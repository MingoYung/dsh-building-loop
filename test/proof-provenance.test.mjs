import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { digest } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";

const firstRef={file:"functional.csv",start:2,end:2,quote:"19,20"};
const secondRef={file:"deployment.md",start:1,end:1,quote:"本次只在实验环境通过。"};
const c1="- C1：通过 19/20（出处：functional.csv 第 2 行）。";
const c2="- C2：本次在实验环境通过（出处：deployment.md 第 1 行）。";
const bad="- C2：所有生产环境都通过（出处：deployment.md 第 1 行）。";
const summary="# 摘要";
const supporting=ref=>({kind:"direct",status:"supported",sourceRelation:"supports",evidence:[ref],basis:"原文内容与当前句子的限定范围一致。"});
const rejecting={kind:"direct",status:"unsupported",sourceRelation:"insufficient",basis:"单次实验不支持全称生产部署结论。",
  finding:{kind:"scope",quote:"所有生产环境都通过",fix:"限定为本次实验环境。"}};
const numbered=(id,ref)=>({id,status:"supported",file:ref.file,start:ref.start,end:ref.end,basis:"已读取匹配的原文行。"});
const quality=Object.fromEntries(Object.entries(QUALITY).map(([key,label])=>[key,"本用例核对 " + label]));

async function setup(root,write,body) {
  const p=structuredClone(policy),spec=p.units.K01;
  spec.claims=body.includes("C2：")?["C1","C2"]:["C1"];
  spec.calculations={};
  spec.requireSourcePins=true;
  p.sourcePins=Object.fromEntries([[firstRef.file,"passed,total\n19,20\n"],[secondRef.file,secondRef.quote+"\n"]]
    .map(([file,bytes])=>{write(file,bytes);return [file,{kind:"primary",locator:"内部项目原始记录 "+file,sha256:digest(bytes)}];}));
  for(const phase of ["first-review","final-review"]) {
    spec.phases[phase].read=["candidate.md","overview.md",firstRef.file,secondRef.file];
    spec.phases[phase].evidence=[firstRef.file,secondRef.file];
  }
  spec.phases.supplement.read.push(firstRef.file,secondRef.file);
  write("candidate.md",body);
  write("BUILDING-LOOP.json",JSON.stringify(p));
  const h=host(root,{automaticCoverage:false});
  const executor=(await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");
  await h.flow(executor,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  return {h,executor,reviewer,packet:await h.flow(reviewer,"prepare")};
}

async function record(h,actor,packet,select,onlyPending=false) {
  return h.coverage(actor,"record",{entries:packet.coverage.blocks.filter(row=>!onlyPending||packet.coverage.pending.includes(row.id))
    .map(block=>({block:block.id,parts:[select(block)]}))});
}

function assess(h,actor) {
  return h.assess(actor,{...Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"已核对原始材料、当前稿件及实际适用范围。"])),
    goalFit:{pass:true,basis:"按本轮项目目标分别核对两项原始记录。"},sourceRefs:[firstRef,secondRef].map(({file,start,end})=>({file,start,end})),
    unverifiedSources:[],unlisted:[],revise:[]});
}

for(const [source,reason] of [
  ["fake-report.md 第 2 行","unapproved-source"],
  ["fake-report.md 第 2 行；functional.csv 第 2 行","unapproved-source"],
  ["https://example.invalid/report","unapproved-url"],
]) {
  test("unapproved prose attribution cannot borrow real evidence: "+source,()=>fixture(async(root,write)=>{
    const fake="本次全部通过（出处："+source+"）。";
    const {h,reviewer,packet}=await setup(root,write,c1+"\n"+fake+"\n");
    const result=await record(h,reviewer,packet,()=>supporting(firstRef));
    assert.equal(result.rejected.length,1);
    assert.equal(result.rejected[0].attribution.reason,reason);
    assert.equal(result.rejected[0].proofObject,"external");
    assert.match(result.rejected[0].findingId,/^[a-f0-9]{64}$/u);
    assert.match(result.rejected[0].proofBinding,/^[a-f0-9]{64}$/u);
    const retried=await record(h,reviewer,packet,()=>({...supporting(firstRef),basis:"另一个核验表述仍引用同一个原始片段。"}));
    assert.equal(retried.rejected[0].findingId,result.rejected[0].findingId);
    await assess(h,reviewer);
    assert.equal((await h.flow(reviewer,"review",{checks:[numbered("C1",firstRef)]})).phase,"supplement-ready");
    const saved=JSON.parse(fs.readFileSync(path.join(root,"first.json"),"utf8"));
    assert.equal(saved.coverage.rejected[0].findingId,result.rejected[0].findingId);
  }));
}

