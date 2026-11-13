import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { codeRegressionArtifacts } from "./code-intake.mjs";
import { goalSnapshot } from "./goals.mjs";
import { DiagnosticRecipeInputError, validateRecipeInputs } from "./diagnostic-recipe-inputs.mjs";
import { inputContractCases } from "./input-contracts.mjs";
import { compareReviewProbe } from "./code-review-probes.mjs";
import { digest, includes, isImplementationPath, keyOf, readBytes, relativeName } from "./policy.mjs";

const LEGACY_SPEC = "building-loop/diagnostics/1";
const SCOPED_SPEC = "building-loop/diagnostics/2";
const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_LEGACY_RESPONSE_BYTES = 16 * 1024;
const MAX_CHECK_RESPONSE_BYTES = 128 * 1024;
const MAX_PROBE_RESPONSE_BYTES = 16 * 1024;
const MAX_PROBE_ARGS = 24;
const MAX_PROBE_ARG_BYTES = 512;
const MAX_PROBE_STDIN_BYTES = 8 * 1024;
const MAX_PROBE_FILES = 12;
const MAX_PROBE_FILE_BYTES = 16 * 1024;
const MAX_PROBE_PATH_BYTES = 160;
const MAX_PROBE_OUTPUT_BYTES = 2 * 1024;
const MAX_STACK_FRAMES = 6;
const MAX_EXECUTED_LINES = 256;
const SINGLE_LINE_CONTROLS = /[\x00-\x1f\x7f]/u;
const MULTILINE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const CHECK_STATUSES = new Set(["passed", "failed", "unavailable"]);

/** Only the host process can set a destination and credential. Use direct HTTP
 * on literal loopback to avoid DNS, system proxies, and redirecting credentials.
 */
export function diagnosticRunnerConfig(env) {
  const endpoint = env.DSH_BUILDING_LOOP_DIAGNOSTICS_URL;
  const token = env.DSH_BUILDING_LOOP_DIAGNOSTICS_TOKEN;
  if (endpoint === undefined && token === undefined) return { reason: "runner-not-configured" };
  try {
    const url = new URL(endpoint);
    const timeoutMs = Number(env.DSH_BUILDING_LOOP_DIAGNOSTICS_TIMEOUT_MS ?? 12000);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username ||
      url.password || url.search || url.hash || typeof token !== "string" || !/^[A-Za-z0-9._~-]{32,256}$/u.test(token) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) throw new Error();
    return { url, token, timeoutMs };
  } catch {
    return { reason: "runner-config-invalid" };
  }
}

function snapshotId(binding, artifacts, operation) {
  return digest(JSON.stringify({ ...binding, artifacts, ...operation }));
}

function checkSelection(spec, active) {
  return {
    protectedCases: active.codeIntake.regression.cases.filter(row => row.status === "passed").map(row => row.id),
    requiredCases: spec.codeTask.tests.requiredCases,
  };
}

function scopedOperation(spec, active, probe) {
  return {
    operation: probe ? "probe" : "check",
    ...checkSelection(spec, active),
    ...(probe ? { probe } : {}),
  };
}

function boundedData(value, maxBytes, controls) {
  return typeof value === "string" && value.isWellFormed() && !controls.test(value) && Buffer.byteLength(value) <= maxBytes;
}

function sameTree(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/** A model supplies data for a fixed runner recipe. Fixture paths are scratch
 * relative and must not shadow candidate artifacts, even on a case-folding FS.
 */
function probeInput(args, recipes) {
  if (!recipes?.includes(args.recipe)) throw new Error("复现配方不在当前项目授权清单");
  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.length > MAX_PROBE_ARGS ||
    args.args.some(value => !boundedData(value, MAX_PROBE_ARG_BYTES, SINGLE_LINE_CONTROLS)))) {
    throw new Error("复现 argv 参数过多、过长或含控制字符");
  }
  if (args.stdin !== undefined && !boundedData(args.stdin, MAX_PROBE_STDIN_BYTES, MULTILINE_CONTROLS)) {
    throw new Error("复现 stdin 超出 UTF-8 文本限制");
  }
  if (args.files !== undefined && (!Array.isArray(args.files) || args.files.length > MAX_PROBE_FILES)) {
    throw new Error("复现样例文件超过数量限制");
  }
  const files = [];
  let fileBytes = 0;
  for (const row of args.files ?? []) {
    if (!hasOnly(row, ["path", "content"]) || !boundedData(row.path, MAX_PROBE_PATH_BYTES, SINGLE_LINE_CONTROLS) ||
      !boundedData(row.content, MAX_PROBE_FILE_BYTES, MULTILINE_CONTROLS)) throw new Error("复现样例文件须使用受限 UTF-8 文本");
    const path = relativeName(row.path);
    if (path !== row.path || files.some(file => sameTree(file.path, path))) throw new Error("复现样例路径重复或不是规范相对路径");
    fileBytes += Buffer.byteLength(row.content);
    if (fileBytes > MAX_PROBE_FILE_BYTES) throw new Error("复现样例文件总大小超限");
    files.push({ path, content: row.content });
  }
  return {
    recipe: args.recipe,
    ...(args.args !== undefined ? { args: [...args.args] } : {}),
    ...(args.files !== undefined ? { files } : {}),
    ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
  };
}

