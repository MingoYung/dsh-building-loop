import { digest, keyOf, readBytes } from "./policy.mjs";
import { citation, claimRow, lineList, numericChecks, errorExample, repairBaseline } from "./preflight.mjs";
import { evidenceReference, UnobservedExcerptError } from "./evidence.mjs";

export const COVERAGE_VERSION = 1;
// Only this error authorizes persisting a failed call's proof invalidation. Other
// failures retain the ordinary all-or-nothing state transaction behavior.
export class CoverageRecordError extends Error {}
const KINDS = ["direct", "inference", "nonfactual", "hypothesis", "error-example"];
const STATUSES = ["supported", "unsupported", "uncertain"];
// These unambiguous surface connectives are a conservative minimum, not a
// universal parser. Untagged/implicit deductions remain the reviewers' duty.
const explicitInference = text => /(?:因此|所以|由此(?:可见|可得|推出)?|据此(?:可知|推出)?|therefore|\bhence\b|\bthus\b)/i.test(text);

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
  // An acquisition receipt registers independent excerpts, not a continuous page.
  // Preserve per-line citations instead of inventing a bridge between excerpts.
  if (ref.origin?.observation && /[\r\n]/u.test(value.quote)) throw new Error("登记的独立来源摘录不能用跨行 quote 拼成连续原话，请逐行分别引用");
  return { ...ref, quote: value.quote };
}

/** Bind arithmetic to the exact reviewed span and the CSV rows actually used.
 * A passing C-number elsewhere is not evidence for this part. The second probe
 * reuses only this physical claim line's verified locator, so splitting a label
 * or citation into another part does not force the author to rewrite the line.
 * This checks arithmetic identity, not the semantic scope of a numerical claim.
 */
function configuredCalculation(frame, spec, id, lines, assertion, premises) {
  const calculation = spec.calculations[id];
  if (!calculation || calculation.kind === "source-number") throw new Error("推导 calculation 须绑定实际计算规则，数值转述不是换算证明");
  const row = claimRow(lines, id);
  if (!row || row.line !== assertion.line) throw new Error("当前推导断言须绑定 " + id + " 的唯一事实行，不能借用别处通过的计算编号");
  const actual = lines[assertion.line - 1];
  if (!Number.isSafeInteger(assertion.start) || !Number.isSafeInteger(assertion.end)
    || assertion.start < 0 || assertion.end <= assertion.start || actual.slice(assertion.start, assertion.end) !== assertion.quote) {
    throw new Error("当前复算断言的原文片段与宿主行位置不一致");
  }
  const calculationSpec = { ...spec, calculations: { [id]: calculation } };
  const result = numericChecks(frame.root, calculationSpec, lines, frame.reads)[0];
  if (!result?.ok) throw new Error("所绑定计算未通过脚本复算");
  const cited = citation(row.body, result.source);
  // This is an arithmetic probe, not a candidate edit or invented source claim:
  // use the exact part's numbers and the already-verified same-line locator.
  const scopedLine = id + "：" + assertion.quote + "（出处：" + result.source + " 第 " + cited.start + "-" + cited.end + " 行）";
  const scoped = numericChecks(frame.root, calculationSpec, [scopedLine], frame.reads)[0];
  if (!scoped?.ok) throw new Error("当前断言片段本身须包含该复算结果，不能借用同行其他片段的数字：" + scoped?.issue);
  if (!premises.length || premises.some(ref => keyOf(ref.file) !== keyOf(result.source) || ref.sha256 !== result.sourceHash)) {
    throw new Error("复算前提须全部来自实际计算的当前原始数据文件 " + result.source);
  }
  const sourceLines = lineList(readBytes(frame.root, result.source));
  // A broad locator is not enough: the quotation itself must cover both complete
  // data rows. Separate before/after refs and harmless outer whitespace are valid.
  for (const rawRow of [result.before.line, result.after.line]) {
    const covered = premises.some(ref => {
      if (ref.start > rawRow || ref.end < rawRow) return false;
      const excerpt = sourceLines.slice(ref.start - 1, ref.end).join("\n");
      const original = sourceLines[rawRow - 1], content = original.trim();
      const offset = sourceLines.slice(ref.start - 1, rawRow - 1).reduce((sum, line) => sum + line.length + 1, 0) + original.indexOf(content);
      let at = -1;
      while ((at = excerpt.indexOf(ref.quote, at + 1)) !== -1) {
        if (at <= offset && at + ref.quote.length >= offset + content.length) return true;
      }
      return false;
    });
    if (!covered) throw new Error("复算前提的逐字引句须覆盖实际原始数据第 " + rawRow + " 行，不能只扩大引用范围或引用无关行");
  }
  return { ...result, assertion: { line: assertion.line, start: assertion.start, end: assertion.end, quoteSha256: digest(assertion.quote) } };
}

