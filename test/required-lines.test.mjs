import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";
import { acceptedVersion, requiredLineCheck } from "../governance/goals.mjs";

const literal = "须逐字保留这个 [范围]，包括空格和标点。";
const ref = { file: "functional.csv", start: 2, end: 2, quote: "19,20" };
const c1 = "- C1：本例通过19/20（出处：functional.csv 第 2 行）。";
const wrong = "- C1：本例通过20/20（出处：functional.csv 第 2 行）。";
const checks = [{ ...ref, id: "C1", status: "supported", basis: "当前 CSV 原文明载 19/20。" }];
const quality = () => Object.fromEntries(Object.keys(QUALITY).map(key => [key, "核对当前样例和明确范围。"]));
const assessment = () => ({ ...quality(), sourceRefs: [ref], unverifiedSources: [], unlisted: [], revise: [],
  goalFit: { pass: true, basis: "按当前目标提交真实样例。" } });
const fence = body => "```building-loop-required-lines\n" + body + "\n```\n";
const goal = entries => "# 项目目标\n\n" + fence(JSON.stringify(entries));
const configured = [{ unit: "K01", lines: [literal] }];

function configure(write, entries = []) {
  const config = structuredClone(policy);
  config.goalContext = ["overview.md"];
  config.requiredLinesGoal = "overview.md";
  config.units.K01.claims = ["C1"];
  config.units.K01.calculations = {};
  config.units.K01.phases.supplement.read.push("functional.csv");
  write("BUILDING-LOOP.json", JSON.stringify(config));
  write("overview.md", goal(entries));
  return config;
}

async function intake(h) {
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  return executor;
}

test("requiredLinesGoal must be a central goal and read-only for each role", async () => fixture((root, write) => {
  const config = configure(write);
  assert.equal(authority(root).requiredLinesGoal, "overview.md");
  for (const invalid of [
    { ...config, requiredLinesGoal: "candidate.md" },
    { ...config, coordinator: { ...config.coordinator, write: ["overview.md"] } },
  ]) {
    write("BUILDING-LOOP.json", JSON.stringify(invalid));
    assert.throws(() => authority(root), /requiredLinesGoal/);
  }
  config.units.K01.phases.supplement.write.push("overview.md");
  write("BUILDING-LOOP.json", JSON.stringify(config));
  assert.throws(() => authority(root), /只读|目标文件/);
}));

test("configured intake fails closed on missing, malformed or duplicate active preservation fences", async () => fixture(async (root, write) => {
  configure(write);
  write("candidate.md", c1 + "\n" + literal + "\n");
  const h = host(root), executor = await intake(h);
  for (const invalid of [
    "# 没有约束\n",
    "<!--\n" + fence("[]") + "-->\n",
    "```building-loop-required-lines\n[]\n",
    fence("[]") + "\n" + fence("[]"),
    fence("{\"unit\":}"),
    fence('[{"unit":"K01","unit":"K01","lines":["原句"]}]'),
    fence('[{"unit":"K01","lines":["原句"],"l\\u0069nes":["替换原句"]}]'),
    goal([{ unit: "UNKNOWN", lines: [literal] }]),
    goal([configured[0], configured[0]]),
    goal([{ unit: "K01", lines: [literal, literal] }]),
    goal([{ unit: "K01", lines: ["跨\n行"] }]),
  ]) {
    write("overview.md", invalid);
    await h.file(executor, "read", "overview.md");
    await assert.rejects(h.flow(executor, "submit"), /requiredLinesGoal/);
    assert.equal((await h.flow(executor, "status")).phase, "intake");
  }
  // A hidden example does not create a second authority fence.
  write("overview.md", "<!--\n" + fence("invalid example") + "-->\n\n" + goal(configured));
  await h.file(executor, "read", "overview.md");
  assert.equal((await h.flow(executor, "submit")).phase, "review-ready");
  // Independent units may share the same approved physical disclaimer.
  const actual = authority(root);
  write("overview.md", goal([...configured, { unit: "K02", lines: [literal] }]));
  const frame = { root, policy: { ...actual, units: { ...actual.units, K02: {} } } };
  assert.equal(requiredLineCheck(frame, "K01", Buffer.from(literal)).proof.passed, true);
}));

