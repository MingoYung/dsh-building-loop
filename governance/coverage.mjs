import { digest, includes, keyOf, readBytes, relativeName } from "./policy.mjs";
import { citation, claimRow, lineList, numericChecks, errorExample, repairBaseline } from "./preflight.mjs";
import { evidenceReference, registeredObservation, UnobservedExcerptError } from "./evidence.mjs";

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

/** Object-check failures distinguish a review-parameter/read problem from a
 * measured manuscript contradiction. Only the latter creates author repair debt. */
function objectFailure(category,message,details={}) {
  return new Error("[coverage-object] "+JSON.stringify({category,message,...details}));
}
const objectMarker=value=>/^\s*(?:[-*+]\s+|\d+[.)]\s+)?\[(摘录范围|稿件自述)\]/u.exec(value)?.[1];
const explanationTail=value=>{
  const match=/(?:——|—|--)\s*(?:不成立\s*[:：]|错在\s*[:：]?|错误在于\s*[:：]?)/u.exec(value);
  return match&&value.slice(match.index+match[0].length).trim()?match.index+match[0].indexOf(match[0].replace(/^(?:——|—|--)\s*/u,"")):-1;
};

/** One pure counting primitive serves review and post-read execution preflight.
 * Each source counts physical lines with a recognized inline locator, not blocks,
 * examples, bare filename mentions, or multiple occurrences on the same line.
 * Callers decide how many line numbers to show; internal results remain complete.
 */
export function citationLineCounts(bytes,files) {
  const lines=lineList(bytes),seen=new Set();
  return files.flatMap(value=>{
    const source=relativeName(value),key=keyOf(source);if(seen.has(key))return [];seen.add(key);
    const matched=lines.flatMap((line,index)=>citation(line,source)?.start?[index+1]:[]);
    return [{source,count:matched.length,lines:matched}];
  });
}

/** Small, kind-specific parameter examples repair the call, never its evidence.
 * Preserve a supplied valid numeric type as an example; it is still checked
 * against the original sentence, and zero is explicitly only a template value.
 */
function objectGuide(input,spec,assertion,phase) {
  const targets=spec.phases[phase].evidence.filter(file=>keyOf(file)!==keyOf(spec.candidate)&&citation(assertion.quote,file));
  const target=targets.length===1?targets[0]:"原句引用的授权来源.md";
  const expected=Number.isSafeInteger(input?.expected)&&input.expected>=0?input.expected:0;
  const examples={
    candidate:[{kind:"candidate",check:"citation-count",source:target,expected},{kind:"candidate",check:"citations-marked",source:target,marker:"原句声明的确切标记"}],
    "registered-excerpts":[{kind:"registered-excerpts",check:"count",file:target,expected},{kind:"registered-excerpts",check:"contains",file:target,quote:"原句中要核对的单行原文"},
      {kind:"registered-excerpts",check:"excludes",file:target,quote:"原句中明确说未见的单行文本"},{kind:"registered-excerpts",check:"line-status",file:target,line:1,expected:"registered"}],
  };
  return {templates:examples[input?.kind]??examples,next:"只按原句选择一个模板并替换示例值；删除其他模板的字段，再提交同一块。不要为参数错误改作者正文。",
    parameterRules:["candidate 不支持 count：用 citation-count；source 是本句引用目标，不能填候选文件 "+spec.candidate+"，也没有 sources 数组字段。",
      "expected 必须是原句明确声称的数量；示例0不是实测值。registered-excerpts/count 统计已登记摘录条目，结论类别或举例数量不能当摘录总数。",
      "file 与 source 按模板二选一；contains/excludes 用 quote，line-status 用 line/expected，citations-marked 用 marker，不混字段。",
      "citation-count 可核末尾完整行号表（第2、4-6行），数量和全表均须相符；citations-marked 仅核明确正向全称标记句，如‘本稿所有 来源.md 引用行都含[模拟]标记’，不能替数量、未全标或完全没标作证。"]};
}
function objectMismatchNext(value) {
  if(value.kind==="candidate")return value.check==="citation-count"
    ?"核对 source 是否为原句引用目标，并按实际物理引用行数复核；有完整行号表时还须逐项核对 claimedLines、missingLines、extraLines、duplicateLines。若只是填错参数，改参数；若原句精确数量或行号表确错，提交 unsupported 与指向实际错处的 finding，保留此 objectCheck 作反证。"
    :"逐项复核 missingLines 是否缺少原句声明的字面标记。确实缺标才提交 unsupported 与实际 finding；若原句指全局说明而非逐行标记，当前谓词不能代证，应改核验方式。";
  if(value.check==="count")return "actual 是登记摘录条目总数，不是其中举例或结论类别数。先核原句是否在声称这个总数；参数错就改参数，原句总数确错才提交 unsupported 与实际 finding，禁止把 expected 改成 actual 来掩盖原句错误。";
  return "核对原句限定范围及谓词：contains/excludes 只核登记集合的确切文本，line-status 只核指定快照行是否登记。参数或谓词不符先改调用；确认原句确错后另提交 unsupported 与实际 finding，不把当前结果扩大成网页全文结论。";
}