test("a real but different source cannot replace the explicit supported prose locator",()=>fixture(async(root,write)=>{
  const {h,reviewer,packet}=await setup(root,write,c1+"\n");
  await assert.rejects(record(h,reviewer,packet,()=>supporting(secondRef)),/coverage-attribution/);
  await record(h,reviewer,packet,()=>supporting(firstRef));
  const ref=(await h.coverage(reviewer,"status",{block:packet.coverage.blocks[0].id})).record.parts[0].evidence[0];
  assert.equal(ref.provenance,"maintainer-pinned-local-material");
  assert.match(ref.evidenceSpan,/^[a-f0-9]{64}$/u);
}));

const plain={kind:"nonfactual",status:"supported",basis:"这是结构标题，无可核的事实内容。"};
test("mislabeling prose cannot erase fake provenance, while quotations, code, examples and hypotheses remain separate",()=>fixture(async(root,write)=>{
  const attributed="本次全部通过（出处：fake-report.md 第 2 行）。";
  const {h,reviewer,packet}=await setup(root,write,[c1,attributed,"","> "+attributed,"","```md",attributed,"```","",
    "[推测] "+attributed,"错例："+attributed,""].join("\n"));
  const result=await record(h,reviewer,packet,block=>block.line===1?supporting(firstRef)
    :block.text.startsWith("[推测]")?{kind:"hypothesis",status:"uncertain",basis:"明确标成假设，须保留未证状态。"}
    :block.text.startsWith("错例")?{...supporting(firstRef),kind:"error-example",sourceRelation:"contradicts",basis:"原始报告只有十九项通过，明确否定错例中的全部通过。"}
    :plain);
  assert.equal(result.rejected.length,1);
  assert.equal(result.rejected[0].line,2);
  assert.equal(result.rejected[0].attribution.reason,"unapproved-source");
}));

for(const change of ["draft-only","source","scope"]) {
  test("same-role selective proof reuse after supplement: "+change,()=>fixture(async(root,write)=>{
    const {h,executor,reviewer,packet}=await setup(root,write,[summary,c1,bad,""].join("\n"));
    const first=await record(h,reviewer,packet,block=>block.line===1?plain:block.line===2?supporting(firstRef):rejecting);
    assert.equal(first.rejected.length,1);
    assert.equal((await h.flow(reviewer,"review",{checks:[numbered("C1",firstRef)]})).phase,"supplement-ready");
    assert.equal((await h.flow("root","advance")).childId,executor);
    await h.file(executor,"write","candidate.md",{content:[change==="scope"?"# 只谈另一批试验":summary,c2,c1,""].join("\n"),note:"收窄 C2 的结论范围，并交换编号段落顺序。"});
    await h.flow(executor,"prepare");
    assert.equal((await h.flow(executor,"submit",{quality})).phase,"final-review-ready");
    if(change==="source")write(secondRef.file,secondRef.quote+"\n未登记的新材料。\n");
    assert.equal((await h.flow("root","advance")).childId,reviewer);
    const final=await h.flow(reviewer,"prepare");
    const block=final.coverage.blocks.find(item=>item.text===c1);
    assert.equal(final.coverage.pending.includes(block.id),change!=="draft-only");
    if(change!=="draft-only")return;
    const restored=(await h.coverage(reviewer,"status",{block:block.id})).record;
    assert.equal(restored.line,3);
    assert.equal(restored.reusedProof.phase,"first-review");
    assert.notEqual(restored.reusedProof.block,block.id);
    await record(h,reviewer,final,row=>row.line===1?plain:supporting(secondRef),true);
    await assess(h,reviewer);
    assert.equal((await h.flow(reviewer,"review",{checks:[numbered("C1",firstRef),numbered("C2",secondRef)]})).phase,"final-audit-ready");
    const auditor=(await h.flow("root","advance")).childId;
    assert.notEqual(auditor,reviewer);
    const fresh=await h.flow(auditor,"prepare");
    assert.equal(fresh.coverage.pendingCount,fresh.coverage.total);
    await record(h,auditor,fresh,row=>row.line===1?plain:supporting(row.line===2?secondRef:firstRef));
    assert.equal((await h.flow(auditor,"audit")).phase,"ledger-review");
    const receipt=JSON.parse(fs.readFileSync(path.join(root,"final.json"),"utf8"));
    assert.equal(receipt.coverage.reusedProofs.length,1);
    assert.deepEqual(receipt.independentAudit.coverage.reusedProofs,[]);
  }));
}
