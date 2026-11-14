import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { digest } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";
import { fixture, host, policy } from "./helpers.mjs";

const metric = "{{building-loop:metric:C1}}";
const countId = "citation-lines:timing.csv";
const count = "{{building-loop:" + countId + "}}";
const draft = "# 样例\n\n- C1：本次两次记录的耗时相对降幅 " + metric + "。\n\n" + count + "\n";
const source = "phase,mean_ms\nbefore,120\nafter,96\n";

function setup(write) {
  const config = structuredClone(policy);
  config.coordinator.write = ["overview.md"];
  const unit = config.units.K01;
  unit.claims = ["C1"];
  unit.calculations = { C1: unit.calculations.C2 };
  unit.hostResults = { calculations: ["C1"], citationLines: ["timing.csv"] };
  unit.phases.intake = { read: ["candidate.md", "timing.csv"], write: ["candidate.md"] };
  unit.phases["first-review"].read.push("timing.csv");
  unit.phases["first-review"].evidence = ["timing.csv"];
  unit.phases["final-review"].evidence = ["timing.csv"];
  config.sourcePins = { "timing.csv": { sha256: digest(source), kind: "synthetic", locator: "fixture:timing" } };
  write("BUILDING-LOOP.json", JSON.stringify(config));
}

test("host writes approved values once and both blind reviews receive bound receipts", () => fixture(async (root, write) => {
  setup(write);
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  const preparation = await h.flow(executor, "prepare");
  assert.deepEqual(preparation.hostResultSlots.map(slot => slot.id), ["C1", countId]);
  const save = content => h.file(executor, "write", "candidate.md", { content, note: "撰写两次校准的结果和引用统计" });
  for (const value of ["19%", "20 ms", "20%"]) {
    await save(draft.replace(metric, value + "（出处：timing.csv 第 2-3 行）"));
    await h.file(executor, "read", "candidate.md");
    await assert.rejects(h.flow(executor, "submit"), /缺少宿主生成结果：C1/u);
  }
  const rendered = await save(draft);
  assert.match(rendered.hostResults[0].text, /20%（出处：timing\.csv 第 2-3 行）/u);
  assert.match(rendered.hostResults[1].text, /1行可识别同行引用（第3行）/u);
  const moved = await h.file(executor, "edit", "candidate.md", {
    beforeSha256: rendered.sha256, oldText: "# 样例", newText: "\n# 样例", note: "移动正文后更新实际物理行号",
  });
  assert.match(moved.hostResults[1].text, /第4行/u);
  await h.file(executor, "read", "candidate.md");
  await h.flow(executor, "submit");

  const reviewer = (await h.flow("root", "advance")).childId;
  const makeEntries = (blocks, reason) => blocks.map(block => ({ block: block.id, parts: [block.hostMeasurement ? {
    kind: "direct", status: "supported", sourceRelation: "supports", measurement: block.hostMeasurement.id, basis: reason,
  } : { kind: "nonfactual", status: "supported", basis: "标题只标识同一次样例" }] }));
  const firstReason = "所引基准与对照均为本样例毫秒记录，稿件引用统计以样例正文的同一来源定位为界";
  await h.file(reviewer, "read", "overview.md");
  await h.file(reviewer, "read", "candidate.md");
  const inventory = await h.coverage(reviewer, "inventory");
  const entries = makeEntries(inventory.blocks, firstReason);
  const metricEntry = entries.find(entry => entry.parts[0].measurement === "C1");
  await assert.rejects(h.coverage(reviewer, "record", { entries: [metricEntry] }), /实际读过的当前原文行/u);
  await h.file(reviewer, "read", "timing.csv");
  await assert.rejects(h.coverage(reviewer, "record", { entries: [{
    block: metricEntry.block, parts: [{ kind: "nonfactual", status: "supported", basis: "测试将指标伪装为无事实标题" }],
  }] }), /宿主结果块/u);
  const scopedRejection = await h.coverage(reviewer, "record", {
    entries: [{ block: metricEntry.block, parts: [{
      ...metricEntry.parts[0], status: "unsupported", sourceRelation: "insufficient",
      basis: "基准与对照可算出这个比例，但原始表并不定义样本的使用范围",
      finding: { kind: "scope", quote: "本次两次记录", fix: "补充本次校准样本的范围证明" },
    }] }],
  });
  assert.equal(scopedRejection.rejected[0].finding.kind, "scope");
  await h.coverage(reviewer, "record", { entries });
  await h.assess(reviewer, {
    ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "核对了实测记录和本样例的适用范围"])),
    goalFit: { pass: true, basis: "数据来自同一份样例且已给出实际引用" },
    sourceRefs: [], revise: [], unverifiedSources: [], unlisted: [],
  });
  assert.equal((await h.flow(reviewer, "review")).phase, "first-audit-ready");

  const auditor = (await h.flow("root", "advance")).childId;
  assert.notEqual(auditor, reviewer);
  await assert.rejects(h.file(auditor, "read", "first.json"), /白名单/u);
  for (const file of ["overview.md", "candidate.md", "timing.csv"]) await h.file(auditor, "read", file);
  const independent = await h.coverage(auditor, "inventory");
  assert.equal(independent.pending.length, independent.total);
  const auditReason = "两条原始时间记录和基准选择支持样例内结论，引用计数按当前稿的物理行重算";
  await h.coverage(auditor, "record", { entries: makeEntries(independent.blocks, auditReason) });
  assert.equal((await h.flow(auditor, "audit")).phase, "ledger-review");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(receipt.checks[0].supportOrigin.kind, "same-reviewer-host-measurement");
  const first = receipt.hostMeasurements.find(row => row.id === "C1");
  const second = receipt.independentAudit.hostMeasurements.find(row => row.id === "C1");
  assert.equal(first.expected, "20%");
  assert.equal(first.sourceHash, digest(source));
  assert.deepEqual(first.sourceRows.map(row => row.line), [2, 3]);
  assert.equal(first.basis.before, "before");
  assert.equal(first.reviewBasis, firstReason);
  assert.equal(second.reviewBasis, auditReason);
  assert.deepEqual(receipt.independentAudit.hostMeasurements.find(row => row.id === countId).lines, [4]);
}));