/** Validate the supplied finite proof, including its scope and counterexample test.
 * The source-to-proposition interpretation is still semantic and is checked again
 * by a separate blind auditor; these structural checks never certify it by themselves.
 */
function inferenceProof(frame, active, spec, value, lines, assertion) {
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
    proof.calculation = configuredCalculation(frame, spec, value.calculation, lines, assertion, premises);
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

/** Explain an exact span failure with bounded source text and a precise cursor.
 * The supplied quote remains untrusted: diagnostics never repair, classify or
 * accept it. Offsets use JavaScript UTF-16 units, as documentCoverage already does.
 */
function spanError(block, part, cursor, quote, reason) {
  const remaining = block.text.slice(cursor);
  const leading = remaining.length - remaining.trimStart().length;
  const expectedStart = cursor + (typeof quote === "string" && /^\s/u.test(quote) ? 0 : leading);
  const expected = block.text.slice(expectedStart);
  const supplied = typeof quote === "string" ? quote : "";
  let common = 0;
  while (common < expected.length && common < supplied.length && expected[common] === supplied[common]) common++;
  // Small blocks are returned whole. Long blocks show the failing neighborhood,
  // not an unbounded duplicate of a potentially very long document line.
  const from = block.text.length <= 800 ? 0 : Math.max(0, Math.min(expectedStart - 100, block.text.length - 800));
  const diagnostic = {
    block: block.id, line: block.line, part, reason, offsetUnit: "UTF-16", cursor,
    blockLength: block.text.length,
    firstMismatch: { blockOffset: expectedStart + common, partOffset: common,
      expected: expected[common] ?? null, received: supplied[common] ?? null },
    blockText: { from, text: block.text.slice(from, from + 800), truncated: block.text.length > 800 },
    expectedSuffix: { from: expectedStart, text: expected.slice(0, 240), truncated: expected.length > 240 },
    receivedQuote: { text: supplied.slice(0, 240), truncated: supplied.length > 240 },
  };
  const issue = reason === "missing-tail" ? "的末尾仍有未覆盖内容"
    : reason === "missing-quote" ? "多段拆分须为每段填写连续原文 quote"
    : reason === "past-block-end" ? "当前块已全部覆盖，后续 part 已越过块尾，不能把下一块原文放入本块"
    : "的拆分遗漏或改写了原文，请连续覆盖整个块";
  return new Error(block.id + " " + issue + "。[coverage-span] " + JSON.stringify(diagnostic)
    + "。只修正核验参数，不改写候选。单一判断可省 quote，由宿主取整块；复合判断仍须按真实原文连续拆分。"
    + "其他块须用它自己的编号提交；不得降为 nonfactual、跳过推导或省掉任何正文内容。");
}

/** Bind every part to a real, nonoverlapping span; leaving even a suffix unassigned fails. */
function reviewBlock(frame, active, spec, block, parts, lines) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 20) throw new Error(block.id + " 需 parts，复合句请拆出各独立判断");
  let cursor = 0;
  const reviewed = parts.map((part, index) => {
    const quote = part.quote ?? (parts.length === 1 ? block.text : undefined);
    if (typeof quote !== "string" || !quote.trim()) throw spanError(block,index+1,cursor,quote,"missing-quote");
    const start = block.text.indexOf(quote, cursor);
    if (start < 0 || block.text.slice(cursor, start).trim()) {
      throw spanError(block,index+1,cursor,quote,cursor===block.text.length?"past-block-end":start<0?"quote-mismatch":"gap-before-part");
    }
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
      if (!errorExample(quote)) throw new Error("error-example 须在该原句开头明确写 [误读]/[错例] 或 误读：/错例 1：/错误示例二：等标签，不能自行猜测作者意图或从前一标题继承标签");
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
        result.inference = inferenceProof(frame, active, spec, part.inference, lines,
          { line: block.line, start: block.start + start, end: block.start + cursor, quote });
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
          || typeof finding.quote !== "string" || !finding.quote.trim() || !quote.includes(finding.quote)
          || quote.indexOf(finding.quote,quote.indexOf(finding.quote)+1)!==-1) {
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
  if (block.text.slice(cursor).trim()) throw spanError(block,parts.length+1,cursor,undefined,"missing-tail");
  return { block: block.id, line: block.line, text: block.text, lineText: block.lineText, parts: reviewed };
}

/** Inventory and per-block decisions are incremental, bounded calls under the host lock. */
export function coverageAction(frame, active, spec, args, options = {}) {
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
    const invalidated = retireStaleProofs(frame, active, spec, bytes, manifest);
    const pending = manifest.blocks.filter(b => !Object.hasOwn(active.coverage.records, b.id)).map(b => b.id);
    const result = { candidateSha256: manifest.candidateSha256, total: manifest.blocks.length,
      pending: options.maxBytes ? pending.slice(0,24) : pending, pendingCount: pending.length,
      invalidated:options.maxBytes?invalidated.slice(0,8).map(row=>({...row,reason:row.reason.slice(0,240),
        ...(row.reason.length>240?{reasonTruncated:true}:{})})):invalidated,
      invalidatedCount:invalidated.length,offset,blocks:[] };
    for (const {lineText,...block} of manifest.blocks.slice(offset,offset+count)) {
      // prepare has a separate response budget. Never stamp blocks removed by
      // that budget as shown; the explicit next page remains unobserved.
      if (options.maxBytes && Buffer.byteLength(JSON.stringify({...result,blocks:[...result.blocks,block]}))>options.maxBytes-400) break;
      result.blocks.push(block);
    }
    if (offset+result.blocks.length<manifest.blocks.length) result.next = {
      tool:"building_loop_coverage",action:"inventory",offset:offset+result.blocks.length,count:result.blocks.length?24:1,
      note:"pending 仅是待核编号；record 前必须取得该块的 inventory 原文，不能按编号猜内容。",
    };
    active.coverage.presented=[...new Set([...(active.coverage.presented??[]),...result.blocks.map(block=>block.id)])];
    active.coverage.presentationOwner={actor:frame.agent?.id??null,phase:active.phase,candidateSha256:manifest.candidateSha256};
    frame.changed=true;
    return result;
  }
  if (active.coverage?.version !== COVERAGE_VERSION || active.coverage.candidateSha256 !== manifest.candidateSha256) throw new Error("请先 inventory 当前正文；正文变化后旧覆盖记录失效");
  if (args.action === "status") {
    const summary = coverageSummary(frame, active, spec, false);
    // Status is a progress query, not another full proof download. A reviewer may
    // explicitly inspect one prior block; the complete proof remains in host state.
    if (args.block !== undefined && !manifest.blocks.some(row => row.id === args.block)) throw new Error("未知覆盖块编号");
    const { records, ...compact } = summary;
    return { ...compact, ...(args.block === undefined ? {} : { record: records.find(row => row.block === args.block) ?? null }) };
  }
  if (args.action !== "record" || !Array.isArray(args.entries) || !args.entries.length || args.entries.length > 12) throw new Error("record 每次提交 1–12 个 entries");
  // A source change can invalidate more blocks than fit in one record call.
  // Retire them before incremental repair, so an untouched stale block cannot
  // roll back eleven newly checked proofs. Completion still rechecks every ref.
  const invalidated = retireStaleProofs(frame, active, spec, bytes, manifest);
  const records = { ...active.coverage.records }, supplied = new Set(), invalid = [];
  for (const entry of args.entries) {
    const block = manifest.blocks.find(row => row.id === entry.block);
    if (!block || supplied.has(entry.block)) throw new Error("覆盖编号不存在或重复，请使用 inventory 返回的当前编号");
    supplied.add(entry.block);
    try {
      const owner=active.coverage.presentationOwner;
      if (owner?.actor!==(frame.agent?.id??null)||owner.phase!==active.phase||owner.candidateSha256!==manifest.candidateSha256
        ||!active.coverage.presented?.includes(block.id)) throw new Error("该块尚未由本会话本阶段 inventory/prepare 实际返回；pending 编号不能代替块原文。请调用 inventory offset="+manifest.blocks.indexOf(block)+" count=1 后再判断，不要猜编号对应内容。");
      records[block.id] = reviewBlock(frame, active, spec, block, entry.parts, lineList(bytes));
      requireDisputedProof(active,[records[block.id]]);
    }
    catch (error) {
      // One malformed block must not make the model resend eleven valid proofs.
      // It also must not retain an older accepted record for the failed replacement.
      delete records[block.id];
      invalid.push({ block: block.id, error: error.message });
    }
  }
  active.coverage.records = records;
  frame.changed = true;
  if (invalid.length === supplied.size) throw new CoverageRecordError(invalid.map(row => row.block + ": " + row.error).join("；"));
  const result = coverageSummary(frame, active, spec, false);
  return { recorded: [...supplied].filter(id => !invalid.some(row => row.block === id)), invalid,
    invalidated, total: result.total, pending: result.pending, rejected: result.rejected };
}

