import { requireCodeRegressionCurrent } from "./code-intake.mjs";
import { architectureProseInventory, checkArchitectureProseReceipt, PROSE_REVIEW_STATUSES } from "./architecture-prose-coverage.mjs";
import { hasConditionalContext, isGroundedRuntimeProof } from "./code-review-probes.mjs";
import { expectedClaims } from "./evidence.mjs";
import { markdownStructure } from "./markdown-structure.mjs";
import { digest, includes, isImplementationPath, keyOf, readBytes, relativeName } from "./policy.mjs";
import { lineList } from "./preflight.mjs";
import { architectureImportsSection } from "./project-hierarchy.mjs";
import { parser as pythonParser } from "./vendor/python-parser.cjs";
import { pythonImportEvidence } from "./python-dependencies.mjs";

export const CODE_COMMENT_RULE = "必要注释写在非显然的职责、调用方向、跨模块状态、权限、数据保护、回滚或重试边界旁，交代原因与成立条件。改动使旧说明失实时同步更新。核验对照实际控制流和测试证据。";
export const CODE_REVIEW_REJECTION_RULE = "行为退回须使用当前角色的 runtime 复现，且 outcome=mismatch、blocking=true。逐字引用完整句子中明确规定的输出字段和值，或使用绑定该条款的已登记示例。字段只在实际结果出现、当前条款不能确定预期，或仅建议优化时写 observations。退回中的实测预期和结果由宿主填入。必测 revise 要关联同一 caseId 和条款的已证实发现。";
export const CODE_REVIEW_PROBE_RULE = "已签名的通过用例无需逐个重复运行。有具体可疑差异再用探针；已登记的必跑架构示例仍须核验。";
const BASELINE_LINES = 16000;
const RANGE_LIMIT = 48;
const MAX_FINDINGS = 24;
const PLAN_PAGE_BYTES = 16 * 1024;
const PROOF_BYTES = 96 * 1024;
const RECORD_LIMIT = 32;
const COMPACT_REF_LIMIT = 6;
const COMPACT_FIELDS = ["id", "basis", "status", "refs", "obligation"];
const KEYS = ["files", "constraints", "findings", "observations", "architecture"];
const RECORD_KEYS = [...KEYS, "decisions", "removeFindings", "removeObservations", "findingsDone", "proseCoverage", "proseFactReview"];
const FINDING_KINDS = ["behavior", "maintenance", "annotation", "architecture"];
const VIOLATION_TYPES = ["requirement", "regression", "annotation", "architecture", "maintainability", "runtime", "syntax"];
const TYPES_BY_KIND = {
  behavior: ["requirement", "regression", "runtime", "syntax"], maintenance: ["maintainability"],
  annotation: ["annotation"], architecture: ["architecture"],
};
const COMMENT_OBLIGATIONS = ["invariant", "interface", "state", "permission", "data-protection", "rollback", "retry"];
const EVIDENCE_RELATIONS = ["supports", "contradicts", "reproduces"];
const FINDING_ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/u;

// Test sources are reviewable even though they cannot qualify as implementation.
const sourceArtifact = file => isImplementationPath("reviewed" + file.slice(file.lastIndexOf(".")));
const locator = {
  type: "object", properties: {
    file: { type: "string" }, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 },
  }, required: ["file", "start", "end"], additionalProperties: false,
};
const brief = { type: "string", minLength: 1, maxLength: 400 };
const COMMENT_QUOTE_RULE = "status=verified 用 start–end 指向当前已读注释，宿主从源码提取原文。通常省略 quote。若填写须逐字一致，missing 和 not-needed 省略 quote。";
const comment = {
  ...locator, properties: { start: locator.properties.start, end: locator.properties.end,
    status: { enum: ["verified", "missing", "not-needed"], description: COMMENT_QUOTE_RULE },
    basis: brief, quote: { ...brief, description: COMMENT_QUOTE_RULE }, obligation: { enum: COMMENT_OBLIGATIONS } },
  required: ["start", "end", "status", "basis"],
};
const rows = (maxItems, properties, required = Object.keys(properties)) => ({
  type: "array", maxItems, items: { type: "object", properties, required, additionalProperties: false },
});
const judgment = { enum: ["pass", "revise"] };
const findingId = { type: "string", pattern: FINDING_ID.source };
const evidenceLocation = { ...locator, properties: { ...locator.properties,
  relation: { enum: EVIDENCE_RELATIONS, description: "相对于该发现或观察的关系：支持、反证或复现。" },
  quote: { ...brief, description: "可省略。填写时逐字定位到该范围。" },
}, required: [...locator.required, "relation"] };
const architectureSections = rows(12, { heading: { type: "string" }, basis: brief,
  evidence: { type: "array", minItems: 1, maxItems: 4, items: evidenceLocation } });
const architecture = { type: "object", properties: { status: judgment, basis: brief, source: locator, sections: architectureSections },
  additionalProperties: false };
const compactRef = { anyOf: [{ type: "string", pattern: "^[SG][1-9][0-9]*:[1-9][0-9]*(?:-[1-9][0-9]*)?$" }, locator] };
const compactDecisions = rows(RECORD_LIMIT, {
  id: { type: "string", pattern: "^(?:file|test|section):[1-9][0-9]*$" }, basis: brief,
  status: { enum: ["pass", "revise", "verified", "missing", "not-needed"] },
  refs: { type: "array", maxItems: COMPACT_REF_LIMIT, items: compactRef }, obligation: { enum: COMMENT_OBLIGATIONS },
}, ["id", "basis", "status"]);
const proseId = { type: "string", pattern: "^p-[0-9a-f]{18}-[1-9][0-9]*$" };
const proseFactId = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$" };
const proseCoverage = rows(RECORD_LIMIT, {
  id: proseId, status: { enum: PROSE_REVIEW_STATUSES }, basis: brief,
  facts: { type: "array", maxItems: 8, items: proseFactId },
  line: locator.properties.start, refs: { type: "array", maxItems: COMPACT_REF_LIMIT, items: compactRef },
}, ["id", "status"]);
const proseFactReview = rows(RECORD_LIMIT, {
  section: { type: "string", pattern: "^s[1-9][0-9]*$" }, id: proseFactId,
  blocks: { type: "array", maxItems: 128, items: proseId },
});
const reasonEvidence = { type: "array", minItems: 1, maxItems: 4, items: evidenceLocation };
export const codeReviewProbeRequirement = { ...locator, properties: { ...locator.properties,
  quote: { ...brief, description: "支持预期的当前目标原文，逐字引用。" },
}, required: [...locator.required, "quote"], description: "绑定 runtime 探针的当前规格条款，必填原文；无条款的探针仅探索。" };
const violation = { type: "object", properties: {
  type: { enum: VIOLATION_TYPES },
  expected: { ...brief, description: "必须满足的行为、规则或安全不变量。" },
  actual: { ...brief, description: "与该要求有实际差异的当前实现或实测结果。" },
  requirement: { ...locator, description: "行为退回填 runtime probe 已绑定的相同条款位置。其他明确需求也可填实际条款。" },
  reproduction: { type: "string", minLength: 1, maxLength: 128, description: "运行行为或语法退回填本角色当前版本的受信失败复现编号。" },
  obligation: { enum: COMMENT_OBLIGATIONS, description: "annotation 退回须指出实际涉及的必要注释规则。" },
}, required: ["type", "expected", "actual"], additionalProperties: false };
export const codeReviewSchema = {
  type: "object", properties: {
    decisions: compactDecisions,
    files: rows(256, { file: locator.properties.file, basis: brief, comment, comments: { type: "array", maxItems: 6, items: comment } }, ["file", "basis"]),
    constraints: rows(80, { caseId: { type: "string" }, requirement: locator, code: locator, basis: brief, status: judgment }),
    findings: rows(MAX_FINDINGS, { ...locator.properties, id: findingId, kind: { enum: FINDING_KINDS },
      observation: brief, issue: brief, fix: brief, caseId: { type: "string", description: "可选，引用当前签名回归中的具体用例。" },
      evidence: reasonEvidence, violation,
    }, ["file", "start", "end", "kind", "observation", "issue", "fix", "evidence", "violation"]),
    observations: rows(MAX_FINDINGS, { ...locator.properties, id: findingId, kind: { enum: FINDING_KINDS },
      observation: brief, suggestion: brief, evidence: reasonEvidence,
    }, ["file", "start", "end", "kind", "observation", "evidence"]),
    architecture,
    proseCoverage,
    proseFactReview,
    removeFindings: { type: "array", maxItems: MAX_FINDINGS, items: findingId },
    removeObservations: { type: "array", maxItems: MAX_FINDINGS, items: findingId },
    findingsDone: { type: "boolean", description: "已记录所有发现，或核验后无发现时填 true。单独提交即可。" },
  }, additionalProperties: false,
};

/** Only opt into changed-source review when both independent grants can read
 * the editable artifacts. Existing text work keeps its proof and repair gates.
 */
export function isCodeReviewUnit(frame, active, spec) {
  if (!active?.codeIntake?.regression || active.codeReviewRoute === "text" ||
    !spec?.codeTask?.tests?.regression || !isImplementationPath(spec.candidate) ||
    spec.plainLast || spec.claims.length || Object.keys(spec.calculations).length || spec.requireSourcePins ||
    Object.keys(frame.policy.sourcePins ?? {}).length || frame.policy.requiredLinesGoal ||
    ["first-review", "final-review"].some(phase => spec.phases[phase].evidence.length)) return false;
  // Older versions could submit signed code only through the text workflow.
  // A qualification without the explicit new route carries that original debt.
  if ((!active.codeReviewRoute && active.codeIntake.qualification) ||
    (active.pendingReceipt && !active.pendingReceipt.codeReview)) return false;
  const reviewCanRead = file => ["first-review", "final-review"].every(phase => includes(spec.phases[phase].read, file));
  const editable = [...spec.phases.intake.write, ...spec.phases.supplement.write];
  if (editable.some(file => !sourceArtifact(file) || !reviewCanRead(file))) return false;
  const candidate = readBytes(frame.root, spec.candidate);
  if (candidate) {
    const lines = lineList(candidate);
    if (expectedClaims(spec, lines).length || lines.some(line => /\[(?:稿件自述|摘录范围)\]/u.test(line))) return false;
  }
  return active.codeIntake.regression.artifacts.every(({ path, sha256 }) => {
    if (sourceArtifact(path) && reviewCanRead(path)) return true;
    const bytes = readBytes(frame.root, path);
    return (bytes === null ? null : digest(bytes)) === sha256;
  });
}

const lineHashes = bytes => lineList(bytes).map(line => digest(line));

/** Keep bounded line fingerprints for real diffs, without duplicating source
 * text in host state or exposing a previous version to a new actor.
 */
export function captureCodeReviewBaseline(frame, active, spec) {
  if (!isCodeReviewUnit(frame, active, spec)) return;
  let remaining = BASELINE_LINES - Object.values(frame.state.units).reduce((total, unit) =>
    total + (unit.codeReviewBaseline ?? []).reduce((n, row) => n + row.lines.length, 0), 0);
  const result = [];
  for (const { path, sha256 } of active.codeIntake.regression.artifacts) {
    if (sha256 === null || !sourceArtifact(path) || remaining <= 0) continue;
    const bytes = readBytes(frame.root, path);
    if (!bytes || digest(bytes) !== sha256) throw new Error("捕捉代码审查基线时文件已变化：" + path);
    const lines = lineHashes(bytes);
    if (lines.length > remaining) continue;
    result.push({ path, lines });
    remaining -= lines.length;
  }
  return result;
}

