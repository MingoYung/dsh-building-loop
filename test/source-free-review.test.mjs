import assert from "node:assert/strict";
import test from "node:test";
import { QUALITY, rejectedClaims, supplementChecks } from "../governance/preflight.mjs";
import { documentCoverage } from "../governance/coverage.mjs";
import { fixture, host, policy } from "./helpers.mjs";

const judgement = {
  ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "按现行目标核对候选，依据及限制如实记录。"])),
  goalFit: { pass: true, basis: "检查交付与当前任务范围。" },
  revise: [], sourceRefs: [], unverifiedSources: [], unlisted: [],
};
const nonfactual = { kind: "nonfactual", status: "supported", basis: "该段只是步骤或标题，未对外部现实作断言。" };

/** Exercise actual registered stages with no evidence grants or numbered claims. */
async function firstReview(root, write, manuscript) {
  const manifest = structuredClone(policy);
  const unit = manifest.units.K01;
  unit.claims = [];
  unit.calculations = {};
  unit.requireSourcePins = true;
  for (const phase of ["first-review", "final-review"]) {
    unit.phases[phase].read = [unit.candidate];
    unit.phases[phase].evidence = [];
  }
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  write("overview.md", "# 项目目标\n提供供用户执行的检查清单。\n");
  write("candidate.md", manuscript);
  const runner = host(root, { automaticCoverage: false });
  const executor = (await runner.flow("root", "advance")).childId;
  await runner.flow(executor, "prepare");
  await runner.flow(executor, "submit");
  const reviewer = (await runner.flow("root", "advance")).childId;
  const packet = await runner.flow(reviewer, "prepare");
  return { runner, reviewer, blocks: packet.coverage.blocks };
}

test("a source-free checklist passes both full-coverage reviews without inventing a citation", async () => fixture(async (root, write) => {
  const { runner, reviewer, blocks } = await firstReview(root, write, "# 检查清单\n\n先记录当前版本。\n再按步骤尝试复现。\n");
  await runner.coverage(reviewer, "record", { entries: blocks.map(block => ({ block: block.id, parts: [nonfactual] })) });
  assert.deepEqual((await runner.assess(reviewer, judgement)).observedSources, []);
  assert.equal((await runner.flow(reviewer, "review", { checks: [] })).phase, "first-audit-ready");
  const auditor = (await runner.flow("root", "advance")).childId;
  assert.notEqual(auditor, reviewer);
  const audit = await runner.flow(auditor, "prepare");
  await runner.coverage(auditor, "record", { entries: audit.coverage.blocks.map(block => ({ block: block.id, parts: [nonfactual] })) });
  assert.equal((await runner.flow(auditor, "audit")).phase, "ledger-review");
}));

test("a source-free draft still returns an unsupported factual assertion for repair", async () => fixture(async (root, write) => {
  const sentence = "此服务的请求全部成功。";
  const { runner, reviewer, blocks } = await firstReview(root, write, "# 检查清单\n\n" + sentence + "\n");
  const fact = { kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis: "没有获授权的观测结果能支持全部成功。",
    finding: { kind: "missing-evidence", quote: sentence, fix: "删除断言或补充实际记录。" } };
  await runner.coverage(reviewer, "record", { entries: [
    { block: blocks[0].id, parts: [nonfactual] }, { block: blocks[1].id, parts: [fact] },
  ] });
  await runner.assess(reviewer, judgement);
  // A full-text block is a location in this draft, never a numbered check.
  const pseudoClaim = { id: blocks[1].id, status: "unsupported", line: blocks[1].line,
    basis: fact.basis, finding: fact.finding };
  await assert.rejects(runner.flow(reviewer, "review", { checks: [pseudoClaim] }), /checks 仅提交/u);
  assert.equal((await runner.flow("root", "status")).units[0].phase, "first-review");
  assert.equal((await runner.flow(reviewer, "review", { checks: [] })).phase, "supplement-ready");
}));

test("an old duplicate coverage check returns to review only after its recorded span is repaired", () => {
  const sentence = "此服务的请求全部成功。";
  const lines = ["# 复盘", sentence];
  const block = documentCoverage(Buffer.from(lines.join("\n"))).blocks[1];
  const spec = { claims: [], calculations: {}, plainLast: false, phases: { "final-review": { evidence: [] } } };
  const rejected = rejectedClaims("", spec, lines, [{ id: block.id, line: block.line }], []);
  const active = { unsupported: [block.id], rejected, coverageRejections: [
    { block: block.id, line: block.line, lineText: sentence, finding: { quote: sentence } },
  ] };
  const unchanged = supplementChecks("", spec, ["# 另一个标题", sentence], [], active);
  assert.equal(unchanged.ok, false);
  assert.deepEqual(unchanged.repairs[0].unresolved, [2]);
  const repairedLines = ["# 复盘", "没有记录可判断所有请求的结果。"];
  const repaired = supplementChecks("", spec, repairedLines, [], active);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.repairs[0].resolution, "removed-or-rewritten");
  const required = { ...spec, claims: [block.id] };
  assert.equal(supplementChecks("", required, repairedLines, [], active).ok, false);
  for (const coverageRejections of [[], [{ ...active.coverageRejections[0], lineText: "没有对应旧行。" }]]) {
    assert.equal(supplementChecks("", spec, repairedLines, [], { ...active, coverageRejections }).ok, false);
  }
});
