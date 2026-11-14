import { digest, includes, keyOf, readBytes } from "./policy.mjs";
import { ledgerItemDocument, projectLedger } from "./ledger-projection.mjs";
import { lineList } from "./preflight.mjs";
import { acceptedVersion } from "./goals.mjs";

export const TERMINAL = new Set(["closed", "retired"]);
const FINISHED = new Set(["completed", "covered", "obsolete", "superseded"]);
const PAGE_SIZE = 32;
const itemHash = item => digest(JSON.stringify(item));
const independentRecord = () => ({ tool: "building_loop_ledger", action: "record", required: ["id", "kind", "title", "note"],
  note: "同一条消息内的不同事项分别使用用户给定或各自稳定的 id，省略 originId。" });

/** Keep the book in the same locked, atomic state file as workflow transitions. */
function book(frame) {
  frame.state.ledger ??= { revision: 0, items: {} };
  frame.state.ledger.items = Object.assign(Object.create(null), frame.state.ledger.items);
  return frame.state.ledger;
}

/** Reject empty decisions and placeholders that hide the reason for a disposition. */
function reason(value, limit = 1200) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("账本操作需要具体原因或项目现状依据");
  return value.trim();
}

/** Add or amend a stable item without silently replacing another task's identity. */
function put(frame, id, value) {
  const ledger = book(frame);
  const previous = ledger.items[id];
  const after = { ...previous, ...value, id };
  if (JSON.stringify(previous) === JSON.stringify(after)) return after;
  ledger.items[id] = { ...after, updatedAt: new Date().toISOString() };
  ledger.revision++;
  frame.changed = true;
  return ledger.items[id];
}

