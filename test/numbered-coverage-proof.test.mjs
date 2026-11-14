import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { QUALITY } from "../governance/preflight.mjs";
import { fixture, host, policy } from "./helpers.mjs";

const source = { file: "samples.md", start: 1, end: 1, quote: "试验一记录 24 ms。" };
const direct = { kind: "direct", status: "supported", sourceRelation: "supports",
  basis: "仅说明当前试验一的记录。", evidence: [source] };
const nonfactual = { kind: "nonfactual", status: "supported", basis: "此段是工作指引。" };
const numbered = { id: "C1", status: "supported", useCoverage: true, basis: "本编号行的证据已逐块核验。" };
const scenario = { body: "C1：试验一记录 24 ms。\n", parts: () => [direct] };
const rule = { file: "overview.md", start: 2, end: 2, quote: "待补件按当前项目规则进入复核。" };
const policyGrounding = { ...direct, basis: "只转述本项目的规则。", kind: "inference", evidence: undefined,
  inference: { rule: "project-policy", policy: [rule], premises: [], scope: "当前项目待补件",
    assumptions: [], counterexample: { possible: false, reason: "当前总纲直接给待补件指定复核动作。" } } };

async function firstReview(root, write, { body, parts, configured = false, external = true, assessment = true }) {
  const manifest = structuredClone(policy);
  const unit = manifest.units.K01;
  unit.claims = configured ? ["C1"] : [];
  unit.calculations = {};
  for (const phase of ["first-review", "final-review"]) {
    unit.phases[phase].read.push(source.file);
    unit.phases[phase].evidence = external ? [source.file] : [];
  }
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  write(rule.file, "# 总纲\n" + rule.quote + "\n");
  write("candidate.md", body);
  write(source.file, source.quote + "\n");
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const packet = await h.flow(reviewer, "prepare");
  assert.deepEqual(packet.claims, [numbered.id]);
  const saved = await h.coverage(reviewer, "record", { entries: packet.coverage.blocks.map(block =>
    ({ block: block.id, parts: parts(block) })) });
  assert.deepEqual(saved.pending, [], JSON.stringify(saved.invalid));
  const assess = sourceRefs => h.assess(reviewer, {
    ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "按现行目标核对内容和适用范围。"])),
    sourceRefs, goalFit: { pass: true, basis: "交付符合目标。" },
    unverifiedSources: [], unlisted: [], revise: [],
  });
  if (assessment) await assess(external ? [{ file: source.file, start: 1, end: 1 }] : []);
  return { h, reviewer, blocks: packet.coverage.blocks, assess };
}

test("inferred numbered support reuses only the current reviewer's own proven line", () => fixture(async (root, write) => {
  const { h, reviewer, blocks } = await firstReview(root, write, scenario);
  for (const overrides of [{ file: source.file }, { start: 1 }, { end: 1 }, { line: 1 }, { status: "unsupported" }]) {
    await assert.rejects(h.flow(reviewer, "review", { checks: [{ ...numbered, ...overrides }] }), /不能|不与|仅用于/u);
  }
  const accepted = await h.flow(reviewer, "review", { checks: [numbered] });
  assert.equal(accepted.phase, "first-audit-ready");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(receipt.checks[0].file, source.file);
  assert.equal(receipt.checks[0].line, 1);
  assert.deepEqual(receipt.checks[0].supportOrigin, { kind: "same-reviewer-coverage", blocks: [blocks[0].id] });
}));

test("explicitly configured numbered claims still require the declared source path", () => fixture(async (root, write) => {
  const { h, reviewer } = await firstReview(root, write,
    { ...scenario, body: "C1：试验一记录 24 ms（出处：samples.md 第1行）。\n", configured: true });
  await assert.rejects(h.flow(reviewer, "review", { checks: [numbered] }), /不与项目明确编号/u);
  const { useCoverage, ...legacy } = numbered;
  assert.equal((await h.flow(reviewer, "review", { checks: [{ ...legacy, file: source.file, start: 1, end: 1 }] })).phase,
    "first-audit-ready");
}));

test("a submission reports all missing or malformed configured IDs before handing off to review", () => fixture(async (root, write) => {
  const manifest=structuredClone(policy);
  manifest.units.K01.claims=["C1","C2","C3"];
  manifest.units.K01.calculations={};
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  write("candidate.md", "C1（E1）：判断。\nC2：第一份。\nC2：第二份。\nC3：当前正确格式。\n");
  const h=host(root,{automaticCoverage:false});
  const worker=(await h.flow("root","advance")).childId;
  await h.flow(worker,"prepare");
  await assert.rejects(h.flow(worker,"submit"),error=>
    error.message.includes("C1 需要")&&error.message.includes("C2 需要")&&!error.message.includes("C3 需要"));
  write("candidate.md","C1：E1 的判断。\nC2：唯一编号。\nC3：当前正确格式。\n");
  await h.file(worker,"read","candidate.md");
  assert.equal((await h.flow(worker,"submit")).phase,"review-ready");
}));

