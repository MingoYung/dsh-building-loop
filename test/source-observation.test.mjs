import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { workspaceStateFile } from "../governance/session-mode.mjs";
import { quoteRepairLocation } from "../governance/evidence.mjs";
import { QUALITY } from "../governance/preflight.mjs";
import { classificationDisagreements, requireStoredFootnoteBindings } from "../governance/coverage.mjs";

const locator = "https://www.itl.nist.gov/div898/handbook/eda/section3/scatterp.htm";
const excerpt = "association does NOT imply causality.";
const secondExcerpt = "A separately recorded excerpt.";
const metadata = "GitHub 列表仅摘 failure/success 两项。";
const snapshot = `# 官方短摘录\n${metadata}\n${excerpt}\n${secondExcerpt}\n`;
const source = { file: "snapshot.md", start: 3, end: 3, quote: excerpt };

function setup(write) {
  const p = structuredClone(policy);
  const row = { snapshot: "snapshot.md", snapshotSha256: digest(snapshot), finalUrl: locator,
    status: 200, fetchedAt: "2026-11-07T13:01:03Z", responseSha256: "a".repeat(64), exactQuotes: [excerpt, secondExcerpt] };
  const receipt = JSON.stringify({ sources: [row] });
  p.sourcePins = { "snapshot.md": { kind: "primary", locator, sha256: digest(snapshot),
    observation: { file: "acquisition.json", sha256: digest(receipt) } } };
  const unit = p.units.K01;
  unit.claims = ["C1"];
  unit.calculations = {};
  for (const name of ["first-review", "final-review"]) {
    unit.phases[name].read.push(source.file);
    unit.phases[name].evidence = [source.file];
  }
  write("snapshot.md", snapshot);
  write("acquisition.json", receipt);
  write("candidate.md", "- C1：相关不说明因果（出处：snapshot.md 第 3 行）。\n");
  write("BUILDING-LOOP.json", JSON.stringify(p));
  return { p, row, receipt };
}

test("actual excerpt evidence passes, copied metadata and changed acquisition receipts are blocked", () => fixture(async (root, write) => {
  const { receipt } = setup(write);
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const packet = await h.flow(reviewer, "prepare");
  assert.ok(packet.files.some(file => file.path === source.file));
  assert.ok(!packet.files.some(file => file.path === "acquisition.json"));
  const record = (id, ref) => h.coverage(id, "record", { entries: [{ block: packet.coverage.blocks[0].id,
    parts: [{ kind: "direct", status: "supported", sourceRelation: "supports", evidence: [ref].flat(), basis: "逐字对应本页相关与因果的边界。" }] }] });
  await assert.rejects(record(reviewer, { ...source, start: 2, end: 2, quote: metadata }), /未登记为外部原文/);
  await assert.rejects(record(reviewer, { ...source, start: 2 }), /未登记为外部原文/);
  await assert.rejects(record(reviewer, { ...source, end: 4, quote: excerpt + "\n" + secondExcerpt }), /不能用跨行 quote/);
  await record(reviewer, [source, { ...source, start: 4, end: 4, quote: secondExcerpt }]);
  const item = (await h.coverage(reviewer, "status", { block: packet.coverage.blocks[0].id })).record.parts[0];
  assert.equal(item.evidence[0].origin.observation.sha256, digest(receipt));
  assert.equal(item.evidence[0].provenance,"maintainer-pinned-acquisition-receipt");
  assert.equal(item.evidence[0].sourceIdentity,item.evidence[1].sourceIdentity);
  assert.notEqual(item.evidence[0].evidenceSpan,item.evidence[1].evidenceSpan);
  await h.assess(reviewer, { ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "核准明确范围、实际来源和读者可理解的表述。"])),
    goalFit: { pass: true, basis: "正文保留授权材料的相关性边界。" },
    sourceRefs: [{ file: source.file, start: 3, end: 3 }], unverifiedSources: [], unlisted: [], revise: [] });
  const checks = [{ id: "C1", status: "supported", file: source.file, start: 3, end: 3, basis: "原始逐字摘录明确该边界。" }];
  await h.flow(reviewer, "review", { checks });
  const auditor = (await h.flow("root", "advance")).childId;
  await h.flow(auditor, "prepare");
  await record(auditor, source);
  assert.equal((await h.flow(auditor, "audit")).phase, "ledger-review");
  await h.ledger("root", "read");
  await h.file("root", "read", "overview.md");
  await h.file("root", "read", "first.json");
  const decisions = [{ id: "unit-K01", outcome: "completed", basis: "本轮结论与当前目标一致。", evidence: { file: "first.json", start: 1, end: 1 } }];
  write("acquisition.json", receipt + "\n");
  await assert.rejects(h.ledger("root", "review", { decisions }), /获取回执/);
  write("acquisition.json", receipt);
  assert.equal((await h.ledger("root", "review", { decisions })).phase, "closed");
}));

