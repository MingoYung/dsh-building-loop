import path from "node:path";
import { goalSnapshot } from "./goals.mjs";
import { TERMINAL } from "./ledger.mjs";
import { isImplementationPath, keyOf, readBytes, text } from "./policy.mjs";
import { workspaceStateFile } from "./session-mode.mjs";
import { STATE_LIMIT } from "./transactions.mjs";
import { DIAGNOSIS_WAIT } from "./stall-diagnostics.mjs";

const UNIT = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FINISHED_ITEM = new Set(["completed", "covered", "obsolete", "superseded"]);

export class EngineeringHandoffDenied extends Error {}

/** Parse only ordinary owner prose, never pasted fenced samples or quotes. */
function ownerClauses(original) {
  if (!original || original.length > 8000) return [];
  const clauses = [];
  let fence;
  for (const line of original.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (/^\s*>|^ {4}|^\t/u.test(line)) continue;
    clauses.push(...line.split(/[。！；;]+/u).map(clause => clause.trim()));
  }
  return clauses.map(clause => clause.replace(/^(?:请\s*)?(?:现在\s*)?(?:开始(?:项目建设|建设|调研|研究)|启动\s*building[- ]loop)\s*[:：]\s*/iu, ""));
}

function oneClause(original, pattern, duplicate) {
  const matches = ownerClauses(original).flatMap(clause => {
    const match = pattern.exec(clause);
    return match ? [match[1]] : [];
  });
  const unique = [...new Set(matches)];
  if (unique.length > 1) throw new Error(duplicate);
  return unique[0];
}

/** Only a complete affirmative unit clause from the real owner's text is eligible. */
export function ownerEngineeringUnit(original) {
  return oneClause(original,
    /^(?:(?:若有工作单元[，,]\s*)?G[1-9]\d*\s*是\s*|(?:请(?:使用|推进|执行|选择)\s*)?(?:工作单元|单元)\s*[:：]?\s*)([A-Za-z][A-Za-z0-9_-]{0,47})[.!]?$/u,
    "开工原文指定了多个不同工作单元，请明确本次唯一工作单元");
}

export function ownerEngineeringReplacement(original) {
  return oneClause(original, /^(?:请\s*)?(?:以新目标\s*)?替换工作单元\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]{0,47})[.!]?$/u,
    "开工原文指定了多个替换对象，请明确唯一的旧工作单元");
}

/** Old activation records omit a checkpoint. Validate only new host-derived bindings. */
export function checkedEngineeringCheckpoint(value) {
  const replacement = value?.replaceUnit;
  if (!value || Object.keys(value).length !== 4 + Number(replacement !== undefined) || typeof value.unit !== "string" ||
    !UNIT.test(value.unit) || !SHA256.test(value.policySha256 ?? "") || !SHA256.test(value.goalSha256 ?? "") ||
    (value.predecessor !== null && !SHA256.test(value.predecessor ?? "")) ||
    (replacement !== undefined && (typeof replacement !== "string" || !UNIT.test(replacement) || replacement === value.unit))) {
    throw new Error("Building-loop 工程开工绑定无效");
  }
  return { unit: value.unit, policySha256: value.policySha256, goalSha256: value.goalSha256, predecessor: value.predecessor,
    ...(replacement === undefined ? {} : { replaceUnit: replacement }) };
}

function engineering(unit) {
  return unit.codeTask || [...unit.phases.intake.write, ...unit.phases.supplement.write].some(isImplementationPath);
}

/** Consent pins the exact authorized goal bytes and current lease generation before any coordinator mutation. */
export function bindEngineeringCheckpoint(hostHome, root, policy, proposal) {
  const units = Object.keys(policy.units);
  if (!units.some(id => engineering(policy.units[id]))) return undefined;
  const unit = proposal.ownerUnit ?? ownerEngineeringUnit(proposal.instruction) ?? (units.length === 1 ? units[0] : undefined);
  if (!unit) throw new Error("当前工程有多个授权工作单元。请所有者明确本次单元，例如在开工消息中单独写“工作单元 K02。”");
  if (!Object.hasOwn(policy.units, unit)) throw new Error("所有者指定的工作单元未获授权：" + unit);
  const bytes = readBytes(path.join(hostHome, "building-loop-state"), workspaceStateFile(root), STATE_LIMIT);
  const state = bytes && JSON.parse(text(bytes));
  if (state && state.spec !== "building-loop-state/1") throw new Error("工作台账版本无效");
  const replaceUnit = proposal.replaceUnit ?? ownerEngineeringReplacement(proposal.instruction);
  const lease = state?.engineeringCoordinator;
  if (replaceUnit && (unit === replaceUnit || lease?.unit !== replaceUnit)) {
    throw new Error("替换工作单元须指定当前工程总控持有且不同于本次目标的旧单元");
  }
  return checkedEngineeringCheckpoint({ unit, policySha256: policy.hash, goalSha256: goalSnapshot({ root, policy }).sha256,
    predecessor: lease?.openingId ?? null, ...(replaceUnit ? { replaceUnit } : {}) });
}

