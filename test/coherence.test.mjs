import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fixture,host,policy} from "./helpers.mjs";
import {authority,readBytes} from "../governance/policy.mjs";
import {QUALITY,supplementChecks} from "../governance/preflight.mjs";

const ref={file:"functional.csv",start:2,end:2,quote:"19,20"};
const fact={kind:"direct",status:"supported",sourceRelation:"supports",basis:"按本例原始记录转述通过数和总数。",evidence:[ref]};
const nonfact={kind:"nonfactual",status:"supported",basis:"这是结构题名，没有提出外部事实。"};
const checks=[{id:"C1",status:"supported",file:ref.file,start:2,end:2,basis:"原始记录明确写明通过19项、总计20项。"}];
const quality=()=>({...Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"只核当前原始样例，保留边界和逐条出处。"])),
  sourceRefs:[ref],unverifiedSources:[],unlisted:[],revise:[],goalFit:{pass:true,basis:"交付当前指定样例的简明说明。"}});

function configure(write,{body="# 说明\n- C1：本例通过19/20（出处：functional.csv 第 2 行）。\n",ledger=false}={}) {
  const p=structuredClone(policy);p.units.K01.claims=["C1"];p.units.K01.calculations={};
  if(ledger){p.ledgerDocument="ledger.md";p.coordinator.write=["ledger.md"];p.coordinator.read.push("ledger.md");}
  write("BUILDING-LOOP.json",JSON.stringify(p));write("candidate.md",body);return p;
}

async function reachReviewer(h,{executorNote,reviewNote}={}) {
  const executor=(await h.flow("root","advance",{note:executorNote})).childId;
  await h.flow(executor,"prepare");await h.flow(executor,"submit");
  const reviewer=(await h.flow("root","advance",{note:reviewNote})).childId;
  const packet=await h.flow(reviewer,"prepare");return {executor,reviewer,packet};
}

test("already classified headings, hypotheses and error examples cannot create unlisted author debt",async()=>fixture(async(root,write)=>{
  configure(write,{body:"# 说明\n- C1：本例通过19/20（出处：functional.csv 第 2 行）。\n[推测] 后续可以扩大样本。\n错例：本例全部通过。\n"});
  const h=host(root,{automaticCoverage:false}),{reviewer,packet}=await reachReviewer(h);
  const parts=[nonfact,fact,{kind:"hypothesis",status:"uncertain",basis:"已经显式标为后续可能方案。"},
    {kind:"error-example",status:"unsupported",sourceRelation:"contradicts",basis:"原始记录是19/20，明确反证所展示的错误说法。",evidence:[ref]}];
  await h.coverage(reviewer,"record",{entries:packet.coverage.blocks.map((block,i)=>({block:block.id,parts:[parts[i]]}))});
  for(const line of [1,3,4])await assert.rejects(h.assess(reviewer,{...quality(),unlisted:[{line,basis:"已由coverage核过，记在这里作为索引。"}]}),/building-loop\/metadata/);
  assert.equal((await h.flow("root","status")).units[0].phase,"first-review");
  await h.assess(reviewer,quality());assert.equal((await h.flow(reviewer,"review",{checks})).phase,"first-audit-ready");
}));

test("a real unsupported factual heading remains valid repair debt",async()=>fixture(async(root,write)=>{
  configure(write,{body:"## 本例全部通过\n- C1：本例通过19/20（出处：functional.csv 第 2 行）。\n"});
  const h=host(root,{automaticCoverage:false}),{reviewer,packet}=await reachReviewer(h);
  await h.coverage(reviewer,"record",{entries:[{block:packet.coverage.blocks[0].id,parts:[{
    kind:"direct",status:"unsupported",sourceRelation:"contradicts",basis:"标题提出全部通过，与记录19/20相反。",evidence:[ref],
    finding:{kind:"contradiction",quote:"本例全部通过",fix:"把标题改为原始记录支持的通过19项、总计20项。"}}]},
    {block:packet.coverage.blocks[1].id,parts:[fact]}]});
  await h.assess(reviewer,{...quality(),unlisted:[{line:1,quote:"本例全部通过",basis:"标题内有真实但错误的数量断言，不能当结构跳过。"}]});
  const result=await h.flow(reviewer,"review",{checks});assert.equal(result.phase,"supplement-ready");
  assert.deepEqual(result.qualityRejected,["sources"]);
}));

