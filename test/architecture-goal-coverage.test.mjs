import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { existingConversationProject, initializeConversationProject } from "../governance/conversation-project.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { engineeringArchitectureCurrent, engineeringArchitectureStatus,
  registerEngineeringArchitecture } from "../governance/engineering-architecture.mjs";
import { authority, digest, parseAuthority } from "../governance/policy.mjs";
import { fixture, host } from "./helpers.mjs";

const goal = "PROJECT-GOAL.md", change = "CHANGE.md", architecture = "modules/architecture.md";
const source = "entry.py";
const windows = "停用窗口由 windows 判定。";
const transfer = "转移预约时，ledger 先核对修订号。";
const windowId = "public-change:example:closed-window";
const transferId = "public-change:example:transfer";
const windowLink = `[${windowId}](../CHANGE.md#L3)`;
const transferLink = `[${transferId}](../CHANGE.md#L5)`;
const initial = "# 架构\n\n## 实施顺序\n\n处理预约和释放。\n\n## 关键验证\n\n验证预约与释放。\n\n" +
  "## 保留兼容\n\n按原样转发 JSON 结果。\n\n## 回退顺序\n\n按依赖顺序恢复。\n";
const current = initial.replace("处理预约和释放。", `将停用窗口交给 windows ${windowLink}。`)
  .replace("验证预约与释放。", `验证修订错误先于停用冲突 ${transferLink}。`);

function setup(root, write) {
  fs.mkdirSync(path.join(root, "modules"));
  write(goal, "# 当前目标\n\n按 CHANGE.md 增加停用窗口及转移。\n\n## 分块入口\n\n[索引](INDEX.md)\n");
  write("INDEX.md", "# 索引\n\n## 模块\n\n[架构](modules/architecture.md)\n");
  write(change, `# 本轮变更\n\n${windows}\n\n${transfer}\n`);
  write(source, "def main(request):\n    return request\n");
  write(architecture, initial);
  const execute = { read: [source, architecture], write: [source] };
  const review = receipt => ({ read: [source, architecture], receipt });
  const example = (id, start, quote) => ({ id, input: { operation: id }, expectedJson: { status: "ok" },
    requirement: { file: change, start, end: start, quote } });
  const { publicKey } = generateKeyPairSync("ed25519");
  const manifest = { spec: "building-loop/1", goalContext: [goal, change], hierarchy: {
    overview: { path: goal, heading: "分块入口" }, index: { path: "INDEX.md", heading: "模块" }, modules: { architecture },
  }, coordinator: { read: [goal, change, "INDEX.md", architecture], write: [architecture] }, units: { K02: {
    candidate: source, plainLast: false, architecture: { module: "architecture",
      headings: ["实施顺序", "关键验证", "保留兼容", "回退顺序"],
      goalCoverage: [{ heading: "实施顺序", examples: [windowId] }, { heading: "关键验证", examples: [transferId] }],
    }, codeTask: { sources: [source], tests: { file: "current-test.json",
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      previousSuiteSha256: digest("old"), suiteSha256: digest("new"), requiredCases: ["window"],
      regression: { baselineFile: "before-test.json", previousCases: ["old"] },
    }, diagnostics: { checkSet: "current", protocol: 2, recipes: ["entry"], reviewRecipes: ["entry"],
      inputContracts: [{ id: "public-change", recipe: "entry", examples: [
        example("closed-window", 3, windows), example("transfer", 5, transfer),
      ] }],
    } }, phases: { intake: execute, supplement: execute, "first-review": review("first.json"), "final-review": review("final.json") },
  } } };
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  const policy = authority(root), spec = policy.units.K02;
  const frame = { root, policy, role: "coordinator", agent: { id: "owner" }, writes: policy.coordinator.write, state: { units: {} } };
  const inspect = () => engineeringArchitectureStatus(frame, "K02");
  const register = () => registerEngineeringArchitecture(frame, "K02", spec, "test");
  return { frame, spec, manifest, inspect, register };
}

