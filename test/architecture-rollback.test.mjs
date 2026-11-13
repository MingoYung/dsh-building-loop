import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { finishRollbackRehearsal, parseArchitectureRollback, prepareRollbackProposal, prepareRollbackRehearsal,
  rollbackRehearsalCurrent } from "../governance/architecture-rollback.mjs";
import { runInputContractBatch } from "../governance/code-diagnostics.mjs";
import { digest } from "../governance/policy.mjs";
import { architectureDocument } from "../governance/project-hierarchy.mjs";

const GOAL = "GOAL.md";
const SOURCE = "policy.js";
const DESIGN = "architecture.md";
const BASELINE = "private-before.js";
const REQUIREMENT = "After rollback, production planning succeeds and the staging cap remains four.";
const BEFORE = 'const production = "blocked";\nconst cap = 4;\n';
const RESTORED = 'const production = "ready";\nconst cap = 4;\n';
const DIAGNOSTICS = { protocol: 2, reviewRecipes: ["app", "syntax"], syntaxRecipe: "syntax" };

const contract = (id, input, expectedJson) => ({ id, input, expectedJson,
  requirement: { file: GOAL, start: 3, end: 3, quote: REQUIREMENT } });
const authority = () => ({ heading: "Rollback", files: [SOURCE], restore: [{ file: SOURCE, source: BASELINE }],
  contracts: [{ id: "rolled-back", recipe: "app", examples: [
    contract("production", { environment: "production" }, { result: "ready" }),
    contract("cap", { environment: "staging" }, { cap: 4 }),
  ] }] });

function fixture(t) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temp, "building-loop-rollback-")));
  t.after(() => {
    assert.equal(path.dirname(root), temp);
    assert.match(path.basename(root), /^building-loop-rollback-/u);
    fs.rmSync(root, { recursive: true });
  });
  const write = (file, contents) => fs.writeFileSync(path.join(root, file), contents);
  const read = file => fs.readFileSync(path.join(root, file), "utf8");
  const goals = "# Project\n\n" + REQUIREMENT + "\n\n## Index\n\n- [Index](INDEX.md)\n";
  write(GOAL, goals);
  write("INDEX.md", "# Index\n\n## Modules\n\n- [Architecture](architecture.md)\n");
  write(SOURCE, BEFORE);
  write(BASELINE, RESTORED);
  const spec = { architecture: { file: DESIGN, headings: ["Rollback"],
    rollback: parseArchitectureRollback(authority(), ["Rollback"], [SOURCE], DIAGNOSTICS, [GOAL]) } };
  const frame = { root, policy: { hash: digest("owner configuration"), hierarchy: {
    overview: { path: GOAL, heading: "Index" }, index: { path: "INDEX.md", heading: "Modules" },
  } } };
  const qualification = { receiptSha256: digest("verified qualification"), goalSha256: digest(goals),
    artifacts: [{ path: SOURCE, sha256: digest(BEFORE) }] };
  const plan = (value, closer = "```") => {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    write(DESIGN, "# Design\n\n## Rollback\n\nRestore only the previous production rule.\n\n" +
      "```json building-loop-rollback\n" + json + "\n" + closer + "\n");
    return architectureDocument(frame, spec.architecture, DIAGNOSTICS);
  };
  return { frame, spec, qualification, write, read, plan };
}

const edit = (oldText, newText, file = SOURCE) => ({ edits: [{ file, replacements: [{ oldText, newText }] }] });

/** Deterministic isolated runner replies exercise the same batch comparer used
 * by the host. The frozen archive separately exercises actual execution. */
async function observed(prepared, responses) {
  return runInputContractBatch(prepared.checks.map((check, index) => ({ check, job: { result: {
    status: "passed", snapshotSha256: digest(JSON.stringify([prepared.binding, check.id])),
    probe: { exitCode: 0, stdout: JSON.stringify(responses[index]), stderr: "", truncated: false },
  } } })), {});
}

test("rollback rehearsal binds an exact typed plan and reports selective rollback failures on a copy", async t => {
  const { frame, spec, qualification, write, read, plan } = fixture(t);
  const wrong = plan(edit('"blocked"', '"locked"'));
  assert.deepEqual([wrong.rollback.start, wrong.rollback.end], [7, 9]);
  const wrongPrepared = prepareRollbackRehearsal(frame, spec, qualification, wrong);
  assert.equal(Buffer.from(wrongPrepared.artifacts[0].contentBase64, "base64").toString(), BEFORE.replace("blocked", "locked"));
  const failed = finishRollbackRehearsal(wrongPrepared, await observed(wrongPrepared, [{ result: "locked" }, { cap: 4 }]));
  assert.equal(failed.status, "failed");
  assert.equal(failed.passed, 1);
  assert.equal(failed.failures[0].id, "rolled-back:example:production");
  assert.deepEqual(failed.failures[0].actual.json, { result: "locked" });
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, wrong, failed), false);

  const correct = plan(edit('"blocked"', '"ready"'));
  const prepared = prepareRollbackRehearsal(frame, spec, qualification, correct);
  assert.deepEqual(prepared.changed, [{ file: SOURCE, beforeSha256: digest(BEFORE), afterSha256: digest(RESTORED) }]);
  assert.equal(read(SOURCE), BEFORE);
  assert.equal(read(BASELINE), RESTORED);
  const passed = finishRollbackRehearsal(prepared, await observed(prepared, [{ result: "ready" }, { cap: 4 }]));
  assert.equal(passed.status, "passed");
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, correct, passed), true);
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, correct, passed, [], undefined, true), true);
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, correct, { ...passed, receipts: passed.receipts.slice(0, 1) }), false);
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, correct, { ...passed, failures: failed.failures }), false);
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, correct, { ...passed, changed: wrongPrepared.changed }), false);
  write(SOURCE, BEFORE + "// Changed during rehearsal.\n");
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, correct, passed, [], undefined, true), false);
  write(SOURCE, BEFORE);
  write(DESIGN, read(DESIGN).replace("previous", "prior"));
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, correct, passed), false);
  const refreshed = plan(edit('"blocked"', '"ready"'));
  write(GOAL, read(GOAL).replace("four", "five"));
  assert.throws(() => prepareRollbackRehearsal(frame, spec, qualification, refreshed), /条款已变化/u);
});

