import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { apply } from "../governance/index.mjs";
import { workspaceStateFile } from "../governance/session-mode.mjs";
import { fixture, host } from "./helpers.mjs";

/** Mount the production workflow around the native writer contract and a new process's empty child registry. */
function restarted(root, persistence) {
  const registry = new Map();
  const listeners = new Map();
  const sends = [];
  const live = new Map();
  const agent = id => ({ id, session: { header: { cwd: root, ...(id === "root" ? {} : { parentSession: "root" }) } },
    model: { current: () => null }, ctx: { tools: {
      view: () => ({ visible: registry, restrictableNames: new Set(registry.keys()) }), restrict: () => {},
    } } });
  const owner = agent("root");
  live.set(owner.id, owner);
  apply({
    agents: { get: id => live.get(id) },
    subagents: { sendMessage: async (parent, id, content) => {
      assert.equal(parent, owner);
      sends.push({ id, content });
      live.set(id, agent(id));
    } },
    tools: { register: tool => registry.set(tool.name, tool), guard: () => {} },
    systemPrompt: { context: () => {} }, on: (name, listener) => listeners.set(name, listener),
    get: key => key === "sessionPersistence" ? persistence : undefined,
    logger: { warn: () => {} },
  });
  const signal = AbortSignal.timeout(1000);
  const run = (name, args, actor = "root") => registry.get(name).execute(args, { agent: live.get(actor), signal });
  return { sends, run, preStep: () => listeners.get("agent/pre-step")({ agent: owner, signal }, async () => ({ kind: "enter", messages: [] })) };
}

function stateFile(root) {
  return path.join(process.env.DSH_HOME, "building-loop-state", workspaceStateFile(root));
}

function storedUnit(root) {
  return JSON.parse(fs.readFileSync(stateFile(root), "utf8")).units.K01;
}

/** The DSH lease stays open across the actual ledger write and is released before cold resume. */
function persistenceFor(id, { owner = "root", boundary = "turn/start", heldElsewhere = false } = {}) {
  let held = false;
  const calls = [];
  return { calls, isHeld: () => held, open: async (actual, access) => {
    assert.equal(actual, id);
    assert.equal(access, "write");
    assert.equal(held, false);
    calls.push("open");
    if (heldElsewhere) throw new Error("SessionAlreadyOwnedError");
    held = true;
    return {
      access, header: { id, parentSession: owner }, inheritedEventCount: 2,
      read: async offset => {
        assert.equal(offset, 2);
        assert.equal(held, true);
        calls.push("read");
        return { events: [{ seq: 2, type: "turn/start" }, { seq: 3, type: boundary }] };
      },
      close: async () => { held = false; calls.push("close"); },
    };
  } };
}

function convertToLegacy(root) {
  const file = stateFile(root), state = JSON.parse(fs.readFileSync(file, "utf8"));
  delete state.units.K01.activationHost;
  fs.writeFileSync(file, JSON.stringify(state));
}

test("a persisted unfinished legacy child is paused at the next root step and resumes with the same actor and proof", async () => fixture(async root => {
  const original = host(root);
  const { childId } = await original.flow("root", "advance");
  await original.file(childId, "read", "candidate.md");
  const seen = storedUnit(root).seen;
  convertToLegacy(root);

  const native = persistenceFor(childId);
  const restored = restarted(root, native);
  await restored.preStep();
  assert.deepEqual(native.calls, ["open", "read", "close"]);
  const status = await restored.run("building_loop", { action: "status" });
  assert.equal(status.units[0].phase, "blocked");
  assert.equal(status.units[0].next, "intake");
  assert.match(status.units[0].blocked, /宿主中断/);
  const prepare = await restored.run("building_loop", { action: "prepare" });
  assert.match(prepare.next, /原子会话/);
  const book = await restored.run("building_loop_ledger", { action: "read" });
  assert.equal(book.items.find(item => item.unit === "K01").kind, "interrupted");

  const resumed = await restored.run("building_loop", { action: "advance", unit: "K01" });
  assert.equal(native.isHeld(), false);
  assert.equal(resumed.reused, true);
  assert.equal(resumed.childId, childId);
  assert.equal(resumed.phase, "intake");
  assert.equal(restored.sends[0].id, childId);
  assert.deepEqual(storedUnit(root).seen, seen);
  assert.equal(storedUnit(root).activationHost.pid, process.pid);
  const files = await restored.run("building_loop_file", { action: "list" }, childId);
  assert.ok(files.read.includes("candidate.md"));
  assert.ok(!files.write.includes("candidate.md"));
}));

test("an absent actor from the current live activation process is not mistaken for an orphan", async () => fixture(async root => {
  const original = host(root);
  const { childId } = await original.flow("root", "advance");
  const native = persistenceFor(childId);
  const restored = restarted(root, native);
  await restored.preStep();
  assert.equal(storedUnit(root).phase, "intake");
  assert.deepEqual(native.calls, []);
  await assert.rejects(restored.run("building_loop", { action: "advance", unit: "K01" }), /尚未交付/);
  assert.deepEqual(restored.sends, []);
}));

test("an exact child from a known prior process can resume even if its last native turn had already settled", async () => fixture(async root => {
  const { childId } = await host(root).flow("root", "advance");
  const file = stateFile(root), state = JSON.parse(fs.readFileSync(file, "utf8"));
  // Simulate OS PID reuse after an old instance exited. This process owns its PID and has a different stable UUID.
  state.units.K01.activationHost.instance = "00000000-0000-4000-8000-000000000000";
  fs.writeFileSync(file, JSON.stringify(state));
  const native = persistenceFor(childId, { boundary: "turn/end" });
  const restored = restarted(root, native);
  const result = await restored.run("building_loop", { action: "advance", unit: "K01" });
  assert.deepEqual(native.calls, ["open", "close"]);
  assert.equal(result.childId, childId);
  assert.equal(result.reused, true);
  assert.equal(restored.sends.length, 1);
  assert.notEqual(storedUnit(root).activationHost.instance, state.units.K01.activationHost.instance);
}));

test("legacy recovery requires exact persisted lineage, incomplete own work and exclusive native ownership", async () => fixture(async root => {
  const { childId } = await host(root).flow("root", "advance");
  convertToLegacy(root);
  for (const options of [{ owner: "another" }, { boundary: "turn/end" }, { heldElsewhere: true }]) {
    const native = persistenceFor(childId, options);
    const restored = restarted(root, native);
    await restored.preStep();
    assert.equal(storedUnit(root).phase, "intake");
    assert.equal(native.isHeld(), false);
    assert.deepEqual(restored.sends, []);
  }
}));
