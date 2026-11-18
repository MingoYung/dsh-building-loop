import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { coverageAction, coverageSummary } from "../governance/coverage.mjs";
import { evidenceReference, workingClaimLocations } from "../governance/evidence.mjs";
import { groundedOriginalReceipt, originalRecheckSchema, ORIGINAL_RECHECK_TOOL } from "../governance/original-review-proof.mjs";
import { goalSnapshot } from "../governance/goals.mjs";
import { authority, digest, keyOf } from "../governance/policy.mjs";
import { lineList, QUALITY } from "../governance/preflight.mjs";
import { workspaceStateFile } from "../governance/session-mode.mjs";
import { fixture, host, policy } from "./helpers.mjs";

const material = "forward.md";
const report = "official.md";
const materialQuote = "内部转发登记编号 PR-07，转发称项目已经开工。";
const externalQuote = "项目状态：尚未开工。";
const materialStatement = "[材料转述] 转发件称项目已经开工（出处：forward.md 第2行）。";
const externalStatement = "独立报告记载项目尚未开工（出处：official.md 第2行）。";

function materialPolicy() {
  const config = structuredClone(policy), unit = config.units.K01;
  unit.claims = [];
  unit.calculations = {};
  unit.requireSourcePins = true;
  config.sourcePins = {
    [report]: {kind:"primary",locator:"archive:official-report",sha256:digest(Buffer.from("# 发布记录\n" + externalQuote + "\n"))},
  };
  for (const phase of Object.values(unit.phases)) {
    phase.read.push(material,report);
    phase.materials = [material];
    if (phase.evidence) phase.evidence = [report];
  }
  return config;
}

function reviewer(root, phase, bindGoal = false) {
  const policy = authority(root), spec = policy.units.K01;
  const frame = {root,policy,reads:spec.phases[phase].read};
  const active = {phase,seen:{}};
  if (bindGoal) active.goal = goalSnapshot(frame);
  const read = file => {
    const bytes = fs.readFileSync(path.join(root,file));
    active.seen[keyOf(file)] = {hash:digest(bytes),ranges:[[1,lineList(bytes).length]]};
  };
  for (const file of [spec.candidate,report]) read(file);
  const invoke = (action,args={}) => coverageAction(frame,active,spec,{action,...args});
  const inventory = invoke("inventory"), {blocks} = inventory;
  const record = (index,part) => invoke("record",{entries:[{block:blocks[index].id,parts:[part]}]});
  return {frame,active,spec,read,record,inventory,summary:(complete = true) => coverageSummary(frame,active,spec,complete)};
}

const asMaterial = {kind:"direct",assertion:"material-attribution",status:"supported",sourceRelation:"supports",
  basis:"只支持转发件自身声称已经开工。",evidence:[{file:material,start:2,end:2,quote:materialQuote}]};
const asExternal = {kind:"direct",assertion:"original-fact",status:"supported",sourceRelation:"supports",
  basis:"独立报告明示当前的实际项目状态。",evidence:[{file:report,start:2,end:2,quote:externalQuote}]};

test("both review roles can verify a read-only forward as material while separately proving the actual state", async () => fixture((root,write) => {
  write("BUILDING-LOOP.json",JSON.stringify(materialPolicy()));
  write(material,"# 编辑转发\n" + materialQuote + "\n");
  write(report,"# 发布记录\n" + externalQuote + "\n");
  write("candidate.md",materialStatement + "\n" + externalStatement + "\n");
  for (const phase of ["final-review","final-audit"]) {
    const review = reviewer(root,phase);
    const {frame,active,spec} = review;
    assert.throws(()=>review.record(0,asMaterial),/实际读过/);
    review.read(material);
    assert.throws(()=>review.record(0,{...asMaterial,assertion:"original-fact"}),/不在本轮证据授权/);
    assert.throws(()=>review.record(0,{...asMaterial,evidence:[{file:material,start:1,end:1,quote:materialQuote}]}),/逐字/);
    assert.throws(()=>review.record(1,asMaterial),/\[材料转述\]/);
    assert.throws(()=>review.record(0,{kind:"nonfactual",status:"supported",basis:"只是没有证据的转发。"}),/\[材料转述\]/);
    assert.throws(()=>evidenceReference(frame,active,spec,{file:material,start:2,end:2}),/不在本轮证据授权/);
    review.record(0,asMaterial);
    review.record(1,asExternal);
    const completed = review.summary();
    assert.equal(completed.rejected.length,0);
    assert.equal(completed.records[0].parts[0].proofObject,"working-material");
    assert.equal(completed.records[0].parts[0].evidence[0].origin.kind,"working-material");
    assert.equal(completed.records[1].parts[0].proofObject,"external");
    write(material,"# 编辑转发\n" + materialQuote + "\n第三行后续补记。\n");
    assert.throws(()=>review.summary(),/实际读过/);
    review.read(material);
    assert.throws(()=>review.summary(),/版本(?:已经|已)变化/);
    write(material,"# 编辑转发\n" + materialQuote + "\n");
  }
}));

test("policy rejects material grant without read scope or with authority to modify or verify it as external", async () => fixture((root,write) => {
  const config = materialPolicy();
  const failures = [
    [p=>p.units.K01.phases.intake.read=p.units.K01.phases.intake.read.filter(file=>file!==material),/当前阶段可读/],
    [p=>p.coordinator.write=[material],/不能授予模型写权/],
    [p=>p.units.K01.phases["first-review"].materials.push(report),/与外部证据/],
    [p=>p.units.K01.phases.intake.materials.push(p.units.K01.candidate),/与外部证据/],
  ];
  for (const [change,reason] of failures) {
    const modified=structuredClone(config);
    change(modified);
    write("BUILDING-LOOP.json",JSON.stringify(modified));
    assert.throws(()=>authority(root),reason);
  }
}));

test("editorial comparison points to unique visible original numbered claims", () => fixture((root, write) => {
  const config = materialPolicy();
  config.units.K01.claims = ["C1", "C2", "C3"];
  write("BUILDING-LOOP.json", JSON.stringify(config));
  write(material, "# 来稿\n- C1 一处待核说法\n- **C2**：一处说法\n- C2：重复编号\n```text\n- C3：隐藏示例\n```\n");
  const actual = authority(root), spec = actual.units.K01;
  const active = { phase: "first-review", seen: {} };
  const frame = { root, reads: spec.phases[active.phase].read };
  assert.deepEqual(workingClaimLocations(frame, active, spec), [{ id: "C1", file: material, line: 2 }]);
  assert.deepEqual(active.seen, {});
}));

test("editorial inventory pairs the original with separate revised assertions and authenticates visible excerpts per role", () => fixture((root, write) => {
  const config = materialPolicy();
  config.goalContext = ["overview.md"];
  config.units.K01.claims = ["C1"];
  const original = "- C1 一条原稿说法。";
  const candidate = "- C1：保留。实际状态需要核明。另一项新说法也必须独立核验（出处：official.md 第2行）。\n";
  write("BUILDING-LOOP.json", JSON.stringify(config));
  write("overview.md", "逐项提交保留／改正／待证。保留表示可用，改正表示可纠正，待证表示证据不足。\n");
  write(material, original + "\n");
  write(report, "# 发布记录\n" + externalQuote + "\n");
  write("candidate.md", candidate);
  for (const phase of ["final-review", "final-audit"]) {
    const {frame,active,spec,read} = reviewer(root, phase, true);
    delete active.seen[keyOf(report)];
    const page = (options) => coverageAction(frame, active, spec, {action:"inventory",offset:1,count:2}, options);
    const unseen = page();
    assert.deepEqual(unseen.blocks.map(block => block.editorialClaim), ["C1", "C1"]);
    assert.equal(unseen.blocks.length, 2);
    assert.ok(unseen.blocks[1].text.includes("另一项新说法"));
    assert.equal(unseen.editorialRows.length, 1);
    assert.deepEqual(unseen.editorialRows[0].incoming.next,
      {tool:"building_loop_file",action:"read",path:material,start:1,count:1});
    assert.equal(unseen.editorialRows[0].incoming.quote, undefined);
    assert.deepEqual(unseen.editorialRows[0].citations, [{file:report,start:2,end:2,object:"external"}]);
    assert.equal(active.seen[keyOf(material)], undefined);
    assert.equal(active.seen[keyOf(report)], undefined);

    read(material);
    read(report);
    const observed = page();
    assert.equal(observed.editorialRows[0].incoming.quote, original);
    assert.equal(observed.editorialRows[0].citations[0].quote, externalQuote);
    const limited = page({maxBytes: 16 * 1024});
    assert.deepEqual(limited.editorialRows, observed.editorialRows);

    write(material, original.replace("原稿", "已换版"));
    assert.equal(page().editorialRows[0].incoming.quote, undefined);
    write(material, original + "\n");
  }
}));

