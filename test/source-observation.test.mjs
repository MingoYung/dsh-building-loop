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
    parts: [index ? { kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis: "这个独立定位尾块指向未登记为原文的编辑说明。",
      finding: { kind: "missing-evidence", quote: block.text, fix: "把此原文定位改到真实登记摘录，或明确撤回原文声称。" } }
      : { kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis: "指向编辑说明。", finding }] })) });
  const result = await h.flow(reviewer, "review", { checks: [{ id: "C1", status: "unsupported", basis: "说明行不属于外部原文。", finding }] });
  assert.equal(result.phase, "supplement-ready");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(receipt.coverage.quotations[0].matches, false);
  assert.deepEqual(receipt.coverage.quotations[0].excludedLocators, [{ file: source.file, start: 2, end: 2 }]);
}));

/** Deliberately give the reviewer an overbroad support judgment. The production
 * quotation gate must still check the manuscript's own locator, rather than
 * accept an unrelated authorized source selected by that reviewer. */
async function quoteReview(root, write, body, claimLine = 3) {
  const { p } = setup(write);
  const other = "other.md";
  write(other, secondExcerpt + "\n");
  for (const phase of ["first-review", "final-review"]) {
    p.units.K01.phases[phase].read.push(other);
    p.units.K01.phases[phase].evidence.push(other);
  }
  write("candidate.md", "- C1：" + body + "\n");
  write("BUILDING-LOOP.json", JSON.stringify(p));
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const packet = await h.flow(reviewer, "prepare");
  const entries = packet.coverage.blocks.map(block => ({ block: block.id, parts: [{
    kind: "direct", status: "supported", sourceRelation: "supports", evidence: [source],
    basis: "故意模拟只查到已授权摘录就放行，由独立逐字门槛核对实际定位。",
  }] }));
  for (let start = 0; start < entries.length; start += 12) await h.coverage(reviewer, "record", { entries: entries.slice(start, start + 12) });
  await h.assess(reviewer, { ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "本用例只检验引句定位，其他质量维度由固定脚本给出。"])),
    goalFit: { pass: true, basis: "保留当前逐字引用样例供独立定位检查。" },
    sourceRefs: [{ file: source.file, start: 3, end: 3 }, { file: source.file, start: 4, end: 4 }], unverifiedSources: [], unlisted: [], revise: [] });
  const result = await h.flow(reviewer, "review", { checks: [{ id: "C1", status: "supported",
    file: source.file, start: claimLine, end: claimLine, basis: "故意给出过宽支持，仍须通过稿件的确定性逐字核对。" }] });
  return { result, receipt: JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8")) };
}

test("a verbatim quote cannot borrow a different same-line source against its adjacent locator", () => fixture(async (root, write) => {
  const { result, receipt } = await quoteReview(root, write,
    `原文为“${secondExcerpt}”（出处：snapshot.md 第 3 行）；另见 other.md 第 1 行。`);
  assert.equal(result.phase, "supplement-ready");
  assert.equal(receipt.coverage.quotations[0].matches, false);
  assert.deepEqual(receipt.coverage.quotations[0].refs.map(({ file, start, end }) => ({ file, start, end })),
    [{ file: source.file, start: 3, end: 3 }]);
  assert.ok(receipt.coverage.rejected.some(row => row.finding?.kind === "verbatim-quote"));
}));

test("adjacent quote bindings preserve correct references and distinguish repeated source ranges", () => fixture(async (root, write) => {
  const { receipt } = await quoteReview(root, write,
    `原文为“${excerpt}”（出处：snapshot.md 第 3 行）；原文为“${secondExcerpt}”（出处：snapshot.md 第 4 行）；另见 other.md 第 1 行。`);
  assert.deepEqual(receipt.coverage.quotations.map(row => row.matches), [true, true]);
  assert.deepEqual(receipt.coverage.quotations.map(row => row.refs.map(ref => ref.start)), [[3], [4]]);
}));

test("a later wrong quote cannot borrow an earlier range of the same source", () => fixture(async (root, write) => {
  const { receipt } = await quoteReview(root, write,
    `原文为“${secondExcerpt}”（出处：snapshot.md 第 4 行）；原文为“${secondExcerpt}”（出处：snapshot.md 第 3 行）。`, 4);
  assert.deepEqual(receipt.coverage.quotations.map(row => row.matches), [true, false]);
}));

test("unambiguous adjacent locator syntax keeps valid quotations without unrelated source proof", async () => {
  for (const location of ["（snapshot.md:3）", "(来源: `snapshot.md` #L3)", "[证据：snapshot.md 第3行]", "【`snapshot.md:3`】"]) {
    await fixture(async (root, write) => {
      const { receipt } = await quoteReview(root, write, `原文为“${excerpt}”${location}；另见 other.md 第1行。`);
      const quote = receipt.coverage.quotations[0];
      assert.equal(quote.matches, true);
      assert.equal(quote.binding, "adjacent-single-source");
      assert.deepEqual(quote.refs.map(ref => ref.file), [source.file]);
    });
  }
});

test("generic multi-source notes and unresolved footnotes keep their legacy quotation scope", async () => {
  await fixture(async (root, write) => {
    const { receipt } = await quoteReview(root, write,
      `原文为“${secondExcerpt}”（出处：snapshot.md 第3行；other.md 第1行）。`);
    const quote = receipt.coverage.quotations[0];
    assert.equal(quote.binding, undefined);
    assert.equal(quote.matches, true);
    assert.deepEqual(quote.refs.map(ref => ref.file), [source.file, "other.md"]);
  });
  await fixture(async (root, write) => {
    const { receipt } = await quoteReview(root, write,
      `相关边界（出处：snapshot.md 第3行）。\n原文为“${excerpt}”[^1]\n[^1]: snapshot.md 第3行`);
    assert.deepEqual(receipt.coverage.quotations, []);
  });
});

test("an explicit unapproved adjacent path cannot borrow a valid alternate source", async () => {
  for (const file of ["not-present.md", "denied.md"]) {
    await fixture(async (root, write) => {
      if (file === "denied.md") write(file, secondExcerpt + "\n");
      const { result, receipt } = await quoteReview(root, write,
        `相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”（出处：${file} 第1行）；另见 other.md 第1行。`);
      assert.equal(result.phase, "supplement-ready");
      const quote = receipt.coverage.quotations[0];
      assert.equal(quote.matches, false);
      assert.deepEqual(quote.refs, []);
      assert.equal(quote.excludedLocators[0].file, file);
      assert.equal(quote.excludedLocators[0].reason, "unapproved-source");
      const rejected = receipt.coverage.rejected.find(row => row.text === quote.text);
      assert.equal(rejected.sourceRelation, "insufficient");
      assert.equal(rejected.finding.kind, "missing-evidence");
    });
  }
});

test("an invalid adjacent authorized range creates author evidence debt without reading an invalid range", async () => {
  for (const location of ["snapshot.md 第0行", "snapshot.md:4-3", "snapshot.md#L9007199254740992"]) {
    await fixture(async (root, write) => {
      const { result, receipt } = await quoteReview(root, write,
        `相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”（出处：${location}）；另见 other.md 第1行。`);
      assert.equal(result.phase, "supplement-ready");
      const quote = receipt.coverage.quotations[0];
      assert.equal(quote.matches, false);
      assert.deepEqual(quote.refs, []);
      assert.equal(quote.excludedLocators[0].reason, "invalid-range");
      assert.ok(receipt.coverage.rejected.some(row => row.finding.kind === "missing-evidence"));
    });
  }
});
