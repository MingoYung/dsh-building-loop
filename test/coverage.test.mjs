import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { authority, digest, keyOf } from "../governance/policy.mjs";
import { acceptedVersion, goalSnapshot, needsRevalidation } from "../governance/goals.mjs";
import { QUALITY, lineList, supplementChecks } from "../governance/preflight.mjs";
import { CLASSIFICATION_VERSION, neutralTextSpans, coverageAction, coverageSummary, documentCoverage, citationLineCounts, candidateCitationProfiles, classificationDisagreements, recordMeetsDispute, requireDisputedProof, requireStoredFootnoteBindings, requireStoredObjectChecks, sourceLineEnumerationChecks, simulationScopeLocatorIssues, projectPolicyContract } from "../governance/coverage.mjs";

/** Raw helpers test the mandatory production gate without auto-generated reviews. */
function environment(root) {
  const p = authority(root), spec = p.units.K01;
  spec.claims = []; spec.calculations = {};
  const active = { phase: "final-review", seen: {} };
  const frame = { root, policy: p, reads: spec.phases[active.phase].read };
  const read = file => {
    const bytes = fs.readFileSync(path.join(root, file));
    active.seen[keyOf(file)] = { hash: digest(bytes), ranges: [[1,lineList(bytes).length]] };
  };
  for (const file of frame.reads) read(file);
  const invoke = (action,args={}) => coverageAction(frame,active,spec,{action,...args});
  return { frame,active,spec,read,invoke,finish:()=>coverageSummary(frame,active,spec) };
}
const nonfact = {kind:"nonfactual",status:"supported",basis:"这是文档结构标题，没有陈述外部事实。"};
const ref = {file:"functional.csv",start:2,end:2,quote:"19,20"};
const fact = {kind:"direct",status:"supported",sourceRelation:"supports",basis:"只转述该样例的通过和总数。",evidence:[ref]};

test("frozen B9 reconciles only the fixed introduction when both roles verify the same complete literal", () => {
  const archive = JSON.parse(fs.readFileSync(new URL("../experiments/observations-0.7.37-host-results.json", import.meta.url)));
  const frozen = archive.artifacts.frozenQuotationRecheck.record;
  const { block, line, text, roles } = frozen.disputes[0];
  assert.equal(block, "B9-cca61760");
  const make = parts => ({ candidateSha256: frozen.candidateSha256, pending: [], rejected: [], records: [{
    block, line, text, lineText: text + '"', parts: parts.map(part => ({ ...part, quote: part.text,
      ...(part.kind === "direct" ? { sourceRelation: "supports", evidence: part.refs } : {}) })),
  }] });
  const [first, second] = roles.map(make);
  assert.deepEqual(classificationDisagreements(first, second), []);
  assert.equal(first.records[0].parts[0].kind, "direct");
  assert.equal(second.records[0].parts[0].kind, "nonfactual");

  for (const change of [
    ref => ({ ...ref, file: "sources/different.md" }),
    ref => ({ ...ref, start: 2, end: 2 }),
    ref => ({ ...ref, sha256: "0".repeat(64) }),
    ref => ({ ...ref, evidenceSpan: "0".repeat(64) }),
    ref => ({ ...ref, quote: "这份数据只记录单次离线校准演练。" }),
  ]) {
    const altered = structuredClone(second);
    altered.records[0].parts[1].evidence[0] = change(altered.records[0].parts[1].evidence[0]);
    assert.equal(classificationDisagreements(first, altered).length, 1);
  }
  const factChanged = structuredClone(second);
  factChanged.records[0].parts[1].kind = "nonfactual";
  assert.ok(classificationDisagreements(first, factChanged)[0].factualSpans.some(([, end]) => end > 41));

  const scopeChanged = structuredClone(second);
  const scopeFinding = { kind: "scope", quote: "未采集生产环境数据。", fix: "确认原始材料记录的实际范围" };
  scopeChanged.records[0].parts[1].finding = scopeFinding;
  scopeChanged.records[0].parts[1].sourceRelation = "contradicts";
  scopeChanged.records[0].parts[1].status = "unsupported";
  scopeChanged.rejected = [scopeFinding];
  assert.equal(classificationDisagreements(first, scopeChanged).length, 1);
  assert.deepEqual(scopeChanged.rejected, [scopeFinding]);

  const extra = "已验证适用于线上。";
  const naive = [first, second].map(summary => ({ ...summary, records: summary.records.map(record => ({
    ...record, text: extra + record.text, lineText: extra + record.lineText,
    parts: record.parts.map((part, index) => ({ ...part, start: index ? part.start + extra.length : 0, end: part.end + extra.length })),
  })) }));
  assert.ok(classificationDisagreements(...naive)[0].factualSpans.some(([start]) => start === 0));
});

test("measurement admits exact redundant source rows, and rejects unrelated or altered evidence", () => fixture(async (root, write) => {
  const p = structuredClone(policy);
  const unit = p.units.K01;
  unit.claims = ["C2"];
  unit.hostResults = { calculations: ["C2"], citationLines: ["timing.csv"] };
  unit.phases.intake = { read: ["candidate.md", "timing.csv"], write: ["candidate.md"] };
  unit.phases["first-review"].read.push("timing.csv");
  unit.phases["first-review"].evidence.push("timing.csv");
  write("BUILDING-LOOP.json", JSON.stringify(p));
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.file(executor, "write", "candidate.md", { content: "- C2：本次对照耗时降幅 {{building-loop:metric:C2}}。\n\n{{building-loop:citation-lines:timing.csv}}\n",
    note: "由宿主计算本轮对照耗时降幅" });
  await h.file(executor, "read", "candidate.md");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  for (const file of ["overview.md", "candidate.md", "timing.csv"]) await h.file(reviewer, "read", file);
  const { blocks } = await h.coverage(reviewer, "inventory");
  const metric = blocks.find(row => row.hostMeasurement?.id === "C2");
  const count = blocks.find(row => row.hostMeasurement?.kind === "citation-lines");
  const direct = { kind: "direct", status: "supported", sourceRelation: "supports",
    basis: "原始表的基准列与对照列支持本次耗时降幅，引用统计仅覆盖当前稿。" };
  const record = (block, evidence) => h.coverage(reviewer, "record", { entries: [{ block: block.id,
    parts: [{ ...direct, measurement: block.hostMeasurement.id, evidence }] }] });
  const before = { file: "timing.csv", start: 2, end: 2, quote: "before,120" };
  const grouped = { file: "timing.csv", start: 2, end: 3, quote: "before,120\nafter,96" };
  assert.deepEqual((await record(metric, [before, grouped])).recorded, [metric.id]);
  const { record: accepted } = await h.coverage(reviewer, "status", { block: metric.id });
  assert.deepEqual(accepted.parts[0].evidence.map(({ file, start, end, quote }) => ({ file, start, end, quote })),
    [before, { file: "timing.csv", start: 3, end: 3, quote: "after,96" }]);
  assert.deepEqual((await record(count, [])).recorded, [count.id]);
  for (const conflicting of [
    { ...before, quote: "before,121" },
    { ...before, file: "functional.csv" },
    { ...grouped, start: 1, quote: "phase,mean_ms\n" + grouped.quote },
    { ...grouped, end: 100, quote: "before,120" },
  ]) await assert.rejects(record(metric, [conflicting]), /host-measurement.*不完全相同/u);
  await assert.rejects(record(count, [before]), /host-measurement.*不完全相同/u);
  assert.deepEqual((await record(metric)).recorded, [metric.id]);
}));

test("project-policy proofs bind the current read goal and keep external evidence separate", () => fixture(async (root, write) => {
  const clause = "待补件按当前项目规则进入复核。";
  const rule = { file: "overview.md", start: 2, end: 2, quote: clause };
  const p = structuredClone(policy);
  p.goalContext = [rule.file];
  p.units.K01.requireSourcePins = true;
  p.sourcePins = Object.fromEntries(["functional.csv", "timing.csv"].map(file => [file, {
    kind: "primary", locator: `fixture:${file}`, sha256: digest(fs.readFileSync(path.join(root, file))),
  }]));
  write("BUILDING-LOOP.json", JSON.stringify(p));
  write(rule.file, "# 总纲\n" + clause + "\n另行处理归档。\n");
  write("candidate.md", "本项目将待补件列入复核（出处：overview.md 第2行）。\n");
  const e = environment(root);
  e.frame.reads = [...e.frame.reads, rule.file];
  e.active.goal = goalSnapshot(e.frame);
  delete e.active.seen[keyOf(rule.file)];
  const [block] = e.invoke("inventory").blocks;
  const inference = { rule: "project-policy", policy: [rule], premises: [], scope: "当前项目待补件",
    assumptions: [], counterexample: { possible: false, reason: "当前总纲直接给待补件指定复核动作。" } };
  const part = { kind: "inference", status: "supported", sourceRelation: "supports", basis: "转述已授权项目规则。", inference };
  const record = part => e.invoke("record", { entries: [{ block: block.id, parts: [part] }] });
  assert.throws(() => record(part), /已读的当前总纲/);
  e.read(rule.file);
  assert.throws(() => record({ ...fact, evidence: [rule] }), /总纲条款可用于项目内规则/);
  assert.throws(() => record({ ...part, inference: { ...inference, policy: [{ ...rule, quote: "所有件均通过" }] } }), /逐字/);
  assert.throws(() => record({ ...part, inference: { ...inference, premises: [rule] } }), /总纲条款可用于项目内规则/);
  assert.throws(() => record({ ...part, inference: { ...inference, policy: [{ ...rule, start: 3, end: 3, quote: "另行处理归档。" }] } }), /位置须与/);
  // Reproduce the native partly flattened payload, then use the actual
  // prepared contract shape with exactly the same independently read proof.
  assert.throws(() => record({ ...part, ...inference, inference: { rule: inference.rule } }),
    /parts\[\].*policy.*premises.*part\.inference/u);
  const example = projectPolicyContract([rule.file]).partsExample;
  assert.equal(example.rule, undefined);
  assert.deepEqual(example.inference.premises, []);
  assert.deepEqual(example.inference.assumptions, []);
  assert.deepEqual(record({ ...example, basis: part.basis, inference: { ...example.inference,
    policy: [rule], scope: inference.scope, counterexample: inference.counterexample } }).recorded, [block.id]);
  const [{ parts: [saved] }] = e.finish().records;
  assert.equal(saved.proofObject, "project-policy");
  assert.equal(saved.inference.policy[0].goalSha256, e.active.goal.sha256);
  assert.equal(saved.inference.policy[0].provenance, "current-project-policy");
  assert.deepEqual(saved.inference.premises, []);
  // Quoting the project rule itself uses the same role's exact quote and
  // locator, while unrelated facts still require independently pinned sources.
  for (const [quote, ok, footnote] of [[clause, true, false], ["待补件按规定归档", false, false], [clause, true, true]]) {
    const text = footnote ? `项目规则原文为“${quote}”[^p]。\n\n[^p]: overview.md 第2行\n`
      : `项目规则原文为“${quote}”（出处：overview.md 第2行）。\n`;
    write("candidate.md", text);
    e.read("candidate.md");
    const inventory = e.invoke("inventory").blocks;
    const entries = inventory.map(({id,text},i) => ({block:id,parts:[i===0?part:{
      kind:"nonfactual",status:"supported",basis:`脚注定位不另外声明事实：${text}` }]}));
    e.invoke("record", {entries});
    const summary=e.finish();
    assert.equal(summary.quotations[0].matches, ok, JSON.stringify({footnote, entries:summary.records, check:summary.quotations[0]}));
    assert.equal(summary.rejected.length, ok?0:1);
    assert.equal(summary.quotations[0].refs.length, 0);
    if (ok) assert.equal(summary.quotations[0].policyRefs[0].provenance, "current-project-policy");
    if (footnote) assert.doesNotThrow(() => requireStoredFootnoteBindings(e.spec,[summary],Buffer.from(text),e.active.phase,e.active.goal));
  }
  write("candidate.md", "本项目将待补件列入复核（出处：overview.md 第2行）。\n");
  e.read("candidate.md");
  write(rule.file, "# 总纲\n" + clause + "\n目标已改。\n");
  e.read(rule.file);
  assert.deepEqual(e.invoke("inventory").pending, [block.id]);
  assert.throws(() => record(part), /当前总纲/);
}));

const enumerationSource = "sources/github-checks.md";
const enumerationRow = (range, locator = "第 6-8 行") =>
  "- C4：GitHub 登记原文在第 " + range + " 行列出的结论例子有 failure 与 success 两项（出处：" + enumerationSource + " " + locator + "）。";

/** Replay exact source-line claims with independently registered physical rows. */
function enumerationEnvironment(root, write, body, rows = ["failure", "success"]) {
  const p = structuredClone(policy), url = "https://example.test/checks";
  const registered = ["If the status is completed, the conclusion can be any of the following:", ...rows];
  const snapshot = ["# 官方页面短摘录", "URL: " + url, "Fetched: 2026-11-07", "以下是编辑说明。", "摘录：", ...registered, ""].join("\n");
  const receipt = JSON.stringify({sources:[{snapshot:"github-checks.md", snapshotSha256:digest(snapshot), finalUrl:url,
    status:200, fetchedAt:"2026-11-07T13:01:00Z", responseSha256:"a".repeat(64), exactQuotes:registered}]});
  fs.mkdirSync(path.join(root,"sources"),{recursive:true});
  write(enumerationSource,snapshot);write("sources/acquisition.json",receipt);write("candidate.md",body);
  p.sourcePins = {[enumerationSource]:{kind:"primary",locator:url,sha256:digest(snapshot),
    observation:{file:"sources/acquisition.json",sha256:digest(receipt)}}};
  for (const phase of ["first-review","final-review"]) {
    p.units.K01.phases[phase].read.push(enumerationSource);
    p.units.K01.phases[phase].evidence.push(enumerationSource);
  }
  p.units.K01.phases.supplement.read.push(enumerationSource);
  write("BUILDING-LOOP.json",JSON.stringify(p));
  return environment(root);
}

test("source-line enumeration returns the author error even when a reviewer supports it with neighboring rows",async()=>fixture(async(root,write)=>{
  const e=enumerationEnvironment(root,write,enumerationRow("6")+"\n"), [block]=e.invoke("inventory").blocks;
  const adjacentMembers=[{file:enumerationSource,start:7,end:7,quote:"failure"},{file:enumerationSource,start:8,end:8,quote:"success"}];
  const submitted={...fact,basis:"原文第6行是引导句，第7及8行分别列出这两项。",evidence:adjacentMembers};
  assert.deepEqual(e.invoke("record",{entries:[{block:block.id,parts:[submitted]}]}).recorded,[block.id]);
  const {records,rejected}=e.finish();
  assert.equal(records[0].parts[0].status,"supported");
  assert.equal(rejected.length,1);
  const [finding]=rejected;
  assert.equal(finding.status,"unsupported");assert.equal(finding.finding.kind,"contradiction");
  assert.equal(finding.finding.quote,"在第 6 行列出的结论例子有 failure 与 success 两项（出处：sources/github-checks.md 第 6-8 行）");
  assert.deepEqual(finding.sourceLineEnumeration.missing,["failure","success"]);
  assert.deepEqual([finding.sourceLineEnumeration.source.start,finding.sourceLineEnumeration.source.end],[6,6]);
  assert.deepEqual([finding.sourceLineEnumeration.locator.start,finding.sourceLineEnumeration.locator.end],[6,8]);
  assert.equal(finding.repairBaseline.refs[0].sha256,finding.sourceLineEnumeration.source.sha256);
  assert.deepEqual(finding.repairBaseline.refs.map(row=>[row.start,row.end]),[[6,6],[6,8]]);
  assert.equal(supplementChecks(root,e.spec,lineList(Buffer.from(enumerationRow("6"))),e.frame.reads,{...e.active,coverageRejections:rejected}).ok,false);
  assert.equal(supplementChecks(root,e.spec,lineList(Buffer.from(enumerationRow("7-8"))),e.frame.reads,{...e.active,coverageRejections:rejected}).ok,true);
}));

test("enumeration positive cases are scoped to authorized actual reads and exact literal list items",async()=>fixture(async(root,write)=>{
  const body=enumerationRow("7-8")+"\n",e=enumerationEnvironment(root,write,body);
  const checked=(candidate=body,frame=e.frame,active=e.active)=>sourceLineEnumerationChecks(frame,active,e.spec,Buffer.from(candidate));
  const [correct]=checked();
  assert.equal(correct.matches,true);assert.deepEqual([correct.source.start,correct.source.end],[7,8]);
  assert.equal(correct.source.origin.observation.file,"sources/acquisition.json");
  const first=e.spec.phases.supplement;
  const author={...e.active,phase:"supplement"},authorFrame={...e.frame,role:"executor",reads:first.read};
  assert.equal(checked(enumerationRow("6"),authorFrame,author)[0].matches,false);
  assert.deepEqual(checked(body,{...authorFrame,reads:first.read.filter(file=>file!==enumerationSource)},author),[]);
  assert.deepEqual(checked(body,authorFrame,{...author,seen:{}}),[]);
  assert.deepEqual(checked(body,{...e.frame,role:"coordinator"}),[]);
  assert.deepEqual(checked(enumerationRow("5","第 5-8 行")),[]); // unregistered metadata
  assert.deepEqual(checked(enumerationRow("6","第 7-8 行")),[]); // incompatible locator
  const literalSubstring=enumerationEnvironment(root,write,body,["failure-mode","success"]);
  const [noSubstring]=sourceLineEnumerationChecks(literalSubstring.frame,literalSubstring.active,literalSubstring.spec,Buffer.from(body));
  assert.equal(noSubstring.matches,false);assert.deepEqual(noSubstring.missing,["failure"]);
  const punctuated=enumerationEnvironment(root,write,body,["failure.","success."]);
  assert.equal(sourceLineEnumerationChecks(punctuated.frame,punctuated.active,punctuated.spec,Buffer.from(body))[0].matches,true);
  const mentions=enumerationEnvironment(root,write,body,["This prose mentions failure and success without listing them.","A second introduction."]);
  assert.deepEqual(sourceLineEnumerationChecks(mentions.frame,mentions.active,mentions.spec,Buffer.from(body)),[]);
}));

test("quoted, non-explicit, separately cited and inert line statements stay with independent review",async()=>fixture(async(root,write)=>{
  const body=enumerationRow("6"),e=enumerationEnvironment(root,write,body);
  const cases=["“"+body+"”","> "+body,"```text\n"+body+"\n```","<!--\n"+body+"\n-->","<pre>\n"+body+"\n</pre>",
    "    "+body,body.replace("在第 6 行列出的","随后列出的"),body.replace("两项（出处","两项。另见（出处"),
    body.replace("第 6-8 行）","第 6-8 行；functional.csv 第 2 行）"),body.replace("有 failure","没有 failure")];
  for(const candidate of cases)assert.deepEqual(sourceLineEnumerationChecks(e.frame,e.active,e.spec,Buffer.from(candidate)),[],candidate);
}));