test("each review binds the declared editorial verdict separately from the original fact and associated prose", () => fixture((root, write) => {
  const config = materialPolicy();
  config.goalContext = ["overview.md"];
  config.units.K01.claims = ["C1", "C2", "C3"];
  const clause = "逐项提交保留／改正／待证。保留表示原话可用，改正表示原话有错且证据能给出修法，待证表示证据不足。";
  const original = "- C1 项目尚未开工。\n- C2 项目已开工。\n- C3 项目原定五月开工。\n";
  const candidate = "- C1：改正。\n- C2：改正，报告记载已经开工（出处：official.md 第2行）。\n- C3：待证。\n";
  write("BUILDING-LOOP.json", JSON.stringify(config));
  write("overview.md", "# 总纲\n" + clause + "\n");
  write(material, original);
  write(report,"# 发布记录\n" + externalQuote + "\n");
  write("candidate.md", candidate);

  const evidence = asExternal.evidence;
  const project = basis => ({kind:"inference", assertion:"project-application", status:"supported", sourceRelation:"supports", basis,
    inference:{rule:"project-policy", premises:evidence, scope:"同一项目的原话及报告范围", assumptions:[],
      counterexample:{possible:false,reason:"本角色在所引报告中核过当前状态的含义，也区分它与开工计划。"}}});
  const wrong = (part, quote, fix, contradictingEvidence) => ({...part, status:"unsupported", sourceRelation:"contradicts",
    finding:{kind:"contradiction",quote,fix},...(contradictingEvidence?{evidence:contradictingEvidence}:{})});
  for (const phase of ["final-review", "final-audit"]) {
    const review = reviewer(root, phase, true);
    const {frame, active, spec, inventory} = review;
    const [c1,c2,c3] = inventory.blocks;
    assert.deepEqual(inventory.blocks.map(block => block.editorial), [
      {id:"C1",decision:"改正",original:{id:"C1",file:material,line:1}},
      {id:"C2",decision:"改正",original:{id:"C2",file:material,line:2}},
      {id:"C3",decision:"待证",original:{id:"C3",file:material,line:3}},
    ]);
    for (const block of inventory.blocks) {
      assert.throws(() => coverageAction(frame,active,spec,{action:"record",entries:[{block:block.id,
        parts:[{kind:"nonfactual",status:"supported",basis:"只看成普通标题。"}]}]}), /处置须单列.*来稿和外部依据/u);
    }
    const wrongLabel = wrong(project("来稿已经与报告一致，没有依据要求改正。"),"改正","把原先正确的处置改回保留。");
    assert.throws(() => review.record(0,wrongLabel), /实际读过/u);
    review.read(material);
    assert.throws(() => review.record(0,wrongLabel), /本角色已读的当前总纲/u);
    review.read("overview.md");
    const fakePremise = {file:material,start:1,end:1,quote:"项目尚未开工。"};
    assert.throws(() => review.record(0,{...wrongLabel,inference:{...wrongLabel.inference,premises:[fakePremise]}}), /不在本轮证据授权/u);
    assert.throws(() => review.record(0,{...wrongLabel,finding:{...wrongLabel.finding,quote:"C1"}}), /须含被判错的处置标签/u);
    const validCorrection = project("来稿称已开工，可信报告反证它，所以应判改正；修改后的正文仍然要核。");
    validCorrection.inference.policy = [{file:"overview.md",start:2,end:2,quote:"改正表示原话有错且证据能给出修法"}];
    assert.throws(() => review.record(1,validCorrection), /处置须单列/u);
    const c2Label = "- C2：改正，";
    const c2Body = c2.text.slice(c2Label.length);
    const wrongBody = wrong({...asExternal,quote:c2Body,basis:"报告明确写尚未开工，这一尾句却说已经开工。"},
      "已经开工","恢复报告中尚未开工这一事实。",evidence);
    coverageAction(frame,active,spec,{action:"record",entries:[
      {block:c1.id,parts:[wrongLabel]},
      {block:c2.id,parts:[{...validCorrection,quote:c2Label},wrongBody]},
      {block:c3.id,parts:[project("报告只证明实际状态，既不证明也不否认原定五月开工；不能把实际状态借给原定时间。")]}]});
    const summary = review.summary();
    assert.deepEqual(summary.rejected.map(row => [row.line,row.finding.quote]), [[1,"改正"],[2,"已经开工"]]);
    const [disposition,fact] = summary.records[1].parts;
    assert.equal(disposition.editorialOriginal.provenance,"observed-working-material");
    assert.equal(disposition.inference.policy[0].quote,clause);
    assert.equal(disposition.inference.premises[0].origin.kind,"primary");
    assert.equal(fact.proofObject,"external");

    // Reopening a saved checkpoint from before the new proof gate must not
    // silently legitimize a formerly structural label or use the other role.
    active.coverage.records[c1.id].parts = [{quote:c1.text,start:0,end:c1.text.length,kind:"nonfactual",status:"supported"}];
    const refreshed = coverageAction(frame,active,spec,{action:"inventory"});
    assert.deepEqual(refreshed.pending,[c1.id]);
    write(material, original + "后续来稿更新。\n");
    assert.throws(() => review.summary(false), /实际读过/u);
    review.read(material);
    assert.throws(() => review.summary(false), /原来稿版本已变化/u);
    write(material, original);
  }
}));

test("material scope splits a leading disposition and carries only expressly attributed same-sentence references", () => fixture((root, write) => {
  const prefix = "编辑核对：";
  const quote = "[材料转述] 据 forward.md 第 2 行，转发声称已开工；";
  const continued = "第 3 行称没有附现场记录。";
  const unbound = "项目真的已经开工。";
  const thirdLine = "转发称没有附现场记录。";
  write("BUILDING-LOOP.json", JSON.stringify(materialPolicy()));
  write(material, "# 编辑转发\n" + materialQuote + "\n" + thirdLine + "\n");
  write(report, "# 发布记录\n" + externalQuote + "\n");
  write("candidate.md", prefix + quote + continued + unbound + "\n");

  for (const phase of ["final-review", "final-audit"]) {
    const review = reviewer(root, phase);
    review.read(material);
    const input = coverageAction(review.frame, review.active, review.spec, { action: "inventory" });
    assert.deepEqual(input.blocks[0].materialAttribution, { start: prefix.length, quote, separateQuote: prefix,
      locator:{file:material,start:2,end:2} });
    assert.deepEqual(input.blocks[1].materialAttribution, { start: 0, quote: continued, file: material, line: 3 });
    assert.equal(input.blocks[2].materialAttribution, undefined);
    assert.throws(() => review.record(0, asMaterial), /separateQuote/u);
    coverageAction(review.frame, review.active, review.spec, { action: "record", entries: [{ block: input.blocks[0].id,
      parts: [{ kind: "nonfactual", status: "supported", quote: prefix, basis: "只标明当前核对环节" }, { ...asMaterial, quote }] }] });
    assert.throws(() => review.record(1, asMaterial), /归给原材料行/u);
    review.record(1, { ...asMaterial, evidence: [{ file: material, start: 3, end: 3, quote: thirdLine }] });
    assert.throws(() => review.record(2, asMaterial), /\[材料转述\]/u);
    review.summary(false);
  }
  write("candidate.md", quote + "项目真的已经开工。\n");
  const review = reviewer(root, "final-review");
  review.read(material);
  assert.throws(() => review.record(1, asMaterial), /\[材料转述\]/u);
}));

