import { digest, includes, keyOf, readBytes, relativeName } from "./policy.mjs";
import { lineList, plainLastIssues, requiredLineMarkdown } from "./preflight.mjs";
import { sourceVersionCurrent } from "./evidence.mjs";
import { candidateCitationProfiles, requireStoredCalculations, requireStoredFootnoteBindings, requireStoredObjectChecks } from "./coverage.mjs";
import { reviewedCodeArtifactsCurrent } from "./code-intake.mjs";
import { currentCodeReview } from "./code-review.mjs";
import { engineeringArchitectureCurrent } from "./engineering-architecture.mjs";
import { deliveryOutcomeContract, requireAcceptedDeliveryOutcomes, reviewDeliveryOutcomes } from "./delivery-outcomes.mjs";

const REQUIRED_MARKERS = new Set(["[稿件自述]", "[摘录范围]"]);
const LEADING_MARKER = /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(\[(?:稿件自述|摘录范围)\])(?!\(|\[|:)/u;

/** A spanning code literal cannot borrow visible prose later on the row. */
function liveLeadingMarker(raw,visible) {
  const marker=LEADING_MARKER.exec(raw)?.[1];
  return marker&&LEADING_MARKER.exec(visible)?.[1]===marker?marker:null;
}

/** Include source-backed structural locators alongside semantic and object proofs. */
function* proofSources(coverage) {
  for(const record of coverage?.records??[]) {
    yield* record.syntaxSources??[];
    for(const part of record.parts) {
      yield* part.evidence??[];
      yield* part.inference?.premises??[];
      yield* part.inference?.warrant??[];
      yield* (part.inference?.assumptions??[]).map(row=>row.evidence);
      yield* part.objectCheck?.sources??[];
    }
  }
  for(const quote of coverage?.quotations??[])yield* quote.refs;
}

/** All evidence used by either reviewer stays pinned through final ledger closure.
 * This reads host proof metadata only; it does not grant the coordinator source access.
 */
function requireProofSources(frame, id, active) {
  for (const coverage of [active.proof?.reviewerCoverage, active.proof?.auditorCoverage]) {
    if (!coverage?.records) throw new Error("宿主缺少完整核验证明，需重新验收");
    for (const ref of proofSources(coverage)) {
      if (!sourceVersionCurrent(frame.root, ref)) throw new Error("验收后来源已经变化（原文或获取回执），须重新判断，不能用旧证明关单：" + ref.file);
    }
    if (!projectPolicyProofsCurrent(frame, active.goal, coverage)) {
      throw new Error("验收使用的项目规则不再对应当前总纲，须重新核验");
    }
  }
}

/** Closure checks the rule version recorded by the role without adding a tool read. */
function projectPolicyProofsCurrent(frame, goal, coverage) {
  return (coverage.records ?? []).every(record => record.parts.every(part => {
    if (part.inference?.rule !== "project-policy") return true;
    const refs = part.inference.policy;
    return Array.isArray(refs) && refs.length > 0 && refs.every(ref =>
      ref.provenance === "current-project-policy" && ref.goalSha256 === goal?.sha256 && typeof ref.evidenceSpan === "string" &&
      includes(frame.policy.goalContext, ref.file) && goal.files?.some(row =>
        keyOf(row.file) === keyOf(ref.file) && row.sha256 === ref.sha256) && sourceVersionCurrent(frame.root, ref));
  }));
}

/** Obtain contract bytes from the same goal read used to calculate its pin. */
function goalMaterial(frame, captureContract) {
  if (!frame.policy.goalContext.length) throw new Error("请在 goalContext 或 ledgerContext 配置项目目标文件");
  let contractBytes;
  const files = frame.policy.goalContext.map(file => {
    const bytes = readBytes(frame.root, file);
    if (!bytes) throw new Error("项目目标文件不存在 " + file);
    if(captureContract&&keyOf(file)===keyOf(frame.policy.requiredLinesGoal))contractBytes=bytes;
    return { file, sha256: digest(bytes) };
  });
  return { snapshot:{ sha256: digest(JSON.stringify(files)), files },contractBytes };
}

/** Bind acceptance to explicit central files; hashes identify versions, not truth. */
export function goalSnapshot(frame) { return goalMaterial(frame,false).snapshot; }

/** Parse the one explicit maintenance contract. The JSON never enters status,
 * receipts or state, so a cross-role error cannot disclose draft snippets. */
function requiredLines(frame, bytes) {
  const rows=lineList(bytes),{fences}=requiredLineMarkdown(rows);
  if(fences.length!==1||!fences[0].canonical||fences[0].end===null)
    throw new Error("requiredLinesGoal 须有且仅有一个有效的顶层 building-loop-required-lines 代码围栏");
  const {start,end}=fences[0],payload=rows.slice(start+1,end).join("\n");
  if(Buffer.byteLength(payload)>64*1024)throw new Error("requiredLinesGoal 约束体积超限");
  let entries;
  try{entries=JSON.parse(payload);}catch{throw new Error("requiredLinesGoal 约束须为有效 JSON 数组");}
  if(!Array.isArray(entries)||entries.length>80)throw new Error("requiredLinesGoal 约束须为有界 JSON 数组");
  // JSON.parse keeps the last duplicate key. Count all raw key tokens and
  // compare with the accepted required fields and the two opt-in fields.
  const keys=[...payload.matchAll(/"(?:[^"\\]|\\[^\r\n])*"/gu)]
    .filter(match=>/^\s*:/u.test(payload.slice(match.index+match[0].length)));
  const table=new Map();let total=0,expectedKeys=0;
  for(const row of entries){
    const hasMarkers=!!row&&Object.hasOwn(row,"requiredMarkers");
    const hasProfile=!!row&&Object.hasOwn(row,"requiredCitationProfile");
    const fields=2+Number(hasMarkers)+Number(hasProfile);
    if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).length!==fields||
      typeof row.unit!=="string"||!Object.hasOwn(frame.policy.units,row.unit)||table.has(row.unit)||
      !Array.isArray(row.lines)||row.lines.length<1||row.lines.length>16){
      throw new Error("requiredLinesGoal 约束须登记已配置且不重复的单元和有界原句清单");
    }
    if(hasMarkers&&(!Array.isArray(row.requiredMarkers)||row.requiredMarkers.length>REQUIRED_MARKERS.size||
      row.requiredMarkers.some(marker=>!REQUIRED_MARKERS.has(marker))||new Set(row.requiredMarkers).size!==row.requiredMarkers.length)){
      throw new Error("requiredLinesGoal requiredMarkers 须为不重复的 [稿件自述] 或 [摘录范围] 标记清单");
    }
    let profileSource;
    if(hasProfile){
      const message="requiredLinesGoal requiredCitationProfile 须指定已授权给本单元补查读取及终审证据的来源文件";
      try{profileSource=relativeName(row.requiredCitationProfile);}catch{throw new Error(message);}
      const {candidate,phases}=frame.policy.units[row.unit];
      if(keyOf(candidate)===keyOf(profileSource)||!includes(phases.supplement.read,profileSource)||!includes(phases["final-review"].evidence,profileSource)){
        throw new Error(message);
      }
    }
    const literals=new Set();
    for(const literal of row.lines){
      if(typeof literal!=="string"||!literal.trim()||literal.length>2000||/[\r\n\x00-\x08\x0b-\x1f\p{Surrogate}]/u.test(literal)||
        literals.has(literal)||total>=128)throw new Error("requiredLinesGoal 单元内原句须为不重复的非空单行文字，且数量和长度有界");
      literals.add(literal);total++;
    }
    table.set(row.unit,{lines:row.lines,markers:row.requiredMarkers,profileSource});
    expectedKeys+=fields;
  }
  if(keys.length!==expectedKeys)throw new Error("requiredLinesGoal 约束字段重复或无效");
  return table;
}