test("host inventory covers every nonblank character including titles, tables, code and suffixes",()=>{
  const body="# 事实标题\n| 项目 | 值 |\n```js\nx = 2; y = 3\n```\n原句（引用），后半句。因此另有结论！\n[^1]: 脚注断言\n";
  const inventory=documentCoverage(Buffer.from(body));
  const lines=body.split("\n");
  for(const [index,line] of lines.entries()) {
    const positions=new Set(inventory.blocks.filter(b=>b.line===index+1).flatMap(b=>Array.from({length:b.end-b.start},(_,i)=>b.start+i)));
    for(let i=0;i<line.length;i++) if(line[i].trim()) assert.ok(positions.has(i),line+":"+i);
  }
  assert.ok(inventory.blocks.some(b=>b.text==="因此另有结论！"));
});

test("empty omissions and partial spans cannot bypass complete coverage",async()=>fixture(async(root,write)=>{
  write("candidate.md","# 摘要\n前半句，后半句。\n脚注也有内容\n");
  const e=environment(root), inventory=e.invoke("inventory");
  e.invoke("record",{entries:[{block:inventory.blocks[0].id,parts:[nonfact]}]});
  assert.throws(e.finish,/2 个未核块/);
  assert.throws(()=>e.invoke("record",{entries:[{block:inventory.blocks[1].id,parts:[{...nonfact,quote:"前半句"}]}]}),/末尾仍有未覆盖/);
  assert.throws(()=>e.invoke("record",{entries:[{block:inventory.blocks[1].id,parts:[{...nonfact,quote:"后半句。"}]}]}),/遗漏或改写/);
}));

/** Extract only the bounded machine-readable diagnostic from the actual error. */
function spanDiagnostic(error) {
  const marker="[coverage-span] ";const start=error.message.indexOf(marker)+marker.length;
  assert.ok(start>=marker.length);
  return JSON.parse(error.message.slice(start,error.message.indexOf("。只修正核验参数",start)));
}

test("a neighboring sentence cannot be appended to an already covered block and the diagnostic identifies the extra part",async()=>fixture(async(root,write)=>{
  // Reproduce the real DSH failure shape: the first quote is the complete current
  // block, while a second quote belongs to the next sentence/block in that line.
  const first="1. 字段边界（状态与结果分开）：模拟记录 A 为 status=completed、conclusion=failure（出处：sources/synthetic.md 第 2 行，模拟记录），所以记录 A 已完成，其结论为 failure，因此不能把完成状态当作成功。";
  const neighbor="此条与 C1 同理：completed 是状态字段，failure 是结论字段。";
  write("candidate.md",first+neighbor+"\n");
  write("functional.csv","记录 A：status=completed，conclusion=failure。\n完成状态不等于成功结果。\n");
  const e=environment(root),[block,next]=e.invoke("inventory").blocks;
  const premise={file:"functional.csv",start:1,end:1,quote:"记录 A：status=completed，conclusion=failure。"};
  const inference={kind:"inference",status:"supported",sourceRelation:"supports",basis:"按记录和字段区分核验这一限定结论。",
    inference:{rule:"source-warrant",premises:[premise],warrant:[{file:"functional.csv",start:2,end:2,quote:"完成状态不等于成功结果。"}],
      scope:"只讨论本例记录A的完成状态与失败结果。",assumptions:[],counterexample:{possible:false,reason:"本例实际已给出完成而失败的记录，不能把完成等同成功。"}}};
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...inference,quote:first},{...nonfact,quote:neighbor}]}]}),error=>{
    const diagnostic=spanDiagnostic(error);assert.equal(diagnostic.part,2);assert.equal(diagnostic.reason,"past-block-end");
    assert.equal(diagnostic.cursor,first.length);assert.equal(diagnostic.firstMismatch.blockOffset,first.length);
    assert.equal(diagnostic.firstMismatch.expected,null);assert.equal(diagnostic.firstMismatch.received,"此");
    assert.equal(diagnostic.blockText.text,first);assert.equal(diagnostic.expectedSuffix.text,"");return true;
  });
  assert.deepEqual(e.invoke("status").pending,[block.id,next.id]);
  // Removing the misplaced parameter fixes the span, without changing the
  // author's correct sentence or replacing its factual inference by nonfactual.
  e.invoke("record",{entries:[{block:block.id,parts:[inference]}]});
  e.invoke("record",{entries:[{block:next.id,parts:[{...fact,evidence:[premise]}]}]});
  assert.equal(e.finish().rejected.length,0);
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),first+neighbor+"\n");
}));

test("span diagnostics locate altered characters, missing suffixes and bound long source previews",async()=>fixture(async(root,write)=>{
  write("candidate.md","前半句，后半句。\n");let e=environment(root),block=e.invoke("inventory").blocks[0];
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...nonfact,quote:"前半句，错半句。"}]}]}),error=>{
    const diagnostic=spanDiagnostic(error);assert.equal(diagnostic.firstMismatch.blockOffset,4);
    assert.equal(diagnostic.firstMismatch.expected,"后");assert.equal(diagnostic.firstMismatch.received,"错");return true;
  });
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...nonfact,quote:"前半句，"}]}]}),error=>{
    const diagnostic=spanDiagnostic(error);assert.equal(diagnostic.part,2);assert.equal(diagnostic.reason,"missing-tail");
    assert.equal(diagnostic.expectedSuffix.text,"后半句。");return true;
  });
  write("candidate.md","长".repeat(4000)+"。\n");e=environment(root);block=e.invoke("inventory").blocks[0];
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...nonfact,quote:"错".repeat(4000)}]}]}),error=>{
    const diagnostic=spanDiagnostic(error);assert.equal(diagnostic.blockText.truncated,true);
    assert.equal(diagnostic.blockText.text.length,800);assert.equal(diagnostic.expectedSuffix.text.length,240);
    assert.equal(diagnostic.receivedQuote.text.length,240);assert.ok(error.message.length<2400);return true;
  });
}));

test("quoted proof must be real authorized source text and cannot cite the candidate",async()=>fixture(async(root,write)=>{
  write("candidate.md","本样例通过19/20。\n");
  const e=environment(root), block=e.invoke("inventory").blocks[0].id;
  const put=evidence=>e.invoke("record",{entries:[{block,parts:[{...fact,evidence}]}]});
  assert.throws(()=>put([{...ref,quote:"19,20,all passed"}]),/逐字/);
  assert.throws(()=>put([{file:"candidate.md",start:1,end:1,quote:"本样例通过19/20。"}]),/原始证据|授权/);
  put([ref]);assert.equal(e.finish().rejected.length,0);
}));

test("changed candidate or source bytes invalidate proof even after rereading",async()=>fixture(async(root,write)=>{
  write("candidate.md","本样例通过19/20。\n");
  const e=environment(root), block=e.invoke("inventory").blocks[0].id;
  e.invoke("record",{entries:[{block,parts:[fact]}]});
  write("functional.csv","passed,total\n19,20\nnew observation\n");e.read("functional.csv");
  assert.throws(e.finish,/版本已经变化/);
  e.invoke("record",{entries:[{block,parts:[fact]}]});
  write("candidate.md","本样例通过19/20。因此所有环境都通过。\n");
  assert.throws(e.finish,/有效全文覆盖/);
}));

test("inferences need quoted premises and a real bridging rule, never a free-text warrant",async()=>fixture(async(root,write)=>{
  write("candidate.md","所以它成功了。\n");
  const e=environment(root), block=e.invoke("inventory").blocks[0].id;
  const inference={rule:"source-warrant",premises:[ref],scope:"仅讨论本次指定运行的结果。",assumptions:[],counterexample:{possible:false,reason:"需由原文明确给出充分条件后才能排除失败分支。"}};
  const put=value=>e.invoke("record",{entries:[{block,parts:[{kind:"inference",status:"supported",sourceRelation:"supports",basis:"由原始前提推导结果。",inference:value}]}]});
  assert.throws(()=>put(inference),/桥接关系/);
  assert.throws(()=>put({...inference,warrant:[{...ref,quote:"completed always means success"}]}),/逐字/);
  assert.throws(()=>put({...inference,warrant:[ref],assumptions:[{statement:"把完成当作成功。"}]}),/原文|路径|证据/);
}));

test("modus ponens accepts a bounded valid proof and rejects converse or changed concepts",async()=>fixture(async(root,write)=>{
  write("functional.csv","若本样本为A级则进入复核。\n本样本为A级。\n");write("candidate.md","所以本样本进入复核。\n");
  const e=environment(root), block=e.invoke("inventory").blocks[0].id;
  const inference={rule:"modus-ponens",premises:[{file:"functional.csv",start:1,end:1,quote:"若本样本为A级则进入复核。"},{file:"functional.csv",start:2,end:2,quote:"本样本为A级。"}],scope:"本规则中的同一个样本，A级仅指本例的分级。",assumptions:[],counterexample:{possible:false,reason:"给定同一个样本满足A级且规则明确A级蕴含复核，不能同时不复核。"},formal:{premises:[{relation:"implies",left:"本样本A级",right:"本样本复核"},{relation:"asserts",left:"本样本A级"}],conclusion:{relation:"asserts",left:"本样本复核"}}};
  const put=value=>e.invoke("record",{entries:[{block,parts:[{kind:"inference",status:"supported",sourceRelation:"supports",basis:"对同一对象应用原文的充分条件。",inference:value}]}]});
  put(inference);assert.equal(e.finish().rejected.length,0);
  put({...inference,scope:{objects:["本例样本 X"],conditions:["仅本例 A 级送复核的规则"]}});
  assert.deepEqual(e.finish().records[0].parts[0].inference.scope.objects,["本例样本 X"]);
  for(const changed of ["另一个样本复核","本样本成功"]) {
    const copy=structuredClone(inference);copy.formal.conclusion.left=changed;
    assert.throws(()=>put(copy),/形式推导不成立/);
  }
  const converse=structuredClone(inference);converse.formal.premises[1].left="本样本复核";converse.formal.conclusion.left="本样本A级";
  assert.throws(()=>put(converse),/形式推导不成立/);
  const undefinedSymbols=structuredClone(inference);delete undefinedSymbols.formal.conclusion.left;
  assert.throws(()=>put(undefinedSymbols),/具体概念/);
  const possible=structuredClone(inference);possible.counterexample={possible:true,reason:"原文规则也许只覆盖另一个批次，现有材料未能排除。"};
  put(possible);assert.equal(e.finish().rejected[0].status,"uncertain");
}));

test("hypotheses require visible labels and cannot disguise mandatory facts",async()=>fixture(async(root,write)=>{
  write("candidate.md","未经证实的猜想。\n");const e=environment(root);let block=e.invoke("inventory").blocks[0].id;
  const hypothesis={kind:"hypothesis",status:"uncertain",basis:"没有原始记录，本文只标为待验证的可能性。"};
  assert.throws(()=>e.invoke("record",{entries:[{block,parts:[hypothesis]}]}),/正文显式/);
  write("candidate.md","[推测] 未来可能增加样本。\n");block=e.invoke("inventory").blocks[0].id;
  e.invoke("record",{entries:[{block,parts:[hypothesis]}]});assert.equal(e.finish().rejected.length,0);
  e.invoke("record",{entries:[{block,parts:[{...hypothesis,status:"supported"}]}]});
  assert.equal(e.finish().records[0].parts[0].status,"uncertain");
  assert.equal(e.finish().records[0].parts[0].inputStatus,"supported");
  write("candidate.md","- C1：待核结论。\n");e.spec.claims=["C1"];block=e.invoke("inventory").blocks[0].id;
  e.invoke("record",{entries:[{block,parts:[nonfact]}]});assert.throws(e.finish,/不能全部分类/);
}));

test("an unchanged unnumbered finding is blocked before review; a real line correction can return",()=>{
  const active={coverageRejections:[{block:"B2",line:2,lineText:"两者相关，所以一定存在因果。",repair:"区分相关与因果。"}]};
  const spec={calculations:{},plainLast:false};
  assert.equal(supplementChecks("",spec,["新标题","两者相关，所以一定存在因果。"],[],active).ok,false);
  assert.equal(supplementChecks("",spec,["原标题","两者相关，现有证据不足以确定因果。"],[],active).ok,true);
});

test("inventory pagination never drops trailing blocks",async()=>fixture(async(root,write)=>{
  write("candidate.md",Array.from({length:27},(_,i)=>"第"+i+"项标题").join("\n"));
  const e=environment(root),first=e.invoke("inventory");assert.equal(first.blocks.length,8);assert.equal(first.total,27);
  let seen=[];
  for(let offset=0;offset<27;offset+=8){
    const page=e.invoke("inventory",{offset});seen.push(...page.blocks.map(b=>b.id));
    e.invoke("record",{entries:page.blocks.map(b=>({block:b.id,parts:[nonfact]}))});
  }
  assert.equal(new Set(seen).size,27);assert.equal(e.finish().pending.length,0);
}));

test("archived oversized page and proof batches recover without admitting unsubmitted blocks", async () => fixture(async (root, write) => {
  write("candidate.md", Array.from({ length: 125 }, (_, index) => `# 第${index + 1}项`).join("\n"));
  const e = environment(root);
  const page = e.invoke("inventory", { offset: 96, count: 29 });
  assert.deepEqual(page.pageLimit, { requested: 29, applied: 24 });
  assert.equal(page.blocks.length, 24);
  assert.deepEqual([page.next.offset, page.next.count], [120, 5]);
  const last = e.invoke("inventory", { offset: page.next.offset, count: page.next.count });
  assert.equal(last.blocks.length, 5);
  assert.equal(last.next, undefined);
  assert.equal(new Set([...page.blocks, ...last.blocks].map(row => row.id)).size, 29);
  assert.throws(() => e.invoke("inventory", { offset: -1, count: 0 }), /offset=0 count=8/u);

  const entries = [...page.blocks, ...last.blocks].map(({ id }) => ({ block: id, parts: [nonfact] }));
  const put = rows => e.invoke("record", { entries: rows });
  const before = JSON.stringify(e.active.coverage);
  for (const length of [13, 17]) {
    const invalidBatch = put(entries.slice(0, length));
    assert.equal(invalidBatch.status, "batch-too-large");
    assert.equal(invalidBatch.requested, length);
    assert.deepEqual(invalidBatch.recorded, []);
    assert.deepEqual([invalidBatch.next.entriesFrom, invalidBatch.next.entriesThrough], [1, 12]);
    assert.equal(JSON.stringify(e.active.coverage), before);
  }
  assert.equal(put(entries.slice(0, 12)).recorded.length, 12);
  assert.equal(put(entries.slice(12, 17)).recorded.length, 5);
  assert.equal(e.invoke("status").pending.length, 108);
  assert.equal(e.invoke("status", { block: entries[17].block }).record, null);
}));

test("registered review tool routes an oversized transcript batch back to exact splitting", async () => fixture(async (root, write) => {
  const p = structuredClone(policy);
  p.units.K01.claims = [];
  p.units.K01.calculations = {};
  write("BUILDING-LOOP.json", JSON.stringify(p));
  write("candidate.md", Array.from({ length: 17 }, (_, index) => `# 第${index + 1}项`).join("\n"));
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.file(executor, "read", "candidate.md");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const prepared = await h.flow(reviewer, "prepare");
  assert.equal(prepared.coverage.blocks.length, 17);
  const entries = prepared.coverage.blocks.map(({ id }) => ({ block: id, parts: [nonfact] }));
  const put = rows => h.coverage(reviewer, "record", { entries: rows });
  const overflow = await put(entries);
  assert.equal(overflow.status, "batch-too-large");
  assert.deepEqual(overflow.recorded, []);
  assert.equal((await h.coverage(reviewer, "status")).pending.length, 17);
  assert.equal((await put(entries.slice(overflow.next.entriesFrom - 1, overflow.next.entriesThrough))).recorded.length, 12);
  assert.equal((await h.coverage(reviewer, "status")).pending.length, 5);
  assert.equal((await put(entries.slice(overflow.next.entriesThrough))).recorded.length, 5);
  assert.equal((await h.coverage(reviewer, "status")).pending.length, 0);
}));

test("equality transitivity requires a shared middle concept",async()=>fixture(async(root,write)=>{
  write("functional.csv","本例 A=B。\n本例 B=C。\n");write("candidate.md","本例 A=C。\n");
  const e=environment(root),block=e.invoke("inventory").blocks[0].id;
  const proof={rule:"equality-transitive",premises:[{file:"functional.csv",start:1,end:1,quote:"本例 A=B。"},{file:"functional.csv",start:2,end:2,quote:"本例 B=C。"}],scope:"本例中的同一组量 A、B、C，关系为相等。",assumptions:[],counterexample:{possible:false,reason:"相等关系的共同中项为同一个 B，故 A 和 C 不能不等。"},formal:{premises:[{relation:"equals",left:"A",right:"B"},{relation:"equals",left:"B",right:"C"}],conclusion:{relation:"equals",left:"A",right:"C"}}};
  const put=inference=>e.invoke("record",{entries:[{block,parts:[{kind:"inference",status:"supported",sourceRelation:"supports",basis:"应用等值关系传递规则。",inference}]}]});
  put(proof);assert.equal(e.finish().rejected.length,0);
  const bad=structuredClone(proof);bad.formal.premises[1].left="另一个B";assert.throws(()=>put(bad),/形式推导不成立/);
}));

test("calculated proof binds the configured script and its real raw data",async()=>fixture(async(root,write)=>{
  write("candidate.md","- C2：下降 20%（出处：timing.csv 第 2-3 行）。\n");
  const e=environment(root);e.spec.calculations=authority(root).units.K01.calculations;
  const block=e.invoke("inventory").blocks[0].id;
  const proof={rule:"configured-calculation",calculation:"C2",premises:[{file:"timing.csv",start:2,end:3,quote:"before,120\nafter,96"}],scope:"仅本例两组均值的相对降幅，不解释因果。",assumptions:[],counterexample:{possible:false,reason:"相同定义下原始两值由脚本按(120-96)/120重算。"}};
  const put=inference=>e.invoke("record",{entries:[{block,parts:[{kind:"inference",status:"supported",sourceRelation:"supports",basis:"由已配置百分比规则复算。",inference}]}]});
  put(proof);assert.equal(e.finish().records[0].parts[0].inference.calculation.expected,"20%");
  assert.throws(()=>put({...proof,calculation:"not-registered"}),/实际计算规则/);
}));

