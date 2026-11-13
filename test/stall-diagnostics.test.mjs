import assert from "node:assert/strict";
import { test } from "node:test";
import { compareReviewProbe } from "../governance/code-review-probes.mjs";
import { digest } from "../governance/policy.mjs";
import {
  createStallReproductionProof, observeExecutionDiagnostic, requireStallReproductionProof, requireStallTriage,
  stallArtifactSha256, stallDiagnosticSummary,
} from "../governance/stall-diagnostics.mjs";

const versions = [
  { path: "parser.py", sha256: digest("original parser"), contentBase64: "private" },
  { path: "helper.py", sha256: digest("original helper") },
  { path: "generated.py", sha256: null },
];
const changed = versions.map(row => row.path === "parser.py" ? { ...row, sha256: digest("repair") } : row);
const snapshotSha256 = digest("runner snapshot");

function observe(active, index, result, options) {
  return observeExecutionDiagnostic(active, { requestId: "request-" + index, result, artifacts: versions, ...options });
}

function suiteFailure(message, caseId = "required-1") {
  return { status: "failed", snapshotSha256, old: { status: "passed" },
    required: [{ caseId, status: "failed", error: { caseId, message } }] };
}

test("immutable artifact version and distinct attempts gate repeated syntax classification", () => {
  const active = {};
  assert.equal(stallArtifactSha256(versions), stallArtifactSha256(versions.toReversed().map(({ path, sha256 }) => ({ path, sha256 }))));
  assert.notEqual(stallArtifactSha256(versions), stallArtifactSha256(changed));
  assert.equal(stallArtifactSha256([{ path: "parser.py", sha256: "bad" }]), undefined);
  const failure = suiteFailure("SyntaxError: private exact error (detected at line 97)");
  assert.equal(observe(active, 1, failure, { fallbackPath: "helper.py" }), undefined);
  assert.equal(observe(active, 1, failure), undefined);
  assert.equal(observe(active, 2, failure, { fallbackPath: "parser.py" }), undefined);
  const record = observe(active, 3, failure);
  assert.equal(record.status, "needs-triage");
  assert.equal(record.suggestedLayer, "syntax");
  assert.equal(record.repeatCount, 3);
  assert.equal(record.trigger, "repeated-failure");
  assert.equal(record.caseId, "required-1");
  assert.equal(observe(active, 4, { status: "passed" }), undefined);
  assert.equal(active.stallDiagnostic, record);
  assert.throws(() => requireStallTriage(active, "unknown"), /哪一层/u);
  assert.equal(requireStallTriage(active, "syntax"), record);
  const summary = stallDiagnosticSummary(active);
  assert.equal(summary.artifactSha256, stallArtifactSha256(versions));
  assert.equal(summary.caseId, undefined);
  assert.doesNotMatch(JSON.stringify(active), /private exact error/u);
});

test("new bytes, a full passing check, distinct case IDs and stale results do not accumulate a false stall", () => {
  const active = {};
  const failure = suiteFailure("result differed");
  observe(active, 1, failure);
  observe(active, 2, failure);
  assert.equal(observe(active, 3, failure, { artifacts: changed }), undefined);
  assert.equal(observe(active, 4, { status: "passed" }, { artifacts: changed }), undefined);
  assert.equal(observe(active, 5, failure, { artifacts: changed }), undefined);
  assert.equal(observe(active, 6, suiteFailure("result differed", "required-2"), { artifacts: changed }), undefined);
  assert.equal(observe(active, "other-error", suiteFailure("operation timed out"), { artifacts: changed }), undefined);
  for (const status of ["superseded", "cancelled", "skipped"]) {
    assert.equal(observe(active, status, { status }, { artifacts: changed }), undefined);
  }
  assert.equal(observe(active, 7, failure, { artifacts: changed }), undefined);
  assert.equal(observe(active, 8, failure, { artifacts: changed }).repeatCount, 3);
  active.stallDiagnostic.status = "resolved";
  assert.equal(observe(active, 9, failure, { artifacts: changed }), undefined);
  assert.equal(active.stallDiagnostic, undefined);
});