function uniquePositions(lines, start, end) {
  const positions = new Map();
  for (let i = start; i < end; i++) positions.set(lines[i], positions.has(lines[i]) ? -1 : i);
  return positions;
}

/** Common ends and unique in-order anchors give conservative changed ranges.
 * Ambiguous alignment expands a range. Deletions retain a current line anchor.
 */
function changedRanges(before, current) {
  let head = 0, oldEnd = before.length, newEnd = current.length;
  while (head < oldEnd && head < newEnd && before[head] === current[head]) head++;
  while (head < oldEnd && head < newEnd && before[oldEnd - 1] === current[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const oldPositions = uniquePositions(before, head, oldEnd);
  const newPositions = uniquePositions(current, head, newEnd);
  const ranges = [];
  let oldStart = head, newStart = head;
  const gap = (oldNext, newNext) => {
    if (oldNext === oldStart && newNext === newStart) return;
    const start = Math.min(newStart + 1, current.length);
    const end = Math.max(start, newNext);
    const previous = ranges.at(-1);
    if (previous && (start <= previous.end + 1 || ranges.length >= RANGE_LIMIT)) {
      previous.end = end;
      previous.removed += oldNext - oldStart;
    } else ranges.push({ start, end, removed: oldNext - oldStart });
  };
  for (let i = head; i < newEnd; i++) {
    const old = oldPositions.get(current[i]);
    if (newPositions.get(current[i]) !== i || old === undefined || old < oldStart) continue;
    gap(old, i);
    oldStart = old + 1;
    newStart = i + 1;
  }
  gap(oldEnd, newEnd);
  // Line-ending-only edits still need a current-file check and verified bytes.
  return ranges.length ? ranges : [{ start: 1, end: 1, removed: 0 }];
}

function proofBinding(regression, goal, architecture) {
  return digest(JSON.stringify([goal.sha256, regression.suiteSha256, regression.artifactsSha256,
    regression.receiptSha256, regression.baselineReceiptSha256,
    ...(regression.architectureResponsibilities ? [digest(JSON.stringify(regression.architectureResponsibilities))] : []),
    ...(architecture ? [[architecture.file, architecture.sha256, architecture.headings,
      ...(architecture.examples ? [architecture.examples] : [])]] : [])]));
}

function reviewArchitecture(frame, active, requireReadGrant) {
  const architecture = active.engineeringArchitecture;
  if (!architecture) return;
  if (requireReadGrant && !includes(frame.reads, architecture.file)) throw new Error("当前角色没有架构稿精确读授权");
  const bytes = readBytes(frame.root, architecture.file);
  if (!bytes || digest(bytes) !== architecture.sha256) throw new Error("架构稿在派审后已变化，请总控重新核验当前稿");
  return architecture;
}

export function codeReviewBinding(frame, active, signed) {
  return proofBinding(signed, active.goal, reviewArchitecture(frame, active, true));
}

function proseReviewInventory(frame, spec, architecture, signed) {
  if (!spec.architecture?.proseReview) return;
  if (!architecture || !signed.architectureResponsibilities?.rows?.length) {
    throw new Error("逐段架构核验须绑定当前架构稿和已验证关键职责");
  }
  const bytes = readBytes(frame.root, architecture.file);
  if (!bytes || digest(bytes) !== architecture.sha256) throw new Error("逐段核验须读取当前已登记的架构稿");
  return architectureProseInventory({ source: bytes.toString("utf8"), sections: architecture.sections,
    facts: signed.architectureResponsibilities.rows,
    protectedHeadings: [spec.architecture.responsibilitiesHeading, spec.architecture.importsHeading].filter(Boolean) });
}

function plan(frame, active, spec, regression) {
  const before = new Map(active.codeIntake.regression.artifacts.map(row => [keyOf(row.path), row.sha256]));
  const baselines = new Map((active.codeReviewBaseline ?? []).map(row => [keyOf(row.path), row.lines]));
  const changes = [];
  const artifacts = active.codeIntake.qualification.artifacts;
  for (const { path, sha256 } of artifacts) {
    const baselineSha256 = before.get(keyOf(path));
    if (baselineSha256 === sha256) continue;
    if (!includes(frame.reads, path)) throw new Error("审查阶段缺少变更工件读授权，请由维护者核对授权");
    const bytes = readBytes(frame.root, path);
    if (!bytes || digest(bytes) !== sha256) throw new Error("已变更源码缺失或版本变化，须复核交付：" + path);
    const saved = baselines.get(keyOf(path));
    const lines = lineList(bytes);
    const ranges = saved ? changedRanges(saved, lineHashes(bytes)) : [{ start: 1, end: lines.length, removed: null }];
    changes.push({ path, baselineSha256, sha256, lines: lines.length, ranges,
      scope: saved ? "changed-lines" : baselineSha256 === null ? "new-file" : "whole-file-no-baseline-lines" });
  }
  const architecture = reviewArchitecture(frame, active, true);
  const proseReview = proseReviewInventory(frame, spec, architecture, regression);
  if (signedLocalImportBoundary(frame, spec, active.codeIntake.qualification)) {
    throw new Error("签名源码违反维护者登记的静态导入边界，须由执行方修复");
  }
  if (spec.architecture?.importsHeading && !inspectArchitectureImports(frame, spec, active).match) {
    throw new Error("架构稿中的静态依赖章节与当前签名源码不一致，须由总控同步");
  }
  return { binding: proofBinding(regression, active.goal, architecture), changes, artifacts, architecture, proseReview,
    ...(regression.architectureResponsibilities ? { responsibilities: regression.architectureResponsibilities.rows } : {}),
    requiredCases: active.codeIntake.qualification.requiredCases, signedCases: active.codeIntake.qualification.cases };
}

/** Packet assembly still verifies each digest and records only bytes it
 * actually displays. A large unchanged source stays available by explicit read. */
export function codeReviewReadPaths(frame, id, active, spec) {
  const signed = requireCodeRegressionCurrent(frame, id, active, spec, active.goal);
  const { changes, artifacts, responsibilities } = plan(frame, active, spec, signed);
  const changed = new Set(changes.map(row => keyOf(row.path)));
  const paths = changes.map(row => ({ file: row.path, ...(row.lines > 250 ? { ranges: row.ranges } : {}) }));
  for (const { path, sha256 } of artifacts) {
    if (!sha256 || changed.has(keyOf(path)) || !sourceArtifact(path) || !includes(frame.reads, path)) continue;
    const bytes = readBytes(frame.root, path);
    if (bytes && digest(bytes) === sha256 && bytes.length <= 24 * 1024 && lineList(bytes).length <= 250) paths.push({ file: path });
  }
  // A pinned line may be unchanged and lie in a large module. Read only that
  // location in addition to the ordinary changed ranges; never copy a verdict.
  for (const { actual } of responsibilities ?? []) {
    const lines = [...new Set([actual.conditionLine, actual.line, actual.callLine, actual.outputLine].filter(Number.isSafeInteger))];
    const existing = paths.find(row => row.file === actual.file);
    const ranges = lines.map(line => ({ start: line, end: line }));
    if (!existing) paths.push({ file: actual.file, ranges });
    else if (existing.ranges) existing.ranges = [...existing.ranges, ...ranges];
  }
  return paths;
}

/** The explicitly opted-in section is a generated inventory, not a model's
 * statement about Python runtime imports. Use only registered local sources. */
export function inspectArchitectureImports(frame, spec, active) {
  const heading = spec.architecture?.importsHeading;
  if (!heading) return;
  const paths = spec.codeTask.sources;
  const qualification = active?.codeIntake?.qualification;
  const signed = new Map(qualification?.artifacts.map(row => [keyOf(row.path), row.sha256]));
  const artifacts = paths.map(file => {
    if (!/\.py$/iu.test(file)) throw new Error("静态依赖图只支持已登记的 Python 源码");
    const bytes = readBytes(frame.root, file);
    const sha256 = bytes && digest(bytes);
    if (!sha256 || qualification && signed.get(keyOf(file)) !== sha256) {
      throw new Error("静态依赖图的实际源码或当前签名工件不符：" + file);
    }
    return { path: file, sha256 };
  });
  const graph = pythonImportEvidence({ root: frame.root, reads: paths }, artifacts, { responsibilities: true });
  if (graph.truncated || graph.unparsedFiles.length || graph.ambiguous.length || graph.checkedFiles.length !== paths.length) {
    throw new Error("无法完整生成已登记 Python 源码的静态依赖图，请核对语法、歧义和文件范围");
  }
  const dependencies = new Map(paths.map(file => [file, new Set()]));
  for (const edge of graph.edges) for (const name of edge.imports) dependencies.get(edge.file).add(name);
  const rows = [...dependencies].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([file, imports]) => `${JSON.stringify(file)} -> ${[...imports].sort().map(name => JSON.stringify(name)).join(", ") || "[]"}`);
  // Select a Markdown fence wider than any run of backticks in a valid path.
  const width = Math.max(2, ...rows.flatMap(row => [...row.matchAll(/`+/gu)].map(match => match[0].length))) + 1;
  const fence = "`".repeat(width);
  const expected = [fence + "text", ...rows, fence].join("\n");
  const { source, sha256, bodyStart, bodyEnd } = architectureImportsSection(frame, spec);
  const eol = /\r\n|\n|\r/u.exec(source)?.[0] ?? "\n";
  const current = source.slice(bodyStart, bodyEnd).trim().replace(/\r\n?/gu, "\n");
  const match = current === expected;
  const proposed = match ? source : source.slice(0, bodyStart) + eol + eol + expected.replaceAll("\n", eol) +
    (bodyEnd < source.length ? eol + eol : eol) + source.slice(bodyEnd);
  return { heading, expected, current, match, proposed, bodyStart, bodyEnd, sha256, graph };
}

/** Check only owner's explicit restrictions, against the candidate bytes
 * already pinned by its regression receipt. This does not grant source reads. */
export function signedLocalImportBoundary(frame, spec, qualification) {
  const rules = spec.architecture?.allowedLocalImports;
  if (!rules) return;
  const graph = pythonImportEvidence({ root: frame.root, reads: spec.codeTask.sources }, qualification.artifacts);
  if (graph.truncated || graph.unparsedFiles.length || graph.ambiguous.length ||
    graph.checkedFiles.length !== spec.codeTask.sources.length) {
    throw new Error("当前签名稿无法完整核对已登记的静态导入边界，请检查源码、语法与路径");
  }
  const allowed = new Map(rules.map(({ file, imports }) => [file, new Set(imports)]));
  const violations = graph.edges.flatMap(({ file, line, imports }) => {
    const scope = allowed.get(file);
    return scope ? imports.filter(target => !scope.has(target)).map(target => ({ file, line, target })) : [];
  });
  if (violations.length) return { status: "architecture-import-boundary", violations,
    next: { tool: "building_loop", action: "submit" } };
}

/** Only the assigned reviewer sees the current contract, never the other
 * actor's recorded judgment. An audit consumes its own sources and test pins.
 */
export function prepareCodeReview(frame, id, active, spec, offset = 0) {
  const signed = requireCodeRegressionCurrent(frame, id, active, spec, active.goal);
  const current = plan(frame, active, spec, signed);
  const { binding, changes, requiredCases, architecture } = current;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > changes.length) throw new Error("代码审查变更分页位置无效");
  const page = [];
  let used = 0;
  for (const change of changes.slice(offset)) {
    const size = Buffer.byteLength(JSON.stringify(change));
    if (page.length && used + size > PLAN_PAGE_BYTES) break;
    page.push(change);
    used += size;
  }
  const nextOffset = offset + page.length;
  const progress = reviewProgress(frame, active, current, reviewDraft(frame, active, binding));
  const refs = reviewRefs(frame, active, current);
  const pending = pendingReviewRows(frame, current, progress, page, refs);
  const proseReview = proseSummary(current, progress);
  // Start with the registered examples so the model need not copy each input
  // into an ad hoc runtime request before discovering the required checks.
  const architectureProbe = progress.architectureExamples?.missing.length
    ? { tool: "building_loop_code_review", action: "probe", assertion: "architecture" } : undefined;
  return { binding, changes: page, changeTotal: changes.length, changeOffset: offset,
    ...(nextOffset < changes.length ? { nextChangePage: { action: "prepare", codeReviewOffset: nextOffset } } : {}),
    requiredCases, signed, goalFiles: active.goal.files.map(({ file }) => file),
    ...(architecture ? { architecture, imports: pythonImportEvidence(frame, current.artifacts) } : {}),
    ...(signed.architectureResponsibilities ? { architectureResponsibilities: signed.architectureResponsibilities.rows } : {}),
    ...(proseReview ? { proseReview } : {}),
    progress: visibleReviewProgress(progress), pending, refs,
    ...(architectureProbe ? { architectureProbe } : {}),
    submission: { tool: "building_loop_code_review", action: "record", fields: {
      decisions: "[{id,status,basis,refs?,obligation?}]；id 用 pending 所列编号；只填未核或需更正的项。已读证据写 S1:12、G1:4-6，也可用实际 {file,start,end}。",
      fileDecision: "简表只交 id、status、basis、最多六个 refs（missing 时另填 obligation）。verified 时选实际注释行，不要复制全部变更范围；有唯一 annotationRef 时可省略 refs。源码注释不准确时用 annotation 发现。",
      testDecision: "status=pass|revise。refs 填目标原文及实际源码，各一个。revise 须同 caseId 和条款的已证实 findings。",
      sectionDecision: "status=pass|revise。refs 填支持判断的已读目标或实际源码。宿主携带章节位置并生成架构总判定。revise 应另登记该节真实发现。",
      ...(proseReview ? {
        proseCoverage: "按 pendingBlocks 逐项交 {id,status}。plan 只用于未来计划，no-current-claim 用于无现状断言。核对实际断言用 consistent 或 contradiction，写 basis 及适用的 facts:[职责编号]；没有登记职责时引用本段实际源码 refs。contradiction 或 insufficient 必填本段真实 line。能证明的矛盾必须登记 contradiction。",
        proseFactReview: "逐节对照生成的每项职责，交 {section,id,blocks:[相关正文编号]}。若该节无相关陈述，确认后填 []。先登记正文判断，同批可提交。",
      } : {}),
      example: "{action:'record',decisions:[{id:'file:1',status:'verified',basis:'这行注释解释为何限制批量大小',refs:['S1:12']},{id:'test:1',status:'pass',basis:'这里比较实际限制条件与原需求',refs:['G1:4','S1:13']}] }；编号和行号须替换成实际 pending 与 refs。",
      commentQuote: COMMENT_QUOTE_RULE,
      findings: "仅需修复的问题 [{id,kind,file,start,end,observation,issue,fix,violation:{type,expected,actual,requirement?,reproduction?,obligation?},evidence:[{file,start,end,relation}]}]。架构稿错误用 kind=architecture、violation.type=architecture，源码注释错误才用 annotation。同一 id 修正；证据复查后确认无需修复时用 removeFindings 明确撤回。" + CODE_REVIEW_REJECTION_RULE,
      observations: "通过的核对、可选优化或无需修改的备注 [{id,kind,file,start,end,observation,suggestion?,evidence:[{file,start,end,relation}]}]；removeObservations 删除",
    } },
    next: (architectureProbe ? "先调用 building_loop_code_review {action:'probe',assertion:'architecture'} 一次，宿主运行当前角色未完成的已登记示例。不要把示例逐个复制到 runtime。" : "") +
      "优先完成 pending 中的全部缺项。用 record decisions 只记编号、判断、短依据及必要证据，已通过的行不用重报。先对照签名和已返回的实际行。" + CODE_REVIEW_REJECTION_RULE + CODE_REVIEW_PROBE_RULE +
      (architecture ? "完整读架构稿，对照实际目标和源码判断各节。静态导入仅能证明静态依赖。" : "") +
      (proseReview ? "逐段检查 proseReview.pendingBlocks 后再核 pendingFacts，单独处理同节的每个项目。用实际条款、触发和源码区分计划、业务判定、兜底和透传。"
        : signed.architectureResponsibilities ? "按编号逐条对照生成的关键职责与全稿。若实施、回退或验证章节把该触发归给其他模块，用该章节原位置和实际源码登记架构退回。计划、兜底和透传分别判断。" : "") +
      (architecture?.examples ? "登记示例实际有差异时，按原示例位置记录架构退回并链接复现编号。" : "") +
      "每批最多 32 项。发现记齐后填 findingsDone:true，无发现也如此。progress.ready 后空参数 submit。",
    commentRule: CODE_COMMENT_RULE };
}

const record = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => fields.includes(key));

function rationale(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " 缺少具体依据");
  if (value.length > 400) throw new Error(field + " 超过 400 字，当前长度 " + value.length);
  return value.trim();
}

function observed(frame, active, row, paths, expected, extract) {
  const file = relativeName(row?.file);
  const { start, end } = row;
  if (!includes(paths, file) || !includes(frame.reads, file)) throw new Error("代码审查位置须属于已授权工件或当前目标");
  const bytes = readBytes(frame.root, file);
  const lines = bytes && lineList(bytes);
  const seen = active.seen?.[keyOf(file)];
  if (!lines || seen?.hash !== digest(bytes) || seen.hash !== expected.get(keyOf(file)) ||
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length ||
    !seen.ranges.some(([a, b]) => a <= start && b >= end)) {
    throw new Error("请先读取当前版本的代码审查位置 " + file + " 第 " + start + "–" + end + " 行");
  }
  if (extract) extract(lines);
  return { file, start, end, sha256: seen.hash };
}

/** Resolve the clause before running an exploratory expectation. This binds
 * the literal excerpt to the role's actual read and the current goal bytes. */
export function codeReviewRequirement(frame, active, row) {
  if (row === undefined) return;
  if (!record(row, [...locatorKeys, "quote"])) throw new Error("复现条款须提供 file、start、end 和 quote");
  const quote = rationale(row.quote, "requirement.quote");
  const files = active.goal.files;
  let context = {};
  const ref = observed(frame, active, row, files.map(({ file }) => file), new Map(files.map(({ file, sha256 }) => [keyOf(file), sha256])), lines => {
    const cited = excerpt(lines, row);
    if (!cited.includes(quote)) throw new Error("requirement.quote 须逐字引用当前目标条款");
    context = clauseContext(lines, row.start, cited, quote);
  });
  return { ...ref, quote, ...context };
}

/** Match the quoted text inside a visible Markdown paragraph. Keep the
 * paragraph's scope when the reviewer selects just one complete sentence. */
function clauseContext(lines, firstLine, cited, quote) {
  const occurrence = cited.indexOf(quote);
  if (cited.indexOf(quote, occurrence + quote.length) !== -1) return {};
  const lineOffset = lines.slice(0, firstLine - 1).reduce((sum, line) => sum + line.length + 1, 0);
  const start = lineOffset + occurrence, end = start + quote.length;
  const { paragraphs } = markdownStructure(lines, { collectParagraphs: true });
  const paragraph = paragraphs.find(span => span.start.offset <= start && span.end.offset >= end);
  if (!paragraph) return {};
  const text = lines.join("\n").slice(paragraph.start.offset, paragraph.end.offset);
  const before = text.slice(0, start - paragraph.start.offset);
  const after = text.slice(end - paragraph.start.offset);
  // Treat punctuation inside inline data as part of the token, never as a
  // sentence boundary. Chinese sentences do not require a following space.
  const endMark = /[。！？]|[.!?](?=\s|$)/gu;
  const prose = value => value.replace(/\x60[^\x60\r\n]+\x60/gu, " ");
  const atBoundary = value => {
    const plain = prose(value).trimEnd();
    return [...plain.matchAll(endMark)].at(-1)?.index === plain.length - 1;
  };
  const begins = !before.trim() || atBoundary(before);
  const ends = !after.trim() || atBoundary(quote) || /^(?:[。！？]|[.!?](?:\s|$))/u.test(after);
  return { visibleClause: true, clauseComplete: begins && ends,
    ...(hasConditionalContext(text) ? { conditionalContext: true } : {}) };
}

function sameClause(left, right) {
  return !!left && !!right && keyOf(left.file) === keyOf(right.file) && left.sha256 === right.sha256 &&
    left.start === right.start && left.end === right.end;
}

/** Python review pins real lexer comments and docstrings, so a '#' inside a
 * string cannot become proof. For other languages the host pins actual source
 * and leaves annotation classification to the independent reviewers. */
function codeAnnotation(file, lines, start, end, knownOnly = false) {
  const span = lines.slice(start - 1, end).join("\n");
  if (!/\.py$/iu.test(file)) {
    if (!knownOnly) return span;
    if (/\.(?:js|mjs|cjs|jsx|ts|tsx|go|rs|java|kt|cs|c|cpp|h|hpp|swift)$/iu.test(file)) {
      // Deliberately conservative: an uncertain comment prevents a missing
      // claim from blocking; the reviewer can still cite the actual text.
      return lines.slice(start - 1, end).filter(line => /(?:\/\/|\/\*|\*\/)|^\s*\*/u.test(line)).join("\n");
    }
    if (/\.(?:sh|ps1|rb|pl|r|ya?ml|toml)$/iu.test(file)) {
      return lines.slice(start - 1, end).filter(line => /#/u.test(line)).join("\n");
    }
    throw new Error("当前源码格式没有受信注释检查，先记 observation 或引用已登记的可运行条款");
  }
  const source = lines.join("\n");
  const from = start === 1 ? 0 : lines.slice(0, start - 1).join("\n").length + 1;
  const to = from + span.length;
  const parts = [];
  pythonParser.parse(source).iterate({ enter(node) {
    if (node.from >= to || node.to <= from) return false;
    const parent = node.node.parent;
    const container = parent?.parent;
    const docstring = ["String", "ContinuedString"].includes(node.name) && parent?.name === "ExpressionStatement" &&
      ["Script", "Body"].includes(container?.name) &&
      !["b", "f"].includes(source[node.from]?.toLowerCase()) &&
      !hasEarlierStatement(parent);
    if (node.name === "Comment" || docstring) {
      parts.push(source.slice(Math.max(from, node.from), Math.min(to, node.to)));
      return false;
    }
  } });
  return parts.join("\n");
}

function hasEarlierStatement(node) {
  for (let sibling = node.prevSibling; sibling; sibling = sibling.prevSibling) {
    if (sibling.name !== ":" && sibling.name !== "Comment") return true;
  }
  return false;
}

function excerpt(lines, ref) {
  return lines.slice(ref.start - 1, ref.end).join("\n");
}

/** Use the bound artifact inventory even when an external edit races a read.
 * Stored reason locators identify exact bytes, without exporting raw source. */
function reviewReaders(frame, active, current) {
  const sources = current.artifacts.filter(row => row.sha256 && sourceArtifact(row.path)).map(row => row.path);
  const goals = active.goal.files.map(({ file }) => file);
  const expected = new Map([
    ...current.artifacts.map(({ path, sha256 }) => [keyOf(path), sha256]),
    ...active.goal.files.map(({ file, sha256 }) => [keyOf(file), sha256]),
  ]);
  const architecturePaths = current.architecture ? [current.architecture.file] : [];
  if (current.architecture) expected.set(keyOf(current.architecture.file), current.architecture.sha256);
  return { sources, goals, architecturePaths, all: [...goals, ...sources, ...architecturePaths],
    read: (ref, paths, extract) => observed(frame, active, ref, paths, expected, extract) };
}

/** Aliases identify exact authorized artifacts in this signed snapshot.
 * Visibility and full-range proof still come from this role's own reads. */
function reviewRefs(frame, active, current) {
  const sources = current.artifacts.filter(row => row.sha256 && sourceArtifact(row.path))
    .map(({ path, sha256 }) => ({ file: path, sha256 }));
  return [["S", "source", sources], ["G", "goal", active.goal.files]].flatMap(([letter, kind, files]) =>
    files.map(({ file, sha256 }, i) => {
      const stamp = active.seen?.[keyOf(file)];
      return { prefix: letter + (i + 1), kind, file, seen: stamp?.hash === sha256 ? stamp.ranges : [] };
    }).filter(row => includes(frame.reads, row.file)));
}

function decisionRows(current) {
  return [
    ...current.changes.map((value, i) => ({ id: "file:" + (i + 1), kind: "file", value })),
    ...current.requiredCases.map((value, i) => ({ id: "test:" + (i + 1), kind: "test", value })),
    ...(current.proseReview ? [] : current.architecture?.sections ?? []).map((value, i) => ({ id: "section:" + (i + 1), kind: "section", value })),
  ];
}

function aliasLocation(ref, start, end = start) {
  return ref.prefix + ":" + start + (end === start ? "" : "-" + end);
}

function fileDecisionHint(frame, change, ref) {
  if (!ref) return {};
  const spans = change.ranges.filter(({ start, end }) =>
    ref.seen.some(([left, right]) => left <= start && right >= end));
  const locations = spans.slice(0, COMPACT_REF_LIMIT).map(({ start, end }) => aliasLocation(ref, start, end));
  const first = spans[0];
  // A suggested annotation must come from source the actor has already seen.
  // Other languages can use explicit locators without a Python-only guess.
  let annotationRef;
  if (spans.length === 1 && change.ranges.length === 1 && first.end - first.start <= 6 && /\.py$/iu.test(change.path)) {
    const bytes = readBytes(frame.root, change.path);
    if (bytes && digest(bytes) === change.sha256) {
      const lines = lineList(bytes);
      const comments = [];
      for (let line = first.start; line <= first.end; line++) {
        if (codeAnnotation(change.path, lines, line, line).trim()) comments.push(line);
      }
      if (comments.length === 1) annotationRef = aliasLocation(ref, comments[0]);
    }
  }
  return { refs: locations, ...(spans.length > locations.length ? { moreObservedRanges: spans.length - locations.length } : {}),
    ...(annotationRef ? { annotationRef } : {}) };
}

function pendingReviewRows(frame, current, progress, page, refs) {
  const sourceRefs = new Map(refs.filter(row => row.kind === "source").map(row => [keyOf(row.file), row]));
  const visibleChanges = new Set(page.map(row => row.path));
  const rows = decisionRows(current);
  const corrections = new Set(progress.pendingCorrections.map(({ field, id }) => field + ":" + id));
  const missingFiles = new Set(progress.missingFiles), missingCases = new Set(progress.missingCases);
  const missingSections = new Set(progress.missingArchitectureSections);
  return rows.flatMap(({ id, kind, value }) => {
    if (kind === "file" && visibleChanges.has(value.path) &&
      (missingFiles.has(value.path) || corrections.has("files:" + value.path))) {
      return [{ id, kind, file: value.path, ...fileDecisionHint(frame, value, sourceRefs.get(keyOf(value.path))) }];
    }
    if (kind === "test" && (missingCases.has(value) || corrections.has("constraints:" + value))) {
      return [{ id, kind, caseId: value, signedStatus: current.signedCases?.find(row => row.id === value)?.status }];
    }
    if (kind === "section" && (missingSections.has(value.heading) || corrections.has("architectureSections:" + value.heading) ||
      progress.architectureCodeEvidence === false && value.heading === current.architecture.sections[0]?.heading)) {
      return [{ id, kind, ...value, file: current.architecture.file, ...(progress.sectionFindingsMissing?.includes(value.heading)
        ? { needs: "请关联该节具体 findings，或更正该节判断" } : {}) }];
    }
    return [];
  });
}

function chosenRef(value, refs) {
  if (record(value, locatorKeys)) return value;
  const found = typeof value === "string" && /^([SG][1-9][0-9]*):([1-9][0-9]*)(?:-([1-9][0-9]*))?$/u.exec(value);
  const row = found && refs.find(item => item.prefix === found[1]);
  if (!row) throw new Error("证据请用本轮 refs 中的编号及实际已读行，或 {file,start,end}");
  return { file: row.file, start: Number(found[2]), end: Number(found[3] ?? found[2]) };
}

function checkedFile(row, change, readers) {
  if (!record(row, ["file", "basis", "comment", "comments"]) || row.comment !== undefined && row.comments !== undefined) {
    throw new Error("每个文件只登记一次，单个注释用 comment，多个注释用 comments");
  }
  const { path: file, ranges } = change;
  const list = row.comments ?? [row.comment];
  if (!Array.isArray(list) || !list.length || list.length > 6) throw new Error(file + " 需登记 1–6 个注释判断");
  for (const { start, end } of ranges) readers.read({ file, start, end }, readers.sources);
  const positions = new Set();
  const comments = list.map((item, index) => {
    if (!record(item, ["status", "basis", "start", "end", "quote", "obligation"]) ||
      !["verified", "missing", "not-needed"].includes(item.status)) throw new Error(file + " 的注释判断无效");
    const where = { file, start: item.start, end: item.end };
    const label = file + (row.comments ? ` 的 comments[${index}]` : " 的 comment");
    let annotationSha256, quote, staticProof;
    const ref = readers.read(where, readers.sources, lines => {
      if (item.status === "missing") {
        if (!COMMENT_OBLIGATIONS.includes(item.obligation) || !ranges.some(({ start, end }) => start <= item.end && end >= item.start) ||
            !excerpt(lines, where).trim() || item.end - item.start > 30) {
          throw new Error(label + " 缺失注释须给出 obligation 和包含实际改动的源码位置（最多 31 行）");
        }
        const from = Math.max(1, item.start - 1);
        if (codeAnnotation(file, lines, from, item.end, true).trim()) {
          throw new Error(label + " 该范围有可定位注释。说明不足或错误时登记 annotation 发现，勿用 missing");
        }
        staticProof = { rule: "necessary-comment", obligation: item.obligation, check: "missing-adjacent-annotation",
          start: from, end: item.end, sha256: digest(lines.slice(from - 1, item.end).join("\n")) };
        return;
      }
      if (item.status !== "verified") return;
      const raw = codeAnnotation(file, lines, item.start, item.end);
      if (!raw.trim()) throw new Error(label + " 选定范围没有可核对的注释，请定位实际注释，或按实情填 missing / not-needed");
      if (item.quote !== undefined && (typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 400 || !raw.includes(item.quote))) {
        throw new Error(label + ".quote 须逐字定位到当前已读源码。" + COMMENT_QUOTE_RULE);
      }
      annotationSha256 = digest(raw);
      // Keep the full pin for a long single-line annotation without copying
      // arbitrary source into a receipt that the coordinator can read.
      if (/\.py$/iu.test(file) && raw.length <= 400) quote = raw;
    });
    if (item.status !== "verified" && item.quote !== undefined) throw new Error(label + ".quote 须省略");
    if (item.status !== "missing" && item.obligation !== undefined) throw new Error(label + ".obligation 仅用于缺失注释");
    const location = `${ref.start}:${ref.end}`;
    if (positions.has(location)) throw new Error(label + " 重复引用同一范围，请合并说明");
    positions.add(location);
    return { ...ref, status: item.status, basis: rationale(item.basis, label + ".basis"),
      ...(annotationSha256 ? { annotationSha256 } : {}), ...(quote === undefined ? {} : { quote }), ...(staticProof ? { staticProof } : {}) };
  });
  return { file, basis: rationale(row.basis, file + " 的 files.basis"),
    ...(row.comments ? { comments } : { comment: comments[0] }) };
}

const locatorKeys = ["file", "start", "end"];
function checkedConstraint(row, readers) {
  if (!record(row, ["caseId", "requirement", "code", "basis", "status"]) || !["pass", "revise"].includes(row.status) ||
    !record(row.requirement, locatorKeys) || !record(row.code, locatorKeys)) {
    throw new Error("逐项绑定当前签名新增必测、目标原文和源码位置，status 为 pass 或 revise");
  }
  return { caseId: row.caseId, status: row.status, requirement: readers.read(row.requirement, readers.goals),
    code: readers.read(row.code, readers.sources), basis: rationale(row.basis, row.caseId + " 的 constraints.basis") };
}

/** Bind the source span itself and preserve the reviewer's stated relationship. */
function checkedEvidence(items, readers, paths) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 4) throw new Error("需提供 1–4 个当前已读的依据定位");
  const locations = new Set();
  return items.map(item => {
    if (!record(item, [...locatorKeys, "quote", "relation"]) || !EVIDENCE_RELATIONS.includes(item.relation)) {
      throw new Error("每条依据须有已读位置及 relation（supports、contradicts 或 reproduces）");
    }
    let excerptSha256;
    const source = readers.read(item, paths, lines => {
      const span = excerpt(lines, item);
      if (!span.trim() || item.quote !== undefined &&
        (typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 400 || !span.includes(item.quote))) {
        throw new Error("依据须定位到实际源码或目标原文。若提供 quote，须逐字一致");
      }
      excerptSha256 = digest(span);
    });
    const location = `${keyOf(source.file)}:${source.start}:${source.end}`;
    if (locations.has(location)) throw new Error("依据位置重复，请保留真正相关的范围");
    locations.add(location);
    return { ...source, relation: item.relation, excerptSha256 };
  });
}

function reviewLocation(row, readers, finding = false) {
  const ref = readers.read(row, readers.all);
  const owner = includes(readers.architecturePaths, ref.file) ? "coordinator" : "executor";
  if (owner === "coordinator" && finding &&
    (row.kind !== "architecture" || row.violation?.type !== "architecture" || row.violation?.obligation !== undefined)) {
    // The path is already verified; retain the reviewer's intent to block until
    // they correct the fields or explicitly withdraw it. No finding is inferred.
    const error = new Error("位置已确认是登记架构稿。请用同一 findings.id 重交，设 kind=architecture、violation.type=architecture，删除 violation.obligation，并引用已读的当前源码或目标。复查确认不需修时用 removeFindings 撤回");
    error.correction = { code: "architecture-finding-kind", file: ref.file, start: ref.start, end: ref.end,
      kind: "architecture", violationType: "architecture", omit: "violation.obligation" };
    throw error;
  }
  if (!FINDING_KINDS.includes(row.kind) || (row.kind === "architecture") !== (owner === "coordinator")) {
    throw new Error(owner === "coordinator" ? "登记架构稿的记录须使用 kind=architecture" :
      "此位置不在登记架构稿中。源码行为、维护或必要注释分别用 kind=behavior、maintenance、annotation；架构问题须定位到实际架构稿");
  }
  return { ref, owner };
}

/** Compare the declared values, never guess the semantics of free-text rationale. */
function checkedViolation(value, kind, id, readers, context) {
  if (!record(value, ["type", "expected", "actual", "requirement", "reproduction", "obligation"]) || !VIOLATION_TYPES.includes(value.type)) {
    throw new Error("需要 violation 明确实际违反的要求。符合要求或无需修改的内容请填 observations");
  }
  const { type } = value;
  const expected = rationale(value.expected, id + ".violation.expected"), actual = rationale(value.actual, id + ".violation.actual");
  const compare = value => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (compare(expected) === compare(actual)) throw new Error("violation 的实际结果等于要求，无需修正的核对请填 observations");
  if (!TYPES_BY_KIND[kind].includes(type)) {
    throw new Error("发现 kind 与 violation.type 不一致，请选择实际违反的类型");
  }
  const runtime = ["requirement", "runtime", "maintainability"].includes(type);
  let requirement, reproduction;
  if (runtime || value.requirement !== undefined) {
    if (!record(value.requirement, locatorKeys)) throw new Error("requirement 须定位到已读的实际要求原文");
    requirement = readers.read(value.requirement, readers.goals);
  }
  if (type === "regression" && (context.caseResult?.status !== "failed" || context.baselineCase?.status !== "passed")) {
    throw new Error("回归退回须绑定基线通过、当前失败的同一签名用例。发现新的运行差异请用 runtime 复现");
  }
  if (runtime || type === "syntax" || value.reproduction !== undefined) {
    if (typeof value.reproduction !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.reproduction)) {
      throw new Error("运行或语法问题需登记当前签名版本的受信复现编号。规格未规定的顺序和建议写 observations");
    }
    const proofType = runtime ? "runtime" : type;
    reproduction = context.resolveReproduction?.(value.reproduction, { type: proofType, ...context.ref, signed: context.signed,
      goal: context.goal, expected, actual, requirement });
    if (reproduction?.id !== value.reproduction || reproduction.type !== proofType || reproduction.outcome !== "mismatch") {
      throw new Error("该复现尚未证明当前签名版本的实际不一致，先核对真实运行结果");
    }
    if (runtime && !isGroundedRuntimeProof(reproduction)) {
      throw new Error("当前复现未用条款或登记示例证明预期输出");
    }
    if (runtime && !sameClause(requirement, reproduction.requirement)) {
      throw new Error("退回须引用 runtime probe 已绑定的相同当前规格条款");
    }
  }
  if (type === "annotation" && !COMMENT_OBLIGATIONS.includes(value.obligation) || type !== "annotation" && value.obligation !== undefined) {
    throw new Error("annotation 退回须选择必要注释规则 obligation；其他发现不得用注释规则代替证据");
  }
  const facts = runtime ? reproduction.summary : { expected, actual };
  return { type, ...facts, ...(requirement ? { requirement } : {}), ...(reproduction ? { reproduction } : {}),
    ...(value.obligation ? { obligation: value.obligation } : {}) };
}