test("G2 preflight and submit enforce exact once on live physical lines while allowing movement and CRLF", async () => fixture(async (root, write) => {
  configure(write);
  write("candidate.md", wrong + "\n");
  const h = host(root), first = await intake(h);
  await h.flow(first, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  await h.flow(reviewer, "prepare");
  assert.equal((await h.flow(reviewer, "review", { checks: [{ id: "C1", status: "unsupported", basis: "当前 CSV 不支持 20/20。",
    finding: { kind: "missing-evidence", quote: "20/20", fix: "改为实际 19/20 并保留定位。" } }] })).phase, "supplement-ready");
  write("overview.md", goal(configured));
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  write("overview.md", goal(configured) + "\n保持当前约束。\n");
  assert.deepEqual(await h.flow(executor,"preflight"),{ok:false,issues:["请先完整读取当前目标约束文件 overview.md"],
    pendingGoalRead:{file:"overview.md",reason:"current-required-lines-goal-read-required"}});
  write("overview.md", goal(configured));
  await h.file(executor,"read","overview.md");
  for (const [draft, reason] of [
    ["- " + literal, "缺失"],
    [literal + " ", "缺失"],
    ["```text\n" + literal + "\n```", "只出现在非正文区域"],
    ["<!--\n" + literal + "\n-->", "只出现在非正文区域"],
    ["<details>\n" + literal + "\n</details>", "只出现在非正文区域"],
    ["> 引用\n" + literal, "只出现在非正文区域"],
    ["`开始\n" + literal + "\n结束`", "只出现在非正文区域"],
    [literal + "\n\n```text\n" + literal + "\n```", "重复"],
    [literal + "\n\n" + literal, "重复"],
  ]) {
    await h.file(executor, "write", "candidate.md", { content: c1 + "\n\n" + draft + "\n", note: "补查稿测试" });
    await h.file(executor, "read", "candidate.md");
    const preflight = await h.flow(executor, "preflight");
    assert.equal(preflight.ok, false);
    assert.equal(preflight.requiredLines.passed, false);
    assert.match(preflight.issues.join("\n"), new RegExp(reason));
    assert.ok(!JSON.stringify(preflight.requiredLines).includes(literal));
    await assert.rejects(h.flow(executor, "submit", { quality: quality() }), /当前目标原句第 1 项/);
  }
  await h.file(executor, "write", "candidate.md", { content: literal + "\r\n\r\n" + c1 + "\r\n", note: "移动原句并按实际证据修订" });
  await h.file(executor, "read", "candidate.md");
  const ready = await h.flow(executor, "preflight");
  assert.equal(ready.ok, true, JSON.stringify(ready.issues));
  assert.deepEqual(ready.requiredLines, { file: "overview.md", sha256: digest(Buffer.from(goal(configured))), count: 1, passed: true });
  assert.equal((await h.flow(executor, "submit", { quality: quality() })).phase, "final-review-ready");
}));

test("review writes a durable preservation rejection after an external draft edit and audit accepts the exact repair", async () => fixture(async (root, write) => {
  configure(write, configured);
  write("candidate.md", c1 + "\n" + literal + "\n");
  const h = host(root), first = await intake(h);
  await h.flow(first, "submit");
  write("candidate.md", c1 + "\n# 改写过的标题\n");
  const reviewer = (await h.flow("root", "advance")).childId;
  await h.flow(reviewer, "prepare");
  await h.assess(reviewer, assessment());
  assert.equal((await h.flow(reviewer, "review", { checks })).phase, "supplement-ready");
  const receipt = name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const rejected = receipt("first.json");
  assert.equal(rejected.decision, "reject");
  assert.equal(rejected.requiredLines.passed, false);
  assert.match(rejected.formatIssues.join("\n"), /当前目标原句第 1 项缺失/);
  assert.ok(!JSON.stringify(rejected.requiredLines).includes(literal));
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.file(executor, "write", "candidate.md", { content: c1 + "\n" + literal + "\n", note: "还原项目目标要求的原句" });
  await h.file(executor, "read", "candidate.md");
  await h.flow(executor, "submit", { quality: quality() });
  const final = (await h.flow("root", "advance")).childId;
  await h.flow(final, "prepare");
  await h.assess(final, assessment());
  assert.equal((await h.flow(final, "review", { checks })).phase, "ledger-review");
  const accepted = receipt("final.json");
  assert.equal(accepted.decision, "accept");
  assert.equal(accepted.requiredLines.passed, true);
  assert.equal(accepted.requiredLines.sha256, accepted.goal.files[0].sha256);
  assert.notEqual(accepted.independentAudit.auditor, accepted.reviewer);

  // Replay an open acceptance saved by an older producer without the new gate.
  await h.file("root", "read", "final.json");
  await h.file("root", "read", "overview.md");
  const book = await h.ledger("root", "read");
  const decisions = book.items.map(item=>({id:item.id,outcome:"completed",basis:"按通过回执完成。",
    evidence:{file:"final.json",start:1,end:4}}));
  const stateHome=path.join(process.env.DSH_HOME,"building-loop-state");
  const statePath=path.join(stateHome,fs.readdirSync(stateHome).find(name=>/^[a-f0-9]{64}\.json$/u.test(name)));
  const state=JSON.parse(fs.readFileSync(statePath,"utf8"));
  const edited=c1+"\n# 外部改写\n";
  write("candidate.md",edited);
  delete accepted.requiredLines;
  accepted.candidateSha256=digest(Buffer.from(edited));
  const olderReceipt=JSON.stringify(accepted);
  write("final.json",olderReceipt);
  const active=state.units.K01;
  active.receiptHash=digest(Buffer.from(olderReceipt));
  fs.writeFileSync(statePath,JSON.stringify(state));
  await assert.rejects(h.ledger("root","review",{decisions}),/当前目标原句第 1 项缺失/);
  const archived=acceptedVersion({root,policy:authority(root)},"K01",{...active,phase:"closed"});
  assert.equal(archived.decision,"accept","A previously closed receipt is not retroactively interpreted by the optional gate.");
}));

const markers = ["[稿件自述]", "[摘录范围]"];
const markerContract = { ...configured[0], requiredMarkers: markers };
const profileContract = { ...markerContract, requiredCitationProfile: "functional.csv" };

test("required marker counts use live leading tokens rather than hidden, inline or linked copies", async () => fixture((root, write) => {
  configure(write,[markerContract]);
  const frame={root,policy:authority(root)};
  const check=body=>requiredLineCheck(frame,"K01",Buffer.from(literal+"\n\n"+body));
  const scope="1) [摘录范围] 范围以本地登记条目为准。";
  for(const sample of [
    "文中提到 [稿件自述] 但没有单独标记。",
    "- `[稿件自述]` 随后的正文可见。",
    "`跨行代码\n[稿件自述] 隐藏` 这里可见。",
    "```text\n[稿件自述] 隐藏\n```",
    "<!--\n[稿件自述] 隐藏\n-->",
    "<details>\n[稿件自述] 隐藏\n</details>",
    "> [稿件自述] 仅为引用。",
    "    [稿件自述] 缩进代码。",
    "[稿件自述](candidate.md) 这里只是链接。",
  ]) {
    const result=check(sample+"\n\n"+scope);
    assert.deepEqual(result.issues.map(issue=>issue.match(/\[稿件自述\]缺失/u)?.[0]),["[稿件自述]缺失"],sample);
    assert.equal(result.proof.requiredMarkerCount,2);
  }
  const visible="- [稿件自述] 已按本稿核对。";
  assert.equal(check(visible+"\n\n"+scope+"\n\n<!--\n[稿件自述] 隐藏\n-->").proof.passed,true);
  assert.match(check(visible+"\n"+visible+"\n"+scope).issues[0],/\[稿件自述\]重复/u);
  for(const malformed of [
    goal([{...markerContract,requiredMarkers:["[未知]"]}]),
    goal([{...markerContract,requiredMarkers:[markers[0],markers[0]]}]),
    goal([{...markerContract,requiredMarkers:markers[0]}]),
    goal([{...profileContract,requiredCitationProfile:"../functional.csv"}]),
    goal([{...profileContract,requiredCitationProfile:"overview.md"}]),
    fence('[{"unit":"K01","lines":["原句"],"requiredMarkers":["[稿件自述]"],"required\\u004darkers":[]}]'),
    fence('[{"unit":"K01","lines":["原句"],"requiredCitationProfile":"functional.csv","requiredCitationProfile":"functional.csv"}]'),
  ]) {
    write("overview.md",malformed);
    assert.throws(()=>check(visible+"\n"+scope),/requiredLinesGoal/u);
  }
}));

test("opt-in compound manuscript proof blocks missing or false typed values before supplement submit", async () => fixture(async (root, write) => {
  configure(write);
  write("candidate.md",wrong+"\n");
  const h=host(root),first=await intake(h);
  await h.flow(first,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  await h.flow(reviewer,"prepare");
  await h.flow(reviewer,"review",{checks:[{id:"C1",status:"unsupported",basis:"原始证据不支持该值。",
    finding:{kind:"missing-evidence",quote:"20/20",fix:"依实际 CSV 改为 19/20。"}}]});
  write("overview.md",goal([profileContract]));
  const executor=(await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");
  const profile="- [稿件自述] 行号定位 2 行：带 functional.csv 的行号定位为第 1-2 行；同带 [模拟] 1 行：第 2 行。";
  const body=c1+"\n- [模拟] 本地样例引用同一条记录（出处：functional.csv 第 2 行）。\n";
  const scope="\n- [摘录范围] 此处只说明本地登记。\n"+literal+"\n";
  const draft=async value=>{
    await h.file(executor,"write","candidate.md",{content:body+value+scope,note:"回归组合稿件统计"});
    await h.file(executor,"read","candidate.md");
    return h.flow(executor,"preflight");
  };
  for(const invalid of ["","- [稿件自述]","- [稿件自述] 本稿有 2 行引用。",profile+"\n"+profile,
    profile.replace("定位 2 行","定位 3 行"),profile.replace("第 1-2 行","第 1、3 行"),
    profile.replace("[模拟] 1 行","[模拟] 2 行"),profile.replace("：第 2 行。","：第 1 行。")]) {
    const result=await draft(invalid);
    assert.equal(result.ok,false,invalid);
    assert.equal(result.requiredLines.citationProfileRequired,true);
    assert.equal(result.requiredLines.requiredMarkerCount,2);
    assert.match(result.issues.join("\n"),/组合稿件自述/u);
    await assert.rejects(h.flow(executor,"submit",{quality:quality()}),/组合稿件自述/u);
  }
  const result=await draft(profile);
  assert.equal(result.ok,true,JSON.stringify(result.issues));
  assert.deepEqual(result.requiredLines,{file:"overview.md",sha256:digest(Buffer.from(goal([profileContract]))),
    count:1,requiredMarkerCount:2,citationProfileRequired:true,passed:true});
  assert.equal((await h.flow(executor,"submit",{quality:quality()})).phase,"final-review-ready");
}));
