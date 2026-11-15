import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { existingConversationProject, initializeConversationProject } from "../governance/conversation-project.mjs";
import { apply } from "../governance/index.mjs";
import { authority, digest, parseAuthority } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";
import { requireResearchInputs, researchInputs } from "../governance/research-handoff.mjs";
import { fixture } from "./helpers.mjs";

const source = "sources/retention.txt";
const sentence = "服务从入账日起保留记录六个月。";
const url = "https://docs.example.test/retention";
const fact = { file: source, start: 1, end: 1 };
const goal = "overview.md";
const researchRules = "research-rules.md";
const engineeringRules = "engineering-rules.md";
const candidate = "findings.md";
const receipt = "research-first.json";
const implementation = "routing.py";
const textStage = { read: [candidate, source], write: [candidate] };
const regressionKey = generateKeyPairSync("ed25519");
const codeTests = {
  file: "code-proof.json",
  publicKey: regressionKey.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  previousSuiteSha256: digest("旧版工程验证"),
  suiteSha256: digest("当前工程验证"),
  requiredCases: ["retention-explicit"],
  regression: { baselineFile: "code-baseline.json", previousCases: ["existing-behavior"] },
};

function manifest() {
  const codeStage = { read: [implementation], write: [implementation] };
  const reviewResearch = name => ({ read: [candidate, source], evidence: [source], receipt: name });
  return {
    spec: "building-loop/1",
    goalContext: [goal],
    instructions: [researchRules, engineeringRules],
    coordinator: { read: [goal, researchRules, engineeringRules, receipt, "research-final.json",
      "code-first.json", "code-final.json", "unrelated-first.json", "unrelated-final.json"] },
    units: {
      K01: { kind: "research", candidate, plainLast: false, requireSourcePins: true, claims: ["C1"],
        instructions: [researchRules], researchSources: [source],
        phases: { intake: textStage, supplement: textStage,
          "first-review": reviewResearch(receipt), "final-review": reviewResearch("research-final.json") } },
      K02: { candidate: implementation, plainLast: false, codeTask: { sources: [implementation], tests: codeTests },
        instructions: [engineeringRules], researchDependencies: { K01: ["C1"] },
        phases: { intake: codeStage, supplement: codeStage,
          "first-review": { read: [implementation], receipt: "code-first.json" },
          "final-review": { read: [implementation], receipt: "code-final.json" } } },
      K03: { candidate: "unrelated.md", plainLast: false, instructions: [],
        phases: { intake: { read: ["unrelated.md"] }, supplement: { read: ["unrelated.md"] },
          "first-review": { read: ["unrelated.md"], receipt: "unrelated-first.json" },
          "final-review": { read: ["unrelated.md"], receipt: "unrelated-final.json" } } },
    },
  };
}

/** Exercise the registered handlers while the web transport is deterministic and offline. */
function nativeHost(root, web) {
  const handlers = new Map();
  const admitted = new Map();
  const agents = new Map();
  let systemPrompt;
  const add = (id, parentSession) => {
    const actor = {
      id, session: { header: { cwd: root, parentSession }, seq: 0 },
      whenIdle: async () => {},
      model: { current: () => null },
    };
    agents.set(id, actor);
  };
  add("root");
  apply({
    get: name => name === "web" ? web : undefined,
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    subagents: {
      startActivation: async ({ childId, request }) => add(childId, request.parent.id),
      sendMessage: async () => {},
    },
    systemPrompt: { context: value => { systemPrompt = value.text; } },
    tools: {
      register: (tool, options) => {
        handlers.set(tool.name, tool.execute);
        admitted.set(tool.name, options?.when);
      },
      guard() {},
    },
    on() {},
    logger: { warn() {} },
  });
  const invoke = async (actor, tool, action, args = {}) => handlers.get(tool)({ action, ...args }, {
    agent: agents.get(actor), signal: AbortSignal.timeout(3000), concludeTurn() {},
  });
  return {
    invoke,
    flow: (actor, action, args) => invoke(actor, "building_loop", action, args),
    prompt: actor => systemPrompt({ agent: agents.get(actor) }),
    visible: (actor, tool) => admitted.get(tool)?.({ agent: agents.get(actor) }) ?? false,
  };
}

function startEngineering(root) {
  const instruction = "开始建设：先查明公开保留期，再让程序遵循独立核验后的规则。工作单元 K02。";
  const current = latestConversationUser([{ type: "user/message", seq: 0,
    data: { source: { kind: "user" }, content: [{ type: "text", text: instruction }] } }]);
  const { proposal } = proposeConversationTask(process.env.DSH_HOME, "root", current, {
    goal: "核对保留期限", deliverable: "对应接口处理", scope: "按授权资料和实现路径",
  });
  decideConversationStart(process.env.DSH_HOME, "root", current, proposal.id, "start",
    task => initializeConversationProject(process.env.DSH_HOME, "root", root, task), {
      typed: true, inspect: task => existingConversationProject(process.env.DSH_HOME, "root", root, task),
    });
}

