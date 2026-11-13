import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { inspectArchitectureProse } from "../governance/engineering-architecture.mjs";
import { authority, digest, parseAuthority } from "../governance/policy.mjs";
import { pythonImportEvidence } from "../governance/python-dependencies.mjs";
import { fixture, host } from "./helpers.mjs";

const candidate = "runtime.py";
const goal = "GOAL.md";
const architecture = "modules/architecture.md";
const headings = ["职责", "回退"];
const template = "# 架构\n\n## 职责\n\n待填写。\n\n## 回退\n\n待填写。\n";
const plan = "# 架构\n\n## 职责\n\n入口限制请求预算。\n\n## 回退\n\n回退入口到原算法并验证旧预算。\n";
const revised = plan.replace("验证旧预算", "重放已发请求并验证旧预算");
const ref = (file, start, end = start) => ({ file, start, end });

function project(root, write, { importsHeading, examplesHeading, diagnostics } = {}) {
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
    units: { K01: { candidate, plainLast: false, architecture: {
      module: "architecture", headings: [...headings, ...(examplesHeading ? [examplesHeading] : [])], importsHeading, examplesHeading,
    },
      codeTask: { sources, tests, diagnostics }, phases: { intake: execute, supplement: execute,
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

test("the host preloads architecture sources and both reviewers decide only the compact section rows", () => fixture(async (root, write) => {
  const { harness, save } = project(root, write);
  await harness.file("root", "write", architecture, { content: plan, note: "Record the design for this goal" });
  await harness.flow("root", "architecture");
  const executor = (await harness.flow("root", "advance")).childId;
  const updated = "def budget(value):\n    # Clamp before handing off to protect capacity.\n    return min(value, 5)\n";
  write(candidate, updated);
  const { codeTask } = await harness.flow(executor, "prepare");
  const { file, previousCases, requiredCases, protectedCases, ...challenge } = codeTask.regressionProof;
  save(file, { ...challenge, runId: "compact-candidate", cases: [...previousCases, ...requiredCases].map(id => ({ id, status: "passed" })) });
  assert.equal((await harness.flow(executor, "submit")).phase, "review-ready");
  const action = (actor, name, fields) => harness.invoke(actor, "building_loop_code_review", { action: name, ...fields });
  const judge = async (actor, basis, leaveGap = false) => {
    const { codeReview: packet } = await action(actor, "prepare");
    const alias = name => packet.refs.find(row => row.file === name).prefix;
    const rows = [
      { id: "file:1", status: "verified", basis: "The nearby comment explains the capacity bound." },
      { id: "test:1", status: "pass", basis: "The clamp implements the stated limit.",
        refs: [alias(goal) + ":3", alias(candidate) + ":3"] },
      { id: "section:1", status: "pass", basis, refs: [alias(candidate) + ":3"] },
      { id: "section:2", status: "pass", basis: "The current budget obligation remains explicit.",
        refs: [alias(goal) + ":3"] },
    ];
    assert.deepEqual(packet.pending.filter(row => row.kind === "section").map(({ id, heading, file }) => ({ id, heading, file })), [
      { id: "section:1", heading: "职责", file: architecture }, { id: "section:2", heading: "回退", file: architecture },
    ]);
    const result = await action(actor, "record", { decisions: leaveGap ? rows.slice(0, 3) : rows, findingsDone: true });
    assert.deepEqual(result.errors, []);
    if (leaveGap) {
      const incomplete = await action(actor, "submit");
      assert.equal(incomplete.status, "needs-review");
      assert.deepEqual(incomplete.next.pending.map(row => row.id), ["section:2"]);
      assert.equal((await action(actor, "record", { decisions: rows.slice(3) })).progress.ready, true);
    } else assert.equal(result.progress.ready, true);
    return action(actor, "submit");
  };
  const reviewer = (await harness.flow("root", "advance")).childId;
  assert.equal((await judge(reviewer, "The first reviewer grounds ownership in the actual clamp.", true)).phase, "first-audit-ready");
  const auditor = (await harness.flow("root", "advance")).childId;
  assert.notEqual(auditor, reviewer);
  assert.equal((await judge(auditor, "The independent auditor located the decision in the actual module.")).phase, "ledger-review");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  for (const proof of [receipt.codeReview, receipt.independentAudit.codeReview]) {
    assert.equal(proof.architecture.status, "pass");
    assert.equal(proof.architecture.source.sha256, digest(plan));
    assert.equal(proof.architecture.sections[0].evidence[0].sha256, digest(updated));
    assert.equal(proof.architecture.sections[0].status, "pass");
  }
}));

test("architecture planning shows source metadata without granting reads and rejects a definite false absence", () => fixture(async (root, write) => {
  const importsHeading = "静态导入";
  const { harness } = project(root, write, { importsHeading });
  write(candidate, "from limits import MAXIMUM\n\ndef budget(value):\n    return min(value, MAXIMUM)\n");
  const prepare = async () => (await harness.flow("root", "prepare")).architecture.sourceFacts;
  assert.deepEqual(await prepare(), {
    modules: [{ file: candidate, presence: "present" }, { file: "limits.py", presence: "present" }],
    directLocalImports: [{ file: candidate, imports: ["limits.py"] }, { file: "limits.py", imports: [] }],
  });
  await assert.rejects(harness.file("root", "read", candidate), /读白名单/u);
  await assert.rejects(harness.file("root", "read", "limits.py"), /读白名单/u);
  const block = "\n## " + importsHeading + "\n\n待由宿主生成。\n";
  const wrong = plan.replace("入口限制请求预算。", "工作区当前只有 GOAL.md，没有 `runtime.py`、limits 的源码。");
  await harness.file("root", "write", architecture, { content: wrong + block, note: "Capture a false present-state claim" });
  await assert.rejects(harness.flow("root", "architecture"), /第 5 行.*runtime\.py、limits\.py/u);
  const precise = plan.replace("入口限制请求预算。", "若未来没有 `runtime.py` 的源码，则使用只读规格恢复。");
  await harness.file("root", "write", architecture, { content: precise + block, note: "Replace with a conditional recovery note" });
  assert.equal((await harness.flow("root", "architecture")).phase, "dispatch");
  fs.unlinkSync(path.join(root, "limits.py"));
  assert.deepEqual(await prepare(), {
    modules: [{ file: candidate, presence: "present" }, { file: "limits.py", presence: "missing" }],
  });
}));

test("labeled import clauses distinguish direct imports from continued design prose", () => {
  const graph = {
    checkedFiles: ["start.py", "middle.py", "end.py", "side.py"],
    edges: [{ file: "start.py", line: 1, imports: ["middle.py"] }, { file: "middle.py", line: 1, imports: ["end.py"] }],
    calls: [], uncertainCalls: [],
  };
  const notes = [
    "导入方向固定为：`start.py` → `middle.py` / `end.py`；`middle.py` → `end.py`。",
    "",
    "导入方向固定：`start.py` → `middle.py` / `side.py`，后三者之间只允许现有依赖，不得反向。",
    "",
    "导入方向：`start.py` → `middle.py`；计划由 `middle.py` → `side.py`。",
    "",
    "实施顺序：`start.py` → `end.py`。",
  ].join("\n");
  assert.deepEqual(inspectArchitectureProse(notes, graph).map(({ line, from, to }) => ({ line, from, to })), [
    { line: 1, from: "start.py", to: "end.py" }, { line: 3, from: "start.py", to: "side.py" },
  ]);
});

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
      violation: { type: "architecture", expected: "The rollback procedure checks a replayed request against the reverted entrypoint.",
        actual: "The rollback procedure only checks the original budget." },
      evidence: [{ ...ref(architecture, 9), relation: "supports" }, { ...ref(goal, 3), relation: "supports" }] }] } : {}) });
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