const blocked = [
  { description: "numbered instruction and unrelated supported source on another line",
    body: "C1：请核对后归档。\n\n试验一记录 24 ms。\n", parts: block => [block.line === 1 ? nonfactual : direct],
    expected: /实际断言的原文/u },
  { description: "an explicitly scoped hypothesis",
    body: "C1：[推测] 试验一记录 24 ms。\n", parts: () => [
      { kind: "nonfactual", status: "supported", quote: "C1：", basis: "编号供读者定位。" },
      { kind: "hypothesis", status: "uncertain", quote: "[推测] 试验一记录 24 ms。", basis: "正文明确标成有待实测。" },
    ], expected: /实际断言的原文/u },
  { description: "a verified candidate self-count as external source proof",
    body: "C1：本稿对 samples.md 有1行可识别同行引用。\n\n试验一记录 24 ms（出处：samples.md 第1行）。\n",
    parts: block => block.line === 1 ? [{ ...direct, evidence: undefined,
      objectCheck: { kind: "candidate", check: "citation-count", source: source.file, expected: 1 } }] : [direct],
    expected: /实际断言的原文/u },
  { description: "actual unsupported external factual part",
    body: "C1：所有试验均记录 24 ms。\n", parts: () => [{ kind: "direct", status: "unsupported", sourceRelation: "insufficient",
      basis: "一条试验记录不足以推出所有试验。", finding: { kind: "scope", quote: "所有试验均记录 24 ms", fix: "范围改为试验一。" } }],
    expected: /存在实际退回/u },
];
for (const item of blocked) {
  test("numbered support refuses " + item.description, () => fixture(async (root, write) => {
    const { h, reviewer } = await firstReview(root, write, item);
    await assert.rejects(h.flow(reviewer, "review", { checks: [numbered] }), item.expected);
    assert.equal(fs.existsSync(path.join(root, "first.json")), false);
  }));
}

test("reading changed source again does not reactivate numbered coverage proof", () => fixture(async (root, write) => {
  const { h, reviewer } = await firstReview(root, write, scenario);
  write(source.file, source.quote + "\n新增另一时段。\n");
  await h.file(reviewer, "read", source.file);
  await assert.rejects(h.flow(reviewer, "review", { checks: [numbered] }), /证据或获取回执版本已经变化/u);
  assert.equal(fs.existsSync(path.join(root, "first.json")), false);
}));

test("numbered project rules stay policy-only through independent audit", () => fixture(async (root, write) => {
  const { h, reviewer, blocks } = await firstReview(root, write, {
    body: "C1：本项目将待补件列入复核（出处：overview.md 第2行）。\n", parts: () => [policyGrounding], external: false,
  });
  assert.equal((await h.flow(reviewer, "review", { checks: [numbered] })).phase, "first-audit-ready");
  const proof = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.deepEqual(proof.observedSources, []);
  assert.equal(Object.hasOwn(proof.checks[0], "file"), false);
  assert.deepEqual(proof.checks[0].supportOrigin, { kind: "same-reviewer-coverage", proofObject: "project-policy", blocks: [blocks[0].id] });
  const auditor = (await h.flow("root", "advance")).childId;
  assert.notEqual(auditor, reviewer);
  const packet = await h.flow(auditor, "prepare");
  assert.deepEqual(packet.coverage.pending, [blocks[0].id]);
  await assert.rejects(h.flow(auditor, "audit"), /未核块/u);
  await h.coverage(auditor, "record", { entries: packet.coverage.blocks.map(block =>
    ({ block: block.id, parts: [policyGrounding] })) });
  assert.equal((await h.flow(auditor, "audit")).phase, "ledger-review");
}));

test("mixed numbered rules still require an actual external premise and quality source", () => fixture(async (root, write) => {
  const mixed = { ...policyGrounding, inference: { ...policyGrounding.inference, premises: [source] } };
  const { h, reviewer, assess } = await firstReview(root, write, {
    body: "C1：试验一记录 24 ms，待补件依本项目规则进入复核。\n", parts: () => [mixed], assessment: false,
  });
  await assert.rejects(h.flow(reviewer, "review", { checks: [numbered] }), /先用 building_loop_quality/u);
  await assert.rejects(assess([]), /实际读取的 sourceRefs/u);
  await assert.rejects(assess([rule]), /证据授权/u);
  await assess([{ file: source.file, start: source.start, end: source.end }]);
  assert.equal((await h.flow(reviewer, "review", { checks: [numbered] })).phase, "first-audit-ready");
  const proof = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(proof.checks[0].file, source.file);
  assert.equal(proof.observedSources[0].file, source.file);
  assert.equal(Object.hasOwn(proof.checks[0].supportOrigin, "proofObject"), false);
}));

for (const { name, text, positive, external } of [
  { name: "policy", text: "本项目将待补件列入复核。", positive: policyGrounding, external: true },
  { name: "external", text: source.quote, positive: direct, external: true },
]) {
  test("the same reviewer can revalidate its " + name + " numbered check after a real classification dispute", () => fixture(async (root, write) => {
    const { h, reviewer, blocks } = await firstReview(root, write, {
      body: "C1：" + text + "\n\n试验一记录的延迟是 24 ms。\n", external,
      parts: block => [block.line === 1 ? positive : nonfactual],
    });
    assert.equal((await h.flow(reviewer, "review", { checks: [numbered] })).phase, "first-audit-ready");
    const auditor = (await h.flow("root", "advance")).childId;
    assert.notEqual(auditor, reviewer);
    await h.flow(auditor, "prepare");
    await h.coverage(auditor, "record", { entries: blocks.map(block =>
      ({ block: block.id, parts: [block.line === 1 ? positive : direct] })) });
    assert.equal((await h.flow(auditor, "audit")).phase, "review-ready");
    assert.equal((await h.flow("root", "advance")).childId, reviewer);
    const resumed = await h.flow(reviewer, "prepare");
    assert.deepEqual(resumed.coverage.pending, [blocks[1].id]);
    await assert.rejects(h.flow(reviewer, "review"), /未核块/u);
    await h.coverage(reviewer, "record", { entries: [{ block: blocks[1].id, parts: [direct] }] });
    assert.equal((await h.flow(reviewer, "review")).phase, "first-audit-ready");
    assert.equal((await h.flow("root", "advance")).childId, auditor);
    await h.flow(auditor, "prepare");
    assert.equal((await h.flow(auditor, "audit")).phase, "ledger-review");
  }));
}
