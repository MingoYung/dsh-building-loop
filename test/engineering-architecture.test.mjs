import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { fixture, host } from "./helpers.mjs";

const candidate = "runtime.py";
const goal = "GOAL.md";
const architecture = "modules/architecture.md";
const headings = ["职责", "回退"];
const template = "# 架构\n\n## 职责\n\n待填写。\n\n## 回退\n\n待填写。\n";
const plan = "# 架构\n\n## 职责\n\n入口限制请求预算。\n\n## 回退\n\n回退入口到原算法并验证旧预算。\n";
const revised = plan.replace("验证旧预算", "重放已发请求并验证旧预算");
const ref = (file, start, end = start) => ({ file, start, end });

function project(root, write, { importsHeading } = {}) {
  const keys = generateKeyPairSync("ed25519");
  const sources = importsHeading ? [candidate, "limits.py"] : [candidate];
  const files = [...sources, architecture];
  const execute = { read: files, write: sources };
  const review = receipt => ({ read: files, receipt });
  const tests = { file: "current-test.json", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    previousSuiteSha256: digest("old"), suiteSha256: digest("new"), requiredCases: ["limit"],
    regression: { baselineFile: "before-test.json", previousCases: ["old"] } };
  write(goal, "# 本轮目标\n\n预算最多五项。\n\n## 入口\n\n- [索引](INDEX.md)\n");
  write("INDEX.md", "# 索引\n\n## 模块\n\n- [架构](modules/architecture.md)\n");
  fs.mkdirSync(path.dirname(path.join(root, architecture)));
  write(architecture, template + (importsHeading ? "\n## " + importsHeading + "\n\n待由宿主生成。\n" : ""));
  write(candidate, "def budget(value):\n    return value\n");
  if (importsHeading) write("limits.py", "MAXIMUM = 5\n");
  write("BUILDING-LOOP.json", JSON.stringify({ spec: "building-loop/1", goalContext: [goal],
    hierarchy: { overview: { path: goal, heading: "入口" }, index: { path: "INDEX.md", heading: "模块" },
      modules: { architecture } },
    coordinator: { read: [goal, "INDEX.md", architecture, "first.json", "final.json"], write: [architecture] },
    units: { K01: { candidate, plainLast: false, architecture: { module: "architecture", headings, importsHeading },
      codeTask: { sources, tests }, phases: { intake: execute, supplement: execute,
        "first-review": review("first.json"), "final-review": review("final.json") } } } }));
  const policy = authority(root);
  const save = (file, body) => write(file, JSON.stringify({ ...body,
    signature: sign(null, codeRegressionSigningBytes(body), keys.privateKey).toString("base64") }));
  save(tests.regression.baselineFile, { spec: "building-loop-code-regression-baseline/1", unit: "K01", policySha256: policy.hash,
    suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, policy.units.K01), runId: "baseline",
    cases: [{ id: "old", status: "passed" }] });
  const current = latestConversationUser([{ type: "user/message", seq: 12, data: { source: { kind: "user" },
    content: [{ type: "text", text: "开始建设：实施预算上限，工作单元 K01。" }] } }]);
  const { proposal } = proposeConversationTask(process.env.DSH_HOME, "root", current,
    { goal: "预算上限", deliverable: "架构和可验证代码", scope: "当前项目" });
  decideConversationStart(process.env.DSH_HOME, "root", current, proposal.id, "start", () => ({ kind: "workspace", root }), { typed: true });
  return { save, harness: host(root, { automaticCoverage: false }) };
}

const fileJudgment = { file: candidate, basis: "The cap protects downstream capacity.",
  comment: { status: "verified", start: 2, end: 2, basis: "This clamp implements the stated limit." } };
const constraint = { caseId: "limit", status: "pass", requirement: ref(goal, 3), code: ref(candidate, 3),
  basis: "The signed test checks the cap that is applied before returning." };

async function approve(harness, actor, changed) {
  const review = (action, fields) => harness.invoke(actor, "building_loop_code_review", { action, ...fields });
  await review("prepare");
  const note = await harness.file(actor, "read", architecture);
  await harness.file(actor, "read", candidate);
  const result = await review("record", { files: [fileJudgment], constraints: [constraint], findingsDone: true,
    architecture: { source: ref(architecture, 1, note.totalLines), status: changed ? "revise" : "pass", basis: "Review the rollback impact against the approved scope.",
      sections: [{ heading: "职责", basis: "The entrypoint implements the bound.", evidence: [{ ...ref(candidate, 3), relation: "supports" }] },
        { heading: "回退", basis: "The owner goal sets the budget that remains covered after rollback.",
          evidence: [{ ...ref(goal, 3), relation: "supports" }] }] },
    ...(changed ? { findings: [{ id: "rollback", kind: "architecture", ...ref(architecture, 9), observation: "Rollback only repeats the old budget check.",
      issue: "The plan does not cover replaying already submitted work.", fix: "Reproduce a replay against the reverted entrypoint.",
      evidence: [{ ...ref(architecture, 9), relation: "supports" }] }] } : {}) });
  assert.deepEqual(result.errors, []);
  return review("submit");
}

