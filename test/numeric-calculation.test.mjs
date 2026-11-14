import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { authority, digest } from "../governance/policy.mjs";
import { configuredNumericMeasurements, numericChecks, QUALITY } from "../governance/preflight.mjs";
import { fixture, host, policy } from "./helpers.mjs";

const csv = "group,amount,passed,total\nA,10.4,1,2\nB,80,9,10\nA,-1.2,9,10\n";
const source = "summary.csv";
const unit = "ms";
const base = { source, where: { column: "group", equals: "A" } };
const rules = {
  C1: { ...base, kind: "count", units: ["条"] },
  C2: { ...base, kind: "sum", valueColumn: "amount", units: [unit] },
  C3: { ...base, kind: "average", valueColumn: "amount", units: [unit] },
  C4: { ...base, kind: "ratio", numeratorColumn: "passed", denominatorColumn: "total" },
  C5: { kind: "unit-conversion", source: "reading.md", line: 2, sourceUnit: "ms", targetUnit: "s", decimals: 4 },
};

function install(write, transform = () => {}) {
  const config = structuredClone(policy);
  const unit = config.units.K01;
  unit.claims = Object.keys(rules);
  unit.calculations = structuredClone(rules);
  unit.hostResults = { calculations: unit.claims, citationLines: [source] };
  const evidence = [source, "reading.md"];
  for (const phase of Object.values(unit.phases)) {
    phase.read.push(...evidence);
    phase.evidence?.push(...evidence);
  }
  unit.phases.intake.write = ["candidate.md"];
  transform(unit);
  write("BUILDING-LOOP.json", JSON.stringify(config));
  write(source, csv);
  write("reading.md", "# Timing\nElapsed 24 ms.\n");
}

test("declared population, weighted denominator and unit conversion produce traceable host values", () =>
  fixture((root, write) => {
    install(write);
    const spec = authority(root).units.K01;
    const readable = [source, "reading.md"];
    const measurements = configuredNumericMeasurements(root, spec, readable);
    assert.deepEqual(measurements.map(item => item.expected), ["2 条", "9.2 ms", "4.6 ms", "83.33%", "0.024 s"]);
    assert.deepEqual(measurements[3].sourceRows, [
      { line: 1, quote: "group,amount,passed,total" },
      { line: 2, quote: "A,10.4,1,2" },
      { line: 4, quote: "A,-1.2,9,10" },
    ]);
    assert.equal(measurements[3].sourceHash, digest(Buffer.from(csv)));
    assert.equal(measurements[4].sourceValue, "24");
    const checks = (id, value, cite, file = source) => numericChecks(root, spec,
      [`- ${id}：结果为 ${value}（出处：${file} 第 ${cite} 行）。`], readable).find(row => row.id === id);
    assert.deepEqual(checks("C4", "83.33%", "1–4").sourceRows, [1, 2, 4]);
    assert.equal(checks("C4", "83.33%", "1–4").ok, true);
    assert.match(checks("C4", "83.33%", "2–4").issue, /全部原始行/u);
    assert.equal(checks("C4", "70%", "1–4").ok, false, "averaging row ratios uses the wrong denominator");
    assert.equal(checks("C5", "0.024 s", "2", "reading.md").ok, true);
    for (const wrong of ["24 s", "0.024 s²", "0.024 ms"]) assert.equal(checks("C5", wrong, "2", "reading.md").ok, false);
    assert.equal(checks("C5", "0.024 s，或为 8", "2", "reading.md").ok, false);
  }));

test("negative exact sums and half-away-from-zero rounding remain usable by the guard", () =>
  fixture((root, write) => {
    install(write, spec => { spec.calculations.C3.decimals = 1; });
    write(source, "group,amount,passed,total\nA,-0.25,0,1\n");
    const spec = authority(root).units.K01;
    const measurements = configuredNumericMeasurements(root, spec, [source]);
    assert.equal(measurements[1].expected, "-0.25 ms");
    assert.equal(measurements[2].expected, "-0.3 ms");
    assert.equal(numericChecks(root, spec,
      ["- C3：结果为 −0.3 ms（出处：summary.csv 第 1–2 行）。"], [source])[2].ok, true);
  }));

test("invalid population data, missing grants and unit dimensions fail without invented values", () =>
  fixture((root, write) => {
    install(write);
    const spec = authority(root).units.K01;
    const measurements = readable => configuredNumericMeasurements(root, spec, readable);
    assert.equal(measurements([]).every(row => !row.available && !Object.hasOwn(row, "value")), true);
    write(source, "group,amount,passed,total\nA,12,1,0\n");
    assert.match(measurements([source])[3].issue, /分母/u);
    write(source, "group,amount,passed,total\nA,unknown,1,2\n");
    assert.match(measurements([source])[1].issue, /十进制/u);
    write(source, "group,amount,passed,total\nB,12,1,2\n");
    assert.equal(measurements([source]).slice(0, 4).every(row => !row.available), true);
    install(write, spec => { spec.calculations.C5.targetUnit = "kg"; });
    assert.throws(() => authority(root), /同量纲/u);
    install(write, spec => { spec.phases.intake.read = ["candidate.md"]; });
    assert.throws(() => authority(root), /两个执行阶段/u);
    install(write, spec => { spec.hostResults.calculations = ["C0"]; });
    assert.throws(() => authority(root), /已配置/u);
  }));