test("numbered review accepts separate cited data rows without using the earlier heading or another file", () => fixture(async (root, write) => {
  const { p } = setup(write);
  const second = "local-table.md", decoy = "archive/snapshot.md";
  const otherQuote = "A single-station estimate is separate from a worldwide estimate.";
  write(second, "# 单站表\n估计口径\n" + otherQuote + "\n");
  fs.mkdirSync(path.join(root,"archive"));
  write(decoy,snapshot);
  for (const name of ["first-review", "final-review"]) {
    const phase = p.units.K01.phases[name];
    phase.read.push(second,decoy);
    phase.evidence.push(second,decoy);
  }
  write("BUILDING-LOOP.json", JSON.stringify(p));
  write("candidate.md", "- C1：相关不能证明因果，单站估计也要区别于全球估计" +
    "（出处：snapshot.md 第 1 行标题、第 3 行；local-table.md 第 1 行、第 3 行）。\n");
  const h = host(root, {automaticCoverage:false});
  const executor = (await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");
  await h.flow(executor,"submit");
  const reviewer = (await h.flow("root","advance")).childId;
  const packet = await h.flow(reviewer,"prepare");
  const evidence = [source,{file:second,start:3,end:3,quote:otherQuote}];
  await h.coverage(reviewer,"record",{entries:packet.coverage.blocks.map((block,index) => ({block:block.id,parts:[index ? {
    kind:"nonfactual",status:"supported",basis:"其余文字只是相邻的另一个实际原文定位。",
  } : {kind:"direct",status:"supported",sourceRelation:"supports",evidence,basis:"两份原文分别说明相关的边界和单站口径。"}]}))});
  await h.assess(reviewer,{...Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"清楚核对全年口径与独立原文边界。"])),
    goalFit:{pass:true,basis:"正文同时解释两种不同的比较口径。"},sourceRefs:evidence,unverifiedSources:[],unlisted:[],revise:[]});
  const check = {id:"C1",status:"supported",file:source.file,start:3,end:3,basis:"该行明确列出原始的数据行。"};
  const review = args => h.flow(reviewer,"review",{checks:[{...check,...args}]});
  await assert.rejects(review({start:4,end:4}),/核验引用无效/u); // genuine excerpt, but the author did not cite it
  await assert.rejects(review({start:1,end:3}),/核验引用无效/u); // cannot fill the gap between disjoint locators
  await assert.rejects(review({start:1,end:1}),/未登记为外部原文/u); // precise heading locator still supplies no evidence
  await assert.rejects(review({file:decoy}),/未出现在候选断言的同行出处/u); // an authorized look-alike path is not the cited source
  assert.equal((await review({})).phase,"first-audit-ready");
  const receipt = JSON.parse(fs.readFileSync(path.join(root,"first.json"),"utf8"));
  assert.equal(receipt.checks[0].file,source.file);
  assert.deepEqual([receipt.checks[0].start,receipt.checks[0].end],[3,3]);
  assert.equal(receipt.checks[0].provenance,"maintainer-pinned-acquisition-receipt");
}));

test("observation files cannot be given to a model as writable or generated from its review", () => fixture(async (root, write) => {
  const { p } = setup(write);
  p.coordinator.write = ["acquisition.json"];
  write("BUILDING-LOOP.json", JSON.stringify(p));
  assert.throws(() => authority(root), /不能授予模型写权/);
  p.coordinator.write = [];
  p.sourcePins["snapshot.md"].observation.file = "first.json";
  write("BUILDING-LOOP.json", JSON.stringify(p));
  assert.throws(() => authority(root), /不能由候选或验收回执自证/);
}));

test("an explicit original quote pointing to editorial metadata can be returned to its author", () => fixture(async (root, write) => {
  setup(write);
  write("candidate.md", `- C1：原文为“${metadata}”（出处：snapshot.md 第 2 行）。\n`);
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const packet = await h.flow(reviewer, "prepare");
  const finding = { kind: "missing-evidence", quote: "原文为", fix: "删除冒称原文的说明或引用实际登记的摘录。" };
  await h.coverage(reviewer, "record", { entries: packet.coverage.blocks.map((block, index) => ({ block: block.id,
    parts: [index ? { kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis: "这个独立定位尾块指向未登记为原文的编辑说明。",
      finding: { kind: "missing-evidence", quote: block.text, fix: "把此原文定位改到真实登记摘录，或明确撤回原文声称。" } }
      : { kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis: "指向编辑说明。", finding }] })) });
  const result = await h.flow(reviewer, "review", { checks: [{ id: "C1", status: "unsupported", basis: "说明行不属于外部原文。", finding }] });
  assert.equal(result.phase, "supplement-ready");
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  assert.equal(receipt.coverage.quotations[0].matches, false);
  assert.deepEqual(receipt.coverage.quotations[0].excludedLocators, [{ file: source.file, start: 2, end: 2 }]);
}));

/** Deliberately give the reviewer an overbroad support judgment. The production
 * quotation gate must still check the manuscript's own locator, rather than
 * accept an unrelated authorized source selected by that reviewer. */
async function quoteReview(root, write, body, claimLine = 3, other = "other.md", partForBlock) {
  const { p } = setup(write);
  write(other, secondExcerpt + "\n");
  for (const phase of ["first-review", "final-review"]) {
    p.units.K01.phases[phase].read.push(other);
    p.units.K01.phases[phase].evidence.push(other);
  }
  p.units.K01.phases.supplement.read.push(source.file, other);
  write("candidate.md", "- C1：" + body + "\n");
  write("BUILDING-LOOP.json", JSON.stringify(p));
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const packet = await h.flow(reviewer, "prepare");
  const entries = packet.coverage.blocks.map(block => ({ block: block.id, parts: [partForBlock?.(block) ?? {
    kind: "direct", status: "supported", sourceRelation: "supports", evidence: [source],
    basis: "故意模拟只查到已授权摘录就放行，由独立逐字门槛核对实际定位。",
  }] }));
  for (let start = 0; start < entries.length; start += 12) await h.coverage(reviewer, "record", { entries: entries.slice(start, start + 12) });
  await h.assess(reviewer, { ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "本用例只检验引句定位，其他质量维度由固定脚本给出。"])),
    goalFit: { pass: true, basis: "保留当前逐字引用样例供独立定位检查。" },
    sourceRefs: [{ file: source.file, start: 3, end: 3 }, { file: source.file, start: 4, end: 4 }], unverifiedSources: [], unlisted: [], revise: [] });
  const result = await h.flow(reviewer, "review", { checks: [{ id: "C1", status: "supported",
    file: source.file, start: claimLine, end: claimLine, basis: "故意给出过宽支持，仍须通过稿件的确定性逐字核对。" }] });
  return { h, result, receipt: JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8")) };
}

test("a verbatim quote cannot borrow a different same-line source against its adjacent locator", () => fixture(async (root, write) => {
  const { result, receipt } = await quoteReview(root, write,
    `原文为“${secondExcerpt}”（出处：snapshot.md 第 3 行）；另见 other.md 第 1 行。`);
  assert.equal(result.phase, "supplement-ready");
  assert.equal(receipt.coverage.quotations[0].matches, false);
  assert.deepEqual(receipt.coverage.quotations[0].refs.map(({ file, start, end }) => ({ file, start, end })),
    [{ file: source.file, start: 3, end: 3 }]);
  assert.ok(receipt.coverage.rejected.some(row => row.finding?.kind === "verbatim-quote"));
}));

