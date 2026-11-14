import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";

import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { fixture, host } from "./helpers.mjs";

const reproduction = "building_loop_reproduce";
const diagnosis = "building_loop_diagnose";
const behaviorProbe = "building_loop_diagnosis_probe";
// The suite exercises guarded writes before the local runner request begins.
// Keep the simulated turn alive through filesystem work under Windows load.
const diagnosticHost = root => host(root, { automaticCoverage: false, toolTimeoutMs: 30_000 });
const unit = "K01";
const entry = "release.py";
const specFile = "SPEC.md";
const baselineFile = "baseline-proof.json";
const candidateFile = "candidate-proof.json";
const privateFile = "private.txt";
const syntaxRecipe = "compile-python";
const behaviorRecipe = "release-json";
const oldCase = "old-green";
const newCase = "new-required";
const syntaxPath = "journal.py";
const behaviorPath = "planner.py";
const architectureFile = "modules/architecture.md";
const architecturePlan = "# Architecture\n\n## Responsibility\n\nThe input boundary normalizes requests.\n";
const windowClause = "新请求与停用区间相交时，由 windows 判定 `window-closed`，它优先于目标预约重叠。";
const compilerSource = '"""Normalize records."""\n\nA boundary owner records identities.\n"""\n\ndef parse(data):\n    return data\n';
const closureSource = [
  "def retained_closure(by_id, applied, retained):",
  "    keep = set(retained)",
  "    stack = list(retained)",
  "    while stack:",
  '        for target in by_id[stack.pop()]["depends_on"]:',
  "            if target in applied and target not in keep:",
  "                keep.add(target)",
  "                stack.append(target)",
  "    return keep",
].join("\n") + "\n";
const publicRequest = { action: "rollback-many", requests: [{
  environment: "staging", budget: 0, changes: [
    { id: "a", component: "db", units: 2 },
    { id: "b", component: "db", units: 1, depends_on: ["a"] },
    { id: "c", component: "db", units: 1, depends_on: ["b"] },
  ], applied: ["a", "c"], retain: ["c"],
}] };
const windowRequest = { action: "reserve", window: [50, 60], closed: [[0, 100], [5, 10]] };

const stallCases = {
  syntax: {
    path: syntaxPath, range: [1, 4], reportedLine: 6,
    probe: { action: "probe", recipe: syntaxRecipe, args: [syntaxPath] },
    cause: "The early closing delimiter leaves the explanatory text outside the docstring.",
    fix: "Remove the premature closing delimiter and compile the pinned source again.",
    oldText: 'records."""\n', newText: "records.\n",
  },
  behavior: {
    path: behaviorPath, range: [5, 8], reportedLine: 6,
    probe: { action: "probe", recipe: behaviorRecipe, stdin: JSON.stringify(publicRequest) },
    cause: "The applied-set condition prevents visiting the unapplied intermediate dependency.",
    fix: "Track visited nodes independently of membership in the keep set.",
  },
};

function approve(root) {
  const user = latestConversationUser([{ type: "user/message", seq: 12, data: { source: { kind: "user" },
    content: [{ type: "text", text: "开始建设：按当前约定修复发布规划器" }] } }]);
  const home = process.env.DSH_HOME;
  const { proposal } = proposeConversationTask(home, "root", user,
    { goal: "修复发布规划器", deliverable: "可执行发布规划器和实测结果", scope: "已授权源码和 SPEC" });
  decideConversationStart(home, "root", user, proposal.id, "start", () => ({ kind: "workspace", root }), { typed: true });
}

function signReceipt(write, file, receipt, keys) {
  const signature = sign(null, codeRegressionSigningBytes(receipt), keys.privateKey).toString("base64");
  write(file, JSON.stringify({ ...receipt, signature }));
}

