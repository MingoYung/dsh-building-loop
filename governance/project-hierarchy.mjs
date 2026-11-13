import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import parser from "./vendor/markdown-parser.cjs";
import { digest, equal, hierarchyBodyPath, includes, keyOf, readBytes, relativeName, replaceWithHistory } from "./policy.mjs";
import { markdownStructure } from "./markdown-structure.mjs";
import { responsibilityClause } from "./architecture-responsibilities.mjs";
import { parseArchitectureRollbackFence } from "./architecture-rollback.mjs";

const { fromMarkdown, gfmFootnoteFromMarkdown, gfmFootnote } = parser;
const options = { extensions: [gfmFootnote()], mdastExtensions: [gfmFootnoteFromMarkdown()] };
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const command = /^(?:请\s*)?新增模块\s+([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\s*[:：]\s*(\S(?:[^\r\n]{0,78}\S)?)$/u;

/** Require the exact module and title from the latest native owner message. */
export function ownerModuleApproval(current, module, title) {
  const match = current?.owner && command.exec(current.text);
  if (!match || match[1] !== module || match[2] !== title || /[\p{Surrogate}\x00-\x1f]/u.test(title)) {
    throw new Error("新增模块须由当前会话所有者明确请求，例如：新增模块 restore-policy：恢复策略");
  }
  return current;
}

/** Read only the module paths already published under this workspace policy. */
export function hierarchyReadPaths(frame) {
  const hierarchy = frame.policy.hierarchy;
  if (!hierarchy || hierarchy.private && !frame.managed) return [];
  return (frame.state.hierarchyModules ?? []).flatMap(entry => {
    if (!hierarchy.private && !Object.hasOwn(hierarchy.modules, entry.id)) return [];
    const file = hierarchyBodyPath(hierarchy, entry.id, frame.managed);
    return typeof entry.path === "string" && keyOf(file) === keyOf(entry.path) ? [file] : [];
  });
}

function headingText(node) {
  const pending = [...node.children].reverse();
  let title = "";
  while (pending.length) {
    const child = pending.pop();
    if (child.type === "text" || child.type === "inlineCode") title += child.value;
    else if (child.children) pending.push(...child.children.slice().reverse());
  }
  return title.trim();
}

function localTarget(file, url) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/iu.test(url)) return undefined;
  try {
    const target = decodeURIComponent(url.split(/[?#]/u, 1)[0]);
    if (!target || target.includes("\\") || target.startsWith("/")) return undefined;
    return relativeName(path.posix.normalize(path.posix.join(path.posix.dirname(file), target)));
  } catch { return undefined; }
}

function hasLinkContext(node) {
  if (["link", "linkReference", "html"].includes(node.type)) return false;
  if (node.type === "text" || node.type === "inlineCode") return /[\p{L}\p{N}]/u.test(node.value);
  return node.children?.some(hasLinkContext) ?? false;
}

function document(file, source) {
  const root = fromMarkdown(source, options);
  const { visible: visibility, htmlHidden } = markdownStructure(source.replace(/^\uFEFF/u, "").split(/\r\n|\n|\r/u));
  const visible = node => visibility[node.position.start.line - 1]?.trim();
  const headings = root.children.filter(node => node.type === "heading" && visible(node)).map(node => ({
    title: headingText(node), depth: node.depth, start: node.position.start.offset, end: node.position.end.offset,
    line: node.position.start.line,
  }));
  const definitions = new Map();
  for (const node of root.children) if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  const links = [];
  const pending = root.children.slice().reverse().map(node => ({ node }));
  while (pending.length) {
    const { node, paragraph } = pending.pop();
    if (["html", "code", "blockquote", "footnoteDefinition"].includes(node.type)) continue;
    if ((node.type === "link" || node.type === "linkReference") && visible(node)) {
      const url = node.type === "link" ? node.url : definitions.get(node.identifier);
      const target = url && localTarget(file, url);
      // A reference attached to authored prose is distinct from a bare link list.
      const explained = paragraph && hasLinkContext(paragraph);
      if (target) links.push({ target, start: node.position.start.offset, url, label: headingText(node),
        from: node.position.start.line, to: node.position.end.line, explained });
    }
    if (node.children) pending.push(...node.children.slice().reverse().map(child => ({ node: child,
      paragraph: node.type === "paragraph" ? node : paragraph })));
  }
  return { file, source, headings, links, htmlHidden };
}

function section(doc, title) {
  const matches = doc.headings.filter(heading => heading.title === title);
  if (matches.length !== 1) throw new Error(`导航文件 ${doc.file} 须有唯一可见章节「${title}」`);
  const heading = matches[0];
  const next = doc.headings.find(item => item.start > heading.start && item.depth <= heading.depth);
  return { ...heading, stop: next?.start ?? doc.source.length };
}

function routeExists(doc, anchor, target) {
  const links = doc.links.filter(link => keyOf(link.target) === keyOf(target));
  if (!links.length) return false;
  if (links.length !== 1 || links[0].start < anchor.end || links[0].start >= anchor.stop) {
    throw new Error(`导航文件 ${doc.file} 中的 ${target} 须唯一且位于「${anchor.title}」章节`);
  }
  return true;
}

/** Resolve the same visible, current goal sentence used by responsibility proofs. */
export function currentArchitectureExampleClause(frame, requirement) {
  return responsibilityClause(frame, { requirement });
}

function goalCoverage(frame, spec, doc, sections) {
  const issues = [], pins = [];
  const clauses = new Map();
  const protectedTitles = [spec.importsHeading, spec.responsibilitiesHeading, spec.examplesHeading,
    spec.rollback?.lockedScope && spec.rollback.heading].filter(Boolean);
  const protectedSections = protectedTitles.filter(title => doc.headings.some(item => item.title === title))
    .map(title => section(doc, title));
  for (const { heading, examples } of spec.goalCoverage) {
    const { start, end } = sections.find(row => row.heading === heading);
    const bounds = section(doc, heading);
    for (const { id, requirement } of examples) {
      const file = requirement.file;
      const first = requirement.start, last = requirement.end;
      const fragment = first === last ? `#L${first}` : `#L${first}-L${last}`;
      const target = path.posix.relative(path.posix.dirname(doc.file), file).split("/").map(encodeURIComponent).join("/");
      const reference = `[${id}](${target}${fragment})`;
      if (!clauses.has(id)) clauses.set(id, currentArchitectureExampleClause(frame, requirement));
      const clause = clauses.get(id);
      // A copied label cannot count when it points to the wrong file or line.
      // Markdown code, quotations, definitions and protected sections are not authored links.
      const link = clause && doc.links.find(link => link.start >= bounds.end && link.start < bounds.stop && link.explained &&
        !protectedSections.some(item => item.start <= link.start && link.start < item.stop) &&
        link.label === id && keyOf(link.target) === keyOf(file) && link.url.endsWith(fragment) &&
        !link.url.slice(0, -fragment.length).includes("?") && !link.url.slice(0, -fragment.length).includes("#") &&
        !doc.htmlHidden.slice(link.from - 1, link.to).some(Boolean));
      if (link) pins.push({ heading, exampleId: id, clause, line: link.from });
      else issues.push({ heading, start, end, exampleId: id, reason: clause ? "missing-reference" : "stale-owner-clause",
        reference, requirement: { file, start: first, end: last } });
    }
  }
  return { issues, pins };
}

function addRoute(doc, anchor, target, label) {
  if (routeExists(doc, anchor, target)) return doc.source;
  const eol = doc.source.includes("\r\n") ? "\r\n" : "\n";
  const actualEnd = doc.source.indexOf("\n", anchor.end);
  const offset = actualEnd === -1 ? doc.source.length : actualEnd + 1;
  const url = path.posix.relative(path.posix.dirname(doc.file), target).split("/").map(encodeURIComponent).join("/");
  const safeLabel = label.replace(/[\\`*_{}\[\]<>]/gu, "\\$&");
  return doc.source.slice(0, offset) + (actualEnd === -1 ? eol : "") + eol + `- [${safeLabel}](${url})` + eol + eol + doc.source.slice(offset);
}

function requiredDocument(root, file) {
  const bytes = readBytes(root, file);
  if (!bytes) throw new Error("缺少已授权的导航文件 " + file);
  return document(file, decoder.decode(bytes));
}

function readableModuleBody(source) {
  return typeof source === "string" && source.trim() && !/[\p{Surrogate}\x00]/u.test(source) &&
    fromMarkdown(source, options).children.some(node => !["html", "definition", "footnoteDefinition"].includes(node.type));
}

const exampleKeys = new Set(["id", "recipe", "stdin", "expectedExitCode", "expectedJson"]);
const exampleBytes = 16 * 1024;

/** Parse the exact visible Markdown fence as data. The runner, its executable,
 * arguments and mounts come from the maintainer's recipe, never this file. */
function architectureExamples(frame, nodes, content, heading, firstLine, diagnostics, ownerExamples) {
  const fence = nodes[0];
  const invalid = message => new Error("架构示例「" + heading + "」" + message);
  if (nodes.length !== 1 || fence.type !== "code" || fence.lang !== "json" || fence.meta !== null) {
    throw invalid("须仅包含一个 json 围栏，说明文字请写在其他章节");
  }
  const lines = content.slice(fence.position.start.offset, fence.position.end.offset).split(/\r\n|\n|\r/u);
  const opener = /^(\x60{3,}|~{3,})[ \t]*json[ \t]*$/u.exec(lines[0])?.[1];
  const closer = /^[ \t]{0,3}(\x60{3,}|~{3,})[ \t]*$/u.exec(lines.at(-1))?.[1];
  if (!opener || !closer || opener[0] !== closer[0] || closer.length < opener.length ||
    Buffer.byteLength(fence.value) > exampleBytes) throw invalid("须完整闭合且 JSON 正文最多 16 KiB");
  let cases;
  try {
    cases = JSON.parse(fence.value, (key, value) => {
      if (!key.isWellFormed() || typeof value === "string" && !value.isWellFormed() ||
        typeof value === "number" && !Number.isFinite(value)) throw invalid("包含无法验证的 JSON 值");
      return value;
    });
  } catch {
    throw invalid("须提供有效且有界的 JSON 数据");
  }
  if (!Array.isArray(cases) || !cases.length || cases.length > 8) throw invalid("须包含 1 至 8 条示例与预期结果");
  const ids = new Set();
  const ownerCases = new Map(ownerExamples?.map(example => [example.id, example]));
  for (const row of cases) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !exampleKeys.has(key)) ||
      typeof row.id !== "string" || (!ownerCases.has(row.id) && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(row.id)) || ids.has(row.id) ||
      !Number.isSafeInteger(row.expectedExitCode) || row.expectedExitCode < 0 || row.expectedExitCode > 0xffffffff) {
      throw invalid("须使用唯一 ID 和明确退出码，且不得包含未登记字段");
    }
    if (Object.hasOwn(row, "expectedJson") && Buffer.byteLength(JSON.stringify(row.expectedJson)) > 2048) {
      throw invalid("预期 JSON 最多 2 KiB");
    }
    const owner = ownerCases.get(row.id);
    // A matching run of an author-selected expectation is not an owner check.
    // Owner cases reuse the registered input; the document can only assert the result.
    if (owner) {
      if (Object.hasOwn(row, "recipe") || Object.hasOwn(row, "stdin") || row.expectedExitCode !== owner.expected.exitCode ||
        !isDeepStrictEqual(row.expectedJson, owner.expected.json)) {
        throw invalid("与维护者登记的预期结果不一致，或试图覆盖固定输入：" + row.id);
      }
    } else {
      if (typeof row.recipe !== "string" || row.recipe === diagnostics?.syntaxRecipe ||
        !diagnostics?.reviewRecipes?.includes(row.recipe)) throw invalid("引用未授权的运行配方");
      if (row.stdin !== undefined && (typeof row.stdin !== "string" || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(row.stdin) ||
        Buffer.byteLength(row.stdin) > 8 * 1024)) throw invalid("stdin 须为不超过 8 KiB 的受限 UTF-8 文本");
    }
    ids.add(row.id);
  }
  const ownerProofs = [...ownerCases].map(([id, { requirement }]) => {
    if (!ids.has(id)) throw invalid("缺少维护者登记的可执行实证：" + id);
    const clause = currentArchitectureExampleClause(frame, requirement);
    if (!clause) throw invalid("维护者登记的目标条款已变化：" + id);
    return { id, clause };
  });
  const result = { heading, start: firstLine + fence.position.start.line - 1, end: firstLine + fence.position.end.line - 1, cases,
    ...(ownerProofs.length ? { ownerProofs } : {}) };
  if (Buffer.byteLength(JSON.stringify(result)) > exampleBytes) throw invalid("登记结果最多 16 KiB");
  return result;
}

/** An architecture checkpoint uses the two visible, unique navigation links and
 * substantive Markdown beneath each maintainer-declared heading. */
export function architectureDocument(frame, spec, diagnostics, { skipRollback = false } = {}) {
  const { file, headings, examplesHeading, rollback: rollbackConfig } = spec;
  const { overview, index } = frame.policy.hierarchy;
  const top = requiredDocument(frame.root, overview.path);
  const middle = requiredDocument(frame.root, index.path);
  if (!routeExists(top, section(top, overview.heading), index.path) ||
      !routeExists(middle, section(middle, index.heading), file)) {
    throw new Error("架构稿须沿唯一的总纲、索引、正文导航定位");
  }
  const bytes = readBytes(frame.root, file);
  if (!bytes) throw new Error("缺少架构正文 " + file);
  const source = decoder.decode(bytes);
  const doc = document(file, source);
  if (spec.responsibilitiesHeading) generatedArchitectureSection(frame, { architecture: spec }, source, "responsibilitiesHeading");
  const sections = [];
  let examples, rollback;
  const bodies = headings.map(title => {
    const anchor = section(doc, title);
    const content = source.slice(anchor.end, anchor.stop);
    const nodes = fromMarkdown(content, options).children;
    if (!skipRollback && title === rollbackConfig?.heading) {
      rollback = parseArchitectureRollbackFence(rollbackConfig, nodes, content,
        source.slice(0, anchor.end).split(/\r\n|\n|\r/u).length, doc.htmlHidden);
    }
    if (title === examplesHeading) {
      examples = architectureExamples(frame, nodes, content, title,
        source.slice(0, anchor.end).split(/\r\n|\n|\r/u).length, diagnostics, spec.ownerExamples);
    }
    const substantive = nodes.filter(node =>
      ["paragraph", "list", "table", "code"].includes(node.type));
    const normalized = substantive.map(node => content.slice(node.position.start.offset, node.position.end.offset).trim().replace(/\s+/gu, " "));
    if (!normalized.length || normalized.every(value => /^(?:[-*+>]\s*)?(?:待填写|待补充|暂无|未填写|TODO|TBD|placeholder|…|\.{3})[。.!！\s]*$/iu.test(value))) {
      throw new Error("架构稿「" + title + "」须写实际内容");
    }
    const next = doc.headings.find(item => item.start === anchor.stop);
    const end = next ? next.line - 1 : source.trimEnd().split(/\r\n|\n|\r/u).length;
    sections.push({ heading: title, start: anchor.line, end });
    // Preserve whitespace inside stdin strings in the meaningful-content
    // digest. Else a goal change could treat different executable inputs as equal.
    return title === examplesHeading ? examples.cases : title === rollbackConfig?.heading && rollback ?
      [normalized, rollback.sha256] : normalized;
  });
  return { file, sha256: digest(bytes), headings, sections, contentsSha256: digest(JSON.stringify(bodies)),
    ...(spec.goalCoverage ? { goalCoverage: goalCoverage(frame, spec, doc, sections) } : {}),
    ...(examples ? { examples } : {}), ...(rollback ? { rollback } : {}) };
}

/** Locate the designated generated section through the same visible-heading parser. */
export function architectureImportsSection(frame, spec, proposed) {
  return generatedArchitectureSection(frame, spec, proposed, "importsHeading");
}

/** Return a unique generated heading's replacement range, without writing. */
export function generatedArchitectureSection(frame, spec, proposed, field) {
  const { file } = spec.architecture;
  const heading = spec.architecture[field];
  const bytes = readBytes(frame.root, file);
  if (!bytes) throw new Error("缺少架构正文 " + file);
  const source = proposed ?? decoder.decode(bytes);
  const doc = document(file, source);
  const anchor = section(doc, heading);
  if (doc.headings.some(heading => heading.start > anchor.start && heading.start < anchor.stop)) {
    throw new Error("宿主生成章节不能包含其他标题，移到同级章节保留正文");
  }
  return { source, sha256: digest(bytes), bodyStart: anchor.end, bodyEnd: anchor.stop };
}

/** Retain literal code spans naming modules inside visible prose only. Quoted
 * examples, fenced code and HTML may contain intentionally false statements. */
export function architectureProseLines(source) {
  const result = new Map();
  const pending = fromMarkdown(source, options).children.map(node => ({ node }));
  const structure = markdownStructure(source.split(/\r\n|\n|\r/u));
  while (pending.length) {
    const { node, parentItem } = pending.pop();
    if (["blockquote", "code", "footnoteDefinition", "definition", "html"].includes(node.type)) continue;
    if (node.type === "paragraph") {
      // Inline Markdown is kept in the line so a backticked filename remains
      // distinguishable from ordinary prose and exact line positions survive.
      const first = node.position.start.line, last = node.position.end.line;
      const lines = source.slice(node.position.start.offset, node.position.end.offset).split(/\r\n|\n|\r/u);
      for (let line = first; line <= last; line++) {
        if (structure.visible[line - 1]?.trim()) result.set(line, [lines[line - first], parentItem]);
      }
    } else if (node.children) {
      const paragraph = node.type === "listItem" && node.children[0]?.type === "paragraph" ? node.children[0] : null;
      const item = paragraph && source.slice(paragraph.position.start.offset, paragraph.position.end.offset).split(/\r\n|\n|\r/u)[0];
      pending.push(...node.children.map(child => ({ node: child, parentItem: child === paragraph ? parentItem : item || parentItem })));
    }
  }
  return [...result].sort(([left], [right]) => left - right).map(([line, [row, parentItem]]) => [line, row, parentItem]);
}

/** Central-file edits can replace one existing section, preserving the route and every other section. */
export function checkHierarchyWrite(frame, file, proposed, requestedHeading) {
  const hierarchy = frame.policy.hierarchy;
  if (!hierarchy || hierarchy.private && !frame.managed) return;
  if (includes(Object.values(hierarchy.modules), file) && !hierarchyReadPaths(frame).some(body => keyOf(body) === keyOf(file))) {
    const current = frame.role === "coordinator" && includes(frame.writes, file) && readBytes(frame.root, file);
    if (!current || !readableModuleBody(decoder.decode(current))) {
      throw new Error("请先用 add-module 同步总纲、索引和正文，不能先单独写模块正文");
    }
    // A maintainer-declared module can predate the host's publication record.
    // Verify both live links on every edit instead of manufacturing that record.
    const { overview, index } = hierarchy;
    const top = requiredDocument(frame.root, overview.path), middle = requiredDocument(frame.root, index.path);
    if (!routeExists(top, section(top, overview.heading), index.path) ||
      !routeExists(middle, section(middle, index.heading), file)) {
      throw new Error("已有模块须保留从总纲经索引到正文的完整导航");
    }
    if (!readableModuleBody(proposed)) throw new Error("模块修改须保留可读的 UTF-8 Markdown 正文");
    return;
  }
  const anchor = [hierarchy.overview, hierarchy.index].find(item => keyOf(item.path) === keyOf(file));
  if (!anchor) return;
  if (/[\p{Surrogate}\x00]/u.test(proposed)) throw new Error("中央文件须保留有效的 UTF-8 正文");
  const before = requiredDocument(frame.root, file), after = document(file, proposed);
  const oldSection = section(before, anchor.heading), newSection = section(after, anchor.heading);
  if (before.source.slice(oldSection.start, oldSection.stop) !== after.source.slice(newSection.start, newSection.stop)) {
    throw new Error("导航章节由 add-module 就地更新，不能直接覆盖");
  }
  if (before.headings.length !== after.headings.length || before.headings.some((heading, i) =>
    before.source.slice(heading.start, heading.end) !== after.source.slice(after.headings[i].start, after.headings[i].end))) {
    throw new Error("中央文件须保留现有标题和顺序，不能在末尾追加或重复章节");
  }
  if (before.source.slice(0, before.headings[0].start) !== after.source.slice(0, after.headings[0].start)) {
    throw new Error("中央文件修改须落在一个已有章节内");
  }
  const changed = before.headings.filter((heading, i) => before.source.slice(heading.end, before.headings[i + 1]?.start) !==
    after.source.slice(after.headings[i].end, after.headings[i + 1]?.start));
  if (changed.length > 1) throw new Error("一次只修改中央文件中对应的一个已有章节");
  if (changed.length && typeof requestedHeading !== "string") throw new Error("中央文件修改须在 heading 填写已有章节标题");
  if (changed.length && section(before, requestedHeading).start !== changed[0].start) {
    throw new Error("改动位置不在 heading 指定的已有章节内");
  }
  const catalogTargets = doc => doc.links.filter(link => keyOf(link.target) === keyOf(hierarchy.index.path) ||
    includes(Object.values(hierarchy.modules), link.target) || hierarchy.private && /^modules\//iu.test(link.target))
    .map(link => keyOf(link.target)).sort();
  if (JSON.stringify(catalogTargets(before)) !== JSON.stringify(catalogTargets(after))) {
    throw new Error("模块的导航链接须由 add-module 同批登记");
  }
}

/** Stage body and both navigation levels with the same rolling history as ordinary writes. */
export function addHierarchyModule(frame, args, approval, note) {
  const hierarchy = frame.policy.hierarchy;
  if (frame.role !== "coordinator" || !hierarchy || hierarchy.private && !frame.managed) throw new Error("当前项目没有授予总控新增模块权限");
  const file = hierarchyBodyPath(hierarchy, args.module, frame.managed);
  const { overview, index } = hierarchy;
  if (!readableModuleBody(args.content)) {
    throw new Error("新增模块须提供可读的 UTF-8 Markdown 正文");
  }
  const current = readBytes(frame.root, file);
  const goalDoc = requiredDocument(frame.root, overview.path), indexDoc = requiredDocument(frame.root, index.path);
  const goalAnchor = section(goalDoc, overview.heading), indexAnchor = section(indexDoc, index.heading);
  const records = frame.state.hierarchyModules ?? [];
  const existing = records.find(item => item.id === args.module);
  if (existing) {
    if (existing.title !== args.title || typeof existing.path !== "string" || keyOf(existing.path) !== keyOf(file) || !current?.equals(Buffer.from(args.content)) ||
      !routeExists(goalDoc, goalAnchor, index.path) || !routeExists(indexDoc, indexAnchor, file)) {
      throw new Error("模块已登记；正文或导航与原登记不同，需要维护者核对");
    }
    return { module: args.module, route: [overview.path, index.path, file], sha256: digest(current), changed: false };
  }
  if (records.length >= 40) throw new Error("三级索引最多登记 40 个新增模块");
  if (current || routeExists(indexDoc, indexAnchor, file)) throw new Error("模块目标或链接已存在，不能覆盖或重复登记");
  const nextOverview = addRoute(goalDoc, goalAnchor, index.path, "项目索引");
  const nextIndex = addRoute(indexDoc, indexAnchor, file, args.title);
  for (const [entry, content, target] of [[overview, nextOverview, index.path], [index, nextIndex, file]]) {
    const projected = document(entry.path, content);
    if (!routeExists(projected, section(projected, entry.heading), target)) throw new Error("三级导航预检失败 " + entry.path);
  }
  const writes = [];
  const tag = `${frame.agent.id}/module/${approval.seq}/${approval.sha256}`;
  const stage = (target, expected) => entries => {
    const version = entries.find(entry => entry.file === target);
    // The navigation was generated from this exact version, even if the history
    // helper saw newer external bytes when it planned the rolling backup.
    if (!version || !equal(version.before, expected)) throw new Error("新增模块期间文件发生外部修改，请核对后重试 " + target);
    writes.push(...entries);
  };
  // Publish the body before either link so even an interrupted filesystem walk never creates a dangling entry.
  const body = replaceWithHistory(frame.root, file, args.content, note, tag, frame.state.markers, stage(file, null));
  const secondary = replaceWithHistory(frame.root, index.path, nextIndex, note, tag, frame.state.markers,
    stage(index.path, Buffer.from(indexDoc.source)));
  if (!body.changed || !secondary.changed) throw new Error("新增模块期间正文或索引已由外部写入，请核对后重试");
  const primary = replaceWithHistory(frame.root, overview.path, nextOverview, note, tag, frame.state.markers,
    stage(overview.path, Buffer.from(goalDoc.source)));
  if (primary.changed !== (nextOverview !== goalDoc.source)) throw new Error("新增模块期间总纲已由外部写入，请核对后重试");
  frame.hierarchyWrites = { module: args.module, writes, overviewSha256: digest(Buffer.from(nextOverview)) };
  frame.state.hierarchyModules = [...records, { id: args.module, title: args.title, path: file }];
  frame.changed = true;
  return { module: args.module, route: [overview.path, index.path, file], sha256: body.sha256, changed: true };
}
