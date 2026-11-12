import { createPublicKey, randomBytes, verify } from "node:crypto";
import { digest, includes, isImplementationPath, keyOf, readBytes, text } from "./policy.mjs";
import { pythonStructure } from "./python-structure.mjs";

const PROOF = "building-loop-code-test/1";
const pythonFile = file => /\.py$/iu.test(file) && isImplementationPath(file);

function contract(spec) {
  const { intake } = spec.phases;
  if (spec.codeTask) return spec.codeTask;
  if (!pythonFile(spec.candidate) || !includes(intake.write, spec.candidate)) return null;
  return { sources: intake.write.filter(file => pythonFile(file) && includes(intake.read, file)) };
}

function sourceVersion(file, bytes) {
  return { path: file, sha256: bytes === null ? null : digest(bytes), structure: bytes && pythonFile(file) ? pythonStructure(bytes) : null };
}

/** The first dispatch snapshots only exact authorized paths, under the workspace lock. */
export function captureCodeIntake(frame, spec) {
  const config = contract(spec);
  if (!config) return undefined;
  const opening = frame.started;
  if (!opening || opening.binding.kind !== "workspace") {
    if (spec.codeTask) throw new Error("代码任务需要所有者在当前会话确认开工后才能派发");
    return undefined;
  }
  return { openingId: opening.proposal.id, nonce: randomBytes(24).toString("hex"),
    sources: config.sources.map(file => sourceVersion(file, readBytes(frame.root, file))) };
}

function artifacts(frame, spec) {
  const files = new Map();
  for (const file of [spec.candidate, ...spec.phases.intake.write]) files.set(keyOf(file), file);
  return [...files.values()].sort().map(path => {
    const bytes = readBytes(frame.root, path);
    return { path, sha256: bytes === null ? null : digest(bytes) };
  });
}

function testChallenge(frame, id, active, spec, goal) {
  const tests = spec.codeTask?.tests;
  if (!tests) return undefined;
  return { file: tests.file, spec: PROOF, unit: id, policySha256: frame.policy.hash, goalSha256: goal.sha256,
    nonce: active.codeIntake.nonce, previousSuiteSha256: tests.previousSuiteSha256, suiteSha256: tests.suiteSha256,
    artifacts: artifacts(frame, spec), requiredCases: tests.requiredCases };
}

export function prepareCodeIntake(frame, id, active, spec, goal) {
  return { sources: active.codeIntake.sources.map(({ path, sha256 }) => ({ path, baselineSha256: sha256 })),
    testProof: testChallenge(frame, id, active, spec, goal) };
}

/** The external runner signs this exact versioned tuple. Object key order is irrelevant. */
export function codeTestSigningBytes(proof) {
  return Buffer.from(JSON.stringify([proof.spec, proof.unit, proof.policySha256, proof.goalSha256, proof.nonce,
    proof.previousSuiteSha256, proof.suiteSha256,
    proof.artifacts.map(({ path, sha256 }) => [path, sha256]), proof.passedCases, proof.runId]));
}

function checkTestProof(frame, spec, challenge) {
  if (!challenge) throw new Error("未发现实现结构变更。注释、排版和测试文件改动不能代替实现；无改动交付须由维护者配置受信测试回执");
  const bytes = readBytes(frame.root, challenge.file, 64 * 1024);
  if (!bytes) throw new Error("未发现实现结构变更或本次开工的受信测试回执");
  const invalid = () => new Error("受信测试回执不符：需验证当前目标、测试套件、全部必测用例和实际测试过的交付字节");
  let proof;
  try { proof = JSON.parse(text(bytes)); }
  catch { throw invalid(); }
  const { file: _proofFile, requiredCases, ...binding } = challenge;
  if (!proof || typeof proof.runId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(proof.runId) ||
    typeof proof.signature !== "string" || !Array.isArray(proof.artifacts) || proof.artifacts.length !== binding.artifacts.length ||
    !Array.isArray(proof.passedCases) || Object.keys(proof).length !== Object.keys(binding).length + 3 ||
    proof.artifacts.some(row => !row || typeof row.path !== "string" || Object.keys(row).length !== 2 ||
      (row.sha256 !== null && !/^[a-f0-9]{64}$/u.test(row.sha256 ?? "")))) throw invalid();
  const expected = { ...binding, passedCases: requiredCases, runId: proof.runId };
  const signedBytes = codeTestSigningBytes(expected);
  if (!codeTestSigningBytes(proof).equals(signedBytes)) throw invalid();
  const signature = Buffer.from(proof.signature, "base64");
  const publicKey = createPublicKey({ key: Buffer.from(spec.codeTask.tests.publicKey, "base64"), type: "spki", format: "der" });
  if (signature.length !== 64 || signature.toString("base64") !== proof.signature || !verify(null, signedBytes, publicKey, signature)) {
    throw invalid();
  }
  return { kind: "trusted-tests", receiptSha256: digest(bytes), previousSuiteSha256: expected.previousSuiteSha256, suiteSha256: expected.suiteSha256,
    goalSha256: expected.goalSha256, runId: proof.runId, passedCases: requiredCases, artifacts: expected.artifacts };
}

export function verifyCodeIntake(frame, id, active, spec, goal, completeRead) {
  if (frame.started?.proposal.id !== active.codeIntake.openingId) throw new Error("代码接单基线与所有者确认的开工记录不符");
  const changes = [];
  for (const baseline of active.codeIntake.sources) {
    const bytes = readBytes(frame.root, baseline.path);
    if (!bytes || digest(bytes) === baseline.sha256 || !pythonFile(baseline.path)) continue;
    const structure = pythonStructure(bytes);
    if (!structure?.statements || (baseline.sha256 !== null && !baseline.structure) || structure.sha256 === baseline.structure?.sha256) continue;
    if (!completeRead(baseline.path, bytes)) throw new Error("请完整读回已修改的实现文件 " + baseline.path);
    changes.push({ path: baseline.path, beforeSha256: baseline.sha256, afterSha256: digest(bytes) });
  }
  if (changes.length) return { kind: "implementation-change", goalSha256: goal.sha256, changes };
  return checkTestProof(frame, spec, testChallenge(frame, id, active, spec, goal));
}