/** Reduce a direct human event to the data needed for a durable ledger intent. */
export function requestIntent(session, event) {
  const message = event.data;
  if (session.header.parentSession !== undefined || session.header.origin === "subagent" || message?.source?.kind !== "user" ||
      !Number.isSafeInteger(event.seq) || event.seq < 0) return;
  const text = (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n").trim();
  if (!text) return;
  return { kind: "request", session: session.id, seq: event.seq, time: event.time ?? 0,
    title: text.replace(/\s+/g, " ").slice(0, 120), sha256: digest(text) };
}

/** Replay under the workspace lock with the original owner and event identity. */
export function captureRequest(frame, event) {
  const owner = event.session;
  const id = "request-" + digest(owner + "/" + event.seq).slice(0, 20);
  if (book(frame).items[id]) return;
  const running = Object.values(frame.state.units).some(unit => !TERMINAL.has(unit.phase));
  put(frame, id, { kind: running ? "temporary" : "planned", status: "pending",
    title: event.title, note: "用户消息待结合项目现状判定，原文见会话事件。",
    origin: { session: owner, event: event.seq, sha256: event.sha256 }, originClassified: false, owner });
  // A notice consumed after closure must still receive a ledger checkpoint.
  // This reopens administration only; a changed goal still forces independent review.
  if (!running) {
    const recent = Object.entries(frame.state.units).filter(([,unit]) => unit.owner === owner && unit.phase === "closed")
      .sort((a,b) => (b[1].closedAt ?? "").localeCompare(a[1].closedAt ?? ""))[0];
    if (recent) {
      const [unitId, active] = recent;
      const receipt = readBytes(frame.root, active.receipt);
      if (receipt) beginLedgerReview(frame, unitId, active, receipt, true);
    }
  }
}

/** Track dispatched and interrupted units even if the model omits a book call. */
export function trackUnit(frame, id, active, interrupted = false) {
  const prior = book(frame).items["unit-" + id];
  put(frame, "unit-" + id, { kind: interrupted ? "interrupted" : prior?.kind ?? "planned",
    status: interrupted ? "deferred" : "running", title: "工作单元 " + id,
    unit: id, owner: active.owner, note: interrupted ? active.blocked : "当前阶段 " + active.phase,
    ...(interrupted ? { lastInterruption: { reason: active.blocked, phase: active.resumePhase } } : {}) });
}

/** The handoff grants read-only history, while active items stay with their owner. */
function historyOwners(frame) {
  const coordinator = frame.state.engineeringCoordinator;
  return new Set(coordinator?.session === frame.agent.id ? coordinator.historyOwners : []);
}

function visibleItem(frame, item, includeClosed, history) {
  return item.owner === frame.agent.id && (includeClosed || !FINISHED.has(item.status)) ||
    includeClosed && history.has(item.owner) && FINISHED.has(item.status);
}

/** Expose open work; historical dispositions remain available on demand. */
export function ledgerSummary(frame, includeClosed = false) {
  const ledger = book(frame);
  const history = historyOwners(frame);
  return { revision: ledger.revision, items: Object.values(ledger.items).filter(item => visibleItem(frame, item, includeClosed, history)) };
}

function currentProjection(frame) {
  const projection = frame.state.ledgerProjection;
  return projection?.owner === frame.agent.id && projection.path === frame.policy.ledgerDocument ? projection : null;
}

/** The authorized document and volumes are derived views of the same ledger. */
export function exportLedger(frame) {
  const history = historyOwners(frame);
  const units = Object.entries(frame.state.units)
    .filter(([, unit]) => unit.owner === frame.agent.id || history.has(unit.owner) && TERMINAL.has(unit.phase))
    .sort(([a], [b]) => a.localeCompare(b));
  return projectLedger(frame, ledgerSummary(frame, true), units);
}

/** Record a fresh coordinator read of a context file during the closing checkpoint. */
export function noteContextRead(frame, file, hash, start, end) {
  if (frame.role !== "coordinator") return;
  for (const active of Object.values(frame.state.units)) {
    if (active.owner !== frame.agent.id || active.phase !== "ledger-review") continue;
    if (!includes([...frame.policy.ledgerContext, ...frame.policy.goalContext, active.receipt], file)) continue;
    active.ledgerSeen ??= {};
    const previous = active.ledgerSeen[keyOf(file)];
    const ranges = previous?.hash === hash ? previous.ranges : [];
    active.ledgerSeen[keyOf(file)] = { hash, ranges: [...ranges, [start, end]] };
    frame.changed = true;
  }
}

/** Open a mandatory book review after factual acceptance, before workflow closure. */
export function beginLedgerReview(frame, id, active, receiptBytes, reopened = false) {
  active.phase = "ledger-review";
  active.receiptHash = digest(receiptBytes);
  active.ledgerSeen = {};
  delete active.ledgerRead;
  delete active.ledgerProgress;
  trackUnit(frame, id, active);
  // Administrative reopening can keep decisions made against the same accepted
  // version. Changes in the goal or context are checked again at read/review.
  if (reopened && Object.keys(active.ledgerDecision?.retained ?? {}).length) {
    active.ledgerProgress = { context: active.ledgerDecision.contextDigest,
      rows: active.ledgerDecision.retained ?? {} };
  }
}

/** Require an exact current context read and name the item that needs repair. */
function contextReference(frame, active, decision, currentUnitItem) {
  const value = decision.evidence;
  const file = value?.file;
  const paths = [...new Set([...frame.policy.ledgerContext, ...frame.policy.goalContext, active.receipt])];
  const invalid = detail => {
    // Only surface paths available to this total controller in this checkpoint.
    const allowed = (currentUnitItem ? [active.receipt] : paths).filter(path => typeof path === "string" && includes(frame.reads, path));
    return new Error("账项 " + decision.id + "（" + decision.outcome + "）：" + detail
      + "。请填写 evidence {file,start,end}，本轮可用的 evidence.file：" + JSON.stringify(allowed));
  };
  if (typeof file !== "string" || !includes(paths, file)) throw invalid("账本处置依据须来自本轮授权的项目现状文件或验收回执");
  const bytes = readBytes(frame.root, file);
  const seen = active.ledgerSeen?.[keyOf(file)];
  const { start, end } = value;
  if (!bytes || seen?.hash !== digest(bytes) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end < start || end > lineList(bytes).length
    || !seen.ranges.some(([a, b]) => a <= start && b >= end)) throw invalid("请在本轮账本复核中实际读取处置依据的当前原文行");
  if (currentUnitItem && file !== active.receipt) throw invalid("本轮完成依据须对应本轮验收回执");
  return { file, start, end, sha256: digest(bytes) };
}

/** Pin the context of staged decisions to this acceptance and all current
 * authorized project context. A changed source drops the whole old page set.
 */
function checkpointDigest(frame, active) {
  const files = [...new Set([...frame.policy.ledgerContext, ...frame.policy.goalContext, active.receipt])];
  const inputs = files.map(file => {
    const bytes = readBytes(frame.root, file);
    return [file, bytes ? digest(bytes) : null];
  });
  return digest(JSON.stringify([frame.policy.hash, active.serial, active.receiptHash, inputs]));
}

/** Preserve completed pages after unrelated arrivals, never after changes to
 * their item version or the acceptance material they were judged against.
 */
function validProgress(frame, active, items, context = checkpointDigest(frame, active)) {
  if (active.ledgerProgress?.context !== context) return new Map();
  const rows = active.ledgerProgress.rows;
  const covered = new Map();
  return new Map(items.flatMap(item => {
    const row = rows[item.id];
    if (row?.itemSha256 !== itemHash(item)) return [];
    if (row.decision.outcome === "covered") {
      const id = row.decision.coveredBy;
      if (!covered.has(id)) {
        const unit = frame.state.units[id];
        let version = null;
        if (unit?.owner === frame.agent.id && ["closed", "ledger-review"].includes(unit.phase)) {
          try {
            acceptedVersion(frame, id, unit);
            version = unit.receiptHash;
          } catch { /* A previously staged decision cannot borrow an expired acceptance. */ }
        }
        covered.set(id, version);
      }
      if (covered.get(id) !== row.coveringVersion) return [];
    }
    return [[item.id, row]];
  }));
}

function pageLimit(value) {
  if (value === undefined) return PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > PAGE_SIZE) throw new Error("账本 limit 必须为 1 至 " + PAGE_SIZE);
  return value;
}