test("a mixed block keeps its id and binds the uniquely cited transfer excerpt without retyping either span", () => fixture((root, write) => {
  const transfer = "# 转发件\n" + materialQuote + "\n";
  const decision = "报告说项目尚未开工：";
  const marked = "[材料转述] 据 forward.md 第 2 行，转发声称已开工；";
  const original = decision + marked + "本文仅列待核项目。\n";
  write("BUILDING-LOOP.json",JSON.stringify(materialPolicy()));
  write(material, transfer);
  write(report,"# 发布记录\n" + externalQuote + "\n");
  write("candidate.md",original);
  const { evidence: _manual, ...fromLocator } = asMaterial;
  const decide = { ...asExternal, basis: "独立报告写的是实际状态。" };
  for (const phase of ["final-review","final-audit"]) {
    const review = reviewer(root,phase);
    const {frame,active,spec,inventory} = review;
    assert.deepEqual(inventory.blocks[0].materialAttribution.next, {
      tool:"building_loop_file",action:"read",path:material,start:2,count:1,
    });
    const record = (transferPart = fromLocator) => coverageAction(frame,active,spec,{action:"record",entries:[
      {block:inventory.blocks[0].id,parts:[decide,transferPart]},
    ]});
    assert.throws(() => record(), /本角色实际读过当前行/u);
    review.read(material);
    assert.throws(() => record({...fromLocator,evidence:asExternal.evidence}), /候选标出且经授权的同一原文行/u);
    assert.throws(() => record({...fromLocator,evidence:[{file:material,start:2,end:2,quote:"文档声称已经完工。"}]}), /逐字出现在/u);
    assert.throws(() => record({...fromLocator,quote:marked.slice(1)}), /拆分遗漏/u);
    const accepted = record();
    assert.deepEqual(accepted.recorded,[inventory.blocks[0].id]);
    assert.deepEqual(accepted.pending,[inventory.blocks[1].id]);
    const saved = review.summary(false).records[0].parts;
    assert.deepEqual(saved.map(part=>part.quote),[decision,marked]);
    assert.equal(saved[1].evidence[0].quote,materialQuote);
    assert.equal(saved[0].evidence[0].origin.kind,"primary");
    assert.equal(saved[1].evidence[0].origin.kind,"working-material");
    write(material, transfer.replace("开工", "结束"));
    assert.throws(() => record(), /本角色实际读过当前行/u);
    write(material, transfer);
  }

  const invalid = marked.replace("第 2 行", "第 99 行");
  write("candidate.md", decision + invalid + "\n");
  for (const [phase, kind] of [["final-review", "missing-evidence"], ["final-audit", "scope"]]) {
    const { frame, active, spec, inventory, summary } = reviewer(root, phase);
    const block = inventory.blocks[0];
    assert.equal(block.materialAttribution.locatorIssue, "候选所列的待核材料或行号不存在。");
    const record = transferPart => coverageAction(frame, active, spec, { action:"record", entries:[
      {block:block.id,parts:[decide,transferPart]},
    ] });
    const finding = { kind, quote:invalid, fix:"修正转发件行号，逐字标出实际原文位置。" };
    const rejected = { ...fromLocator, status:"unsupported", sourceRelation:"insufficient", finding };
    assert.throws(() => record(fromLocator), /行号不存在/u);
    assert.throws(() => record({...rejected,evidence:asExternal.evidence}), /行号不存在/u);
    assert.throws(() => record({...rejected,finding:{...finding,kind:"contradiction"}}), /行号不存在/u);
    assert.deepEqual(record(rejected).recorded,[block.id]);
    assert.deepEqual(summary().rejected.map(({finding})=>finding),[finding]);
    assert.deepEqual(summary().records[0].parts[1].evidence,[]);
  }

  const inventoryFor = draft => {
    write("candidate.md",draft + "\n");
    return reviewer(root,"final-review").inventory.blocks[0].materialAttribution;
  };
  assert.equal(inventoryFor('他只是引用「[材料转述] 据 forward.md 第 2 行，不能据此判断」。').locator,undefined);
  assert.equal(inventoryFor(decision + marked.replace("forward.md","unknown.md")).locator,undefined);
  assert.equal(inventoryFor(decision + marked.replace("声称已开工；","对照 forward.md 第 3 行才知道；")).locator,undefined);
  assert.equal(inventoryFor(decision + marked.replace("声称已开工；","对照 `official.md`:2 才知道；")).locator,undefined);
  assert.equal(inventoryFor(decision + marked.replace("第 2 行","第 2–3 行")).locator,undefined);
}));

test("one numbered line can cite a transfer's exact words and an independent source with separate scope", async () => fixture((root,write) => {
  write("BUILDING-LOOP.json",JSON.stringify(materialPolicy()));
  write(material,"# 编辑转发\n" + materialQuote + "\n");
  write(report,"# 发布记录\n" + externalQuote + "\n");
  const excerpt = "[材料转述] 转发原文：“" + materialQuote + "”（出处：forward.md 第2行）。";
  write("candidate.md","- C8：待证。" + excerpt + externalStatement + "\n");
  const review = reviewer(root,"final-review");
  review.read(material);
  review.record(0,{kind:"nonfactual",status:"supported",basis:"编号后的待证标签只标明处置栏目。"});
  review.record(1,asMaterial);
  // The punctuation inside the literal quote splits its adjacent locator into a separate block.
  review.record(2,{kind:"nonfactual",status:"supported",basis:"这一块仅包含引号和已读材料的合法定位。"});
  review.record(3,asExternal);
  const coverage = review.summary();
  assert.equal(coverage.records.length,4);
  assert.equal(coverage.rejected.length,0);
  assert.equal(coverage.quotations[0].matches,true);
  assert.equal(coverage.quotations[0].refs[0].origin.kind,"working-material");
}));

test("a numbered material-only statement needs its own scope and proof from both roles", () => fixture(async (root,write) => {
  const config = materialPolicy();
  config.units.K01.claims = ["C1"];
  for (const phase of ["first-review","final-review"]) config.units.K01.phases[phase].evidence = [];
  write("BUILDING-LOOP.json",JSON.stringify(config));
  write(material,"# 编辑转发\n" + materialQuote + "\n");
  write(report,"# 发布记录\n" + externalQuote + "\n");
  write("candidate.md","C1：" + materialStatement + "\n");
  const h = host(root,{automaticCoverage:false});
  const worker = (await h.flow("root","advance")).childId;
  const work = await h.flow(worker,"prepare");
  assert.deepEqual(work.workingMaterials.files,[material]);
  await h.flow(worker,"submit");
  const reviewer = (await h.flow("root","advance")).childId;
  const proof = async role => {
    const packet = await h.flow(role,"prepare");
    assert.equal(packet.workingMaterials.coverage.assertion,"material-attribution");
    assert.equal(packet.coverage.blocks.length,1);
    const key = packet.coverage.blocks[0].id;
    const parts = [{kind:"nonfactual",status:"supported",quote:"C1：",basis:"这是编号。"},
      {...asMaterial,quote:materialStatement}];
    const accepted = await h.coverage(role,"record",{entries:[{block:key,parts}]});
    assert.deepEqual(accepted.pending,[],JSON.stringify(accepted.invalid));
    return key;
  };
  const block = await proof(reviewer);
  await h.assess(reviewer,{...Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"已核当前来稿及所述材料。"])),
    sourceRefs:[],goalFit:{pass:true,basis:"当前目标只要求核对内部附件内容。"},unverifiedSources:[],unlisted:[],revise:[]});
  const review = await h.flow(reviewer,"review",{checks:[{id:"C1",status:"supported",useCoverage:true,
    basis:"编号行只转述当前内部附件，已单独核证原句。"}]});
  assert.equal(review.phase,"first-audit-ready");
  const receipt=JSON.parse(fs.readFileSync(path.join(root,"first.json"),"utf8"));
  assert.deepEqual(receipt.observedSources,[]);
  assert.deepEqual(receipt.checks[0].supportOrigin,{kind:"same-reviewer-coverage",proofObject:"working-material",blocks:[block]});
  const auditor=(await h.flow("root","advance")).childId;
  assert.notEqual(auditor,reviewer);
  await assert.rejects(h.flow(auditor,"audit"),/读取|未核/);
  await proof(auditor);
  const result=await h.flow(auditor,"audit");
  assert.notEqual(result.phase,"supplement-ready");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,"first.json"),"utf8")).independentAudit.auditor,auditor);
}));

function originalFirstPolicy() {
  const config = materialPolicy();
  config.goalContext = ["overview.md"];
  Object.assign(config.units.K01,{claims:["C1"],plainLast:false,originalFirst:true});
  return config;
}

function setOriginalFirstFixtures(write, label) {
  write("BUILDING-LOOP.json",JSON.stringify(originalFirstPolicy()));
  write("overview.md","逐项提交保留／改正／待证。保留表示原话可用，改正表示原话有错且证据能给出修法，待证表示证据不足。\n");
  write(material,"- C1 项目尚未开工。\n");
  write(report,"# 发布记录\n" + externalQuote + "\n");
  write("candidate.md","- C1：" + label + "。" + externalStatement + "\n");
}

