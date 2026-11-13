import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { architectureProseInventory, checkArchitectureProseReceipt, linkedResponsibilityConflicts } from "../governance/architecture-prose-coverage.mjs";
import { codeRegressionArtifacts, codeRegressionSigningBytes } from "../governance/code-intake.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { authority, digest } from "../governance/policy.mjs";
import { fixture, host } from "./helpers.mjs";

const fact = { id: "request-shape", decision: { file: "worker.py", line: 21 }, response: { error: "invalid-request" } };
const base = [
  "# Architecture",
  "## Verified",
  "A host-only block [proof](#bl-fact-request-shape).",
  "",
  "## Implementation",
  "1. Inventory inputs.",
  "2. Apply [shape rule](#bl-fact-request-shape).",
  "   The worker owns this branch.",
  "   - Keep plan notes close to source.",
  "3. Run checks.",
  "",
  "> Quoted bad example [ignore](#bl-fact-unknown).",
  "",
  "```text",
  "[ignore](#bl-fact-unknown)",
  "```",
  "",
  "<div>",
  "",
  "Hidden text [ignore](#bl-fact-unknown).",
  "",
  "</div>",
  "",
  "## Further notes",
  "",
  "Re-check rollover after launch.",
].join("\n");
const options = { source: base, sections: [{ heading: "Implementation", start: 5, end: 23 }],
  protectedHeadings: ["Verified"], facts: [fact] };
const build = changes => architectureProseInventory({ ...options, ...changes });
const reviewed = (inventory, decisions = new Map()) => {
  const blocks = inventory.blocks.map(block => ({ id: block.id, sha256: block.sha256,
    status: block.refs.length ? "consistent" : "no-current-claim", facts: block.refs, ...decisions.get(block.id) }));
  return { binding: inventory.binding, blocks, facts: inventory.sections.flatMap(section =>
    inventory.facts.map(({ id }) => ({ section: section.id, id,
      blocks: blocks.filter(block => section.blocks.includes(block.id) && block.facts.includes(id)).map(block => block.id) }))) };
};

test("host inventory uses visible paragraphs and independent list items, including extra headings", () => {
  const inventory = build();
  assert.deepEqual(inventory.blocks.map(({ kind, start, end, refs }) => ({ kind, start, end, refs })), [
    { kind: "list-item", start: 6, end: 6, refs: [] },
    { kind: "list-item", start: 7, end: 8, refs: [fact.id] },
    { kind: "list-item", start: 9, end: 9, refs: [] },
    { kind: "list-item", start: 10, end: 10, refs: [] },
    { kind: "heading", start: 24, end: 24, refs: [] },
    { kind: "paragraph", start: 26, end: 26, refs: [] },
  ]);
  assert.equal(checkArchitectureProseReceipt(inventory, reviewed(inventory)).status, "pass");
  const shifted = build({ source: base.replace("1. Inventory inputs.", "\n1. Inventory inputs."),
    sections: [{ heading: "Implementation", start: 5, end: 24 }] });
  assert.deepEqual(shifted.blocks.map(block => block.id), inventory.blocks.map(block => block.id));
  assert.notEqual(shifted.binding.sourceSha256, inventory.binding.sourceSha256);
});

test("omitted item or fact review prevents a blanket section pass", () => {
  const inventory = build();
  const reviewedAll = reviewed(inventory);
  const omitted = { ...reviewedAll, blocks: reviewedAll.blocks.filter(row => row.id !== inventory.blocks[3].id),
    facts: reviewedAll.facts.slice(0, 1) };
  const result = checkArchitectureProseReceipt(inventory, omitted);
  assert.equal(result.status, "pending");
  assert.deepEqual(result.missing, [inventory.blocks[3].id]);
  assert.deepEqual(result.missingFacts, [{ section: inventory.sections[1].id, id: fact.id }]);
});

