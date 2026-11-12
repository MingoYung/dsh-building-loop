import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { codeRegressionArtifacts } from "./code-intake.mjs";
import { goalSnapshot } from "./goals.mjs";
import { digest, includes, isImplementationPath, keyOf, readBytes } from "./policy.mjs";

const SPEC = "building-loop/diagnostics/1";
const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;

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

function snapshotId(binding, artifacts) {
  return digest(JSON.stringify({ ...binding, artifacts }));
}

/** Called after the file replacement while the workspace lock still owns its
 * version. No test process starts until the associated state commit completes.
 */
export function prepareCodeDiagnostics(frame, file, fileSha256, runner) {
  if (frame.role !== "executor" || !isImplementationPath(file)) return;
  const [unit, active] = frame.assignment;
  const spec = frame.policy.units[unit];
  if (!active.codeIntake?.regression || !spec.codeTask?.tests?.regression) return;
  const checkSet = spec.codeTask.diagnostics?.checkSet;
  if (!checkSet) return { result: { status: "skipped", reason: "check-set-not-configured" } };
  if (runner.reason) return { result: { status: "skipped", reason: runner.reason } };
  try {
    const binding = { checkSet, unit, phase: active.phase, policySha256: frame.policy.hash, goalSha256: goalSnapshot(frame).sha256 };
    const versions = codeRegressionArtifacts(frame.root, spec);
    const changed = versions.find(artifact => keyOf(artifact.path) === keyOf(file));
    if (!changed || changed.sha256 !== fileSha256) return { result: { status: "superseded" } };
    if (versions.length > MAX_ARTIFACTS) return { result: { status: "unavailable", reason: "snapshot-limit" } };
    const artifacts = [];
    let totalBytes = 0;
    for (const version of versions) {
      const bytes = readBytes(frame.root, version.path);
      if ((bytes === null ? null : digest(bytes)) !== version.sha256) return { result: { status: "superseded" } };
      totalBytes += bytes?.length ?? 0;
      if (totalBytes > MAX_ARTIFACT_BYTES) return { result: { status: "unavailable", reason: "snapshot-limit" } };
      artifacts.push({ ...version, contentBase64: bytes?.toString("base64") ?? null });
    }
    const request = { spec: SPEC, requestId: randomUUID(), ...binding, snapshotSha256: snapshotId(binding, versions), changed, artifacts };
    return { request, binding, root: frame.root, actor: active.actor, serial: active.serial, nonce: active.codeIntake.nonce,
      readablePaths: versions.filter(version => includes(frame.reads, version.path)).map(version => version.path) };
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
  if (frame.role !== "executor" || frame.root !== job.root || unit !== binding.unit || active.phase !== binding.phase ||
    active.actor !== job.actor || active.serial !== job.serial || active.codeIntake?.nonce !== job.nonce ||
    frame.policy.hash !== binding.policySha256 || goalSnapshot(frame).sha256 !== binding.goalSha256) return false;
  return snapshotId(binding, codeRegressionArtifacts(frame.root, frame.policy.units[unit])) === job.request.snapshotSha256;
}

async function post(runner, payload, signal) {
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
      if (bytes > MAX_RESPONSE_BYTES) return undefined;
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

function feedback(reply, job) {
  if (!hasOnly(reply, ["spec", "requestId", "snapshotSha256", "status", "firstError"]) || reply.spec !== SPEC ||
    reply.requestId !== job.request.requestId || reply.snapshotSha256 !== job.request.snapshotSha256) {
    return { status: "unavailable", reason: "invalid-runner-reply" };
  }
  if (reply.status === "passed" && reply.firstError === undefined) return { status: "passed", snapshotSha256: reply.snapshotSha256 };
  if (reply.status === "unavailable" && reply.firstError === undefined) return { status: "unavailable", reason: "runner-unavailable" };
  const error = reply.firstError;
  if (reply.status !== "failed" || !hasOnly(error, ["caseId", "message", "path", "line"]) ||
    !cleanText(error.caseId, 120, /[\x00-\x1f\x7f]/u) || !cleanText(error.message, 1200, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u) ||
    (error.path !== undefined && (typeof error.path !== "string" || !job.readablePaths.includes(error.path))) ||
    (error.line !== undefined && (error.path === undefined || !Number.isSafeInteger(error.line) || error.line < 1))) {
    return { status: "unavailable", reason: "invalid-runner-reply" };
  }
  return { status: "failed", snapshotSha256: reply.snapshotSha256, firstError: error };
}

/** The result is early feedback for the writer. Only the existing signed
 * regression gate can qualify a candidate for delivery.
 */
export async function runCodeDiagnostics(job, runner, signal) {
  const timeout = AbortSignal.timeout(runner.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return feedback(await post(runner, job.request, requestSignal), job);
  } catch {
    if (signal?.aborted) return { status: "cancelled" };
    if (timeout.aborted) return { status: "timeout" };
    return { status: "unavailable", reason: "runner-transport-error" };
  }
}