test("source-first review withholds the candidate until each reviewer saves a current independent decision", () => fixture(async (root,write) => {
  setOriginalFirstFixtures(write, "保留");
  const h=host(root,{automaticCoverage:false});
  const worker=(await h.flow("root","advance")).childId;
  await h.flow(worker,"prepare");
  await h.flow(worker,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  const origin={id:"C1",decision:"保留",basis:"独立报告证实原稿所称项目尚未开工。",evidence:asExternal.evidence};
  async function checkOriginal(role) {
    const packet=await h.flow(role,"prepare");
    assert.equal(packet.originalReview.pending,1);
    assert.match(packet.originalReview.items[0].quote,/项目尚未开工/u);
    assert.ok(packet.files.every(({ path })=>path!=="candidate.md"));
    assert.equal(packet.coverage,undefined);
    await assert.rejects(h.file(role,"read","candidate.md"),/改稿尚未开放/u);
    await assert.rejects(h.file(role,"search","candidate.md",{query:"独立报告记载"}),/改稿尚未开放/u);
    const found=await h.file(role,"search",undefined,{query:"独立报告记载"});
    assert.deepEqual(found.matches,[]);
    await assert.rejects(h.coverage(role,"inventory"),/改稿尚未开放/u);
    await assert.rejects(h.coverage(role,"original-record",{originals:[{...origin,decision:"改正",quote:"项目已完成"}]}),/逐字唯一/u);
    await assert.rejects(h.coverage(role,"original-record",{originals:[{...origin,evidence:[{file:material,start:1,end:1,quote:"项目尚未开工。"}]}]}),/证据授权/u);
    const saved=await h.coverage(role,"original-record",{originals:[origin]});
    assert.equal(saved.pending,0);
    const review=await h.flow(role,"prepare");
    const [label, fact]=review.coverage.blocks;
    assert.equal(label.editorial.decision,"保留");
    assert.ok(!review.coverage.pending.includes(label.id));
    assert.ok(review.coverage.pending.includes(fact.id));
    const stored=(await h.coverage(role,"status",{block:label.id})).record.parts[0];
    assert.equal(stored.originalDisposition.owner.actor,role);
    assert.equal(stored.originalDisposition.decision,"保留");
    assert.equal(stored.status,"supported");
    await assert.rejects(h.coverage(role,"original-record",{originals:[origin]}),/不能改写/u);
    const recorded=await h.coverage(role,"record",{entries:[{block:fact.id,parts:[asExternal]}]});
    assert.deepEqual(recorded.pending,[]);
  }
  await checkOriginal(reviewer);
  await h.assess(reviewer,{...Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"独立核对来稿及实际出处。"])),
    sourceRefs:[{file:report,start:2,end:2}],goalFit:{pass:true,basis:"当前候选保留有证据支持的原稿。"},unverifiedSources:[],unlisted:[],revise:[]});
  const first=await h.flow(reviewer,"review",{checks:[{id:"C1",status:"supported",useCoverage:true,
    basis:"保留的原稿说法有本轮独立来源。"}]});
  assert.equal(first.phase,"first-audit-ready");
  const auditor=(await h.flow("root","advance")).childId;
  assert.notEqual(auditor,reviewer);
  await h.flow(auditor,"prepare");
  await assert.rejects(h.flow(auditor,"audit"),/改稿尚未开放/u);
  await checkOriginal(auditor);
  const audit=await h.flow(auditor,"audit");
  assert.notEqual(audit.phase,"supplement-ready");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,"first.json"),"utf8")).independentAudit.auditor,auditor);
}));

for (const scenario of ["agreement","evidence","project-rule","mixed","legacy-handoff"]) {
  test("opposite original receipts reconcile independently before executor repair: "+scenario, () => fixture(async (root,write) => {
    setOriginalFirstFixtures(write,"保留");
    const h=host(root,{automaticCoverage:false});
    const worker=(await h.flow("root","advance")).childId;
    await h.flow(worker,"prepare");
    await h.flow(worker,"submit");
    const reviewer=(await h.flow("root","advance")).childId;
    const row = decision => ({id:"C1",decision,basis:"本轮实际核对登记的独立项目状态。",
      evidence:asExternal.evidence});
    const recheck = (decision,scope) => ({id:"C1",evidence:asExternal.evidence,sourceRelation:decision==="保留"?"supports":"insufficient",
      grounds:scope==="project-rule"?"project-rule":decision==="保留"?"source-statement":"missing-premise",
      ...(scope==="project-rule"?{policy:{file:"overview.md",start:1,end:1,quote:"待证表示证据不足"}}:{})});
    await h.flow(reviewer,"prepare");
    await h.coverage(reviewer,"original-record",{originals:[row("保留")]});
    const p=await h.flow(reviewer,"prepare");
    await h.coverage(reviewer,"record",{entries:[{block:p.coverage.blocks[1].id,parts:[asExternal]}]});
    await h.assess(reviewer,{...Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"已核对授权原文与这次项目状态。"])),
      sourceRefs:[{file:report,start:2,end:2}],goalFit:{pass:true,basis:"稿件交付了原始报告的判断。"},unverifiedSources:[],unlisted:[],revise:[]});
    await h.flow(reviewer,"review",{checks:[{id:"C1",status:"supported",useCoverage:true,basis:"当前原稿的项目状态有直接来源。"}]});
    const auditor=(await h.flow("root","advance")).childId;
    assert.notEqual(auditor,reviewer);
    assert.equal((await h.flow(auditor,"prepare")).originalReview.items[0].reviewer,undefined);
    const dispute=await h.coverage(auditor,"original-record",{originals:[row("待证")]});
    assert.equal(dispute.stage,"original-dispute");
    assert.equal(dispute.next.tool,ORIGINAL_RECHECK_TOOL);
    assert.deepEqual(dispute.next.calculation,{status:"required-if-selected",tool:"building_loop_calculate",action:"evaluate"});
    assert.ok(h.visible(auditor).includes(ORIGINAL_RECHECK_TOOL));
    assert.ok(!h.visible(auditor).includes("building_loop_coverage"));
    for (const outsider of ["root",worker]) {
      assert.ok(!h.visible(outsider).includes(ORIGINAL_RECHECK_TOOL));
      await assert.rejects(h.invoke(outsider,ORIGINAL_RECHECK_TOOL,{action:"original-recheck",originals:[recheck("保留","evidence")]}));
    }
    await assert.rejects(h.invoke(auditor,ORIGINAL_RECHECK_TOOL,{action:"original-record",originals:[row("保留")]}));
    await assert.rejects(h.invoke(auditor,ORIGINAL_RECHECK_TOOL,{action:"original-recheck",unit:"elsewhere",originals:[recheck("保留","evidence")]}));
    assert.deepEqual(Object.keys(dispute.items[0]),["id","original","evidence"]);
    assert.deepEqual(dispute.items[0].evidence.map(ref => [ref.file,ref.start,ref.end,ref.quote]),[[report,2,2,externalQuote]]);
    assert.ok(!JSON.stringify(dispute.items).includes(row("保留").basis),"historical judgments stay with the host");
    await assert.rejects(h.file(auditor,"read","candidate.md"),/改稿尚未开放/u);
    await assert.rejects(h.coverage(auditor,"original-recheck",{originals:[{...recheck("保留","evidence"),decision:"改正"}]}),/sourceRelation/u);
    await assert.rejects(h.coverage(auditor,"original-recheck",{originals:[row("保留")]}),/sourceRelation/u);
    await assert.rejects(h.coverage(auditor,"original-recheck",{originals:[{...recheck("保留","evidence"),
      evidence:[{...asExternal.evidence[0],quote:"出处没有这句话"}]}]}),/逐字/u);
    const a=recheck(scenario==="agreement"?"保留":"待证",scenario==="project-rule"?"project-rule":"evidence");
    const first=await h.invoke(auditor,ORIGINAL_RECHECK_TOOL,{action:"original-recheck",originals:[a]});
    assert.equal(first.phase,"review-ready");
    assert.equal((await h.flow("root","advance")).childId,reviewer);
    const blind=(await h.flow(reviewer,"prepare")).originalReview;
    assert.deepEqual(blind.items,dispute.items);
    if (scenario === "legacy-handoff") {
      // Simulate an upgrade after a named auditor voted and the reviewer had prepared the old packet.
      const statePath = path.join(process.env.DSH_HOME,"building-loop-state",workspaceStateFile(root));
      const readState = () => JSON.parse(fs.readFileSync(statePath,"utf8"));
      const currentDispute = () => readState().units.K01.originalDispute;
      const state = readState(), legacy = state.units.K01.originalDispute;
      delete legacy.view;
      const oldVote = legacy.rechecks.auditor.C1;
      delete oldVote.sourceRelation;
      oldVote.basis = "旧格式的具名依据不应随证据包重放。";
      assert.equal(oldVote.decision,"待证");
      const source = legacy.initial.auditor.C1.evidence[0];
      // A duplicate and a working-material-only receipt test the recipient's evidence grants.
      legacy.initial.auditor.C1.evidence.push({...source},{...source,file:material,quote:materialQuote});
      if (process.platform === "win32") {
        legacy.initial.auditor.C1.evidence.push({...source,file:source.file.toUpperCase()});
      }
      fs.writeFileSync(statePath,JSON.stringify(state));

      const fresh = await h.coverage(reviewer,"original-recheck",{originals:[row("改正")]});
      assert.equal(fresh.stage,"original-dispute");
      assert.equal(fresh.pending,1);
      assert.deepEqual(fresh.items,blind.items);
      const archived = currentDispute();
      assert.deepEqual(archived.previousRechecks,{reviewer:{},auditor:{C1:oldVote}});
      assert.deepEqual(archived.rechecks,{reviewer:{},auditor:{}});
      assert.equal(archived.status,"checking");

      const reviewerVote=recheck("保留","evidence"),auditorVote=recheck("保留","evidence");
      await assert.rejects(h.coverage(reviewer,"original-recheck",{originals:[{...reviewerVote,basis:"来源给出了另一项没有写在引文中的事实。"}]}),/basis/u);
      const firstFresh = await h.coverage(reviewer,"original-recheck",{originals:[reviewerVote]});
      assert.equal(firstFresh.phase,"first-audit-ready");
      assert.equal(currentDispute().status,"checking");
      assert.deepEqual(currentDispute().rechecks.auditor,{});
      assert.equal((await h.flow("root","advance")).childId,auditor);
      assert.deepEqual((await h.flow(auditor,"prepare")).originalReview.items,blind.items);
      const secondFresh = await h.coverage(auditor,"original-recheck",{originals:[auditorVote]});
      assert.equal(secondFresh.phase,"review-ready");
      const settled = currentDispute();
      assert.equal(settled.status,"settled");
      assert.deepEqual(settled.actors,{reviewer,auditor});
      assert.deepEqual(settled.previousRechecks.auditor.C1,oldVote);
      assert.equal(settled.rechecks.reviewer.C1.sourceRelation,"supports");
      assert.ok(settled.rechecks.reviewer.C1.basis.includes(externalQuote));
      assert.equal(settled.rechecks.auditor.C1.sourceRelation,"supports");
      assert.ok(settled.rechecks.auditor.C1.basis.includes(externalQuote));
      return;
    }
    const second=await h.coverage(reviewer,"original-recheck",{originals:[
      recheck("保留",["project-rule","mixed"].includes(scenario)?"project-rule":"evidence")]});
    if(scenario==="agreement") {
      assert.equal(second.phase,"review-ready");
      const resumed=await h.flow("root","advance");
      assert.equal(resumed.childId,reviewer);
      const next=await h.flow(reviewer,"prepare");
      assert.equal(next.coverage.blocks[0].editorial.independentOriginal.decision,"保留");
      assert.ok(next.coverage.blocks[0].editorial.independentOriginal.basis.includes(externalQuote));
      assert.ok(h.visible(reviewer).includes("building_loop_coverage"));
      assert.ok(!h.visible(reviewer).includes(ORIGINAL_RECHECK_TOOL));
      // Modify the evidence at the same path and refresh the pin. Both old
      // reconciled opinions are now stale, including the actor's proven label.
      const data="# 发布记录\n"+externalQuote+"\n补记：同一来源更新。\n";
      write(report,data);
      const changed=(await h.flow(reviewer,"prepare")).originalReview;
      assert.equal(changed.pending,1);assert.equal(changed.stage,"originals");
      await assert.rejects(h.coverage(reviewer,"original-record",{originals:[row("保留")]}),/摘要|版本/u);
      const policy=originalFirstPolicy(), url="https://example.org/official-report";
      const acquisition=JSON.stringify({sources:[{snapshot:report,snapshotSha256:digest(data),status:200,finalUrl:url,
        fetchedAt:"2026-11-18T00:00:00Z",responseSha256:digest(data),exactQuotes:[externalQuote]}]});
      write("acquisition.json",acquisition);
      Object.assign(policy.sourcePins[report],{sha256:digest(data),locator:url,observation:{file:"acquisition.json",sha256:digest(acquisition)}});
      write("BUILDING-LOOP.json",JSON.stringify(policy));
      const newWork=await h.flow("root","advance");
      assert.equal(newWork.childId,worker);
      await h.flow(worker,"prepare");await h.flow(worker,"submit",{quality:
        Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"原执行方已按新来源核对材料、处置和读者说明。"]))});
      const newReview=await h.flow("root","advance");
      assert.equal(newReview.childId,reviewer);
      assert.equal((await h.flow(reviewer,"prepare")).originalReview.pending,1);
      return;
    }
    assert.equal(second.phase,"blocked");
    assert.equal(second.gaps[0].reason,scenario==="project-rule"?"project-rule":"evidence");
    assert.equal(second.gaps[0].auditor.evidence[0].file,report);
    assert.equal((await h.flow("root","status")).units[0].next,null);
    await assert.rejects(h.flow("root","advance"),/原稿定点对账/u);
    write("candidate.md","- C1：改正。"+externalStatement+"\n");
    await assert.rejects(h.flow("root","advance"),/原稿定点对账/u);
    write("overview.md","逐项提交保留／改正／待证。保留表示一份报告足够，改正表示原话有错，待证表示证据不足。\n");
    const restarted=await h.flow("root","advance");
    assert.equal(restarted.childId,reviewer);
    const changed=(await h.flow(reviewer,"prepare")).originalReview;
    assert.equal(changed.pending,1);assert.equal(changed.stage,"originals");
  }));
}

