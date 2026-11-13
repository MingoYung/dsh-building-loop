import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { inspectArchitectureImports, isCodeReviewUnit } from "../governance/code-review.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { fixture, host } from "./helpers.mjs";

const entry = "main.py";
const worker = "queue.py";
const goal = "SPEC.md";
const source = "def bounded(n):\n    # Reject negative batch sizes before enqueue.\n    return max(0, n)\n";
const update = "def bounded(n):\n    # Clamp before enqueue to keep downstream memory bounded.\n    return min(5, max(0, n))\n";
const goalText = "# Queue release\nBound each submitted batch between zero and five items.\n";

function prepareProject(root, write, { evidence = false, proseEdit = false, partialReview = false } = {}) {
  const keys = generateKeyPairSync("ed25519");
  const sources = [entry, worker];
  const grant = { read: [...sources, "first.json", "final.json", ...(proseEdit ? ["notes.md"] : [])],
    write: [...sources, ...(proseEdit ? ["notes.md"] : [])] };
  const review = receipt => ({ read: [...(partialReview ? [entry] : sources), ...(evidence ? ["functional.csv"] : [])],
    evidence: evidence ? ["functional.csv"] : [], receipt });
  const tests = { file: "candidate-proof.json", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    previousSuiteSha256: digest("previous suite"), suiteSha256: digest("candidate suite"),
    requiredCases: ["batch-bound"], regression: { baselineFile: "baseline-proof.json", previousCases: ["old-negative"] } };
  write(entry, "from queue import bounded\n\nprint(bounded(9))\n");
  write(worker, source);
  write(goal, goalText);
  if (proseEdit) write("notes.md", "# Existing release notes\n");
  write("BUILDING-LOOP.json", JSON.stringify({ spec: "building-loop/1", coordinator: { read: [goal, "first.json", "final.json"] },
    goalContext: [goal], units: { K01: { candidate: entry, plainLast: false, codeTask: { sources, tests },
      phases: { intake: grant, supplement: grant, "first-review": review("first.json"), "final-review": review("final.json") } } } }));
  const policy = authority(root);
  const saveProof = (file, body) => write(file, JSON.stringify({ ...body,
    signature: sign(null, codeRegressionSigningBytes(body), keys.privateKey).toString("base64") }));
  saveProof(tests.regression.baselineFile, { spec: "building-loop-code-regression-baseline/1", unit: "K01",
    policySha256: policy.hash, suiteSha256: tests.previousSuiteSha256,
    artifacts: codeRegressionArtifacts(root, policy.units.K01), cases: [{ id: "old-negative", status: "passed" }], runId: "frozen" });
  const current = latestConversationUser([{ type: "user/message", seq: 12, data: { source: { kind: "user" },
    content: [{ type: "text", text: "开始建设：按 SPEC.md 实现批次上限并保住旧行为" }] } }]);
  const { proposal } = proposeConversationTask(process.env.DSH_HOME, "root", current,
    { goal: "实现批次上限", deliverable: "代码和真实测试", scope: "SPEC 和授权代码" });
  decideConversationStart(process.env.DSH_HOME, "root", current, proposal.id, "start",
    () => ({ kind: "workspace", root }), { typed: true });
  const harness = host(root, { automaticCoverage: false });
  async function qualify(actor, runId = "tested-current") {
    const ready = await harness.flow(actor, "prepare");
    const { file, previousCases, requiredCases, protectedCases, ...binding } = ready.codeTask.regressionProof;
    saveProof(file, { ...binding, cases: [...previousCases, ...requiredCases].map(id => ({ id, status: "passed" })), runId });
    return harness.flow(actor, "submit");
  }
  return { harness, qualify };
}

const ref = (file, start, end = start) => ({ file, start, end });
const verified = {
  files: [{ file: worker, basis: "Limits the actual queue input before it is handed off",
    comment: { status: "verified", basis: "Reason agrees with the clamp before downstream memory is used",
      start: 2, end: 2, quote: "# Clamp before enqueue to keep downstream memory bounded." } }],
  constraints: [{ caseId: "batch-bound", requirement: ref(goal, 2), code: ref(worker, 3), status: "pass",
    basis: "The clamp enforces both stated bounds, and the signed batch-bound case exercised them." }],
  findings: [],
};
const codeReview = (harness, actor, action, fields = {}) =>
  harness.invoke(actor, "building_loop_code_review", { action, ...fields });