/** Reuse one binding check for active reviews and already accepted host proofs. */
function validateCalculationPart(frame, spec, part, lines, block) {
  const previous = part.inference?.calculation;
  if (!previous) {
    if (part.inference?.rule === "configured-calculation") throw new Error("宿主缺少已绑定的计算结果，须重新核验");
    return;
  }
  if (!block) throw new Error("推导绑定的当前正文块已失效");
  const current = configuredCalculation(frame, spec, previous.id, lines,
    { line: block.line, start: block.start + part.start, end: block.start + part.end, quote: part.quote }, part.inference.premises ?? []);
  // Older receipts have no assertion field: recheck their actual record/part
  // under the same gate without inventing a historical binding or rewriting it.
  if (current.sourceHash !== previous.sourceHash || current.expected !== previous.expected
    || JSON.stringify(current.before) !== JSON.stringify(previous.before) || JSON.stringify(current.after) !== JSON.stringify(previous.after)
    || (previous.assertion && JSON.stringify(current.assertion) !== JSON.stringify(previous.assertion))) {
    throw new Error("推导绑定的脚本计算或原文片段已失效");
  }
}

/** Host-only closure check, including old receipts that predate span bindings.
 * The caller has already pinned proof/source versions. Recompute from the unit's
 * authorized review material without granting coordinator tools, claiming a new
 * model read, returning private evidence, or rewriting the historical receipt.
 */