function checkedFinding(row, id, readers, active, current, signed, resolveReproduction) {
  if (!record(row, [...locatorKeys, "id", "kind", "observation", "issue", "fix", "evidence", "caseId", "violation"])) {
    throw new Error("代码审查问题须指向可核对的实际位置");
  }
  const { ref, owner } = reviewLocation(row, readers, true);
  const evidence = checkedEvidence(row.evidence, readers, readers.all);
  if (!evidence.some(item => item.relation !== "contradicts")) throw new Error("发现缺少支持或复现该问题的定位，请核对观察");
  if (owner === "executor" && ![ref, ...evidence].some(item => includes(readers.sources, item.file))) {
    throw new Error("代码发现须有实际源码依据，不能仅引用目标说明");
  }
  const caseResult = row.caseId === undefined ? undefined : active.codeIntake.qualification.cases?.find(item => item.id === row.caseId);
  if (row.caseId !== undefined && !caseResult) throw new Error("caseId 须为当前签名回执内的实际用例编号");
  const baselineCase = row.caseId === undefined ? undefined : active.codeIntake.regression.cases?.find(item => item.id === row.caseId);
  const violation = checkedViolation(row.violation, row.kind, id, readers,
    { ref, signed, goal: active.goal, caseResult, baselineCase, resolveReproduction });
  let staticProof;
  if (violation.type === "annotation") {
    readers.read(ref, readers.sources, lines => {
      const annotation = codeAnnotation(ref.file, lines, ref.start, ref.end, true);
      const source = evidence.find(item => item.relation !== "contradicts" && includes(readers.sources, item.file) &&
        (keyOf(item.file) !== keyOf(ref.file) || item.start < ref.start || item.end > ref.end));
      if (!annotation.trim() || !source) throw new Error("已有注释退回须定位真实注释，并引用另一处当前源码。注释完全缺失用 files.comment.status=missing");
      staticProof = { rule: "necessary-comment", obligation: violation.obligation, check: "existing-annotation-against-source",
        annotationSha256: digest(annotation), source };
    });
  }
  if (violation.type === "architecture") {
    const section = current.architecture?.sections.find(({ start, end }) => ref.start >= start && ref.end <= end);
    const source = evidence.find(item => item.relation !== "contradicts" && includes([...readers.sources, ...readers.goals], item.file));
    if (!section || !source && !violation.reproduction) {
      throw new Error("架构退回须定位登记章节，并引用相关当前源码或目标，或关联该节受信示例差异");
    }
    staticProof = { rule: "registered-architecture-section", section: section.heading,
      check: violation.reproduction ? "registered-example" : "architecture-against-current-source-or-goal", ...(source ? { source } : {}) };
  }
  const examples = active.engineeringArchitecture?.examples;
  if (violation.reproduction?.exampleId && (owner !== "coordinator" || !examples?.cases.some(item => item.id === violation.reproduction.exampleId) ||
    ref.start < examples.start || ref.end > examples.end)) {
    throw new Error("该退回项须定位到架构稿中声明该示例的章节");
  }
  return { ...ref, id, owner, kind: row.kind, observation: rationale(row.observation, id + ".observation"), evidence, violation,
    ...(staticProof ? { staticProof } : {}),
    issue: rationale(row.issue, id + ".issue"), fix: rationale(row.fix, id + ".fix"),
    ...(caseResult ? { signedCase: { id: caseResult.id, status: caseResult.status } } : {}) };
}

