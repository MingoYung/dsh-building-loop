import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { inputContractBatchCurrent, prepareInputContractBatch, runInputContractBatch } from "../governance/code-diagnostics.mjs";
import { inputContractCases, parseInputContracts } from "../governance/input-contracts.mjs";
import { digest } from "../governance/policy.mjs";
import { fixture } from "./helpers.mjs";

const recipe = "request-json";
const control = { ok: true };
const invalid = { ok: false, error: "shape" };
const contract = { id: "request-shapes", recipe, seed: { entries: [{ labels: ["sample"] }], count: 4 }, expectedJson: control,
  checks: [{ path: ["entries", 0, "labels"], invalid: ["object", "null", "boolean", "number", "string", "missing"], expectedJson: invalid },
    { path: [], invalid: ["array"], expectedJson: invalid }] };

test("typed abnormal cases expand from one valid control and reject unsafe contracts", () => {
  const parsed = parseInputContracts([contract], [recipe, "compile"], "compile");
  const cases = inputContractCases(parsed);
  assert.deepEqual(cases.map(row => row.id), ["request-shapes:seed", "request-shapes:1:object", "request-shapes:1:null",
    "request-shapes:1:boolean", "request-shapes:1:number", "request-shapes:1:string", "request-shapes:1:missing", "request-shapes:2:array"]);
  assert.deepEqual(JSON.parse(cases[1].input.stdin), { entries: [{ labels: {} }], count: 4 });
  assert.deepEqual(JSON.parse(cases[6].input.stdin), { entries: [{}], count: 4 });
  assert.deepEqual(JSON.parse(cases[7].input.stdin), []);
  assert.deepEqual(contract.seed.entries[0].labels, ["sample"]);
  assert.throws(() => parseInputContracts([{ ...contract, recipe: "compile" }], [recipe, "compile"], "compile"));
  for (const [path, types] of [[["entries", "0", "labels"], ["object"]], [["entries", 0, "labels"], ["array"]],
    [["entries", 0], ["missing"]], [[], ["missing"]], [["__proto__"], ["null"]], [["count"], ["null", "null"]]]) {
    assert.throws(() => parseInputContracts([{ ...contract, checks: [{ path, invalid: types, expectedJson: invalid }] }], [recipe]));
  }
  assert.throws(() => parseInputContracts([contract, contract], [recipe]), /异常输入/u);
  const distinct = [1, 2, 3, 4].map(index => ({ ...contract, id: "contract-" + index }));
  assert.throws(() => parseInputContracts(distinct, [recipe]), /24/u);
});

test("registered input probes compare exact outputs, report real differences and cannot qualify stale bytes", () => fixture(async (root, write) => {
  const source = "gateway.py";
  write(source, "def read_request(value):\n    return value\n");
  write("goal.md", "Validate gateway request shapes.\n");
  const phase = { write: [source] };
  const spec = { candidate: source, phases: { intake: phase, supplement: phase }, codeTask: { sources: [source],
    tests: { regression: { inputs: [] }, requiredCases: ["new"] },
    diagnostics: { checkSet: "request-test", protocol: 2, recipes: [recipe], inputContracts: [contract] } } };
  const active = { actor: "executor-1", phase: "intake", serial: 1,
    codeIntake: { nonce: "test-nonce", regression: { cases: [{ id: "old", status: "passed" }] } } };
  const frame = { root, role: "executor", reads: [source], assignment: ["K01", active],
    policy: { units: { K01: spec }, hash: digest("test-policy"), goalContext: ["goal.md"] } };
  const observed = [];
  let defect = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { spec, requestId, snapshotSha256, probe, artifacts } = JSON.parse(Buffer.concat(chunks));
    observed.push({ probe, artifacts });
    const input = JSON.parse(probe.stdin);
    const labels = Array.isArray(input.entries) ? input.entries[0]?.labels : undefined;
    const exitCode = labels === null && defect ? 1 : 0;
    const stdout = JSON.stringify(Array.isArray(labels) ? control : invalid);
    res.end(JSON.stringify({ spec, requestId, snapshotSha256, status: exitCode ? "failed" : "passed", probe: {
      exitCode, stdout, ...(exitCode ? { stack: [{ path: source, line: 2, function: "read_request" }] } : {}),
    } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const runner = { url: new URL(`http://127.0.0.1:${server.address().port}/input`), timeoutMs: 3000, token: "local-only-reproduction-token-123456" };
    const batch = prepareInputContractBatch(frame, spec, runner);
    assert.equal(inputContractBatchCurrent(frame, batch), true);
    const failed = await runInputContractBatch(batch, runner);
    assert.equal(failed.status, "failed");
    assert.equal(failed.passed, 7);
    assert.deepEqual(failed.failures[0], { id: "request-shapes:1:null", shape: { path: ["entries", 0, "labels"], type: "null" },
      outcome: "mismatch", actual: { exitCode: 1 }, stdin: '{"entries":[{"labels":null}],"count":4}\n',
      expected: { exitCode: 0, json: invalid }, stack: [{ path: source, line: 2, function: "read_request" }] });
    assert.equal(observed.length, 8);
    assert.ok(observed.every(row => row.artifacts[0].sha256 === observed[0].artifacts[0].sha256));
    write(source, "def read_request(value):\n    return {} if value is None else value\n");
    defect = false;
    assert.equal(inputContractBatchCurrent(frame, batch), false);
    const corrected = prepareInputContractBatch(frame, spec, runner);
    const passed = await runInputContractBatch(corrected, runner);
    assert.equal(passed.status, "passed");
    assert.equal(passed.receipts.length, 8);
    assert.equal(inputContractBatchCurrent(frame, corrected), true);
    active.serial++;
    assert.equal(inputContractBatchCurrent(frame, corrected), false);
    const unavailable = await runInputContractBatch(prepareInputContractBatch(frame, spec, { reason: "runner-not-configured" }), runner);
    assert.equal(unavailable.status, "unavailable");
    assert.ok(unavailable.failures.every(row => row.reason === "runner-not-configured"));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}));