test("legacy measurements keep raw before-after values and direct source aliases", () =>
  fixture((root, write) => {
    let spec = authority(root).units.K01;
    const [legacy] = configuredNumericMeasurements(root, spec, ["timing.csv"]);
    assert.equal(legacy.expected, "20%");
    assert.deepEqual(legacy.before, { raw: "120", line: 2 });
    assert.deepEqual(legacy.after, { raw: "96", line: 3 });
    assert.deepEqual(legacy.sourceRows, [{ line: 2, quote: "before,120" }, { line: 3, quote: "after,96" }]);
    const config = structuredClone(policy);
    const unit = config.units.K01;
    unit.calculations.C2 = { kind: "source-number", source: "timing.csv", line: 1, sourceUnit: "ms", units: ["毫秒", "ms"] };
    unit.phases["first-review"].read.push("timing.csv");
    unit.phases["first-review"].evidence.push("timing.csv");
    write("BUILDING-LOOP.json", JSON.stringify(config));
    write("timing.csv", "Elapsed 24 ms.\n");
    spec = authority(root).units.K01;
    assert.equal(configuredNumericMeasurements(root, spec, ["timing.csv"])[0].expected, "24 毫秒");
    for (const raw of ["24 毫秒", "24ms"]) assert.equal(numericChecks(root, spec,
      [`- C2：观测为 ${raw}（出处：timing.csv 第 1 行）。`], ["timing.csv"])[0].ok, true);
    assert.equal(numericChecks(root, spec,
      ["- C2：观测为 24%（出处：timing.csv 第 1 行）。"], ["timing.csv"])[0].ok, false);
  }));

test("direct extraction retains the literal relation across units and document scope", () =>
  fixture((root, write) => {
    install(write, spec => {
      spec.calculations.C5 = { kind: "source-number", source: "reading.md", line: 2,
        sourceUnit: "ms", units: ["毫秒", "ms"], scope: "document" };
    });
    const spec = authority(root).units.K01;
    const readable = ["reading.md"];
    const measurement = () => configuredNumericMeasurements(root, spec, readable).at(-1);
    const check = (value, ...rest) => numericChecks(root, spec,
      [`- C5：实测耗时 ${value}（出处：reading.md 第 2 行）。`, ...rest], readable).at(-1);
    const cases = [
      ["Elapsed under 24 ms.", "lt", "<24 毫秒", "低于 24.0 毫秒", "不超过 24 ms"],
      ["耗时不超过 24 ms。", "lte", "≤24 毫秒", "24毫秒以内", "不足 24 ms"],
      ["耗时 > 24 ms。", "gt", ">24 毫秒", "More than 24 ms", "至少 24 ms"],
      ["Elapsed at least 24 ms.", "gte", "≥24 毫秒", "24 毫秒以上", "超过 24 ms"],
      ["耗时 24 ms 左右。", "approximate", "≈24 毫秒", "About 24 ms", "低于 24 ms"],
      ["耗时大约 24 ms。", "approximate", "≈24 毫秒", "约为 24 毫秒", "超过 24 ms"],
      ["Elapsed ≈24 ms.", "approximate", "≈24 毫秒", "24 毫秒附近", "大于 24 ms"],
      ["Elapsed exactly 24 ms.", "exact", "精确为 24 毫秒", "精确值是 24 毫秒", "大约 24 毫秒"],
    ];
    for (const [original, relation, expected, same, different] of cases) {
      write("reading.md", "# Timing\n" + original + "\n");
      assert.equal(measurement().relation, relation, original);
      assert.equal(measurement().expected, expected, original);
      assert.deepEqual(measurement().sourceRows, [{ line: 2, quote: original }]);
      assert.equal(check(same).ok, true, same);
      assert.equal(check(expected).ok, true, expected);
      assert.equal(check(different).ok, false, different);
      assert.equal(check("24 ms").ok, false, original);
      if (relation !== "exact") assert.equal(check("精确为 24 ms").ok, false, original);
      assert.equal(check(expected, "附注重新转述：" + different + "。").documentIssues[0].line, 2);
    }
    write("reading.md", "# Timing\nElapsed 24 ms.\n");
    assert.equal(Object.hasOwn(measurement(), "relation"), false, "retain unqualified proof shape");
    for (const value of ["不到 24 ms", "约 24 ms", "精确为 24 ms"]) assert.equal(check(value).ok, false, value);
  }));

