import path from "node:path";
import { requireCodeRegressionCurrent } from "./code-intake.mjs";
import { expectedClaims } from "./evidence.mjs";
import { digest, includes, isImplementationPath, keyOf, readBytes, relativeName } from "./policy.mjs";
import { lineList } from "./preflight.mjs";
import { architectureImportsSection } from "./project-hierarchy.mjs";
import { parser as pythonParser } from "./vendor/python-parser.cjs";

export const CODE_COMMENT_RULE = "必要注释写在非显然的职责、调用方向、跨模块状态、权限、数据保护、回滚或重试边界旁，交代原因与成立条件。改动使旧说明失实时同步更新。核验对照实际控制流和测试证据。";
const BASELINE_LINES = 16000;
const RANGE_LIMIT = 48;
const MAX_FINDINGS = 24;
const PLAN_PAGE_BYTES = 16 * 1024;
const PROOF_BYTES = 96 * 1024;
const RECORD_LIMIT = 32;
const KEYS = ["files", "constraints", "findings", "architecture"];
const RECORD_KEYS = [...KEYS, "removeFindings", "findingsDone"];
const FINDING_KINDS = ["behavior", "maintenance", "annotation", "architecture"];
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
    basis: brief, quote: { ...brief, description: COMMENT_QUOTE_RULE } },
  required: ["start", "end", "status", "basis"],
};
const rows = (maxItems, properties, required = Object.keys(properties)) => ({
  type: "array", maxItems, items: { type: "object", properties, required, additionalProperties: false },
});
const judgment = { enum: ["pass", "revise"] };
const findingId = { type: "string", pattern: FINDING_ID.source };
const evidenceLocation = { ...locator, properties: { ...locator.properties,
  relation: { enum: EVIDENCE_RELATIONS, description: "相对 issue 的关系。证据支持、指出反例或可复现该问题。" },
  quote: { ...brief, description: "可省略。填写时逐字定位到该范围。" },
}, required: [...locator.required, "relation"] };
const architectureSections = rows(12, { heading: { type: "string" }, basis: brief,
  evidence: { type: "array", minItems: 1, maxItems: 4, items: evidenceLocation } });
const architecture = { type: "object", properties: { status: judgment, basis: brief, source: locator, sections: architectureSections },
  additionalProperties: false };
export const codeReviewSchema = {
  type: "object", properties: {
    files: rows(256, { file: locator.properties.file, basis: brief, comment, comments: { type: "array", maxItems: 6, items: comment } }, ["file", "basis"]),
    constraints: rows(80, { caseId: { type: "string" }, requirement: locator, code: locator, basis: brief, status: judgment }),
    findings: rows(MAX_FINDINGS, { ...locator.properties, id: findingId, kind: { enum: FINDING_KINDS },
      observation: brief, issue: brief, fix: brief, caseId: { type: "string", description: "可选，引用当前签名回归中的具体用例。" },
      evidence: { type: "array", minItems: 1, maxItems: 4, items: evidenceLocation },
    }, ["file", "start", "end", "kind", "observation", "issue", "fix", "evidence"]),
    architecture,
    removeFindings: { type: "array", maxItems: MAX_FINDINGS, items: findingId },
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
    ...(architecture ? [[architecture.file, architecture.sha256, architecture.headings]] : [])]));
}

function reviewArchitecture(frame, active, requireReadGrant) {
  const architecture = active.engineeringArchitecture;
  if (!architecture) return;
  if (requireReadGrant && !includes(frame.reads, architecture.file)) throw new Error("当前角色没有架构稿精确读授权");
  const bytes = readBytes(frame.root, architecture.file);
  if (!bytes || digest(bytes) !== architecture.sha256) throw new Error("架构稿在派审后已变化，请总控重新核验当前稿");
  return architecture;
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
  if (spec.architecture?.importsHeading && !inspectArchitectureImports(frame, spec, active).match) {
    throw new Error("架构稿中的静态依赖章节与当前签名源码不一致，须由总控同步");
  }
  return { binding: proofBinding(regression, active.goal, architecture), changes, artifacts, architecture,
    requiredCases: active.codeIntake.qualification.requiredCases };
}