test("adjacent quote bindings preserve correct references and distinguish repeated source ranges", () => fixture(async (root, write) => {
  const { receipt } = await quoteReview(root, write,
    `原文为“${excerpt}”（出处：snapshot.md 第 3 行）；原文为“${secondExcerpt}”（出处：snapshot.md 第 4 行）；另见 other.md 第 1 行。`);
  assert.deepEqual(receipt.coverage.quotations.map(row => row.matches), [true, true]);
  assert.deepEqual(receipt.coverage.quotations.map(row => row.refs.map(ref => ref.start)), [[3], [4]]);
}));

test("a later wrong quote cannot borrow an earlier range of the same source", () => fixture(async (root, write) => {
  const { receipt } = await quoteReview(root, write,
    `原文为“${secondExcerpt}”（出处：snapshot.md 第 4 行）；原文为“${secondExcerpt}”（出处：snapshot.md 第 3 行）。`, 4);
  assert.deepEqual(receipt.coverage.quotations.map(row => row.matches), [true, false]);
}));

test("unambiguous adjacent locator syntax keeps valid quotations without unrelated source proof", async () => {
  for (const location of ["（snapshot.md:3）", "(来源: `snapshot.md` #L3)", "[证据：snapshot.md 第3行]", "【`snapshot.md:3`】"]) {
    await fixture(async (root, write) => {
      const { receipt } = await quoteReview(root, write, `原文为“${excerpt}”${location}；另见 other.md 第1行。`);
      const quote = receipt.coverage.quotations[0];
      assert.equal(quote.matches, true);
      assert.equal(quote.binding, "adjacent-single-source");
      assert.deepEqual(quote.refs.map(ref => ref.file), [source.file]);
    });
  }
});

test("generic multi-source inline notes keep their legacy quotation scope", async () => {
  await fixture(async (root, write) => {
    const { receipt } = await quoteReview(root, write,
      `原文为“${secondExcerpt}”（出处：snapshot.md 第3行；other.md 第1行）。`);
    const quote = receipt.coverage.quotations[0];
    assert.equal(quote.binding, undefined);
    assert.equal(quote.matches, true);
    assert.deepEqual(quote.refs.map(ref => ref.file), [source.file, "other.md"]);
  });
});

test("a unique touching footnote binds its own source and cannot borrow nearby evidence", () => fixture(async (root, write) => {
  const { result, receipt } = await quoteReview(root, write,
    `相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”[^correct]\n原文为“${secondExcerpt}”[^wrong]；另见 other.md 第1行。\n\n[^correct]: snapshot.md 第4行。\n[^wrong]: snapshot.md 第3行。`);
  const [positive,negative]=receipt.coverage.quotations;
  assert.equal(result.phase,"supplement-ready");
  assert.deepEqual([positive,negative].map(({binding,footnote,matches,refs})=>[binding,footnote,matches,refs.map(ref=>ref.start)]),[
    ["adjacent-footnote",{id:"correct",definitionLine:5},true,[4]],
    ["adjacent-footnote",{id:"wrong",definitionLine:6},false,[3]],
  ]);
  const rejected=receipt.coverage.rejected.find(row=>row.finding?.kind==="verbatim-quote");
  assert.equal(rejected.finding.quote,`原文为“${secondExcerpt}”[^wrong]`);
  assert.deepEqual(rejected.repairBaseline.refs.map(({file,start})=>[file,start]),[["snapshot.md",3]]);
}));

test("disjoint source lines survive both independent footnote checks and ledger closure", () => fixture(async(root,write)=>{
  const body=`相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”[^both]\n\n[^both]: snapshot.md 第3、4行。`;
  const {h,result}=await quoteReview(root,write,body);
  assert.equal(result.phase,"first-audit-ready");
  const auditor=(await h.flow("root","advance")).childId;
  const packet=await h.flow(auditor,"prepare");
  await h.coverage(auditor,"record",{entries:packet.coverage.blocks.map(block=>({block:block.id,parts:[{
    kind:"direct",status:"supported",sourceRelation:"supports",evidence:[source,{...source,start:4,end:4,quote:secondExcerpt}],
    basis:"分别读取两个登记行，逐字引文出现在第二个定位。"
  }]}))});
  assert.equal((await h.flow(auditor,"audit")).phase,"ledger-review");
  const stateFile=path.join(process.env.DSH_HOME,"building-loop-state",workspaceStateFile(root));
  const proof=JSON.parse(fs.readFileSync(stateFile,"utf8")).units.K01.proof;
  const both=[proof.reviewerCoverage,proof.auditorCoverage];
  for(const role of both)assert.deepEqual(role.quotations[0].refs.map(ref=>ref.start),[3,4]);
  const bytes=fs.readFileSync(path.join(root,"candidate.md")),spec=authority(root).units.K01;
  for(const damage of [row=>row.refs.pop(),row=>row.refs[0].end=4,row=>row.refs[1].file="other.md"]){
    const tampered=structuredClone(both);damage(tampered[1].quotations[0]);
    assert.throws(()=>requireStoredFootnoteBindings(spec,tampered,bytes,"final-review"),/唯一脚注定位/);
  }
  await h.ledger("root","read");
  await h.file("root","read","overview.md");await h.file("root","read","first.json");
  assert.equal((await h.ledger("root","review",{decisions:[{id:"unit-K01",outcome:"completed",basis:"两道审核保留所有登记行并核对逐字引句。",evidence:{file:"first.json",start:1,end:1}}]})).phase,"closed");
}));

