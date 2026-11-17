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

function registerSource(write) {
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
    sources: [{ snapshot: source, snapshotSha256: digest(table), finalUrl: locator, status: 200,
      responseSha256: digest("response"), fetchedAt: "2025-01-01T00:00:00.000Z", exactQuotes: table.trimEnd().split("\n").slice(1) }],
  };
  const receipt = JSON.stringify(observation);
  config.sourcePins = { [source]: { sha256: digest(table), kind: "primary", locator,
    observation: { file: "sources.json", sha256: digest(receipt) } } };
  write(source, table);
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