function configure(root, write, kind, { architecture = false, registered = false } = {}) {
  const keys = generateKeyPairSync("ed25519");
  const sources = [entry, kind === "syntax" ? syntaxPath : behaviorPath];
  const tests = {
    file: candidateFile,
    publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    previousSuiteSha256: digest("old public suite"),
    suiteSha256: digest("old plus current public suite"),
    requiredCases: [newCase],
    regression: { baselineFile, previousCases: [oldCase], inputs: [] },
  };
  write(entry, "print('entry')\n");
  if (kind === "syntax") write(syntaxPath, architecture ?
    compilerSource.replace(stallCases.syntax.oldText, stallCases.syntax.newText) : compilerSource);
  else write(behaviorPath, closureSource);
  write(privateFile, "separate private artifact\n");
  write(specFile, "# Release planner\nKeep transitive installed dependencies through unapplied intermediaries; omit kept IDs from rollback actions.\n\n" +
    windowClause + "\n" +
    (architecture ? "\n## Navigation\n\n- [Index](INDEX.md)\n" : ""));
  if (architecture) {
    write("INDEX.md", "# Index\n\n## Modules\n\n- [Architecture](modules/architecture.md)\n");
    fs.mkdirSync(path.join(root, "modules"));
    write(architectureFile, architecturePlan + "\n## Imports\n\nPending.\n");
  }
  const review = [...sources, ...(architecture ? [architectureFile] : [])];
  write("BUILDING-LOOP.json", JSON.stringify({
    spec: "building-loop/1", coordinator: { read: [specFile, ...(architecture ? ["INDEX.md", architectureFile] : [])],
      ...(architecture ? { write: [architectureFile] } : {}) }, goalContext: [specFile],
    ...(architecture ? { hierarchy: { overview: { path: specFile, heading: "Navigation" },
      index: { path: "INDEX.md", heading: "Modules" }, modules: { architecture: architectureFile } } } : {}),
    units: { [unit]: {
      candidate: entry, continuation: "reuse",
      ...(architecture ? { plainLast: false, architecture: { module: "architecture", headings: ["Responsibility"], importsHeading: "Imports" } } : {}),
      phases: {
        intake: { read: sources, write: sources },
        supplement: { read: sources, write: sources },
        "first-review": { read: review, receipt: "first.json" },
        "final-review": { read: review, receipt: "final.json" },
      },
      codeTask: { sources, tests, diagnostics: {
        checkSet: "registered-host-stalls", protocol: 2, recipes: [syntaxRecipe, behaviorRecipe],
        reviewRecipes: registered ? [syntaxRecipe, behaviorRecipe] : [syntaxRecipe], syntaxRecipe,
        ...(registered ? { inputContracts: [{ id: "retained-closure", recipe: behaviorRecipe, examples: [{ id: "through-unapplied",
          stdin: JSON.stringify(publicRequest), expectedJson: { status: "ok", results: [{ actions: [], units: 0 }], units: 0 },
          requirement: { file: specFile, start: 2, end: 2,
            quote: "Keep transitive installed dependencies through unapplied intermediaries; omit kept IDs from rollback actions." },
          diagnosticCases: [newCase] }] }] } : {}),
        recipeInputs: {
          [syntaxRecipe]: { args: { min: 1, types: ["source"] }, stdin: "forbidden", files: { min: 0, max: 0 } },
          [behaviorRecipe]: { args: { min: 0, types: [] }, stdin: "required", files: { min: 0, max: 0 } },
        },
      } },
    } },
  }));
  approve(root);
  const policy = authority(root);
  signReceipt(write, baselineFile, {
    spec: "building-loop-code-regression-baseline/1", unit, policySha256: policy.hash,
    suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, policy.units[unit]),
    runId: "registered-stall-baseline", cases: [{ id: oldCase, status: "passed" }],
  }, keys);
  return keys;
}