function browseRows(frame, args, view, limit) {
  const scope = JSON.stringify([frame.file, frame.agent.id, [...historyOwners(frame)].sort(), view.revision, args.includeClosed === true]);
  let offset = 0;
  if (args.cursor !== undefined) {
    const match = /^([1-9]\d*)\.([a-f0-9]{64})$/u.exec(args.cursor);
    if (!match || match[2] !== digest(scope + "/" + match[1])) throw new Error("账本分页版本或范围已变化，请重新调用 read");
    offset = Number(match[1]);
    if (offset >= view.items.length) throw new Error("账本分页位置已失效，请重新调用 read");
  }
  const items = view.items.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, ...(next < view.items.length ? { nextCursor: next + "." + digest(scope + "/" + next) } : {}) };
}

/** A review reads the next unreviewed batch. Historical browsing is independent
 * and cannot authorize a write. Small default calls keep the previous schema.
 */
function ledgerRead(frame, args, unitId, active) {
  if (active && active.owner !== frame.agent.id) throw new Error("账本读取不能指定其他总控持有的单元");
  const view = ledgerSummary(frame, args.includeClosed === true);
  const limit = pageLimit(args.limit);
  const reviewing = active?.phase === "ledger-review" && args.includeClosed !== true;
  let page;
  if (reviewing) {
    if (args.cursor !== undefined) throw new Error("复盘请直接 read 获取待审页；将返回的 reviewPage.cursor 用于 review");
    let marker = { revision: view.revision, serial: active.serial };
    if (view.items.length > limit || active.ledgerProgress) {
      const context = checkpointDigest(frame, active);
      const progress = validProgress(frame, active, view.items, context);
      const remaining = view.items.filter(item => !progress.has(item.id));
      const items = remaining.slice(0, limit);
      const ids = items.map(item => item.id);
      const cursor = digest(JSON.stringify([frame.file, frame.agent.id, unitId, marker, context, ids]));
      marker = { ...marker, cursor, context, ids, progress: progress.size };
      page = { items, reviewPage: { cursor, reviewed: progress.size, remaining: remaining.length, total: view.items.length } };
    } else page = { items: view.items };
    active.ledgerRead = marker;
    frame.changed = true;
  } else page = browseRows(frame, args, view, limit);
  const covered = new Set(active ? frame.policy.units[unitId].covers : []);
  return { revision: view.revision, ...page, itemCount: view.items.length,
    items: page.items.map(item => ({ ...item, itemSha256: itemHash(item) })),
    context: [...new Set([...frame.policy.ledgerContext, ...frame.policy.goalContext])],
    document: frame.policy.ledgerDocument ? { path: frame.policy.ledgerDocument, managedBy: "host", projection: currentProjection(frame) }
      : { configured: false, authority: "host-state", next: "维护者可配置 ledgerDocument；不会按文件名自动覆盖现有叙事文档。" },
    coverage: [...covered].map(id => ({ id, coveredBy: unitId })),
    current: active ? { unit: unitId, phase: active.phase, receipt: active.receipt } : null,
    constraints: page.items.filter(item => !FINISHED.has(item.status)).map(item => ({ id: item.id,
      outcomes: item.id === "unit-" + unitId ? ["completed"] : covered.has(item.id) ? ["covered", "obsolete"]
        : item.origin && !item.unit ? ["keep", "resume", "defer", "completed", "covered", "obsolete"] : ["keep", "resume", "defer", "covered", "obsolete"],
      ...(item.id === "unit-" + unitId ? { requiredEvidenceFile: active.receipt } : {}),
      evidenceRequiredFor: ["completed", "covered", "obsolete"], coveredByRequiredFor: "covered" })) };
}

