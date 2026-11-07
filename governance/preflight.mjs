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

/** Remove only recognized locators. Facts after a citation remain in the comparison. */
function conclusion(body, files = []) {
  let result = body.normalize("NFKC").replaceAll("−", "-").replaceAll("\\", "/");
  for (const file of files) {
    const locator = new RegExp(escape(file.normalize("NFKC"))
      + "\\s*(?:#L\\d+(?:-L?\\d+)?|[:：]\\d+(?:[-–—]\\d+)?|第\\s*\\d+(?:\\s*[-–—、至到]\\s*\\d+)?\\s*行)", "gi");
    result = result.replace(locator, "");
  }
  return result.replace(/(?:出处|来源|证据|source|evidence)\s*[:：]/gi, "");
}

/** 消除排版差异，标题或标点调整不能伪装成实质补查。 */
function normalized(body) {
  return body.normalize("NFKC").replace(/[\s,，。;；!?“”‘’\x60*_()\[\]【】〔〕]+/g, "").toLowerCase();
}

/** A document-scoped numeric return may be repaired outside its valid numbered row. */
function documentHash(spec, lines) {
  return digest(normalized(conclusion(lines.join("\n"), spec.phases["final-review"].evidence)));
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
  return { version: 2, body: row.body, conclusion: digest(normalized(conclusion(row.body, spec.phases["final-review"].evidence))), refs };
}