test("the signed checkpoint sends a wrong direct-call claim back to the coordinator with actual source lines", () => fixture(async (root, write) => {
  const { harness, save } = project(root, write, { importsHeading: "静态导入" });
  const inaccurate = plan.replace("入口限制请求预算。", "- `runtime.py`（入口）：只做传输，调用 `limits.py` 处理额度。");
  const initial = inaccurate + "\n## 静态导入\n\n待由宿主生成。\n";
  const readPlan = () => fs.readFileSync(path.join(root, architecture), "utf8");
  await harness.file("root", "write", architecture, { content: initial, note: "Register the planned module boundary" });
  await harness.flow("root", "architecture");
  const executor = (await harness.flow("root", "advance")).childId;
  write(candidate, "from limits import MAXIMUM\n\ndef budget(value):\n    # Clamp before passing a request downstream.\n    return min(value, MAXIMUM)\n");
  const { codeTask } = await harness.flow(executor, "prepare");
  const { file, previousCases, requiredCases, protectedCases, ...challenge } = codeTask.regressionProof;
  save(file, { ...challenge, runId: "actual-candidate", cases: [...previousCases, ...requiredCases].map(id => ({ id, status: "passed" })) });
  assert.equal((await harness.flow(executor, "submit")).phase, "architecture-sync");
  const status = (await harness.flow("root", "prepare")).architecture;
  assert.equal(status.status, "sync");
  assert.deepEqual(status.conflicts, ["架构稿第 5 行称 runtime.py 直接调用 limits.py，当前签名源码没有可定位的本地直接调用。请按实际路径改写，间接关系写清中间模块。"]);
  await assert.rejects(harness.flow("root", "architecture"), /架构稿第 5 行.*直接调用 limits\.py/u);
  const corrected = readPlan().replace("调用 `limits.py` 处理额度", "从 `limits.py` 导入预算常量并约束额度");
  await harness.file("root", "write", architecture, { content: corrected, note: "Document the source-confirmed import instead of a call" });
  assert.equal((await harness.flow("root", "architecture")).phase, "review-ready");
  assert.match(readPlan(), /"runtime\.py" -> "limits\.py"/u);
  const reviewer = (await harness.flow("root", "advance")).childId;
  assert.equal((await harness.invoke(reviewer, "building_loop_code_review", { action: "prepare" })).phase, "first-review");
}));

