import parser from "./vendor/markdown-parser.cjs";

const { fromMarkdown, gfmFootnoteFromMarkdown, gfmFootnote } = parser;
const parserOptions = { extensions: [gfmFootnote()], mdastExtensions: [gfmFootnoteFromMarkdown()] };
const fenceMarker = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const tags = /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gu;
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const literalTags = new Set(["pre", "code", "script", "style", "textarea"]);
const hiddenBlocks = new Set(["blockquote", "code", "footnoteDefinition", "definition"]);
export const footnoteId = "[A-Za-z0-9][A-Za-z0-9_.-]{0,63}";
export const footnoteDefinition = new RegExp("^ {0,3}\\[\\^(" + footnoteId + ")\\]:", "u");

/** Classify Markdown from one syntax tree and retain physical line positions.
 * The project consumes original text and can impose stricter requirements
 * than CommonMark on HTML and the authority fence. */
export function markdownStructure(lines) {
  const source = lines.join("\n");
  const root = fromMarkdown(source, parserOptions);
  const hidden = new Int32Array(lines.length + 1);
  const htmlHidden = new Int32Array(lines.length + 1);
  const visible = [...lines];
  const closingRows = new Uint8Array(lines.length);
  const standaloneFootnotes = new Uint8Array(lines.length);
  const continuedFootnotes = new Uint8Array(lines.length);
  const fences = [];
  const htmlScopes = new Map();
  const pending = [{ node: root, parent: null, item: null, list: null }];

  const hide = (start, end, ranges = hidden) => {
    ranges[start]++;
    ranges[end + 1]--;
  };

  // Markdown HTML blocks can end at a blank line while an element remains
  // open. Keep its contents unavailable to the project gates, but only within
  // the same container. A quoted opener must never obscure outside prose.
  function markHtml(node, scope) {
    const { start, end } = node.position;
    hide(start.line - 1, end.line - 1, htmlHidden);
    const active = htmlScopes.get(scope) ?? { start: -1, tags: [] };
    const raw = source.slice(start.offset, end.offset);
    let cursor = 0;
    let line = start.line - 1;
    for (const match of raw.matchAll(tags)) {
      const [token, name] = match;
      line += raw.slice(cursor, match.index).split("\n").length - 1;
      const startLine = line;
      line += token.split("\n").length - 1;
      cursor = match.index + token.length;
      if (!name) continue;
      const tag = name.toLowerCase();
      const top = active.tags.at(-1);
      if (token.startsWith("</")) {
        if (top === tag) {
          active.tags.pop();
          if (!active.tags.length) hide(active.start, line, htmlHidden);
        }
      } else if (!literalTags.has(top) && !voidTags.has(tag) && !token.endsWith("/>")) {
        if (!active.tags.length) active.start = startLine;
        active.tags.push(tag);
      }
    }
    if (active.tags.length) htmlScopes.set(scope, active);
    else htmlScopes.delete(scope);
  }

  while (pending.length) {
    const { node, parent, item, list } = pending.pop();
    const { start, end } = node.position;
    const first = start.line - 1;
    const last = end.line - 1;
    if (hiddenBlocks.has(node.type)) {
      hide(first, last);
      if (node.type === "footnoteDefinition" && parent === root) {
        const marker = footnoteDefinition.exec(lines[first]);
        if (marker && lines[first].slice(marker[0].length).trim()) {
          // A goal can preserve this exact source locator without treating
          // its contents as prose or letting a lazy continuation count.
          if (first === last) standaloneFootnotes[first] = 1;
          else continuedFootnotes.fill(1, first, last + 1);
        }
      }
      if (node.type === "code" && parent === root && start.column === 1) {
        const opener = fenceMarker.exec(lines[first]);
        if (opener && /^building-loop-required-lines\b/u.test(opener[2].trim())) {
          const closer = last > first && fenceMarker.exec(lines[last]);
          const closed = closer && closer[1][0] === opener[1][0] && closer[1].length >= opener[1].length && !closer[2].trim();
          fences.push({ start: first, end: closed ? last : null,
            canonical: /^```building-loop-required-lines[ \t]*$/u.test(lines[first]) && (!closed || /^```[ \t]*$/u.test(lines[last])) });
        }
      }
      continue;
    }
    if (node.type === "html") {
      markHtml(node, item ?? root);
      continue;
    }
    if (node.type === "inlineCode") {
      for (let line = first; line <= last; line++) {
        const begin = line === first ? start.column - 1 : 0;
        const finish = line === last ? end.column - 1 : lines[line].length;
        visible[line] = visible[line].slice(0, begin) + " ".repeat(finish - begin) + visible[line].slice(finish);
      }
      continue;
    }

    if (node.type === "paragraph" || node.type === "heading") {
      if (parent === root) closingRows.fill(1, first, last + 1);
      // An explicit footer immediately after a top-level list item is an
      // allowed project form, even when CommonMark makes it a lazy line.
      else if (list && parent === item && node.type === "paragraph" && node === item.children[0]) {
        for (let line = first + 1; line <= last; line++) {
          const indent = /^ */u.exec(lines[line])[0].length;
          if (indent < start.column - 1 && !/^ *\t/u.test(lines[line])) closingRows[line] = 1;
        }
      }
    }
    const children = node.children ?? [];
    const childItem = node.type === "listItem" ? node : item;
    const childList = node.type === "list" ? (parent === root ? node : null) : list;
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ node: children[index], parent: node, item: childItem, list: childList });
    }
  }
  for (const [scope, active] of htmlScopes) hide(active.start, scope.position.end.line - 1, htmlHidden);
  let depth = 0;
  let htmlDepth = 0;
  for (let line = 0; line < lines.length; line++) {
    depth += hidden[line];
    htmlDepth += htmlHidden[line];
    htmlHidden[line] = htmlDepth;
    if (depth || htmlDepth) visible[line] = "";
    if (htmlDepth) standaloneFootnotes[line] = 0;
  }
  return { fences: fences.filter(fence => !htmlHidden[fence.start]), visible, closingRows, standaloneFootnotes, continuedFootnotes };
}