/** A tool may omit the bound unit, but cannot substitute another ID or a changed project goal. */
export function resolveBoundUnit(frame, requested) {
  const checkpoint = frame.started?.binding.checkpoint;
  if (!checkpoint) return requested;
  if (requested !== undefined && requested !== checkpoint.unit) {
    throw new Error("所有者已确认工作单元 " + checkpoint.unit + "；当前调用不能推进 " + requested);
  }
  if (checkpoint.policySha256 !== frame.policy.hash || checkpoint.goalSha256 !== goalSnapshot(frame).sha256) {
    throw new Error("已确认的工程目标或授权版本已变化，请在新的主会话按当前目标和单元重新确认开工");
  }
  return checkpoint.unit;
}

/** A previously confirmed contender cannot seize a lease that changed after its confirmation. */
export function engineeringAccess(state, owner, started) {
  const lease = state?.engineeringCoordinator;
  if (!lease || lease.session === owner) return true;
  return started?.binding.checkpoint?.predecessor === lease.openingId;
}

/** Recover the exact predecessor opening, including leases written before the goal was stored. */
function planningPredecessor(frame, lease) {
  const opening = frame.startedProject(lease.session);
  const checkpoint = opening?.binding.checkpoint;
  if (opening?.proposal.id !== lease.openingId || opening.binding.kind !== "workspace" ||
    keyOf(opening.binding.root) !== keyOf(frame.root) || checkpoint?.unit !== lease.unit ||
    (lease.goalSha256 !== undefined && lease.goalSha256 !== checkpoint.goalSha256)) {
    throw new EngineeringHandoffDenied("无法核对原总控尚未派单的开工记录，需维护者确认");
  }
  return checkpoint;
}

function assessClaim(frame) {
  const { state, started, agent } = frame;
  const checkpoint = started?.binding.checkpoint;
  if (!checkpoint) return {};
  const lease = state.engineeringCoordinator;
  if (lease?.session === agent.id && lease.openingId === started.proposal.id) return {};
  const blocked = issue => ({ issue });
  if ((lease?.openingId ?? null) !== checkpoint.predecessor) return blocked("工程总控交接版本已变化，请按当前项目重新确认开工");
  if (Object.hasOwn(state.units, checkpoint.unit)) return blocked("工作单元 " + checkpoint.unit + " 已有宿主记录；新一轮请使用新的授权单元");
  if (lease && !Object.hasOwn(state.units, lease.unit)) {
    // A failed native activation can leave its durable unit ledger entry even
    // after rolling back the stage row. That is not an undispatched plan.
    if (Object.hasOwn(state.ledger?.items ?? {}, "unit-" + lease.unit)) return blocked("原计划已有派单台账记录，需维护者核对派单结果后再接手");
    if (Object.values(state.units).some(unit => !TERMINAL.has(unit.phase))) return blocked("工作区仍有其他未关单单元，不能替换尚未派单的计划");
    if (checkpoint.replaceUnit && checkpoint.replaceUnit !== lease.unit) return blocked("替换对象与当前工程总控记录不一致");
    const previous = planningPredecessor(frame, lease);
    if (previous.goalSha256 === checkpoint.goalSha256) return blocked("原总控尚未派单，须先发布与原计划不同的新目标版本才能接手");
    return { planning: previous };
  }
  if (checkpoint.replaceUnit) {
    const previous = state.units[checkpoint.replaceUnit];
    if (lease?.unit !== checkpoint.replaceUnit || previous?.owner !== lease.session) return blocked("替换对象与当前工程总控记录不一致");
    if (!SHA256.test(previous.goal?.sha256 ?? "") || previous.goal.sha256 === checkpoint.goalSha256) return blocked("须先发布与原单元不同的新目标版本才能替换");
    // A parked diagnosis has already revoked every child grant. An explicit
    // replacement may retire it under the same rule as an interrupted unit.
    if (previous.phase !== "blocked" && !DIAGNOSIS_WAIT.has(previous.phase)) {
      return blocked("原工作单元仍未退出活动阶段或已关单；只有已挂起的未完成单元可以替换");
    }
    if (Object.entries(state.units).some(([id, unit]) => id !== checkpoint.replaceUnit && !TERMINAL.has(unit.phase))) {
      return blocked("工作区仍有其他未关单单元，当前替换不能接管其权限");
    }
    return {};
  }
  if (Object.values(state.units).some(unit => !TERMINAL.has(unit.phase))) {
    return blocked("原总控仍有写入权或未关单工作。请先完成原工作单元的关单，再从同一工作区接手");
  }
  return {};
}