function checkedObservation(row, id, readers) {
  if (!record(row, [...locatorKeys, "id", "kind", "observation", "suggestion", "evidence"])) {
    throw new Error("observations 仅登记观察与可选建议；明确需修复的问题用 findings");
  }
  const { ref } = reviewLocation(row, readers);
  return { ...ref, id, kind: row.kind, observation: rationale(row.observation, id + ".observation"),
    evidence: checkedEvidence(row.evidence, readers, readers.all),
    ...(row.suggestion === undefined ? {} : { suggestion: rationale(row.suggestion, id + ".suggestion") }) };
}

function checkedArchitecture(row, current, readers) {
  if (!current.architecture) throw new Error("当前单元无已授权架构稿");
  if (!record(row, ["status", "basis", "source", "sections"]) || !["pass", "revise"].includes(row.status) || !record(row.source, locatorKeys)) {
    throw new Error("架构核验须提供 status、basis 和实际架构稿位置 source");
  }
  const source = readers.read(row.source, readers.architecturePaths, lines => {
    const last = lines.at(-1) === "" ? Math.max(1, lines.length - 1) : lines.length;
    if (row.source.start !== 1 || row.source.end < last) throw new Error("请完整读架构稿，source 从第 1 行覆盖至最后一行正文");
  });
  return { source, status: row.status, basis: rationale(row.basis, "architecture.basis") };
}

