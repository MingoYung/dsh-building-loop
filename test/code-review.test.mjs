import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { inspectArchitectureImports, isCodeReviewUnit, signedAnnotationCandidates, unreadAnnotationCandidates } from "../governance/code-review.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { fixture, host } from "./helpers.mjs";

const entry = "main.py";
const worker = "queue.py";
const goal = "SPEC.md";
const source = "def bounded(n):\n    # Reject negative batch sizes before enqueue.\n    return max(0, n)\n";
const update = "def bounded(n):\n    # Clamp before enqueue to keep downstream memory bounded.\n    return min(5, max(0, n))\n";
const goalText = "# Queue release\nBound each submitted batch between zero and five items. Output field `size` is at most 5.\n";

test("signed list cost review surfaces exact source and excludes explicit linear or fixed-slice bounds", () => fixture(async (root, write) => {
  const check = (source, current = true) => {
    write(worker, source);
    return signedAnnotationCandidates({ root }, { codeTask: { sources: [worker] } },
      { artifacts: [{ path: worker, sha256: digest(current ? source : "old bytes") }] });
  };
  const code = `from bisect import insort\ndef build(items):\n    \"\"\"Each insertion is O(log n).\"\"\"\n    rows = [item for item in items]\n    insort(rows, 0)\n    return rows\n`;
  const [issue] = check(code);
  assert.deepEqual([issue.file, issue.start, issue.operationLine], [worker, 3, 5]);
  assert.deepEqual(check(code.replace("Each insertion is O(log n).", "Find insertion position in O(log n); moving the suffix costs O(n).")), []);
  assert.deepEqual(check(code.replace("O(log n)", "O(log n + n)")), []);
  assert.deepEqual(check(code.replace("item in items", "item in items[:2]").replace("O(log n)", "O(1)")), []);
  assert.deepEqual(check(code.replace("from bisect import insort", "from custom import insort")), []);
  assert.deepEqual(check(code.replace("    insort(rows, 0)", "    if items:\n        rows = make_custom_index()\n    insort(rows, 0)")), []);
  assert.deepEqual(check(code.replace("[item for item in items]", "[]")), []);
  assert.deepEqual(check(code, false), []);
}));

