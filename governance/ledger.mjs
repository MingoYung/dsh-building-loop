import { digest, includes, keyOf, readBytes, replaceWithHistory } from "./policy.mjs";
import { lineList } from "./preflight.mjs";
import { acceptedVersion } from "./goals.mjs";

export const TERMINAL = new Set(["closed", "retired"]);
const FINISHED = new Set(["completed", "covered", "obsolete"]);
// The projection version distinguishes explicit model-reason labels from the
// historical generic "依据" format without rewriting stored dispositions.
const EXPORT_FORMAT="building-loop-ledger/2";

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
  // A notice consumed after closure must still receive a ledger checkpoint.
  // This reopens administration only; a changed goal still forces independent review.
  if (!running) {
    const recent = Object.entries(frame.state.units).filter(([,unit]) => unit.owner === frame.agent.id && unit.phase === "closed")
      .sort((a,b) => (b[1].closedAt ?? "").localeCompare(a[1].closedAt ?? ""))[0];
    if (recent) {
      const [unitId, active] = recent;
      const receipt = readBytes(frame.root, active.receipt);
      if (receipt) beginLedgerReview(frame, unitId, active, receipt);
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

/** Expose open work; historical dispositions remain stored and available on demand. */
export function ledgerSummary(frame, includeClosed = false) {
  const ledger = book(frame);
  const items = Object.values(ledger.items).filter(item => item.owner === frame.agent.id && (includeClosed || !FINISHED.has(item.status)));
  return { revision: ledger.revision, items };
}

/** Render stored strings as literal Markdown text, not new headings/table rows. */
function literal(value) {
  return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replace(/[\\`*_{}\[\]()#!|]/g,"\\$&").replace(/\r\n|\n|\r/g,"<br>");
}

/** Project the complete current owned ledger, never a model-rewritten selection.
 * No historical stage sequence is inferred from current state or free prose.
 */
export function exportLedger(frame) {
  const file=frame.policy.ledgerDocument;
  if(!file)return {configured:false,exported:false,authority:"host-state",
    next:"项目维护者可配置 ledgerDocument 并加入 coordinator.write；未配置时保留现有文档，宿主台账仍为权威。"};
  if(frame.role!=="coordinator"||!includes(frame.policy.coordinator.write,file))throw new Error("账本导出缺少总控的精确路径授权");
  const view=ledgerSummary(frame,true),items=[...view.items].sort((a,b)=>a.id.localeCompare(b.id));
  const units=Object.entries(frame.state.units).filter(([,unit])=>unit.owner===frame.agent.id).sort(([a],[b])=>a.localeCompare(b));
  const counts=items.reduce((result,item)=>{result[item.status]=(result[item.status]??0)+1;return result;},{});
  const lines=["# 当前总控账本快照","", "账本 revision："+view.revision,
    "总控："+literal(frame.agent.id),"条目总数："+items.length,"",
    "状态统计："+Object.entries(counts).map(([status,count])=>literal(status)+" = "+count).join("；"),"",
    "## 当前工作单元","","| 单元 | 当前阶段 | 当前回执 |","|---|---|---|",
    ...units.map(([id,unit])=>"| "+literal(id)+" | "+literal(unit.phase)+" | "+literal(unit.receipt??"未生成")+" |"),
    "","## 全部当前账项","","| ID | 类型 | 当前状态 | 名称 |","|---|---|---|---|",
    ...items.map(item=>"| "+[item.id,item.kind,item.status,item.title].map(literal).join(" | ")+" |")];
  for(const item of items) {
    const disposition=item.disposition,evidence=disposition?.evidence,coverage=disposition?.coverage;
    lines.push("","### "+literal(item.id),"", "名称："+literal(item.title),
      "当前状态："+literal(item.status),(disposition?"总控处置理由（模型判断）：":"账项说明（登记内容）：")+literal(disposition?.basis??item.note));
    if(disposition)lines.push("已登记处置："+literal(disposition.outcome)+"；核对单元："+literal(disposition.checkpoint));
    if(evidence)lines.push("已核定位证据："+literal(evidence.file)+" 第 "+evidence.start+"–"+evidence.end+" 行；SHA-256 "+literal(evidence.sha256));
    if(coverage)lines.push("覆盖关系："+literal(coverage.unit)+"；验收回执 "+literal(coverage.receipt)+"；回执 SHA-256 "+literal(coverage.receiptHash)
      +"；候选 SHA-256 "+literal(coverage.candidateSha256)+"；目标 SHA-256 "+literal(coverage.goal?.sha256));
    if(item.origin)lines.push("原始请求："+literal(item.origin.session)+"；事件 "+item.origin.event+"；SHA-256 "+literal(item.origin.sha256));
    if(item.lastInterruption)lines.push("宿主最近中断："+literal(item.lastInterruption.phase)+"；"+literal(item.lastInterruption.reason));
    if(item.updatedAt)lines.push("最近登记时间："+literal(item.updatedAt));
  }
  const content=lines.join("\n")+"\n";
  const result=replaceWithHistory(frame.root,file,content,"宿主导出当前账本 revision "+view.revision,
    frame.agent.id+"/ledger/"+view.revision,frame.state.markers,frame.rollback??=[]);
  const projection={format:EXPORT_FORMAT,path:file,revision:view.revision,owner:frame.agent.id,sha256:digest(content),itemIds:items.map(item=>item.id)};
  frame.state.ledgerProjection=projection;frame.changed=true;
  return {configured:true,exported:true,...projection,itemCount:items.length,changed:result.changed};
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
  if (!includes([...frame.policy.ledgerContext, ...frame.policy.goalContext, active.receipt], file ?? "")) throw new Error("账本处置依据须来自本轮授权的项目现状文件或验收回执");
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
  if(args.action==="export")return exportLedger(frame);
  if (args.action === "record") {
    const linked = args.originId && ledger.items[args.originId];
    if (args.originId && (!linked?.origin || linked.owner !== frame.agent.id)) throw new Error("originId 须指向本总控已有的自动请求记录");
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
    if (!linked && (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id ?? "") || id.startsWith("unit-") || id.startsWith("request-"))) throw new Error("已有请求请用 originId 关联；独立计划须使用稳定编号");
    if (!["planned", "temporary", "interrupted"].includes(args.kind)) throw new Error("账本分类须为 planned、temporary 或 interrupted");
    const title = reason(args.title, 300), note = reason(args.note);
    const previous = ledger.items[id];
    if (previous && previous.owner !== frame.agent.id) throw new Error("账目由其他总控持有");
    if (previous && !linked) {
      if (previous.kind === args.kind && previous.title === title && previous.note === note) return previous;
      // A stable ID is not permission to overwrite a different task's content.
      // Explicit amendments use the last item version returned by ledger read.
      if (args.expectedItemSha256 !== digest(JSON.stringify(previous))) {
        throw new Error("账目编号已经存在。修改该项须先读最新账本并提供 expectedItemSha256；新事项使用新编号");
      }
    } else if (args.expectedItemSha256 !== undefined) {
      throw new Error("指定了已有账项版本，但当前没有可修改的独立账项");
    }
    const duplicate = Object.values(ledger.items).find(item => item.owner === frame.agent.id && item.id !== id
      && item.title.normalize("NFKC").replace(/\s/g, "") === title.normalize("NFKC").replace(/\s/g, ""));
    if (duplicate) throw new Error("同名事项已登记 " + duplicate.id + "，请沿用原编号或 originId");
    // Reclassification never reopens completed/covered/obsolete items.
    return put(frame, id, { kind: args.kind, title, note, status: previous?.status ?? "pending", owner: frame.agent.id });
  }
  // A single owned checkpoint is unambiguous when the caller reads the global book.
  const unitId = args.unit ?? Object.keys(frame.state.units).find(id =>
    frame.state.units[id].owner === frame.agent.id && frame.state.units[id].phase === "ledger-review");
  const active = frame.state.units[unitId];
  if (args.action === "read") {
    if(active&&active.owner!==frame.agent.id)throw new Error("账本读取不能指定其他总控持有的单元");
    const view = ledgerSummary(frame, args.includeClosed === true);
    if (active?.owner === frame.agent.id && active.phase === "ledger-review") {
      active.ledgerRead = { revision: ledger.revision, serial: active.serial };
      frame.changed = true;
    }
    // A workspace has one configured output path. Its last generated metadata
    // belongs only to that exporting coordinator; never expose another owner's
    // item IDs through the shared state slot or imply it is this caller's book.
    const projection=frame.state.ledgerProjection?.owner===frame.agent.id
      &&frame.state.ledgerProjection.path===frame.policy.ledgerDocument?frame.state.ledgerProjection:null;
    return { ...view, items: view.items.map(item => ({ ...item, itemSha256: digest(JSON.stringify(item)) })),
      context: [...new Set([...frame.policy.ledgerContext, ...frame.policy.goalContext])],
      document:frame.policy.ledgerDocument?{path:frame.policy.ledgerDocument,managedBy:"host",projection}
        :{configured:false,authority:"host-state",next:"维护者可配置 ledgerDocument；不会按文件名自动覆盖现有叙事文档。"},
      coverage: active ? frame.policy.units[unitId].covers.map(id => ({ id,coveredBy:unitId })) : [],
      current: active ? { unit: unitId, phase: active.phase, receipt: active.receipt } : null,
      // Publish the existing mechanical contract, never choose a semantic outcome
      // for the coordinator. Exact IDs and evidence files prevent paid trial/error.
      constraints: view.items.map(item=>({id:item.id,
        outcomes:item.id==="unit-"+unitId?["completed"]
          : active&&frame.policy.units[unitId].covers.includes(item.id)?["covered","obsolete"]
          : item.origin&&!item.unit?["keep","resume","defer","completed","covered","obsolete"]
          : ["keep","resume","defer","covered","obsolete"],
        ...(item.id==="unit-"+unitId?{requiredEvidenceFile:active.receipt}:{}),
        evidenceRequiredFor:["completed","covered","obsolete"],coveredByRequiredFor:"covered"})) };
  }
  const requestHash = digest(JSON.stringify({ note: args.note, decisions: args.decisions }));
  if (args.action === "review" && active?.owner === frame.agent.id && active.phase === "closed"
    && active.ledgerDecision?.requestHash === requestHash) {
    acceptedVersion(frame, unitId, active);
    return { unit: unitId, phase: "closed", replayed: true,document:exportLedger(frame) };
  }
  if (args.action !== "review" || !active || active.owner !== frame.agent.id || active.phase !== "ledger-review") throw new Error("当前没有由本总控持有的账本复核阶段");
  if (active.ledgerRead?.revision !== ledger.revision || active.ledgerRead?.serial !== active.serial) throw new Error("请先调用账本 read（unit=" + unitId + "）读取最新账本，变更后须重新读取");
  acceptedVersion(frame, unitId, active);
  for (const file of [...new Set([...frame.policy.ledgerContext, ...frame.policy.goalContext])]) {
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
      ? contextReference(frame, active, decision.evidence) : null;
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
    if (item.id === "unit-" + unitId && evidence?.file !== active.receipt) throw new Error("本轮完成依据须对应本轮验收回执");
    const unit = item.unit && frame.state.units[item.unit];
    if (unit && item.unit !== unitId && FINISHED.has(decision.outcome)
      && (unit.owner !== frame.agent.id || unit.phase !== "blocked")) throw new Error("其他运行中单元的权限和验收由其原总控维护");
    return { item, outcome: decision.outcome, basis, evidence, unit, coverage };
  });
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
  active.phase = "closed";
  active.closedAt = new Date().toISOString();
  active.ledgerDecision = { revision: ledger.revision, context,
    contextOrigin: args.note === undefined ? "host-from-validated-decisions" : "provided",
    reviewed: planned.map(row => row.item.id), requestHash };
  frame.changed = true;
  // Export runs inside the existing locked state transaction. A write failure
  // aborts it: callers never receive closed while a configured document failed.
  const document=exportLedger(frame);
  return { unit: unitId, phase: "closed", ledgerRevision: ledger.revision, reviewed: planned.length,document };
}