test("unlisted checks exact mixed spans and is revalidated after coverage changes",async()=>fixture(async(root,write)=>{
  configure(write,{body:"范围说明：本例通过19项\n- C1：本例通过19/20（出处：functional.csv 第 2 行）。\n"});
  const h=host(root,{automaticCoverage:false}),{reviewer,packet}=await reachReviewer(h);const mixed=packet.coverage.blocks[0].id;
  const prefix={...nonfact,quote:"范围说明："};
  await h.coverage(reviewer,"record",{entries:[{block:mixed,parts:[prefix,{kind:"direct",quote:"本例通过19项",status:"uncertain",sourceRelation:"insufficient",
    basis:"该未编号句尚未绑定其实际证据。",finding:{kind:"missing-evidence",quote:"本例通过19项",fix:"用实际原始数据核实该句。"}}]},
    {block:packet.coverage.blocks[1].id,parts:[fact]}]});
  for(const quote of [undefined,"范围说明："])await assert.rejects(h.assess(reviewer,{...quality(),unlisted:[{line:1,quote,basis:"本行存在待核事实。"}]}),/building-loop\/metadata/);
  await h.assess(reviewer,{...quality(),unlisted:[{line:1,quote:"本例通过19项",basis:"只登记这一尚未核实的事实范围。"}]});
  await h.coverage(reviewer,"record",{entries:[{block:mixed,parts:[prefix,{...fact,quote:"本例通过19项"}]}]});
  await assert.rejects(h.flow(reviewer,"review",{checks}),/building-loop\/metadata/);
  await h.assess(reviewer,quality());assert.equal((await h.flow(reviewer,"review",{checks})).phase,"first-audit-ready");
}));

test("unlisted preflight diagnostics identify the current text location instead of implying old-line lookup",()=>{
  const spec={plainLast:false,calculations:{},phases:{"final-review":{evidence:[]}}};
  const result=supplementChecks("unused",spec,["新增前文","旧事实仍在"],[],{unlisted:[{line:1,text:"旧事实仍在",basis:"真实缺口"}]});
  assert.match(result.issues[0],/原验收第 1 行/);assert.match(result.issues[0],/当前第 2 行/);assert.match(result.issues[0],/按原文匹配/);
});

test("one rejected factual part does not make its correct prefix author repair debt",async()=>fixture(async(root,write)=>{
  configure(write,{body:"本例通过19项，全部20项均通过\n- C1：本例通过19/20（出处：functional.csv 第 2 行）。\n"});
  const h=host(root,{automaticCoverage:false}),{reviewer,packet}=await reachReviewer(h);
  await h.coverage(reviewer,"record",{entries:[{block:packet.coverage.blocks[0].id,parts:[{
    kind:"direct",status:"unsupported",sourceRelation:"contradicts",basis:"前半句对应19项记录，只有后半句声称全部通过与19/20矛盾。",evidence:[ref],
    finding:{kind:"contradiction",quote:"全部20项均通过",fix:"移除或改正与19/20矛盾的全部通过判断。"}}]},
    {block:packet.coverage.blocks[1].id,parts:[fact]}]});
  await assert.rejects(h.assess(reviewer,{...quality(),unlisted:[{line:1,quote:"本例通过19项",basis:"不能把正确前半句登记成拒绝事实。"}]}),/building-loop\/metadata/);
  await h.assess(reviewer,{...quality(),unlisted:[{line:1,quote:"全部20项均通过",basis:"只登记有明确反证的后半句。"}]});
  assert.equal((await h.flow(reviewer,"review",{checks})).phase,"supplement-ready");
}));

test("reviewer and auditor dispatch ignores coordinator answers while executor instructions remain",async()=>fixture(async(root,write)=>{
  configure(write);const h=host(root,{automaticCoverage:false}),secret="LEAK_PREVIOUS_VERDICT_24_SUPPORTED";
  const {executor,reviewer,packet}=await reachReviewer(h,{executorNote:"执行方规划保留原稿",reviewNote:secret});
  const prompt=id=>JSON.stringify(h.activations.find(row=>row.childId===id).request.prompt);
  assert.match(prompt(executor),/执行方规划保留原稿/);assert.ok(!prompt(reviewer).includes(secret));
  await h.coverage(reviewer,"record",{entries:packet.coverage.blocks.map((block,i)=>({block:block.id,parts:[i?fact:nonfact]}))});
  await h.assess(reviewer,quality());await h.flow(reviewer,"review",{checks});
  const auditor=(await h.flow("root","advance",{note:secret})).childId;assert.ok(!prompt(auditor).includes(secret));
  const second=await h.flow(auditor,"prepare");await h.coverage(auditor,"record",{entries:second.coverage.blocks.map((block,i)=>({block:block.id,parts:[i?fact:nonfact]}))});
  await h.flow(auditor,"audit");write("overview.md","# 当前目标\n仍交付原样例，但重新核对当前目标。\n");
  const final=await h.flow("root","advance",{note:secret});assert.equal(final.childId,reviewer);assert.equal(final.phase,"final-review");
  const delivery=h.notifications.filter(row=>row.target===reviewer).at(-1);assert.ok(!JSON.stringify(delivery.content).includes(secret));
  assert.match(JSON.stringify(delivery.content),/独立依据当前授权目标/);
}));