function checkedArchitectureSection(row, section, current, readers) {
  if (!record(row, ["heading", "basis", "evidence"]) || !section) throw new Error("架构章节须使用登记的准确标题");
  const source = readers.read({ file: current.architecture.file, start: section.start, end: section.end }, readers.architecturePaths);
  const evidence = checkedEvidence(row.evidence, readers, [...readers.goals, ...readers.sources]);
  if (!evidence.some(item => item.relation !== "contradicts")) throw new Error("架构章节须定位支持本判断的目标或源码");
  return { heading: section.heading, source, basis: rationale(row.basis, section.heading + " 的 basis"), evidence };
}

/** Reuse the same evidence validators for legacy verbose rows and compact
 * decisions. A compact decision cannot cite an unobserved or stale alias. */
function checkedDecision(row, descriptor, refs, frame, current, readers) {
  const selected = (row.refs ?? []).map(value => chosenRef(value, refs));
  const { kind, value } = descriptor;
  if (kind === "file") {
    if (!["verified", "missing", "not-needed"].includes(row.status)) throw new Error("文件判断须使用 verified、missing 或 not-needed");
    if (selected.some(ref => typeof ref.file !== "string" || keyOf(ref.file) !== keyOf(value.path))) {
      throw new Error("文件判断须定位到该实际变更文件的已读行");
    }
    if (!selected.length) {
      if (row.status === "verified") {
        const alias = refs.find(ref => ref.file === value.path && ref.kind === "source");
        const hint = fileDecisionHint(frame, value, alias);
        if (!hint.annotationRef) throw new Error("没有唯一可预填的已读注释，请选择实际注释位置");
        selected.push(chosenRef(hint.annotationRef, refs));
      } else {
        const { start, end } = value.ranges[0];
        selected.push({ file: value.path, start, end });
      }
    }
    const comments = selected.map(({ start, end }) => ({ start, end, status: row.status, basis: row.basis, obligation: row.obligation }));
    return checkedFile({ file: value.path, basis: row.basis,
      ...(comments.length === 1 ? { comment: comments[0] } : { comments }) }, value, readers);
  }
  if (row.obligation !== undefined) throw new Error("obligation 只用于变更源码的注释缺失判断");
  if (kind === "test") {
    const goal = selected.filter(ref => includes(readers.goals, ref.file));
    const source = selected.filter(ref => includes(readers.sources, ref.file));
    if (selected.length !== 2 || goal.length !== 1 || source.length !== 1) {
      throw new Error("必测判断需要一个已读目标原文位置和一个已读实际源码位置");
    }
    return checkedConstraint({ caseId: value, requirement: goal[0], code: source[0], status: row.status, basis: row.basis }, readers);
  }
  if (!["pass", "revise"].includes(row.status)) throw new Error("架构章节判断须使用 pass 或 revise");
  const evidence = selected.map(ref => ({ ...ref, relation: "supports" }));
  return { ...checkedArchitectureSection({ heading: value.heading, basis: row.basis, evidence }, value, current, readers),
    status: row.status };
}

function compactArchitecture(frame, active, current, draft, proseReview) {
  if ((!draft.compactArchitecture && !current.proseReview) || !current.architecture) return draft.architecture;
  if (current.proseReview && !["pass", "revise"].includes(proseReview?.status)) return;
  const sections = draft.architectureSections ?? [];
  if (!current.proseReview && !current.architecture.sections.every(section => sections.some(row => row.heading === section.heading))) return;
  const bytes = readBytes(frame.root, current.architecture.file);
  if (!bytes || digest(bytes) !== current.architecture.sha256) return;
  const lines = lineList(bytes);
  const end = lines.at(-1) === "" ? Math.max(1, lines.length - 1) : lines.length;
  const seen = active.seen?.[keyOf(current.architecture.file)];
  if (seen?.hash !== current.architecture.sha256 || !seen.ranges.some(([start, last]) => start === 1 && last >= end)) return;
  const source = { file: current.architecture.file, start: 1, end, sha256: seen.hash };
  const status = proseReview?.status === "revise" || sections.some(row => row.status === "revise") ||
    draft.findings.some(row => row.owner === "coordinator") ? "revise" : "pass";
  return { source, status, basis: current.proseReview ? "依据逐段核验、已读完整架构稿和退回记录生成" :
    "依据各节核验、已读完整架构稿和退回记录生成" };
}

