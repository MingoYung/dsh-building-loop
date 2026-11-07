import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fixture,host,policy} from "./helpers.mjs";
import {authority} from "../governance/policy.mjs";
import {QUALITY,plainLastIssues} from "../governance/preflight.mjs";

const source={file:"functional.csv",start:2,end:2,quote:"19,20"};
const fact={kind:"direct",status:"supported",sourceRelation:"supports",basis:"只转述这个已列样例的通过数与总数。",evidence:[source]};
const nonfact={kind:"nonfactual",status:"supported",basis:"这是文档结构或阅读建议，没有提出额外外部事实。"};
const checks=[{id:"C1",status:"supported",file:source.file,start:2,end:2,basis:"源记录明确写明通过19项，总数20项。"}];
const quality=()=>({...Object.fromEntries(Object.keys(QUALITY).map(k=>[k,"本例只转述授权数据，保持范围并给出读者说明。"])),
  sourceRefs:[source],unverifiedSources:[],unlisted:[],revise:[],goalFit:{pass:true,basis:"符合当前只核本例记录的交付目标。"}});

/** Keep source/format fixtures small enough to expose mechanical regressions. */
function single(write,{plainLast=false,body="# 摘要\n- C1：通过19/20（出处：functional.csv 第 2 行）。\n"}={}) {
  const p=structuredClone(policy);p.units.K01.claims=["C1"];p.units.K01.calculations={};p.units.K01.plainLast=plainLast;
  write("BUILDING-LOOP.json",JSON.stringify(p));write("candidate.md",body);
}