async function closeReady(h) {
  const {reviewer}=await reachReviewer(h);await h.assess(reviewer,quality());
  assert.equal((await h.flow(reviewer,"review",{checks})).phase,"ledger-review");
  await h.flow("root","prepare");
  const book=await h.ledger("root","read");
  const decisions=book.items.map(item=>item.unit||item.origin
    ?{id:item.id,outcome:"completed",basis:"当前样例已经独立核验与反证验收，完成本条对应的交付要求。",evidence:{file:"first.json",start:1,end:5}}
    :{id:item.id,outcome:"keep",basis:"后续计划仍有效，留待安排，不能用当前样例代称完成。"});
  return {book,decisions};
}

test("recording an observed unit interruption returns its existing host ledger item", async () => fixture(async (root, write) => {
  configure(write, { ledger: true });
  const h = host(root);
  const executor = (await h.flow("root", "advance")).childId;
  h.interrupt(executor);
  const before = await h.ledger("root", "read");
  const linked = await h.ledger("root", "record", { id: "duplicated-interruption", kind: "interrupted", unit: "K01",
    title: "重记同一单元中断", note: "执行已中断，等待按原单元恢复。" });
  assert.equal(linked.id, "unit-K01");
  assert.equal(linked.alreadyRecorded, true);
  assert.equal(linked.lastInterruption.phase, "intake");
  assert.deepEqual(await h.ledger("root", "read"), before);
  h.coordinator("other");
  await assert.rejects(h.ledger("other", "record", { kind: "interrupted", unit: "K01" }), /原总控持有/);
  await h.ledger("root", "export");
  const snapshot = fs.readFileSync(path.join(root, "ledger.md"), "utf8");
  assert.match(snapshot, /宿主最近中断：intake/);
  assert.doesNotMatch(snapshot, /duplicated-interruption/);
}));

test("a repeated stable ledger ID needs a fresh item version to change its content", async () => fixture(async (root, write) => {
  configure(write);
  const h = host(root);
  const original = { id: "paused-quiz", kind: "interrupted", title: "课堂测验互动", note: "曾搁置，等待当前目标复盘。" };
  const probe = { id: original.id, kind: "temporary", title: "测试", note: "测试登记" };
  await h.ledger("root", "record", original);
  const before = await h.ledger("root", "read");
  await h.ledger("root", "record", original);
  await assert.rejects(h.ledger("root", "record", probe), /编号已经存在/);
  assert.deepEqual(await h.ledger("root", "read"), before);
  const update = { ...original, note: "按新目标复核后更新说明。", expectedItemSha256: before.items[0].itemSha256 };
  assert.equal((await h.ledger("root", "record", update)).note, update.note);
  await assert.rejects(h.ledger("root", "record", { ...probe, expectedItemSha256: update.expectedItemSha256 }), /编号已经存在/);
  assert.equal((await h.ledger("root", "read")).items[0].title, original.title);
}));

test("canonical ledger exports every current item including a late request and blocks model rewrites",async()=>fixture(async(root,write)=>{
  configure(write,{ledger:true});write("ledger.md","# 原先的文档\n");const h=host(root);
  for(let i=1;i<=4;i++)await h.ledger("root","record",{id:"plan-"+i,kind:"planned",title:"后续计划"+i,note:"核验完成后再评估是否执行。"});
  h.user("root",1,"完成这份原始样例的核验与账本复盘。\n");
  const {book,decisions}=await closeReady(h);assert.equal(book.items.length,6);
  h.user("root",2,"补充：按当前项目目标一并复核原计划。\n");
  await h.flow("root","prepare");const latest=await h.ledger("root","read");
  const missing=latest.items.find(item=>!decisions.some(row=>row.id===item.id));
  decisions.push({id:missing.id,outcome:"completed",basis:"已依据当前目标逐项核对全部计划。",evidence:{file:"overview.md",start:1,end:2}});
  const result=await h.ledger("root","review",{decisions,note:"不可信的自由阶段史与随意计数不应进入宿主导出。"});
  assert.equal(result.phase,"closed");assert.equal(result.document.itemCount,7);
  assert.deepEqual([...result.document.itemIds].sort(),latest.items.map(item=>item.id).sort());
  const content=fs.readFileSync(path.join(root,"ledger.md"),"utf8");
  assert.match(content,/条目总数：7/);assert.match(content,new RegExp("账本 revision："+result.ledgerRevision));
  for(const item of latest.items)assert.ok(content.includes(item.id),item.id);
  assert.doesNotMatch(content,/不可信的自由阶段史|dispatch →/);
  assert.equal(fs.readFileSync(path.join(root,".building-loop/latest_backup/ledger.md"),"utf8"),"# 原先的文档\n");
  await assert.rejects(h.file("root","write","ledger.md",{content:"只列六项",note:"改写"}),/宿主生成/);
  assert.ok(!(await h.file("root","list")).write.includes("ledger.md"));
  const replay=await h.ledger("root","export");assert.equal(replay.changed,false);assert.equal(replay.itemCount,7);
}));

