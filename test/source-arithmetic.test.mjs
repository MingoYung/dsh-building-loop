import assert from "node:assert/strict";
import { test } from "node:test";
import { authority, digest, keyOf } from "../governance/policy.mjs";
import { measuredOriginalDisposition } from "../governance/source-arithmetic.mjs";
import { fixture, host, policy } from "./helpers.mjs";

const source = "table.md";
const table = "# Frozen sales data\nYear,Online,Total,Total\n2020,12,90,225\n2025,32,140,320\n";
const cell = (line, column) => ({ file: source, line, column });
const evaluate = (h, id, operation, operands) =>
  h.invoke(id, "building_loop_calculate", { action: "evaluate", operation, operands });

test("whole compound durations bind to registered rows and are normalized before rounding", () => fixture(async (root, write) => {
  const rows = ["# Source", "It took 11 hours and 55 minutes to orbit its parent.", "11 hours and 23 minutes",
    "历时2小时5分钟", "1 hour 55 minutes", "2 小时 5 分钟 0.5 秒", "5 min 0 seconds",
    "2 hours and 4 kg", "1 h 5 min or 2 h 0 min", "About 2 h 5 min", "2 h and at least 5 min",
    "2 h 5 min or more", "2 h 5 min/km", "5 min 1 hour", "Version 3 took 2 h 5 min",
    "12", "2026-11-18", "2 to 3 hours", "2 hours", "1 hour 30 minutes"];
  const original = rows.join("\n") + "\n";
  registerSource(write, original);
  const h = host(root, { automaticCoverage: false }), worker = (await h.flow("root", "advance")).childId;
  const ref = line => ({file: source, line});
  const compute = (a, b, durationUnit = "min", operation = "difference", decimals = 2, role = worker) =>
    h.invoke(role, "building_loop_calculate", {action: "evaluate", operation, operands: [a,b], durationUnit, decimals});
  await h.file(worker, "read", "overview.md");
  await assert.rejects(compute(ref(2), ref(3)), /先实际读取/u);
  await h.file(worker, "read", source);
  const result = await compute(ref(2), ref(3));
  assert.deepEqual([result.value,result.unit], ["32","min"]);
  assert.deepEqual(result.operands.map(({raw,sha256,line}) => [raw,sha256,line]), [
    ["11 hours and 55 minutes",digest(original),2], ["11 hours and 23 minutes",digest(original),3]]);
  assert.equal((await compute(ref(4),ref(5))).value, "10");
  assert.equal((await compute(ref(6),ref(5),"s")).value, "600.5");
  assert.equal((await compute(ref(4),ref(5),"h","difference",6)).value, "0.166667");
  assert.equal((await compute(ref(7),ref(4),"s","share")).value, "4");
  assert.equal((await compute(ref(rows.length-1),ref(rows.length))).value, "30");
  for (let line = 8; line <= rows.length-2; line++) {
    await assert.rejects(compute(ref(line),ref(3)), /完整复合时长/u, rows[line-1]);
  }
  for (const selector of [{value: "55"},{column: 2}]) {
    await assert.rejects(compute({...ref(2),...selector},ref(3)), /只需 file 和 line/u);
  }
  await assert.rejects(compute(ref(1),ref(3)), /登记为原文/u);
  await assert.rejects(compute(ref(2),ref(3),"min","difference",2,"root"), /没有原文复算授权/u);
  assert.equal((await evaluate(h,worker,"difference",[{...ref(2),value:"55"},{...ref(3),value:"23"}])).unit, "minutes");
}));

function registerSource(write, tableText = table) {
  const config = structuredClone(policy);
  const spec = config.units.K01;
  delete spec.calculations;
  spec.phases.intake.read.push(source);
  for (const name of ["first-review", "final-review"]) {
    spec.phases[name].read.push(source);
    spec.phases[name].evidence.push(source);
  }
  const locator = "https://example.org/frozen-sales.csv";
  const observation = {
    sources: [{ snapshot: source, snapshotSha256: digest(tableText), finalUrl: locator, status: 200,
      responseSha256: digest("response"), fetchedAt: "2025-01-01T00:00:00.000Z", exactQuotes: tableText.trimEnd().split("\n").slice(1) }],
  };
  const receipt = JSON.stringify(observation);
  config.sourcePins = { [source]: { sha256: digest(tableText), kind: "primary", locator,
    observation: { file: "sources.json", sha256: digest(receipt) } } };
  write(source, tableText);
  write("sources.json", receipt);
  write("BUILDING-LOOP.json", JSON.stringify(config));
  return config;
}

test("original disposition recomputes a scoped difference from pinned physical rows for each role", () => fixture((root, write) => {
  const config = registerSource(write), unit = config.units.K01;
  const incoming = "desk.md";
  for (const name of ["first-review", "final-review"]) {
    unit.phases[name].read.push(incoming);
    unit.phases[name].materials = [incoming];
  }
  unit.originalFirst = true;
  unit.originalMeasurements = { C1: { source, header:2, valueColumn:3, valueHeading:"Total", keyColumn:1,
    before:{line:3,key:"2020"}, after:{line:4,key:"2025"}, sourceUnit:"W/m²", targetUnit:"mW/m²",
    statement:"2025 年试验指标比 2020 年多 {quantity}，采用表内第一列 Total。" } };
  write("BUILDING-LOOP.json", JSON.stringify(config));
  const check = authority(root), spec = check.units.K01;
  const location = { id:"C1", file:incoming, line:1 };
  for (const [role, phase] of [["reviewer", "first-review"], ["auditor", "final-audit"]]) {
    const frame = {root, role, policy:check, reads:spec.phases[phase].read};
    const active = {phase, seen:{}};
    const assess = () => measuredOriginalDisposition(frame, active, spec, "C1", location);
    const original = quantity => {
      const line = "- C1 2025 年试验指标比 2020 年多 " + quantity + "，采用表内第一列 Total。\n";
      write(incoming, line);
      active.seen[keyOf(incoming)] = {hash:digest(line),ranges:[[1,1]]};
    };
    original("50000 mW/m²");
    assert.throws(assess, /实际读过/u);
    active.seen[keyOf(source)] = {hash:digest(table),ranges:[[2,4]]};
    const proof = assess();
    assert.equal(proof.decision, "保留");
    assert.equal(proof.expected, "50000 mW/m²");
    assert.deepEqual(proof.sources.map(ref => ref.start), [2,3,4]);
    original("50 W/m²");
    assert.equal(assess().decision, "保留");
    original("50001 mW/m²");
    assert.equal(assess().decision, "改正");
    original("约 50000 mW/m²");
    assert.equal(assess(), undefined);
    original("50000 ms");
    assert.equal(assess(), undefined);
    original("50000 mW/m²");
    write(source, table.replace("140,320", "141,320"));
    assert.throws(assess, /实际读过/u);
    write(source, table);
  }
}));

