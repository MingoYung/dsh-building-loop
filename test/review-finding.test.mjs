import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";

// This exact claim and heading are the C4 portion of the 063219Z first review.
const fragment = "NIST 散点图页面原文举了 GitHub 列表中的 failure 和 success 两项";
const row = "- C4：" + fragment + "（出处：sources/nist-scatter.md 第 4 行）。";
const basis = "页面快照第 4 行属于编辑说明，不能证明 NIST 原文列举了这些结论。";
const finding = { kind: "missing-evidence", quote: "- C4：" + fragment, fix: "删除 C4 或改引实际登记的 GitHub 摘录。" };
const check = { id: "C4", status: "unsupported", line: 13, basis, finding };

/** Run the actual registered tools, with full coverage recorded independently
 * of the submitted numbered check so a quote fix cannot weaken coverage. */
async function firstReview(root, write) {
  const configured = structuredClone(policy);
  configured.units.K01.claims = ["C4"];
  configured.units.K01.calculations = {};
  write("BUILDING-LOOP.json", JSON.stringify(configured));
  write("candidate.md", "\n".repeat(12) + row + "\n");
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const { coverage } = await h.flow(reviewer, "prepare");
  await h.coverage(reviewer, "record", { entries: coverage.blocks.map(block => ({ block: block.id, parts: [{
    kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis,
    finding: { ...finding, quote: fragment },
  }] })) });
  return { h, reviewer };
}

for (const [name, quote, canonical] of [
  ["exact prefix and partial body", finding.quote, fragment],
  ["entire exact Markdown row", row, row.slice("- C4：".length)],
  ["literal body without heading", fragment, fragment],
]) {
  test("a C4 finding accepts " + name + " and persists the current body span", async () => fixture(async (root, write) => {
    const { h, reviewer } = await firstReview(root, write);
    const result = await h.flow(reviewer, "review", { checks: [{ ...check, finding: { ...finding, quote } }] });
    assert.equal(result.phase, "supplement-ready");
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
    assert.deepEqual(receipt.checks[0], { ...check, finding: { ...finding, quote: canonical } });
    assert.ok(receipt.coverage.rejected.length > 0);
  }));
}

test("missing C4 findings, heading-only, wrong IDs and nonliteral text remain parameter errors", async () => fixture(async (root, write) => {
  const { h, reviewer } = await firstReview(root, write);
  const submit = (proposal, actor = reviewer) => h.flow(actor, "review", { checks: [proposal] });
  const { finding: _omitted, ...withoutFinding } = check;
  await assert.rejects(submit(withoutFinding), /C4 的 unsupported 须提供 finding\.kind.*候选第 13 行正文.*failure 和 success/);
  for (const quote of ["- C4：", "- C5：" + fragment, "* C4：" + fragment, fragment + "，还有 neutral", fragment + "\n另一行"]) {
    await assert.rejects(submit({ ...check, finding: { ...finding, quote } }), /C4 的 finding\.quote 未绑定当前候选正文.*候选第 13 行正文.*failure 和 success/);
  }
  await assert.rejects(submit({ ...check, id: "C5" }), /核验编号无效/);
  await assert.rejects(submit({ ...check, line: 12 }), /候选行号应为 13/);
  await assert.rejects(submit(check, "root"), error => !error.message.includes(fragment));
  assert.equal((await h.flow("root", "status")).units[0].phase, "first-review");
  assert.equal(fs.existsSync(path.join(root, "first.json")), false);
}));

test("an exact heading grants neither stale candidate bytes nor unauthorized counterevidence", async () => fixture(async (root, write) => {
  const { h, reviewer } = await firstReview(root, write);
  const submit = proposal => h.flow(reviewer, "review", { checks: [proposal] });
  await assert.rejects(submit({ ...check, file: "timing.csv", start: 2, end: 2, finding: { ...finding, kind: "contradiction" } }), /资料引用不在本轮证据授权中/);
  write("candidate.md", "\n".repeat(12) + row.replace("failure 和 success", "cancelled 和 skipped") + "\n");
  await assert.rejects(submit(check), /验收前须完整读取当前候选正文/);
  await h.flow(reviewer, "prepare");
  await assert.rejects(submit(check), /finding\.quote 未绑定当前候选正文.*cancelled 和 skipped/);
  assert.equal((await h.flow("root", "status")).units[0].phase, "first-review");
  assert.equal(fs.existsSync(path.join(root, "first.json")), false);
}));
