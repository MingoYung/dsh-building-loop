import { digest, includes, keyOf, readBytes, text } from "./policy.mjs";

export const QUALITY = {
  sources: "资料的原始出处、核实办法和仍待证的部分",
  conclusion: "可支持的结论、修订理由与适用范围",
  method: "采用的方法、复算或反查及其局限",
  alternatives: "可行的备选、取舍和更合适的提议",
  detail: "先摘要后依据的层次、读者需要的细节",
  plain: "面向读者的一句大白话",
};

export const lineList = bytes => text(bytes).split(/\r\n|\n|\r/);
const escape = value => value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");

/** 以唯一编号定位事实行，重复编号交回修改。 */
export function claimRow(lines, id) {
  const pattern = new RegExp("^\\s*(?:[-*]\\s+|\\d+[.)]\\s+)?(?:\\*\\*)?" + escape(id) + "(?:\\*\\*)?\\s*[:：]\\s*(.*)$");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]);
    if (match) found.push({ line: i + 1, body: match[1] });
  }
  return found.length === 1 ? found[0] : null;
}

/** 识别准确路径及原文行范围，排除同名前缀和备份别名。 */
export function citation(body, file) {
  const pattern = new RegExp("(^|[\\s:：\\x60\"'“‘(（\\[【〔<《,，、])" + escape(file)
    + "(?=$|[\\s#:,：，、。；;\\x60\"'”’）)\\]】〕>》]|\\.(?:\\s|$))", process.platform === "win32" ? "i" : "");
  const row = body.replaceAll("\\", "/");
  const match = pattern.exec(row);
  if (!match) return null;
  const after = row.slice(match.index + match[0].length);
  const range = /^\s*(?:\x60\s*)?(?:#L(\d+)(?:-L?(\d+))?|[:：](\d+)(?:[-–—](\d+))?|第\s*(\d+)(?:\s*[-–—、至到]\s*(\d+))?\s*行)/i.exec(after);
  if (!range) return { start: null, end: null };
  const start = Number(range[1] ?? range[3] ?? range[5]);
  const end = Number(range[2] ?? range[4] ?? range[6] ?? start);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start ? { start, end } : null;
}

/** 分离断言与出处，逐条比较补查是否改变有效结论。 */
function conclusion(body) {
  return body.normalize("NFKC").replaceAll("−", "-").split(/\s*[（(〔【\[]?\s*(?:出处|来源|证据|source|evidence)\s*[:：]/i, 1)[0];
}

/** 消除排版差异，标题或标点调整不能伪装成实质补查。 */
function normalized(body) {
  return body.normalize("NFKC").replace(/[\s,，。;；!?“”‘’\x60*_()\[\]【】〔〕]+/g, "").toLowerCase();
}

/** 对结论与已读证据位置建立可比对的退回基线。 */
function shape(root, spec, row, readable, seen) {
  const refs = [];
  for (const file of spec.phases["final-review"].evidence) {
    const locate = citation(row.body, file);
    if (!locate?.start || !includes(readable, file)) continue;
    const bytes = readBytes(root, file);
    if (!bytes || locate.end > lineList(bytes).length) continue;
    const hash = digest(bytes);
    const observed = seen?.[keyOf(file)];
    if (seen && (observed?.hash !== hash || !observed.ranges.some(([a, b]) => a <= locate.start && b >= locate.end))) continue;
    refs.push({ hash, start: locate.start, end: locate.end });
  }
  return { conclusion: digest(normalized(conclusion(row.body))), refs };
}

/** 保存本轮被退回的实际断言，供下一轮逐项检查。 */
export function rejectedClaims(root, spec, lines, rejected, readable) {
  return Object.fromEntries(rejected.map(check => {
    const row = claimRow(lines, check.id) ?? (Number.isSafeInteger(check.line) && check.line > 0 && check.line <= lines.length
      ? { body: lines[check.line - 1] } : null);
    if (!row) throw new Error(check.id + " 的退回项缺少可定位的候选行，请提供编号行或候选行号");
    return [check.id, shape(root, spec, row, readable)];
  }));
}

/** 把普通十进制拆成整数比，复算不依赖浮点近似。 */
function decimal(value) {
  const parsed = /^([+-]?)(\d{1,18})(?:\.(\d{1,9}))?$/.exec(value);
  if (!parsed) throw new Error("原始数值需要普通十进制数字");
  const fraction = parsed[3] ?? "";
  return { n: BigInt(parsed[2] + fraction) * (parsed[1] === "-" ? -1n : 1n), scale: 10n ** BigInt(fraction.length) };
}

/** 按数值比较百分比，允许等价的小数表示。 */
function equalNumber(left, right) {
  const a = decimal(left);
  const b = decimal(right);
  return a.n * b.scale === b.n * a.scale;
}

/** 输出按声明精度取整后的十进制结果。 */
function formatDecimal(n, places) {
  const prefix = n < 0n ? "-" : "";
  const digits = (n < 0n ? -n : n).toString().padStart(places + 1, "0");
  if (!places) return prefix + digits;
  return (prefix + digits.slice(0, -places) + "." + digits.slice(-places)).replace(/0+$/, "").replace(/\.$/, "");
}

/** 从指定 CSV 行取原始值，检查口径后复算相对降幅。 */
function calculate(bytes, rule) {
  const lines = lineList(bytes);
  if (lines.some(line => line.includes('"'))) throw new Error("复算支持无引号和无跨行字段的 UTF-8 CSV");
  const header = lines[0].split(",").map(x => x.trim());
  const key = header.indexOf(rule.keyColumn);
  const value = header.indexOf(rule.valueColumn);
  if (key < 0 || value < 0 || new Set(header).size !== header.length) throw new Error("复算 CSV 表头不匹配或有重复列");
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = lines[i].split(",").map(x => x.trim());
    if (cells.length !== header.length) throw new Error("复算 CSV 行列数量不一致");
    if (cells[key] !== rule.before && cells[key] !== rule.after) continue;
    if (rows.has(cells[key])) throw new Error("复算 CSV 匹配到重复数据行");
    rows.set(cells[key], { raw: cells[value], line: i + 1 });
  }
  const before = rows.get(rule.before);
  const after = rows.get(rule.after);
  if (!before || !after) throw new Error("缺少配置的基准行或对照行");
  const a = decimal(before.raw);
  const b = decimal(after.raw);
  if (a.n <= 0n || b.n < 0n) throw new Error("降幅复算需要正基准和非负对照值");
  const numerator = (a.n * b.scale - b.n * a.scale) * 100n * 10n ** BigInt(rule.decimals);
  const denominator = a.n * b.scale;
  const absolute = numerator < 0n ? -numerator : numerator;
  const rounded = ((2n * absolute + denominator) / (2n * denominator)) * (numerator < 0n ? -1n : 1n);
  return { expected: formatDecimal(rounded, rule.decimals), before, after };
}

/** 每次从当前原始文件计算，核结果、来源版本和引用行。 */
export function numericChecks(root, spec, lines, readable) {
  return Object.entries(spec.calculations).map(([id, rule]) => {
    try {
      if (!includes(readable, rule.source)) throw new Error("本阶段没有原始数据的读取授权");
      const bytes = readBytes(root, rule.source);
      if (!bytes) throw new Error("复算原始文件尚未提供");
      const { expected, before, after } = calculate(bytes, rule);
      const row = claimRow(lines, id);
      const cites = row && citation(row.body, rule.source);
      const body = row ? conclusion(row.body) : "";
      // A literal ×100% is a formula multiplier, while 24% in a claim is a result.
      const percentages = [...body.matchAll(/(?<![\dA-Za-z.,+\-])([+-]?\d+(?:\.\d+)?)\s*%/g)]
        .filter(match => !(match[1] === "100" && /[×*]\s*$/.test(body.slice(0, match.index))))
        .map(match => match[1]);
      const correct = percentages.length > 0 && percentages.every(value => equalNumber(value, expected));
      const coversRows = cites?.start && cites.start <= Math.min(before.line, after.line)
        && cites.end >= Math.max(before.line, after.line) && cites.end <= lineList(bytes).length;
      const issue = !correct ? "结论中的降幅应为 " + expected + "%"
        : !coversRows ? "出处须引用 " + rule.source + " 中两条原始数据行" : null;
      return {
        id, ok: issue === null, issue, expected: expected + "%", reported: percentages.map(value => value + "%"),
        source: rule.source, sourceHash: digest(bytes), before, after, formula: "(基准-对照)/基准×100",
      };
    } catch (error) { return { id, ok: false, source: rule.source, issue: error.message }; }
  });
}

/** 补查提交前逐项检查退回、遗漏事实及可复算数字。 */
export function supplementChecks(root, spec, lines, readable, active) {
  const issues = [];
  for (const finding of active.unlisted ?? []) {
    if (lines.some(line => normalized(line) === normalized(finding.text))) issues.push("候选第 " + finding.line + " 行的未登记事实仍未修订或编号溯源");
  }
  for (const id of active.unsupported ?? []) {
    const before = active.rejected?.[id];
    const row = claimRow(lines, id);
    if (!before) {
      issues.push(id + " 缺少退回基线，先记录阻塞并由总控重新发起补查");
      continue;
    }
    if (!row) {
      issues.push(id + " 需要保留唯一的编号断言行");
      continue;
    }
    const now = shape(root, spec, row, readable, active.seen);
    if (before.conclusion === now.conclusion && !now.refs.some(ref => !before.refs.some(old =>
      ref.hash === old.hash && old.start <= ref.start && old.end >= ref.end))) {
      issues.push(id + " 的退回结论与可定位证据均未变");
    }
  }
  const calculations = numericChecks(root, spec, lines, readable);
  for (const result of calculations) if (!result.ok) issues.push(result.id + " " + result.issue);
  return { ok: issues.length === 0, issues, calculations };
}

/** 质量说明须有具体内容或边界，拒绝空白和通用占位词。 */
function qualityText(value, field) {
  if (typeof value !== "string" || !value.trim() || /^(?:已核对|已检查|已优化|完成|通过|无|同上|ok|pass|n\/a)[。.!！]?$/i.test(value.trim())) {
    throw new Error("请给出质量项 " + field + " 的具体内容或适用边界");
  }
  if (value.length > 4000) throw new Error("质量项 " + field + " 超过 4000 字，请保留关键判断和证据路径");
  return value.trim();
}

/** 六项交付说明逐项保留，退回的质量项必须修订。 */
export function deliveryQuality(value, previous, rejected = []) {
  return Object.fromEntries(Object.keys(QUALITY).map(field => {
    const note = qualityText(value?.[field], field);
    if (rejected.includes(field) && normalized(note) === normalized(previous?.[field] ?? "")) {
      throw new Error("退回的质量项 " + field + " 没有修订");
    }
    return [field, note];
  }));
}

/** 独立核验的六项结果由明确退回项计算，保留具体依据。 */
export function reviewedQuality(value, revise) {
  if (!Array.isArray(revise) || revise.some(field => !Object.hasOwn(QUALITY, field))) {
    throw new Error("revise 只能列出需要退回的质量项名称");
  }
  return Object.fromEntries(Object.keys(QUALITY).map(field => [field, {
    pass: !revise.includes(field), basis: qualityText(value[field], field),
  }]));
}