test("authorized roles can evaluate two distinct ratios from the same pinned data without copying numbers", () => fixture(async (root, write) => {
  registerSource(write);
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  const pairs = [cell(4, 2), cell(4, 3)];
  assert.ok(!h.visible("root").includes("building_loop_calculate"));
  await assert.rejects(evaluate(h, "root", "share", pairs), /没有原文复算授权/u);
  await h.file(executor, "read", "overview.md");
  await assert.rejects(evaluate(h, executor, "share", pairs), /先实际读取/u);
  assert.deepEqual((await h.flow(executor, "prepare")).sourceArithmetic.sources, [source]);
  await h.file(executor, "read", source);
  const current = await evaluate(h, executor, "share", pairs);
  assert.equal(current.value, "22.86");
  assert.equal(current.unit, "%");
  assert.deepEqual(current.operands, ["32", "140"].map((value, index) => ({ ...pairs[index], value, sha256: digest(table) })));
  const change = await evaluate(h, executor, "change-share", [cell(4, 2), cell(3, 2), cell(4, 3), cell(3, 3)]);
  assert.equal(change.value, "40");
  assert.equal((await evaluate(h, executor, "difference", [cell(4, 2), cell(3, 2)])).value, "20");
  await assert.rejects(evaluate(h, executor, "change-share", [cell(4, 2), cell(3, 2), cell(3, 3), cell(4, 3)]), /分母/u);
  await assert.rejects(evaluate(h, executor, "share", [cell(1, 2), cell(4, 3)]), /登记为原文/u);
  await assert.rejects(evaluate(h, executor, "share", [{ file: source, line: 4, value: "4" }, cell(4, 3)]), /唯一的原始数值/u);
  await assert.rejects(evaluate(h, executor, "share", [{ file: "candidate.md", line: 2, value: "19" }, cell(4, 3)]), /登记原始证据/u);

  await h.file(executor, "read", "candidate.md");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  await h.file(reviewer, "read", "overview.md");
  await assert.rejects(evaluate(h, reviewer, "share", pairs), /先实际读取/u);
  await h.file(reviewer, "read", source);
  assert.deepEqual(await evaluate(h, reviewer, "share", pairs), current);
  write(source, table.replace("32,140", "33,140"));
  await h.file(reviewer, "read", source);
  await assert.rejects(evaluate(h, reviewer, "share", pairs), /原始版本不符/u);
}));

test("source calculation binds whole numbers, units and qualified claims to raw physical rows", () => fixture(async (root, write) => {
  const rows = ["# Frozen measurement", "Dataset", "Duration = 1,234 ms.", "Duration = 34 ms.",
    "At least 34 ms.", "Duration = 34 kg.", '"base, first","1,234",24', '"unfinished,12',
    "Duration = 12,34 ms.", "Duration = 34 ms or more.", "Duration = 34 ms and 34 ms.",
    "12 or more", "10 or more", "12 or so", "12 to 15", "12 and then", "12 ms", "10 ms", "12 ms or less"];
  registerSource(write, rows.join("\n")+"\n");
  const h=host(root,{automaticCoverage:false}), worker=(await h.flow("root","advance")).childId;
  await h.file(worker,"read","overview.md");
  await h.file(worker,"read",source);
  const at=(line,value)=>({file:source,line,value});
  const diff=(a,b)=>evaluate(h,worker,"difference",[a,b]);
  const result=await diff(at(3,"1,234"),at(4,"34"));
  assert.equal(result.value,"1200");assert.equal(result.unit,"ms");assert.equal(result.operands[0].raw,"1,234");
  assert.equal((await diff(cell(7,2),cell(7,3))).value,"1210");
  for(const value of ["1","234"]) await assert.rejects(diff(at(3,value),at(4,"34")),/唯一的原始数值/u);
  for(const line of [5,10]) await assert.rejects(diff(at(line,"34"),at(4,"34")),/限定词/u);
  await assert.rejects(diff(at(6,"34"),at(4,"34")),/单位/u);
  await assert.rejects(diff(cell(8,2),cell(7,3)),/CSV/u);
  await assert.rejects(diff(at(9,"12,34"),at(4,"34")),/格式/u);
  await assert.rejects(diff(at(11,"34"),at(4,"34")),/唯一/u);
  await assert.rejects(diff(at(12,"12"),at(13,"10")), /限定词/u);
  for (const line of [14,15,16,19]) await assert.rejects(diff(at(line,"12"),at(18,"10")), /限定词/u);
  assert.equal((await diff(at(17,"12"),at(18,"10"))).value, "2");
}));