async function reviewStage(h) {
  const executor=(await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");await h.flow(executor,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  return {executor,reviewer};
}

test("role-visible tools shrink while runtime guards and successful turn conclusion remain",async()=>fixture(async(root,write)=>{
  single(write);const h=host(root,{automaticCoverage:false});
  assert.deepEqual(h.visible("root").sort(),["building_loop","building_loop_file","building_loop_ledger"].sort());
  assert.ok(h.restriction("root"),"admission must restrict before the first prompt snapshot");
  h.prompt("root");assert.ok(!h.restriction("root").allow.includes("read"));
  assert.match(h.guard("root","read"),/denied/);
  const executor=(await h.flow("root","advance")).childId;
  assert.deepEqual(h.visible(executor).sort(),["building_loop","building_loop_file"].sort());
  await assert.rejects(h.flow(executor,"submit"),/完整读回/);assert.deepEqual(h.concluded,[]);
  await h.flow(executor,"prepare");await h.flow(executor,"submit");
  assert.deepEqual(h.concluded,[executor]);assert.deepEqual(h.visible(executor),[]);
  const reviewer=(await h.flow("root","advance")).childId;
  assert.ok(h.visible(reviewer).includes("building_loop_coverage"));assert.ok(!h.visible(reviewer).includes("building_loop_ledger"));
  await assert.rejects(h.coverage("root","inventory"),/总控无正文/);
}));

test("prepare returns actual authorized lines, records their versions and reuses only those reads",async()=>fixture(async(root,write)=>{
  single(write);const h=host(root,{automaticCoverage:false});
  const central=await h.flow("root","prepare");
  assert.ok(!central.files.some(f=>f.path==="candidate.md"||f.path==="functional.csv"));
  const {reviewer}=await reviewStage(h);const packet=await h.flow(reviewer,"prepare");
  assert.ok(packet.files.some(f=>f.path==="functional.csv"&&f.lines.some(([n,text])=>n===2&&text==="19,20")));
  assert.equal(packet.coverage.total,2);assert.equal(packet.complete,true);
  assert.equal((await h.flow(reviewer,"prepare")).files.length,0);
  await h.coverage(reviewer,"record",{entries:packet.coverage.blocks.map((b,i)=>({block:b.id,parts:[i?fact:nonfact]}))});
  write("functional.csv","passed,total\n19,20\nnew version\n");
  const changed=await h.flow(reviewer,"prepare");assert.deepEqual(changed.files.map(f=>f.path),["functional.csv"]);
  assert.equal(changed.coverage.invalidated.length,1);
  assert.deepEqual((await h.coverage(reviewer,"status")).pending,[packet.coverage.blocks[1].id]);
  await assert.rejects(h.flow(reviewer,"review",{checks}),/未核块/);
}));

test("prepare pagination never stamps undisclosed lines as read",async()=>fixture(async(root,write)=>{
  single(write,{body:Array.from({length:402},(_,i)=>"第"+(i+1)+"行").join("\n")});
  const h=host(root,{automaticCoverage:false});const executor=(await h.flow("root","advance")).childId;
  const a=await h.flow(executor,"prepare");const candidate=a.files.find(f=>f.path==="candidate.md");
  assert.equal(candidate.lines.length,250);assert.equal(a.complete,false);
  await assert.rejects(h.flow(executor,"submit"),/完整读回/);
  const b=await h.flow(executor,"prepare");assert.equal(b.files.find(f=>f.path==="candidate.md").lines[0][0],251);
  assert.equal(b.complete,true);assert.equal((await h.flow(executor,"submit")).phase,"review-ready");
}));

test("prepare shows up to twenty-four blocks and pending IDs cannot authorize unseen block judgments",async()=>fixture(async(root,write)=>{
  single(write,{body:Array.from({length:27},(_,i)=>"# 结构分块"+(i+1)).join("\n")});
  const h=host(root,{automaticCoverage:false});const {reviewer}=await reviewStage(h);
  const packet=await h.flow(reviewer,"prepare");assert.equal(packet.coverage.blocks.length,24);
  assert.equal(packet.coverage.pendingCount,27);assert.equal(packet.coverage.next.offset,24);
  const hidden=(await h.coverage(reviewer,"status")).pending[24];
  await assert.rejects(h.coverage(reviewer,"record",{entries:[{block:hidden,parts:[nonfact]}]}),/尚未由本会话本阶段/);
  const page=await h.coverage(reviewer,"inventory",{offset:24,count:3});assert.equal(page.blocks.length,3);
  assert.deepEqual((await h.coverage(reviewer,"record",{entries:[{block:hidden,parts:[nonfact]}]})).recorded,[hidden]);
}));

test("the prepare byte budget never marks an omitted long block as presented",async()=>fixture(async(root,write)=>{
  single(write,{body:"# 结构标题\n"+"长".repeat(7000)+"\n"});
  const h=host(root,{automaticCoverage:false});const {reviewer}=await reviewStage(h);
  const packet=await h.flow(reviewer,"prepare");assert.equal(packet.complete,true);
  assert.equal(packet.coverage.blocks.length,1);assert.ok(Buffer.byteLength(JSON.stringify(packet.coverage))<=16*1024);
  assert.equal(packet.coverage.next.offset,1);
  const hidden=(await h.coverage(reviewer,"status")).pending[1];
  await assert.rejects(h.coverage(reviewer,"record",{entries:[{block:hidden,parts:[nonfact]}]}),/尚未由本会话本阶段/);
  const page=await h.coverage(reviewer,"inventory",{offset:1,count:1});assert.equal(page.blocks[0].text.length,7000);
  assert.deepEqual((await h.coverage(reviewer,"record",{entries:[{block:hidden,parts:[nonfact]}]})).recorded,[hidden]);
}));

test("interrupted same-phase session keeps version-valid reads; changed source still returns",async()=>fixture(async(root,write)=>{
  single(write);const h=host(root,{automaticCoverage:false});const {reviewer}=await reviewStage(h);
  await h.flow(reviewer,"prepare");h.interrupt(reviewer);
  assert.equal((await h.flow("root","advance")).childId,reviewer);
  assert.equal((await h.flow(reviewer,"prepare")).files.length,0);
  write("functional.csv","passed,total\n18,20\n");
  const changed=await h.flow(reviewer,"prepare");assert.deepEqual(changed.files.map(f=>f.path),["functional.csv"]);
}));

test("partial proof records preserve valid blocks, expose failed ones, and status does not duplicate the proof",async()=>fixture(async(root,write)=>{
  single(write);const h=host(root,{automaticCoverage:false});const {reviewer}=await reviewStage(h);
  const packet=await h.flow(reviewer,"prepare");const [title,claim]=packet.coverage.blocks;
  const result=await h.coverage(reviewer,"record",{entries:[{block:title.id,parts:[nonfact]},
    {block:claim.id,parts:[{...fact,evidence:[{...source,quote:"invented"}]}]}]});
  assert.deepEqual(result.recorded,[title.id]);assert.deepEqual(result.pending,[claim.id]);assert.equal(result.invalid[0].block,claim.id);
  const status=await h.coverage(reviewer,"status");assert.equal(status.records,undefined);assert.equal(status.record,undefined);
  assert.equal((await h.coverage(reviewer,"status",{block:title.id})).record.block,title.id);
  await assert.rejects(h.flow(reviewer,"review",{checks}),/未核块/);
  await h.coverage(reviewer,"record",{entries:[{block:claim.id,parts:[fact]}]});
  assert.deepEqual((await h.coverage(reviewer,"status")).pending,[]);
}));

test("a wholly invalid replacement retires old persisted proof before reporting its error",async()=>fixture(async(root,write)=>{
  single(write);const h=host(root,{automaticCoverage:false});const {reviewer}=await reviewStage(h);
  const packet=await h.flow(reviewer,"prepare");const [title,claim]=packet.coverage.blocks;
  await h.coverage(reviewer,"record",{entries:[{block:title.id,parts:[nonfact]},{block:claim.id,parts:[fact]}]});
  assert.deepEqual((await h.coverage(reviewer,"status")).pending,[]);
  await assert.rejects(h.coverage(reviewer,"record",{entries:[{block:claim.id,parts:[{...fact,evidence:[{...source,quote:"invented"}]}]}]}),/逐字/);
  assert.deepEqual((await h.coverage(reviewer,"status")).pending,[claim.id]);
  await assert.rejects(h.flow(reviewer,"review",{checks}),/未核块/);
}));

test("a persisted child result with failed parent notification does not conclude the turn",async()=>fixture(async(root,write)=>{
  single(write);const h=host(root,{automaticCoverage:false,failNotifications:true});
  const executor=(await h.flow("root","advance")).childId;await h.flow(executor,"prepare");
  const result=await h.flow(executor,"submit");assert.equal(result.notified,false);
  assert.equal(result.phase,"review-ready");assert.deepEqual(h.concluded,[]);
  assert.equal((await h.flow("root","status")).units[0].phase,"review-ready");
}));

test("more than twelve stale shared-source proofs can be replaced incrementally without accepting the remaining old block",async()=>fixture(async(root,write)=>{
  single(write,{body:Array.from({length:13},(_,i)=>i===0
    ? "- C1：通过19/20（出处：functional.csv 第 2 行）。"
    : "记录转述：通过19/20（出处：functional.csv 第 2 行）。").join("\n")});
  const h=host(root,{automaticCoverage:false});const {reviewer}=await reviewStage(h);
  await h.flow(reviewer,"prepare");
  const inventory=await h.coverage(reviewer,"inventory",{count:24});assert.equal(inventory.total,13);
  const entries=inventory.blocks.map(block=>({block:block.id,parts:[fact]}));
  await h.coverage(reviewer,"record",{entries:entries.slice(0,12)});await h.coverage(reviewer,"record",{entries:entries.slice(12)});
  assert.deepEqual((await h.coverage(reviewer,"status")).pending,[]);
  write("functional.csv","passed,total\n19,20\nchanged source version\n");await h.file(reviewer,"read","functional.csv");
  const repaired=await h.coverage(reviewer,"record",{entries:entries.slice(0,12)});
  assert.equal(repaired.invalidated.length,13);assert.equal(repaired.recorded.length,12);
  assert.deepEqual(repaired.pending,[entries[12].block]);
  await assert.rejects(h.flow(reviewer,"review",{checks}),/未核块/);
  const final=await h.coverage(reviewer,"record",{entries:entries.slice(12)});assert.deepEqual(final.pending,[]);
  await h.assess(reviewer,quality());assert.equal((await h.flow(reviewer,"review",{checks})).phase,"first-audit-ready");
}));

test("plain-language closing rejects appended examples including Markdown bullets",()=>{
  const check=body=>plainLastIssues({plainLast:true},body.split("\n"));
  assert.deepEqual(check("正文\n\n大白话：完成和成功要分开看。"),[]);
  assert.deepEqual(check("正文\n\n## 大白话\n\n完成和成功要分开看。"),[]);
  assert.deepEqual(check("正文\n\n**大白话：** 看实际结果。"),[]);
  assert.deepEqual(check("正文\n\n## **大白话**\n\n看实际结果。"),[]);
  for(const tail of ["\n\n错例：完成就是成功。","\n- 错例：完成就是成功。","\n1. 误读：完成就是成功。",
    "\n- [错例] 完成就是成功。","\n- **错例：** 完成就是成功。","\n**[错例]** 完成就是成功。",
    "\n### 附录","\n[^1]: another source","\n<div>附录内容</div>","\n| 附录 | 内容 |","\n- 新加一项内容"]) {
    assert.equal(check("大白话：看实际结果。"+tail).length,1,tail);
  }
  assert.equal(check("只有正文，没有收尾说明").length,1);
  assert.deepEqual(plainLastIssues({plainLast:false},["machine-only output"]),[]);
});

test("plainLast defaults on and cannot pass by a model saying quality is supported",async()=>fixture(async(root,write)=>{
  single(write,{plainLast:true,body:"- C1：通过19/20（出处：functional.csv 第 2 行）。\n\n大白话：按记录看结果。\n\n附录文字。\n"});
  assert.equal(authority(root).units.K01.plainLast,true);
  const h=host(root);const {reviewer}=await reviewStage(h);await h.flow(reviewer,"prepare");await h.assess(reviewer,quality());
  const result=await h.flow(reviewer,"review",{checks});assert.equal(result.phase,"supplement-ready");assert.deepEqual(result.qualityRejected,["plain"]);
  const executor=(await h.flow("root","advance")).childId;await h.flow(executor,"prepare");
  assert.equal((await h.flow(executor,"preflight")).ok,false);
  await h.file(executor,"write","candidate.md",{content:"- C1：通过19/20（出处：functional.csv 第 2 行）。\n\n附录文字。\n\n大白话：按记录看结果。\n",note:"将解释放在最后，保留正确正文。"});
  await h.flow(executor,"prepare");assert.equal((await h.flow(executor,"preflight")).ok,true);
}));

test("blind auditor has a different method, cannot read first verdict, and still covers every block",async()=>fixture(async(root,write)=>{
  single(write);const h=host(root,{automaticCoverage:false});const {reviewer}=await reviewStage(h);const packet=await h.flow(reviewer,"prepare");
  await h.coverage(reviewer,"record",{entries:packet.coverage.blocks.map((b,i)=>({block:b.id,parts:[i?fact:nonfact]}))});
  await h.assess(reviewer,quality());await h.flow(reviewer,"review",{checks});
  const auditor=(await h.flow("root","advance")).childId;
  assert.match(h.prompt(auditor),/反证路线/);assert.doesNotMatch(h.prompt(reviewer),/反证路线/);
  const material=await h.flow(auditor,"prepare");assert.ok(!material.files.some(f=>f.path==="first.json"));
  assert.deepEqual(material.contract.finalSubmission,{action:"audit"});assert.match(h.prompt(auditor),/不要重复发送 checks/);
  await assert.rejects(h.file(auditor,"read","first.json"),/白名单/);
  await assert.rejects(h.flow(auditor,"audit"),/未核块/);
  assert.ok(!h.visible(auditor).includes("building_loop_quality"));
}));

/** Create a real classifier disagreement after both roles have fully reviewed. */
async function classificationLoop(root,write,{deliverAudit=true,instructions=false}={}) {
  single(write,{body:"# 说明\n- C1：通过19/20（出处：functional.csv 第 2 行）。\n本例记录通过19项，总计20项（出处：functional.csv 第 2 行）。\n"});
  if(instructions) {
    const p=JSON.parse(fs.readFileSync(path.join(root,"BUILDING-LOOP.json"),"utf8"));
    p.instructions=["rules.md"];p.coordinator.read.push("rules.md");write("rules.md","按当前样例核验。\n");
    write("BUILDING-LOOP.json",JSON.stringify(p));
  }
  const h=host(root,{automaticCoverage:false}),{reviewer}=await reviewStage(h);
  const first=await h.flow(reviewer,"prepare");
  const [title,claim,disputed]=first.coverage.blocks;
  await h.coverage(reviewer,"record",{entries:[{block:title.id,parts:[{...nonfact,basis:"首审自身检查的文档结构标题。"}]},
    {block:claim.id,parts:[fact]},{block:disputed.id,parts:[nonfact]}]});
  await h.assess(reviewer,quality());await h.flow(reviewer,"review",{checks});
  const auditor=(await h.flow("root","advance")).childId;
  await h.flow(auditor,"prepare");
  await h.coverage(auditor,"record",{entries:[{block:title.id,parts:[{...nonfact,basis:"独立反证自身检查的标题结构。"}]},
    {block:claim.id,parts:[fact]},{block:disputed.id,parts:[fact]}]});
  if(deliverAudit)assert.equal((await h.flow(auditor,"audit")).phase,"review-ready");
  return {h,reviewer,auditor,title,claim,disputed};
}

test("classification disputes require factual proof and restore only each role's own unaffected records",async()=>fixture(async(root,write)=>{
  const {h,reviewer,auditor,title,disputed}=await classificationLoop(root,write);
  const original=fs.readFileSync(path.join(root,"candidate.md"),"utf8");
  const status=await h.flow("root","status"),notice=status.units[0];
  assert.equal(notice.reason,"classification-reconciliation");assert.equal(notice.disputeCount,1);
  assert.equal(notice.nextRole,"reviewer");assert.equal(notice.nextPhase,"first-review");
  assert.match(notice.reasonNote,/正常重核流程/);
  assert.doesNotMatch(JSON.stringify(status),/本例记录通过|Checkpoint|首审自身|独立反证自身/);
  assert.equal((await h.flow("root","prepare")).reason,"classification-reconciliation");
  assert.match(JSON.stringify(h.notifications.at(-1)),/classification-reconciliation/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,"first.json"),"utf8"),/Checkpoint|首审自身/);
  assert.equal((await h.flow("root","advance")).childId,reviewer);
  const resumed=await h.flow(reviewer,"prepare");assert.deepEqual(resumed.files,[]);
  assert.deepEqual(resumed.coverage.pending,[disputed.id]);assert.equal(resumed.reconciliation.length,1);
  assert.match((await h.coverage(reviewer,"status",{block:title.id})).record.parts[0].basis,/首审自身/);
  await assert.rejects(h.coverage(reviewer,"record",{entries:[{block:disputed.id,parts:[nonfact]}]}),/reconciliation/);
  await assert.rejects(h.flow(reviewer,"review",{checks}),/未核块/);
  await h.coverage(reviewer,"record",{entries:[{block:disputed.id,parts:[fact]}]});
  // The unchanged, version-bound quality assessment is also this same reviewer's.
  await h.flow(reviewer,"review",{checks});
  assert.equal((await h.flow("root","advance")).childId,auditor);
  const second=await h.flow(auditor,"prepare");assert.deepEqual(second.files,[]);assert.deepEqual(second.coverage.pending,[disputed.id]);
  assert.match((await h.coverage(auditor,"status",{block:title.id})).record.parts[0].basis,/独立反证自身/);
  await assert.rejects(h.coverage(auditor,"record",{entries:[{block:disputed.id,parts:[nonfact]}]}),/reconciliation/);
  await h.coverage(auditor,"record",{entries:[{block:disputed.id,parts:[fact]}]});
  const accepted=await h.flow(auditor,"audit");assert.equal(accepted.phase,"ledger-review");assert.equal(accepted.reason,undefined);
  assert.equal((await h.flow("root","status")).units[0].reason,undefined);
  assert.equal((await h.flow("root","prepare")).reason,undefined);
  assert.doesNotMatch(JSON.stringify(h.notifications.at(-1)),/classification-reconciliation/);
  assert.match(h.prompt("root"),/全文块数不是行数/);
  assert.equal(fs.readFileSync(path.join(root,"candidate.md"),"utf8"),original);
}));

