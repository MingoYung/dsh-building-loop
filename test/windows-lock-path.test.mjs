import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conversationStartSnapshot, decideConversationStart, latestConversationUser,
  proposeConversationTask, startedConversationProject } from "../governance/conversation-start.mjs";
import { digest } from "../governance/policy.mjs";
import { withWorkspaceLock } from "../governance/transactions.mjs";

const windowsOnly = { skip: process.platform !== "win32" };
const session = "deep-state-session";
const file = "conversation-start-" + digest(session) + ".json";
const task = { goal: "复现 Windows 深路径开工失败", deliverable: "提交修复与回归结果", scope: "当前隔离工作区" };
const current = latestConversationUser([{ type: "user/message", seq: 1,
  data: { source: { kind: "user" }, content: [{ type: "text", text: "开始建设：复现并修复 Windows 开工错误" }] } }]);

/** Match the historical 250-character prefix plus mkdtemp's six-character suffix. */
function fixture(t, minimum = 250) {
  const base = fs.realpathSync.native(os.tmpdir());
  const sandbox = fs.mkdtempSync(path.join(base, "bl-win-lock-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(sandbox)), base);
    assert.match(path.basename(sandbox), /^bl-win-lock-/u);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const prefixLength = name => path.join(name, "building-loop-state", file + ".claim-").length;
  const count = Math.max(1, minimum - prefixLength(sandbox) - 1);
  const home = path.join(sandbox, "深".repeat(count));
  fs.mkdirSync(home);
  assert.ok(prefixLength(home) >= minimum);
  return { home, state: path.join(home, "building-loop-state"), barrier: path.join(sandbox, "release") };
}

function assertClean(state) {
  assert.deepEqual(fs.readdirSync(state), [file]);
}

test("Windows deep conversation proposal and approval use the same state and clean the lock", windowsOnly, t => {
  const { home, state } = fixture(t);
  assert.deepEqual(conversationStartSnapshot(home, session, current), { status: "idle" });
  const proposed = proposeConversationTask(home, session, current, task);
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.proposal.instruction, "开始建设：复现并修复 Windows 开工错误");
  assertClean(state);

  let initialized = 0;
  const start = () => { initialized++; return { kind: "private" }; };
  assert.equal(decideConversationStart(home, session, current, proposed.proposal.id, "start", start).status, "started");
  assert.equal(decideConversationStart(home, session, current, proposed.proposal.id, "start", start).changed, false);
  assert.equal(startedConversationProject(home, session).proposal.id, proposed.proposal.id);
  assert.equal(initialized, 1);
  assertClean(state);
});

const childScript = "import fs from 'node:fs';\n" +
  "import { withWorkspaceLock } from " + JSON.stringify(new URL("../governance/transactions.mjs", import.meta.url).href) + ";\n" +
  "const [home, file, barrier, crash] = process.argv.slice(1);\n" +
  "withWorkspaceLock(home, file, () => {\n" +
  "  fs.writeSync(1, 'locked\\n');\n" +
  "  if (crash) process.kill(process.pid, 'SIGKILL');\n" +
  "  const cell = new Int32Array(new SharedArrayBuffer(4));\n" +
  "  const deadline = Date.now() + 8000;\n" +
  "  while (!fs.existsSync(barrier)) {\n" +
  "    if (Date.now() > deadline) throw new Error('test release barrier timed out');\n" +
  "    Atomics.wait(cell, 0, 0, 10);\n" +
  "  }\n" +
  "});";

function childArgs(state, barrier) {
  return ["--input-type=module", "--eval", childScript, state, file, barrier];
}

test("Windows deep lock cannot be stolen and recovers after the real owner is killed", windowsOnly, async t => {
  const { home, state, barrier } = fixture(t, 320);
  fs.mkdirSync(state);
  const lock = path.join(state, file + ".lock");
  const child = spawn(process.execPath, childArgs(state, barrier), { windowsHide: true });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  try {
    const ready = await Promise.race([once(child.stdout, "data"), exited]);
    assert.equal(String(ready[0]).trim(), "locked", stderr);
    assert.match(fs.readdirSync(lock)[0], new RegExp("^owner-" + child.pid + "-", "u"));
    assert.throws(() => proposeConversationTask(home, session, current, task), { code: "BUILDING_LOOP_LOCK_BUSY" });
    assert.equal(fs.existsSync(path.join(state, file)), false);
    assert.deepEqual(fs.readdirSync(state), [file + ".lock"]);
  } finally {
    fs.writeFileSync(barrier, "release");
    assert.equal((await exited)[0], 0, stderr);
  }
  assert.deepEqual(fs.readdirSync(state), []);

  const crashed = spawnSync(process.execPath, [...childArgs(state, barrier), "crash"], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.ifError(crashed.error);
  assert.notEqual(crashed.status, 0);
  assert.match(crashed.stdout, /^locked\r?$/mu, crashed.stderr);
  assert.match(fs.readdirSync(lock)[0], new RegExp("^owner-" + crashed.pid + "-", "u"));

  assert.equal(proposeConversationTask(home, session, current, task).status, "proposed");
  assertClean(state);
  assert.equal(withWorkspaceLock(state, file, () => "reacquired"), "reacquired");
  assertClean(state);
});