/** Fixture runner validates host pinning and returns controlled replay evidence. */
async function runWithRunner(kind, run) {
  const scenario = stallCases[kind];
  const requests = [], errors = [];
  let forcePass;
  const secret = "isolated-registered-stall-test-runner";
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer " + secret);
      assert.equal(request.method, "POST");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      assert.equal(body.unit, unit);
      assert.equal(body.checkSet, "registered-host-stalls");
      assert.deepEqual(body.protectedCases, [oldCase]);
      assert.deepEqual(body.requiredCases, [newCase]);
      const artifacts = body.artifacts.map(artifact => {
        assert.equal(digest(Buffer.from(artifact.contentBase64, "base64")), artifact.sha256);
        return { path: artifact.path, sha256: artifact.sha256 };
      });
      assert.deepEqual(artifacts.map(artifact => artifact.path), [scenario.path, entry]);
      const source = Buffer.from(body.artifacts[0].contentBase64, "base64").toString("utf8");
      const fixed = forcePass ?? (kind === "syntax" ? source.includes("records.\n\nA boundary owner")
        : source.includes("seen = set(retained)") && source.includes("stack.append(target)\n            if target in applied:"));
      const reply = { spec: body.spec, requestId: body.requestId, snapshotSha256: body.snapshotSha256 };
      if (body.operation === "check") {
        const error = { caseId: newCase, message: kind === "syntax" ? "SyntaxError: stray triple-quote" :
          "Expected no rollback action through unapplied intermediate, got a", path: scenario.path, line: scenario.reportedLine };
        Object.assign(reply, { status: fixed ? "passed" : "failed", old: { status: "passed" },
          required: [{ caseId: newCase, status: fixed ? "passed" : "failed", ...(!fixed && { error }) }] });
      } else {
        assert.equal(body.operation, "probe");
        const { action, ...expected } = scenario.probe;
        const windowProbe = kind === "behavior" && body.probe.stdin === JSON.stringify(windowRequest);
        assert.deepEqual(body.probe, windowProbe ? { recipe: behaviorRecipe, stdin: JSON.stringify(windowRequest) } : expected);
        if (kind === "syntax") Object.assign(reply, { status: fixed ? "passed" : "failed", probe: fixed
          ? { exitCode: 0, stdout: '{"status":"parsed"}' }
          : { exitCode: 1, stdout: JSON.stringify({ status: "syntax-error", line: scenario.reportedLine }),
              stderr: "SyntaxError: stray triple-quote" } });
        else if (windowProbe) Object.assign(reply, { status: "passed", probe: { exitCode: 0, stdout: '{"status":"ok"}' } });
        else Object.assign(reply, { status: "passed", probe: { exitCode: 0, stdout: JSON.stringify(fixed
          ? { status: "ok", results: [{ actions: [], units: 0 }], units: 0 }
          : { status: "ok", results: [{ actions: ["a"], units: 2 }], units: 2 }) } });
      }
      response.end(JSON.stringify(reply));
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = {
    DSH_BUILDING_LOOP_DIAGNOSTICS_URL: "http://127.0.0.1:" + server.address().port + "/stall-check",
    DSH_BUILDING_LOOP_DIAGNOSTICS_TOKEN: secret,
    DSH_BUILDING_LOOP_DIAGNOSTICS_TIMEOUT_MS: "12000",
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await run({ requests, forceCheckPass: value => { forcePass = value; } });
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

async function forceStall(kind, harness, executor, requests) {
  const scenario = stallCases[kind];
  const attempt = args => harness.invoke(executor, reproduction, args);
  const phase = async () => (await harness.flow("root", "status")).units[0].phase;
  assert.equal((await attempt({ action: "check" })).status, "failed");
  if (kind === "syntax") {
    // Exact repeated failures on a stable artifact are one independent trigger.
    assert.equal((await attempt({ action: "check" })).status, "failed");
    assert.equal(await phase(), "intake");
    await attempt({ action: "check" });
  } else {
    // All four exploratory probes exit zero. The unchanged source still fails
    // the registered requirement, so exploration cannot continue indefinitely.
    assert.equal((await attempt({ action: "check" })).status, "failed");
    for (let i = 0; i < 3; i++) {
      assert.equal((await attempt(scenario.probe)).status, "passed");
      assert.equal(await phase(), "intake");
    }
    await attempt(scenario.probe);
  }
  assert.equal(await phase(), "diagnosis-ready");
  const before = requests.length;
  await assert.rejects(attempt({ action: "check" }));
  await assert.rejects(harness.flow(executor, "submit"));
  assert.equal(requests.length, before);
}

async function startInvestigation(kind, harness, executor) {
  const scenario = stallCases[kind];
  const issue = { unit, layer: kind, reason: scenario.cause };
  assert.match(harness.prompt("root"), /role=coordinator phase=diagnosis-ready[\s\S]*building_loop_diagnose triage/u);
  await assert.rejects(harness.flow("root", "advance"));
  await assert.rejects(harness.invoke(executor, diagnosis, { action: "triage", ...issue }));
  await harness.invoke("root", diagnosis, { action: "triage", ...issue });
  const assigned = await harness.flow("root", "advance");
  assert.equal(assigned.phase, "diagnosis");
  assert.notEqual(assigned.childId, executor);
  const investigator = assigned.childId;
  await harness.preStep(investigator);
  assert.match(harness.prompt(investigator), /role=diagnostician phase=diagnosis[\s\S]*只读诊断[\s\S]*building_loop_diagnosis_probe/u);
  assert.equal((await harness.flow(investigator, "status")).role, "diagnostician");
  assert.ok(harness.visible(investigator).includes(reproduction));
  assert.ok(harness.visible(investigator).includes(diagnosis));
  assert.ok(harness.visible(investigator).includes(behaviorProbe));
  assert.ok(!harness.visible("root").includes(behaviorProbe));
  assert.ok(!harness.visible(executor).includes(behaviorProbe));
  assert.deepEqual(Object.keys(harness.schema(reproduction).properties), ["action", "recipe", "args", "stdin", "files", "exampleId"]);
  assert.deepEqual(harness.schema(behaviorProbe).properties.action.enum, ["probe", "example"]);
  assert.ok(!harness.visible(investigator).includes("building_loop_code_review"));
  for (const name of ["pwsh", "read", "glob", "search", "write", "grep", "terminal"]) {
    assert.match(harness.guard(investigator, name), /禁止直接调用/u);
    assert.match(harness.guard("root", name), /禁止直接调用/u);
    assert.ok(!harness.restriction(investigator)?.allow.includes(name));
  }
  const grants = await harness.file(investigator, "list");
  assert.ok(grants.read.includes(scenario.path));
  assert.ok(!grants.read.includes(privateFile));
  assert.deepEqual(grants.write, []);
  await assert.rejects(harness.file("root", "read", scenario.path), /白名单/u);
  await assert.rejects(harness.file("root", "search", scenario.path, { query: "def" }), /白名单/u);
  await assert.rejects(harness.file("root", "write", scenario.path, { content: "", note: "escape" }), /白名单/u);
  await assert.rejects(harness.file(investigator, "read", privateFile), /白名单/u);
  await assert.rejects(harness.file(investigator, "search", privateFile, { query: "private" }), /白名单/u);
  await assert.rejects(harness.file(investigator, "write", scenario.path, { content: "", note: "escape" }), /白名单/u);
  await assert.rejects(harness.file(investigator, "edit", scenario.path, { beforeSha256: digest("x"),
    oldText: "old", newText: "new", note: "escape" }), /白名单/u);
  await assert.rejects(harness.flow(investigator, "advance"));
  await assert.rejects(harness.flow(investigator, "submit"));
  await assert.rejects(harness.invoke("root", reproduction, scenario.probe));
  return investigator;
}

function submission(kind) {
  const scenario = stallCases[kind];
  const [start, end] = scenario.range;
  return { action: "submit", unit, file: scenario.path, start, end, cause: scenario.cause, fix: scenario.fix };
}

async function reproduceFinding(kind, harness, investigator) {
  const scenario = stallCases[kind];
  const proofArgs = { ...scenario.probe };
  if (kind === "behavior") {
    const exploratory = await harness.invoke(investigator, reproduction, scenario.probe);
    assert.equal(exploratory.status, "passed");
    assert.equal(exploratory.proofId, undefined);
    await harness.file(investigator, "read", specFile, { start: 1, count: 1 });
    const requirement = await harness.file(investigator, "read", specFile, { start: 2, count: 1 });
    Object.assign(proofArgs, { expectedExitCode: 0, expectedJson: "[]", expectedPointer: "/results/0/actions",
      requirement: { file: specFile, start: 2, end: 2, quote: requirement.lines[0][1] } });
  }
  const proof = await harness.invoke(investigator, kind === "behavior" ? behaviorProbe : reproduction, proofArgs);
  assert.equal(proof.status, kind === "syntax" ? "failed" : "passed");
  assert.match(proof.proofId, /^stall-proof-[a-f0-9]{64}$/u);
  assert.match(proof.snapshotSha256, /^[a-f0-9]{64}$/u);
  return proof;
}

async function signCurrent(harness, executor, write, keys, oldStatus = "passed") {
  const { file, previousCases, requiredCases, protectedCases, ...binding } =
    (await harness.flow(executor, "prepare")).codeTask.regressionProof;
  assert.deepEqual(protectedCases, [oldCase]);
  signReceipt(write, file, { ...binding, runId: "registered-stall-candidate",
    cases: [{ id: oldCase, status: oldStatus }, { id: newCase, status: "passed" }] }, keys);
}

test("signed failure selects its public behavior replay and only that mismatch can route the repair", () =>
  fixture(async (root, write) => runWithRunner("behavior", async ({ requests }) => {
    configure(root, write, "behavior", { registered: true });
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    await harness.flow(executor, "prepare");
    await forceStall("behavior", harness, executor, requests);
    const investigator = await startInvestigation("behavior", harness, executor);
    const exampleId = "retained-closure:example:through-unapplied";
    const replay = { action: "example", exampleId };
    const initial = await harness.flow(investigator, "prepare");
    assert.deepEqual(initial.next, { tool: behaviorProbe, ...replay });
    assert.equal(initial.reproduction.signedCase.id, newCase);
    const finding = submission("behavior");
    await harness.file(investigator, "read", finding.file, { start: finding.start, count: finding.end - finding.start + 1 });
    const exploratory = await reproduceFinding("behavior", harness, investigator);
    assert.deepEqual(exploratory.next, { tool: behaviorProbe, ...replay });
    await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, proofId: exploratory.proofId }), /关联的公开示例/u);
    const proof = await harness.invoke(investigator, behaviorProbe, replay);
    assert.equal(proof.outcome, "mismatch");
    const count = requests.length;
    const cached = await harness.invoke(investigator, behaviorProbe, replay);
    assert.equal(cached.proofId, proof.proofId);
    assert.equal(cached.reused, true);
    assert.equal(requests.length, count);
    const prepared = await harness.flow(investigator, "prepare");
    assert.equal(prepared.next.proofId, proof.proofId);
    await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, proofId: exploratory.proofId }), /真实回执/u);
    const submitted = await harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.proofId });
    const { evidence } = submitted.stallDiagnostic;
    assert.equal(evidence.proof.exampleId, exampleId);
    assert.equal(evidence.proof.scope, "signed-case");
    assert.equal(evidence.proof.signedCaseId, newCase);
    assert.ok(!JSON.stringify(submitted).includes(JSON.stringify(publicRequest)));
    await harness.invoke("root", diagnosis, { action: "verify", unit, evidenceId: evidence.id,
      decision: "confirmed", reason: "The registered case and exact source location identify the dependency traversal defect." });
    const repair = await harness.flow("root", "advance");
    assert.equal(repair.childId, executor);
    assert.equal(repair.reused, true);
  })));