test("a signed delivery waits for the coordinator architecture and sends architecture repair back to that role", () => fixture(async (root, write) => {
  const { harness, save } = project(root, write);
  assert.equal((await harness.flow("root", "prepare")).architecture.status, "required");
  await assert.rejects(harness.flow("root", "advance"), /架构稿/);
  await assert.rejects(harness.flow("root", "architecture"), /须写实际内容/);
  await harness.file("root", "write", architecture, { content: plan, note: "Publish the design under the current goal" });
  await harness.flow("root", "architecture");
  const executor = (await harness.flow("root", "advance")).childId;
  await assert.rejects(harness.file(executor, "write", architecture, { content: revised, note: "Attempt an unapproved write" }), /写白名单/);
  await assert.rejects(harness.file("root", "write", architecture, { content: revised, note: "Attempt to change an active plan" }), /正在进行/);
  write(candidate, "def budget(value):\n    # Clamp before handing off to protect capacity.\n    return min(value, 5)\n");
  const prepared = await harness.flow(executor, "prepare");
  const { file, previousCases, requiredCases, protectedCases, ...challenge } = prepared.codeTask.regressionProof;
  save(file, { ...challenge, runId: "actual-candidate", cases: [...previousCases, ...requiredCases].map(id => ({ id, status: "passed" })) });
  assert.equal((await harness.flow(executor, "submit")).phase, "review-ready");
  const reviewer = (await harness.flow("root", "advance")).childId;
  assert.equal((await approve(harness, reviewer, true)).phase, "architecture-repair");
  await assert.rejects(harness.flow("root", "advance"), /阶段|架构/);
  await assert.rejects(harness.flow("root", "architecture"), /实际修改/);
  await harness.file("root", "write", architecture, { content: revised, note: "Address the located rollback finding" });
  assert.equal((await harness.flow("root", "architecture")).phase, "final-review-ready");
  const finalReviewer = (await harness.flow("root", "advance")).childId;
  assert.equal((await approve(harness, finalReviewer, false)).phase, "final-audit-ready");
  const auditor = (await harness.flow("root", "advance")).childId;
  assert.notEqual(auditor, finalReviewer);
  assert.equal((await approve(harness, auditor, false)).phase, "ledger-review");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "final.json"), "utf8"));
  assert.equal(receipt.codeReview.architecture.source.sha256, digest(revised));
  assert.equal(receipt.independentAudit.codeReview.architecture.source.sha256, digest(revised));
  write(architecture, plan);
  assert.equal((await harness.flow("root", "status")).units[0].goalStale, true);
}));

test("only the coordinator checkpoint renders the generated import section after signed source changes", () => fixture(async (root, write) => {
  const importsHeading = "静态导入";
  const { harness, save } = project(root, write, { importsHeading });
  const prose = plan + "\n## 静态导入\n\n待由宿主生成。\n";
  const readPlan = () => fs.readFileSync(path.join(root, architecture), "utf8");
  await assert.rejects(harness.file("root", "write", architecture, { content: prose.replace("待由宿主生成。", "假边"), note: "Try to replace the host section" }), /由宿主生成/);
  await harness.file("root", "write", architecture, { content: prose, note: "Supply the design sections" });
  await harness.flow("root", "architecture");
  const first = readPlan();
  assert.match(first, /"runtime\.py" -> \[\]/u);
  assert.ok(first.startsWith(plan));
  const executor = (await harness.flow("root", "advance")).childId;
  write(candidate, "from limits import MAXIMUM\n\ndef budget(value):\n    # Limit the amount handed to downstream code.\n    return min(value, MAXIMUM)\n");
  const prepared = await harness.flow(executor, "prepare");
  const { file, previousCases, requiredCases, protectedCases, ...challenge } = prepared.codeTask.regressionProof;
  save(file, { ...challenge, runId: "new-graph-candidate", cases: [...previousCases, ...requiredCases].map(id => ({ id, status: "passed" })) });
  assert.equal((await harness.flow(executor, "submit")).phase, "architecture-sync");
  assert.equal(readPlan(), first);
  await assert.rejects(harness.flow("root", "advance"), /阶段|架构/);
  assert.equal((await harness.flow("root", "architecture")).phase, "review-ready");
  assert.match(readPlan(), /"runtime\.py" -> "limits\.py"/u);
  assert.ok(readPlan().startsWith(plan));
  const reviewer = (await harness.flow("root", "advance")).childId;
  const packet = await harness.invoke(reviewer, "building_loop_code_review", { action: "prepare" });
  assert.deepEqual(packet.codeReview.imports.edges, [{ file: candidate, line: 1, imports: ["limits.py"] }]);
  write(architecture, first);
  await assert.rejects(harness.invoke(reviewer, "building_loop_code_review", { action: "prepare" }), /架构|变化/);
}));