function sourceLines(bytes) {
  let lines = 1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10 || bytes[i] === 13 && bytes[i + 1] !== 10) lines++;
  }
  return lines;
}

/** Called after the file replacement while the workspace lock still owns its
 * version. No test process starts until the associated state commit completes.
 */
export function prepareCodeDiagnostics(frame, file, fileSha256, runner) {
  if (frame.role !== "executor" || !isImplementationPath(file)) return;
  return prepare(frame, runner, { file, fileSha256 });
}

/** Only the assigned executor or read-only diagnostician can reproduce. */
export function prepareCodeReproduction(frame, args, runner) {
  if (!hasOnly(args, ["action", "recipe", "args", "files", "stdin"]) ||
    !["check", "probe"].includes(args.action) ||
    args.action === "check" && Object.keys(args).some(key => key !== "action")) throw new Error("复现动作或参数不符合契约");
  return prepare(frame, runner, { manual: args });
}

/** Capture authorized inputs and candidate bytes under the caller's lock.
 * The registered checks consume no model-authored probe arguments. */
export function prepareInputContractBatch(frame, spec, runner) {
  const cases = inputContractCases(spec.codeTask?.diagnostics?.inputContracts);
  if (!cases.length) return;
  const traceExamples = new Set(spec.architecture?.responsibilities?.map(row => row.exampleId) ?? []);
  return cases.map(check => {
    const { requirement } = check;
    if (requirement) {
      const { file, start, end, quote } = requirement;
      const bytes = includes(frame.policy.goalContext, file) && readBytes(frame.root, file);
      const lines = bytes && bytes.toString("utf8").split(/\r\n|\n|\r/u);
      if (!lines || end > lines.length || !lines.slice(start - 1, end).join("\n").includes(quote)) {
        return { check, job: { result: { status: "unavailable", reason: "public-example-clause-stale" } } };
      }
    }
    // Only owner-pinned responsibility cases can request executed-line evidence.
    return { check, job: prepare(frame, runner, { manual: { action: "probe", ...check.input }, trace: traceExamples.has(check.id) }) };
  });
}

/** A maintainer-authorized rollback runs the same data-only recipes on a
 * derived copy. It grants no tool access to the captured source bytes. */
export function prepareRollbackBatch(frame, unit, active, spec, rehearsal, runner) {
  const { checkSet, recipes, recipeInputs } = spec.codeTask.diagnostics;
  const binding = { checkSet, unit, phase: active.phase, policySha256: frame.policy.hash, goalSha256: rehearsal.binding.goalSha256 };
  const versions = rehearsal.artifacts.map(({ path, sha256 }) => ({ path, sha256 }));
  const sources = spec.codeTask.sources.filter(path => versions.some(row => row.path === path && row.sha256));
  return rehearsal.checks.map(check => {
    if (runner.reason) return { check, job: { result: { status: "unavailable", reason: runner.reason } } };
    const probe = probeInput(check.input, recipes);
    const shape = recipeInputs && Object.hasOwn(recipeInputs, probe.recipe) && recipeInputs[probe.recipe];
    if (shape) {
      try { validateRecipeInputs(probe, shape, sources); }
      catch (error) {
        if (!(error instanceof DiagnosticRecipeInputError)) throw error;
        return { check, job: { result: error.result } };
      }
    }
    const operation = scopedOperation(spec, active, probe);
    const request = { spec: SCOPED_SPEC, requestId: randomUUID(), ...binding,
      snapshotSha256: snapshotId(binding, versions, operation), artifacts: rehearsal.artifacts, ...operation };
    const sourceLineCounts = new Map(rehearsal.artifacts.filter(row => row.contentBase64 && sources.includes(row.path))
      .map(row => [row.path, sourceLines(Buffer.from(row.contentBase64, "base64"))]));
    return { check, job: { request, readablePaths: sources, sourceLineCounts } };
  });
}