test("alternate success gives a usable independent proof and a bad proof ID returns specific guidance", () =>
  fixture(async (root, write) => runWithRunner("behavior", async ({ requests }) => {
    configure(root, write, "behavior");
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    await harness.flow(executor, "prepare");
    await forceStall("behavior", harness, executor, requests);
    const investigator = await startInvestigation("behavior", harness, executor);
    await harness.flow(investigator, "prepare");
    await harness.file(investigator, "read", specFile, { start: 1, count: 4 });
    const finding = submission("behavior");
    await harness.file(investigator, "read", finding.file, { start: finding.start, count: finding.end - finding.start + 1 });
    const args = { action: "probe", recipe: behaviorRecipe, stdin: JSON.stringify(windowRequest), expectedExitCode: 0, expectedPointer: "/error",
      expectedJson: '"window-closed"', requirement: { file: specFile, start: 4, end: 4, quote: windowClause } };
    const unknown = await harness.invoke(investigator, behaviorProbe, { ...args, expectedPointer: "/nested/error" });
    assert.equal(unknown.proofId, undefined);
    assert.equal(unknown.reason, "missing-unstated-field");
    const proof = await harness.invoke(investigator, behaviorProbe, args);
    assert.equal(proof.actual.output, "missing-field");
    assert.equal(proof.actual.responseStatus, "ok");
    assert.equal(proof.next.scope, "independent");
    assert.equal(proof.next.proofId, proof.proofId);
    await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.snapshotSha256 }), /请勿填快照/u);
    await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, proofId: "stall-proof-" + "0".repeat(64) }), /没有这个复现编号/u);
    const count = requests.length;
    const cached = await harness.invoke(investigator, behaviorProbe, args);
    assert.equal(cached.proofId, proof.proofId);
    assert.equal(cached.reused, true);
    assert.equal(requests.length, count);
    assert.equal((await harness.flow(investigator, "prepare")).next.proofId, proof.proofId);
    const submitted = await harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.proofId });
    const { evidence } = submitted.stallDiagnostic;
    assert.equal(evidence.proof.scope, "independent");
    assert.equal(evidence.proof.signedCaseId, undefined);
    assert.equal(evidence.proof.responseStatus, "ok");
    assert.ok(!JSON.stringify(submitted).includes(JSON.stringify(windowRequest)));
  })));