const regexLiteral=value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const candidateClause=value=>value.normalize("NFKC").trim()
  .replace(/^(?:[-*+]\s+|\d+[.)]\s+)?(?:\[稿件自述\]\s*)?/u,"")
  .replace(/[。.!！?？;；]\s*$/u,"").trim();
const quotedLiteral=value=>{
  const literal=regexLiteral(value.normalize("NFKC"));
  return "(?:"+literal+"|`"+literal+"`|\""+literal+"\"|'"+literal+"'|“"+literal+"”|「"+literal+"」|『"+literal+"』)";
};

/** A finite manuscript count grammar identifies the optional exact ordinal list.
 * The list is another assertion, not ignorable citation punctuation: every row
 * is expanded and checked against the full current set below, beyond previews.
 * Unrecognized/oversize list syntax stays a parameter error, not author debt.
 */
function candidateCountClaim(quote,source,guide) {
  const clause=candidateClause(quote),path=quotedLiteral(source),number="(?:\\d+|[零〇一二两三四五六七八九十]+)",subject="(?:本稿|本文|本节|稿件|候选稿?|当前文档)(?:中)?";
  const bound=new RegExp("^"+subject+"\\s*(?:对\\s*"+path+"\\s*有\\s*"+number+"\\s*行可识别同行引用|有\\s*"+number+"\\s*行带\\s*"+path+"\\s*的行号定位|带\\s*"+path+"\\s*行号定位的共\\s*"+number+"\\s*行)$","u");
  const suffix=/(?:\(\s*第\s*([^()]+?)\s*行\s*\)|,\s*(?:即|分别为)\s*第\s*([^()]+?)\s*行)$/u.exec(clause);
  if(!suffix) {
    if(/第\s*\d+\s*[,、]\s*\d/u.test(clause))throw objectFailure("parameter","行号清单须是同一计数句末尾完整的（第2、4-6行）或‘，即第2、4-6行’，不能忽略未核列表",guide);
    return {quantityQuote:quote,fullyBound:bound.test(clause)};
  }
  const quantityQuote=clause.slice(0,suffix.index).trim(),list=(suffix[1]??suffix[2]).trim();
  if(!bound.test(quantityQuote))throw objectFailure("parameter","带行号表的 citation-count 只核明确稿件计数句；请拆开外部行号、标记或其他独立断言，保留作者原文",{...guide,countForms:["本稿有6行带 "+source+" 的行号定位（第2、4-8行）","本稿对 "+source+" 有2行可识别同行引用（第2、4行）"]});
  const claimedLines=[];
  for(const item of list.split(/[,、]/u)) {
    const match=/^\s*(?:第\s*)?([1-9]\d*)(?:\s*[-–—至到]\s*(?:第\s*)?([1-9]\d*))?\s*$/u.exec(item);
    if(!match)throw objectFailure("parameter","完整行号表仅支持正整数及递增范围，以顿号/逗号分隔；不接受省略号、‘等’或附加断言",guide);
    const first=Number(match[1]),last=Number(match[2]??match[1]);
    if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||last<first||last-first+1>256-claimedLines.length)throw objectFailure("parameter","完整行号表每次最多256项，须为安全正整数及递增范围；超出范围请单独核验，不能截断清单",guide);
    for(let line=first;line<=last;line++)claimedLines.push(line);
  }
  return {quantityQuote,claimedLines,fullyBound:true};
}

/** This predicate has only a positive, universal, literal-label meaning.
 * Anchor the whole clause, so a filename/count, a negative claim, or a genuine
 * extra assertion cannot borrow the accidental presence of a marker as proof.
 * Not-all and none are distinct predicates and are deliberately unsupported.
 */