async function prepareReview(harness, actor) {
  const packet = await codeReview(harness, actor, "prepare");
  await harness.file(actor, "read", worker, { start: 2, count: 2 });
  return packet;
}

test("signed code review uses actual changed lines and an independent receipt before ledger closure", () => fixture(async (root, write) => {
  const { harness, qualify } = prepareProject(root, write);
  const executor = (await harness.flow("root", "advance")).childId;
  write(worker, update);
  assert.equal((await qualify(executor)).phase, "review-ready");
  const reviewer = (await harness.flow("root", "advance")).childId;
  const packet = await codeReview(harness, reviewer, "prepare");
  assert.equal(packet.coverage, undefined);
  assert.equal(harness.visible(reviewer).includes("building_loop_coverage"), false);
  assert.equal(harness.visible(reviewer).includes("building_loop"), false);
  assert.equal(harness.visible(reviewer).includes("building_loop_code_review"), true);
  assert.equal(harness.visible(executor).includes("building_loop_code_review"), false);
  await assert.rejects(async () => codeReview(harness, executor, "submit", verified), /没有纯代码核验授权/);
  assert.deepEqual(packet.codeReview.changes.map(row => [row.path, row.ranges]), [[worker, [{ start: 2, end: 3, removed: 2 }]]]);
  assert.deepEqual(packet.files.map(row => row.path).sort(), [entry, goal, worker].sort());
  await assert.rejects(async () => codeReview(harness, reviewer, "submit", verified), /record/);
  const unread = await codeReview(harness, reviewer, "record", {
    files: [{ ...verified.files[0], comment: { ...verified.files[0].comment, start: 99, end: 99 } }],
  });
  assert.match(unread.errors[0].reason, /读取当前版本/);
  await harness.file(reviewer, "read", worker, { start: 2, count: 2 });
  assert.match(packet.codeReview.submission.fields.commentQuote, /宿主从源码提取原文/);
  const unsupported = structuredClone(verified.files[0]);
  unsupported.comment.quote = "fabricated explanatory comment";
  const partial = await codeReview(harness, reviewer, "record", {
    files: [unsupported, { ...verified.files[0], file: entry }], constraints: verified.constraints, findingsDone: true,
  });
  assert.deepEqual(partial.progress.missingFiles, [worker]);
  assert.deepEqual(partial.progress.missingCases, []);
  assert.equal(partial.progress.findingsDone, true);
  assert.deepEqual(partial.errors.map(({ id }) => id), [worker, entry]);
  assert.match(partial.errors[0].reason, /逐字定位/);
  assert.match(partial.errors[1].reason, /只记录 changes/);
  const corrected = structuredClone(verified.files[0]);
  delete corrected.comment.quote;
  assert.equal((await codeReview(harness, reviewer, "record", { files: [corrected] })).progress.ready, true);
  const longBasis = { ...verified.constraints[0], basis: "a".repeat(401) };
  const invalidReplacement = await codeReview(harness, reviewer, "record", { constraints: [longBasis] });
  assert.match(invalidReplacement.errors[0].reason, /batch-bound 的 constraints\.basis.*当前长度 401/);
  assert.deepEqual(invalidReplacement.progress.pendingCorrections, [{ field: "constraints", id: "batch-bound" }]);
  const needsReview = await codeReview(harness, reviewer, "submit");
  assert.equal(needsReview.status, "needs-review");
  assert.deepEqual(needsReview.progress.pendingCorrections, [{ field: "constraints", id: "batch-bound" }]);
  assert.deepEqual(needsReview.next.pending.map(row => row.id), ["test:1"]);
  assert.equal((await codeReview(harness, reviewer, "record", { constraints: verified.constraints })).progress.ready, true);
  const note = { ...ref(worker, 2), id: "cap-note", kind: "annotation", observation: "The memory rationale is sufficient.",
    suggestion: "Consider documenting the value at its configuration source later.",
    evidence: [{ ...ref(worker, 3), relation: "supports" }] };
  const { suggestion, ...sameResult } = note;
  const badFinding = { ...sameResult, issue: "No defect observed", fix: "No change needed",
    violation: { type: "annotation", expected: "The rationale is present.", actual: "  The rationale  is present. " } };
  const bad = await codeReview(harness, reviewer, "record", { findings: [badFinding], findingsDone: true });
  assert.match(bad.errors[0].reason, /实际结果等于要求.*observations/);
  assert.deepEqual(bad.progress.missingFiles, []);
  assert.deepEqual(bad.progress.missingCases, []);
  assert.equal(bad.progress.ready, false);
  const syntax = { ...badFinding, violation: { type: "syntax", expected: "Valid Python syntax", actual: "Unterminated string" } };
  assert.match((await codeReview(harness, reviewer, "record", { findings: [syntax] })).errors[0].reason, /受信复现编号/);
  const unavailableSyntax = { ...syntax, violation: { ...syntax.violation, reproduction: "missing-probe" } };
  assert.match((await codeReview(harness, reviewer, "record", { findings: [unavailableSyntax] })).errors[0].reason, /复现证明不属于|尚未证明/);
  const valid = await codeReview(harness, reviewer, "record", { observations: [{ ...note, suggestion }], findingsDone: true });
  assert.deepEqual(valid.progress.observationIds, [note.id]);
  assert.equal(valid.progress.ready, true);
  assert.equal((await codeReview(harness, reviewer, "submit")).phase, "first-audit-ready");
  await assert.rejects(harness.ledger("root", "review", { decisions: [] }), /复核阶段/);
  const auditor = (await harness.flow("root", "advance")).childId;
  assert.notEqual(auditor, reviewer);
  assert.notEqual(auditor, executor);
  const blind = await prepareReview(harness, auditor);
  assert.equal(blind.codeReview.binding, packet.codeReview.binding);
  assert.ok(!JSON.stringify(blind).includes(verified.files[0].basis));
  assert.ok(!JSON.stringify(blind).includes(note.observation));
  assert.deepEqual(blind.codeReview.progress.observationIds, []);
  assert.deepEqual(blind.codeReview.progress.missingFiles, [worker]);
  assert.deepEqual(blind.codeReview.progress.missingCases, ["batch-bound"]);
  await assert.rejects(harness.file(auditor, "read", "first.json"), /授权|白名单/);
  assert.equal((await codeReview(harness, auditor, "record", { ...verified, findingsDone: true })).progress.ready, true);
  write(worker, update.replace("min(5", "min(6"));
  await assert.rejects(codeReview(harness, auditor, "submit"), /回归|变化/);
  write(worker, update);
  assert.equal((await codeReview(harness, auditor, "submit")).phase, "ledger-review");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(receipt.codeReview.actor, reviewer);
  assert.equal(receipt.independentAudit.codeReview.actor, auditor);
  assert.equal(receipt.codeReview.binding, receipt.independentAudit.codeReview.binding);
  assert.equal(receipt.codeReview.files[0].comment.quote, verified.files[0].comment.quote);
  assert.equal(receipt.codeReview.files[0].comment.annotationSha256, digest(verified.files[0].comment.quote));
  assert.deepEqual(receipt.codeReview.findings, []);
  assert.equal(receipt.codeReview.observations[0].suggestion, suggestion);
  assert.equal(receipt.independentAudit.codeReview.observations, undefined);
  assert.equal(receipt.coverage, undefined);
  const book = await harness.ledger("root", "read");
  await harness.file("root", "read", goal);
  await harness.file("root", "read", "first.json");
  const decisions = book.items.map(({ id }) => id === "unit-K01"
    ? { id, outcome: "completed", basis: "Both independent current-version records pass", evidence: ref("first.json", 1) }
    : { id, outcome: "keep", basis: "Track the original request separately from this delivery" });
  const proofFile = path.join(root, "candidate-proof.json");
  const saved = fs.readFileSync(proofFile);
  write("candidate-proof.json", saved.toString().replace("tested-current", "untrusted-change"));
  await assert.rejects(harness.ledger("root", "review", { decisions }), /代码、目标或签名/);
  write("candidate-proof.json", saved);
  assert.equal((await harness.ledger("root", "review", { decisions })).phase, "closed");
}));

