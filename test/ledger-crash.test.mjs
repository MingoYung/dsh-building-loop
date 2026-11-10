import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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
function crashAt(root, fixture, target, phase, action = "review") {
  const source = `import fs from "node:fs"; import path from "node:path";
import { host } from ${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)};
const [root,target,phase,decisions,action] = process.argv.slice(1);
const h=host(root),rename=fs.renameSync;
fs.renameSync=(from,to)=>{
  if(path.resolve(to)!==target)return rename(from,to);
  if(phase==="after")rename(from,to);
  fs.writeSync(1,"terminated before returning from "+phase+" rename\\n");
  process.kill(process.pid,"SIGKILL");
};
await h.ledger("root",action,{decisions:JSON.parse(decisions)});
throw new Error("crash point was not reached");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, root, target, phase,
    JSON.stringify(fixture.decisions), action], { env: process.env, encoding: "utf8", timeout: 10_000 });
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

test("hard exit before unchanged-revision ledger regeneration commits restores pre-export bytes", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  // The snapshot may be locally restored or removed while its authoritative
  // projection and ledger revision remain current. Export regenerates it.
  write("ledger.md", "# 先前保留的账本副本\n");
  const previous = files.map(file => readBytes(root, file));
  crashAt(root, f, f.statePath, "before", "export");
  const journal = JSON.parse(fs.readFileSync(f.statePath + ".ledger-txn", "utf8"));
  assert.equal(journal.before, digest(f.stateBefore));
  assert.deepEqual(readBytes(root, "ledger.md"), f.before[0]);
  assert.deepEqual(fs.readFileSync(f.statePath), f.stateBefore);
  const restarted = host(root);
  const status = await restarted.flow("root", "status");
  assert.equal(status.blocked, undefined, `Recovery rejected journal ${journal.before} → ${journal.after}`);
  assert.equal(status.units[0].phase, "ledger-review");
  assert.notEqual(journal.before, journal.after);
  assert.deepEqual(files.map(file => readBytes(root, file)), previous);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.backupBefore);
  assert.equal(fs.existsSync(f.statePath + ".ledger-txn"), false);
  assert.equal((await restarted.ledger("root", "export")).changed, true);
  assert.deepEqual(readBytes(root, "ledger.md"), f.before[0]);
}));

test("hard exit after unchanged-revision ledger regeneration commits keeps the regenerated snapshot", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  write("ledger.md", "# 先前保留的账本副本\n");
  crashAt(root, f, f.statePath, "after", "export");
  const journal = JSON.parse(fs.readFileSync(f.statePath + ".ledger-txn", "utf8"));
  const published = files.map(file => readBytes(root, file));
  const committed = fs.readFileSync(f.statePath);
  assert.equal(journal.before, digest(f.stateBefore));
  assert.equal(journal.after, digest(committed));
  assert.deepEqual(JSON.parse(committed).ledger, JSON.parse(f.stateBefore).ledger);
  assert.deepEqual(published[0], f.before[0]);
  const restarted = host(root);
  const status = await restarted.flow("root", "status");
  assert.equal(status.blocked, undefined, `Recovery rejected journal ${journal.before} → ${journal.after}`);
  assert.equal(status.units[0].phase, "ledger-review");
  assert.notEqual(journal.before, journal.after);
  assert.equal((await restarted.ledger("root", "export")).changed, false);
  assert.deepEqual(files.map(file => readBytes(root, file)), published);
  assert.deepEqual(fs.readFileSync(f.statePath), committed);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.stateBefore);
  assert.equal(fs.existsSync(f.statePath + ".ledger-txn"), false);
}));

test("a legacy equal-hash regeneration journal restores only known before bytes", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  write("ledger.md", "# 先前保留的账本副本\n");
  const previous = files.map(file => readBytes(root, file));
  assert.equal((await f.h.ledger("root", "export")).changed, true);
  const published = files.map(file => readBytes(root, file));

  // Model the old residue after all projection files were published. The
  // legacy writer stored identical state bytes on both sides of the rename.
  const legacy = JSON.parse(f.stateBefore);
  delete legacy.ledgerCommit;
  const legacyState = Buffer.from(JSON.stringify(legacy, null, 2) + "\n");
  fs.writeFileSync(f.statePath, legacyState);
  fs.writeFileSync(f.statePath + ".bak", legacyState);
  const stateHash = digest(legacyState);
  const journalPath = f.statePath + ".ledger-txn";
  fs.writeFileSync(journalPath, JSON.stringify({
    spec: "building-loop-ledger-transaction/1", policy: legacy.policy, ledger: "ledger.md",
    before: stateHash, after: stateHash, backupBefore: f.backupBefore.toString("base64"),
    writes: [1, 0].map(i => ({ file: files[i], before: previous[i].toString("base64"), after: digest(published[i]) })),
  }));

  const restarted = host(root);
  const status = await restarted.flow("root", "status");
  assert.equal(status.blocked, undefined);
  assert.equal(status.units[0].phase, "ledger-review");
  assert.deepEqual(files.map(file => readBytes(root, file)), previous);
  assert.deepEqual(fs.readFileSync(f.statePath), legacyState);
  assert.deepEqual(fs.readFileSync(f.statePath + ".bak"), f.backupBefore);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal((await restarted.ledger("root", "export")).changed, true);
  assert.deepEqual(readBytes(root, "ledger.md"), f.before[0]);
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

test("Windows lock observation recovers a vanished directory without clearing an unknown lock", windowsOnly, async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  const lock = f.statePath + ".lock";
  const native = fs.realpathSync.native;
  for (const failure of ["redirected", "EBADF"]) {
    fs.mkdirSync(lock);
    let observed = false;
    fs.realpathSync.native = (name, ...args) => {
      if (name !== lock || observed) return native(name, ...args);
      observed = true;
      fs.rmdirSync(lock);
      if (failure === "EBADF") throw claimError(failure);
      return lock + ".delete-pending";
    };
    try {
      assert.equal((await f.h.ledger("root", "read")).current.phase, "ledger-review");
      assert.equal(observed, true);
    } finally { fs.realpathSync.native = native; }
  }

  fs.mkdirSync(lock);
  fs.realpathSync.native = (name, ...args) => name === lock ? lock + ".stable-redirect" : native(name, ...args);
  try { await assert.rejects(f.h.ledger("root", "read"), /锁来源未知/); }
  finally { fs.realpathSync.native = native; }
  assert.ok(fs.statSync(lock).isDirectory());
}));

test("Windows empty-lock cleanup preserves a new owner and distinguishes persistent denial", windowsOnly, async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  const lock = f.statePath + ".lock";
  const owner = path.join(lock, "owner-" + process.pid + "-11111111-1111-1111-1111-111111111111");
  const rmdir = fs.rmdirSync;
  const failure = claimError("EPERM");
  fs.mkdirSync(lock);
  fs.rmdirSync = (name, ...args) => {
    if (name !== lock) return rmdir(name, ...args);
    rmdir(lock);
    fs.mkdirSync(lock);
    fs.writeFileSync(owner, "other process");
    throw failure;
  };
  try { await assert.rejects(f.h.ledger("root", "read"), { code: "BUILDING_LOOP_LOCK_BUSY" }); }
  finally { fs.rmdirSync = rmdir; }
  assert.equal(fs.readFileSync(owner, "utf8"), "other process");

  fs.unlinkSync(owner);
  fs.rmdirSync = (name, ...args) => {
    if (name === lock) throw failure;
    return rmdir(name, ...args);
  };
  try { await assert.rejects(f.h.ledger("root", "read"), actual => actual === failure); }
  finally { fs.rmdirSync = rmdir; }
  assertUnchanged(root, f);
}));

test("post-commit journal cleanup failure reports a committed receipt and recovers without a second commit", async () => fixture(async (root, write) => {
  const f = await scenario(root, write);
  const journal = f.statePath + ".ledger-txn";
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file, ...args) => {
    if (file === journal) throw claimError("EPERM");
    return unlink(file, ...args);
  };
  try {
    const receipt = await f.h.ledger("root", "review", { decisions: f.decisions });
    assert.equal(receipt.phase, "closed");
    assert.equal(fs.existsSync(journal), true);
    assert.match(f.h.warnings[0], /账本清理未完成.*EPERM/u);
  } finally { fs.unlinkSync = unlink; }
  const state = fs.readFileSync(f.statePath);
  assert.equal((await f.h.ledger("root", "review", { decisions: f.decisions })).replayed, true);
  assert.deepEqual(fs.readFileSync(f.statePath), state);
  assert.equal(fs.existsSync(journal), false);
}));

async function withCompetingLock(root, write, home, file, operation) {
  const release = path.join(root, "release-competitor");
  const script = `import fs from "node:fs";
import { withWorkspaceLock } from ${JSON.stringify(new URL("../governance/transactions.mjs", import.meta.url).href)};
const [home,file,release] = process.argv.slice(1);
withWorkspaceLock(home,file,()=>{
  fs.writeSync(1,"locked\\n");
  const wait = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now()+6000;
  while(!fs.existsSync(release)) {
    if(Date.now()>deadline) throw new Error("release barrier timed out");
    Atomics.wait(wait,0,0,10);
  }
});`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, home, file, release], { windowsHide: true });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  try {
    const ready = await Promise.race([once(child.stdout, "data"), exited]);
    assert.equal(String(ready[0]).trim(), "locked", stderr);
    await operation(() => write("release-competitor", "release"), exited);
  } finally {
    if (!fs.existsSync(release)) write("release-competitor", "release");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
  }
}

test("real cross-process lock contention defers both automatic events and does not replay a completed event", async () => fixture(async (root, write) => {
  const h = host(root);
  const executor = (await h.flow("root", "advance")).childId;
  const home = path.join(process.env.DSH_HOME, "building-loop-state");
  const file = fs.readdirSync(home).find(name => /^[a-f0-9]{64}\.json$/u.test(name));
  const statePath = path.join(home, file);
  await withCompetingLock(root,write,home,file,async release=>{
    const before = fs.readFileSync(statePath);
    const pending = [h.user("root", 32, "保留跨进程争用时到达的真实用户消息。"), h.interrupt(executor, 45)];
    assert.ok(pending.every(item => item instanceof Promise));
    const reading = h.ledger("root", "read");
    assert.deepEqual(fs.readFileSync(statePath), before);
    release();
    await Promise.all(pending);
    const book = await reading;
    assert.equal(book.items.filter(item => item.origin?.event === 32).length, 1);
    assert.equal(book.items.find(item => item.id === "unit-K01").status, "deferred");
    assert.equal((await h.flow("root", "status")).units[0].interruptions, 1);
    assert.equal((await h.flow("root", "advance")).childId, executor);

    await h.user("root", 32, "保留跨进程争用时到达的真实用户消息。");
    await h.interrupt(executor, 45);
    assert.equal((await h.flow("root", "status")).units[0].phase, "intake");
    assert.equal((await h.ledger("root", "read")).items.filter(item => item.origin?.event === 32).length, 1);
    assert.deepEqual(h.warnings, []);
  });
}));

test("hard exit under contention preserves automatic intents for a new host without the source child", async () => fixture(async (root, write) => {
  const h = host(root);
  const executor = (await h.flow("root", "advance")).childId;
  const home = path.join(process.env.DSH_HOME, "building-loop-state");
  const file = fs.readdirSync(home).find(name => /^[a-f0-9]{64}\.json$/u.test(name));
  const statePath = path.join(home, file);
  const intentHome = path.join(home, "automatic", file);
  await withCompetingLock(root,write,home,file,async (release,exited)=>{
    const before = fs.readFileSync(statePath);
    const script = `import assert from "node:assert/strict"; import fs from "node:fs";
import { host } from ${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)};
const [root,executor] = process.argv.slice(1);
const h=host(root);h.restoreChild(executor,"root");
assert.ok(h.user("root",32,"重启前保留用户请求。") instanceof Promise);
assert.ok(h.interrupt(executor,45) instanceof Promise);
fs.writeSync(1,"both intents were staged before commit\\n");
process.kill(process.pid,"SIGKILL");`;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script, root, executor],
      { env: process.env, windowsHide: true, timeout: 4500, encoding: "utf8" });
    assert.ifError(crashed.error);
    assert.notEqual(crashed.status, 0);
    assert.match(crashed.stdout,/both intents were staged before commit/u,crashed.stderr);
    assert.equal(fs.readdirSync(intentHome).filter(name=>name.endsWith(".json")).length,2);
    assert.deepEqual(fs.readFileSync(statePath), before);

    release();
    await exited;
    const commitThenCrash = `import fs from "node:fs"; import path from "node:path";
