import assert from "node:assert/strict";
import test from "node:test";

import {
  classificationDisagreements,
  coverageAction,
  coverageSummary,
  documentCoverage,
  recordMeetsDispute,
} from "../governance/coverage.mjs";
import { goalSnapshot } from "../governance/goals.mjs";
import { authority, digest } from "../governance/policy.mjs";
import {
  frozenAssertionCases,
  frozenAssertionMaterial,
  frozenAssertionProvenance,
  frozenAssertionReference,
  frozenAssertionRoles,
  installFrozenAssertionFixture,
} from "./fixtures/assertion-reconciliation.mjs";
import { fixture } from "./helpers.mjs";

test("frozen terminal candidate retains each original assertion and reconciles the proven mixed span", () => {
  const original = Buffer.from(frozenAssertionMaterial["modules/eligibility.md"]);
  assert.equal(digest(original), frozenAssertionProvenance.candidateSha256);

  const { reviewer, auditor } = frozenAssertionRoles();
  const manifest = documentCoverage(original);
  for (const testCase of frozenAssertionCases) {
    const block = manifest.blocks.find(row => row.id === testCase.block);
    assert.ok(block, testCase.block);
    const labelled = (testCase.prefix ?? "") + testCase.atoms.map(atom => atom.quote).join("");
    assert.equal(block.text, labelled, testCase.block);

    for (const role of [reviewer, auditor]) {
      const saved = role.records.find(row => row.block === testCase.block);
      assert.equal(saved.text, block.text);
      assert.equal(saved.lineText, block.lineText);
      assert.equal(saved.line, block.line);
      for (const part of saved.parts) assert.equal(part.quote, block.text.slice(part.start, part.end));
    }
  }

  const disagreement = classificationDisagreements(reviewer, auditor);
  assert.deepEqual(disagreement.map(row => row.block),
    frozenAssertionCases.filter(row => !row.block.startsWith("B13-")).map(row => row.block));
});

function reviewEnvironment(workspace, archivedRole, role) {
  const policy = authority(workspace);
  assert.equal(policy.hash, frozenAssertionProvenance.policySha256);
  const spec = policy.units.K01;
  const phase = "final-review";
  const frame = {
    root: workspace,
    agent: { id: role },
    role,
    policy,
    reads: [...spec.phases[phase].read, ...policy.goalContext],
  };
  const active = { phase, goal: goalSnapshot(frame), seen: structuredClone(archivedRole.seen) };
  assert.equal(active.goal.sha256, frozenAssertionProvenance.goal.sha256);
  const invoke = (action, args = {}) => coverageAction(frame, active, spec, { action, ...args });
  for (let offset = 0, more = true; more;) {
    const page = invoke("inventory", { offset });
    more = page.next !== undefined;
    offset = page.next?.offset;
  }
  const summary = () => ({ ...coverageSummary(frame, active, spec, false), goalSha256: active.goal.sha256 });
  return { frame, active, invoke, summary };
}

const neutral = quote => ({
  kind: "nonfactual", status: "supported", quote, basis: "此处是展示标签、定位或排版边界。",
});

function evidencePart(atom) {
  const { quote, assertion, references = [], policy = [], navigationHeading, manuscriptLines } = atom;
  if (navigationHeading) {
    assert.equal(frozenAssertionMaterial["modules/eligibility.md"].split("\n")[navigationHeading.line - 1],
      navigationHeading.text);
    return neutral(quote);
  }
  const base = { quote, assertion, status: "supported", sourceRelation: "supports",
    basis: "逐项核对当前候选断言及其独立引用的原始材料或总纲。" };
  const refs = references.map(frozenAssertionReference);
  if (assertion === "project-rule" || assertion === "project-application") {
    return {
      ...base, kind: "inference",
      inference: {
        rule: "project-policy", policy: policy.map(frozenAssertionReference), premises: refs,
        scope: "当前 G2 的规则与该句明确涉及的记录。",
        assumptions: [],
        counterexample: { possible: false, reason: "该断言只用所引规则与明确的项目材料。" },
      },
    };
  }
  const manuscript = manuscriptLines ? { start: manuscriptLines[0], end: manuscriptLines[1] } : undefined;
  return { ...base, kind: "direct", evidence: refs, ...(manuscript ? { manuscript } : {}) };
}

