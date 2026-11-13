import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { existingConversationProject, initializeConversationProject } from "../governance/conversation-project.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask, startedConversationProject } from "../governance/conversation-start.mjs";
import { ownerEngineeringReplacement, ownerEngineeringUnit } from "../governance/engineering-handoff.mjs";
import { goalSnapshot } from "../governance/goals.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { workspaceStateFile } from "../governance/session-mode.mjs";
import { fixture, host } from "./helpers.mjs";

const projectGoal = "overview.md";
const source = "solution.py";
const opening = unit => `开始建设：请按当前工作区目标改进程序。若有工作单元，G${Number(unit.slice(1))} 是 ${unit}。`;
const nativeUser = (text, seq = 12) => latestConversationUser([{ type: "user/message", seq,
  data: { source: { kind: "user" }, content: [{ type: "text", text }] } }]);

function setup(root, write) {
  const keys = generateKeyPairSync("ed25519");
  const grant = { read: [source], write: [source] };
  const receipts = id => [`${id}-first.json`, `${id}-final.json`];
  const ids = ["K01", "K02", "K03"];
  const manifest = { spec: "building-loop/1", coordinator: { read: [projectGoal, ...ids.flatMap(receipts), "DESIGN.md"],
    write: ["DESIGN.md"] }, goalContext: [projectGoal], units: Object.fromEntries(ids.map(id => [id, {
      candidate: source, codeTask: { sources: [source], tests: {
        file: `${id}-candidate-proof.json`, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        previousSuiteSha256: digest(`${id}-previous`), suiteSha256: digest(`${id}-current`), requiredCases: [`${id}-new`],
        regression: { baselineFile: `${id}-baseline.json`, previousCases: [`${id}-old`] },
      } }, phases: { intake: grant, supplement: grant,
        "first-review": { read: [source], receipt: receipts(id)[0] }, "final-review": { read: [source], receipt: receipts(id)[1] } },
    }])) };
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  write(source, "def process(value):\n    return value\n");
  write("DESIGN.md", "# Design\n");
  const stateDir = path.join(process.env.DSH_HOME, "building-loop-state");
  const statePath = path.join(stateDir, workspaceStateFile(root));
  const native = host(root, { automaticCoverage: false });
  const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  const saveState = value => fs.writeFileSync(statePath, JSON.stringify(value));
  const start = (id, text, { seq = 12, typed = true } = {}) => {
    const current = nativeUser(text, seq);
    // A hostile/wrong model summary is deliberately independent of the owner unit.
    const { proposal } = proposeConversationTask(process.env.DSH_HOME, id, current,
      { goal: "Model summary mentions K01", deliverable: "Code", scope: "K01 only" });
    return decideConversationStart(process.env.DSH_HOME, id, current, proposal.id, "start",
      task => initializeConversationProject(process.env.DSH_HOME, id, root, task), {
        typed, inspect: task => existingConversationProject(process.env.DSH_HOME, id, root, task),
      });
  };
  const baseline = id => {
    const policy = authority(root);
    const unit = policy.units[id];
    const tests = unit.codeTask.tests;
    const proof = { spec: "building-loop-code-regression-baseline/1", unit: id, policySha256: policy.hash,
      suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, unit), runId: "pre-edit",
      cases: [{ id: tests.regression.previousCases[0], status: "passed" }] };
    write(tests.regression.baselineFile, JSON.stringify({ ...proof, signature: sign(null, codeRegressionSigningBytes(proof), keys.privateKey).toString("base64") }));
  };
  return { native, state, saveState, start, baseline, manifest };
}

test("engineering unit is parsed from owner clauses, excluding code fences, quotes, negation and model summaries", () => {
  assert.equal(ownerEngineeringUnit(opening("K02")), "K02");
  assert.equal(ownerEngineeringUnit("请使用工作单元 Checkpoint_B。"), "Checkpoint_B");
  assert.equal(ownerEngineeringUnit("不要推进工作单元 K01。\n> 工作单元 K01\n“工作单元 K01”"), undefined);
  assert.equal(ownerEngineeringUnit("```text\n工作单元 K01。\n```\n工作单元 K02。"), "K02");
  assert.equal(ownerEngineeringReplacement("> 替换工作单元 K01。\n以新目标替换工作单元 K02。"), "K02");
  assert.throws(() => ownerEngineeringUnit("工作单元 K01。工作单元 K02。"), /多个不同/);
});