/** Check raw physical equality once and require that occurrence to be live.
 * An identical row hidden elsewhere is still a duplicate, never an escape.
 */
export function requiredLineCheck(frame,id,candidate,pinned,observer) {
  if(!frame.policy.requiredLinesGoal)return {issues:[]};
  const {snapshot,contractBytes}=goalMaterial(frame,true);
  if(pinned&&snapshot.sha256!==pinned.sha256)throw new Error("项目目标在原句核对前发生变化，请按当前目标重新验收");
  const file=frame.policy.requiredLinesGoal,sha256=digest(contractBytes);
  if(observer){
    const seen=observer.seen?.[keyOf(file)];
    if(seen?.hash!==sha256||!seen.ranges.some(([a,b])=>a===1&&b>=lineList(contractBytes).length)){
      return {issues:["请先完整读取当前目标约束文件 "+file],pendingGoalRead:{file,reason:"current-required-lines-goal-read-required"}};
    }
  }
  // Preview first checks the goal observation even while candidate read-back
  // is pending, without calculating or returning any candidate detail.
  if(!candidate)return {issues:[]};
  const {lines:required=[],markers,profileSource}=requiredLines(frame,contractBytes).get(id)??{};
  const issues=[];
  if(required.length){
    const rows = lineList(candidate);
    const { live, visible, standaloneFootnotes, continuedFootnotes } = requiredLineMarkdown(rows);
    for(const [index,literal] of required.entries()){
      let count = 0, allowed = false, continuedFootnote = false;
      for (const [line, row] of rows.entries()) if (row === literal) {
        count++;
        allowed ||= live[line] || !!standaloneFootnotes[line];
        continuedFootnote ||= !!continuedFootnotes[line];
      }
      if(count!==1||!allowed){
        const detail=count===0?"缺失":count>1?"重复（含隐藏位置）":"只出现在非正文区域";
        const hint = count === 1 && continuedFootnote ? "。当前这行被纳入多行脚注定义，请在脚注定义之后插入空行，并保持脚注定义和正文各自独立。" : "";
        issues.push("当前目标原句第 "+(index+1)+" 项"+detail+"，须按 "+file+" 的本单元约束逐字保留一次"+hint);
      }
    }
    if(markers?.length){
      const counts=new Map(markers.map(marker=>[marker,0]));
      for(const [line,row] of rows.entries()){
        const marker=liveLeadingMarker(row,visible[line]);
        if(counts.has(marker))counts.set(marker,counts.get(marker)+1);
      }
      for(const [marker,count] of counts){
        if(count!==1)issues.push("当前目标标记 "+marker+(count===0?"缺失":"重复")+"，须按 "+file+" 的本单元约束在可见正文行首保留一次");
      }
    }
    if(profileSource){
      const clauses=candidateCitationProfiles(candidate,[profileSource],frame.policy.units[id].candidate);
      const head=clauses.find(clause=>clause.profileClause==="citation-lines");
      const marked=clauses.find(clause=>clause.profileClause==="marked-citation-lines");
      // Each existing clause matcher proves both its count and complete list.
      // They must describe one physical row, not separate substitute claims.
      if(clauses.length!==2||!head||!marked||head.line!==marked.line||
        liveLeadingMarker(rows[head.line-1],visible[head.line-1])!=="[稿件自述]"){
        issues.push("当前目标要求一条可见的组合稿件自述，须完整列出 "+profileSource+" 的定位行总数、完整行号和已标记子集的数量、完整行号");
      }else if(!head.matches||!marked.matches){
        issues.push("当前目标的组合稿件自述与当前候选复算不符，须重新核对总数、完整行号和已标记子集");
      }
    }
  }
  return {issues,proof:{file,sha256,count:required.length,...(markers?{requiredMarkerCount:markers.length}:{}),
    ...(profileSource?{citationProfileRequired:true}:{}),passed:issues.length===0}};
}

