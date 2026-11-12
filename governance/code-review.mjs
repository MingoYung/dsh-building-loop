import { requireCodeRegressionCurrent } from "./code-intake.mjs";
import { expectedClaims } from "./evidence.mjs";
import { digest, includes, isImplementationPath, keyOf, readBytes, relativeName } from "./policy.mjs";
import { lineList } from "./preflight.mjs";

export const CODE_COMMENT_RULE = "必要注释写在非显然的职责、调用方向、跨模块状态、权限、数据保护、回滚或重试边界旁，交代原因与成立条件。改动使旧说明失实时同步更新。核验对照实际控制流和测试证据。";
const BASELINE_LINES = 16000;
const RANGE_LIMIT = 48;
const MAX_FINDINGS = 24;
const PLAN_PAGE_BYTES = 16 * 1024;
const PROOF_BYTES = 96 * 1024;
const KEYS = ["files", "constraints", "findings"];

// Test sources are reviewable even though they cannot qualify as implementation.
const sourceArtifact = file => isImplementationPath("reviewed" + file.slice(file.lastIndexOf(".")));
const locator = {
  type: "object", properties: {
    file: { type: "string" }, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 },
  }, required: ["file", "start", "end"], additionalProperties: false,
};
const brief = { type: "string", minLength: 1, maxLength: 400 };
const COMMENT_QUOTE_RULE = "status=verified 必须填写 quote，从 start–end 范围逐字复制实际源码注释，不含工具行号。missing 和 not-needed 省略 quote。";
const comment = {
  ...locator, properties: { start: locator.properties.start, end: locator.properties.end,
    status: { enum: ["verified", "missing", "not-needed"], description: COMMENT_QUOTE_RULE },
    basis: brief, quote: { ...brief, description: COMMENT_QUOTE_RULE } },
  required: ["start", "end", "status", "basis"],
};
const rows = (maxItems, properties, required = Object.keys(properties)) => ({
  type: "array", maxItems, items: { type: "object", properties, required, additionalProperties: false },
});
export const codeReviewSchema = {
  type: "object", properties: {
    files: rows(256, { file: locator.properties.file, basis: brief, comment }),
    constraints: rows(80, { caseId: { type: "string" }, requirement: locator, code: locator, basis: brief, status: { enum: ["pass", "revise"] } }),
    findings: rows(MAX_FINDINGS, { ...locator.properties, issue: brief, fix: brief }),
  }, required: KEYS, additionalProperties: false,
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

function proofBinding(regression, goal) {
  return digest(JSON.stringify([goal.sha256, regression.suiteSha256, regression.artifactsSha256,
    regression.receiptSha256, regression.baselineReceiptSha256]));
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
  return { binding: proofBinding(regression, active.goal), changes, artifacts,
    requiredCases: active.codeIntake.qualification.requiredCases };
}

/** Only the assigned reviewer sees the current contract, never the other
 * actor's recorded judgment. An audit consumes its own sources and test pins.
 */
export function prepareCodeReview(frame, id, active, spec, offset = 0) {
  const signed = requireCodeRegressionCurrent(frame, id, active, spec, active.goal);
  const { binding, changes, requiredCases } = plan(frame, active, spec, signed);
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
  return { binding, changes: page, changeTotal: changes.length, changeOffset: offset,
    ...(nextOffset < changes.length ? { nextChangePage: { action: "prepare", codeReviewOffset: nextOffset } } : {}),
    requiredCases, signed, goalFiles: active.goal.files.map(({ file }) => file),
    submission: { tool: "building_loop_code_review", action: "submit", fields: {
      files: "[{file,basis,comment:{status,basis,start,end,quote}}]",
      commentQuote: COMMENT_QUOTE_RULE,
      constraints: "[{caseId,requirement:{file,start,end},code:{file,start,end},basis,status}]",
      findings: "[{file,start,end,issue,fix}]",
    } },
    next: "按 changes 的行范围读当前源码，每份变更交一条文件判断和注释核对。每个 requiredCases 用当前目标与实际源码行解释 signed 回归结果覆盖的约束。没有发现填 findings: []。",
    commentRule: CODE_COMMENT_RULE };
}

const record = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => fields.includes(key));

function rationale(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " 缺少具体依据");
  if (value.length > 400) throw new Error(field + " 超过 400 字，当前长度 " + value.length);
  return value.trim();
}

function observed(frame, active, row, paths) {
  const file = relativeName(row?.file);
  const { start, end } = row;
  if (!includes(paths, file) || !includes(frame.reads, file)) throw new Error("代码审查位置须属于已授权工件或当前目标");
  const bytes = readBytes(frame.root, file);
  const lines = bytes && lineList(bytes);
  const seen = active.seen?.[keyOf(file)];
  if (!lines || seen?.hash !== digest(bytes) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 1 || end < start || end > lines.length || !seen.ranges.some(([a, b]) => a <= start && b >= end)) {
    throw new Error("请先读取当前版本的代码审查位置 " + file + " 第 " + start + "–" + end + " 行");
  }
  return { file, start, end, sha256: seen.hash };
}

