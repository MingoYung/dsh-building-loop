import { goalSnapshot } from "./goals.mjs";
import { inspectArchitectureImports } from "./code-review.mjs";
import { digest, includes, keyOf, readBytes, replaceWithHistory } from "./policy.mjs";
import { architectureDocument, architectureImportsSection } from "./project-hierarchy.mjs";

/** A plan is published by the coordinator under the same lock as dispatch. */
export function registerEngineeringArchitecture(frame, unit, spec, tag) {
  const active = frame.state.units[unit];
  if (!spec.architecture || frame.role !== "coordinator" || !includes(frame.writes, spec.architecture.file) ||
    active && active.owner !== frame.agent.id) throw new Error("只有获授权的本单元总控能登记架构稿");
  if (active && !["review-ready", "final-review-ready", "architecture-sync", "architecture-repair", "ledger-review", "blocked"].includes(active.phase)) {
    throw new Error("只在派单前、代码待审或架构退回时登记架构稿；正在工作的子会话须先结束阶段");
  }
  const goal = goalSnapshot(frame);
  let plan = architectureDocument(frame, spec.architecture);
  const previous = frame.state.engineeringArchitecture?.[keyOf(plan.file)];
  if (previous?.goalSha256 !== goal.sha256 && previous?.contentsSha256 === plan.contentsSha256) {
    throw new Error("目标已变化，请把受影响的架构、回退与验证计划实际更新到 " + plan.file);
  }
  if (active?.phase === "architecture-repair" && active.engineeringArchitecture?.contentsSha256 === plan.contentsSha256) {
    throw new Error("架构已退回，请实际修改对应内容后再登记");
  }
  const imports = inspectArchitectureImports(frame, spec, active);
  if (imports && !imports.match) {
    replaceWithHistory(frame.root, plan.file, before => {
      if (!before || digest(before) !== imports.sha256) throw new Error("静态导入生成时架构正文已变化，请重新登记");
      return imports.proposed;
    }, "宿主根据当前代码更新实际本地静态导入", tag, frame.state.markers);
    plan = architectureDocument(frame, spec.architecture);
  }
  const snapshot = { ...plan, goalSha256: goal.sha256, unit, owner: frame.agent.id };
  frame.state.engineeringArchitecture = { ...frame.state.engineeringArchitecture, [keyOf(plan.file)]: snapshot };
  if (active) {
    active.engineeringArchitecture = snapshot;
    if (active.phase === "architecture-sync") {
      active.phase = active.architectureSyncResume;
      delete active.architectureSyncResume;
    } else if (active.phase === "architecture-repair") {
      active.phase = active.codeReviewRejection ? "supplement-ready" : "final-review-ready";
    } else if (active.phase === "ledger-review" && previous?.sha256 !== snapshot.sha256) {
      active.phase = "final-review-ready";
    } else if (active.phase === "blocked" && ["first-review", "first-audit", "final-review", "final-audit"].includes(active.resumePhase) &&
      previous?.sha256 !== snapshot.sha256) {
      active.phase = "final-review-ready";
      delete active.pendingReceipt;
      delete active.resumePhase;
    }
  }
  frame.changed = true;
  return { unit, phase: active?.phase ?? "dispatch", architecture: snapshot };
}

export function engineeringArchitectureCurrent(frame, spec, snapshot, active, checkImports = true) {
  if (!spec.architecture) return true;
  const file = spec.architecture.file;
  const bytes = readBytes(frame.root, file);
  if (snapshot?.file !== file || !bytes || snapshot.sha256 !== digest(bytes) ||
    snapshot.goalSha256 !== goalSnapshot(frame).sha256) return false;
  try { return architectureDocument(frame, spec.architecture).sha256 === snapshot.sha256 &&
    (!checkImports || !spec.architecture.importsHeading || inspectArchitectureImports(frame, spec, active).match); }
  catch { return false; }
}

export function requireEngineeringArchitecture(frame, unit, spec, active, checkImports = true) {
  if (!spec.architecture) return;
  const snapshot = active?.engineeringArchitecture ?? frame.state.engineeringArchitecture?.[keyOf(spec.architecture.file)];
  if (snapshot?.unit !== unit || snapshot.owner !== (frame.assignment?.[1].owner ?? frame.agent.id) ||
    !engineeringArchitectureCurrent(frame, spec, snapshot, active, checkImports)) {
    throw new Error("请总控维护当前目标的架构稿 " + spec.architecture.file + "，再用 building_loop architecture 登记实际版本");
  }
  return snapshot;
}

/** Include only the exact authorized path and next action in coordinator packets. */
export function engineeringArchitectureStatus(frame, unit) {
  const spec = frame.policy.units[unit];
  if (!spec?.architecture || frame.role !== "coordinator") return;
  const active = frame.state.units[unit];
  const { file, headings } = spec.architecture;
  if (active?.phase === "architecture-repair") {
    return { file, headings, status: "repair", receipt: active.receipt, next: { action: "architecture", unit } };
  }
  if (active?.phase === "architecture-sync") {
    return { file, headings, status: "sync", next: { action: "architecture", unit } };
  }
  try {
    const snapshot = requireEngineeringArchitecture(frame, unit, spec, active);
    return { file, headings, status: "registered", sha256: snapshot.sha256 };
  } catch (error) {
    return { file, headings, status: "required", reason: error.message, next: { action: "architecture", unit } };
  }
}

/** Preserve the designated generated body when the coordinator edits prose. */
export function requireHostImportSectionUnchanged(frame, file, proposed) {
  const spec = Object.values(frame.policy.units).find(unit => unit.architecture?.importsHeading && includes([unit.architecture.file], file));
  if (!spec) return;
  const current = architectureImportsSection(frame, spec);
  const next = architectureImportsSection(frame, spec, proposed);
  if (current.source.slice(current.bodyStart, current.bodyEnd).trim() !== next.source.slice(next.bodyStart, next.bodyEnd).trim()) {
    throw new Error("静态导入章节由宿主生成。保留该章节原文，用 building_loop architecture 更新");
  }
}

/** Only the actual coordinator-owned architecture location can route repair
 * to the coordinator. Mixed findings still require the original code repair. */
export function engineeringRepair(proof) {
  const architecture = proof.architecture?.status === "revise";
  const code = proof.files.some(row => (row.comments ?? [row.comment]).some(comment => comment?.status === "missing")) ||
    proof.constraints.some(row => row.status === "revise") || proof.findings.some(row => row.owner !== "coordinator");
  return { architecture, code };
}