const exactParts = testCase => [
  ...(testCase.prefix ? [neutral(testCase.prefix)] : []),
  ...testCase.atoms.map(evidencePart),
];

function addToReview(reviewer, block, parts) {
  const result = reviewer.invoke("record", { entries: [{ block, parts }] });
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.recorded, [block]);
}

test("typed review preserves independent source/policy obligations under different valid span boundaries", () =>
  fixture(async workspace => {
    installFrozenAssertionFixture(workspace);
    const archived = frozenAssertionRoles();
    const reviewer = reviewEnvironment(workspace, archived.reviewer, "reviewer");
    const auditor = reviewEnvironment(workspace, archived.auditor, "auditor");
    const applies = frozenAssertionCases.find(row => row.block.startsWith("B13-"));
    const sameIdentity = frozenAssertionCases.find(row => row.block.startsWith("B33-"));
    for (const testCase of [applies, sameIdentity]) addToReview(reviewer, testCase.block, exactParts(testCase));

    // Put separator and punctuation into adjacent parts without moving evidence.
    const auditorParts = exactParts(applies);
    auditorParts[0].quote = auditorParts[0].quote.slice(0, -1);
    auditorParts[1].quote = "，" + auditorParts[1].quote.slice(0, -1);
    auditorParts[2].quote = "，" + auditorParts[2].quote;
    addToReview(auditor, applies.block, auditorParts);
    addToReview(auditor, sameIdentity.block, exactParts(sameIdentity));
    assert.deepEqual(classificationDisagreements(reviewer.summary(), auditor.summary()), []);

    // The old broad policy record can be aligned to legacy's narrower raw +
    // policy reading. An explicit new policy claim about the larger fragment
    // is a stronger obligation, so the adjacent legacy application cannot settle it.
    const broadExplicit = exactParts(applies);
    broadExplicit[2].quote = broadExplicit[1].quote + broadExplicit[2].quote;
    broadExplicit.splice(1, 1);
    const narrowerLegacy = exactParts(applies);
    for (const part of narrowerLegacy) delete part.assertion;
    addToReview(reviewer, applies.block, broadExplicit);
    addToReview(auditor, applies.block, narrowerLegacy);
    const [explicitConflict] = classificationDisagreements(reviewer.summary(), auditor.summary());
    assert.equal(explicitConflict.block, applies.block);
    assert.ok(explicitConflict.requiredAssertions.some(item =>
      item.kind === "project-application" && item.quote.includes("属华北")));
    addToReview(reviewer, applies.block, exactParts(applies));

    const missingPolicy = structuredClone(auditorParts);
    missingPolicy[2].inference.policy = [];
    assert.throws(() => auditor.invoke("record", { entries: [{ block: applies.block, parts: missingPolicy }] }), /policy|总纲/u);
    assert.ok(auditor.summary().pending.includes(applies.block));

    const missingRecord = exactParts(applies);
    missingRecord[2].inference.premises = [];
    assert.throws(() => auditor.invoke("record", { entries: [{ block: applies.block, parts: missingRecord }] }), /原始|处置/u);
    assert.ok(auditor.summary().pending.includes(applies.block));
  }));

