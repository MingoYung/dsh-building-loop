import { markdownStructure } from "./markdown-structure.mjs";

const declaration = /^ {0,3}交付要求[：:][ \t]*(?:只给一份短 Markdown[。.]\s*)?用一张“([^“”\r\n]+)”表逐项填[ \t]+([A-Za-z0-9_、，, \t-]+)[，,][ \t]*每个编号恰好一行(?:[。.]|$)/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const separatorCell = /^:?-{3,}:?$/u;

function cells(line) {
  const text = line.trim();
  if (!text.includes("|")) return null;
  const result = [];
  let start = text.startsWith("|") ? 1 : 0;
  let escaped = false;
  // A backslash escapes the next character, including a pipe or a backslash.
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === "|" && !escaped) {
      result.push(text.slice(start, index).trim());
      start = index + 1;
    }
    escaped = character === "\\" && !escaped;
  }
  if (start < text.length) result.push(text.slice(start).trim());
  return result.length >= 2 ? result : null;
}

function cellLabel(value) {
  for (const marker of ["**", "__", "`", "*", "_"]) {
    if (value.startsWith(marker) && value.endsWith(marker) && value.length > marker.length * 2) {
      return value.slice(marker.length, -marker.length).trim();
    }
  }
  return value;
}

/** Recognize a standalone, explicit owner requirement. Quoted excerpts,
 * examples, fenced Markdown and ambiguous declarations provide no contract. */
export function deliverableTableContract(instruction) {
  if (!instruction?.includes("交付要求")) return undefined;
  const lines = instruction.split(/\r?\n/u);
  const { visible, closingRows } = markdownStructure(lines);
  const matches = visible.flatMap((line, index) => {
    const match = closingRows[index] && declaration.exec(line);
    return match ? [match] : [];
  });
  if (matches.length !== 1) return undefined;
  const [, header, list] = matches[0];
  const columns = cells(header);
  const ids = list.split(/[、，,]/u).map(value => value.trim());
  if (!columns || columns.length < 2 || columns.length > 8 || columns[0] !== "编号" ||
    columns.some(column => !column || column.length > 32) || new Set(columns).size !== columns.length ||
    ids.length > 64 || ids.some(id => !identifier.test(id)) || new Set(ids).size !== ids.length) return undefined;
  return { columns, ids };
}

/** Count IDs in the actual top-level Markdown table. Only the row identifier
 * is mechanical here. Its answer and evidence still belong to review. */
export function deliverableTableIssues(candidate, contract) {
  if (!contract) return [];
  const lines = candidate.toString("utf8").split(/\r?\n/u);
  const { visible, closingRows } = markdownStructure(lines);
  const read = index => closingRows[index] && visible[index].trim() ? cells(lines[index]) : null;
  const matches = [];
  for (let index = 0; index + 1 < lines.length; index++) {
    const header = read(index);
    const separator = read(index + 1);
    if (header?.length === contract.columns.length && separator?.length === header.length &&
      header.every((label, cell) => cellLabel(label) === contract.columns[cell]) && separator.every(cell => separatorCell.test(cell))) {
      matches.push(index + 2);
    }
  }
  if (matches.length !== 1) {
    return ["交付稿须有且仅有一张正文表格「" + contract.columns.join(" | ") + "」，编号列须保留 " + contract.ids.join("、")];
  }
  const counts = new Map(contract.ids.map(id => [id, 0]));
  const malformed = [];
  const unexpected = [];
  const empty = [];
  for (let index = matches[0]; index < lines.length; index++) {
    const row = read(index);
    if (!row) break;
    if (row.length !== contract.columns.length) {
      malformed.push(index + 1);
      continue;
    }
    const id = cellLabel(row[0]);
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
    else unexpected.push(index + 1);
    if (!cellLabel(row[1])) empty.push(index + 1);
  }
  const missing = contract.ids.filter(id => counts.get(id) === 0);
  const duplicate = contract.ids.filter(id => counts.get(id) > 1);
  const locations = rows => "第 " + rows.slice(0, 8).join("、") + " 行" + (rows.length > 8 ? "等 " + rows.length + " 行" : "");
  return [
    ...(missing.length ? ["交付表缺少原样编号 " + missing.join("、")] : []),
    ...(duplicate.length ? ["交付表编号重复 " + duplicate.join("、") + "，每个编号只能有一行"] : []),
    ...(unexpected.length ? ["交付表" + locations(unexpected) + "的编号不在明确要求的清单中"] : []),
    ...(empty.length ? ["交付表" + locations(empty) + "的答案为空"] : []),
    ...(malformed.length ? ["交付表" + locations(malformed) + "的列数与表头不符"] : []),
  ];
}