test("blind code rejection returns actual repair debt and prevents unchanged resubmission", () => fixture(async (root, write) => {
  const { harness, qualify } = prepareProject(root, write);
  const executor = (await harness.flow("root", "advance")).childId;
  write(worker, update);
  assert.equal((await qualify(executor)).phase, "review-ready");
  const reviewer = (await harness.flow("root", "advance")).childId;
  await prepareReview(harness, reviewer);
  await codeReview(harness, reviewer, "record", { ...verified, findingsDone: true });
  assert.equal((await codeReview(harness, reviewer, "submit")).phase, "first-audit-ready");
  const auditor = (await harness.flow("root", "advance")).childId;
  await prepareReview(harness, auditor);
  const finding = { ...ref(worker, 2), id: "cap-ownership", kind: "annotation",
    observation: "The comment gives the memory reason. The clamp on the next line hard-codes the cap.",
    issue: "The comment omits the ownership of the cap value", fix: "Explain why this queue owns the bound",
    violation: { type: "annotation", expected: "Identify why this queue owns the fixed cap", actual: "The memory reason alone is documented" },
    evidence: [{ ...ref(worker, 3), relation: "supports" }], caseId: "batch-bound" };
  const fake = { ...finding, evidence: [{ ...finding.evidence[0], quote: "return n" }] };
  const invalid = await codeReview(harness, auditor, "record", { ...verified, findings: [fake], findingsDone: true });
  assert.match(invalid.errors[0].reason, /逐字一致/);
  assert.deepEqual(invalid.progress.missingFiles, []);
  assert.deepEqual(invalid.progress.missingCases, []);
  assert.equal(invalid.progress.findingsDone, false);
  assert.equal((await codeReview(harness, auditor, "record", { findings: [finding], findingsDone: true })).progress.ready, true);
  const observation = { ...ref(worker, 2), id: finding.id, kind: "annotation", observation: finding.observation, evidence: finding.evidence };
  const failedMove = await codeReview(harness, auditor, "record", { removeFindings: [finding.id],
    observations: [{ ...observation, evidence: [] }] });
  assert.deepEqual(failedMove.progress.findingIds, [finding.id]);
  assert.deepEqual(failedMove.progress.observationIds, []);
  const move = await codeReview(harness, auditor, "record", { removeFindings: [finding.id], observations: [observation] });
  assert.deepEqual(move.progress.findingIds, []);
  assert.deepEqual(move.progress.observationIds, [finding.id]);
  assert.equal(move.progress.ready, true);
  const reverse = await codeReview(harness, auditor, "record", { removeObservations: [finding.id], findings: [finding], findingsDone: true });
  assert.deepEqual(reverse.progress.findingIds, [finding.id]);
  assert.deepEqual(reverse.progress.observationIds, []);
  assert.equal(reverse.progress.ready, true);
  assert.equal((await codeReview(harness, auditor, "submit")).phase, "supplement-ready");
  const active = await harness.flow("root", "advance");
  assert.equal(active.childId, executor);
  const rejected = await harness.file(executor, "read", "first.json");
  assert.ok(JSON.stringify(rejected).includes(finding.issue));
  const proof = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8")).independentAudit.codeReview;
  assert.equal(proof.findings[0].evidence[0].excerptSha256, digest(update.split("\n")[2]));
  assert.deepEqual(proof.findings[0].signedCase, { id: "batch-bound", status: "passed" });
  await assert.rejects(qualify(executor, "same-source-new-test-run"), /退回|落实/);
  const originalEntry = fs.readFileSync(path.join(root, entry), "utf8");
  write(entry, originalEntry + "# [稿件自述] 文档化说明\n");
  await assert.rejects(qualify(executor, "route-switch"), /已有代码核验退回项/);
  write(entry, originalEntry);
  const repaired = update.replace("Clamp before enqueue", "This queue owns its fixed batch cap. Clamp before enqueue");
  write(worker, repaired);
  assert.equal((await qualify(executor, "retested-repair")).phase, "final-review-ready");
  const second = (await harness.flow("root", "advance")).childId;
  await prepareReview(harness, second);
  write(goal, goalText.replace("five items", "six items"));
  const stale = await codeReview(harness, second, "submit");
  assert.equal(stale.phase, "goal-review-ready");
  assert.equal((await harness.flow("root", "advance")).phase, "supplement");
}));