test("the archived scope and source cases compare individual proofs and preserve both missing policy objections", () =>
  fixture(async workspace => {
    installFrozenAssertionFixture(workspace);
    const archived = frozenAssertionRoles();
    const reviewer = reviewEnvironment(workspace, archived.reviewer, "reviewer");
    const auditor = reviewEnvironment(workspace, archived.auditor, "auditor");
    const manuscript = frozenAssertionCases.find(row => row.block.startsWith("B11-"));
    const publicSource = frozenAssertionCases.find(row => row.block.startsWith("B24-"));
    const twoSources = frozenAssertionCases.find(row => row.block.startsWith("B28-"));
    for (const testCase of frozenAssertionCases) {
      addToReview(reviewer, testCase.block, exactParts(testCase));
      addToReview(auditor, testCase.block, exactParts(testCase));
    }
    assert.deepEqual(classificationDisagreements(reviewer.summary(), auditor.summary()), []);

    // The two real omissions were raw source arguments for a project decision.
    // Preserve the original rule and data in the first record. Have the
    // independent auditor submit its actual earlier proof on that same atom.
    const unprovenScope = exactParts(publicSource);
    unprovenScope[2] = evidencePart({
      ...publicSource.atoms[2], assertion: "original-fact", references: ["demo-3-5"],
    });
    const differentSources = exactParts(twoSources);
    differentSources[3] = evidencePart({
      ...twoSources.atoms[3], assertion: "original-fact", references: ["demo-3-5", "public-7-8"],
    });
    addToReview(auditor, publicSource.block, unprovenScope);
    addToReview(auditor, twoSources.block, differentSources);
    const missing = classificationDisagreements(reviewer.summary(), auditor.summary());
    assert.deepEqual(missing.map(row => row.block), [publicSource.block, twoSources.block]);
    assert.ok(missing.every(row => row.objectSpans.length > 0));
    const deficient = auditor.summary().records.find(row => row.block === publicSource.block);
    assert.equal(recordMeetsDispute(deficient, missing[0]), false,
      "repeating the raw-only proof cannot satisfy a known project application obligation");
    const recovery = reviewEnvironment(workspace, archived.reviewer, "recheck");
    recovery.active.reconciliation = missing;
    assert.throws(() => recovery.invoke("record", { entries: [{ block: publicSource.block, parts: unprovenScope }] }),
      /须逐条补证|争议尚未/u, "one role cannot silently drop the same authority the other role omitted");
    addToReview(recovery, publicSource.block, exactParts(publicSource));

    // Pinned and quoted, but from the wrong current goal line.
    const wrongPolicy = exactParts(twoSources);
    wrongPolicy[3].inference.policy = [frozenAssertionReference("policy-4-4")];
    addToReview(auditor, twoSources.block, wrongPolicy);
    const wrongPolicyConflict = classificationDisagreements(reviewer.summary(), auditor.summary())
      .find(row => row.block === twoSources.block);
    assert.equal(wrongPolicyConflict.recheckEvidence, true, "same type using different current rules must be independently rechecked");

    // One valid premise is insufficient for the claim that depends on two.
    const partialApplication = exactParts(publicSource);
    partialApplication[2].inference.premises = [frozenAssertionReference("demo-3-5")];
    addToReview(auditor, publicSource.block, partialApplication);
    const partialApplicationConflict = classificationDisagreements(reviewer.summary(), auditor.summary())
      .find(row => row.block === publicSource.block);
    assert.equal(partialApplicationConflict.recheckEvidence, true, "shared classification cannot hide a disputed premise set");

    // Matching authorized material type alone cannot establish provenance of
    // the wrong file. And broad row ranges cannot borrow a different E value.
    const wrongMaterial = exactParts(twoSources);
    wrongMaterial[1].evidence = [frozenAssertionReference("public-6-6")];
    addToReview(auditor, twoSources.block, wrongMaterial);
    const objections = classificationDisagreements(reviewer.summary(), auditor.summary());
    assert.ok(objections.find(row => row.block === twoSources.block).requiredAssertions
      .some(row => row.kind === "material-identity" && row.quote.includes("前者是演练登记")));
    const plain = frozenAssertionCases.find(row => row.block.startsWith("B30-"));
    const wrongQuotedValue = exactParts(plain);
    wrongQuotedValue[2].evidence = [frozenAssertionReference("demo-3-5")];
    addToReview(auditor, plain.block, wrongQuotedValue);
    assert.ok(classificationDisagreements(reviewer.summary(), auditor.summary()).find(row => row.block === plain.block)
      .requiredAssertions.some(row => row.kind === "original-fact" && row.quote.includes("E1")));

    const unbounded = exactParts(manuscript);
    unbounded[0].manuscript = { start: 9, end: 17 };
    assert.throws(() => auditor.invoke("record", { entries: [{ block: manuscript.block, parts: unbounded }] }),
      /本节完整编号行范围/u);
    const missingScope = exactParts(manuscript);
    delete missingScope[0].manuscript;
    assert.throws(() => auditor.invoke("record", { entries: [{ block: manuscript.block, parts: missingScope }] }),
      /稿件|来源归属/u);
  }));