test("a new goal, stage, executor assignment, or observed passing version cannot inherit failure counts", () => {
  const failure = suiteFailure("registered mismatch");
  for (const altered of ["goal", "phase", "serial", "new-bytes-then-revert"]) {
    const active = { phase: "intake", serial: 1 };
    observe(active, 1, failure, { goalSha256: digest("first goal") });
    observe(active, 2, failure, { goalSha256: digest("first goal") });
    const goalSha256 = digest(altered === "goal" ? "new goal" : "first goal");
    if (altered === "phase") active.phase = "supplement";
    if (altered === "serial") active.serial++;
    if (altered === "new-bytes-then-revert") observe(active, 3, { status: "passed" }, { artifacts: changed, goalSha256 });
    assert.equal(observe(active, 4, failure, { goalSha256 }), undefined, altered);
    const saved = active.stallObservations;
    observe(active, 4, failure, { goalSha256 });
    assert.equal(active.stallObservations, saved);
  }
});

test("successful narrow probes cannot clear a current failing registered behavior check", () => {
  const active = {};
  const probe = { status: "passed", snapshotSha256, probe: { exitCode: 0 } };
  const options = { operation: "probe", recipe: "public-json" };
  const failure = suiteFailure("Result differs for fields: results, units");
  observe(active, 0, failure);
  for (let i = 1; i < 6; i++) assert.equal(observe(active, i, probe, options), undefined);
  observe(active, 6, failure);
  for (let i = 7; i < 10; i++) assert.equal(observe(active, i, probe, options), undefined);
  assert.equal(observe(active, 9, probe, options), undefined);
  const record = observe(active, 10, probe, options);
  assert.equal(record.trigger, "unchanged-after-probes");
  assert.equal(record.suggestedLayer, "behavior");
  assert.equal(record.repeatCount, 4);
  const edited = {};
  observe(edited, 1, failure, { changed: { path: "parser.py", sha256: versions[0].sha256 } });
  for (let i = 2; i < 5; i++) assert.equal(observe(edited, i, probe, options), undefined);
  assert.equal(observe(edited, 5, probe, options).trigger, "unchanged-after-probes");
});

test("nonzero outcomes from exploratory bad-input probes do not signal a regression by themselves", () => {
  const active = {};
  const expectedRejection = { status: "failed", snapshotSha256, probe: { exitCode: 2, stderr: "InputError: invalid request" } };
  const options = { operation: "probe", recipe: "public-json" };
  for (let i = 0; i < 5; i++) assert.equal(observe(active, i, expectedRejection, options), undefined);
  assert.equal(active.stallObservations, undefined);
});

test("typed parameter errors and actual transport failures remain different layers", () => {
  const active = {};
  const options = { operation: "probe", recipe: "public-json" };
  const invalid = { status: "invalid-input", recipe: "public-json", field: "args", message: "private value" };
  const timeout = { status: "timeout" };
  const transport = { status: "unavailable", reason: "runner-transport-error" };
  observe(active, 1, invalid, options);
  observe(active, 2, timeout, options);
  observe(active, 3, transport, options);
  observe(active, 4, { ...invalid, field: "stdin" }, options);
  assert.equal(observe(active, 5, invalid, options), undefined);
  const parameters = observe(active, 6, invalid, options);
  assert.equal(parameters.suggestedLayer, "parameters");
  assert.equal(stallDiagnosticSummary(active).recipe, "public-json");
  const runner = {};
  for (let i = 0; i < 2; i++) assert.equal(observe(runner, i, transport, options), undefined);
  assert.equal(observe(runner, 2, transport, options).suggestedLayer, "runner");
  assert.doesNotMatch(JSON.stringify(active), /private value/u);
});

test("syntax reproduction requires the registered compiler, current file and actual structured parse failure", () => {
  const active = {};
  const options = { operation: "probe", recipe: "compile-python", syntaxRecipe: "compile-python",
    input: { args: ["parser.py"] }, sourceLineCounts: new Map([["parser.py", 90]]) };
  const result = { status: "failed", snapshotSha256,
    probe: { exitCode: 1, stdout: '{"status":"syntax-error","line":68}', stderr: "private text" } };
  observe(active, 1, result, options);
  observe(active, 2, result, options);
  const record = observe(active, 3, result, options);
  assert.equal(record.suggestedLayer, "syntax");
  record.layer = "syntax";
  const captured = { artifacts: versions, requestId: "syntax-repro", result, ...options };
  const proof = createStallReproductionProof(record, captured);
  assert.equal(proof.kind, "syntax-error");
  assert.equal(proof.path, "parser.py");
  assert.equal(proof.line, 68);
  assert.equal(proof.fileSha256, versions[0].sha256);
  assert.doesNotMatch(JSON.stringify(proof), /private text/u);
  const current = { artifacts: versions, layer: "syntax", proofId: proof.id };
  assert.equal(requireStallReproductionProof(record, proof, current), proof);
  for (const edit of [
    { operation: "check" }, { recipe: "other" }, { input: { args: ["generated.py"] } },
    { sourceLineCounts: new Map([["parser.py", 67]]) },
    { result: { ...result, probe: { ...result.probe, stdout: '{"status":"internal-error","line":68}' } } },
    { result: { ...result, probe: { ...result.probe, stdout: undefined } } },
    { result: { ...result, status: "passed", probe: { exitCode: 0, stdout: '{"status":"parsed"}' } } },
  ]) assert.equal(createStallReproductionProof(record, { ...captured, ...edit }), undefined);
  assert.throws(() => requireStallReproductionProof(record, proof, { ...current, artifacts: changed }), /当前源码版本/u);
  assert.throws(() => requireStallReproductionProof(record, { ...proof, line: 55 }, current), /已变化/u);
});