test("authority keeps research scopes and declared engineering dependencies separate", () => {
  const accepted = manifest();
  const parse = value => parseAuthority(Buffer.from(JSON.stringify(value)));
  const policy = parse(accepted);
  assert.equal(policy.units.K01.kind, "research");
  assert.deepEqual(policy.units.K01.instructions, [researchRules]);
  assert.deepEqual(policy.units.K02.researchDependencies, [["K01", ["C1"]]]);
  const unrelated = manifest();
  unrelated.units.K02.researchDependencies = { K03: ["C1"] };
  assert.throws(() => parse(unrelated), /已登记的资料单元/);
  const codeWithSources = manifest();
  codeWithSources.units.K02.researchSources = [source];
  assert.throws(() => parse(codeWithSources), /资料采集限于/);
  const wrongSlot = manifest();
  wrongSlot.units.K01.researchSources = ["outside.txt"];
  assert.throws(() => parse(wrongSlot), /资料采集限于/);
});

test("host acquires, independently accepts and hands off research without granting raw file access to engineering", () => fixture(async (root, write) => {
  fs.mkdirSync(path.join(root, "sources"));
  write("BUILDING-LOOP.json", JSON.stringify(manifest()));
  write(goal, "# 当前目标\n核对公开保留期限并实现接口处理。\n");
  write(researchRules, "# 资料规则\n保留原文及适用时间口径。\n");
  write(engineeringRules, "# 工程规则\n保持原接口行为。\n");
  write(candidate, "# 本轮资料\n");
  write(implementation, "def duration():\n    return None\n");
  write("unrelated.md", "# 无关单元\n");
  // Cross the real dispatch gate with the test-only signer and untouched code.
  const policy = authority(root);
  const baseline = {
    spec: "building-loop-code-regression-baseline/1",
    unit: "K02", policySha256: policy.hash, suiteSha256: codeTests.previousSuiteSha256,
    artifacts: codeRegressionArtifacts(root, policy.units.K02), runId: "pre-edit",
    cases: [{ id: "existing-behavior", status: "passed" }],
  };
  const signature = sign(null, codeRegressionSigningBytes(baseline), regressionKey.privateKey).toString("base64");
  write(codeTests.regression.baselineFile, JSON.stringify({ ...baseline, signature }));
  const body = "公共文档\n" + "A".repeat(8_100) + "\n" + sentence + "\n附件无关内容。\n";
  const urls = [];
  const queries = [];
  const web = {
    search: async ({ query }) => {
      queries.push(query);
      return { sources: [{ url, title: "官方保留政策", snippet: "此摘要不足以形成凭据。" }] };
    },
    fetch: async ({ url: requested }) => {
      urls.push(requested);
      return { statusCode: 200, url, body: { kind: "text", content: body } };
    },
  };
  const h = nativeHost(root, web);
  const flow = h.flow;
  const file = (actor, action, file, args) => h.invoke(actor, "building_loop_file", action, { path: file, ...args });
  const acquire = (actor, action, args) => h.invoke(actor, "building_loop_research", action, args);
  const cover = (actor, action, args) => h.invoke(actor, "building_loop_coverage", action, args);

  startEngineering(root);
  await assert.rejects(flow("root", "advance", { unit: "K03" }), /已确认工作单元 K02/);
  await assert.rejects(flow("root", "advance", { unit: "K02" }), /资料.*(?:核验|依赖)|依赖.*资料/);
  const researcher = (await flow("root", "advance", { unit: "K01" })).childId;
  assert.match(h.prompt(researcher), /资料查证/);
  assert.match(h.prompt(researcher), /research-rules\.md/);
  assert.doesNotMatch(h.prompt(researcher), /engineering-rules\.md/);
  assert.equal(h.visible(researcher, "building_loop_research"), true);
  assert.equal(h.visible("root", "building_loop_research"), false);
  await flow(researcher, "prepare");
  const hits = await acquire(researcher, "search", { query: "保留政策" });
  assert.equal(hits.status, "leads-only");
  assert.deepEqual(hits.sources.map(item => item.url), [url]);
  assert.deepEqual(queries, ["保留政策"]);
  assert.equal(fs.existsSync(path.join(root, source)), false, "Search snippets are not enrolled as evidence.");

  const fetched = await acquire(researcher, "fetch", { url });
  assert.deepEqual(urls, [url]);
  assert.equal(fetched.offset, 0);
  assert.equal(fetched.nextOffset, 8000);
  assert.equal(fetched.responseSha256, digest(body));
  const remaining = await acquire(researcher, "preview", { offset: fetched.nextOffset });
  assert.ok(remaining.text.includes(sentence));
  await assert.rejects(acquire(researcher, "seal", { path: source, excerpts: ["未出现在响应里的引句。"] }), /逐字|本次响应/);
  await assert.rejects(acquire(researcher, "seal", { path: "sources/other.txt", excerpts: [sentence] }), /授权采集槽/);
  const sealed = await acquire(researcher, "seal", { path: source, excerpts: [sentence] });
  assert.equal(sealed.sha256, digest(sentence + "\n"));
  assert.equal(fs.readFileSync(path.join(root, source), "utf8"), sentence + "\n");
  await file(researcher, "write", candidate, { content: "- C1：" + sentence.slice(0, -1) + "（出处：" + source + " 第 1 行）。\n", note: "给工程提供逐字原文与适用口径。" });
  await flow(researcher, "prepare");
  assert.equal((await flow(researcher, "submit")).phase, "review-ready");

  const prepareReview = async actor => {
    assert.equal(h.visible(actor, "building_loop_research"), false);
    const page = (await flow(actor, "prepare")).coverage;
    assert.equal(page.pendingCount, 1);
    const result = await cover(actor, "record", { entries: [{ block: page.blocks[0].id,
      parts: [{ kind: "direct", status: "supported", sourceRelation: "supports", basis: "官方原文明确给出起算日和期限。",
        evidence: [{ ...fact, quote: sentence }] }] }] });
    assert.deepEqual(result.recorded, [page.blocks[0].id]);
  };
  const reviewer = (await flow("root", "advance", { unit: "K01" })).childId;
  await prepareReview(reviewer);
  const assessment = Object.fromEntries(Object.keys(QUALITY).map(key => [key, "核过已登记的原文、期限及起算条件。"]));
  await h.invoke(reviewer, "building_loop_quality", "assess", {
    ...assessment, goalFit: { pass: true, basis: "当前已按总纲确定保留期限。" }, sourceRefs: [fact],
    unverifiedSources: [], unlisted: [], revise: [],
  });
  const checks = [{ id: "C1", status: "supported", basis: "真实获取的原文确证结论和范围。", ...fact }];
  assert.equal((await flow(reviewer, "review", { checks })).phase, "first-audit-ready");
  const auditor = (await flow("root", "advance", { unit: "K01" })).childId;
  assert.notEqual(auditor, reviewer);
  await assert.rejects(file(auditor, "read", receipt), /白名单/);
  await prepareReview(auditor);
  assert.equal((await flow(auditor, "audit")).phase, "ledger-review");

  await file("root", "read", goal);
  await file("root", "read", receipt, { start: 1, end: 5 });
  const ledger = await h.invoke("root", "building_loop_ledger", "read", { unit: "K01" });
  const decisions = ledger.items.map(item => item.unit === "K01" ? {
    id: item.id, outcome: "completed", basis: "原文及两个不同角色的当前版回执已确认本项。",
    evidence: { file: receipt, start: 1, end: 5 },
  } : { id: item.id, outcome: "keep", basis: "由后续工程任务按已核资料落实。" });
  const closed = await h.invoke("root", "building_loop_ledger", "review", { unit: "K01", decisions });
  assert.equal(closed.phase, "closed");
  const engineer = (await flow("root", "advance", { unit: "K02" })).childId;
  assert.match(h.prompt(engineer), /engineering-rules\.md/);
  assert.doesNotMatch(h.prompt(engineer), /research-rules\.md|retention\.txt/);
  assert.equal(h.visible(engineer, "building_loop_research"), false);
  await assert.rejects(acquire(engineer, "fetch", { url }), /没有资料采集授权/);
  const packet = await flow(engineer, "prepare");
  assert.deepEqual(packet.research.conclusions.map(row => [row.unit, row.claim]), [["K01", "C1"]]);
  assert.equal(packet.research.conclusions[0].evidence[0].locator, url);
  assert.ok(packet.files.every(row => row.path !== source));
  await assert.rejects(file(engineer, "read", source), /白名单/);

  // External replacement bypasses the model's allowlist, so the bound
  // engineering session must revalidate the research receipt before reuse.
  write(source, "未经登记的更新版本。\n");
  await assert.rejects(flow(engineer, "prepare"), /依赖的资料尚未独立核验或已失效/);
}));

