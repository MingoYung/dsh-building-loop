import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { isCodeReviewUnit } from "../governance/code-review.mjs";
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
  assert.ok(packet.files.every(row => row.path === goal));
  await assert.rejects(codeReview(harness, reviewer, "submit", verified), /读取当前版本/);
  await harness.file(reviewer, "read", worker, { start: 2, count: 2 });
  assert.match(packet.codeReview.submission.fields.commentQuote, /status=verified 必须填写 quote/);
  const missingQuote = structuredClone(verified);
  delete missingQuote.files[0].comment.quote;
  await assert.rejects(harness.flow(reviewer, "review", { codeReview: missingQuote }), /queue\.py 的 comment\.quote.*必须填写 quote/);
  const longBasis = structuredClone(verified);
  longBasis.constraints[0].basis = "a".repeat(401);
  await assert.rejects(harness.flow(reviewer, "review", { codeReview: longBasis }), /batch-bound 的 constraints\.basis.*当前长度 401/);
  const unsupported = structuredClone(verified);
  unsupported.files[0].comment.quote = "fabricated explanatory comment";
  await assert.rejects(harness.flow(reviewer, "review", { codeReview: unsupported }), /逐字定位/);
  assert.equal((await codeReview(harness, reviewer, "submit", verified)).phase, "first-audit-ready");
  await assert.rejects(harness.ledger("root", "review", { decisions: [] }), /复核阶段/);
  const auditor = (await harness.flow("root", "advance")).childId;
  assert.notEqual(auditor, reviewer);
  assert.notEqual(auditor, executor);
  const blind = await prepareReview(harness, auditor);
  assert.equal(blind.codeReview.binding, packet.codeReview.binding);
  assert.ok(!JSON.stringify(blind).includes(verified.files[0].basis));
  await assert.rejects(harness.file(auditor, "read", "first.json"), /授权|白名单/);
  write(worker, update.replace("min(5", "min(6"));
  await assert.rejects(harness.flow(auditor, "audit", { codeReview: verified }), /回归|变化/);
  write(worker, update);
  assert.equal((await codeReview(harness, auditor, "submit", verified)).phase, "ledger-review");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(receipt.codeReview.actor, reviewer);
  assert.equal(receipt.independentAudit.codeReview.actor, auditor);
  assert.equal(receipt.codeReview.binding, receipt.independentAudit.codeReview.binding);
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
  assert.equal((await harness.flow(reviewer, "review", { codeReview: verified })).phase, "first-audit-ready");
  const auditor = (await harness.flow("root", "advance")).childId;
  await prepareReview(harness, auditor);
  const finding = { ...ref(worker, 2), issue: "The comment omits the ownership of the cap value", fix: "Explain why this queue owns the bound" };
  assert.equal((await harness.flow(auditor, "audit", { codeReview: { ...verified, findings: [finding] } })).phase, "supplement-ready");
  const active = await harness.flow("root", "advance");
  assert.equal(active.childId, executor);
  const rejected = await harness.file(executor, "read", "first.json");
  assert.ok(JSON.stringify(rejected).includes(finding.issue));
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
  const stale = await harness.flow(second, "review", { codeReview: verified });
  assert.equal(stale.phase, "goal-review-ready");
  assert.equal((await harness.flow("root", "advance")).phase, "supplement");
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
