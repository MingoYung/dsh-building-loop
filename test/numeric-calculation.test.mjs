import assert from "node:assert/strict";
import test from "node:test";
import { authority, digest } from "../governance/policy.mjs";
import { configuredNumericMeasurements, numericChecks } from "../governance/preflight.mjs";
import { fixture, policy } from "./helpers.mjs";

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
