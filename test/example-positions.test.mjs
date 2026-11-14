import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { digest } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";

// Exact final candidate from the archived 055022Z fresh run; its quality prose
// named lines 7/9/12 although the third example is line 10.
const archivedDraft = `# 检查结果与观测说明
- C1：GitHub 的 completed 状态可以对应 failure 结论（出处：sources/github-checks.md 第 6-8 行）。
- C2：NIST 指出，相关不必然说明因果（出处：sources/nist-scatter.md 第 6 行）。
- C3：按本例规则，样本 X 是 A 级，因此样本 X 应送复核（出处：sources/synthetic.md 第 4-5 行）。
- C4：GitHub 登记原文在 completed 状态下列出的结论例子含 failure 与 success 两项（出处：sources/github-checks.md 第 6-8 行）。
记录 A 的 conclusion 为 failure（出处：sources/synthetic.md 第 2 行）。
错例：记录 A 已完成，所以记录 A 必定成功；完成状态不决定结论（出处：sources/synthetic.md 第 2 行）。
[模拟] 模拟观测组的训练时长与分数正相关（出处：sources/synthetic.md 第 3 行）。
错例：由上述相关推出延长训练必然提高每个人的分数；没有随机分配、未排除其他共同影响因素，不能把相关当作因果，也不能由群体推到每个个体（出处：sources/synthetic.md 第 3 行）。
错例：由样本 X 应送复核反推任何送复核的样本都是 A 级；按本例规则只能得到 X 应送复核，不能反推所有送复核样本都是 A 级（出处：sources/synthetic.md 第 4-5 行）。
就 sources/synthetic.md 的模拟观测记录而言，只能报告相关，不能单凭该记录确定因果（出处：sources/synthetic.md 第 3 行；sources/nist-scatter.md 第 6 行）。
[推测] 后续可以考虑通过更合适的研究设计检验原因。
sources/nist-scatter.md 第 6 行的逐字原文：association does NOT imply causality.
- [摘录范围] 本轮登记的 sources/nist-scatter.md 含 1 条 NIST 页面短摘录。
- [稿件自述] 本稿有 7 行带 sources/synthetic.md 的行号定位。
大白话：把完成状态、实际结果和证据能说明的范围分开看。
`;
const archivedHash = "7aff949a18aee9ba36a03bdf51521eca2c29f689ccfc28f2e903a931e07cffde";

/** Exercise the real tool flow without auto-filling example or hypothesis proof. */
async function startReview(root, write, body) {
  const p = structuredClone(policy);
  p.units.K01.claims = ["C1"];
  p.units.K01.calculations = {};
  write("BUILDING-LOOP.json", JSON.stringify(p));
  write("candidate.md", body);
  const h = host(root, { automaticCoverage: false });
  assert.equal((await h.flow("root", "prepare")).candidatePositions, undefined);
  const executor = (await h.flow("root", "advance")).childId;
  assert.equal((await h.flow(executor, "prepare")).candidatePositions, undefined);
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  return { h, reviewer };
}

test("the exact 055022Z candidate locates line 10 as an example and line 12 as a hypothesis", async () => fixture(async (root, write) => {
  assert.equal(digest(archivedDraft), archivedHash);
  const { h, reviewer } = await startReview(root, write, archivedDraft);
  const first = (await h.flow(reviewer, "prepare")).candidatePositions;
  assert.deepEqual(first, {
    spec: "building-loop-candidate-positions/1", provenance: "host-derived-explicit-labels",
    path: "candidate.md", candidateSha256: archivedHash, errorExampleLines: [7, 9, 10], hypothesisLines: [12],
  });

  const shifted = "# 另加一行\n" + archivedDraft;
  write("candidate.md", shifted);
  await assert.rejects(h.coverage(reviewer, "inventory"), /完整读取当前候选正文/);
  const next = (await h.flow(reviewer, "prepare")).candidatePositions;
  assert.equal(next.candidateSha256, digest(shifted));
  assert.notEqual(next.candidateSha256, first.candidateSha256);
  assert.deepEqual(next.errorExampleLines, [8, 10, 11]);
  assert.deepEqual(next.hypothesisLines, [13]);
}));

test("a model cannot promote the line 12 hypothesis to a host example in coverage or receipts", async () => fixture(async (root, write) => {
  const body = ["- C1：通过19/20（出处：functional.csv 第 2 行）。", ...Array(8).fill(""),
    "错例：本样例全部通过。", "", "[推测] 未测样例可能有类似结果。\n"].join("\n");
  const { h, reviewer } = await startReview(root, write, body);
  const packet = await h.flow(reviewer, "prepare");
  const source = { file: "functional.csv", start: 2, end: 2, quote: "19,20" };
  const example = { kind: "error-example", status: "supported", sourceRelation: "contradicts", evidence: [source],
    basis: "原始记录19/20反证正文明确展示的全部通过错误。" };
  const fact = { kind: "direct", status: "supported", sourceRelation: "supports", evidence: [source],
    basis: "原始记录的通过数为19，总数为20。" };
  const hypothesis = { kind: "hypothesis", status: "uncertain", basis: "以推测标示未测样例的可能情况。" };
  const [factBlock, exampleBlock, hypothesisBlock] = packet.coverage.blocks;
  assert.deepEqual([factBlock.line, exampleBlock.line, hypothesisBlock.line], [1, 10, 12]);
  await assert.rejects(h.coverage(reviewer, "record", { entries: [{ block: hypothesisBlock.id, parts: [example] }] }), /error-example 须在该原句开头/);
  assert.ok((await h.coverage(reviewer, "status")).pending.includes(hypothesisBlock.id));

  const entries = [
    { block: factBlock.id, parts: [fact] },
    { block: exampleBlock.id, parts: [example] },
    { block: hypothesisBlock.id, parts: [hypothesis] },
  ];
  await h.coverage(reviewer, "record", { entries });
  const quality = Object.fromEntries(Object.keys(QUALITY).map(key => [key, "按当前任务范围提供结论与说明。"]));
  const wrongProse = "模型误述：稿件的错例在第 12 行。";
  await h.assess(reviewer, { ...quality, method: wrongProse, sourceRefs: [source], unverifiedSources: [], unlisted: [], revise: [],
    goalFit: { pass: true, basis: "当前目标只要求核对已登记的样例记录。" },
    candidatePositions: { errorExampleLines: [12], hypothesisLines: [] } });
  await h.flow(reviewer, "review", { checks: [{ id: "C1", ...source, status: "supported", basis: fact.basis }] });
  const firstReceipt = () => JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  let receipt = firstReceipt();
  assert.equal(receipt.decision, "pending-audit");
  assert.equal(receipt.assessmentProvenance.candidatePositionSource, "candidatePositions");
  assert.equal(receipt.qualityChecks.method.basis, wrongProse, "Preserve the original model assessment for audit.");
  assert.deepEqual(receipt.candidatePositions, packet.candidatePositions);
  assert.deepEqual(receipt.candidatePositions.errorExampleLines, [10]);
  assert.deepEqual(receipt.candidatePositions.hypothesisLines, [12]);

  const auditor = (await h.flow("root", "advance")).childId;
  assert.deepEqual((await h.flow(auditor, "prepare")).candidatePositions, packet.candidatePositions);
  await h.coverage(auditor, "record", { entries });
  await h.flow(auditor, "audit");
  receipt = firstReceipt();
  assert.equal(receipt.decision, "accept");
  assert.deepEqual(receipt.candidatePositions, packet.candidatePositions);
  assert.equal(receipt.candidatePositions.candidateSha256, receipt.candidateSha256);
}));
