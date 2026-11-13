import { randomUUID } from "node:crypto";
import { digest } from "./policy.mjs";

export const STALL_LAYERS = Object.freeze(["parameters", "runner", "syntax", "behavior"]);
export const DIAGNOSIS_WAIT = new Set(["diagnosis-ready", "diagnosis-verify", "diagnosis-repair-ready"]);
const REPEATED_FAILURES = 3;
const UNPRODUCTIVE_PROBES = 4;
const MAX_OBSERVATIONS = 64;
const MAX_SIGNATURES = 16;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9_.:/-]{0,119}$/iu;
const SYNTAX_ERRORS = new Set(["SyntaxError", "IndentationError", "TabError", "ParseError"]);
const RUNNER_ERRORS = new Set(["runner-unavailable", "runner-transport-error", "invalid-runner-reply",
  "snapshot-error", "check-unavailable", "timeout"]);

/** Request digests also bind the operation and its data. Diagnosis instead
 * compares the actual candidate bytes across operations on the same version.
 */
export function stallArtifactSha256(artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length ||
    artifacts.some(row => typeof row?.path !== "string" ||
      (row.sha256 !== null && !SHA256.test(row.sha256 ?? "")))) return undefined;
  const versions = artifacts.map(({ path, sha256 }) => [path, sha256]);
  versions.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return digest(JSON.stringify(versions));
}

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

function errorClass(message) {
  if (typeof message !== "string") return undefined;
  return /^\s*([A-Z][A-Za-z]*(?:Error|Exception))(?::|\s*$)/mu.exec(message)?.[1];
}

function caseFailure(error, sourceKind, fallbackPath) {
  const exception = errorClass(error.message);
  const layer = SYNTAX_ERRORS.has(exception) ? "syntax" : "behavior";
  return {
    layer, kind: sourceKind, caseId: safeId(error.caseId), exception,
    outputSha256: typeof error.message === "string" ? digest(error.message.trim()) : undefined,
    path: error.path ?? error.stack?.at(-1)?.path, fallbackPath,
  };
}

function failureOf(observation) {
  const { result, operation, recipe, toolAction, fallbackPath } = observation;
  if (["invalid-input", "invalid-parameters", "bad-parameters"].includes(result.status)) {
    return { layer: "parameters", kind: "invalid-input", recipe: safeId(recipe ?? result.recipe ?? toolAction),
      field: safeId(result.field) };
  }
  if (result.status === "timeout" || result.status === "unavailable") {
    const kind = result.reason ?? (result.status === "timeout" ? "timeout" : "check-unavailable");
    if (RUNNER_ERRORS.has(kind)) return { layer: "runner", kind };
  }
  if (result.status !== "failed") return undefined;
  if (operation === "probe") {
    const syntax = syntaxProof(observation);
    if (syntax) return { layer: "syntax", kind: syntax.kind, recipe, path: syntax.path };
    const exception = errorClass(result.probe?.stderr);
    return { layer: "behavior", kind: "probe-failed",
      recipe: safeId(recipe), exception, exitCode: result.probe?.exitCode,
      outputSha256: exception ? undefined : digest(JSON.stringify([result.probe?.stderr, result.probe?.stdout])),
      path: result.probe?.stack?.at(-1)?.path ?? fallbackPath };
  }
  const candidates = [];
  const old = result.old?.firstError ?? result.firstError;
  if (old) candidates.push(caseFailure(old, "protected-check-failed", fallbackPath));
  for (const row of result.required ?? []) {
    if (row.status === "failed" && row.error) candidates.push(caseFailure(row.error, "required-check-failed", fallbackPath));
  }
  return candidates.find(candidate => candidate.layer === "syntax") ?? candidates[0] ??
    { layer: "behavior", kind: "check-failed" };
}

function failureKey(failure) {
  // Avoid changing stack offsets in the key. Include a digest of the actual
  // failure text where available, so a single case can fail in distinct ways.
  const { layer, kind, caseId, recipe, field, exception, exitCode, path, outputSha256 } = failure;
  return digest(JSON.stringify([layer, kind, caseId, recipe, field, exception, exitCode, outputSha256,
    layer === "syntax" ? path : undefined]));
}

function freezeDiagnostic(active, artifactSha256, failure, repeatCount, trigger) {
  const { layer, kind, caseId, path, fallbackPath, recipe } = failure;
  active.stallDiagnostic = {
    id: randomUUID(), status: "needs-triage", artifactSha256,
    suggestedLayer: layer, failureKind: kind, repeatCount, trigger,
    ...(caseId ? { caseId } : {}), ...(path ?? fallbackPath ? { suspectedPath: path ?? fallbackPath } : {}),
    ...(recipe ? { stalledRecipe: recipe } : {}),
  };
  return active.stallDiagnostic;
}

/** Called under the state lock only after validating the runner response or
 * detecting a host-side input error. Model explanations cannot add attempts.
 */
