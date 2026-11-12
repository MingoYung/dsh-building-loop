import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { codeRegressionArtifacts, codeRegressionSigningBytes, codeTestSigningBytes, prepareCodeIntake, verifyCodeIntake } from "../governance/code-intake.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { pythonStructure } from "../governance/python-structure.mjs";
import { fixture, host } from "./helpers.mjs";

const solution = "solution.py";
const module = "parser.py";
const testArtifact = "test_parser.py";
const requirements = "SPEC.md";
const proofFile = "trusted-test-result.json";
const baselineFile = "trusted-regression-baseline.json";
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

test("new authorized code work refuses dispatch without a regression contract even when code already exists", () => fixture(async (root, write) => {
  setup(root, write);
  approve(root);
  const harness = host(root, { automaticCoverage: false });
  await assert.rejects(harness.flow("root", "advance"), /先配置 codeTask\.tests\.regression/);
  assert.equal(harness.activations.length, 0);
}));

function regressionConfig(keys) {
  return { file: proofFile, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    previousSuiteSha256: digest("previous suite"), suiteSha256: digest("complete suite for checkpoint 2"),
    requiredCases: ["new-case"], regression: { baselineFile, previousCases: ["old-pass", "old-fail"], inputs: ["settings.json"] } };
}

function signedRegression(write, file, proof, keys) {
  write(file, JSON.stringify({ ...proof, signature: sign(null, codeRegressionSigningBytes(proof), keys.privateKey).toString("base64") }));
}

function caseRows(entries) {
  return Object.entries(entries).map(([id, status]) => ({ id, status }));
}

test("dispatch checks trusted full baseline against pre-edit artifacts and keeps the passing case set across resume", () => fixture(async (root, write) => {
  const keys = generateKeyPairSync("ed25519");
  const wrong = generateKeyPairSync("ed25519");
  const tests = regressionConfig(keys);
  setup(root, write, { sources: [module], tests });
  write("settings.json", '{"behavior":"public"}');
  const harness = host(root, { automaticCoverage: false });
  await assert.rejects(harness.flow("root", "advance"), /所有者在当前会话确认开工/);
  approve(root);
  const policy = authority(root);
  const baseline = { spec: "building-loop-code-regression-baseline/1", unit: "K01", policySha256: policy.hash,
    suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, policy.units.K01), runId: "pre-edit-1",
    cases: caseRows({ "old-pass": "passed", "old-fail": "failed" }) };
  await assert.rejects(harness.flow("root", "advance"), /缺少改前回归基线签名回执/);
  signedRegression(write, baselineFile, baseline, wrong);
  await assert.rejects(harness.flow("root", "advance"), /改前回归基线签名回执.*不符/);
  signedRegression(write, baselineFile, { ...baseline, cases: baseline.cases.slice(0, 1) }, keys);
  await assert.rejects(harness.flow("root", "advance"), /改前回归基线签名回执.*不符/);
  signedRegression(write, baselineFile, baseline, keys);
  write("settings.json", '{"behavior":"changed"}');
  await assert.rejects(harness.flow("root", "advance"), /改前回归基线签名回执.*不符/);
  assert.equal(harness.activations.length, 0);
  write("settings.json", '{"behavior":"public"}');
  const { childId } = await harness.flow("root", "advance");
  assert.match(harness.prompt(childId), /改前通过的旧用例和新增必测用例/);
  const challenge = async () => (await harness.flow(childId, "prepare")).codeTask.regressionProof;
  const original = await challenge();
  assert.equal(original.file, proofFile);
  assert.deepEqual(original.protectedCases, ["old-pass"]);
  assert.deepEqual(original.artifacts.map(row => row.path), [module, "settings.json", solution, testArtifact]);
  await assert.rejects(harness.file(childId, "write", baselineFile, { content: "{}", note: "forge" }), /写白名单/);
  await assert.rejects(harness.file(childId, "read", baselineFile), /读白名单/);
  await assert.rejects(harness.file(childId, "write", proofFile, { content: "{}", note: "forge" }), /写白名单/);
  await harness.flow(childId, "block", { note: "验证接单恢复保留改前证据" });
  signedRegression(write, baselineFile, { ...baseline, cases: caseRows({ "old-pass": "failed", "old-fail": "passed" }) }, keys);
  assert.equal((await harness.flow("root", "advance")).childId, childId);
  assert.deepEqual((await challenge()).protectedCases, ["old-pass"]);
  assert.equal((await challenge()).baselineReceiptSha256, original.baselineReceiptSha256);
}));