/** Save only the actor's own validated rows for this activation and exact proof
 * input. In particular, the auditor cannot inherit the first reviewer's draft. */
function reviewDraft(frame, active, binding) {
  const identity = { actor: frame.agent.id, role: frame.role, serial: active.serial, binding };
  const saved = active.codeReviewDraft;
  if (saved && Object.keys(identity).every(key => saved[key] === identity[key])) return { observations: [], proseCoverage: [], proseFactReview: [], ...saved };
  return { ...identity, files: [], constraints: [], findings: [], observations: [], findingsDone: false, pendingCorrections: [],
    proseCoverage: [], proseFactReview: [] };
}

function proseSnapshot(current, draft) {
  return current.proseReview && { binding: current.proseReview.binding, blocks: draft.proseCoverage, facts: draft.proseFactReview };
}

function proseSummary(current, progress) {
  if (!current.proseReview) return;
  const coverage = progress.proseReview;
  const pending = new Set([...coverage.missing, ...coverage.findings.filter(row => row.status === "insufficient").map(row => row.id)]);
  for (const { field, id } of progress.pendingCorrections) if (field === "proseCoverage") pending.add(id);
  const unresolved = current.proseReview.blocks.filter(block => pending.has(block.id));
  const sections = new Map(current.proseReview.sections.map(section => [section.id, section]));
  const factPins = new Map(current.proseReview.facts.map(fact => [fact.id, fact]));
  const factPending = new Set(coverage.missingFacts.map(({ section, id }) => section + ":" + id));
  for (const { field, id } of progress.pendingCorrections) if (field === "proseFactReview") factPending.add(id);
  const factRows = [...factPending].slice(0, RECORD_LIMIT).map(key => {
    const [section, id] = key.split(":");
    return { section, id };
  }).map(row => ({
    ...row, heading: sections.get(row.section)?.heading, reviewedBlocks: coverage.references[row.section]?.[row.id] ?? [],
  }));
  const shownFacts = [...new Set(factRows.map(row => row.id))].map(id => {
    const { clause, decision } = factPins.get(id) ?? {};
    return { id, anchor: "#bl-fact-" + id,
      ...(clause ? { clause: { file: clause.file, start: clause.start, end: clause.end } } : {}),
      ...(decision ? { decision: { file: decision.file, line: decision.line, mode: decision.mode } } : {}) };
  });
  return { file: current.architecture.file, status: coverage.status, pendingBlockCount: unresolved.length, pendingFactCount: factPending.size,
    pendingBlocks: unresolved.slice(0, RECORD_LIMIT).map(({ id, section, heading, kind, start, end, refs, unknownRefs }) => ({
      id, section, heading, kind, start, end, ...(refs.length ? { factLinks: refs } : {}), ...(unknownRefs ? { unknownFactLinks: unknownRefs } : {}),
    })),
    pendingFacts: factRows, factLocations: shownFacts };
}

function visibleReviewProgress(progress) {
  const { proseReview, ...rest } = progress;
  if (!proseReview) return progress;
  return { ...rest, proseReview: { status: proseReview.status, missingBlocks: proseReview.missing.length,
    missingFacts: proseReview.missingFacts.length, findings: proseReview.findings.slice(0, RECORD_LIMIT) } };
}

function exactProseSource(current, readers, start, end = start) {
  return readers.read({ file: current.architecture.file, start, end }, readers.architecturePaths);
}

function checkedProseCoverage(row, block, current, readers, aliases) {
  if (!record(row, ["id", "status", "basis", "facts", "line", "refs"]) || !block || !PROSE_REVIEW_STATUSES.includes(row.status)) {
    throw new Error("逐段核验使用 proseReview 中的编号和判断");
  }
  const facts = row.facts ?? [];
  const refs = row.refs ?? [];
  if (!Array.isArray(facts) || facts.length > 8 || new Set(facts).size !== facts.length ||
    !Array.isArray(refs) || refs.length > COMPACT_REF_LIMIT || block.unknownRefs || block.refs.some(id => !facts.includes(id))) {
    throw new Error("逐段核验须保留此段链接的真实职责编号，引用最多六处");
  }
  const source = exactProseSource(current, readers, block.start, block.end);
  const proseStatus = row.status;
  const simple = proseStatus === "plan" || proseStatus === "no-current-claim";
  if (simple && (facts.length || refs.length || row.line !== undefined)) {
    throw new Error("计划或无现状陈述仅登记状态；涉及职责的断言须另按事实判断");
  }
  if (simple) return { id: block.id, sha256: block.sha256, status: proseStatus, facts, source };
  const basis = rationale(row.basis, "逐段核验 " + row.id + " 的 basis");
  const needsLine = proseStatus === "contradiction" || proseStatus === "insufficient";
  if (needsLine && !Number.isSafeInteger(row.line) || row.line !== undefined &&
    (!Number.isSafeInteger(row.line) || row.line < block.start || row.line > block.end)) {
    throw new Error("请定位到此段中有待核对的实际行，不能用同一章节的其他条目");
  }
  const proof = facts.map(id => {
    const fact = current.responsibilities?.find(item => item.id === id);
    if (!fact) throw new Error("逐段核验只能引用当前签名的关键职责编号");
    const { clause, actual } = fact;
    const target = readers.read(clause, readers.goals);
    const decision = readers.read({ file: actual.file, start: actual.line, end: actual.line }, readers.sources);
    return { id, clause: target, decision };
  });
  const evidence = refs.map(ref => readers.read(chosenRef(ref, aliases), [...readers.goals, ...readers.sources]));
  if (!facts.length && proseStatus !== "insufficient" &&
    !evidence.some(item => includes(readers.sources, item.file))) {
    throw new Error("没有职责编号的现状判断须引用实际已读源码，并说明与本段的关系");
  }
  return { id: block.id, sha256: block.sha256, status: proseStatus, facts, source, basis,
    ...(row.line === undefined ? {} : { line: row.line }), ...(proof.length ? { proof } : {}), ...(evidence.length ? { evidence } : {}) };
}

function checkedProseFactReview(row, inventory) {
  if (!record(row, ["section", "id", "blocks"]) || typeof row.section !== "string" || typeof row.id !== "string" ||
    !inventory.facts.some(fact => fact.id === row.id) || !Array.isArray(row.blocks) ||
    new Set(row.blocks).size !== row.blocks.length) throw new Error("逐节核对请使用本轮章节和职责编号");
  const section = inventory.sections.find(item => item.id === row.section);
  if (!section || row.blocks.some(id => !section.blocks.includes(id))) throw new Error("职责关联位置必须属于当前节");
  return { section: row.section, id: row.id, blocks: row.blocks };
}

function proseSectionSummaries(current, draft, progress) {
  if (!current.proseReview) return draft.architectureSections ?? [];
  if (!["pass", "revise"].includes(progress.proseReview.status)) return [];
  return current.architecture.sections.map(({ heading, start, end }) => {
    const blocks = draft.proseCoverage.filter(({ source }) => source.start >= start && source.end <= end);
    const evidence = blocks.flatMap(row => [...(row.evidence ?? []), ...(row.proof ?? []).map(item => item.decision)]);
    return { heading, source: { file: current.architecture.file, start, end, sha256: current.architecture.sha256 },
      status: blocks.some(row => row.status === "contradiction") ? "revise" : "pass",
      basis: "逐段判断已登记，按正文位置核对对应职责与证据", evidence: evidence.slice(0, COMPACT_REF_LIMIT),
    };
  });
}

function architectureProbeProgress(frame, active, current, draft, architectureVerdict) {
  const cases = current.architecture?.examples?.cases ?? [];
  if (!cases.length) return;
  const saved = active.codeReviewProbes;
  const available = saved?.actor === frame.agent.id && saved.serial === active.serial && saved.binding === current.binding ? saved.rows : [];
  const rows = cases.map(({ id }) => {
    // One evidenced mismatch stays actionable for these exact bytes. A later
    // successful rerun cannot hide an earlier unresolved discrepancy.
    const attempts = (available ?? []).filter(row => row.type === "architecture" && row.exampleId === id);
    const proof = attempts.find(row => row.outcome === "mismatch") ?? attempts.find(row => row.outcome === "match");
    return { id, ...(proof ? { probeId: proof.id, outcome: proof.outcome } : {}) };
  });
  const missing = rows.filter(row => !row.outcome).map(row => row.id);
  const mismatches = rows.filter(row => row.outcome === "mismatch");
  const unaddressed = mismatches.filter(row => !draft.findings.some(finding => {
    const probe = finding.violation?.reproduction;
    return finding.owner === "coordinator" && probe?.type === "architecture" && probe.exampleId === row.id && probe.outcome === "mismatch";
  })).map(row => row.id);
  return { rows, missing, unaddressed, passWithMismatch: mismatches.length > 0 && architectureVerdict?.status === "pass" };
}

function reviewProgress(frame, active, current, draft) {
  const recordedFiles = new Set(draft.files.map(row => keyOf(row.file)));
  const recordedCases = new Set(draft.constraints.map(row => row.caseId));
  const missingFiles = current.changes.filter(change => !recordedFiles.has(keyOf(change.path))).map(change => change.path);
  const missingCases = current.requiredCases.filter(id => !recordedCases.has(id));
  const findingIds = draft.findings.map(row => row.id);
  const observationIds = draft.observations.map(row => row.id);
  // Old stored drafts may lack the proof required by this version. A current
  // pass remains readable, while an unsupported rejection needs correction.
  const pendingCorrections = draft.pendingCorrections.slice();
  const requireCorrection = (field, id) => {
    if (!pendingCorrections.some(item => item.field === field && item.id === id)) pendingCorrections.push({ field, id });
  };
  for (const { id, kind, violation, staticProof } of draft.findings) {
    if (!violation || !TYPES_BY_KIND[kind]?.includes(violation.type) ||
      ["requirement", "runtime", "maintainability"].includes(violation.type) &&
        (!isGroundedRuntimeProof(violation.reproduction) || !sameClause(violation.requirement, violation.reproduction.requirement)) ||
      ["annotation", "architecture"].includes(violation.type) && !staticProof) requireCorrection("findings", id);
  }
  for (const { file, comment, comments } of draft.files) {
    if ((comments ?? [comment]).some(item => item.status === "missing" && !item.staticProof)) requireCorrection("files", file);
  }
  const unsupportedCaseRevisions = draft.constraints.filter(row => row.status === "revise" && !draft.findings.some(finding =>
    finding.kind === "behavior" && finding.signedCase?.id === row.caseId && sameClause(row.requirement, finding.violation?.requirement) &&
    !pendingCorrections.some(item => item.field === "findings" && item.id === finding.id))).map(row => row.caseId);
  for (const caseId of unsupportedCaseRevisions) requireCorrection("constraints", caseId);
  const proseReview = current.proseReview && checkArchitectureProseReceipt(current.proseReview, proseSnapshot(current, draft));
  const sections = draft.architectureSections ?? [];
  const missingArchitectureSections = (current.proseReview ? [] : current.architecture?.sections ?? []).filter(section =>
    !sections.some(row => row.heading === section.heading)).map(row => row.heading);
  const sectionFindingsMissing = sections.filter(({ status, source }) => status === "revise" && !draft.findings.some(finding =>
    finding.owner === "coordinator" && finding.sha256 === source.sha256 && finding.file === source.file &&
    finding.start <= source.end && finding.end >= source.start)).map(row => row.heading);
  const unfinishedSections = [...new Set([...missingArchitectureSections, ...sectionFindingsMissing])];
  const candidatePaths = current.artifacts.filter(row => sourceArtifact(row.path)).map(row => row.path);
  const architectureCodeEvidence = !!current.proseReview || !current.architecture || !current.architecture.sections?.length ||
    sections.some(row => row.evidence.some(item => item.relation !== "contradicts" && includes(candidatePaths, item.file)));
  const architectureVerdict = compactArchitecture(frame, active, current, draft, proseReview);
  const hasArchitectureFinding = proseReview?.status === "revise" || draft.findings.some(row => row.owner === "coordinator");
  const architectureIssue = architectureVerdict && draft.findingsDone &&
    ((architectureVerdict.status === "revise") !== hasArchitectureFinding);
  const architecture = current.architecture ? architectureVerdict ? architectureIssue ? "inconsistent" : "recorded" : "missing" : "not-required";
  const examples = architectureProbeProgress(frame, active, current, draft, architectureVerdict);
  const responsibilityEvidenceMissing = (current.responsibilities ?? []).flatMap(({ id, clause, actual }) => {
    const locators = [clause, ...[...new Set([actual.conditionLine, actual.line, actual.callLine, actual.outputLine]
      .filter(Number.isSafeInteger))].map(line => ({ file: actual.file, start: line, end: line, sha256: actual.sha256 }))];
    const missing = locators.filter(({ file, start, end, sha256 }) => {
      const seen = active.seen?.[keyOf(file)];
      return !includes(frame.reads, file) || seen?.hash !== sha256 || !seen.ranges.some(([a, b]) => a <= start && b >= end);
    });
    return missing.length ? [{ id, missing }] : [];
  });
  return { missingFiles, missingCases, findingIds, observationIds, findingsDone: draft.findingsDone, architecture, pendingCorrections,
    ...(proseReview ? { proseReview } : {}),
    ...(responsibilityEvidenceMissing.length ? { responsibilityEvidenceMissing } : {}),
    ...(unsupportedCaseRevisions.length ? { unsupportedCaseRevisions } : {}),
    ...(current.architecture ? { missingArchitectureSections: unfinishedSections, architectureCodeEvidence,
      ...(sectionFindingsMissing.length ? { sectionFindingsMissing } : {}) } : {}),
    ...(examples ? { architectureExamples: examples } : {}),
    ready: !missingFiles.length && !missingCases.length && !pendingCorrections.length && !responsibilityEvidenceMissing.length && draft.findingsDone &&
      !unfinishedSections.length && architectureCodeEvidence && !["missing", "inconsistent"].includes(architecture) &&
      (!proseReview || proseReview.status !== "pending") &&
      (!examples || !examples.missing.length && !examples.unaddressed.length && !examples.passWithMismatch) };
}