test("same-line quotations cannot borrow a sibling's source, including compound and unapproved locator lists", async()=>{
  for(const annotation of ["（出处：denied.md 第2、4、6行）","（出处：denied.md 第-1行）","", "（出处：snapshot.md 第3行；denied.md 第1行）"]) {
    await fixture(async(root,write)=>{
      const local=`原文为“${secondExcerpt}”${annotation}，原文为“${secondExcerpt}”（出处：snapshot.md 第4行）。`;
      const {receipt,result}=await quoteReview(root,write,`相关边界（出处：snapshot.md 第3行）。\n${local}`);
      assert.equal(result.phase,"supplement-ready",annotation);
      const [first,second]=receipt.coverage.quotations;
      assert.deepEqual([first.matches,second.matches],[false,true],annotation);
      assert.ok(!first.refs.some(ref=>ref.start===4),annotation);
      assert.deepEqual(second.refs.map(ref=>ref.start),[4]);
      // An open receipt created by the previous whole-line fallback cannot
      // be carried through the audit or ledger after a restart.
      const old=structuredClone(receipt.coverage);
      Object.assign(old.quotations[0],{matches:true,refs:structuredClone(second.refs)});
      delete old.quotations[0].excludedLocators;
      assert.throws(()=>requireStoredFootnoteBindings(authority(root).units.K01,[old],
        fs.readFileSync(path.join(root,"candidate.md")),"first-review"),/自身的出处/);
    });
  }
});

test("a marked list of lines or sources can establish its own literal without borrowing a sibling",async()=>{
  for(const note of ["snapshot.md第3行说明、第4行", "snapshot.md 第3行表头、第4行摘录", "snapshot.md 第3行、other.md 第1行"]) {
    await fixture(async(root,write)=>{
      const {receipt}=await quoteReview(root,write,`相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”（出处：${note}），原文为“${excerpt}”（出处：snapshot.md 第3行）。`);
      assert.deepEqual(receipt.coverage.quotations.map(row=>row.matches),[true,true],note);
      assert.equal(receipt.coverage.quotations[0].refs.length,2,note);
    });
  }
});

test("authorized hyphenated paths are literal in touching and inline locators", () => fixture(async (root, write) => {
  const file="sources/other-checks.md";
  fs.mkdirSync(path.join(root,"sources"));
  const {receipt}=await quoteReview(root,write,`相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”[^hyphen-path]\n原文为“${secondExcerpt}”（出处：${file} 第1行）。\n\n[^hyphen-path]: ${file} 第1行。`,3,file);
  assert.deepEqual(receipt.coverage.quotations.map(({binding,refs,matches})=>[binding,refs[0].file,matches]),[
    ["adjacent-footnote",file,true],["adjacent-single-source",file,true],
  ]);
}));

test("ambiguous or unavailable touching footnotes return missing evidence instead of borrowing", async () => {
  const cases=[
    ["[^n]","[^n]: snapshot.md 第3行。\n[^N]: other.md 第1行。","ambiguous-footnote"],
    ["[^n]","[^n]: snapshot.md 第3行；other.md 第1行。","unresolved-footnote"],
    ["[^n]","[^n]: snapshot.md 第3行。\n    另见 other.md 第1行。","ambiguous-footnote"],
    ["[^n]","也使用该注[^N]\n[^n]: snapshot.md 第3行。","ambiguous-footnote"],
    ["[^n][^m]","[^n]: snapshot.md 第3行。\n[^m]: other.md 第1行。","ambiguous-footnote"],
    ["[^n","[^n]: snapshot.md 第3行。","malformed-footnote"],
    ["[^n]","[^n]: denied.md 第1行。","unapproved-source"],
    ["[^n]","[^n]: snapshot.md 第50行。","invalid-range"],
  ];
  for(const [marker,definition,reason] of cases)await fixture(async(root,write)=>{
    const {result,receipt}=await quoteReview(root,write,
      `相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”${marker}；另见 other.md 第1行。\n\n${definition}`);
    const quote=receipt.coverage.quotations[0];
    assert.equal(result.phase,"supplement-ready",reason);
    assert.equal(quote.binding,"adjacent-footnote");
    assert.deepEqual(quote.refs,[]);
    assert.equal(quote.excludedLocators[0].reason,reason);
    assert.ok(receipt.coverage.rejected.some(row=>row.finding?.kind==="missing-evidence"&&row.sourceRelation==="insufficient"));
  });
});

test("escaped, inline-code, fenced and commented markers cannot create a footnote owner or definition", () => fixture(async (root, write) => {
  const { receipt } = await quoteReview(root, write,
    `相关边界（出处：snapshot.md 第3行）。\n原文为“${excerpt}”[^n]\n原文为“${secondExcerpt}”\\[^n]；另见 other.md 第1行。\n原文为“${secondExcerpt}”\`[^n]\`；另见 other.md 第1行。\n\n\`代码开头\n原文为“${secondExcerpt}”[^n]；另见 other.md 第1行。\n代码结尾\`\n\n\`\`\`text\n原文为“${secondExcerpt}”[^n]；另见 other.md 第1行。\n[^n]: other.md 第1行。\n\`\`\`\n<!-- [^n] -->\n\n[^n]: \`snapshot.md\` 第3行。`);
  assert.deepEqual(receipt.coverage.quotations.map(({line,matches,footnote,refs})=>[line,matches,footnote.id,refs[0].start]),[[2,true,"n",3]]);
}));

test("fixing only a footnote definition requires the actual new read before author resubmission", () => fixture(async (root, write) => {
  const body=`相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”[^n]；另见 other.md 第1行。\n\n[^n]: snapshot.md 第3行。`;
  const {h,result}=await quoteReview(root,write,body);
  assert.equal(result.phase,"supplement-ready");
  const executor=(await h.flow("root","advance")).childId;
  await h.file(executor,"read","candidate.md");
  await h.file(executor,"read","other.md");
  assert.equal((await h.flow(executor,"preflight")).ok,false,"Unrelated matching evidence is not a repair");
  await h.file(executor,"write","candidate.md",{content:"- C1："+body.replace("[^n]: snapshot.md 第3行。","[^n]: snapshot.md 第4行。")+"\n",note:"只修复脚注的实际原文定位"});
  await h.file(executor,"read","candidate.md");
  assert.equal((await h.flow(executor,"preflight")).ok,false,"New bound line has not been read");
  await h.file(executor,"read","snapshot.md",{start:4,end:4});
  const preflight=await h.flow(executor,"preflight");
  assert.equal(preflight.ok,true);
  assert.equal(preflight.repairs[0].resolution,"new-evidence-for-review");
  assert.deepEqual(preflight.repairs[0].evidence[0].refs.map(({file,start})=>[file,start]),[["snapshot.md",4]]);
}));

