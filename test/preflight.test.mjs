import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../governance/index.mjs";
import { QUALITY, lineList, numericChecks, rejectedClaims, supplementChecks } from "../governance/preflight.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { evidenceReference, expectedClaims } from "../governance/evidence.mjs";

import { fixture, host, policy, seed } from "./helpers.mjs";

test("actual submit handler blocks unchanged and incorrect candidates before final review", async () => fixture(async (root, write) => {
  const { flow, file, assess, interrupt, notifications, ledger, user } = host(root);
  user("root", 1, "后续补充更多采样，但先把当前任务完成。");
  await ledger("root", "record", { id: "future-samples", kind: "planned", title: "扩大样本", note: "当前样例只核两条均值，后续再加采样。" });
  await ledger("root", "record", { id: "old-collector", kind: "temporary", title: "旧采集方案", note: "待结合当前项目现状判断。" });
  const worker = (await flow("root", "advance")).childId;
  await file(worker, "read", "candidate.md");
  await file(worker, "read", "overview.md");
  await flow(worker, "submit");
  const reviewer = (await flow("root", "advance")).childId;
  for (const name of ["candidate.md", "functional.csv", "overview.md"]) await file(reviewer, "read", name);
  const c1 = { id: "C1", status: "supported", file: "functional.csv", start: 1, end: 2, basis: "第1行为表头，第2行确为19,20" };
  const c2 = { id: "C2", status: "supported", file: "timing.csv", start: 2, end: 3, basis: "原文为120到96，差24，除以120得20%" };
  const rejected = await flow(reviewer, "review", { checks: [c1, { id: "C2", status: "unsupported", basis: "没有来源", finding: { kind: "missing-evidence", quote: "平均耗时下降 25%", fix: "读取原始耗时数据后更正或补证据" } }] });
  assert.deepEqual(rejected.unsupported, ["C2"]);
  assert.deepEqual(await flow("root", "advance"), { unit: "K01", phase: "supplement", childId: worker, reused: true });
  await file(worker, "read", "candidate.md");
  await file(worker, "read", "overview.md");
  const check = await flow(worker, "preflight");
  assert.equal(check.calculations[0].expected, "20%");
  const notified = notifications.length;
  await assert.rejects(flow(worker, "submit"), /C2 的退回结论与可定位证据均未变/);
  await assert.rejects(flow("root", "advance"), /尚未交付/);
  assert.equal(notifications.length, notified);
  const withValue = n => seed.replace("25%。", n + "%（出处：timing.csv 第 2-3 行）。");
  await file(worker, "write", "candidate.md", { content: withValue("24"), note: "负向复现" });
  await file(worker, "read", "candidate.md");
  await file(worker, "read", "overview.md");
  await assert.rejects(flow(worker, "submit"), /降幅应为 20%/);
  await assert.rejects(flow("root", "advance"), /尚未交付/);
  assert.ok(!fs.existsSync(path.join(root, "final.json")));
  await file(worker, "write", "candidate.md", { content: withValue("20"), note: "重算" });
  await file(worker, "read", "candidate.md");
  await file(worker, "read", "overview.md");
  await assert.rejects(flow(worker, "submit"), /本补查阶段实际读取/);
  await file(worker, "read", "timing.csv");
  await assert.rejects(flow(worker, "submit"), /质量项 sources/);
  const quality = Object.fromEntries(Object.entries(QUALITY).map(([k, label]) => [k, "本样例具体说明 " + label]));
  quality.sources += "证据位于原始数据文件及相应行。".repeat(65);
  await flow(worker, "submit", { quality });
  assert.equal((await flow("root", "advance")).childId, reviewer);
  interrupt(reviewer);
  const [paused] = (await flow("root", "status")).units;
  assert.equal(paused.phase, "blocked");
  assert.equal(paused.next, "final-review");
  assert.equal(paused.interruptions, 1);
  assert.deepEqual(await flow("root", "advance"), { unit: "K01", phase: "final-review", childId: reviewer, reused: true });
  await assert.rejects(assess("root", {}), /独立核验方/);
  for (const name of ["candidate.md", "functional.csv", "timing.csv", "overview.md"]) await file(reviewer, "read", name);
  await assert.rejects(flow(reviewer, "review", { checks: [c1, c2] }), /先用 building_loop_quality/);
  await assert.rejects(assess(reviewer, { revise: [] }), /质量项 sources/);
  const qualityChecks = Object.fromEntries(Object.entries(QUALITY).map(([k, label]) => [k, "独立核验 " + label]));
  const proofArgs = { goalFit: { pass: true, basis: "本轮只验 CSV 小样例，交付边界符合现目标。" }, sourceRefs: [{ file: "functional.csv", start: 1, end: 2 }, { file: "timing.csv", start: 2, end: 3 }],
    unverifiedSources: [], unlisted: [] };
  await assert.rejects(assess(reviewer, { ...qualityChecks, ...proofArgs, sources: "我实际读过 first.json。", revise: [] }), /本轮未实际读取/);
  await assert.rejects(assess(reviewer, { ...qualityChecks, ...proofArgs,
    sourceRefs: [{ file: "first.json", start: 1, end: 2 }], revise: [] }), /证据授权/);
  qualityChecks.sources = "没有交代数据是合成材料";
  assert.deepEqual((await assess(reviewer, { ...qualityChecks, ...proofArgs, revise: ["sources"], revisions: [{ field: "sources", change: "候选标明合成数据边界", requirement: { file: "overview.md", start: 2, end: 2 } }] })).revise, ["sources"]);
  assert.ok(!fs.existsSync(path.join(root, "final.json")));
  write("candidate.md", withValue("20") + "\n结果的范围限于样例。\n");
  await file(reviewer, "read", "candidate.md");
  await assert.rejects(flow(reviewer, "review", { checks: [c1, c2] }), /当前候选的六项/);
  await assess(reviewer, { ...qualityChecks, ...proofArgs, revise: ["sources"], revisions: [{ field: "sources", change: "候选标明合成数据边界", requirement: { file: "overview.md", start: 2, end: 2 } }] });
  assert.deepEqual((await flow(reviewer, "review", { checks: [c1, c2] })).qualityRejected, ["sources"]);
  assert.equal((await flow("root", "advance")).childId, worker);
  await file(worker, "read", "candidate.md");
  await file(worker, "read", "overview.md");
  await assert.rejects(flow(worker, "submit", { quality }), /质量退回须落实到候选正文/);
  await file(worker, "write", "candidate.md", { content: withValue("20")+"\n数据来自合成样例，生产代表性未核。\n", note: "落实来源边界" });
  await file(worker,"read","candidate.md");
  await assert.rejects(flow(worker,"submit",{quality}), /退回的质量项 sources 没有修订/);
  await flow(worker, "submit", { quality: { ...quality, sources: "用户提供的合成 CSV，生产代表性未核" } });
  await flow("root", "advance");
  for (const name of ["candidate.md", "functional.csv", "timing.csv", "overview.md"]) await file(reviewer, "read", name);
  qualityChecks.sources = "报告区分合成数据和未核实的生产效果";
  const assessment = await assess(reviewer, { ...qualityChecks, ...proofArgs, revise: [] });
  assert.deepEqual(assessment.observedSources.map(row => row.file), ["functional.csv", "timing.csv"]);
  assert.ok(!assessment.actualReads.some(row => row.file === "first.json"));
  assert.equal((await flow(reviewer, "review", { checks: [c1, c2] })).phase, "ledger-review");
  await assert.rejects(flow("root", "advance"), /尚未交付/);
  const reviewArgs = { note: "按本轮验收与最新总纲逐项处置。", decisions: [] };
  await assert.rejects(ledger("root", "review", reviewArgs), /读取最新账本/);
  await ledger("root", "read");
  await assert.rejects(ledger("root", "review", reviewArgs), /读取最新项目现状/);
  await file("root", "read", "overview.md");
  await file("root", "read", "final.json");
  await assert.rejects(ledger("root", "review", reviewArgs), /逐项处置/);
  await ledger("root", "record", { id: "temporary-note", kind: "temporary", title: "临时提醒", note: "本轮完成后保留，等待核定。" });
  await assert.rejects(ledger("root", "review", reviewArgs), /读取最新账本/);
  const current = await ledger("root", "read", { unit: undefined });
  assert.equal(current.current.unit, "K01");
  reviewArgs.decisions = current.items.map(item => item.id === "unit-K01"
    ? { id: item.id, outcome: "completed", basis: "本轮独立验收已通过。", evidence: { file: "final.json", start: 1, end: 6 } }
    : item.id === "old-collector"
      ? { id: item.id, outcome: "covered", coveredBy: "K01", basis: "当前总纲确认旧方案已被当前样例覆盖。", evidence: { file: "overview.md", start: 2, end: 2 } }
      : { id: item.id, outcome: "keep", basis: "当前只验收小样例，后续采样需求仍有效，待下一轮安排。" });
  write("overview.md", "# 当前项目\n现状已更新，旧采集方案由当前 CSV 样例覆盖。\n");
  await assert.rejects(ledger("root", "review", reviewArgs), /当前目标/);
  await file("root", "read", "overview.md");
  await assert.rejects(ledger("root", "review", reviewArgs), /当前目标/);
  assert.equal((await flow("root", "advance")).childId, reviewer);
  for (const name of ["candidate.md","functional.csv","timing.csv","overview.md"]) await file(reviewer,"read",name);
  await assess(reviewer, { ...qualityChecks, ...proofArgs, revise: [] });
  await flow(reviewer,"review", { checks: [c1,c2] });
  await ledger("root","read");
  await file("root","read","overview.md");
  await file("root","read","final.json");
  assert.equal((await ledger("root", "review", { ...reviewArgs, unit: undefined })).phase, "closed");
  assert.equal((await ledger("root", "review", reviewArgs)).replayed, true);
  const history = await ledger("root", "read", { includeClosed: true });
  assert.equal(history.items.find(row => row.id === "old-collector").status, "covered");
  assert.ok(history.items.find(row => row.id === "unit-K01").lastInterruption);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "final.json"), "utf8"));
  assert.equal(receipt.calculations[0].expected, "20%");
  assert.equal(receipt.qualityChecks.sources.pass, true);
}));