test("source-first recorded evidence turns an opposite draft label into a targeted rejection", () => fixture(async (root,write) => {
  setOriginalFirstFixtures(write, "改正");
  const h=host(root,{automaticCoverage:false});
  const worker=(await h.flow("root","advance")).childId;
  await h.flow(worker,"prepare");
  await h.flow(worker,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  await h.flow(reviewer,"prepare");
  await h.coverage(reviewer,"original-record",{originals:[{id:"C1",decision:"保留",basis:"原始报告说明来稿已有正确说法。",evidence:asExternal.evidence}]});
  const packet=await h.flow(reviewer,"prepare");
  const label=packet.coverage.blocks[0];
  const saved=(await h.coverage(reviewer,"status",{block:label.id})).record.parts[0];
  assert.equal(saved.status,"unsupported");
  assert.deepEqual(saved.finding.quote,"改正");
  assert.match(saved.finding.fix,/改为「保留」/u);
  await h.coverage(reviewer,"record",{entries:[{block:label.id,parts:[{kind:"nonfactual",status:"supported",basis:"尝试把处置改判成一般标注。"}]}]});
  assert.equal((await h.coverage(reviewer,"status",{block:label.id})).record.parts[0].status,"unsupported");
  const fact=packet.coverage.blocks[1];
  await h.coverage(reviewer,"record",{entries:[{block:fact.id,parts:[asExternal]}]});
  const rejected=await h.flow(reviewer,"review");
  assert.equal(rejected.phase,"supplement-ready");
  const receipt=JSON.parse(fs.readFileSync(path.join(root,"first.json"),"utf8"));
  assert.deepEqual(receipt.checks[0].findingOrigin,{kind:"same-reviewer-original-disposition",block:label.id});
  assert.equal(receipt.checks[0].counterEvidence.file,report);
  assert.match(receipt.checks[0].finding.fix,/改为「保留」/u);

  assert.equal((await h.flow("root","advance")).childId,worker);
  await h.flow(worker,"prepare");
  await h.file(worker,"read","overview.md");
  await h.file(worker,"read",report,{start:2,count:1});
  const current = "+ C1：保留。" + externalStatement;
  const other = "附记：其他事项需改正。";
  async function revise(lines) {
    await h.file(worker,"write","candidate.md",{content:lines.join("\n")+"\n",note:"核对被退回编号的处置及稿件原文。"});
    await h.file(worker,"read","candidate.md");
    return h.flow(worker,"preflight");
  }
  for (const rows of [
    [current.replace("保留","改正"),other], [current.replace("保留","待证"),other],
    [current,"- C1：另作说明。",other], [current.replace("保留","正在整理"),other],
    ["```text",current,"```",other], ["> " + current,other], [other],
  ]) {
    const result = await revise(rows);
    assert.equal(result.ok,false,rows.join("\n"));
    assert.match(result.issues.join("\n"),/C1/u);
  }
  const accepted = await revise([other,"","```text","- C1：改正。示例行。","- C80：改正。示例行。","```","",current]);
  assert.deepEqual(accepted.issues,[]);
  assert.equal(accepted.repairs.find(item=>item.claim==="C1")?.resolution,"corrected-for-review");
  const quality = Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"已按原稿凭据校正本编号并保留可回查的出处。"]));
  assert.equal((await h.flow(worker,"submit",{quality})).phase,"final-review-ready");
  // A corrected disposition only releases the author. The final reviewer must
  // still build an independent original-only judgement before seeing this draft.
  const finalReviewer=(await h.flow("root","advance")).childId;
  const pending = await h.flow(finalReviewer,"prepare");
  assert.equal(pending.originalReview.pending,1);
  await assert.rejects(h.file(finalReviewer,"read","candidate.md"),/改稿尚未开放/u);
}));

