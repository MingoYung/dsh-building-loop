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
function host(root, { automaticCoverage = true } = {}) {
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
  // Older tests isolate arithmetic/ledger behavior. Supply explicit scripted
  // reviewer and independent-auditor decisions through the production tools;
  // this is not evidence that the fixture's semantic judgments are correct.
  const fill = async (id, checks) => {
    const inventory = await invoke(id, "building_loop_coverage", { action: "inventory" });
    const entries = inventory.blocks.map(block => {
      const check = checks.find(c => new RegExp("\\b" + c.id + "[：:]").test(block.text));
      let part = { kind: "nonfactual", status: "supported", basis: "脚本测试中的结构或说明，不属于本用例的事实判断。" };
      if (check) {
        part = { kind: "direct", status: check.status, sourceRelation: check.status === "supported" ? "supports" : "insufficient", basis: check.basis };
        if (check.status === "supported" && check.file) part.evidence = [{ file: check.file, start: check.start, end: check.end,
          quote: fs.readFileSync(path.join(root, check.file), "utf8").split(/\r?\n/).slice(check.start-1,check.end).join("\n") }];
        else {
          part.repair = check.finding?.fix ?? "按实际来源修订该条结论。";
          part.finding = check.finding ?? {kind:"missing-evidence",quote:block.text,fix:part.repair};
        }
      }
      return { block: block.id, parts: [part] };
    });
    await invoke(id, "building_loop_coverage", { action: "record", entries });
    return entries;
  };
  const flow = async (id, action, args = {}) => {
    const status = automaticCoverage && action === "review" ? await invoke(id,"building_loop",{action:"status"}) : null;
    // Let original validation report malformed arguments or changed goals first.
    let entries;
    if (status?.role === "reviewer" && args.unit !== "K02") {
      const state = (await invoke("root","building_loop",{action:"status"})).units[0];
      if (!state.goalStale && args.checks?.length && args.checks.every(c => c.status !== "supported" || c.file && c.start && c.end)) {
        try { entries = await fill(id,args.checks); } catch { /* Original review reports its primary input error. */ }
      }
    }
    const result = await invoke(id,"building_loop",{action,unit:"K01",...args});
    if (automaticCoverage && result.phase?.endsWith("audit-ready")) {
      const auditor = (await invoke("root","building_loop",{action:"advance",unit:"K01"})).childId;
      const grant = await invoke(auditor,"building_loop_file",{action:"list"});
      for (const file of grant.read) if (fs.existsSync(path.join(root,file))) await invoke(auditor,"building_loop_file",{action:"read",path:file});
      await invoke(auditor,"building_loop_coverage",{action:"inventory"});
      await invoke(auditor,"building_loop_coverage",{action:"record",entries});
      return invoke(auditor,"building_loop",{action:"audit",unit:"K01"});
    }
    return result;
  };
  return {
    flow,
    coverage: (id, action, args = {}) => invoke(id, "building_loop_coverage", { action, ...args }),
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