/** The registered C2 calculation may justify only its own exact numerical part. */
function configuredProof(premises=[{file:"timing.csv",start:2,end:3,quote:"before,120\nafter,96"}]) {
  return {rule:"configured-calculation",calculation:"C2",premises,scope:"只复算本例两条原始耗时数据的相对降幅。",
    assumptions:[],counterexample:{possible:false,reason:"按同一配置对120与96复算，得到20%的相对降幅。"}};
}
function calculatedPart(inference=configuredProof(),quote) {
  return {kind:"inference",status:"supported",sourceRelation:"supports",basis:"按配置复算这段实际数字。",inference,...(quote===undefined?{}:{quote})};
}
function calculationEnvironment(root) {
  const e=environment(root);e.spec.calculations=authority(root).units.K01.calculations;return e;
}

test("configured calculation cannot lend another claim's passed result to an unrelated line",async()=>fixture(async(root,write)=>{
  write("candidate.md","- C2：下降 20%（出处：timing.csv 第 2-3 行）。\n因此所有项目必定成功。\n");
  const e=calculationEnvironment(root),blocks=e.invoke("inventory").blocks;
  assert.throws(()=>e.invoke("record",{entries:[{block:blocks[1].id,parts:[calculatedPart()]}]}),/当前.*断言|绑定.*事实行/);
}));

test("configured calculation checks the actual part rather than another percentage on its line",async()=>fixture(async(root,write)=>{
  write("candidate.md","- C2：下降 20%（出处：timing.csv 第 2-3 行）。因此所有项目必定成功。\n");
  const e=calculationEnvironment(root),blocks=e.invoke("inventory").blocks;
  assert.throws(()=>e.invoke("record",{entries:[{block:blocks[1].id,parts:[calculatedPart()]}]}),/当前.*断言|当前.*片段|当前.*复算/);
}));

test("configured calculation premises must quote both actual raw rows in the calculated source",async()=>fixture(async(root,write)=>{
  write("candidate.md","- C2：下降 20%（出处：timing.csv 第 2-3 行）。\n");
  const e=calculationEnvironment(root),block=e.invoke("inventory").blocks[0].id;
  for(const premises of [
    [{file:"functional.csv",start:2,end:2,quote:"19,20"}],
    [{file:"timing.csv",start:1,end:1,quote:"phase,mean_ms"}],
    [{file:"timing.csv",start:1,end:3,quote:"phase,mean_ms"}],
    [{file:"timing.csv",start:2,end:3,quote:"before,120"}],
    [{file:"timing.csv",start:2,end:3,quote:"120\nafter,96"}],
  ])assert.throws(()=>e.invoke("record",{entries:[{block,parts:[calculatedPart(configuredProof(premises))]}]}),/复算.*前提|前提.*复算|原始.*行/);
}));

test("configured calculation preserves split parts, Markdown claim labels and separate raw-row refs",async()=>fixture(async(root,write)=>{
  write("timing.csv","phase,mean_ms\r\n  before,120  \r\nunused,777\r\n after,96 \r\n");
  const numeric="因此下降 ２０．００％",locator="（出处：timing.csv #L2-L4）。";
  const candidate="# 摘要\r\n  2) **C2** : 本例口径；"+numeric+locator+"\r\n";
  write("candidate.md",candidate);
  const e=calculationEnvironment(root),blocks=e.invoke("inventory").blocks;
  const raw=[{file:"timing.csv",start:2,end:2,quote:"before,120"},{file:"timing.csv",start:4,end:4,quote:"after,96"}];
  e.invoke("record",{entries:blocks.map(block=>({block:block.id,parts:block.text.startsWith(numeric)
    ?[calculatedPart(configuredProof(raw),numeric),{...nonfact,quote:locator}]:[nonfact]}))});
  const checked=e.finish(),part=checked.records.at(-1).parts[0];
  assert.equal(part.inference.calculation.expected,"20%");
  assert.deepEqual(part.inference.calculation.assertion,{line:2,start:candidate.split("\r\n")[1].indexOf(numeric),
    end:candidate.split("\r\n")[1].indexOf(numeric)+numeric.length,quoteSha256:digest(numeric)});
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),candidate);
  assert.equal(part.inference.calculation.before.line,2);assert.equal(part.inference.calculation.after.line,4);
}));

test("legacy calculated records remain readable but cannot retain mismatched raw premises",async()=>fixture(async(root,write)=>{
  write("candidate.md","- C2：下降 20%（出处：timing.csv 第 2-3 行）。\n");
  const e=calculationEnvironment(root),block=e.invoke("inventory").blocks[0].id;
  e.invoke("record",{entries:[{block,parts:[calculatedPart()]}]});
  const stored=e.active.coverage.records[block].parts[0];
  delete stored.inference.calculation.assertion;
  const before=JSON.stringify(stored);
  assert.equal(e.finish().rejected.length,0);assert.equal(JSON.stringify(stored),before);
  stored.inference.premises=[{...ref,sha256:digest(fs.readFileSync(path.join(root,"functional.csv")))}];
  assert.throws(e.finish,/复算前提/);
}));

test("completion rechecks the exact calculation binding instead of trusting old passing records",async()=>fixture(async(root,write)=>{
  write("candidate.md","- C2：下降 20%（出处：timing.csv 第 2-3 行）。\n因此所有项目必定成功。\n");
  const e=calculationEnvironment(root),blocks=e.invoke("inventory").blocks;
  e.invoke("record",{entries:[{block:blocks[0].id,parts:[calculatedPart()]},{block:blocks[1].id,parts:[nonfact]}]});
  const saved=e.active.coverage.records[blocks[0].id].parts[0];
  saved.inference.calculation.assertion.quoteSha256=digest("别的断言");
  assert.throws(e.finish,/原文片段已失效/);
  delete saved.inference.calculation.assertion;
  const other=e.active.coverage.records[blocks[1].id].parts[0];
  Object.assign(other,{kind:"inference",sourceRelation:"supports",inference:structuredClone(saved.inference)});
  assert.throws(e.finish,/当前.*断言|绑定.*事实行/);
}));

/** Replay the exact persisted host boundary used by ledger review and closed units. */
function acceptedCalculationState(e,write,coverage,phase) {
  const receipt={decision:"accept",reviewer:"reviewer",candidateSha256:coverage.candidateSha256,
    goal:goalSnapshot(e.frame),goalFit:{pass:true},coverage:{version:1,pending:[],rejected:[]},
    independentAudit:{auditor:"auditor",coverage:{version:1,pending:[],rejected:[]}}};
  const raw=JSON.stringify(receipt);write("final.json",raw);
  const frame={...e.frame,reads:[...e.frame.policy.coordinator.read]};
  const active={phase,executor:"executor",receipt:"final.json",receiptHash:digest(raw),
    proof:{reviewerCoverage:structuredClone(coverage),auditorCoverage:structuredClone(coverage)}};
  return {frame,active};
}

test("ledger review and closed units reject old calculation records bound to another assertion or raw source",async()=>fixture(async(root,write)=>{
  write("candidate.md","- C2：下降 20%（出处：timing.csv 第 2-3 行）。\n因此所有项目必定成功。\n");
  const e=calculationEnvironment(root),blocks=e.invoke("inventory").blocks;
  e.invoke("record",{entries:[{block:blocks[0].id,parts:[calculatedPart()]},{block:blocks[1].id,parts:[nonfact]}]});
  const saved=e.finish();delete saved.records[0].parts[0].inference.calculation.assertion;
  for(const phase of ["ledger-review","closed"])for(const role of ["reviewerCoverage","auditorCoverage"])for(const wrong of ["assertion","source"]) {
    const {frame,active}=acceptedCalculationState(e,write,saved,phase),coverage=active.proof[role];
    const prior=coverage.records[0].parts[0],other=coverage.records[1].parts[0];
    if(wrong==="assertion")Object.assign(other,{kind:"inference",sourceRelation:"supports",inference:structuredClone(prior.inference)});
    else prior.inference.premises=[{...ref,sha256:digest(fs.readFileSync(path.join(root,"functional.csv")))}];
    assert.throws(()=>acceptedVersion(frame,"K01",active),error=>{
      assert.equal(error.message,"已验收计算证明失效，须重新核验");return true;
    });
    assert.equal(needsRevalidation(frame,"K01",active),true);
    assert.deepEqual(frame.reads,e.frame.policy.coordinator.read);
  }
}));

test("correct legacy calculation acceptance rechecks without rewriting proof or granting coordinator reads",async()=>fixture(async(root,write)=>{
  write("candidate.md","- C2：下降 20%（出处：timing.csv 第 2-3 行）。\n");
  const e=calculationEnvironment(root),block=e.invoke("inventory").blocks[0].id;
  e.invoke("record",{entries:[{block,parts:[calculatedPart()]}]});
  const coverage=e.finish();delete coverage.records[0].parts[0].inference.calculation.assertion;
  for(const phase of ["ledger-review","closed"]) {
    const {frame,active}=acceptedCalculationState(e,write,coverage,phase),before=JSON.stringify(active);
    const receipt=fs.readFileSync(path.join(root,"final.json"));
    assert.equal(acceptedVersion(frame,"K01",active).decision,"accept");
    assert.equal(needsRevalidation(frame,"K01",active),false);
    assert.equal(JSON.stringify(active),before);assert.deepEqual(fs.readFileSync(path.join(root,"final.json")),receipt);
    assert.deepEqual(frame.reads,e.frame.policy.coordinator.read);assert.equal(active.seen,undefined);
  }
}));

test("classification disagreement is distinct from a proven false claim",()=>{
  const a={records:[{block:"B1",line:1,text:"结论",parts:[nonfact]}]};
  const b={records:[{block:"B1",line:1,text:"结论",parts:[fact]}]};
  assert.equal(classificationDisagreements(a,b).length,1);
  assert.equal(classificationDisagreements(b,b).length,0);
});

test("a factual first part cannot hide a classification dispute in the rest of the same block",()=>{
  const text="甲项是事实，乙项也提出事实判断。";
  const first={records:[{block:"B1",line:1,text,parts:[{...fact,start:0,end:6},{...nonfact,start:6,end:text.length}]}]};
  const second={records:[{block:"B1",line:1,text,parts:[{...fact,start:0,end:text.length}]}]};
  const disputes=classificationDisagreements(first,second);assert.deepEqual(disputes[0].factualSpans,[[6,text.length]]);
  assert.throws(()=>requireDisputedProof({reconciliation:disputes},first.records,true),/reconciliation/);
  assert.doesNotThrow(()=>requireDisputedProof({reconciliation:disputes},second.records,true));
});

test("presentation advice cannot enter factual repair debt without an actual factual defect",async()=>fixture(async(root,write)=>{
  write("candidate.md","大白话：把状态和结果分开看。\n");
  const e=environment(root),block=e.invoke("inventory").blocks[0].id;
  const rejected={kind:"direct",status:"uncertain",sourceRelation:"insufficient",basis:"方向正确，但结尾没有重复所有正文要点，属于写法。",repair:"再补一句解释。"};
  assert.throws(()=>e.invoke("record",{entries:[{block,parts:[rejected]}]}),/中性.*nonfactual/);
  assert.throws(()=>e.invoke("record",{entries:[{block,parts:[{...rejected,finding:{kind:"presentation",quote:"分开看",fix:"加长收尾"}}]}]}),/中性.*nonfactual/);
  assert.equal(e.invoke("status").rejected.length,0);
  e.invoke("record",{entries:[{block,parts:[nonfact]}]});assert.equal(e.finish().rejected.length,0);
}));

test("production acceptance requires full coverage and a separate blind audit, with no coordinator bypass",async()=>fixture(async(root,write)=>{
  const p=structuredClone(policy);p.units.K01.claims=["C1"];p.units.K01.calculations={};write("BUILDING-LOOP.json",JSON.stringify(p));
  write("candidate.md","# 摘要\n- C1：通过 19/20（出处：functional.csv 第 2 行）。\n");
  const h=host(root,{automaticCoverage:false});
  await assert.rejects(h.coverage("root","inventory"),/总控无正文/);
  const worker=(await h.flow("root","advance")).childId;
  await h.file(worker,"read","candidate.md");await h.flow(worker,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  for(const file of ["overview.md","candidate.md","functional.csv"])await h.file(reviewer,"read",file);
  const checks=[{id:"C1",status:"supported",file:"functional.csv",start:2,end:2,basis:"样例数据明确给出通过19总数20。"}];
  await assert.rejects(h.flow(reviewer,"review",{checks}),/有效全文覆盖/);
  const inventory=await h.coverage(reviewer,"inventory");
  const entries=inventory.blocks.map((b,i)=>({block:b.id,parts:[i?fact:nonfact]}));
  await h.coverage(reviewer,"record",{entries:entries.slice(0,1)});
  await assert.rejects(h.flow(reviewer,"review",{checks}),/未核块/);
  await h.coverage(reviewer,"record",{entries:entries.slice(1)});
  await h.assess(reviewer,{...Object.fromEntries(Object.keys(QUALITY).map(k=>[k,"本例仅转述原始样本并给出明确出处。"])),goalFit:{pass:true,basis:"满足本轮样例核验范围。"},sourceRefs:[ref],revise:[],unverifiedSources:[],unlisted:[]});
  assert.equal((await h.flow(reviewer,"review",{checks})).phase,"first-audit-ready");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,"first.json"))).decision,"pending-audit");
  await assert.rejects(h.ledger("root","review",{decisions:[]}),/账本|验收|阶段/);
  const auditor=(await h.flow("root","advance")).childId;
  assert.notEqual(auditor,reviewer);assert.notEqual(auditor,worker);
  await assert.rejects(h.file(auditor,"read","first.json"),/白名单/);
  await assert.rejects(h.flow(reviewer,"audit"),/没有可交付阶段/);
  for(const file of ["overview.md","candidate.md","functional.csv"])await h.file(auditor,"read",file);
  await h.coverage(auditor,"inventory");await h.coverage(auditor,"record",{entries});
  assert.equal((await h.flow(auditor,"audit")).phase,"ledger-review");
  const receipt=JSON.parse(fs.readFileSync(path.join(root,"first.json")));
  assert.equal(receipt.independentAudit.auditor,auditor);assert.equal(receipt.coverage.total,2);
}));

test("the archived lunar suffix is an obligatory block without astronomy-specific code",()=>{
  const bundle=JSON.parse(fs.readFileSync(new URL("../experiments/data/building-loop-repair-audit/20261107T120812Z.json",import.meta.url)));
  const artifact=bundle.artifacts.find(a=>a.path.endsWith("workspace/module/candidate.md"));
  const inventory=documentCoverage(Buffer.from(artifact.data));
  const wrong=inventory.blocks.filter(b=>b.text.includes("月面一昼夜"));
  assert.ok(wrong.length);assert.ok(wrong.every(b=>b.id&&b.line));
});

test("explicit deduction cannot masquerade as direct restatement and contradiction cannot be accepted as intent",async()=>fixture(async(root,write)=>{
  write("candidate.md","记录已完成，因此记录成功。\n");const e=environment(root);let block=e.invoke("inventory").blocks[0];
  assert.equal(block.requiresInference,true);
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[fact]}]}),/不能用 direct 跳过/);
  write("candidate.md","这个结果成功。\n");block=e.invoke("inventory").blocks[0];
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...fact,sourceRelation:"contradicts",basis:"原文相反，但猜作者是在举错误例子。"}]}]}),/不能 supported/);
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...fact,sourceRelation:undefined}]}]}),/必须单独给 sourceRelation/);
}));

test("an inline verbatim quote must match its cited lines; clear paraphrase remains allowed",async()=>fixture(async(root,write)=>{
  const e=environment(root);
  const verify=body=>{
    write("candidate.md",body);const inventory=e.invoke("inventory");
    e.invoke("record",{entries:inventory.blocks.map(b=>({block:b.id,parts:[fact]}))});
    return e.finish();
  };
  const wrong=verify('原文为 “19 / 20”（出处：functional.csv 第 2 行）。\n');
  assert.equal(wrong.rejected.length,1);assert.equal(wrong.rejected[0].finding.kind,"verbatim-quote");
  assert.equal(verify('原文为 “19,20”（出处：functional.csv 第 2 行）。\n').rejected.length,0);
  assert.equal(verify('转述为通过 19 / 20（出处：functional.csv 第 2 行）。\n').rejected.length,0);
}));

test("visible error examples need counterevidence but are not endorsed facts",async()=>fixture(async(root,write)=>{
  write("candidate.md","误读：本样例全部通过。\n");const e=environment(root);let block=e.invoke("inventory").blocks[0];
  assert.equal(block.stance,"error-example");
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[fact]}]}),/用 error-example/);
  const part={kind:"error-example",status:"supported",sourceRelation:"contradicts",basis:"19/20 并非全通过，本段明确展示误读，不认可它。",evidence:[ref]};
  e.invoke("record",{entries:[{block:block.id,parts:[part]}]});
  assert.equal(e.finish().rejected.length,0);assert.equal(e.finish().records[0].parts[0].status,"illustrated-error");
  write("candidate.md","本样例全部通过。\n");block=e.invoke("inventory").blocks[0];
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[part]}]}),/不能自行猜测/);
}));

test("numbered error labels and Markdown presentation preserve the same counterevidence gate",async()=>fixture(async(root,write)=>{
  const labels=["错例 1：","错例一：","错误示例二：","错误推理 第3：","误读（四）：","[错例 12]","【错误示例二】",
    "- **错例 1：**","+ __错误示例二__：","2. *错例一：*","> - **[错例 ２]**","### **错误示例二：**",
    "错例（任意分类说明）：","错例(another description):","错例 2（本段示范）：","错误示例（本段示范）二：",
    "错误推理（2）（接口含义）：","误读（范围描述）(3)：","- **错例一（仅作示范）：**","[错例二（附注）]",
    "错例（"+"例".repeat(64)+"）："];
  const e=environment(root),part={kind:"error-example",status:"unsupported",sourceRelation:"contradicts",
    basis:"原始记录19/20反证本段明确展示的全部通过错误。",evidence:[ref]};
  for(const label of labels) {
    const body=label+"本样例全部通过。\n";write("candidate.md",body);const block=e.invoke("inventory").blocks[0];
    assert.equal(block.stance,"error-example",label);
    assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...part,evidence:[]}]}]}),/实际已读的 evidence/,label);
    assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...part,sourceRelation:"supports"}]}]}),/不可写 supports/,label);
    e.invoke("record",{entries:[{block:block.id,parts:[part]}]});
    assert.equal(e.finish().records[0].parts[0].status,"illustrated-error",label);
    assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),body);
  }
}));