/** Only an authenticated sandbox result can establish that the candidate
 * exceeded its execution limit. Transport timeout has unknown behavior. */
export function compareInputContract(check, result) {
  return result.status === "execution-timeout"
    ? { outcome: "mismatch", actual: { status: "execution-timeout" } }
    : compareReviewProbe(check, result);
}

/** All rows must run against the same freshly signed artifact snapshot. Only
 * failed/unknown rows need to be sent to the executor, with repro data. */
export async function runInputContractBatch(batch, runner, signal) {
  const results = [];
  for (let index = 0; index < batch.length; index += 4) {
    signal?.throwIfAborted();
    results.push(...await Promise.all(batch.slice(index, index + 4).map(({ check, job }) =>
      Promise.resolve(job.result ?? runCodeDiagnostics(job, runner, signal)).then(result => ({ check, result })))));
  }
  const failures = [];
  const traced = [];
  for (const { check, result } of results) {
    const compared = compareInputContract(check, result);
    if (compared.outcome === "match") {
      if (result.probe?.executed) traced.push({ id: check.id, snapshotSha256: result.snapshotSha256,
        exitCode: result.probe.exitCode, responseSha256: digest(result.probe.stdout),
        json: JSON.parse(result.probe.stdout), executed: result.probe.executed });
      continue;
    }
    const { id, shape, input, expected } = check;
    failures.push({ id, ...(shape ? { shape } : {}), ...compared,
      ...(compared.outcome === "mismatch" ? { ...(failures.length < 4 ? { stdin: input.stdin, expected } : {}),
        ...(result.probe?.stack ? { stack: result.probe.stack } : {}) }
        : { status: result.status, ...(result.reason ? { reason: result.reason } : {}) }) });
  }
  return { status: failures.some(row => row.outcome === "mismatch") ? "failed" : failures.length ? "unavailable" : "passed",
    total: results.length, passed: results.length - failures.length, failures,
    ...(traced.length ? { traced } : {}),
    receipts: results.flatMap(({ check, result }) => result.snapshotSha256 ? [{ id: check.id, snapshotSha256: result.snapshotSha256 }] : []) };
}

/** Recheck the original batch while the caller holds the commit lock. */
export function inputContractBatchCurrent(frame, batch) {
  return batch.every(({ job }) => job.request && codeDiagnosticsCurrent(frame, job));
}

/** Review probes use the same isolation and read grants, but only explicitly
 * reviewable recipes. The caller must also prove a current signed review. */
export function prepareReviewReproduction(frame, args, runner) {
  const [unit] = frame.assignment ?? [];
  const diagnostics = frame.policy.units[unit]?.codeTask?.diagnostics;
  if (!["reviewer", "auditor"].includes(frame.role) || diagnostics?.protocol !== 2 ||
    !diagnostics.reviewRecipes?.includes(args.recipe)) throw new Error("当前角色无该复核配方授权");
  return prepare(frame, runner, { manual: { action: "probe", ...args }, review: true });
}

