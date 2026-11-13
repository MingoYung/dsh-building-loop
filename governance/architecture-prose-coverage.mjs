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

function references(node) {
  const pending = [...node.children];
  const refs = new Set();
  while (pending.length) {
    const child = pending.pop();
    if (child.type === "link" && child.url.startsWith(factAnchor)) refs.add(child.url.slice(factAnchor.length));
    if (child.children) pending.push(...child.children);
  }
  return [...refs].sort();
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
    [node.position.start.line, { title: headingTitle(node), depth: node.depth, line: node.position.start.line }]));
  return { lines, normalized, rootHeadings, rows: authoredRows(tree, visibleParagraphs, rootHeadings) };
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

/** A protected link can identify a fact, but can also cite delegated work.
 * Require a concrete module prefix, a repeated response code and a direct
 * assertion that this module makes the linked decision. The narrower grammar
 * leaves plans, examples, fallbacks and indirect descriptions with reviewers. */
function linkedRowConflicts({ node, kind, nonCurrentContext }, facts) {
  if (kind === "heading" || nonCurrentContext) return [];
  const from = roleFile(node.children);
  if (!from) return [];
  const conflicts = [];
  const codes = new Set();
  let prose = "";
  for (const child of node.children) {
    if (child.type === "inlineCode") {
      const claim = prose.split(clauseBreak).at(-1);
      if (emission.test(claim) && !nonCurrent.test(claim)) codes.add(child.value);
      // Inline code is a literal and cannot add planning qualifiers or sentence boundaries.
      prose += "\u0000";
    } else if (child.type === "link" && child.url.startsWith(factAnchor)) {
      const id = child.url.slice(factAnchor.length);
      const fact = facts.get(id);
      const decision = fact?.actual ?? fact?.decision;
      const clauses = prose.split(clauseBreak);
      const claim = clauses.at(-1);
      const direct = localDecision.exec(claim);
      if ((fact?.mode ?? decision?.mode) === "business" && typeof decision?.file === "string" &&
          Number.isSafeInteger(decision.line) && decision.line > 0 && typeof decision.symbol === "string" &&
          typeof decision.code === "string" && codes.has(decision.code) && !sameFile(from, decision.file) &&
          direct && !nonCurrent.test(claim) && !nonCurrentHeading.test(clauses[0])) {
        const line = child.position.start.line - (direct[0].match(/\n/gu)?.length ?? 0);
        conflicts.push({ line, from, actual: [{ file: decision.file, line: decision.line, symbol: decision.symbol }],
          id, relation: "linked-responsibility" });
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
export function linkedResponsibilityConflicts(source, facts) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE_BYTES || !Array.isArray(facts) ||
      !facts.length || facts.length > MAX_FACTS) return [];
  const known = new Map(facts.map(fact => [fact.id, fact]));
  return parseAuthoredMarkdown(source).rows.flatMap(row => linkedRowConflicts(row, known));
}

/** Keep author prose separate from protected host sections. Visible paragraphs
 * and each list item's own paragraph retain exact physical lines. Added
 * headings outside declared sections remain reviewable. */
export function architectureProseInventory({ source, sections, facts, protectedHeadings = [] }) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE_BYTES || !Array.isArray(sections) ||
    !Array.isArray(facts) || !facts.length || facts.length > MAX_FACTS ||
    facts.some(item => typeof item?.id !== "string" || !factId.test(item.id)) ||
    new Set(facts.map(item => item.id)).size !== facts.length) throw new Error("Invalid architecture coverage inputs");
  const { lines, normalized, rootHeadings, rows } = parseAuthoredMarkdown(source);
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
  const protectedRanges = protectedHeadings.map(title => {
    const matches = allHeadings.filter(heading => heading.title === title);
    if (matches.length !== 1) throw new Error("Invalid protected architecture heading");
    const [heading] = matches;
    const next = allHeadings.find(item => item.line > heading.line && item.depth <= heading.depth);
    return [heading.line, next?.line - 1 || lines.length];
  });
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
    const refs = references(node);
    const sha256 = digest(normalized.slice(start.offset, end.offset));
    const basis = digest(JSON.stringify([groupHeading, kind, sha256]));
    const occurrence = (occurrences.get(basis) ?? 0) + 1;
    occurrences.set(basis, occurrence);
    const id = "p-" + basis.slice(0, 18) + "-" + occurrence;
    const block = { id, section: group.id, heading: groupHeading, kind, start: start.line, end: end.line, sha256, refs };
    if (refs.some(ref => !known.has(ref))) block.unknownRefs = refs.filter(ref => !known.has(ref));
    const hostConflicts = linkedRowConflicts(row, currentFacts);
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
