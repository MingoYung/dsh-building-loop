import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";

const locator = "https://www.itl.nist.gov/div898/handbook/eda/section3/scatterp.htm";
const excerpt = "association does NOT imply causality.";
const secondExcerpt = "A separately recorded excerpt.";
const metadata = "GitHub 列表仅摘 failure/success 两项。";
const snapshot = `# 官方短摘录\n${metadata}\n${excerpt}\n${secondExcerpt}\n`;
const source = { file: "snapshot.md", start: 3, end: 3, quote: excerpt };

function setup(write) {
  const p = structuredClone(policy);
  const row = { snapshot: "snapshot.md", snapshotSha256: digest(snapshot), finalUrl: locator,
    status: 200, fetchedAt: "2026-11-07T13:01:03Z", responseSha256: "a".repeat(64), exactQuotes: [excerpt, secondExcerpt] };
  const receipt = JSON.stringify({ sources: [row] });
  p.sourcePins = { "snapshot.md": { kind: "primary", locator, sha256: digest(snapshot),
    observation: { file: "acquisition.json", sha256: digest(receipt) } } };
  const unit = p.units.K01;
  unit.claims = ["C1"];
  unit.calculations = {};
  for (const name of ["first-review", "final-review"]) {
    unit.phases[name].read.push(source.file);
    unit.phases[name].evidence = [source.file];
  }
  write("snapshot.md", snapshot);
  write("acquisition.json", receipt);
  write("candidate.md", "- C1：相关不说明因果（出处：snapshot.md 第 3 行）。\n");
  write("BUILDING-LOOP.json", JSON.stringify(p));
  return { p, row, receipt };
}

test("actual excerpt evidence passes, copied metadata and changed acquisition receipts are blocked", () => fixture(async (root, write) => {
  const { receipt } = setup(write);
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const packet = await h.flow(reviewer, "prepare");
  assert.ok(packet.files.some(file => file.path === source.file));
  assert.ok(!packet.files.some(file => file.path === "acquisition.json"));
  const record = (id, ref) => h.coverage(id, "record", { entries: [{ block: packet.coverage.blocks[0].id,
    parts: [{ kind: "direct", status: "supported", sourceRelation: "supports", evidence: [ref].flat(), basis: "逐字对应本页相关与因果的边界。" }] }] });
  await assert.rejects(record(reviewer, { ...source, start: 2, end: 2, quote: metadata }), /未登记为外部原文/);
  await assert.rejects(record(reviewer, { ...source, start: 2 }), /未登记为外部原文/);
  await assert.rejects(record(reviewer, { ...source, end: 4, quote: excerpt + "\n" + secondExcerpt }), /不能用跨行 quote/);
  await record(reviewer, [source, { ...source, start: 4, end: 4, quote: secondExcerpt }]);
  const item = (await h.coverage(reviewer, "status", { block: packet.coverage.blocks[0].id })).record.parts[0];
  assert.equal(item.evidence[0].origin.observation.sha256, digest(receipt));
  await h.assess(reviewer, { ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "核准明确范围、实际来源和读者可理解的表述。"])),
    goalFit: { pass: true, basis: "正文保留授权材料的相关性边界。" },
    sourceRefs: [{ file: source.file, start: 3, end: 3 }], unverifiedSources: [], unlisted: [], revise: [] });
  const checks = [{ id: "C1", status: "supported", file: source.file, start: 3, end: 3, basis: "原始逐字摘录明确该边界。" }];
  await h.flow(reviewer, "review", { checks });
  const auditor = (await h.flow("root", "advance")).childId;
  await h.flow(auditor, "prepare");
  await record(auditor, source);
  assert.equal((await h.flow(auditor, "audit")).phase, "ledger-review");
  await h.ledger("root", "read");
  await h.file("root", "read", "overview.md");
  await h.file("root", "read", "first.json");
  const decisions = [{ id: "unit-K01", outcome: "completed", basis: "本轮结论与当前目标一致。", evidence: { file: "first.json", start: 1, end: 1 } }];
  write("acquisition.json", receipt + "\n");
  await assert.rejects(h.ledger("root", "review", { decisions }), /获取回执/);
  write("acquisition.json", receipt);
  assert.equal((await h.ledger("root", "review", { decisions })).phase, "closed");
}));

test("observation files cannot be given to a model as writable or generated from its review", () => fixture(async (root, write) => {
  const { p } = setup(write);
  p.coordinator.write = ["acquisition.json"];
  write("BUILDING-LOOP.json", JSON.stringify(p));
  assert.throws(() => authority(root), /不能授予模型写权/);
  p.coordinator.write = [];
  p.sourcePins["snapshot.md"].observation.file = "first.json";
  write("BUILDING-LOOP.json", JSON.stringify(p));
  assert.throws(() => authority(root), /不能由候选或验收回执自证/);
}));

test("an explicit original quote pointing to editorial metadata can be returned to its author", () => fixture(async (root, write) => {
  setup(write);
  write("candidate.md", `- C1：原文为“${metadata}”（出处：snapshot.md 第 2 行）。\n`);
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const packet = await h.flow(reviewer, "prepare");
  const finding = { kind: "missing-evidence", quote: "原文为", fix: "删除冒称原文的说明或引用实际登记的摘录。" };
  await h.coverage(reviewer, "record", { entries: packet.coverage.blocks.map((block, index) => ({ block: block.id,
    parts: [index ? { kind: "nonfactual", status: "supported", basis: "后续为引文尾部的定位说明。" }
      : { kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis: "指向编辑说明。", finding }] })) });
  const result = await h.flow(reviewer, "review", { checks: [{ id: "C1", status: "unsupported", basis: "说明行不属于外部原文。", finding }] });
  assert.equal(result.phase, "supplement-ready");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(receipt.coverage.quotations[0].matches, false);
  assert.deepEqual(receipt.coverage.quotations[0].excludedLocators, [{ file: source.file, start: 2, end: 2 }]);
}));
