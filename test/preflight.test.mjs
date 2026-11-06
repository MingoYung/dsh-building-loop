import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../governance/index.mjs";
import { QUALITY, lineList, numericChecks, rejectedClaims, supplementChecks } from "../governance/preflight.mjs";
import { authority, digest } from "../governance/policy.mjs";

const seed = "# 摘要\n- C1：通过 19/20（出处：functional.csv 第 2 行）。\n- C2：平均耗时下降 25%。\n";
const policy = {
  spec: "building-loop/1",
  coordinator: { read: ["first.json", "final.json"] },
  units: { K01: {
    candidate: "candidate.md", claims: ["C1", "C2"],
    calculations: { C2: {
      kind: "percent-decrease", source: "timing.csv", keyColumn: "phase", valueColumn: "mean_ms", before: "before", after: "after",
    } },
    phases: {
      intake: { read: ["candidate.md"] },
      "first-review": { read: ["candidate.md", "functional.csv"], evidence: ["functional.csv"], receipt: "first.json" },
      supplement: { read: ["candidate.md", "timing.csv", "first.json", "final.json"], write: ["candidate.md"] },
      "final-review": {
        read: ["candidate.md", "functional.csv", "timing.csv"], evidence: ["functional.csv", "timing.csv"], receipt: "final.json",
      },
    },
  } },
};

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
    interrupt: id => listeners.get("session/event")(Object.assign(live.get(id).session, { id }), {
      type: "turn/end", data: { reason: { kind: "error" } },
    }),
    notifications,
  };
}

test("actual submit handler blocks unchanged and incorrect candidates before final review", async () => fixture(async (root, write) => {
  const { flow, file, assess, interrupt, notifications } = host(root);
  const worker = (await flow("root", "advance")).childId;
  await file(worker, "read", "candidate.md");
  await flow(worker, "submit");
  const reviewer = (await flow("root", "advance")).childId;
  for (const name of ["candidate.md", "functional.csv"]) await file(reviewer, "read", name);
  const c1 = { id: "C1", status: "supported", file: "functional.csv", start: 1, end: 2, basis: "第1行为表头，第2行确为19,20" };
  const c2 = { id: "C2", status: "supported", file: "timing.csv", start: 2, end: 3, basis: "原文为120到96，差24，除以120得20%" };
  const rejected = await flow(reviewer, "review", { checks: [c1, { id: "C2", status: "unsupported", basis: "没有来源" }] });
  assert.deepEqual(rejected.unsupported, ["C2"]);
  assert.deepEqual(await flow("root", "advance"), { unit: "K01", phase: "supplement", childId: worker, reused: true });
  await file(worker, "read", "candidate.md");
  const check = await flow(worker, "preflight");
  assert.equal(check.calculations[0].expected, "20%");
  const notified = notifications.length;
  await assert.rejects(flow(worker, "submit"), /C2 的退回结论与可定位证据均未变/);
  await assert.rejects(flow("root", "advance"), /尚未交付/);
  assert.equal(notifications.length, notified);
  const withValue = n => seed.replace("25%。", n + "%（出处：timing.csv 第 2-3 行）。");
  await file(worker, "write", "candidate.md", { content: withValue("24"), note: "负向复现" });
  await file(worker, "read", "candidate.md");
  await assert.rejects(flow(worker, "submit"), /降幅应为 20%/);
  await assert.rejects(flow("root", "advance"), /尚未交付/);
  assert.ok(!fs.existsSync(path.join(root, "final.json")));
  await file(worker, "write", "candidate.md", { content: withValue("20"), note: "重算" });
  await file(worker, "read", "candidate.md");
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
  for (const name of ["candidate.md", "functional.csv", "timing.csv"]) await file(reviewer, "read", name);
  await assert.rejects(flow(reviewer, "review", { checks: [c1, c2] }), /先用 building_loop_quality/);
  await assert.rejects(assess(reviewer, { revise: [] }), /质量项 sources/);
  const qualityChecks = Object.fromEntries(Object.entries(QUALITY).map(([k, label]) => [k, "独立核验 " + label]));
  qualityChecks.sources = "没有交代数据是合成材料";
  assert.deepEqual((await assess(reviewer, { ...qualityChecks, revise: ["sources"] })).revise, ["sources"]);
  assert.ok(!fs.existsSync(path.join(root, "final.json")));
  write("candidate.md", withValue("20") + "\n结果的范围限于样例。\n");
  await file(reviewer, "read", "candidate.md");
  await assert.rejects(flow(reviewer, "review", { checks: [c1, c2] }), /当前候选的六项/);
  await assess(reviewer, { ...qualityChecks, revise: ["sources"] });
  assert.deepEqual((await flow(reviewer, "review", { checks: [c1, c2] })).qualityRejected, ["sources"]);
  assert.equal((await flow("root", "advance")).childId, worker);
  await file(worker, "read", "candidate.md");
  await assert.rejects(flow(worker, "submit", { quality }), /退回的质量项 sources 没有修订/);
  await flow(worker, "submit", { quality: { ...quality, sources: "用户提供的合成 CSV，生产代表性未核" } });
  await flow("root", "advance");
  for (const name of ["candidate.md", "functional.csv", "timing.csv"]) await file(reviewer, "read", name);
  qualityChecks.sources = "报告区分合成数据和未核实的生产效果";
  await assess(reviewer, { ...qualityChecks, revise: [] });
  assert.equal((await flow(reviewer, "review", { checks: [c1, c2] })).phase, "closed");
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
