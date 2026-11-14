import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { documentCoverage } from "../governance/coverage.mjs";
import {
  declaredDeliveryOutcomes,
  deliveryOutcomeLayoutIssues,
  requireAcceptedDeliveryOutcomes,
  reviewDeliveryOutcomes,
} from "../governance/delivery-outcomes.mjs";
import { evidenceSpan } from "../governance/evidence.mjs";
import { digest } from "../governance/policy.mjs";
import { QUALITY } from "../governance/preflight.mjs";
import {
  archivedDeliveryAcceptance,
  archivedDeliveryCandidate,
  archivedDeliveryRoles,
  deliveryVariants,
  nativeOutcomeLayoutDraft,
  nativeOutcomeLayoutSha256,
} from "./fixtures/delivery-outcomes.mjs";
import { frozenAssertionMaterial, installFrozenAssertionFixture } from "./fixtures/assertion-reconciliation.mjs";
import { fixture, host } from "./helpers.mjs";

test("native R80 closed although E3's fact and rule proofs never produced an outcome", () => {
  assert.equal(digest(Buffer.from(archivedDeliveryCandidate)), archivedDeliveryAcceptance.candidateSha256);
  assert.equal(digest(Buffer.from(frozenAssertionMaterial["PROJECT.md"])), archivedDeliveryAcceptance.goalFileSha256);
  assert.equal(digest(Buffer.from(frozenAssertionMaterial["sources/regional-register.md"])), archivedDeliveryAcceptance.sourceSha256);
  assert.equal(archivedDeliveryAcceptance.terminal, "closed");
  assert.equal(archivedDeliveryAcceptance.decision, "accept");
  assert.equal(archivedDeliveryAcceptance.goalFit.pass, true);

  const draft = archivedDeliveryCandidate.split("\n");
  assert.match(frozenAssertionMaterial["PROJECT.md"].split("\n")[3], /为 E1、E2、E3 分别写清处置/u);
  assert.equal(frozenAssertionMaterial["sources/regional-register.md"].split("\n")[4], "E3 地区：空白。");
  assert.match(draft[7], /它是否等同“地区字段空白”从而列入待补/u);
  assert.match(draft[13], /既不收也不当空字段补，除非按总纲规则/u);

  assert.notEqual(archivedDeliveryRoles.reviewer.receiptSha256, archivedDeliveryRoles.auditor.receiptSha256);
  for (const role of Object.values(archivedDeliveryRoles)) {
    assert.equal(role.candidateSha256, archivedDeliveryAcceptance.candidateSha256);
    assert.equal(role.rejectedCount, 0);
    for (const line of [8, 14]) {
      const scoped = role.records.filter(record => record.line === line).flatMap(record => record.parts);
      const ruleAndEvidence = scoped.find(part => part.policy?.some(ref =>
        ref.start === 4 && ref.goalSha256 === archivedDeliveryAcceptance.goalSha256)
        && part.premises?.some(ref => ref.file === "sources/regional-register.md" && ref.start === 5));
      assert.ok(ruleAndEvidence, "each role actually bound the current rule and the E3 row");
      for (const ref of [...ruleAndEvidence.policy, ...ruleAndEvidence.premises]) {
        const bytes = Buffer.from(frozenAssertionMaterial[ref.file]);
        assert.equal(digest(bytes), ref.sha256);
        assert.equal(evidenceSpan(bytes, ref), ref.evidenceSpan);
      }
      assert.ok(scoped.every(part => draft[line - 1].includes(part.quote)));
    }
  }
});

test("declared outcomes take IDs from visible owner requirements, not copied examples or the candidate", () => {
  const before = [
    "# Current owner contract",
    "",
    "> 逐项结果：BORROWED_1、BORROWED_2",
    "",
    "```",
    "逐项结果：EXAMPLE_1、EXAMPLE_2",
    "```",
    "",
    "<div>",
    "逐项结果：HIDDEN_1、HIDDEN_2",
    "</div>",
    "",
    "- 逐项结果：RA-1、SP_19",
    "",
    "为 M1、M2 分别给出结论。",
  ].join("\n");
  assert.deepEqual(declaredDeliveryOutcomes(before), [
    { id: "RA-1", line: 13 }, { id: "SP_19", line: 13 },
    { id: "M1", line: 15 }, { id: "M2", line: 15 },
  ]);
  assert.deepEqual(declaredDeliveryOutcomes(frozenAssertionMaterial["PROJECT.md"]).map(row => row.id), ["E1", "E2", "E3"]);
});