test("changed candidate, goal, source or instructions retire reconciliation checkpoints before reuse",async()=>{
  for(const change of ["candidate","goal","source","instructions"])await fixture(async(root,write)=>{
    const {h,reviewer}=await classificationLoop(root,write,{instructions:true});
    const target={candidate:"candidate.md",goal:"overview.md",source:"functional.csv",instructions:"rules.md"}[change];
    write(target,fs.readFileSync(path.join(root,target),"utf8")+"本文件版本已改变\n");
    // Observation before any advance/child preparation must not repeat a reason
    // tied to old material. This read path does not expose either review proof.
    assert.equal((await h.flow("root","status")).units[0].reason,undefined,change);
    assert.equal((await h.flow("root","prepare")).reason,undefined,change);
    assert.equal((await h.flow("root","advance")).childId,reviewer);
    const packet=await h.flow(reviewer,"prepare");assert.ok(packet.files.length>0,change);
    assert.equal(packet.reconciliation,undefined,change);assert.equal(packet.coverage.pendingCount,packet.coverage.total,change);
    await assert.rejects(h.flow(reviewer,"review",{checks}),/未核块/);
  });
});

test("a real factual rejection retires classification-reconciliation notices and private checkpoints",async()=>fixture(async(root,write)=>{
  const {h,reviewer,disputed}=await classificationLoop(root,write);
  await h.flow("root","advance");await h.flow(reviewer,"prepare");
  await h.coverage(reviewer,"record",{entries:[{block:disputed.id,parts:[{
    kind:"direct",status:"unsupported",sourceRelation:"insufficient",basis:"本次重核确认这条断言尚需实际证据而不是继续分类争议。",
    finding:{kind:"missing-evidence",quote:disputed.text,fix:"由执行者核原始资料后修订或补证。"}}]}]});
  const returned=await h.flow(reviewer,"review",{checks});
  assert.equal(returned.phase,"supplement-ready");assert.equal(returned.reason,undefined);
  const state=(await h.flow("root","status")).units[0];assert.equal(state.next,"supplement");assert.equal(state.reason,undefined);
  assert.equal((await h.flow("root","prepare")).reason,undefined);
  assert.doesNotMatch(JSON.stringify(h.notifications.at(-1)),/classification-reconciliation/);
  const directory=path.join(process.env.DSH_HOME,"building-loop-state");
  const saved=JSON.parse(fs.readFileSync(path.join(directory,fs.readdirSync(directory).find(name=>name.endsWith(".json"))),"utf8")).units.K01;
  for(const field of ["reconciliation","reconciliationBinding","reviewerCheckpoint","auditorCheckpoint","restoredCheckpointBinding","pendingReceipt"])
    assert.equal(saved[field],undefined,field);
}));

