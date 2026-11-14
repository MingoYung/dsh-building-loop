import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";

const fragment="方案在所有环境中都可用";
const basis="材料只记录一次试验，证据范围不能支持所有环境。";
const finding={kind:"scope",quote:fragment,fix:"限定为这次试验的实际结果。"};
const c1={id:"C1",status:"supported",file:"functional.csv",start:2,end:2,basis:"读过原始测试数据。"};

/** Start the real review tool with C4 discovered from the draft, not policy. */
async function review(root,write,{readSource=true,supported=false,ambiguous=false}={}) {
  const configured=structuredClone(policy);
  const spec=configured.units.K01;
  spec.claims=["C1"];
  spec.calculations={};
  const phase=spec.phases["first-review"];
  phase.read.push("cases.md");
  phase.evidence.push("cases.md");
  write("BUILDING-LOOP.json",JSON.stringify(configured));
  write("cases.md","这次试验中方案可用。\n");
  const statement=supported?"这次试验中方案可用":fragment;
  write("candidate.md","- C1：通过 19/20（出处：functional.csv 第 2 行）。\n- C4："+statement
    +(ambiguous?"；其他方案都不可用":"")+"（出处：cases.md 第 1 行）。\n");
  const h=host(root,{automaticCoverage:false});
  const executor=(await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");
  await h.flow(executor,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  const packet=readSource?await h.flow(reviewer,"prepare"):null;
  if(!readSource)for(const file of ["candidate.md","overview.md","functional.csv"])await h.file(reviewer,"read",file);
  const inventory=packet?.coverage??await h.coverage(reviewer,"inventory");
  const output=await h.coverage(reviewer,"record",{entries:inventory.blocks.map(block=>({block:block.id,parts:[block.line===1
    ? {kind:"direct",status:"supported",sourceRelation:"supports",basis:c1.basis,evidence:[{file:c1.file,start:2,end:2,quote:"19,20"}]}
    : supported ? {kind:"direct",status:"supported",sourceRelation:"supports",basis:"范围仅限本次原始记录。",
      evidence:[{file:"cases.md",start:1,end:1,quote:"这次试验中方案可用。"}]}
    : {kind:"direct",status:"unsupported",sourceRelation:"insufficient",basis,
      finding:block.text.includes(fragment)?finding:{...finding,quote:"其他方案都不可用"}},
  ]}))});
  assert.deepEqual(output.pending,[]);
  return {h,reviewer,packet};
}

for(const checks of [[c1],[c1,{id:"C4",status:"unsupported",basis}]]) {
  test("the reviewer can reuse one current exact rejection for an omitted "+(checks.length===1?"numbered check":"finding"),async()=>fixture(async(root,write)=>{
    const {h,reviewer,packet}=await review(root,write);
    assert.deepEqual(packet.claims,["C1","C4"]);
    const result=await h.flow(reviewer,"review",{checks});
    assert.equal(result.phase,"supplement-ready");
    assert.deepEqual(result.unsupported,["C4"]);
    const receipt=JSON.parse(fs.readFileSync(path.join(root,"first.json"),"utf8"));
    const c4=receipt.checks.find(check=>check.id==="C4");
    assert.deepEqual(c4.finding,finding);
    assert.deepEqual(c4.findingOrigin,{kind:"same-reviewer-coverage",block:receipt.coverage.rejected[0].block});
  }));
}

for(const scenario of [{supported:true},{readSource:false},{ambiguous:true}]) {
  test("no fallback from positive, unread or ambiguous coverage "+JSON.stringify(scenario),async()=>fixture(async(root,write)=>{
    const {h,reviewer}=await review(root,write,scenario);
    await assert.rejects(h.flow(reviewer,"review",{checks:[c1]}),/核验参数缺少 C4/);
    assert.equal((await h.flow("root","status")).units[0].phase,"first-review");
    assert.equal(fs.existsSync(path.join(root,"first.json")),false);
  }));
}

test("an explicit invalid finding and an observed source changed since coverage are not rescued",async()=>fixture(async(root,write)=>{
  const {h,reviewer}=await review(root,write);
  await assert.rejects(h.flow(reviewer,"review",{checks:[c1,{id:"C4",status:"unsupported",basis,finding:null}]}),/须提供 finding/);
  write("cases.md","另一次试验在两个环境中可用。\n");
  await h.file(reviewer,"read","cases.md");
  await assert.rejects(h.flow(reviewer,"review",{checks:[c1]}),/核验参数缺少 C4/);
  assert.equal(fs.existsSync(path.join(root,"first.json")),false);
}));