test("ambiguous source quantities and rounded bounds fail closed", () =>
  fixture((root, write) => {
    install(write);
    const spec = authority(root).units.K01;
    const readable = ["reading.md"];
    const read = original => {
      write("reading.md", "# Timing\n" + original + "\n");
      return configuredNumericMeasurements(root, spec, readable).at(-1);
    };
    const check = value => numericChecks(root, spec,
      [`- C5：耗时 ${value}（出处：reading.md 第 2 行）。`], readable).at(-1);
    for (const original of ["约 <24 ms", "至少 <24 ms", "no fewer than roughly 24 ms", "12 to 24 ms", "20～24 ms",
      "20−24 ms", "12 <24 ms", "12 24 ms", "24 ms ±2", "24 ms +/- 2", "2 × 24 ms", "不等于 24 ms", "接近 24 ms", "24 ms only if <30"]) {
      assert.equal(read(original).available, false, original);
    }
    for (const symbol of ["<", "≤", ">", "≥", "≈"]) {
      assert.equal(read(`延迟 ${symbol}24.04 ms`).available, false, symbol);
      assert.match(read(`延迟 ${symbol}24.04 ms`).issue, /不能在当前精度下原样保留/u);
      assert.equal(read(`延迟 ${symbol}24 ms`).expected, `${symbol}0.024 s`, symbol);
      assert.equal(check(`${symbol}0.024 s`).ok, true, symbol);
      assert.equal(check("0.024 s").ok, false, symbol);
      assert.equal(check("精确为 0.024 s").ok, false, symbol);
      assert.equal(check(`至少 ${symbol}0.024 s`).ok, false, symbol);
    }
    assert.equal(read("校正后计时差 <−24 ms").expected, "<-0.024 s");
    assert.equal(check("<−0.024 s").ok, true);
    assert.equal(read("P95 <24 ms").expected, "<0.024 s");
    assert.equal(check("P95 <0.024 s").ok, true);
    assert.equal(read("P95 24 ms").expected, "0.024 s");
    assert.equal(check("P95 0.024 s").ok, true);
    assert.equal(read("Elapsed 24.04 ms.").expected, "0.024 s", "unqualified conversion keeps its declared rounding");
  }));

test("qualified conversion is rendered and carried through the two review receipts", () =>
  fixture(async (root, write) => {
    install(write, spec => {
      spec.claims = ["C5"];
      spec.calculations = { C5: spec.calculations.C5 };
      spec.hostResults = { calculations: ["C5"] };
    });
    const original = "Elapsed less than 24 ms.";
    write("reading.md", "# Timing\n" + original + "\n");
    const h = host(root, { automaticCoverage: false });
    const executor = (await h.flow("root", "advance")).childId;
    const draft = scope => `- C5：${scope} {{building-loop:metric:C5}}。\n`;
    const save = scope => h.file(executor, "write", "candidate.md", { content: draft(scope), note: "按原始不等式换算单位" });
    for (const wrong of ["该样例至少", "该样例小于", "该样例精确为", "该样例约为"]) {
      await assert.rejects(save(wrong), /限定/u, wrong);
    }
    const saved = await save("该样例实测耗时");
    assert.match(saved.hostResults[0].text, /<0\.024 s（出处：reading\.md 第 2 行）/u);
    await h.file(executor, "read", "candidate.md");
    assert.equal((await h.flow(executor, "submit")).phase, "review-ready");
    for (const [action, next] of [["review", "first-audit-ready"], ["audit", "ledger-review"]]) {
      const reviewer = (await h.flow("root", "advance")).childId;
      for (const file of ["overview.md", "candidate.md", "reading.md"]) await h.file(reviewer, "read", file);
      const { blocks } = await h.coverage(reviewer, "inventory");
      const [block] = blocks;
      assert.match(block.text, /<0\.024 s/u);
      const basis = "原文唯一实测耗时是严格小于二十四毫秒，换算到秒不改变这一边界";
      await h.coverage(reviewer, "record", { entries: [{ block: block.id, parts: [{
        kind: "direct", status: "supported", sourceRelation: "supports", measurement: "C5", basis,
      }] }] });
      if (action === "review") await h.assess(reviewer, {
        ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, basis])),
        goalFit: { pass: true, basis }, sourceRefs: [], revise: [], unverifiedSources: [], unlisted: [],
      });
      assert.equal((await h.flow(reviewer, action)).phase, next);
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
    for (const review of [receipt, receipt.independentAudit]) {
      const [metric] = review.hostMeasurements;
      assert.equal(metric.relation, "lt");
      assert.equal(metric.expected, "<0.024 s");
      assert.deepEqual(metric.sourceRows, [{ line: 2, quote: original }]);
    }
  }));
