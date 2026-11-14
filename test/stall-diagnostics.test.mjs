import assert from "node:assert/strict";
import { test } from "node:test";
import { compareReviewProbe } from "../governance/code-review-probes.mjs";
import { digest } from "../governance/policy.mjs";
import {
  createStallReproductionProof, diagnosisProofIdentity, diagnosisProofNext, observeExecutionDiagnostic,
  requireDiagnosisProofScope, requireStallReproductionProof, requireStallTriage,
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

test("A–B–A–B–A parser failures park the current bytes despite varying error text", () => {
  const active = { phase: "supplement", serial: 2 };
  // Pins and error classes from the two repeating, non-parsing journal
  // revisions in the frozen G4 replay. Other registered files stay fixed.
  const revisionA = [{ path: "journal.py", sha256: "e2fc62a6aea2aea51728e0a4c139292587d8273d08b1cbfdae3810da2b2ff4e0" }, ...versions];
  const revisionB = [{ path: "journal.py", sha256: "420be7b797edaaf07e96c7b7eeeb7febbe24dbd39525f516114d4e51f34e4858" }, ...versions];
  const failureA = suiteFailure("SyntaxError: invalid syntax");
  const failureB = suiteFailure("SyntaxError: unterminated triple-quoted string literal (detected at line 254)", "required-2");
  const attempts = [
    [revisionA, failureA], [revisionB, failureB], [revisionA, failureA], [revisionB, failureB], [revisionA, failureA],
  ];
  const observeVisit = (index, [artifacts, result]) => observe(active, index, result,
    { artifacts, goalSha256: digest("new G4 requirements"), changed: { path: "journal.py", sha256: artifacts[0].sha256 } });
  for (const [index, row] of attempts.slice(0, -1).entries()) assert.equal(observeVisit(index, row), undefined);
  assert.equal(observeVisit(0, attempts[0]), undefined, "a replay from the first visit cannot complete the pattern");
  assert.equal(observeVisit("repeat", attempts[3]), undefined, "rechecking B is still the fourth visit");
  const compiler = { status: "failed", snapshotSha256,
    probe: { exitCode: 1, stdout: '{"status":"syntax-error","line":225}' } };
  assert.equal(observe(active, "compile-B", compiler, { artifacts: revisionB, goalSha256: digest("new G4 requirements"),
    operation: "probe", recipe: "compile-python", syntaxRecipe: "compile-python", input: { args: ["journal.py"] } }),
  undefined, "the narrow compiler probe cannot replace B's authenticated full-check visit");
  const record = observeVisit(4, attempts[4]);
  assert.equal(record.trigger, "recurring-failed-versions");
  assert.equal(record.artifactSha256, stallArtifactSha256(revisionA));
  assert.equal(record.suggestedLayer, "syntax");
  assert.equal(record.repeatCount, 5);
  assert.doesNotMatch(JSON.stringify(active), /unterminated/u);
});

test("recurring exact behavior failures escalate, while new bytes and different evidence keep working", () => {
  const revisionC = versions.map(row => row.path === "parser.py" ? { ...row, sha256: digest("new third revision") } : row);
  const failure = suiteFailure("result differed");
  const observeVisits = (artifacts, results) => {
    const active = {};
    return artifacts.map((artifact, index) => observe(active, index, results?.[index] ?? failure, { artifacts: artifact }));
  };
  const alternating = [versions, changed, versions, changed, versions];
  assert.equal(observeVisits(alternating).at(-1).trigger, "recurring-failed-versions");
  const assertions = [
    [alternating, [failure, suiteFailure("unexpected result shape"), failure, suiteFailure("unexpected result shape"), failure]],
    [alternating, [failure, suiteFailure("result differed", "required-2"), failure, suiteFailure("result differed", "required-2"), failure]],
    [alternating, [suiteFailure("SyntaxError: invalid syntax"), suiteFailure("IndentationError: unexpected indent"),
      suiteFailure("SyntaxError: invalid syntax"), suiteFailure("IndentationError: unexpected indent"), suiteFailure("SyntaxError: invalid syntax")]],
    [alternating, alternating.map(() => ({ status: "failed", snapshotSha256 }))],
    [alternating, alternating.map(() => ({ ...failure, snapshotSha256: undefined }))],
    [alternating, alternating.map(() => ({ status: "timeout" }))],
    [alternating, alternating.map(() => ({ status: "invalid-input", reason: "recipe-input-invalid", recipe: "compile-python" }))],
    [[versions, changed, versions, changed, revisionC], undefined],
    [[versions, changed, revisionC, versions, changed, versions], undefined],
  ];
  for (const [artifacts, results] of assertions) {
    assert.ok(observeVisits(artifacts, results).every(record => record === undefined));
  }
});

test("a full pass, another observed version, or a new assignment breaks the recurring-version trail", () => {
  const failure = suiteFailure("SyntaxError: invalid syntax");
  const newVersion = versions.map(row => row.path === "parser.py" ? { ...row, sha256: digest("another revision") } : row);
  for (const interruption of ["pass-current", "pass-other", "probe-other", "new-goal", "new-phase", "new-serial"]) {
    const active = { phase: "intake", serial: 1 };
    let goalSha256 = digest("first goal");
    const observeVisit = (index, artifacts, result = failure, extra) => observe(active, index, result, { artifacts, goalSha256, ...extra });
    observeVisit(1, versions);
    observeVisit(2, changed);
    observeVisit(3, versions);
    if (interruption === "pass-current") observeVisit(4, versions, { status: "passed", snapshotSha256 });
    if (interruption === "pass-other") observeVisit(4, newVersion, { status: "passed", snapshotSha256 });
    if (interruption === "probe-other") observeVisit(4, newVersion,
      { status: "passed", snapshotSha256, probe: { exitCode: 0 } }, { operation: "probe" });
    if (interruption === "new-goal") goalSha256 = digest("next goal");
    if (interruption === "new-phase") active.phase = "supplement";
    if (interruption === "new-serial") active.serial++;
    assert.equal(observeVisit(5, changed), undefined, interruption);
    assert.equal(observeVisit(6, versions), undefined, interruption);
    assert.equal(observeVisit(7, changed), undefined, interruption);
  }
});

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

test("owner mapping alone lets a public mismatch represent the signed case", () => {
  const artifactSha256 = stallArtifactSha256(versions);
  const record = { id: "stall-2", layer: "behavior", caseId: "required-1", artifactSha256 };
  const expected = { exitCode: 0, json: "blocked", pointer: "/status" };
  const result = { status: "passed", snapshotSha256, probe: { exitCode: 0, stdout: '{"status":"ok","private":"data"}' } };
  const exampleId = "public:example:real";
  const observation = { artifacts: versions, requestId: "mapped-repro", recipe: "public-json", operation: "probe",
    input: { stdin: "private input" }, expected, exampleId,
    comparison: compareReviewProbe({ type: "runtime", expected }, result), result };
  const independent = createStallReproductionProof(record, observation);
  const signed = createStallReproductionProof(record, { ...observation, signedCaseId: record.caseId });
  assert.equal(independent.scope, "independent");
  assert.equal(signed.scope, "signed-case");
  assert.equal(signed.signedCaseId, record.caseId);
  assert.doesNotMatch(JSON.stringify(signed), /private|"stdout"/u);
  assert.equal(createStallReproductionProof(record, { ...observation, signedCaseId: "different-case" }), undefined);
  assert.equal(createStallReproductionProof(record, { ...observation, signedCaseId: record.caseId, exampleId: undefined }), undefined);
  const registered = { examples: [{ id: exampleId }], attempts: {} };
  const pending = { ...registered, pending: { id: exampleId } };
  assert.throws(() => requireDiagnosisProofScope(record, independent, pending), /关联的公开示例/u);
  assert.deepEqual(diagnosisProofNext(record, independent, pending), { action: "example", exampleId });
  const mismatch = { ...registered, mismatch: { proofId: signed.id }, attempts: { [exampleId]: { proofId: signed.id } } };
  assert.throws(() => requireDiagnosisProofScope(record, independent, mismatch), /真实回执/u);
  assert.equal(diagnosisProofNext(record, independent, mismatch).proofId, signed.id);
  assert.equal(requireDiagnosisProofScope(record, signed, mismatch), signed);
  assert.throws(() => requireDiagnosisProofScope(record, signed), /未关联/u);
  assert.throws(() => requireStallReproductionProof(record, undefined, { artifacts: versions,
    proofId: snapshotSha256, layer: "behavior" }), /请勿填快照/u);
  assert.throws(() => requireStallReproductionProof(record, undefined, { artifacts: versions,
    proofId: "stall-proof-" + "0".repeat(64), layer: "behavior" }), /没有这个复现编号/u);
});

test("the same independent symptom cannot masquerade as a new repair for an unchanged signed failure", () => {
  const goalSha256 = digest("original goal");
  const failure = suiteFailure("opaque failure text");
  const active = { phase: "intake", serial: 1 };
  for (let index = 0; index < 3; index++) observe(active, index, failure, { goalSha256 });
  const prior = active.stallDiagnostic;
  const expected = { exitCode: 0, json: "blocked", pointer: "/status" };
  const result = { status: "passed", snapshotSha256, probe: { exitCode: 0, stdout: '{"status":"ok"}' } };
  const observation = { artifacts: versions, requestId: "old-repro", recipe: "public-json", operation: "probe",
    input: { stdin: '{"scope":"other-branch"}' }, expected,
    comparison: compareReviewProbe({ type: "runtime", expected }, result), result };
  const proof = createStallReproductionProof({ ...prior, layer: "behavior" }, observation);
  active.stallDiagnostic = { ...prior, goalSha256, status: "resolved", evidence: { proof } };
  active.serial++;
  // A genuine narrow run can be the first operation after resuming. It does
  // not erase the prior repair before the full signed check runs again.
  observe(active, "first-probe", { status: "passed", snapshotSha256 }, { goalSha256, operation: "probe" });
  for (let index = 0; index < 3; index++) observe(active, "current-" + index, failure, { goalSha256, artifacts: changed });
  const current = { ...active.stallDiagnostic, layer: "behavior" };
  const repeated = createStallReproductionProof(current, { ...observation, artifacts: changed, requestId: "new-repro" });
  assert.notEqual(repeated.id, proof.id);
  assert.equal(diagnosisProofIdentity(repeated), diagnosisProofIdentity(proof));
  assert.deepEqual(stallDiagnosticSummary(active).signedFailure, { id: "required-1", unchangedIndependentRepairs: 1 });
  assert.throws(() => requireDiagnosisProofScope(current, repeated), /签名用例仍失败/u);
  assert.equal(diagnosisProofNext(current, repeated).action, "probe");
  const different = createStallReproductionProof(current, { ...observation, artifacts: changed,
    input: { stdin: '{"scope":"other-trigger"}' }, requestId: "another-repro" });
  assert.equal(requireDiagnosisProofScope(current, different), different);
});
