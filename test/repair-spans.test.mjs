import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fixture,host,policy} from "./helpers.mjs";
import {QUALITY,supplementChecks,plainLastIssues} from "../governance/preflight.mjs";

const rejectedText="全部20项均通过";
const firstLine="资料说明：本例通过19项，"+rejectedText;
const numbered="- C1：本例通过19/20（出处：functional.csv 第 2 行）。";
const source={file:"functional.csv",start:2,end:2,quote:"19,20"};
const quality=()=>Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"逐项核实本例原始数据与真实适用范围，清楚区分事实与解释。"]));

/** Reach a real returned stage; both rejection channels identify one bad suffix. */
async function returned(root,write,{unlisted=true,body=firstLine,quote=rejectedText,kind="contradiction"}={}) {
  const p=structuredClone(policy);p.units.K01.claims=["C1"];p.units.K01.calculations={};
  p.units.K01.phases.supplement.read.push("functional.csv");
  write("BUILDING-LOOP.json",JSON.stringify(p));write("candidate.md",body+"\n"+numbered+"\n");
  const h=host(root,{automaticCoverage:false}),worker=(await h.flow("root","advance")).childId;
  await h.flow(worker,"prepare");await h.flow(worker,"submit");
  const reviewer=(await h.flow("root","advance")).childId,packet=await h.flow(reviewer,"prepare");
  await h.coverage(reviewer,"record",{entries:packet.coverage.blocks.map((block,i)=>({block:block.id,parts:[i===0?
    {kind:"direct",status:"unsupported",sourceRelation:kind==="scope"?"insufficient":"contradicts",
      basis:kind==="scope"?"该事实须限定为本样例的记录，不能无范围地泛化。":"只有全部通过的后半句与19/20记录矛盾。",evidence:[source],
      finding:{kind,quote,fix:"只修订错误范围，或补实际支持这项结论的新证据。"}}:
    {kind:"direct",status:"supported",sourceRelation:"supports",basis:"本条准确转述19项通过、20项总数。",evidence:[source]}]}))});
  await h.assess(reviewer,{...quality(),goalFit:{pass:true,basis:"仍在本例数据说明目标内。"},sourceRefs:[source],unverifiedSources:[],revise:[],
    unlisted:unlisted?[{line:1,quote,basis:"只登记未编号的错误后半句。"}]:[]});
  assert.equal((await h.flow(reviewer,"review",{checks:[{id:"C1",status:"supported",...source,basis:"按实际19/20记录核验。"}]})).phase,"supplement-ready");
  assert.equal((await h.flow("root","advance")).childId,worker);await h.flow(worker,"prepare");
  const submit=async content=>{
    await h.file(worker,"write","candidate.md",{content:content+"\n"+numbered+"\n",note:"落实本轮实际退回范围。"});
    await h.file(worker,"read","candidate.md");return h.flow(worker,"submit",{quality:quality()});
  };
  return {h,worker,reviewer,submit};
}

test("production submit blocks a changed correct prefix while the rejected suffix and evidence remain unchanged",async()=>fixture(async(root,write)=>{
  const {submit}=await returned(root,write);
  await assert.rejects(submit("重新整理资料说明：本例通过19项，"+rejectedText),/building-loop\/preflight/);
}));

test("production submit rejects unchanged assertions across same-paragraph soft line wrapping",async()=>fixture(async(root,write)=>{
  const {h,worker,submit}=await returned(root,write);
  for(const body of ["资料说明：本例通过19项，全部20项\n均通过","- 全部20项\n  均通过",
    "全部20项\n    均通过","- 全部20项\n    均通过","全部20项\n\t均通过"]){
    await assert.rejects(submit(body),/building-loop\/preflight/,body);
    const result=await h.flow(worker,"preflight");
    assert.ok(result.repairs.some(item=>item.unresolved.includes(1)&&item.unresolved.includes(2)),"保留实际起止行映射");
  }
}));