test("Python call facts distinguish aliases from imports, conditional bindings, and uncertain shadowing", () => fixture(async (root, write) => {
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(pkg);
  const files = ["pkg/entry.py", "pkg/journal.py", "pkg/limits.py", "pkg/planner.py", "pkg/shadowed.py", "pkg/parameter.py",
    "pkg/dynamic.py", "pkg/nested.py", "pkg/nonlocal.py", "pkg/conditional.py"];
  const entry = ["from . import planner as p", "from .journal import filter_rows as clean", "from .limits import MAX",
    "p.run()", "clean()", "print(MAX)"].join("\n");
  const source = {
    "pkg/entry.py": entry,
    "pkg/journal.py": "def filter_rows(): return []\n",
    "pkg/limits.py": "MAX = 7\n",
    "pkg/planner.py": "from . import limits\ndef run(): return limits.MAX\n",
    "pkg/shadowed.py": "from .planner import run as work\nwork = lambda: False\nwork()\n",
    "pkg/parameter.py": "from .planner import run as work\ndef invoke(work): return work()\n",
    "pkg/dynamic.py": "import importlib\nimportlib.import_module('pkg.planner').run()\n",
    "pkg/nested.py": "from .planner import run as work\ndef run():\n    from pathlib import Path as work\n    return work()\n",
    "pkg/nonlocal.py": "from .planner import run as work\ndef outer():\n    work = lambda: False\n    def inner():\n        nonlocal work\n        return work()\n    return inner()\n",
    "pkg/conditional.py": "if SELECT_LOCAL:\n    from .planner import run as work\nwork()\n",
  };
  for (const file of files) write(file, source[file]);
  const graph = pythonImportEvidence({ root, reads: files }, files.map(file => ({ path: file, sha256: digest(source[file]) })));
  assert.deepEqual(graph.calls, [{ file: "pkg/entry.py", line: 4, target: "pkg/planner.py", symbol: "run" },
    { file: "pkg/entry.py", line: 5, target: "pkg/journal.py", symbol: "filter_rows" }]);
  assert.deepEqual(graph.uncertainCalls, [{ file: "pkg/shadowed.py", targets: ["pkg/planner.py"] },
    { file: "pkg/parameter.py", targets: ["pkg/planner.py"] }, { file: "pkg/dynamic.py" },
    ...["pkg/nested.py", "pkg/nonlocal.py", "pkg/conditional.py"].map(file => ({ file, targets: ["pkg/planner.py"] }))]);
  const note = [
    "# 模块",
    "- `pkg/entry.py`（入口）：直接导入 `pkg/limits.py`。",
    "- `pkg/journal.py`：直接导入 `pkg/planner.py`。",
    "- `pkg/journal.py`：计划调用 `pkg/planner.py`。",
    "- `pkg/journal.py`：不调用 `pkg/planner.py`。",
    "- `pkg/journal.py`：通过另一模块调用 `pkg/planner.py`。",
    "- `pkg/shadowed.py`：调用 `pkg/planner.py`。",
    "- `pkg/parameter.py`：调用 `pkg/planner.py`。",
    "- `pkg/dynamic.py`：调用 `pkg/planner.py`。",
    "",
    "> `pkg/journal.py`：直接导入 `pkg/planner.py`。",
    "",
    "~~~text",
    "`pkg/journal.py`：直接导入 `pkg/planner.py`。",
    "~~~",
  ].join("\n");
  assert.deepEqual(inspectArchitectureProse(note, graph),
    [{ line: 3, from: "pkg/journal.py", to: "pkg/planner.py", relation: "import", actual: [] }]);
}));

