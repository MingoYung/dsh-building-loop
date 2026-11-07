import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply } from "../governance/index.mjs";
import { QUALITY, lineList, numericChecks, rejectedClaims, supplementChecks } from "../governance/preflight.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { evidenceReference, expectedClaims } from "../governance/evidence.mjs";

const seed = "# 摘要\n- C1：通过 19/20（出处：functional.csv 第 2 行）。\n- C2：平均耗时下降 25%。\n";
const policy = {
  spec: "building-loop/1",
  coordinator: { read: ["first.json", "final.json", "overview.md"] },
  ledgerContext: ["overview.md"],
  units: { K01: {
    candidate: "candidate.md", claims: ["C1", "C2"],
    calculations: { C2: {
      kind: "percent-decrease", source: "timing.csv", keyColumn: "phase", valueColumn: "mean_ms", before: "before", after: "after",
    } },
    phases: {
      intake: { read: ["candidate.md"] },
      "first-review": { read: ["candidate.md", "functional.csv", "overview.md"], evidence: ["functional.csv"], receipt: "first.json" },
      supplement: { read: ["candidate.md", "timing.csv", "first.json", "final.json"], write: ["candidate.md"] },
      "final-review": {
        read: ["candidate.md", "functional.csv", "timing.csv", "overview.md"], evidence: ["functional.csv", "timing.csv"], receipt: "final.json",
      },
    },
  } },
};

/** Each scenario owns an isolated host and project, including filesystem cleanup. */
async function fixture(run) {
  const base = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, "dsh-building-loop-preflight-"));
  const root = path.join(dir, "workspace");
  const host = path.join(dir, "host");
  fs.mkdirSync(root);
  fs.mkdirSync(host);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = host;
  const write = (name, value) => fs.writeFileSync(path.join(root, name), value);
  try {
    write("candidate.md", seed);
    write("functional.csv", "passed,total\n19,20\n");
    write("timing.csv", "phase,mean_ms\nbefore,120\nafter,96\n");
    write("overview.md", "# 当前项目\n旧采集方案已由当前 CSV 样例覆盖。后续扩大样本的计划仍有效。\n");
    write("BUILDING-LOOP.json", JSON.stringify(policy));
    await run(root, write);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    assert.equal(path.dirname(fs.realpathSync.native(dir)), base);
    assert.match(path.basename(dir), /^dsh-building-loop-preflight-/);
    fs.rmSync(dir, { recursive: true });
  }
}

/** Exercise the registered production handlers with real files and host identities. */
function host(root) {
  const live = new Map();
  const tools = new Map();
  const listeners = new Map();
  const notifications = [];
  function agent(id, parentSession) {
    live.set(id, { id, session: { header: { cwd: root, parentSession } },
      whenIdle: async () => {}, model: { current: () => null } });
  }
  agent("root");
  apply({
    agents: { get: id => live.get(id) },
    subagents: {
      startActivation: async args => agent(args.childId, args.request.parent.id),
      sendMessage: async (sender, target, content) => notifications.push({ sender: sender.id, target, content }),
    },
    tools: { register: tool => tools.set(tool.name, tool), guard: () => {} },
    systemPrompt: { context: () => {} }, on: (name, listener) => listeners.set(name, listener),
  });
  const invoke = (id, tool, args) => tools.get(tool).execute(args, { agent: live.get(id), signal: AbortSignal.timeout(3000) });
  return {
    flow: (id, action, args = {}) => invoke(id, "building_loop", { action, unit: "K01", ...args }),
    file: (id, action, path, args = {}) => invoke(id, "building_loop_file", { action, path, ...args }),
    assess: (id, args) => invoke(id, "building_loop_quality", { action: "assess", unit: "K01", ...args }),
    ledger: (id, action, args = {}) => invoke(id, "building_loop_ledger", { action, unit: "K01", ...args }),
    user: (id, seq, content) => listeners.get("session/event")(Object.assign(live.get(id).session, { id }), {
      type: "user/message", seq, data: { source: { kind: "user" }, content: [{ type: "text", text: content }] },
    }),
    interrupt: id => listeners.get("session/event")(Object.assign(live.get(id).session, { id }), {
      type: "turn/end", data: { reason: { kind: "error" } },
    }),
    finish: id => listeners.get("session/event")(Object.assign(live.get(id).session, { id }), {
      type: "turn/end", data: { reason: { kind: "completed" } },
    }),
    notifications,
  };
}


export { fixture, host, policy, seed };
