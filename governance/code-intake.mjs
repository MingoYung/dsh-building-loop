import { createPublicKey, randomBytes, verify } from "node:crypto";
import { digest, includes, isImplementationPath, keyOf, readBytes, text } from "./policy.mjs";
import { pythonStructure } from "./python-structure.mjs";

const PROOF = "building-loop-code-test/1";
const BASELINE = "building-loop-code-regression-baseline/1";
const CANDIDATE = "building-loop-code-regression-candidate/1";
const CASE_STATUS = new Set(["passed", "failed", "skipped", "error"]);
const pythonFile = file => /\.py$/iu.test(file) && isImplementationPath(file);

function contract(spec) {
  if (spec.codeTask) return spec.codeTask;
  const sources = [...spec.phases.intake.write, ...spec.phases.supplement.write].filter(isImplementationPath);
  return sources.length ? { sources } : null;
}

function sourceVersion(file, bytes) {
  return { path: file, sha256: bytes === null ? null : digest(bytes), structure: bytes && pythonFile(file) ? pythonStructure(bytes) : null };
}

/** The first dispatch snapshots only exact authorized paths, under the workspace lock. */
export function captureCodeIntake(frame, spec, id) {
  const config = contract(spec);
  if (!config) return undefined;
  const opening = frame.started;
  if (!opening || opening.binding.kind !== "workspace") throw new Error("代码任务需要所有者在当前会话确认开工后才能派发");
  if (!config.tests?.regression) {
    throw new Error("代码任务须由维护者先配置 codeTask.tests.regression，并让受信运行者用改前文件跑旧测试、生成签名基线回执，才能派发");
  }
  const regression = captureRegression(frame, spec, id, config.tests);
  return { openingId: opening.proposal.id, nonce: randomBytes(24).toString("hex"),
    sources: config.sources.map(file => sourceVersion(file, readBytes(frame.root, file))), regression };
}

/** A runner may opt in exact read-only inputs in addition to both executor write grants. */
export function codeRegressionArtifacts(root, spec) {
  return artifacts(root, spec, true);
}

function artifacts(root, spec, regression = false) {
  const files = new Map();
  const writes = [...spec.phases.intake.write, ...(regression ? spec.phases.supplement.write : [])];
  const inputs = regression ? spec.codeTask.tests.regression.inputs : [];
  for (const file of [spec.candidate, ...writes, ...inputs]) files.set(keyOf(file), file);
  return [...files.values()].sort().map(path => {
    const bytes = readBytes(root, path);
    return { path, sha256: bytes === null ? null : digest(bytes) };
  });
}

function testChallenge(frame, id, active, spec, goal) {
  const tests = spec.codeTask?.tests;
  if (!tests) return undefined;
  return { file: tests.file, spec: PROOF, unit: id, policySha256: frame.policy.hash, goalSha256: goal.sha256,
    nonce: active.codeIntake.nonce, previousSuiteSha256: tests.previousSuiteSha256, suiteSha256: tests.suiteSha256,
    artifacts: artifacts(frame.root, spec), requiredCases: tests.requiredCases };
}

export function prepareCodeIntake(frame, id, active, spec, goal) {
  return { sources: active.codeIntake.sources.map(({ path, sha256 }) => ({ path, baselineSha256: sha256 })),
    ...(active.codeIntake.regression ? { regressionProof: regressionChallenge(frame, id, active, spec, goal) }
      : { testProof: testChallenge(frame, id, active, spec, goal) }) };
}

/** The external runner signs this exact versioned tuple. Object key order is irrelevant. */
export function codeTestSigningBytes(proof) {
  return Buffer.from(JSON.stringify([proof.spec, proof.unit, proof.policySha256, proof.goalSha256, proof.nonce,
    proof.previousSuiteSha256, proof.suiteSha256,
    proof.artifacts.map(({ path, sha256 }) => [path, sha256]), proof.passedCases, proof.runId]));
}