test("contradiction cites current block and fact; stale or wrong spans cannot pass", () => {
  const inventory = build();
  const block = inventory.blocks[1];
  const contradiction = new Map([[block.id, { status: "contradiction", facts: [fact.id], line: 8 }]]);
  const record = reviewed(inventory, contradiction);
  const rejected = checkArchitectureProseReceipt(inventory, record);
  assert.equal(rejected.status, "revise");
  assert.deepEqual(rejected.findings, [{ id: block.id, section: block.section, heading: block.heading,
    status: "contradiction", line: 8, facts: [fact.id] }]);
  assert.equal(checkArchitectureProseReceipt(build({ facts: [{ ...fact, decision: { file: "worker.py", line: 22 } }] }),
    record).reason, "coverage-version-changed");
  assert.equal(checkArchitectureProseReceipt(inventory,
    reviewed(inventory, new Map([[block.id, { status: "contradiction", facts: [fact.id], line: 6 }]]))).status, "pending");
  assert.equal(checkArchitectureProseReceipt(inventory,
    reviewed(inventory, new Map([[block.id, { status: "consistent", facts: [] }]]))).status, "pending");
  assert.equal(checkArchitectureProseReceipt(inventory,
    reviewed(inventory, new Map([[block.id, { status: "plan", facts: [fact.id] }]]))).status, "pending");
  assert.equal(checkArchitectureProseReceipt(inventory,
    reviewed(inventory, new Map([[inventory.blocks[0].id, { status: "plan" }]]))).status, "pass");
});

test("unrecognized fact links remain visible and block a completed review", () => {
  const inventory = build({ source: base.replace("[shape rule](#bl-fact-request-shape)", "[shape rule](#bl-fact-wrong)") });
  assert.deepEqual(inventory.blocks[1].unknownRefs, ["wrong"]);
  assert.equal(checkArchitectureProseReceipt(inventory, reviewed(inventory)).status, "pending");
});

test("an explicit business fact linked to the wrong local decision overrides a consistent receipt", () => {
  // This is the authored G1 checkpoint line that the first live reviewer marked consistent.
  const wrong = "1. **transport（release.py）**：只做 stdin 读取与 JSON 往返。空输入或解析失败返回 `invalid-json`；顶层不是对象返回 `invalid-request`；结果序列化为单个 JSON 对象写到 stdout；所有业务错误也以正常退出码返回。请求对象的非对象形态（含数组、null、标量）在此处拦截，对应 [请求对象判定](#bl-fact-nonobject-request)。";
  const decision = { file: "planner.py", line: 61, symbol: "plan", mode: "business", code: "invalid-request" };
  const hostFact = { id: "nonobject-request", mode: "business", actual: decision };
  const source = "# 发布规划与维护\n\n## 实施顺序\n\n" + wrong;
  const expected = { line: 5, from: "release.py", actual: [{ file: "planner.py", line: 61, symbol: "plan" }],
    id: hostFact.id, relation: "linked-responsibility" };
  assert.deepEqual(linkedResponsibilityConflicts(source, [hostFact]), [expected]);
  const inventory = architectureProseInventory({ source, sections: [{ heading: "实施顺序", start: 3, end: 5 }], facts: [hostFact] });
  const [block] = inventory.blocks;
  assert.deepEqual(block.hostConflicts, [expected]);
  const checked = checkArchitectureProseReceipt(inventory, reviewed(inventory));
  assert.equal(checked.status, "revise");
  assert.deepEqual(checked.findings, [{ id: block.id, section: block.section, heading: "实施顺序", line: 5,
    status: "contradiction", facts: [hostFact.id], hostConflict: expected }]);

  const controls = [
    source.replace("transport（release.py）", "planner（planner.py）"),
    source.replace("在此处拦截，对应", "由下游拦截，本层仅透传，详见"),
    source.replace("在此处拦截，对应", "在此处兜底，对应"),
    source.replace("在此处拦截，对应", "计划在此处拦截，对应"),
    source.replace("在此处拦截，对应", "例如在此处拦截，对应"),
    source.replace("## 实施顺序", "## 反例\n\n### 实施顺序"),
    source.replace("`invalid-request`", "`wrong-envelope`"),
    source.replace("顶层不是对象返回", "旧版入口兜底返回"),
    source.replace("顶层不是对象返回", "示例使用"),
    source.replace("\n1. ", "\n> 1. "),
    source.replace("\n1. ", "\n```md\n1. ") + "\n```",
  ];
  for (const control of controls) assert.deepEqual(linkedResponsibilityConflicts(control, [hostFact]), [], control);
  assert.deepEqual(linkedResponsibilityConflicts(source, [{ ...hostFact, mode: "fallback" }]), []);
  assert.deepEqual(linkedResponsibilityConflicts(source, [{ ...hostFact, actual: undefined, planned: decision }]), []);
  assert.deepEqual(linkedResponsibilityConflicts(source, []), []);
});