test("architecture checks explicit import chains without interpreting unlabeled workflow arrows", () => fixture(async (root, write) => {
  const sources = {
    "main.py": "from engine import run\nrun()\n",
    "engine.py": "from policy import LIMIT\ndef run(): return LIMIT\n",
    "policy.py": "LIMIT = 7\n",
    "a/shared.py": "X = 1\n",
    "b/shared.py": "X = 2\n",
  };
  for (const dir of ["a", "b"]) fs.mkdirSync(path.join(root, dir));
  for (const [file, content] of Object.entries(sources)) write(file, content);
  const reads = Object.keys(sources);
  const graph = pythonImportEvidence({ root, reads }, reads.map(file => ({ path: file, sha256: digest(sources[file]) })));
  const note = ["# Modules", "", "导入方向固定：`main.py` → `policy.py` → `engine.py`。另有实施顺序。",
    "Import direction: `main.py` -> `engine.py` -> `policy.py`.",
    "实施顺序：`policy.py` → `engine.py` → `main.py`。",
    "`main.py` → `policy.py` → `engine.py`。",
    "未来导入方向：`main.py` → `policy.py`。",
    "静态导入关系：`main.py` → `shared.py` → `engine.py`。",
    "导入方向：`main.py` → `outside.py`。",
    "导入方向：`main.py` → policy/engine；其余文字。",
    "导入方向固定：`main.py -> engine.py -> (policy.py)`，叶子不再导入。",
    "导入方向：main → (policy, engine)。",
    "导入方向：main → `a/shared.py`。",
    "导入方向：main → (shared, engine)。",
    "导入方向：main → policy.unknown。",
    "导入方向：main → policy/engine → main。",
    "", "> Import direction: `main.py` -> `policy.py`.", "", "~~~text",
    "导入方向固定：`main.py` → `policy.py`。", "~~~"].join("\n");
  assert.deepEqual(inspectArchitectureProse(note, graph), [
    { line: 3, from: "main.py", to: "policy.py", relation: "import", actual: [{ file: "engine.py", line: 1 }] },
    { line: 3, from: "policy.py", to: "engine.py", relation: "import", actual: [] },
    { line: 10, from: "main.py", to: "policy.py", relation: "import", actual: [{ file: "engine.py", line: 1 }] },
    { line: 12, from: "main.py", to: "policy.py", relation: "import", actual: [{ file: "engine.py", line: 1 }] },
    { line: 13, from: "main.py", to: "a/shared.py", relation: "import", actual: [{ file: "engine.py", line: 1 }] },
  ]);
}));