test("evidence-only repair must cite actually read new data, not cosmetic changes", async () => fixture(async root => {
  const spec = authority(root).units.K01;
  spec.calculations = {};
  const readable = ["timing.csv"];
  const lines = lineList(Buffer.from(seed));
  const rejected = rejectedClaims(root, spec, lines, [{ id: "C2" }], []);
  const active = { rejected, unsupported: ["C2"], seen: {} };
  const check = content => supplementChecks(root, spec, lineList(Buffer.from(content)), readable, active);
  assert.equal(check(seed.replace("下降 25%。", "下降 ２５％。").replace("# 摘要", "# 调整标题")).ok, false);
  const withEvidence = seed.replace("25%。", "25%（出处：timing.csv 第 2-3 行）。");
  assert.equal(check(withEvidence).ok, false);
  active.seen["timing.csv"] = { hash: digest(fs.readFileSync(path.join(root, "timing.csv"))), ranges: [[2, 3]] };
  assert.equal(check(withEvidence).ok, true);
}));

test("numeric proof rejects bad scope, ambiguous numerals, bad locators and invalid source rows", async () => fixture(async (root, write) => {
  const spec = authority(root).units.K01;
  const make = (n, cite = "timing.csv 第 2–3 行") => lineList(Buffer.from("- C2：下降 " + n + "（出处：" + cite + "）。"));
  const check = (n, cite, reads = ["timing.csv"]) => numericChecks(root, spec, make(n, cite), reads)[0];
  assert.equal(check("20.00%").ok, true);
  assert.equal(check("20%（(120-96)/120×100%=20%）").ok, true);
  for (const n of ["24 ms", "24%", "−20%", "1e20%", "24% 或 20%"]) assert.equal(check(n).ok, false, n);
  for (const cite of ["timing.csv.bak 第 2–3 行", "timing.csv 第 2 行", "timing.csv 第 2–999 行"]) {
    assert.equal(check("20%", cite).ok, false, cite);
  }
  assert.match(check("20%", undefined, []).issue, /读取授权/);
  write("timing.csv", "phase,mean_ms\nbefore,120\nafter,96\nafter,95\n");
  assert.match(check("20%").issue, /重复数据行/);
  write("timing.csv", "phase,mean_ms\nbefore,0\nafter,96\n");
  assert.match(check("20%").issue, /正基准/);
}));