test("removing the wrong attribution preserves an identical correct quote under a different footnote ID", () => fixture(async (root, write) => {
  const correct=`原文为“${secondExcerpt}”[^n1]`,wrong=`原文为“${secondExcerpt}”[^n_1_]；另见 other.md 第1行。`;
  const body=`相关边界（出处：snapshot.md 第3行）。\n${correct}\n${wrong}\n\n[^n1]: snapshot.md 第4行。\n[^n_1_]: snapshot.md 第3行。`;
  const {h,result}=await quoteReview(root,write,body);
  assert.equal(result.phase,"supplement-ready");
  const executor=(await h.flow("root","advance")).childId;
  await h.file(executor,"read","candidate.md");
  assert.equal((await h.flow(executor,"preflight")).ok,false,"The unchanged wrong attribution is still debt");
  await h.file(executor,"write","candidate.md",{content:"- C1："+body.replace(wrong+"\n","").replace("\n[^n_1_]: snapshot.md 第3行。","")+"\n",note:"撤回错绑脚注，保留另一独立正确引句"});
  await h.file(executor,"read","candidate.md");
  const preflight=await h.flow(executor,"preflight");
  assert.equal(preflight.ok,true);
  assert.equal(preflight.repairs[0].resolution,"removed-or-rewritten");
}));

test("a returned inline attribution does not create debt for the exact same quote under a correct footnote", () => fixture(async (root, write) => {
  const sentence=`原文为“${excerpt}”`,positive=`${sentence}[^nist-original]`;
  const wrong=`${sentence}（出处：other.md 第 1 行）`;
  const extra="另有未证的市场影响";
  const wrongRow=`${wrong}；另见 snapshot.md 第 3 行；${extra}。`;
  const body=`相关边界（出处：snapshot.md 第3行）。\n${wrongRow}\n${positive}\n\n[^nist-original]: snapshot.md 第 3 行。`;
  const missing=quote=>({kind:"direct",status:"unsupported",sourceRelation:"insufficient",basis:"本分句缺少支持其当前实际措辞的证据。",
    finding:{kind:"missing-evidence",quote,fix:"核对实际出处，证据不足时删去该断言。"}});
  const {h,result,receipt}=await quoteReview(root,write,body,3,"other.md",block=>block.text.startsWith(wrong)?missing(sentence)
    :block.text.startsWith(extra)?missing(extra):undefined);
  assert.equal(result.phase,"supplement-ready");
  const rejected=receipt.coverage.rejected.find(row=>row.finding?.kind==="verbatim-quote");
  assert.equal(receipt.coverage.quotations[0].text,sentence);
  assert.equal(rejected.finding.quote,wrong);
  assert.deepEqual(rejected.repairBaseline.refs.map(({file,start})=>[file,start]),[["other.md",1]]);
  const short=receipt.coverage.rejected.find(row=>row.finding?.quote===sentence);
  const tail=receipt.coverage.rejected.find(row=>row.finding?.quote===extra);
  assert.equal(short.repairBaseline.quote,sentence,"The original model finding is retained");
  assert.equal(short.repairBaseline.attribution.quote,wrong);
  assert.equal(tail.repairBaseline.attribution,undefined,"Independent factual tail remains its own debt");
  const executor=(await h.flow("root","advance")).childId;
  await h.flow(executor,"prepare");
  assert.equal((await h.flow(executor,"preflight")).ok,false,"Both sources were read but the wrong attribution remains");
  const onlyAttribution="- C1："+body.replace(wrongRow,extra+"。")+"\n";
  await h.file(executor,"write","candidate.md",{content:onlyAttribution,note:"先删错绑出处，单独验证事实尾句仍须修订"});
  await h.file(executor,"read","candidate.md");
  const remaining=await h.flow(executor,"preflight");
  assert.equal(remaining.ok,false);
  assert.deepEqual(remaining.repairs.filter(row=>row.unresolved.length).map(row=>row.quote),[extra]);
  const corrected="- C1："+body.replace(wrongRow+"\n","")+"\n";
  await h.file(executor,"write","candidate.md",{content:corrected,note:"删除错绑行内出处，完整保留独立脚注"});
  await h.file(executor,"read","candidate.md");
  const preflight=await h.flow(executor,"preflight");
  assert.equal(preflight.ok,true);
  assert.ok(preflight.repairs.every(row=>row.resolution==="removed-or-rewritten"));
  const quality=Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"已按实际引句定位删除错误归属，独立脚注保留并完整读回。"]));
  assert.equal((await h.flow(executor,"submit",{quality})).phase,"final-review-ready");
}));

test("an open legacy quotation proof cannot carry a touching footnote through the audit transition", () => fixture(async (root, write) => {
  const {h,result}=await quoteReview(root,write,`相关边界（出处：snapshot.md 第3行）。\n原文为“${excerpt}”[^n]\n\n[^n]: snapshot.md 第3行。`);
  assert.equal(result.phase,"first-audit-ready");
  assert.equal((await h.flow("root","status")).units[0].goalStale,false);
  const dir=path.join(process.env.DSH_HOME,"building-loop-state");
  const file=path.join(dir,fs.readdirSync(dir).find(name=>name.endsWith(".json")));
  const state=JSON.parse(fs.readFileSync(file,"utf8"));
  const old=state.units.K01.pendingReceipt.coverage.quotations[0];
  delete old.binding;delete old.footnote;
  fs.writeFileSync(file,JSON.stringify(state));
  assert.equal((await h.flow("root","status")).units[0].goalStale,true);
  assert.equal((await h.flow("root","advance")).phase,"final-review");
}));