test("architecture locates grouped guards, a literal rejection decision, and a wrongly delegated JSON decoder", () => fixture(async (root, write) => {
  const sources = {
    "entry.py": "import json as codec\nfrom calculation import compute\ndef main(stream):\n    request = codec.load(stream)\n    return compute(request)\n",
    "calculation.py": "from rules import limit\ndef fail(code): return {'error': code}\ndef compute(request):\n    allowed = limit(request)\n    if 10 > allowed: return fail('over-quota')\n    if not isinstance(request, dict): return fail('bad-root')\n    return allowed\n",
    "data.py": "def normalize(request): return request['items']\n",
    "rules.py": "def limit(request):\n    quantity = request.get('quantity')\n    owner = request.get('owner')\n    if not isinstance(owner, str) or owner not in allowed[quantity]:\n        raise ValueError('invalid-owner')\n    if not isinstance(quantity, int):\n        raise ValueError('invalid-quantity')\n    kind = request.get('kind')\n    if kind not in ('small', 'large'):\n        raise ValueError('invalid-kind')\n    return quantity\n",
  };
  for (const [file, content] of Object.entries(sources)) write(file, content);
  const reads = Object.keys(sources);
  const graph = pythonImportEvidence({ root, reads }, reads.map(file => ({ path: file, sha256: digest(sources[file]) })),
    { responsibilities: true });
  const note = ["# Modules", "", "- `entry.py`：读取原始文本，交付给 data 解析。",
    "- `data.py`：字段校验（`quantity`/`owner`/`items` 各自类型面）。",
    "- `rules.py`：做 `over-quota` 判定。",
    "- `data.py`：无需校验（`quantity`/`owner`）。",
    "- `entry.py`：JSON 解析后交给 data 解析业务字段。",
    "- `rules.py`：通过 calculation 做 `over-quota` 判定。",
    "- `rules.py`：准备做 `over-quota` 判定并迁移至下一版本。",
    "- `rules.py`：检查（`quantity`/`owner`）。",
    "- `rules.py`：对照额度给出 `over-quota`。",
    "- `data.py`：校验输入结构（`bad-root`）与子字段。",
    "- `calculation.py`：校验输入结构（`bad-root`）。",
    "- `entry.py`：下游校验失败时返回 `bad-root`，原样序列化。",
    "- `data.py`：将来校验输入结构（`bad-root`）。",
    "- `rules.py`：预算超出时不返回 `over-quota`。",
    "- `rules.py`：支持文档列举错误码 `over-quota`。",
    "- `entry.py`：读取原始文本 → `json.loads`。",
    "- `entry.py`：读取原始文本 → `json.load`。",
    "- `entry.py`：将来拟用 `json.loads`。",
    "- `entry.py`：调用 `json.loads` 或 `json.load`。",
    "- `data.py`：归档并校验种类是否属于 `small`/`large`（`invalid-kind`）。",
    "- `rules.py`：对请求判定有效额度（超出→`over-quota`）。",
    "- `data.py`：委托规则模块校验种类是否属于 `small`/`large`（`invalid-kind`）。",
    "- `data.py`：检查种类是否属于 `small`/`large`（`maybe-invalid-kind`）。",
    "- `calculation.py`：对请求判定有效额度（超出→`over-quota`）。",
  ].join("\n");
  const problems = inspectArchitectureProse(note, graph);
  assert.deepEqual(problems.map(({ line, from, relation, field, code, to, symbol }) => [line, from, relation, field ?? code ?? to ?? symbol]), [
    [3, "entry.py", "json-decoding", "data.py"], [4, "data.py", "validation", "quantity"],
    [4, "data.py", "validation", "owner"], [5, "rules.py", "decision", "over-quota"],
    [11, "rules.py", "decision", "over-quota"], [12, "data.py", "decision", "bad-root"],
    [18, "entry.py", "json-decoder-call", "json.loads"],
    [22, "data.py", "decision", "invalid-kind"], [23, "rules.py", "decision", "over-quota"],
  ]);
  assert.ok(problems[2].actual.some(row => row.file === "rules.py" && row.line === 5 && row.code === "invalid-owner"));
  assert.deepEqual(problems[3].actual, [{ file: "calculation.py", line: 5, symbol: "compute", code: "over-quota" }]);
  write("entry.py", sources["entry.py"].replace("request = codec.load(stream)", "codec = stream\n    request = codec.load(stream)"));
  const rebound = pythonImportEvidence({ root, reads }, reads.map(file => ({ path: file,
    sha256: digest(fs.readFileSync(path.join(root, file))) })), { responsibilities: true });
  assert.deepEqual(inspectArchitectureProse(note, rebound).map(row => row.relation),
    ["validation", "validation", "decision", "decision", "decision", "decision", "decision"]);
  write("entry.py", "import json as other\n" + sources["entry.py"].replace("return compute(request)", "return other.loads(stream) if stream else compute(request)"));
  const both = pythonImportEvidence({ root, reads }, reads.map(file => ({ path: file,
    sha256: digest(fs.readFileSync(path.join(root, file))) })), { responsibilities: true });
  assert.equal(inspectArchitectureProse(note, both).some(row => row.relation === "json-decoder-call"), false);
  write("entry.py", "import json as other\n" + sources["entry.py"].replace("return compute(request)", "return compute(other)"));
  const escaped = pythonImportEvidence({ root, reads }, reads.map(file => ({ path: file,
    sha256: digest(fs.readFileSync(path.join(root, file))) })), { responsibilities: true });
  assert.equal(inspectArchitectureProse(note, escaped).some(row => row.relation === "json-decoder-call"), false);
}));