const measuredBytes = value => Buffer.byteLength(JSON.stringify(value));

function applyReviewRows(frame, active, current, input, signed, resolveReproduction) {
  if (!record(input, RECORD_KEYS)) throw new Error("代码核验请求含未登记字段");
  const draft = structuredClone(reviewDraft(frame, active, current.binding));
  const readers = reviewReaders(frame, active, current);
  const errors = [];
  const correctionKey = (field, id) => `${field}/${id ?? ""}`;
  const forgetCorrection = (field, id) => {
    const key = correctionKey(field, id);
    draft.pendingCorrections = draft.pendingCorrections.filter(item => correctionKey(item.field, item.id) !== key);
  };
  const add = (field, id, verify, canReplace = false) => {
    try { verify(); forgetCorrection(field, id); }
    catch (error) {
      const correction = field === "findings" ? error.correction : undefined;
      const item = { field, id, reason: error.message, ...(correction ? { correction } : {}) };
      errors.push(item);
      if (canReplace || correction) {
        const saved = draft.pendingCorrections.find(row => correctionKey(row.field, row.id) === correctionKey(field, id));
        if (!saved && correction && draft.pendingCorrections.filter(row => row.correction).length >= MAX_FINDINGS) return;
        forgetCorrection(field, id);
        const retry = correction ?? saved?.correction;
        draft.pendingCorrections.push({ field, id, ...(retry ? { correction: retry } : {}) });
      }
    }
  };
  const put = (field, match, row) => {
    const old = draft[field];
    const index = old.findIndex(match);
    if (index < 0 && ["findings", "observations"].includes(field) && old.length >= MAX_FINDINGS) {
      throw new Error("每类最多 24 条，请合并或删除同类记录");
    }
    const next = old.slice();
    if (index < 0) next.push(row);
    else next[index] = row;
    if (measuredBytes({ ...draft, [field]: next }) > PROOF_BYTES) throw new Error("当前角色记录超过存储上限，请缩短该项说明");
    draft[field] = next;
  };
  const removals = { findings: new Set(), observations: new Set() };
  for (const [field, inputKey] of [["findings", "removeFindings"], ["observations", "removeObservations"]]) {
    if (input[inputKey] === undefined) continue;
    add(inputKey, undefined, () => {
      const ids = input[inputKey];
      if (!Array.isArray(ids) || ids.length > MAX_FINDINGS || ids.some(id => typeof id !== "string" || !FINDING_ID.test(id))) {
        throw new Error("只接受已有记录编号数组");
      }
      removals[field] = new Set(ids);
    });
  }
  const correctionGroups = ["findings", "observations"];
  // A rejected move keeps the previous row. Explicit removal without a
  // replacement is still possible when the reviewer withdraws a claim.
  const requested = Object.fromEntries(correctionGroups.map(field => [field, new Set(
    (Array.isArray(input[field]) ? input[field] : []).map(row => row?.id).filter(id => typeof id === "string"))]));
  if (input.decisions !== undefined) {
    if (!Array.isArray(input.decisions) || input.decisions.length > RECORD_LIMIT ||
      input.files !== undefined || input.constraints !== undefined || input.architecture !== undefined) {
      errors.push({ field: "decisions", reason: "决策每批最多 32 项，不能与旧版 files、constraints 或 architecture 一并提交" });
    } else {
      const refs = reviewRefs(frame, active, current);
      const byId = new Map(decisionRows(current).map(row => [row.id, row]));
      const recorded = new Set();
      for (const row of input.decisions) {
        const descriptor = byId.get(row?.id);
        if (!descriptor) {
          errors.push({ field: "decisions", id: typeof row?.id === "string" ? row.id : undefined, reason: "使用 pending 中实际变更、必测或章节的编号" });
          continue;
        }
        const { id, kind, value } = descriptor;
        const [field, key, match] = kind === "file" ? ["files", value.path, item => item.file === value.path] :
          kind === "test" ? ["constraints", value, item => item.caseId === value] :
          ["architectureSections", value.heading, item => item.heading === value.heading];
        if (kind === "section") draft.architectureSections ??= [];
        if (recorded.has(id)) {
          errors.push({ field, id: key, reason: "同一批只提交该项一次" });
          continue;
        }
        recorded.add(id);
        // A payload in the wrong format never asserts a replacement verdict.
        // Preserve the accepted current-version row and show exactly what to fix.
        const unknown = Object.keys(row).filter(key => !COMPACT_FIELDS.includes(key));
        if (unknown.length || row.refs !== undefined && (!Array.isArray(row.refs) || row.refs.length > COMPACT_REF_LIMIT)) {
          const previousAccepted = draft[field].some(match);
          const parts = [unknown.length && "删除简表字段 " + unknown.slice(0, 6).join("、"),
            row.refs !== undefined && (!Array.isArray(row.refs) || row.refs.length > COMPACT_REF_LIMIT) &&
              "refs 须是数组，最多六个位置" + (kind === "file" ? "；verified 只选实际注释行" : "")].filter(Boolean);
          errors.push({ field, id: key, decisionId: id, reason: parts.join("；"),
            correction: { code: "compact-decision-shape", allowed: COMPACT_FIELDS, maxRefs: COMPACT_REF_LIMIT, previousAccepted } });
          continue;
        }
        add(field, key, () => {
          put(field, match, checkedDecision(row, descriptor, refs, frame, current, readers));
          if (kind === "section") draft.compactArchitecture = true;
        }, draft[field].some(match));
      }
    }
  }
  for (const [field, cap] of [["files", 256], ["constraints", 80], ["findings", MAX_FINDINGS], ["observations", MAX_FINDINGS]]) {
    const rows = input[field];
    if (rows === undefined) continue;
    const maximum = Math.min(cap, RECORD_LIMIT);
    if (!Array.isArray(rows) || rows.length > maximum) {
      errors.push({ field, reason: "须提供数组，最多 " + maximum + " 项" });
      continue;
    }
    const batch = new Set();
    rows.forEach((row, index) => {
      let id = field === "files" ? row?.file : field === "constraints" ? row?.caseId : row?.id ??
        `${field === "findings" ? "finding" : "observation"}-${digest(JSON.stringify([row?.file, row?.start, row?.end])).slice(0, 14)}`;
      if (field === "files" && typeof id === "string") {
        const canonical = current.changes.find(item => keyOf(item.path) === keyOf(id.replaceAll("\\", "/")));
        if (canonical) id = canonical.path;
      }
      const canReplace = field === "files" ? draft.files.some(item => typeof id === "string" && keyOf(item.file) === keyOf(id)) :
        field === "constraints" ? draft.constraints.some(item => item.caseId === id) :
          field === "findings" && (draft.findings.some(item => item.id === id) ||
            draft.pendingCorrections.some(item => item.field === field && item.id === id));
      add(field, typeof id === "string" ? id : String(index + 1), () => {
        const key = field === "files" ? keyOf(relativeName(id)) : id;
        if (batch.has(key)) throw new Error("同一批记录重复，请只重交此项一份");
        batch.add(key);
        if (field === "files") {
          const change = current.changes.find(item => keyOf(item.path) === key);
          if (!change) throw new Error("只记录 changes 里的实际变更文件，未改文件可作为约束或发现依据");
          put(field, item => keyOf(item.file) === key, checkedFile(row, change, readers));
        } else if (field === "constraints") {
          if (!current.requiredCases.includes(id)) throw new Error("只记录 requiredCases 里的签名新增必测");
          put(field, item => item.caseId === id, checkedConstraint(row, readers));
        } else {
          if (typeof id !== "string" || !FINDING_ID.test(id)) throw new Error("记录 id 须为不超过 48 字符的字母开头编号");
          const other = field === "findings" ? "observations" : "findings";
          if (requested[other].has(id) || removals[field].has(id)) throw new Error("同一编号在本批仅允许一种最终状态");
          if (draft[other].some(item => item.id === id) && !removals[other].has(id)) {
            throw new Error("同一编号已在另一类记录，调整分类时请同时删除原类别编号");
          }
          const pending = field === "findings" && draft.pendingCorrections.find(item => item.field === field && item.id === id)?.correction;
          if (pending && (typeof row?.file !== "string" || keyOf(row.file.replaceAll("\\", "/")) !== keyOf(pending.file) ||
            row.start > pending.end || row.end < pending.start)) {
            throw new Error("请先修正原登记架构位置上的发现，或用 removeFindings 明确撤回后再另行记录其他位置");
          }
          const checked = field === "findings" ? checkedFinding(row, id, readers, active, current, signed, resolveReproduction) :
            checkedObservation(row, id, readers);
          put(field, item => item.id === id, checked);
        }
      }, canReplace);
    });
  }
  for (const [field, other] of [["findings", "observations"], ["observations", "findings"]]) {
    for (const id of removals[field]) {
      if (requested[other].has(id) && (!draft[other].some(row => row.id === id) ||
        errors.some(row => row.field === other && (row.id === id || row.id === undefined)))) continue;
      if (requested[field].has(id)) continue;
      draft[field] = draft[field].filter(row => row.id !== id);
      forgetCorrection(field, id);
    }
  }
  const aliases = current.proseReview && reviewRefs(frame, active, current);
  for (const [field, keyOfRow, check] of [
    ["proseCoverage", row => row?.id, row => checkedProseCoverage(row,
      current.proseReview.blocks.find(item => item.id === row?.id), current, readers, aliases)],
    ["proseFactReview", row => typeof row?.section === "string" && typeof row.id === "string" ? row.section + ":" + row.id : undefined,
      row => checkedProseFactReview(row, current.proseReview)],
  ]) {
    if (input[field] === undefined) continue;
    if (!current.proseReview || !Array.isArray(input[field]) || input[field].length > RECORD_LIMIT) {
      errors.push({ field, reason: "仅逐段核验单元使用此数组，每批最多 32 项" });
      continue;
    }
    const batch = new Set();
    for (const row of input[field]) {
      const key = keyOfRow(row);
      const match = item => keyOfRow(item) === key;
      add(field, typeof key === "string" ? key : undefined, () => {
        if (typeof key !== "string" || batch.has(key)) throw new Error("每个逐段记录须使用真实且唯一的编号");
        batch.add(key);
        put(field, match, check(row));
      }, draft[field].some(match));
    }
  }
  if (input.architecture !== undefined && current.proseReview) {
    errors.push({ field: "architecture", reason: "本单元按 proseCoverage 和 proseFactReview 逐段核验，整节结论由宿主生成" });
  } else if (input.architecture !== undefined) {
    const inputArchitecture = input.architecture;
    if (!record(inputArchitecture, ["status", "basis", "source", "sections"])) {
      errors.push({ field: "architecture", reason: "架构回执须使用已登记的字段" });
    } else {
      if ([inputArchitecture.status, inputArchitecture.basis, inputArchitecture.source].some(value => value !== undefined)) {
        add("architecture", current.architecture?.file, () => {
          const item = checkedArchitecture(inputArchitecture, current, readers);
          if (measuredBytes({ ...draft, architecture: item }) > PROOF_BYTES) throw new Error("架构回执超过剩余存储额度");
          draft.architecture = item;
        }, !!draft.architecture);
      }
      if (inputArchitecture.sections !== undefined) {
        const rows = inputArchitecture.sections;
        if (!Array.isArray(rows) || rows.length > 12) errors.push({ field: "architectureSections", reason: "架构章节须为最多 12 项的数组" });
        else {
          const batch = new Set();
          draft.architectureSections ??= [];
          for (const row of rows) {
            const id = row?.heading;
            add("architectureSections", typeof id === "string" ? id : undefined, () => {
              if (batch.has(id)) throw new Error("同一批只登记该架构章节一次");
              batch.add(id);
              const section = current.architecture?.sections?.find(section => section.heading === id);
              put("architectureSections", item => item.heading === id, checkedArchitectureSection(row, section, current, readers));
            }, draft.architectureSections.some(item => item.heading === id));
          }
        }
      }
    }
  }
  const findingsFailed = errors.some(row => ["findings", "removeFindings"].includes(row.field));
  if (findingsFailed) draft.findingsDone = false;
  else if (input.findingsDone !== undefined) {
    add("findingsDone", undefined, () => {
      if (typeof input.findingsDone !== "boolean") throw new Error("发现完成状态须为布尔值");
      draft.findingsDone = input.findingsDone;
    });
  }
  const progress = reviewProgress(frame, active, current, draft);
  if (progress.architecture === "inconsistent") errors.push({ field: "architecture", id: current.architecture.file,
      reason: compactArchitecture(frame, active, current, draft, progress.proseReview)?.status === "revise" ?
      "revise 须有定位到实际架构稿的发现" : "pass 不能同时保留架构退回项" });
  if (progress.architectureExamples?.passWithMismatch) errors.push({ field: "architecture", id: current.architecture.file,
    reason: "已登记架构示例出现可复现差异，须核对并登记关联的架构退回项" });
  for (const id of progress.unsupportedCaseRevisions ?? []) errors.push({ field: "constraints", id,
    reason: "revise 须关联同一 caseId、同一目标条款的已证实行为退回。若实测符合要求，按原证据更正判断" });
  return { draft, progress, errors };
}