function prepareProject(root, write, { evidence = false, proseEdit = false, partialReview = false,
  receiptReads = true, diagnostics, text = goalText } = {}) {
  const keys = generateKeyPairSync("ed25519");
  const sources = [entry, worker];
  const grant = { read: [...sources, ...(receiptReads ? ["first.json", "final.json"] : []), ...(proseEdit ? ["notes.md"] : [])],
    write: [...sources, ...(proseEdit ? ["notes.md"] : [])] };
  const review = receipt => ({ read: [...(partialReview ? [entry] : sources), ...(evidence ? ["functional.csv"] : [])],
    evidence: evidence ? ["functional.csv"] : [], receipt });
  const tests = { file: "candidate-proof.json", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    previousSuiteSha256: digest("previous suite"), suiteSha256: digest("candidate suite"),
    requiredCases: ["batch-bound"], regression: { baselineFile: "baseline-proof.json", previousCases: ["old-negative"] } };
  write(entry, "from queue import bounded\n\nprint(bounded(9))\n");
  write(worker, source);
  write(goal, text);
  if (proseEdit) write("notes.md", "# Existing release notes\n");
  write("BUILDING-LOOP.json", JSON.stringify({ spec: "building-loop/1", coordinator: { read: [goal, "first.json", "final.json"] },
    goalContext: [goal], units: { K01: { candidate: entry, plainLast: false, codeTask: { sources, tests, diagnostics },
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

test("the annotation locator requires the actual signed lines and leaves the decision to each review", () => fixture(async (root, write) => {
  const { harness, qualify } = prepareProject(root, write);
  const executor = (await harness.flow("root", "advance")).childId;
  write(worker, "from bisect import insort\n" + update + "\ndef order(items):\n" +
    '    """Each insertion is O(log n)."""\n    rows = [item for item in items]\n    insort(rows, 0)\n    return rows\n');
  assert.equal((await qualify(executor)).phase, "review-ready");
  const reviewer = (await harness.flow("root", "advance")).childId;
  const prepared = await codeReview(harness, reviewer, "prepare");
  const [candidate] = prepared.codeReview.annotationCandidates;
  assert.deepEqual([candidate.start, candidate.operationLine], [7, 9]);
  assert.deepEqual(unreadAnnotationCandidates({ reads: [worker] }, { seen: {
    [worker]: { hash: candidate.sha256, ranges: [[7, 8]] },
  } }, [candidate]), [candidate]);
  assert.ok(prepared.files.find(row => row.path === worker).lines.some(([line]) => line === 9));
  assert.equal((await codeReview(harness, reviewer, "prepare")).codeReview.annotationCandidates, undefined);
  assert.equal((await codeReview(harness, reviewer, "submit")).next.annotationCandidates, undefined);
}));

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
  const syntax = { ...badFinding, kind: "behavior", violation: { type: "syntax", expected: "Valid Python syntax", actual: "Unterminated string" } };
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
    violation: { type: "annotation", obligation: "interface", expected: "Identify why this queue owns the fixed cap", actual: "The memory reason alone is documented" },
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
  assert.equal(proof.findings[0].staticProof.annotationSha256, digest(verified.files[0].comment.quote));
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

test("behavior rejection requires the current reviewer's exact clause and a real output mismatch", () => fixture(async (root, write) => {
  const token = "only-test-review-requirement-token-1234";
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.headers.authorization, "Bearer " + token);
    calls.push(input);
    const { missing, overCap, entries } = JSON.parse(input.probe.stdin);
    const registeredFault = Array.isArray(entries) && !entries.length && input.phase.includes("audit");
    const stdout = JSON.stringify(missing ? { error: "unknown-reference" } : { size: registeredFault ? 1
      : Array.isArray(entries) && !entries.length ? 0 : overCap ? 6 : 5 });
    response.end(JSON.stringify({ spec: input.spec, requestId: input.requestId, snapshotSha256: input.snapshotSha256,
      status: "passed", probe: { exitCode: 0, stdout } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = { DSH_BUILDING_LOOP_DIAGNOSTICS_URL: "http://127.0.0.1:" + server.address().port + "/run",
    DSH_BUILDING_LOOP_DIAGNOSTICS_TOKEN: token };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const unknown = "Missing queue or missing worker both return `unknown-reference`.";
    const conditionalSuffix = "output field `size` equals 0.";
    const conditionalLine = "When the input contains no entries, " + conditionalSuffix;
    const previousCondition = "When the input contains no entries:\nOutput field `size` equals 0.";
    const clauseText = goalText + unknown + "\n\n" + conditionalLine + "\n\n" + previousCondition + "\n";
    const diagnostics = { checkSet: "review-clause", protocol: 2, recipes: ["queue"], reviewRecipes: ["queue"],
      inputContracts: [{ id: "entries", recipe: "queue", examples: [{ id: "empty", input: { entries: [] },
        expectedJson: { size: 0 }, requirement: { ...ref(goal, 5), quote: conditionalLine } }] }] };
    const { harness, qualify } = prepareProject(root, write, { diagnostics, receiptReads: false, text: clauseText });
    const executor = (await harness.flow("root", "advance")).childId;
    write(worker, update);
    assert.equal((await qualify(executor)).phase, "review-ready");
    const reviewer = (await harness.flow("root", "advance")).childId;
    await prepareReview(harness, reviewer);
    await codeReview(harness, reviewer, "record", { ...verified, findingsDone: true });
    assert.equal((await codeReview(harness, reviewer, "submit")).phase, "first-audit-ready");
    const auditor = (await harness.flow("root", "advance")).childId;
    const packet = await prepareReview(harness, auditor);
    assert.match(packet.codeReview.reproduction.requirement, /quote/u);
    calls.length = 0;
    const finding = { id: "reference-order", kind: "behavior", ...ref(worker, 3), caseId: "batch-bound",
      observation: "Two invalid references take different code paths.", issue: "The implementation lacks priority for missing references.",
      fix: "Give the missing queue priority over the missing worker.", evidence: [{ ...ref(worker, 3), relation: "supports" }],
      violation: { type: "requirement", expected: "An explicit priority for the two checks.", actual: "No explicit priority.", requirement: ref(goal, 3) } };
    const recordFinding = row => codeReview(harness, auditor, "record", { findings: [row], findingsDone: true });
    const unsupported = await codeReview(harness, auditor, "record", { ...verified, findings: [finding], findingsDone: true });
    assert.match(unsupported.errors[0].reason, /受信复现编号/);
    assert.deepEqual(unsupported.progress.findingIds, []);
    for (const kind of ["annotation", "maintenance"]) {
      const aliases = await recordFinding({ ...finding, kind });
      assert.match(aliases.errors[0].reason, /kind 与 violation.type 不一致/u);
    }
    const fakeMaintenance = await recordFinding({ ...finding, kind: "maintenance", violation: { ...finding.violation,
      type: "maintainability", requirement: undefined } });
    assert.match(fakeMaintenance.errors[0].reason, /实际要求原文/u);
    const falseComment = await recordFinding({ ...finding, kind: "annotation", violation: { ...finding.violation,
      type: "annotation", obligation: "invariant", requirement: undefined } });
    assert.match(falseComment.errors[0].reason, /定位真实注释/u);
    const falseMissing = await codeReview(harness, auditor, "record", { decisions: [{ id: "file:1", status: "missing",
      basis: "Reinterprets an already documented choice as missing rationale.", refs: [ref(worker, 3)], obligation: "invariant" }] });
    assert.match(falseMissing.errors[0].reason, /该范围有可定位注释/u);
    await codeReview(harness, auditor, "record", { files: verified.files });
    const probe = { assertion: "runtime", file: worker, recipe: "queue", stdin: '{"missing":["queue","worker"]}', expectedExitCode: 0 };
    const unknownClause = { ...ref(goal, 3), quote: unknown };
    await assert.rejects(codeReview(harness, auditor, "probe", { ...probe, requirement: { ...unknownClause, quote: "Returns another error." } }), /逐字引用/);
    await assert.rejects(codeReview(harness, auditor, "probe", { ...probe, requirement: unknownClause,
      expectedJson: '{"error":"unknown-reference","invented":true}', expectedPointer: "" }), /只提供该字段的标量或数组/u);
    for (const code of ["queue-first", "QUEUE_FIRST"]) {
      await assert.rejects(codeReview(harness, auditor, "probe", { ...probe, requirement: unknownClause,
        expectedPointer: "/error", expectedJson: JSON.stringify(code) }), /须逐字见于对应条款/u);
    }
    assert.equal(calls.length, 0);
    const matching = await codeReview(harness, auditor, "probe", { ...probe, requirement: unknownClause,
      expectedPointer: "/error", expectedJson: '"unknown-reference"' });
    assert.equal(matching.outcome, "match");
    assert.match((await recordFinding({ ...finding, violation: { ...finding.violation, reproduction: matching.id } })).errors[0].reason, /符合预期/);
    const inventedField = await codeReview(harness, auditor, "probe", { ...probe, requirement: unknownClause,
      expectedPointer: "/diagnosticPriority", expectedJson: '"queue"' });
    assert.equal(inventedField.outcome, "unavailable");
    assert.equal(inventedField.reason, "missing-unstated-field");
    const exploratory = await codeReview(harness, auditor, "probe", { ...probe, expectedJson: '{"error":"queue-first"}' });
    assert.equal(exploratory.outcome, "mismatch");
    assert.match((await recordFinding({ ...finding, violation: { ...finding.violation, reproduction: exploratory.id } })).errors[0].reason, /探索复现不能用于退回/);
    const conditionalExpectation = { ...probe, stdin: '{"entries":[1]}', expectedPointer: "/size", expectedJson: "0" };
    for (const requirement of [
      { ...ref(goal, 5), quote: conditionalLine },
      { ...ref(goal, 5), quote: conditionalSuffix },
      { ...ref(goal, 8), quote: "Output field `size` equals 0." },
    ]) {
      const observed = await codeReview(harness, auditor, "probe", { ...conditionalExpectation, requirement });
      assert.equal(observed.outcome, "mismatch");
      assert.equal(observed.actual.json, 5);
      assert.equal(observed.blocking, false);
    }
    const registered = await codeReview(harness, auditor, "probe", {
      assertion: "runtime", file: worker, exampleId: "entries:example:empty",
    });
    assert.equal(registered.outcome, "mismatch");
    assert.equal(registered.actual.json.size, 1);
    assert.equal(registered.blocking, true);
    assert.equal(registered.grounding.kind, "registered-example");
    assert.deepEqual(JSON.parse(calls.at(-1).probe.stdin), { entries: [] });

    const badDecision = { id: "test:1", status: "revise", basis: "The review has a concern about the ordering.", refs: [ref(goal, 2), ref(worker, 3)] };
    const decision = await codeReview(harness, auditor, "record", { decisions: [badDecision], findingsDone: true });
    assert.deepEqual(decision.progress.unsupportedCaseRevisions, ["batch-bound"]);
    assert.equal((await codeReview(harness, auditor, "submit")).status, "needs-review");

    const capClause = { ...ref(goal, 2), quote: "Output field `size` is at most 5." };
    const failed = await codeReview(harness, auditor, "probe", { ...probe, stdin: '{"overCap":true}', requirement: capClause,
      expectedPointer: "/size", expectedOperator: "at-most", expectedJson: "5" });
    assert.equal(failed.outcome, "mismatch");
    assert.equal(failed.actual.json, 6);
    assert.equal(failed.blocking, true);
    assert.match((await recordFinding({ ...finding, violation: { ...finding.violation, reproduction: failed.id } })).errors[0].reason, /相同当前规格条款/);
    const real = { ...finding, id: "over-cap", observation: "The signed reproduction observed six queued items.", issue: "The queue exceeds five items.",
      fix: "Clamp the reproduced queue operation before downstream processing.", violation: { type: "runtime", expected: "The observed size is at most five.",
        actual: "The observed size is six.", requirement: ref(goal, 2), reproduction: failed.id } };
    assert.equal((await recordFinding(real)).progress.ready, true);
    assert.equal((await codeReview(harness, auditor, "submit")).phase, "supplement-ready");
    const proof = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8")).independentAudit.codeReview.findings[0].violation.reproduction;
    assert.deepEqual(proof.replay, { input: { recipe: "queue", stdin: '{"overCap":true}' },
      expected: { exitCode: 0, pointer: "/size", operator: "at-most", json: 5 } });
    assert.equal(proof.actual.jsonSha256, digest("6"));
    assert.equal(proof.requirement.quote, capClause.quote);
    assert.equal(proof.summary.expected, "JSON 字段 /size ≤ 5");
    assert.equal(proof.summary.actual, "JSON 字段 /size 实测 6");
    const supplement = await harness.flow("root", "advance");
    assert.equal(supplement.childId, executor);
    const handoff = (await harness.flow(executor, "prepare")).codeRepair;
    assert.equal(handoff.receipt, "first.json");
    assert.deepEqual(handoff.findings, [{ id: "over-cap", kind: "behavior", ...ref(worker, 3), issue: real.issue,
      fix: real.fix, requirement: { ...ref(goal, 2), sha256: digest(clauseText) } }]);
    await assert.rejects(harness.file(executor, "read", "first.json"), /读白名单/u);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.close();
    await once(server, "close");
  }
}));

test("the archived G4 success clause cannot justify an error index or an invented normalization rule", () => fixture(async (root, write) => {
  const archive = JSON.parse(fs.readFileSync(new URL("../experiments/observations-0.7.26-hard-g4-review-grounding.json", import.meta.url), "utf8"));
  const { actualReplay, correctIdenticalPayloadControl, receipt } = archive;
  const token = "only-test-frozen-review-replay-token-1234";
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.headers.authorization, "Bearer " + token);
    const input = JSON.parse(job.probe.stdin);
    const outcome = Object.hasOwn(input.requests[1], "retain") ? correctIdenticalPayloadControl : actualReplay;
    assert.deepEqual(input, outcome.input);
    calls.push(job);
    response.end(JSON.stringify({ spec: job.spec, requestId: job.requestId, snapshotSha256: job.snapshotSha256,
      status: "passed", probe: { exitCode: outcome.exitCode, stdout: JSON.stringify(outcome.output) } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = { DSH_BUILDING_LOOP_DIAGNOSTICS_URL: "http://127.0.0.1:" + server.address().port + "/run",
    DSH_BUILDING_LOOP_DIAGNOSTICS_TOKEN: token };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const { harness, qualify } = prepareProject(root, write, {
      receiptReads: false,
      diagnostics: { checkSet: "review-frozen-replay", protocol: 2, recipes: ["queue"], reviewRecipes: ["queue"] },
      text: goalText + receipt.clauseFullLine + "\n",
    });
    const executor = (await harness.flow("root", "advance")).childId;
    write(worker, update);
    assert.equal((await qualify(executor)).phase, "review-ready");
    const reviewer = (await harness.flow("root", "advance")).childId;
    await prepareReview(harness, reviewer);
    const requirement = { ...ref(goal, 3), quote: receipt.requirement.quote };
    const originalAssertion = { assertion: "runtime", file: worker, recipe: "queue", requirement,
      expectedExitCode: receipt.replayExpected.exitCode, expectedPointer: receipt.replayExpected.pointer,
      expectedJson: JSON.stringify(receipt.replayExpected.json) };
    const replay = input => codeReview(harness, reviewer, "probe", { ...originalAssertion, stdin: JSON.stringify(input) });
    const ambiguous = await replay(actualReplay.input);
    assert.equal(ambiguous.outcome, "mismatch");
    assert.equal(ambiguous.actual.json, 1);
    assert.equal(ambiguous.blocking, false);
    assert.equal(ambiguous.replay, undefined);
    const passing = await replay(correctIdenticalPayloadControl.input);
    assert.equal(passing.outcome, "unavailable");
    assert.equal(passing.reason, "missing-unstated-field");
    assert.equal(calls.length, 2);
    const falseRejection = await codeReview(harness, reviewer, "record", { findings: [{
      id: "retain-default-not-normalized", kind: "behavior", ...ref(worker, 3),
      observation: "Explicit and omitted fields took different paths.",
      issue: "Treat absence as an explicit empty list for identity.",
      fix: "Normalize the default before checking identity.",
      evidence: [{ ...ref(worker, 3), relation: "supports" }],
      violation: { type: "requirement", expected: "An error index of zero.", actual: "An error index of one.",
        requirement: ref(goal, 3), reproduction: ambiguous.id },
    }] });
    assert.match(falseRejection.errors[0].reason, /探索复现不能用于退回/u);
    assert.deepEqual(falseRejection.progress.findingIds, []);
    await codeReview(harness, reviewer, "record", { ...verified, findingsDone: true });
    assert.equal((await codeReview(harness, reviewer, "submit")).phase, "first-audit-ready");
    const auditor = (await harness.flow("root", "advance")).childId;
    await prepareReview(harness, auditor);
    await codeReview(harness, auditor, "record", { ...verified, findingsDone: true });
    assert.equal((await codeReview(harness, auditor, "submit")).phase, "ledger-review");
    const saved = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
    assert.deepEqual(saved.codeReview.findings, []);
    assert.deepEqual(saved.independentAudit.codeReview.findings, []);
    assert.notEqual(saved.codeReview.actor, saved.independentAudit.codeReview.actor);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.close();
    await once(server, "close");
  }
}));

test("a required missing annotation can block on a named rule and observed changed range", () => fixture(async (root, write) => {
  const { harness, qualify } = prepareProject(root, write, { receiptReads: false });
  const executor = (await harness.flow("root", "advance")).childId;
  const uncommented = "def bounded(n):\n    return min(5, max(0, n))\n";
  write(worker, uncommented);
  assert.equal((await qualify(executor)).phase, "review-ready");
  const reviewer = (await harness.flow("root", "advance")).childId;
  await codeReview(harness, reviewer, "prepare");
  const file = { id: "file:1", status: "missing", refs: [ref(worker, 2)],
    basis: "Explain why downstream capacity makes both bounds necessary before handing off." };
  const test = { id: "test:1", status: "pass", refs: [ref(goal, 2), ref(worker, 2)],
    basis: "The signed batch test applies both bounds at this handoff." };
  const invalid = await codeReview(harness, reviewer, "record", { decisions: [file, test], findingsDone: true });
  assert.match(invalid.errors[0].reason, /须给出 obligation/u);
  assert.equal(invalid.progress.ready, false);
  const recorded = await codeReview(harness, reviewer, "record", { decisions: [{ ...file, obligation: "invariant" }] });
  assert.equal(recorded.progress.ready, true);
  assert.equal((await codeReview(harness, reviewer, "submit")).phase, "supplement-ready");
  const proof = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8")).codeReview.files[0].comment.staticProof;
  assert.deepEqual(proof, { rule: "necessary-comment", obligation: "invariant", check: "missing-adjacent-annotation",
    start: 1, end: 2, sha256: digest(uncommented.trimEnd()) });
  const repair = await harness.flow("root", "advance");
  assert.equal(repair.childId, executor);
  const packet = (await harness.flow(executor, "prepare")).codeRepair;
  assert.equal(packet.receipt, "first.json");
  assert.equal(packet.sha256, digest(fs.readFileSync(path.join(root, "first.json"))));
  assert.deepEqual(packet.comments, [{ file: worker, start: 2, end: 2, obligation: "invariant", basis: file.basis }]);
  await assert.rejects(harness.file(executor, "read", "first.json"), /读白名单/u);
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
  const badShape = await codeReview(harness, reviewer, "record", { decisions: [
    { ...fileDecision, file: worker, comments: [], refs: Array.from({ length: 7 }, () => alias(worker) + ":2") },
  ] });
  assert.match(badShape.errors[0].reason, /删除简表字段 file、comments.*最多六个位置/u);
  assert.deepEqual(badShape.errors[0].correction, { code: "compact-decision-shape",
    allowed: ["id", "basis", "status", "refs", "obligation"], maxRefs: 6, previousAccepted: true });
  assert.deepEqual(badShape.next.pending.map(row => row.id), ["test:1"]);
  const wrongEvidence = await codeReview(harness, reviewer, "record", {
    decisions: [{ ...fileDecision, refs: [alias(worker) + ":3"] }],
  });
  assert.match(wrongEvidence.errors[0].reason, /没有可核对的注释/u);
  assert.deepEqual(wrongEvidence.progress.pendingCorrections, [{ field: "files", id: worker }]);
  await codeReview(harness, reviewer, "record", { decisions: [fileDecision] });
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