test("prefilled review rows carry only current observed evidence and independently record compact decisions", () => fixture(async (root, write) => {
  const { harness, qualify } = prepareProject(root, write);
  const executor = (await harness.flow("root", "advance")).childId;
  write(worker, update);
  assert.equal((await qualify(executor)).phase, "review-ready");
  const reviewer = (await harness.flow("root", "advance")).childId;
  const packet = await codeReview(harness, reviewer, "prepare");
  const alias = file => packet.codeReview.refs.find(row => row.file === file).prefix;
  const fileDecision = { id: "file:1", status: "verified", basis: "Explains the bounded batch before downstream memory is used" };
  const testDecision = { id: "test:1", status: "pass", basis: "The clamp applies the stated upper and lower bounds.",
    refs: [alias(goal) + ":2", alias(worker) + ":3"] };
  assert.deepEqual(packet.codeReview.pending, [
    { id: "file:1", kind: "file", file: worker, refs: [alias(worker) + ":2-3"], annotationRef: alias(worker) + ":2" },
    { id: "test:1", kind: "test", caseId: "batch-bound", signedStatus: "passed" },
  ]);
  const bad = await codeReview(harness, reviewer, "record", {
    decisions: [fileDecision, { ...testDecision, refs: [alias(goal) + ":2", alias(worker) + ":99"] }],
    findingsDone: true,
  });
  assert.match(bad.errors[0].reason, /读取当前版本/);
  assert.deepEqual(bad.next.pending.map(row => row.id), ["test:1"]);
  const waiting = await codeReview(harness, reviewer, "submit");
  assert.equal(waiting.status, "needs-review");
  assert.deepEqual(waiting.next.pending, bad.next.pending);
  assert.equal((await codeReview(harness, reviewer, "record", { decisions: [testDecision] })).progress.ready, true);
  assert.equal((await codeReview(harness, reviewer, "submit")).phase, "first-audit-ready");
  const auditor = (await harness.flow("root", "advance")).childId;
  assert.notEqual(auditor, reviewer);
  const blind = await codeReview(harness, auditor, "prepare");
  assert.deepEqual(blind.codeReview.pending, packet.codeReview.pending);
  assert.ok(!JSON.stringify(blind).includes(fileDecision.basis));
  const judgment = { ...fileDecision, basis: "The actual memory bound is explained at its source" };
  assert.equal((await codeReview(harness, auditor, "record", {
    decisions: [judgment, testDecision], findingsDone: true,
  })).progress.ready, true);
  assert.equal((await codeReview(harness, auditor, "submit")).phase, "ledger-review");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(receipt.codeReview.files[0].comment.quote, verified.files[0].comment.quote);
  assert.equal(receipt.codeReview.files[0].basis, fileDecision.basis);
  assert.equal(receipt.independentAudit.codeReview.files[0].basis, judgment.basis);
  assert.deepEqual(receipt.codeReview.constraints[0].code, { ...ref(worker, 3), sha256: digest(update) });
}));