export function recordCodeReview(frame, active, spec, input, signed, { resolveReproduction } = {}) {
  const current = plan(frame, active, spec, signed);
  const { draft, progress, errors } = applyReviewRows(frame, active, current, input, signed, resolveReproduction);
  active.codeReviewDraft = draft;
  frame.changed = true;
  const refs = reviewRefs(frame, active, current);
  return { progress: visibleReviewProgress(progress), errors, next: reviewNext(frame, current, progress, refs) };
}

function reviewNext(frame, current, progress, refs) {
  if (progress.ready) return { tool: "building_loop_code_review", action: "submit" };
  if (progress.architectureExamples?.missing.length) return { tool: "building_loop_code_review", action: "probe", assertion: "architecture" };
  if (progress.responsibilityEvidenceMissing?.length) return { tool: "building_loop_code_review", action: "prepare",
    responsibilityEvidenceMissing: progress.responsibilityEvidenceMissing };
  const rows = pendingReviewRows(frame, current, progress, current.changes, refs).slice(0, RECORD_LIMIT);
  const proseReview = proseSummary(current, progress);
  if (!rows.length && progress.architecture === "missing" && current.architecture && !proseReview?.pendingBlockCount && !proseReview?.pendingFactCount) {
    return { tool: "building_loop_code_review", action: "prepare", read: current.architecture.file };
  }
  if (!rows.length && !progress.findingsDone && !progress.pendingCorrections.length &&
    !proseReview?.pendingBlockCount && !proseReview?.pendingFactCount) {
    return { tool: "building_loop_code_review", action: "record", findingsDone: true };
  }
  const findingCorrections = progress.pendingCorrections.flatMap(({ field, id, correction }) =>
    field === "findings" && correction ? [{ id, ...correction }] : []);
  return { tool: "building_loop_code_review", action: "record",
    ...(rows.length ? { pending: rows } : {}),
    ...(proseReview?.pendingBlockCount || proseReview?.pendingFactCount ? { proseReview } : {}),
    ...(findingCorrections.length ? { findingCorrections } : {}),
    ...(progress.findingsDone ? {} : { findingsDoneRequired: true }) };
}

export class CodeReviewIncomplete extends Error {
  constructor(message, progress, next) {
    super(message);
    this.name = "CodeReviewIncomplete";
    this.progress = progress;
    this.next = next;
  }
}

export function verifyCodeReview(frame, active, spec, signed) {
  const current = plan(frame, active, spec, signed);
  const draft = reviewDraft(frame, active, current.binding);
  const progress = reviewProgress(frame, active, current, draft);
  if (!progress.ready) {
    const missing = [progress.missingFiles.length && "待记录文件 " + progress.missingFiles.join("、"),
      progress.missingCases.length && "待记录必测 " + progress.missingCases.join("、"),
      progress.unsupportedCaseRevisions?.length && "必测 revise 尚未关联同条款的已证实发现 " + progress.unsupportedCaseRevisions.join("、"),
      progress.pendingCorrections.length && "待修正 " + progress.pendingCorrections.map(({field, id}) => id ?? field).join("、"),
      !progress.findingsDone && "发现尚未确认 findingsDone",
      progress.architecture === "missing" && "缺少架构核验",
      progress.missingArchitectureSections?.length && "待记录架构章节 " + progress.missingArchitectureSections.join("、"),
      progress.architectureCodeEvidence === false && "架构核验缺少实际源码依据",
      progress.responsibilityEvidenceMissing?.length && "关键职责未读回 " + progress.responsibilityEvidenceMissing.map(row => row.id).join("、"),
      progress.proseReview?.status === "pending" && "逐段架构核验仍有待核的正文或职责关联，请按 next.proseReview 处理",
      progress.architecture === "inconsistent" && "架构判断与发现不一致",
      progress.architectureExamples?.missing.length && "待复现架构示例 " + progress.architectureExamples.missing.join("、") +
        "，先调用 building_loop_code_review {action:'probe',assertion:'architecture'} 批量核验",
      progress.architectureExamples?.unaddressed.length && "架构示例退回未绑定实际差异 " + progress.architectureExamples.unaddressed.join("、"),
      progress.architectureExamples?.passWithMismatch && "架构判断与实际复现不一致"].filter(Boolean);
    throw new CodeReviewIncomplete("代码核验尚不能提交：" + missing.join("；") + "。用 record 补齐这些项。",
      visibleReviewProgress(progress), reviewNext(frame, current, progress, reviewRefs(frame, active, current)));
  }
  const { files, constraints, findings, observations } = draft;
  const architecture = compactArchitecture(frame, active, current, draft, progress.proseReview);
  const missing = files.some(row => (row.comments ?? [row.comment]).some(item => item.status === "missing"));
  const failing = constraints.some(row => row.status === "revise");
  const proof = { version: 1, actor: frame.agent.id, binding: current.binding, files, constraints, findings,
    ...(observations.length ? { observations } : {}),
    ...(architecture ? { architecture: { ...architecture, sections: proseSectionSummaries(current, draft, progress),
      ...(current.proseReview ? { proseReview: { ...proseSnapshot(current, draft), findings: progress.proseReview.findings } } : {}),
      ...(progress.architectureExamples ? { examples: progress.architectureExamples.rows } : {}) } } : {}),
    decision: missing || failing || findings.length || architecture?.status === "revise" ? "reject" : "pass" };
  // The accepted receipt stores both independent records under the 256 KiB
  // workspace receipt limit. Keep room for the surrounding signed metadata.
  if (measuredBytes(proof) > PROOF_BYTES) throw new Error("代码审查回执超过单角色存储上限，请缩短说明后重试");
  return proof;
}

/** Source locations above are all goal or signed artifact paths. Revalidate
 * those exact versions and the exact signed receipt at review and closure.
 */
export function currentCodeReview(frame, id, active, spec, receipt, independent = false) {
  try {
    if (!isCodeReviewUnit(frame, active, spec) || !receipt?.codeReview) return false;
    const signed = requireCodeRegressionCurrent(frame, id, active, spec, active.goal);
    const architecture = reviewArchitecture(frame, active, false);
    if (signedLocalImportBoundary(frame, spec, active.codeIntake.qualification)) return false;
    if (spec.architecture?.importsHeading && !inspectArchitectureImports(frame, spec, active).match) return false;
    const binding = proofBinding(signed, active.goal, architecture);
    const proseReview = proseReviewInventory(frame, spec, architecture, signed);
    const matches = (proof, actor) => proof?.version === 1 && proof.actor === actor &&
      proof.binding === binding && proof.decision === "pass" &&
      (!architecture || proof.architecture?.status === "pass" && proof.architecture.source?.sha256 === architecture.sha256 &&
        (!proseReview || checkArchitectureProseReceipt(proseReview, proof.architecture.proseReview).status === "pass") &&
        (architecture.sections ?? []).every(section => proof.architecture.sections?.some(row => row.heading === section.heading &&
          row.source?.sha256 === architecture.sha256 && row.source?.start === section.start && row.source?.end === section.end &&
          (proseReview || row.evidence?.length))) && (architecture.examples?.cases ?? []).every(({ id }) =>
          proof.architecture.examples?.some(row => row.id === id && row.outcome === "match" && typeof row.probeId === "string")));
    if (!receipt.reviewer || receipt.reviewer === active.executor || !matches(receipt.codeReview, receipt.reviewer)) return false;
    if (!independent) return true;
    const audit = receipt.independentAudit;
    return !!audit?.auditor && audit.auditor !== receipt.reviewer && audit.auditor !== active.executor &&
      matches(audit.codeReview, audit.auditor);
  } catch { return false; }
}