/** Apply explicit dispositions to every open item, guarding stale and partial reads. */
export function ledgerAction(frame, args) {
  if (frame.role !== "coordinator") throw new Error("账本由总控维护，执行方通过阻塞回执登记中断");
  const ledger = book(frame);
  if (args.action === "export") return exportLedger(frame);
  if (args.action === "lookup") {
    const item = ledger.items[args.id];
    if (!item || !visibleItem(frame, item, true, historyOwners(frame))) return { found: false };
    const projection = ledgerItemDocument(frame, currentProjection(frame), item.id, ledger.revision);
    let document = null;
    if (projection) {
      try {
        const bytes = readBytes(frame.root, projection.path);
        if (bytes && digest(bytes) === projection.sha256) document = projection;
      } catch { /* A missing or unreadable view must not hide the authoritative entry. */ }
    }
    return { found: true, revision: ledger.revision, item: { ...item, itemSha256: itemHash(item) },
      document };
  }
  if (args.action === "record") {
    if (args.originId !== undefined && args.id !== undefined) return { status: "record-identity-conflict", recorded: false,
      next: independentRecord(), note: "id 与 originId 二选一。只归类原始请求时，保留 originId，省略 id。" };
    const linked = args.originId === undefined ? undefined : ledger.items[args.originId];
    if (args.originId !== undefined && (!linked?.origin || linked.owner !== frame.agent.id)) throw new Error("originId 须指向本总控已有的自动请求记录");
    // A recorded interruption of a known unit already has an authoritative item.
    // Reuse it so completion follows the unit's acceptance, not an unrelated plan.
    if (!linked && args.kind === "interrupted" && typeof args.unit === "string") {
      const existing = ledger.items["unit-" + args.unit];
      if (existing?.lastInterruption) {
        if (existing.owner !== frame.agent.id) throw new Error("中断账项由该工作单元的原总控持有");
        return { ...existing, alreadyRecorded: true };
      }
    }
    const id = linked?.id ?? args.id;
    if (!linked && (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id ?? "") || id.startsWith("unit-") || id.startsWith("request-"))) {
      return { status: "record-id-required", recorded: false, next: independentRecord(),
        note: "只归类已有的原始请求时，用 originId；独立事项使用不以 unit- 或 request- 开头的稳定编号。" };
    }
    if (!["planned", "temporary", "interrupted"].includes(args.kind)) throw new Error("账本分类须为 planned、temporary 或 interrupted");
    const title = reason(args.title, 300), note = reason(args.note);
    const previous = ledger.items[id];
    if (previous && previous.owner !== frame.agent.id) throw new Error("账目由其他总控持有");
    if (previous) {
      if (previous.kind === args.kind && previous.title === title && previous.note === note) return previous;
      // Legacy records have no marker and cannot prove a first classification.
      // A reviewed origin also needs a fresh pin, even if never explicitly classified.
      const firstClassification = linked?.originClassified === false && !linked.disposition;
      const versionRequired = !firstClassification || args.expectedItemSha256 !== undefined;
      if (versionRequired && args.expectedItemSha256 !== itemHash(previous)) {
        if (linked) return { status: "origin-version-required", recorded: false, originId: linked.id, next: independentRecord(),
          amendment: { tool: "building_loop_ledger", action: "lookup", id: linked.id,
            note: "若确实要改写同一条原请求，先查最新 itemSha256，再用 originId 和 expectedItemSha256 提交。" } };
        throw new Error("账目编号已经存在。修改该项须先读最新账本并提供 expectedItemSha256；新事项使用新编号");
      }
    } else if (args.expectedItemSha256 !== undefined) {
      throw new Error("指定了已有账项版本，但当前没有可修改的独立账项");
    }
    const duplicate = Object.values(ledger.items).find(item => item.owner === frame.agent.id && item.id !== id
      && item.title.normalize("NFKC").replace(/\s/g, "") === title.normalize("NFKC").replace(/\s/g, ""));
    if (duplicate) throw new Error("同名事项已登记 " + duplicate.id + "，请沿用原编号或 originId");
    // Reclassification never reopens completed/covered/obsolete items.
    return put(frame, id, { kind: args.kind, title, note, status: previous?.status ?? "pending", owner: frame.agent.id,
      ...(linked ? { originClassified: true } : {}) });
  }
  // A single owned checkpoint is unambiguous when the caller reads the global book.
  const unitId = args.unit ?? Object.keys(frame.state.units).find(id =>
    frame.state.units[id].owner === frame.agent.id && frame.state.units[id].phase === "ledger-review");
  const active = frame.state.units[unitId];
  if (args.action === "read") return ledgerRead(frame, args, unitId, active);
  const requestHash = digest(JSON.stringify({ note: args.note, decisions: args.decisions, cursor: args.cursor }));
  if (args.action === "review" && active?.owner === frame.agent.id && active.phase === "closed"
    && active.ledgerDecision?.requestHash === requestHash) {
    acceptedVersion(frame, unitId, active);
    return { unit: unitId, phase: "closed", replayed: true,document:exportLedger(frame) };
  }
  if (args.action !== "review" || !active || active.owner !== frame.agent.id || active.phase !== "ledger-review") throw new Error("当前没有由本总控持有的账本复核阶段");
  const read = active.ledgerRead;
  if (read?.revision !== ledger.revision || read?.serial !== active.serial || read.cursor !== args.cursor) {
    throw new Error("请先调用账本 read（unit=" + unitId + "）读取最新账本，分批处置须提供最新 cursor，变更后须重新读取");
  }
  acceptedVersion(frame, unitId, active);
  for (const file of [...new Set([...frame.policy.ledgerContext, ...frame.policy.goalContext])]) {
    const bytes = readBytes(frame.root, file);
    if (!bytes || active.ledgerSeen?.[keyOf(file)]?.hash !== digest(bytes)) throw new Error("请先读取最新项目现状 " + file);
  }
  const items = ledgerSummary(frame).items;
  const contextVersion = read.cursor && checkpointDigest(frame, active);
  const progress = read.cursor ? validProgress(frame, active, items, contextVersion) : new Map();
  if (read.cursor && (read.context !== contextVersion || read.progress !== progress.size)) {
    throw new Error("账本复盘依据已变化，请先重新读取当前项目现状及账本页");
  }
  const current = read.cursor ? read.ids.map(id => ledger.items[id]) : items;
  if (!Array.isArray(args.decisions) || args.decisions.length !== current.length
    || new Set(args.decisions.map(row => row.id)).size !== current.length) {
    throw new Error(read.cursor ? "请逐项处置本页的全部未复盘账目，保留或续做也需给原因" : "请逐项处置全部未结账目，保留或续做也需给原因");
  }
  const decisions = new Map(args.decisions.map(row => [row.id, row]));
  function validate(item) {
    const decision = decisions.get(item.id);
    if (!decision || !["keep", "resume", "defer", "completed", "covered", "obsolete"].includes(decision.outcome)) throw new Error("账本处置项缺失或状态无效 " + item.id);
    const basis = reason(decision.basis);
    // Completion belongs to this unit's own independently accepted checkpoint.
    // A blocked sibling may be retained, cancelled, or replaced by an accepted
    // delivery; another unit's receipt must never claim it actually completed.
    // Finished historical items are absent from this open-item plan and unchanged.
    if(decision.outcome==="completed"&&item.unit&&item.unit!==unitId) {
      throw new Error(item.id+" 须由本单元自身验收后登记 completed，不能借 "+unitId+" 的验收完成其他阻塞工作；保留/续做用 keep、resume 或 defer，确被已验收成果替代用 covered 并提供 coveredBy，取消用 obsolete");
    }
    // Continuing work may cite its current context too. Omission stays legacy-
    // compatible, but an explicitly supplied locator is never silently dropped:
    // it must pass the same authority, exact read range and current-version gate.
    const evidence = FINISHED.has(decision.outcome)||decision.evidence!==undefined
      ? contextReference(frame, active, decision, item.id === "unit-" + unitId) : null;
    if (frame.policy.units[unitId].covers.includes(item.id) && !["covered","obsolete"].includes(decision.outcome)) {
      throw new Error(item.id + " 已声明由本轮当前目标下的验收产物替代，请 covered 并填 coveredBy；关系确已失效时引用当前目标标 obsolete");
    }
    // Only a dispatched unit or a captured user request has a direct completion
    // checkpoint. A standalone plan cannot borrow an unrelated accepted receipt.
    // If another delivery satisfies it, preserve that relationship as coverage;
    // cancellation is obsolete, never evidence that the planned work was performed.
    if (decision.outcome === "completed" && !item.unit && !item.origin) {
      throw new Error(item.id + " 是独立计划，不能用本轮其他工作的验收标为 completed；任务已取消用 obsolete 并引用当前目标；确被已验收成果满足才用 covered、coveredBy 和具体覆盖依据。实际执行的工作单元由其自身验收登记完成");
    }
    let coverage;
    if (decision.outcome === "covered") {
      const covering = frame.state.units[decision.coveredBy];
      if (!covering || covering.owner !== frame.agent.id || !["closed","ledger-review"].includes(covering.phase)) throw new Error("coveredBy 须指向本总控已验收单元");
      const proof = acceptedVersion(frame, decision.coveredBy, covering);
      coverage = { unit: decision.coveredBy, receipt: covering.receipt, receiptHash: covering.receiptHash,
        candidateSha256: proof.candidateSha256, goal: proof.goal };
    }
    if (item.id === "unit-" + unitId && decision.outcome !== "completed") throw new Error("本轮已验收单元须以验收回执登记完成");
    const unit = item.unit && frame.state.units[item.unit];
    if (unit && item.unit !== unitId && FINISHED.has(decision.outcome)
      && (unit.owner !== frame.agent.id || unit.phase !== "blocked")) throw new Error("其他运行中单元的权限和验收由其原总控维护");
    return { item, outcome: decision.outcome, basis, evidence, unit, coverage };
  }
  let planned = current.map(validate);
  if (read.cursor) {
    for (const row of planned) progress.set(row.item.id, { itemSha256: itemHash(row.item), decision: decisions.get(row.item.id),
      ...(row.coverage ? { coveringVersion: row.coverage.receiptHash } : {}) });
    if (progress.size < items.length) {
      active.ledgerProgress = { context: read.context, rows: Object.fromEntries(progress) };
      delete active.ledgerRead;
      frame.changed = true;
      return { unit: unitId, phase: "ledger-review", reviewed: progress.size, remaining: items.length - progress.size,
        next: { action: "read", unit: unitId } };
    }
    // Validate all staged decisions against the current acceptance and evidence
    // again before applying any result. Partial pages never retire a task.
    for (const [id, row] of progress) decisions.set(id, row.decision);
    planned = items.map(validate);
  }
  // Per-item reasons and evidence above are mandatory. An omitted duplicate
  // overview is transport metadata, not a reason to discard valid dispositions.
  const context = args.note === undefined
    ? "宿主依据已验证的逐项决定复盘 " + planned.length + " 项：" + JSON.stringify(planned.reduce((counts,row) => {
      counts[row.outcome] = (counts[row.outcome] ?? 0) + 1; return counts;
    }, {}))
    : reason(args.note);
  for (const { item, outcome, basis, evidence, unit, coverage } of planned) {
    put(frame, item.id, { status: outcome === "keep" ? item.status : outcome === "resume" ? "pending" : outcome === "defer" ? "deferred" : outcome,
      disposition: { outcome, basis, evidence, checkpoint: unitId, ...(coverage ? { coverage } : {}) }, note: basis });
    if (unit && item.unit !== unitId && FINISHED.has(outcome)) {
      unit.phase = "retired";
      unit.retirement = { outcome, basis, evidence };
    }
  }
  delete active.ledgerProgress;
  active.phase = "closed";
  active.closedAt = new Date().toISOString();
  const retained = Object.fromEntries(planned.filter(row => !FINISHED.has(row.outcome)).map(row => [row.item.id, {
    itemSha256: itemHash(ledger.items[row.item.id]), decision: decisions.get(row.item.id),
  }]));
  active.ledgerDecision = { revision: ledger.revision, context,
    contextOrigin: args.note === undefined ? "host-from-validated-decisions" : "provided",
    reviewed: planned.map(row => row.item.id), requestHash, contextDigest: checkpointDigest(frame, active), retained };
  frame.changed = true;
  // Export runs inside the existing locked state transaction. A write failure
  // aborts it: callers never receive closed while a configured document failed.
  const document=exportLedger(frame);
  return { unit: unitId, phase: "closed", ledgerRevision: ledger.revision, reviewed: planned.length,document };
}