for (const kind of ["syntax", "behavior"]) {
  test("registered host escalates " + kind + " stalls, verifies bounded proof and resumes the same executor",
    () => fixture(async (root, write) => runWithRunner(kind, async ({ requests }) => {
      const scenario = stallCases[kind];
      const withArchitecture = kind === "syntax";
      const keys = configure(root, write, kind, { architecture: withArchitecture });
      const harness = diagnosticHost(root);
      if (withArchitecture) await harness.flow("root", "architecture");
      const { childId: executor } = await harness.flow("root", "advance");
      assert.ok(harness.visible(executor).includes(reproduction));
      assert.ok(!harness.visible(executor).includes(behaviorProbe));
      await harness.flow(executor, "prepare");
      if (withArchitecture) write(syntaxPath, compilerSource);
      await forceStall(kind, harness, executor, requests);
      assert.ok(harness.concluded.includes(executor));
      const investigator = await startInvestigation(kind, harness, executor);
      const finding = submission(kind);
      await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, proofId: "unprepared" }));
      await harness.flow(investigator, "prepare");
      const proof = await reproduceFinding(kind, harness, investigator);
      const read = await harness.file(investigator, "read", scenario.path, {
        start: finding.start, count: finding.end - finding.start + 1,
      });
      await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, file: entry, proofId: proof.proofId }));
      await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, proofId: "stall-proof-" + "0".repeat(64) }));
      await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, end: read.totalLines + 1, proofId: proof.proofId }));
      const submitted = await harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.proofId });
      assert.equal(submitted.phase, "diagnosis-verify");
      assert.ok(harness.concluded.includes(investigator));
      assert.match(harness.prompt("root"), /role=coordinator phase=diagnosis-verify[\s\S]*building_loop_diagnose verify/u);
      const status = (await harness.flow("root", "status")).units[0].stallDiagnostic;
      assert.equal(status.suggestedLayer, kind);
      assert.equal(status.trigger, kind === "syntax" ? "repeated-failure" : "unchanged-after-probes");
      assert.ok(!JSON.stringify(status).includes(scenario.probe.stdin ?? "stray triple-quote"));
      assert.deepEqual(status.evidence.source, { file: scenario.path, start: finding.start, end: finding.end, sha256: read.sha256 });
      assert.equal(status.evidence.proof.id, proof.proofId);
      assert.equal(status.evidence.proof.snapshotSha256, proof.snapshotSha256);
      if (kind === "syntax") assert.equal(status.evidence.proof.line, scenario.reportedLine);
      else assert.notEqual(status.evidence.proof.expectedSha256, status.evidence.proof.actualSha256);
      const verification = { action: "verify", unit, evidenceId: submitted.stallDiagnostic.evidence.id, decision: "confirmed",
        reason: "Current pinned source range and governed minimal reproduction establish the reported cause." };
      await assert.rejects(harness.flow("root", "advance"));
      await assert.rejects(harness.invoke(executor, diagnosis, verification));
      await assert.rejects(harness.invoke("root", diagnosis, { ...verification, evidenceId: "forged" }));
      const verified = await harness.invoke("root", diagnosis, verification);
      assert.equal(verified.phase, "diagnosis-repair-ready");
      assert.match(harness.prompt("root"), /role=coordinator phase=diagnosis-repair-ready[\s\S]*原执行会话[\s\S]*签名回归/u);
      if (withArchitecture) {
        const amended = fs.readFileSync(path.join(root, architectureFile), "utf8").replace("normalizes requests", "normalizes requests after decoding");
        await harness.file("root", "write", architectureFile, { content: amended, note: "Update the architecture after verified diagnosis" });
        await assert.rejects(harness.flow("root", "advance"), /登记实际版本/u);
        const registered = await harness.flow("root", "architecture");
        assert.equal(registered.phase, "diagnosis-repair-ready");
        assert.equal(registered.architecture.sha256, digest(amended));
      }
      const resumed = await harness.flow("root", "advance");
      assert.equal(resumed.phase, "intake");
      assert.equal(resumed.childId, executor);
      assert.equal(resumed.reused, true);
      assert.deepEqual(harness.activations.map(item => item.childId), [executor, investigator]);
      const handoff = harness.notifications.at(-1);
      assert.equal(handoff.target, executor);
      assert.match(handoff.content[0].text, /prepare.*定点修复|定点修复.*prepare/u);
      assert.equal((await harness.flow(investigator, "status")).role, "idle");
      assert.match(harness.prompt(executor), /role=executor phase=intake[\s\S]*改前通过的旧用例和新增必测用例/u);
      const repairPacket = await harness.flow(executor, "prepare");
      assert.match(repairPacket.instruction.text, /按当前约定修复发布规划器/u);
      assert.equal(repairPacket.stallDiagnostic.evidence.proof.id, proof.proofId);
      assert.equal(repairPacket.stallDiagnostic.evidence.fix, scenario.fix);
      assert.equal(repairPacket.stallDiagnostic.evidence.replay.input.recipe, scenario.probe.recipe);
      assert.equal((await harness.file(executor, "read", scenario.path)).sha256, read.sha256);
      await assert.rejects(harness.flow(executor, "submit"), /回归签名回执/u);

      const edit = await harness.file(executor, "edit", scenario.path, { beforeSha256: read.sha256, note: scenario.fix,
        ...(kind === "syntax" ? { oldText: scenario.oldText, newText: scenario.newText } : {
          oldText: [
            "    while stack:", '        for target in by_id[stack.pop()]["depends_on"]:',
            "            if target in applied and target not in keep:", "                keep.add(target)", "                stack.append(target)",
          ].join("\n"),
          newText: [
            "    seen = set(retained)", "    while stack:", '        for target in by_id[stack.pop()]["depends_on"]:',
            "            if target in seen:", "                continue", "            seen.add(target)", "            stack.append(target)",
            "            if target in applied:", "                keep.add(target)",
          ].join("\n"),
        }) });
      assert.equal(edit.changed, true);
      assert.notEqual(edit.sha256, read.sha256);
      assert.equal(edit.diagnostics.status, "passed");
      await signCurrent(harness, executor, write, keys, "failed");
      await assert.rejects(harness.flow(executor, "submit"), /旧用例回退/u);
      await signCurrent(harness, executor, write, keys);
      assert.equal((await harness.flow(executor, "submit")).phase, "review-ready");
      const review = await harness.flow("root", "advance");
      assert.equal(review.phase, "first-review");
      assert.notEqual(review.childId, executor);
      assert.notEqual(review.childId, investigator);
    })));
}