function prepare(frame, runner, { file, fileSha256, manual, review = false, trace = false }) {
  const [unit, active] = frame.assignment ?? [];
  const spec = frame.policy.units[unit];
  if ((!review && !["executor", "diagnostician"].includes(frame.role)) || !active?.codeIntake?.regression || !spec?.codeTask?.tests?.regression) {
    if (manual) throw new Error("仅当前已授权的代码执行方可以复现");
    return;
  }
  const { checkSet, protocol, recipes, recipeInputs } = spec.codeTask.diagnostics ?? {};
  if (!checkSet) return { result: { status: "skipped", reason: "check-set-not-configured" } };
  if (manual && protocol !== 2) return { result: { status: "skipped", reason: "protocol-upgrade-required" } };
  // Validate model input outside the snapshot catch so invalid arguments are
  // explicit tool errors. Probe bytes may not disclose other phases' grants.
  const requestedProbe = manual?.action === "probe";
  const inputShape = requestedProbe && recipeInputs && Object.hasOwn(recipeInputs, manual.recipe) ? recipeInputs[manual.recipe] : undefined;
  if (runner.reason && !inputShape) return { result: { status: "skipped", reason: runner.reason } };
  const probe = requestedProbe ? probeInput(manual, recipes) : undefined;
  let versions;
  try { versions = codeRegressionArtifacts(frame.root, spec); }
  catch { return { result: { status: "unavailable", reason: "snapshot-error" } }; }
  if (probe?.files?.some(row => versions.some(file => sameTree(file.path, row.path)))) {
    throw new Error("复现样例路径与交付工件冲突");
  }
  if (inputShape) {
    const authorizedSources = versions.filter(row => row.sha256 && spec.codeTask.sources.includes(row.path) &&
      includes(frame.reads, row.path)).map(row => row.path);
    try { validateRecipeInputs(probe, inputShape, authorizedSources); }
    catch (error) {
      if (!(error instanceof DiagnosticRecipeInputError)) throw error;
      return { result: error.result };
    }
  }
  if (runner.reason) return { result: { status: "skipped", reason: runner.reason } };
  try {
    const binding = { checkSet, unit, phase: active.phase, policySha256: frame.policy.hash, goalSha256: goalSnapshot(frame).sha256 };
    const changed = file === undefined ? undefined : versions.find(artifact => keyOf(artifact.path) === keyOf(file));
    if (file !== undefined && (!changed || changed.sha256 !== fileSha256)) return { result: { status: "superseded" } };
    const readablePaths = versions.filter(version => includes(frame.reads, version.path)).map(version => version.path);
    if (requestedProbe && versions.length !== readablePaths.length) return { result: { status: "unavailable", reason: "probe-artifacts-not-readable" } };
    if (versions.length > MAX_ARTIFACTS) return { result: { status: "unavailable", reason: "snapshot-limit" } };
    const artifacts = [];
    const sourceLineCounts = new Map();
    let totalBytes = 0;
    for (const version of versions) {
      const bytes = readBytes(frame.root, version.path);
      if ((bytes === null ? null : digest(bytes)) !== version.sha256) return { result: { status: "superseded" } };
      totalBytes += bytes?.length ?? 0;
      if (totalBytes > MAX_ARTIFACT_BYTES) return { result: { status: "unavailable", reason: "snapshot-limit" } };
      artifacts.push({ ...version, contentBase64: bytes?.toString("base64") ?? null });
      if (protocol === 2 && bytes && isImplementationPath(version.path) && readablePaths.includes(version.path)) {
        sourceLineCounts.set(version.path, sourceLines(bytes));
      }
    }
    const operation = protocol === 2 ? scopedOperation(spec, active, trace ? { ...probe, trace: true } : probe) : undefined;
    const request = {
      spec: protocol === 2 ? SCOPED_SPEC : LEGACY_SPEC, requestId: randomUUID(), ...binding,
      snapshotSha256: snapshotId(binding, versions, operation), ...(changed ? { changed } : {}), artifacts, ...operation,
    };
    return { request, binding, role: frame.role, root: frame.root, actor: active.actor, serial: active.serial, nonce: active.codeIntake.nonce,
      readablePaths, sourceLineCounts, ...(trace ? { tracePaths: spec.codeTask.sources } : {}) };
  } catch {
    // A diagnostic capture error must never report an already-landed edit as lost.
    return { result: { status: "unavailable", reason: "snapshot-error" } };
  }
}

/** Compare the active authority and all relevant bytes after the asynchronous
 * test. A result from an earlier edit or work stage must not drive a repair.
 */
export function codeDiagnosticsCurrent(frame, job) {
  const [unit, active] = frame.assignment ?? [];
  const { binding } = job;
  if (frame.role !== (job.role ?? "executor") || frame.root !== job.root || unit !== binding.unit || active.phase !== binding.phase ||
    active.actor !== job.actor || active.serial !== job.serial || active.codeIntake?.nonce !== job.nonce ||
    frame.policy.hash !== binding.policySha256 || goalSnapshot(frame).sha256 !== binding.goalSha256) return false;
  const spec = frame.policy.units[unit];
  const versions = codeRegressionArtifacts(frame.root, spec);
  if (job.request.operation === "probe" && versions.some(row => !includes(frame.reads, row.path))) return false;
  const operation = job.request.operation ? scopedOperation(spec, active, job.request.probe) : undefined;
  return snapshotId(binding, versions, operation) === job.request.snapshotSha256;
}