const candidateFile = "modules/eligibility.md";
const goalFile = "PROJECT.md";
const registerFile = "sources/regional-register.md";
const publicFile = "sources/github-checks.md";
const rawRow = (file, line, quote) => ({
  file, start: line, end: line, quote: quote ?? frozenAssertionMaterial[file].split("\n")[line - 1],
});
const rowFor = entity => rawRow(registerFile, 2 + Number(entity[1]));
const plainTag = "大白话：";
const neutral = quote => ({
  kind: "nonfactual", status: "supported", quote, basis: "结构、读者提示或需维护者回答的问题。",
});
const positive = (quote, kind) => ({
  quote, kind, status: "supported", sourceRelation: "supports",
  basis: "按当前授权、此处候选原句及相应来源逐条核对。",
});
const direct = (quote, evidence, assertion = "original-fact") => ({
  ...positive(quote, "direct"), assertion, evidence,
});
const applyRule = (quote, evidence, rule) => ({
  ...positive(quote, "inference"),
  assertion: evidence.length ? "project-application" : "project-rule",
  inference: {
    rule: "project-policy",
    policy: [rule],
    premises: evidence,
    scope: "当前授权交付范围内的登记条目。",
    assumptions: [],
    counterexample: { possible: false, reason: "申请对象和判定取自所引当期总纲和已读原始记录。" },
  },
});

const variants = {
  definite: deliveryVariants.repeatedIdsInNarration,
  missing: deliveryVariants.historicalNoOutcome,
  isolatedMissing: deliveryVariants.isolatedNoOutcome,
  inconsistent: deliveryVariants.summaryMismatch,
  clarification: deliveryVariants.genuineClarification,
};

function coverageParts(block, variant, rule) {
  const { line, text } = block;
  if (line === 1 || text.startsWith("请维护者确认") || text.startsWith("（出处")) return [neutral(text)];
  if (line === 3) return [applyRule(text, [], rule)];
  if (line === 5) {
    return [direct(text, text.includes("completed") ? [rawRow(publicFile, 6), rawRow(publicFile, 7)] : [rawRow(publicFile, 7), rawRow(publicFile, 8)])];
  }
  if ([6, 7, 8].includes(line)) {
    const entity = "E" + (line - 5);
    const marker = text.indexOf("，按") >= 0 ? "，按" : text.indexOf("，属") >= 0 ? "，属" : "，本批";
    const breakAt = text.indexOf(marker);
    if (breakAt < 0) return [applyRule(text, [rowFor(entity), rawRow(registerFile, 2)], rule)];
    const declaration = /^- C\d：E\d：(纳入|排除|待补|待确认)，/u.exec(text)?.[0];
    return [
      ...(declaration ? [applyRule(declaration, [rowFor(entity)], rule)] : []),
      direct(text.slice(declaration?.length ?? 0, breakAt), [rowFor(entity)]),
      applyRule(text.slice(breakAt), [rowFor(entity)], rule),
    ];
  }
  if (line === 10) return [{
    ...positive(text, "direct"),
    objectCheck: { kind: "candidate", check: "citation-count", source: registerFile, expected: 3 },
  }];
  if (line === 12) return [direct(text, [rawRow(registerFile, 2)], "material-identity")];
  if (line === 14) {
    const body = text.startsWith(plainTag) ? text.slice(plainTag.length) : text;
    if (variant === "inconsistent" && body.startsWith("E3")) {
      return [{
        ...applyRule(body, [rowFor("E3")], rule),
        status: "unsupported", sourceRelation: "contradicts",
        finding: { kind: "contradiction", quote: body, fix: "统一为正文已经写明的 E3 待补。" },
      }];
    }
    const entities = ["E1", "E2", "E3"].filter(entity => body.includes(entity));
    const premises = (entities.length ? entities : ["E1", "E2", "E3"]).map(rowFor);
    return [...(body === text ? [] : [neutral(plainTag)]), applyRule(body, premises, rule)];
  }
  throw new Error("Frozen candidate gained an unadjudicated block " + line);
}