function candidateMarkClaim(quote,source,marker,guide) {
  if(typeof marker!=="string"||!marker.trim()||marker.length>80||/[\r\n]/u.test(marker)||!quote.includes(marker))throw objectFailure("parameter","marker 须是本句声明的明确单行标记，最长80字符",guide);
  if(source.normalize("NFKC").includes(marker.normalize("NFKC")))throw objectFailure("parameter","引用来源路径及其片段不能充当 marker；文件名的出现不证明已标记",guide);
  const subject="(?:本稿|本文|本节|稿件|候选稿?|当前文档)(?:中)?",target=quotedLiteral(source),label=quotedLiteral(marker);
  const action="(?:含有?|带有|标有|标注(?:为|了)?|标记(?:为|了)?|标了)\\s*"+label+"(?:\\s*标记)?";
  const contract=new RegExp("^"+subject+"\\s*(?:(?:所有|全部)\\s*"+target+"\\s*(?:的)?引用行(?:都|均)\\s*"+action+"|引用\\s*"+target+"\\s*的每(?:一)?行(?:都|均)\\s*"+action+"|(?:带|有)\\s*"+target+"\\s*(?:的)?行号定位的每(?:一)?行(?:都|均)\\s*"+action+")$","u");
  if(!contract.test(candidateClause(quote)))throw objectFailure("parameter","citations-marked 须绑定完整正向全称标记句、同一来源和明确标记动作；数量/行号表请用 citation-count，‘未全标’与‘完全没标’均不能用此谓词代证",{...guide,claimForm:"本稿所有 "+source+" 引用行都含"+marker+"标记。",next:"只修核验参数；若同句另有数量、否定或独立后半句，请按实际原文拆分核验，不要求作者改写正确句子。"});
}