test("changing a source after memo restoration also retires active nonfactual proof and reads",async()=>fixture(async(root,write)=>{
  const {h,reviewer}=await classificationLoop(root,write);
  await h.flow("root","advance");assert.deepEqual((await h.flow(reviewer,"prepare")).files,[]);
  write("functional.csv","passed,total\n19,20\nchanged after restore\n");
  const changed=await h.flow(reviewer,"prepare");
  assert.ok(changed.files.some(file=>file.path==="candidate.md"));assert.ok(changed.files.some(file=>file.path==="functional.csv"));
  assert.equal(changed.coverage.pendingCount,changed.coverage.total);assert.equal(changed.reconciliation,undefined);
}));

test("a blocked auditor redirected by a goal change cannot donate proof to the reviewer",async()=>fixture(async(root,write)=>{
  const {h,reviewer,auditor}=await classificationLoop(root,write,{deliverAudit:false});
  h.interrupt(auditor);write("overview.md","# 新目标\n仍交付同一原始样例，逐条重核本次目标。\n");
  const next=await h.flow("root","advance");assert.equal(next.childId,reviewer);assert.equal(next.phase,"final-review");
  const packet=await h.flow(reviewer,"prepare");assert.ok(packet.files.length>0);
  assert.equal(packet.coverage.pendingCount,packet.coverage.total);
  await assert.rejects(h.flow(reviewer,"review",{checks}),/未核块/);
}));