/** Import facts supplement the actual review reads. Exact signed local files are
 * resolved when the explicit statement unambiguously names them. */
function pythonImportEvidence(frame, artifacts) {
  const files = artifacts.filter(row => row.sha256 && /\.py$/iu.test(row.path));
  const local = new Map(files.filter(row => includes(frame.reads, row.path)).map(({ path }) => [keyOf(path), path]));
  const checkedFiles = [], unparsedFiles = [], edges = [], ambiguous = [];
  let truncated = false;
  const add = (file, node, source) => {
    const tokens = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== "Comment") tokens.push(source.slice(child.from, child.to));
    }
    const split = tokens.indexOf("import");
    const members = tokens.slice(split + 1).join(" ").split(",").map(value => value.trim()
      .replace(/^[()]\s*|\s*[()]$/gu, "").split(/\s+as\s+/u, 1)[0].replaceAll(" ", ""));
    const from = tokens[0] === "from" ? tokens.slice(1, split).join("") : "";
    const prefix = /^\.+/u.exec(from)?.[0] ?? "";
    const depth = prefix.length, module = from.slice(depth);
    const directory = depth ? path.posix.join(path.posix.dirname(file), ...Array(depth - 1).fill("..")) : ".";
    if (directory === ".." || directory.startsWith("../")) return;
    const modulePath = module.replaceAll(".", "/");
    const names = from ? modulePath ? [modulePath] : members.filter(name => name !== "*") :
      members.map(name => name.replaceAll(".", "/"));
    const imports = new Set();
    for (const name of names.filter(value => /^[\p{ID_Start}_][\p{ID_Continue}\/]*$/u.test(value))) {
      const base = path.posix.join(directory, name);
      const candidates = [base + ".py", path.posix.join(base, "__init__.py")].map(value => local.get(keyOf(value))).filter(Boolean);
      if (candidates.length === 1 && candidates[0] !== file) imports.add(candidates[0]);
      if (candidates.length > 1 && ambiguous.length < 64) ambiguous.push({ file, module: name });
    }
    if (!imports.size) return;
    const line = source.slice(0, node.from).split("\n").length;
    if (edges.length < 64) edges.push({ file, line, imports: [...imports] });
    else truncated = true;
  };
  for (const { path: file, sha256 } of files) {
    if (!includes(frame.reads, file)) continue;
    if (checkedFiles.length + unparsedFiles.length >= 64) { truncated = true; break; }
    const bytes = readBytes(frame.root, file);
    if (!bytes || digest(bytes) !== sha256) throw new Error("已签名源码已变化：" + file);
    const source = lineList(bytes).join("\n"), tree = pythonParser.parse(source);
    const nodes = [];
    let invalid = false;
    tree.iterate({ enter(node) {
      if (node.type.isError) invalid = true;
      if (node.name === "ImportStatement") nodes.push(node.node);
    } });
    if (invalid) unparsedFiles.push(file);
    else {
      checkedFiles.push(file);
      for (const node of nodes) add(file, node, source);
    }
  }
  return { kind: "python-static-local", checkedFiles, unparsedFiles, edges, ambiguous, truncated,
    scope: "只列已签名且获准读取的 Python 源码中可定位的本地静态 import。动态导入、外部包和运行路径仍由核验方判断。" };
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
  const graph = pythonImportEvidence({ root: frame.root, reads: paths }, artifacts);
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
  return { heading, expected, current, match, proposed, bodyStart, bodyEnd, sha256 };
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
  return { binding, changes: page, changeTotal: changes.length, changeOffset: offset,
    ...(nextOffset < changes.length ? { nextChangePage: { action: "prepare", codeReviewOffset: nextOffset } } : {}),
    requiredCases, signed, goalFiles: active.goal.files.map(({ file }) => file),
    ...(architecture ? { architecture, imports: pythonImportEvidence(frame, current.artifacts) } : {}),
    progress: reviewProgress(current, reviewDraft(frame, active, binding)),
    submission: { tool: "building_loop_code_review", action: "record", fields: {
      files: "[{file,basis,comment:{status,basis,start,end}}]；同一文件有多个注释用 comments 数组替代 comment",
      commentQuote: COMMENT_QUOTE_RULE,
      constraints: "[{caseId,requirement:{file,start,end},code:{file,start,end},basis,status}]",
      findings: "[{id,kind,file,start,end,observation,issue,fix,evidence:[{file,start,end,relation}]}]；relation=supports|contradicts|reproduces；用相同 id 修正，removeFindings 删除",
      ...(architecture ? { architecture: "{status,basis,source:{file,start,end},sections:[{heading,basis,evidence:[{file,start,end,relation}]}]}；逐标题分批补，保留其他已登记段" } : {}),
    } },
    next: "用 record 分批记改动文件、签名必测和发现，只补错项或缺项。发现先写实际观察，沿控制流核对调用、使用和边界。查找与该判断相反的源码，发现反证时先缩小或撤销主张。evidence 定位已读佐证及反证。" +
      (architecture ? "完整读架构稿，按 architecture.sections 逐节登记判断，对照当前要求和实际代码，涉及依赖时用 imports 提示查源码。" : "") +
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

/** Python review pins real lexer comments and docstrings, so a '#' inside a
 * string cannot become proof. For other languages the host pins actual source
 * and leaves annotation classification to the independent reviewers. */
function codeAnnotation(file, lines, start, end) {
  const span = lines.slice(start - 1, end).join("\n");
  if (!/\.py$/iu.test(file)) return span;
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
    if (!record(item, ["status", "basis", "start", "end", "quote"]) ||
      !["verified", "missing", "not-needed"].includes(item.status)) throw new Error(file + " 的注释判断无效");
    const where = { file, start: item.start, end: item.end };
    const label = file + (row.comments ? ` 的 comments[${index}]` : " 的 comment");
    let annotationSha256, quote;
    const ref = readers.read(where, readers.sources, lines => {
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
    const location = `${ref.start}:${ref.end}`;
    if (positions.has(location)) throw new Error(label + " 重复引用同一范围，请合并说明");
    positions.add(location);
    return { ...ref, status: item.status, basis: rationale(item.basis, label + ".basis"),
      ...(annotationSha256 ? { annotationSha256 } : {}), ...(quote === undefined ? {} : { quote }) };
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

function checkedFinding(row, id, readers, active) {
  if (!record(row, [...locatorKeys, "id", "kind", "observation", "issue", "fix", "evidence", "caseId"])) {
    throw new Error("代码审查问题须指向可核对的实际位置");
  }
  const ref = readers.read(row, readers.all);
  const owner = includes(readers.architecturePaths, ref.file) ? "coordinator" : "executor";
  const answer = { ...ref, id, owner, issue: rationale(row.issue, id + ".issue"), fix: rationale(row.fix, id + ".fix") };
  if (!FINDING_KINDS.includes(row.kind) || (row.kind === "architecture") !== (owner === "coordinator")) {
    throw new Error("架构发现须以已授权架构稿为位置；其余发现用 behavior、maintenance 或 annotation");
  }
  const evidence = checkedEvidence(row.evidence, readers, readers.all);
  if (!evidence.some(item => item.relation !== "contradicts")) throw new Error("发现缺少支持或复现该问题的定位，请核对观察");
  if (owner === "executor" && ![ref, ...evidence].some(item => includes(readers.sources, item.file))) {
    throw new Error("代码发现须有实际源码依据，不能仅引用目标说明");
  }
  const caseResult = row.caseId === undefined ? undefined : active.codeIntake.qualification.cases?.find(item => item.id === row.caseId);
  if (row.caseId !== undefined && !caseResult) throw new Error("caseId 须为当前签名回执内的实际用例编号");
  return { ...answer, kind: row.kind, observation: rationale(row.observation, id + ".observation"), evidence,
    ...(caseResult ? { signedCase: { id: caseResult.id, status: caseResult.status } } : {}) };
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

/** Save only the actor's own validated rows for this activation and exact proof
 * input. In particular, the auditor cannot inherit the first reviewer's draft. */
function reviewDraft(frame, active, binding) {
  const identity = { actor: frame.agent.id, role: frame.role, serial: active.serial, binding };
  const saved = active.codeReviewDraft;
  if (saved && Object.keys(identity).every(key => saved[key] === identity[key])) return saved;
  return { ...identity, files: [], constraints: [], findings: [], findingsDone: false, pendingCorrections: [] };
}

function reviewProgress(current, draft) {
  const recordedFiles = new Set(draft.files.map(row => keyOf(row.file)));
  const recordedCases = new Set(draft.constraints.map(row => row.caseId));
  const missingFiles = current.changes.filter(change => !recordedFiles.has(keyOf(change.path))).map(change => change.path);
  const missingCases = current.requiredCases.filter(id => !recordedCases.has(id));
  const findingIds = draft.findings.map(row => row.id);
  const pendingCorrections = draft.pendingCorrections;
  const sections = draft.architectureSections ?? [];
  const missingArchitectureSections = (current.architecture?.sections ?? []).filter(section =>
    !sections.some(row => row.heading === section.heading)).map(row => row.heading);
  const candidatePaths = current.artifacts.filter(row => sourceArtifact(row.path)).map(row => row.path);
  const architectureCodeEvidence = !current.architecture || !current.architecture.sections?.length ||
    sections.some(row => row.evidence.some(item => item.relation !== "contradicts" && includes(candidatePaths, item.file)));
  const architectureIssue = draft.architecture && draft.findingsDone &&
    ((draft.architecture.status === "revise") !== draft.findings.some(row => row.owner === "coordinator"));
  const architecture = current.architecture ? draft.architecture ? architectureIssue ? "inconsistent" : "recorded" : "missing" : "not-required";
  return { missingFiles, missingCases, findingIds, findingsDone: draft.findingsDone, architecture, pendingCorrections,
    ...(current.architecture ? { missingArchitectureSections, architectureCodeEvidence } : {}),
    ready: !missingFiles.length && !missingCases.length && !pendingCorrections.length && draft.findingsDone &&
      !missingArchitectureSections.length && architectureCodeEvidence && !["missing", "inconsistent"].includes(architecture) };
}

const measuredBytes = value => Buffer.byteLength(JSON.stringify(value));

function applyReviewRows(frame, active, current, input) {
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
      const item = { field, id, reason: error.message };
      errors.push(item);
      if (canReplace) {
        forgetCorrection(field, id);
        draft.pendingCorrections.push({ field, id });
      }
    }
  };
  const put = (field, match, row) => {
    const old = draft[field];
    const index = old.findIndex(match);
    if (index < 0 && field === "findings" && old.length >= MAX_FINDINGS) throw new Error("发现最多 24 条，请合并或删除同类发现");
    const next = old.slice();
    if (index < 0) next.push(row);
    else next[index] = row;
    if (measuredBytes({ ...draft, [field]: next }) > PROOF_BYTES) throw new Error("当前角色记录超过存储上限，请缩短该项说明");
    draft[field] = next;
  };
  for (const [field, cap] of [["files", 256], ["constraints", 80], ["findings", MAX_FINDINGS]]) {
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
        `finding-${digest(JSON.stringify([row?.file, row?.start, row?.end])).slice(0, 14)}`;
      if (field === "files" && typeof id === "string") {
        const canonical = current.changes.find(item => keyOf(item.path) === keyOf(id.replaceAll("\\", "/")));
        if (canonical) id = canonical.path;
      }
      const canReplace = field === "files" ? draft.files.some(item => typeof id === "string" && keyOf(item.file) === keyOf(id)) :
        field === "constraints" ? draft.constraints.some(item => item.caseId === id) : draft.findings.some(item => item.id === id);
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
          if (typeof id !== "string" || !FINDING_ID.test(id)) throw new Error("发现 id 须为不超过 48 字符的字母开头编号");
          put(field, item => item.id === id, checkedFinding(row, id, readers, active));
        }
      }, canReplace);
    });
  }
  if (input.removeFindings !== undefined) {
    add("removeFindings", undefined, () => {
      const ids = input.removeFindings;
      if (!Array.isArray(ids) || ids.length > MAX_FINDINGS || ids.some(id => typeof id !== "string" || !FINDING_ID.test(id))) {
        throw new Error("只接受已有发现编号数组");
      }
      draft.findings = draft.findings.filter(row => !ids.includes(row.id));
      for (const id of ids) forgetCorrection("findings", id);
    });
  }
  if (input.architecture !== undefined) {
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
  const progress = reviewProgress(current, draft);
  if (progress.architecture === "inconsistent") errors.push({ field: "architecture", id: current.architecture.file,
    reason: draft.architecture.status === "revise" ? "revise 须有定位到实际架构稿的发现" : "pass 不能同时保留架构退回项" });
  return { draft, progress, errors };
}

