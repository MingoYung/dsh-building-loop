import assert from "node:assert/strict";
import { test } from "node:test";
import { compareReviewProbe, reviewProbeId, reviewProbeRequest, reviewProbeRows, reviewReproduction,
  saveReviewProbe } from "../governance/code-review-probes.mjs";

const signedFile = "app.py";
const spec = { codeTask: { sources: [signedFile],
  diagnostics: { reviewRecipes: ["app-json", "compiler"], syntaxRecipe: "compiler" } } };
const architecture = { file: "architecture.md", examples: { start: 13, end: 23, cases: [
  { id: "budget", recipe: "app-json", stdin: '{"budget":3}', expectedExitCode: 0, expectedJson: { status: "ok" } },
] } };
const fixture = () => ({
  frame: { agent: { id: "first-reviewer" }, reads: [signedFile, architecture.file], changed: false },
  active: { serial: 4, codeIntake: { qualification: { artifacts: [{ path: signedFile, sha256: "signed" }] } } },
});
const result = (exitCode, stdout, rest = {}) => ({ status: exitCode === 0 ? "passed" : "failed",
  snapshotSha256: "runner-pin", probe: { exitCode, stdout, ...rest } });

test("review probe only selects registered recipes and uses exact architecture inputs", () => {
  const { frame, active } = fixture();
  const prepare = args => reviewProbeRequest(args, frame, active, spec, architecture);
  const check = prepare({ assertion: "architecture", exampleId: "budget" });
  assert.deepEqual(check.input, { recipe: "app-json", stdin: '{"budget":3}' });
  assert.deepEqual(check.expected, { exitCode: 0, json: { status: "ok" } });
  assert.throws(() => prepare({ assertion: "architecture", exampleId: "budget", stdin: "substitute" }), /已登记的架构稿/);
  assert.throws(() => prepare({ assertion: "runtime", recipe: "compiler", file: signedFile, expectedExitCode: 1 }), /未获授权/);
  assert.throws(() => prepare({ assertion: "syntax", file: "unrelated.py" }), /当前签名/);
  assert.deepEqual(prepare({ assertion: "syntax", file: signedFile }).input, { recipe: "compiler", args: [signedFile] });
});

test("compiler confirmation disproves false syntax findings and unavailable output proves neither result", () => {
  const { frame, active } = fixture();
  const check = reviewProbeRequest({ assertion: "syntax", file: signedFile }, frame, active, spec, architecture);
  const id = reviewProbeId("signed-v1", check);
  const claim = { type: "syntax", file: signedFile, start: 3, end: 4 };
  assert.equal(compareReviewProbe(check, result(1, "runner failure")).outcome, "unavailable");
  assert.equal(compareReviewProbe(check, result(1, '{"status":"syntax-error","line":3}', { truncated: true })).outcome, "unavailable");
  assert.equal(saveReviewProbe(frame, active, "signed-v1", id, check, result(0, '{"status":"parsed"}')).outcome, "match");
  assert.throws(() => reviewReproduction(frame, active, "signed-v1", id, claim), /符合预期/);
  const other = reviewProbeId("signed-v2", check);
  saveReviewProbe(frame, active, "signed-v2", other, check, result(1, '{"status":"syntax-error","line":3}'));
  assert.equal(reviewReproduction(frame, active, "signed-v2", other, claim).actual.line, 3);
  assert.throws(() => reviewReproduction(frame, active, "signed-v2", other, { ...claim, start: 4 }), /实际出错行/);
  assert.deepEqual(reviewProbeRows({ ...frame, agent: { id: "independent-auditor" } }, active, "signed-v2"), []);
  assert.deepEqual(reviewProbeRows(frame, { ...active, serial: 5 }, "signed-v2"), []);
  assert.deepEqual(reviewProbeRows(frame, active, "signed-v1"), []);
});

test("a failing architecture example pins input and result without exposing candidate output in the receipt", () => {
  const { frame, active } = fixture();
  const check = reviewProbeRequest({ assertion: "architecture", exampleId: "budget" }, frame, active, spec, architecture);
  const id = reviewProbeId("signed", check);
  const output = { status: "error", error: "budget-exceeded" };
  const toolResult = saveReviewProbe(frame, active, "signed", id, check, result(0, JSON.stringify(output)));
  assert.deepEqual(toolResult.actual.json, output);
  const proof = reviewReproduction(frame, active, "signed", id, { type: "architecture", file: architecture.file, start: 14, end: 16 });
  assert.equal(proof.outcome, "mismatch");
  assert.equal(proof.actual.jsonSha256.length, 64);
  assert.equal(proof.actual.json, undefined);
  assert.throws(() => reviewReproduction(frame, active, "signed", id, { type: "architecture", file: architecture.file, start: 25, end: 25 }), /已登记示例/);
});

test("exploratory probe quota cannot consume mandatory registered example slots", () => {
  const { frame, active } = fixture();
  const makeCheck = stdin => reviewProbeRequest({ assertion: "runtime", file: signedFile, recipe: "app-json", stdin,
    expectedExitCode: 0 }, frame, active, spec, architecture);
  const save = check => saveReviewProbe(frame, active, "current", reviewProbeId("current", check), check, result(0, "{}"));
  for (let n = 0; n < 16; n++) assert.equal(save(makeCheck(String(n))).outcome, "match");
  assert.throws(() => save(makeCheck("17")), /16 次探索复现/);
  const registered = reviewProbeRequest({ assertion: "architecture", exampleId: "budget" }, frame, active, spec, architecture);
  assert.equal(save(registered).outcome, "mismatch");
  assert.equal(reviewProbeRows(frame, active, "current").length, 17);
});

