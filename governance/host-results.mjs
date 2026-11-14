import { markdownStructure } from "./markdown-structure.mjs";
import { digest, includes, keyOf, readBytes, relativeName } from "./policy.mjs";
import { citation, claimRow, configuredNumericMeasurements } from "./preflight.mjs";

const marker = "{{building-loop:";
const metricTemplate = /^(.*?)[\t ]*\{\{building-loop:metric:([\w-]{1,48})\}\}[\t ]*([。.]?)[\t ]*$/u;
const citationTemplate = /^\{\{building-loop:citation-lines:([^{}\r\n]+)\}\}$/u;
const blockBreak = /[。！？；;!?]/u;

function manuscript(value) {
  const source = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  const bom = source.startsWith("\ufeff") ? "\ufeff" : "";
  const parts = source.slice(bom.length).split(/(\r\n|\n|\r)/u);
  const lines = parts.filter((_, index) => index % 2 === 0);
  return { lines, render: rendered => bom + parts.map((part, index) => index % 2 === 0 ? rendered[index / 2] : part).join("") };
}

function declarations(spec) {
  const { calculations = [], citationLines = [] } = spec.hostResults ?? {};
  return [...calculations.map(id => ({ id, kind: "metric", source: spec.calculations[id].source })),
    ...citationLines.map(source => ({ id: "citation-lines:" + source, kind: "citation-lines", source }))];
}

/** Expose the owner-authorized slots without projecting data across role boundaries. */
export function hostResultSlots(spec) {
  return declarations(spec).map(row => ({ ...row, template: row.kind === "metric"
    ? "- " + row.id + "：<说明指标范围> {{building-loop:metric:" + row.id + "}}"
    : "{{building-loop:citation-lines:" + row.source + "}}" }));
}