test("wrapped denials, examples and new evidence remain reviewable without joining separate structure blocks",async()=>{
  for(const body of ["并非“全部20项\n均通过”，原记录仅19/20。","错例 1：全部20项\n均通过，原记录构成反证。"]){
    await fixture(async(root,write)=>{const {submit}=await returned(root,write);assert.equal((await submit(body)).phase,"final-review-ready");});
  }
  await fixture(async(root,write)=>{
    const {h,worker,submit}=await returned(root,write);write("functional.csv","passed,total\n20,20\n");
    await h.file(worker,"read","functional.csv",{start:2,count:1});
    assert.equal((await submit("全部20项\n均通过（出处：functional.csv 第 2 行）。")).phase,"final-review-ready");
  });
  await fixture(async(root,write)=>{
    const {submit}=await returned(root,write);
    await assert.rejects(submit("错例：另一个旧说法。\n全部20项\n均通过"),/building-loop\/preflight/);
    // Separate paragraphs/headings/list items are never invented into one quote.
    // This only verifies matching boundaries; their new content still needs review.
    const legacy={unlisted:[{line:1,text:rejectedText,quote:rejectedText,basis:"明确旧片段"}],unsupported:[]};
    for(const lines of [["全部20项","","均通过"],["全部20项","","    均通过"],["    全部20项","均通过"],
      ["全部20项","## 均通过"],["全部20项","- 均通过"],["# 全部20项","均通过"]]){
      assert.equal(supplementChecks("",{plainLast:false,calculations:{}},lines,[],legacy).ok,true,lines.join("\n"));
    }
  });
});

test("real removal, correction, explicit denial and labelled teaching examples can return to full review",async()=>{
  for(const body of ["本例通过19项，总计20项。","本例通过19项，尚有一项未通过。","并非“"+rejectedText+"”，原始记录为19/20。",
    "“"+rejectedText+"”这一结论不成立。","- **错例 1：**"+rejectedText+"，实际记录19/20构成反证。"]){
    await fixture(async(root,write)=>{const {submit}=await returned(root,write);assert.equal((await submit(body)).phase,"final-review-ready",body);});
  }
});

test("parenthetical example labels use the shared contract in production repair preflight",async()=>{
  assert.equal(plainLastIssues({},["大白话：这是最终解释。","错例（任意描述）：这段示例不能放在收尾之后。"]).length,1);
  await fixture(async(root,write)=>{
    const {submit}=await returned(root,write);
    for(const prefix of ["不是错例（附注）：","错例（附注）","错例（"+"例".repeat(65)+"）："])
      await assert.rejects(submit(prefix+rejectedText),/building-loop\/preflight/);
    assert.equal((await submit("- **错例二（不同的描述）：**"+rejectedText+"，原始19/20是反证。")).phase,"final-review-ready");
  });
  await fixture(async(root,write)=>{
    const {submit}=await returned(root,write);
    assert.equal((await submit("错误示例(another description) 2:"+rejectedText)).phase,"final-review-ready");
  });
});

test("an example label or denial does not exempt a second unchanged assertion",async()=>fixture(async(root,write)=>{
  const {submit}=await returned(root,write);
  for(const body of ["错例："+rejectedText+"。\n"+rejectedText,"错例："+rejectedText+"。"+rejectedText,
    "## 错例 1：\n"+rejectedText,"并非不是“"+rejectedText+"”。"]){
    await assert.rejects(submit(body),/building-loop\/preflight/,body);
  }
}));

test("explicit scope restriction repairs only a scope finding and cannot excuse a contradiction",async()=>{
  await fixture(async(root,write)=>{
    const {submit}=await returned(root,write,{body:"通过19/20",quote:"通过19/20",kind:"scope"});
    assert.equal((await submit("本样例通过19/20（出处：functional.csv 第 2 行）。")).phase,"final-review-ready");
  });
  await fixture(async(root,write)=>{
    const {submit}=await returned(root,write);
    await assert.rejects(submit("仅在该样例中，"+rejectedText),/building-loop\/preflight/);
  });
});