test("regression executors must edit existing implementation against one exact preimage", () => fixture(async (root, write) => {
  const keys = generateKeyPairSync("ed25519");
  const tests = regressionConfig(keys);
  const manifest = setup(root, write, { sources: [module], tests });
  const fresh = "new_module.py";
  const empty = "empty_module.py";
  const bomOnly = "bom_module.py";
  const writeOnly = "write_only.py";
  const grant = manifest.units.K01.phases.intake;
  grant.read.push(fresh, empty, bomOnly);
  grant.write.push(fresh, empty, bomOnly, writeOnly);
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  const original = "\uFEFFdef parse(value):\r\n    return value + 1\r\n\r\nflag = False\r\n# untouched\r\n# untouched\r\n";
  write(module, original);
  write(empty, "");
  write(bomOnly, "\uFEFF");
  write(writeOnly, "keep = True\n");
  approve(root);
  const policy = authority(root);
  signedRegression(write, baselineFile, { spec: "building-loop-code-regression-baseline/1", unit: "K01", policySha256: policy.hash,
    suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, policy.units.K01), runId: "scoped-edit",
    cases: caseRows({ "old-pass": "passed", "old-fail": "failed" }) }, keys);
  const harness = host(root, { automaticCoverage: false });
  const { childId } = await harness.flow("root", "advance");
  const { sha256 } = await harness.file(childId, "read", module);
  const note = "scoped implementation";
  const head = { oldText: "def parse(value):\n    return value + 1", newText: "def parse(value):\n    return value + 2" };
  const tail = { oldText: "flag = False", newText: "flag = True" };
  const edit = args => harness.file(childId, "edit", module, { beforeSha256: sha256, note, ...args });
  const sourceOnDisk = () => fs.readFileSync(path.join(root, module), "utf8");
  const backup = path.join(root, ".building-loop", "latest_backup", module);
  await assert.rejects(harness.file(childId, "write", module, { content: "    return value + 2\n", note }), /须用 edit 局部编辑/);
  await assert.rejects(harness.file(childId, "edit", writeOnly, { ...tail, note, beforeSha256: digest("keep = True\n") }), /读白名单/);
  await assert.rejects(harness.file(childId, "edit", fresh, { ...tail, note, beforeSha256: digest("") }), /只适用于已有文件/);
  await assert.rejects(edit({ ...head, beforeSha256: digest("stale") }), /摘要不匹配/);
  await assert.rejects(edit({ oldText: "# untouched", newText: "", }), /恰好出现一次/);
  await assert.rejects(edit({ edits: [head, { oldText: "value + 1", newText: "value + 9" }] }), /不能重叠/);
  await assert.rejects(edit({ edits: [head, { oldText: "missing", newText: "extra" }] }), /第 2 项.*恰好出现一次/);
  assert.equal(sourceOnDisk(), original);
  assert.equal(fs.existsSync(backup), false);
  const changed = await edit({ edits: [tail, head] });
  const expected = original.replace("value + 1", "value + 2").replace("flag = False", "flag = True");
  assert.equal(sourceOnDisk(), expected);
  assert.equal(changed.sha256, digest(expected));
  assert.deepEqual(changed.diagnostics, { status: "skipped", reason: "check-set-not-configured" });
  assert.equal(fs.readFileSync(backup, "utf8"), original);
  await assert.rejects(edit(tail), /摘要不匹配/);
  await harness.file(childId, "write", fresh, { content: "valid = True\n", note });
  await assert.rejects(harness.file(childId, "write", fresh, { content: "valid = False\n", note }), /须用 edit 局部编辑/);
  await harness.file(childId, "edit", empty, { oldText: "", newText: "filled = True\n", beforeSha256: digest(""), note });
  assert.equal(fs.readFileSync(path.join(root, empty), "utf8"), "filled = True\n");
  const { sha256: bomSha256 } = await harness.file(childId, "read", bomOnly);
  await harness.file(childId, "edit", bomOnly, { oldText: "", newText: "filled = True\n", beforeSha256: bomSha256, note });
  assert.equal(fs.readFileSync(path.join(root, bomOnly), "utf8"), "\uFEFFfilled = True\n");
  await harness.file(childId, "write", testArtifact, { content: "assert 1\n", note });
}));

