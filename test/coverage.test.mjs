import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { authority, digest, keyOf } from "../governance/policy.mjs";
import { QUALITY, lineList, supplementChecks } from "../governance/preflight.mjs";
import { coverageAction, coverageSummary, documentCoverage, classificationDisagreements } from "../governance/coverage.mjs";

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
  const spec={calculations:{}};
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

test("classification disagreement is distinct from a proven false claim",()=>{
  const a={records:[{block:"B1",line:1,text:"结论",parts:[nonfact]}]};
  const b={records:[{block:"B1",line:1,text:"结论",parts:[fact]}]};
  assert.equal(classificationDisagreements(a,b).length,1);
  assert.equal(classificationDisagreements(b,b).length,0);
});

test("presentation advice cannot enter factual repair debt without an actual factual defect",async()=>fixture(async(root,write)=>{
  write("candidate.md","大白话：把状态和结果分开看。\n");
  const e=environment(root),block=e.invoke("inventory").blocks[0].id;
  const rejected={kind:"direct",status:"uncertain",sourceRelation:"insufficient",basis:"方向正确，但结尾没有重复所有正文要点，属于写法。",repair:"再补一句解释。"};
  assert.throws(()=>e.invoke("record",{entries:[{block,parts:[rejected]}]}),/事实退回须/);
  assert.throws(()=>e.invoke("record",{entries:[{block,parts:[{...rejected,finding:{kind:"presentation",quote:"分开看",fix:"加长收尾"}}]}]}),/事实退回须/);
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
