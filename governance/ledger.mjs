import { digest, includes, keyOf, readBytes } from "./policy.mjs";
import { lineList } from "./preflight.mjs";

export const TERMINAL = new Set(["closed", "retired"]);
const FINISHED = new Set(["completed", "covered", "obsolete"]);

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

/** Capture direct human messages so a mid-task request remains discoverable. */
export function captureRequest(frame, event) {
  const message = event.data;
  if (frame.role !== "coordinator" || message?.source?.kind !== "user") return;
  const text = (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n").trim();
  if (!text) return;
  const id = "request-" + digest(frame.agent.id + "/" + event.seq).slice(0, 20);
  if (book(frame).items[id]) return;
  const running = Object.values(frame.state.units).some(unit => !TERMINAL.has(unit.phase));
  put(frame, id, { kind: running ? "temporary" : "planned", status: "pending",
    title: text.replace(/\s+/g, " ").slice(0, 120), note: "用户消息待结合项目现状判定，原文见会话事件。",
    origin: { session: frame.agent.id, event: event.seq, sha256: digest(text) }, owner: frame.agent.id });
}

/** Track dispatched and interrupted units even if the model omits a book call. */
export function trackUnit(frame, id, active, interrupted = false) {
  const prior = book(frame).items["unit-" + id];
  put(frame, "unit-" + id, { kind: interrupted ? "interrupted" : prior?.kind ?? "planned",
    status: interrupted ? "deferred" : "running", title: "工作单元 " + id,
    unit: id, owner: active.owner, note: interrupted ? active.blocked : "当前阶段 " + active.phase,
    ...(interrupted ? { lastInterruption: { reason: active.blocked, phase: active.resumePhase } } : {}) });
}

/** Expose open work; historical dispositions remain stored and available on demand. */
export function ledgerSummary(frame, includeClosed = false) {
  const ledger = book(frame);
  const items = Object.values(ledger.items).filter(item => includeClosed || !FINISHED.has(item.status));
  return { revision: ledger.revision, items };
}

/** Record a fresh coordinator read of a context file during the closing checkpoint. */
export function noteContextRead(frame, file, hash, start, end) {
  if (frame.role !== "coordinator") return;
  for (const active of Object.values(frame.state.units)) {
    if (active.owner !== frame.agent.id || active.phase !== "ledger-review") continue;
    if (!includes([...frame.policy.ledgerContext, active.receipt], file)) continue;
    active.ledgerSeen ??= {};
    const previous = active.ledgerSeen[keyOf(file)];
    const ranges = previous?.hash === hash ? previous.ranges : [];
    active.ledgerSeen[keyOf(file)] = { hash, ranges: [...ranges, [start, end]] };
    frame.changed = true;
  }
}

/** Open a mandatory book review after factual acceptance, before workflow closure. */
export function beginLedgerReview(frame, id, active, receiptBytes) {
  active.phase = "ledger-review";
  active.receiptHash = digest(receiptBytes);
  active.ledgerSeen = {};
  delete active.ledgerRead;
  trackUnit(frame, id, active);
}

/** Require a current, authorized context locator for covered or obsolete work. */
function contextReference(frame, active, value) {
  const file = value?.file;
  if (!includes([...frame.policy.ledgerContext, active.receipt], file ?? "")) throw new Error("账本处置依据须来自本轮授权的项目现状文件或验收回执");
  const bytes = readBytes(frame.root, file);
  const seen = active.ledgerSeen?.[keyOf(file)];
  const { start, end } = value;
  if (!bytes || seen?.hash !== digest(bytes) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end < start || end > lineList(bytes).length
    || !seen.ranges.some(([a, b]) => a <= start && b >= end)) throw new Error("请在本轮账本复核中实际读取处置依据的当前原文行");
  return { file, start, end, sha256: digest(bytes) };
}

/** Apply explicit dispositions to every open item, guarding stale and partial reads. */
export function ledgerAction(frame, args) {
  if (frame.role !== "coordinator") throw new Error("账本由总控维护，执行方通过阻塞回执登记中断");
  const ledger = book(frame);
  if (args.action === "record") {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(args.id ?? "") || args.id.startsWith("unit-") || args.id.startsWith("request-")) throw new Error("请为计划提供稳定且独立的账本编号");
    if (!["planned", "temporary", "interrupted"].includes(args.kind)) throw new Error("账本分类须为 planned、temporary 或 interrupted");
    return put(frame, args.id, { kind: args.kind, title: reason(args.title, 300), note: reason(args.note),
      status: "pending", owner: frame.agent.id });
  }
  // A single owned checkpoint is unambiguous when the caller reads the global book.
  const unitId = args.unit ?? Object.keys(frame.state.units).find(id =>
    frame.state.units[id].owner === frame.agent.id && frame.state.units[id].phase === "ledger-review");
  const active = frame.state.units[unitId];
  if (args.action === "read") {
    const view = ledgerSummary(frame, args.includeClosed === true);
    if (active?.owner === frame.agent.id && active.phase === "ledger-review") {
      active.ledgerRead = { revision: ledger.revision, serial: active.serial };
      frame.changed = true;
    }
    return { ...view, context: frame.policy.ledgerContext,
      current: active ? { unit: unitId, phase: active.phase, receipt: active.receipt } : null };
  }
  const requestHash = digest(JSON.stringify({ note: args.note, decisions: args.decisions }));
  if (args.action === "review" && active?.owner === frame.agent.id && active.phase === "closed"
    && active.ledgerDecision?.requestHash === requestHash) return { unit: unitId, phase: "closed", replayed: true };
  if (args.action !== "review" || !active || active.owner !== frame.agent.id || active.phase !== "ledger-review") throw new Error("当前没有由本总控持有的账本复核阶段");
  if (active.ledgerRead?.revision !== ledger.revision || active.ledgerRead?.serial !== active.serial) throw new Error("请先调用账本 read（unit=" + unitId + "）读取最新账本，变更后须重新读取");
  const receipt = readBytes(frame.root, active.receipt);
  if (!receipt || digest(receipt) !== active.receiptHash) throw new Error("验收回执在账本复核前发生变化，停止关单并核实");
  for (const file of frame.policy.ledgerContext) {
    const bytes = readBytes(frame.root, file);
    if (!bytes || active.ledgerSeen?.[keyOf(file)]?.hash !== digest(bytes)) throw new Error("请先读取最新项目现状 " + file);
  }
  const items = ledgerSummary(frame).items;
  if (!Array.isArray(args.decisions) || args.decisions.length !== items.length
    || new Set(args.decisions.map(row => row.id)).size !== items.length) throw new Error("请逐项处置全部未结账目，保留或续做也需给原因");
  const planned = items.map(item => {
    const decision = args.decisions.find(row => row.id === item.id);
    if (!decision || !["keep", "resume", "defer", "completed", "covered", "obsolete"].includes(decision.outcome)) throw new Error("账本处置项缺失或状态无效 " + item.id);
    const basis = reason(decision.basis);
    const evidence = FINISHED.has(decision.outcome) ? contextReference(frame, active, decision.evidence) : null;
    if (item.id === "unit-" + unitId && decision.outcome !== "completed") throw new Error("本轮已验收单元须以验收回执登记完成");
    if (item.id === "unit-" + unitId && evidence?.file !== active.receipt) throw new Error("本轮完成依据须对应本轮验收回执");
    const unit = item.unit && frame.state.units[item.unit];
    if (unit && item.unit !== unitId && FINISHED.has(decision.outcome)
      && (unit.owner !== frame.agent.id || unit.phase !== "blocked")) throw new Error("其他运行中单元的权限和验收由其原总控维护");
    return { item, outcome: decision.outcome, basis, evidence, unit };
  });
  const context = reason(args.note);
  for (const { item, outcome, basis, evidence, unit } of planned) {
    put(frame, item.id, { status: outcome === "keep" ? item.status : outcome === "resume" ? "pending" : outcome === "defer" ? "deferred" : outcome,
      disposition: { outcome, basis, evidence, checkpoint: unitId }, note: basis });
    if (unit && item.unit !== unitId && FINISHED.has(outcome)) {
      unit.phase = "retired";
      unit.retirement = { outcome, basis, evidence };
    }
  }
  active.phase = "closed";
  active.ledgerDecision = { revision: ledger.revision, context, reviewed: planned.map(row => row.item.id), requestHash };
  frame.changed = true;
  return { unit: unitId, phase: "closed", ledgerRevision: ledger.revision, reviewed: planned.length };
}