test("changed code is returned for regression or failed new requirements, and a passing receipt is pinned through review", () => fixture(async (root, write) => {
  const keys = generateKeyPairSync("ed25519");
  const tests = regressionConfig(keys);
  setup(root, write, { sources: [module], tests });
  approve(root);
  const policy = authority(root);
  signedRegression(write, baselineFile, { spec: "building-loop-code-regression-baseline/1", unit: "K01", policySha256: policy.hash,
    suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, policy.units.K01), runId: "pre-edit-2",
    cases: caseRows({ "old-pass": "passed", "old-fail": "failed" }) }, keys);
  const harness = host(root, { automaticCoverage: false });
  const { childId } = await harness.flow("root", "advance");
  const challenge = async () => (await harness.flow(childId, "prepare")).codeTask.regressionProof;
  const original = await challenge();
  const intended = { "old-pass": "passed", "old-fail": "failed", "new-case": "passed" };
  function receipt(input, statuses = intended, changes = {}) {
    const { file, previousCases, requiredCases, protectedCases, ...binding } = input;
    signedRegression(write, file, { ...binding, runId: "post-edit-2", cases: caseRows(statuses), ...changes }, keys);
  }
  await harness.file(childId, "edit", module, { beforeSha256: digest(source), oldText: "return value + 1",
    newText: "return value + 2", note: "implement new requirement" });
  await assert.rejects(harness.flow(childId, "submit"), /缺少当前交付的回归签名回执/);
  receipt(original);
  await assert.rejects(harness.flow(childId, "submit"), /当前交付的回归签名回执.*不符/);
  const changed = await challenge();
  receipt(changed, { ...intended, "old-pass": "skipped", "new-case": "failed" });
  await assert.rejects(harness.flow(childId, "submit"), /旧用例回退：old-pass \(skipped\).*新增必测用例未通过：new-case \(failed\)/);
  receipt(changed, { "old-pass": "passed", "new-case": "passed" });
  await assert.rejects(harness.flow(childId, "submit"), /当前交付的回归签名回执.*不符/);

  write(requirements, "# SPEC\nThis requirement changed since the tests ran.\n");
  receipt(changed);
  const movedGoal = await challenge();
  assert.notEqual(movedGoal.goalSha256, changed.goalSha256);
  await assert.rejects(harness.flow(childId, "submit"), /当前交付的回归签名回执.*不符/);
  receipt(movedGoal);
  assert.equal((await harness.flow(childId, "submit")).phase, "review-ready");
  write("settings.json", '{"behavior":"changed after submit"}');
  const retry = await harness.flow("root", "advance");
  assert.equal(retry.childId, childId);
  assert.equal(retry.phase, "intake");
  const retried = await challenge();
  assert.deepEqual(retried.protectedCases, movedGoal.protectedCases);
  assert.notDeepEqual(retried.artifacts, movedGoal.artifacts);
  await assert.rejects(harness.flow(childId, "submit"), /当前交付的回归签名回执.*不符/);
  receipt(retried);
  assert.equal((await harness.flow(childId, "submit")).phase, "review-ready");
  assert.equal((await harness.flow("root", "advance")).phase, "first-review");
  await assert.rejects(harness.flow("root", "advance"), /当前阶段尚未交付/);
  write(requirements, "# SPEC\nNew goal while reviewer is working.\n");
  assert.equal((await harness.flow("root", "advance")).childId, childId);
  assert.equal((await challenge()).baselineReceiptSha256, retried.baselineReceiptSha256);
}));

