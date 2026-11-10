import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { authority } from "../governance/policy.mjs";
import { numericChecks, plainLastIssues, QUALITY, requiredLineMarkdown } from "../governance/preflight.mjs";
import { fixture, host, policy } from "./helpers.mjs";

const fact = "- C1：本例通过 19/20（出处：functional.csv 第 2 行）。";
const source = { file: "functional.csv", start: 2, end: 2, quote: "19,20" };
const supported = { ...source, id: "C1", status: "supported", basis: "实际 CSV 行明确记录 19/20。" };
const quality = () => Object.fromEntries(Object.keys(QUALITY).map(key => [key, "保留原始数字、实际适用范围和读者解释。"]));
const timingClaim = value => `- C2：样例耗时 ${value}（出处：timing.csv 第 1 行）。`;

function timingPolicy(write) {
  const config = structuredClone(policy);
  const unit = config.units.K01;
  unit.calculations.C2 = { kind: "source-number", source: "timing.csv", line: 1,
    sourceUnit: "ms", units: ["ms", "毫秒"], scope: "document" };
  unit.phases["first-review"].read.push("timing.csv");
  unit.phases["first-review"].evidence.push("timing.csv");
  write("BUILDING-LOOP.json", JSON.stringify(config));
  write("timing.csv", "sample duration 24 ms\n");
}