test("new factual IDs are mandatory and origin pins detect replacement after a fresh read", async () => fixture(async (root, write) => {
  const doc = structuredClone(policy);
  doc.sourcePins = Object.fromEntries(["functional.csv", "timing.csv"].map(file => [file, {
    sha256: digest(fs.readFileSync(path.join(root, file))), kind: "synthetic", locator: "synthetic-test-fixture/" + file,
  }]));
  doc.units.K01.requireSourcePins = true;
  write("BUILDING-LOOP.json", JSON.stringify(doc));
  const spec = authority(root).units.K01;
  assert.deepEqual(expectedClaims(spec, ["- C1：已知。", "- C3：额外断言。"]), ["C1", "C2", "C3"]);
  const bytes = fs.readFileSync(path.join(root, "timing.csv"));
  const frame = { root, policy: authority(root) };
  const active = { phase: "final-review", seen: { "timing.csv": { hash: digest(bytes), ranges: [[1, 3]] } } };
  assert.equal(evidenceReference(frame, active, spec, { file: "timing.csv", start: 2, end: 3 }).origin.kind, "synthetic");
  write("timing.csv", "phase,mean_ms\nbefore,120\nafter,95\n");
  active.seen["timing.csv"].hash = digest(fs.readFileSync(path.join(root, "timing.csv")));
  assert.throws(() => evidenceReference(frame, active, spec, { file: "timing.csv", start: 2, end: 3 }), /原始版本不符/);
}));