test("signed deliveries with declared evidence or writable prose keep the original text review contract", async t => {
  for (const options of [{ evidence: true }, { proseEdit: true }]) {
    await t.test(JSON.stringify(options), () => fixture(async (root, write) => {
      const { harness, qualify } = prepareProject(root, write, options);
      const executor = (await harness.flow("root", "advance")).childId;
      assert.equal((await harness.flow(executor, "prepare")).submission, undefined);
      assert.match(harness.activations.at(-1).request.prompt[0].text, /必要注释/);
      assert.match(harness.prompt(executor), /必要注释/);
      write(worker, update);
      if (options.proseEdit) write("notes.md", "# Changed external assertions\n");
      assert.equal((await qualify(executor)).phase, "review-ready");
      const reviewer = (await harness.flow("root", "advance")).childId;
      const packet = await harness.flow(reviewer, "prepare");
      assert.equal(packet.codeReview, undefined);
      assert.ok(packet.coverage);
      assert.ok(harness.visible(reviewer).includes("building_loop_coverage"));
      await assert.rejects(harness.flow(reviewer, "review", { codeReview: verified }), /文稿及证据/);
    }));
  }
});

test("an older candidate-only review grant still admits signed multi-file work to text review", () => fixture(async (root, write) => {
  const { harness, qualify } = prepareProject(root, write, { partialReview: true });
  const executor = (await harness.flow("root", "advance")).childId;
  write(worker, update);
  assert.equal((await harness.flow(executor, "prepare")).submission, undefined);
  assert.equal((await qualify(executor)).phase, "review-ready");
  const reviewer = (await harness.flow("root", "advance")).childId;
  const packet = await harness.flow(reviewer, "prepare");
  assert.equal(packet.codeReview, undefined);
  assert.ok(packet.coverage);
  await assert.rejects(harness.file(reviewer, "read", worker), /授权|白名单/);
}));