test("stored intake using the earlier signed-test contract remains readable", () => fixture(async (root, write) => {
  const keys = generateKeyPairSync("ed25519");
  const { regression, ...tests } = regressionConfig(keys);
  setup(root, write, { sources: [module], tests });
  const policy = authority(root), spec = policy.units.K01, goal = { sha256: digest("old goal") };
  const frame = { root, policy, started: { proposal: { id: "old-proposal" } } };
  const active = { codeIntake: { openingId: "old-proposal", nonce: "old-nonce", sources: [{ path: module, sha256: digest(source) }] } };
  const { file, requiredCases, ...binding } = prepareCodeIntake(frame, "K01", active, spec, goal).testProof;
  const proof = { ...binding, runId: "previous-host", passedCases: requiredCases };
  write(file, JSON.stringify({ ...proof, signature: sign(null, codeTestSigningBytes(proof), keys.privateKey).toString("base64") }));
  assert.equal(verifyCodeIntake(frame, "K01", active, spec, goal, () => true).kind, "trusted-tests");
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
  const regression = regressionConfig({ publicKey });
  const protectedManifest = setup(root, write, { sources: [solution], tests: regression });
  protectedManifest.units.K01.phases.supplement.read.push(baselineFile);
  write("BUILDING-LOOP.json", JSON.stringify(protectedManifest));
  assert.throws(() => authority(root), /不得进入模型授权/);
}));

/** Start through the real approval and signed baseline gate before testing edits. */
async function startDiagnosticTask(root, write, diagnostics) {
  const keys = generateKeyPairSync("ed25519");
  const tests = regressionConfig(keys);
  setup(root, write, { sources: [module], tests, diagnostics });
  write("settings.json", '{"mode":"isolated"}');
  approve(root);
  const policy = authority(root);
  signedRegression(write, baselineFile, { spec: "building-loop-code-regression-baseline/1", unit: "K01", policySha256: policy.hash,
    suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, policy.units.K01),
    runId: "diagnostics-baseline", cases: caseRows({ "old-pass": "passed", "old-fail": "failed" }) }, keys);
  const harness = host(root, { automaticCoverage: false });
  const { childId } = await harness.flow("root", "advance");
  await harness.flow(childId, "prepare");
  const edit = async (from, to) => {
    const { sha256 } = await harness.file(childId, "read", module);
    return harness.file(childId, "edit", module, {
      beforeSha256: sha256, oldText: "return value + " + from, newText: "return value + " + to, note: "try one edit",
    });
  };
  return { harness, childId, edit, policy };
}

