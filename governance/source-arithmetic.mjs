import { evidenceReference, registeredSourceRows, workingMaterialReference } from "./evidence.mjs";
import { decimal, lineList, roundedDecimal } from "./preflight.mjs";
import { digest, includes, keyOf, numericUnitConversion, readBytes, relativeName } from "./policy.mjs";

const operations = {
  difference: { count: 2, formula: "a − b", unit: "原单位" },
  share: { count: 2, formula: "a / b × 100", unit: "%" },
  "change-share": { count: 4, formula: "(a − b) / (c − d) × 100", unit: "%" },
};
const decimalToken = /(?<![\d.])[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\d.])/gu;

export const sourceArithmeticSchema = {
  operation: { enum: Object.keys(operations) },
  operands: { type: "array", minItems: 2, maxItems: 4, items: {
    type: "object", properties: {
      file: { type: "string" },
      line: { type: "integer", minimum: 1 },
      column: { type: "integer", minimum: 1, description: "无引号 CSV 中的物理列号，1 起计。与 value 二选一。" },
      value: { type: "string", maxLength: 30, description: "非 CSV 原文行中唯一出现的十进制数，须逐字相同。" },
    }, required: ["file", "line"], additionalProperties: false,
  } },
  decimals: { type: "integer", minimum: 0, maximum: 6 },
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

function sourceOperand(frame, active, files, ref) {
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
  let value;
  if (Number.isSafeInteger(ref.column) && ref.column > 0 && ref.value === undefined && !quote.includes('"') && quote.includes(",")) {
    value = quote.split(",")[ref.column - 1]?.trim();
  } else if (ref.column === undefined && typeof ref.value === "string" &&
      [...quote.matchAll(decimalToken)].filter(match => match[0] === ref.value).length === 1) {
    value = ref.value;
  }
  if (!value) throw new Error("每个操作数需提供有效的 CSV 物理列号或本行唯一的原始数值");
  const number = decimal(value);
  return { number, evidence: { file, line, ...(ref.column ? { column: ref.column } : {}), value, sha256 } };
}

/** Bind operands to current data and round once on the exact rational result.
 * The caller still establishes the comparability of the populations and units. */
export function calculateFromSources(frame, active, spec, { operation, operands, decimals = 2 }) {
  const rule = Object.hasOwn(operations, operation) && operations[operation];
  if (!rule || !Array.isArray(operands) || operands.length !== rule.count ||
      !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new Error("按已选公式提供 2 或 4 个操作数，精度为 0–6 位小数");
  }
  const files = arithmeticSources(frame, active, spec);
  const sourced = operands.map(ref => sourceOperand(frame, active, files, ref));
  // A common exact scale cancels in both ratio operations.
  const scale = 1_000_000_000n;
  const [a, b, c, d] = sourced.map(({ number }) => number.n * (scale / number.scale));
  const numerator = operation === "difference" ? a - b : operation === "share" ? a * 100n : (a - b) * 100n;
  const denominator = operation === "difference" ? scale : operation === "share" ? b : c - d;
  if (denominator <= 0n) throw new Error("当前口径的分母必须大于零");
  return { operation, formula: rule.formula, value: roundedDecimal(numerator, denominator, decimals), unit: rule.unit,
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
    if (!row || row.includes('"')) throw new Error("原稿复算需要可唯一定位的无引号 CSV 行");
    return row.split(",").map(cell => cell.trim());
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