test("owner change cases must be cited by authored prose in each selected heading, including on a fresh continuation", () =>
  fixture(async (root, write) => {
    const { frame, spec, inspect, register } = setup(root, write);
    const missing = inspect();
    assert.equal(missing.status, "goal-coverage-required");
    assert.deepEqual(missing.goalCoverage.issues.map(({ heading, start, end, exampleId, reason, reference }) =>
      ({ heading, start, end, exampleId, reason, reference })), [
      { heading: "实施顺序", start: 3, end: 6, exampleId: windowId, reason: "missing-reference", reference: windowLink },
      { heading: "关键验证", start: 7, end: 10, exampleId: transferId, reason: "missing-reference", reference: transferLink },
    ]);
    assert.deepEqual(register().goalCoverage, missing.goalCoverage);
    assert.equal(frame.state.engineeringArchitecture, undefined);

    // A correction in one section and a copied citation in rollback cannot cover the other section.
    write(architecture, initial.replace("处理预约和释放。", `交给 windows ${windowLink}。`)
      .replace("按依赖顺序恢复。", `按依赖顺序恢复并重放 ${transferLink}。`));
    assert.deepEqual(register().goalCoverage.issues.map(({ heading }) => heading), ["关键验证"]);

    for (const substitute of [`验证修订 ${transferLink.replace("#L5", "#L3")}。`, `> 验证修订 ${transferLink}。`,
      `\`验证修订 ${transferLink}\``, `<!-- 验证修订 ${transferLink}。 -->`, transferLink, `**${transferLink}**`,
      `![说明](icon.png) ${transferLink}`]) {
      write(architecture, current.replace(`验证修订错误先于停用冲突 ${transferLink}。`, substitute + "\n\n保留原有验证。"));
      assert.equal(register().goalCoverage.issues[0].reason, "missing-reference", substitute);
    }

    write(architecture, current);
    const { architecture: snapshot } = register();
    assert.equal(inspect().status, "registered");
    assert.deepEqual(snapshot.goalCoverage.pins.map(({ exampleId, clause }) => [exampleId, clause.file, clause.start]),
      [[windowId, change, 3], [transferId, change, 5]]);
    assert.equal(engineeringArchitectureCurrent(frame, spec, snapshot, undefined, false), true);
    assert.ok(current.includes("## 保留兼容\n\n按原样转发 JSON 结果。"));

    write(change, `# 本轮变更\n\n${windows}\n\n> ${transfer}\n`);
    assert.equal(engineeringArchitectureCurrent(frame, spec, snapshot, undefined, false), false);
    assert.equal(register().goalCoverage.issues[0].reason, "stale-owner-clause");
  }));

test("goal coverage can use only owner public examples in distinct authored sections", () => fixture(async (root, write) => {
  const { manifest } = setup(root, write);
  const config = manifest.units.K02.architecture;
  const parse = () => parseAuthority(Buffer.from(JSON.stringify(manifest)));
  config.goalCoverage[0].examples.push("public-change:seed");
  assert.throws(parse, /架构目标覆盖/u);
  config.goalCoverage[0].examples.pop();
  config.goalCoverage[1].heading = config.goalCoverage[0].heading;
  assert.throws(parse, /架构目标覆盖/u);
  config.goalCoverage[1].heading = "关键验证";
  config.examplesHeading = "关键验证";
  assert.throws(parse, /架构目标覆盖/u);
  delete config.examplesHeading;
  delete config.goalCoverage;
  assert.equal(parse().units.K02.architecture.goalCoverage, undefined);
}));

for (const confirmed of [true, false]) test(`root prepare and registration expose a scoped repair (confirmed=${confirmed})`,
  () => fixture(async (root, write) => {
  setup(root, write);
  if (confirmed) {
    const instruction = "开始建设：增加停用窗口与预约转移。工作单元 K02。";
    const owner = latestConversationUser([{ type: "user/message", seq: 12, data: { source: { kind: "user" },
      content: [{ type: "text", text: instruction }] } }]);
    const { proposal } = proposeConversationTask(process.env.DSH_HOME, "root", owner,
      { goal: "停用窗口与预约转移", deliverable: "架构和可验证代码", scope: "当前项目" });
    decideConversationStart(process.env.DSH_HOME, "root", owner, proposal.id, "start",
      task => initializeConversationProject(process.env.DSH_HOME, "root", root, task), {
        typed: true, inspect: task => existingConversationProject(process.env.DSH_HOME, "root", root, task),
      });
  }
  const harness = host(root, { automaticCoverage: false });
  const flow = action => harness.flow("root", action, { unit: "K02" });
  const { architecture: prepared } = await flow("prepare");
  assert.equal(prepared.status, "goal-coverage-required");
  assert.deepEqual(prepared.next, { tool: "building_loop_file", action: "edit", path: architecture,
    headings: ["实施顺序", "关键验证"], required: ["heading", "beforeSha256", "note", "newText"],
    then: { tool: "building_loop", action: "architecture", unit: "K02" } });
  const rejected = await flow("architecture");
  assert.equal(rejected.status, prepared.status);
  assert.deepEqual(rejected.next, prepared.next);
  assert.equal(harness.activations.length, 0);

  const edit = (heading, newText) => harness.file("root", "edit", architecture, { heading,
    beforeSha256: digest(fs.readFileSync(path.join(root, architecture))), note: "更新本轮业主条款对应章节", newText });
  const first = await edit("实施顺序", `将停用窗口交给 windows ${windowLink}。`);
  assert.deepEqual(first.architecture.next.headings, ["关键验证"]);
  await edit("关键验证", `验证修订错误先于停用冲突 ${transferLink}。`);
  assert.equal((await flow("architecture")).architecture.goalCoverage.pins.length, 2);
  assert.equal((await flow("prepare")).architecture.status, "registered");
}));