test("source changes after the blind audit invalidate ledger closure and require re-review",async()=>fixture(async(root,write)=>{
  single(write);const h=host(root);const {reviewer}=await reviewStage(h);
  await h.flow(reviewer,"prepare");await h.assess(reviewer,quality());
  assert.equal((await h.flow(reviewer,"review",{checks})).phase,"ledger-review");
  await h.flow("root","prepare");const book=await h.ledger("root","read");
  assert.deepEqual(book.constraints.find(row=>row.id==="unit-K01").outcomes,["completed"]);
  write("functional.csv","passed,total\n19,20\nnew source version after acceptance\n");
  await assert.rejects(h.ledger("root","review",{decisions:[{id:"unit-K01",outcome:"completed",basis:"已接受",evidence:{file:"first.json",start:1,end:1}}]}),/来源已经变化/);
  const next=await h.flow("root","advance");assert.equal(next.phase,"final-review");assert.equal(next.childId,reviewer);
}));

/** Cause the ordinary numbered source deficiency to request one supplement. */
async function rejectNumeric(h,reviewer) {
  await h.flow(reviewer,"prepare");
  return h.flow(reviewer,"review",{checks:[checks[0],{id:"C2",status:"unsupported",basis:"原稿没有列这项数字的原始依据。",
    finding:{kind:"missing-evidence",quote:"平均耗时下降 25%",fix:"按原始CSV复算并提供实际出处。"}}]});
}

