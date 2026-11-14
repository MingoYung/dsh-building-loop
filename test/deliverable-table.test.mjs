import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { deliverableTableContract, deliverableTableIssues } from "../governance/deliverable-table.mjs";
import { decideConversationStart, groundConversationMaterials, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { DELIVERY, GOAL, MATERIALS, initializeConversationProject, privateProjectRoot, privateProjectUsesOwnerTable } from "../governance/conversation-project.mjs";
import { authority, digest, keyOf } from "../governance/policy.mjs";
import { fixture, host } from "./helpers.mjs";
import { QUALITY } from "../governance/preflight.mjs";

const declaration = "交付要求：只给一份短 Markdown。用一张“| 编号 | 值 | 依据 |”表逐项填 Q1、Q2、Q3、Q4、Q5、Q6，每个编号恰好一行。值一格只写题目要求的值。";
const opening = "开始建设：题目涉及多工位排程。\n\n" + declaration;
const contract = deliverableTableContract(opening);
const table = (rows, header = "| 编号 | 值 | 依据 |") => [header, "| --- | :---: | --- |", ...rows].join("\n");
const rows = ["H", "5", "7", "9", "12", "14"].map((value, index) => `| Q${index + 1} | ${value} | 推导 |`);

test("the owner instruction activates only an explicit unique table requirement", () => {
  assert.deepEqual(contract, { columns: ["编号", "值", "依据"], ids: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] });
  for (const instruction of [
    "开始建设：Q1、Q2 是需要分析的原始材料。",
    "例子：" + declaration,
    "> " + declaration,
    "```markdown\n" + declaration + "\n```",
    "<!--\n" + declaration + "\n-->",
    "  - " + declaration,
    "交付要求：不要用一张“| 编号 | 值 | 依据 |”表逐项填 Q1、Q2，每个编号恰好一行。",
    declaration + "\n\n" + declaration.replaceAll("Q", "E"),
    declaration.replace("Q1、Q2", "Q1、Q1"),
    declaration.replace("恰好一行。", "恰好一行或两行。"),
    declaration.replace("| 值 | 依据 |", "| 值 | 值 |"),
  ]) assert.equal(deliverableTableContract(instruction), undefined, instruction);
  assert.equal(deliverableTableContract("交付要求：用一张“| 编号 | 状态 |”表逐项填 1、R-2，每个编号恰好一行。")?.ids[1], "R-2");
});

test("correct answers with substituted row numbers cannot pass the original requirement", () => {
  const oldDraft = table(rows.map(row => row.replace("Q", "")));
  assert.match(deliverableTableIssues(Buffer.from(oldDraft), contract)[0], /缺少原样编号 Q1、Q2、Q3、Q4、Q5、Q6/u);
  assert.deepEqual(deliverableTableIssues(Buffer.from(table(rows)), contract), []);
  assert.deepEqual(deliverableTableIssues(Buffer.from(table(rows.map(row => row.replace(/Q\d/u, id => "`" + id + "`")))), contract), []);
  assert.deepEqual(deliverableTableIssues(Buffer.from(table(rows).split("\n").map(row => row.replace(/^\||\|$/gu, "")).join("\n")), contract), []);
});

test("missing and duplicate IDs are separate and unrelated tables do not satisfy the contract", () => {
  const draft = table([rows[1], rows[1], ...rows.slice(2)]);
  assert.deepEqual(deliverableTableIssues(Buffer.from(draft), contract), ["交付表缺少原样编号 Q1", "交付表编号重复 Q2，每个编号只能有一行"]);
  assert.match(deliverableTableIssues(Buffer.from(table(rows, "| 其他 | 值 | 依据 |")), contract)[0], /一张正文表格/u);
  assert.match(deliverableTableIssues(Buffer.from(table(rows) + "\n\n" + table(rows)), contract)[0], /一张正文表格/u);
  assert.deepEqual(deliverableTableIssues(Buffer.from(table(rows).replace("推导", "B\\|E")), contract), []);
  assert.deepEqual(deliverableTableIssues(Buffer.from(draft), undefined), []);
});

test("an empty answer, extra row, or malformed row cannot complete the declared table", () => {
  assert.deepEqual(deliverableTableIssues(Buffer.from(table(["| Q1 |  | 推导 |", ...rows.slice(1)])), contract), ["交付表第 3 行的答案为空"]);
  assert.deepEqual(deliverableTableIssues(Buffer.from(table([...rows, "| Q7 | 1 | 推导 |"])), contract), ["交付表第 9 行的编号不在明确要求的清单中"]);
  assert.deepEqual(deliverableTableIssues(Buffer.from(table([...rows, "| | | |"])), contract), ["交付表第 9 行的编号不在明确要求的清单中", "交付表第 9 行的答案为空"]);
  assert.deepEqual(deliverableTableIssues(Buffer.from(table([...rows, "| Q7 | 1 |"])), contract), ["交付表第 9 行的列数与表头不符"]);
});

