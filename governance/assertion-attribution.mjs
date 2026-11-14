import parser from "./vendor/markdown-parser.cjs";
import { markdownStructure } from "./markdown-structure.mjs";
import { exactCitationLocator, lineList } from "./preflight.mjs";
import { keyOf, relativeName } from "./policy.mjs";

const { fromMarkdown, gfmFootnote, gfmFootnoteFromMarkdown } = parser;
const markdownOptions = { extensions: [gfmFootnote()], mdastExtensions: [gfmFootnoteFromMarkdown()] };
const numberedClaim = /^\s*(?:[-*]\s+|\d+[.)]\s+)?(?:\*\*)?(C\d+)(?:\*\*)?\s*[:：]\s*(?<body>\S.*)?$/u;
const literalFile = /^(?:[\p{L}\p{N}_. -]+[/\\])*[\p{L}\p{N}_. -]+\.[A-Za-z0-9_-]+$/u;
const range = String.raw`(?:#L[+-]?\d+(?:-L?[+-]?\d+)?|[:：][+-]?\d+(?:[-–—][+-]?\d+)?|第\s*[+-]?\d+(?:\s*[-–—、至到]\s*[+-]?\d+)?\s*行)`;
const escaped = value => value.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
const paths = String.raw`(?:(?:[A-Za-z]:)?[^\s"“”'‘’()（）\[\]【】<>:：#;；,，、\x60]+\.[A-Za-z0-9_-]+|\x60[^\x60\r\n]+\x60)`;
const url = /(?:https?:\/\/|www\.)[^\s<>()[\]（）"“”]+/iu;

/** An inline-coded filename can introduce a visible locator outside the
 * code span. Restore just that filename, never a whole coded assertion or
 * an entire locator written as a code example. */
function visibleLocatorRows(lines, tree, structure) {
  const rows = [...structure.visible];
  const pending = [...tree.children];
  while (pending.length) {
    const node = pending.pop();
    if (["blockquote", "code", "definition", "footnoteDefinition", "html"].includes(node.type)) continue;
    if (node.type === "inlineCode") {
      const { start, end } = node.position;
      const index = start.line - 1;
      if (start.line === end.line && rows[index]?.trim() && !structure.htmlHidden[index] && literalFile.test(node.value)) {
        const first = start.column - 1;
        const last = end.column - 1;
        rows[index] = rows[index].slice(0, first) + lines[index].slice(first, last) + rows[index].slice(last);
      }
    }
    if (node.children) pending.push(...node.children);
  }
  return rows;
}

/** Summarize the source locators of the visible numbered claims in one Markdown
 * section. It measures what the draft cites. Reading the source, checking the
 * cited lines, and judging whether the source supports a conclusion are separate. */
export function sectionSourceAttribution(bytes, blockLine, source, authorizedSources) {
  const files = [...new Map(authorizedSources.map(value => {
    const file = relativeName(value);
    return [keyOf(file), file];
  })).values()];
  const selected = keyOf(relativeName(source));
  const failed = reason => ({ matches: false, section: null, rowCount: 0, rows: [], reason });
  if (!files.some(file => keyOf(file) === selected)) return failed("unauthorized-source");
  const lines = lineList(bytes);
  if (!Number.isSafeInteger(blockLine) || blockLine < 1 || blockLine > lines.length) return failed("invalid-block-line");

  const tree = fromMarkdown(lines.join("\n"), markdownOptions);
  const structure = markdownStructure(lines);
  const rows = visibleLocatorRows(lines, tree, structure);
  const headings = tree.children.filter(node => node.type === "heading" && rows[node.position.end.line - 1]?.trim());
  const prior = headings.findLast(node => node.position.end.line < blockLine);
  if (!prior || !rows[blockLine - 1]?.trim()) return failed("outside-visible-section");
  const next = headings.find(node => node.position.start.line >= blockLine);
  const section = { headingLine: prior.position.start.line, startLine: prior.position.end.line + 1,
    endLine: next ? next.position.start.line - 1 : lines.length };
  if (blockLine > section.endLine) return failed("outside-visible-section");

  const fileAlternatives = [...files].sort((a, b) => b.length - a.length).map(escaped).join("|");
  const fileToken = `(?:${paths}|${fileAlternatives})`;
  const flags = process.platform === "win32" ? "giu" : "gu";
  const selector = new RegExp(String.raw`(?:^|[\s:："'“‘(（\[【〔<《,，、；;])(${fileToken}\s*${range})(?=$|[\s()[\]（）【】.,，。;；:：”’'"、])`, flags);
  // A file with a broken line locator is still a source attempt. Count these
  // separately so a valid neighbouring locator cannot make the row unambiguous.
  const attempts = new RegExp(String.raw`(?:^|[\s:："'“‘(（\[【〔<《,，、；;])(${fileToken})\s*(?:#|[:：](?=\s*[+\-\d])|第[^。！？；;()（）\[\]【】\r\n]{0,48}?行)`, flags);
  const first = new Map();
  const measured = [];
  for (let line = section.startLine; line <= section.endLine; line++) {
    const numbered = numberedClaim.exec(rows[line - 1]);
    if (!numbered) continue;
    const [, id] = numbered;
    const locators = [];
    const body = numbered.groups.body ?? "";
    const matches = [...body.matchAll(selector)];
    const matchStarts = new Set(matches.map(match => match.index));
    let unresolved = url.test(body) || [...body.matchAll(attempts)].some(attempt => !matchStarts.has(attempt.index));
    for (const match of matches) {
      const parsed = exactCitationLocator(match[1], files);
      if (parsed?.locators.length === 1 && !parsed.excludedLocators.length) locators.push(parsed.locators[0]);
      else unresolved = true;
    }
    const status = unresolved ? "unresolved-locator" : !locators.length ? "missing-locator" :
      locators.some(locator => keyOf(locator.file) !== selected) ? "different-source" : "attributed";
    const item = { id, line, status, locators };
    if (first.has(id)) first.get(id).status = item.status = "duplicate-claim";
    else first.set(id, item);
    measured.push(item);
  }
  return { matches: measured.length > 0 && measured.every(row => row.status === "attributed"), section,
    rowCount: measured.length, rows: measured, ...(measured.length ? {} : { reason: "no-numbered-claims" }) };
}