/** Every review sees the current goal in addition to the unchanged factual evidence. */
export function requireGoalRead(frame, active, refresh = false) {
  const current = goalSnapshot(frame);
  if (!refresh && active.goal?.sha256 !== current.sha256) throw new Error("项目目标已变，请总控 advance 重启当前目标的独立验收");
  for (const { file, sha256 } of current.files) {
    const seen = active.seen?.[keyOf(file)];
    const length = lineList(readBytes(frame.root, file)).length;
    if (seen?.hash !== sha256 || !seen.ranges.some(([a,b]) => a === 1 && b >= length)) {
      throw new Error("验收前须完整读取当前目标 " + file);
    }
  }
  // Executors can acknowledge a goal changed during their work after reading it;
  // reviewers must start a new independent checkpoint to avoid mixed-version receipts.
  if (refresh) active.goal = current;
  return current;
}

/** A changed goal, candidate or receipt invalidates closure, even after an earlier close. */
export function acceptedVersion(frame, id, active) {
  const bytes = readBytes(frame.root, active.receipt);
  if (!bytes || digest(bytes) !== active.receiptHash) throw new Error("验收回执在账本复核前发生变化，停止关单并核实");
  const receipt = JSON.parse(bytes.toString("utf8"));
  const spec = frame.policy.units[id];
  if (spec.architecture && !receipt.codeReview) throw new Error("缺少两道架构验收回执，须重新按当前工程单元验收");
  if (receipt.codeReview) {
    const current = goalSnapshot(frame);
    const candidate = readBytes(frame.root, spec.candidate);
    if (receipt.decision !== "accept" || receipt.goal?.sha256 !== current.sha256 ||
      !candidate || receipt.candidateSha256 !== digest(candidate) ||
      !engineeringArchitectureCurrent(frame, spec, active.engineeringArchitecture, active) ||
      !currentCodeReview(frame, id, active, spec, receipt, true)) {
      throw new Error("当前代码、目标或签名结果与两份独立验收不符，须重新取得签名回归和验收");
    }
    return receipt;
  }
  if (receipt.coverage?.version !== 1 || receipt.coverage.pending?.length !== 0 || receipt.coverage.rejected?.length !== 0
    || receipt.independentAudit?.coverage?.version !== 1 || receipt.independentAudit.coverage.pending?.length !== 0
    || receipt.independentAudit.coverage.rejected?.length !== 0 || !receipt.independentAudit.auditor
    || receipt.independentAudit.auditor === receipt.reviewer || receipt.independentAudit.auditor === active.executor) {
    throw new Error("验收缺少完整全文核验和独立反证回执，需重新验收");
  }
  const current = goalSnapshot(frame);
  if (receipt.goal?.sha256 !== current.sha256 || receipt.goalFit?.pass !== true) {
    throw new Error("验收未覆盖当前目标，请总控 advance 重新独立验收；原事实证据保留");
  }
  const candidate = readBytes(frame.root, frame.policy.units[id].candidate);
  if (!candidate || receipt.candidateSha256 !== digest(candidate) || receipt.decision !== "accept") {
    throw new Error("当前候选与通过回执不一致，请总控 advance 重新独立验收");
  }
  if (!reviewedCodeArtifactsCurrent(frame, id, active, receipt)) {
    throw new Error("已验收代码的交付文件发生变化，须重新取得签名回归结果和独立验收");
  }
  if(active.phase!=="closed"){
    const preservation=requiredLineCheck(frame,id,candidate,current);
    if(preservation.issues.length)throw new Error(preservation.issues.join("；"));
  }
  requireProofSources(frame, id, active);
  const coverages=[active.proof.reviewerCoverage, active.proof.auditorCoverage];
  if(active.phase!=="closed"||receipt.deliveryOutcomes) {
    requireAcceptedDeliveryOutcomes(deliveryOutcomeContract(frame,spec,current),candidate,receipt,active.proof);
  }
  requireStoredCalculations(frame, spec, coverages, candidate);
  requireStoredObjectChecks(frame, spec, coverages, candidate, receipt.phase);
  // Do not retroactively reinterpret a completed historical receipt. Open
  // units, including accepted units still awaiting their ledger, need it now.
  if(active.phase!=="closed")requireStoredFootnoteBindings(spec,coverages,candidate,receipt.phase,active.goal);
  for (const ref of [...(receipt.checks ?? []), ...(receipt.observedSources ?? [])]) {
    if (ref.file && ref.sha256 && !sourceVersionCurrent(frame.root, ref)) throw new Error("验收后编号证据或获取回执已经变化：" + ref.file);
  }
  for (const calculation of receipt.calculations ?? []) {
    const source = frame.policy.units[id].calculations[calculation.id]?.source;
    const sourceBytes = source && readBytes(frame.root, source);
    if (source && calculation.sourceHash && (!sourceBytes || digest(sourceBytes) !== calculation.sourceHash)) {
      throw new Error("验收后复算来源已经变化，需重新验收");
    }
  }
  const layout = plainLastIssues(frame.policy.units[id], lineList(candidate));
  if (layout.length) throw new Error(layout.join("；"));
  return receipt;
}