test("a registered reviewer example binds exact input, owner clause, response and execution status", () => {
  const { frame, active } = fixture();
  const requirement = { file: "SPEC.md", start: 8, end: 8,
    quote: "When the key is list, output field `order` equals [\"a\",\"b\"]." };
  const expected = { order: ["a", "b"], count: 2 };
  const input = { key: "list", data: ["b", "a"] };
  const withCases = { codeTask: { ...spec.codeTask, diagnostics: { ...spec.codeTask.diagnostics,
    inputContracts: [{ id: "sort", recipe: "app-json", examples: [
      { id: "ordered", input, expectedJson: expected, requirement },
    ] }],
  } } };
  const args = { assertion: "runtime", file: signedFile, exampleId: "sort:example:ordered" };
  const prepare = (data = {}, clause = { ...requirement, visibleClause: true }) =>
    reviewProbeRequest({ ...args, ...data }, frame, active, withCases, architecture, clause);
  const check = prepare();
  assert.deepEqual(check.input, { recipe: "app-json", stdin: JSON.stringify(input) + "\n" });
  assert.deepEqual(check.expected, { exitCode: 0, json: expected });
  assert.deepEqual(check.grounding, { kind: "registered-example", version: 2, caseId: args.exampleId, exit: true, field: true });
  assert.throws(() => prepare({ stdin: "{}" }), /固定的配方和输入/u);
  assert.throws(() => prepare({ expectedJson: "0", expectedPointer: "/requestIndex" }), /已登记示例不一致/u);
  assert.equal(prepare({}, { ...requirement, quote: "A different clause" }).grounding, undefined);
  const sameInput = prepare({ exampleId: undefined, recipe: "app-json", expectedExitCode: 0,
    expectedPointer: "/order", expectedJson: '["a","b"]', stdin: '{"data":["b","a"], "key":"list"}' });
  assert.deepEqual(sameInput.input, check.input);
  assert.equal(sameInput.grounding.kind, "registered-example");
  const otherInput = prepare({ exampleId: undefined, recipe: "app-json", expectedExitCode: 0,
    expectedPointer: "/count", expectedJson: "0", stdin: JSON.stringify(input) });
  assert.equal(otherInput.grounding, undefined);
  const otherBranch = prepare({ exampleId: undefined, recipe: "app-json", expectedExitCode: 0,
    expectedPointer: "/order", expectedJson: '["a","b"]', stdin: '{"key":"count","data":["b","a"]}' });
  assert.equal(otherBranch.grounding, undefined);
  const otherBranchProbe = saveReviewProbe(frame, active, "current", reviewProbeId("current", otherBranch), otherBranch,
    result(0, '{"order":["b","a"]}'));
  assert.equal(otherBranchProbe.outcome, "mismatch");
  assert.equal(otherBranchProbe.blocking, false);

  const proofId = reviewProbeId("current", check);
  const location = { type: "runtime", file: signedFile, start: 2, end: 3 };
  const match = saveReviewProbe(frame, active, "current", proofId, check, result(0, JSON.stringify(expected)));
  assert.equal(match.outcome, "match");
  assert.throws(() => reviewReproduction(frame, active, "current", proofId, location), /符合预期/u);
  assert.equal(compareReviewProbe(check, { status: "timeout" }).outcome, "unavailable");
  assert.equal(compareReviewProbe(check, { status: "execution-timeout" }).outcome, "unavailable");
  assert.equal(compareReviewProbe(prepare({}, { ...requirement, start: 9, end: 9 }),
    { status: "execution-timeout", snapshotSha256: "runner-pin" }).outcome, "unavailable");
  const timed = saveReviewProbe(frame, active, "current", proofId, check,
    { status: "execution-timeout", snapshotSha256: "runner-pin" });
  assert.equal(timed.blocking, true);
  assert.equal(reviewReproduction(frame, active, "current", proofId, location).summary.actual, "运行器确认执行超时");
});

test("output clauses reject branch alternatives, examples and negated assertions as proof", () => {
  const { frame, active } = fixture();
  const prepare = quote => reviewProbeRequest({ assertion: "runtime", file: signedFile, recipe: "app-json",
    expectedExitCode: 0, expectedPointer: "/size", expectedJson: "5" }, frame, active, spec, architecture, { quote, clauseComplete: true });
  for (const quote of [
    "Output field `size` equals 5 or 7.",
    "For branch A output field `size` equals 5. For branch B output field `size` equals 7.",
    "The implementation must not return `{\"size\":5}`.",
    "For example, it returns `{\"size\":5}`.",
    "Input field `size` equals 5. The command prints one result.",
    "The command takes `{\"size\":5}` and returns a record.",
    "When the input contains no entries, output field `size` equals 5.",
    "Output field `size` equals 5 provided that the input is empty.",
    "当输入为空时，输出字段 `size` 等于 5。",
    "输入为空时输出 `{\"size\":5}`。",
    "如果输入为空，返回 `{\"size\":5}`。",
  ]) {
    const check = prepare(quote);
    assert.equal(check.grounding, undefined, quote);
    const probe = saveReviewProbe(frame, active, "current", reviewProbeId("current", check), check, result(0, '{"size":7}'));
    assert.equal(probe.outcome, "mismatch");
    assert.equal(probe.blocking, false, quote);
  }
  assert.deepEqual(prepare("The command returns `{\"size\":5}`.").grounding,
    { kind: "clause", version: 2, field: true, exit: false });
});