test("an unclosed ledger requires current footnote proof without reinterpreting a completed record", () => fixture(async (root, write) => {
  const {h}=await quoteReview(root,write,`相关边界（出处：snapshot.md 第3行）。\n原文为“${excerpt}”[^n]\n\n[^n]: snapshot.md 第3行。`);
  const auditor=(await h.flow("root","advance")).childId;
  const packet=await h.flow(auditor,"prepare");
  const entries=packet.coverage.blocks.map(block=>({block:block.id,parts:[{
    kind:"direct",status:"supported",sourceRelation:"supports",evidence:[source],basis:"原稿唯一脚注的定位与登记逐字引句一致。",
  }]}));
  await h.coverage(auditor,"record",{entries});
  assert.equal((await h.flow(auditor,"audit")).phase,"ledger-review");
  assert.equal((await h.flow("root","status")).units[0].goalStale,false);
  const dir=path.join(process.env.DSH_HOME,"building-loop-state");
  const file=path.join(dir,fs.readdirSync(dir).find(name=>name.endsWith(".json")));
  const state=JSON.parse(fs.readFileSync(file,"utf8")),unit=state.units.K01;
  for(const proof of [unit.proof.reviewerCoverage,unit.proof.auditorCoverage])proof.quotations=[];
  fs.writeFileSync(file,JSON.stringify(state));
  assert.equal((await h.flow("root","status")).units[0].goalStale,true);
  unit.phase="closed"; // Reconstruct the already-completed legacy state.
  fs.writeFileSync(file,JSON.stringify(state));
  assert.equal((await h.flow("root","status")).units[0].goalStale,false);
}));

test("only the exact marker shared by two current valid footnote proofs is classification syntax", () => fixture(async (root, write) => {
  const quote=`原文为“${excerpt}”`,marker="[^nist-original]",tail=" 同一快照还收录另一条登记摘录。";
  const secondSource={...source,start:4,end:4,quote:secondExcerpt};
  const direct=(quote,evidence)=>({quote,kind:"direct",status:"supported",sourceRelation:"supports",evidence,
    basis:"按已读逐字摘录分别证明引句的内容、归属或另一条登记摘录。"});
  const neutral={quote:marker,kind:"nonfactual",status:"supported",basis:"这个标记只把逐字引句连接到同名出处定义。"};
  const body=`相关边界（出处：snapshot.md 第3行）。\n${quote}${marker}${tail}\n\n${marker}: snapshot.md 第3行。`;
  const {h,result}=await quoteReview(root,write,body,3,"other.md",block=>block.line===2?direct(block.text,[source,secondSource]):undefined);
  assert.equal(result.phase,"first-audit-ready");
  const auditor=(await h.flow("root","advance")).childId;
  const packet=await h.flow(auditor,"prepare");
  await h.coverage(auditor,"record",{entries:packet.coverage.blocks.map(block=>({block:block.id,
    parts:block.line===2?[direct(quote,[source]),neutral,direct(tail,[secondSource])]:[direct(block.text,[source])],
  }))});
  // Exercise the production audit transition with the two actual, different
  // classifications. Previously it performed an unnecessary targeted round.
  assert.equal((await h.flow(auditor,"audit")).phase,"ledger-review");
  const dir=path.join(process.env.DSH_HOME,"building-loop-state");
  const state=JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(name=>name.endsWith(".json"))),"utf8"));
  const {reviewerCoverage,auditorCoverage}=state.units.K01.proof;
  assert.deepEqual(classificationDisagreements(reviewerCoverage,auditorCoverage),[]);
  const quoteRecord=proof=>proof.records.find(row=>row.line===2);
  const noEquivalence=[
    ["missing role proof",proof=>{proof.quotations=[];}],
    ["stale candidate",proof=>{proof.candidateSha256="b".repeat(64);}],
    ["changed source bytes",proof=>{proof.quotations[0].refs[0].sha256="b".repeat(64);}],
    ["changed acquisition receipt",proof=>{proof.quotations[0].refs[0].origin.observation.sha256="b".repeat(64);}],
    ["different source",proof=>{proof.quotations[0].refs[0].file="other.md";}],
    ["different source range",proof=>{proof.quotations[0].refs[0].start=4;}],
    ["different definition",proof=>{proof.quotations[0].footnote.definitionLine++;}],
    ["different marker ID",proof=>{proof.quotations[0].footnote.id="other";}],
    ["negative match",proof=>{proof.quotations[0].matches=false;}],
    ["ambiguous locator",proof=>{proof.quotations[0].excludedLocators=[{reason:"ambiguous-footnote"}];}],
    ["ambiguous duplicate",proof=>{proof.quotations.push(structuredClone(proof.quotations[0]));}],
    ["unsupported marker",proof=>{quoteRecord(proof).parts[1].status="uncertain";}],
  ];
  for(const [label,change] of noEquivalence){
    const changed=structuredClone(auditorCoverage);
    change(changed);
    const [dispute]=classificationDisagreements(reviewerCoverage,changed);
    assert.equal(dispute?.line,2,label);
    assert.ok(dispute.factualSpans.some(([start,end])=>start<quote.length+marker.length&&end>quote.length),label);
  }
  for(const [line,partIndex,subject] of [[2,0,quote],[2,2,tail],[4,0,marker]]){
    const changed=structuredClone(auditorCoverage);
    changed.records.find(row=>row.line===line).parts[partIndex].kind="nonfactual";
    const [dispute]=classificationDisagreements(reviewerCoverage,changed);
    assert.equal(dispute?.line,line,subject);
    assert.ok(dispute.factualSpans.every(([start,end])=>line!==2||end<=quote.length+1||start>=quote.length+marker.length),subject);
  }
}));

test("an explicit unapproved adjacent path cannot borrow a valid alternate source", async () => {
  for (const file of ["not-present.md", "denied.md"]) {
    await fixture(async (root, write) => {
      if (file === "denied.md") write(file, secondExcerpt + "\n");
      const { result, receipt } = await quoteReview(root, write,
        `相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”（出处：${file} 第1行）；另见 other.md 第1行。`);
      assert.equal(result.phase, "supplement-ready");
      const quote = receipt.coverage.quotations[0];
      assert.equal(quote.matches, false);
      assert.deepEqual(quote.refs, []);
      assert.equal(quote.excludedLocators[0].file, file);
      assert.equal(quote.excludedLocators[0].reason, "unapproved-source");
      const rejected = receipt.coverage.rejected.find(row => row.text === quote.text);
      assert.equal(rejected.sourceRelation, "insufficient");
      assert.equal(rejected.finding.kind, "missing-evidence");
    });
  }
});

