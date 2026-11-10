import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host, policy } from "./helpers.mjs";
import { digest, readBytes } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";

const ref = { file: "functional.csv", start: 2, end: 2, quote: "19,20" };
const files = ["ledger.md", ".building-loop/changes/ledger.md.md", ".building-loop/latest_backup/ledger.md",
  ".building-loop/latest_backup/.building-loop/changes/ledger.md.md"];

/** Build an actual ledger-review checkpoint and a prior generated snapshot. */
async function scenario(root, write) {
  const config = structuredClone(policy);
  config.units.K01.claims = ["C1"];
  config.units.K01.calculations = {};
  config.coordinator.write = ["ledger.md"];
  config.coordinator.read.push("ledger.md");
  config.ledgerDocument = "ledger.md";
  write("BUILDING-LOOP.json", JSON.stringify(config));
  write("candidate.md", "- C1：本例通过19/20（出处：functional.csv 第 2 行）。\n");
  write("ledger.md", "# 项目既有快照\n");
  const h = host(root);
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  await h.flow(reviewer, "prepare");
  await h.assess(reviewer, { ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "核对当前原始样例及交付边界。"])),
    sourceRefs: [ref], unverifiedSources: [], unlisted: [], revise: [], goalFit: { pass: true, basis: "交付现行样例说明。" } });
  assert.equal((await h.flow(reviewer, "review", { checks: [{ ...ref, id: "C1", status: "supported", basis: "CSV 原文为 19/20。" }] })).phase, "ledger-review");
  await h.flow("root", "prepare");
  const book = await h.ledger("root", "read");
  const decisions = book.items.map(item => ({ id: item.id, outcome: "completed", basis: "本单元已独立验收。",
    evidence: { file: "first.json", start: 1, end: 5 } }));
  await h.ledger("root", "export");
  const stateHome = path.join(process.env.DSH_HOME, "building-loop-state");
  const stateFile = fs.readdirSync(stateHome).find(file => /^[a-f0-9]{64}\.json$/.test(file));
  const statePath = path.join(stateHome, stateFile);
  return { h, decisions, stateHome, stateFile, statePath, before: files.map(file => readBytes(root, file)),
    stateBefore: fs.readFileSync(statePath), backupBefore: fs.readFileSync(statePath + ".bak") };
}