/** 保存本轮被退回的实际断言，供下一轮逐项检查。 */
export function rejectedClaims(root, spec, lines, rejected, readable) {
  return Object.fromEntries(rejected.map(check => {
    const row = claimRow(lines, check.id) ?? (Number.isSafeInteger(check.line) && check.line > 0 && check.line <= lines.length
      ? { body: lines[check.line - 1] } : null);
    if (!row) throw new Error(check.id + " 的退回项缺少可定位的候选行，请提供编号行或候选行号");
    const baseline = shape(root, spec, row, readable);
    if (spec.calculations?.[check.id]?.scope === "document") baseline.documentHash = documentHash(spec, lines);
    return [check.id, baseline];
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
      if (rule.kind === "source-number") return sourceNumber(bytes, rule, lines, id, spec.phases["final-review"].evidence);
      const { expected, before, after } = calculate(bytes, rule);
      const row = claimRow(lines, id);
      const cites = row && citation(row.body, rule.source);
      const body = row ? conclusion(row.body, [rule.source]) : "";
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

/** Check direct numerical restatements; conversions require a different declared formula. */
function sourceNumber(bytes, rule, lines, id, evidence) {
  const source = lineList(bytes)[rule.line-1] ?? "";
  const pattern = new RegExp("([+-]?\\d+(?:\\.\\d+)?)\\s*" + escape(rule.sourceUnit),"gi");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error("原文指定行须含唯一的数值与单位");
  const expected = matches[0][1];
  const row = claimRow(lines,id);
  const body = row ? conclusion(row.body,[rule.source]) : "";
  const values = [...body.matchAll(/(?<![\dA-Za-z.])([+-]?\d+(?:\.\d+)?)/g)].map(m=>m[1]);
  const unitPattern = new RegExp("[+-]?\\d+(?:\\.\\d+)?\\s*(?:个\\s*)?(?:"+rule.units.map(escape).join("|")+")");
  const cited = row && citation(row.body,rule.source);
  const rowOk = values.length > 0 && values.every(value=>equalNumber(value,expected)) && unitPattern.test(body)
    && cited?.start <= rule.line && cited?.end >= rule.line;
  // This opt-in contract is for one scalar per declared unit across the document.
  // It deliberately does not infer quantities or support arbitrary conversions.
  const documentIssues = rule.scope === "document" ? directQuantityIssues(lines, rule, expected, evidence) : [];
  const ok = rowOk && documentIssues.length === 0;
  return { id,ok,expected:expected+" "+rule.units[0],source:rule.source,sourceHash:digest(bytes),line:rule.line,
    reported:values,scope:rule.scope ?? "claim",documentIssues,
    issue:ok?null:!rowOk?"本条直接转述须为原文的 "+expected+" "+rule.units[0]+"，引用原文第 "+rule.line+" 行；转换或旧错数不要混在当前事实行"
      :documentIssues.map(item=>"候选第 "+item.line+" 行："+item.issue).join("；") };
}

/** Reject literal mismatches and bounded comparisons around the declared quantity.
 * Comments, headings and explanatory paragraphs have no exemption. Pure statements
 * that the source gives no finer value are allowed; other semantic claims still
 * require independent full-document review, not a regex claim of general truth.
 */
function directQuantityIssues(lines, rule, expected, evidence) {
  const units = [...new Set([...rule.units,rule.sourceUnit])].sort((a,b)=>b.length-a.length).map(escape).join("|");
  const quantity = new RegExp("(?<![\\dA-Za-z.])([+-]?\\d+(?:\\.\\d+)?)\\s*(?:个\\s*)?(?:"+units+")(?![A-Za-z])","gi");
  const beforeBound = /(?:[<>≤≥]=?|超过|不足|至少|至多|大于|小于|多于|少于|高于|低于|不满|不超过|不低于|more\s+than|less\s+than|longer\s+than|shorter\s+than|at\s+least|at\s+most|over|under)\s*(?:约|大约)?\s*$/i;
  const afterBound = /^\s*(?:以上|以下|以外|以内|左右以外|或更多|或更少|[<>≤≥]=?)/;
  const compareAfter = /^\s*(?:略|稍|更|还|要|偏|稍微|略微)*\s*(?:长|短|多|少|大|小|高|低)/;
  const issues = [];
  for (const [index,line] of lines.entries()) {
    const body = conclusion(line,evidence);
    const quantities = [...body.matchAll(quantity)];
    // A direct restatement does not authorize extra operands or derived values in
    // the same line. Locators and URLs are metadata, not arithmetic operands.
    const statement = body.replace(/https?:\/\/[^\s）)\]】>"'“”]+/gi, "");
    const additionalNumbers = quantities.length ? [...statement.matchAll(/(?<![\dA-Za-z.])([+-]?\d+(?:\.\d+)?)/g)]
      .map(match=>match[1]).filter(value=>!equalNumber(value,expected)) : [];
    if (additionalNumbers.length) issues.push({line:index+1,text:line,reported:additionalNumbers,
      issue:"直接转述同一行包含其他操作数或结果；换算须另行登记原始量、单位与复算规则，不能混入本条直接转述"});
    for (const match of quantities) {
      const before = body.slice(0,match.index).split(/[，,。；;!?！？\n]/).at(-1);
      const after = body.slice(match.index+match[0].length).split(/[，,。；;!?！？\n]/)[0];
      const comparison = beforeBound.test(before) || afterBound.test(after)
        || /比\s*$/.test(before) && compareAfter.test(after);
      // A bare source numeral provides no warrant for an "exact" value. Only
      // positive precision labels adjacent to this quantity are checked here;
      // "the excerpt provides no finer value" has no such quantity-label pair.
      const exactness = /(?:精确值|精确数值|准确值|确切值|exact(?:ly)?|precisely)[^。；;，,!?！？]{0,24}$/i.test(before)
        || /^\s*(?:就是|即为|是|为|为其)\s*(?:精确值|精确数值|准确值|确切值)/.test(after);
      if (!equalNumber(match[1],expected) || comparison || exactness) {
        issues.push({line:index+1,text:line,reported:match[1],issue:exactness
          ? "原文给出数字不等于证明精确值；直接转述不得自行升级精度，改为说明原文给出的数值与未知边界"
          :comparison
          ? "直接转述契约没有授权给原文数值添加上下界或长短比较；删去无据推断，或先登记支持该关系的证据与核验规则"
          : "全文直接转述应为原文的 "+expected+" "+rule.units[0]+"，不能在说明段另添未经支持的数字"});
      }
    }
  }
  return issues;
}

/** 补查提交前逐项检查退回、遗漏事实及可复算数字。 */
export function supplementChecks(root, spec, lines, readable, active) {
  const issues = [];
  for (const finding of active.unlisted ?? []) {
    // Older receipts could wrongly classify a blank line as a fact. A blank can
    // never carry an assertion; ignoring that legacy entry prevents an impossible repair.
    if (!finding.text.trim()) continue;
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
    // A changed sentence still needs a verifiable locator before paying for final review.
    // A table elsewhere cannot substitute for the claim-level contract used by reviewChecks.
    if (!now.refs.length) {
      issues.push(id + " 改后断言须在同行引用授权证据及原文行号，并在本补查阶段实际读取；文末表格或项目规则不能代替事实出处");
    }
    if (before.version !== 2) {
      issues.push(id + " 的旧版退回基线不含完整断言，需重新独立核验，不能沿用截断摘要");
      continue;
    }
    // An outside-row repair is substantive only for an explicitly document-scoped
    // rule; numericChecks below still rejects the original error after unrelated edits.
    const documentChanged = spec.calculations?.[id]?.scope === "document"
      && before.documentHash && before.documentHash !== documentHash(spec, lines);
    if (before.conclusion === now.conclusion && !documentChanged && !now.refs.some(ref => !before.refs.some(old =>
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