test("an invalid adjacent authorized range creates author evidence debt without reading an invalid range", async () => {
  for (const location of ["snapshot.md 第0行", "snapshot.md:4-3", "snapshot.md#L9007199254740992"]) {
    await fixture(async (root, write) => {
      const { result, receipt } = await quoteReview(root, write,
        `相关边界（出处：snapshot.md 第3行）。\n原文为“${secondExcerpt}”（出处：${location}）；另见 other.md 第1行。`);
      assert.equal(result.phase, "supplement-ready");
      const quote = receipt.coverage.quotations[0];
      assert.equal(quote.matches, false);
      assert.deepEqual(quote.refs, []);
      assert.equal(quote.excludedLocators[0].reason, "invalid-range");
      assert.ok(receipt.coverage.rejected.some(row => row.finding.kind === "missing-evidence"));
    });
  }
});


test("an authenticated source replacement revokes the old stage, resumes its executor and requires both independent reviews", () => fixture(async (root, write) => {
  const {p, row} = setup(write);
  const unit = p.units.K01;
  for (const phase of ["intake","supplement"]) unit.phases[phase].read.push(source.file);
  write("BUILDING-LOOP.json", JSON.stringify(p));
  const h = host(root,{automaticCoverage:false});
  const exec = (await h.flow("root","advance")).childId;
  await h.flow(exec,"prepare");
  await h.flow(exec,"submit");
  const reviewer = (await h.flow("root","advance")).childId;
  const quality = Object.fromEntries(Object.keys(QUALITY).map(key=>[key,"核对当前来源、更新的项目目标和适用范围。"]));
  async function assessRevision(actor, ref, basis) {
    const packet=await h.flow(actor,"prepare");
    assert.equal(packet.coverage.pending.length,packet.coverage.total);
    await h.coverage(actor,"record",{entries:packet.coverage.blocks.map(block=>({ block:block.id,parts:[{
      kind:"direct",status:"supported",sourceRelation:"supports",evidence:[ref],basis,
    }]}))});
    if (actor === reviewer) {
      await h.assess(actor,{...quality,goalFit:{pass:true,basis},sourceRefs:[{file:ref.file,start:ref.start,end:ref.end}],
        unverifiedSources:[],unlisted:[],revise:[]});
      return h.flow(actor,"review",{checks:[{id:"C1",file:ref.file,start:ref.start,end:ref.end,status:"supported",basis}]});
    }
    return h.flow(actor,"audit");
  }
  assert.equal((await assessRevision(reviewer,source,"首审逐字检查了初始原文。")).phase,"first-audit-ready");
  const auditor = (await h.flow("root","advance")).childId;
  assert.notEqual(reviewer,auditor);
  assert.equal((await assessRevision(auditor,source,"独立复核亲自对照初始原文。")).phase,"ledger-review");
  const first=fs.readFileSync(path.join(root,"first.json"));
  const file="replacement.md", quote="Replacement observations cover this interval.", revised=quote+"\n";
  const newRow={...row,snapshot:file,snapshotSha256:digest(revised),finalUrl:locator+"?revision=2",exactQuotes:[quote]};
  const receipt=JSON.stringify({sources:[newRow]});
  const grant=structuredClone(p);
  grant.sourcePins={[file]:{kind:"primary",locator:newRow.finalUrl,sha256:digest(revised),
    observation:{file:"acquisition.json",sha256:digest(receipt)}}};
  for(const phase of Object.values(grant.units.K01.phases)) {
    phase.read=phase.read.map(name=>name===source.file?file:name);
    if(phase.evidence)phase.evidence=phase.evidence.map(name=>name===source.file?file:name);
  }
  write(file,revised);write("BUILDING-LOOP.json",JSON.stringify(grant));
  await assert.rejects(h.flow("root","advance"),/获取回执/u);
  write("acquisition.json",receipt);
  for (const modify of [
    cfg=>cfg.coordinator.read.push(file),
    cfg=>cfg.units.K01.phases.intake.write=["candidate.md"],
    cfg=>cfg.units.K01.phases.supplement.read.push("unregistered.txt"),
  ]) {
    const unsafe=structuredClone(grant);modify(unsafe);
    write("BUILDING-LOOP.json",JSON.stringify(unsafe));
    await assert.rejects(h.flow("root","advance"),/授权清单发生变化/u);
  }
  write("BUILDING-LOOP.json",JSON.stringify(grant));write("overview.md","项目现在要求使用替换后的实际观测。");
  await assert.rejects(h.flow(auditor,"audit"),/未获得|未处于|阶段|归属|工作单元|分配/u);
  let resumed=await h.flow("root","advance");
  assert.deepEqual([resumed.childId,resumed.phase],[exec,"supplement"]);
  const packet=await h.flow(exec,"prepare");
  assert.deepEqual(packet.sourceRevision,{added:[file],refreshed:[],withdrawnCount:1});
  await assert.rejects(h.file(exec,"read",source.file),/读白名单/u);
  await assert.rejects(h.file("root","read",file),/读白名单/u);
  assert.match(h.guard("root","pwsh"),/禁止直接调用/u);
  assert.deepEqual(fs.readFileSync(path.join(root,"first.json")),first);
  const draft="- C1：替换后的观测涵盖当前区间（出处："+file+" 第 1 行）。\n";
  await h.file(exec,"write","candidate.md",{content:draft,note:"改用经过核实的替换材料"});
  await h.file(exec,"read","candidate.md");
  assert.equal((await h.flow(exec,"submit",{quality})).phase,"final-review-ready");
  const ref={file,start:1,end:1,quote};
  assert.equal((await h.flow("root","advance")).childId,reviewer);
  assert.equal((await assessRevision(reviewer,ref,"首审逐字检查替换后的原文。")).phase,"final-audit-ready");
  assert.equal((await h.flow("root","advance")).childId,auditor);
  assert.equal((await assessRevision(auditor,ref,"独立复核重新核对变更后的观测范围。")).phase,"ledger-review");
  await h.ledger("root","read");await h.file("root","read","overview.md");await h.file("root","read","final.json");
  const decisions=[{id:"unit-K01",outcome:"completed",basis:"两道验收都已重新核对替换材料。",evidence:{file:"final.json",start:1,end:1}}];
  assert.equal((await h.ledger("root","review",{decisions})).phase,"closed");
}));