export function verifyCodeReview(frame, active, spec, input, signed) {
  const { binding, changes, artifacts, requiredCases } = plan(frame, active, spec, signed);
  if (!record(input, KEYS) || !Array.isArray(input.files) || input.files.length !== changes.length ||
    !Array.isArray(input.constraints) || input.constraints.length !== requiredCases.length ||
    !Array.isArray(input.findings) || input.findings.length > MAX_FINDINGS) {
    throw new Error("代码审查需提交每份变更源码、每项签名新增必测和 findings 数组");
  }
  const sources = artifacts.filter(row => row.sha256 && sourceArtifact(row.path)).map(row => row.path);
  const goals = active.goal.files.map(({ file }) => file);
  const byFile = new Map();
  for (const row of input.files) {
    if (!record(row, ["file", "basis", "comment"])) throw new Error("代码文件审查记录无效");
    const file = relativeName(row.file);
    const current = changes.find(change => keyOf(change.path) === keyOf(file));
    const annotation = row.comment;
    if (!current || byFile.has(keyOf(file)) || !record(annotation, ["status", "basis", "start", "end", "quote"]) ||
      !["verified", "missing", "not-needed"].includes(annotation.status)) throw new Error("代码审查须逐份登记变更文件及注释判断");
    for (const { start, end } of current.ranges) observed(frame, active, { file, start, end }, sources);
    const ref = observed(frame, active, { file, start: annotation.start, end: annotation.end }, sources);
    if (annotation.status === "verified") {
      if (typeof annotation.quote !== "string" || !annotation.quote.trim() || annotation.quote.length > 400) {
        throw new Error(file + " 的 comment.quote 无效。" + COMMENT_QUOTE_RULE + " quote 限 400 字。");
      }
      if (!lineList(readBytes(frame.root, file)).slice(ref.start - 1, ref.end).join("\n").includes(annotation.quote)) {
        throw new Error(file + " 的 comment.quote 须逐字定位到当前已读源码。" + COMMENT_QUOTE_RULE);
      }
    } else if (annotation.quote !== undefined) throw new Error(file + " 的 comment.quote 须省略。" + COMMENT_QUOTE_RULE);
    byFile.set(keyOf(file), { file: current.path, basis: rationale(row.basis, file + " 的 files.basis"),
      comment: { ...ref, status: annotation.status, basis: rationale(annotation.basis, file + " 的 comment.basis"),
        ...(annotation.quote === undefined ? {} : { quote: annotation.quote }) } });
  }
  const seenCases = new Set();
  const constraints = input.constraints.map(row => {
    if (!record(row, ["caseId", "requirement", "code", "basis", "status"]) || seenCases.has(row.caseId) ||
      !requiredCases.includes(row.caseId) || !["pass", "revise"].includes(row.status) ||
      !record(row.requirement, ["file", "start", "end"]) || !record(row.code, ["file", "start", "end"])) {
      throw new Error("代码审查约束须逐项绑定当前签名新增必测、目标原文和源码位置");
    }
    seenCases.add(row.caseId);
    return { caseId: row.caseId, status: row.status, requirement: observed(frame, active, row.requirement, goals),
      code: observed(frame, active, row.code, sources), basis: rationale(row.basis, row.caseId + " 的 constraints.basis") };
  });
  const findings = input.findings.map((row, index) => {
    if (!record(row, ["file", "start", "end", "issue", "fix"])) throw new Error("代码审查问题须指向可核对的实际位置");
    return { ...observed(frame, active, row, [...goals, ...sources]),
      issue: rationale(row.issue, `findings[${index}].issue`), fix: rationale(row.fix, `findings[${index}].fix`) };
  });
  const files = [...byFile.values()];
  const missing = files.filter(row => row.comment.status === "missing");
  const failing = constraints.filter(row => row.status === "revise");
  const proof = { version: 1, actor: frame.agent.id, binding, files, constraints, findings,
    decision: missing.length || failing.length || findings.length ? "reject" : "pass" };
  // The accepted receipt stores both independent records under the 256 KiB
  // workspace receipt limit. Keep room for the surrounding signed metadata.
  if (Buffer.byteLength(JSON.stringify(proof)) > PROOF_BYTES) throw new Error("代码审查回执超过单角色存储上限，请缩短说明后重试");
  return proof;
}

/** Source locations above are all goal or signed artifact paths. Revalidate
 * those exact versions and the exact signed receipt at review and closure.
 */
export function currentCodeReview(frame, id, active, spec, receipt, independent = false) {
  try {
    if (!isCodeReviewUnit(frame, active, spec) || !receipt?.codeReview) return false;
    const signed = requireCodeRegressionCurrent(frame, id, active, spec, active.goal);
    const binding = proofBinding(signed, active.goal);
    const matches = (proof, actor) => proof?.version === 1 && proof.actor === actor &&
      proof.binding === binding && proof.decision === "pass";
    if (!receipt.reviewer || receipt.reviewer === active.executor || !matches(receipt.codeReview, receipt.reviewer)) return false;
    if (!independent) return true;
    const audit = receipt.independentAudit;
    return !!audit?.auditor && audit.auditor !== receipt.reviewer && audit.auditor !== active.executor &&
      matches(audit.codeReview, audit.auditor);
  } catch { return false; }
}
