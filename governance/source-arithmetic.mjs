import { evidenceReference, registeredSourceRows, workingMaterialReference } from "./evidence.mjs";
import { canonicalDecimal, decimal, lineList, physicalCsvCells, quantityRelation, roundedDecimal } from "./preflight.mjs";
import { digest, includes, keyOf, numericUnitConversion, readBytes, relativeName } from "./policy.mjs";

export const SOURCE_ARITHMETIC_TOOL = "building_loop_calculate";

const operations = {
  difference: { count: 2, formula: "a − b", unit: "原单位" },
  share: { count: 2, formula: "a / b × 100", unit: "%" },
  "change-share": { count: 4, formula: "(a − b) / (c − d) × 100", unit: "%" },
};
// Consume the full numeric token, including unsupported numeric forms; a
// substring of a grouped number or scientific notation is never an operand.
const decimalToken = /[+−-]?\d+(?:[,\u202f\u00a0]\d+)*(?:\.\d+)?(?:[eE][+−-]?\d+)?/gu;
const durationUnits = ["h", "min", "s"];
const durationPart = /^\s*(?:(hours?|h|minutes?|min|seconds?|s)(?![a-z])|(小时|分钟|秒钟?))/iu;
// A number alone can also be a record key or a year. Automatic selection
// requires a complete, recognized quantity at the end of a simple source row.
const scalarUnits = new Set(("% ％ ‰ °C °F ℃ 秒 毫秒 分钟 小时 千克 公斤 克 毫克 米 毫米 厘米 千米 美元 人民币 " +
  "件 个 人 人次 次 箱 盒 台 项 份 条 hours hour minutes minute seconds second items item boxes box people persons count").split(" "));
// Chinese count units can lead directly into the sentence. Prefer the entire
// longest registered unit (e.g. 人次); an English symbol must match as a whole.
const chineseScalarUnits = [...scalarUnits].filter(unit => /^\p{Script=Han}+$/u.test(unit)).sort((a,b) => b.length - a.length);
const leadingScalarUnit = new RegExp("^\\s*(" + chineseScalarUnits.join("|") + "|[%％‰°℃a-zA-Zμ]+(?:/[a-zA-Zμ]+)?[²³]?)", "u");
const locatorLabel = /(?:号|编码|标识|版本|邮编|日期|年份|时刻|时间戳|第\s*$|\b(?:id|code|sku|identifier|serial|version|model|date|timestamp|epoch|clock|year)\b)/iu;
const qualifiedLabel = /(?:每|人均|上限|下限|范围|区间|预计|估计|估算|大约|可能|不足|至少|至多|不超过|并非|否认|未达|\b(?:per|each|range|limit|bounded|estimated?|probably|possibly|not|approximately|about|maximum|minimum)\b)/iu;