const cite = (file, start, end = start) => ({ file, start, end });
const checks = [
  { id: "C1", ...cite(publicFile, 6, 7) },
  { id: "C2", ...cite(registerFile, 3) },
  { id: "C3", ...cite(registerFile, 4) },
  { id: "C4", ...cite(registerFile, 5) },
].map(row => ({ ...row, status: "supported", basis: "核验编号同行的已读原文范围。" }));

function reportFor(variant, draft) {
  const lines = draft.split("\n");
  const location = (line, quote = lines[line - 1]) => ({ line, quote });
  const results = [
    { id: "E1", status: "decided", decision: "纳入", body: location(6, "E1：纳入"), summary: location(14, "E1 纳入"), basis: "登记与规则都明确。" },
    { id: "E2", status: "decided", decision: "排除", body: location(7, "E2：排除"), summary: location(14, "E2 排除"), basis: "登记明确为其他地区。" },
    { id: "E3", status: "decided", decision: "待补", body: location(8, "E3：待补"), summary: location(14, "E3 待补"), basis: "原始登记与当期总纲对应待补分支。" },
  ];
  if (variant === "missing") {
    for (const i of [0, 1, 2]) {
      results[i] = { id: "E" + (i + 1), status: "missing", body: location(6 + i), summary: location(14),
        basis: i === 2 ? "正文复述依据后把实际处置留给规则，摘要也只有条件。" : "旧稿没有逐项明确标示的主体与结论。" };
    }
  }
  if (variant === "isolatedMissing") {
    results[2] = { id: "E3", status: "missing", body: location(8), summary: location(14), basis: "正文与摘要都只有引述和条件，没有给 E3 实际结果。" };
  }
  if (variant === "inconsistent") {
    results[2] = { id: "E3", status: "inconsistent", body: location(8), summary: location(14), basis: "正文给待补，结尾却声称已排除。" };
  }
  if (variant === "clarification") {
    const question = "本批的“空白”是录入标签，还是表示地区字段未填写？";
    results[2] = { id: "E3", status: "clarify", body: location(8, "本批含义尚未定义，E3 待确认。"),
      question, basis: "当前规则把登记符号的含义留给维护者选择。" };
  }
  return results;
}

async function materializeReview(root, variant) {
  installFrozenAssertionFixture(root);
  const draft = variants[variant];
  const goal = variant === "clarification" ? deliveryVariants.clarificationGoal : frozenAssertionMaterial[goalFile];
  fs.writeFileSync(path.join(root, candidateFile), draft);
  fs.writeFileSync(path.join(root, goalFile), goal);
  const goalRef = rawRow(goalFile, 4, goal.split("\n")[3]);
  const h = host(root, { automaticCoverage: false });
  const executor = (await h.flow("root", "advance")).childId;
  await h.flow(executor, "prepare");
  await h.flow(executor, "submit");
  const reviewer = (await h.flow("root", "advance")).childId;
  const prepare = await h.flow(reviewer, "prepare");
  const record = async (id, override = list => list) => {
    const blocks = documentCoverage(Buffer.from(draft)).blocks;
    for (let offset = 0; offset < blocks.length;) {
      const page = await h.coverage(id, "inventory", { offset, count: 8 });
      const entries = override(page.blocks.map(block => ({ block: block.id, parts: coverageParts(block, variant, goalRef) })));
      const result = await h.coverage(id, "record", { entries });
      assert.deepEqual(result.invalid, []);
      offset += page.blocks.length;
    }
  };
  await record(reviewer);
  await h.assess(reviewer, {
    ...Object.fromEntries(Object.keys(QUALITY).map(key => [key, "按当前候选、总纲与已读原始材料逐项核对。"])),
    sourceRefs: [cite(publicFile, 6, 8), cite(registerFile, 2, 5)],
    goalFit: { pass: true, basis: "旧回执只看证据及行号，曾误以为已写清全部处置。" },
    unverifiedSources: [], unlisted: [], revise: [],
  });
  return { h, reviewer, executor, prepare, record, draft, outcomes: reportFor(variant, draft) };
}

