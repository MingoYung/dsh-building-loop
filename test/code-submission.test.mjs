import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { editedCodeReadback } from "../governance/code-submission.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { authority, digest, scopedEditContent } from "../governance/policy.mjs";
import { fixture, host } from "./helpers.mjs";

const candidate = "schedule.py", module = "events.py", goal = "SPEC.md";
const baseline = "signed-before.json", current = "signed-after.json";

async function start(root, write, source, plainLast = false) {
  const keys = generateKeyPairSync("ed25519");
  const tests = { file: current, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    previousSuiteSha256: digest("frozen old suite"), suiteSha256: digest("current full suite"),
    requiredCases: ["new"], regression: { baselineFile: baseline, previousCases: ["old"] } };
  const editable = { read: [candidate, module], write: [candidate, module] };
  write("BUILDING-LOOP.json", JSON.stringify({ spec: "building-loop/1",
    coordinator: { read: [goal, "review.json", "final.json"] }, goalContext: [goal],
    units: { K01: { candidate, plainLast, codeTask: { sources: [candidate, module], tests },
      phases: { intake: editable, supplement: editable,
        "first-review": { read: [candidate, module], receipt: "review.json" },
        "final-review": { read: [candidate, module], receipt: "final.json" } } } },
  }));
  write(candidate, source);
  write(goal, "# Current goal\nSchedule one more event.\n");
  const owner = latestConversationUser([{ type: "user/message", seq: 12, data: { source: { kind: "user" },
    content: [{ type: "text", text: "开始建设：按 SPEC 扩展事件调度" }] } }]);
  const { proposal } = proposeConversationTask(process.env.DSH_HOME, "root", owner,
    { goal: "调度扩展", deliverable: "可执行调度器与回归", scope: "SPEC 与授权源码" });
  decideConversationStart(process.env.DSH_HOME, "root", owner, proposal.id, "start", () => ({ kind: "workspace", root }), { typed: true });
  const seal = (file, proof) => write(file, JSON.stringify({ ...proof,
    signature: sign(null, codeRegressionSigningBytes(proof), keys.privateKey).toString("base64") }));
  const policy = authority(root);
  seal(baseline, { spec: "building-loop-code-regression-baseline/1", unit: "K01", policySha256: policy.hash,
    suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, policy.units.K01), runId: "baseline",
    cases: [{ id: "old", status: "passed" }] });
  const harness = host(root, { automaticCoverage: false });
  const { childId } = await harness.flow("root", "advance");
  return { harness, childId, seal: ({ file, previousCases, requiredCases, protectedCases, ...binding }) =>
    seal(file, { ...binding, runId: "current", cases: [...previousCases, ...requiredCases].map(id => ({ id, status: "passed" })) }) };
}

test("exact splice carries only complete previously seen lines and echoes changed lines", () => {
  const original = Buffer.from("\uFEFFheader\r\nreplace A\r\nnever read\r\nreplace B\r\nread tail\r\n");
  let edit;
  const landed = Buffer.from(scopedEditContent(original, { beforeSha256: digest(original),
    edits: [{ oldText: "replace A", newText: "changed A\ninserted" }, { oldText: "replace B\n", newText: "joined " }] },
  splice => { edit = splice; }));
  assert.equal(landed.toString("utf8"), "\uFEFFheader\r\nchanged A\r\ninserted\r\nnever read\r\njoined read tail\r\n");
  const { carried, rows } = editedCodeReadback(edit, landed, { hash: digest(original), ranges: [[1, 2], [4, 6]] }, 1024);
  assert.deepEqual(carried, [[1, 1]]);
  assert.deepEqual(rows, [[2, "changed A"], [3, "inserted"], [5, "joined read tail"], [6, ""]]);
  const next = Buffer.from(scopedEditContent(landed, { beforeSha256: digest(landed),
    oldText: "changed A", newText: "another\nchanged A" }, splice => { edit = splice; }));
  const shifted = editedCodeReadback(edit, next, { hash: digest(landed), ranges: [[3, 3], [5, 5]] }, 1024);
  assert.deepEqual(shifted.carried, [[4, 4], [6, 6]]);
  assert.deepEqual(shifted.rows, [[2, "another"], [3, "changed A"], [7, ""]]);
});