export function observeExecutionDiagnostic(active, observation) {
  const { artifacts, requestId, operation = "check", result, goalSha256, changed } = observation;
  const artifactSha256 = stallArtifactSha256(artifacts);
  if (!artifactSha256 || !safeId(requestId) || !result || active.stallDiagnostic &&
    active.stallDiagnostic.status !== "resolved") return undefined;
  const fallbackPath = observation.fallbackPath ?? changed?.path;
  const classified = failureOf({ ...observation, operation, fallbackPath });
  const executed = result.status === "passed" || result.status === "failed";
  if (!classified && !executed) return undefined;
  // Resuming the original executor gets a fresh observation window. The same
  // artifact can stall again if that repair attempt also makes no progress.
  if (active.stallDiagnostic?.status === "resolved") {
    delete active.stallDiagnostic;
    delete active.stallObservations;
  }
  let window = active.stallObservations;
  if (window?.artifactSha256 !== artifactSha256 || window.goalSha256 !== goalSha256 ||
    window.phase !== active.phase || window.serial !== active.serial) {
    window = { artifactSha256, goalSha256, phase: active.phase, serial: active.serial, attempts: [], failures: [], probes: 0 };
    if (active.stallObservations) delete active.stallObservations;
  }
  if (window.attempts.includes(requestId)) return undefined;
  // An exploratory nonzero exit can be correct for intentionally invalid
  // input. Treat it as evidence of a stall only with a full failing check.
  const failure = classified?.kind === "probe-failed" && !window.pendingCheck?.eligible ? undefined : classified;
  if (!failure && (operation === "check" ? !window.failures.length : !window.pendingCheck?.eligible)) return undefined;
  // A replaced window is the signal for the host to persist an observation.
  // Ignore no-op probes and checks instead of rewriting the workspace backup.
  window = active.stallObservations = { ...window, attempts: [...window.attempts],
    failures: window.failures.map(row => ({ ...row })), pendingCheck: window.pendingCheck && { ...window.pendingCheck } };
  window.attempts.push(requestId);
  if (window.attempts.length > MAX_OBSERVATIONS) window.attempts.shift();

  if (operation === "check" && !failure) {
    // The full registered check supersedes exploratory evidence at this version.
    window.failures = [];
    window.probes = 0;
    delete window.pendingCheck;
    return undefined;
  }
  if (failure) {
    const key = failureKey(failure);
    let row = window.failures.find(item => item.key === key);
    if (!row) {
      row = { key, count: 0 };
      window.failures.push(row);
      if (window.failures.length > MAX_SIGNATURES) window.failures.shift();
    }
    row.count++;
    if (row.count >= REPEATED_FAILURES) {
      return freezeDiagnostic(active, artifactSha256, failure, row.count, "repeated-failure");
    }
    if (operation === "check" && result.status === "failed") {
      if (window.pendingCheck?.key !== key) {
        window.pendingCheck = { key, count: 0, eligible: false };
        window.probes = 0;
      }
      window.pendingCheck.count++;
      window.pendingCheck.eligible ||= Boolean(fallbackPath) || window.pendingCheck.count >= 2;
      window.pendingCheck.failure = failure;
    }
  }

  if (operation === "probe" && window.pendingCheck?.eligible && executed) {
    // A narrow reproduction can succeed even while the broader registered
    // check remains failed. Allow initial exploration, then count probes after
    // a landed edit still failed or two checks confirmed the same failure.
    window.probes++;
    if (window.probes >= UNPRODUCTIVE_PROBES) {
      return freezeDiagnostic(active, artifactSha256, window.pendingCheck.failure, window.probes, "unchanged-after-probes");
    }
  }
  return undefined;
}

export function stallDiagnosticSummary(active) {
  const record = active?.stallDiagnostic;
  if (!record) return undefined;
  const { id, status, artifactSha256, suggestedLayer, failureKind, repeatCount, trigger, layer, stalledRecipe } = record;
  return { id, status, artifactSha256, suggestedLayer, failureKind, repeatCount, trigger,
    ...(layer ? { layer } : {}), ...(stalledRecipe ? { recipe: stalledRecipe } : {}) };
}

/** The host's classification is a routing hint. The coordinator must choose
 * a layer explicitly before a separate read-only diagnosis can be dispatched.
 */
export function requireStallTriage(active, layer) {
  if (active?.stallDiagnostic?.status !== "needs-triage") throw new Error("当前单元没有等待分层的执行停滞");
  if (!STALL_LAYERS.includes(layer)) throw new Error("需明确判断卡在参数、运行器、语法或行为哪一层");
  return active.stallDiagnostic;
}