test("ambiguous metric blocks the unit until the owner updates the scope, then reuses the executor", () =>
  fixture(async (root, write) => {
    setup(write);
    const h = host(root, { automaticCoverage: false });
    const executor = (await h.flow("root", "advance")).childId;
    const question = "这里的降幅按本次两次记录还是按批次均值统计？";
    const blocked = await h.flow(executor, "block", {
      note: "同一目标中有两种样本范围，需要用户选择", metricClarification: { id: "C1", question },
    });
    assert.equal(blocked.phase, "blocked");
    const status = await h.flow("root", "status");
    assert.equal(status.units[0].outcomeClarification.items[0].question, question);
    await assert.rejects(h.flow("root", "advance"), /等待用户澄清口径/u);
    await h.file("root", "write", "overview.md", {
      content: "# 当前项目\n\n用户选择本次两条校准记录作为唯一统计范围。\n",
      note: "登记用户确定的统计范围",
    });
    assert.equal((await h.flow("root", "advance")).childId, executor);
  }));

test("a classified and already sourced fact with no same-line locator goes back to the same author", () =>
  fixture(async (root, write) => {
    setup(write);
    const config = JSON.parse(fs.readFileSync(path.join(root, "BUILDING-LOOP.json"), "utf8"));
    const unit = config.units.K01;
    unit.claims.push("C2");
    for (const stage of ["supplement", "first-review", "final-review"]) {
      if (!unit.phases[stage].read.includes("functional.csv")) unit.phases[stage].read.push("functional.csv");
      if (unit.phases[stage].evidence && !unit.phases[stage].evidence.includes("functional.csv")) unit.phases[stage].evidence.push("functional.csv");
    }
    write("BUILDING-LOOP.json", JSON.stringify(config));
    const h = host(root, { automaticCoverage: false });
    const writer = (await h.flow("root", "advance")).childId;
    const original = draft + "\nC2：另一次记录有十九项通过。\n";
    await h.file(writer, "write", "candidate.md", { content: original, note: "第一版交付" });
    await h.file(writer, "read", "candidate.md");
    await h.flow(writer, "submit");
    const reviewer = (await h.flow("root", "advance")).childId;
    for (const file of ["overview.md", "candidate.md", "timing.csv", "functional.csv"]) await h.file(reviewer, "read", file);
    const { blocks } = await h.coverage(reviewer, "inventory");
    const direct = { kind: "direct", status: "supported", sourceRelation: "supports", basis: "只核原始记录支持的样例范围" };
    const ref = { file: "functional.csv", start: 2, end: 2, quote: "19,20" };
    await h.coverage(reviewer, "record", { entries: blocks.map(block => ({
      block: block.id, parts: [block.hostMeasurement ? { ...direct, measurement: block.hostMeasurement.id }
        : block.text.startsWith("C2") ? { ...direct, evidence: [ref] }
          : { kind: "nonfactual", status: "supported", basis: "这一行是样例标题" }],
    })) });
    await assert.rejects(h.flow(reviewer, "review", {
      checks: [{ id: "C2", ...direct, file: "timing.csv", start: 2, end: 2 }],
    }), /未出现在候选断言的同行出处/u);
    const reviewed = await h.flow(reviewer, "review", {
      checks: [{ id: "C2", status: "supported", basis: direct.basis, file: ref.file, start: 2, end: 2 }],
    });
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
    assert.equal(reviewed.phase, "supplement-ready");
    assert.equal(receipt.decision, "reject");
    assert.equal(receipt.checks.find(row => row.id === "C2").findingOrigin.kind, "host-missing-numbered-locator");
    assert.equal((await h.flow("root", "advance")).childId, writer);
    const current = await h.file(writer, "read", "candidate.md");
    await h.file(writer, "read", "functional.csv");
    await h.file(writer, "edit", "candidate.md", {
      beforeSha256: current.sha256, oldText: "C2：另一次记录有十九项通过。",
      newText: "C2：另一次记录有十九项通过（出处：functional.csv 第 2 行）。", note: "补齐同行出处",
    });
    await h.file(writer, "read", "candidate.md");
    const preflight = await h.flow(writer, "preflight");
    assert.equal(preflight.ok, true, JSON.stringify(preflight));
  }));
