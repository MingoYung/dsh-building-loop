import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { codeTestSigningBytes } from "../governance/code-intake.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { pythonStructure } from "../governance/python-structure.mjs";
import { fixture, host } from "./helpers.mjs";

const solution = "solution.py";
const module = "parser.py";
const testArtifact = "test_parser.py";
const requirements = "SPEC.md";
const proofFile = "trusted-test-result.json";
const source = "def parse(value):\n    return value + 1\n";

function setup(root, write, codeTask) {
  const unit = { candidate: solution, phases: {
    intake: { read: [solution, module, testArtifact], write: [solution, module, testArtifact] },
    "first-review": { read: [solution], receipt: "first.json" },
    supplement: { read: [solution], write: [solution] },
    "final-review": { read: [solution], receipt: "final.json" },
  }, ...(codeTask ? { codeTask } : {}) };
  const manifest = { spec: "building-loop/1", coordinator: { read: ["overview.md", requirements] },
    goalContext: ["overview.md", requirements], units: { K01: unit } };
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  write(solution, "from parser import parse\n\nprint(parse(5))\n");
  write(module, source);
  write(testArtifact, "assert True\n");
  write(requirements, "# SPEC\nThe next checkpoint requires adding two to the input.\n");
  return manifest;
}

function approve(root) {
  const home = process.env.DSH_HOME;
  const current = latestConversationUser([{ type: "user/message", seq: 12, data: { source: { kind: "user" },
    content: [{ type: "text", text: "开始建设：按 SPEC 完成下一项功能要求" }] } }]);
  const { proposal } = proposeConversationTask(home, "root", current,
    { goal: "完成下一阶段", deliverable: "可执行实现和真实验证", scope: "SPEC 及现有授权文件" });
  decideConversationStart(home, "root", current, proposal.id, "start", () => ({ kind: "workspace", root }), { typed: true });
}

test("Python structure ignores comments, layout, simple quote style, and docstrings while preserving semantics", () => {
  const parse = value => pythonStructure(Buffer.from(value))?.sha256;
  const original = 'from math import floor, ceil\n\ndef f(a):\n    """old docs"""\n    return [a + 1000, "literal"]\n';
  const formatted = 'from math import (floor, ceil,)\r\n# comment\r\n\r\ndef f(a,):\r\n  "new docs"\r\n  return ([a + 1_000, \'literal\',]) # comment\r\n';
  assert.equal(parse(original), parse(formatted));
  assert.notEqual(parse(original), parse(formatted.replace("1_000", "1_001")));
  assert.notEqual(parse(original), parse(formatted.replace("literal", "different literal")));
  assert.notEqual(parse("if x:\n  y()\nz()\n"), parse("if x:\n  y()\n  z()\n"));
  assert.equal(parse("x=1;y=2\n"), parse("x = 1\ny = 2\n"));
  assert.notEqual(parse('x=f"{do_one()}" "tail"\n'), parse('x=f"{do_two()}" "tail"\n'));
  assert.notEqual(parse('f"{do_one()}" "tail"\n'), parse('f"{do_two()}" "tail"\n'));
  assert.notEqual(parse('x=f"before:{value}!"\n'), parse('x=f"before:{value}?"\n'));
  assert.equal(parse('x=f"before:{value}!"\n'), parse('x = "before:" f\'{ value }\' "!"\n'));
  assert.equal(pythonStructure(Buffer.from("def f(:\n  return 1\n")), null);
});

test("approved writable Python intake requires a functional edit even if comments, formatting or tests changed", () => fixture(async (root, write) => {
  setup(root, write);
  approve(root);
  const harness = host(root, { automaticCoverage: false });
  const { childId } = await harness.flow("root", "advance");
  assert.match(harness.prompt(childId), /接单执行已确认的代码任务/);
  assert.deepEqual((await harness.flow(childId, "prepare")).codeTask.sources.map(entry => entry.path), [solution, module]);
  await assert.rejects(harness.flow(childId, "submit"), /未发现实现结构变更/);
  await harness.file(childId, "write", module, { content: "# note\n\ndef parse(value,):\n  return (value+1) # comment\n", note: "format" });
  await harness.file(childId, "write", testArtifact, { content: "assert 1 + 1 == 2\n", note: "add test" });
  await harness.flow(childId, "prepare");
  await assert.rejects(harness.flow(childId, "submit"), /注释、排版和测试文件/);
  await harness.flow(childId, "block", { note: "暂停以验证接单基线" });
  assert.equal((await harness.flow("root", "advance")).childId, childId);
  const resumed = await harness.flow(childId, "prepare");
  assert.equal(resumed.codeTask.sources.find(entry => entry.path === module).baselineSha256, digest(source));
  await harness.file(childId, "write", module, { content: "def parse(value):\n    return value + 2\n", note: "implement required increment" });
  await assert.rejects(harness.flow(childId, "submit"), /完整读回已修改的实现文件/);
  await harness.file(childId, "read", module);
  assert.equal((await harness.flow(childId, "submit")).phase, "review-ready");
}));