function syntaxProof({ artifacts, recipe, syntaxRecipe, input, result, sourceLineCounts }) {
  if (!syntaxRecipe || recipe !== syntaxRecipe || input?.args?.length !== 1 ||
    result.status !== "failed" || result.probe?.exitCode !== 1 || result.probe?.truncated) return undefined;
  const path = input.args[0];
  const source = artifacts.find(row => row.path === path && row.sha256);
  if (!source) return undefined;
  let output;
  try { output = JSON.parse(result.probe.stdout); }
  catch { return undefined; }
  const { line, status } = output ?? {};
  if (status !== "syntax-error" || !Number.isSafeInteger(line) || line < 1 ||
    (sourceLineCounts && !(line <= sourceLineCounts.get(path)))) return undefined;
  return { kind: status, path, line, fileSha256: source.sha256, exitCode: result.probe.exitCode };
}

function behaviorProof({ expected, comparison, result }) {
  if (!expected || comparison?.outcome !== "mismatch" || !["passed", "failed"].includes(result.status) ||
    !result.probe || !Number.isSafeInteger(result.probe.exitCode) || result.probe.truncated ||
    !Number.isSafeInteger(expected.exitCode) || comparison.actual?.exitCode !== result.probe.exitCode) return undefined;
  // Pin only the comparator's projection. Stdout, parameters and source
  // excerpts may be confidential even when the reproduction is valid.
  const { actual } = comparison;
  return {
    kind: "runtime-mismatch", expectedExitCode: expected.exitCode, exitCode: actual.exitCode,
    expectedSha256: digest(JSON.stringify(expected)), actualSha256: digest(JSON.stringify(actual)),
  };
}

/** Store a receipt only after the host authenticated this diagnostic result
 * and confirmed it is still current for the read-only investigator. A failed
 * hidden case can trigger the workflow, while source behavior needs a public
 * probe with a concrete expected outcome before the coordinator can use it.
 */
export function createStallReproductionProof(record, observation) {
  const { artifacts, requestId, operation, recipe, input, result } = observation;
  const artifactSha256 = stallArtifactSha256(artifacts);
  if (!artifactSha256 || record?.artifactSha256 !== artifactSha256 || !safeId(requestId) ||
    !STALL_LAYERS.includes(record.layer) || !result) return undefined;
  const snapshotSha256 = SHA256.test(result.snapshotSha256 ?? "") ? result.snapshotSha256 : undefined;
  const fullPass = operation === "check" && result.status === "passed" && snapshotSha256;
  let details;
  if (fullPass && record.failureKind === "version-changed") {
    // The original failure was bound to other bytes. A complete current check
    // can establish recovery here without attributing a new source defect.
    details = { kind: "current-version-passed", recovery: true };
  } else if (fullPass && record.layer === "runner" && record.suggestedLayer === "runner") {
    details = { kind: "runner-recovered", recovery: true };
  } else if (record.layer === "parameters" && record.stalledRecipe && recipe === record.stalledRecipe &&
      operation === "probe" && snapshotSha256 && result.probe && ["passed", "failed"].includes(result.status)) {
    // A genuine runner response proves this recipe's arguments were admitted,
    // even when the resulting program correctly exits with a nonzero code.
    details = { kind: "parameters-recovered", recovery: true };
  } else if (record.layer === "syntax" && operation === "probe") {
    details = syntaxProof(observation);
  } else if (record.layer === "behavior" && operation === "probe") {
    details = behaviorProof(observation);
  } else if (["runner", "parameters"].includes(record.layer)) {
    const failure = failureOf(observation);
    if (failure?.layer === record.layer) details = { kind: failure.kind };
  }
  if (!details) return undefined;
  // Syntax and behavior need an authenticated execution snapshot. A host
  // parameter rejection or transport failure can occur before a reply exists.
  if (["syntax", "behavior"].includes(record.layer) && !snapshotSha256) return undefined;
  const receipt = {
    stallId: record.id, artifactSha256, layer: record.layer, requestId, operation,
    ...(snapshotSha256 ? { snapshotSha256 } : {}), ...(safeId(recipe) ? { recipe } : {}),
    ...(input ? { inputSha256: digest(JSON.stringify(input)) } : {}), ...details,
  };
  return { id: "stall-proof-" + digest(JSON.stringify(receipt)), ...receipt };
}

/** A model supplies an identifier. Only the corresponding host-persisted
 * receipt for these bytes and this stall is authority for a diagnosis.
 */
export function requireStallReproductionProof(record, receipt, { artifacts, proofId, layer }) {
  const artifactSha256 = stallArtifactSha256(artifacts);
  if (!artifactSha256 || !record || !receipt || !STALL_LAYERS.includes(layer) || record.layer !== layer ||
    record.artifactSha256 !== artifactSha256 || receipt.stallId !== record.id ||
    receipt.artifactSha256 !== artifactSha256 || receipt.layer !== layer || !proofId || receipt.id !== proofId) {
    throw new Error("最小复现回执须属于当前诊断、选定层和当前源码版本");
  }
  const { id, ...payload } = receipt;
  if (id !== "stall-proof-" + digest(JSON.stringify(payload))) throw new Error("最小复现回执内容已变化");
  return receipt;
}