test("unlisted prose and newly numbered facts cannot escape independent review", async () => fixture(async (root, write) => {
  const doc = structuredClone(policy);
  doc.units.K01.phases["first-review"].read.push("timing.csv");
  doc.units.K01.phases["first-review"].evidence.push("timing.csv");
  write("BUILDING-LOOP.json", JSON.stringify(doc));
  const candidate = seed.replace("25%。", "20%（出处：timing.csv 第 2-3 行）。") + "本系统在所有环境都更快。\n- C3：另一个未核实的结论。\n";
  write("candidate.md", candidate);
  const { flow, file, assess, coverage } = host(root,{automaticCoverage:false});
  const worker = (await flow("root", "advance")).childId;
  await file(worker, "read", "candidate.md");
  await file(worker, "read", "overview.md");
  await flow(worker, "submit");
  const reviewer = (await flow("root", "advance")).childId;
  for (const name of ["candidate.md", "functional.csv", "timing.csv", "overview.md"]) await file(reviewer, "read", name);
  const checks = [{ id: "C1", status: "supported", file: "functional.csv", start: 1, end: 2, basis: "通过数与总数与数据一致" },
    { id: "C2", status: "supported", file: "timing.csv", start: 2, end: 3, basis: "原始两值复算为20%" }];
  const notes = Object.fromEntries(Object.keys(QUALITY).map(key => [key, "本轮已读样例与范围的独立判断。"]));
  // Metadata must now agree with actual full-document decisions. The numbered
  // checks below still independently test the missing-C3 review contract.
  const inventory=await coverage(reviewer,"inventory");
  await coverage(reviewer,"record",{entries:inventory.blocks.map(block=>({block:block.id,parts:[
    block.line===1?{kind:"nonfactual",status:"supported",basis:"结构标题没有外部事实判断。"}
    :block.line===2||block.line===3?{kind:"direct",status:"supported",sourceRelation:"supports",basis:"本条转述对应的原始样例数据。",
      evidence:[block.line===2?{file:"functional.csv",start:2,end:2,quote:"19,20"}:{file:"timing.csv",start:2,end:3,quote:"before,120\nafter,96"}]}
    :{kind:"direct",status:"unsupported",sourceRelation:"insufficient",basis:"泛化或新增结论缺少对应范围的证据。",
      finding:{kind:"missing-evidence",quote:block.text,fix:"查证后收窄为有据的结论，并给原文位置。"}},
  ]}))});
  await assess(reviewer, { ...notes, goalFit: { pass: true, basis: "小样例范围符合项目目标。" }, revise: [], sourceRefs: checks.map(({ file, start, end }) => ({ file, start, end })),
    unverifiedSources: [], unlisted: [{ line: 4, basis: "泛化到所有环境缺少相应采样。" }] });
  await assert.rejects(flow(reviewer, "review", { checks }), /核验参数缺少 C3/);
  assert.equal((await flow("root", "status")).units[0].phase, "first-review");
  const result = await flow(reviewer, "review", { checks: [...checks, {
    id: "C3", status: "unsupported", basis: "该条新增结论未提供证据", finding: {
      kind: "missing-evidence", quote: "另一个未核实的结论", fix: "查证后改为有据的事实并附原文位置",
    },
  }] });
  assert.deepEqual(result.unsupported, ["C3"]);
  assert.deepEqual(result.qualityRejected, ["sources"]);
  await flow("root", "advance");
  await file(worker, "read", "candidate.md");
  await file(worker, "read", "overview.md");
  await assert.rejects(flow(worker, "submit", { quality: notes }), /未登记事实仍未修订/);
}));