test("architecture attributes definite guards and definitions without accusing delegation or unknown ownership", () => fixture(async (root, write) => {
  const sources = {
    "processor.py": "from rules import quota as get_quota\n\ndef run(request):\n    return get_quota(request)\n",
    "rules.py": "def quota(request):\n    count = request.get('amount')\n    if type(count) is not int:\n        raise ValueError('invalid-amount')\n    if request['currency'] not in ('USD', 'EUR'):\n        return {'error': 'invalid-currency'}\n    return count\n",
    "uncertain.py": "from rules import quota\n\ndef run(quota, request):\n    return quota(request)\n",
    "also.py": "from rules import quota\n\ndef run(request):\n    if request['amount'] == 0:\n        return {'allowed': False}\n    return quota(request)\n",
    "parameter.py": "from rules import quota\n\ndef run(request, amount):\n    if type(amount) is not int:\n        raise ValueError('invalid-amount')\n    return quota(request)\n",
  };
  for (const [file, content] of Object.entries(sources)) write(file, content);
  const reads = Object.keys(sources);
  const graph = pythonImportEvidence({ root, reads }, reads.map(file => ({ path: file, sha256: digest(sources[file]) })),
    { responsibilities: true });
  const note = ["# Modules", "", "- `processor.py`: validates `amount` (otherwise `invalid-amount`).",
    "- `processor.py`：实现 `quota()`。", "- `rules.py`：校验 `amount`（不合规时报 `invalid-amount`）。",
    "- `processor.py`：委托规则模块校验 `amount`（错误 `invalid-amount`）。",
    "- `processor.py`：校验 `currency`（`invalid-currency`）。",
    "- `processor.py`：校验 `amount`（例如 `unknown-range`）。",
    "- `processor.py`：将来校验 `amount`（错误 `invalid-amount`）。",
    "- `processor.py`：读取 `amount` 后交给下游。",
    "- `uncertain.py`：校验 `amount`（错误 `invalid-amount`）。",
    "- `also.py`：校验 `amount`（错误 `invalid-amount`）。",
    "- `parameter.py`：校验 `amount`（错误 `invalid-amount`）。",
    "- `processor.py`：负责校验 `amount`（错误 `invalid-amount`），改为由规则层处理。",
    "- `processor.py`：实现 `quota` 是后续方案。",
    "- `processor.py`: validates `amount` (formerly `invalid-amount`).",
    "", "> `processor.py`：校验 `amount`（错误 `invalid-amount`）。", ""].join("\n");
  assert.deepEqual(inspectArchitectureProse(note, graph), [
    { line: 3, from: "processor.py", relation: "validation", field: "amount", actual: [
      { file: "rules.py", symbol: "quota", field: "amount", line: 4, code: "invalid-amount" }] },
    { line: 4, from: "processor.py", relation: "definition", symbol: "quota", actual: [
      { file: "rules.py", symbol: "quota", line: 1 }] },
    { line: 7, from: "processor.py", relation: "validation", field: "currency", actual: [
      { file: "rules.py", symbol: "quota", field: "currency", line: 6, code: "invalid-currency" }] },
  ]);
}));