import { host } from ${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)};
const [root,intentHome] = process.argv.slice(1);
const unlink=fs.unlinkSync;
fs.unlinkSync=(name,...args)=>{
  if (path.dirname(name)!==intentHome) return unlink(name,...args);
  fs.writeSync(1,"state was committed before intent acknowledgement\\n");
  process.kill(process.pid,"SIGKILL");
};
await host(root).ledger("root","read");
throw new Error("intent acknowledgement not reached");`;
    const committed = spawnSync(process.execPath,["--input-type=module","--eval",commitThenCrash,root,intentHome],
      { env: process.env, windowsHide: true, timeout: 4500, encoding: "utf8" });
    assert.ifError(committed.error);
    assert.notEqual(committed.status,0);
    assert.match(committed.stdout,/state was committed before intent acknowledgement/u,committed.stderr);
    const onceCommitted = fs.readFileSync(statePath);
    assert.notDeepEqual(onceCommitted,before);
    assert.equal(fs.readdirSync(intentHome).filter(name=>name.endsWith(".json")).length,2);
    const restarted = host(root);
    const book = await restarted.ledger("root", "read");
    assert.equal(book.items.filter(item => item.origin?.event === 32).length, 1);
    assert.equal(book.items.find(item => item.id === "unit-K01").status, "deferred");
    assert.equal((await restarted.flow("root", "status")).units[0].interruptions, 1);
    assert.deepEqual(fs.readdirSync(intentHome),[]);
    await restarted.user("root",32,"重启前保留用户请求。");
    assert.deepEqual(fs.readFileSync(statePath),onceCommitted);
    assert.deepEqual(restarted.warnings,[]);
  });
}));

test("native live cancellation and crash recovery closers both record interruptions", async () => fixture(async root => {
  const h = host(root);
  const executor = (await h.flow("root", "advance")).childId;
  for (const [seq, kind] of [[30,"aborted"],[60,"interrupted"]]) {
    await h.interrupt(executor,seq,kind);
    const current = (await h.flow("root","status")).units[0];
    assert.equal(current.phase,"blocked");
    assert.match(current.blocked,new RegExp(kind,"u"));
    assert.equal((await h.flow("root","advance")).childId,executor);
  }
  assert.deepEqual(h.warnings,[]);
}));

test("an orphaned usage event cannot block a durable request in the same contended queue", async () => fixture(async (root, write) => {
  const h = host(root);
  const executor = (await h.flow("root", "advance")).childId;
  const home = path.join(process.env.DSH_HOME, "building-loop-state");
  const file = fs.readdirSync(home).find(name => /^[a-f0-9]{64}\.json$/u.test(name));
  await withCompetingLock(root,write,home,file,async release=>{
    const usage = h.usage(executor,1,1,77);
    assert.ok(usage instanceof Promise);
    h.detachChild(executor);
    const request = h.user("root",32,"子会话离开后仍保留争用期间的新请求。");
    assert.ok(request instanceof Promise);
    const reading = h.ledger("root","read");
    release();
    await Promise.all([usage,request]);
    assert.equal((await reading).items.filter(item=>item.origin?.event===32).length,1);
    assert.equal(h.warnings.length,1);
    assert.match(h.warnings[0],/未能补记内存事件/u);
  });
}));