/** Bind a count parameter to the same visible quantity, not a C-number or locator. */
function countAssertion(quote,expected,unit,guide={}) {
  const normalized=quote.normalize("NFKC").replace(/第\s*\d+(?:\s*[-–—、至到]\s*\d+)?\s*行|#L\d+(?:-L?\d+)?/gu,""),values=[];
  if(/至少|至多|超过|少于|多于|不低于|不超过|不到|小于|大于|并非|不是|不为|约\s*\d|[≥≤<>]/u.test(normalized))throw objectFailure("parameter","count 只核精确等值，不能替范围、近似或否定数量作证",guide);
  const chinese=value=>{
    if(/^\d+$/u.test(value))return Number(value);
    const digits="零一二三四五六七八九";value=value.replaceAll("两","二").replaceAll("〇","零");
    if(value==="十")return 10;
    if(/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(value)) {
      const [a,b]=value.split("十");return (a?digits.indexOf(a):1)*10+(b?digits.indexOf(b):0);
    }
    return value.length===1?digits.indexOf(value):NaN;
  };
  for(const match of normalized.matchAll(/(\d+|[零〇一二两三四五六七八九十]+)\s*(条|句|项|行)/gu)) {
    if(/第\s*$/u.test(normalized.slice(0,match.index)))continue;
    if(unit==="candidate-citation-lines"&&match[2]!=="行")continue;
    values.push(chinese(match[1]));
  }
  if(values.length!==1||values[0]!==expected) {
    // A unique literal in the current sentence can repair the example parameter;
    // this never substitutes the measured total for the author's stated number.
    const templates=values.length===1&&Number.isSafeInteger(values[0])&&Array.isArray(guide.templates)
      ?guide.templates.map(row=>typeof row.expected==="number"?{...row,expected:values[0]}:row):guide.templates;
    throw objectFailure("parameter","count 的 expected 须对应当前片段唯一明确数量及单位；请拆分复合断言，不能用参数替原句补数量",{...guide,templates,unit,claimedQuantities:values,expectedReceived:expected});
  }
}

/** Finite predicates over a real registered set or the current manuscript.
 * These checks do not establish arbitrary natural-language entailment, external
 * page completeness, or labels hidden behind implicit/paraphrased references. */
function checkObject(frame,active,spec,input,assertion,bytes,{host=false}={}) {
  const guide=objectGuide(input,spec,assertion,active.phase);
  if(!input||typeof input!=="object"||Array.isArray(input))throw objectFailure("parameter","objectCheck 需要对象参数",guide);
  const allowed={"registered-excerpts":{
    count:["file","expected"],contains:["file","quote"],excludes:["file","quote"],"line-status":["file","line","expected"]},
    candidate:{"citation-count":["source","expected"],"citations-marked":["source","marker"]}};
  const fields=allowed[input.kind]?.[input.check];
  if(!fields||fields.some(key=>input[key]===undefined)||Object.keys(input).some(key=>!["kind","check",...fields].includes(key)))throw objectFailure("parameter","objectCheck 的 kind/check 或字段不匹配",{...guide,receivedKind:input.kind??null,receivedCheck:input.check??null,allowedFields:fields?["kind","check",...fields]:[],receivedFields:Object.keys(input)});
  const candidateSha256=digest(bytes),lines=lineList(bytes);
  if(lines[assertion.line-1]?.slice(assertion.start,assertion.end)!==assertion.quote)throw objectFailure("parameter","对象核对的实际断言位置不匹配");
  const result={...input,assertion:{line:assertion.line,start:assertion.start,end:assertion.end,quoteSha256:digest(assertion.quote)},candidateSha256,sources:[]};
  if(input.check==="count"||input.check==="citation-count") {
    if(!Number.isSafeInteger(input.expected)||input.expected<0)throw objectFailure("parameter","expected 须为非负整数，单位由 check 固定",guide);
    if(input.kind!=="candidate")countAssertion(assertion.quote,input.expected,"registered-excerpts",guide);
  }
  if(input.kind==="registered-excerpts") {
    if(!/(?:登记|摘录|快照|registered|excerpt)/iu.test(assertion.quote))throw objectFailure("unverifiable","登记集合只能证明明确限定的摘录范围，不能证明整页或外部世界没有该内容");
    const file=relativeName(input.file);
    if(!citation(assertion.quote,file))throw objectFailure("parameter","摘录对象必须绑定当前断言中明确出现的同一来源路径，不能借其他来源的同值结果");
    let observed;
    try { observed=registeredObservation(frame,active,spec,file,{host}); }
    catch(error){throw objectFailure("unverifiable",error.message);}
    result.file=observed.source.file;result.sources=[observed.source];
    if(input.check==="count")result.result={matches:input.expected===observed.registered.length,actual:observed.registered.length,unit:"registered-excerpts",lines:observed.registered.slice(0,24).map(row=>row.line)};
    else if(input.check==="line-status") {
      if(!Number.isSafeInteger(input.line)||input.line<1||input.line>observed.lines.length||!["registered","unregistered"].includes(input.expected))throw objectFailure("parameter","line-status 需现有快照行及 expected=registered|unregistered");
      const located=citation(assertion.quote,file);
      if(located?.start!==input.line||located?.end!==input.line)throw objectFailure("parameter","line-status 的 line 须对应当前断言明确定位的同一单行");
      const actual=observed.registered.some(row=>row.line===input.line)?"registered":"unregistered";
      result.result={matches:actual===input.expected,actual,unit:"snapshot-line-membership",lines:[input.line],lineText:observed.lines[input.line-1].slice(0,1200)};
    } else {
      if(typeof input.quote!=="string"||!input.quote.trim()||input.quote.length>2000||/[\r\n]/u.test(input.quote)||!assertion.quote.includes(input.quote))throw objectFailure("parameter","contains/excludes 的 quote 须为当前断言内的确切单行文本，不能自行换成别的主题");
      const matching=observed.registered.filter(row=>row.quote.includes(input.quote));
      const actual=matching.length>0;
      result.result={matches:input.check==="contains"?actual:!actual,actual,unit:"registered-excerpt-literal",lines:matching.slice(0,24).map(row=>row.line)};
    }
  } else {
    if(!/(?:本稿|本文|本节|稿件|候选|当前文档|this (?:draft|document))/iu.test(assertion.quote))throw objectFailure("unverifiable","candidate 检查只证明当前稿件的明确结构，不能替外部事实作证");
    const source=relativeName(input.source),grant=spec.phases[active.phase],seen=active.seen?.[keyOf(spec.candidate)];
    if(keyOf(source)===keyOf(spec.candidate))throw objectFailure("parameter","source 是该句引用目标，不能填候选自身 "+spec.candidate,guide);
    if(!citation(assertion.quote,source))throw objectFailure("parameter","稿件自述必须明确写出所检查的同一来源路径，不能借别的引用对象作证",guide);
    if(!includes(grant.evidence,source)||!includes(grant.read,spec.candidate))throw objectFailure("unverifiable","稿件引用对象不在当前单元授权内");
    if(!host&&(seen?.hash!==candidateSha256||!seen.ranges.some(([a,b])=>a===1&&b>=lines.length)))throw objectFailure("unverifiable","核全稿自述前须实际完整读取当前候选版本");
    result.source=source;
    const counted=citationLineCounts(bytes,[source])[0];
    const cited=counted.lines.map(line=>({line,text:lines[line-1]}));
    if(input.check==="citation-count") {
      const claim=candidateCountClaim(assertion.quote,source,guide);
      countAssertion(claim.quantityQuote,input.expected,"candidate-citation-lines",guide);
      result.result={matches:cited.length===input.expected,actual:cited.length,unit:"candidate-citation-lines",lines:cited.slice(0,24).map(row=>row.line)};
      if(claim.claimedLines) {
        const declared=new Set(claim.claimedLines),actual=new Set(counted.lines),seenLines=new Set(),duplicates=new Set();
        for(const line of claim.claimedLines){if(seenLines.has(line))duplicates.add(line);seenLines.add(line);}
        const missing=counted.lines.filter(line=>!declared.has(line)),extra=[...declared].filter(line=>!actual.has(line));
        const lineListMatches=claim.claimedLines.length===input.expected&&!missing.length&&!extra.length&&!duplicates.size;
        result.result={...result.result,matches:result.result.matches&&lineListMatches,claimedLines:claim.claimedLines,lineListMatches,
          missingLines:missing.slice(0,24),missingCount:missing.length,extraLines:extra.slice(0,24),extraCount:extra.length,duplicateLines:[...duplicates]};
      }
    }
    else {
      candidateMarkClaim(assertion.quote,source,input.marker,guide);
      if(!cited.length)throw objectFailure("unverifiable","当前稿无该来源的可识别同行定位，不能用空集合证明逐处已标记");
      const missing=cited.filter(row=>!row.text.includes(input.marker));
      result.result={matches:missing.length===0,actual:cited.length,unit:"candidate-citation-lines",lines:cited.slice(0,24).map(row=>row.line),missingLines:missing.slice(0,24).map(row=>row.line),missingCount:missing.length};
    }
  }
  return result;
}

/** Restore only the original input fields; host outputs cannot become input authority. */
function objectInput(value) {
  const {assertion,candidateSha256,sources,result,...input}=value;return input;
}
function validateObjectPart(frame,active,spec,part,lines,block,bytes,{host=false}={}) {
  if(part.kind==="error-example"&&explanationTail(part.quote)>=0)throw objectFailure("parameter","显式错例解释尾部须另以 direct/inference 给实际证明，不能沿用仅核错例的反证");
  if(!part.objectCheck)return;
  if(!block)throw objectFailure("unverifiable","对象证明所在的当前正文块已失效");
  const current=checkObject(frame,active,spec,objectInput(part.objectCheck),{line:block.line,start:block.start+part.start,end:block.start+part.end,quote:part.quote},bytes,{host});
  if(JSON.stringify(current)!==JSON.stringify(part.objectCheck))throw objectFailure("unverifiable","对象版本、实际范围或计算结果已变化，须重新核验该块");
}

/** Recheck typed objects at ledger closure without new coordinator access/reads. */
export function requireStoredObjectChecks(frame,spec,coverages,bytes,phase="final-review") {
  const lines=lineList(bytes),blocks=new Map(documentCoverage(bytes).blocks.map(block=>[block.id,block]));
  try {
    if(!["first-review","final-review"].includes(phase))throw new Error("invalid review authority");
    for(const coverage of coverages)for(const record of coverage.records)for(const part of record.parts) {
      validateObjectPart(frame,{phase},spec,part,lines,blocks.get(record.block),bytes,{host:true});
      if(part.objectCheck&&(!part.objectCheck.result.matches||part.status!=="supported"))throw new Error("object not accepted");
    }
  }catch{throw new Error("已验收的证据对象或解释证明失效，须重新核验");}
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
    if(part.objectCheck&&(part.kind!=="direct"||part.evidence!==undefined||part.inference!==undefined))throw objectFailure("parameter","objectCheck 仅用于 direct，且不能与外部 evidence/inference 混用");
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
      if(explanationTail(quote)>=0)throw objectFailure("parameter","显式错例解释尾部须拆成 direct/inference 并分别证明；只改核验参数，不改正文",{tail:quote.slice(explanationTail(quote),explanationTail(quote)+240)});
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
    } else if (part.objectCheck) {
      result.objectCheck=checkObject(frame,active,spec,part.objectCheck,{line:block.line,start:block.start+start,end:block.start+cursor,quote},readBytes(frame.root,spec.candidate));
      if(part.status==="supported"&&!result.objectCheck.result.matches)throw objectFailure("parameter","提交的 supported 与对象实测谓词冲突；先核对参数和原句范围。确属事实错误时另提交 unsupported 与实际 finding，宿主不代作者造退回项",{...result.objectCheck.result,next:objectMismatchNext(result.objectCheck)});
      // Only these fully bound candidate clauses have a mechanically determined
      // truth value. A real independent suffix must be split and proved itself.
      if(part.status==="unsupported"&&result.objectCheck.result.matches&&result.objectCheck.kind==="candidate"
        &&(result.objectCheck.check==="citations-marked"||candidateCountClaim(quote,result.objectCheck.source,{}).fullyBound)) {
        throw objectFailure("parameter","完整绑定的稿件对象谓词已实测成立，不能将同一事实填 unsupported 制造作者债；独立后半句请按原文拆分并另给真实 finding",{...result.objectCheck.result,next:"保留正确正文，只修核验状态/分段；不能用已证真对象代替另一断言的反证。"});
      }
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
        if (finding.kind === "contradiction" && !part.evidence?.length && result.objectCheck?.result.matches!==false) throw new Error("矛盾退回须 evidence 给实际原文反证及逐字引句，或已验证为 false 的 objectCheck");
      }
      if (part.evidence?.length) result.evidence = part.evidence.map(ref => sourceQuote(frame, active, spec, ref));
    }
    return result;
  });
  if (block.text.slice(cursor).trim()) throw spanError(block,parts.length+1,cursor,undefined,"missing-tail");
  const marker=objectMarker(block.text),expected=marker==="摘录范围"?"registered-excerpts":marker==="稿件自述"?"candidate":null;
  if(expected) {
    const facts=reviewed.filter(part=>["direct","inference"].includes(part.kind));
    if(!facts.length||facts.some(part=>part.status==="supported"&&(part.kind!=="direct"||part.objectCheck?.kind!==expected))) {
      throw objectFailure("parameter","显式 ["+marker+"] 事实须用对应 objectCheck 支持，不能全部 nonfactual；依据不足可用真实 finding 退回");
    }
  }
  const files=spec.phases[active.phase].evidence,syntaxSources=[];
  const syntax=syntaxSpans(block.text,files,ref=>{
    try{syntaxSources.push(evidenceReference(frame,active,spec,ref));return true;}catch{return false;}
  });
  const possible=syntaxSpans(block.text,files);
  const substantiveOutside=spans=>block.text.split("").some((char,index)=>/[\p{L}\p{N}]/u.test(char)&&!spans.some(([a,b])=>a<=index&&index<b));
  if(!substantiveOutside(possible)&&substantiveOutside(syntax)&&reviewed.every(part=>part.kind==="nonfactual"))throw objectFailure("unverifiable","纯出处块的定位尚未通过已读/实际范围/登记校验，不能按合法语法略过；先读正确范围，实际错引须明确 finding");
  return { block: block.id, line: block.line, text: block.text, lineText: block.lineText, parts: reviewed,syntaxSpans:syntax,syntaxSources };
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
function validateRecordSources(frame, active, spec, record, lines, block, bytes) {
  // Syntax is neutral only while its locator remains authorized, read and pinned.
  // Keep the same ordinary refs for host closure to check without exposing text.
  for(const ref of record.syntaxSources??[]) {
    const current=evidenceReference(frame,active,spec,ref);
    if(current.sha256!==ref.sha256||JSON.stringify(current.origin)!==JSON.stringify(ref.origin))throw new Error("合法定位的来源或获取回执版本已变化，须重新核验");
  }
  for (const part of record.parts) {
    const refs = [...(part.evidence ?? []), ...(part.inference?.premises ?? []), ...(part.inference?.warrant ?? []),
      ...(part.inference?.assumptions ?? []).map(row => row.evidence)];
    for (const ref of refs) {
      const current = sourceQuote(frame, active, spec, ref);
      if (ref.sha256 !== current.sha256) throw new Error("覆盖证据版本已经变化，须重新判断该块而非仅重读文件");
    }
    validateCalculationPart(frame, spec, part, lines, block);
    validateObjectPart(frame, active, spec, part, lines, block, bytes);
  }
}