test("rows in quoted, fenced, nested or HTML Markdown cannot replace visible rows", () => {
  const candidate = table(rows);
  for (const hidden of [
    candidate.split("\n").map(line => "> " + line).join("\n"),
    "```markdown\n" + candidate + "\n```",
    "- 引用表格：\n\n" + candidate.split("\n").map(line => "  " + line).join("\n"),
    "<details>\n\n" + candidate + "\n\n</details>",
  ]) assert.match(deliverableTableIssues(Buffer.from(hidden), contract)[0], /一张正文表格/u);
});

test("the actual intake handler keeps an invalid draft at intake and accepts the corrected table", () => fixture(async (root, write) => {
  const hostHome = process.env.DSH_HOME;
  const current = latestConversationUser([{ type: "user/message", seq: 9,
    data: { source: { kind: "user" }, content: [{ type: "text", text: opening }] } }]);
  const proposal = proposeConversationTask(hostHome, "root", current, {
    goal: "排程分析", deliverable: "表格答复", scope: "本会话样本",
  }).proposal;
  decideConversationStart(hostHome, "root", current, proposal.id, "start",
    approved => initializeConversationProject(hostHome, "root", root, approved), { typed: true });
  write("candidate.md", table(rows.map(row => row.replace("Q", ""))));
  const native = host(root, { automaticCoverage: false });
  const executor = (await native.flow("root", "advance", { note: "已有授权项目的执行说明" })).childId;
  assert.match(native.activations[0].request.prompt[0].text, /已有授权项目的执行说明/u);
  assert.deepEqual((await native.flow(executor, "prepare")).deliverableTable, contract);
  await assert.rejects(native.flow(executor, "submit"), /缺少原样编号 Q1、Q2、Q3、Q4、Q5、Q6/u);
  assert.equal((await native.flow(executor, "status")).phase, "intake");
  write("candidate.md", table(rows));
  await native.file(executor, "read", "candidate.md");
  assert.equal((await native.flow(executor, "submit")).phase, "review-ready");
}));

function approveDirect(root, instruction, proposed, excerpts = []) {
  const hostHome = process.env.DSH_HOME;
  const events = [{ type: "user/message", seq: 9,
    data: { source: { kind: "user" }, content: [{ type: "text", text: instruction }] } }];
  const current = latestConversationUser(events);
  const materials = groundConversationMaterials(events, 0, excerpts);
  const proposal = proposeConversationTask(hostHome, "root", current, proposed, materials).proposal;
  decideConversationStart(hostHome, "root", current, proposal.id, "start",
    accepted => initializeConversationProject(hostHome, "root", root, accepted), { typed: true });
  return privateProjectRoot(hostHome, "root", proposal.id);
}

test("new private table intake preserves owner bytes and discards proposed answers from the author handoff", () => fixture(async root => {
  fs.unlinkSync(path.join(root, "BUILDING-LOOP.json"));
  const evidence = "[S1] 工位允许前一任务恰好结束时开始下一任务。";
  const original = "开始建设：按排程约束完成题目。\n\n" + evidence + "\n\n" + declaration;
  const proposed = { goal: "模型预测污染：F 从 10 开始", deliverable: "模型预测污染：Q5 填 13", scope: "模型预测污染：Q6 填 13" };
  const project = approveDirect(root, original, proposed, [evidence]);
  assert.equal(privateProjectUsesOwnerTable(project), true);
  const goal = fs.readFileSync(path.join(project, GOAL), "utf8");
  assert.doesNotMatch(goal, /模型预测污染/u);
  const pinned = fs.readFileSync(path.join(project, MATERIALS));
  assert.ok(pinned.toString("utf8").includes(evidence));
  assert.equal(authority(project).sourcePins[keyOf(MATERIALS)].sha256, digest(pinned));
  const native = host(root, { automaticCoverage: false });
  const executor = (await native.flow("root", "advance", { note: "模型预测污染：按 13 写结果" })).childId;
  assert.match(native.activations[0].request.prompt[0].text, /完整读取用户开工原文/u);
  assert.doesNotMatch(native.activations[0].request.prompt[0].text, /模型预测污染/u);
  assert.doesNotMatch(native.prompt(executor), /模型预测污染/u);
  const prepared = await native.flow(executor, "prepare");
  assert.deepEqual(prepared.instruction, { seq: 9, sha256: digest(original), text: original });
  assert.deepEqual(prepared.deliverableTable, contract);
  assert.equal(prepared.files.find(file => file.path === MATERIALS).sha256, digest(pinned));
  assert.ok(prepared.files.find(file => file.path === MATERIALS).lines.some(([, text]) => text === evidence));
  await native.flow(executor, "block", { note: "记录可恢复的接单阻塞" });
  const restored = await native.flow("root", "advance", { note: "模型预测污染：继续写 13" });
  assert.equal(restored.childId, executor);
  const message = native.notifications.findLast(entry => entry.target === executor).content[0].text;
  assert.match(message, /完整读取用户开工原文/u);
  assert.doesNotMatch(message, /模型预测污染/u);
}));