test("negated labels, unlabelled assertions and a previous example heading cannot borrow example status",async()=>fixture(async(root,write)=>{
  const e=environment(root),part={kind:"error-example",status:"unsupported",sourceRelation:"contradicts",
    basis:"尝试把没有实际标签的断言当成反例应被宿主拒绝。",evidence:[ref]};
  for(const body of ["不是错例：本样例全部通过。","- **不是错例 1：**本样例全部通过。","并非错误示例二：本样例全部通过。",
    "错例分析：本样例全部通过。","正文提到错例 1：本样例全部通过。","本样例全部通过。","## 错例 1：\n本样例全部通过。",
    "不是错例（任意描述）：本样例全部通过。","错例分析（说明）：本样例全部通过。","错例（说明）本样例全部通过。",
    "错例（未闭合：本样例全部通过。","错例（嵌套（说明））：本样例全部通过。","错例（ ）：本样例全部通过。",
    "错例（"+"例".repeat(65)+"）：本样例全部通过。","## 错例（单独的标题）：\n本样例全部通过。"]){
    write("candidate.md",body+"\n");const blocks=e.invoke("inventory").blocks;
    for(const block of blocks){
      assert.notEqual(block.stance,"error-example",body);
      assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[part]}]}),/不能自行猜测作者意图/,body);
    }
  }
}));

test("the actual parenthetical-label rejection replays as an evidenced example without rewriting its original block",async()=>fixture(async(root,write)=>{
  // Exact rejected block B32-1eade2c2 from 161408Z events.jsonl line 443.
  const body="- 错例（字段混滑）：记录 A 已完成，所以记录 A 必定成功——错在把 status=completed 当成 conclusion=success；\n";
  const p=structuredClone(policy);p.units.K01.phases["final-review"].read.push("sources/synthetic.md");
  p.units.K01.phases["final-review"].evidence.push("sources/synthetic.md");
  write("BUILDING-LOOP.json",JSON.stringify(p));fs.mkdirSync(path.join(root,"sources"));
  write("sources/synthetic.md","# 合成逻辑样例\n记录 A：status=completed，conclusion=failure。\n");write("candidate.md",body);
  const e=environment(root),[block]=e.invoke("inventory").blocks;assert.equal(block.stance,"error-example");
  const proof={kind:"error-example",status:"unsupported",sourceRelation:"contradicts",basis:"实际记录同时completed且failure，反证示例中把完成状态等同成功结果。",
    evidence:[{file:"sources/synthetic.md",start:2,end:2,quote:"记录 A：status=completed，conclusion=failure。"}]};
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...proof,evidence:[]}]}]}),/实际已读的 evidence/);
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[proof]}]}),/解释尾部须拆/);
  const tail=block.text.indexOf("错在"),counter=block.text.slice(0,tail),explanation=block.text.slice(tail);
  e.invoke("record",{entries:[{block:block.id,parts:[{...proof,quote:counter},
    {kind:"direct",status:"supported",sourceRelation:"supports",quote:explanation,basis:"实际记录已完成但结论为failure，核对解释中的字段区分。",evidence:proof.evidence}]}]});
  assert.equal(e.finish().records[0].parts[0].status,"illustrated-error");
  assert.equal(e.finish().records[0].parts[1].status,"supported");assert.equal(e.finish().rejected.length,0);
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),body);
}));

test("real numbered-example rejection replays without changing the author's three original examples",async()=>fixture(async(root,write)=>{
  // Frozen excerpt from 151723Z's pre-repair candidate. This local fixture
  // reproduces the parameter error without depending on mutable run artifacts.
  const body=[
    "- 错例 1：记录 A 已完成，因此记录 A 必定成功（与 sources/synthetic.md 第 2 行 conclusion=failure 相反）。",
    "- 错例 2：模拟观测组的训练时长与分数正相关，因此延长训练必然提高每个人的分数（把相关当因果，并把群体相关推到每个人，与 sources/synthetic.md 第 3 行所缺的随机分配、共同因素排除条件冲突）。",
    "- 错例 3：样本 X 应送复核，因此任何送复核的样本都是 A 级（把单向蕴含反推为充要，与 sources/synthetic.md 第 4 行规则不符）。",
  ].join("\n")+"\n";
  const source=["# 合成逻辑样例；不是外部研究、生产日志或真实效果数据","记录 A：status=completed，conclusion=failure。",
    "模拟观测组：训练时长与分数正相关；没有随机分配，也没有排除其他共同影响因素。",
    "本例分级规则：如果一个样本是 A 级，则该样本应送复核。","本例对象：样本 X 是 A 级。"];
  const p=structuredClone(policy);p.units.K01.phases["final-review"].read.push("sources/synthetic.md");
  p.units.K01.phases["final-review"].evidence.push("sources/synthetic.md");
  write("BUILDING-LOOP.json",JSON.stringify(p));fs.mkdirSync(path.join(root,"sources"));
  write("sources/synthetic.md",source.join("\n")+"\n");write("candidate.md",body);
  const e=environment(root),blocks=e.invoke("inventory").blocks;assert.equal(blocks.length,3);
  const result=e.invoke("record",{entries:blocks.map((block,i)=>({block:block.id,parts:[{kind:"error-example",status:"unsupported",
    sourceRelation:i===0?"contradicts":"insufficient",basis:["完成且失败的原始记录直接反证完成等同成功。",
      "相关观测没有排除共同因素，不足以证明对每个人的必然因果效应。","原文只给A到复核的单向规则，没有反向充分条件。"][i],
    evidence:[{file:"sources/synthetic.md",start:i+2,end:i+2,quote:source[i+1]}]}]}))});
  assert.equal(result.errors?.length??0,0);assert.equal(e.finish().rejected.length,0);
  assert.ok(e.finish().records.every(row=>row.parts[0].status==="illustrated-error"));
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),body);
}));

/** Fixture source observations are trusted setup, never generated reviewer evidence. */
function objectEnvironment(root,write,body,{firstOnly=false,sources={}}={}) {
  const p=structuredClone(policy),snapshot="# 快照标题\n编辑说明，不是页面原文。\nAlpha is recorded.\nBeta is recorded.\n";
  const row={snapshot:"snapshot.md",snapshotSha256:digest(snapshot),finalUrl:"https://example.test/source",status:200,
    fetchedAt:"2026-11-07T13:01:03Z",responseSha256:"a".repeat(64),exactQuotes:["Alpha is recorded.","Beta is recorded."]};
  const receipt=JSON.stringify({sources:[row]});
  p.units.K01.calculations={};
  p.sourcePins={"snapshot.md":{kind:"primary",locator:row.finalUrl,sha256:digest(snapshot),observation:{file:"acquisition.json",sha256:digest(receipt)}}};
  for(const phase of firstOnly?["first-review"]:["first-review","final-review"]) {
    p.units.K01.phases[phase].read.push("snapshot.md");p.units.K01.phases[phase].evidence.push("snapshot.md");
    p.units.K01.phases[phase].read.push(...Object.keys(sources));p.units.K01.phases[phase].evidence.push(...Object.keys(sources));
  }
  for(const [file,content] of Object.entries(sources)){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});write(file,content);}
  write("snapshot.md",snapshot);write("acquisition.json",receipt);write("candidate.md",body);write("BUILDING-LOOP.json",JSON.stringify(p));
  const e=environment(root);
  if(firstOnly){e.active.phase="first-review";e.frame.reads=e.spec.phases["first-review"].read;for(const file of e.frame.reads)e.read(file);}
  const blocks=e.invoke("inventory").blocks;
  const put=(objectCheck,{status="supported",finding,block=blocks[0].id,...extra}={})=>e.invoke("record",{entries:[{block,parts:[{
    kind:"direct",status,sourceRelation:status==="supported"?"supports":"contradicts",basis:"核对明确指定的真实证据对象及有限谓词。",objectCheck,...(finding?{finding}:{}),...extra}]}]});
  return {...e,blocks,put,snapshot,receipt,p};
}
const objectFinding=quote=>({kind:"contradiction",quote,fix:"按本句实际对象的已核结果修正，保留范围限制。"});

test("registered object counts and line membership have their own verified source object",async()=>fixture(async(root,write)=>{
  let e=objectEnvironment(root,write,"[摘录范围] snapshot.md 的登记摘录共2条。\n");
  e.put({kind:"registered-excerpts",check:"count",file:"snapshot.md",expected:2});
  let saved=e.finish().records[0].parts[0].objectCheck;
  assert.equal(saved.result.actual,2);assert.equal(saved.result.unit,"registered-excerpts");
  assert.equal(saved.sources[0].origin.observation.sha256,digest(e.receipt));assert.equal(saved.sources[0].quote,undefined);
  e=objectEnvironment(root,write,"[摘录范围] snapshot.md 第2行没有登记为外部原文。\n");
  e.put({kind:"registered-excerpts",check:"line-status",file:"snapshot.md",line:2,expected:"unregistered"});
  saved=e.finish().records[0].parts[0].objectCheck;
  assert.equal(saved.result.actual,"unregistered");assert.equal(saved.result.lineText,"编辑说明，不是页面原文。");
  assert.throws(()=>e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[{...fact,evidence:[{file:"snapshot.md",start:2,end:2,quote:"编辑说明，不是页面原文。"}]}]}]}),/未登记为外部原文/);
}));

test("registered local snapshot line ranges bind subset and exact predicates to the current source",async()=>fixture(async(root,write)=>{
  const shape=(start,end,mode)=>({kind:"registered-excerpts",check:"line-range",file:"snapshot.md",start,end,mode});
  let e=objectEnvironment(root,write,"- [摘录范围] 本轮 snapshot.md 快照第 3–4 行均已登记。\n");
  assert.deepEqual(e.blocks[0].objectCheckHint,shape(3,4,"subset"));
  assert.throws(()=>e.put(shape(3,4,"exact")),/对应当前单一断言/);
  assert.throws(()=>e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[nonfact]}]}),/须按 objectCheckHint/);
  e.put(e.blocks[0].objectCheckHint);
  assert.deepEqual(e.finish().records[0].parts[0].objectCheck.result,
    {matches:true,actual:[3,4],unit:"snapshot-line-range",claimedLines:[3,4],missingLines:[],extraLines:[]});
  assert.throws(()=>e.put(shape(3,4,"subset"),{status:"unsupported",finding:objectFinding("快照第 3–4 行均已登记")}),/已实测成立/);
  e=objectEnvironment(root,write,"[摘录范围] 本轮 snapshot.md 只登记了本地快照第 3–4 行。\n");
  assert.deepEqual(e.blocks[0].objectCheckHint,shape(3,4,"exact"));
  e.put(shape(3,4,"exact"));assert.equal(e.finish().records[0].parts[0].objectCheck.result.matches,true);
  e=objectEnvironment(root,write,"[摘录范围] 本轮 snapshot.md 只登记了本地快照第 3–3 行。\n");
  const exact=shape(3,3,"exact");
  assert.throws(()=>e.put(exact),/supported 与对象实测谓词冲突/);
  e.put(exact,{status:"unsupported",finding:objectFinding("只登记了本地快照第 3–3 行")});
  assert.deepEqual(e.finish().records[0].parts[0].objectCheck.result.extraLines,[4]);
  e=objectEnvironment(root,write,"[摘录范围] 本轮 snapshot.md 快照第 2–4 行均已登记。\n");
  const subset=shape(2,4,"subset");
  assert.throws(()=>e.put(subset),/supported 与对象实测谓词冲突/);
  e.put(subset,{status:"unsupported",finding:objectFinding("快照第 2–4 行均已登记")});
  assert.deepEqual(e.finish().records[0].parts[0].objectCheck.result.missingLines,[2]);
}));

test("snapshot range does not certify the old page-wide mixed assertion or a new extra tail",async()=>fixture(async(root,write)=>{
  const old="- [摘录范围] 本轮登记的 snapshot.md 只登记了该页第 6-8 行，其中第 6 行是引导句、第 7 行 failure、第 8 行 success，不表示原页列表只有这两项（见第 4 行）；sources/nist-scatter.md 只登记 1 条，即第 6 行。";
  const mixed="[摘录范围] 本轮 snapshot.md 快照第 3–4 行均已登记，并且完整网页只有这些行。";
  for(const body of [old,mixed]){
    const e=objectEnvironment(root,write,body+"\n");
    assert.ok(e.blocks.every(row=>!row.objectCheckHint));
    assert.throws(()=>e.put({kind:"registered-excerpts",check:"line-range",file:"snapshot.md",start:3,end:4,mode:"subset"}),/对应当前单一断言/);
    assert.equal(e.invoke("status").rejected.length,0);
  }
}));

test("false object predicates conflict with supported; only explicit factual findings create author debt",async()=>fixture(async(root,write)=>{
  const e=objectEnvironment(root,write,"[摘录范围] snapshot.md 的登记摘录共3条。\n");
  const check={kind:"registered-excerpts",check:"count",file:"snapshot.md",expected:3};
  assert.throws(()=>e.put(check),/supported.*冲突/);
  assert.equal(e.invoke("status").rejected.length,0);
  e.put(check,{status:"unsupported",finding:objectFinding("登记摘录共3条")});
  const summary=e.finish();assert.equal(summary.rejected.length,1);assert.equal(summary.records[0].parts[0].status,"unsupported");
  assert.equal(summary.records[0].parts[0].objectCheck.result.actual,2);
  const input=e.active.coverage.records[e.blocks[0].id].parts[0];assert.equal(input.sourceRelation,"contradicts");
}));

test("registered literal membership is finite and cannot substitute another source or a page-wide absence",async()=>fixture(async(root,write)=>{
  let e=objectEnvironment(root,write,'[摘录范围] snapshot.md 的已登记摘录包含“Alpha is recorded.”。\n');
  e.put({kind:"registered-excerpts",check:"contains",file:"snapshot.md",quote:"Alpha is recorded."});
  assert.equal(e.finish().records[0].parts[0].objectCheck.result.actual,true);
  assert.throws(()=>e.put({kind:"registered-excerpts",check:"excludes",file:"snapshot.md",quote:"Alpha is recorded."}),/supported.*冲突/);
  assert.throws(()=>e.put({kind:"registered-excerpts",check:"contains",file:"functional.csv",quote:"Alpha is recorded."}),/同一来源路径/);
  e=objectEnvironment(root,write,'[摘录范围] snapshot.md 的已登记摘录没有“Gamma”。\n');
  e.put({kind:"registered-excerpts",check:"excludes",file:"snapshot.md",quote:"Gamma"});assert.equal(e.finish().rejected.length,0);
  e=objectEnvironment(root,write,'snapshot.md 页面全文没有“Gamma”。\n');
  assert.throws(()=>e.put({kind:"registered-excerpts",check:"excludes",file:"snapshot.md",quote:"Gamma"}),/不能证明整页/);
}));

test("object parameter errors, approximate counts, unread versions and bad observation receipts are not author findings",async()=>fixture(async(root,write)=>{
  let e=objectEnvironment(root,write,"[摘录范围] snapshot.md 的登记摘录至少2条。\n");
  assert.throws(()=>e.put({kind:"registered-excerpts",check:"count",file:"snapshot.md",expected:2}),/精确等值/);
  e=objectEnvironment(root,write,"[摘录范围] snapshot.md 的登记摘录共2条。\n");
  const check={kind:"registered-excerpts",check:"count",file:"snapshot.md",expected:2};
  assert.throws(()=>e.put({...check,expected:3}),/当前片段唯一明确数量/);
  e.active.seen[keyOf("snapshot.md")].ranges=[[3,3]];assert.throws(()=>e.put(check),/实际读过/);
  e.read("snapshot.md");write("acquisition.json",e.receipt+"\n");assert.throws(()=>e.put(check),/回执缺失或已变更/);
  assert.equal(e.invoke("status").rejected.length,0);
}));

test("candidate count uses actual cited physical lines, and complete marking enumerates every such line",async()=>fixture(async(root,write)=>{
  const source="functional.csv";
  let e=objectEnvironment(root,write,"[稿件自述] 本稿对 functional.csv 有2行可识别同行引用。\n[模拟] 第一例（出处：functional.csv 第2行）。\n第二例（出处：functional.csv 第2行）。\n");
  e.put({kind:"candidate",check:"citation-count",source,expected:2});
  let saved=e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck;
  assert.deepEqual(saved.result.lines,[2,3]);assert.equal(saved.result.unit,"candidate-citation-lines");assert.deepEqual(saved.sources,[]);
  e=objectEnvironment(root,write,"[稿件自述] 本稿所有 functional.csv 引用行都含[模拟]标记。\n[模拟] 第一例（出处：functional.csv 第2行）。\n第二例（出处：functional.csv 第2行）。\n");
  const check={kind:"candidate",check:"citations-marked",source,marker:"[模拟]"};
  assert.throws(()=>e.put(check),/supported.*冲突/);
  e.put(check,{status:"unsupported",finding:objectFinding("所有 functional.csv 引用行都含[模拟]标记")});
  saved=e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck;
  assert.deepEqual(saved.result.missingLines,[3]);assert.equal(saved.result.missingCount,1);
}));

test("candidate objects reject empty-reference success, partial reads, wrong source binding and mixed external evidence",async()=>fixture(async(root,write)=>{
  let e=objectEnvironment(root,write,"[稿件自述] 本稿所有 functional.csv 引用行都含[模拟]标记。\n");
  const check={kind:"candidate",check:"citations-marked",source:"functional.csv",marker:"[模拟]"};
  assert.throws(()=>e.put(check),/不能用空集合/);
  e=objectEnvironment(root,write,"[稿件自述] 本稿所有 functional.csv 引用行都含[模拟]标记。\n[模拟] 第一例（出处：functional.csv 第2行）。\n");
  e.active.seen[keyOf("candidate.md")].ranges=[[1,1]];assert.throws(()=>e.put(check),/完整读取/);
  e.read("candidate.md");assert.throws(()=>e.put({...check,source:"timing.csv"}),/同一来源路径/);
  assert.throws(()=>e.put(check,{evidence:[ref]}),/不能与外部/);
  e.put(check);assert.equal(e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck.result.matches,true);
}));

test("explicit object markers cannot be dismissed as nonfactual or supported by external titles",async()=>fixture(async(root,write)=>{
  const e=objectEnvironment(root,write,"[摘录范围] snapshot.md 的登记摘录共2条。\n");
  assert.throws(()=>e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[nonfact]}]}),/不能全部 nonfactual/);
  assert.throws(()=>e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[{...fact,evidence:[{file:"snapshot.md",start:3,end:3,quote:"Alpha is recorded."}]}]}]}),/对应 objectCheck/);
  e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[{kind:"direct",status:"unsupported",sourceRelation:"insufficient",basis:"登记集合仍待明确核对，不能用外部单句证明数量。",finding:{kind:"missing-evidence",quote:"登记摘录共2条",fix:"核对登记集合数量。"}}]}]});
  assert.equal(e.finish().rejected.length,1);
}));