test("rollback rehearsal rejects foreign, concealed, ambiguous and stale steps", t => {
  const { frame, spec, qualification, write, plan } = fixture(t);
  assert.throws(() => plan(edit("cap", "limit", "another.js")), /局部替换/u);
  assert.throws(() => plan('{"edits":[],"edits":[],"restore":["policy.js"]}'), /局部替换/u);
  assert.throws(() => plan({ edits: null, restore: [SOURCE] }), /局部替换/u);
  assert.throws(() => plan(edit("cap", "limit"), ""), /闭合/u);
  write(DESIGN, "## Rollback\n\nRestores production.\n\n> ```json building-loop-rollback\n> {\"restore\":[\"policy.js\"]}\n> ```\n");
  const concealed = architectureDocument(frame, spec.architecture, DIAGNOSTICS);
  assert.throws(() => prepareRollbackRehearsal(frame, spec, qualification, concealed), /登记/u);
  write(DESIGN, "## Rollback\n\nRestores production.\n\n<div hidden>\n\n```json building-loop-rollback\n" +
    '{"restore":["policy.js"]}\n```\n\n</div>\n');
  assert.throws(() => architectureDocument(frame, spec.architecture, DIAGNOSTICS), /闭合/u);
  const absent = plan(edit("missing anchor", "new source"));
  assert.throws(() => prepareRollbackRehearsal(frame, spec, qualification, absent), /anchor-not-found/u);
  write(SOURCE, BEFORE + "// Unsigned change.\n");
  assert.throws(() => prepareRollbackRehearsal(frame, spec, qualification, absent), /已变化/u);
});

test("rollback baseline bytes must match a prior signed artifact and stay out of the runner inventory", t => {
  const { frame, spec, qualification, write, read, plan } = fixture(t);
  const restore = plan({ restore: [SOURCE] });
  assert.throws(() => prepareRollbackRehearsal(frame, spec, qualification, restore), /签名回退基线/u);
  const baseline = [{ path: SOURCE, sha256: digest(RESTORED) }];
  const prepared = prepareRollbackRehearsal(frame, spec, qualification, restore, baseline);
  assert.deepEqual(prepared.artifacts.map(row => row.path), [SOURCE]);
  assert.equal(Buffer.from(prepared.artifacts[0].contentBase64, "base64").toString(), RESTORED);
  assert.equal(read(SOURCE), BEFORE);
  write(BASELINE, BEFORE);
  assert.throws(() => prepareRollbackRehearsal(frame, spec, qualification, restore, baseline), /已变化/u);
});

test("rollback checks require an owner clause and cannot become current-source diagnostic examples", () => {
  const parse = value => parseArchitectureRollback(value, ["Rollback"], [SOURCE], DIAGNOSTICS, [GOAL]);
  assert.ok(parse(authority()));
  const missing = authority();
  delete missing.contracts[0].examples[0].requirement;
  assert.throws(() => parse(missing), /公开检查/u);
  const diagnosed = authority();
  diagnosed.contracts[0].examples[0].diagnosticCases = ["signed-case"];
  assert.throws(() => parse(diagnosed), /公开检查/u);
});

test("an opaque executor proposal must match the current signed source and exact private edits", async t => {
  const { frame, spec, qualification, plan } = fixture(t);
  const { edits } = edit('"blocked"', '"ready"');
  const proposal = prepareRollbackProposal(frame, spec, qualification, edits);
  assert.match(proposal.id, /^rollback-[a-f0-9]{64}$/u);
  assert.deepEqual(proposal.files, [SOURCE]);
  assert.throws(() => plan({ proposal: proposal.id, edits }), /局部替换/u);
  const reference = plan({ proposal: proposal.id });
  assert.equal(reference.rollback.proposal, proposal.id);
  assert.equal(Object.hasOwn(reference.rollback, "edits"), false);
  assert.throws(() => prepareRollbackRehearsal(frame, spec, qualification, reference), /当前已登记方案/u);
  assert.throws(() => prepareRollbackRehearsal(frame, spec, { ...qualification, goalSha256: digest("new goal") },
    reference, [], proposal), /重新登记/u);
  assert.throws(() => prepareRollbackRehearsal(frame, spec, qualification, reference, [],
    { ...proposal, edits: edit('"blocked"', '"other"').edits }), /重新登记/u);
  const prepared = prepareRollbackRehearsal(frame, spec, qualification, reference, [], proposal);
  assert.equal(prepared.binding.proposalId, proposal.id);
  const passed = finishRollbackRehearsal(prepared, await observed(prepared, [{ result: "ready" }, { cap: 4 }]));
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, reference, passed, [], proposal), true);
  assert.equal(rollbackRehearsalCurrent(frame, spec, qualification, reference, passed), false);
  const resigned = { ...qualification, receiptSha256: digest("fresh signature, equivalent signed source") };
  assert.equal(prepareRollbackRehearsal(frame, spec, resigned, reference, [], proposal).binding.proposalId, proposal.id);
  assert.equal(rollbackRehearsalCurrent(frame, spec, resigned, reference, passed, [], proposal), false);
});