test("registered host retires a diagnostic receipt when source advances before coordinator verification",
  () => fixture(async (root, write) => runWithRunner("syntax", async ({ requests }) => {
    configure(root, write, "syntax");
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    await harness.flow(executor, "prepare");
    await forceStall("syntax", harness, executor, requests);
    const investigator = await startInvestigation("syntax", harness, executor);
    await harness.flow(investigator, "prepare");
    const proof = await reproduceFinding("syntax", harness, investigator);
    await harness.file(investigator, "read", syntaxPath);
    const finding = submission("syntax");
    const submitted = await harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.proofId });
    const current = fs.readFileSync(path.join(root, syntaxPath), "utf8");
    write(syntaxPath, current + "# Source changed outside the host while verification waited.\n");
    await assert.rejects(harness.invoke("root", diagnosis, { action: "verify", unit,
      evidenceId: submitted.stallDiagnostic.evidence.id, decision: "confirmed", reason: "Attempting to reuse a stale source receipt." }));
    await assert.rejects(harness.flow("root", "advance"));
    await harness.invoke("root", diagnosis, { action: "triage", unit, layer: "syntax", reason: "Source advanced; recheck the new pin." });
    const fresh = await harness.flow("root", "advance");
    assert.equal(fresh.phase, "diagnosis");
    await harness.flow(fresh.childId, "prepare");
    await harness.file(fresh.childId, "read", syntaxPath);
    await assert.rejects(harness.invoke(fresh.childId, diagnosis, { ...finding, proofId: proof.proofId }));
    const currentProof = await reproduceFinding("syntax", harness, fresh.childId);
    assert.notEqual(currentProof.proofId, proof.proofId);
    assert.notEqual(currentProof.snapshotSha256, proof.snapshotSha256);
  })));

test("different source revisions and an intervening complete pass reset repeated-failure counters",
  () => fixture(async (root, write) => runWithRunner("syntax", async ({ forceCheckPass }) => {
    configure(root, write, "syntax");
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    const check = () => harness.invoke(executor, reproduction, { action: "check" });
    assert.equal((await check()).status, "failed");
    assert.equal((await check()).status, "failed");
    const before = fs.readFileSync(path.join(root, syntaxPath), "utf8");
    write(syntaxPath, before + "# New revision must not inherit the old counter.\n");
    assert.equal((await check()).status, "failed");
    assert.equal((await check()).status, "failed");
    assert.equal((await harness.flow("root", "status")).units[0].phase, "intake");
    forceCheckPass(true);
    assert.equal((await check()).status, "passed");
    forceCheckPass(false);
    assert.equal((await check()).status, "failed");
    assert.equal((await check()).status, "failed");
    assert.equal((await harness.flow("root", "status")).units[0].phase, "intake");
  })));

test("a changed goal retires a verified repair even when the source bytes are unchanged",
  () => fixture(async (root, write) => runWithRunner("syntax", async ({ requests }) => {
    configure(root, write, "syntax");
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    await forceStall("syntax", harness, executor, requests);
    const investigator = await startInvestigation("syntax", harness, executor);
    await harness.flow(investigator, "prepare");
    const proof = await reproduceFinding("syntax", harness, investigator);
    const finding = submission("syntax");
    const submitted = await harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.proofId });
    const review = { action: "verify", unit, evidenceId: submitted.stallDiagnostic.evidence.id, decision: "confirmed",
      reason: "The diagnostic source and compiler output are current for this goal." };
    assert.equal((await harness.invoke("root", diagnosis, review)).phase, "diagnosis-repair-ready");
    const oldGoal = fs.readFileSync(path.join(root, specFile), "utf8");
    write(specFile, oldGoal + "Confirm the syntax repair under the revised owner objective.\n");
    await assert.rejects(harness.flow("root", "advance"), /版本已变化/u);
    await harness.invoke("root", diagnosis, { action: "triage", unit, layer: "syntax",
      reason: "The owner revised the current goal; reproduce under its new pin." });
    const fresh = await harness.flow("root", "advance");
    assert.notEqual(fresh.childId, investigator);
    assert.equal(fresh.reused, false);
    await harness.flow(fresh.childId, "prepare");
    await assert.rejects(harness.invoke(fresh.childId, diagnosis, { ...finding, proofId: proof.proofId }));
    const currentProof = await reproduceFinding("syntax", harness, fresh.childId);
    assert.notEqual(currentProof.snapshotSha256, proof.snapshotSha256);
    const current = await harness.invoke(fresh.childId, diagnosis, { ...finding, proofId: currentProof.proofId });
    assert.equal(current.stallDiagnostic.artifactSha256, submitted.stallDiagnostic.artifactSha256);
    assert.notEqual(current.stallDiagnostic.id, submitted.stallDiagnostic.id);
    await assert.rejects(harness.invoke("root", diagnosis, review));
    await harness.invoke("root", diagnosis, { ...review, evidenceId: current.stallDiagnostic.evidence.id });
    assert.equal((await harness.flow("root", "advance")).childId, executor);
  })));

