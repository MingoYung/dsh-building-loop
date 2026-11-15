import assert from "node:assert/strict";
import test from "node:test";

import { coveragePageGuidance } from "../governance/phase-context.mjs";
import { fixture, host, policy } from "./helpers.mjs";

test("role prompts identify versioned files and prepare returns only unread current bytes", async () => fixture(async (root, write) => {
  const config = structuredClone(policy);
  config.instructions = ["rules.md"];
  config.goalContext = ["overview.md"];
  config.coordinator.read.push("rules.md");
  write("rules.md", "规则内容首次版本\n");
  write("overview.md", "目标内容正文\n");
  write("BUILDING-LOOP.json", JSON.stringify(config));

  const harness = host(root, { automaticCoverage: false });
  const executor = (await harness.flow("root", "advance")).childId;
  for (const actor of ["root", executor]) {
    const prompt = harness.prompt(actor);
    assert.match(prompt, /building_loop prepare/);
    assert.match(prompt, /"goalFiles":\["overview.md"\],"instructionFiles":\["rules.md"\]/);
    assert.doesNotMatch(prompt, /规则内容首次版本|目标内容正文/);
  }
  const packet = await harness.flow(executor, "prepare");
  assert.equal(packet.files.find(file => file.path === "overview.md").lines[0][1], "目标内容正文");
  assert.equal(packet.files.find(file => file.path === "rules.md").lines[0][1], "规则内容首次版本");
  assert.deepEqual((await harness.flow(executor, "prepare")).files, []);

  write("rules.md", "规则内容第二版本\n");
  const update = await harness.flow(executor, "prepare");
  assert.deepEqual(update.files.map(({ path, lines }) => [path, lines[0][1]]), [["rules.md", "规则内容第二版本"]]);
}));

test("footnote and example instructions follow the applicable coverage page", async () => fixture(async (root, write) => {
  const config = structuredClone(policy);
  config.units.K01.claims = [];
  config.units.K01.calculations = {};
  write("BUILDING-LOOP.json", JSON.stringify(config));
  const headlines = Array.from({ length: 24 }, (_, index) => "# 标题 " + (index + 1)).join("\n");
  write("candidate.md", headlines + "\n\n「样本通过」[^pin]。\n\n错例：只凭分母为正就推断因果。\n\n[^pin]: functional.csv 第 2 行。\n");
  const harness = host(root, { automaticCoverage: false });
  const executor = (await harness.flow("root", "advance")).childId;
  await harness.flow(executor, "prepare");
  await harness.flow(executor, "submit");
  const reviewer = (await harness.flow("root", "advance")).childId;
  assert.match(harness.prompt(reviewer), /原始事实和稿件自述分别核/);
  assert.doesNotMatch(harness.prompt(reviewer), /读同名定义|原文明示的错例|outcomeContract/);

  const prepared = await harness.flow(reviewer, "prepare");
  assert.equal(prepared.coverage.blocks.length, 24);
  assert.equal(prepared.coverage.next.offset, 24);
  assert.equal(prepared.contract.footnoteRule, undefined);
  assert.equal(prepared.contract.errorExampleRule, undefined);
  assert.match(prepared.contract.factualRejection, /实际错误断言/);
  assert.match(prepared.qualityInstructions, /实际来源/);
  assert.equal(prepared.outcomeInstructions, undefined);

  const later = await harness.coverage(reviewer, "inventory", { offset: 24, count: 12 });
  assert.match(later.guidance.footnoteRule, /同名定义/);
  assert.match(later.guidance.errorExampleRule, /错例不得作为已证前提/);
  assert.equal(later.guidance.nonEntailmentRule, undefined);
  assert.equal((await harness.coverage(reviewer, "status")).guidance, undefined);
}));

test("page hints remain separately tied to real inventory objects", () => {
  const guidance = coveragePageGuidance([{
    text: "[模拟] 大白话：记录不能推出因果。",
    neutralSpans: [[6, 10]],
    inferenceHint: { rule: "bounded-non-entailment" },
    objectCheckHint: { kind: "registered-excerpts" },
  }]);
  assert.match(guidance.simulationRule, /实际来源范围/);
  assert.match(guidance.neutralSpanRule, /neutralSpans/);
  assert.match(guidance.nonEntailmentRule, /证实非 P/);
  assert.match(guidance.objectCheckExamples.note, /expected/);
  assert.equal(guidance.footnoteRule, undefined);
  assert.deepEqual(coveragePageGuidance([{ text: "普通事实" }]), {});
});