test("same bytes need an authentic current passing receipt with every owner-pinned case", () => fixture(async (root, write) => {
  const keys = generateKeyPairSync("ed25519");
  const wrong = generateKeyPairSync("ed25519");
  const tests = { file: proofFile, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    previousSuiteSha256: digest("previous checkpoint suite"), suiteSha256: digest("checkpoint test suite"),
    requiredCases: ["new-case-a", "new-case-b"] };
  setup(root, write, { sources: [module], tests });
  const harness = host(root, { automaticCoverage: false });
  await assert.rejects(harness.flow("root", "advance"), /所有者在当前会话确认开工/);
  approve(root);
  const { childId } = await harness.flow("root", "advance");
  const challenge = async () => (await harness.flow(childId, "prepare")).codeTask.testProof;
  const original = await challenge();
  assert.equal(original.file, proofFile);
  assert.deepEqual(original.artifacts.map(row => row.path), [module, solution, testArtifact]);
  await assert.rejects(harness.flow(childId, "submit"), /未发现.*受信测试回执/);
  await assert.rejects(harness.file(childId, "write", proofFile, { content: "{}", note: "forge" }), /写白名单/);
  await assert.rejects(harness.file(childId, "read", proofFile), /读白名单/);

  function receipt(input, changes = {}, key = keys.privateKey) {
    const { file, requiredCases, ...binding } = input;
    const proof = { ...binding, runId: "native-checkpoint-2", passedCases: requiredCases, ...changes };
    write(file, JSON.stringify({ ...proof, signature: sign(null, codeTestSigningBytes(proof), key).toString("base64") }));
  }
  for (const change of [{ passedCases: ["new-case-a"] }, { suiteSha256: digest("swapped tests") },
    { previousSuiteSha256: digest("another previous suite") },
    { nonce: "old-assignment" }, { goalSha256: digest("stale target") }]) {
    receipt(original, change);
    await assert.rejects(harness.flow(childId, "submit"), /受信测试回执不符/);
  }
  receipt(original, {}, wrong.privateKey);
  await assert.rejects(harness.flow(childId, "submit"), /受信测试回执不符/);

  receipt(original);
  write(requirements, "# SPEC\nThis requirement changed since the tests ran.\n");
  const movedGoal = await challenge();
  assert.notEqual(movedGoal.goalSha256, original.goalSha256);
  await assert.rejects(harness.flow(childId, "submit"), /受信测试回执不符/);
  receipt(movedGoal);
  await harness.file(childId, "write", testArtifact, { content: "assert False\n", note: "adversarial changed artifact" });
  const changedArtifact = await challenge();
  await assert.rejects(harness.flow(childId, "submit"), /受信测试回执不符/);
  assert.notDeepEqual(movedGoal.artifacts, changedArtifact.artifacts);
  await harness.file(childId, "write", testArtifact, { content: "assert True\n", note: "restore tested bytes" });
  await challenge();
  receipt(movedGoal);
  assert.equal((await harness.flow(childId, "submit")).phase, "review-ready");
}));

test("code task paths cannot authorize tests as implementation or allow model access to the trusted receipt", () => fixture(async (root, write) => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const tests = { file: proofFile, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    previousSuiteSha256: digest("previous suite"), suiteSha256: digest("suite"), requiredCases: ["new-case"] };
  setup(root, write, { sources: [testArtifact], tests });
  assert.throws(() => authority(root), /不能用测试或文档/);
  setup(root, write, { sources: [solution], tests: { ...tests, previousSuiteSha256: tests.suiteSha256 } });
  assert.throws(() => authority(root), /不同的新旧测试套件/);
  const manifest = setup(root, write, { sources: [solution], tests });
  manifest.units.K01.phases.intake.write.push(proofFile);
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  assert.throws(() => authority(root), /不得进入模型授权/);
  manifest.units.K01.phases.intake.write.pop();
  manifest.units.K01.phases["first-review"].read.push(proofFile);
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  assert.throws(() => authority(root), /不得进入模型授权/);
}));