function scalarRowUnit(quote, hit, wholeRow) {
  const prefix = quote.slice(0, hit.index);
  const before = wholeRow ? prefix : prefix.split(/[。；;，,]/u).at(-1);
  const tail = quote.slice(hit.index + hit[0].length);
  const match = leadingScalarUnit.exec(tail);
  const unit = match?.[1];
  if (!unit || !scalarUnits.has(unit) && !numericUnitConversion(unit, unit) ||
      locatorLabel.test(before) || qualifiedLabel.test(before)) return;
  const after = tail.slice(match[0].length);
  // An explicitly located token may be followed by prose. Never truncate a
  // rate, power, compound unit or qualified amount to its leading unit.
  if (/^\s*(?:[/／⁄·×÷*^²³]|每|力|平方|立方|per\b)/iu.test(after)) return;
  if (wholeRow && (!/^\s*[.。]?\s*$/u.test(after) ||
      /[,，;；。!?！？#/|*×÷+<>≤≥~≈±]|(?:^|\s)[−-]\s*$/u.test(before))) return;
  return unit;
}

export const sourceArithmeticSchema = {
  operation: { enum: Object.keys(operations) },
  operands: { type: "array", minItems: 2, maxItems: 4, items: {
    type: "object", properties: {
      file: { type: "string" },
      line: { type: "integer", minimum: 1 },
      column: { type: "integer", minimum: 1, description: "同一物理行 CSV 中的列号，1 起计。与 value 二选一。" },
      value: { type: "string", maxLength: 30, description: "已读原文行只含一个明确带单位的简单量时可省略。显式选数须逐字保留完整十进制数及分组符；CSV 用 column。" },
    }, required: ["file", "line"], additionalProperties: false,
  } },
  decimals: { type: "integer", minimum: 0, maximum: 6 },
  durationUnit: { enum: durationUnits, description: "复合时长换算。每个操作数只传 file 和 line，宿主取整段明确的时、分、秒。差值按所选单位输出，占比仍为百分比。" },
};

/** Only the active author and the two independent review roles can recompute
 * from their own reads. Author reads also need the unit's evidence grant. */
export function arithmeticSources(frame, active, spec) {
  if (!active || !spec || !["executor", "reviewer", "auditor"].includes(frame.role)) return [];
  const authorized = frame.role === "executor"
    ? spec.phases["final-review"].evidence.filter(file => includes(spec.phases["first-review"].evidence, file))
    : spec.phases[active.phase].evidence;
  return authorized.filter(file => includes(frame.reads, file) && frame.policy.sourcePins[keyOf(file)]);
}

/** Consume every numeral as one descending sequence of time components. This
 * prevents selecting only the minutes when the hour boundary also changed. */
function compoundDuration(quote) {
  const tokens = [...quote.matchAll(decimalToken)];
  const invalid = () => new Error("该原文行须含唯一、连续、没有限定词的完整复合时长");
  if (tokens.length < 1 || tokens.length > 3) throw invalid();
  let end = 0, previousFactor, ns = 0n;
  for (const { index, 0: raw } of tokens) {
    if (!/^\d+(?:\.\d+)?$/u.test(raw)) throw invalid();
    const connector = quote.slice(end, index);
    if (previousFactor === undefined ? /[\w.\-–—]$/u.test(connector)
      : !/^\s*(?:and|和|又|[,，、])?\s*$/iu.test(connector)) throw invalid();
    const unitMatch = durationPart.exec(quote.slice(index + raw.length));
    if (!unitMatch) throw invalid();
    const unit = (unitMatch[1] ?? unitMatch[2]).toLowerCase();
    const symbol = /^(?:h|小时)/u.test(unit) ? "h" : /^(?:m|分钟)/u.test(unit) ? "min" : "s";
    const factor = numericUnitConversion(symbol, "ns").from;
    const number = decimal(raw);
    if (previousFactor !== undefined && previousFactor <= factor) throw invalid();
    ns += number.n * factor / number.scale;
    previousFactor = factor;
    end = index + raw.length + unitMatch[0].length;
  }
  const start = tokens[0].index, relation = quantityRelation(quote, {start, end});
  if ((relation !== undefined && relation !== "exact") || /^\s*(?:\/|每|per\b)/iu.test(quote.slice(end))) throw invalid();
  return { number: { n: ns, scale: 1n }, raw: quote.slice(start, end), value: ns.toString(), unit: "ns" };
}

function sourceOperand(frame, active, files, ref, durationUnit, usesImplicitScalar) {
  const file = relativeName(ref?.file);
  if (!includes(files, file)) throw new Error("只可从本角色已获授权的登记原始证据复算 " + file);
  const bytes = readBytes(frame.root, file);
  const pin = frame.policy.sourcePins[keyOf(file)];
  const sha256 = bytes && digest(bytes);
  const seen = active.seen?.[keyOf(file)];
  const line = ref.line;
  if (!Number.isSafeInteger(line) || line < 1 || !sha256 || seen?.hash !== sha256 ||
      !seen.ranges.some(([start, end]) => start <= line && line <= end)) {
    throw new Error("先实际读取当前原始数据行 " + file);
  }
  const rows = registeredSourceRows(frame.root, file, bytes, pin);
  if (rows && !rows.has(line)) throw new Error("复算只可使用登记为原文的实际数据行 " + file);

  const quote = lineList(bytes)[line - 1];
  if (quote === undefined) throw new Error("原始数据行超出文件实际范围 " + file);
  if (durationUnit !== undefined) {
    if (ref.value !== undefined || ref.column !== undefined) throw new Error("复合时长使用完整登记原文行，只需 file 和 line");
    const { number, ...quantity } = compoundDuration(quote);
    return { number, evidence: { file, line, ...quantity, sha256 } };
  }
  let raw, unit;
  if (Number.isSafeInteger(ref.column) && ref.column > 0 && ref.value === undefined && quote.includes(",")) {
    raw = physicalCsvCells(quote)[ref.column - 1];
  } else if (ref.column === undefined && (ref.value === undefined || typeof ref.value === "string")) {
    const tokens = [...quote.matchAll(decimalToken)];
    const hits = ref.value === undefined ? tokens : tokens.filter(match => match[0] === ref.value);
    if (hits.length === 1) {
      const { index: start, 0: token } = hits[0], end = start + token.length;
      const tail = quote.slice(end);
      unit = /^\s*(%|％|‰|[a-zA-Zμ°]+(?:\/[a-zA-Z]+[²³]?)?|毫秒|秒|分钟|小时|千克|公斤|美元|人民币|人|次)(?![a-zA-Z])/u.exec(tail)?.[1];
      if (usesImplicitScalar) {
        // Keep all-explicit historical receipts byte compatible. For a new
        // line-only selection all units must agree, but only an omitted selector
        // requires the single quantity to occupy the whole physical line.
        unit = scalarRowUnit(quote, hits[0], ref.value === undefined);
        if (!unit) throw new Error("操作数须有明确单位，省略数值仅适用于单一实测量；请确认口径并选择原数值或 CSV 列号");
      }
      const unitEnd = unit ? end + tail.indexOf(unit) + unit.length : end;
      // In "12 or more", an apparent unit can be the start of a bound.
      // A bound after an actual unit and one after a bare number both apply.
      const boundaries = unitEnd === end ? [end] : [end, unitEnd];
      if (/^(?:and|or|to|but|nor|through|versus)$/iu.test(unit ?? "") || boundaries.some(boundary => {
        const relation = quantityRelation(quote, { start, end: boundary });
        return relation !== undefined && relation !== "exact";
      })) throw new Error("原文含限定词、区间或运算，须先确认计算口径："+quote.slice(Math.max(0,start-16),unitEnd+12));
      if (!/[\d._A-Za-z]$/u.test(quote.slice(0,start)) && !/^\.\d/u.test(tail)) raw = token;
    }
  }
  if (!raw) throw new Error("每个操作数需提供有效的 CSV 物理列号或本行唯一的原始数值");
  const value = canonicalDecimal(raw), number = decimal(value);
  return { number, evidence: { file, line, ...(ref.column ? { column: ref.column } : {}), value,
    ...(raw !== value ? { raw } : {}), ...(unit ? {unit} : {}), sha256 } };
}

/** Bind operands to current data and round once on the exact rational result.
 * The caller still establishes the comparability of the populations and units. */
export function calculateFromSources(frame, active, spec, { operation, operands, decimals = 2, durationUnit }) {
  const rule = Object.hasOwn(operations, operation) && operations[operation];
  if (!rule || !Array.isArray(operands) || operands.length !== rule.count ||
      !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new Error("按已选公式提供 2 或 4 个操作数，精度为 0–6 位小数");
  }
  const files = arithmeticSources(frame, active, spec);
  if (durationUnit !== undefined && !durationUnits.includes(durationUnit)) throw new Error("复合时长输出单位须为 h、min 或 s");
  const usesImplicitScalar = durationUnit === undefined && operands.some(ref => ref?.column === undefined && ref?.value === undefined);
  const sourced = operands.map(ref => sourceOperand(frame, active, files, ref, durationUnit, usesImplicitScalar));
  const units = sourced.map(row => row.evidence.unit);
  if (units.some(Boolean) && !units.every(unit => unit === units[0])) throw new Error("操作数单位不一致或不完整，请先统一单位并确认口径");
  // A common exact scale cancels in both ratio operations.
  const scale = 1_000_000_000n;
  const [a, b, c, d] = sourced.map(({ number }) => number.n * (scale / number.scale));
  const numerator = operation === "difference" ? a - b : operation === "share" ? a * 100n : (a - b) * 100n;
  const differenceScale = durationUnit ? scale * numericUnitConversion(durationUnit, "ns").from : scale;
  const denominator = operation === "difference" ? differenceScale : operation === "share" ? b : c - d;
  if (denominator <= 0n) throw new Error("当前口径的分母必须大于零");
  return { operation, formula: rule.formula, value: roundedDecimal(numerator, denominator, decimals), unit: operation === "difference" ? (durationUnit ?? units[0] ?? rule.unit) : rule.unit,
    operands: sourced.map(row => row.evidence) };
}

const escapeLiteral = text => text.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");

/** Resolve only the full authorized statement. Unrecognized wording or units
 * fall back to independent semantic review instead of a numeric verdict. */
export function measuredOriginalDisposition(frame, active, spec, id, location) {
  const rule = spec.originalMeasurements?.[id];
  if (!rule) return;
  const { file, line } = location;
  const original = workingMaterialReference(frame, active, spec, { file, start: line, end: line });
  const originalBytes = readBytes(frame.root, file);
  if (!originalBytes || digest(originalBytes) !== original.sha256) throw new Error("原稿已变更，须重新读取当前原句");
  const originalQuote = lineList(originalBytes)[line - 1];
  const marker = new RegExp("^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:\\*\\*)?" + escapeLiteral(id) +
    "(?:\\*\\*)?(?:\\s*[:：]\\s*|\\s+)", "u");
  const [left, right] = rule.statement.split("{quantity}").map(escapeLiteral);
  const literal = new RegExp("^" + left + "([+-]?\\d{1,18}(?:\\.\\d{1,9})?)\\s*([^\\s，。；]{1,40})" + right + "$", "u");
  const stated = literal.exec(originalQuote.replace(marker, "").trim());
  const statedScale = stated && numericUnitConversion(stated[2], rule.sourceUnit);
  if (!statedScale) return;

  const positions = [rule.header, rule.before.line, rule.after.line];
  const sources = positions.map(position => evidenceReference(frame, active, spec,
    { file: rule.source, start: position, end: position }));
  const bytes = readBytes(frame.root, rule.source);
  const sha256 = bytes && digest(bytes);
  if (!sha256 || sources.some(ref => ref.sha256 !== sha256)) throw new Error("原始表已变更，须重新读取所用数据行");
  const lines = lineList(bytes);
  const cells = position => {
    const row = lines[position - 1];
    if (!row) throw new Error("原稿复算需要可唯一定位的 CSV 物理行");
    return physicalCsvCells(row);
  };
  const headings = cells(rule.header);
  if (headings[rule.valueColumn - 1] !== rule.valueHeading || [rule.before, rule.after].some(endpoint => {
    const row = cells(endpoint.line);
    return row.length !== headings.length || row[rule.keyColumn - 1] !== endpoint.key;
  })) throw new Error("已登记的表头、物理列或原始记录主键与当前原文不一致");

  const observed = calculateFromSources(frame, active, spec, { operation: "difference", decimals: 6,
    operands: [rule.after.line, rule.before.line].map(position => ({ file: rule.source, line: position, column: rule.valueColumn })) });
  if (observed.operands.some(operand => operand.sha256 !== sha256)) throw new Error("原稿复算的记录已变更");
  const [later, earlier] = observed.operands.map(operand => decimal(operand.value));
  const numerator = later.n * earlier.scale - earlier.n * later.scale;
  const denominator = later.scale * earlier.scale;
  const reported = decimal(stated[1]);
  const equivalent = reported.n * statedScale.from * denominator === numerator * reported.scale * statedScale.to;
  const display = numericUnitConversion(rule.sourceUnit, rule.targetUnit);
  const displayNumerator = numerator * display.from, displayDenominator = denominator * display.to;
  const value = roundedDecimal(displayNumerator, displayDenominator, 9);
  const approximate = displayNumerator * 1_000_000_000n % displayDenominator !== 0n;
  return { decision: equivalent ? "保留" : "改正", value, expected: (approximate ? "约 " : "") + value + " " + rule.targetUnit,
    original, originalQuote, originalAmount: stated[1] + " " + stated[2], sources,
    source: { file: rule.source, start: Math.min(...positions), end: Math.max(...positions), sha256 },
    operands: observed.operands, basis: rule.after.key + " − " + rule.before.key + " 的「" + rule.valueHeading + "」同列差值" };
}
