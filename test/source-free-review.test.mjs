import assert from "node:assert/strict";
import test from "node:test";
import { QUALITY } from "../governance/preflight.mjs";
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
  assert.equal((await runner.flow(reviewer, "review", { checks: [] })).phase, "supplement-ready");
}));