/** Permit revalidation without granting the coordinator access to module contents. */
export function needsRevalidation(frame, id, active) {
  if (!active) return false;
  const phase = active.phase === "blocked" ? active.resumePhase : active.phase;
  if (["first-audit", "final-audit", "first-audit-ready", "final-audit-ready"].includes(phase)) {
    const pending = active.pendingReceipt;
    const candidate = readBytes(frame.root, frame.policy.units[id].candidate);
    if (!pending || !candidate || pending.candidateSha256 !== digest(candidate) || !reviewedCodeArtifactsCurrent(frame, id, active, pending)) return true;
    if (pending.codeReview) {
      if (!currentCodeReview(frame, id, active, frame.policy.units[id], pending)) return true;
    } else {
      try {
        const unit=frame.policy.units[id];
        requireStoredFootnoteBindings(unit,[pending.coverage],candidate,pending.phase,active.goal);
        const contract=deliveryOutcomeContract(frame,unit,active.goal);
        const outcomes=reviewDeliveryOutcomes(contract,candidate,pending.coverage,pending.reviewer,pending.deliveryOutcomes?.items);
        if(outcomes&&JSON.stringify(outcomes)!==JSON.stringify(pending.deliveryOutcomes))return true;
      }
      catch { return true; }
      for (const ref of [...(pending.checks ?? []), ...(pending.observedSources ?? [])]) {
        if (ref.file && ref.sha256 && !sourceVersionCurrent(frame.root, ref)) return true;
      }
      for (const ref of proofSources(pending.coverage)) {
        if (!sourceVersionCurrent(frame.root, ref)) return true;
      }
      if (!projectPolicyProofsCurrent(frame, active.goal, pending.coverage)) return true;
    }
  }
  // Old rejected fingerprints cannot describe text after a citation. Rebuild them
  // through the independent reviewer, never by treating the edited draft as baseline.
  if (["supplement-ready","supplement","blocked"].includes(active.phase)
    && active.unsupported?.some(claim => active.rejected?.[claim]?.version !== 2)) return true;
  if (["ledger-review", "closed"].includes(active.phase)) {
    try { acceptedVersion(frame, id, active); return false; } catch { return true; }
  }
  return ["first-review", "final-review", "first-audit", "final-audit", "first-audit-ready", "final-audit-ready", "goal-review-ready"].includes(phase)
    && active.goal?.sha256 !== goalSnapshot(frame).sha256;
}