test("retained assertions require current actually read changed cited content rather than another source line",async()=>fixture(async(root,write)=>{
  const {h,worker,submit}=await returned(root,write);
  const cited=firstLine+"（出处：functional.csv 第 2 行）。";
  // The reviewer already used this exact range: adding its locator is not new evidence.
  await assert.rejects(submit(cited),/building-loop\/preflight/);
  write("functional.csv","updated-header\n19,20\nunrelated-new-row\n");
  await h.file(worker,"read","functional.csv");
  await assert.rejects(submit(cited),/building-loop\/preflight/);
  // Moving unchanged evidence to a different row also adds no supporting content.
  write("functional.csv","header\ninserted context\n19,20\n");
  await h.file(worker,"read","functional.csv");
  await assert.rejects(submit(firstLine+"（出处：functional.csv 第 3 行）。"),/building-loop\/preflight/);
  write("functional.csv","passed,total\n20,20\n");
  await assert.rejects(submit(cited),/building-loop\/preflight/); // stale full-file read
  await h.file(worker,"read","functional.csv",{start:1,count:1});
  await assert.rejects(submit(cited),/building-loop\/preflight/); // current version, wrong row
  await h.file(worker,"read","functional.csv",{start:2,count:1});
  await assert.rejects(submit(firstLine+"。\n另附来源：functional.csv 第 2 行。"),/building-loop\/preflight/);
  assert.equal((await submit(cited)).phase,"final-review-ready");
}));

test("a true source-only repair can return unchanged prose for independent verification",async()=>fixture(async(root,write)=>{
  const body=firstLine+"（出处：functional.csv 第 2 行）。";
  const {h,worker,submit}=await returned(root,write,{body});
  write("functional.csv","passed,total\n20,20\n");await h.file(worker,"read","functional.csv",{start:2,count:1});
  assert.equal((await submit(body)).phase,"final-review-ready");
}));

test("legacy receipts disclose their limited line fallback and cannot invent new evidence snapshots",()=>{
  const spec={plainLast:false,calculations:{}},legacy={unlisted:[{line:1,text:firstLine,basis:"旧回执只有整行"}],unsupported:[]};
  const unchanged=supplementChecks("",spec,[firstLine],[],legacy);
  assert.equal(unchanged.ok,false);assert.match(unchanged.issues[0],/legacy.*无精确片段保证/);
  assert.equal(unchanged.legacy[0].guarantee,"legacy-whole-line-only");
  const changed=supplementChecks("",spec,["重新说明："+firstLine],[],legacy);
  assert.equal(changed.ok,true);assert.equal(changed.legacy.length,1);
  const quoted={unlisted:[{line:1,text:firstLine,quote:rejectedText,basis:"旧片段无原证据快照"}],unsupported:[]};
  const current=supplementChecks("",spec,["改了前缀，"+rejectedText],[],quoted);
  assert.equal(current.ok,false);assert.equal(current.repairs[0].baseline,"legacy-quote-no-evidence-snapshot");
});

test("the real closing immediately after a Markdown list is valid without an extra blank line",()=>{
  const ending="大白话：完成状态不是成功结论，模拟记录只能说相关，单条规则也不能反推，先分清官方说法和模拟记录再看结论。";
  // Exact tail from 155317Z's rejected candidate, isolated from its content verdict.
  const original="- 错例：样本 X 应送复核，因此任何送复核的样本都是 A 级（出处：sources/synthetic.md 第 4-5 行）。\n"+ending;
  assert.deepEqual(plainLastIssues({},original.split("\n")),[]);
  assert.deepEqual(plainLastIssues({},["- 前一条内容","**直白说明：** 看实际记录。"]),[]);
  for(const tail of ["\n错例 1：另一个错误。","\n错误示例二：另一个错误。","\n\n附录内容。","\n- 新列表内容"]){
    assert.equal(plainLastIssues({},(original+tail).split("\n")).length,1,tail);
  }
  for(const body of ["```text\n\n"+ending+"\n```","<div>\n\n"+ending+"\n</div>","<!--\n"+ending+"\n-->",
    "> 这是引用\n"+ending,"    "+ending,"> "+ending]){
    assert.equal(plainLastIssues({},body.split("\n")).length,1,body);
  }
});

test("strict closing fences cannot expose a plain-language label that remains inside code",()=>{
  for(const fence of ["```","~~~"]){
    assert.equal(plainLastIssues({},[fence+"text",fence+"not-a-close","大白话：仍在代码围栏内。"]).length,1);
    assert.deepEqual(plainLastIssues({},[fence+"text","代码内容",fence+"   ","大白话：这是围栏之后的独立解释。"]),[]);
  }
});