test("an unfilled acquisition slot can be rejected and handed back without forcing a bogus source", () => fixture(async (root, write) => {
  fs.mkdirSync(path.join(root, "sources"));
  write("BUILDING-LOOP.json", JSON.stringify(manifest()));
  write(goal, "# 当前目标\n用已核实原文确定这条保留规则。\n");
  write(researchRules, "# 资料规则\n保留原文来源。\n");
  write(engineeringRules, "# 工程规则\n保留旧接口行为。\n");
  write(candidate, "- C1：" + sentence + "\n");
  write(implementation, "def duration():\n    return None\n");
  const h = nativeHost(root, undefined);
  const flow = h.flow;
  startEngineering(root);
  const worker = (await flow("root", "advance", { unit: "K01" })).childId;
  await flow(worker, "prepare");
  assert.equal((await flow(worker, "submit")).phase, "review-ready");
  const reviewer = (await flow("root", "advance", { unit: "K01" })).childId;
  const packet = await flow(reviewer, "prepare");
  assert.equal(packet.files.some(file => file.path === source), false);
  assert.equal(fs.existsSync(path.join(root, source)), false);

  const finding = { kind: "missing-evidence", quote: sentence, fix: "取得并登记支持起算日与期限的原文。" };
  const basis = "采集槽尚空，没有允许用于证实结论的原文。";
  const block = packet.coverage.blocks[0];
  const covered = await h.invoke(reviewer, "building_loop_coverage", "record", { entries: [{ block: block.id,
    parts: [{ kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis, finding }] }] });
  assert.deepEqual(covered.recorded, [block.id]);

  const quality = Object.fromEntries(Object.keys(QUALITY).map(key => [key, "核对了本轮稿件和当前授权的证据槽。"]));
  const assessment = await h.invoke(reviewer, "building_loop_quality", "assess", {
    ...quality, goalFit: { pass: false, basis }, sourceRefs: [],
    unverifiedSources: ["资料采集槽尚未取得原文。"], unlisted: [], revise: [],
  });
  assert.deepEqual(assessment.observedSources, []);
  const decision = await flow(reviewer, "review", { checks: [{ id: "C1", status: "unsupported", basis, finding }] });
  assert.equal(decision.phase, "supplement-ready");
  const supplement = await flow("root", "advance", { unit: "K01" });
  assert.equal(supplement.phase, "supplement");
  assert.equal(supplement.childId, worker);
  assert.equal(h.visible(worker, "building_loop_research"), true);
  await assert.rejects(flow("root", "advance", { unit: "K02" }), /资料.*(?:核验|依赖)|依赖.*资料|尚有其他工作单元/);
}));