test("the owned architecture section renders direct static Python imports from exactly the signed source set", () => fixture(async (root, write) => {
  const file = "architecture.md";
  const importsHeading = "直接依赖";
  const original = "# 现行设计\r\n\r\n## 直接依赖\r\n\r\n错误声称 queue.py 直接导入 main.py。\r\n\r\n## 回退\r\n\r\n保留本段字节。\r\n";
  const before = "from queue import bounded as route\n# import main\n";
  write(file, original);
  write(entry, before);
  write(worker, source);
  const spec = { architecture: { file, importsHeading }, codeTask: { sources: [entry, worker] } };
  const pin = () => ({ codeIntake: { qualification: { artifacts: [entry, worker].map(file =>
    ({ path: file, sha256: digest(fs.readFileSync(path.join(root, file))) })) } } });
  const baseline = inspectArchitectureImports({ root }, spec);
  assert.equal(baseline.match, false);
  assert.equal(baseline.current, "错误声称 queue.py 直接导入 main.py。");
  assert.equal(baseline.expected, '```text\n"main.py" -> "queue.py"\n"queue.py" -> []\n```');
  assert.ok(baseline.proposed.startsWith("# 现行设计\r\n\r\n## 直接依赖\r\n\r\n"));
  assert.ok(baseline.proposed.endsWith("\r\n\r\n## 回退\r\n\r\n保留本段字节。\r\n"));
  write(file, baseline.proposed);
  const first = pin();
  assert.equal(inspectArchitectureImports({ root }, spec, first).match, true);
  write(worker, "import main\n" + source);
  assert.throws(() => inspectArchitectureImports({ root }, spec, first), /当前签名工件不符/);
  const second = inspectArchitectureImports({ root }, spec, pin());
  assert.equal(second.match, false);
  assert.match(second.expected, /"queue\.py" -> "main\.py"/u);
  write(file, second.proposed);
  assert.equal(inspectArchitectureImports({ root }, spec, pin()).match, true);
}));

test("an unmarked signed qualification from before the upgrade retains prose repair debt", () => fixture(async (root, write) => {
  prepareProject(root, write);
  const policy = authority(root), spec = policy.units.K01;
  const artifacts = codeRegressionArtifacts(root, spec);
  const frame = { root, policy };
  const active = { phase: "intake", codeIntake: { regression: { artifacts } } };
  assert.equal(isCodeReviewUnit(frame, active, spec), true);
  const legacy = { ...active, phase: "supplement", coverageRejections: [{ block: "B1" }], qualityRejected: ["sources"],
    codeIntake: { ...active.codeIntake, qualification: { artifacts, submittedPhase: "intake" } } };
  assert.equal(isCodeReviewUnit(frame, legacy, spec), false);
}));
