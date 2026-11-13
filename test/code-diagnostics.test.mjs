import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { codeDiagnosticsCurrent, diagnosticRunnerConfig, prepareCodeReproduction, runCodeDiagnostics } from "../governance/code-diagnostics.mjs";
import { parseRecipeInputs, visibleRecipeInputs } from "../governance/diagnostic-recipe-inputs.mjs";
import { digest } from "../governance/policy.mjs";
import { fixture } from "./helpers.mjs";

const source = "entry.py";
const input = "schema.json";
const token = "test-token-that-must-never-appear-in-tool-output";
const invalidReply = { status: "unavailable", reason: "invalid-runner-reply" };

test("recipe shapes only constrain authorized protocols and existing review and input contract call forms", () => {
  const transport = { args: { min: 0, types: [] }, stdin: "required", files: { min: 0, max: 0 } };
  const compile = { args: { min: 1, types: ["source"] }, stdin: "forbidden", files: { min: 0, max: 0 } };
  const recipes = ["transport", "compile"];
  const parsed = parseRecipeInputs({ transport, compile }, recipes, recipes, "compile", [{ recipe: "transport" }]);
  assert.deepEqual(visibleRecipeInputs({ recipeInputs: parsed }, ["compile"]), { compile });
  assert.equal(visibleRecipeInputs({ recipeInputs: parsed }, ["unrelated"]), undefined);
  assert.equal(parseRecipeInputs(undefined), undefined);
  for (const rows of [
    { unauthorized: transport },
    { transport: { ...transport, files: { min: 0, max: 13 } } },
    { transport: { ...transport, stdin: "forbidden" } },
    { transport: { ...transport, args: { min: 1, types: ["text"] } } },
    { compile: { ...compile, args: { min: 1, types: ["text"] } } },
    { compile: { ...compile, stdin: "optional" } },
  ]) assert.throws(() => parseRecipeInputs(rows, recipes, recipes, "compile", [{ recipe: "transport" }]), /recipeInputs/u);
});

function executor(root, write) {
  write(source, "def parse(value):\n    raise ValueError(value)\n");
  write(input, "{}");
  const phase = { write: [source] };
  const unit = { candidate: source, phases: { intake: phase, supplement: phase },
    codeTask: { sources: [source], tests: { regression: { inputs: [input] }, requiredCases: ["new-A", "new-B"] },
      diagnostics: { checkSet: "small-suite", protocol: 2, recipes: ["small-case"] } } };
  const active = { actor: "executor-1", phase: "intake", serial: 1, codeIntake: {
    nonce: "baseline-nonce", regression: { cases: [{ id: "old-ok", status: "passed" }, { id: "old-bad", status: "failed" }] },
  } };
  return { role: "executor", root, reads: [source, input], assignment: ["K01", active],
    policy: { units: { K01: unit }, hash: digest("fixture-policy"), goalContext: ["overview.md"] } };
}

test("reproduction versions bind data, case lists and the authorized current snapshot", () => fixture(async (root, write) => {
  const frame = executor(root, write);
  const runner = {};
  const probe = { action: "probe", recipe: "small-case", args: ["字", "--"], files: [{ path: "数据/样例.txt", content: "输入" }] };
  const job = prepareCodeReproduction(frame, probe, runner);
  const { checkSet, unit, phase, policySha256, goalSha256, artifacts, operation, protectedCases, requiredCases } = job.request;
  const versions = artifacts.map(({ path, sha256 }) => ({ path, sha256 }));
  const fingerprint = digest(JSON.stringify({ checkSet, unit, phase, policySha256, goalSha256,
    artifacts: versions, operation, protectedCases, requiredCases, probe: job.request.probe }));
  assert.equal(job.request.snapshotSha256, fingerprint);
  assert.deepEqual(protectedCases, ["old-ok"]);
  assert.deepEqual(requiredCases, ["new-A", "new-B"]);
  assert.equal(codeDiagnosticsCurrent(frame, job), true);
  const otherInput = prepareCodeReproduction(frame, { ...probe, stdin: "another case" }, runner);
  assert.notEqual(otherInput.request.snapshotSha256, fingerprint);

  for (const update of [
    { args: ["字".repeat(171)] },
    { stdin: "\u0000" },
    { files: [{ path: "Entry.py/extra.txt", content: "shadow" }] },
    { files: [{ path: "sample.txt", content: "" }, { path: "SAMPLE.txt", content: "" }] },
    { files: [{ path: "x.txt", content: "x".repeat(9000) }, { path: "y.txt", content: "y".repeat(8000) }] },
  ]) assert.throws(() => prepareCodeReproduction(frame, { ...probe, ...update }, runner));
  const unreadable = { ...frame, reads: [source] };
  assert.deepEqual(prepareCodeReproduction(unreadable, probe, runner).result,
    { status: "unavailable", reason: "probe-artifacts-not-readable" });
  assert.equal(codeDiagnosticsCurrent(unreadable, job), false);
  assert.ok(prepareCodeReproduction(unreadable, { action: "check" }, runner).request);
  write(input, "{\"changed\":true}");
  assert.equal(codeDiagnosticsCurrent(frame, job), false);
}));

