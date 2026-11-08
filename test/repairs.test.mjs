import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { authority, digest, keyOf } from "../governance/policy.mjs";
import { QUALITY, lineList, rejectedClaims, supplementChecks, numericChecks } from "../governance/preflight.mjs";
import { coverageFindings } from "../governance/evidence.mjs";

test("empty lines and numbered facts cannot become unlisted repair deadlocks",()=>{
  const lines=["# 月球完全不自转", "", "- C1：待核说法", "另一条尚未登记的外部事实"];
  assert.throws(()=>coverageFindings([{line:2,basis:"空行，没有内容"}],lines),/不能把空行/);
  assert.throws(()=>coverageFindings([{line:3,basis:"已编号，待核"}],lines),/已编号断言/);
  assert.equal(coverageFindings([{line:1,basis:"标题含实际待核断言"}],lines)[0].text,lines[0]);
  assert.equal(coverageFindings([{line:4,basis:"新增事实缺少出处"}],lines).length,1);
  const legacy={unlisted:[{line:2,text:"",basis:"旧回执错误"}],unsupported:[]};
  assert.equal(supplementChecks("",{calculations:{},plainLast:false},lines,[],legacy).ok,true);
});

test("actual failed NASA before/after pair passes repair preflight while unchanged text stays blocked", async () => fixture(async (root,write) => {
  const bundle = JSON.parse(fs.readFileSync(new URL("../experiments/data/building-loop-source-audit/20261107T050421Z.json",import.meta.url)));
  const artifacts = Object.fromEntries(bundle.artifacts.map(a => [a.path,a.data]));
  for (const [file,data] of Object.entries(artifacts)) {
    if (file.startsWith("reuse/workspace/sources/") && typeof data === "string") {
      fs.mkdirSync(path.join(root,"sources"),{recursive:true});
      write(file.replace("reuse/workspace/",""),data);
    }
  }
  const sourceChecks=artifacts["reuse/workspace/sources/source-checks.json"];
  write("sources/source-checks.json",JSON.stringify(sourceChecks,null,2)+"\n");
  const receipt=artifacts["reuse/workspace/records/audit-final.json"];
  const writes=artifacts["events.jsonl"].filter(e=>e.type==="tool/call"&&e.data.name==="building_loop_file").map(e=>JSON.parse(e.data.arguments));
  const before=writes.find(a=>a.action==="write"&&a.path==="module/candidate.md"&&digest(Buffer.from(a.content))===receipt.candidateSha256).content;
  const after=artifacts["reuse/workspace/module/candidate.md"];
  // Reproduce the historical numeric repair as recorded, before prose layout gates.
  const spec={...artifacts["reuse/workspace/BUILDING-LOOP.json"].units.K01,calculations:{},plainLast:false};
  const readable=spec.phases.supplement.read;
  const seen=Object.fromEntries(readable.filter(file=>fs.existsSync(path.join(root,file))).map(file=>{
    const bytes=fs.readFileSync(path.join(root,file));
    return [keyOf(file),{hash:digest(bytes),ranges:[[1,lineList(bytes).length]]}];
  }));
  const active={rejected:rejectedClaims(root,spec,lineList(Buffer.from(before)),[{id:"C3"}],readable),unsupported:["C3"],seen};
  assert.equal(before.includes("27.3"),true);
  assert.equal(after.includes("27.3"),false);
  assert.equal(supplementChecks(root,spec,lineList(Buffer.from(before)),readable,active).ok,false);
  assert.equal(supplementChecks(root,spec,lineList(Buffer.from(after)),readable,active).ok,true);
}));

test("a wrong percentage after the citation cannot hide from numeric verification", async () => fixture(async root => {
  const spec=authority(root).units.K01;
  const content="- C2：下降 20%（出处：timing.csv 第 2-3 行），实际下降 24%。";
  assert.equal(numericChecks(root,spec,[content],["timing.csv"])[0].ok,false);
}));