test("cache-read rotation counts measured unique executor steps and changes session only at a delivered boundary",async()=>fixture(async(root,write)=>{
  const p=structuredClone(policy);p.units.K01.cacheReadRotationThreshold=100;write("BUILDING-LOOP.json",JSON.stringify(p));
  const h=host(root);const executor=(await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");h.usage(executor,1,1,60);h.usage(executor,1,1,60);h.usage(executor,1,2,40);
  h.usage(executor,1,3,undefined);
  assert.equal((await h.flow("root","status")).units[0].executor,executor);
  await h.flow(executor,"submit");const reviewer=(await h.flow("root","advance")).childId;
  h.usage(reviewer,1,1,1000000);await rejectNumeric(h,reviewer);
  const next=await h.flow("root","advance");assert.notEqual(next.childId,executor);assert.equal(next.reused,false);
  assert.deepEqual(next.rotation,{from:executor,to:next.childId,cacheReadTokens:100,threshold:100,reason:"cache-read-threshold"});
  const state=(await h.flow("root","status")).units[0];assert.equal(state.executorUsage.cacheReadTokens,0);
  assert.equal(state.executorUsage.rotations.length,1);
  await assert.rejects(h.file(next.childId,"read","functional.csv"),/白名单/);
  h.usage(next.childId,1,1,12);assert.equal((await h.flow("root","status")).units[0].executorUsage.cacheReadTokens,12);
}));

test("below-threshold and unconfigured continuations retain the original executor",async()=>{
  for(const threshold of [100,undefined])await fixture(async(root,write)=>{
    const p=structuredClone(policy);if(threshold!==undefined)p.units.K01.cacheReadRotationThreshold=threshold;
    write("BUILDING-LOOP.json",JSON.stringify(p));const h=host(root);const executor=(await h.flow("root","advance")).childId;
    await h.flow(executor,"prepare");h.usage(executor,1,1,threshold===undefined?5000000:99);await h.flow(executor,"submit");
    const reviewer=(await h.flow("root","advance")).childId;await rejectNumeric(h,reviewer);
    const next=await h.flow("root","advance");assert.equal(next.childId,executor);assert.equal(next.rotation,undefined);
  });
});

test("an interrupted phase resumes the same actor even after its cache-read threshold",async()=>fixture(async(root,write)=>{
  const p=structuredClone(policy);p.units.K01.cacheReadRotationThreshold=1;write("BUILDING-LOOP.json",JSON.stringify(p));
  const h=host(root);const executor=(await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");h.usage(executor,1,1,100);h.interrupt(executor);
  const next=await h.flow("root","advance");assert.equal(next.childId,executor);assert.equal(next.phase,"intake");assert.equal(next.rotation,undefined);
  assert.equal((await h.flow(executor,"prepare")).files.length,0);
}));

test("cache threshold configuration is explicit and fresh policy remains fresh",async()=>fixture(async(root,write)=>{
  const p=structuredClone(policy);
  for(const value of [0,-1,1.5,"100",Number.MAX_SAFE_INTEGER+1]) {
    p.units.K01.cacheReadRotationThreshold=value;write("BUILDING-LOOP.json",JSON.stringify(p));
    assert.throws(()=>authority(root),/正整数/);
  }
  p.units.K01.cacheReadRotationThreshold=10;p.units.K01.continuation="fresh";write("BUILDING-LOOP.json",JSON.stringify(p));
  const h=host(root);const executor=(await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");h.usage(executor,1,1,20);await h.flow(executor,"submit");
  const reviewer=(await h.flow("root","advance")).childId;await rejectNumeric(h,reviewer);
  const next=await h.flow("root","advance");assert.notEqual(next.childId,executor);assert.equal(next.rotation,undefined);
}));