test("supplement retains the independently supported locator or submits newly read evidence for both reviews", () => fixture(async (root,write) => {
  setOriginalFirstFixtures(write,"保留");
  const config = originalFirstPolicy();
  const alternative = "second-report.md";
  const alternateBytes = "# 独立验收台账\n当前状态：项目仍未开工。\n";
  const originalBytes = "# 发布记录\n"+externalQuote+"\n检查项：开工记录尚无登记。\n";
  config.sourcePins[report].sha256 = digest(originalBytes);
  config.sourcePins[alternative] = { kind:"primary", locator:"archive:independent-start-log", sha256:digest(alternateBytes) };
  for (const grant of Object.values(config.units.K01.phases)) {
    grant.read.push(alternative);
    grant.evidence?.push(alternative);
  }
  write("BUILDING-LOOP.json",JSON.stringify(config));
  write(alternative,alternateBytes);
  write(report,originalBytes);
  write("candidate.md","- C1：保留。"+externalStatement.replace("第2行","第2–3行")+"\n");
  const h = host(root,{automaticCoverage:false});
  const executor = (await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");
  await h.flow(executor,"submit");
  const reviewer = (await h.flow("root","advance")).childId;
  await h.flow(reviewer,"prepare");
  await h.coverage(reviewer,"original-record",{originals:[{
    id:"C1",decision:"保留",basis:externalQuote,evidence:asExternal.evidence,
  }]});
  const { coverage } = await h.flow(reviewer,"prepare");
  await h.coverage(reviewer,"record",{entries:[{block:coverage.blocks[1].id,parts:[{
    ...asExternal,evidence:[{file:report,start:2,end:3,quote:originalBytes.split("\n").slice(1,3).join("\n")}],
  }]}]});
  await h.assess(reviewer,{...Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"核对当前稿及可查原文。"])),
    sourceRefs:[{file:report,start:2,end:3}],goalFit:{pass:false,basis:"需要补足交付说明。"},unverifiedSources:[],unlisted:[],revise:[]});
  assert.equal((await h.flow(reviewer,"review",{checks:[{
    id:"C1",status:"supported",useCoverage:true,basis:"正式记录有原始来源。",
  }]})).phase,"supplement-ready");
  assert.equal((await h.flow("root","advance")).childId,executor);
  await h.file(executor,"read","overview.md");

  async function preflight(suffix) {
    await h.file(executor,"write","candidate.md",{content:"- C1：保留。实际项目尚未开工"+suffix+"。\n",note:"补足说明"});
    await h.file(executor,"read","candidate.md");
    return h.flow(executor,"preflight");
  }
  const missing = await preflight("");
  assert.equal(missing.ok,false);
  assert.equal(missing.evidenceRegressions[0].file,report);
  await assert.rejects(h.flow(executor,"submit"),/丢失已有出处/u);
  assert.equal((await preflight("（出处：official.md 第2行）")).evidenceRegressions?.length,1);
  assert.equal((await preflight("（出处：official.md 第2、3行）")).evidenceRegressions,undefined);
  assert.equal((await preflight("（出处：second-report.md 第2行）")).evidenceRegressions?.length,1);
  await h.file(executor,"read",alternative,{start:2,count:1});
  const replacement = await h.flow(executor,"preflight");
  assert.equal(replacement.evidenceRegressions,undefined);
  assert.equal(replacement.ok,true);
  const quality = Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"补充来自独立台账的可回查定位。"]));
  assert.equal((await h.flow(executor,"submit",{quality})).phase,"final-review-ready");
}));

for (const [authored, isComplete] of [["", false], [" 第2行", false], [" 第2-4行", true]]) {
  test(`source-first review routes the numbered locator ${authored.trim() || "without a line"}`, () => fixture(async (root,write) => {
    setOriginalFirstFixtures(write, "保留");
    const reportBytes = "# 发布记录\n" + externalQuote + "\n验收状态：尚未验收。\n# 附录\n";
    const config = originalFirstPolicy();
    config.sourcePins[report].sha256 = digest(reportBytes);
    write("BUILDING-LOOP.json", JSON.stringify(config));
    write(report, reportBytes);
    const statement = "独立报告记载项目尚未开工，且尚未验收（出处：official.md" + authored + "）。";
    write("candidate.md", "- C1：保留。" + statement + "\n");
    const h = host(root, { automaticCoverage:false });
    const worker = (await h.flow("root", "advance")).childId;
    await h.flow(worker, "prepare");
    await h.flow(worker, "submit");
    const reviewer = (await h.flow("root", "advance")).childId;
    await h.flow(reviewer, "prepare");
    await h.coverage(reviewer, "original-record", { originals:[{
      id:"C1", decision:"保留", basis:externalQuote, evidence:asExternal.evidence,
    }] });
    const { coverage } = await h.flow(reviewer, "prepare");
    const fact = coverage.blocks[1];
    await h.coverage(reviewer, "record", { entries:[{ block:fact.id, parts:[{ ...asExternal,
      evidence:[...asExternal.evidence, { file:report,start:3,end:3,quote:"验收状态：尚未验收。" }],
    }] }] });
    await h.assess(reviewer,{...Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"独立核对来稿及实际出处。"])),
      sourceRefs:[{file:report,start:2,end:3}],goalFit:{pass:true,basis:"按独立报告核对来稿。"},
      unverifiedSources:[],unlisted:[],revise:[]});
    const result = await h.flow(reviewer, "review", { checks:[{
      id:"C1", status:"supported", useCoverage:true, basis:"对照独立记录。",
    }] });
    if (!isComplete) {
      assert.equal(result.phase, "supplement-ready");
      const receipt = JSON.parse(fs.readFileSync(path.join(root,"first.json"), "utf8"));
      assert.equal(receipt.checks[0].finding.kind, "missing-evidence");
      assert.ok(receipt.checks[0].findingOrigin.sources.some(source=>source.start===3));
      assert.match(receipt.checks[0].finding.fix, /official\.md 第 3 行/u);
    } else {
      // Valid complete locator reaches the unchanged independent quality gate.
      assert.equal(result.phase, "first-audit-ready");
    }
  }));
}

test("source-first preparation itself records a registered numeric result and unlocks the draft with a repair", () => fixture(async (root,write) => {
  setOriginalFirstFixtures(write, "改正");
  const config = originalFirstPolicy();
  const table = "Year,Total,Total\n2024,3.543,540\n2025,3.587,544\n";
  config.sourcePins[report].sha256=digest(table);
  config.units.K01.originalMeasurements={C1:{source:report,header:1,valueColumn:2,valueHeading:"Total",keyColumn:1,
    before:{line:2,key:"2024"},after:{line:3,key:"2025"},sourceUnit:"W/m²",targetUnit:"mW/m²",
    statement:"2025 年试验指标比 2024 年多 {quantity}。"}};
  const original="- C1 2025 年试验指标比 2024 年多 44 mW/m²。\n";
  write("BUILDING-LOOP.json",JSON.stringify(config));
  write(material,original);
  write(report,table);
  const h=host(root,{automaticCoverage:false});
  const worker=(await h.flow("root","advance")).childId;
  await h.flow(worker,"prepare");
  await h.flow(worker,"submit");
  const reviewer=(await h.flow("root","advance")).childId;
  const first=await h.flow(reviewer,"prepare");
  assert.deepEqual(first.originalReview.recorded,[{id:"C1",decision:"保留",method:"measured-original"}]);
  assert.ok(first.files.every(({path})=>path!=="candidate.md"));
  const second=await h.flow(reviewer,"prepare");
  assert.match(second.coverage.blocks[0].editorial.independentOriginal.finding.fix,/44 mW\/m²/u);
  write(material,original.replace("44","43"));
  await assert.rejects(h.file(reviewer,"read","candidate.md"),/改稿尚未开放/u);
  const refreshed=await h.flow(reviewer,"prepare");
  assert.deepEqual(refreshed.originalReview.recorded,[{id:"C1",decision:"改正",method:"measured-original"}]);
  assert.ok(refreshed.files.every(({path})=>path!=="candidate.md"));
}));