test("V2 feedback requires exact case inventory and bounded authorized frames and output", () => fixture(async (root, write) => {
  const frame = executor(root, write);
  let next;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.end(JSON.stringify({ spec: body.spec, requestId: body.requestId, snapshotSha256: body.snapshotSha256, ...next }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const runner = diagnosticRunnerConfig({ DSH_BUILDING_LOOP_DIAGNOSTICS_URL: `http://127.0.0.1:${server.address().port}/test`,
      DSH_BUILDING_LOOP_DIAGNOSTICS_TOKEN: token });
    const check = prepareCodeReproduction(frame, { action: "check" }, runner);
    const probe = prepareCodeReproduction(frame, { action: "probe", recipe: "small-case" }, runner);
    const stack = [{ path: source, line: 2, function: "parse" }];
    const old = { status: "failed", firstError: { caseId: "old-ok", message: "ValueError: old input", stack } };
    const rows = [{ caseId: "new-B", status: "failed", error: { caseId: "new-B", message: "ValueError: new input", stack } },
      { caseId: "new-A", status: "passed" }];
    next = { status: "failed", old, required: rows };
    const result = await runCodeDiagnostics(check, runner);
    assert.deepEqual(result.old, old);
    assert.deepEqual(result.required, [rows[1], rows[0]]);

    for (const invalid of [
      { required: [rows[1], rows[1]] },
      { required: [rows[0]] },
      { status: "passed" },
      { snapshotSha256: probe.request.snapshotSha256 },
      { old: { status: "failed", firstError: { ...old.firstError, caseId: "old-bad" } } },
      { old: { status: "failed", firstError: { ...old.firstError, stack: [{ path: source, line: 500 }] } } },
      { old: { status: "failed", firstError: { ...old.firstError, stack: [{ path: input, line: 1 }] } } },
    ]) {
      next = { status: "failed", old, required: rows, ...invalid };
      assert.deepEqual(await runCodeDiagnostics(check, runner), invalidReply);
    }
    for (const output of [
      { stderr: token },
      { stdout: "字".repeat(683) },
      { stdout: "x".repeat(17000) },
      { exitCode: 0 },
      { stack: Array(7).fill(stack[0]) },
    ]) {
      next = { status: "failed", probe: { exitCode: 1, ...output } };
      assert.deepEqual(await runCodeDiagnostics(probe, runner), invalidReply);
    }
    next = { status: "failed", probe: { exitCode: 1, stderr: "ValueError: local fixture", stack, truncated: false } };
    assert.deepEqual((await runCodeDiagnostics(probe, runner)).probe, next.probe);
    next = { status: "invalid-input", inputError: "files" };
    assert.equal((await runCodeDiagnostics(probe, runner)).reason, "runner-rejected-input");
    assert.deepEqual(await runCodeDiagnostics(check, runner), invalidReply);
    next = { ...next, message: "hidden payload" };
    assert.deepEqual(await runCodeDiagnostics(probe, runner), invalidReply);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}));