test("script rejects a falsely supported source number even when another claim is already rejected",async()=>fixture(async(root,write)=>{
  const doc=structuredClone(policy);
  doc.units.K01.calculations={C2:{kind:"source-number",source:"timing.csv",line:1,sourceUnit:"Earth days",units:["地球日","天"]}};
  doc.units.K01.phases["first-review"].read.push("timing.csv");
  doc.units.K01.phases["first-review"].evidence.push("timing.csv");
  write("BUILDING-LOOP.json",JSON.stringify(doc));
  write("timing.csv","Orbit takes 27 Earth days.\n");
  write("candidate.md","- C1：通过 19/20（出处：functional.csv 第 2 行）。\n- C2：自转只需24小时（出处：timing.csv 第1行）。\n");
  const h=host(root);const worker=(await h.flow("root","advance")).childId;
  await h.file(worker,"read","candidate.md");await h.flow(worker,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  for(const file of ["candidate.md","timing.csv","overview.md"])await h.file(reviewer,"read",file);
  const result=await h.flow(reviewer,"review",{checks:[
    {id:"C1",status:"unsupported",basis:"本次尚未核功能原始数据",finding:{kind:"missing-evidence",quote:"通过 19/20",fix:"核原始记录"}},
    {id:"C2",status:"supported",file:"timing.csv",start:1,end:1,basis:"原文实际上不支持24小时，但标签错误填支持"},
  ]});
  assert.deepEqual(result.unsupported,["C1","C2"]);
  const spec=authority(root).units.K01;
  const check=body=>numericChecks(root,spec,["- C2："+body+"（出处：timing.csv 第1行）。"],["timing.csv"])[0];
  assert.equal(check("周期为27.0个地球日").ok,true);
  assert.equal(check("周期为27小时").ok,false);
  assert.equal(check("周期为24小时").ok,false);
}));

/** Opt in to a single-quantity document contract using a frozen source line. */
function directDocument(root,write) {
  const doc=structuredClone(policy);
  doc.units.K01.calculations={C2:{kind:"source-number",source:"timing.csv",line:1,sourceUnit:"Earth days",units:["地球日","天"],scope:"document"}};
  doc.units.K01.phases["first-review"].read.push("timing.csv");
  doc.units.K01.phases["first-review"].evidence.push("timing.csv");
  write("BUILDING-LOOP.json",JSON.stringify(doc));write("timing.csv","Orbit takes 27 Earth days.\n");
  return {doc,spec:authority(root).units.K01,row:"- C2：周期为 27 个地球日（出处：timing.csv 第 1 行）。"};
}

test("document scope checks extra paragraphs but does not claim universal semantic coverage",async()=>fixture(async(root,write)=>{
  const {doc,spec,row}=directDocument(root,write);
  const check=extra=>numericChecks(root,spec,[row,extra],["timing.csv"])[0];
  for(const extra of ["精确值为 27.3 天。","周期应为24 Earth days。","精确值比 27 天略长。","实际超过27天。","时间至少 27 天。","More than 27 Earth days.","周期 >= 27 天。"]){
    const result=check(extra);assert.equal(result.ok,false,extra);assert.equal(result.documentIssues[0].line,2);
  }
  assert.equal(check("原文写 27 天，未给出更精确的数值，本文不补写。").ok,true);
  assert.equal(check("说明：同一句给出 27.0 个地球日。").ok,true);
  // Backward compatible claim scope does not silently constrain unrelated quantities.
  delete doc.units.K01.calculations.C2.scope;write("BUILDING-LOOP.json",JSON.stringify(doc));
  assert.equal(numericChecks(root,authority(root).units.K01,[row,"另一个阶段为 30 天。"],["timing.csv"])[0].ok,true);
  doc.units.K01.calculations.C2.scope="automatic";write("BUILDING-LOOP.json",JSON.stringify(doc));
  assert.throws(()=>authority(root),/原文数值核对/);
}));

test("outside-row numeric repair is accepted without rewriting a correct claim; unrelated edits cannot bypass it",async()=>fixture(async(root,write)=>{
  const {spec,row}=directDocument(root,write);
  const before=["# 问答",row,"精确值比 27 天略长，原文没给小数。"];
  const readable=spec.phases.supplement.read;
  const bytes=fs.readFileSync(path.join(root,"timing.csv"));
  const active={unsupported:["C2"],rejected:rejectedClaims(root,spec,before,[{id:"C2"}],readable),
    seen:{[keyOf("timing.csv")]:{hash:digest(bytes),ranges:[[1,2]]}}};
  assert.equal(supplementChecks(root,spec,before,readable,active).ok,false);
  assert.equal(supplementChecks(root,spec,["# 新标题",...before.slice(1)],readable,active).ok,false);
  assert.equal(supplementChecks(root,spec,before.slice(0,2),readable,active).ok,true);
  assert.equal(supplementChecks(root,spec,[...before.slice(0,2),"原文没有给出更精确的值。"],readable,active).ok,true);
}));

test("direct document quantities cannot silently become exact values or unregistered conversions",async()=>fixture(async(root,write)=>{
  const {spec,row}=directDocument(root,write);
  const check=extra=>numericChecks(root,spec,[row,extra],["timing.csv"])[0];
  for(const extra of ["精确值按来源写作27地球日。","周期为27地球日，是精确值27天。","Exactly 27 Earth days.","27个地球日折算约648小时（27 × 24）。"]){
    assert.equal(check(extra).ok,false,extra);
  }
  assert.equal(check("原文写 27 个地球日，未说明精确值，本文不自行增加精度。").ok,true);
  assert.equal(check("原文写 27 天（timing.csv 第 1 行；https://example.org/2026/report），本稿据此转述。").ok,true);
}));

/** A small source-backed delivery keeps the goal/ledger tests independent of arithmetic. */
async function acceptedFixture(run) {
  await fixture(async(root,write)=>{
    const doc=structuredClone(policy);
    const unit=doc.units.K01;
    unit.claims=["C1"]; unit.calculations={}; unit.covers=["old-faq"];
    unit.phases.supplement.read.push("functional.csv");
    write("BUILDING-LOOP.json",JSON.stringify(doc));
    write("candidate.md","# 问答\n- C1：通过 19/20（出处：functional.csv 第 2 行）。\n");
    const h=host(root);
    await h.ledger("root","record",{id:"old-faq",kind:"temporary",title:"单独的 FAQ",note:"由本轮交付覆盖"});
    const worker=(await h.flow("root","advance")).childId;
    await h.file(worker,"read","candidate.md"); await h.flow(worker,"submit");
    const reviewer=(await h.flow("root","advance")).childId;
    const check={id:"C1",status:"supported",file:"functional.csv",start:2,end:2,basis:"原始数据行确为 19,20"};
    const assessment={...Object.fromEntries(Object.keys(QUALITY).map(k=>[k,"本轮小样例的具体证据与适用边界。"])),
      goalFit:{pass:true,basis:"现稿是当前目标要求的简明问答。"},sourceRefs:[{file:"functional.csv",start:2,end:2}],
      unverifiedSources:[],unlisted:[],revise:[],suggestions:["如日后扩展范围可添加更多独立样本。"]};
    const readReview=async()=>{for(const file of ["candidate.md","functional.csv","overview.md"])await h.file(reviewer,"read",file);};
    const accept=async()=>{await readReview();await h.assess(reviewer,assessment);return h.flow(reviewer,"review",{checks:[check]});};
    await run({root,write,h,worker,reviewer,check,assessment,readReview,accept});
  });
}

test("presentation cannot be submitted as a factual defect and optional advice does not block",async()=>acceptedFixture(async({h,reviewer,readReview,assessment,check})=>{
  await readReview();
  await assert.rejects(h.flow(reviewer,"review",{checks:[{...check,status:"unsupported",finding:{kind:"presentation",quote:"通过 19/20",fix:"写得更详细"}}]}),/事实退回/);
  await assert.rejects(h.flow(reviewer,"review",{checks:[{...check,status:"unsupported",finding:{kind:"missing-evidence",quote:"27.3",fix:"补写精确值"}}]}),/真实存在/);
  await assert.rejects(h.assess(reviewer,{...assessment,revise:["detail"]}),/revisions/);
  await h.assess(reviewer,assessment);
  assert.equal((await h.flow(reviewer,"review",{checks:[check]})).phase,"ledger-review");
}));

test("missing child unit uses its host assignment without granting coordinator or another unit",async()=>acceptedFixture(async({h,reviewer,readReview,assessment,check})=>{
  await readReview();
  await assert.rejects(h.assess("root",{...assessment,unit:undefined}),/独立核验方/);
  await assert.rejects(h.assess(reviewer,{...assessment,unit:"K02"}),/授权不匹配/);
  assert.equal((await h.assess(reviewer,{...assessment,unit:undefined})).unit,"K01");
  await assert.rejects(h.flow(reviewer,"review",{unit:"K02",checks:[check]}),/授权不匹配/);
  await assert.rejects(h.flow("root","review",{unit:undefined,checks:[check]}),/没有可交付阶段/);
  assert.equal((await h.flow(reviewer,"review",{unit:undefined,checks:[check]})).phase,"ledger-review");
}));

test("reviewer citation and omission mistakes do not create candidate repair debt",async()=>acceptedFixture(async({h,reviewer,readReview,assessment,check})=>{
  await readReview();await h.assess(reviewer,assessment);
  await assert.rejects(h.flow(reviewer,"review",{checks:[]}),/核验参数缺少 C1/);
  await assert.rejects(h.flow(reviewer,"review",{checks:[{...check,file:"overview.md"}]}),/核验引用无效/);
  await assert.rejects(h.flow(reviewer,"review",{checks:[{...check,start:1,end:1}]}),/核验引用无效/);
  const state=(await h.flow("root","status")).units[0];
  assert.equal(state.phase,"first-review");assert.equal(state.unsupported,undefined);
  assert.equal((await h.flow(reviewer,"review",{checks:[check]})).phase,"ledger-review");
}));

test("an unrelated acceptance cannot mark a cancelled standalone plan completed",async()=>acceptedFixture(async({h,write,accept})=>{
  await h.ledger("root","record",{id:"cancelled-quiz",kind:"interrupted",title:"课堂测验",note:"曾等待问答核验，现已取消"});
  write("overview.md","# 当前项目\n旧 FAQ 由本轮正文覆盖；课堂测验已取消，本轮只交付问答。\n");
  await h.flow("root","advance"); // A changed goal needs the same reviewer's fresh checkpoint.
  await accept();
  for(const file of ["final.json","overview.md"])await h.file("root","read",file);
  const view=await h.ledger("root","read");
  const decisions=view.items.map(item=>item.id==="old-faq"
    ?{id:item.id,outcome:"covered",coveredBy:"K01",basis:"问答正文覆盖旧 FAQ",evidence:{file:"overview.md",start:2,end:2}}
    :{id:item.id,outcome:"completed",basis:"问答核验已通过，不等于测验已执行",evidence:{file:"final.json",start:1,end:5}});
  await assert.rejects(h.ledger("root","review",{decisions}),/独立计划.*不能.*completed/);
  assert.equal((await h.flow("root","status")).units[0].phase,"ledger-review");
  const cancelled=decisions.find(item=>item.id==="cancelled-quiz");
  Object.assign(cancelled,{outcome:"obsolete",basis:"当前项目取消课堂测验，执行前提已经失效",evidence:{file:"overview.md",start:2,end:2}});
  assert.equal((await h.ledger("root","review",{decisions})).phase,"closed");
  assert.equal((await h.ledger("root","read",{includeClosed:true})).items.find(item=>item.id==="cancelled-quiz").status,"obsolete");
}));

test("misplaced contradiction evidence gets a precise parameter error without a new stage",async()=>acceptedFixture(async({h,reviewer,readReview,check})=>{
  await readReview();
  await assert.rejects(h.flow(reviewer,"review",{checks:[{...check,status:"unsupported",file:undefined,start:undefined,end:undefined,
    finding:{kind:"contradiction",quote:"通过 19/20",fix:"回到原始行核对",file:"functional.csv",start:2,end:2}}]}),/与 id\/status 同级/);
  assert.equal((await h.flow("root","status")).units[0].phase,"first-review");
}));

test("conversation ending without a receipt resumes the same actor; delivered stages stay delivered",async()=>acceptedFixture(async({h,reviewer,accept})=>{
  h.finish(reviewer);
  const unit=(await h.flow("root","status")).units[0];
  assert.equal(unit.phase,"blocked");assert.equal(unit.next,"first-review");
  assert.equal((await h.flow("root","advance")).childId,reviewer);
  await accept();h.finish(reviewer);
  assert.equal((await h.flow("root","status")).units[0].phase,"ledger-review");
}));

test("ledger may summarize validated decisions but cannot invent per-item reasons",async()=>acceptedFixture(async({h,accept})=>{
  await accept();
  const current=await h.ledger("root","read");
  await h.file("root","read","overview.md");await h.file("root","read","first.json");
  const decisions=current.items.map(item=>item.id==="old-faq"
    ?{id:item.id,outcome:"covered",coveredBy:"K01",basis:"当前问答已取代独立 FAQ",evidence:{file:"overview.md",start:2,end:2}}
    :{id:item.id,outcome:"completed",basis:"当前目标的独立验收已通过",evidence:{file:"first.json",start:1,end:5}});
  await assert.rejects(h.ledger("root","review",{decisions:decisions.map((d,i)=>i?d:{...d,basis:""})}),/具体原因/);
  assert.equal((await h.ledger("root","review",{decisions})).phase,"closed");
  assert.equal((await h.ledger("root","review",{decisions})).replayed,true);
}));

test("goal changes invalidate assessment and force current-goal review in the same reviewer session",async()=>acceptedFixture(async({h,reviewer,write,readReview,assessment,check,accept})=>{
  await assert.rejects(h.assess(reviewer,assessment),/读取当前目标/);
  await readReview();await h.assess(reviewer,assessment);
  write("overview.md","# G2\n只交简明问答，旧 FAQ 由本轮覆盖。\n");
  assert.equal((await h.flow(reviewer,"review",{checks:[check]})).phase,"goal-review-ready");
  assert.equal((await h.flow("root","advance")).childId,reviewer);
  assert.equal((await accept()).phase,"ledger-review");
}));

test("closure and covered tasks require the current goal, candidate and accepted replacing unit",async()=>acceptedFixture(async({h,root,reviewer,write,accept})=>{
  await accept();
  let current=await h.ledger("root","read");
  await h.file("root","read","overview.md");await h.file("root","read","first.json");
  const decisions=()=>current.items.map(item=>item.id==="old-faq"
    ?{id:item.id,outcome:"covered",coveredBy:"K01",basis:"本轮交付在当前目标下替代旧 FAQ",evidence:{file:"overview.md",start:2,end:2}}
    :{id:item.id,outcome:"completed",basis:"本轮回执通过",evidence:{file:"final.json",start:1,end:5}});
  write("overview.md","# G2\n只交中文问答，原 FAQ 由本轮交付覆盖。\n");
  await assert.rejects(h.ledger("root","review",{note:"按现目标",decisions:decisions()}),/当前目标/);
  assert.equal((await h.flow("root","advance")).childId,reviewer);
  await accept();
  current=await h.ledger("root","read");
  await h.file("root","read","overview.md");await h.file("root","read","final.json");
  const unchanged=decisions().map(d=>d.id==="old-faq"?{...d,outcome:"resume"}:d);
  await assert.rejects(h.ledger("root","review",{note:"按现目标",decisions:unchanged}),/已声明/);
  const noProof=decisions().map(d=>d.id==="old-faq"?{...d,coveredBy:"missing"}:d);
  await assert.rejects(h.ledger("root","review",{note:"按现目标",decisions:noProof}),/coveredBy/);
  const request={note:"按现目标逐项关单",decisions:decisions()};
  await h.ledger("root","review",request);
  const before=fs.readFileSync(path.join(root,"candidate.md"),"utf8");
  write("candidate.md",before+"未验收的新断言。\n");
  await assert.rejects(h.ledger("root","review",request),/候选与通过回执/);
}));

test("late user messages reopen ledger review and classification uses the original request identity",async()=>acceptedFixture(async({h,accept})=>{
  await accept();
  const finish=async()=>{
    const view=await h.ledger("root","read");
    await h.file("root","read","overview.md");await h.file("root","read","first.json");
    const decisions=view.items.map(i=>i.id==="old-faq"?{id:i.id,outcome:"covered",coveredBy:"K01",basis:"现稿已覆盖",evidence:{file:"overview.md",start:2,end:2}}
      :i.id==="unit-K01"?{id:i.id,outcome:"completed",basis:"本轮事实和目标已验收",evidence:{file:"first.json",start:1,end:5}}
      :{id:i.id,outcome:"keep",basis:"新请求仍需另行安排"});
    return h.ledger("root","review",{note:"本轮逐项确认",decisions});
  };
  await finish();
  const previous = (await h.ledger("root","read",{includeClosed:true})).items.find(i=>i.id==="old-faq");
  await h.ledger("root","record",{id:"old-faq",kind:"temporary",title:"单独的 FAQ",note:"修改说明不能复活已覆盖事项",expectedItemSha256:previous.itemSha256});
  assert.equal((await h.ledger("root","read",{includeClosed:true})).items.find(i=>i.id==="old-faq").status,"covered");
  h.user("root",9,"后续检查来源链接");h.user("root",9,"后续检查来源链接");
  const view=await h.ledger("root","read");
  assert.equal(view.current.phase,"ledger-review");
  const request=view.items.find(i=>i.origin);
  await h.ledger("root","record",{originId:request.id,kind:"planned",title:"后续检查来源链接",note:"按原始请求安排"});
  await assert.rejects(h.ledger("root","record",{id:"duplicate",kind:"planned",title:"后续检查来源链接",note:"再次登记"}),/同名事项/);
  assert.equal((await h.ledger("root","read")).items.filter(i=>i.origin).length,1);
  await finish();
}));

test("supplement must reread a changed goal before its candidate can be submitted",async()=>acceptedFixture(async({h,worker,reviewer,write,readReview})=>{
  await readReview();
  await h.flow(reviewer,"review",{checks:[{id:"C1",status:"unsupported",basis:"需要限定样例范围",
    finding:{kind:"scope",quote:"通过 19/20",fix:"标明只适用于该样例"}}]});
  await h.flow("root","advance");
  await h.file(worker,"read","overview.md");
  write("overview.md","# G2\n只交付一个标明样例边界的中文问答。\n");
  await h.file(worker,"write","candidate.md",{content:"# 样例问答\n- C1：本样例通过 19/20（出处：functional.csv 第 2 行）。\n",note:"修正适用范围"});
  await h.file(worker,"read","candidate.md");
  const quality=Object.fromEntries(Object.keys(QUALITY).map(k=>[k,"仅报告已核实样例，不推广到总体。"]));
  await assert.rejects(h.flow(worker,"submit",{quality}),/读取当前目标/);
  await h.file(worker,"read","overview.md");
  await h.file(worker,"read","functional.csv");
  assert.equal((await h.flow(worker,"submit",{quality})).phase,"final-review-ready");
}));

test("changed facts with evidence only in a later table are blocked before final review",async()=>acceptedFixture(async({h,worker,reviewer,readReview})=>{
  await readReview();
  await h.flow(reviewer,"review",{checks:[{id:"C1",status:"unsupported",basis:"需要限定样例范围",
    finding:{kind:"scope",quote:"通过 19/20",fix:"说明仅为该样例"}}]});
  await h.flow("root","advance");
  for(const name of ["overview.md","functional.csv"])await h.file(worker,"read",name);
  const quality=Object.fromEntries(Object.keys(QUALITY).map(k=>[k,"仅报告已核实的该样例，保持原始行出处和适用边界。"]));
  const candidate="# 样例\n- C1：本样例通过 19/20。\n\n| 原始数据 | functional.csv 第 2 行 |\n";
  await h.file(worker,"write","candidate.md",{content:candidate,note:"改了结论但只在后表给来源"});
  await h.file(worker,"read","candidate.md");
  await assert.rejects(h.flow(worker,"submit",{quality}),/同行引用授权证据/);
  assert.equal((await h.flow("root","status")).units[0].phase,"supplement");
  await h.file(worker,"write","candidate.md",{content:candidate.replace("19/20。","19/20（出处：functional.csv 第 2 行）。"),note:"把实际已读来源绑定到该断言"});
  await h.file(worker,"read","candidate.md");
  assert.equal((await h.flow(worker,"submit",{quality})).phase,"final-review-ready");
}));