test("a second stall uses a new investigator and returns both repairs to the original executor",
  () => fixture(async (root, write) => runWithRunner("syntax", async ({ requests }) => {
    configure(root, write, "syntax");
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    const finishInvestigation = async (investigator, proof, prepared) => {
      const finding = submission("syntax");
      const submitted = await harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.proofId });
      assert.equal(submitted.stallDiagnostic.id, prepared.stallDiagnostic.id);
      await harness.invoke("root", diagnosis, { action: "verify", unit, evidenceId: submitted.stallDiagnostic.evidence.id,
        decision: "confirmed", reason: "The current authorized compiler reproduced the described failure." });
      const repair = await harness.flow("root", "advance");
      assert.equal(repair.phase, "intake");
      assert.equal(repair.childId, executor);
      assert.equal(repair.reused, true);
      return harness.flow(executor, "prepare");
    };
    await forceStall("syntax", harness, executor, requests);
    const first = await startInvestigation("syntax", harness, executor);
    const firstPacket = await harness.flow(first, "prepare");
    const firstProof = await reproduceFinding("syntax", harness, first);
    const repair = await finishInvestigation(first, firstProof, firstPacket);
    assert.equal(repair.stallDiagnostic.evidence.proof.id, firstProof.proofId);

    // The first repair attempted a real edit. The new bytes still compile
    // incorrectly and must never inherit the first investigator's completion.
    const current = await harness.file(executor, "read", syntaxPath);
    const changed = await harness.file(executor, "edit", syntaxPath, { beforeSha256: current.sha256,
      oldText: "A boundary owner records identities.", newText: "The input boundary owns record identities.",
      note: "First scoped repair changed explanatory text while leaving the compiler fault." });
    assert.equal(changed.diagnostics.status, "failed");
    assert.notEqual(changed.sha256, current.sha256);
    await harness.invoke(executor, reproduction, { action: "check" });
    await harness.invoke(executor, reproduction, { action: "check" });
    const second = await startInvestigation("syntax", harness, executor);
    assert.notEqual(second, first);
    assert.deepEqual(harness.activations.map(x => x.childId), [executor, first, second]);
    assert.equal((await harness.flow(first, "status")).role, "idle");
    await assert.rejects(harness.invoke(first, reproduction, stallCases.syntax.probe));
    const secondPacket = await harness.flow(second, "prepare");
    assert.notEqual(secondPacket.stallDiagnostic.id, firstPacket.stallDiagnostic.id);
    assert.notEqual(secondPacket.stallDiagnostic.artifactSha256, firstPacket.stallDiagnostic.artifactSha256);
    await assert.rejects(harness.invoke(second, diagnosis, { ...submission("syntax"), proofId: firstProof.proofId }));
    const secondProof = await reproduceFinding("syntax", harness, second);
    assert.notEqual(secondProof.proofId, firstProof.proofId);
    const secondRepair = await finishInvestigation(second, secondProof, secondPacket);
    assert.equal(secondRepair.stallDiagnostic.evidence.proof.id, secondProof.proofId);
  })));


test("interrupted investigation and rejected evidence stay gated and resume the correct identity",
  () => fixture(async (root, write) => runWithRunner("syntax", async ({ requests }) => {
    configure(root, write, "syntax");
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    await harness.flow(executor, "prepare");
    await forceStall("syntax", harness, executor, requests);
    const investigator = await startInvestigation("syntax", harness, executor);
    await harness.flow(investigator, "prepare");
    const proof = await reproduceFinding("syntax", harness, investigator);
    await harness.interrupt(investigator, 21);
    assert.equal((await harness.flow("root", "status")).units[0].phase, "blocked");
    assert.equal((await harness.flow(investigator, "status")).role, "idle");
    await assert.rejects(harness.invoke(investigator, reproduction, stallCases.syntax.probe));
    const resumed = await harness.flow("root", "advance");
    assert.equal(resumed.phase, "diagnosis");
    assert.equal(resumed.childId, investigator);
    assert.equal(resumed.reused, true);
    await harness.flow(investigator, "prepare");
    const finding = submission("syntax");
    const submitted = await harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.proofId });
    const review = { action: "verify", unit, evidenceId: submitted.stallDiagnostic.evidence.id };
    const returned = await harness.invoke("root", diagnosis, { ...review, decision: "retry",
      reason: "Re-check the actual source lines before sending the repair back." });
    assert.equal(returned.phase, "diagnosis-ready");
    assert.equal(returned.stallDiagnostic.evidence, undefined);
    await assert.rejects(harness.flow("root", "advance"));
    await harness.invoke("root", diagnosis, { action: "triage", unit, layer: "syntax",
      reason: "Reproduce the current compiler result and verify the syntax finding." });
    const assignedAgain = await harness.flow("root", "advance");
    assert.equal(assignedAgain.childId, investigator);
    await harness.flow(investigator, "prepare");
    await assert.rejects(harness.invoke(investigator, diagnosis, { ...finding, proofId: proof.proofId }));
    await assert.rejects(harness.invoke("root", diagnosis, { ...review, decision: "confirmed",
      reason: "This earlier receipt was already retired." }));
    const current = await reproduceFinding("syntax", harness, investigator);
    assert.notEqual(current.proofId, proof.proofId);
    assert.equal((await harness.invoke(investigator, diagnosis, { ...finding, proofId: current.proofId })).phase,
      "diagnosis-verify");
  })));