async function post(runner, payload, maxBytes, signal) {
  const body = JSON.stringify(payload);
  const response = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(runner.url, {
      method: "POST", agent: false, signal, headers: {
        Authorization: "Bearer " + runner.token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
      },
    }, resolve);
    outgoing.once("error", reject);
    outgoing.end(body);
  });
  try {
    if (response.statusCode !== 200) throw new Error();
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) return undefined;
      chunks.push(chunk);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    } catch {
      return undefined;
    }
  } finally {
    response.destroy();
  }
}

function hasOnly(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}

function cleanText(value, limit, controls) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !controls.test(value);
}

const invalidReply = () => ({ status: "unavailable", reason: "invalid-runner-reply" });
const runnerUnavailable = () => ({ status: "unavailable", reason: "runner-unavailable" });
const replyEnvelope = ["spec", "requestId", "snapshotSha256", "status"];

function legacyFeedback(reply, job) {
  if (!hasOnly(reply, [...replyEnvelope, "firstError"])) return invalidReply();
  if (reply.status === "passed" && reply.firstError === undefined) return { status: "passed", snapshotSha256: reply.snapshotSha256 };
  if (reply.status === "unavailable" && reply.firstError === undefined) return runnerUnavailable();
  const error = reply.firstError;
  if (reply.status !== "failed" || !hasOnly(error, ["caseId", "message", "path", "line"]) ||
    !cleanText(error.caseId, 120, SINGLE_LINE_CONTROLS) || !cleanText(error.message, 1200, MULTILINE_CONTROLS) ||
    (error.path !== undefined && (typeof error.path !== "string" || !job.readablePaths.includes(error.path))) ||
    (error.line !== undefined && (error.path === undefined || !Number.isSafeInteger(error.line) || error.line < 1))) {
    return invalidReply();
  }
  return { status: "failed", snapshotSha256: reply.snapshotSha256, firstError: error };
}

function sourceLocation(path, line, job) {
  return job.sourceLineCounts.has(path) && (line === undefined ||
    Number.isSafeInteger(line) && line >= 1 && line <= job.sourceLineCounts.get(path));
}

function sourceStack(stack, job) {
  return stack === undefined || Array.isArray(stack) && stack.length <= MAX_STACK_FRAMES &&
    stack.every(frame => hasOnly(frame, ["path", "line", "function"]) &&
      frame.line !== undefined && sourceLocation(frame.path, frame.line, job) &&
      (frame.function === undefined || cleanText(frame.function, 120, SINGLE_LINE_CONTROLS) && frame.function.isWellFormed()));
}

/** Keep trace metadata in a separate envelope from candidate stdout/stderr.
 * A trace belongs only to the exact requested Python artifact inventory. */
function executionTrace(rows, job) {
  if (!job.request.probe.trace) return rows === undefined;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_EXECUTED_LINES) return false;
  const positions = new Set();
  return rows.every(row => {
    if (!hasOnly(row, ["path", "line"]) || !job.tracePaths?.includes(row.path) || !Number.isSafeInteger(row.line) ||
      !sourceLocation(row.path, row.line, job)) return false;
    const position = row.path + ":" + row.line;
    if (positions.has(position)) return false;
    positions.add(position);
    return true;
  });
}

function caseError(error, job) {
  return hasOnly(error, ["caseId", "message", "path", "line", "stack"]) &&
    cleanText(error.message, 1200, MULTILINE_CONTROLS) && error.message.isWellFormed() &&
    (error.path === undefined ? error.line === undefined : sourceLocation(error.path, error.line, job)) &&
    sourceStack(error.stack, job);
}

/** Validate independent check groups against the exact signed inventory. A
 * first protected failure can never stand in for omitted required results.
 */
