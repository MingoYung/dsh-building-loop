import { digest, keyOf, readBytes } from "./policy.mjs";
import { lineList } from "./preflight.mjs";

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
  const current = goalSnapshot(frame);
  if (receipt.goal?.sha256 !== current.sha256 || receipt.goalFit?.pass !== true) {
    throw new Error("验收未覆盖当前目标，请总控 advance 重新独立验收；原事实证据保留");
  }
  const candidate = readBytes(frame.root, frame.policy.units[id].candidate);
  if (!candidate || receipt.candidateSha256 !== digest(candidate) || receipt.decision !== "accept") {
    throw new Error("当前候选与通过回执不一致，请总控 advance 重新独立验收");
  }
  return receipt;
}

/** Permit revalidation without granting the coordinator access to module contents. */
export function needsRevalidation(frame, id, active) {
  if (!active) return false;
  // Old rejected fingerprints cannot describe text after a citation. Rebuild them
  // through the independent reviewer, never by treating the edited draft as baseline.
  if (["supplement-ready","supplement","blocked"].includes(active.phase)
    && active.unsupported?.some(claim => active.rejected?.[claim]?.version !== 2)) return true;
  if (["ledger-review", "closed"].includes(active.phase)) {
    try { acceptedVersion(frame, id, active); return false; } catch { return true; }
  }
  return ["first-review", "final-review", "goal-review-ready"].includes(active.phase)
    && active.goal?.sha256 !== goalSnapshot(frame).sha256;
}