/** Terminate a separate real Node process on an exact production rename. */
function crashAt(root, fixture, target, phase) {
  const source = `import fs from "node:fs"; import path from "node:path";
import { host } from ${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)};
const [root,target,phase,decisions] = process.argv.slice(1);
const h=host(root),rename=fs.renameSync;
fs.renameSync=(from,to)=>{
  if(path.resolve(to)!==target)return rename(from,to);
  if(phase==="after")rename(from,to);
  fs.writeSync(1,"terminated before returning from "+phase+" rename\\n");
  process.kill(process.pid,"SIGKILL");
};
await h.ledger("root","review",{decisions:JSON.parse(decisions)});
throw new Error("crash point was not reached");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, root, target, phase,
    JSON.stringify(fixture.decisions)], { env: process.env, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, new RegExp("terminated before returning from " + phase + " rename"), result.stderr);
  assert.equal(fs.existsSync(fixture.statePath + ".lock"), true, "The actual process cannot run its finally clause.");
}

test("hard exit before state commit restores exact ledger and rolling backup bytes on restart", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  crashAt(root, f, f.statePath, "before");
  assert.deepEqual(fs.readFileSync(f.statePath), f.stateBefore);
  assert.notDeepEqual(readBytes(root, "ledger.md"), f.before[0]);
  const restarted = host(root);
  assert.equal((await restarted.flow("root", "status")).units[0].phase, "ledger-review");
  assert.deepEqual(fs.readFileSync(f.statePath), f.stateBefore);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.backupBefore);
  assert.deepEqual(files.map(file => readBytes(root, file)), f.before);
  assert.equal(fs.existsSync(f.statePath + ".lock"), false);
  assert.equal(fs.existsSync(f.statePath + ".ledger-txn"), false);
  assert.equal((await restarted.ledger("root", "review", { decisions: f.decisions })).phase, "closed");
}));

test("hard exit during a partial ledger projection rolls back only the known writes", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  crashAt(root, f, path.join(root, ".building-loop", "changes", "ledger.md.md"), "after");
  assert.deepEqual(readBytes(root, "ledger.md"), f.before[0]);
  assert.notDeepEqual(readBytes(root, files[1]), f.before[1]);
  const restarted = host(root);
  assert.equal((await restarted.flow("root", "status")).units[0].phase, "ledger-review");
  assert.deepEqual(files.map(file => readBytes(root, file)), f.before);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.backupBefore);
}));

test("hard exit after committed state keeps the published matching projection and makes retry idempotent", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  crashAt(root, f, f.statePath, "after");
  const published = files.map(file => readBytes(root, file));
  const committed = fs.readFileSync(f.statePath);
  assert.notDeepEqual(committed, f.stateBefore);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.stateBefore);
  const restarted = host(root);
  const replay = await restarted.ledger("root", "review", { decisions: f.decisions });
  assert.equal(replay.phase, "closed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.document.sha256, digest(published[0]));
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.stateBefore);
  assert.deepEqual(files.map(file => readBytes(root, file)), published);
  assert.equal(fs.existsSync(f.statePath + ".ledger-txn"), false);
}));

test("a second hard exit during recovery resumes from already restored byte pairs", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  crashAt(root, f, f.statePath, "before");
  crashAt(root, f, path.join(root, "ledger.md"), "after");
  assert.deepEqual(readBytes(root, "ledger.md"), f.before[0]);
  assert.notDeepEqual(readBytes(root, files[1]), f.before[1]);
  assert.equal((await host(root).flow("root", "status")).units[0].phase, "ledger-review");
  assert.deepEqual(files.map(file => readBytes(root, file)), f.before);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.backupBefore);
  assert.equal(fs.existsSync(f.statePath + ".ledger-txn"), false);
}));

test("intervening external ledger edits or policy changes leave journal and every current file intact", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  crashAt(root, f, f.statePath, "before");
  const written = files.map(file => readBytes(root, file));
  const restarted = host(root);
  write("ledger.md", "# 用户的中途修改\n");
  await assert.rejects(restarted.ledger("root", "read"), /未完成账本事务.*文件发生外部变化/);
  assert.match(readBytes(root, "ledger.md").toString(), /用户的中途修改/);
  assert.deepEqual(files.slice(1).map(file => readBytes(root, file)), written.slice(1));
  assert.deepEqual(fs.readFileSync(f.statePath), f.stateBefore);
  assert.equal(fs.existsSync(f.statePath + ".ledger-txn"), true);
  write("ledger.md", written[0]);
  const authorization = readBytes(root, "BUILDING-LOOP.json");
  write("BUILDING-LOOP.json", Buffer.concat([authorization, Buffer.from("\n")]));
  await assert.rejects(restarted.ledger("root", "read"), /未完成账本事务.*授权清单/);
  assert.deepEqual(files.map(file => readBytes(root, file)), written);
  write("BUILDING-LOOP.json", authorization);
  assert.equal((await restarted.ledger("root", "read")).current.phase, "ledger-review");
  assert.deepEqual(files.map(file => readBytes(root, file)), f.before);
}));

test("an external edit after a committed hard exit is preserved and must be reconciled explicitly", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  crashAt(root, f, f.statePath, "after");
  const state = fs.readFileSync(f.statePath);
  const log = readBytes(root, files[1]);
  write("ledger.md", "# 外部修改发生在提交后\n");
  const restarted = host(root);
  await assert.rejects(restarted.ledger("root", "review", { decisions: f.decisions }), /文件发生外部变化/);
  assert.match(readBytes(root, "ledger.md").toString(), /外部修改发生在提交后/);
  assert.deepEqual(readBytes(root, files[1]), log);
  assert.deepEqual(fs.readFileSync(f.statePath), state);
  assert.equal(fs.existsSync(f.statePath + ".ledger-txn"), true);
}));

test("active and unrecognized state locks cannot be stolen", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  const lock = f.statePath + ".lock";
  const owner = path.join(lock, "owner-" + process.pid + "-11111111-1111-1111-1111-111111111111");
  fs.mkdirSync(lock);
  fs.closeSync(fs.openSync(owner, "wx"));
  await assert.rejects(f.h.ledger("root", "read"), /工作台账正在更新/);
  assert.equal(fs.existsSync(owner), true);
  fs.unlinkSync(owner);
  assert.equal((await f.h.ledger("root", "read")).current.phase, "ledger-review");
  assert.equal(fs.existsSync(lock), false, "A process may stop between retiring the unique owner and removing the empty directory.");
  fs.writeFileSync(lock, "");
  await assert.rejects(f.h.ledger("root", "read"), /工作台账锁来源未知/);
  assert.equal(fs.statSync(lock).isFile(), true);
}));

/** Inject only the exact claim rename; production performs all other writes. */
async function failClaims(f, inject, run) {
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to === f.statePath + ".lock" && from.startsWith(f.statePath + ".claim-")) {
      const [owner] = fs.readdirSync(from);
      assert.match(owner, /^owner-/u);
      assert.equal(fs.statSync(path.join(from, owner)).isFile(), true);
      inject(++attempts);
    }
    return rename(from, to);
  };
  try { await run(); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readdirSync(f.stateHome).some(file => file.startsWith(f.stateFile + ".claim-")), false);
  return attempts;
}

function assertUnchanged(root, f) {
  assert.deepEqual(fs.readFileSync(f.statePath), f.stateBefore);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.backupBefore);
  assert.deepEqual(files.map(file => readBytes(root, file)), f.before);
  assert.equal(fs.existsSync(f.statePath + ".ledger-txn"), false);
}

const windowsOnly = { skip: process.platform !== "win32" };
const claimError = code => Object.assign(new Error("Injected Windows claim rename " + code), { code });

test("Windows lock publication retries transient EPERM, EBUSY and EACCES before the ledger can change", windowsOnly, async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  const failures = ["EPERM", "EBUSY", "EACCES"];
  assert.equal(await failClaims(f, attempt => {
    assertUnchanged(root, f);
    if (attempt <= failures.length) throw claimError(failures[attempt - 1]);
  }, async () => {
    assert.equal((await f.h.ledger("root", "review", { decisions: f.decisions })).phase, "closed");
  }), 4);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.stateBefore);
}));

test("Windows lock publication caps persistent denial and keeps the original error and bytes", windowsOnly, async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  const error = claimError("EPERM");
  assert.equal(await failClaims(f, () => {
    assertUnchanged(root, f);
    throw error;
  }, () => assert.rejects(f.h.ledger("root", "review", { decisions: f.decisions }), actual => actual === error)), 5);
  assertUnchanged(root, f);
  assert.equal(fs.existsSync(f.statePath + ".lock"), false);
}));

test("Windows lock publication stops for a live or unknown competitor before a second rename", windowsOnly, async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  const lock = f.statePath + ".lock";
  const owner = path.join(lock, "owner-" + process.pid + "-11111111-1111-1111-1111-111111111111");
  const review = () => assert.rejects(f.h.ledger("root", "review", { decisions: f.decisions }), /工作台账正在更新/u);
  assert.equal(await failClaims(f, () => {
    fs.mkdirSync(lock);
    fs.writeFileSync(owner, "competitor");
    throw claimError("EPERM");
  }, review), 1);
  assert.equal(fs.readFileSync(owner, "utf8"), "competitor");
  fs.unlinkSync(owner);
  fs.rmdirSync(lock);

  const wait = Atomics.wait;
  Atomics.wait = () => { fs.writeFileSync(lock, "unrecognized"); return "timed-out"; };
  try { assert.equal(await failClaims(f, () => { throw claimError("EPERM"); }, review), 1); }
  finally { Atomics.wait = wait; }
  assert.equal(fs.readFileSync(lock, "utf8"), "unrecognized");
  assertUnchanged(root, f);
}));