test("typed object proofs invalidate on acquisition changes and preserve the original first-review authority at closure",async()=>fixture(async(root,write)=>{
  const e=objectEnvironment(root,write,"[摘录范围] snapshot.md 的登记摘录共2条。\n",{firstOnly:true});
  e.put({kind:"registered-excerpts",check:"count",file:"snapshot.md",expected:2});
  const coverage=e.finish(),bytes=fs.readFileSync(path.join(root,"candidate.md")),frame={...e.frame,reads:[...e.frame.policy.coordinator.read]},before=JSON.stringify(frame.reads);
  assert.doesNotThrow(()=>requireStoredObjectChecks(frame,e.spec,[coverage],bytes,"first-review"));
  assert.throws(()=>requireStoredObjectChecks(frame,e.spec,[coverage],bytes,"final-review"),/须重新核验/);
  assert.equal(JSON.stringify(frame.reads),before);
  write("acquisition.json",e.receipt+"\n");assert.throws(e.finish,/回执缺失或已变更/);
  assert.throws(()=>requireStoredObjectChecks(frame,e.spec,[coverage],bytes,"first-review"),/须重新核验/);
}));

test("valid locator-only blocks and claim labels align, while nonexistent or unregistered locators do not disappear",async()=>fixture(async(root,write)=>{
  let e=objectEnvironment(root,write,"出处：snapshot.md 第3行。\n");
  e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[nonfact]}]});const first=e.finish();
  e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[{...fact,evidence:[{file:"snapshot.md",start:3,end:3,quote:"Alpha is recorded."}]}]}]});
  assert.deepEqual(classificationDisagreements(first,e.finish()),[]);
  assert.equal(first.records[0].syntaxSources[0].origin.observation.sha256,digest(e.receipt));
  write("acquisition.json",e.receipt+"\n");
  assert.throws(e.finish,/回执缺失或已变更/);
  assert.equal(e.invoke("inventory").pendingCount,1);
  for(const line of [2,99]){
    e=objectEnvironment(root,write,"出处：snapshot.md 第"+line+"行。\n");
    assert.throws(()=>e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[nonfact]}]}),/纯出处块/);
  }
  const text="- C4：当前结论。",a={records:[{block:"B1",text,parts:[{...nonfact,start:0,end:5},{...fact,start:5,end:text.length}]}]},b={records:[{block:"B1",text,parts:[{...fact,start:0,end:text.length}]}]};
  assert.deepEqual(classificationDisagreements(a,b),[]);
}));

test("fact union and evidence-object disagreements persist without weakening explanation or plain-language facts",()=>{
  const text="前项正确，后项也有事实。",a={block:"B1",text,parts:[{...fact,start:0,end:5},{...nonfact,start:5,end:text.length}]},b={block:"B1",text,parts:[{...fact,start:0,end:text.length}]};
  const dispute=classificationDisagreements({records:[a]},{records:[b]})[0];
  assert.ok(dispute.requiredSpans.some(([start])=>start===0));assert.equal(recordMeetsDispute(a,dispute),false);assert.equal(recordMeetsDispute(b,dispute),true);
  const object=structuredClone(b);object.parts[0].objectCheck={kind:"candidate",source:"functional.csv"};
  assert.ok(classificationDisagreements({records:[b]},{records:[object]})[0].objectSpans.length);
  for(const value of ["不成立：原记录的结果为failure。","大白话：完成状态不保证成功。"]){
    const left={block:"B2",text:value,parts:[{...nonfact,start:0,end:value.length}]},right={block:"B2",text:value,parts:[{...fact,start:0,end:value.length}]};
    assert.ok(classificationDisagreements({records:[left]},{records:[right]}).length);
  }
});


function objectDiagnostic(error) {
  const marker="[coverage-object] ",index=error.message.indexOf(marker);assert.ok(index>=0);
  return JSON.parse(error.message.slice(index+marker.length));
}
test("candidate self-report advice preserves the external whitelist and offers the existing factual return route", async () => fixture(async (root, write) => {
  const body = "正文声明各结论有原始资料（A1）；另一结论以实测为据（A2）。\n";
  const e = objectEnvironment(root, write, body);
  const block = e.blocks[0];
  assert.equal(block.objectCheckHint, undefined);
  const put = part => e.invoke("record", { entries: [{ block: block.id, parts: [part] }] });
  const base = { kind: "direct", status: "supported", sourceRelation: "supports", basis: "逐字核对当前块的来源范围。" };
  for (const attempted of [
    { ...base, evidence: [{ file: "candidate.md", start: 1, end: 1, quote: block.text }] },
    { ...base, objectCheck: { kind: "candidate", check: "citations-marked", source: "functional.csv", marker: "（A1）" } },
    { ...base, objectCheck: { kind: "candidate", check: "citation-profile", source: "candidate.md" } },
  ]) assert.throws(() => put(attempted), error => {
    const diagnostic = objectDiagnostic(error);
    assert.match(diagnostic.manuscript, /objectCheckHint/u);
    assert.match(diagnostic.mixedClaims, /uncertain、sourceRelation=insufficient 和具体 finding/u);
    return true;
  });
  assert.equal(e.invoke("status", { block: block.id }).record, null);
  const rejected = put({ ...base, status: "uncertain", sourceRelation: "insufficient",
    finding: { kind: "missing-evidence", quote: block.text, fix: "为稿内标注范围给出准确行号及已授权原始出处。" } });
  assert.equal(rejected.rejected.length, 1);
  assert.equal(e.invoke("status", { block: block.id }).record.parts[0].objectCheck, undefined);
  assert.equal(fs.readFileSync(path.join(root, "candidate.md"), "utf8"), body);
}));
test("object parameter errors show valid kind-specific templates and never use the candidate as source",async()=>fixture(async(root,write)=>{
  const e=objectEnvironment(root,write,"[稿件自述] 本稿对 functional.csv 有2行可识别同行引用。\n第一处（出处：functional.csv 第2行）。\n第二处（出处：functional.csv 第2行）。\n");
  for(const bad of [
    {kind:"candidate",check:"count",sources:["candidate.md"],expected:2},
    {kind:"candidate",check:"citation-count",file:"functional.csv",expected:2},
    {kind:"candidate",check:"citation-count",source:"candidate.md",expected:2},
  ])assert.throws(()=>e.put(bad),error=>{
    const diagnostic=objectDiagnostic(error);assert.equal(diagnostic.category,"parameter");
    assert.deepEqual(diagnostic.templates.map(row=>row.check),["citation-count","citations-marked","citations-leading-marked"]);
    assert.deepEqual(diagnostic.templates[0],{kind:"candidate",check:"citation-count",source:"functional.csv",expected:2});
    assert.ok(diagnostic.parameterRules.some(rule=>rule.includes("不能填候选文件")));assert.match(diagnostic.next,/删除其他模板的字段/);return true;
  });
  e.put({kind:"candidate",check:"citation-count",source:"functional.csv",expected:2});
  assert.equal(e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck.result.actual,2);
}));

test("wrong expected and measured mismatches name the original quantity and a precise next step",async()=>fixture(async(root,write)=>{
  let e=objectEnvironment(root,write,"[摘录范围] snapshot.md 的登记摘录共3条。\n");
  assert.throws(()=>e.put({kind:"registered-excerpts",check:"count",file:"snapshot.md",expected:2}),error=>{
    const diagnostic=objectDiagnostic(error);assert.deepEqual(diagnostic.claimedQuantities,[3]);
    assert.equal(diagnostic.templates[0].expected,3);assert.equal(diagnostic.templates[0].file,"snapshot.md");return true;
  });
  assert.throws(()=>e.put({kind:"registered-excerpts",check:"count",file:"snapshot.md",expected:3}),error=>{
    const diagnostic=objectDiagnostic(error);assert.equal(diagnostic.actual,2);assert.equal(diagnostic.unit,"registered-excerpts");
    assert.match(diagnostic.next,/不是其中举例或结论类别数/);assert.match(diagnostic.next,/unsupported/);return true;
  });
  assert.equal(e.invoke("status").rejected.length,0);
}));

test("citationLineCounts and object checks use identical physical-line counting including duplicate locators",async()=>fixture(async(root,write)=>{
  const body="[稿件自述] 本稿对 functional.csv 有2行可识别同行引用。\r\n一行两处：functional.csv 第2行；functional.csv #L2。\r\n仅提及 functional.csv。\r\n另一行：functional.csv:2，timing.csv 第2-3行。\r\n";
  const e=objectEnvironment(root,write,body);
  const counted=citationLineCounts(Buffer.from(body),["functional.csv","timing.csv","functional.csv"]);
  assert.deepEqual(counted,[{source:"functional.csv",count:2,lines:[2,4]},{source:"timing.csv",count:1,lines:[4]}]);
  e.put({kind:"candidate",check:"citation-count",source:"functional.csv",expected:2});
  const checked=e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck.result;
  assert.equal(checked.actual,counted[0].count);assert.deepEqual(checked.lines,counted[0].lines);
  assert.deepEqual(citationLineCounts(Buffer.from("只有 functional.csv 文件名。\n"),["functional.csv"]),[{source:"functional.csv",count:0,lines:[]}]);
}));

// Frozen author bytes from 020834Z/reuse: the final self-description and its six
// cited physical lines are correct. Only review parameters should change.
const countList020834Z=[
  "# 检查结果与观测说明",
  "- C1：GitHub 的 completed 状态可以对应 failure 结论（出处：sources/github-checks.md 第 6-8 行）。",
  "- C2：NIST 指出，相关不必然说明因果（出处：sources/nist-scatter.md 第 6 行）。",
  "- C3：[模拟] 按本例规则，样本 X 是 A 级，因此样本 X 应送复核（出处：sources/synthetic.md 第 4-5 行）。",
  "- 错例：[模拟] 记录 A 已完成，因此记录 A 必定成功（出处：sources/synthetic.md 第 2 行）；该行原文记录的是 conclusion=failure，结论与原文相反，推不出“必定成功”。",
  "- 错例：[模拟] 模拟观测组的训练时长与分数正相关，因此延长训练必然提高每个人的分数（出处：sources/synthetic.md 第 3 行）；原文只说正相关，且没有随机分配、没有排除其他共同影响因素，不能据此确定因果，也不能外推到每个人。",
  "- 错例：[模拟] 样本 X 应送复核，因此任何送复核的样本都是 A 级（出处：sources/synthetic.md 第 4-5 行）；本例规则只有“A 级则送复核”这一单向方向，不能逆推。",
  "- 就模拟观测记录而言，只能报告相关，不能单凭该记录确定因果（出处：sources/synthetic.md 第 3 行；sources/nist-scatter.md 第 6 行）。",
  "- [推测] 后续可以考虑通过更合适的研究设计检验原因。",
  "- 错例：记录 A 已完成，所以记录 A 必定成功（出处：sources/synthetic.md 第 2 行）。",
  "- [摘录范围] 本轮登记的 sources/nist-scatter.md 含 1 条 NIST 页面短摘录。",
  "- C4：所称“NIST 散点图页面原文举了 GitHub 列表中的 failure 和 success 两项”无登记原文可证（出处：sources/nist-scatter.md 第 6 行，该行只写 association does NOT imply causality，未提 GitHub 列表）。",
  "- [稿件自述] 本稿有 6 行带 sources/synthetic.md 的行号定位（第 4、5、6、7、8、10 行）。",
  "","大白话：把完成状态、实际结果和证据能说明的范围分开看。","",
].join("\n");
const synthetic020834Z="# 合成逻辑样例；不是外部研究、生产日志或真实效果数据\n记录 A：status=completed，conclusion=failure。\n模拟观测组：训练时长与分数正相关；没有随机分配，也没有排除其他共同影响因素。\n本例分级规则：如果一个样本是 A 级，则该样本应送复核。\n本例对象：样本 X 是 A 级。\n";

const scope063221Z="[模拟] 按本例规则只能由 A 级推出应送复核，不能反推，所以样本 X 应送复核并不能说明其他送复核的样本也是 A 级（出处：sources/synthetic.md 第 4-5 行）。";
const draft063221Z=[
  "# 检查结果与观测说明",
  "- C1：GitHub 的 completed 状态可以对应 failure 结论（出处：sources/github-checks.md 第 6-8 行）。",
  "- C2：NIST 指出，相关不必然说明因果（出处：sources/nist-scatter.md 第 6 行）；该页原文写“association does NOT imply causality.”，含义同此（出处：sources/nist-scatter.md 第 6 行）。",
  "- C3：按本例规则，样本 X 是 A 级，因此样本 X 应送复核（出处：sources/synthetic.md 第 4-5 行）。",
  "[模拟] completed 只表示状态字段已完成，对应的 conclusion 可能是 failure，也可能是 success，不能由完成状态推出成功（出处：sources/synthetic.md 第 2 行；sources/github-checks.md 第 6-8 行）。",
  "[模拟] 模拟观测组只能报告正相关；该记录没有随机分配、也没有排除其他共同影响因素，因此不能确定训练导致分数提高（出处：sources/synthetic.md 第 3 行）。",
  scope063221Z,
  "[模拟] 就 sources/synthetic.md 的模拟观测记录而言，只能报告相关，不能单凭该记录确定因果（出处：sources/synthetic.md 第 3 行；sources/nist-scatter.md 第 6 行）。",
  "[推测] 后续可以考虑通过更合适的研究设计检验原因。",
  "- C4：GitHub 登记摘录中，completed 状态下的 conclusion 举例列有 failure 和 success（出处：sources/github-checks.md 第 6-8 行）。",
  "- [摘录范围] 本轮登记的 sources/nist-scatter.md 含 1 条 NIST 页面短摘录。",
  "错例：记录 A 已完成，所以记录 A 必定成功（出处：sources/synthetic.md 第 2 行）。",
  "- [稿件自述] 行号定位 6 行：带 sources/synthetic.md 的行号定位为第 4,5,6,7,8,12 行；同带 [模拟] 4 行：第 5,6,7,8 行。",
  "大白话：把完成状态、实际结果和证据能说明的范围分开看。", "",
].join("\n");
const caseFile="sources/synthetic.md";
const boundedPart={kind:"inference",status:"supported",sourceRelation:"supports",basis:"同一规则只规定分类能推出复核，其他复核对象仍有不同分类的可能。"};

/** Use a current pinned synthetic source and the normal inventory/record entry. */
function caseFixture(root,write,body,source=synthetic020834Z,firstOnly=false) {
  const e=objectEnvironment(root,write,body,{sources:{[caseFile]:source}});
  e.frame.policy.sourcePins[keyOf(caseFile)]={kind:"synthetic",locator:"synthetic:bounded-test",sha256:digest(source)};
  if(firstOnly) {
    e.active.phase="first-review";
    e.frame.reads=e.spec.phases["first-review"].read;
    e.active.seen={};
    delete e.active.coverage;
    for(const file of e.frame.reads)e.read(file);
  }
  const target=e.invoke("inventory",{count:24}).blocks.find(b=>b.text.includes("按本例规则只能由"));
  const record=(...parts)=>e.invoke("record",{entries:[{block:target.id,parts}]});
  const saved=()=>e.invoke("status",{block:target.id}).record;
  return {...e,target,record,saved};
}

test("063221Z preserves the original valid rule non-entailment and retires its false author finding",async()=>fixture(async(root,write)=>{
  assert.equal(digest(draft063221Z),"75d74a752b36e5802451aad3104596dd88774433980fef846fbde332d2e1fb3f");
  const e=caseFixture(root,write,draft063221Z),{target}=e;
  assert.equal(target.id,"B10-1aa3ca1c");
  assert.equal(target.line,7);
  const tail="，所以样本 X 应送复核并不能说明其他送复核的样本也是 A 级";
  assert.equal(target.inferenceHint.quote,tail);
  assert.deepEqual(target.inferenceHint.source,{file:caseFile,start:4,end:5});
  const prefix={...fact,quote:target.text.slice(0,target.text.indexOf(tail)),evidence:[{
    file:caseFile,start:4,end:4,quote:synthetic020834Z.split("\n")[3],
  }]};
  const locator={...nonfact,quote:target.text.slice(target.text.indexOf(tail)+tail.length)};
  const old={...boundedPart,quote:tail,status:"unsupported",sourceRelation:"insufficient",finding:{
    kind:"invalid-inference",quote:tail.slice(1),fix:"删除‘所以样本 X 应送复核并不能说明其他送复核的样本也是 A 级’。",
  }};
  assert.throws(()=>e.record(prefix,old,locator),/‘不能说明’成立.*只改核验状态/);
  assert.throws(()=>e.record(prefix,{...boundedPart,quote:tail,sourceRelation:"insufficient"},locator),/sourceRelation 应为 supports.*外层/);
  assert.equal(e.invoke("status").rejected.length,0);
  assert.throws(()=>e.record(prefix,{...nonfact,quote:tail},locator),/须以 inference 连续覆盖/);
  e.record(prefix,{...boundedPart,quote:tail},locator);
  const record=e.saved(),proof=record.parts[1].inference;
  assert.equal(proof.rule,"bounded-non-entailment");
  assert.equal(proof.nonEntailment.kind,"non-entailment");
  assert.equal(proof.nonEntailment.holds,true);
  assert.deepEqual(proof.nonEntailment.witnesses,[{otherAntecedent:false,otherConsequent:true,otherObservedAction:true},
    {otherAntecedent:true,otherConsequent:true,otherObservedAction:true}]);
  assert.deepEqual(proof.premises.map(r=>[r.file,r.start,r.end,r.quote]),[4,5].map(i=>[caseFile,i,i,synthetic020834Z.split("\n")[i-1]]));
  assert.equal(proof.nonEntailment.assertion.quoteSha256,digest(tail));
  assert.equal(e.invoke("status").rejected.length,0);
  requireStoredObjectChecks(e.frame,e.spec,[{records:[record]}],Buffer.from(draft063221Z));
  write(caseFile,synthetic020834Z.replace("样本 X 是 A 级","样本 Y 是 A 级"));
  assert.throws(()=>requireStoredObjectChecks(e.frame,e.spec,[{records:[record]}],Buffer.from(draft063221Z)),/证明失效/);
}));