test("a private start without a table keeps its accepted proposal and intake note", () => fixture(async root => {
  fs.unlinkSync(path.join(root, "BUILDING-LOOP.json"));
  const original = "开始建设：给出两条清单。";
  const proposed = { goal: "按确认的目标写清单", deliverable: "两条清单", scope: "既有确认范围" };
  const project = approveDirect(root, original, proposed);
  assert.equal(privateProjectUsesOwnerTable(project), false);
  assert.equal(fs.existsSync(path.join(project, MATERIALS)), false);
  const goal = fs.readFileSync(path.join(project, GOAL), "utf8");
  for (const value of Object.values(proposed)) assert.ok(goal.includes(value));
  const native = host(root, { automaticCoverage: false });
  await native.flow("root", "advance", { note: "清单的派单备注" });
  assert.match(native.activations[0].request.prompt[0].text, /清单的派单备注/u);
}));

for (const selected of [true, false]) test(`owner case rows are citable by both reviewers with selected excerpts=${selected}`, () => fixture(async root => {
  fs.unlinkSync(path.join(root, "BUILDING-LOOP.json"));
  const rule = "仅支持一区。已指定其他区域时禁止，未指定时待补。";
  const cases = ["R1：落点一区。", "R2：落点二区。", "R3：未填写落点。"];
  const instruction = ["开始建设：核实恢复落点。", rule, ...cases,
    "交付要求：用一张“| 编号 | 值 | 依据 |”表逐项填 R1、R2、R3，每个编号恰好一行。"].join("\r\n");
  const project = approveDirect(root, instruction, { goal: "核实范围", deliverable: "判定表", scope: "当前资料" }, selected ? [rule] : []);
  const source = fs.readFileSync(path.join(project, MATERIALS), "utf8");
  assert.ok(source.includes(instruction));
  assert.ok(source.includes(`原文 SHA-256 ${digest(instruction)}`));
  const sourceLines = source.split(/\r?\n/u);
  const sourceRef = quote => {
    const line = sourceLines.indexOf(quote) + 1;
    assert.ok(line > 0);
    return { file: MATERIALS, start: line, end: line, quote };
  };
  const caseRefs = cases.map(sourceRef);
  const ruleRef = sourceRef(rule);
  const native = host(root, { automaticCoverage: false });
  await assert.rejects(native.file("root", "read", MATERIALS), /读白名单/u);
  const executor = (await native.flow("root", "advance")).childId;
  await native.flow(executor, "prepare");
  await native.file(executor, "write", DELIVERY, { content: table([
    "| R1 | 放行 | 一区 |", "| R2 | 禁止 | 已指定二区 |", "| R3 | 待补 | 未填写 |",
  ]) + "\n\n大白话：一区放行，明确二区就不接，没填的再问。\n", note: "按用户提供的各项落点整理判定" });
  await native.file(executor, "read", DELIVERY);
  assert.equal((await native.flow(executor, "submit")).phase, "review-ready");
  async function check(actor) {
    await native.flow(actor, "prepare");
    const invoke = args => native.invoke(actor, "building_loop_coverage", args);
    const { blocks } = await invoke({ action: "inventory" });
    const block = blocks.find(b => b.text.includes("R2"));
    const caseProof = index => ({ kind: "direct", status: "supported", sourceRelation: "supports",
      basis: ["原文 R1 明确位于受支持的一区。", "原文 R2 明确指定二区，适用规则中的明确排除。", "原文 R3 未指定落点，按规则待补。"][index],
      evidence: [caseRefs[index], ruleRef] });
    const correct = caseProof(1);
    await assert.rejects(invoke({ action: "record", entries: [{ block: block.id, parts: [{ ...correct,
      evidence: [{ ...caseRefs[1], quote: cases[2] }],
    }] }] }), /逐字/u);
    const entries = blocks.map(b => {
      const row = /^\| R([1-3]) /u.exec(b.text);
      const part = row ? caseProof(Number(row[1]) - 1) : b.text.startsWith("|") ?
        { kind: "nonfactual", status: "supported", basis: "表头或分隔符，仅用于排版。" } :
        { kind: "direct", status: "supported", sourceRelation: "supports", basis: "用易懂的说法重述一区、其他地区和未填的三种处置。", evidence: [ruleRef] };
      return { block: b.id, parts: [part] };
    });
    assert.deepEqual((await invoke({ action: "record", entries })).invalid, []);
    const { record } = await invoke({ action: "status", block: block.id });
    assert.equal(record.parts[0].evidence[0].quote, cases[1]);
  }
  const reviewer = (await native.flow("root", "advance")).childId;
  await check(reviewer);
  const quality = Object.fromEntries(Object.keys(QUALITY).map(key => [key, "受控样本核对本会话的三条落点。"]));
  await native.assess(reviewer, { ...quality, revise: [], unlisted: [], unverifiedSources: [], sourceRefs: caseRefs,
    goalFit: { pass: true, basis: "交付逐行说明三区输入的归类依据。" } });
  const verdict = await native.flow(reviewer, "review", { note: "已核对受控样本与原文落点", checks: [] });
  assert.equal(verdict.phase, "first-audit-ready");
  const auditor = (await native.flow("root", "advance")).childId;
  assert.notEqual(auditor, reviewer);
  await check(auditor);
}));