async function withDiagnosticRunner(handler, run, timeoutMs = 2000) {
  const secret = "test-credential-for-local-test-runner";
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/check");
      assert.equal(request.headers.authorization, "Bearer " + secret);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const send = (fields, binding = {}) => response.end(JSON.stringify({
        spec: body.spec, requestId: body.requestId, snapshotSha256: body.snapshotSha256, ...fields, ...binding,
      }));
      await handler(body, send, response);
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const settings = {
    DSH_BUILDING_LOOP_DIAGNOSTICS_URL: "http://127.0.0.1:" + server.address().port + "/check",
    DSH_BUILDING_LOOP_DIAGNOSTICS_TOKEN: secret,
    DSH_BUILDING_LOOP_DIAGNOSTICS_TIMEOUT_MS: String(timeoutMs),
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    await run();
    assert.deepEqual(errors, []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test("a landed edit returns the runner's first real error directly, but cannot replace a signed proof", () => fixture(async (root, write) => {
  const requests = [];
  const firstError = { caseId: "new-case", message: "Expected value + 3, received value + 2", path: module, line: 2 };
  let task;
  await withDiagnosticRunner(async (body, send) => {
    requests.push(body);
    const { spec, requestId, snapshotSha256, changed, artifacts, ...binding } = body;
    assert.equal(spec, "building-loop/diagnostics/1");
    assert.match(requestId, /^[0-9a-f-]{36}$/u);
    assert.equal(binding.checkSet, "fixture-small");
    assert.equal(binding.unit, "K01");
    assert.equal(binding.phase, "intake");
    assert.equal(binding.policySha256, task.policy.hash);
    const versions = artifacts.map(({ path, sha256, contentBase64 }) => {
      assert.equal(digest(Buffer.from(contentBase64, "base64")), sha256);
      return { path, sha256 };
    });
    assert.deepEqual(versions, codeRegressionArtifacts(root, task.policy.units.K01));
    assert.equal(digest(JSON.stringify({ ...binding, artifacts: versions })), snapshotSha256);
    assert.equal(changed.path, module);
    // This tool also acquires the workspace lock. The HTTP request reaches the
    // runner after the edit, its history, and its state have been committed.
    assert.equal((await task.harness.file(task.childId, "read", module)).sha256, changed.sha256);
    assert.equal((await task.harness.file(task.childId, "history", module)).recent[0].includes(changed.sha256), true);
    const snapshot = Buffer.from(artifacts.find(entry => entry.path === module).contentBase64, "base64").toString("utf8");
    send(snapshot.includes("value + 3") ? { status: "passed" } : { status: "failed", firstError });
  }, async () => {
    task = await startDiagnosticTask(root, write, { checkSet: "fixture-small" });
    const bad = await task.edit(1, 2);
    assert.equal(bad.changed, true);
    assert.deepEqual(bad.diagnostics, { status: "failed", snapshotSha256: requests[0].snapshotSha256, firstError });
    const good = await task.edit(2, 3);
    assert.equal(good.changed, true);
    assert.deepEqual(good.diagnostics, { status: "passed", snapshotSha256: requests[1].snapshotSha256 });
    assert.equal((await task.edit(3, 3)).diagnostics, undefined);
    assert.equal(requests.length, 2);
    await assert.rejects(task.harness.flow(task.childId, "submit"), /缺少当前交付的回归签名回执/);
  });
}));

test("stale, malformed, out-of-scope and timed-out diagnostics preserve the edits", () => fixture(async (root, write) => {
  const holdFirst = Promise.withResolvers();
  let resumeFirst;
  await withDiagnosticRunner((body, send, response) => {
    const current = Buffer.from(body.artifacts.find(entry => entry.path === module).contentBase64, "base64").toString("utf8");
    const step = Number(/return value \+ (\d+)/u.exec(current)[1]);
    const fail = (extra = {}) => send({ status: "failed", firstError: { caseId: "new-case", message: "wrong result", ...extra } });
    if (step === 2) return send({ status: "passed" }, { requestId: "different-request" });
    if (step === 3) return fail({ path: "settings.json", line: 1 });
    if (step === 4) return response.end("{");
    if (step === 5) return; // The runner stalls until the configured timeout.
    if (step === 6) {
      resumeFirst = fail;
      holdFirst.resolve();
      return;
    }
    send({ status: "passed" });
  }, async () => {
    const { edit, harness, childId } = await startDiagnosticTask(root, write, { checkSet: "fixture-small" });
    for (const step of [2, 3, 4]) {
      const landed = await edit(step - 1, step);
      assert.equal(landed.changed, true);
      assert.deepEqual(landed.diagnostics, { status: "unavailable", reason: "invalid-runner-reply" });
    }
    const timed = await edit(4, 5);
    assert.equal(timed.changed, true);
    assert.equal(timed.diagnostics.status, "timeout");
    assert.equal((await harness.file(childId, "read", module)).sha256, timed.sha256);
    const pending = edit(5, 6);
    await Promise.race([holdFirst.promise, pending.then(() => assert.fail("first diagnosis completed before overlap"))]);
    const latest = await edit(6, 7);
    resumeFirst();
    assert.equal(latest.diagnostics.status, "passed");
    assert.deepEqual((await pending).diagnostics, { status: "superseded" });
  }, 1500);
}));