test("legacy source withdrawal needs the exact old grant and keeps an unresolved outcome paused", () => fixture(async (root, write) => {
  const { p, row } = setup(write);
  const second = "older.md", receipt = JSON.stringify({sources:[row, {...row,snapshot:second}]});
  write(second,snapshot);write("acquisition.json",receipt);
  p.sourcePins[source.file].observation.sha256=digest(receipt);
  p.sourcePins[second]=structuredClone(p.sourcePins[source.file]);
  for(const phase of Object.values(p.units.K01.phases)) {
    phase.read.push(second);
    if(phase.evidence)phase.evidence.push(second);
  }
  const baseline=JSON.stringify(p);
  write("BUILDING-LOOP.json",baseline);
  const h=host(root,{automaticCoverage:false}),executor=(await h.flow("root","advance")).childId;
  const statePath=path.join(process.env.DSH_HOME,"building-loop-state",workspaceStateFile(root));
  const state=JSON.parse(fs.readFileSync(statePath));
  // Versions before this migration stored only two fingerprints. Simulate their
  // persisted shape and a real outstanding clarification bound to this goal.
  delete state.authorityVersions.research;
  const unit=state.units.K01;
  unit.phase="blocked";unit.resumePhase="intake";unit.outcomeClarification={goalSha256:unit.goal.sha256,
    question:"记录里写的是两种不同的口径，请维护者选择一种。"};
  fs.writeFileSync(statePath,JSON.stringify(state));
  const revised=structuredClone(p);
  delete revised.sourcePins[second];
  for(const phase of Object.values(revised.units.K01.phases)) {
    phase.read=phase.read.filter(file=>file!==second);
    if(phase.evidence)phase.evidence=phase.evidence.filter(file=>file!==second);
  }
  write("BUILDING-LOOP.json",JSON.stringify(revised));
  await assert.rejects(h.flow("root","advance"),/授权清单发生变化/u);
  write("BUILDING-LOOP.json.bak",JSON.stringify(revised));
  await assert.rejects(h.flow("root","advance"),/授权清单发生变化/u);
  write("BUILDING-LOOP.json.bak",baseline);
  await assert.rejects(h.flow("root","advance"),/等待用户澄清/u);
  assert.equal(h.activations.length,1);
  write("overview.md","项目维护者选择了记录的原始口径。");
  const next=await h.flow("root","advance");
  assert.deepEqual([next.childId,next.phase],[executor,"supplement"]);
  assert.equal((await h.flow(executor,"prepare")).sourceRevision.withdrawnCount,1);
}));

test("a verbatim repair hints only one exact acquired location in the rejected source already read under this grant", () => fixture((root,write) => {
  const { p, row } = setup(write);
  const sample = "原文为“" + secondExcerpt + "”";
  const finding = { lineText:sample, finding:{kind:"verbatim-quote",quote:sample},
    repairBaseline:{version:1,candidateSha256:"old-draft",start:0,end:sample.length,quote:sample,
      refs:[{file:source.file,start:3,end:3,sha256:digest(snapshot)}]} };
  const active = {rejectedCandidate:"old-draft",seen:{[source.file]:{hash:digest(snapshot),ranges:[[1,4]]}}};
  const frame={root,policy:authority(root),reads:[source.file]},spec=frame.policy.units.K01;
  const hint=(scope=frame,current=active,rejection=finding)=>quoteRepairLocation(scope,current,spec,rejection);
  assert.deepEqual(hint(),{file:source.file,line:4});
  assert.equal(hint({...frame,reads:[]}),undefined);
  assert.equal(hint(frame,{...active,seen:{}}),undefined);
  assert.equal(hint(frame,{...active,seen:{[source.file]:{hash:digest(snapshot),ranges:[[1,3]]}}}),undefined);
  assert.equal(hint(frame,{...active,rejectedCandidate:"another-draft"}),undefined);
  assert.equal(hint(frame,active,{...finding,finding:{...finding.finding,kind:"contradiction"}}),undefined);
  const ambiguity="Normalized control: "+secondExcerpt,expanded=snapshot+ambiguity+"\n";
  const registered=JSON.stringify({sources:[{...row,snapshotSha256:digest(expanded),exactQuotes:[...row.exactQuotes,ambiguity]}]});
  write(source.file,expanded);write("acquisition.json",registered);
  // A stale pin cannot turn a changed document into a recommended repair.
  assert.equal(hint(),undefined);
  p.sourcePins[source.file].sha256=digest(expanded);p.sourcePins[source.file].observation.sha256=digest(registered);
  write("BUILDING-LOOP.json",JSON.stringify(p));
  const newFrame={...frame,policy:authority(root)};
  const freshFinding={...finding,repairBaseline:{...finding.repairBaseline,refs:[{...finding.repairBaseline.refs[0],sha256:digest(expanded)}]}};
  const current={...active,seen:{[source.file]:{hash:digest(expanded),ranges:[[1,5]]}}};
  assert.equal(hint(newFrame,current,freshFinding),undefined);
  // Exclude the duplicate from the acquisition record, while keeping the
  // bytes in the source. Only the authenticated original rows can be offered.
  const unique=JSON.stringify({sources:[{...row,snapshotSha256:digest(expanded)}]});
  write("acquisition.json",unique);
  p.sourcePins[source.file].observation.sha256=digest(unique);write("BUILDING-LOOP.json",JSON.stringify(p));
  assert.deepEqual(hint({...frame,policy:authority(root)},current,freshFinding),{file:source.file,line:4});
}));