test("same one-way premises cannot establish the affirmative opposite and preserve the exact finding",async()=>fixture(async(root,write)=>{
  const opposite="就能说明其他送复核的样本都不是 A 级";
  const body=scope063221Z.replace("并不能说明其他送复核的样本也是 A 级",opposite)+"\n";
  const e=caseFixture(root,write,body,synthetic020834Z,true);
  assert.equal(e.target.inferenceHint.rule,"bounded-non-entailment");
  assert.throws(()=>e.record(boundedPart),/前提无法支持‘其他都不是’/);
  const wrong={...boundedPart,status:"unsupported",sourceRelation:"insufficient",
    finding:{kind:"invalid-inference",quote:opposite,fix:"把肯定否定结论改成不能由本例材料确定其他对象分类。"}};
  assert.throws(()=>e.record({...wrong,sourceRelation:"contradicts"}),/并未证明现实中的其他对象/);
  assert.throws(()=>e.record({...wrong,finding:{...wrong.finding,quote:"不能反推"}}),/不能退回前面正确的单向规则/);
  e.record(wrong);
  const rejected=e.finish().rejected;
  assert.equal(rejected.length,1);
  assert.equal(rejected[0].finding.quote,opposite);
  assert.equal(rejected[0].boundedNonEntailment.kind,"opposite");
  assert.equal(rejected[0].boundedNonEntailment.holds,false);
  assert.deepEqual(rejected[0].repairBaseline.refs.map(ref=>[ref.start,ref.end]),[[4,4],[5,5],[4,5]]);
}));

test("105947Z L16 preserves outer denial of the negative target without permitting the affirmative opposite",async()=>fixture(async(root,write)=>{
  const tail="也不能说明其他送复核的样本不是 A 级";
  const exact=scope063221Z.replace("并不能说明其他送复核的样本也是 A 级",tail)+"\n";
  let e=caseFixture(root,write,exact);
  assert.ok(e.target.inferenceHint.quote.endsWith(tail));
  assert.throws(()=>e.record({...boundedPart,status:"unsupported",sourceRelation:"insufficient",finding:{
    kind:"invalid-inference",quote:tail,fix:"删除未获支持的断言。",
  }}),/‘不能说明’成立.*只改核验状态/);
  assert.deepEqual(e.invoke("status").rejected,[]);
  e.record(boundedPart);
  const proof=e.saved().parts[0].inference.nonEntailment;
  assert.equal(proof.holds,true);
  assert.equal(proof.targetPolarity,"negative");
  assert.deepEqual(proof.witnesses.map(world=>world.otherAntecedent),[false,true]);
  assert.deepEqual(e.finish().rejected,[]);
  e=caseFixture(root,write,exact.replace(tail,"就能说明其他送复核的样本都不是 A 级"));
  assert.throws(()=>e.record(boundedPart),/前提无法支持‘其他都不是’/);
}));

test("105949Z L15 binds the outer denial to the rule without inventing a stated object",async()=>fixture(async(root,write)=>{
  const tail="不能由此反推其他送复核的样本都不是 A 级";
  const exact=scope063221Z.replace("样本 X 应送复核并不能说明其他送复核的样本也是 A 级",tail)+"\n";
  let e=caseFixture(root,write,exact);
  assert.ok(e.target.inferenceHint.quote.endsWith(tail));
  assert.throws(()=>e.record({...boundedPart,status:"unsupported",sourceRelation:"insufficient",finding:{
    kind:"invalid-inference",quote:tail,fix:"删除未获支持的断言。",
  }}),/‘不能说明’成立.*只改核验状态/);
  e.record(boundedPart);
  const proof=e.saved().parts[0].inference.nonEntailment;
  assert.equal(proof.holds,true);
  assert.equal(proof.object,null);
  assert.equal(proof.scopeReference,"rule-only");
  assert.equal(proof.targetPolarity,"negative");
  e=caseFixture(root,write,exact.replace("其他送复核","其他接受审核"));
  assert.equal(e.target.inferenceHint,undefined);
}));

test("bounded inference requires the same cited rule, classification, action, object and current reads",async()=>fixture(async(root,write)=>{
  const alternate=scope063221Z.replaceAll("A 级","B 类").replaceAll("样本","申请").replaceAll(" X "," R7 ").replaceAll("送复核","进入审核");
  const alternateSource=synthetic020834Z.replaceAll("A 级","B 类").replaceAll("样本","申请").replaceAll(" X "," R7 ").replaceAll("送复核","进入审核");
  let e=caseFixture(root,write,alternate,alternateSource);
  assert.ok(e.target.inferenceHint);
  delete e.active.seen[keyOf(caseFile)];
  assert.throws(()=>e.record(boundedPart),/本轮实际读过的当前原文行/);
  e.read(caseFile);e.record(boundedPart);
  assert.equal(e.saved().parts[0].inference.nonEntailment.object,"R7");
  for(const invalidSource of [
    alternateSource.replace("申请 R7 是 B 类","申请 R8 是 B 类"),
    alternateSource.replace("应进入审核","应进入复查"),
    alternateSource.replace("，则该申请应进入审核。","，则该申请应进入审核；反之亦然。"),
  ]) {
    e=caseFixture(root,write,alternate,invalidSource);
    assert.throws(()=>e.record(boundedPart),/推导需明确 rule/);
  }
  for(const changed of [
    alternate.replace("其他进入审核","其他进入复查"),
    alternate.replace("也是 B 类","也是 B 类并且更安全"),
    alternate.replace("第 4-5 行","第 4-6 行"),
  ]) {
    e=caseFixture(root,write,changed,alternateSource);
    assert.equal(e.target.inferenceHint,undefined);
    assert.throws(()=>e.record(boundedPart),/推导需明确 rule/);
  }
}));

// Immutable draft from 053234Z; line 13 produced two separate review blocks.
const profile053234Z=[
  "# 检查结果与观测说明",
  "- C1：GitHub 的 completed 状态可以对应 failure 结论；原文限定为 completed 状态下 conclusion 可以是 failure 或 success 等任一项（出处：sources/github-checks.md 第 6-8 行）。",
  "- C2：NIST 指出，相关不必然说明因果（出处：sources/nist-scatter.md 第 6 行）。",
  "- C3：按本例规则，样本 X 是 A 级，因此样本 X 应送复核；该规则只就本例样本 X 作单向推导，不外推到其他样本（出处：sources/synthetic.md 第 4-5 行）。",
  "- [模拟] 记录 A 已完成，但 conclusion 为 failure，不能因已完成推出成功（出处：sources/synthetic.md 第 2 行）。",
  "- [模拟] 模拟观测组的训练时长与分数正相关，但没有随机分配，也没有排除其他共同影响因素，不能由此推出延长训练必然提高每个人的分数（出处：sources/synthetic.md 第 3 行）。",
  "- [模拟] 本例规则只有 A 级则送复核这一单向方向，不能反过来推出送复核的样本都是 A 级（出处：sources/synthetic.md 第 4-5 行）。",
  "- [模拟] 就 sources/synthetic.md 的模拟观测记录而言，只能报告相关，不能单凭该记录确定因果（出处：sources/synthetic.md 第 3 行；sources/nist-scatter.md 第 6 行）。",
  "- [推测] 后续可以考虑通过更合适的研究设计检验原因。",
  "- 错例：记录 A 已完成，所以记录 A 必定成功（出处：sources/synthetic.md 第 2 行）。",
  "- C4：completed 状态下 conclusion 不只限于 failure，也可以是 success 等任一项，因此 completed 状态本身不能确定实际结果（出处：sources/github-checks.md 第 6-8 行）。",
  "- [摘录范围] 本轮登记的 sources/nist-scatter.md 含 1 条 NIST 页面短摘录。",
  "- [稿件自述] 行号定位 6 行：带 sources/synthetic.md 的行号定位为第 4-8 行及第 10 行错例行；同带 [模拟] 4 行：第 5-8 行。",
  "- [引文校验] sources/nist-scatter.md 第 6 行逐字为“association does NOT imply causality.”。",
  "大白话：把完成状态、实际结果和证据能说明的范围分开看。", "",
].join("\n");
const profileCheck={kind:"candidate",check:"citation-profile",source:"sources/synthetic.md"};
const profileFixture=(root,write,body=profile053234Z)=>objectEnvironment(root,write,body,{sources:{"sources/synthetic.md":synthetic020834Z}});
const profileBlocks=e=>e.invoke("inventory",{count:24}).blocks.filter(block=>block.line===13);
const profileProof=(e,block)=>e.invoke("status",{block:block.id}).record.parts[0].objectCheck;

test("053234Z blocked compound statistics verify both original spans without rewriting a byte",async()=>fixture(async(root,write)=>{
  const expectedHash="cbf93253b49e4685c103411d459db079c6f0bb845aa5216911c239313439c971";
  assert.equal(digest(profile053234Z),expectedHash);
  const e=profileFixture(root,write),[head,tail]=profileBlocks(e);
  assert.equal(head.id,"B16-68820bbd");
  assert.deepEqual(head.objectCheckHint,profileCheck);
  assert.deepEqual(tail.objectCheckHint,profileCheck);
  e.put(head.objectCheckHint,{block:head.id});e.put(tail.objectCheckHint,{block:tail.id});
  const headProof=profileProof(e,head),tailProof=profileProof(e,tail);
  assert.equal(headProof.candidateSha256,expectedHash);assert.equal(tailProof.candidateSha256,expectedHash);
  assert.deepEqual(headProof.result,{matches:true,profileClause:"citation-lines",expected:6,actual:6,unit:"candidate-citation-lines",
    lines:[4,5,6,7,8,10],claimedLines:[4,5,6,7,8,10],lineListMatches:true,missingLines:[],missingCount:0,extraLines:[],extraCount:0,
    duplicateLines:[],exampleLines:[10],wrongExampleLines:[]});
  assert.deepEqual(tailProof.result,{matches:true,profileClause:"marked-citation-lines",expected:4,actual:4,unit:"candidate-marked-citation-lines",
    lines:[5,6,7,8],claimedLines:[5,6,7,8],lineListMatches:true,missingLines:[],missingCount:0,extraLines:[],extraCount:0,duplicateLines:[],
    exampleLines:[],wrongExampleLines:[],marker:"[模拟]",markerPosition:"any"});
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),profile053234Z);
  const records=[head,tail].map(block=>e.invoke("status",{block:block.id}).record);
  requireStoredObjectChecks(e.frame,e.spec,[{records}],Buffer.from(profile053234Z));
  assert.throws(()=>requireStoredObjectChecks(e.frame,e.spec,[{records}],Buffer.from(profile053234Z.replace("同带 [模拟] 4", "同带 [模拟] 3"))),/失效/);
}));

test("compound counts, each ordinal set, and explicit error-example annotations reject independently",async()=>fixture(async(root,write)=>{
  const cases=[
    ["行号定位 6 行","行号定位 7 行",0,"行号定位 7 行",{expected:7,actual:6}],
    ["第 4-8 行及第 10 行错例行","第 4-8 行及第 9 行",0,"第 4-8 行及第 9 行",{missingLines:[10],extraLines:[9]}],
    ["第 4-8 行及第 10 行错例行","第 4-8 行及第 8 行",0,"第 4-8 行及第 8 行",{duplicateLines:[8]}],
    ["第 4-8 行及第 10 行错例行","第 4-7 行及第 8 行错例行及第 10 行",0,"第 8 行错例行",{wrongExampleLines:[8],lineListMatches:true}],
    ["同带 [模拟] 4 行","同带 [模拟] 5 行",1,"同带 [模拟] 5 行",{expected:5,actual:4}],
    ["同带 [模拟] 4 行：第 5-8 行","同带 [模拟] 4 行：第 5-7、10 行",1,"第 5-7、10 行",{missingLines:[8],extraLines:[10]}],
  ];
  for(const [oldText,newText,index,finding,expected] of cases) {
    const e=profileFixture(root,write,profile053234Z.replace(oldText,newText)),block=profileBlocks(e)[index];
    assert.throws(()=>e.put(profileCheck,{block:block.id}),error=>{
      const actual=objectDiagnostic(error);assert.equal(actual.matches,false);
      for(const [key,value] of Object.entries(expected))assert.deepEqual(actual[key],value);
      return true;
    });
    assert.equal(e.invoke("status").rejected.length,0);
    e.put(profileCheck,{block:block.id,status:"unsupported",finding:objectFinding(finding)});
    assert.equal(profileProof(e,block).result.matches,false);
    assert.equal(e.invoke("status").rejected.length,1);
  }
}));

test("executor preflight measures the same current candidate profiles as review, using only its approved sources",async()=>fixture(async(root,write)=>{
  const bytes=Buffer.from(profile053234Z),source=profileCheck.source,candidate="candidate.md";
  const e=profileFixture(root,write),blocks=profileBlocks(e);
  const measured=candidateCitationProfiles(bytes,[source],candidate);
  for(const [index,block] of blocks.entries()) {
    e.put(profileCheck,{block:block.id});
    assert.deepEqual(measured[index],{line:13,block:block.id,source,...profileProof(e,block).result});
  }
  assert.deepEqual(candidateCitationProfiles(bytes,["snapshot.md"],candidate),[]);
  assert.deepEqual(candidateCitationProfiles(Buffer.from("\n"),[source],candidate),[]);
  assert.deepEqual(candidateCitationProfiles(bytes,[source],source),[]);
  const wrong=Buffer.from(profile053234Z.replace("同带 [模拟] 4 行：第 5-8 行", "同带 [模拟] 4 行：第 5-7、10 行"));
  const changed=candidateCitationProfiles(wrong,[source],candidate);
  assert.equal(changed[0].matches,true);assert.equal(changed[1].matches,false);
  assert.deepEqual(changed[1].missingLines,[8]);assert.deepEqual(changed[1].extraLines,[10]);
}));

test("a compound statistic needs the current full read, its own source and exact proof for both clauses",async()=>fixture(async(root,write)=>{
  const e=profileFixture(root,write),[head,tail]=profileBlocks(e);
  const candidate=e.active.seen[keyOf("candidate.md")];
  e.active.seen[keyOf("candidate.md")]={...candidate,ranges:[[13,13]]};
  assert.throws(()=>e.put(profileCheck,{block:head.id}),/实际完整读取/);
  e.read("candidate.md");
  assert.throws(()=>e.put({...profileCheck,expected:6},{block:head.id}),/字段不匹配/);
  assert.throws(()=>e.put({...profileCheck,source:"snapshot.md"},{block:tail.id}),/同一来源/);
  assert.throws(()=>e.put(profileCheck,{block:tail.id,status:"unsupported",finding:objectFinding("同带 [模拟] 4 行")}),/实测成立/);
  assert.throws(()=>e.invoke("record",{entries:[{block:tail.id,parts:[nonfact]}]}),/须按本块的 objectCheckHint/);
  assert.throws(()=>e.invoke("record",{entries:[{block:tail.id,parts:[fact]}]}),/须按本块的 objectCheckHint/);
  const numberOnly="同带 [模拟] 4 行：";
  assert.throws(()=>e.invoke("record",{entries:[{block:tail.id,parts:[{...fact,quote:numberOnly,evidence:undefined,objectCheck:profileCheck},
    {...nonfact,quote:tail.text.slice(numberOnly.length)}]}]}),/完整原句块/);
  e.put(profileCheck,{block:head.id});e.put(profileCheck,{block:tail.id});
  const records=[head,tail].map(block=>e.invoke("status",{block:block.id}).record);
  // Old proof shapes cannot claim closure after the current host identifies the
  // same marker-count clause as requiring an actual manuscript measurement.
  records[1]={...records[1],parts:[{...records[1].parts[0],objectCheck:undefined}]};
  assert.throws(()=>requireStoredObjectChecks(e.frame,e.spec,[{records}],Buffer.from(profile053234Z)),/失效/);
}));

test("compound marks are limited to the chosen source, and leading marks cannot be borrowed from inline text",async()=>fixture(async(root,write)=>{
  const changed=profile053234Z.replace("- [模拟] 记录 A 已完成", "- 记录 A [模拟] 已完成")
    .replace("- [推测] 后续可以考虑", "- [推测] [模拟] 后续可以考虑");
  let e=profileFixture(root,write,changed),tail=profileBlocks(e)[1];
  e.put(profileCheck,{block:tail.id});assert.deepEqual(profileProof(e,tail).result.lines,[5,6,7,8]);
  e=profileFixture(root,write,changed.replace("同带 [模拟]", "同行首带 [模拟]"));tail=profileBlocks(e)[1];
  assert.throws(()=>e.put(profileCheck,{block:tail.id}),error=>{
    const measured=objectDiagnostic(error);assert.equal(measured.markerPosition,"leading");
    assert.deepEqual(measured.lines,[6,7,8]);assert.deepEqual(measured.extraLines,[5]);return true;
  });
  e=profileFixture(root,write,changed.replace("同带 [模拟] 4 行：第 5-8 行", "同行首带 [模拟] 3 行：第 6-8 行"));tail=profileBlocks(e)[1];
  e.put(profileCheck,{block:tail.id});assert.deepEqual(profileProof(e,tail).result.lines,[6,7,8]);
}));

test("unbounded or attached additional statistics do not borrow the recognized exact proof",async()=>fixture(async(root,write)=>{
  for(const body of [
    profile053234Z.replace("第 5-8 行。", "第 5-8 等行。"),
    profile053234Z.replace("第 5-8 行。", "第 1-257 行。"),
    profile053234Z.replace("第 5-8 行。", "第 5-8 行，且外部已证明新结论。"),
  ]) {
    const e=profileFixture(root,write,body),blocks=profileBlocks(e);
    assert.ok(blocks.every(block=>!block.objectCheckHint));
    assert.throws(()=>e.put(profileCheck,{block:blocks[0].id}),/完整原句块/);
  }
}));

test("an independent trailing block still needs its own proof; an explicit zero marked subset checks all cited rows",async()=>fixture(async(root,write)=>{
  for(const delimiter of ["；","。"]) {
    const body=profile053234Z.replace("第 5-8 行。", "第 5-8 行"+delimiter+"外部已证明新结论。");
    const e=profileFixture(root,write,body),[head,tail,independent]=profileBlocks(e);
    assert.deepEqual([head.objectCheckHint,tail.objectCheckHint],[profileCheck,profileCheck]);
    assert.equal(independent.objectCheckHint,undefined);
    e.put(profileCheck,{block:head.id});e.put(profileCheck,{block:tail.id});
    assert.throws(()=>e.put(profileCheck,{block:independent.id}),/完整原句块/);
    assert.ok(e.invoke("status").pending.includes(independent.id));
  }
  const zero=profile053234Z.replaceAll("- [模拟] ","- ").replace("同带 [模拟] 4 行：第 5-8 行","同带 [模拟] 0 行：无")
    .replace("- [推测] 后续可以考虑","- [推测] [模拟] 后续可以考虑");
  let e=profileFixture(root,write,zero),tail=profileBlocks(e)[1];
  e.put(profileCheck,{block:tail.id});assert.deepEqual(profileProof(e,tail).result.lines,[]);
  e=profileFixture(root,write,zero.replace("- 记录 A 已完成，但", "- [模拟] 记录 A 已完成，但"));tail=profileBlocks(e)[1];
  assert.throws(()=>e.put(profileCheck,{block:tail.id}),error=>{
    const measured=objectDiagnostic(error);assert.equal(measured.expected,0);assert.deepEqual(measured.missingLines,[5]);return true;
  });
}));