function checkFeedback(reply, job) {
  if (!hasOnly(reply, [...replyEnvelope, "old", "required"])) return invalidReply();
  const { status, snapshotSha256, old, required } = reply;
  if (status === "unavailable" && old === undefined && required === undefined) return runnerUnavailable();
  const { protectedCases, requiredCases } = job.request;
  if (!hasOnly(old, ["status", "firstError"]) || !CHECK_STATUSES.has(old.status) ||
    (old.status === "failed" ? !caseError(old.firstError, job) || !protectedCases.includes(old.firstError.caseId) : old.firstError !== undefined) ||
    !Array.isArray(required) || required.length !== requiredCases.length) return invalidReply();
  const rows = new Map();
  for (const row of required) {
    if (!hasOnly(row, ["caseId", "status", "error"]) || !requiredCases.includes(row.caseId) || rows.has(row.caseId) ||
      !CHECK_STATUSES.has(row.status) || (row.status === "failed"
        ? !caseError(row.error, job) || row.error.caseId !== row.caseId : row.error !== undefined)) return invalidReply();
    rows.set(row.caseId, row);
  }
  const ordered = requiredCases.map(id => rows.get(id));
  const statuses = [old.status, ...ordered.map(row => row.status)];
  const outcome = statuses.includes("failed") ? "failed" : statuses.includes("unavailable") ? "unavailable" : "passed";
  if (status !== outcome) return invalidReply();
  return { status, snapshotSha256, old, required: ordered };
}

function probeFeedback(reply, job) {
  if (reply.status === "execution-timeout" && hasOnly(reply, replyEnvelope)) {
    return { status: "execution-timeout", snapshotSha256: reply.snapshotSha256 };
  }
  // Older adapters still return unavailable. New adapters may reject a
  // parameter without sending exception text or echoing the hidden input.
  if (reply.status === "invalid-input") {
    if (!hasOnly(reply, [...replyEnvelope, "inputError"]) || !["args", "stdin", "files"].includes(reply.inputError)) return invalidReply();
    return { status: "invalid-input", reason: "runner-rejected-input", recipe: job.request.probe.recipe,
      field: reply.inputError, message: "运行器拒绝该字段，请按已授权配方形状更正。" };
  }
  if (!hasOnly(reply, [...replyEnvelope, "probe"])) return invalidReply();
  const { status, snapshotSha256, probe } = reply;
  if (status === "unavailable" && probe === undefined) return runnerUnavailable();
  if (!["passed", "failed"].includes(status) || !hasOnly(probe, ["exitCode", "stdout", "stderr", "stack", "truncated", "executed"]) ||
    !Number.isSafeInteger(probe.exitCode) || probe.exitCode < 0 || probe.exitCode > 0xffffffff ||
    (status === "passed") !== (probe.exitCode === 0) ||
    ["stdout", "stderr"].some(field => probe[field] !== undefined && !boundedData(probe[field], MAX_PROBE_OUTPUT_BYTES, MULTILINE_CONTROLS)) ||
    (probe.truncated !== undefined && typeof probe.truncated !== "boolean") || !sourceStack(probe.stack, job) ||
    !executionTrace(probe.executed, job)) return invalidReply();
  return { status, snapshotSha256, probe };
}

function feedback(reply, job) {
  if (!reply || reply.spec !== job.request.spec || reply.requestId !== job.request.requestId ||
    reply.snapshotSha256 !== job.request.snapshotSha256) return invalidReply();
  if (job.request.operation === "check") return checkFeedback(reply, job);
  if (job.request.operation === "probe") return probeFeedback(reply, job);
  return legacyFeedback(reply, job);
}

/** The result is early feedback for the writer. Only the existing signed
 * regression gate can qualify a candidate for delivery.
 */
export async function runCodeDiagnostics(job, runner, signal) {
  const timeout = AbortSignal.timeout(runner.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const maxBytes = job.request.operation === "check" ? MAX_CHECK_RESPONSE_BYTES
    : job.request.probe?.trace ? MAX_CHECK_RESPONSE_BYTES : job.request.operation === "probe" ? MAX_PROBE_RESPONSE_BYTES : MAX_LEGACY_RESPONSE_BYTES;
  try {
    const result = feedback(await post(runner, job.request, maxBytes, requestSignal), job);
    // The transport credential is never a diagnostic, even if a broken
    // adapter accidentally includes it in an exception or child output.
    return JSON.stringify(result).includes(runner.token) ? invalidReply() : result;
  } catch {
    if (signal?.aborted) return { status: "cancelled" };
    if (timeout.aborted) return { status: "timeout" };
    return { status: "unavailable", reason: "runner-transport-error" };
  }
}