test("goal and unit are pinned, and a fresh coordinator claims the same workspace without rewriting completed history", () => fixture(async (root, write) => {
  const { native, state, saveState, start, baseline, manifest } = setup(root, write);
  native.coordinator("g2");
  native.coordinator("contender");
  native.coordinator("stale");
  start("root", opening("K01"));
  const initial = await native.flow("root", "status");
  assert.deepEqual(initial.checkpoint.advance, { action: "advance", unit: "K01" });
  assert.equal(initial.units.find(row => row.unit === "K02").next, null);
  assert.equal((await native.flow("root", "prepare")).unit, "K01");
  baseline("K01");
  const assigned = await native.flow("root", "advance");
  assert.equal(assigned.unit, "K01");
  start("contender", opening("K03"));
  assert.match((await native.flow("contender", "status")).checkpoint.blocked, /仍有写入权或未关单/);
  await assert.rejects(native.file("contender", "write", "DESIGN.md", { content: "stolen", note: "wrong" }), /仍有写入权或未关单/);
  await native.ledger("root", "record", { id: "followup", kind: "planned", title: "Recheck downstream",
    note: "Keep this cross-check for the next goal" });
  // Seed the final state normally written by independent acceptance and ledger
  // closure. Their evidence protocol is exercised separately in architecture tests.
  const frozen = state();
  Object.assign(frozen.units.K01, { phase: "closed", receipt: "K01-final.json", closedAt: "2026-11-12T00:00:00.000Z" });
  frozen.ledger.items["unit-K01"].status = "completed";
  write("K01-final.json", '{"accepted":true}\n');
  saveState(frozen);
  start("stale", opening("K02"));
  write(projectGoal, "# G2\n\nA newly approved goal.\n");
  assert.match((await native.flow("stale", "status")).checkpoint.blocked, /目标或授权版本已变化/);
  await assert.rejects(native.flow("stale", "advance", { unit: "K02" }), /目标或授权版本已变化/);
  // The maintainer changes the manifest between closed checkpoints. Old unit
  // rows and ledger entries survive even when removed from the current grants.
  delete manifest.units.K01;
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  start("g2", opening("K02"));
  const bound = startedConversationProject(process.env.DSH_HOME, "g2").binding.checkpoint;
  assert.equal(bound.goalSha256, goalSnapshot({ root, policy: authority(root) }).sha256);
  assert.equal(bound.predecessor, frozen.engineeringCoordinator.openingId);
  const waiting = await native.flow("g2", "status");
  assert.deepEqual(waiting.checkpoint.advance, { action: "advance", unit: "K02" });
  assert.deepEqual(waiting.units.find(row => row.unit === "K01"), { unit: "K01", phase: "closed", current: false, historical: true, next: null });
  await assert.rejects(native.flow("g2", "advance", { unit: "K01" }), /确认工作单元 K02/);
  assert.equal(state().engineeringCoordinator.session, "root");
  assert.equal(native.activations.length, 1);
  assert.equal((await native.flow("g2", "prepare")).unit, "K02");
  assert.match((await native.flow("root", "status")).blocked, /已交由当前确认/);
  assert.match((await native.flow("contender", "status")).blocked, /已交由当前确认/);
  await assert.rejects(native.file("root", "write", "DESIGN.md", { content: "stolen", note: "wrong" }), /已交由当前确认/);
  baseline("K02");
  const fresh = await native.invoke("g2", "building_loop", { action: "advance" });
  assert.equal(fresh.unit, "K02");
  assert.notEqual(fresh.childId, assigned.childId);
  assert.deepEqual(state().units.K01, frozen.units.K01);
  assert.deepEqual(state().ledger.items["unit-K01"], frozen.ledger.items["unit-K01"]);
  assert.equal(fs.readFileSync(path.join(root, "K01-final.json"), "utf8"), '{"accepted":true}\n');
  const ledger = await native.invoke("g2", "building_loop_ledger", { action: "read", includeClosed: true });
  assert.equal(ledger.items.find(row => row.id === "unit-K01").owner, "root");
  const continued = ledger.items.find(row => row.id === "followup");
  assert.equal(continued.owner, "g2");
  assert.equal(continued.originalOwner, "root");
  assert.equal(continued.status, "pending");
}));

