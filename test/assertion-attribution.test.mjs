import assert from "node:assert/strict";
import test from "node:test";
import { sectionSourceAttribution } from "../governance/assertion-attribution.mjs";

const table = "records/samples.md";
const other = "records/reference.md";
const sources = [table, other];
const bullet = (id, body) => `- ${id}：${body}`;
const locate = rows => sectionSourceAttribution(Buffer.from(rows.join("\r\n")), 2, table, sources);

test("measures visible numbered claims only until the next Markdown heading", () => {
  const rows = ["## 本节来源", "下面的三条案例使用同一登记资料。", "", bullet("C1", `原始记录甲（${table} 第3行）。`),
    bullet("C2", `原始记录乙（出处：\`${table}\` 第4行）。`), bullet("C3", `原始记录丙（${table}#L5-L6）。`), "",
    "下一节", "------", bullet("C4", `另一判断（${other}:12）。`)];
  const result = locate(rows);
  assert.equal(result.matches, true);
  assert.deepEqual(result.section, { headingLine: 1, startLine: 2, endLine: 7 });
  assert.deepEqual(result.rows.map(({ id, line, locators }) => ({ id, line, locators })), [
    { id: "C1", line: 4, locators: [{ file: table, start: 3, end: 3 }] },
    { id: "C2", line: 5, locators: [{ file: table, start: 4, end: 4 }] },
    { id: "C3", line: 6, locators: [{ file: table, start: 5, end: 6 }] },
  ]);
});

test("cannot borrow coded or quoted locators, headings, or claim rows", () => {
  const rows = ["# 本节来源", "核实该节中的编号行。", "", "```md", "## 假分节",
    bullet("C8", `代码示例（${other} 第1行）。`), "```", "", "<!--",
    "## 假分节", bullet("C9", `HTML 注释（${other} 第1行）。`), "-->", "",
    "> ## 引用标题", `> ${bullet("C7", `被引用行（${other} 第1行）。`)}`, "",
    bullet("C2", `正文示例代码：\`${other} 第1行\`，实际出处（${table} 第2行）。`)];
  const result = locate(rows);
  assert.equal(result.matches, true);
  assert.deepEqual(result.rows, [{ id: "C2", line: 17, status: "attributed", locators: [{ file: table, start: 2, end: 2 }] }]);
  assert.equal(sectionSourceAttribution(Buffer.from(rows.join("\n")), 5, table, sources).matches, false);
});

test("blocks another, missing, unapproved, invalid, or ambiguously repeated row citation", () => {
  const variants = [
    [bullet("C2", `另一来源（出处：${other} 第3行）。`), "different-source"],
    [bullet("C2", `两个来源（出处：${table} 第2行；${other} 第3行）。`), "different-source"],
    [bullet("C2", `另一来源缺授权（出处：${table} 第2行；records/unknown.md 第3行）。`), "unresolved-locator"],
    [bullet("C2", `同行来源需要有效范围（${table} 第2行；${table} 第8-2行）。`), "unresolved-locator"],
    [bullet("C2", `另一定位未解析（${table} 第2行；records/unknown.md 第X行）。`), "unresolved-locator"],
    [bullet("C2", `另一引用用网页地址（${table} 第2行；来源：https://example.org/page）。`), "unresolved-locator"],
    [bullet("C2", `另一文档以锚定位（${table} 第2行；records/unknown.md#section）。`), "unresolved-locator"],
    [bullet("C2", `这里只提到了 ${table}，未定位。`), "missing-locator"],
    [bullet("C2", `这里只给出代码示例 \`${table} 第3行\`。`), "missing-locator"],
    [bullet("C1", `重复编号（${table} 第3行）。`), "duplicate-claim"],
  ];
  for (const [claim, expectedStatus] of variants) {
    const result = locate(["# 本节来源", "核实编号行。", "", bullet("C1", `真实出处（${table} 第2行）。`), claim]);
    assert.equal(result.matches, false, claim);
    assert.equal(result.rows.at(-1).status, expectedStatus, claim);
  }
  assert.equal(locate(["# 没有编号行", "只有描述文字。"]).matches, false);
  assert.equal(locate(["没有章节", "只有描述文字。", bullet("C1", `正文（${table} 第2行）。`)]).matches, false);
  assert.equal(sectionSourceAttribution(Buffer.from("# 一节\n检查。"), 2, other, [table]).reason, "unauthorized-source");
});