/** Keep independent unaffected blocks; explicitly expose every invalidation. */
function retireStaleProofs(frame, active, spec, bytes, manifest) {
  const invalidated = [];
  const lines = lineList(bytes);
  const blocks = new Map(manifest.blocks.map(block => [block.id, block]));
  for (const [id, record] of Object.entries(active.coverage.records)) {
    try { validateRecordSources(frame, active, spec, record, lines, blocks.get(id), bytes); }
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
  for (const record of records) validateRecordSources(frame, active, spec, record, lines, blocks.get(record.block), bytes);
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

/** Only explicit syntax is neutral: words in explanations/headings remain facts.
 * Authorized inline locators may be a separate block without becoming a claim. */
function syntaxSpans(value,files=[],validate=()=>true) {
  const mask=new Uint8Array(value.length),escape=text=>text.replace(/[|\{}()[\]^$+*?.-]/g,"\\$&");
  const leading=/^\s*(?:(?:[-*+>]\s+|\d+[.)]\s+|#{1,6}\s+))?(?:\*\*)?(?:C\d+)(?:\*\*)?\s*[:：]\s*/u.exec(value)
    ??/^\s*(?:[-*+>]\s+|\d+[.)]\s+|#{1,6}\s+)/u.exec(value);
  if(leading)mask.fill(1,0,leading[0].length);
  for(const file of files) {
    const locator=new RegExp("(?:出处|来源|证据)?\\s*[:：]?\\s*"+escape(file)+"\\s*(?:#L\\d+(?:-L?\\d+)?|[:：]\\d+(?:[-–—]\\d+)?|第\\s*\\d+(?:\\s*[-–—、至到]\\s*\\d+)?\\s*行)",process.platform==="win32"?"gi":"g");
    for(const match of value.matchAll(locator)) {
      const ref=citation(match[0],file);
      if(ref?.start&&validate({file,...ref}))mask.fill(1,match.index,match.index+match[0].length);
    }
  }
  return maskSpans(mask,value,false);
}
function maskSpans(mask,text,substantive=true) {
  const spans=[];
  for(let i=0;i<mask.length;i++)if(mask[i]&&(!substantive||text[i]?.trim())) {
    const prior=spans.at(-1);if(prior&&(!text.slice(prior[1],i).trim()||prior[1]===i))prior[1]=i+1;else spans.push([i,i+1]);
  }
  if(substantive)for(const span of spans)while(span[1]<text.length&&/[\s\p{P}]/u.test(text[span[1]]))span[1]++;
  return spans;
}
function factualMask(record) {
  const mask=new Uint8Array(record.text.length);
  for(const part of record.parts.filter(part=>["direct","inference"].includes(part.kind))) {
    mask.fill(1,Math.max(0,part.start??0),Math.min(mask.length,part.end??mask.length));
  }
  const files=record.parts.flatMap(part=>[...(part.evidence??[]),...(part.inference?.premises??[])].map(ref=>ref.file));
  for(const [start,end] of record.syntaxSpans??syntaxSpans(record.text,files))mask.fill(0,start,end);
  for(let i=0;i<mask.length;i++)if(/[\s\p{P}]/u.test(record.text[i]))mask[i]=0;
  return mask;
}
function objectKind(part) {
  return part?.objectCheck?JSON.stringify([part.objectCheck.kind,part.objectCheck.file??part.objectCheck.source??null]):"external";
}

/** Return differing spans and the stable factual union required of both roles. */
export function classificationDisagreements(first,second) {
  return first.records.flatMap(record=>{
    const other=second.records.find(row=>row.block===record.block);if(!other)return [];
    const a=factualMask(record),b=factualMask(other),different=new Uint8Array(a.length),required=new Uint8Array(a.length),objects=new Uint8Array(a.length);
    for(let i=0;i<a.length;i++) {
      required[i]=a[i]||b[i];different[i]=a[i]!==b[i]?1:0;
      if(a[i]&&b[i]) {
        const find=row=>row.parts.find(part=>(part.start??0)<=i&&(part.end??row.text.length)>i);
        if(objectKind(find(record))!==objectKind(find(other))){different[i]=1;objects[i]=1;}
      }
    }
    const factualSpans=maskSpans(different,record.text),requiredSpans=maskSpans(required,record.text);
    return factualSpans.length?[{block:record.block,line:record.line,text:record.text,factualSpans,requiredSpans,
      ...(objects.some(Boolean)?{objectSpans:maskSpans(objects,record.text)}:{}),
      basis:"核验对事实范围或证据对象存在分歧。requiredSpans 是双方事实并集；按真实对象补证，保留正确正文。纯编号/合法定位可等价，解释与大白话中的事实不能跳过；仍无依据时 block 请求裁定。"}]:[];
  });
}

/** Used by checkpoint restoration and submission; never borrows the other role's proof. */
export function recordMeetsDispute(record,dispute) {
  if(!record||record.text!==dispute.text)return false;
  const mask=factualMask(record),spans=dispute.requiredSpans?.length?dispute.requiredSpans:dispute.factualSpans?.length?dispute.factualSpans:[[0,dispute.text.length]];
  return spans.every(([a,b])=>{
    for(let i=a;i<b;i++)if(dispute.text[i]?.trim()&&!/[\s\p{P}]/u.test(dispute.text[i])&&!mask[i])return false;
    return true;
  });
}
export function requireDisputedProof(active,records,complete=false) {
  for(const dispute of active.reconciliation??[]) {
    const record=records.find(row=>row.block===dispute.block);if(!record&&!complete)continue;
    if(!recordMeetsDispute(record,dispute))throw new Error("[building-loop/reconciliation] "+dispute.block+" 的事实分类争议尚未逐项落实。已标记事实并集须以 direct/inference 提交实际证明；依据不足可用真实 finding 或 block，不要要求作者改写正确正文。范围="+JSON.stringify(dispute.requiredSpans??dispute.factualSpans));
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
  const objectCheck={type:"object",properties:{kind:{type:"string",enum:["registered-excerpts","candidate"]},check:{type:"string",enum:["count","contains","excludes","line-status","citation-count","citations-marked"]},
    file:string,source:string,line:integer,expected:{anyOf:[integer,{type:"string",enum:["registered","unregistered"]}]},quote:string,marker:string},required:["kind","check"],additionalProperties:false,
    description:"direct 专用，与 evidence 互斥。registered-excerpts: count(file,expected条/句/项)、contains/excludes(file,quote单行确切文本)、line-status(file,line,expected登记状态)，只核登记摘录/快照成员关系，不证明网页全文。candidate: citation-count(source,expected可识别同行引用行数)、citations-marked(source,marker确切字面)，须先读当前全稿。参数/读取/谓词冲突留在核验侧；真实对象不符须核验者显式 unsupported+finding，不自动改判作者。"};
  return { offset: integer, count: integer, block: { ...string, description: "status 可选：只取这一块已有的详细证明；省略时只返回进度摘要。" }, entries: { type: "array", minItems: 1, maxItems: 12,
    description: "每次提交1至12块，按 inventory 分页分批提交；不能把全文超过12块塞进一次调用。", items: { type: "object", properties: {
    block: string, parts: { type: "array", items: { type: "object", properties: {
      quote: { ...string, description: "单一判断可省略，自动取该块完整原文；复合判断须逐段连续覆盖本块，不能把下一块文字并入。匹配失败按 coverage-span 的 part/cursor/expectedSuffix 修正核验参数，不得改写正文或省掉事实。" },
      kind: { type: "string", enum: KINDS }, status: { type: "string", enum: STATUSES,
        description: "direct/inference 给事实判定；nonfactual 用 supported；hypothesis 宿主固定 uncertain，不能成为已证前提。" }, basis: string, repair: string,
      sourceRelation: { type: "string", enum: ["supports", "contradicts", "insufficient"], description: "direct/inference 必填：原始证据对该断言字面含义的关系。error-example 核展示的错误推理，只能 contradicts/insufficient，并提供 evidence；明确错例的状态由宿主固定，不作为已证前提。" },
      finding: { type: "object", properties: { kind: { type: "string", enum: ["missing-evidence", "contradiction", "scope", "invalid-inference"] }, quote: string, fix: string }, required: ["kind", "quote", "fix"], additionalProperties: false },
      evidence: { type: "array", items: ref }, inference, objectCheck,
    }, required: ["kind", "status", "basis"], additionalProperties: false } },
  }, required: ["block", "parts"], additionalProperties: false } } };
}