test("behavior reproduction pins a publicly expected mismatch and rejects passing, hidden or clipped evidence", () => {
  const record = { id: "stall-1", layer: "behavior", artifactSha256: stallArtifactSha256(versions) };
  const expected = { exitCode: 0, json: 0, pointer: "/units" };
  const result = { status: "passed", snapshotSha256, probe: { exitCode: 0, stdout: '{"units":2,"secret":"private"}' } };
  const captured = { artifacts: versions, requestId: "behavior-repro", recipe: "public-json", operation: "probe",
    input: { stdin: "private input" }, expected, comparison: compareReviewProbe({ type: "runtime", expected }, result), result };
  const proof = createStallReproductionProof(record, captured);
  assert.equal(proof.kind, "runtime-mismatch");
  assert.equal(proof.exitCode, 0);
  assert.equal(proof.expectedExitCode, 0);
  assert.match(proof.actualSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(proof), /private/u);
  assert.equal(requireStallReproductionProof(record, proof, { artifacts: versions, layer: "behavior", proofId: proof.id }), proof);
  assert.equal(createStallReproductionProof(record, { ...captured, comparison: { outcome: "match", actual: { exitCode: 0 } } }), undefined);
  assert.equal(createStallReproductionProof(record, { ...captured, operation: "check", result: suiteFailure("hidden failure") }), undefined);
  assert.equal(createStallReproductionProof(record, { ...captured, result: { ...result, probe: { ...result.probe, truncated: true } } }), undefined);
  assert.equal(createStallReproductionProof(record, { ...captured, result: { ...result, snapshotSha256: undefined } }), undefined);
});

test("recovery needs a current authenticated full check or the corrected failed recipe", () => {
  const artifactSha256 = stallArtifactSha256(versions);
  const runner = { id: "runner-stall", layer: "runner", suggestedLayer: "runner", artifactSha256 };
  const check = { artifacts: versions, requestId: "check-recovery", operation: "check", result: { status: "passed", snapshotSha256 } };
  const probe = { ...check, operation: "probe", recipe: "public-json",
    result: { status: "failed", snapshotSha256, probe: { exitCode: 2 } } };
  assert.equal(createStallReproductionProof(runner, check).kind, "runner-recovered");
  assert.equal(createStallReproductionProof(runner, probe), undefined);
  assert.equal(createStallReproductionProof(runner, { ...check, artifacts: changed }), undefined);
  assert.equal(createStallReproductionProof(runner, { ...check, result: { status: "passed" } }), undefined);
  const parameters = { ...runner, id: "params-stall", layer: "parameters", stalledRecipe: "public-json" };
  assert.equal(createStallReproductionProof(parameters, probe).kind, "parameters-recovered");
  assert.equal(createStallReproductionProof(parameters, { ...probe, recipe: "different-recipe" }), undefined);
  assert.equal(createStallReproductionProof(parameters, check), undefined);
  const syntax = { ...runner, id: "syntax-stall", layer: "syntax", suggestedLayer: "syntax" };
  assert.equal(createStallReproductionProof(syntax, check), undefined);
  const newVersion = { ...syntax, artifactSha256: stallArtifactSha256(changed), failureKind: "version-changed" };
  const recovered = createStallReproductionProof(newVersion, { ...check, artifacts: changed });
  assert.equal(recovered.kind, "current-version-passed");
  assert.equal(recovered.recovery, true);
});
