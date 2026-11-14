import parser from "./vendor/markdown-parser.cjs";
import { markdownStructure } from "./markdown-structure.mjs";
import { digest } from "./policy.mjs";

const { fromMarkdown, gfmFootnoteFromMarkdown, gfmFootnote } = parser;
const options = { extensions: [gfmFootnote()], mdastExtensions: [gfmFootnoteFromMarkdown()] };
const ignored = new Set(["blockquote", "code", "definition", "footnoteDefinition", "html"]);
export const PROSE_REVIEW_STATUSES = ["plan", "no-current-claim", "consistent", "contradiction", "insufficient"];
const statuses = new Set(PROSE_REVIEW_STATUSES);
const factId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;
const factAnchor = "#bl-fact-";
const MAX_BLOCKS = 128;
const MAX_FACTS = 8;
const MAX_SOURCE_BYTES = 256 * 1024;
const sourceName = String.raw`(?:[\p{L}\p{N}_.-]+/)*[\p{L}\p{N}_.-]+\.py`;
const roleTitle = new RegExp(String.raw`^(?:(${sourceName})|[^()（）:：\n]{1,80}[（(](${sourceName})[）)])$`, "u");
const bareRole = new RegExp(String.raw`^(${sourceName})\s*[:：]`, "u");
const clauseBreak = /[。！？!?；;]|\.(?=\s|$)/u;
const nonCurrent = /(?:计划|拟由|拟将|将来|未来|待改|建议|如果|假设|示例|举例|例如|比如|反例|原先|旧版|历史|误写|不在此|并非|不由本|不负责|不(?:会)?(?:拦截|拒绝|校验|判定)|可能|回退|兜底|透传|转发|下游|经由|间接|委托|\b(?:plans?|planned|proposals?|examples?|formerly|previously|instead|would|will|should|might|could|if|never|not|fallback|pass[- ]?through|forward\w*|delegat\w*|via)\b)/iu;
const nonCurrentHeading = /(?:计划|规划示例|举例|示例|反例|草案|提案|\b(?:plans?|planned|examples?|proposals?|draft)\b)/iu;
const localDecision = /(?:(?:在此(?:处)?|由(?:该|本|此)(?:模块|文件|层))\s*(?:直接)?\s*(?:拦截|拒绝|校验|判定)(?:该(?:请求|输入))?\s*[，,]\s*(?:对应|详见|参见)|(?:\b(?:rejected|validated|decided)\s+here|\bthis\s+(?:module|file|layer)\s+(?:rejects|validates|decides)\s+(?:it|the\s+(?:request|input)))\s*,\s*(?:per|see|as\s+specified\s+by))\s*$/iu;
const emission = /(?:返回|抛出|给出|\b(?:returns?|raises?|emits?))\s*$/iu;
const MAX_TYPED_CLAUSE = 240;
const moduleToken = String.raw`(?:${sourceName}|[\p{ID_Start}_][\p{ID_Continue}]*)`;
const moduleDescription = String.raw`(?:\s*[（(]([^()（）:：\n]{1,80})[）)])?`;
const modulePrefix = new RegExp(String.raw`^(${moduleToken})${moduleDescription}\s*[:：]\s*`, "u");
const moduleTitle = new RegExp(String.raw`^(${moduleToken})${moduleDescription}$`, "u");
const rootTypes = new Map(Object.entries({ 对象: "object", 数组: "array", 字符串: "string", 整数: "integer", 布尔值: "boolean", 空值: "null",
  object: "object", array: "array", string: "string", integer: "integer", boolean: "boolean", null: "null" }));