test("frozen R80 cannot turn a word mentioned in a condition into E3's disposition", () =>
  fixture(async root => {
    const { h, reviewer, draft, outcomes } = await materializeReview(root, "missing");
    const misleading = {
      ...outcomes[2], status: "decided", decision: "待补",
      body: { line: 8, quote: "列入待补" },
      summary: { line: 14, quote: "算作待补" },
    };
    assert.ok(draft.split("\n")[7].includes(misleading.body.quote));
    assert.ok(draft.split("\n")[13].includes(misleading.summary.quote));
    const result = await h.flow(reviewer, "review", { checks, outcomes: [outcomes[0], outcomes[1], misleading] });
    assert.equal(result.phase, "supplement-ready");
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "records/first.json"), "utf8"));
    assert.equal(receipt.candidateSha256, archivedDeliveryAcceptance.candidateSha256);
    assert.equal(receipt.decision, "reject");
    assert.ok(receipt.outcomeLayout.some(issue => issue.startsWith("E3 ")));
    assert.equal(fs.existsSync(path.join(root, "records/final.json")), false);
  }));

test("an isolated missing E3 result returns to the original executor instead of opening independent acceptance", () =>
  fixture(async root => {
    const { h, reviewer, outcomes } = await materializeReview(root, "isolatedMissing");
    const result = await h.flow(reviewer, "review", { checks, outcomes });
    assert.equal(result.phase, "supplement-ready");
    assert.equal(fs.existsSync(path.join(root, "records/final.json")), false);
    assert.equal((await h.flow("root", "advance")).childId, h.activations[0].childId);
  }));

test("an exact but inconsistent summary cannot count as outcome completion", () =>
  fixture(async root => {
    const { h, reviewer, outcomes } = await materializeReview(root, "inconsistent");
    const misleading = structuredClone(outcomes);
    misleading[2] = { ...misleading[2], status: "decided", decision: "待补",
      body: { line: 8, quote: "E3：待补" }, summary: { line: 14, quote: "E3 排除" } };
    assert.equal((await h.flow(reviewer, "review", { checks, outcomes: misleading })).phase, "supplement-ready");
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "records/first.json"), "utf8"));
    assert.equal(receipt.decision, "reject");
    assert.ok(receipt.outcomeLayout.some(issue => issue.startsWith("E3 ") && issue.includes("大白话")));
    assert.equal(fs.existsSync(path.join(root, "records/final.json")), false);
  }));

test("nested examples and conditional summary mentions cannot supply an operative outcome", () => {
  const contract = { items: [{ id: "ITEM-3" }], summary: true };
  const source = (body, summary) => Buffer.from(`${body}\n\n大白话：${summary}\n`);
  assert.deepEqual(deliveryOutcomeLayoutIssues(contract,
    source("- ITEM-3：待补，登记值未填。", "ITEM-3：待补。")), []);
  const nested = deliveryOutcomeLayoutIssues(contract,
    source("- 举例说明\n  - ITEM-3：待补，登记值未填。", "ITEM-3：待补。"));
  assert.equal(nested.length, 1);
  assert.match(nested[0], /正文/u);
  const conditional = deliveryOutcomeLayoutIssues(contract,
    source("- ITEM-3：待补，登记值未填。", "假设 ITEM-3：待补。"));
  assert.equal(conditional.length, 1);
  assert.match(conditional[0], /大白话/u);
});