/** Stable tuple for both independent runner receipts, with explicit baseline/candidate domains. */
export function codeRegressionSigningBytes(proof) {
  const results = [...proof.cases].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const binding = proof.spec === CANDIDATE ? [proof.goalSha256, proof.nonce, proof.baselineReceiptSha256] : [];
  return Buffer.from(JSON.stringify([proof.spec, proof.unit, proof.policySha256, ...binding, proof.suiteSha256,
    proof.artifacts.map(row => [row.path, row.sha256]), results.map(row => [row.id, row.status]), proof.runId]));
}

function verifySignature(value, signedBytes, key) {
  if (typeof value !== "string") return false;
  const signature = Buffer.from(value, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== value) return false;
  const publicKey = createPublicKey({ key: Buffer.from(key, "base64"), type: "spki", format: "der" });
  return verify(null, signedBytes, publicKey, signature);
}

function readRegressionReceipt(root, file, binding, caseIds, key) {
  const baseline = binding.spec === BASELINE;
  const label = baseline ? "改前回归基线" : "当前交付的回归";
  const bytes = readBytes(root, file, 64 * 1024);
  if (!bytes) throw new Error(`[building-loop/code-regression] 缺少${label}签名回执，请让受信运行者完成测试`);
  const invalid = () => new Error(`[building-loop/code-regression] ${label}签名回执与授权、文件字节或用例清单不符，请让受信运行者重跑`);
  let proof;
  try { proof = JSON.parse(text(bytes)); }
  catch { throw invalid(); }
  if (!proof || Object.keys(proof).length !== Object.keys(binding).length + 3 ||
    typeof proof.runId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(proof.runId) ||
    !Array.isArray(proof.artifacts) || proof.artifacts.length !== binding.artifacts.length ||
    proof.artifacts.some((row, index) => !row || Object.keys(row).length !== 2 ||
      row.path !== binding.artifacts[index].path || row.sha256 !== binding.artifacts[index].sha256) ||
    !Array.isArray(proof.cases) || proof.cases.length !== caseIds.length ||
    proof.cases.some(row => !row || Object.keys(row).length !== 2 || typeof row.id !== "string" || !CASE_STATUS.has(row.status))) {
    throw invalid();
  }
  const cases = new Map(proof.cases.map(({ id, status }) => [id, status]));
  if (cases.size !== caseIds.length || caseIds.some(id => !cases.has(id))) throw invalid();
  const expected = { ...binding, cases: proof.cases, runId: proof.runId };
  const signingBytes = codeRegressionSigningBytes(expected);
  if (!signingBytes.equals(codeRegressionSigningBytes(proof)) || !verifySignature(proof.signature, signingBytes, key)) throw invalid();
  return { receiptSha256: digest(bytes), runId: proof.runId, cases };
}

function captureRegression(frame, spec, id, tests) {
  const binding = { spec: BASELINE, unit: id, policySha256: frame.policy.hash, suiteSha256: tests.previousSuiteSha256,
    artifacts: codeRegressionArtifacts(frame.root, spec) };
  const receipt = readRegressionReceipt(frame.root, tests.regression.baselineFile, binding, tests.regression.previousCases, tests.publicKey);
  return { receiptSha256: receipt.receiptSha256, runId: receipt.runId, artifacts: binding.artifacts,
    cases: [...receipt.cases].map(([id, status]) => ({ id, status })) };
}

function regressionChallenge(frame, id, active, spec, goal) {
  const { tests } = spec.codeTask;
  return { file: tests.file, spec: CANDIDATE, unit: id, policySha256: frame.policy.hash, goalSha256: goal.sha256,
    nonce: active.codeIntake.nonce, baselineReceiptSha256: active.codeIntake.regression.receiptSha256,
    suiteSha256: tests.suiteSha256, artifacts: codeRegressionArtifacts(frame.root, spec), previousCases: tests.regression.previousCases,
    requiredCases: tests.requiredCases,
    protectedCases: active.codeIntake.regression.cases.filter(row => row.status === "passed").map(row => row.id) };
}