const chineseType = /^(?:当\s*)?(?:请求|输入|参数|根值|顶层(?:值)?)\s*(不(?:是|为|属于)|非|是|为|属于)\s*(?:JSON\s*)?(对象|数组|字符串|整数|布尔值|空值|null)\s*(?:时|则)?\s*(?:[，,]\s*)?(?:直接\s*)?(?:返回|抛出|给出|报出)\s*$/iu;
const englishType = /^(?:when|if)\s+(?:the\s+)?(?:input|request|argument|root(?:\s+value)?)\s+is\s+(?:(not)\s+)?(?:an?\s+)?(?:json\s+)?(object|array|string|integer|boolean|null)\s*,?\s+(?:directly\s+)?(?:returns?|raises?|emits?)\s*$/iu;
const chineseField = /^(?:当\s*)?(?:请求|输入|对象)\s*(缺少|缺失|包含|存在)\s*(?:字段\s*)?`([\p{ID_Start}_][\p{ID_Continue}-]*)`\s*(?:字段)?\s*(?:时|则)?\s*(?:[，,]\s*)?(?:直接\s*)?(?:返回|抛出|给出|报出)\s*$/u;
const englishField = /^(?:when|if)\s+(?:the\s+)?(?:request|input|object)\s+(lacks|contains|is missing)\s+(?:the\s+)?(?:field\s+)?`([\p{ID_Start}_][\p{ID_Continue}-]*)`\s*,?\s+(?:directly\s+)?(?:returns?|raises?|emits?)\s*$/iu;
const quoteEnds = new Map([["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ['"', '"']]);

function headingTitle(node) {
  const leaves = [...node.children];
  let title = "";
  while (leaves.length) {
    const child = leaves.shift();
    if (child.type === "text" || child.type === "inlineCode") title += child.value;
    else if (child.children) leaves.unshift(...child.children);
  }
  return title.trim();
}

function responsibilityReference(node, definitions) {
  const url = node.type === "link" ? node.url :
    node.type === "linkReference" ? definitions.get(node.identifier)?.url : undefined;
  return url?.startsWith(factAnchor) ? url.slice(factAnchor.length) : undefined;
}

function references(node, definitions, referencedDefinitions) {
  const pending = [...(node.children ?? [])];
  const refs = new Set();
  while (pending.length) {
    const child = pending.pop();
    const id = responsibilityReference(child, definitions);
    if (id !== undefined) {
      refs.add(id);
      const definition = child.type === "linkReference" && definitions.get(child.identifier);
      if (definition) referencedDefinitions?.add(definition);
    }
    if (child.children) pending.push(...child.children);
  }
  return [...refs].sort();
}

/** Repair an exceptional line-scoped link without altering surrounding text
 * or a declared heading's rendered title. */
export function architectureLinkReplacementOnly(before, after, unknownIds, knownIds) {
  const marker = /(#bl-fact-)([^\s<>()\]]+)/gu;
  const unknown = new Set(unknownIds);
  const known = new Set(knownIds);
  const original = [...before.matchAll(marker)].map(match => match[2]);
  const proposed = [...after.matchAll(marker)].map(match => match[2]);
  return original.length === proposed.length && before.replace(marker, "$1") === after.replace(marker, "$1") &&
    original.every((id, i) => id === proposed[i] || unknown.has(id) && known.has(proposed[i]));
}

function authoredRows(tree, visibleParagraphs, rootHeadings) {
  const rows = [];
  const ancestors = [];
  const pending = tree.children.map(node => ({ node, item: false })).reverse();
  while (pending.length) {
    const { node, item } = pending.pop();
    if (ignored.has(node.type)) continue;
    const line = node.position.start.line;
    if (node.type === "heading" && rootHeadings.has(line)) {
      const heading = rootHeadings.get(line);
      while (ancestors.length && ancestors.at(-1).depth >= heading.depth) ancestors.pop();
      ancestors.push(heading);
      // Registered headings have owner-specified labels and identify sections.
      // An added visible subheading can itself make an assertion.
      rows.push({ node, kind: "heading", heading });
      continue;
    }
    if (node.type === "paragraph") {
      const { start, end } = node.position;
      if (visibleParagraphs.has(start.offset + ":" + end.offset)) {
        rows.push({ node, kind: item ? "list-item" : "paragraph", heading: ancestors.at(-1),
          nonCurrentContext: ancestors.some(item => nonCurrentHeading.test(item.title)) });
      }
      continue;
    }
    if (node.children) {
      pending.push(...node.children.map(child => ({ node: child, item: item || node.type === "listItem" })).reverse());
    }
  }
  return rows;
}

function parseAuthoredMarkdown(source) {
  const lines = source.split(/\r\n|\n|\r/u);
  const normalized = lines.join("\n");
  const tree = fromMarkdown(normalized, options);
  const markdown = markdownStructure(lines, { collectParagraphs: true });
  const visibleParagraphs = new Set(markdown.paragraphs.map(({ start, end }) => start.offset + ":" + end.offset));
  const rootHeadings = new Map(tree.children.filter(node => node.type === "heading" &&
    markdown.visible[node.position.start.line - 1]?.trim()).map(node =>
    [node.position.start.line, { title: headingTitle(node), depth: node.depth,
      line: node.position.start.line, endLine: node.position.end.line }]));
  const definitions = new Map();
  for (const node of tree.children) {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
  }
  return { lines, normalized, rootHeadings, definitions, rows: authoredRows(tree, visibleParagraphs, rootHeadings) };
}

function protectedHeadingRanges(headings, titles, lineCount, strict = true) {
  return titles.flatMap(title => {
    const matches = headings.filter(heading => heading.title === title);
    if (!strict && !matches.length) return [];
    if (matches.length !== 1) throw new Error("Invalid protected architecture heading");
    const [heading] = matches;
    const next = headings.find(item => item.line > heading.line && item.depth <= heading.depth);
    return [[heading.line, next?.line - 1 || lineCount]];
  });
}

/** Diagnose reserved responsibility links with the same visible Markdown rules as review. */
export function architectureBrokenFactLinks(source, responsibilityIds, { protectedHeadings = [], authoredHeadings = [] } = {}) {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new Error("架构稿超过正文核验大小上限");
  const { lines, rootHeadings, definitions, rows } = parseAuthoredMarkdown(source);
  const headings = [...rootHeadings.values()];
  const generated = protectedHeadingRanges(headings, protectedHeadings, lines.length, false);
  const ids = new Set(responsibilityIds);
  return rows.flatMap(({ node, heading, kind }) => {
    const { start, end } = node.position;
    if (generated.some(([first, last]) => first <= start.line && start.line <= last)) return [];
    const usedDefinitions = new Set();
    const unknownRefs = references(node, definitions, usedDefinitions).filter(id => !ids.has(id));
    if (!unknownRefs.length) return [];
    const definition = [...usedDefinitions].find(candidate =>
      candidate.url.startsWith(factAnchor) && unknownRefs.includes(candidate.url.slice(factAnchor.length)) &&
      !generated.some(([first, last]) => first <= candidate.position.start.line && candidate.position.start.line <= last));
    if (definition) {
      const { start: from, end: to } = definition.position;
      return [{ line: start.line, end: end.line, heading: heading?.title ?? null, unknownRefs,
        lineScoped: true, editLines: [from.line, to.line] }];
    }
    const editable = kind !== "heading" && heading && (heading.depth !== 1 || authoredHeadings.includes(heading.title)) &&
      headings.filter(row => row.title === heading.title).length === 1;
    return [{ line: start.line, end: end.line, heading: heading?.title ?? null, unknownRefs,
      ...(editable ? {} : { lineScoped: true }) }];
  });
}

/** Locate original offsets before Markdown normalizes mixed line endings. */
export function architectureLineOffsets(source) {
  const lines = source.split(/\r\n|\n|\r/u);
  const eol = source.match(/\r\n|\n|\r/gu) ?? [];
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) offsets.push(offsets[i] + lines[i].length + (eol[i]?.length ?? 0));
  return offsets;
}

/** Locate the exact body span in the original line endings for a scoped edit. */
export function architectureHeadingSpans(source) {
  const { rootHeadings } = parseAuthoredMarkdown(source);
  const offsets = architectureLineOffsets(source);
  const headings = [...rootHeadings.values()];
  return headings.map((heading, i) => {
    const next = headings[i + 1];
    return { ...heading, start: offsets[heading.line - 1], bodyStart: offsets[heading.endLine],
      stop: next ? offsets[next.line - 1] : source.length };
  });
}

function roleFile([first, second]) {
  if (first?.type === "text") return bareRole.exec(first.value)?.[1];
  if (!/^(?:strong|inlineCode)$/u.test(first?.type ?? "") || second?.type !== "text" || !/^\s*[:：]/u.test(second.value)) return;
  const title = roleTitle.exec(first.type === "strong" ? headingTitle(first) : first.value);
  return title?.[1] ?? title?.[2];
}

function sameFile(from, file) {
  return from === file || (!from.includes("/") || !file.includes("/")) && from.split("/").at(-1) === file.split("/").at(-1);
}

function signedModules(sources) {
  if (!Array.isArray(sources)) return;
  const files = new Set(sources.filter(file => typeof file === "string" && file.endsWith(".py")));
  const aliases = new Map();
  for (const file of files) {
    const basename = file.split("/").at(-1);
    for (const alias of [basename, basename.slice(0, -3)]) aliases.set(alias, aliases.has(alias) ? undefined : file);
  }
  return { files, resolve: token => token.includes("/") ? files.has(token) && token : aliases.get(token) };
}

function signedRole(nodes, modules) {
  const [first, second] = nodes;
  if (first?.type === "text") {
    const prefix = modulePrefix.exec(first.value);
    const from = prefix && modules.resolve(prefix[1]);
    if (from && !nonCurrentHeading.test(prefix[2] ?? "")) {
      return { from, nodes: [{ ...first, value: first.value.slice(prefix[0].length) }, ...nodes.slice(1)] };
    }
  }
  if ((first?.type !== "strong" && first?.type !== "inlineCode") || second?.type !== "text") return;
  const title = first.type === "strong" ? headingTitle(first) : first.value;
  const heading = moduleTitle.exec(title);
  const colon = /^\s*[:：]\s*/u.exec(second.value);
  const from = colon && modules.resolve(roleFile(nodes) ?? heading?.[1] ?? "");
  if (from && !nonCurrentHeading.test(heading?.[2] ?? title)) {
    return { from, nodes: [{ ...second, value: second.value.slice(colon[0].length) }, ...nodes.slice(2)] };
  }
}

/** The text before a return literal must state the entire typed trigger.
 * Matching an exact supported form leaves partial and compound scopes alone. */
function typedCondition(clause) {
  const type = chineseType.exec(clause) ?? englishType.exec(clause);
  if (type) return { kind: "input-type", argument: 0, type: rootTypes.get(type[2].toLowerCase()),
    test: /^(?:不|非|not)/iu.test(type[1] ?? "") ? "not" : "is" };
  const field = chineseField.exec(clause) ?? englishField.exec(clause);
  if (field) return { kind: "field-presence", argument: 0, field: field[2],
    test: /^(?:缺|lacks|is missing)/iu.test(field[1]) ? "missing" : "present" };
}

function sameTrigger(left, right) {
  return right && left.kind === right.kind && left.argument === right.argument && left.test === right.test &&
    (left.kind === "input-type" ? left.type === right.type : left.field === right.field);
}

/** A parenthesized protected reference immediately following a conditional
 * literal is scoped to that clause. The condition, code and signed module
 * must all be identified before calling the ownership false. */
function typedDirectConflicts(row, facts, modules, definitions) {
  if (!modules) return [];
  const role = signedRole(row.node.children, modules);
  if (!role) return [];
  const { from, nodes } = role;
  const opening = nodes[0]?.value?.split(clauseBreak, 1)[0] ?? "";
  if (nonCurrentHeading.test(opening) || /(?:例如|比如|假设|旧版|历史|(?:\b(?:formerly|previously|would|will|should)\b))/iu.test(opening)) return [];
  const result = [];
  let clause = "";
  let emission;
  const quotes = [];
  for (const [index, node] of nodes.entries()) {
    if (node.type === "inlineCode") {
      const trigger = clause === null || quotes.length ? undefined : typedCondition(clause.trim());
      emission = trigger && { trigger, code: node.value, index, line: node.position.start.line };
    }
    const id = responsibilityReference(node, definitions);
    if (id !== undefined && emission?.index === index - 2) {
      const open = nodes[index - 1];
      const close = nodes[index + 1];
      const opener = open.type === "text" && /^\s*([（(])\s*$/u.exec(open.value)?.[1];
      const closer = close?.type === "text" && /^\s*([）)])(?=\s*(?:[。！？!?；;]|\.(?:\s|$)|$))/u.exec(close.value)?.[1];
      const fact = facts.get(id);
      const decision = fact?.actual ?? fact?.decision;
      if ((opener === "（" && closer === "）" || opener === "(" && closer === ")") &&
          (fact?.mode ?? decision?.mode) === "business" && modules.files.has(decision?.file) && decision.file !== from &&
          Number.isSafeInteger(decision.line) && decision.line > 0 && typeof decision.symbol === "string" &&
          emission.code === decision.code && sameTrigger(emission.trigger, fact.trigger)) {
        result.push({ line: emission.line, from, actual: [{ file: decision.file, line: decision.line, symbol: decision.symbol }],
          id, relation: "linked-responsibility" });
      }
    }
    // Non-text markup is opaque. A quoted example or an earlier fact label
    // cannot supply a predicate. Field names may be explicit inline literals.
    if (node.type === "text") {
      for (const quote of node.value.matchAll(/[“”‘’「」『』"]/gu)) {
        if (quotes.at(-1) === quote[0]) quotes.pop();
        else if (quoteEnds.has(quote[0])) quotes.push(quoteEnds.get(quote[0]));
      }
      const parts = node.value.split(clauseBreak);
      if (parts.length > 1) clause = parts.at(-1);
      else if (clause !== null) clause += node.value;
    } else if (clause !== null) {
      clause += node.type === "inlineCode" && !node.value.includes("`") ? "`" + node.value + "`" : "\u0000";
    }
    if (clause !== null && clause.length > MAX_TYPED_CLAUSE) clause = null;
  }
  return result;
}

/** A protected link can identify a fact, but can also cite delegated work.
 * Require a concrete module prefix, a repeated response code and a direct
 * assertion that this module makes the linked decision. The narrower grammar
 * leaves plans, examples, fallbacks and indirect descriptions with reviewers. */
function linkedRowConflicts(row, facts, modules, definitions) {
  const { node, kind, nonCurrentContext } = row;
  if (kind === "heading" || nonCurrentContext) return [];
  const conflicts = typedDirectConflicts(row, facts, modules, definitions);
  const role = roleFile(node.children);
  const from = modules && role ? modules.resolve(role) : role;
  if (!from) return conflicts;
  const codes = new Set();
  let prose = "";
  for (const child of node.children) {
    const id = responsibilityReference(child, definitions);
    if (child.type === "inlineCode") {
      const claim = prose.split(clauseBreak).at(-1);
      if (emission.test(claim) && !nonCurrent.test(claim)) codes.add(child.value);
      // Inline code is a literal and cannot add planning qualifiers or sentence boundaries.
      prose += "\u0000";
    } else if (id !== undefined) {
      const fact = facts.get(id);
      const decision = fact?.actual ?? fact?.decision;
      const clauses = prose.split(clauseBreak);
      const claim = clauses.at(-1);
      const direct = localDecision.exec(claim);
      if ((fact?.mode ?? decision?.mode) === "business" && typeof decision?.file === "string" &&
          (!modules || modules.files.has(decision.file)) &&
          Number.isSafeInteger(decision.line) && decision.line > 0 && typeof decision.symbol === "string" &&
          typeof decision.code === "string" && codes.has(decision.code) && !(modules ? from === decision.file : sameFile(from, decision.file)) &&
          direct && !nonCurrent.test(claim) && !nonCurrentHeading.test(clauses[0])) {
        const line = child.position.start.line - (direct[0].match(/\n/gu)?.length ?? 0);
        if (!conflicts.some(item => item.line === line && item.from === from && item.id === id)) {
          conflicts.push({ line, from, actual: [{ file: decision.file, line: decision.line, symbol: decision.symbol }],
            id, relation: "linked-responsibility" });
        }
      }
      prose += "\u0000";
    } else {
      prose += child.type === "text" ? child.value : headingTitle({ children: [child] });
    }
  }
  return conflicts;
}

/** Standalone preflight for current host-verified facts, even when architecture
 * prose receipts or the import graph are disabled. */
export function linkedResponsibilityConflicts(source, facts, { sources } = {}) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE_BYTES || !Array.isArray(facts) ||
      !facts.length || facts.length > MAX_FACTS) return [];
  const known = new Map(facts.map(fact => [fact.id, fact]));
  const modules = signedModules(sources);
  const { rows, definitions } = parseAuthoredMarkdown(source);
  return rows.flatMap(row => linkedRowConflicts(row, known, modules, definitions));
}

/** Keep author prose separate from protected host sections. Visible paragraphs
 * and each list item's own paragraph retain exact physical lines. Added
 * headings outside declared sections remain reviewable. */
export function architectureProseInventory({ source, sections, facts, protectedHeadings = [], sources }) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE_BYTES || !Array.isArray(sections) ||
    !Array.isArray(facts) || !facts.length || facts.length > MAX_FACTS ||
    facts.some(item => typeof item?.id !== "string" || !factId.test(item.id)) ||
    new Set(facts.map(item => item.id)).size !== facts.length) throw new Error("Invalid architecture coverage inputs");
  const { lines, normalized, rootHeadings, definitions, rows } = parseAuthoredMarkdown(source);
  const modules = signedModules(sources);
  const currentFacts = new Map(facts.map(fact => [fact.id, fact]));
  const known = new Map(facts.map(fact => [fact.id, { id: fact.id, sha256: digest(JSON.stringify(fact)),
    ...(fact.clause ? { clause: fact.clause } : {}), ...((fact.actual ?? fact.decision) ? { decision: fact.actual ?? fact.decision } : {}) }]));
  const allHeadings = [...rootHeadings.values()];
  const declared = new Map();
  for (const section of sections) {
    const heading = rootHeadings.get(section.start);
    if (heading?.title !== section.heading || !Number.isSafeInteger(section.end) || section.end < section.start ||
      section.end > lines.length || declared.has(section.start)) throw new Error("Invalid registered architecture heading");
    declared.set(section.start, section);
  }
  const protectedRanges = protectedHeadingRanges(allHeadings, protectedHeadings, lines.length);
  const blocks = [];
  const groups = new Map();
  const coverageGroup = (heading, start) => {
    const identity = JSON.stringify([heading, start]);
    if (!groups.has(identity)) groups.set(identity, { id: "s" + (groups.size + 1), heading, blocks: [] });
    return groups.get(identity);
  };
  for (const section of declared.values()) coverageGroup(section.heading, section.start);
  const occurrences = new Map();
  const titleLine = allHeadings[0]?.depth === 1 ? allHeadings[0].line : undefined;
  for (const row of rows) {
    const { node, kind, heading } = row;
    const { start, end } = node.position;
    if (protectedRanges.some(([first, last]) => first <= start.line && last >= start.line)) continue;
    if (kind === "heading" && (declared.has(start.line) || start.line === titleLine)) continue;
    const section = [...declared.values()].filter(item => item.start <= start.line && item.end >= end.line)
      .sort((a, b) => b.start - a.start)[0];
    const groupHeading = section?.heading ?? heading?.title ?? "";
    const groupStart = section?.start ?? heading?.line ?? 0;
    const group = coverageGroup(groupHeading, groupStart);
    const refs = references(node, definitions);
    const sha256 = digest(normalized.slice(start.offset, end.offset));
    const basis = digest(JSON.stringify([groupHeading, kind, sha256]));
    const occurrence = (occurrences.get(basis) ?? 0) + 1;
    occurrences.set(basis, occurrence);
    const id = "p-" + basis.slice(0, 18) + "-" + occurrence;
    const block = { id, section: group.id, heading: groupHeading, kind, start: start.line, end: end.line, sha256, refs };
    if (refs.some(ref => !known.has(ref))) block.unknownRefs = refs.filter(ref => !known.has(ref));
    const hostConflicts = linkedRowConflicts(row, currentFacts, modules, definitions);
    if (hostConflicts.length) block.hostConflicts = hostConflicts;
    blocks.push(block);
    group.blocks.push(id);
    if (blocks.length > MAX_BLOCKS) throw new Error("Architecture coverage exceeds its block limit");
  }
  const factPins = [...known.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
  return {
    binding: { sourceSha256: digest(source), factsSha256: digest(JSON.stringify(factPins.map(({ id, sha256 }) => ({ id, sha256 })))) },
    facts: factPins,
    sections: [...groups.values()],
    blocks,
  };
}

/** Each reviewer makes their own semantic decisions. The host checks
 * completeness, binding and explicit conflicts with protected facts. */
export function checkArchitectureProseReceipt(inventory, receipt) {
  const invalidBinding = receipt?.binding?.sourceSha256 !== inventory.binding.sourceSha256 ||
    receipt?.binding?.factsSha256 !== inventory.binding.factsSha256;
  if (invalidBinding) return { status: "pending", reason: "coverage-version-changed" };
  const expected = new Map(inventory.blocks.map(block => [block.id, block]));
  const facts = new Set(inventory.facts.map(fact => fact.id));
  const knownSections = new Map(inventory.sections.map(section => [section.id, section]));
  if (!Array.isArray(receipt.blocks) || receipt.blocks.length > MAX_BLOCKS || !Array.isArray(receipt.facts) ||
    receipt.facts.length > knownSections.size * facts.size) return { status: "pending", reason: "invalid-prose-coverage-shape" };
  const submitted = new Map();
  const findings = inventory.blocks.flatMap(block => (block.hostConflicts ?? []).map(hostConflict => ({
    id: block.id, section: block.section, heading: block.heading, line: hostConflict.line,
    status: "contradiction", facts: [hostConflict.id], hostConflict,
  })));
  const errors = [];
  for (const row of receipt.blocks) {
    const block = expected.get(row?.id);
    if (!block || submitted.has(row.id) || row.sha256 !== block.sha256 || !statuses.has(row.status) ||
      block.unknownRefs || !Array.isArray(row.facts) || new Set(row.facts).size !== row.facts.length ||
      row.facts.some(id => !facts.has(id)) || block.refs.some(id => !row.facts.includes(id)) ||
      ["plan", "no-current-claim"].includes(row.status) && row.facts.length ||
      ["contradiction", "insufficient"].includes(row.status) &&
        (!Number.isSafeInteger(row.line) || row.line < block.start || row.line > block.end)) {
      errors.push({ id: row?.id, reason: "invalid-prose-coverage-row" });
      continue;
    }
    submitted.set(row.id, row);
    if (["contradiction", "insufficient"].includes(row.status) &&
        !findings.some(item => item.id === row.id && item.line === row.line && item.status === row.status &&
          row.facts.length === 1 && item.facts[0] === row.facts[0])) {
      findings.push({ id: row.id, section: block.section, heading: block.heading, line: row.line, status: row.status, facts: row.facts });
    }
  }
  const references = Object.fromEntries(inventory.sections.map(section => [section.id, Object.fromEntries(inventory.facts.map(({ id }) =>
    [id, section.blocks.filter(block => submitted.get(block)?.facts.includes(id))]))]));
  const addressed = new Set();
  for (const row of receipt.facts) {
    const section = knownSections.get(row?.section);
    const key = section?.id + ":" + row?.id;
    const matches = references[row?.section]?.[row?.id];
    if (!section || !facts.has(row.id) || addressed.has(key) || !Array.isArray(row.blocks) ||
      row.blocks.length !== matches.length || new Set(row.blocks).size !== row.blocks.length ||
      row.blocks.some(id => !matches.includes(id))) {
      errors.push({ section: row?.section, id: row?.id, reason: "invalid-section-fact-review" });
      continue;
    }
    addressed.add(key);
  }
  const missing = inventory.blocks.filter(row => !submitted.has(row.id)).map(row => row.id);
  const missingFacts = inventory.sections.flatMap(({ id: section }) => inventory.facts.filter(({ id }) =>
    !addressed.has(section + ":" + id)).map(({ id }) => ({ section, id })));
  const status = errors.length || missing.length || missingFacts.length || findings.some(item => item.status === "insufficient") ? "pending" :
    findings.some(item => item.status === "contradiction") ? "revise" : "pass";
  return { status, missing, missingFacts, errors, findings, references };
}