test("the exact native layout fails all required outcomes together before author handoff", () =>
  fixture(async root => {
    const frozen = Buffer.from(nativeOutcomeLayoutDraft);
    assert.equal(digest(frozen), nativeOutcomeLayoutSha256);
    const { h, executor, reviewer, prepare } = await materializeReview(root, "isolatedMissing");
    assert.equal((await h.flow(reviewer, "review", { checks })).phase, "supplement-ready",
      "author debt no longer requires retrying the outcome arguments");
    assert.equal((await h.flow("root", "advance")).childId, executor);
    await h.flow(executor, "prepare");
    await h.file(executor, "write", candidateFile, {
      content: nativeOutcomeLayoutDraft,
      note: "隔离复跑真机交付原稿。",
    });
    await h.file(executor, "read", candidateFile);
    assert.equal(digest(fs.readFileSync(path.join(root, candidateFile))), nativeOutcomeLayoutSha256);

    const problems = deliveryOutcomeLayoutIssues(prepare.outcomeContract, frozen);
    assert.deepEqual(problems.map(issue => issue.split(" ")[0]), ["E1", "E2", "E3"]);
    const result = await h.flow(executor, "preflight");
    assert.equal(result.ok, false);
    for (const issue of problems) assert.ok(result.issues.includes(issue));
    await assert.rejects(h.flow(executor, "submit"), error =>
      problems.every(issue => error.message.includes(issue)));
    assert.equal((await h.flow("root", "status")).units[0].phase, "supplement");
    assert.equal(await fs.promises.readFile(path.join(root, candidateFile), "utf8"), nativeOutcomeLayoutDraft);
  }));

test("genuine unresolved owner definition blocks with a specific question and retains the owner goal", () =>
  fixture(async root => {
    const { h, reviewer, outcomes } = await materializeReview(root, "clarification");
    await assert.rejects(h.flow(reviewer, "review", { checks, outcomes: outcomes.map(({ question, ...outcome }) => outcome) }),
      /澄清|question|待确认/u);
    const result = await h.flow(reviewer, "review", { checks, outcomes });
    assert.equal(result.phase, "blocked");
    assert.equal(fs.existsSync(path.join(root, "records/final.json")), false);
    const status = await h.flow("root", "status");
    assert.equal(status.units[0].phase, "blocked");
    const ownerPacket = await h.flow("root", "prepare");
    assert.ok(JSON.stringify(ownerPacket.outcomeClarification).includes(outcomes[2].question),
      "the coordinator receives exactly the question the independent reviewer needs answered");
    assert.equal(digest(fs.readFileSync(path.join(root, goalFile))), digest(Buffer.from(deliveryVariants.clarificationGoal)));
    await assert.rejects(h.flow("root", "advance"), /等待用户澄清|更新总纲/u);

    // The owner resolves the ambiguity in a new revision. No phase or role is
    // changed directly; the native advance action can now start fresh review.
    fs.writeFileSync(path.join(root, goalFile), frozenAssertionMaterial[goalFile]);
    const resumed = await h.flow("root", "advance");
    assert.equal(resumed.childId, reviewer);
    assert.equal(resumed.phase, "final-review");
    assert.equal((await h.flow(reviewer, "prepare")).outcomeContract.goalSha256, archivedDeliveryAcceptance.goalSha256);
  }));