test("architecture registration pins one bounded fence of explicitly granted examples", () => fixture(async (root, write) => {
  const examplesHeading = "可执行验证";
  const diagnostics = { checkSet: "smoke", protocol: 2, recipes: ["entry", "compile", "writer-only"],
    reviewRecipes: ["entry", "compile"], syntaxRecipe: "compile" };
  const { harness } = project(root, write, { examplesHeading, diagnostics });
  assert.deepEqual(authority(root).units.K01.codeTask.diagnostics, diagnostics);
  assert.equal((await harness.flow("root", "prepare")).architecture.examplesHeading, examplesHeading);
  const spec = JSON.parse(fs.readFileSync(path.join(root, "BUILDING-LOOP.json"), "utf8"));
  const check = changed => {
    const edited = structuredClone(spec);
    changed(edited.units.K01);
    return () => parseAuthority(Buffer.from(JSON.stringify(edited)));
  };
  assert.throws(check(unit => { unit.architecture.examplesHeading = "未登记章节"; }), /架构示例/u);
  assert.throws(check(unit => { unit.codeTask.diagnostics.reviewRecipes = ["unknown"]; }), /代码核验配方/u);
  assert.throws(check(unit => { unit.codeTask.diagnostics.reviewRecipes = ["entry", "entry"]; }), /代码核验配方/u);
  assert.throws(check(unit => { unit.codeTask.diagnostics.syntaxRecipe = "writer-only"; }), /语法配方/u);
  assert.throws(check(unit => { unit.codeTask.diagnostics.reviewRecipes = ["compile"]; }), /架构示例/u);

  const example = { id: "budget-small", recipe: "entry", stdin: "  4  \n", expectedExitCode: 0, expectedJson: { units: 4 } };
  const section = body => plan + "\n## " + examplesHeading + "\n\n" + body;
  const fence = rows => "~~~json\n" + JSON.stringify(rows) + "\n~~~\n";
  const setPlan = content => harness.file("root", "write", architecture, { content, note: "Publish executable examples" });
  for (const [content, error] of [
    [section("待补充。\n"), /一个 json 围栏/u],
    [section(fence([example]) + "\n额外说明。\n"), /一个 json 围栏/u],
    [section(fence([example]).replace(/~~~\n$/u, "")), /完整闭合/u],
    [section(fence([example, example])), /唯一 ID/u],
    [section(fence([{ ...example, args: ["--help"] }])), /未登记字段/u],
    [section(fence([{ ...example, recipe: "writer-only" }])), /未授权/u],
    [section(fence([{ ...example, recipe: "compile" }])), /未授权/u],
    [section(fence([{ ...example, stdin: "x".repeat(8193) }])), /8 KiB/u],
  ]) {
    await setPlan(content);
    await assert.rejects(harness.flow("root", "architecture"), error);
  }
  const content = section(fence([example])).replaceAll("\n", "\r\n");
  await setPlan(content);
  const result = await harness.flow("root", "architecture");
  const start = content.split("\r\n").indexOf("~~~json") + 1;
  assert.equal(result.architecture.sha256, digest(content));
  assert.deepEqual(result.architecture.examples, { heading: examplesHeading, start, end: start + 2, cases: [example] });
  assert.equal((await harness.flow("root", "prepare")).architecture.status, "registered");
  await setPlan(section(fence([{ ...example, stdin: " 4  \n" }])));
  assert.equal((await harness.flow("root", "prepare")).architecture.status, "required");
  assert.notEqual((await harness.flow("root", "architecture")).architecture.contentsSha256, result.architecture.contentsSha256);
}));