export function recordCodeReview(frame, active, spec, input, signed) {
  const current = plan(frame, active, spec, signed);
  const { draft, progress, errors } = applyReviewRows(frame, active, current, input);
  active.codeReviewDraft = draft;
  frame.changed = true;
  return { progress, errors };
}

export function verifyCodeReview(frame, active, spec, signed) {
  const current = plan(frame, active, spec, signed);
  const draft = reviewDraft(frame, active, current.binding);
  const progress = reviewProgress(current, draft);
  if (!progress.ready) {
    const missing = [progress.missingFiles.length && "待记录文件 " + progress.missingFiles.join("、"),
      progress.missingCases.length && "待记录必测 " + progress.missingCases.join("、"),
      progress.pendingCorrections.length && "待修正 " + progress.pendingCorrections.map(({field, id}) => id ?? field).join("、"),
      !progress.findingsDone && "发现尚未确认 findingsDone",
      progress.architecture === "missing" && "缺少架构核验",
      progress.missingArchitectureSections?.length && "待记录架构章节 " + progress.missingArchitectureSections.join("、"),
      progress.architectureCodeEvidence === false && "架构核验缺少实际源码依据",
      progress.architecture === "inconsistent" && "架构判断与发现不一致"].filter(Boolean);
    throw new Error("代码核验尚不能提交：" + missing.join("；") + "。用 record 补齐这些项。");
  }
  const { files, constraints, findings, architecture } = draft;
  const missing = files.some(row => (row.comments ?? [row.comment]).some(item => item.status === "missing"));
  const failing = constraints.some(row => row.status === "revise");
  const proof = { version: 1, actor: frame.agent.id, binding: current.binding, files, constraints, findings,
    ...(architecture ? { architecture: { ...architecture, sections: draft.architectureSections ?? [] } } : {}),
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
    if (spec.architecture?.importsHeading && !inspectArchitectureImports(frame, spec, active).match) return false;
    const binding = proofBinding(signed, active.goal, architecture);
    const matches = (proof, actor) => proof?.version === 1 && proof.actor === actor &&
      proof.binding === binding && proof.decision === "pass" &&
      (!architecture || proof.architecture?.status === "pass" && proof.architecture.source?.sha256 === architecture.sha256 &&
        (architecture.sections ?? []).every(section => proof.architecture.sections?.some(row => row.heading === section.heading &&
          row.source?.sha256 === architecture.sha256 && row.source?.start === section.start && row.source?.end === section.end &&
          row.evidence?.length)));
    if (!receipt.reviewer || receipt.reviewer === active.executor || !matches(receipt.codeReview, receipt.reviewer)) return false;
    if (!independent) return true;
    const audit = receipt.independentAudit;
    return !!audit?.auditor && audit.auditor !== receipt.reviewer && audit.auditor !== active.executor &&
      matches(audit.codeReview, audit.auditor);
  } catch { return false; }
}