function slotAt(text, rows) {
  const metric = metricTemplate.exec(text);
  if (metric && !metric[1].includes(marker)) {
    const row = rows.find(item => item.kind === "metric" && item.id === metric[2]);
    const numbered = /^ {0,3}(?:(?:[-*]|\d+[.)])[\t ]+)?(?:\*\*)?([\w-]{1,48})(?:\*\*)?[\t ]*[:：][\t ]*(\S.*)$/u.exec(metric[1]);
    if (row && numbered?.[1] === row.id && !blockBreak.test(numbered[2])) {
      if (/(?:因此|所以|由此(?:可见|可得|推出)?|据此(?:可知|推出)?|therefore|\bhence\b|\bthus\b)/iu.test(numbered[2])) {
        throw new Error("宿主结果行只写指标口径，业务推论须在正文另起一句独立核验");
      }
      return { ...row, template: text, scope: metric[1].trimEnd(), ending: metric[3] };
    }
  }
  const citation = citationTemplate.exec(text);
  if (citation) {
    const source = relativeName(citation[1]);
    if (source === citation[1] && !/[`{}]/u.test(source)) {
      const row = rows.find(item => item.kind === "citation-lines" && item.source === source);
      if (row) return { ...row, template: text };
    }
  }
  throw new Error("宿主结果占位符未获授权或所在行格式错误：指标须使用同编号的独立结果行；引用统计须单独占一行");
}

function showLineRange(lines) {
  return lines[0] === lines.at(-1) ? String(lines[0]) : lines[0] + "-" + lines.at(-1);
}

/** Keep collision detection linear for long manuscripts. A repeated rendered
 * line cannot serve as an unambiguous location for a carried-forward slot. */
function rowLocations(lines) {
  const locations = new Map();
  for (const [index, line] of lines.entries()) {
    locations.set(line, locations.has(line) ? 0 : index + 1);
  }
  return locations;
}

/** Rendering uses only current registered materials. The independent role
 * still verifies the source's scope and records its own evidence reads. */
function checkSourcePin(frame, spec, source, sha256) {
  const pin = frame.policy?.sourcePins?.[keyOf(source)];
  if (spec.requireSourcePins && !pin) throw new Error("宿主结果缺少原始来源凭据：" + source);
  if (pin && pin.sha256 !== sha256) throw new Error("宿主结果的原文与登记版本不一致：" + source);
  if (!pin?.observation) return;
  const receipt = readBytes(frame.root, pin.observation.file);
  if (!receipt || digest(receipt) !== pin.observation.sha256) throw new Error("宿主结果的来源获取回执已变化：" + source);
  return pin.observation;
}

/** Metrics are ordinary citation-bearing manuscript lines. Citation summaries
 * report those physical lines and cannot count their own outgoing labels. */
function renderRows(frame, spec, draft, slots, readable) {
  const lines = [...draft.lines];
  for (const { source } of slots) {
    if (blockBreak.test(source) || /[`{}]/u.test(source)) throw new Error("宿主结果来源路径不能包含正文分隔符：" + source);
  }
  const metricSlots = slots.filter(row => row.kind === "metric");
  const measurements = new Map(configuredNumericMeasurements(frame.root, { ...spec, calculations:
    Object.fromEntries(metricSlots.map(({ id }) => [id, spec.calculations[id]])) }, readable).map(row => [row.id, row]));
  const proofs = [];
  for (const slot of metricSlots) {
    const measurement = measurements.get(slot.id);
    if (!measurement?.available) throw new Error(slot.id + " 宿主复算失败：" + (measurement?.issue ?? "没有可用数据"));
    const { available, id, kind: calculationKind, ...fields } = measurement;
    if (blockBreak.test(measurement.expected)) throw new Error(id + " 的格式化结果包含正文分隔符");
    const sourceObservation = checkSourcePin(frame, spec, slot.source, measurement.sourceHash);
    const locator = "（出处：" + slot.source + " 第 " + showLineRange(measurement.sourceRows.map(row => row.line)) + " 行）";
    const owned = measurement.expected + locator;
    const start = slot.scope.length + 1;
    const result = slot.scope + " " + owned + slot.ending;
    lines[slot.line - 1] = result;
    proofs.push({ ...fields, id, kind: slot.kind, calculationKind, line: slot.line, text: result,
      span: { start, end: start + owned.length }, ...(sourceObservation ? { sourceObservation } : {}) });
  }
  const citationSlots = slots.filter(row => row.kind === "citation-lines");
  // Preserve physical rows even when a statistics slot is positioned between citations.
  const projected = [...lines];
  for (const { line } of citationSlots) projected[line - 1] = "";
  for (const { id, kind, source, line } of citationSlots) {
    if (!includes(readable, source)) throw new Error("当前阶段无引用统计来源的读授权：" + source);
    const sourceBytes = readBytes(frame.root, source);
    if (!sourceBytes) throw new Error("引用统计来源文件不存在：" + source);
    const sourceHash = digest(sourceBytes);
    const sourceObservation = checkSourcePin(frame, spec, source, sourceHash);
    // Match the existing citationLineCounts definition, including its exact locator parser.
    const citedLines = projected.flatMap((text, index) => citation(text, source)?.start ? [index + 1] : []);
    const result = citedLines.length ? "[稿件自述] 本稿对 " + source + " 有" + citedLines.length +
      "行可识别同行引用（第" + citedLines.join("、") + "行）。" : "[稿件自述] 本稿带 " + source + " 行号定位的共0行。";
    lines[line - 1] = result;
    proofs.push({ id, kind, source, line, text: result, sourceHash, count: citedLines.length,
      lines: citedLines, span: { start: 0, end: result.length }, ...(sourceObservation ? { sourceObservation } : {}) });
  }
  return { content: draft.render(lines), proofs: proofs.sort((a, b) => a.line - b.line) };
}

function verifyLocations(lines, slots) {
  if (!slots.length) return;
  const { visible, outcomeRows } = markdownStructure(lines, { collectOutcomeRows: true });
  for (const slot of slots) {
    const index = slot.line - 1;
    if (!outcomeRows[index] || !visible[index].includes(slot.template.slice(slot.template.indexOf(marker)).trimEnd())) {
      throw new Error("宿主结果占位符须出现在第 " + slot.line + " 行的可见独立正文，不能放入引用、代码、注释或列表续行");
    }
    if (slot.kind === "metric" && claimRow(lines, slot.id)?.line !== slot.line) {
      throw new Error(slot.id + " 的宿主指标必须是唯一的编号断言行");
    }
  }
}

/** Keep an owned result only when the prior host-written row survives exactly,
 * or when the author explicitly replaces it through its authorized template. */