export function requireStoredCalculations(frame, spec, coverages, bytes) {
  const lines = lineList(bytes), manifest = documentCoverage(bytes);
  const blocks = new Map(manifest.blocks.map(block => [block.id, block]));
  const hostFrame = { root: frame.root, reads: spec.phases["final-review"].read };
  try {
    for (const coverage of coverages) for (const record of coverage.records) {
      for (const part of record.parts) validateCalculationPart(hostFrame, spec, part, lines, blocks.get(record.block));
    }
  } catch {
    // Detailed arithmetic diagnostics belong to the authorized review session,
    // not the coordinator's closure tool response.
    throw new Error("已验收计算证明失效，须重新核验");
  }
}

/** The same strict version/read/pin checks serve both progress and acceptance.
 * Retiring a stale proof means pending, never a verdict about the new source.
 */
function validateRecordSources(frame, active, spec, record, lines, block) {
  for (const part of record.parts) {
    const refs = [...(part.evidence ?? []), ...(part.inference?.premises ?? []), ...(part.inference?.warrant ?? []),
      ...(part.inference?.assumptions ?? []).map(row => row.evidence)];
    for (const ref of refs) {
      const current = sourceQuote(frame, active, spec, ref);
      if (ref.sha256 !== current.sha256) throw new Error("覆盖证据版本已经变化，须重新判断该块而非仅重读文件");
    }
    validateCalculationPart(frame, spec, part, lines, block);
  }
}

