import { digest, keyOf, readBytes } from "./policy.mjs";
import { lineList, plainLastIssues } from "./preflight.mjs";
import { sourceVersionCurrent } from "./evidence.mjs";
import { requireStoredCalculations } from "./coverage.mjs";

/** All evidence used by either reviewer stays pinned through final ledger closure.
 * This reads host proof metadata only; it does not grant the coordinator source access.
 */
function requireProofSources(frame, id, active) {
  for (const coverage of [active.proof?.reviewerCoverage, active.proof?.auditorCoverage]) {
    if (!coverage?.records) throw new Error("宿主缺少完整核验证明，需重新验收");
    for (const record of coverage.records) for (const part of record.parts) {
      const refs = [...(part.evidence ?? []), ...(part.inference?.premises ?? []), ...(part.inference?.warrant ?? []),
        ...(part.inference?.assumptions ?? []).map(row => row.evidence)];
      for (const ref of refs) {
        if (!sourceVersionCurrent(frame.root, ref)) throw new Error("验收后来源已经变化（原文或获取回执），须重新判断，不能用旧证明关单：" + ref.file);
      }
    }
    for (const quote of coverage.quotations ?? []) for (const ref of quote.refs) {
      if (!sourceVersionCurrent(frame.root, ref)) throw new Error("验收后引文来源或获取回执已经变化");
    }
  }
}

/** Bind acceptance to explicit central files; hashes identify versions, not truth. */
export function goalSnapshot(frame) {
  if (!frame.policy.goalContext.length) throw new Error("请在 goalContext 或 ledgerContext 配置项目目标文件");
  const files = frame.policy.goalContext.map(file => {
    const bytes = readBytes(frame.root, file);
    if (!bytes) throw new Error("项目目标文件不存在 " + file);
    return { file, sha256: digest(bytes) };
  });
  return { sha256: digest(JSON.stringify(files)), files };
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
  requireProofSources(frame, id, active);
  requireStoredCalculations(frame, frame.policy.units[id], [active.proof.reviewerCoverage, active.proof.auditorCoverage], candidate);
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
    if (!pending || !candidate || pending.candidateSha256 !== digest(candidate)) return true;
    for (const ref of [...(pending.checks ?? []), ...(pending.observedSources ?? [])]) {
      if (ref.file && ref.sha256 && !sourceVersionCurrent(frame.root, ref)) return true;
    }
    for (const record of pending.coverage?.records ?? []) for (const part of record.parts) {
      const refs = [...(part.evidence ?? []), ...(part.inference?.premises ?? []), ...(part.inference?.warrant ?? []),
        ...(part.inference?.assumptions ?? []).map(row => row.evidence)];
      for (const ref of refs) {
        if (!sourceVersionCurrent(frame.root, ref)) return true;
      }
    }
    for (const quote of pending.coverage?.quotations ?? []) for (const ref of quote.refs) {
      if (!sourceVersionCurrent(frame.root, ref)) return true;
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