export function renderHostResults(frame, active, spec, content, before) {
  const declared = declarations(spec);
  const prior = active?.hostResultRows ?? [];
  if (!declared.length && !content.includes(marker) && !prior.length) return { content, rows: [] };
  const draft = manuscript(content);
  const slots = [];
  const lines = [...draft.lines];
  for (const [index, line] of lines.entries()) {
    if (line.includes(marker)) slots.push({ ...slotAt(line, declared), line: index + 1 });
  }
  const previous = before == null || !prior.length ? [] : manuscript(before).lines;
  const locations = rowLocations(lines);
  const ids = new Set(slots.map(row => row.id));
  if (ids.size !== slots.length) throw new Error("同一个宿主结果占位符只能登记一次");
  for (const row of prior) {
    const line = locations.get(row.text);
    if (ids.has(row.id)) {
      if (line !== undefined) throw new Error(row.id + " 已有生成结果，请在同一行替换为占位符，不能同时保留两处");
      continue;
    }
    if (previous[row.line - 1] !== row.text || !line) {
      throw new Error(row.id + " 的宿主结果已变更或无法唯一定位，请在正文重新放置该结果占位符");
    }
    const next = slotAt(row.template, declared);
    if (next.id !== row.id || next.source !== row.source || next.kind !== row.kind) throw new Error("旧宿主结果与当前授权不一致");
    lines[line - 1] = next.template;
    slots.push({ ...next, line });
    ids.add(row.id);
  }
  verifyLocations(lines, slots);
  const rendered = renderRows(frame, spec, { ...draft, lines }, slots, frame.reads);
  const renderedLocations = slots.length ? rowLocations(manuscript(rendered.content).lines) : new Map();
  const templates = new Map(slots.map(row => [row.id, row.template]));
  const rows = rendered.proofs.map(proof => {
    if (renderedLocations.get(proof.text) !== proof.line) throw new Error(proof.id + " 的生成结果在正文中重复");
    return { id: proof.id, kind: proof.kind, source: proof.source, line: proof.line, text: proof.text,
      template: templates.get(proof.id), fingerprint: digest(JSON.stringify(proof)) };
  });
  return { content: rendered.content, rows };
}

/** Verify the stored locations and pinned inputs without modifying the draft.
 * A source change invalidates a result even if it rounds to identical text. */
export function currentHostResults(frame, active, spec, bytes, { host = false, complete = true } = {}) {
  const declared = declarations(spec);
  if (!declared.length) return [];
  const rows = active?.hostResultRows ?? [];
  const ids = new Set(rows.map(row => row.id));
  const missing = declared.filter(row => !ids.has(row.id));
  if (complete && missing.length) throw new Error("候选缺少宿主生成结果：" + missing.map(row => row.id).join("、"));
  const draft = manuscript(bytes);
  const lines = [...draft.lines];
  if (lines.some(line => line.includes(marker))) throw new Error("候选仍有未由宿主生成的结果占位符");
  const renderedLocations = rowLocations(lines);
  const locations = new Set();
  const slots = rows.map(row => {
    if (!Number.isSafeInteger(row.line) || row.line < 1 || renderedLocations.get(row.text) !== row.line || locations.has(row.line)) {
      throw new Error(row.id + " 的宿主结果已偏离当前稿件，请由执行方重新生成");
    }
    locations.add(row.line);
    const slot = slotAt(row.template, declared);
    if (slot.id !== row.id || slot.kind !== row.kind || slot.source !== row.source) throw new Error("宿主结果登记与当前授权不一致");
    lines[row.line - 1] = slot.template;
    return { ...slot, line: row.line };
  });
  if (ids.size !== rows.length) throw new Error("宿主结果登记编号重复");
  verifyLocations(lines, slots);
  const readable = host ? spec.phases["final-review"].read : frame.reads;
  const rendered = renderRows(frame, spec, { ...draft, lines }, slots, readable);
  const candidateSha256 = digest(bytes);
  const registered = new Map(rows.map(row => [row.id, row]));
  return rendered.proofs.map(proof => {
    const row = registered.get(proof.id);
    if (row.text !== proof.text || row.fingerprint !== digest(JSON.stringify(proof))) {
      throw new Error(proof.id + " 的原始数据或稿件引用行已变更，请由执行方重新生成当前结果");
    }
    return { ...proof, candidateSha256 };
  });
}