/** Keep independent unaffected blocks; explicitly expose every invalidation. */
function retireStaleProofs(frame, active, spec, bytes, manifest) {
  const invalidated = [];
  const lines = lineList(bytes);
  const blocks = new Map(manifest.blocks.map(block => [block.id, block]));
  for (const [id, record] of Object.entries(active.coverage.records)) {
    try { validateRecordSources(frame, active, spec, record, lines, blocks.get(id)); }
    catch (error) {
      delete active.coverage.records[id];
      invalidated.push({ block: id, reason: error.message });
      frame.changed = true;
    }
  }
  return invalidated;
}

/** Revalidate every source on completion so fresh reading cannot legitimize a stale proof. */
export function coverageSummary(frame, active, spec, complete = true) {
  const bytes = readBytes(frame.root, spec.candidate);
  const lines=lineList(bytes);
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
  const blocks = new Map(manifest.blocks.map(block => [block.id, block]));
  for (const record of records) validateRecordSources(frame, active, spec, record, lines, blocks.get(record.block));
  const rejected = records.flatMap(record => record.parts.filter(part => ["direct", "inference"].includes(part.kind) && part.status !== "supported")
    .map(part => {
      const finding={block:record.block,line:record.line,text:part.quote,lineText:record.lineText,
        basis:part.basis,repair:part.repair,finding:part.finding,status:part.status};
      const refs=[...(part.evidence??[]),...(part.inference?.premises??[]),...(part.inference?.warrant??[]),
        ...(part.inference?.assumptions??[]).map(item=>item.evidence)];
      const contextStart=blocks.get(record.block).start+part.start;
      return {...finding,repairBaseline:repairBaseline(frame.root,spec,lines,{...finding,contextStart},frame.reads,active.seen,refs)};
    }));
  const quotations = complete ? quotationChecks(frame, active, spec, manifest) : [];
  for (const quote of quotations.filter(row => !row.matches)) rejected.push({ block: quote.block, line: quote.line,
    text: quote.text, lineText: quote.lineText, status: "unsupported", sourceRelation: "contradicts",
    basis: "声明为逐字原文的引句与同行所引原文范围不一致，不能用意思相近替代逐字引用。",
    repair: "换成原文中实际存在的逐字引句，或明确改称转述，不冒充原话。",
    finding: { kind: "verbatim-quote", quote: quote.text, fix: "恢复逐字引句或改称转述。" },
    repairBaseline:repairBaseline(frame.root,spec,lines,{line:quote.line,text:quote.text,quote:quote.text,contextStart:quote.contextStart},frame.reads,active.seen,quote.refs) });
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
      const refs = [];
      const excludedLocators = [];
      for (const locator of locators) {
        try { refs.push(evidenceReference(frame, active, spec, locator)); }
        catch (error) {
          // A verified receipt can establish a wrong locator in the manuscript.
          // An unread range or broken receipt still blocks the reviewer instead.
          if (!(error instanceof UnobservedExcerptError)) throw error;
          excludedLocators.push(locator);
        }
      }
      const matches = refs.some(ref => {
        const excerpt = lineList(readBytes(frame.root,ref.file)).slice(ref.start-1,ref.end);
        // Observed excerpts remain independent even when Markdown whitespace is
        // normalized; ordinary continuous local sources retain multi-line quotes.
        return ref.origin?.observation ? excerpt.some(line => normalize(line).includes(normalize(match[1])))
          : normalize(excerpt.join("\n")).includes(normalize(match[1]));
      });
      results.push({block:manifest.blocks.find(b=>b.line===index+1&&b.start<=match.index&&b.end>match.index)?.id ?? "Q"+(index+1),
        line:index+1,text:match[0],lineText:line,contextStart:match.index,refs,matches,
        ...(excludedLocators.length ? { excludedLocators } : {}) });
    }
  }
  return results;
}

