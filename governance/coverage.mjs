import { digest, readBytes } from "./policy.mjs";
import { citation, claimRow, lineList, numericChecks } from "./preflight.mjs";
import { evidenceReference } from "./evidence.mjs";

export const COVERAGE_VERSION = 1;
const KINDS = ["direct", "inference", "nonfactual", "hypothesis", "error-example"];
const STATUSES = ["supported", "unsupported", "uncertain"];
// These unambiguous surface connectives are a conservative minimum, not a
// universal parser. Untagged/implicit deductions remain the reviewers' duty.
const explicitInference = text => /(?:因此|所以|由此(?:可见|可得|推出)?|据此(?:可知|推出)?|therefore|\bhence\b|\bthus\b)/i.test(text);
const errorExample = text => /^\s*(?:[-*#>]\s*)?(?:\[(?:误读|错例|错误示例|错误推理)\]|(?:误读|错例|错误示例|错误推理)\s*[:：])/u.test(text);

/** Build the mandatory inventory from actual bytes, not a model-selected fact list.
 * Every nonblank character belongs to one block. Sentence punctuation splits long
 * lines; commas, headings, tables, code and footnotes are retained with their context.
 * A block is a text boundary, not a claim that linguistic atomization is solved.
 */
export function documentCoverage(bytes) {
  const blocks = [];
  for (const [row, line] of lineList(bytes).entries()) {
    for (const match of line.matchAll(/[^。！？；;!?]+[。！？；;!?]*|[。！？；;!?]+/gu)) {
      const content = match[0].trim();
      if (!content) continue;
      const start = match.index + match[0].indexOf(content);
      blocks.push({ id: "B" + (blocks.length + 1) + "-" + digest(content).slice(0, 8),
        line: row + 1, start, end: start + content.length, text: content, lineText: line,
        requiresInference: explicitInference(content) && !errorExample(content), stance: errorExample(content) ? "error-example"
          : /^\s*(?:[-*#>]\s*)?\[(?:推测|假设|未证实|Hypothesis|Unverified)\]/i.test(content) ? "hypothesis" : "asserted-unless-nonfactual" });
    }
  }
  if (!blocks.length) throw new Error("候选为空，不能用空覆盖清单验收");
  return { version: COVERAGE_VERSION, candidateSha256: digest(bytes), blocks };
}

/** Demand a concrete explanation while keeping small reviews compact. */
function explanation(value, label, limit = 1200) {
  if (typeof value !== "string" || !value.trim() || value.length > limit
    || /^(?:无|通过|已核对|已检查|合理|无反例|没有反例|不适用|ok|pass|none|n\/a)[。.!！]?$/i.test(value.trim())) {
    throw new Error(label + "需要具体内容，不能仅填通过、无反例或占位词");
  }
  return value.trim();
}

/** Verify exact quotations against authorized, actually read current source lines. */
function sourceQuote(frame, active, spec, value) {
  const ref = evidenceReference(frame, active, spec, value);
  const original = lineList(readBytes(frame.root, ref.file)).slice(ref.start - 1, ref.end).join("\n");
  if (typeof value.quote !== "string" || !value.quote.trim() || value.quote.length > 2000 || !original.includes(value.quote)) {
    throw new Error("证据 quote 必须逐字出现在所指原文行，不能用概括或自己补写的桥接条件代替");
  }
  return { ...ref, quote: value.quote };
}

/** Validate the supplied finite proof, including its scope and counterexample test.
 * The source-to-proposition interpretation is still semantic and is checked again
 * by a separate blind auditor; these structural checks never certify it by themselves.
 */
function inferenceProof(frame, active, spec, value, lines) {
  if (!value || !["source-warrant", "modus-ponens", "equality-transitive", "configured-calculation"].includes(value.rule)) {
    throw new Error("推导需明确 rule：source-warrant、modus-ponens、equality-transitive 或 configured-calculation");
  }
  if (!Array.isArray(value.premises) || !value.premises.length || value.premises.length > 12) throw new Error("推导须逐项列 premises 原始前提，不得引用候选自证");
  const premises = value.premises.map(ref => sourceQuote(frame, active, spec, ref));
  // A structured scope is semantically equivalent to the short text contract;
  // preserve it instead of misreporting a meaningful object as empty evidence.
  const scope = typeof value.scope === "string" ? explanation(value.scope, "推导的对象、概念含义和适用条件")
    : value.scope && Array.isArray(value.scope.objects) && value.scope.objects.length
      && Array.isArray(value.scope.conditions) && value.scope.conditions.length
      && value.scope.objects.length <= 12 && value.scope.conditions.length <= 12
      ? { objects: value.scope.objects.map(item => explanation(item,"适用对象")),
        conditions: value.scope.conditions.map(item => explanation(item,"适用条件")) }
      : (() => { throw new Error("inference.scope 须为具体说明字符串，或 {objects:[具体对象],conditions:[具体条件]}；不能省略对象或条件"); })();
  if (!Array.isArray(value.assumptions) || value.assumptions.length > 12) throw new Error("额外假设须显式列 assumptions，无额外假设填 []");
  const assumptions = value.assumptions.map(item => ({ statement: explanation(item.statement, "假设"),
    evidence: sourceQuote(frame, active, spec, item.evidence) }));
  const counterexample = value.counterexample;
  if (typeof counterexample?.possible !== "boolean") throw new Error("须判断前提成立而结论不成立的反例是否可能，counterexample.possible 为布尔值");
  const counter = { possible: counterexample.possible, reason: explanation(counterexample.reason, "反例或排除反例的理由") };
  const proof = { rule: value.rule, premises, scope, assumptions, counterexample: counter };
  if (value.rule === "source-warrant") {
    if (!Array.isArray(value.warrant) || !value.warrant.length || value.warrant.length > 8) throw new Error("自然语言推导须 warrant 指出原文中的桥接关系，不能仅重复结论");
    proof.warrant = value.warrant.map(ref => sourceQuote(frame, active, spec, ref));
  } else if (value.rule === "configured-calculation") {
    const calculation = spec.calculations[value.calculation];
    if (!calculation || calculation.kind === "source-number") throw new Error("推导 calculation 须绑定实际计算规则，数值转述不是换算证明");
    const result = numericChecks(frame.root, spec, lines, frame.reads).find(row => row.id === value.calculation);
    if (!result?.ok) throw new Error("所绑定计算未通过脚本复算");
    proof.calculation = result;
  } else {
    const form = value.formal;
    if (premises.length !== 2 || !form || !Array.isArray(form.premises) || form.premises.length !== 2) throw new Error('形式推导须两条原始前提及 formal.premises；modus-ponens 结构示例：{"premises":[{"relation":"implies","left":"P","right":"Q"},{"relation":"asserts","left":"P"}],"conclusion":{"relation":"asserts","left":"Q"}}。把P/Q替换为同一对象的具体命题；若仅转述原文单向规则，可用 source-warrant 和逐字关系引句。');
    if ([...form.premises, form.conclusion].some(row => !row || typeof row.left !== "string" || !row.left.trim())) throw new Error("每条形式命题必须绑定具体概念 left");
    const symbols = [...form.premises.flatMap(row => [row.left, row.right]), form.conclusion.left, form.conclusion.right].filter(x => x !== undefined);
    if (symbols.some(x => typeof x !== "string" || !x.trim() || x.length > 300)) throw new Error("形式命题中的概念须明确且一致");
    const [a, b] = form.premises, c = form.conclusion;
    const valid = value.rule === "modus-ponens"
      ? a.relation === "implies" && b.relation === "asserts" && c?.relation === "asserts" && typeof a.right === "string" && a.left === b.left && a.right === c.left && b.right === undefined && c.right === undefined
      : a.relation === "equals" && b.relation === "equals" && c?.relation === "equals" && typeof a.right === "string" && typeof b.right === "string" && a.right === b.left && a.left === c.left && b.right === c.right;
    if (!valid) throw new Error("形式推导不成立：不能倒置条件、偷换概念或引入前提里没有的对象。"
      + (value.rule === "modus-ponens" ? '需要第一项 implies(P,Q)、第二项 asserts(P)、结论 asserts(Q)；asserts 省略 right。'
        : '需要 equals(A,B)、equals(B,C)、结论 equals(A,C)。')
      + " 当前提交=" + JSON.stringify(form));
    proof.formal = form;
  }
  return proof;
}

/** Bind every part to a real, nonoverlapping span; leaving even a suffix unassigned fails. */
function reviewBlock(frame, active, spec, block, parts, lines) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 20) throw new Error(block.id + " 需 parts，复合句请拆出各独立判断");
  let cursor = 0;
  const reviewed = parts.map(part => {
    const quote = part.quote ?? (parts.length === 1 ? block.text : undefined);
    if (typeof quote !== "string" || !quote.trim()) throw new Error("多段拆分须为每段填写连续原文 quote");
    const start = block.text.indexOf(quote, cursor);
    if (start < 0 || block.text.slice(cursor, start).trim()) throw new Error(block.id + " 的拆分遗漏或改写了原文，请连续覆盖整个块");
    cursor = start + quote.length;
    if (!KINDS.includes(part.kind) || !STATUSES.includes(part.status)) throw new Error("每段须声明 kind 与 supported/unsupported/uncertain");
    const basis = explanation(part.basis, "该段的判断依据");
    const result = { quote, start, end: cursor, kind: part.kind, status: part.status, basis };
    if (errorExample(quote) && part.kind !== "error-example") throw new Error("正文已明确标为误读/错例，请用 error-example 核验它的反证，不要把展示错误误当成作者认可该结论。这是核验分类修正，不是正文返工。");
    if (part.kind === "direct" && explicitInference(quote)) throw new Error("该段含明确推导连接词，不能用 direct 跳过推导。改用 inference；这只是核验分类修正，不要求作者改正文。若来源本身已写明关系，可用 source-warrant。不要把未明确标注的错误断言解释成教学反例。");
    if (["direct", "inference"].includes(part.kind)) {
      // Source agreement is assessed independently of inferred author intent.
      // A reviewer who recognizes a contradiction cannot mark the assertion as
      // supported by calling it an unlabelled example or a rhetorical device.
      if (!["supports", "contradicts", "insufficient"].includes(part.sourceRelation)) throw new Error("事实段必须单独给 sourceRelation=supports|contradicts|insufficient：按原句字面判断证据关系，不能因猜测作者在举反例而改成支持。未显式标注错例的句子按断言核验。");
      result.sourceRelation = part.sourceRelation;
      if (part.status === "supported" && part.sourceRelation !== "supports") throw new Error("原文关系为 " + part.sourceRelation + "，该断言不能 supported。请给实际事实退回；写作者须明确修订或标注错例，核验者不能自行补上写作意图。");
    }
    if (part.kind === "error-example") {
      if (!errorExample(quote)) throw new Error("error-example 须在该原句开头明确写 [误读]/[错例] 或 误读：/错例：等标签，不能自行猜测作者意图");
      if (!["contradicts", "insufficient"].includes(part.sourceRelation)) throw new Error("错例须指出所展示推理与原文矛盾或证据不足，sourceRelation 不可写 supports");
      if (!Array.isArray(part.evidence) || !part.evidence.length) throw new Error("错例须给实际已读的 evidence 反证或推理依据及逐字引句");
      result.sourceRelation = part.sourceRelation;
      result.evidence = part.evidence.map(ref => sourceQuote(frame,active,spec,ref));
      result.inputStatus = part.status;
      result.status = "illustrated-error"; // Never becomes an established premise.
    } else if (part.kind === "hypothesis") {
      if (!/^\s*(?:[-*#>]\s*)?\[(?:推测|假设|未证实|Hypothesis|Unverified)\]/i.test(quote)) throw new Error("假设须在正文显式以 [推测]、[假设] 或 [未证实] 标注，不能仅在回执中降级");
      // The visible hypothesis marker already fixes its epistemic status. Keep
      // the model's input for audit, but never promote it to an established fact
      // or force another paid call just to repeat this redundant enum.
      if (part.status !== "uncertain") result.inputStatus = part.status;
      result.status = "uncertain";
    } else if (part.kind === "nonfactual") {
      if (part.status !== "supported") throw new Error("非事实分类须明确 supported；含事实的标题或说明按 direct/inference 核验");
    } else if (part.status === "supported") {
      if (part.kind === "direct") {
        if (!Array.isArray(part.evidence) || !part.evidence.length || part.evidence.length > 12) throw new Error("直接事实须给 evidence 原文及逐字 quote");
        result.evidence = part.evidence.map(ref => sourceQuote(frame, active, spec, ref));
      } else {
        result.inference = inferenceProof(frame, active, spec, part.inference, lines);
        if (result.inference.counterexample.possible) {
          result.status = "uncertain";
          result.repair = "存在前提成立而结论不成立的反例，补充排除它的依据或收窄结论";
          result.finding = { kind: "invalid-inference", quote, fix: result.repair };
        }
      }
    }
    if (["direct", "inference"].includes(part.kind) && result.status !== "supported") {
      // Factual debt needs a real disputed assertion, not optional wording advice.
      // As in numbered checks, malformed classifications stay with the reviewer.
      if (!result.finding) {
        const finding = part.finding;
        if (!finding || !["missing-evidence", "contradiction", "scope", "invalid-inference"].includes(finding.kind)
          || typeof finding.quote !== "string" || !finding.quote.trim() || !quote.includes(finding.quote)) {
          throw new Error("事实退回须 finding.kind/quote/fix，quote 指该段实际的错误断言；排版、详细度和收尾表达建议只能走质量判断，不能冒充事实错误");
        }
        result.finding = { kind: finding.kind, quote: finding.quote, fix: explanation(finding.fix, "事实最小修正") };
        result.repair = result.finding.fix;
        if (finding.kind === "contradiction" && !part.evidence?.length) throw new Error("矛盾退回须 evidence 给实际原文反证及逐字引句");
      }
      if (part.evidence?.length) result.evidence = part.evidence.map(ref => sourceQuote(frame, active, spec, ref));
    }
    return result;
  });
  if (block.text.slice(cursor).trim()) throw new Error(block.id + " 的末尾仍有未覆盖内容");
  return { block: block.id, line: block.line, text: block.text, lineText: block.lineText, parts: reviewed };
}

/** Inventory and per-block decisions are incremental, bounded calls under the host lock. */
export function coverageAction(frame, active, spec, args) {
  const bytes = readBytes(frame.root, spec.candidate);
  if (!bytes) throw new Error("候选不存在");
  const manifest = documentCoverage(bytes);
  if (args.action === "inventory") {
    if (active.coverage?.candidateSha256 !== manifest.candidateSha256 || active.coverage?.version !== COVERAGE_VERSION) {
      active.coverage = { version: COVERAGE_VERSION, candidateSha256: manifest.candidateSha256, records: {} };
      frame.changed = true;
    }
    const offset = args.offset ?? 0, count = args.count ?? 8;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > 24) throw new Error("覆盖分页 offset/count 无效，每页最多 24 块");
    return { candidateSha256: manifest.candidateSha256, total: manifest.blocks.length,
      pending: manifest.blocks.filter(b => !Object.hasOwn(active.coverage.records, b.id)).map(b => b.id),
      blocks: manifest.blocks.slice(offset, offset + count).map(({ lineText, ...block }) => block) };
  }
  if (active.coverage?.version !== COVERAGE_VERSION || active.coverage.candidateSha256 !== manifest.candidateSha256) throw new Error("请先 inventory 当前正文；正文变化后旧覆盖记录失效");
  if (args.action === "status") return coverageSummary(frame, active, spec, false);
  if (args.action !== "record" || !Array.isArray(args.entries) || !args.entries.length || args.entries.length > 12) throw new Error("record 每次提交 1–12 个 entries");
  const records = { ...active.coverage.records }, supplied = new Set();
  for (const entry of args.entries) {
    const block = manifest.blocks.find(row => row.id === entry.block);
    if (!block || supplied.has(entry.block)) throw new Error("覆盖编号不存在或重复，请使用 inventory 返回的当前编号");
    supplied.add(entry.block);
    records[block.id] = reviewBlock(frame, active, spec, block, entry.parts, lineList(bytes));
  }
  active.coverage.records = records;
  frame.changed = true;
  const result = coverageSummary(frame, active, spec, false);
  return { recorded: [...supplied], total: result.total, pending: result.pending, rejected: result.rejected };
}

/** Revalidate every source on completion so fresh reading cannot legitimize a stale proof. */
export function coverageSummary(frame, active, spec, complete = true) {
  const bytes = readBytes(frame.root, spec.candidate);
  const manifest = documentCoverage(bytes);
  const inventory = active.coverage;
  if (inventory?.version !== COVERAGE_VERSION || inventory.candidateSha256 !== manifest.candidateSha256) throw new Error("当前正文尚无有效全文覆盖记录，请 inventory 后逐块 record");
  const pending = manifest.blocks.filter(b => !Object.hasOwn(inventory.records, b.id)).map(b => b.id);
  if (complete && pending.length) throw new Error("全文仍有 " + pending.length + " 个未核块：" + pending.slice(0, 12).join(", ") + "；unlisted=[] 不能代替覆盖记录");
  const records = manifest.blocks.flatMap(block => inventory.records[block.id] ? [inventory.records[block.id]] : []);
  if (complete) for (const id of spec.claims) {
    const row = claimRow(lineList(bytes), id);
    if (row && !records.some(record => record.line === row.line && record.parts.some(part => ["direct", "inference"].includes(part.kind)))) {
      throw new Error("必核断言 " + id + " 不能全部分类成非事实或假设后跳过核验");
    }
  }
  for (const record of records) for (const part of record.parts) {
    const refs = [...(part.evidence ?? []), ...(part.inference?.premises ?? []), ...(part.inference?.warrant ?? []),
      ...(part.inference?.assumptions ?? []).map(row => row.evidence)];
    for (const ref of refs) {
      const current = sourceQuote(frame, active, spec, ref);
      if (ref.sha256 !== current.sha256) throw new Error("覆盖证据版本已经变化，须重新判断该块而非仅重读文件");
    }
    if (part.inference?.calculation) {
      const current = numericChecks(frame.root, spec, lineList(bytes), frame.reads).find(r => r.id === part.inference.calculation.id);
      if (!current?.ok || current.sourceHash !== part.inference.calculation.sourceHash) throw new Error("推导绑定的脚本计算已失效");
    }
  }
  const rejected = records.flatMap(record => record.parts.filter(part => ["direct", "inference"].includes(part.kind) && part.status !== "supported")
    .map(part => ({ block: record.block, line: record.line, text: part.quote, lineText: record.lineText,
      basis: part.basis, repair: part.repair, finding: part.finding, status: part.status })));
  const quotations = complete ? quotationChecks(frame, active, spec, manifest) : [];
  for (const quote of quotations.filter(row => !row.matches)) rejected.push({ block: quote.block, line: quote.line,
    text: quote.text, lineText: quote.lineText, status: "unsupported", sourceRelation: "contradicts",
    basis: "声明为逐字原文的引句与同行所引原文范围不一致，不能用意思相近替代逐字引用。",
    repair: "换成原文中实际存在的逐字引句，或明确改称转述，不冒充原话。",
    finding: { kind: "verbatim-quote", quote: quote.text, fix: "恢复逐字引句或改称转述。" } });
  return { version: COVERAGE_VERSION, candidateSha256: manifest.candidateSha256, total: manifest.blocks.length,
    pending, rejected, records, quotations, receiptSha256: digest(JSON.stringify({ records, quotations })) };
}

/** Deterministic validation of explicitly verbatim, inline-located quotations.
 * Other quotation styles still need semantic review; this rule never silently
 * invents a reference for a footnote or interprets a paraphrase as a direct quote.
 */
function quotationChecks(frame, active, spec, manifest) {
  const results = [];
  const normalize = value => value.replace(/\s+/gu," ").trim();
  const lines = lineList(readBytes(frame.root,spec.candidate));
  for (const [index,line] of lines.entries()) {
    for (const match of line.matchAll(/(?:原文|原句|逐字引文)\s*(?:为|是|写道|[:：])?\s*[“"]([^”"\n]{1,2000})[”"]/gu)) {
      const locators = spec.phases[active.phase].evidence.flatMap(file => {
        const cited = citation(line,file);
        return cited?.start ? [{file,start:cited.start,end:cited.end}] : [];
      });
      if (!locators.length) continue; // No invented cross-reference; the reviewer must resolve it.
      const refs = locators.map(ref => evidenceReference(frame,active,spec,ref));
      const matches = refs.some(ref => normalize(lineList(readBytes(frame.root,ref.file)).slice(ref.start-1,ref.end).join("\n")).includes(normalize(match[1])));
      results.push({block:manifest.blocks.find(b=>b.line===index+1&&b.start<=match.index&&b.end>match.index)?.id ?? "Q"+(index+1),
        line:index+1,text:match[0],lineText:line,refs,matches});
    }
  }
  return results;
}

/** Separate a new unsupported finding from a reviewer classification disagreement. */
export function classificationDisagreements(first, second) {
  return first.records.flatMap(record => {
    const other = second.records.find(row => row.block === record.block);
    const factual = row => row.parts.some(part => ["direct", "inference"].includes(part.kind));
    return other && factual(record) !== factual(other) ? [{ block: record.block, line: record.line,
      text: record.text, basis: "两位核验者对该块是否包含事实判断存在分歧，先重核分类，不能当作无事实略过" }] : [];
  });
}

/** Shared schema keeps formal premises, quoted evidence and the tool contract aligned. */
export function coverageSchema() {
  const string = { type: "string" }, integer = { type: "integer" };
  const ref = { type: "object", properties: { file: string, start: integer, end: integer, quote: string }, required: ["file", "start", "end", "quote"], additionalProperties: false };
  const proposition = { type: "object", properties: { relation: { type: "string", enum: ["implies", "asserts", "equals"] },
    left: { ...string, description: "具体命题/对象标识。implies 表示 left→right；asserts 仅断言 left；equals 表示 left=right。同一命题必须用相同字符串。" },
    right: { ...string, description: "仅 implies/equals 必填；asserts 必须省略，不填空串或复述左项。" } }, required: ["relation", "left"], additionalProperties: false };
  const inference = { type: "object", properties: {
    rule: { type: "string", enum: ["source-warrant", "modus-ponens", "equality-transitive", "configured-calculation"] },
    premises: { type: "array", items: ref }, warrant: { type: "array", items: ref },
    scope: { anyOf: [string, { type: "object", properties: { objects: {type:"array",items:string,minItems:1,maxItems:12}, conditions: {type:"array",items:string,minItems:1,maxItems:12} }, required:["objects","conditions"],additionalProperties:false }],description:"具体说明适用对象、概念和条件，可用短句或明确的 objects/conditions 对象。" },
    assumptions: { type: "array", items: { type: "object", properties: { statement: string, evidence: ref }, required: ["statement", "evidence"], additionalProperties: false } },
    counterexample: { type: "object", properties: { possible: { type: "boolean" }, reason: string }, required: ["possible", "reason"], additionalProperties: false },
    formal: { type: "object", description: "modus-ponens 的两项依次为 implies(P,Q)、asserts(P)，结论 asserts(Q)；equality-transitive 为 equals(A,B)、equals(B,C)，结论 equals(A,C)。premises 与原文前提顺序一致。", properties: { premises: { type: "array", minItems: 2, maxItems: 2, items: proposition }, conclusion: proposition }, required: ["premises", "conclusion"], additionalProperties: false }, calculation: string,
  }, required: ["rule", "premises", "scope", "assumptions", "counterexample"], additionalProperties: false };
  return { offset: integer, count: integer, entries: { type: "array", minItems: 1, maxItems: 12,
    description: "每次提交1至12块，按 inventory 分页分批提交；不能把全文超过12块塞进一次调用。", items: { type: "object", properties: {
    block: string, parts: { type: "array", items: { type: "object", properties: {
      quote: { ...string, description: "单段可省略，自动取整块原文；多段必须逐段连续覆盖整块" },
      kind: { type: "string", enum: KINDS }, status: { type: "string", enum: STATUSES,
        description: "direct/inference 给事实判定；nonfactual 用 supported；hypothesis 宿主固定 uncertain，不能成为已证前提。" }, basis: string, repair: string,
      sourceRelation: { type: "string", enum: ["supports", "contradicts", "insufficient"], description: "direct/inference 必填：原始证据对该断言字面含义的关系。error-example 核展示的错误推理，只能 contradicts/insufficient，并提供 evidence；明确错例的状态由宿主固定，不作为已证前提。" },
      finding: { type: "object", properties: { kind: { type: "string", enum: ["missing-evidence", "contradiction", "scope", "invalid-inference"] }, quote: string, fix: string }, required: ["kind", "quote", "fix"], additionalProperties: false },
      evidence: { type: "array", items: ref }, inference,
    }, required: ["kind", "status", "basis"], additionalProperties: false } },
  }, required: ["block", "parts"], additionalProperties: false } } };
}