test("signed submit supplies unread current source in bounded pages, then hands off without editing again", () => fixture(async (root, write) => {
  const source = Array.from({ length: 904 }, (_, i) => "# line " + (i + 1)).join("\n");
  const { harness, childId, seal } = await start(root, write, source);
  const prepare = () => harness.flow(childId, "prepare");
  const submit = () => harness.flow(childId, "submit");
  const initial = await prepare();
  assert.equal(initial.submission.status, "blocked");
  const edit = await harness.file(childId, "edit", candidate, { beforeSha256: digest(source), oldText: "# line 299\n",
    newText: "def schedule():\n    return 2\n", note: "Add scheduler behavior" });
  assert.deepEqual(edit.readback.lines, [[299, "def schedule():"], [300, "    return 2"]]);
  const fresh = await harness.file(childId, "write", module, { content: "def event():\n    return 2\n", note: "Add event helper" });
  assert.deepEqual(fresh.readback.lines, [[1, "def event():"], [2, "    return 2"], [3, ""]]);
  assert.equal(fresh.readback.pending, null);
  const { codeTask } = await prepare();
  const notices = harness.notifications.length;
  await assert.rejects(submit(), /缺少当前交付的回归签名回执/);
  seal(codeTask.regressionProof);
  const first = await submit();
  assert.equal(first.phase, "intake");
  assert.equal(first.submission.status, "read-back");
  assert.deepEqual(first.submission.next, { tool: "building_loop", action: "submit" });
  assert.equal(first.submission.files[0].path, candidate);
  assert.equal(first.submission.files[0].lines.length, 250);
  assert.equal(first.submission.files[0].sha256, edit.sha256);
  assert.equal(first.submission.pending.length, 1);
  assert.equal(harness.notifications.length, notices);
  assert.deepEqual(harness.concluded, []);
  const second = await submit();
  assert.equal(second.submission.status, "read-back");
  assert.deepEqual(second.submission.pending, []);
  assert.equal((await submit()).phase, "review-ready");
  assert.equal(harness.notifications.length, notices + 1);
  assert.deepEqual(harness.concluded, [childId]);
}));

test("edit readback avoids a full re-read and rejects a receipt for a superseded goal", () => fixture(async (root, write) => {
  const source = "def schedule():\n    return 1\n";
  const { harness, childId, seal } = await start(root, write, source);
  await harness.flow(childId, "prepare");
  const edit = await harness.file(childId, "edit", candidate, { beforeSha256: digest(source), oldText: "return 1", newText: "return 2", note: "New event" });
  assert.deepEqual(edit.readback.lines, [[2, "    return 2"], [3, ""]]);
  assert.equal(edit.readback.pending, null);
  const challenge = await harness.flow(childId, "prepare");
  assert.ok(!challenge.files.some(({ path }) => path === candidate));
  seal(challenge.codeTask.regressionProof);
  assert.equal((await harness.flow(childId, "prepare")).submission.status, "ready");
  write(goal, "# Current goal\nSchedule two more events.\n");
  await assert.rejects(harness.flow(childId, "submit"), /回归签名回执.*不符/);
  assert.equal((await harness.flow(childId, "status")).phase, "intake");
  const updated = await harness.flow(childId, "prepare");
  seal(updated.codeTask.regressionProof);
  assert.equal((await harness.flow(childId, "submit")).phase, "review-ready");
}));

test("an implementation candidate with an explicit prose requirement uses the original read gate", () => fixture(async (root, write) => {
  const source = "def schedule():\n    return 1\n";
  const { harness, childId } = await start(root, write, source, true);
  assert.equal((await harness.flow(childId, "prepare")).submission, undefined);
  const edit = await harness.file(childId, "edit", candidate, { beforeSha256: digest(source), oldText: "return 1", newText: "return 2", note: "Edit in mixed task" });
  assert.equal(edit.readback, undefined);
  await assert.rejects(harness.flow(childId, "submit"), /完整读回当前候选文件/);
}));