/** Separate a new unsupported finding from a reviewer classification disagreement. */
export function classificationDisagreements(first, second) {
  return first.records.flatMap(record => {
    const other = second.records.find(row => row.block === record.block);
    if(!other)return [];
    const factual=row=>{
      const mask=new Uint8Array(record.text.length);
      for(const part of row.parts.filter(value=>["direct","inference"].includes(value.kind))) {
        const start=Number.isSafeInteger(part.start)?part.start:0,end=Number.isSafeInteger(part.end)?part.end:record.text.length;
        mask.fill(1,Math.max(0,start),Math.min(mask.length,end));
      }
      return mask;
    };
    const a=factual(record),b=factual(other),factualSpans=[];
    for(let i=0;i<record.text.length;i++)if(record.text[i].trim()&&a[i]!==b[i]) {
      const prior=factualSpans.at(-1);
      if(prior&&!record.text.slice(prior[1],i).trim())prior[1]=i+1;
      else factualSpans.push([i,i+1]);
    }
    // Both reviews may contain some facts while disagreeing about an appended
    // assertion. Compare factual coverage by span, not one Boolean per block.
    return factualSpans.length ? [{ block: record.block, line: record.line, text: record.text,factualSpans,
      basis: "两位核验者对该块是否包含事实判断存在分歧。争议范围须按 direct/inference 实质核证，不能原样 nonfactual 重送；依据不足请 block 说明待维护者裁定，不要求作者改写正确正文。" }] : [];
  });
}

/** A disputed factual span cannot disappear behind a different category label.
 * Both roles retain their own proof; only candidate spans, never the other
 * role's source mapping or verdict, are exchanged as the work to reconcile.
 */
export function requireDisputedProof(active, records, complete=false) {
  for(const dispute of active.reconciliation??[]) {
    const record=records.find(row=>row.block===dispute.block);
    if(!record&&!complete)continue;
    const spans=dispute.factualSpans?.length?dispute.factualSpans:[[0,dispute.text.length]];
    const missing=!record||spans.some(([a,b])=>Array.from({length:b-a},(_,i)=>a+i)
      .some(i=>dispute.text[i]?.trim()&&!record.parts.some(part=>["direct","inference"].includes(part.kind)&&part.start<=i&&part.end>i)));
    if(missing)throw new Error("[building-loop/reconciliation] "+dispute.block+" 的事实分类争议尚未逐项落实。"
      +"已标记范围必须重新以 direct/inference 提交实际证据和推导，不能原样 nonfactual/hypothesis 再送。"
      +"不确定或无依据时用 building_loop block 说明需维护者裁定；不要编证据，也不要要求作者改写正确正文。范围="+JSON.stringify(spans));
  }
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
  return { offset: integer, count: integer, block: { ...string, description: "status 可选：只取这一块已有的详细证明；省略时只返回进度摘要。" }, entries: { type: "array", minItems: 1, maxItems: 12,
    description: "每次提交1至12块，按 inventory 分页分批提交；不能把全文超过12块塞进一次调用。", items: { type: "object", properties: {
    block: string, parts: { type: "array", items: { type: "object", properties: {
      quote: { ...string, description: "单一判断可省略，自动取该块完整原文；复合判断须逐段连续覆盖本块，不能把下一块文字并入。匹配失败按 coverage-span 的 part/cursor/expectedSuffix 修正核验参数，不得改写正文或省掉事实。" },
      kind: { type: "string", enum: KINDS }, status: { type: "string", enum: STATUSES,
        description: "direct/inference 给事实判定；nonfactual 用 supported；hypothesis 宿主固定 uncertain，不能成为已证前提。" }, basis: string, repair: string,
      sourceRelation: { type: "string", enum: ["supports", "contradicts", "insufficient"], description: "direct/inference 必填：原始证据对该断言字面含义的关系。error-example 核展示的错误推理，只能 contradicts/insufficient，并提供 evidence；明确错例的状态由宿主固定，不作为已证前提。" },
      finding: { type: "object", properties: { kind: { type: "string", enum: ["missing-evidence", "contradiction", "scope", "invalid-inference"] }, quote: string, fix: string }, required: ["kind", "quote", "fix"], additionalProperties: false },
      evidence: { type: "array", items: ref }, inference,
    }, required: ["kind", "status", "basis"], additionalProperties: false } },
  }, required: ["block", "parts"], additionalProperties: false } } };
}