test("handoff projects exactly one selected positive conclusion and invalidates stale or rejected claims", () => fixture(async (root, write) => {
  const markdown = "- C1：实际结论及条件。\n- C2：不应进入工程的无关结论。\n";
  write(candidate, markdown);
  const original = n => ({ file: "sources/source" + n + ".txt", start: 1, end: 1, sha256: digest("excerpt" + n),
    origin: { kind: "primary", locator: "https://docs.example.test/source" + n } });
  const proof = refs => ({ records: [
    { line: 1, parts: [{ status: "supported", evidence: refs }] },
    { line: 2, parts: [{ status: "supported", evidence: [original(3)] }] },
  ] });
  const active = { phase: "closed", proof: { reviewerCoverage: proof([original(1)]), auditorCoverage: proof([original(2)]) } };
  const frame = { root, policy: { units: { K01: { candidate }, K02: { researchDependencies: [["K01", ["C1"]]] } } },
    state: { units: { K01: active } } };
  const accepted = { candidateSha256: digest(markdown), checks: [
    { id: "C1", line: 1, status: "supported" }, { id: "C2", line: 2, status: "supported" },
  ] };
  const accept = (_frame, id, unit) => {
    assert.equal(id, "K01");
    assert.equal(unit, active);
    return accepted;
  };

  const handoff = requireResearchInputs(frame, "K02", accept);
  assert.equal(handoff.ready.length, 1);
  assert.deepEqual(handoff.blocked, []);
  assert.deepEqual(handoff.ready[0].evidence.map(ref => ref.file), ["sources/source1.txt", "sources/source2.txt"]);
  assert.doesNotMatch(JSON.stringify(handoff), /C2|source3/);

  active.proof.auditorCoverage = proof([original(4)]);
  assert.throws(() => requireResearchInputs(frame, "K02", accept, handoff.versions), /结论已变化/);
  accepted.checks[0].status = "unsupported";
  const rejected = researchInputs(frame, "K02", accept);
  assert.deepEqual(rejected.ready, []);
  assert.equal(rejected.blocked[0].status, "unproven");

  write(candidate, markdown.replace("实际结论", "未经核的新结论"));
  const changed = researchInputs(frame, "K02", accept);
  assert.deepEqual(changed.ready, []);
  assert.equal(changed.blocked[0].status, "stale");
  const invalidProof = researchInputs(frame, "K02", () => { throw new Error("原始凭据已失效"); });
  assert.equal(invalidProof.blocked[0].status, "stale");
}));