test("a goal change disables stale source writes and dispatch while allowing the original child to report its interruption", () => fixture(async (root, write) => {
  const { native, start, baseline, state } = setup(root, write);
  native.coordinator("replacement");
  start("root", opening("K01"));
  baseline("K01");
  const { childId } = await native.flow("root", "advance");
  write(projectGoal, "# Changed goal\n");
  await assert.rejects(native.file(childId, "write", source, { content: "bad", note: "stale executor" }), /目标或授权版本已变化/);
  assert.equal((await native.flow(childId, "block", { note: "Owner has changed the goal." })).phase, "blocked");
  start("replacement", opening("K02"));
  assert.match((await native.flow("replacement", "status")).checkpoint.blocked, /仍有写入权或未关单/);
  await assert.rejects(native.flow("replacement", "advance", { unit: "K02" }), /未结单|未关单/);
  assert.equal(state().engineeringCoordinator.session, "root");
  assert.equal(state().units.K02, undefined);
}));

test("explicit new owner goal can retire a blocked old writer without lending it acceptance", () => fixture(async (root, write) => {
  const { native, start, baseline, state } = setup(root, write);
  for (const id of ["unchanged", "replacement", "competitor"]) native.coordinator(id);
  start("root", opening("K01"));
  baseline("K01");
  const { childId } = await native.flow("root", "advance");
  const replace = "以新目标替换工作单元 K01。";
  assert.throws(() => start("unchanged", opening("K02") + "替换工作单元 K03。"), /须指定当前工程总控/);
  start("unchanged", opening("K02") + replace, { seq: 13 });
  assert.match((await native.flow("unchanged", "status")).checkpoint.blocked, /不同的新目标版本/);
  write(projectGoal, "# G2\n\nPublish the actual replacement goal.\n");
  start("replacement", opening("K02") + replace);
  start("competitor", opening("K03") + replace);
  assert.match((await native.flow("replacement", "status")).checkpoint.blocked, /仍未退出可写阶段/);
  await assert.rejects(native.file("replacement", "write", "DESIGN.md", { content: "premature", note: "unsafe" }), /仍未退出可写阶段/);
  assert.equal((await native.flow(childId, "block", { note: "The owner published a newer goal." })).phase, "blocked");
  const before = state();
  const target = await native.flow("replacement", "status");
  assert.deepEqual(target.checkpoint.advance, { action: "advance", unit: "K02" });
  assert.equal(target.checkpoint.replaceUnit, "K01");
  await native.flow("replacement", "prepare");
  baseline("K02");
  assert.equal((await native.invoke("replacement", "building_loop", { action: "advance" })).unit, "K02");
  const after = state();
  assert.equal(after.units.K01.phase, "retired");
  assert.equal(after.units.K01.owner, before.units.K01.owner);
  assert.equal(after.units.K01.retirement.oldGoalSha256, before.units.K01.goal.sha256);
  assert.equal(after.units.K01.retirement.newGoalSha256, after.units.K02.goal.sha256);
  assert.equal(after.units.K01.retirement.previousPhase, "intake");
  assert.equal(after.units.K01.retirement.newUnit, "K02");
  assert.equal(after.ledger.items["unit-K01"].status, "superseded");
  assert.equal(after.units.K01.receipt, undefined);
  const book = await native.invoke("replacement", "building_loop_ledger", { action: "read", includeClosed: true });
  assert.equal(book.items.find(row => row.id === "unit-K01").retirement.userSha256, digest(opening("K02") + replace));
  assert.match((await native.flow("competitor", "status")).blocked, /已交由当前确认/);
}));