/** The next exact action is visible even while an older work unit prevents takeover. */
export function engineeringStatus(frame) {
  const checkpoint = frame.started?.binding.checkpoint;
  if (!checkpoint || frame.role !== "coordinator") return undefined;
  let blocked;
  try { resolveBoundUnit(frame); blocked = assessClaim(frame).issue; }
  catch (error) { blocked = error.message; }
  return { unit: checkpoint.unit, goalSha256: checkpoint.goalSha256, policySha256: checkpoint.policySha256,
    ...(checkpoint.replaceUnit ? { replaceUnit: checkpoint.replaceUnit } : {}),
    ...(blocked ? { blocked } : { advance: { action: "advance", unit: checkpoint.unit } }) };
}

/** Transfer future administration, never old accepted ownership, inside the workspace transaction. */
export function claimEngineeringCoordinator(frame) {
  if (frame.role !== "coordinator" || !frame.started?.binding.checkpoint) return;
  const unit = resolveBoundUnit(frame);
  const { state, started, agent } = frame;
  const prior = state.engineeringCoordinator;
  if (prior?.session === agent.id && prior.openingId === started.proposal.id) return;
  const { issue, planning } = assessClaim(frame);
  if (issue) throw new EngineeringHandoffDenied(issue);
  const owners = [...new Set(Object.values(state.units).map(row => row.owner))];
  const previousOwner = prior?.session ?? (owners.length === 1 ? owners[0] : undefined);
  const { replaceUnit, goalSha256 } = started.binding.checkpoint;
  if (replaceUnit && !planning) {
    const old = state.units[replaceUnit];
    const retirement = { outcome: "superseded", oldGoalSha256: old.goal.sha256, newGoalSha256: goalSha256,
      previousPhase: old.resumePhase, previousBlock: old.blocked, newUnit: unit, confirmedBy: agent.id,
      openingId: started.proposal.id, userEvent: started.source.seq, userSha256: started.source.sha256 };
    old.phase = "retired";
    old.retirement = retirement;
    const item = state.ledger?.items["unit-" + replaceUnit];
    if (item) {
      state.ledger.items[item.id] = { ...item, status: "superseded", retirement,
        note: "所有者明确以新目标替换此未完成单元。旧执行记录、证据和原始状态保留。", updatedAt: new Date().toISOString() };
      state.ledger.revision++;
    }
  }
  if (previousOwner && previousOwner !== agent.id) {
    const ledger = state.ledger;
    for (const item of Object.values(ledger?.items ?? {})) {
      if (item.owner !== previousOwner || item.unit || FINISHED_ITEM.has(item.status)) continue;
      ledger.items[item.id] = { ...item, owner: agent.id, originalOwner: item.originalOwner ?? previousOwner,
        handedOffFrom: previousOwner };
      ledger.revision++;
    }
  }
  state.engineeringCoordinator = { session: agent.id, openingId: started.proposal.id, unit, goalSha256,
    historyOwners: [...new Set([...(prior?.historyOwners ?? []), ...(previousOwner && previousOwner !== agent.id ? [previousOwner] : [])])] };
  if (planning) {
    // No child was granted a stage. Record replacement of the opening itself,
    // leaving units, any architecture draft, and prior ledger items as they were.
    state.planningHandoff = { previousUnit: prior.unit, previousOwner: prior.session, previousOpeningId: prior.openingId,
      oldGoalSha256: planning.goalSha256, newGoalSha256: goalSha256, unit, owner: agent.id, openingId: started.proposal.id,
      userEvent: started.source.seq, userSha256: started.source.sha256 };
  }
  frame.changed = true;
}