test("020834Z exact count plus ordinal list proves every claimed physical line without editing the manuscript",async()=>fixture(async(root,write)=>{
  const e=objectEnvironment(root,write,countList020834Z,{sources:{"sources/synthetic.md":synthetic020834Z}});
  const block=e.invoke("inventory",{count:24}).blocks.find(row=>row.line===13);
  e.put({kind:"candidate",check:"citation-count",source:"sources/synthetic.md",expected:6},{block:block.id});
  const saved=e.invoke("status",{block:block.id}).record.parts[0].objectCheck;
  assert.equal(saved.result.matches,true);assert.deepEqual(saved.result.claimedLines,[4,5,6,7,8,10]);
  assert.deepEqual(saved.result.lines,[4,5,6,7,8,10]);assert.equal(saved.result.lineListMatches,true);
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),countList020834Z);
}));

test("020834Z count and list cannot be certified by using the source path as a marking predicate",async()=>fixture(async(root,write)=>{
  const e=objectEnvironment(root,write,countList020834Z,{sources:{"sources/synthetic.md":synthetic020834Z}});
  const block=e.invoke("inventory",{count:24}).blocks.find(row=>row.line===13);
  assert.throws(()=>e.put({kind:"candidate",check:"citations-marked",source:"sources/synthetic.md",marker:"sources/synthetic.md"},{block:block.id}),/标记|marker/);
  assert.equal(e.invoke("status").rejected.length,0);assert.ok(e.invoke("status").pending.includes(block.id));
}));

test("an exact count does not certify an incorrect, duplicate or incomplete ordinal list",async()=>fixture(async(root,write)=>{
  const body=list=>"[稿件自述] 本稿有2行带 functional.csv 的行号定位（第"+list+"行）。\n第一处 functional.csv 第2行。\n无引用的正文。\n第二处 functional.csv 第2行。\n";
  const check={kind:"candidate",check:"citation-count",source:"functional.csv",expected:2};
  for(const list of ["2、3","2、2","2","2、4、9"]) {
    const e=objectEnvironment(root,write,body(list));
    assert.throws(()=>e.put(check),error=>{
      const details=objectDiagnostic(error);assert.equal(details.category,"parameter");assert.equal(details.actual,2);
      assert.equal(details.lineListMatches,false);assert.equal(details.matches,false);return true;
    });
    assert.equal(e.invoke("status").rejected.length,0);
    e.put(check,{status:"unsupported",finding:objectFinding("第"+list+"行")});
    assert.equal(e.invoke("status").rejected.length,1);
  }
  for(const list of ["2、4","4、2"]) {
    const e=objectEnvironment(root,write,body(list));e.put(check);
    assert.equal(e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck.result.matches,true);
  }
  const e=objectEnvironment(root,write,body("2、4"));
  assert.throws(()=>e.put({...check,expected:4}),error=>{
    assert.deepEqual(objectDiagnostic(error).claimedQuantities,[2]);return true;
  });
}));

test("ordinal ranges compare the complete set beyond the bounded result preview",async()=>fixture(async(root,write)=>{
  const check={kind:"candidate",check:"citation-count",source:"functional.csv",expected:26};
  const rows=Array.from({length:26},(_,index)=>"第"+(index+1)+"处 functional.csv 第2行。").join("\n");
  let e=objectEnvironment(root,write,"[稿件自述] 本稿对 functional.csv 有26行可识别同行引用（第2-27行）。\n"+rows+"\n");
  e.put(check);let saved=e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck;
  assert.equal(saved.result.lines.length,24);assert.equal(saved.result.claimedLines.length,26);assert.equal(saved.result.matches,true);
  e=objectEnvironment(root,write,"[稿件自述] 本稿对 functional.csv 有26行可识别同行引用（第2-26、28行）。\n"+rows+"\n");
  assert.throws(()=>e.put(check),error=>{
    const details=objectDiagnostic(error);assert.deepEqual(details.missingLines,[27]);assert.deepEqual(details.extraLines,[28]);return true;
  });
  e.put(check,{status:"unsupported",finding:objectFinding("第2-26、28行")});
  saved=e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck;assert.equal(saved.result.actual,26);assert.equal(saved.result.matches,false);
}));

test("standalone manuscript count hints preserve authored quantity, exact ordinals and separate sibling claims", async () => fixture(async (root, write) => {
  const source = "sources/regional-register.md";
  const raw = "[稿件自述] 本稿带 `sources/regional-register.md` 行号引用的共 3 行（第16、17、18行）；";
  const body = claim => ["# 交付稿", ...Array(14).fill(""), ...[3, 4, 5].map(i => `出处：${source} 第${i}行。`), "", claim].join("\n");
  const materials = { sources: { [source]: "登记样例\n空行\n甲\n乙\n丙\n" } };
  const originalBlock = `${raw}附加断言：有用户已上线。`;
  const check = { kind: "candidate", check: "citation-count", source, expected: 3 };
  for (const sentence of [originalBlock, raw.replace("（第16、17、18行）", "，分别是第16、17、18行"),
    ...["：第 16、17、18 行。","，行号为第16、17、18行。","，具体行号如下：第16、17、18行。"]
      .map(suffix=>`[稿件自述] 本稿共 3 行带 ${source} 的原文行号引用${suffix}`),
    raw.replace("行号引用的共 3 行", "行号定位的共 三 行"), raw.replace("行号引用的共 3 行", "行号引用的共 ３ 行")]) {
    const e = objectEnvironment(root, write, body(sentence), materials);
    const page = e.invoke("inventory", { count: 24 });
    const block = page.blocks.find(row => row.text.startsWith("[稿件自述]"));
    assert.deepEqual(block.objectCheckHint, check);
    e.put(block.objectCheckHint, { block: block.id });
    const proof = e.invoke("status", { block: block.id }).record.parts[0].objectCheck;
    assert.equal(proof.result.matches, true);
    assert.deepEqual(proof.result.claimedLines, [16, 17, 18]);
    assert.deepEqual(proof.result.lines, [16, 17, 18]);
    if (sentence === originalBlock) {
      const sibling = page.blocks.find(row => row.text.includes("有用户已上线"));
      assert.equal(sibling.objectCheckHint, undefined);
      assert.ok(e.invoke("status").pending.includes(sibling.id));
    }
  }
  for (const tail of ["，分别是第16、17、18行（C2、C3、C4 各一行）；", "（第16、17、18行），与某计数器一致；",
    "：第16、17、18行（所有均已上线）；"]) {
    const e = objectEnvironment(root, write, body(raw.replace("（第16、17、18行）；", tail)), materials);
    const block = e.invoke("inventory", { count: 24 }).blocks.find(row => row.text.startsWith("[稿件自述]"));
    assert.equal(block.objectCheckHint, undefined);
    assert.throws(() => e.put(check, { block: block.id }), /不能忽略未核列表/u);
  }
  for (const [changed, expected, missing] of [[raw.replace("16、17、18", "16、17、19"), 3, [18]],
    [raw.replace("共 3 行", "共 4 行"), 4, []]]) {
    const e = objectEnvironment(root, write, body(changed), materials);
    const block = e.invoke("inventory", { count: 24 }).blocks.find(row => row.text.startsWith("[稿件自述]"));
    assert.deepEqual(block.objectCheckHint, { ...check, expected });
    assert.throws(() => e.put(block.objectCheckHint, { block: block.id }), error => {
      const diagnostic = objectDiagnostic(error);
      assert.equal(diagnostic.actual, 3);
      assert.equal(diagnostic.matches, false);
      assert.deepEqual(diagnostic.missingLines, missing);
      return true;
    });
  }
  const split = `[稿件自述] 本稿共 3 行带 ${source} 的原文行号引用`;
  for (const [suffix, expectedMatch] of [["：第 16、17、18 行。", true], ["：第 16、17、19 行。", false]]) {
    const e = objectEnvironment(root, write, body(split+suffix), materials);
    const block = e.invoke("inventory",{count:24}).blocks.find(row=>row.text.startsWith("[稿件自述]"));
    assert.throws(() => e.invoke("record",{entries:[{block:block.id,parts:[
      {kind:"direct",status:"supported",sourceRelation:"supports",basis:"实测正好三行。",quote:split,objectCheck:check},
      {kind:"nonfactual",status:"supported",basis:"说成仅是版式。",quote:suffix},
    ]}]}), /核对完整原句/u);
    const measured=candidateCitationProfiles(fs.readFileSync(path.join(root,"candidate.md")),[source],"candidate.md");
    assert.equal(measured[0].matches,expectedMatch);
    assert.deepEqual(measured[0].lines,[16,17,18]);
  }
}));

test("ordinal grammar rejects unverified abbreviations, ambiguous source lists and oversized ranges as parameters",async()=>fixture(async(root,write)=>{
  const check={kind:"candidate",check:"citation-count",source:"functional.csv",expected:2};
  for(const sentence of [
    "本稿有2行带 functional.csv 的行号定位（第2、4等行）。",
    "本稿有2行带 functional.csv 的行号定位（第2、……、4行）。",
    "本稿有2行带 functional.csv 的行号定位（第4-2行）。",
    "本稿有2行带 functional.csv 的行号定位（第1-257行）。",
    "本稿有2行带 functional.csv 的行号定位，出处是来源的第2、4行。",
    "本稿有2行带 functional.csv 的行号定位（第2、4行及其他内容）。",
  ]) {
    const e=objectEnvironment(root,write,"[稿件自述] "+sentence+"\nfunctional.csv 第2行。\n无引用。\nfunctional.csv 第2行。\n");
    assert.throws(()=>e.put(check),error=>objectDiagnostic(error).category==="parameter");
    assert.equal(e.invoke("status").rejected.length,0);
  }
  const e=objectEnvironment(root,write,"- [稿件自述] 本稿带 functional.csv 行号定位的共2行，即第2、4行。\nfunctional.csv 第2行。\n无引用。\nfunctional.csv 第2行。\n");
  e.put(check);assert.equal(e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck.result.lineListMatches,true);
}));

test("marking requires an explicit positive universal action and cannot certify negative or count claims",async()=>fixture(async(root,write)=>{
  const check={kind:"candidate",check:"citations-marked",source:"functional.csv",marker:"[模拟]"};
  for(const sentence of [
    "本稿有2行带 functional.csv 的行号定位，[模拟]。",
    "本稿对 functional.csv 的引用未统一标[模拟]。",
    "本稿所有 functional.csv 引用行都没有[模拟]标记。",
    "本稿所有 functional.csv 引用行都含[模拟]标记之外的额外事实。",
    "本稿部分 functional.csv 引用行含[模拟]标记。",
  ]) {
    // None, some and all marked sets must not change the meaning of a negative
    // or unsupported clause into the positive universal predicate.
    for(const marked of [0,1,2]) {
      const e=objectEnvironment(root,write,"[稿件自述] "+sentence+"\n"+(marked>0?"[模拟] ":"")+"functional.csv 第2行。\n"+(marked>1?"[模拟] ":"")+"functional.csv 第2行。\n");
      assert.throws(()=>e.put(check),/完整正向全称/);assert.equal(e.invoke("status").rejected.length,0);
    }
  }
  for(const sentence of ["本稿所有 functional.csv 引用行都含[模拟]标记。","本稿引用 `functional.csv` 的每一行均标注为“[模拟]”。"]) {
    const e=objectEnvironment(root,write,"[稿件自述] "+sentence+"\n[模拟] functional.csv 第2行。\n[模拟] functional.csv 第2行。\n");
    e.put(check);assert.equal(e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck.result.matches,true);
  }
  const e=objectEnvironment(root,write,"[稿件自述] 本稿所有 functional.csv 引用行都含functional.csv标记。\nfunctional.csv 第2行。\n");
  assert.throws(()=>e.put({...check,marker:"functional.csv"}),/路径及其片段不能充当 marker/);
}));

test("a marker elsewhere in a citation line cannot support an explicit line-start assertion",async()=>fixture(async(root,write)=>{
  const claim="本稿所有 functional.csv 引用行都在行首标了[模拟]。", check={kind:"candidate",check:"citations-leading-marked",source:"functional.csv",marker:"[模拟]"};
  const body=tail=>"[稿件自述] "+claim+"\n- [模拟] functional.csv 第2行。\n"+tail+"\n";
  let e=objectEnvironment(root,write,body("functional.csv 第2行，注中出现[模拟]。"));
  assert.throws(()=>e.put({...check,check:"citations-marked"}),/明确标记位置/);
  assert.throws(()=>e.put(check),error=>{
    const diagnostic=objectDiagnostic(error);assert.equal(diagnostic.matches,false);assert.deepEqual(diagnostic.missingLines,[3]);return true;
  });
  e.put(check,{status:"unsupported",sourceRelation:"contradicts",finding:objectFinding("都在行首标了[模拟]")});
  assert.equal(e.invoke("status").rejected.length,1);
  e=objectEnvironment(root,write,body("[模拟] functional.csv 第2行。"));
  e.put(check);assert.equal(e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck.result.matches,true);
}));

test("a fully bound true candidate predicate cannot itself create unsupported author debt",async()=>fixture(async(root,write)=>{
  const body="[稿件自述] 本稿有2行带 functional.csv 的行号定位（第2、3行）。\nfunctional.csv 第2行。\nfunctional.csv 第2行。\n";
  let e=objectEnvironment(root,write,body),check={kind:"candidate",check:"citation-count",source:"functional.csv",expected:2};
  assert.throws(()=>e.put(check,{status:"unsupported",finding:{kind:"missing-evidence",quote:"本稿有2行",fix:"保留原文不变即可。"}}),/实测成立.*不能.*unsupported/);
  assert.equal(e.invoke("status").rejected.length,0);e.put(check);
  e=objectEnvironment(root,write,"[稿件自述] 本稿所有 functional.csv 引用行都含[模拟]标记。\n[模拟] functional.csv 第2行。\n");
  check={kind:"candidate",check:"citations-marked",source:"functional.csv",marker:"[模拟]"};
  assert.throws(()=>e.put(check,{status:"unsupported",finding:{kind:"missing-evidence",quote:"所有 functional.csv 引用行",fix:"该句无需修改。"}}),/实测成立/);
  // A separate actual suffix is still reviewable as its own factual assertion.
  const prefix="本稿所有 functional.csv 引用行都含[模拟]标记",suffix="，本例全部20项均通过。";
  e=objectEnvironment(root,write,prefix+suffix+"\n[模拟] functional.csv 第2行。\n");
  e.invoke("record",{entries:[{block:e.blocks[0].id,parts:[
    {kind:"direct",status:"supported",sourceRelation:"supports",basis:"逐行核对当前稿的字面标记。",quote:prefix,objectCheck:check},
    {kind:"direct",status:"unsupported",sourceRelation:"contradicts",basis:"当前原始CSV只有19项通过，总数20。",quote:suffix,evidence:[ref],finding:objectFinding("全部20项均通过")},
  ]}]});
  assert.equal(e.invoke("status").rejected.length,1);
}));

test("the unchanged paired seed marking claim measures false and still permits an actual author finding",async()=>fixture(async(root,write)=>{
  const original="[稿件自述] 本稿带 sources/synthetic.md 行号定位的每一行都带有 [模拟] 标记。\n";
  const body=original+"[模拟] 第一处 sources/synthetic.md 第2行。\n第二处 sources/synthetic.md 第2行。\n";
  const e=objectEnvironment(root,write,body,{sources:{"sources/synthetic.md":synthetic020834Z}});
  const check={kind:"candidate",check:"citations-marked",source:"sources/synthetic.md",marker:"[模拟]"};
  assert.throws(()=>e.put(check),error=>{
    const details=objectDiagnostic(error);assert.equal(details.matches,false);assert.deepEqual(details.missingLines,[3]);return true;
  });
  e.put(check,{status:"unsupported",finding:objectFinding("每一行都带有 [模拟] 标记")});
  const saved=e.invoke("status",{block:e.blocks[0].id}).record.parts[0].objectCheck;
  assert.equal(saved.result.matches,false);assert.equal(e.invoke("status").rejected.length,1);
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),body);
}));

test("old correctly bound positive candidate proofs remain readable while the historical path-marker bypass fails closed",async()=>fixture(async(root,write)=>{
  for(const [claim,check] of [
    ["本稿对 functional.csv 有2行可识别同行引用。",{kind:"candidate",check:"citation-count",source:"functional.csv",expected:2}],
    ["本稿所有 functional.csv 引用行都含[模拟]标记。",{kind:"candidate",check:"citations-marked",source:"functional.csv",marker:"[模拟]"}],
  ]) {
    const body="[稿件自述] "+claim+"\n[模拟] functional.csv 第2行。\n[模拟] functional.csv 第2行。\n";
    const e=objectEnvironment(root,write,body);e.put(check);
    const record=e.invoke("status",{block:e.blocks[0].id}).record,before=JSON.stringify(record);
    assert.doesNotThrow(()=>requireStoredObjectChecks(e.frame,e.spec,[{records:[record]}],Buffer.from(body)));
    assert.equal(JSON.stringify(record),before);assert.equal(record.parts[0].objectCheck.result.claimedLines,undefined);
  }
  const body="[稿件自述] 本稿有2行带 functional.csv 的行号定位。\nfunctional.csv 第2行。\nfunctional.csv 第2行。\n";
  const e=objectEnvironment(root,write,body),block=e.blocks[0];
  // Restore the previous host's exact stored field shape, without invoking the
  // newly guarded producer or rewriting the historical receipt in place.
  const legacy={quote:block.text,start:0,end:block.text.length,kind:"direct",status:"supported",sourceRelation:"supports",basis:"旧版把路径本身当标记。",
    objectCheck:{kind:"candidate",check:"citations-marked",source:"functional.csv",marker:"functional.csv",
      assertion:{line:block.line,start:block.start,end:block.end,quoteSha256:digest(block.text)},candidateSha256:digest(body),sources:[],
      result:{matches:true,actual:2,unit:"candidate-citation-lines",lines:[2,3],missingLines:[],missingCount:0}}};
  assert.throws(()=>requireStoredObjectChecks(e.frame,e.spec,[{records:[{block:block.id,parts:[legacy]}]}],Buffer.from(body)),/须重新核验/);
}));

// The final B16 from 023249Z was correct author text. A previous role's direct
// label forced the later reviewer to prove even the structural label as fact.
const advice023249Z="大白话：把完成状态、实际结果和证据能说明的范围分开看。";
test("023249Z B16 neutral advice cannot manufacture a factual union or require author rewriting",()=>{
  const full={block:"B16-34fd46e9",line:14,text:advice023249Z,parts:[{...fact,quote:advice023249Z,start:0,end:advice023249Z.length}]};
  const neutral={...full,parts:[{...nonfact,quote:advice023249Z,start:0,end:advice023249Z.length}]};
  assert.deepEqual(classificationDisagreements({records:[full]},{records:[neutral]}),[]);
  const oldDispute={block:full.block,line:14,text:advice023249Z,factualSpans:[[0,4],[4,10],[10,27]],requiredSpans:[[0,4],[4,10],[10,27]]};
  assert.equal(recordMeetsDispute(neutral,oldDispute),true);
  assert.equal(recordMeetsDispute({...neutral,parts:[]},oldDispute),false);
});