function verifyRegression(frame, id, active, spec, goal) {
  const { file, previousCases, requiredCases, protectedCases, ...binding } = regressionChallenge(frame, id, active, spec, goal);
  const { receiptSha256, runId, cases } = readRegressionReceipt(frame.root, file, binding, [...previousCases, ...requiredCases],
    spec.codeTask.tests.publicKey);
  const notPassed = ids => ids.filter(id => cases.get(id) !== "passed");
  const lost = notPassed(protectedCases), missing = notPassed(requiredCases);
  if (lost.length || missing.length) {
    const show = ids => ids.slice(0, 8).map(id => `${id} (${cases.get(id)})`).join("、") + (ids.length > 8 ? `，另有 ${ids.length - 8} 项` : "");
    const detail = [...(lost.length ? ["已通过的旧用例回退：" + show(lost)] : []),
      ...(missing.length ? ["新增必测用例未通过：" + show(missing)] : [])].join("；");
    throw new Error("[building-loop/code-regression] " + detail);
  }
  return { kind: "trusted-regression", receiptSha256, runId, suiteSha256: binding.suiteSha256, goalSha256: binding.goalSha256,
    artifacts: binding.artifacts, protectedCases, requiredCases, cases: [...cases].map(([id, status]) => ({ id, status })) };
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
  if (!verifySignature(proof.signature, signedBytes, spec.codeTask.tests.publicKey)) {
    throw invalid();
  }
  return { kind: "trusted-tests", receiptSha256: digest(bytes), previousSuiteSha256: expected.previousSuiteSha256, suiteSha256: expected.suiteSha256,
    goalSha256: expected.goalSha256, runId: proof.runId, passedCases: requiredCases, artifacts: expected.artifacts };
}

export function verifyCodeIntake(frame, id, active, spec, goal, completeRead) {
  if (frame.started?.proposal.id !== active.codeIntake.openingId) throw new Error("代码接单基线与所有者确认的开工记录不符");
  if (active.codeIntake.regression) {
    const qualification = verifyRegression(frame, id, active, spec, goal);
    const previous = active.codeIntake.regression.artifacts;
    for (const file of spec.codeTask.sources) {
      const row = qualification.artifacts.find(item => keyOf(item.path) === keyOf(file));
      const old = previous.find(item => keyOf(item.path) === keyOf(file));
      if (includes(frame.reads, file) && row?.sha256 && old?.sha256 !== row.sha256) {
        const bytes = readBytes(frame.root, file);
        if (!bytes || digest(bytes) !== row.sha256 || !completeRead(file, bytes)) throw new Error("请完整读回已修改的实现文件 " + file);
      }
    }
    return qualification;
  }
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

/** Revalidation must use a passing receipt for the artifact and goal now under review. */
export function requireCodeRegressionCurrent(frame, id, active, spec, goal) {
  if (!active?.codeIntake?.regression) return;
  const check = verifyRegression(frame, id, active, spec, goal);
  const submission = active.codeIntake.qualification;
  const artifactsSha256 = digest(JSON.stringify(check.artifacts));
  if (submission?.goalSha256 !== check.goalSha256 || digest(JSON.stringify(submission.artifacts)) !== artifactsSha256) {
    throw new Error("[building-loop/code-regression] 交付文件或目标已经变化，须由执行方重新提交当前版本");
  }
  return { receiptSha256: check.receiptSha256, suiteSha256: check.suiteSha256,
    baselineReceiptSha256: active.codeIntake.regression.receiptSha256,
    artifactsSha256, protectedPassed: check.protectedCases.length,
    requiredPassed: check.requiredCases.length };
}

/** Audits and closure also bind unchanged sibling files, which prose checks do not track. */
export function reviewedCodeArtifactsCurrent(frame, id, active, receipt) {
  if (!active.codeIntake?.regression) return true;
  const artifacts = codeRegressionArtifacts(frame.root, frame.policy.units[id]);
  return receipt?.codeRegression?.artifactsSha256 === digest(JSON.stringify(artifacts));
}