test("disputed numerical receipts bind the quantity, scope, actor, evidence and actual source unit", () => fixture((root,write) => {
  const file="weights.txt",rows=["秤 A 起读 8.5 kg。","秤 A 终读 5.0 kg。","秤 A 公报净变动 3.5 kg。","入口备查表另有 18.5 kg。"];
  const sourceText=rows.join("\n")+"\n",sha256=digest(sourceText);
  write(file,sourceText);
  const evidence=rows.slice(0,3).map((quote,i)=>({file,start:i+1,end:i+1,quote,sha256}));
  const result={operation:"difference",formula:"a − b",value:"3.5",unit:"kg",operands:[
    {file,line:1,value:"8.5",unit:"kg",sha256},{file,line:2,value:"5.0",unit:"kg",sha256}]};
  const calc={id:"C1",proofId:"local-signed",result},dispute={calculations:{reviewer:calc}};
  const frame={role:"reviewer",root},base={id:"C1",grounds:"calculation",sourceRelation:"supports",calculation:calc.proofId};
  const vote=(body,changes={},sources=evidence,role=frame)=>groundedOriginalReceipt(role,{},dispute,{...base,...changes},
    sources,"- C1："+body,changes.quote??("- C1："+body));
  const check="读者可以核对秤 A 的 3.5 kg。";
  const properties=originalRecheckSchema().items.properties;
  assert.equal(properties.calculation,undefined);assert.equal(properties.claimValue,undefined);
  const proof=vote(check,{calculation:undefined});
  assert.ok(proof.basis.includes("(8.5) − (5.0) = 3.5 kg"));
  assert.deepEqual(proof.calculation.operands,result.operands);
  const noNumericTarget="秤 A 的两条读数可供独立核验。";
  const fromReport=vote(noNumericTarget,{claimValue:"3.5"});
  assert.ok(fromReport.basis.includes("来自所引登记记录"));
  assert.ok(!fromReport.basis.includes("原稿所称值为"));
  assert.throws(()=>vote(noNumericTarget,{claimValue:"8.5"}),/删除 claimValue/u);
  assert.throws(()=>vote(noNumericTarget,{claimValue:"两个数"}),/删除 claimValue/u);
  const ambiguous={calculations:{reviewer:{...calc,alternatives:[{proofId:"other-computation",result:{...result,operation:"share"}}]}}};
  assert.throws(()=>groundedOriginalReceipt(frame,{},ambiguous,{...base,calculation:undefined},evidence,check,check),/无法唯一/u);
  assert.deepEqual(vote(check,{},[{file,sha256,start:1,end:2,quote:rows.slice(0,2).join("\n")},evidence[2]]).calculation.operands,result.operands);
  assert.throws(()=>vote(check,{},[{file,sha256,start:1,end:4,quote:rows[3]},evidence[1],evidence[2]]),/操作数/u);
  assert.throws(()=>vote(check,{},[{...evidence[0],quote:"8"},evidence[1],evidence[2]]),/操作数/u);
  assert.throws(()=>vote(check,{basis:"主管已签署放行。"}),/自由/u);
  assert.throws(()=>vote(check,{gap:"新的、无来源的时序。"}),/自由/u);
  assert.throws(()=>vote(check,{},evidence,{role:"auditor"}),/building_loop_calculate/u);
  assert.throws(()=>vote(check,{},evidence.slice(1)),/操作数/u);
  assert.throws(()=>vote("读者可以核对秤 A 的 3.5%。"),/量纲/u);
  assert.throws(()=>vote("读者可以核对秤 A 的至少 3.5 kg。"),/限定/u);
  assert.throws(()=>vote("读者可以核对秤 B 的 3.5 kg。"),/对象/u);
  assert.throws(()=>vote("读者可以核对 3.5 kg，甲已签字。"),/单一数量/u);
  assert.throws(()=>vote("读者可以核对 3.5 kg，且甲先于乙签字。"),/单一数量/u);
  assert.throws(()=>vote("秤 A 编制人实际采用了减法计算该数。"),/单一数量/u);
  assert.throws(()=>vote("乙登记先于甲登记。",{grounds:"source-statement",calculation:undefined}),/时序/u);
  const negative=vote("按交接单计算，净变动为 9 kg。",
    {sourceRelation:"contradicts",quote:"9 kg",claimValue:"9"});
  assert.ok(negative.basis.includes("原稿所称值为 9"));
  const counter=vote("按交接单计算，净变动为 9 kg。",{sourceRelation:"contradicts",calculation:undefined,quote:"9 kg",counterQuote:evidence[2].quote});
  assert.equal(counter.calculation.observation.quote,evidence[2].quote);
  assert.throws(()=>vote("按交接单计算，净变动为 9 kg。",{sourceRelation:"contradicts",quote:"9 kg",counterQuote:"不存在的对照值"}),/counterQuote/u);
  assert.throws(()=>vote("按交接单计算，净变动为 3.5 kg。",
    {sourceRelation:"contradicts",quote:"3.5 kg",claimValue:"3.5"}),/不相等/u);
}));

test("a calculation's independently reported value stays bound to the physical subject and metric", () => fixture((root,write) => {
  const file="energy-ledger.txt";
  const rows=["晨星厂本期登记表。","晨星厂（A 厂）主要计量起读 36 kWh。","晨星厂（A 厂）主要计量终读 16 kWh。",
    "本期登记表中净耗电量为 20 kWh。","海湾厂登记表中净耗电量为 20 kWh。",
    "晨星厂登记表中照明耗电量为 20 kWh。","海湾厂：净耗电量为 20 kWh。","晨星厂登记表中累计净耗电量为 20 kWh。",
    "# 海湾厂","本期登记表中净耗电量为 20 kWh。","# 晨星厂","本期登记表中净耗电量为 20 kWh。",
    "A 厂：净耗电量为 20 kWh。","B 厂：净耗电量为 20 kWh。"];
  const raw=rows.join("\n")+"\n", sha256=digest(raw);
  write(file,raw);
  const ref=line=>({file,sha256,start:line,end:line,quote:rows[line-1]});
  const result={operation:"difference",formula:"a − b",value:"20",unit:"kWh",operands:[{file,line:2,value:"36",unit:"kWh",sha256},{file,line:3,value:"16",unit:"kWh",sha256}]};
  const dispute={calculations:{reviewer:{id:"C1",proofId:"signed-test",result}}};
  const active={seen:{[file]:{hash:sha256,ranges:[[1,rows.length]]}}};
  const body="按晨星厂交接单计算，净耗电量为 25 kWh。";
  function vote(line,quote=rows[line-1],current=active,original=body) {
    const entry={id:"C1",grounds:"calculation",sourceRelation:"contradicts",quote:"25 kWh",counterQuote:quote};
    return groundedOriginalReceipt({role:"reviewer",root},current,dispute,entry,[ref(2),ref(3),{...ref(line),quote}],original,entry.quote);
  }
  assert.equal(vote(4).calculation.observation.start,4);
  assert.equal(vote(4,"20 kWh").calculation.observation.start,4);
  assert.throws(()=>vote(4,"20 kWh",{seen:{[file]:{hash:sha256,ranges:[[2,8]]}}}),/主体/u);
  for (const n of [5,7]) assert.throws(()=>vote(n,"20 kWh"),/主体/u);
  for (const n of [6,8]) assert.throws(()=>vote(n,"20 kWh"),/指标/u);
  assert.throws(()=>vote(10,"20 kWh"),/主体/u);
  assert.equal(vote(12,"20 kWh").calculation.observation.start,12);
  const named="按 A 厂交接单计算，净耗电量为 25 kWh。";
  assert.equal(vote(13,"20 kWh",active,named).calculation.observation.start,13);
  assert.throws(()=>vote(14,"20 kWh",active,named),/主体/u);
}));