test("a changed owner goal supersedes an undispatched legacy planning lease, preserving files and denying the old coordinator", () => fixture(async (root, write) => {
  const { native, start, baseline, state, saveState } = setup(root, write);
  for (const id of ["same-goal", "new", "contender", "unapproved"]) native.coordinator(id);
  start("root", opening("K01"));
  await native.flow("root", "prepare");
  await native.file("root", "write", "DESIGN.md", { content: "# Real G1 plan\n", note: "Plan before dispatch" });
  const old = state();
  assert.deepEqual(old.units, {});
  const oldGoal = old.engineeringCoordinator.goalSha256;
  delete old.engineeringCoordinator.goalSha256; // A persisted 0.7.22 lease predates this field.
  saveState(old);
  start("same-goal", opening("K02"));
  assert.match((await native.flow("same-goal", "status")).checkpoint.blocked, /须先发布与原计划不同/);
  await assert.rejects(native.file("same-goal", "write", "DESIGN.md", { content: "stolen", note: "same goal" }), /须先发布与原计划不同/);

  write(projectGoal, "# New owner goal\n\nUse K02.\n");
  assert.match((await native.flow("unapproved", "status")).blocked, /已交由当前确认/);
  await assert.rejects(native.file("root", "write", "DESIGN.md", { content: "stale", note: "old owner" }), /目标或授权版本已变化/);
  start("new", opening("K02"));
  start("contender", opening("K03") + "以新目标替换工作单元 K01。");
  assert.deepEqual((await native.flow("new", "status")).checkpoint.advance, { action: "advance", unit: "K02" });
  await assert.rejects(native.flow("new", "advance", { unit: "K01" }), /确认工作单元 K02/);
  assert.equal(state().engineeringCoordinator.session, "root");
  assert.equal((await native.flow("new", "prepare", { unit: "K02" })).unit, "K02");
  const handed = state();
  assert.deepEqual(handed.units, {});
  assert.equal(handed.planningHandoff.previousOpeningId, old.engineeringCoordinator.openingId);
  assert.equal(handed.planningHandoff.oldGoalSha256, oldGoal);
  assert.equal(handed.planningHandoff.newGoalSha256, handed.engineeringCoordinator.goalSha256);
  assert.equal(handed.planningHandoff.userSha256, digest(opening("K02")));
  assert.equal(handed.ledger.items["unit-K01"], undefined);
  assert.equal(fs.readFileSync(path.join(root, "DESIGN.md"), "utf8"), "# Real G1 plan\n");
  assert.match((await native.flow("root", "status")).blocked, /已交由当前确认/);
  assert.match((await native.flow("contender", "status")).blocked, /已交由当前确认/);
  await assert.rejects(native.file("root", "write", "DESIGN.md", { content: "stale", note: "old owner" }), /已交由当前确认/);
  baseline("K02");
  assert.equal((await native.invoke("new", "building_loop", { action: "advance" })).unit, "K02");
  assert.deepEqual(Object.keys(state().units), ["K02"]);
}));

test("a planning claim with a wrong predecessor identity or an unrelated durable writer fails closed", () => fixture(async (root, write) => {
  const { native, start, state, saveState } = setup(root, write);
  native.coordinator("new");
  start("root", opening("K01"));
  await native.flow("root", "prepare");
  const original = state();
  write(projectGoal, "# Updated goal\n");
  start("new", opening("K02") + "以新目标替换工作单元 K01。");
  const wrong = structuredClone(original);
  wrong.engineeringCoordinator.session = "other-owner";
  saveState(wrong);
  assert.match((await native.flow("new", "status")).checkpoint.blocked, /无法核对原总控/);
  await assert.rejects(native.flow("new", "prepare", { unit: "K02" }), /无法核对原总控/);

  const rolledBack = structuredClone(original);
  rolledBack.ledger.items["unit-K01"] = { id: "unit-K01", unit: "K01", owner: "root", status: "running" };
  saveState(rolledBack);
  assert.match((await native.flow("new", "status")).checkpoint.blocked, /已有派单台账记录/);
  await assert.rejects(native.flow("new", "prepare", { unit: "K02" }), /已有派单台账记录/);

  const active = structuredClone(original);
  active.units.K03 = { owner: "other-owner", actor: "actual-child", phase: "intake" };
  saveState(active);
  assert.match((await native.flow("new", "status")).checkpoint.blocked, /其他未关单/);
  await assert.rejects(native.flow("new", "prepare", { unit: "K02" }), /其他未关单/);
  assert.deepEqual(state(), active);
}));

test("missing and unregistered engineering units can be corrected before approval is committed", () => fixture(async (root, write) => {
  const { start } = setup(root, write);
  assert.throws(() => start("root", "开始建设：落实项目目标。"), /多个授权工作单元/);
  assert.equal(startedConversationProject(process.env.DSH_HOME, "root"), undefined);
  assert.throws(() => start("root", opening("K09"), { seq: 14 }), /未获授权：K09/);
  assert.equal(startedConversationProject(process.env.DSH_HOME, "root"), undefined);
  assert.equal(start("root", opening("K02"), { seq: 16 }).binding.checkpoint.unit, "K02");
}));