test("correct explicit outcomes need two distinct current role proofs before their receipt reaches the ledger", () =>
  fixture(async root => {
    const { h, reviewer, prepare, record, outcomes, draft } = await materializeReview(root, "definite");
    assert.ok(prepare.outcomeContract, "the working reviewer receives the three owner-defined required dispositions");
    assert.equal((await h.flow(reviewer, "review", { checks, outcomes })).phase, "first-audit-ready");
    const auditor = (await h.flow("root", "advance")).childId;
    assert.notEqual(auditor, reviewer);
    const independent = await h.flow(auditor, "prepare");
    assert.deepEqual(independent.outcomeContract, prepare.outcomeContract);

    await assert.rejects(h.flow(auditor, "audit", { outcomes }), /未核|证明|覆盖/u);
    await record(auditor, entries => entries.map(entry => ({
      ...entry, parts: entry.parts.map(part => part.quote.startsWith("E3 待补")
        ? direct(part.quote, [rowFor("E3")]) : part),
    })));
    await assert.rejects(h.flow(auditor, "audit", { outcomes }), /处置|证明|outcome/u,
      "an independent verifier cannot reuse the other role's typed summary disposition");
    await record(auditor, entries => entries.map(entry => ({
      ...entry, parts: entry.parts.map(part =>
        part.assertion === "original-fact" && part.evidence.some(ref => ref.file === registerFile && ref.start === 5)
          ? { ...part, assertion: undefined } : part),
    })));
    await assert.rejects(h.flow(auditor, "audit", { outcomes }), /原始|original-fact|outcome/u,
      "independent typed E1/E2 and public source facts cannot discharge E3's original record requirement");
    await record(auditor);
    assert.equal((await h.flow(auditor, "audit", { outcomes })).phase, "ledger-review");

    const receipt = JSON.parse(fs.readFileSync(path.join(root, "records/first.json"), "utf8"));
    assert.equal(receipt.decision, "accept");
    assert.equal(receipt.candidateSha256, digest(Buffer.from(draft)));
    assert.notEqual(receipt.reviewer, receipt.independentAudit.auditor);
    assert.equal(receipt.deliveryOutcomes.actor, receipt.reviewer);
    assert.equal(receipt.independentAudit.deliveryOutcomes.actor, receipt.independentAudit.auditor);
    for (const result of [receipt.deliveryOutcomes, receipt.independentAudit.deliveryOutcomes]) {
      assert.deepEqual(result.items.map(row => [row.id, row.decision]),
        [["E1", "纳入"], ["E2", "排除"], ["E3", "待补"]]);
      assert.ok(result.items.every(row => row.bodyProof && row.originalProof && row.summaryProof));
    }
    const snapshot = fs.readdirSync(path.join(process.env.DSH_HOME, "building-loop-state"))
      .find(file => /^[a-f0-9]{64}\.json$/u.test(file));
    const state = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, "building-loop-state", snapshot), "utf8"));
    const archived = state.units.K01.proof;
    const candidate = Buffer.from(draft);
    const proof = archived.reviewerCoverage;
    const originalOutcome = outcomes[2];
    const submission = item => [...outcomes.slice(0, 2), item];
    assert.throws(() => reviewDeliveryOutcomes(prepare.outcomeContract,
      Buffer.from(deliveryVariants.conflictingSecondBodyOutcome), proof, reviewer,
      submission({ ...originalOutcome, summary: { ...originalOutcome.summary, line: 15 } })), /唯一|处置/u,
    "another visible body declaration cannot be ignored by selecting the favorable line");
    const conditional = draft.replace("E3：待补，", "E3：可能待补，").replace("E3 待补，", "E3 可能待补，");
    assert.throws(() => reviewDeliveryOutcomes(prepare.outcomeContract, Buffer.from(conditional), proof, reviewer,
      submission({ ...originalOutcome, decision: "可能待补", body: { line: 8, quote: "E3：可能待补" },
        summary: { line: 14, quote: "E3 可能待补" } })), /明确处置/u,
    "an uncertainty label is not itself a current disposition");
    const incorrectlyQuoted = {
      ...originalOutcome, summary: { line: 14, quote: "E3 待补。" },
    };
    assert.throws(() => reviewDeliveryOutcomes(prepare.outcomeContract, candidate, proof, reviewer,
      submission(incorrectlyQuoted)), /逐字|唯一定位/u, "the exact summary entry must exist in the actual candidate");
    const stale = structuredClone(receipt);
    stale.independentAudit.deliveryOutcomes.items[2].bodyProof = "f".repeat(64);
    assert.throws(() => requireAcceptedDeliveryOutcomes(prepare.outcomeContract, candidate, stale, archived), /逐项|变化/u);
    const borrowed = structuredClone(receipt);
    borrowed.independentAudit.deliveryOutcomes.actor = borrowed.reviewer;
    assert.throws(() => requireAcceptedDeliveryOutcomes(prepare.outcomeContract, candidate, borrowed, archived), /两位|独立/u);
    await h.flow("root", "prepare");
    const book = await h.ledger("root", "read");
    const decisions = book.items.map(item => item.unit
      ? { id: item.id, outcome: "completed", basis: "本任务逐项结果和已记录的两份独立回执已经核实。",
          evidence: { file: "records/first.json", start: 1, end: 5 } }
      : { id: item.id, outcome: "keep", basis: "其他任务仍按账本计划继续。" });
    assert.equal((await h.ledger("root", "review", { decisions })).phase, "closed");
  }));