test("a signed architecture mismatch blocks approval, then both roles verify the corrected example independently", () => fixture(async (root, write) => {
  const token = "only-test-engineering-diagnostics-token-1234";
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.headers.authorization, "Bearer " + token);
    calls.push(input);
    const stdout = input.probe.recipe === "compile" ? '{"status":"parsed"}' : '{"units":5}';
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
    const examplesHeading = "可执行验证";
    const diagnostics = { checkSet: "smoke", protocol: 2, recipes: ["entry", "compile"], reviewRecipes: ["entry", "compile"], syntaxRecipe: "compile" };
    const { harness, save } = project(root, write, { examplesHeading, diagnostics });
    const publish = async units => {
      const body = JSON.stringify([{ id: "budget", recipe: "entry", stdin: '{"units":8}', expectedExitCode: 0, expectedJson: { units } }]);
      await harness.file("root", "write", architecture, { content: plan + "\n## " + examplesHeading + "\n\n~~~json\n" + body + "\n~~~\n",
        note: "Set the executable budget example expectation" });
      return (await harness.flow("root", "architecture")).architecture.examples;
    };
    let examples = await publish(8);
    const executor = (await harness.flow("root", "advance")).childId;
    write(candidate, "def budget(value):\n    # Clamp before handing off to protect capacity.\n    return min(value, 5)\n");
    const { codeTask } = await harness.flow(executor, "prepare");
    const { file, previousCases, requiredCases, protectedCases, ...challenge } = codeTask.regressionProof;
    save(file, { ...challenge, runId: "actual-candidate", cases: [...previousCases, ...requiredCases].map(id => ({ id, status: "passed" })) });
    assert.equal((await harness.flow(executor, "submit")).phase, "review-ready");
    const action = (actor, name, fields) => harness.invoke(actor, "building_loop_code_review", { action: name, ...fields });
    const probe = async actor => (await action(actor, "probe", { assertion: "architecture" })).examples[0];
    async function prepare(actor) {
      const packet = await action(actor, "prepare");
      assert.deepEqual(packet.codeReview.progress.architectureExamples.missing, ["budget"]);
      assert.deepEqual(packet.codeReview.architectureProbe, { tool: "building_loop_code_review", action: "probe", assertion: "architecture" });
      assert.match(packet.codeReview.next, /^先调用 building_loop_code_review \{action:'probe',assertion:'architecture'\}/u);
      const note = await harness.file(actor, "read", architecture);
      await harness.file(actor, "read", candidate);
      return note.totalLines;
    }
    async function record(actor, end, failed) {
      const architectureFinding = failed ? {
        id: "budget-example", kind: "architecture", ...ref(architecture, examples.start, examples.end),
        observation: "The configured example reproduced an output of five units.",
        issue: "The architecture advertises eight units for a capped request.",
        fix: "Use the observed limit of five units as the expected output.",
        violation: { type: "architecture", expected: "Five units after the cap.", actual: "Example advertises eight units.", reproduction: failed.id },
        evidence: [{ ...ref(architecture, examples.start, examples.end), relation: "reproduces" }],
      } : null;
      return action(actor, "record", { files: [fileJudgment], constraints: [constraint], findingsDone: true,
        ...(failed ? { findings: [architectureFinding] } : {}),
        architecture: { source: ref(architecture, 1, end), status: failed ? "revise" : "pass", basis: "Compare the plan and the current cap.",
          sections: ["职责", "回退", examplesHeading].map(heading => ({ heading, basis: "The cap is defined in the current implementation.",
            evidence: [{ ...ref(candidate, 3), relation: "supports" }] })) } });
    }
    const reviewer = (await harness.flow("root", "advance")).childId;
    const end = await prepare(reviewer);
    assert.equal((await record(reviewer, end)).progress.ready, false);
    const pending = await action(reviewer, "submit");
    assert.equal(pending.status, "needs-review");
    assert.match(pending.message, /待复现架构示例 budget.*\{action:'probe',assertion:'architecture'\}/u);
    const syntax = await action(reviewer, "probe", { assertion: "syntax", file: candidate });
    assert.equal(syntax.outcome, "match");
    const incorrect = await probe(reviewer);
    assert.equal(incorrect.outcome, "mismatch");
    assert.deepEqual((await action(reviewer, "probe", { assertion: "architecture" })).examples.map(({ id, outcome }) => ({ id, outcome })),
      [{ id: incorrect.id, outcome: "mismatch" }]);
    assert.equal((await action(reviewer, "prepare")).codeReview.architectureProbe, undefined);
    assert.equal((await record(reviewer, end, incorrect)).progress.ready, true);
    assert.equal((await action(reviewer, "submit")).phase, "architecture-repair");
    examples = await publish(5);
    const finalReviewer = (await harness.flow("root", "advance")).childId;
    const finalEnd = await prepare(finalReviewer);
    assert.equal((await probe(finalReviewer)).outcome, "match");
    assert.equal((await record(finalReviewer, finalEnd)).progress.ready, true);
    assert.equal((await action(finalReviewer, "submit")).phase, "final-audit-ready");
    const auditor = (await harness.flow("root", "advance")).childId;
    assert.notEqual(auditor, finalReviewer);
    const auditEnd = await prepare(auditor);
    assert.equal((await probe(auditor)).outcome, "match");
    assert.equal((await record(auditor, auditEnd)).progress.ready, true);
    assert.equal((await action(auditor, "submit")).phase, "ledger-review");
    assert.deepEqual(calls.map(({ probe }) => probe.recipe), ["compile", "entry", "entry", "entry"]);
    assert.ok(calls.every(({ artifacts }) => artifacts[0].sha256 === digest(fs.readFileSync(path.join(root, candidate)))));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}));