test("supplement tools reject the complete wrong unit before final review", () => fixture(async (root, write) => {
  timingPolicy(write);
  const draft = value => [fact, timingClaim(value)].join("\n") + "\n";
  write("candidate.md", draft("24%"));
  const h = host(root);
  const first = (await h.flow("root", "advance")).childId;
  await h.flow(first, "prepare");
  await h.flow(first, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  await h.flow(reviewer, "prepare");
  const result = await h.flow(reviewer, "review", { checks: [supported, {
    id: "C2", status: "unsupported",
    basis: "计时原始数据登记毫秒，原稿错误使用了百分比。",
    finding: { kind: "missing-evidence", quote: "24%", fix: "从 timing.csv 核对完整的时间单位。" },
  }] });
  assert.equal(result.phase, "supplement-ready");
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  for (const value of ["24 ms/s", "24 ms²", "24 ms，另称 24%", "24 ms⁻¹"]) {
    await h.file(executor, "write", "candidate.md", { content: draft(value), note: "尝试修订时间单位" });
    await h.file(executor, "read", "candidate.md");
    const checked = await h.flow(executor, "preflight");
    assert.equal(checked.ok, false, value);
    assert.match(checked.issues.join("\n"), /C2 本条直接转述/u, value);
    await assert.rejects(h.flow(executor, "submit", { quality: quality() }), /C2 本条直接转述/u, value);
  }
  await h.file(executor, "write", "candidate.md", { content: draft("24.0 毫秒"), note: "按原始数值及登记单位修订" });
  await h.file(executor, "read", "candidate.md");
  assert.equal((await h.flow(executor, "preflight")).ok, true);
  assert.equal((await h.flow(executor, "submit", { quality: quality() })).phase, "final-review-ready");
}));

test("source-number uses the same case-sensitive and operator-aware unit boundary in each scope", () => fixture((root, write) => {
  timingPolicy(write);
  const unit = authority(root).units.K01;
  const check = (value, extra = []) => numericChecks(root, unit, [timingClaim(value), ...extra], ["timing.csv"])[0];
  for (const value of ["24 ms", "24.0 ms", "24毫秒", "２４ ｍｓ", "24 毫秒后结束", "*24 ms*后结束"]) assert.equal(check(value).ok, true, value);
  for (const value of ["24 ms/s", "24 ms²", "24 ms^2", "24 ms2", "24 ms / s", "24 ms·s", "24 ms s", "24 msV", "24 mS", "24 毫秒每秒", "24%", "0.024 s"]) {
    assert.equal(check(value).ok, false, value);
  }
  assert.equal(check("24 ms", ["单独记录样品质量 37 mg。"]).ok, true);
  for (const value of ["24 ms²", "24 ms/s", "24 ms / s"]) {
    assert.match(check("24 ms", [`另一段误写本例耗时 ${value}。`]).documentIssues[0].issue, /完整单位/u, value);
    write("timing.csv", `sample duration ${value}\n`);
    assert.match(check("24 ms").issue, /数值与完整单位/u, value);
    write("timing.csv", "sample duration 24 ms\n");
  }
}));

test("percentage recomputation requires a complete result unit and retains the formula multiplier", () => fixture(root => {
  const unit = authority(root).units.K01;
  const check = value => numericChecks(root, unit, ["- C2：" + value + "（出处：timing.csv 第 2-3 行）。"], ["timing.csv"])[0];
  assert.equal(check("耗时下降 20%，公式是 (120−96)/120×100%").ok, true);
  for (const value of ["耗时下降 20%/秒", "耗时下降 20%²", "耗时下降 20%，公式乘以 ×100%/s"]) assert.equal(check(value).ok, false, value);
}));

for (const opener of ["<!--", "<details>"]) {
  test(`registered submit and review allow real prose after a quote containing ${opener}`, () => fixture(async (root, write) => {
    const config = structuredClone(policy);
    config.goalContext = ["overview.md"];
    config.requiredLinesGoal = "overview.md";
    const unit = config.units.K01;
    unit.claims = ["C1"];
    unit.calculations = {};
    unit.plainLast = true;
    const literal = "- 这句必须原样保留。";
    write("BUILDING-LOOP.json", JSON.stringify(config));
    write("overview.md", "```building-loop-required-lines\n" + JSON.stringify([{ unit: "K01", lines: [literal] }]) + "\n```\n");
    write("candidate.md", ["> 参考摘录", literal, "", fact, "", `> ${opener}`, "> 范例文字", "# 大白话", "把状态和结果分开看。"].join("\r\n"));
    const h = host(root);
    const executor = (await h.flow("root", "advance")).childId;
    await h.flow(executor, "prepare");
    assert.equal((await h.flow(executor, "submit")).phase, "review-ready");
    const reviewer = (await h.flow("root", "advance")).childId;
    await h.flow(reviewer, "prepare");
    await h.assess(reviewer, { ...quality(), sourceRefs: [source], unverifiedSources: [], unlisted: [], revise: [],
      goalFit: { pass: true, basis: "核对已读目标和 CSV 数据。" } });
    assert.equal((await h.flow(reviewer, "review", { checks: [supported] })).phase, "ledger-review");
  }));
}

test("shared Markdown structure keeps footnotes, code, and continued HTML out of visible prose", () => {
  const raw = ["# 正文", "[^n]: 来源说明", "    脚注内原句。", "", "<details>", "", "藏在 HTML 的原句。", "",
    "```building-loop-required-lines", "[]", "```", "", "</details>", "", "> 参考摘要", "引用续行。", "- 正文列表原句。"];
  const inspected = requiredLineMarkdown(raw);
  assert.deepEqual(inspected.fences, []);
  assert.deepEqual(inspected.live, raw.map((_, index) => [0, 16].includes(index)));
  assert.equal(plainLastIssues({}, ["[^n]: 来源说明", "    大白话：仍在脚注。"]).length, 1);
  assert.equal(plainLastIssues({}, ["- 正文项目", "  大白话：仍在列表内。"]).length, 1);
  assert.equal(plainLastIssues({}, ["# 大白话", "", "`只有代码` "]).length, 1);
  assert.deepEqual(plainLastIssues({}, ["- 正文项目", "大白话：作为独立末段。"]), []);
});

test("G2 keeps an exact standalone footnote and rejects quote or footer swallowed by its definition", () => fixture(async (root, write) => {
  const config = structuredClone(policy);
  config.goalContext = ["overview.md"];
  config.requiredLinesGoal = "overview.md";
  const unit = config.units.K01;
  unit.claims = ["C1"];
  unit.calculations = {};
  unit.plainLast = true;
  const nist = "sources/nist-scatter.md";
  unit.phases.supplement.read.push("functional.csv", nist);
  unit.phases["final-review"].read.push(nist);
  unit.phases["final-review"].evidence.push(nist);
  fs.mkdirSync(path.join(root, "sources"));
  write(nist, "# NIST\n\n本地登记\n\n原始短摘录\nassociation does NOT imply causality.\n");
  write("BUILDING-LOOP.json", JSON.stringify(config));
  const goal = value => "```building-loop-required-lines\n" + JSON.stringify(value) + "\n```\n";
  const footer = "大白话：把完成状态、实际结果和证据能说明的范围分开看。";
  const quote = "原文为“association does NOT imply causality.”[^nist-original]";
  const definition = "[^nist-original]: sources/nist-scatter.md 第 6 行。";
  write("overview.md", goal([]));
  write("candidate.md", fact.replace("19/20", "20/20") + "\n\n" + footer);
  const h = host(root);
  const first = (await h.flow("root", "advance")).childId;
  await h.flow(first, "prepare");
  await h.flow(first, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  await h.flow(reviewer, "prepare");
  assert.equal((await h.flow(reviewer, "review", { checks: [{ id: "C1", status: "unsupported", basis: "当前 CSV 不支持 20/20。",
    finding: { kind: "missing-evidence", quote: "20/20", fix: "按实际 CSV 修改。" } }] })).phase, "supplement-ready");
  write("overview.md", goal([{ unit: "K01", lines: [quote, definition], requiredMarkers: ["[稿件自述]", "[摘录范围]"],
    requiredCitationProfile: "functional.csv" }]));
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  const body = [fact, "[模拟] 本地样例引用同一条记录（出处：functional.csv 第 2 行）。",
    "- [摘录范围] 此处只说明本地登记。", "- [稿件自述] 行号定位 2 行：带 functional.csv 的行号定位为第 1-2 行；同带 [模拟] 1 行：第 2 行。", ""];
  const setTail = async tail => {
    await h.file(executor, "write", "candidate.md", { content: [...body, ...tail, ""].join("\r\n"), note: "保留 G2 原句并检查脚注边界。" });
    await h.file(executor, "read", "candidate.md");
    return h.flow(executor, "preflight");
  };
  for (const tail of [[quote, "", definition, footer], [definition, quote, footer]]) {
    const blocked = await setTail(tail);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.requiredLines.passed, false);
    assert.match(blocked.issues.join("\n"), /仍属于上一脚注定义/u);
    assert.match(blocked.issues.join("\n"), /在脚注定义之后插入空行/u);
    await assert.rejects(h.flow(executor, "submit", { quality: quality() }), /脚注定义之后插入空行/u);
  }
  const indented = await setTail([quote, "", definition, "    另一个真实脚注段落。", "", footer]);
  assert.equal(indented.requiredLines.passed, false);
  const repaired = await setTail([quote, "", definition, "", footer]);
  assert.equal(repaired.ok, true, JSON.stringify(repaired.issues));
  assert.equal(repaired.requiredLines.citationProfileRequired, true);
  assert.equal(repaired.requiredLines.passed, true);
  assert.equal((await h.flow(executor, "submit", { quality: quality() })).phase, "final-review-ready");
}));
