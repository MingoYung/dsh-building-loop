import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { apply } from "../governance/index.mjs";
import { digest } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";
import { setSessionProjectMode, workspaceStateFile } from "../governance/session-mode.mjs";
import { fixture, policy } from "./helpers.mjs";

const owner = "root";
const unit = "K01";
const workflow = "building_loop";
const coverage = "building_loop_coverage";
const candidate = "candidate.md";
const firstReceipt = "first.json";
const finalReceipt = "final.json";
const decision = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const approval = Object.fromEntries(Object.keys(QUALITY).map(key => [key, "按当期目标核对现有稿件的内容与适用范围。"]));
const instructions = "# 本次步骤\n\n先记录当前版本。\n";
const unsupported = "生产环境的请求全部成功。";
const structural = { kind: "nonfactual", status: "supported", basis: "清单标题与操作步骤没有外部事实断言。" };
const finding = { kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis: "没有任何已授权生产记录。",
  finding: { kind: "missing-evidence", quote: unsupported, fix: "删除未经验证的生产结果。" } };

/** Mount the real tool and event handlers around local stand-ins for DSH sessions. */
function nativeHost(root, { store = new Map(), acceptMessage, deliveryBoundary, afterObservation } = {}) {
  const listeners = new Map();
  const tools = new Map();
  const live = new Map();
  const deliveries = [];
  const warnings = [];
  const remoteEvents = [];
  const probes = [];
  const ensureSession = (id, parentSession) => {
    if (!store.has(id)) store.set(id, { header: { id, cwd: root, ...(parentSession ? { parentSession } : {}) }, events: [] });
    return store.get(id);
  };
  const mount = (id, parentSession) => {
    const stored = ensureSession(id, parentSession);
    const session = { id, header: stored.header, get seq() { return stored.events.length; } };
    let idlePromise = Promise.resolve(), settle, pending = false;
    const agent = { id, session, whenIdle: () => idlePromise,
      get status() { return settle ? "running" : "idle"; },
      inbox: { get hasPending() { return pending; } },
      model: { current: () => null }, ctx: { tools: {
        view: () => ({ visible: tools, restrictableNames: new Set(tools.keys()) }), restrict: () => {},
      } },
      setRunning(value) {
        if (value && !settle) idlePromise = new Promise(resolve => { settle = resolve; });
        if (!value && settle) {
          settle(); settle = undefined;
          return listeners.get("agent/status")?.({ agent, status: "idle" });
        }
      },
      setPending(value) { pending = value; },
    };
    live.set(id, agent);
    return agent;
  };
  const append = (id, type, data) => {
    const { events } = store.get(id);
    const event = { type, data, seq: events.length, time: Date.now() };
    events.push(event);
    return event;
  };
  mount(owner);
  const deliver = async (id, parent, content, kind, source, boundary) => {
    await deliveryBoundary?.("before-session", { id, parent, content });
    if (kind === "spawn") assert(!store.has(id), "native spawn cannot create the same child twice");
    else assert(store.has(id), "native resume requires a stored child");
    if (!live.has(id)) mount(id, parent);
    if (kind === "spawn") {
      store.get(id).header.origin = "subagent";
      append(id, "subagent/descriptor", { mode: "continuable", provider: "spawn" });
      acceptMessage?.(store);
    }
    await deliveryBoundary?.("before-inbox", { id, parent, content });
    const target = boundary === "queue" ? "next-turn" : "next-step";
    const messageId = "fixture-message-" + store.get(id).events.length;
    append(id, "agent/inbox/spliced", { target, start: 0, inserted: [{ id: messageId, role: "user", source, content }] });
    deliveries.push({ id, parent, content, kind });
    acceptMessage?.(store);
    await deliveryBoundary?.("after-inbox", { id, parent, content });
    return messageId;
  };
  apply({
    agents: { get: id => live.get(id), roots: () => [live.get(owner)], list: () => [...live.values()] },
    get: name => ({
      sessionPersistence: { stat: async id => {
        probes.push({ method: "stat", id });
        return store.has(id) ? { header: store.get(id).header } : undefined;
      } },
      typertGateway: { getPendingRemoteEvents: () => [...remoteEvents] },
    })[name],
    sessionQuery: { observeSession: async id => {
      probes.push({ method: "observe", id });
      const stored = store.get(id);
      if (!stored) throw Object.assign(new Error("session not found"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
      const snapshot = { header: stored.header, cursor: stored.events.length - 1,
        events: structuredClone(stored.events), source: live.has(id) ? "live" : "prepared",
        inheritedEventCount: 0, [Symbol.dispose]() {} };
      await afterObservation?.(id);
      return snapshot;
    } },
    subagents: {
      startActivation: async args => {
        const messageId = await deliver(args.childId, args.request.parent.id, args.request.prompt, "spawn", { kind: "user" }, "queue");
        return { childId: args.childId, messageId };
      },
      sendMessage: async (sender, id, content) => {
        // Child reporting to the parent is separate from a parent activation.
        if (sender.id !== owner) return;
        const source = { kind: "agent-message", form: "relay", senderSessionId: sender.id };
        return deliver(id, sender.id, content, "resume", source, "steer");
      },
      queuePrompt: (parent, id, content, source) => deliver(id, parent.id, content, "resume", source, "queue"),
    },
    tools: { register: tool => tools.set(tool.name, tool), guard: () => {} },
    systemPrompt: { context: () => {} }, on: (name, listener) => listeners.set(name, listener),
    logger: { warn: message => warnings.push(message) },
  });
  const invoke = (id, name, args) => tools.get(name).execute(args, { agent: live.get(id), signal: AbortSignal.timeout(5000),
    concludeTurn: () => {} });
  return { deliveries, warnings, store, invoke, remoteEvents, probes,
    flow: (id, action, args = {}) => invoke(id, workflow, { action, unit, ...args }),
    file: (id, action, name, args = {}) => invoke(id, "building_loop_file", { action, path: name, ...args }),
    running: (id, value) => live.get(id).setRunning(value),
    pending: (id, value) => live.get(id).setPending(value),
    idleEvent: id => listeners.get("agent/status")?.({ agent: live.get(id), status: "idle" }),
    ownerMessage: text => append(owner, "user/message", { source: { kind: "user" }, content: [{ type: "text", text }] }),
    finish(id) {
      const session = live.get(id).session;
      return listeners.get("session/event")(session, append(id, "turn/end", { reason: { kind: "completed" } }));
    },
    reconnect() { return listeners.get("agent/created")?.({ agent: live.get(owner), source: "resume" }); },
    dispose() { return listeners.get("dispose")?.(); },
    status: async () => (await invoke(owner, workflow, { action: "status" })).units[0].phase,
  };
}

function configure(root, write, { manuscript = instructions, metric = false } = {}) {
  const settings = structuredClone(policy);
  const cell = settings.units[unit];
  cell.claims = [];
  cell.calculations = {};
  cell.requireSourcePins = true;
  for (const stage of ["first-review", "final-review"]) {
    cell.phases[stage].read = [candidate];
    cell.phases[stage].evidence = [];
  }
  if (metric) {
    cell.claims = ["C1"];
    cell.calculations = { C1: policy.units[unit].calculations.C2 };
    cell.hostResults = { calculations: ["C1"] };
    const file = "timing.csv";
    const original = "phase,mean_ms\nbefore,120\nafter,96\n";
    cell.phases.intake = { read: [candidate, file], write: [candidate] };
    for (const stage of ["first-review", "final-review"]) {
      cell.phases[stage].read.push(file);
      cell.phases[stage].evidence = [file];
    }
    settings.sourcePins = { [file]: { sha256: digest(original), kind: "synthetic", locator: "fixture:timing" } };
  }
  write("BUILDING-LOOP.json", JSON.stringify(settings));
  write(candidate, manuscript);
  setSessionProjectMode(process.env.DSH_HOME, root, owner, true);
}

async function deliverIntake(host, beforeSubmit = () => {}) {
  const executor = (await host.flow(owner, "advance")).childId;
  await host.flow(executor, "prepare");
  beforeSubmit(executor);
  assert.equal((await host.flow(executor, "submit")).phase, "review-ready");
  return executor;
}

async function inspectManuscript(host, actor, action, { reject = false, assess = true } = {}) {
  const packet = await host.flow(actor, "prepare");
  assert.equal(packet.coverage.pendingCount, packet.coverage.total, "an independent role starts with its own coverage");
  const entries = packet.coverage.blocks.map(block => ({ block: block.id,
    parts: [reject && block.text === unsupported ? finding : structural] }));
  assert.deepEqual((await host.invoke(actor, coverage, { action: "record", entries })).invalid, []);
  if (assess) await host.invoke(actor, "building_loop_quality", { action: "assess", unit, ...approval,
    goalFit: { pass: true, basis: "已按目标逐项检查清单。" }, revise: [], sourceRefs: [], unverifiedSources: [], unlisted: [] });
  return host.flow(actor, action, action === "review" ? { checks: [] } : {});
}

async function waitFor(observe, expected, reason) {
  const start = Date.now();
  let actual = await observe();
  while (actual !== expected && Date.now() - start < 4000) {
    await delay(20);
    actual = await observe();
  }
  assert.equal(actual, expected, reason());
}

const waitForPhase = (host, expected) => waitFor(host.status, expected, () => host.warnings.join("\n"));

const nativeLog = root => path.join(path.dirname(root), "native-sessions.json");
const savedSessions = root => new Map(JSON.parse(fs.readFileSync(nativeLog(root), "utf8")));
const saveSessions = root => store => fs.writeFileSync(nativeLog(root), JSON.stringify([...store]));
const assignmentMarker = content => content.find(item => item.type === "text" && /^Building-loop 交接编号：/u.test(item.text))?.text;
const durableAssignments = (store, id) => (store.get(id)?.events ?? []).filter(event => event.type === "agent/inbox/spliced" &&
  event.data.inserted.some(message => assignmentMarker(message.content)));

/** The worker exits while its delivery call is still on the stack. */
export async function hardExitWorker(root, cutoff) {
  const host = nativeHost(root, {
    store: savedSessions(root), acceptMessage: saveSessions(root),
    deliveryBoundary(point, { id }) {
      if (point !== cutoff) return;
      fs.writeSync(1, "hard-exit " + point + " " + id + "\n");
      process.kill(process.pid, "SIGKILL");
    },
  });
  await host.reconnect();
  await delay(6000);
  throw new Error("The configured crash boundary was never reached");
}

function stopAt(root, cutoff) {
  const source = `import { hardExitWorker } from ${JSON.stringify(import.meta.url)};
    await hardExitWorker(process.argv[1], process.argv[2]);`;
  const worker = spawnSync(process.execPath, ["--input-type=module", "--eval", source, root, cutoff], {
    env: { ...process.env, DSH_BUILDING_LOOP_HANDOFF_WORKER: "1" }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(worker.error);
  assert.notEqual(worker.status, 0);
  const marker = new RegExp("hard-exit " + cutoff + " ([0-9a-f-]{36})", "u").exec(worker.stdout);
  assert.ok(marker, worker.stderr + worker.stdout);
  return marker[1];
}

function storedUnit(root) {
  const file = path.join(process.env.DSH_HOME, "building-loop-state", workspaceStateFile(root));
  return JSON.parse(fs.readFileSync(file, "utf8")).units[unit];
}

function regression(name, run) {
  if (process.env.DSH_BUILDING_LOOP_HANDOFF_WORKER !== "1") test(name, run);
}

regression("host dispatches a stalled first review only after both actors settle", () => fixture(async (root, write) => {
  configure(root, write);
  const host = nativeHost(root);
  host.running(owner, true);
  const executor = await deliverIntake(host, id => host.running(id, true));
  const submitterEnd = host.finish(executor);
  const ownerEnd = host.finish(owner);
  await delay(30);
  assert.equal(await host.status(), "review-ready");
  host.pending(owner, true);
  await host.running(owner, false);
  await delay(30);
  assert.equal(await host.status(), "review-ready");
  await host.running(executor, false);
  await delay(30);
  assert.equal(await host.status(), "review-ready", "the queued user message still owns the next action");
  host.running(owner, true);
  host.pending(owner, false);
  host.remoteEvents.push({ agentId: owner, event: "user-questions/request" });
  await host.running(owner, false);
  await delay(30);
  assert.equal(await host.status(), "review-ready", "an open native user question keeps the existing handoff pending");
  host.running(owner, true);
  host.remoteEvents.length = 0;
  await host.running(owner, false);
  await Promise.all([submitterEnd, ownerEnd]);
  await waitForPhase(host, "first-review");
  assert.equal(host.deliveries.length, 2);
  const reviewer = host.deliveries.at(-1).id;
  assert.notEqual(reviewer, executor);
  assert.match(host.deliveries.at(-1).content[0].text, /first-review/u);
  await host.finish(owner);
  await host.finish(executor);
  await Promise.all([host.idleEvent(owner), host.idleEvent(executor), host.reconnect()]);
  await assert.rejects(host.flow(owner, "advance"), /尚未交付|已经由其他调用推进/u);
  assert.equal(host.deliveries.length, 2);
  await assert.rejects(host.file(reviewer, "write", candidate, { content: instructions, note: "越权反例" }), /白名单|授权/u);
  await assert.rejects(host.flow(reviewer, "review", { checks: [] }), /全文|核验|读取|质量/u);
}));

regression("the host rechecks after a newer owner turn finishes during the eligibility read", () => fixture(async (root, write) => {
  configure(root, write);
  const observed = Promise.withResolvers(), unpin = Promise.withResolvers();
  let frozen = false;
  const host = nativeHost(root, { async afterObservation(id) {
    if (id !== owner || frozen) return;
    frozen = true;
    observed.resolve();
    await unpin.promise;
  } });
  await deliverIntake(host);
  try {
    await Promise.race([observed.promise, delay(4000, undefined, { ref: false }).then(() => {
      throw new Error("The review eligibility check was not started");
    })]);
    host.running(owner, true);
    host.ownerMessage("请继续核验本轮提交。");
    await host.running(owner, false);
  } finally { unpin.resolve(); }
  await waitForPhase(host, "first-review");
  assert.equal(host.deliveries.length, 2);
}));

for (const failureBoundary of ["before-session", "after-inbox"]) {
  regression("same-process retry preserves one assignment after a throwing native send " + failureBoundary, () => fixture(async (root, write) => {
    configure(root, write);
    const attempts = [];
    const knownTargets = [];
    const host = nativeHost(root, { deliveryBoundary(point, { id, content }) {
      const marker = assignmentMarker(content);
      if (!marker) return;
      if (point === "before-session") attempts.push({ id, marker });
      if (point === failureBoundary && attempts.length === 1) {
        knownTargets.push(id);
        throw new Error("synthetic native failure " + point);
      }
    } });
    await deliverIntake(host);
    await waitForPhase(host, "first-review");
    const row = storedUnit(root);
    await waitFor(() => row.actor && durableAssignments(host.store, row.actor).length, 1, () => host.warnings.join("\n"));
    await waitFor(() => storedUnit(root).reviewHandoff.retry, "used", () => host.warnings.join("\n"));
    assert.deepEqual(knownTargets, [row.actor]);
    assert.equal(attempts.length, failureBoundary === "before-session" ? 2 : 1);
    assert(attempts.every(attempt => attempt.id === row.actor && attempt.marker === attempts[0].marker));
    assert.equal(host.deliveries.length, 2);
    assert(host.warnings.some(message => message.includes("synthetic native failure " + failureBoundary)));
  }));
}

for (const cutoff of ["before-session", "before-inbox", "after-inbox"]) {
  regression("cold reconnect delivers the same reserved child once after hard exit " + cutoff, () => fixture(async (root, write) => {
    configure(root, write);
    const initial = nativeHost(root);
    initial.running(owner, true);
    await deliverIntake(initial);
    initial.dispose();
    saveSessions(root)(initial.store);
    const reservedId = stopAt(root, cutoff);
    const interrupted = storedUnit(root);
    assert.equal(interrupted.actor, reservedId);
    assert.throws(() => process.kill(interrupted.activationHost.pid, 0), { code: "ESRCH" });
    const store = savedSessions(root);
    assert.equal(durableAssignments(store, reservedId).length, cutoff === "after-inbox" ? 1 : 0);
    assert.equal(store.has(reservedId), cutoff !== "before-session");

    const restored = nativeHost(root, { store, acceptMessage: saveSessions(root) });
    await restored.reconnect();
    await waitForPhase(restored, "first-review");
    await waitFor(() => durableAssignments(savedSessions(root), reservedId).length, 1,
      () => "there is one durable dispatch to the reserved child across the hard exit\n" + JSON.stringify({
        warnings: restored.warnings, probes: restored.probes, activationHost: storedUnit(root).activationHost,
      }));
    if (cutoff !== "after-inbox") assert.equal(restored.deliveries.length, 1);
    assert.equal(storedUnit(root).actor, reservedId);

    const secondRestart = nativeHost(root, { store: savedSessions(root), acceptMessage: saveSessions(root) });
    await secondRestart.reconnect();
    await secondRestart.finish(owner);
    await delay(60);
    assert.equal(durableAssignments(savedSessions(root), reservedId).length, 1,
      "replayed lifecycle events do not send a second assignment");
  }));
}

regression("host dispatches the final independent audit and requires its own coverage before ledger review", () => fixture(async (root, write) => {
  configure(root, write, { manuscript: instructions + "\n" + unsupported + "\n" });
  const host = nativeHost(root);
  host.running(owner, true);
  const executor = await deliverIntake(host);
  const reviewer = (await host.flow(owner, "advance")).childId;
  assert.equal((await inspectManuscript(host, reviewer, "review", { reject: true })).phase, "supplement-ready");
  assert.equal((await host.flow(owner, "advance")).childId, executor);
  await host.flow(executor, "prepare");
  await host.file(executor, "write", candidate, { content: instructions, note: "撤回未经验证的生产结论。" });
  await host.file(executor, "read", candidate);
  assert.equal((await host.flow(executor, "submit", { quality: approval })).phase, "final-review-ready");
  assert.equal((await host.flow(owner, "advance")).childId, reviewer);
  assert.equal((await inspectManuscript(host, reviewer, "review")).phase, "final-audit-ready");
  assert.equal(decision(root, finalReceipt).decision, "pending-audit");
  await Promise.all([host.finish(reviewer), host.finish(owner)]);
  await host.running(owner, false);
  await waitForPhase(host, "final-audit");
  const auditor = host.deliveries.at(-1).id;
  assert.notEqual(auditor, reviewer);
  assert.notEqual(auditor, executor);
  assert.match(host.deliveries.at(-1).content[0].text, /final-audit/u);
  assert.doesNotMatch(host.deliveries.at(-1).content[0].text, /撤回未经验证|生产环境的请求全部成功/u);
  await assert.rejects(host.file(auditor, "read", firstReceipt), /白名单|授权/u);
  await assert.rejects(host.flow(auditor, "audit"), /核验|读取/u);
  assert.equal(decision(root, finalReceipt).decision, "pending-audit");
  assert.equal((await inspectManuscript(host, auditor, "audit", { assess: false })).phase, "ledger-review");
  const receipt = decision(root, finalReceipt);
  assert.equal(receipt.decision, "accept");
  assert.deepEqual(receipt.independentAudit.coverage.rejected, []);
}));

regression("a real metric question continues to wait for the user on both turn endings and cold reconnect", () => fixture(async (root, write) => {
  configure(root, write, { metric: true });
  const initial = nativeHost(root);
  const executor = (await initial.flow(owner, "advance")).childId;
  const question = "这次降幅按单独校准记录计算，还是按批次均值计算？";
  const blocked = await initial.flow(executor, "block", { note: "两种统计口径都能算，须由用户选择。",
    metricClarification: { id: "C1", question } });
  assert.equal(blocked.phase, "blocked");
  await Promise.all([initial.finish(owner), initial.finish(executor)]);
  const restarted = nativeHost(root, { store: initial.store });
  await restarted.reconnect();
  await restarted.finish(owner);
  await delay(50);
  assert.equal(await restarted.status(), "blocked");
  assert.equal(initial.deliveries.length, 1);
  assert.deepEqual(restarted.deliveries, []);
  const status = await restarted.flow(owner, "status");
  assert.equal(status.units[0].outcomeClarification.items[0].question, question);
  await assert.rejects(restarted.flow(owner, "advance"), /等待用户澄清口径/u);
}));