test("source witnesses stay with the named party and an unrecorded premise is not a contrary observation", () => {
  const sha256=digest("case"),file="handover.md";
  const read=(text)=>[{file,sha256,start:2,end:2,quote:text}];
  const vote=(body,rows,entry={})=>groundedOriginalReceipt({role:"reviewer"},{},{},
    {id:"C1",grounds:"source-statement",sourceRelation:"supports",...entry},read(rows),body,body);
  assert.throws(()=>vote("甲登记先于乙登记。","当前总数为 12 件。"),/时序/u);
  assert.ok(vote("甲登记先于乙登记。","甲的登记先于乙的登记。").basis.includes("先于"));
  const contrary=(original,actual,counterQuote)=>vote(original,actual,{sourceRelation:"contradicts",counterQuote});
  for(const c of ["实收 18 份","黄组实收 18 份。"])
    assert.throws(()=>contrary("黄组实收 18 份。","黄组实收 18 份。",c),/直接相反/u);
  assert.ok(contrary("黄组实收 19 份。","黄组实收 18 份。","实收 18 份").basis.includes("18 份"));
  assert.ok(contrary("上午","下午签收。","下午").basis.includes("下午"));
  assert.ok(contrary("实收18份","原称实收18份，后来改为19份。","原称实收18份，后来改为19份。").basis.includes("19份"));
  assert.ok(contrary("该事项已批准","该事项已批准不成立。","该事项已批准不成立").basis.includes("不成立"));
  const claim="甲方公司规定以扫描清点为准。";
  assert.throws(()=>vote(claim,"乙方公司规定以扫描清点为准。"),/同一条原文/u);
  assert.ok(vote(claim,"甲方公司规定以扫描清点为准。").basis.includes("甲方公司"));
  const capability="用登记的台数便可从本材料算出总质量。";
  assert.throws(()=>vote(capability,"单台质量没有记录。",{sourceRelation:"contradicts",counterQuote:"没有记录"}),/缺少输入|相反/u);
  assert.throws(()=>vote(capability,"总质量登记为 40 kg。",{sourceRelation:"contradicts",counterQuote:"40 kg"}),/缺少输入|相反/u);
  assert.ok(vote(capability,"本规程明确写明：不能用台数换算总质量。",{sourceRelation:"contradicts",counterQuote:"不能用台数换算总质量"}).basis.includes("相反记录"));
  assert.equal(vote(capability,"单台质量没有记录。",{grounds:"missing-premise",sourceRelation:"insufficient"}).scope,"evidence");
  assert.throws(()=>vote(capability,"单台质量没有记录。",{grounds:"missing-premise",sourceRelation:"contradicts"}),/不足/u);
});

test("a missing premise separates observed quantities, the actual limitation and the reviewer's unresolved relationship", () => {
  const file="shift.log", sha256=digest("signed synthetic handover");
  const lines=["本批 5 筐；每筐质量没有记录。","交接单另行登记退回 16 kg。"];
  const refs=lines.map((quote,i)=>({file,start:i+1,end:i+1,quote,sha256}));
  const body="用 5 筐可算出此次退回的质量。", decision={id:"C1",sourceRelation:"insufficient",grounds:"missing-premise",
    missing:"用 5 筐可算出此次退回的质量"};
  const vote=(line=body,proof=decision,evidence=refs)=>groundedOriginalReceipt({role:"reviewer"},{},{},proof,evidence,line,line);
  const r=vote();
  assert.match(r.basis,/5 筐/u);assert.match(r.basis,/16 kg/u);assert.match(r.gap,/每筐质量没有记录/u);
  assert.throws(()=>vote(body,{...decision,missing:"此次退回的质量"}),/没有指明待证关系/u);
  assert.equal(originalRecheckSchema().items.properties.missing,undefined);
  assert.throws(()=>vote(body,{...decision,limitation:"称重设备已失灵"}),/limitation/u);
  const rule="乙中心规定逐袋电子登记。", entries=["甲中心未提供登记方法。","乙中心成稿规范：逐袋电子登记。"]
    .map((quote,i)=>({file,start:i+1,end:i+1,quote,sha256}));
  assert.throws(()=>vote(rule,{...decision,missing:"乙中心规定逐袋电子登记"},entries),/已引原文/u);
  assert.throws(()=>vote(rule,{...decision,missing:"乙中心规定逐袋电子登记",limitation:"甲中心未提供登记方法"},entries),/主体/u);
  const absent=vote("丙中心使用虹膜仪。",{...decision,missing:"虹膜仪"},entries);
  assert.equal(absent.sourceRelation,"insufficient");assert.ok(absent.basis.includes("虹膜仪"));
});

test("a missing judgment defaults to its proposition and can select one complete claim in a compound original",()=>{
  const lines=["表中已登记总能耗 48 kWh。","运行时间已登记，功率没有记录。"];
  const refs=lines.map((quote,i)=>({file:"energy.txt",start:i+1,end:i+1,quote,sha256:digest(lines.join("\n"))}));
  const prefix="电表已登记总能耗 48 kWh",part="由运行时间可以推算出实际消耗的电量";
  const line=prefix+"；"+part+"。";
  const vote=(fields={})=>groundedOriginalReceipt({role:"reviewer"},{},{},
    {id:"C4",grounds:"missing-premise",sourceRelation:"insufficient",...fields},refs,line,fields.quote??line);
  assert.match(vote().basis,/48 kWh/u);
  assert.match(vote({quote:part}).gap,/中的「由运行时间可以推算出实际消耗的电量」/u);
  assert.throws(()=>vote({quote:"实际消耗的电量"}),/完整分句/u);
  assert.throws(()=>vote({missing:"实际消耗的电量"}),/没有指明待证关系/u);
  assert.throws(()=>vote({quote:part,missing:prefix}),/不一致/u);
  assert.match(vote({missing:part}).gap,/中的「由运行时间可以推算出实际消耗的电量」/u);
});

test("a missing time cannot be used to mark a separately witnessed measurement as missing",()=>fixture((root,write)=>{
  const file="cooling.txt",rows=["各站的降温时间没有记录。","P 站流量读数为 72 kg。","Z 站流量读数为 53 kg。",
    "交接单登记 P、Z 两个流量读数的差额为 19 kg。"];
  const raw=rows.join("\n")+"\n",sha256=digest(raw);write(file,raw);
  const refs=rows.map((quote,i)=>({file,start:i+1,end:i+1,quote,sha256}));
  const result={operation:"difference",formula:"a − b",value:"19",unit:"kg",operands:[
    {file,line:2,value:"72",unit:"kg",sha256},{file,line:3,value:"53",unit:"kg",sha256}]};
  const dispute={calculations:{reviewer:{id:"C3",proofId:"local",result}}};
  const time="P 先于 Z 降温", measured="两者流量读数差是 19 kg", unknown="第三站的进货量是 19 kg";
  const vote=(part,focus)=>groundedOriginalReceipt({role:"reviewer",root},{},dispute,
    {id:"C3",grounds:"missing-premise",sourceRelation:"insufficient",quote:focus,limitation:rows[0]},refs,time+"；"+part+"。",focus);
  assert.throws(()=>vote(measured,measured),/独立登记的量重合/u);
  assert.match(vote(measured,time).gap,/中的「P 先于 Z 降温」/u);
  const independent=vote(unknown,unknown);
  assert.match(independent.gap,/第三站的进货量/u);assert.equal(independent.calculation,undefined);
}));

test("a corroborating calculator independently agrees with the signed numeric counterstatement", () => fixture((root,write) => {
  const file="manifest.txt",rows=["起始 22 盒。","库存退回 8 盒。","登记的余量为 14 盒。","留档说明：余量来自复点。","蓝区的余量为 14 盒。"];
  const raw=rows.join("\n")+"\n",sha256=digest(raw);write(file,raw);
  const refs=rows.map((quote,i)=>({file,quote,start:i+1,end:i+1,sha256}));
  const result={operation:"difference",formula:"a − b",value:"14",unit:"原单位",operands:[{file,line:1,value:"22",sha256},{file,line:2,value:"8",sha256}]};
  const proof={id:"C1",proofId:"calculation1",result};
  const body="复点得到的余量结果为 17 盒。", counter=rows[2];
  const base={id:"C1",grounds:"source-statement",sourceRelation:"contradicts",quote:"余量结果为 17 盒",counterQuote:counter,claimValue:"17",calculation:"calculation1"};
  const run=(edit={},line=body,evidence=refs.slice(0,4),who="reviewer")=>groundedOriginalReceipt({role:who,root},{},{calculations:{reviewer:proof}},
    {...base,...edit},evidence,line,edit.quote??base.quote);
  const positive=run();
  const direct=run({calculation:undefined});
  assert.equal(direct.calculation,undefined);assert.ok(direct.basis.includes("14 盒"));
  assert.throws(()=>run({calculation:undefined,claimValue:"22"}),/删除 claimValue/u);
  assert.equal(positive.calculation.observation.file,file);assert.match(positive.basis,/22.*8.*14/u);
  assert.match(positive.basis,/相反记录/u);
  assert.throws(()=>run({calculation:"earlier"}),/proofId/u);
  assert.throws(()=>run({},body,refs.slice(0,4),"auditor"),/building_loop_calculate/u);
  assert.throws(()=>run({counterQuote:"库存退回 8 盒。"}),/独立观测/u);
  assert.throws(()=>run({quote:"余量结果为 17 %"},body.replace("17 盒","17 %")),/量纲/u);
  assert.throws(()=>run({quote:"余量结果为 17 盒",counterQuote:rows[4]},"黄区的余量结果为 17 盒。",refs),/独立观测/u);
  assert.throws(()=>run({sourceRelation:"supports",claimValue:undefined,counterQuote:undefined,quote:undefined}, "复点员实际采用了本流程。"),/明示|同一条原文|实际数量/u);
}));