test("023249Z B16 accepts a bounded classification correction and rejects new direct author debt",async()=>fixture(async(root,write)=>{
  write("candidate.md",advice023249Z+"\n");const e=environment(root),block=e.invoke("inventory").blocks[0];
  e.active.reconciliation=[{block:block.id,text:block.text,requiredSpans:[[0,block.text.length]]}];
  e.invoke("record",{entries:[{block:block.id,parts:[nonfact]}]});
  assert.equal(e.finish().rejected.length,0);
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[fact]}]}),/中性.*nonfactual/);
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),advice023249Z+"\n");
}));

test("neutral recognition is limited to explicit structural labels and complete bare-concept directives",()=>{
  for(const text of ["大白话：","**直白说明：**","# 摘要","## **建议**",
    "- 直白说明：把事实与推测分开看。","请区分条件和结论。","建议把定义、对象及单位分开说明。",
    "把状态和结果区分清楚。","分清相关关系与因果关系。",advice023249Z]) {
    const ranges=neutralTextSpans(text);
    for(let i=0;i<text.length;i++)if(/[\p{L}\p{N}]/u.test(text[i]))assert.ok(ranges.some(row=>row.start<=i&&i<row.end),text+":"+i);
    const direct={block:"B1",text,parts:[{...fact,start:0,end:text.length}]},neutral={...direct,parts:[{...nonfact,start:0,end:text.length}]};
    assert.deepEqual(classificationDisagreements({records:[direct]},{records:[neutral]}),[]);
  }
  for(const text of ["# 当前项目已经完成","# 所有结论已证实","当前结果：","“大白话：把事实与推测分开看。”","> 大白话：全部完成。"])
    assert.deepEqual(neutralTextSpans(text),[],text);
});

test("seventh paid [补充] reconciliation neutralizes only the leading layout label",()=>{
  const prefix="- [补充] ";
  const assertion="sources/github-checks.md 第 6 行称 completed 状态下 conclusion 可为下列任一值，第 7 行为 failure、第 8 行为 success，即至少列出 failure 与 success 两个不同取值，故 completed 下 conclusion 不唯一。";
  const text=prefix+assertion;
  assert.deepEqual(neutralTextSpans(text),[{start:0,end:prefix.length,kind:"structural-label",rule:"explicit-label-v1"}]);
  for(const decoration of ["","* ","+ ","1. ","## "]){
    const leading=decoration+"[补充] ";
    assert.deepEqual(neutralTextSpans(leading+assertion).map(({start,end})=>[start,end]),[[0,leading.length]]);
  }
  const full={block:"B15-32847e16",text,parts:[{...fact,start:0,end:text.length}]};
  const split={...full,parts:[{...nonfact,start:0,end:prefix.length},{...fact,start:prefix.length,end:text.length}]};
  assert.deepEqual(classificationDisagreements({records:[full]},{records:[split]}),[]);
  const omitted={...full,parts:[{...nonfact,start:0,end:text.length}]};
  const [dispute]=classificationDisagreements({records:[full]},{records:[omitted]});
  assert.ok(dispute.requiredSpans.every(([start])=>start>=prefix.length));
  assert.equal(recordMeetsDispute(omitted,dispute),false);
  for(const inline of ["正文 [补充] ","- [[补充]] ","- “[补充]” ","- [说明 [补充]] ","- 补充："]){
    assert.deepEqual(neutralTextSpans(inline+assertion),[],inline);
  }
  const [marked,next]=documentCoverage(Buffer.from(prefix+"示例有两项；所有结论已核实。\n")).blocks;
  assert.equal(marked.neutralSpans[0].end,prefix.length);assert.equal(next.neutralSpans,undefined);
});

test("unknown modifiers, source-dependent advice, numeric assertions and appended tails never become host neutral",async()=>fixture(async(root,write)=>{
  const cases=[
    "请把已经证明有效的方法和无效方法分开看。",
    "把完成状态、实际结果和成功率100%的结论分开看。",
    "大白话：把状态和结果分开看，但是24ms就是24%。",
    "大白话：完成状态不保证成功。",
    "建议把状态和结果分开看，因为结果全部成功。",
    "只有把事实和推测分开看才能保证成功。",
    "把研究A和研究B分开看。",
    "把状态和结果分开看，适用于所有研究。",
    "建议：所有项目均已完成。",
  ];
  for(const text of cases) {
    assert.equal(neutralTextSpans(text).some(row=>row.kind==="directive"),false,text);
    const direct={block:"B1",text,parts:[{...fact,start:0,end:text.length}]},neutral={...direct,parts:[{...nonfact,start:0,end:text.length}]};
    const disputes=classificationDisagreements({records:[direct]},{records:[neutral]});assert.equal(disputes.length,1,text);
    assert.equal(recordMeetsDispute(neutral,disputes[0]),false,text);
    write("candidate.md",text+"\n");const e=environment(root),block=e.invoke("inventory").blocks[0];
    e.active.reconciliation=[{...disputes[0],block:block.id}];
    assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[nonfact]}]}),/事实分类争议尚未逐项落实/);
  }
  assert.deepEqual(neutralTextSpans(cases[2]).map(({start,end,kind})=>({start,end,kind})),[{start:0,end:4,kind:"structural-label"}]);
  // Sentence splitting never extends a safe prefix over another actual block.
  const blocks=documentCoverage(Buffer.from("大白话：把状态和结果分开看；所有20项均通过。\n")).blocks;
  assert.equal(blocks.length,2);assert.equal(blocks[1].text,"所有20项均通过。");assert.equal(blocks[1].neutralSpans,undefined);
}));

test("a structural label is neutral while its factual explanation still needs actual proof",async()=>fixture(async(root,write)=>{
  const label="大白话：",tail="本样例通过19/20。",text=label+tail;
  write("candidate.md",text+"\n");const e=environment(root),block=e.invoke("inventory").blocks[0];
  assert.deepEqual(block.neutralSpans.map(({start,end,kind})=>({start,end,kind})),[{start:0,end:label.length,kind:"structural-label"}]);
  e.invoke("record",{entries:[{block:block.id,parts:[fact]}]});const whole=e.finish();
  e.invoke("record",{entries:[{block:block.id,parts:[{...nonfact,quote:label},{...fact,quote:tail}]}]});
  assert.deepEqual(classificationDisagreements(whole,e.finish()),[]);
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[{...fact,quote:label},{...fact,quote:tail}]}]}),/中性.*nonfactual/);
  const neutral={block:block.id,text,neutralSpans:[{start:0,end:text.length,kind:"directive"}],parts:[{...nonfact,start:0,end:text.length}]};
  // A model/old receipt cannot make the factual tail neutral by supplying ranges.
  const disputed=classificationDisagreements(whole,{records:[neutral]})[0];
  assert.ok(disputed.requiredSpans.every(([start])=>start>=label.length));assert.equal(recordMeetsDispute(neutral,disputed),false);
}));

test("inventory exposes bounded host ranges without automatically completing neutral blocks",async()=>fixture(async(root,write)=>{
  write("candidate.md",advice023249Z+"\n");const e=environment(root),inventory=e.invoke("inventory"),block=inventory.blocks[0];
  assert.equal(inventory.classificationVersion,CLASSIFICATION_VERSION);
  assert.deepEqual(block.neutralSpans.map(row=>row.kind),["structural-label","directive"]);
  assert.throws(e.finish,/未核块/);assert.equal(inventory.pendingCount,1);
  e.invoke("record",{entries:[{block:block.id,parts:[nonfact]}]});assert.equal(e.finish().rejected.length,0);
}));

function scopeEnvironment(root,write,body,{pinned=true,kind="synthetic",source="# 模拟数据\nstatus=completed，conclusion=failure。\n"}={}) {
  const p=structuredClone(policy);p.units.K01.claims=[];p.units.K01.calculations={};
  if(pinned)p.sourcePins={"functional.csv":{kind,locator:kind==="synthetic"?"synthetic:scope-test":"https://example.test/real",sha256:digest(source)}};
  write("functional.csv",source);write("candidate.md",body);write("BUILDING-LOOP.json",JSON.stringify(p));
  const e=environment(root),block=e.invoke("inventory").blocks[0];
  const scopeRef={file:"functional.csv",start:2,end:2,quote:"status=completed，conclusion=failure。"};
  const direct={...fact,evidence:[scopeRef]};
  const put=(parts)=>e.invoke("record",{entries:[{block:block.id,parts}]});
  return {...e,block,direct,put};
}

test("030757Z leading simulation scope cannot be nonfactual and the body keeps its independent proof",async()=>fixture(async(root,write)=>{
  const text="[模拟] 完成状态与实际结论是两个字段（出处：functional.csv 第2行）。\n";
  const e=scopeEnvironment(root,write,text),marker="[模拟] ",tail=e.block.text.slice(marker.length);
  assert.deepEqual(e.block.scopeMarkers,[{start:0,end:4,kind:"synthetic",label:"[模拟]"}]);assert.equal(e.block.neutralSpans,undefined);
  assert.throws(()=>e.put([{...nonfact,quote:marker},{...e.direct,quote:tail}]),error=>{
    assert.match(error.message,/scope-marker/);assert.match(error.message,/"kind":"direct"/);assert.match(error.message,/不能.*nonfactual/);return true;
  });
  e.put([{...e.direct,quote:marker},{...e.direct,quote:tail}]);assert.equal(e.finish().rejected.length,0);
  assert.throws(()=>e.put([{...e.direct,quote:marker},{...e.direct,quote:tail,evidence:[]}]),/直接事实须给 evidence/);
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),text);
}));

test("simulation scope is bound to the same authorized source and does not promote real or unknown material",async()=>fixture(async(root,write)=>{
  const text="[模拟] 完成状态与实际结论是两个字段（出处：functional.csv 第2行）。\n";
  let e=scopeEnvironment(root,write,text);assert.throws(()=>e.put([{...e.direct,evidence:[{file:"timing.csv",start:2,end:2,quote:"before,120"}]}]),/同源.*合成范围证明/);
  e=scopeEnvironment(root,write,text,{kind:"primary"});assert.throws(()=>e.put([e.direct]),/未知范围不能自动算模拟/);
  e.put([{kind:"direct",status:"unsupported",sourceRelation:"insufficient",basis:"当前资料尚无足够依据支持其模拟范围声明。",finding:{kind:"missing-evidence",quote:"[模拟]",fix:"核实这份实际来源的范围属性，不能凭标签假设其为模拟数据。"}}]);
  assert.equal(e.finish().rejected.length,1);
  // Primary is provenance, not a claim that every dataset is a real observation.
  e.put([{...e.direct,quote:"[模拟] ",evidence:[{file:"functional.csv",start:1,end:1,quote:"# 模拟数据"}]},{...e.direct,quote:e.block.text.slice(5)}]);
  assert.equal(e.finish().rejected.length,0);
  e=scopeEnvironment(root,write,text,{pinned:false});assert.throws(()=>e.put([e.direct]),/明确合成声明/);
  e.put([{...e.direct,quote:"[模拟] ",evidence:[{file:"functional.csv",start:1,end:1,quote:"# 模拟数据"}]},{...e.direct,quote:e.block.text.slice(5)}]);
  assert.equal(e.finish().rejected.length,0);
}));

test("032313Z object annotation is neutral, while the full citation-count assertion remains mandatory",async()=>fixture(async(root,write)=>{
  const label="- [稿件自述]", claim=" 本稿有 2 行带 functional.csv 的行号定位。";
  const e=objectEnvironment(root,write,label+claim+"\nfunctional.csv 第2行。\nfunctional.csv 第2行。\n");
  const block=e.blocks[0],check={kind:"candidate",check:"citation-count",source:"functional.csv",expected:2};
  const marked={kind:"direct",status:"supported",sourceRelation:"supports",basis:"以实际稿件的授权来源行数做对象复核。",objectCheck:check};
  e.invoke("record",{entries:[{block:block.id,parts:[marked]}]});
  const full=e.invoke("status",{block:block.id}).record;
  e.invoke("record",{entries:[{block:block.id,parts:[{...nonfact,quote:label},{...marked,quote:claim}]}]});
  const split=e.invoke("status",{block:block.id}).record;
  assert.deepEqual(classificationDisagreements({records:[full]},{records:[split]}),[]);
  assert.equal(recordMeetsDispute(split,{text:block.text,requiredSpans:[[3,block.text.length]]}),true);
  assert.throws(()=>e.invoke("record",{entries:[{block:block.id,parts:[nonfact]}]}),/不能全部 nonfactual/);
}));

test("a following coverage block's source cannot change the simulation marker's source",async()=>fixture(async(root,write)=>{
  const body="[模拟] 本例结论为 failure（出处：functional.csv 第2行；timing.csv 第2行）。\n";
  const e=scopeEnvironment(root,write,body),[simulation,locator]=e.invoke("inventory").blocks;
  assert.match(simulation.text,/functional.csv/);assert.match(locator.text,/timing.csv/);
  e.put([e.direct]);
  e.invoke("record",{entries:[{block:locator.id,parts:[nonfact]}]});
  assert.equal(e.finish().rejected.length,0);
}));

test("sixth paid mixed-locator simulation row returns to the author instead of retrying proof parameters",async()=>fixture(async(root,write)=>{
  const line="[模拟] 记录 A 的 status 为 completed，conclusion 为 failure；由 status=completed 推出 conclusion 必定成功不成立（出处：sources/synthetic.md 第 2 行；sources/github-checks.md 第 6-8 行）。";
  enumerationEnvironment(root,write,line+"\n");
  const policyPath=path.join(root,"BUILDING-LOOP.json"),p=JSON.parse(fs.readFileSync(policyPath));
  const file="sources/synthetic.md",scope="# 合成逻辑样例；不是外部研究、生产日志或真实效果数据",value="记录 A：status=completed，conclusion=failure。";
  const source=scope+"\n"+value+"\n";write(file,source);
  p.sourcePins[file]={kind:"synthetic",locator:"synthetic:scope-test",sha256:digest(source)};
  for(const phase of ["first-review","final-review"]){p.units.K01.phases[phase].read.push(file);p.units.K01.phases[phase].evidence.push(file);}
  p.units.K01.phases.supplement.read.push(file);
  write("BUILDING-LOOP.json",JSON.stringify(p));
  let e=environment(root),[block]=e.invoke("inventory").blocks;
  const author=(text,reads=e.spec.phases.supplement.read)=>simulationScopeLocatorIssues({...e.frame,role:"executor",reads},
    {...e.active,phase:"supplement"},e.spec,Buffer.from(text+"\n"));
  const [issue]=author(line);
  assert.deepEqual([issue.code,issue.block,issue.line],["ambiguous",block.id,1]);
  assert.match(issue.issue,/实际陈述块内标明唯一合成来源/);
  const marker={...fact,quote:"[模拟]",evidence:[{file,start:1,end:1,quote:scope}]};
  const sentence={...fact,quote:block.text.slice(5),evidence:[{file,start:2,end:2,quote:value}]};
  const put=parts=>e.invoke("record",{entries:[{block:block.id,parts}]});
  assert.throws(()=>put([marker,sentence]),/稿件来源归属问题.*重填 supported 参数无法解决.*finding.kind=scope/);
  const returned=put([{kind:"direct",status:"unsupported",sourceRelation:"insufficient",basis:"模拟陈述块未单独定位合成来源，同行引用两份不同材料。",
    finding:{kind:"scope",quote:block.text,fix:"在记录 A 这块内引用 synthetic.md 第 2 行，将官方对照另起一行。"}}]);
  assert.equal(returned.rejected[0].finding.kind,"scope");
  assert.equal(returned.rejected[0].finding.quote,block.text);
  const local=line.replace("failure；","failure（出处：sources/synthetic.md 第 2 行）；")
    .replace("（出处：sources/synthetic.md 第 2 行；sources/github-checks.md","（出处：sources/github-checks.md");
  const fallback=line.replace("；sources/github-checks.md 第 6-8 行","");
  assert.deepEqual(author(local),[]);assert.deepEqual(author(fallback),[]);
  assert.deepEqual(author(local,e.spec.phases.supplement.read.filter(item=>item!==file&&item!==enumerationSource)).map(row=>row.code),["missing"]);
  write("candidate.md",local+"\n");e=environment(root);[block]=e.invoke("inventory").blocks;
  assert.deepEqual(put([marker,{...sentence,quote:block.text.slice(5)}]).recorded,[block.id]);
}));

test("scope provenance changes and old nonfactual receipts invalidate through the shared source and closure gates",async()=>fixture(async(root,write)=>{
  const body="[模拟] 完成状态与实际结论是两个字段（出处：functional.csv 第2行）。\n",e=scopeEnvironment(root,write,body);
  e.put([e.direct]);const coverage=e.finish();
  assert.doesNotThrow(()=>requireStoredObjectChecks(e.frame,e.spec,[coverage],Buffer.from(body)));
  const old=structuredClone(coverage);old.records[0].parts=[{...nonfact,quote:e.block.text,start:0,end:e.block.text.length}];
  assert.throws(()=>requireStoredObjectChecks(e.frame,e.spec,[old],Buffer.from(body)),/须重新核验/);
  e.active.coverage.records[e.block.id]=old.records[0];assert.equal(e.invoke("inventory").invalidatedCount,1);
  e.put([e.direct]);e.frame.policy.sourcePins[keyOf("functional.csv")].kind="primary";
  assert.throws(()=>requireStoredObjectChecks(e.frame,e.spec,[coverage],Buffer.from(body)),/须重新核验/);
  assert.equal(e.invoke("inventory").invalidatedCount,1);
}));

test("only a true leading simulation marker is handled; other tags and example or numbered internals stay unchanged",()=>{
  for(const text of ["[模拟] 正文。","- [模拟] 正文。","## [模拟] 正文。","1. [模拟] 正文。"])
    assert.equal(documentCoverage(Buffer.from(text)).blocks[0].scopeMarkers?.[0]?.label,"[模拟]",text);
  for(const text of ["[实测] 正文。","[稿件自述] 本稿标记为[模拟]。","C3：[模拟] 正文。","错例：[模拟] 正文。","[错例] [模拟] 正文。","不是[模拟]。"])
    assert.equal(documentCoverage(Buffer.from(text)).blocks[0].scopeMarkers,undefined,text);
});