test("engineering coordinator prepare resumes actual current pages without rereading old receipts or bypassing ledger reads", () => fixture(async (root, write) => {
  const { native, state, saveState, start, baseline, manifest } = setup(root, write);
  const architecture = "modules/architecture.md";
  const template = "# 架构\n\n## 实施\n\n待填写。\n";
  fs.mkdirSync(path.join(root, "modules"));
  manifest.instructions = ["RULES.md"];
  manifest.coordinator.read.push("INDEX.md", architecture, "HANDOFF.md", "RULES.md");
  manifest.coordinator.write.push(architecture);
  manifest.hierarchy = { overview: { path: projectGoal, heading: "入口" }, index: { path: "INDEX.md", heading: "模块" },
    modules: { architecture } };
  manifest.units.K02.architecture = { module: "architecture", headings: ["实施"] };
  manifest.units.K02.plainLast = false;
  for (const phase of ["first-review", "final-review"]) manifest.units.K02.phases[phase].read = [source, architecture];
  write("BUILDING-LOOP.json", JSON.stringify(manifest));
  write(projectGoal, "# Current goal\n\n## 入口\n\n- [Index](INDEX.md)\n");
  write("INDEX.md", "# Index\n\n## 模块\n\n- [Architecture](modules/architecture.md)\n");
  write(architecture, template);
  write("RULES.md", Array.from({ length: 400 }, (_, index) => `Rule ${index + 1}.`).join("\n"));
  write("HANDOFF.md", "Historical handoff\n");
  write("K01-first.json", "Old first receipt\n".repeat(925));
  start("root", opening("K02"));
  const initialStatus = await native.flow("root", "status");
  const action = { tool: "building_loop_file", action: "write", path: architecture, required: ["content", "note"],
    then: { tool: "building_loop", action: "architecture", unit: "K02" } };
  assert.deepEqual(initialStatus.units.find(unit => unit.unit === "K02").architecture.next, action);
  const first = await native.flow("root", "prepare", { unit: "K02" });
  assert.deepEqual(first.next, action);
  assert.deepEqual(first.files.map(row => row.path), [projectGoal, "RULES.md", "INDEX.md", architecture]);
  assert.equal(first.pending[0].start, 251);
  await native.file("root", "read", "RULES.md", { start: 301, count: 25 });
  const second = await native.flow("root", "prepare", { unit: "K02" });
  assert.deepEqual(second.files.map(row => row.path), ["RULES.md"]);
  assert.deepEqual(second.files[0].lines.map(([line]) => line),
    [...Array.from({ length: 50 }, (_, i) => i + 251), ...Array.from({ length: 75 }, (_, i) => i + 326)]);
  assert.deepEqual(second.pending, []);
  assert.deepEqual((await native.flow("root", "prepare", { unit: "K02" })).files, []);
  assert.equal((await native.file("root", "read", "K01-first.json", { count: 3 })).lines.length, 3);
  assert.equal((await native.file("root", "read", "HANDOFF.md")).lines[0][1], "Historical handoff");

  const revised = template.replace("待填写。", "Limit data at the handler before calling the downstream boundary.");
  await native.file("root", "write", architecture, { content: revised, note: "Implement the actual architecture plan" });
  const changed = await native.flow("root", "prepare", { unit: "K02" });
  assert.deepEqual(changed.files.map(row => row.path), [architecture]);
  assert.equal(changed.files[0].lines[0][0], 1);
  assert.deepEqual(changed.next, { tool: "building_loop", action: "architecture", unit: "K02" });
  await native.flow("root", "architecture", { unit: "K02" });
  baseline("K02");
  await native.flow("root", "advance", { unit: "K02" });
  const ledgerPhase = state();
  Object.assign(ledgerPhase.units.K02, { phase: "ledger-review", receipt: "K02-first.json", ledgerSeen: {} });
  write("K02-first.json", '{"current":true}\n');
  saveState(ledgerPhase);
  const ledger = await native.flow("root", "prepare", { unit: "K02" });
  assert.ok(ledger.files.some(row => row.path === projectGoal), "ledger needs a fresh read independent of the earlier packet cursor");
  assert.ok(ledger.files.some(row => row.path === "K02-first.json"));
  assert.ok(!ledger.files.some(row => row.path === "K01-first.json"));
  assert.equal(state().units.K02.ledgerSeen[projectGoal].hash, ledger.files.find(row => row.path === projectGoal).sha256);
}));