test("two receiptless completions in one diagnosis require re-triage and a different read-only actor",
  () => fixture(async (root, write) => runWithRunner("syntax", async ({ requests }) => {
    configure(root, write, "syntax");
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    await forceStall("syntax", harness, executor, requests);
    const investigator = await startInvestigation("syntax", harness, executor);
    const finding = submission("syntax");
    const assigned = await harness.flow(investigator, "prepare");
    const earlierProof = await reproduceFinding("syntax", harness, investigator);
    await harness.interrupt(investigator, 21, "completed");
    assert.equal((await harness.flow("root", "status")).units[0].phase, "blocked");
    const resumed = await harness.flow("root", "advance");
    assert.equal(resumed.childId, investigator);
    assert.equal(resumed.reused, true);
    await assert.rejects(harness.invoke(investigator, reproduction, { action: "check" }), /prepare/u);
    await harness.interrupt(investigator, 23, "completed");
    const parked = (await harness.flow("root", "status")).units[0];
    assert.equal(parked.phase, "diagnosis-ready");
    assert.equal(parked.stallDiagnostic.id, assigned.stallDiagnostic.id);
    assert.equal((await harness.flow(investigator, "status")).role, "idle");
    await assert.rejects(harness.flow("root", "advance"));
    await harness.invoke("root", diagnosis, { action: "triage", unit, layer: "syntax",
      reason: "Two ends without a receipt need a replacement investigator and current evidence." });
    const replacement = await harness.flow("root", "advance");
    assert.notEqual(replacement.childId, investigator);
    assert.notEqual(replacement.childId, executor);
    await harness.flow(replacement.childId, "prepare");
    await assert.rejects(harness.invoke(replacement.childId, diagnosis, { ...finding, proofId: earlierProof.proofId }));
    const proof = await reproduceFinding("syntax", harness, replacement.childId);
    const result = await harness.invoke(replacement.childId, diagnosis, { ...finding, proofId: proof.proofId });
    await harness.invoke("root", diagnosis, { action: "verify", unit, evidenceId: result.stallDiagnostic.evidence.id,
      decision: "confirmed", reason: "The replacement reproduced the same pinned failure." });
    assert.equal((await harness.flow("root", "advance")).childId, executor);
  })));


test("repeated invalid parameters require actual corrected execution of the same recipe",
  () => fixture(async (root, write) => runWithRunner("syntax", async ({ requests }) => {
    configure(root, write, "syntax");
    const harness = diagnosticHost(root);
    const { childId: executor } = await harness.flow("root", "advance");
    await harness.flow(executor, "prepare");
    const invalid = { action: "probe", recipe: syntaxRecipe };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await harness.invoke(executor, reproduction, invalid);
      assert.equal(result.status, "invalid-input");
      assert.equal(result.field, "args");
    }
    assert.equal(requests.length, 0);
    const status = (await harness.flow("root", "status")).units[0];
    assert.equal(status.phase, "diagnosis-ready");
    assert.equal(status.stallDiagnostic.suggestedLayer, "parameters");
    assert.equal(status.stallDiagnostic.recipe, syntaxRecipe);
    const triage = { action: "triage", unit, layer: "parameters", reason: "The registered compiler requires one authorized source argument." };
    await harness.invoke("root", diagnosis, triage);
    const assigned = await harness.flow("root", "advance");
    const investigator = assigned.childId;
    await harness.flow(investigator, "prepare");
    const rejected = await harness.invoke(investigator, reproduction, invalid);
    assert.equal(rejected.status, "invalid-input");
    assert.equal(requests.length, 0);
    const attempted = await harness.invoke(investigator, reproduction, stallCases.syntax.probe);
    assert.equal(requests.length, 1);
    assert.equal(attempted.status, "failed");
    assert.equal(attempted.provenLayer, "parameters");
    const report = { action: "submit", unit, proofId: attempted.proofId,
      cause: "The registered compiler was called with no source argument.",
      fix: "Pass the exact authorized source path; then handle its actual compiler result independently." };
    await assert.rejects(harness.invoke(investigator, diagnosis, { ...report, file: syntaxPath, start: 1, end: 4 }));
    const submitted = await harness.invoke(investigator, diagnosis, report);
    assert.equal(submitted.stallDiagnostic.evidence.source, undefined);
    assert.equal(submitted.stallDiagnostic.evidence.proof.kind, "parameters-recovered");
    assert.equal(submitted.stallDiagnostic.evidence.proof.recovery, true);
    await harness.invoke("root", diagnosis, { action: "verify", unit, evidenceId: submitted.stallDiagnostic.evidence.id,
      decision: "confirmed", reason: "Corrected arguments reached the registered compiler for the current version." });
    const resumed = await harness.flow("root", "advance");
    assert.equal(resumed.childId, executor);
    assert.equal(resumed.reused, true);
    assert.equal((await harness.flow(executor, "prepare")).stallDiagnostic.evidence.replay.input.args[0], syntaxPath);
  })));