test("configured ledger export failure keeps the workflow open and leaves dispositions unapplied",async()=>fixture(async(root,write)=>{
  configure(write,{ledger:true});const h=host(root),{decisions}=await closeReady(h);
  fs.mkdirSync(path.join(root,"ledger.md"));
  await assert.rejects(h.ledger("root","review",{decisions}));
  assert.equal((await h.flow("root","status")).units[0].phase,"ledger-review");
  assert.equal((await h.ledger("root","read")).items.find(item=>item.id==="unit-K01").status,"running");
  fs.rmdirSync(path.join(root,"ledger.md"));
  assert.equal((await h.ledger("root","review",{decisions})).document.exported,true);
}));

test("host-state commit failure restores the generated ledger, history and rolling backups",async()=>fixture(async(root,write)=>{
  configure(write,{ledger:true});write("ledger.md","# 旧版账本\n");
  const h=host(root),{decisions}=await closeReady(h);await h.ledger("root","export");
  const paths=["ledger.md",".building-loop/changes/ledger.md.md",".building-loop/latest_backup/ledger.md",
    ".building-loop/latest_backup/.building-loop/changes/ledger.md.md"];
  const before=paths.map(file=>readBytes(root,file));
  const stateDirectory=path.join(process.env.DSH_HOME,"building-loop-state");
  const stateFile=fs.readdirSync(stateDirectory).find(file=>file.endsWith(".json"));
  const stateBefore=fs.readFileSync(path.join(stateDirectory,stateFile));
  const original=fs.renameSync;let injected=false;
  fs.renameSync=(from,to)=>{
    if(path.resolve(to)===path.join(stateDirectory,stateFile)){injected=true;throw new Error("synthetic host-state commit failure");}
    return original(from,to);
  };
  try{await assert.rejects(h.ledger("root","review",{decisions}),/synthetic host-state commit failure/);}
  finally{fs.renameSync=original;}
  assert.equal(injected,true);
  assert.deepEqual(fs.readFileSync(path.join(stateDirectory,stateFile)),stateBefore);
  paths.forEach((file,i)=>assert.deepEqual(readBytes(root,file),before[i],file));
  assert.equal((await h.flow("root","status")).units[0].phase,"ledger-review");
  assert.equal((await h.ledger("root","review",{decisions})).phase,"closed");
}));

test("ledger export requires an explicit safe authorized path and leaves legacy narrative untouched",async()=>fixture(async(root,write)=>{
  const p=configure(write);write("ledger.md","# 人工叙事保留\n");const h=host(root);
  assert.equal((await h.ledger("root","export")).configured,false);
  assert.equal(fs.readFileSync(path.join(root,"ledger.md"),"utf8"),"# 人工叙事保留\n");
  for(const destination of ["ledger.md","overview.md","candidate.md","functional.csv","first.json","../outside.md"]) {
    const next=structuredClone(p);next.ledgerDocument=destination;
    next.coordinator.write=destination==="ledger.md"?[]:[destination];write("BUILDING-LOOP.json",JSON.stringify(next));
    assert.throws(()=>authority(root),destination);
  }
}));

test("a shared workspace never returns another coordinator's projection metadata or unit checkpoint",async()=>fixture(async(root,write)=>{
  configure(write,{ledger:true});const h=host(root);h.coordinator("second-root");
  await h.flow("root","advance");
  await h.ledger("root","record",{id:"plan-a",kind:"planned",title:"总控甲的计划",note:"由甲按自己的项目现状复盘。"});
  await h.ledger("second-root","record",{id:"plan-b",kind:"planned",title:"总控乙的计划",note:"由乙按自己的项目现状复盘。"});
  const first=await h.ledger("root","export");assert.ok(first.itemIds.includes("plan-a"));
  const second=await h.ledger("second-root","export");assert.deepEqual(second.itemIds,["plan-b"]);
  assert.doesNotMatch(fs.readFileSync(path.join(root,"ledger.md"),"utf8"),/plan-a|unit-K01/);
  const own=await h.ledger("root","read");assert.equal(own.document.projection,null);
  assert.ok(own.items.every(item=>item.owner==="root"));assert.equal(own.current.unit,"K01");
  await assert.rejects(h.ledger("second-root","read",{unit:"K01"}),/其他总控持有/);
  const other=await h.ledger("second-root","read",{unit:undefined});
  assert.deepEqual(other.document.projection.itemIds,["plan-b"]);assert.equal(other.current,null);
}));