test("the same grammar binds an arbitrary response and module to the protected fact's exact source line", () => {
  const audit = { id: "blocked-action", decision: { mode: "business", file: "core/actions.py", symbol: "authorize", line: 18, code: "action-denied" } };
  const source = "## Current wiring\n\n- `adapter.py`: Returns `action-denied` on restriction. The request is rejected here, see\n" +
    "  [action rule](#bl-fact-blocked-action).\n";
  assert.deepEqual(linkedResponsibilityConflicts(source, [audit]), [{ line: 3, from: "adapter.py",
    actual: [{ file: "core/actions.py", line: 18, symbol: "authorize" }], id: audit.id, relation: "linked-responsibility" }]);
  assert.deepEqual(linkedResponsibilityConflicts(source.replace("`adapter.py`", "`actions.py`"), [audit]), []);
  assert.deepEqual(linkedResponsibilityConflicts(source.replace("rejected here", "forwarded here"), [audit]), []);
});

test("the real code-review path requires two independent block receipts and routes exact contradictions to the coordinator", () =>
  fixture(async (root, write) => {
    const goal = "GOAL.md";
    const architecture = "modules/architecture.md";
    const entry = "entry.py";
    const worker = "worker.py";
    const sources = [entry, worker];
    const output = { error: "invalid-request" };
    const clause = "A request that is not an object returns the invalid-request error.";
    const secret = "isolated-architecture-prose-test-runner";
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const request = JSON.parse(Buffer.concat(chunks));
      assert.equal(req.headers.authorization, "Bearer " + secret);
      assert.equal(request.probe.trace, true);
      assert.deepEqual(JSON.parse(request.probe.stdin), []);
      res.end(JSON.stringify({ spec: request.spec, requestId: request.requestId, snapshotSha256: request.snapshotSha256,
        status: "passed", probe: { exitCode: 0, stdout: JSON.stringify(output), executed: [{ path: worker, line: 3 }, { path: worker, line: 4 }] } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const env = { DSH_BUILDING_LOOP_DIAGNOSTICS_URL: "http://127.0.0.1:" + server.address().port + "/run",
      DSH_BUILDING_LOOP_DIAGNOSTICS_TOKEN: secret };
    const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      const keys = generateKeyPairSync("ed25519");
      const tests = { file: "current.json", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        previousSuiteSha256: digest("old suite"), suiteSha256: digest("new suite"), requiredCases: ["request-shape"],
        regression: { baselineFile: "baseline.json", previousCases: ["legacy"] } };
      const declared = { spec: "building-loop/1", goalContext: [goal],
        hierarchy: { overview: { path: goal, heading: "Navigation" }, index: { path: "INDEX.md", heading: "Modules" },
          modules: { architecture } },
        coordinator: { read: [goal, "INDEX.md", architecture, "first.json", "final.json"], write: [architecture] },
        units: { K01: { candidate: entry, plainLast: false, architecture: { module: "architecture", headings: ["Implementation", "Rollback"],
          responsibilitiesHeading: "Verified", proseReview: true,
          responsibilities: [{ id: "request-shape", mode: "business", owner: { file: worker },
            trigger: { kind: "input-type", argument: 0, type: "object", test: "not" }, exampleId: "entry:example:non-object" }] },
        codeTask: { sources, tests, diagnostics: { checkSet: "request-architecture", protocol: 2, recipes: ["entry"], reviewRecipes: ["entry"],
          inputContracts: [{ id: "entry", recipe: "entry", examples: [{ id: "non-object", input: [], expectedJson: output,
            requirement: { file: goal, start: 3, end: 3, quote: clause } }] }] } },
        phases: { intake: { read: sources, write: sources }, supplement: { read: sources, write: sources },
          "first-review": { read: [...sources, architecture], receipt: "first.json" },
          "final-review": { read: [...sources, architecture], receipt: "final.json" } } } } };
      const wrong = "A non-object is rejected at the CLI, and remaining values are sent downstream.";
      const fixed = "[Non-object rejection](#bl-fact-request-shape) is owned by the worker and returned by the CLI.";
      const doc = "# Architecture\n\n## Implementation\n\n1. Keep the caller's interface simple.\n2. " + wrong +
        "\n\n## Rollback\n\nPlan to restore the preceding unit if the new check regresses.\n\n## Verified\n\nPending host evidence.\n";
      write(goal, "# Goal\n\n" + clause + "\n\n## Navigation\n\n- [Index](INDEX.md)\n");
      write("INDEX.md", "# Index\n\n## Modules\n\n- [Architecture](modules/architecture.md)\n");
      fs.mkdirSync(path.join(root, "modules"));
      write(architecture, doc);
      write(entry, "from worker import validate\n\ndef dispatch(value):\n    return validate(value)\n");
      write(worker, "def validate(value):\n    return value\n");
      write("BUILDING-LOOP.json", JSON.stringify(declared));
      const policy = authority(root);
      assert.equal(policy.units.K01.architecture.proseReview, true);
      const save = (file, body) => write(file, JSON.stringify({ ...body, signature:
        sign(null, codeRegressionSigningBytes(body), keys.privateKey).toString("base64") }));
      save(tests.regression.baselineFile, { spec: "building-loop-code-regression-baseline/1", unit: "K01", policySha256: policy.hash,
        suiteSha256: tests.previousSuiteSha256, artifacts: codeRegressionArtifacts(root, policy.units.K01), runId: "baseline",
        cases: [{ id: "legacy", status: "passed" }] });
      const user = latestConversationUser([{ type: "user/message", seq: 12, data: { source: { kind: "user" },
        content: [{ type: "text", text: "开始建设：校验输入形状，工作单元 K01。" }] } }]);
      const { proposal } = proposeConversationTask(process.env.DSH_HOME, "root", user,
        { goal: "校验输入形状", deliverable: "代码及架构回执", scope: "已授权源码" });
      decideConversationStart(process.env.DSH_HOME, "root", user, proposal.id, "start", () => ({ kind: "workspace", root }), { typed: true });
      const harness = host(root, { automaticCoverage: false });
      await harness.flow("root", "architecture");
      const executor = (await harness.flow("root", "advance")).childId;
      write(worker, 'def validate(value):\n    # Keep the transport free of domain-specific errors.\n    if not isinstance(value, dict):\n        return {"error": "invalid-request"}\n    return value\n');
      const { codeTask } = await harness.flow(executor, "prepare");
      const { file, previousCases, requiredCases, protectedCases, ...challenge } = codeTask.regressionProof;
      save(file, { ...challenge, runId: "current", cases: [...previousCases, ...requiredCases].map(id => ({ id, status: "passed" })) });
      assert.equal((await harness.flow(executor, "submit")).phase, "architecture-sync");
      assert.equal((await harness.flow("root", "architecture")).phase, "review-ready");
      await assert.rejects(harness.file("root", "read", worker), /读白名单/u);
      const invoke = (actor, action, input = {}) => harness.invoke(actor, "building_loop_code_review", { action, ...input });

      async function prepare(actor) {
        const { codeReview } = await invoke(actor, "prepare");
        const { pendingBlocks, pendingFacts } = codeReview.proseReview;
        assert.deepEqual(codeReview.proseReview.factLocations, [{ id: "request-shape", anchor: "#bl-fact-request-shape",
          clause: { file: goal, start: 3, end: 3 }, decision: { file: worker, line: 4, mode: "business" } }]);
        const fileId = codeReview.pending.find(row => row.kind === "file").id;
        const testId = codeReview.pending.find(row => row.kind === "test").id;
        assert.ok(!codeReview.pending.some(row => row.kind === "section"));
        assert.equal(pendingBlocks.length, 3);
        assert.equal(pendingFacts.length, 2);
        const aliases = name => codeReview.refs.find(row => row.file === name).prefix;
        const decisions = [{ id: fileId, status: "verified", basis: "The comment explains the ownership boundary.",
          refs: [aliases(worker) + ":2"] }, { id: testId, status: "pass", basis: "The test covers the actual rejection branch.",
          refs: [aliases(goal) + ":3", aliases(worker) + ":3-4"] }];
        return { codeReview, decisions, pendingBlocks, pendingFacts };
      }
      function prose(packet, status) {
        const conflict = packet.pendingBlocks.find(row => row.start === 6);
        const coverage = packet.pendingBlocks.map(row => row === conflict ? { id: row.id, status, facts: ["request-shape"],
          basis: "The worker rejects the input, and the transport returns its result.", ...(status === "contradiction" ? { line: 6 } : {}) }
          : { id: row.id, status: "plan" });
        const factReview = packet.pendingFacts.map(({ id, section }) => ({
          id, section, blocks: section === conflict.section ? [conflict.id] : [],
        }));
        return { conflict, coverage, factReview };
      }
      const initialReviewer = (await harness.flow("root", "advance")).childId;
      const first = await prepare(initialReviewer);
      const { conflict, coverage, factReview } = prose(first, "contradiction");
      const blanket = await invoke(initialReviewer, "record", { findingsDone: true,
        architecture: { status: "pass", basis: "Everything in this section passes." } });
      assert.equal(blanket.progress.ready, false);
      assert.match(blanket.errors[0].reason, /逐段核验/u);
      const omitted = await invoke(initialReviewer, "record", { decisions: first.decisions,
        proseCoverage: coverage.filter(row => row.id !== conflict.id), findingsDone: true });
      assert.deepEqual(omitted.next.proseReview.pendingBlocks.map(row => row.id), [conflict.id]);
      assert.equal((await invoke(initialReviewer, "submit")).status, "needs-review");
      const crossItem = await invoke(initialReviewer, "record", {
        proseCoverage: [{ ...coverage.find(row => row.id === conflict.id), line: 5 }],
      });
      assert.match(crossItem.errors[0].reason, /不能用同一章节的其他条目/u);
      const reject = await invoke(initialReviewer, "record", { proseCoverage: coverage.filter(row => row.id === conflict.id),
        proseFactReview: factReview, findingsDone: true });
      assert.equal(reject.progress.ready, true);
      assert.equal((await invoke(initialReviewer, "submit")).phase, "architecture-repair");
      const firstReceipt = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
      assert.deepEqual(firstReceipt.codeReview.architecture.proseReview.findings.map(({ id, line, facts }) => ({ id, line, facts })),
        [{ id: conflict.id, line: 6, facts: ["request-shape"] }]);

      const verifiedDoc = fs.readFileSync(path.join(root, architecture), "utf8");
      await harness.file("root", "write", architecture, { content: verifiedDoc.replace(wrong, fixed), note: "Correct only the disputed item" });
      assert.equal((await harness.flow("root", "architecture")).phase, "final-review-ready");
      const reviewer = (await harness.flow("root", "advance")).childId;
      const current = await prepare(reviewer);
      const updated = prose(current, "consistent");
      assert.notEqual(updated.conflict.id, conflict.id);
      const stale = await invoke(reviewer, "record", { proseCoverage: coverage.filter(row => row.id === conflict.id) });
      assert.match(stale.errors[0].reason, /proseReview 中的编号/u);
      const complete = await invoke(reviewer, "record", { decisions: current.decisions, proseCoverage: updated.coverage,
        proseFactReview: updated.factReview, findingsDone: true });
      assert.equal(complete.progress.ready, true);
      assert.equal((await invoke(reviewer, "submit")).phase, "final-audit-ready");
      const auditor = (await harness.flow("root", "advance")).childId;
      assert.notEqual(auditor, reviewer);
      const blind = await prepare(auditor);
      const blocked = await invoke(auditor, "record", { decisions: blind.decisions, findingsDone: true });
      assert.equal(blocked.progress.ready, false);
      assert.equal((await invoke(auditor, "submit")).status, "needs-review");
      const own = prose(blind, "consistent");
      assert.equal((await invoke(auditor, "record", { proseCoverage: own.coverage, proseFactReview: own.factReview })).progress.ready, true);
      assert.equal((await invoke(auditor, "submit")).phase, "ledger-review");
      const finalReceipt = JSON.parse(fs.readFileSync(path.join(root, "final.json"), "utf8"));
      assert.equal(finalReceipt.codeReview.actor, reviewer);
      assert.equal(finalReceipt.independentAudit.codeReview.actor, auditor);
      for (const proof of [finalReceipt.codeReview, finalReceipt.independentAudit.codeReview]) {
        assert.equal(proof.architecture.proseReview.blocks.length, 3);
        const row = proof.architecture.proseReview.blocks.find(item => item.id === updated.conflict.id);
        assert.equal(row.proof[0].decision.file, worker);
        assert.equal(row.proof[0].decision.start, 4);
        assert.equal(row.proof[0].clause.file, goal);
      }
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }));
