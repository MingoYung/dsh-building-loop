import { digest, includes, keyOf, readBytes, relativeName } from "./policy.mjs";
import { citation, claimRow, lineList, numericChecks, errorExample, repairBaseline, adjacentCitationLocator, exactCitationLocator, footnoteQuoteIndex, verbatimQuotes, requiredLineMarkdown } from "./preflight.mjs";
import { evidenceReference, evidenceSpan, registeredObservation, UnobservedExcerptError, webSourceLocator } from "./evidence.mjs";

export const COVERAGE_VERSION = 1;
// Checkpoint bindings include this separate classification contract revision;
// source/proof storage stays compatible while obsolete classification loops reset.
export const CLASSIFICATION_VERSION = 8;
// Only this error authorizes persisting a failed call's proof invalidation. Other
// failures retain the ordinary all-or-nothing state transaction behavior.
export class CoverageRecordError extends Error {}
const KINDS = ["direct", "inference", "nonfactual", "hypothesis", "error-example"];
const STATUSES = ["supported", "unsupported", "uncertain"];
const INVENTORY_LIMIT = 24;
const RECORD_LIMIT = 12;
// These unambiguous surface connectives are a conservative minimum, not a
// universal parser. Untagged/implicit deductions remain the reviewers' duty.
const explicitInference = text => /(?:因此|所以|由此(?:可见|可得|推出)?|据此(?:可知|推出)?|therefore|\bhence\b|\bthus\b)/i.test(text);

// These are presentation labels and bare concepts, never a general heading or
// imperative classifier. The finite lexicon deliberately excludes predicates,
// quantities, modifiers such as "已证实", and arbitrary quoted propositions.
const NEUTRAL_LABELS=["大白话","直白说明","摘要","结论","建议","方法","依据","注意事项"];
const ADVICE_CONCEPTS=["状态","完成状态","执行状态","任务状态","结果","实际结果","执行结果","结论","证据","证据范围","证据能说明的范围",
  "适用范围","条件","前提","假设","事实","推测","建议","相关","因果","相关关系","因果关系","定义","概念","对象","数量","单位","来源"];
const neutralLabels=NEUTRAL_LABELS.join("|"),neutralConcepts="(?:"+[...ADVICE_CONCEPTS].sort((a,b)=>b.length-a.length).join("|")+")";
const conceptList=neutralConcepts+"(?:\\s*(?:、|和|与|及)\\s*"+neutralConcepts+"){1,7}";
const neutralDirective=new RegExp("^(?:(?:请|建议)\\s*)?(?:把\\s*"+conceptList+"\\s*(?:分开看|分开说明|区分清楚)|(?:区分|分清)\\s*"+conceptList+")[。.!！]?\\s*$","u");

/** Host-only neutral ranges come from actual block bytes, never a model's part
 * boundaries. Labels neutralize only themselves. An advice body must match the
 * entire bounded directive; unknown qualifications/reasons/tails stay factual
 * candidates and cannot borrow the safe prefix. Every block still needs review.
 */
export function neutralTextSpans(text) {
  if(typeof text!=="string"||!text.trim())return [];
  const ranges=[],decoration=/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?/u.exec(text)[0].length;
  const remaining=text.slice(decoration);
  // These two tags select a proof contract. Only the tag is structural;
  // the assertion that follows still has to use the selected evidence object.
  const objectLabel=/^\[(?:稿件自述|摘录范围)\]\s*/u.exec(remaining);
  if(objectLabel)return [{start:0,end:decoration+objectLabel[0].length,kind:"structural-label",rule:"explicit-object-label-v1"}];
  // A leading [补充] only announces layout. Neither inline mentions nor any
  // fact that follows the label inherit that classification.
  const label=new RegExp("^(?:\\[补充\\]|(?:"+neutralLabels+")\\s*[:：]|\\*\\*(?:"+neutralLabels+")\\s*[:：]\\*\\*|\\*\\*(?:"+neutralLabels+")\\*\\*\\s*[:：])\\s*","u").exec(remaining);
  let bodyStart=decoration;
  if(label){bodyStart=decoration+label[0].length;ranges.push({start:0,end:bodyStart,kind:"structural-label",rule:"explicit-label-v1"});}
  else if(new RegExp("^\\s*#{1,6}\\s+(?:(?:"+neutralLabels+")|\\*\\*(?:"+neutralLabels+")\\*\\*)\\s*(?:#+\\s*)?$","u").test(text)) {
    return [{start:0,end:text.length,kind:"structural-label",rule:"explicit-label-v1"}];
  }
  if(neutralDirective.test(text.slice(bodyStart)))ranges.push({start:bodyStart,end:text.length,kind:"directive",rule:"bare-concept-separation-v1"});
  return ranges;
}

function neutralMask(text) {
  const mask=new Uint8Array(text.length);
  for(const {start,end} of neutralTextSpans(text))mask.fill(1,start,end);
  return mask;
}

/** A leading simulation marker asserts source scope; it is never neutral syntax.
 * C-number/error-example internals and other bracket tags keep their own rules. */
function simulationMarker(text) {
  const match=/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?\[模拟\]/u.exec(text);
  return match?{start:match[0].lastIndexOf("[模拟]"),end:match[0].length,kind:"synthetic",label:"[模拟]"}:null;
}
function scopeFailure(message,block,marker) {
  const example={quote:block.text.slice(0,marker.end),kind:"direct",status:"supported",sourceRelation:"supports",basis:"说明该行实际来源的合成范围",evidence:[{file:"该行实际引用来源",start:1,end:1,quote:"替换为已读行逐字原文"}]};
  return new Error("[building-loop/scope-marker] "+message+"。这是核验参数/范围证明问题，不要求改作者正文。将标记单列 "+JSON.stringify(example)+"；示例行号1须替换为实际已读范围。后续正文另按 direct/inference 核验。没有依据可用 unsupported/uncertain 与真实 finding，不能把标记降为 nonfactual。");
}

/** Prefer citations in the marked claim block. When they were separated by
 * punctuation, retain the existing single-source physical-line fallback. */
function simulationSourceFiles(frame,block,authorized) {
  const locatedFiles=value=>authorized.filter(file=>{
    const range=citation(value,file);
    if(!range?.start)return false;
    const bytes=readBytes(frame.root,file);
    return bytes&&range.end<=lineList(bytes).length;
  });
  const inBlock=locatedFiles(block.text);
  return inBlock.length?inBlock:locatedFiles(block.lineText??block.text);
}

/** Missing or ambiguous locators are manuscript defects. Models must not
 * choose a convenient synthetic source among unrelated sibling references. */
function simulationLocatorIssue(block,files) {
  if(files.length===1)return null;
  const code=files.length?"ambiguous":"missing";
  const issue="候选第 "+block.line+" 行 [模拟] 范围归属须有唯一、有效且授权的同行引用来源，"
    +(code==="ambiguous"?"当前同一范围有多个来源":"当前范围没有可定位的来源")
    +"。请在带标记的实际陈述块内标明唯一合成来源和有效行号，或将引用其他来源的陈述另起一行。";
  return {block:block.id,line:block.line,code,issue};
}

/** The executor calls this after reading its current draft. Inspect only
 * evidence that it is allowed to read in its actual supplement phase. */
export function simulationScopeLocatorIssues(frame,active,spec,bytes) {
  if(active.phase!=="supplement"||frame.role==="coordinator"||!bytes.includes("[模拟]"))return [];
  const allowed=spec.phases["final-review"].evidence.filter(file=>
    includes(spec.phases.supplement.read,file)&&includes(frame.reads,file));
  return documentCoverage(bytes).blocks.flatMap(block=>{
    if(!simulationMarker(block.text))return [];
    const issue=simulationLocatorIssue(block,simulationSourceFiles(frame,block,allowed));
    return issue?[issue]:[];
  });
}

/** Reuse ordinary verified refs; a document pin can prove its scope even when
 * the citation points to a substantive row. Other pin kinds (or no pin) need a
 * conservative explicit same-source declaration, not filename/label guessing. */
function validateSimulationScope(frame,active,spec,block,parts) {
  const marker=simulationMarker(block?.text??"");if(!marker)return;
  const covering=parts.filter(part=>part.start<marker.end-1&&part.end>marker.start+1);
  if(!covering.length||covering.some(part=>!["direct","inference"].includes(part.kind)))throw scopeFailure("[模拟] 是有事实含义的来源范围标记，须用 direct/inference 覆盖",block,marker);
  const grant=spec.phases[active.phase];
  const files=simulationSourceFiles(frame,block,grant.evidence.filter(file=>includes(grant.read,file)));
  const locatorIssue=simulationLocatorIssue(block,files);
  for(const part of covering) {
    if(part.status!=="supported")continue; // The existing finding gate owns real rejection.
    if(locatorIssue)throw new Error("[building-loop/scope-marker] "+locatorIssue.issue
      +" 这是稿件来源归属问题，重填 supported 参数无法解决。按实际片段提交 direct 或 inference、status=unsupported 或 uncertain、sourceRelation=insufficient，"
      +"并给 finding.kind=scope、指向本块实际带标记断言的 quote 和最小 fix；其他事实仍按原文独立核验。");
    const refs=[...(part.evidence??[]),...(part.inference?.premises??[]),...(part.inference?.warrant??[])];
    const supported=refs.some(ref=>{
      if(keyOf(ref.file)!==keyOf(files[0]))return false;
      const bytes=readBytes(frame.root,ref.file),pin=frame.policy.sourcePins[keyOf(ref.file)];
      if(!bytes||digest(bytes)!==ref.sha256)return false;
      const quote=typeof ref.quote==="string"?ref.quote:"",original=lineList(bytes).slice(ref.start-1,ref.end).join("\n");
      if(!quote.trim()||!original.includes(quote))return false;
      if(pin&&(pin.sha256!==ref.sha256||ref.origin?.kind!==pin.kind||ref.origin.integrity!=="matches-pin"))return false;
      if(pin?.kind==="synthetic")return true;
      // Primary/secondary describes provenance, not whether the reported data
      // is simulated. An explicit declaration can prove that narrower scope;
      // merely mentioning 模拟 (possibly negated) cannot.
      return /^(?:#{1,6}\s*)?(?:本(?:文件|材料|数据|例)(?:为|是))?(?:合成(?:逻辑样例|数据)|模拟(?:样例|数据))(?:[。.]|[；;]\s*不是外部研究、生产日志或真实效果数据[。.]?)?$/u.test(quote.trim());
    });
    if(!supported)throw scopeFailure("尚无该行同源的当前合成范围证明：需已核 synthetic 来源凭据，或同源的明确合成声明引句；未知范围不能自动算模拟",block,marker);
  }
}

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
      const neutralSpans=neutralTextSpans(content);
      const scopeMarker=simulationMarker(content);
      blocks.push({ id: "B" + (blocks.length + 1) + "-" + digest(content).slice(0, 8),
        line: row + 1, start, end: start + content.length, text: content, lineText: line,
        ...(neutralSpans.length?{neutralSpans}:{}),
        ...(scopeMarker?{scopeMarkers:[scopeMarker]}:{}),
        requiresInference: explicitInference(content) && !errorExample(content), stance: errorExample(content) ? "error-example"
          : /^\s*(?:[-*#>]\s*)?\[(?:推测|假设|未证实|Hypothesis|Unverified)\]/i.test(content) ? "hypothesis" : "asserted-unless-nonfactual" });
    }
  }
  if (!blocks.length) throw new Error("候选为空，不能用空覆盖清单验收");
  return { version: COVERAGE_VERSION, classificationVersion:CLASSIFICATION_VERSION, candidateSha256: digest(bytes), blocks };
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
  if (typeof value?.file === "string" && keyOf(relativeName(value.file)) === keyOf(spec.candidate)) {
    throw objectFailure("unverifiable", "资料引用不在本轮证据授权中 " + spec.candidate + "：候选稿只能证明稿内结构", candidateProofGuide());
  }
  const ref = evidenceReference(frame, active, spec, value);
  const quote=value.quote, span=typeof quote==="string"&&quote.length<=2000
    ?evidenceSpan(readBytes(frame.root,ref.file),{...ref,quote}):null;
  if (!span) {
    throw new Error("证据 quote 必须逐字出现在所指原文行，不能用概括或自己补写的桥接条件代替");
  }
  // An acquisition receipt registers independent excerpts, not a continuous page.
  // Preserve per-line citations instead of inventing a bridge between excerpts.
  if (ref.origin?.observation && /[\r\n]/u.test(quote)) throw new Error("登记的独立来源摘录不能用跨行 quote 拼成连续原话，请逐行分别引用");
  return { ...ref, quote, evidenceSpan:span };
}

/** A single explicit trailing citation is owned by the preceding clause. Do
 * not infer attribution for compound lists, prose URLs, or touching footnotes. */
const markedCitation = /(?:（((?:出处|来源|证据)\s*[:：][^（）\r\n]*)）|\(((?:出处|来源|证据)\s*[:：][^()\r\n]*)\)|【((?:出处|来源|证据)\s*[:：][^【】\r\n]*)】)/gu;
const annotationBody = match => match.slice(1).find(value=>value!==undefined);
function explicitAttribution(block, files) {
  const annotation=[...block.text.matchAll(markedCitation)].at(-1);
  if(!annotation||annotation.index===0||!/^\s*[。.!！?？;；]*$/u.test(block.text.slice(annotation.index+annotation[0].length)))return null;
  const body=annotationBody(annotation);
  const bound=exactCitationLocator(body,files);
  if(bound)return {...bound,start:annotation.index};
  const url=webSourceLocator(body.replace(/^(?:出处|来源|证据)\s*[:：]\s*/u,"").trim());
  return url?{url,start:annotation.index}:null;
}

/** Full physical lines keep semicolon-separated citations together even when
 * sentence coverage splits inside the annotation. A genuine co-citation
 * cannot legitimize an unapproved second source. */
function listedAttribution(block,files) {
  for(const annotation of block.lineText.matchAll(markedCitation)) {
    const start=annotation.index-block.start;
    if(start<=0||start>=block.text.length)continue;
    const entries=annotationBody(annotation).split(/[；;]/u);
    if(entries.length<2)continue;
    const parsed=entries.map(entry=>exactCitationLocator(entry,files));
    if(parsed.every(Boolean))return {start,locators:parsed.flatMap(item=>item.locators),
      excludedLocators:parsed.flatMap(item=>item.excludedLocators)};
  }
  return null;
}

function proofReferences(part) {
  return [...(part.evidence??[]),...(part.inference?.premises??[]),...(part.inference?.warrant??[]),
    ...(part.inference?.assumptions??[]).map(item=>item.evidence)];
}

/** Legacy receipts predate these provenance labels. Keep their original shape
 * after recomputing the proof, while checking every field they did record. */
function savedReferenceShape(current,previous) {
  const ref={...current};
  for(const key of ["sourceIdentity","provenance","evidenceSpan"])if(!Object.hasOwn(previous??{},key))delete ref[key];
  return ref;
}

/** Parse visibility at most once per draft scan, and only if attribution is used. */
function bodyVisibility(lines) {
  let live;
  return line=>(live??=requiredLineMarkdown(lines).live)[line-1];
}

/** The locators a reviewer has access to cannot substitute for the explicit
 * attribution the reader sees. A bad author locator remains an author finding. */
function validateAttribution(frame,active,spec,block,parts,visible) {
  if(!spec.requireSourcePins)return null;
  const grant=spec.phases[active.phase],bound=listedAttribution(block,grant.evidence)??explicitAttribution(block,grant.evidence);
  if(!bound||[...verbatimQuotes(block.text)].length||!visible(block.line))return null;
  const marker=simulationMarker(block.text);
  // An isolated [模拟] proof establishes the cited file's scope. Its header can
  // live outside the cited substantive rows. A part with any narrative text
  // still has to bind that narrative to its exact attribution below.
  const scopeOnly=part=>marker&&part.start<=marker.start&&part.end>=marker.end&&!block.text.slice(marker.end,part.end).trim();
  const facts=parts.filter(part=>part.start<bound.start&&["direct","inference"].includes(part.kind)&&!part.objectCheck&&!scopeOnly(part));
  const supported=facts.some(part=>part.status==="supported");
  if(!supported) {
    // An explicit claim of provenance is still attributable when both models
    // misclassify the surrounding prose. Quoted examples and hypotheses are
    // not author assertions and continue under their own review rules.
    if(facts.length||!parts.some(part=>part.kind==="nonfactual")||errorExample(block.lineText)
      ||/^\s*(?:[-*#>]\s*)?\[(?:推测|假设|未证实|Hypothesis|Unverified)\]/iu.test(block.lineText))return null;
    const invalid=bound.excludedLocators?.[0]??(bound.url&&!grant.evidence.some(file=>
      webSourceLocator(frame.policy.sourcePins[keyOf(file)]?.locator)===bound.url)
      ?{file:bound.url,reason:"unapproved-url"}:null);
    return invalid;
  }
  if(bound.url) {
    const pins=grant.evidence.map(file=>frame.policy.sourcePins[keyOf(file)])
      .filter(pin=>pin?.kind!=="synthetic"&&webSourceLocator(pin?.locator)===bound.url);
    if(!pins.some(pin=>pin.observation))return {file:bound.url,reason:pins.length?"unobserved-url":"unapproved-url"};
    if(!facts.some(part=>part.status==="supported"&&proofReferences(part).some(source=>source.origin?.observation
      &&webSourceLocator(source.origin.locator)===bound.url)))throw new Error("[coverage-attribution] 正文给出的网页须由同一网页的实际登记摘录核验；改核验参数，确实缺证则提交真实 finding");
    return null;
  }
  if(bound.excludedLocators.length)return bound.excludedLocators[0];
  for(const ref of bound.locators) {
    const bytes=readBytes(frame.root,ref.file);
    if(bytes&&ref.end>lineList(bytes).length)return {...ref,reason:"invalid-range"};
    try { evidenceReference(frame,active,spec,ref); }
    catch(error) {
      if(error instanceof UnobservedExcerptError)return {...ref,reason:"unobserved-excerpt"};
      throw error;
    }
  }
  if(!facts.some(part=>part.status==="supported"&&proofReferences(part).some(source=>bound.locators.some(ref=>keyOf(source.file)===keyOf(ref.file)
    &&source.start>=ref.start&&source.end<=ref.end))))throw new Error("[coverage-attribution] 正文明确给出出处，须用该出处同一范围内的实际原文核验；改核验参数，确实缺证则提交真实 finding");
  return null;
}

// A classification and a review action are different predicates. Restrict the
// mechanical grammar to those two types, with the same entity, case and verbs
// throughout. Open-ended terms or extra premises stay with the two reviewers.
const caseClass = "[A-Za-z0-9]{1,12}\\s*[级类]";
const caseAction = "(?:送|提交|进入|接受)(?:复核|审核|检查|复查|复审|验收)";
const caseNoun = "(?:样本|对象|项目|记录|申请)";
const caseInstance = "[A-Za-z0-9][A-Za-z0-9_-]{0,31}";
const caseText = new RegExp("^\\s*(?:[-*+]\\s+)?(?:\\[模拟\\]\\s*)?按本例规则只能由\\s*(?<level>"+caseClass+
  ")\\s*推出\\s*(?<modal>应|需|须)(?<action>"+caseAction+")\\s*[，,]\\s*不能反推(?<tail>[，,]\\s*所以\\s*(?:(?<noun>"+caseNoun+
  ")\\s*(?<object>"+caseInstance+")\\s*\\k<modal>\\k<action>(?:(?:并|也)?不能(?:说明|推出)其他\\s*\\k<action>的\\k<noun>(?:(?:也)?(?:是|为)|(?<negativeTarget>(?:都)?(?:不是|不为)))\\s*\\k<level>|(?<opposite>就能(?:说明|推出)其他\\s*\\k<action>的\\k<noun>都不是\\s*\\k<level>))"+
  "|不能由此反推其他\\s*\\k<action>的(?<ruleOnlyNoun>"+caseNoun+")(?<ruleOnlyNegative>(?:都)?(?:不是|不为))\\s*\\k<level>))(?<locator>\\s*[（(](?:出处|来源)\\s*[:：]\\s*[^（）()\\r\\n]+[）)])\\s*[。.]?$", "du");

/** Match one explicit same-block case and one exact adjacent authorized range.
 * Retain physical offsets from the original bytes rather than normalized text.
 */
function boundedCase(block, grant) {
  const match=caseText.exec(block?.text??"");
  if(!match)return null;
  const locator=match.groups.locator.trim().slice(1,-1).replace(/^(?:出处|来源)\s*[:：]\s*/u,"").trim().replaceAll("\\","/");
  for(const file of grant.evidence) {
    const exact=new RegExp("^"+regexLiteral(file)+"\\s*第\\s*\\d+\\s*[-–—至到]\\s*\\d+\\s*行$",process.platform==="win32"?"iu":"u");
    if(!exact.test(locator)||!includes(grant.read,file))continue;
    const range=citation(locator,file);
    if(!range||range.end!==range.start+1)return null;
    const {level,modal,action,noun,object,opposite,negativeTarget,ruleOnlyNoun,ruleOnlyNegative}=match.groups;
    return {file,...range,level,modal,action,noun:noun??ruleOnlyNoun,object,opposite,
      negativeTarget:negativeTarget??ruleOnlyNegative,kind:opposite?"opposite":"non-entailment",tail:match.indices.groups.tail};
  }
  return null;
}

/** Build the two countermodels only after reading the actual full rule and
 * instance rows. An extra Y can have the action with or without membership;
 * both worlds satisfy the cited rule and X fact. Neither membership nor its
 * opposite follows for Y from that pair of premises alone.
 */
function measureBoundedCase(frame,active,spec,block,binding,stored) {
  const {file,start,end,level,modal,action,noun,object,kind,tail,negativeTarget}=binding;
  const bytes=readBytes(frame.root,file);
  if(!bytes)return null;
  const lines=lineList(bytes),rule=lines[start-1],instance=lines[end-1];
  const predicate=regexLiteral(level.replace(/\s+/gu,""));
  const ruleText=new RegExp("^(?:本例(?:的)?(?:分级)?规则[:：])?(?:如果|若)(?:一个|任一个|任一|某个)"+noun+
    "(?:是|为)"+predicate+"[,，](?:则|那么)(?:该|这个|此)"+noun+modal+action+"[。.]?$","u");
  // A rule-only claim still cites the complete two-row case. Check the second
  // row belongs to that case without inventing an object in the candidate.
  const factText=new RegExp("^(?:本例对象[:：])?"+noun+(object===undefined?caseInstance:regexLiteral(object))+"(?:是|为)"+predicate+"[。.]?$","u");
  if(!ruleText.test(rule?.replace(/\s+/gu,"")??"")||!factText.test(instance?.replace(/\s+/gu,"")??""))return null;
  const original=[{file,start,end:start,quote:rule},{file,start:end,end,quote:instance}];
  // Closure already checked acquisition/source versions for these persisted
  // quotes. Recompute against those authenticated refs without forging reads.
  const premises=stored??original.map(ref=>sourceQuote(frame,active,spec,ref));
  if(premises.length!==2||premises.some((ref,i)=>ref.file!==file||ref.start!==original[i].start||ref.end!==original[i].end||
      ref.quote!==original[i].quote||ref.sha256!==digest(bytes)))throw new Error("有界推导的规则、样本或来源版本已失效");
  const holds=kind==="non-entailment";
  const assertion={line:block.line,start:block.start+tail[0],end:block.start+tail[1],quoteSha256:digest(block.text.slice(...tail))};
  return {rule:"bounded-non-entailment",premises,scope:"仅据同行两条明确前提及同一例内的单向规则判断，假设的其他对象不代表真实观测。",
    assumptions:[],counterexample:{possible:!holds,reason:holds?"可假设其他对象既符合动作要求也已执行该动作，而分类分别为真、假；两种假设均与给定前提相容。":"存在同样符合要求且已执行该动作、也属于该分类的假设对象，足以否定声称可推出其他对象均不属于该分类。"},
    nonEntailment:{assertion,kind,holds,source:{file,start,end,sha256:premises[0].sha256},entity:noun,object:object??null,antecedent:level,consequent:modal+action,
      // The outer denial applies to the entailment in both directions. Only
      // new negative-target records add this field, preserving prior proofs.
      ...(negativeTarget?{targetPolarity:"negative"}:{}),...(object===undefined?{scopeReference:"rule-only"}:{}),
      // Normative requirement and observed action are independent predicates.
      // Set both for Y in the hypothetical worlds; assert neither as real data.
      witnesses:[{otherAntecedent:false,otherConsequent:true,otherObservedAction:true},
        {otherAntecedent:true,otherConsequent:true,otherObservedAction:true}]}};
}

/** Force the literal logical claim to be decided together. Splitting it into
 * punctuation, a neutral prefix or an asserted opposite cannot drop a premise.
 */
function requireBoundedPart(block,part,binding,proof) {
  const [start,end]=binding.tail;
  if(part.end<=start||part.start>=end)return false;
  if((part.start>start&&block.text.slice(start,part.start).replace(/[，,\s]/gu,""))||part.end<end||part.kind!=="inference") {
    throw new Error("[coverage-non-entailment] 单向规则的结论须以 inference 连续覆盖实际后段，不能拆开‘不能说明’与其对象。quote="+JSON.stringify(block.text.slice(start,end)));
  }
  if((part.status==="supported")!==proof.nonEntailment.holds) {
    const relation=proof.nonEntailment.holds
      ?"两种其他对象均与引用前提相容，‘不能说明’成立。只改核验状态为 status=supported、sourceRelation=supports，不要求作者删改正确正文。"
      :"其他对象满足复核时仍可能属于该分类。前提无法支持‘其他都不是’，请按实际原句提交未支持判断及 finding。";
    throw new Error("[coverage-non-entailment] "+relation);
  }
  return true;
}

/** Recompute saved host proof from the actual bound span and source version. */
function validateBoundedRecord(frame,active,spec,block,parts,{host=false}={}) {
  const saved=parts.filter(part=>part.inference?.rule==="bounded-non-entailment");
  // Earlier accepted records had no dedicated format. Preserve that historical
  // shape at closure; any newly presented or resumed record is checked below.
  if(host&&!saved.length)return;
  const binding=boundedCase(block,spec.phases[active.phase]);
  const proof=binding&&measureBoundedCase(frame,active,spec,block,binding,host?saved[0].inference.premises:undefined);
  if(!proof&&!saved.length)return;
  const compatible=proof&&saved.length===1?{...proof,premises:proof.premises.map((ref,index)=>savedReferenceShape(ref,saved[0].inference.premises[index]))}:proof;
  if(!proof||saved.length!==1||!requireBoundedPart(block,saved[0],binding,proof)||
      JSON.stringify(compatible)!==JSON.stringify(saved[0].inference))throw new Error("已保存的有界推导证明失效，须重新核验该块");
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
    candidate:[{kind:"candidate",check:"citation-count",source:target,expected},{kind:"candidate",check:"citations-marked",source:target,marker:"原句声明的确切标记"},
      {kind:"candidate",check:"citations-leading-marked",source:target,marker:"原句声明的确切行首标记"}],
    "registered-excerpts":[{kind:"registered-excerpts",check:"count",file:target,expected},{kind:"registered-excerpts",check:"contains",file:target,quote:"原句中要核对的单行原文"},
      {kind:"registered-excerpts",check:"excludes",file:target,quote:"原句中明确说未见的单行文本"},{kind:"registered-excerpts",check:"line-status",file:target,line:1,expected:"registered"},
      {kind:"registered-excerpts",check:"line-range",file:target,start:1,end:2,mode:"subset"}],
  };
  return {templates:examples[input?.kind]??examples,next:"只按原句选择一个模板并替换示例值；删除其他模板的字段，再提交同一块。不要为参数错误改作者正文。",
    ...(input?.kind === "candidate" ? candidateProofGuide() : {}),
    parameterRules:["candidate 不支持 count：用 citation-count；source 是本句引用目标，不能填候选文件 "+spec.candidate+"，也没有 sources 数组字段。",
      "expected 必须是原句明确声称的数量；示例0不是实测值。registered-excerpts/count 统计已登记摘录条目，结论类别或举例数量不能当摘录总数。",
      "file 与 source 按模板二选一；line-range 用 start/end/mode，按 inventory 原样填写。快照行范围与外部事实或另一来源分别核验。",
      "citation-count 可核末尾完整行号表（第2、4-6行），数量和全表均须相符；citations-marked 核明确的全称含标记；原句限定行首则用 citations-leading-marked，两者都不能替数量、未全标或完全没标作证。",
      "若 inventory 给出 objectCheckHint，按块原样传入；citation-profile 由宿主从原句绑定并复算数量、完整行号和同源标记子集。"]};
}

/** Manuscript object checks prove only their literal structural predicate. */
function candidateProofGuide() {
  return { manuscript: "只核本稿引用数量或明确逐处标记时，优先用 inventory 的 objectCheckHint。没有提示时，只有原句明确给出同一已授权来源路径及可复算的数量或标记，才可按模板填写。",
    mixedClaims: "把稿内覆盖声明与其中的事实分段核验，外部事实用各自获授权原文。仅有作者自报、来源代号或格式提示，且找不到可绑定的核验依据时，给实际原句的 uncertain、sourceRelation=insufficient 和具体 finding。不要把候选稿改作 evidence 或把未证明内容归为 nonfactual。" };
}
function objectMismatchNext(value) {
  if(value.check==="citation-profile")return "分别核对该块的实测数量、完整行号表及明确声明的错例/标记。若原句确错，保留同一 objectCheck，提交 unsupported 和指向实际错处的 finding；不能改参数迁就原句。";
  if(value.kind==="candidate")return value.check==="citation-count"
    ?"核对 source 是否为原句引用目标，并按实际物理引用行数复核；有完整行号表时还须逐项核对 claimedLines、missingLines、extraLines、duplicateLines。若只是填错参数，改参数；若原句精确数量或行号表确错，提交 unsupported 与指向实际错处的 finding，保留此 objectCheck 作反证。"
    :"逐项复核 missingLines 是否缺少原句声明的字面标记。确实缺标才提交 unsupported 与实际 finding；若原句指全局说明而非逐行标记，当前谓词不能代证，应改核验方式。";
  if(value.check==="count")return "actual 是登记摘录条目总数，不是其中举例或结论类别数。先核原句是否在声称这个总数；参数错就改参数，原句总数确错才提交 unsupported 与实际 finding，禁止把 expected 改成 actual 来掩盖原句错误。";
  if(value.check==="line-range")return "核对 missingLines 及 exact 的 extraLines；原句确错才保留同一 objectCheck 并提交 unsupported 与实际 finding。结果只说明本地快照的登记集合。";
  return "核对原句限定范围及谓词：contains/excludes 只核登记集合的确切文本，line-status 只核指定快照行是否登记。参数或谓词不符先改调用；确认原句确错后另提交 unsupported 与实际 finding，不把当前结果扩大成网页全文结论。";
}

const regexLiteral=value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

/** Match only a complete, explicit claim about one local snapshot. A page,
 * second source, external statement or attached clause cannot use this proof. */
function registeredLineRange(value, files) {
  if(!value.includes("快照")||!value.includes("登记"))return null;
  const clause=value.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)?(?:\[摘录范围\]\s*)?(?:本轮\s*)?/u,"")
    .replace(/[。.!！?？;；]$/u,"").trim();
  for(const file of files){
    const prefix=regexLiteral(file)+"\\s*(?:的\\s*)?";
    const range="第\\s*(\\d{1,6})\\s*[-–—至到]\\s*(\\d{1,6})\\s*行";
    const flags=process.platform==="win32"?"iu":"u";
    const subset=new RegExp("^"+prefix+"(?:本地)?快照\\s*"+range+"\\s*(?:均|都)已登记$",flags).exec(clause);
    const exact=!subset&&new RegExp("^"+prefix+"只登记了\\s*本地快照\\s*"+range+"$",flags).exec(clause);
    const match=subset||exact;
    if(match)return {kind:"registered-excerpts",check:"line-range",file,start:Number(match[1]),end:Number(match[2]),mode:subset?"subset":"exact"};
  }
  return null;
}

const candidateClause=value=>value.normalize("NFKC").trim()
  .replace(/^(?:[-*+]\s+|\d+[.)]\s+)?(?:\[稿件自述\]\s*)?/u,"")
  .replace(/[。.!！?？;；]\s*$/u,"").trim();
const quotedLiteral=value=>{
  const literal=regexLiteral(value.normalize("NFKC"));
  return "(?:"+literal+"|`"+literal+"`|\""+literal+"\"|'"+literal+"'|“"+literal+"”|「"+literal+"」|『"+literal+"』)";
};

/** Expand physical line ordinals with a hard cap before allocating ranges.
 * Profile lists can annotate explicitly marked error examples. Those labels
 * are assertions to verify later, never ignored punctuation. */
function ordinalLines(list,profile=false) {
  const claimedLines=[],exampleLines=[];
  const items=profile?list.split(/[,、]|\s*(?:及|和|与)\s*(?=第)/u):list.split(/[,、]/u);
  const itemPattern=profile
    ? /^\s*(?:第\s*)?([1-9]\d*)(?:\s*[-–—至到]\s*(?:第\s*)?([1-9]\d*))?(?:\s*行(?:\s*(错例行))?)?\s*$/u
    : /^\s*(?:第\s*)?([1-9]\d*)(?:\s*[-–—至到]\s*(?:第\s*)?([1-9]\d*))?\s*$/u;
  for(const item of items) {
    const match=itemPattern.exec(item);
    if(!match)return {problem:"syntax"};
    const first=Number(match[1]),last=Number(match[2]??match[1]);
    if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||last<first||last-first+1>256-claimedLines.length)return {problem:"range"};
    for(let line=first;line<=last;line++) {
      claimedLines.push(line);
      if(match[3])exampleLines.push(line);
    }
  }
  return {claimedLines,exampleLines};
}

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
  const {claimedLines,problem}=ordinalLines(list);
  if(problem==="syntax")throw objectFailure("parameter","完整行号表仅支持正整数及递增范围，以顿号/逗号分隔；不接受省略号、‘等’或附加断言",guide);
  if(problem==="range")throw objectFailure("parameter","完整行号表每次最多256项，须为安全正整数及递增范围；超出范围请单独核验，不能截断清单",guide);
  return {quantityQuote,claimedLines,fullyBound:true};
}

/** Recognize a two-clause self-report without changing normal block boundaries.
 * Both exact spans must be present on the same physical line. The second clause
 * inherits the first clause's one explicit source; its literal marker and
 * position come from the text rather than reviewer-supplied parameters. */
function candidateProfile(line,assertion,source) {
  if(objectMarker(line)!=="稿件自述")return null;
  const boundary=line.search(/[；;]/u);
  if(boundary<0)return null;
  const following=line.slice(boundary+1),stop=/[。！？；;!?]+/u.exec(following);
  const tailEnd=stop?boundary+1+stop.index+stop[0].length:line.length;
  const profileText=value=>candidateClause(value.replace(/[。！？；;!?]+\s*$/u,""));
  // Any further sentence remains a separate mandatory coverage block, even
  // when it shares this physical line with the two measured claims.
  const head=profileText(line.slice(0,boundary)),tailText=line.slice(boundary+1,tailEnd),tail=profileText(tailText);
  const headPattern=new RegExp("^行号定位\\s*(\\d+)\\s*行\\s*:\\s*带\\s*"+quotedLiteral(source)+"\\s*的行号定位(?:为|是)\\s*(第.+行)$","u");
  const first=headPattern.exec(head);
  const second=/^同(行首)?(?:带|含)\s*(\[[\p{L}\p{N}_-]{1,60}\])\s*(\d+)\s*行\s*:\s*(第.+行|无)$/u.exec(tail);
  if(!first||!second||!tailText.includes(second[2]))return null;
  const citationOrdinals=ordinalLines(first[2],true);
  const markerOrdinals=second[4]==="无"?{claimedLines:[],exampleLines:[]}:ordinalLines(second[4],true);
  const citationExpected=Number(first[1]),markerExpected=Number(second[3]);
  if(citationOrdinals.problem||markerOrdinals.problem||![citationExpected,markerExpected].every(Number.isSafeInteger))return null;
  // Compare the whole selected clause after removing presentation syntax. A
  // model cannot submit just a matching number and leave the list unproved.
  const clause=profileText(assertion.quote);
  if(assertion.end<=boundary+1&&clause===head)return {profileClause:"citation-lines",expected:citationExpected,...citationOrdinals};
  if(assertion.start>boundary&&assertion.end<=tailEnd&&clause===tail)return {profileClause:"marked-citation-lines",expected:markerExpected,...markerOrdinals,
    marker:second[2],markerPosition:second[1]?"leading":"any"};
  return null;
}

/** Recognize only one source already authorized for the current phase. */
function profileAtBlock(block,sources,candidate) {
  if(!block||objectMarker(block.lineText)!=="稿件自述")return null;
  const assertion={start:block.start,end:block.end,quote:block.text};
  for(const source of sources) {
    if(keyOf(source)===keyOf(candidate))continue;
    const profile=candidateProfile(block.lineText,assertion,source);
    if(profile)return {source,profile};
  }
  return null;
}

/** A hint reveals only the typed input already present in the current block. */
function profileHint(block,grant,candidate) {
  const match=profileAtBlock(block,grant.evidence,candidate);
  return match?{kind:"candidate",check:"citation-profile",source:match.source}:null;
}

/** Require both recognized statistics to use their measured object, including
 * the second block which does not repeat the tag or the source name. */
function requireProfileProof(block,grant,candidate,parts) {
  const hint=profileHint(block,grant,candidate);
  if(hint&&!parts.some(part=>part.objectCheck?.check===hint.check&&part.objectCheck.source===hint.source)) {
    throw objectFailure("parameter","组合稿件统计须按本块的 objectCheckHint 复算；不能用外部出处或 nonfactual 跳过数量、行号或标记",{objectCheckHint:hint});
  }
}

/** Compare the complete declared and actual sets before applying display caps. */
function compareOrdinals(claimedLines,actualLines,expected) {
  const declared=new Set(claimedLines),actual=new Set(actualLines),seen=new Set(),duplicates=new Set();
  for(const line of claimedLines){if(seen.has(line))duplicates.add(line);seen.add(line);}
  const missing=actualLines.filter(line=>!declared.has(line)),extra=[...declared].filter(line=>!actual.has(line));
  const lineListMatches=claimedLines.length===expected&&!missing.length&&!extra.length&&!duplicates.size;
  return {claimedLines,lineListMatches,missingLines:missing.slice(0,24),missingCount:missing.length,
    extraLines:extra.slice(0,24),extraCount:extra.length,duplicateLines:[...duplicates]};
}

/** Filter actual cited physical rows by a literal label. Markdown list and
 * heading tokens are presentation for the stricter leading-only mode. */
export function citationMarkedLines(lines,citedLines,marker,leading=false) {
  return citedLines.filter(line=>leading
    ? lines[line-1].trimStart().replace(/^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u,"").startsWith(marker)
    : lines[line-1].includes(marker));
}

/** Use the same exact-set and marker semantics at submit and in both reviews. */
function measureCitationProfile(profile,lines,citedLines) {
  const {profileClause,expected,claimedLines,exampleLines,marker,markerPosition}=profile;
  // Use actual cited rows, never the author's declared citation set or every
  // occurrence of the tag across the draft.
  const actualLines=marker?citationMarkedLines(lines,citedLines,marker,markerPosition==="leading"):citedLines;
  const ordinals=compareOrdinals(claimedLines,actualLines,expected);
  const wrongExampleLines=exampleLines.filter(line=>!errorExample(lines[line-1]??""));
  const matches=actualLines.length===expected&&ordinals.lineListMatches&&!wrongExampleLines.length;
  return {matches,profileClause,expected,actual:actualLines.length,unit:marker?"candidate-marked-citation-lines":"candidate-citation-lines",
    lines:actualLines.slice(0,24),...ordinals,exampleLines,wrongExampleLines,...(marker?{marker,markerPosition}:{})};
}

/** Preflight computes only recognized clauses in the current candidate bytes.
 * Source names come from the caller's existing grant; no external file is read.
 * Reuse the reviewer predicate so a passing executor preflight cannot mean a
 * weaker measurement than the one the downstream proofs must carry. */
export function candidateCitationProfiles(bytes,authorizedSources,candidate) {
  const lines=lineList(bytes);
  if(!lines.some(line=>objectMarker(line)==="稿件自述"))return [];
  const counts=new Map();
  return documentCoverage(bytes).blocks.flatMap(block=>{
    const matched=profileAtBlock(block,authorizedSources,candidate);
    if(!matched)return [];
    const {source,profile}=matched;
    if(!counts.has(source))counts.set(source,citationLineCounts(bytes,[source])[0].lines);
    return [{line:block.line,block:block.id,source,...measureCitationProfile(profile,lines,counts.get(source))}];
  });
}

/** This predicate has only a positive, universal, literal-label meaning.
 * Anchor the whole clause, so a filename/count, a negative claim, or a genuine
 * extra assertion cannot borrow the accidental presence of a marker as proof.
 * Not-all and none are distinct predicates and are deliberately unsupported.
 */
function candidateMarkClaim(quote,source,marker,leading,guide) {
  if(typeof marker!=="string"||!marker.trim()||marker.length>80||/[\r\n]/u.test(marker)||!quote.includes(marker))throw objectFailure("parameter","marker 须是本句声明的明确单行标记，最长80字符",guide);
  if(source.normalize("NFKC").includes(marker.normalize("NFKC")))throw objectFailure("parameter","引用来源路径及其片段不能充当 marker；文件名的出现不证明已标记",guide);
  const subject="(?:本稿|本文|本节|稿件|候选稿?|当前文档)(?:中)?",target=quotedLiteral(source),label=quotedLiteral(marker);
  const action=(leading?"(?:在)?行首\\s*(?:含有?|带有|标有|标注(?:为|了)?|标记(?:为|了)?|标了|标)":"(?:含有?|带有|标有|标注(?:为|了)?|标记(?:为|了)?|标了)")+"\\s*"+label+"(?:\\s*标记)?";
  const contract=new RegExp("^"+subject+"\\s*(?:(?:所有|全部)\\s*"+target+"\\s*(?:的)?引用行(?:都|均)\\s*"+action+"|引用\\s*"+target+"\\s*的每(?:一)?行(?:都|均)\\s*"+action+"|(?:带|有)\\s*"+target+"\\s*(?:的)?行号定位的每(?:一)?行(?:都|均)\\s*"+action+")$","u");
  if(!contract.test(candidateClause(quote)))throw objectFailure("parameter",(leading?"citations-leading-marked":"citations-marked")+" 须绑定完整正向全称标记句、同一来源和明确标记位置；数量/行号表请用 citation-count，‘未全标’与‘完全没标’均不能用此谓词代证",{...guide,claimForm:"本稿所有 "+source+" 引用行都"+(leading?"在行首标了":"含")+marker+"标记。",next:"只修核验参数；若同句另有数量、否定或独立后半句，请按实际原文拆分核验，不要求作者改写正确句子。"});
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
    count:["file","expected"],contains:["file","quote"],excludes:["file","quote"],"line-status":["file","line","expected"],
    "line-range":["file","start","end","mode"]},
    candidate:{"citation-count":["source","expected"],"citations-marked":["source","marker"],"citations-leading-marked":["source","marker"],"citation-profile":["source"]}};
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
    } else if(input.check==="line-range") {
      const claim=registeredLineRange(assertion.quote,[file]);
      if(!claim||input.start!==claim.start||input.end!==claim.end||input.mode!==claim.mode
        ||claim.start<1||claim.end<claim.start||claim.end>observed.lines.length||claim.end-claim.start>=250){
        throw objectFailure("parameter","line-range 只核同一来源的明确本地快照行区间，参数须逐字对应当前单一断言；整页、外部事实或另一对象须另行核验",guide);
      }
      const actual=observed.registered.map(row=>row.line),registered=new Set(actual);
      const claimedLines=Array.from({length:claim.end-claim.start+1},(_,offset)=>claim.start+offset);
      const missingLines=claimedLines.filter(line=>!registered.has(line));
      const extraLines=claim.mode==="exact"?actual.filter(line=>line<claim.start||line>claim.end):[];
      result.result={matches:missingLines.length===0&&extraLines.length===0,actual,unit:"snapshot-line-range",claimedLines,missingLines,extraLines};
    } else {
      if(typeof input.quote!=="string"||!input.quote.trim()||input.quote.length>2000||/[\r\n]/u.test(input.quote)||!assertion.quote.includes(input.quote))throw objectFailure("parameter","contains/excludes 的 quote 须为当前断言内的确切单行文本，不能自行换成别的主题");
      const matching=observed.registered.filter(row=>row.quote.includes(input.quote));
      const actual=matching.length>0;
      result.result={matches:input.check==="contains"?actual:!actual,actual,unit:"registered-excerpt-literal",lines:matching.slice(0,24).map(row=>row.line)};
    }
  } else {
    const source=relativeName(input.source),grant=spec.phases[active.phase],seen=active.seen?.[keyOf(spec.candidate)];
    const profile=input.check==="citation-profile"?candidateProfile(lines[assertion.line-1],assertion,source):null;
    if(input.check==="citation-profile"&&!profile)throw objectFailure("parameter","citation-profile 须绑定当前稿件自述的完整原句块、同一来源和完整行号表；不能跳过数值、标记或附加断言",guide);
    if(!profile&&!/(?:本稿|本文|本节|稿件|候选|当前文档|this (?:draft|document))/iu.test(assertion.quote))throw objectFailure("unverifiable","candidate 检查只证明当前稿件的明确结构，不能替外部事实作证",candidateProofGuide());
    if(keyOf(source)===keyOf(spec.candidate))throw objectFailure("parameter","source 是该句引用目标，不能填候选自身 "+spec.candidate,guide);
    if(!profile&&!citation(assertion.quote,source))throw objectFailure("parameter","稿件自述必须明确写出所检查的同一来源路径，不能借别的引用对象作证",guide);
    if(!includes(grant.evidence,source)||!includes(grant.read,spec.candidate))throw objectFailure("unverifiable","稿件引用对象不在当前单元授权内");
    if(!host&&(seen?.hash!==candidateSha256||!seen.ranges.some(([a,b])=>a===1&&b>=lines.length)))throw objectFailure("unverifiable","核全稿自述前须实际完整读取当前候选版本");
    result.source=source;
    const counted=citationLineCounts(bytes,[source])[0];
    if(profile) {
      result.result=measureCitationProfile(profile,lines,counted.lines);
    } else if(input.check==="citation-count") {
      const claim=candidateCountClaim(assertion.quote,source,guide);
      countAssertion(claim.quantityQuote,input.expected,"candidate-citation-lines",guide);
      result.result={matches:counted.count===input.expected,actual:counted.count,unit:"candidate-citation-lines",lines:counted.lines.slice(0,24)};
      if(claim.claimedLines) {
        const ordinals=compareOrdinals(claim.claimedLines,counted.lines,input.expected);
        result.result={...result.result,matches:result.result.matches&&ordinals.lineListMatches,...ordinals};
      }
    } else {
      const leading=input.check==="citations-leading-marked";
      candidateMarkClaim(assertion.quote,source,input.marker,leading,guide);
      if(!counted.count)throw objectFailure("unverifiable","当前稿无该来源的可识别同行定位，不能用空集合证明逐处已标记");
      const marked=new Set(citationMarkedLines(lines,counted.lines,input.marker,leading));
      const missing=counted.lines.filter(line=>!marked.has(line));
      result.result={matches:missing.length===0,actual:counted.count,unit:"candidate-citation-lines",lines:counted.lines.slice(0,24),missingLines:missing.slice(0,24),missingCount:missing.length};
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
  current.sources=current.sources.map((ref,index)=>savedReferenceShape(ref,part.objectCheck.sources?.[index]));
  if(JSON.stringify(current)!==JSON.stringify(part.objectCheck))throw objectFailure("unverifiable","对象版本、实际范围或计算结果已变化，须重新核验该块");
}

/** Recheck typed objects at ledger closure without new coordinator access/reads. */
export function requireStoredObjectChecks(frame,spec,coverages,bytes,phase="final-review") {
  const lines=lineList(bytes),blocks=new Map(documentCoverage(bytes).blocks.map(block=>[block.id,block]));
  try {
    if(!["first-review","final-review"].includes(phase))throw new Error("invalid review authority");
    for(const coverage of coverages)for(const record of coverage.records) {
      const block=blocks.get(record.block);
      requireProfileProof(block,spec.phases[phase],spec.candidate,record.parts);
      validateSimulationScope(frame,{phase},spec,block,record.parts);
      validateBoundedRecord(frame,{phase},spec,block,record.parts,{host:true});
      for(const part of record.parts) {
      validateObjectPart(frame,{phase},spec,part,lines,block,bytes,{host:true});
      if(part.objectCheck&&(!part.objectCheck.result.matches||part.status!=="supported"))throw new Error("object not accepted");
      if(part.inference?.nonEntailment&&(!part.inference.nonEntailment.holds||part.status!=="supported"))throw new Error("bounded case not accepted");
      }
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
function reviewBlock(frame, active, spec, block, parts, lines, visible) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 20) throw new Error(block.id + " 需 parts，复合句请拆出各独立判断");
  let cursor = 0;const neutral=neutralMask(block.text);
  const binding=boundedCase(block,spec.phases[active.phase]);
  const bounded=binding&&measureBoundedCase(frame,active,spec,block,binding);
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
    const boundedPart=bounded&&requireBoundedPart(block,result,binding,bounded);
    const scope=simulationMarker(block.text);
    if(scope&&start<scope.end-1&&cursor>scope.start+1&&!["direct","inference"].includes(part.kind))throw scopeFailure("[模拟] 是来源范围断言，不能作为无事实标签",block,scope);
    if(["direct","inference"].includes(part.kind)&&[...quote].some(char=>/[\p{L}\p{N}]/u.test(char))
      &&Array.from({length:cursor-start},(_,i)=>start+i).every(i=>neutral[i]||/[\s\p{P}]/u.test(block.text[i]))) {
      throw new Error("[building-loop/classification] 该片段只有宿主识别的中性标签或有界非断言建议，请改核验参数为 kind=nonfactual、status=supported，并说明其结构/建议作用；保留作者原文，不能为此补来源或制造作者退回。neutralSpans="+JSON.stringify(neutralTextSpans(block.text)));
    }
    if(part.objectCheck&&(part.kind!=="direct"||part.evidence!==undefined||part.inference!==undefined))throw objectFailure("parameter","objectCheck 仅用于 direct，且不能与外部 evidence/inference 混用");
    if (errorExample(quote) && part.kind !== "error-example") throw new Error("正文已明确标为误读/错例，请用 error-example 核验它的反证，不要把展示错误误当成作者认可该结论。这是核验分类修正，不是正文返工。");
    if (part.kind === "direct" && explicitInference(quote)) throw new Error("该段含明确推导连接词，不能用 direct 跳过推导。改用 inference；这只是核验分类修正，不要求作者改正文。若来源本身已写明关系，可用 source-warrant。不要把未明确标注的错误断言解释成教学反例。");
    if (["direct", "inference"].includes(part.kind)) {
      // Source agreement is assessed independently of inferred author intent.
      // A reviewer who recognizes a contradiction cannot mark the assertion as
      // supported by calling it an unlabelled example or a rhetorical device.
      if (!["supports", "contradicts", "insufficient"].includes(part.sourceRelation)) throw new Error("事实段必须单独给 sourceRelation=supports|contradicts|insufficient：按原句字面判断证据关系，不能因猜测作者在举反例而改成支持。未显式标注错例的句子按断言核验。");
      result.sourceRelation = part.sourceRelation;
      if (part.status === "supported" && part.sourceRelation !== "supports") throw new Error(boundedPart && bounded.nonEntailment.holds
        ? "[coverage-non-entailment] sourceRelation 应为 supports：核验的是外层‘不能说明’这个已成立的结论，内层命题推不出正是支持外层的理由。只改核验参数，保留正文。"
        : "原文关系为 " + part.sourceRelation + "，该断言不能 supported。请给实际事实退回；写作者须明确修订或标注错例，核验者不能自行补上写作意图。");
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
        &&(["citations-marked","citations-leading-marked","citation-profile"].includes(result.objectCheck.check)||candidateCountClaim(quote,result.objectCheck.source,{}).fullyBound)) {
        throw objectFailure("parameter","完整绑定的稿件对象谓词已实测成立，不能将同一事实填 unsupported 制造作者债；独立后半句请按原文拆分并另给真实 finding",{...result.objectCheck.result,next:"保留正确正文，只修核验状态/分段；不能用已证真对象代替另一断言的反证。"});
      }
      if(part.status==="unsupported"&&result.objectCheck.result.matches&&result.objectCheck.check==="line-range") {
        throw objectFailure("parameter","本地快照登记区间已实测成立，只修正核验状态，不为同一断言制造作者退回",result.objectCheck.result);
      }
    } else if (boundedPart) {
      // This is a host-measured proof, not an interpretation of the model's
      // counterexample text. Both roles still supply a current verdict and basis.
      if(binding.opposite&&part.sourceRelation!=="insufficient") {
        throw new Error("[coverage-non-entailment] 此处是前提不足以推出‘其他都不是’，并未证明现实中的其他对象属于哪类。填 sourceRelation=insufficient，保留实际 finding。");
      }
      if(binding.opposite&&(typeof part.finding?.quote!=="string"||!part.finding.quote.includes(binding.opposite))) {
        throw new Error("[coverage-non-entailment] finding.quote 须引用实际‘其他都不是’断言，不能退回前面正确的单向规则");
      }
      result.inference=bounded;
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
    // These describe different objects. A manuscript measurement or a local
    // excerpt registry cannot establish a fact about the external world.
    if(["direct","inference"].includes(part.kind)) {
      const marker=objectMarker(block.lineText);
      result.proofObject=result.objectCheck?.kind??(marker==="稿件自述"?"candidate":marker==="摘录范围"?"registered-excerpts":"external");
    }
    return result;
  });
  if (block.text.slice(cursor).trim()) throw spanError(block,parts.length+1,cursor,undefined,"missing-tail");
  requireProfileProof(block,spec.phases[active.phase],spec.candidate,reviewed);
  const range=registeredLineRange(block.text,spec.phases[active.phase].evidence);
  if(range&&!reviewed.some(part=>part.objectCheck?.check==="line-range"&&keyOf(part.objectCheck.file)===keyOf(range.file))) {
    throw objectFailure("parameter","明确本地快照登记区间须按 objectCheckHint 复核，不能用外部事实或另一来源替代",{objectCheckHint:range});
  }
  validateSimulationScope(frame,active,spec,block,reviewed);
  const marker=objectMarker(block.text),expected=marker==="摘录范围"?"registered-excerpts":marker==="稿件自述"?"candidate":null;
  if(expected) {
    const facts=reviewed.filter(part=>["direct","inference"].includes(part.kind));
    if(!facts.length||facts.some(part=>part.status==="supported"&&(part.kind!=="direct"||part.objectCheck?.kind!==expected))) {
      throw objectFailure("parameter","显式 ["+marker+"] 事实须用对应 objectCheck 支持，不能全部 nonfactual；依据不足可用真实 finding 退回");
    }
  }
  validateAttribution(frame,active,spec,block,reviewed,visible);
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
    const offset = args.offset ?? 0, requested = args.count ?? 8;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requested) || requested < 1) {
      throw new Error("覆盖分页须使用非负整数 offset 和正整数 count。可从 inventory offset=0 count=8 开始，再按返回 next 继续");
    }
    const count = Math.min(requested, INVENTORY_LIMIT);
    if (active.coverage?.candidateSha256 !== manifest.candidateSha256 || active.coverage?.version !== COVERAGE_VERSION) {
      active.coverage = { version: COVERAGE_VERSION, candidateSha256: manifest.candidateSha256, records: {} };
      frame.changed = true;
    }
    const invalidated = retireStaleProofs(frame, active, spec, bytes, manifest);
    const pending = manifest.blocks.filter(b => !Object.hasOwn(active.coverage.records, b.id)).map(b => b.id);
    const result = { candidateSha256: manifest.candidateSha256, classificationVersion:CLASSIFICATION_VERSION,total: manifest.blocks.length,
      pending: options.maxBytes ? pending.slice(0,24) : pending, pendingCount: pending.length,
      invalidated:options.maxBytes?invalidated.slice(0,8).map(row=>({...row,reason:row.reason.slice(0,240),
        ...(row.reason.length>240?{reasonTruncated:true}:{})})):invalidated,
      invalidatedCount:invalidated.length,offset,blocks:[],
      ...(requested > count ? { pageLimit: { requested, applied: count } } : {}) };
    for (const row of manifest.blocks.slice(offset,offset+count)) {
      const {lineText,...block}=row;
      const hint=profileHint(row,spec.phases[active.phase],spec.candidate)??registeredLineRange(row.text,spec.phases[active.phase].evidence);
      if(hint)block.objectCheckHint=hint;
      const bounded=boundedCase(row,spec.phases[active.phase]);
      if(bounded)block.inferenceHint={rule:"bounded-non-entailment",kind:"inference",quote:row.text.slice(...bounded.tail),
        source:{file:bounded.file,start:bounded.start,end:bounded.end},
        note:"核验整段外层结论。原句‘不能说明’且原文确实推不出内层命题，填 status=supported、sourceRelation=supports；若原句却断言可推出该命题，填 unsupported、insufficient 和实际 finding。宿主复算有界反例，不需另填 inference。"};
      // prepare has a separate response budget. Never stamp blocks removed by
      // that budget as shown; the explicit next page remains unobserved.
      if (options.maxBytes && Buffer.byteLength(JSON.stringify({...result,blocks:[...result.blocks,block]}))>options.maxBytes-400) break;
      result.blocks.push(block);
    }
    if (offset+result.blocks.length<manifest.blocks.length) result.next = {
      tool:"building_loop_coverage",action:"inventory",offset:offset+result.blocks.length,
      count:result.blocks.length?Math.min(INVENTORY_LIMIT,manifest.blocks.length-offset-result.blocks.length):1,
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
  if (args.action !== "record" || !Array.isArray(args.entries) || !args.entries.length) throw new Error("record 每次提交 1–12 个 entries");
  if (args.entries.length > RECORD_LIMIT) {
    // Reject the full batch before touching proofs. The caller reuses its own
    // submitted entries in order; listing an ordinal never proves that row.
    return { status: "batch-too-large", recorded: [], requested: args.entries.length, limit: RECORD_LIMIT,
      next: { tool: "building_loop_coverage", action: "record", entriesFrom: 1, entriesThrough: RECORD_LIMIT,
        note: "未保存本批任何条目。原样重交这段 entries，成功后按同一上限提交余项。序号是本次数组位置，不是覆盖块编号。" } };
  }
  // A source change can invalidate more blocks than fit in one record call.
  // Retire them before incremental repair, so an untouched stale block cannot
  // roll back eleven newly checked proofs. Completion still rechecks every ref.
  const invalidated = retireStaleProofs(frame, active, spec, bytes, manifest);
  const records = { ...active.coverage.records }, supplied = new Set(), invalid = [];
  const lines=lineList(bytes),visible=bodyVisibility(lines);
  for (const entry of args.entries) {
    const block = manifest.blocks.find(row => row.id === entry.block);
    if (!block || supplied.has(entry.block)) throw new Error("覆盖编号不存在或重复，请使用 inventory 返回的当前编号");
    supplied.add(entry.block);
    try {
      const owner=active.coverage.presentationOwner;
      if (owner?.actor!==(frame.agent?.id??null)||owner.phase!==active.phase||owner.candidateSha256!==manifest.candidateSha256
        ||!active.coverage.presented?.includes(block.id)) throw new Error("该块尚未由本会话本阶段 inventory/prepare 实际返回；pending 编号不能代替块原文。请调用 inventory offset="+manifest.blocks.indexOf(block)+" count=1 后再判断，不要猜编号对应内容。");
      records[block.id] = reviewBlock(frame, active, spec, block, entry.parts, lines, visible);
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
function validateRecordSources(frame, active, spec, record, lines, block, bytes, visible) {
  requireProfileProof(block,spec.phases[active.phase],spec.candidate,record.parts);
  validateBoundedRecord(frame,active,spec,block,record.parts);
  // Syntax is neutral only while its locator remains authorized, read and pinned.
  // Keep the same ordinary refs for host closure to check without exposing text.
  for(const ref of record.syntaxSources??[]) {
    const current=evidenceReference(frame,active,spec,ref);
    if(current.sha256!==ref.sha256||JSON.stringify(current.origin)!==JSON.stringify(ref.origin))throw new Error("合法定位的来源或获取回执版本已变化，须重新核验");
  }
  for (const part of record.parts) {
    for (const ref of proofReferences(part)) {
      const current = sourceQuote(frame, active, spec, ref);
      if (ref.sha256 !== current.sha256||ref.origin&&JSON.stringify(ref.origin)!==JSON.stringify(current.origin)
        ||ref.evidenceSpan&&ref.evidenceSpan!==current.evidenceSpan) throw new Error("覆盖证据或获取回执版本已经变化，须重新判断该块而非仅重读文件");
    }
    validateCalculationPart(frame, spec, part, lines, block);
    validateObjectPart(frame, active, spec, part, lines, block, bytes);
  }
  validateSimulationScope(frame,active,spec,block,record.parts);
  return validateAttribution(frame,active,spec,block,record.parts,visible);
}

/** Keep independent unaffected blocks; explicitly expose every invalidation. */
function retireStaleProofs(frame, active, spec, bytes, manifest) {
  const invalidated = [];
  const lines = lineList(bytes),visible=bodyVisibility(lines);
  const blocks = new Map(manifest.blocks.map(block => [block.id, block]));
  for (const [id, record] of Object.entries(active.coverage.records)) {
    try { validateRecordSources(frame, active, spec, record, lines, blocks.get(id), bytes,visible); }
    catch (error) {
      delete active.coverage.records[id];
      invalidated.push({ block: id, reason: error.message });
      frame.changed = true;
    }
  }
  return invalidated;
}

/** Only a unique, complete numbered direct claim can survive a draft edit.
 * Multi-block inference, author findings and manuscript objects are rechecked
 * from the new draft. Keep the prose introducing the numbered group as scope. */
function directCoverageAnchor(block, lines, files) {
  const match=/^ {0,3}(?:[-*+]\s+)?(?:\*\*)?(C\d+)(?:\*\*)?\s*[:：]\s*/u.exec(block.text);
  if(!match||block.start!==lines[block.line-1].indexOf(block.text)||block.text!==lines[block.line-1].trim()
    ||claimRow(lines,match[1])?.line!==block.line||!explicitAttribution(block,files)?.locators?.length
    ||/(?:上述|如下|前者|后者|同上|该项|这个|这些|\b(?:this|above|below)\b)/iu.test(block.text.slice(match[0].length)))return null;
  let groupStart=block.line-1;
  while(groupStart>0&&/^ {0,3}(?:[-*+]\s+)?(?:\*\*)?C\d+(?:\*\*)?\s*[:：]/u.test(lines[groupStart-1]))groupStart--;
  return digest(JSON.stringify([match[1],block.text,lines.slice(0,groupStart)]));
}

/** Save only bounded, explicit proofs from this independent role. The caller
 * checks the unchanged goal, policy and source inventory before restoring. */
export function directCoverageMemo(frame,active,spec,summary) {
  if(!spec.requireSourcePins)return {items:[],seen:{}};
  const bytes=readBytes(frame.root,spec.candidate),lines=lineList(bytes),grant=spec.phases[active.phase];
  const visible=bodyVisibility(lines);
  const blocks=new Map(documentCoverage(bytes).blocks.map(block=>[block.id,block]));
  const rejected=new Set(summary.rejected.map(row=>row.block));
  const items=[];
  const seen=Object.create(null);
  for(const record of summary.records) {
    const block=blocks.get(record.block),[part]=record.parts;
    if(!block||!visible(record.line)||rejected.has(record.block)||record.parts.length!==1||part.kind!=="direct"
      ||part.status!=="supported"||part.objectCheck||!part.evidence?.length)continue;
    const anchor=directCoverageAnchor(block,lines,grant.evidence);
    if(!anchor)continue;
    items.push({anchor,record});
    for(const ref of [...part.evidence,...(record.syntaxSources??[])]) {
      const key=keyOf(ref.file);
      seen[key]??={hash:ref.sha256,ranges:[]};
      if(!seen[key].ranges.some(([start,end])=>start===ref.start&&end===ref.end))seen[key].ranges.push([ref.start,ref.end]);
    }
    if(items.length===64)break;
  }
  return {items,seen};
}

/** Install only this role's own surviving proofs. Current inventory still reads
 * the draft, shows every block and independently checks all source versions. */
export function restoreDirectCoverage(frame,active,spec,memo) {
  const bytes=readBytes(frame.root,spec.candidate);
  if(!bytes||!memo.items.length)return;
  const manifest=documentCoverage(bytes),lines=lineList(bytes),grant=spec.phases[active.phase];
  const visible=bodyVisibility(lines);
  const old=new Map(memo.items.map(row=>[row.anchor,row.record]));
  const records={};
  for(const block of manifest.blocks) {
    if(!visible(block.line))continue;
    const prior=old.get(directCoverageAnchor(block,lines,grant.evidence));
    if(!prior)continue;
    const record={...prior,block:block.id,line:block.line,lineText:block.lineText,
      reusedProof:prior.reusedProof??{candidateSha256:memo.binding.candidateSha256,phase:memo.phase,block:prior.block}};
    const seen=Object.assign(Object.create(null),active.seen);
    for(const ref of [...record.parts[0].evidence,...(record.syntaxSources??[])])seen[keyOf(ref.file)]=memo.seen[keyOf(ref.file)];
    try {
      if(validateRecordSources(frame,{...active,seen},spec,record,lines,block,bytes,visible))continue;
    } catch { continue; }
    records[block.id]=record;
    active.seen=seen;
  }
  if(Object.keys(records).length)active.coverage={version:COVERAGE_VERSION,candidateSha256:manifest.candidateSha256,records};
}

/** Revalidate every source on completion so fresh reading cannot legitimize a stale proof. */
export function coverageSummary(frame, active, spec, complete = true) {
  const bytes = readBytes(frame.root, spec.candidate);
  const lines=lineList(bytes),visible=bodyVisibility(lines);
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
  const attributions=records.flatMap(record=>{
    const block=blocks.get(record.block),problem=validateRecordSources(frame,active,spec,record,lines,block,bytes,visible);
    return problem?[{block,problem}]:[];
  });
  const rejected = records.flatMap(record => record.parts.filter(part => ["direct", "inference"].includes(part.kind) && part.status !== "supported")
    .map(part => {
      const finding={block:record.block,line:record.line,text:part.quote,lineText:record.lineText,
        basis:part.basis,repair:part.repair,finding:part.finding,status:part.status,
        ...(part.inference?.nonEntailment?{boundedNonEntailment:part.inference.nonEntailment}:{})};
      const refs=proofReferences(part);
      const contextStart=blocks.get(record.block).start+part.start;
      const object=part.proofObject??part.objectCheck?.kind??(objectMarker(record.lineText)==="稿件自述"?"candidate"
        :objectMarker(record.lineText)==="摘录范围"?"registered-excerpts":"external");
      return {...finding,proofObject:object,repairBaseline:repairBaseline(frame.root,spec,lines,{...finding,contextStart},frame.reads,active.seen,refs)};
    }));
  for(const {block,problem} of attributions) {
    const fix="将正文的出处改为实际可追溯的已登记原文，或撤回该断言。";
    const finding={block:block.id,line:block.line,text:block.text,lineText:block.lineText,status:"unsupported",sourceRelation:"insufficient",
      proofObject:"external",basis:"正文标注的出处无法作为原文证据（"+problem.reason+"）："+problem.file,
      repair:fix,finding:{kind:"missing-evidence",quote:block.text,fix},attribution:problem};
    rejected.push({...finding,repairBaseline:repairBaseline(frame.root,spec,lines,{...finding,contextStart:block.start},frame.reads,active.seen,[])});
  }
  const quotations = complete ? quotationChecks(frame, active, spec, manifest) : [];
  const modelRejections=rejected.slice();
  for (const quote of quotations.filter(row => !row.matches)) {
    const unavailable = quote.excludedLocators?.some(ref => ["unapproved-source", "invalid-range"].includes(ref.reason)
      || ref.reason?.endsWith("-footnote"));
    const fix = unavailable ? "提供已授权的有效原文定位，或撤回当前逐字引用声称。" : "恢复逐字引句或改称转述。";
    // A failed attribution owns the precise annotation. Keep the separately
    // normalized quotation observation stable for receipt consumers.
    const inlineQuote=quote.binding==="adjacent-single-source";
    const findingText=inlineQuote?quote.lineText.slice(quote.contextStart,quote.locatorEnd):quote.text;
    const baseline=repairBaseline(frame.root,spec,lines,{line:quote.line,text:findingText,quote:findingText,
      contextStart:quote.contextStart,footnote:quote.footnote,inlineQuote},frame.reads,active.seen,quote.refs);
    if(inlineQuote||quote.footnote)for(const row of modelRejections){
      const prior=row.repairBaseline;
      const scope=row.text.replace(/[。！？；;!?\s]+$/u,"");
      const scopeStart=prior.start-row.text.indexOf(prior.quote);
      if(row.line===quote.line&&["contradiction","missing-evidence"].includes(row.finding?.kind)
        &&prior.start>=baseline.start&&prior.end<=baseline.end&&scope&&scopeStart>=baseline.start
        &&scopeStart+scope.length<=baseline.end&&quote.lineText.slice(scopeStart,scopeStart+scope.length)===scope
        &&quote.lineText.slice(prior.start,prior.end)===prior.quote){
        // Preserve the reviewer finding and its original evidence. Only the
        // repair matcher follows the host's confirmed full attribution span.
        row.repairBaseline={...prior,attribution:baseline};
      }
    }
    rejected.push({ block: quote.block, line: quote.line,
      text: quote.text, lineText: quote.lineText, status: "unsupported", sourceRelation: unavailable ? "insufficient" : "contradicts",
      basis: unavailable ? "逐字引句自身的出处无效、未授权或脚注关系无法唯一定位，不能用同行另一来源代替核验。此处是缺证，不声称已证明原话为假。"
        : "声明为逐字原文的引句与同行所引原文范围不一致，不能用意思相近替代逐字引用。",
      repair: fix, finding: { kind: unavailable ? "missing-evidence" : "verbatim-quote", quote: findingText, fix },
      repairBaseline:baseline });
  }
  if (complete) for (const row of sourceLineEnumerationChecks(frame, active, spec, bytes, manifest)) {
    if (row.matches) continue;
    const { block, line, lineText, text, contextStart, source } = row;
    const basis = "原文 " + source.file + " 第 " + source.start + (source.end === source.start ? "" : "–" + source.end)
      + " 行未出现所声称的列项 " + row.missing.join("、") + "。不能用同行出处范围内的其他行支持‘在第几行列出’。";
    const fix = "改为实际列出这些成员的原文行并核对同行出处，或删除错误的原文行号断言。";
    const finding = { kind: "contradiction", quote: text, fix };
    // The host's concrete counterexample creates author debt without overwriting
    // the model's independent record or sending it another parameter retry.
    rejected.push({ block, line, text, lineText, basis, repair: fix, finding, status: "unsupported",
      sourceRelation: "contradicts", sourceLineEnumeration: row,
      repairBaseline: repairBaseline(frame.root, spec, lines, { line, text, contextStart, finding }, frame.reads, active.seen, [source]) });
  }
  // Identity follows the unchanged physical assertion, independent of the
  // role's judgment and current evidence version. Ambiguous duplicate lines
  // keep their positions rather than merging into one repair item.
  const counts=new Map();
  for(const line of lines)counts.set(line,(counts.get(line)??0)+1);
  const reviewVersion=digest(JSON.stringify([CLASSIFICATION_VERSION,frame.policy.hash,active.phase,active.goal?.sha256??null,
    manifest.candidateSha256,Object.entries(active.seen??{}).sort(([a],[b])=>a.localeCompare(b))]));
  for(const row of rejected) {
    row.findingId=digest(JSON.stringify([spec.candidate,active.goal?.sha256??null,row.lineText,
      counts.get(row.lineText)>1?row.line:null,row.repairBaseline?.start,row.finding?.quote,row.proofObject??"external"]));
    row.proofBinding=digest(JSON.stringify([reviewVersion,row.findingId,row.repairBaseline]));
  }
  return { version: COVERAGE_VERSION, candidateSha256: manifest.candidateSha256, total: manifest.blocks.length,
    pending, rejected, records, quotations, reusedProofs:records.flatMap(record=>record.reusedProof?[{block:record.block,from:record.reusedProof}]:[]),
    receiptSha256: digest(JSON.stringify({ records, quotations, rejected })) };
}

const sourceMember = "[A-Za-z][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)*";
const sourceMemberTokens = new RegExp("(?<![A-Za-z0-9_])" + sourceMember + "(?![A-Za-z0-9_])", "gu");
const sourceMemberList = new RegExp("^" + sourceMember + "(?:\\s*[,，、]\\s*" + sourceMember + ")*$", "u");
const sourceLineEnumeration = new RegExp(
  "^(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:C\\d+\\s*[:：]\\s*)?"
  + "(?:(?:[A-Za-z][A-Za-z0-9_. -]{0,39}\\s+)?(?:登记原文|登记摘录|原文|摘录|原始材料|来源)\\s*)?"
  + "(?<claim>在\\s*第\\s*(?<start>\\d{1,6})(?:\\s*[-–—至到]\\s*(?<end>\\d{1,6}))?\\s*行"
  + "(?:列出的(?:结论例子|示例|例子|项目|条目|成员|选项)\\s*(?:有|为|包括)|列出(?:了)?)\\s*"
  + "(?<first>" + sourceMember + ")\\s*(?:与|和|及|、)\\s*(?<second>" + sourceMember + ")"
  + "(?:\\s*(?:两项|两个(?:例子|示例|项目|条目|成员|选项)?))?)", "u");

/** Check exact ASCII list members on the explicitly claimed source rows, not
 * on the full adjacent locator range. Positive results do not replace review. */
export function sourceLineEnumerationChecks(frame, active, spec, bytes, manifest) {
  const lines = lineList(bytes), grant = spec.phases[active.phase];
  if (frame.role === "coordinator" || !grant || !lines.some(line => line.includes("列出"))) return [];
  const allowedEvidence = grant.evidence ?? (active.phase === "supplement" ? spec.phases["final-review"].evidence : []);
  const files = allowedEvidence.filter(file => includes(grant.read, file) && includes(frame.reads, file));
  if (!files.length) return [];
  // Supplement can test the final evidence it actually read, without inheriting
  // the reviewer read list, credentials, or any observed range.
  const evidenceSpec = grant.evidence ? spec : { ...spec, phases: { ...spec.phases, [active.phase]: { ...grant, evidence: files } } };
  const { live } = requiredLineMarkdown(lines), checks = [];
  for (const block of (manifest ?? documentCoverage(bytes)).blocks) {
    if (!live[block.line - 1]) continue;
    const match = sourceLineEnumeration.exec(block.text);
    if (!match) continue;
    const locator = adjacentCitationLocator(block.text, match[0].length, files);
    if (!locator || locator.locators.length !== 1 || !/^[。.!！]?\s*$/u.test(block.text.slice(locator.end))) continue;
    const cited = locator.locators[0], { claim, first, second } = match.groups;
    const start = Number(match.groups.start), end = Number(match.groups.end ?? match.groups.start);
    if (first === second || Math.max(first.length, second.length) > 64 || start < cited.start || end < start || end > cited.end || end - start >= 24) continue;
    const sourceBytes = readBytes(frame.root, cited.file), seen = active.seen?.[keyOf(cited.file)];
    if (!sourceBytes || seen?.hash !== digest(sourceBytes) || !seen.ranges.some(([a, b]) => a <= start && b >= end)) continue;
    const sourceLines = lineList(sourceBytes);
    if (cited.end > sourceLines.length) continue;
    let source;
    try { source = evidenceReference(frame, active, evidenceSpec, { file: cited.file, start, end }); }
    catch (error) { if (error instanceof UnobservedExcerptError) continue; throw error; }
    if (source.sha256 !== seen.hash) continue;
    const excerpt = sourceLines.slice(start - 1, end), members = [first, second];
    const seenMembers = new Set(excerpt.flatMap(line => line.match(sourceMemberTokens) ?? []));
    const missing = members.filter(member => !seenMembers.has(member));
    // A token in prose is not itself a listed member. Absence is conclusive;
    // presence is reported only for exact literal items or delimited lists.
    const literalItems = excerpt.flatMap(line => {
      const value = line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "").replace(/[.。]$/u, "");
      return sourceMemberList.test(value) ? value.split(/\s*[,，、]\s*/u) : [];
    });
    if (!missing.length && !members.every(member => literalItems.includes(member))) continue;
    const contextStart = block.start + match[0].length - claim.length;
    const text = block.lineText.slice(contextStart, block.start + locator.end);
    checks.push({ block: block.id, line: block.line, lineText: block.lineText, text, contextStart, source, locator: cited,
      members, missing, matches: missing.length === 0 });
  }
  return checks;
}

/** Deterministic validation of explicitly verbatim quotations with a literal
 * inline locator or a unique touching footnote. Other styles still need review.
 */
function quotationChecks(frame, active, spec, manifest) {
  const results = [];
  const normalize = value => value.replace(/\s+/gu," ").trim();
  const lines = lineList(readBytes(frame.root,spec.candidate));
  const grant=spec.phases[active.phase],files=grant.evidence;
  const footnotes=lines.some(line=>line.includes("[^"))?footnoteQuoteIndex(lines,files):null;
  for (const [index,line] of lines.entries()) {
    for (const match of verbatimQuotes(line)) {
      const quoteEnd=match.index+match[0].length;
      const footnote=footnotes?.(index+1,match.index,quoteEnd);
      if(footnote?.ignored)continue;
      const bound = footnote ?? adjacentCitationLocator(line, quoteEnd, files);
      const locators = bound ? bound.locators : files.flatMap(file => {
        const cited = citation(line,file);
        return cited?.start ? [{file,start:cited.start,end:cited.end}] : [];
      });
      if (!locators.length && !bound?.excludedLocators.length) continue;
      const refs = [];
      const excludedLocators = [...(bound?.excludedLocators ?? [])];
      for (const locator of locators) {
        if(footnote&&includes(grant.read,locator.file)){
          const bytes=readBytes(frame.root,locator.file);
          if(bytes&&locator.end>lineList(bytes).length){excludedLocators.push({...locator,reason:"invalid-range"});continue;}
        }
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
        line:index+1,text:footnote?line.slice(match.index,footnote.end):match[0],lineText:line,contextStart:match.index,refs,matches,
        ...(footnote ? {binding:"adjacent-footnote",footnote:footnote.footnote} : bound ? {binding:"adjacent-single-source",locatorEnd:bound.end} : {}),
        ...(excludedLocators.length ? { excludedLocators } : {}) });
    }
  }
  return results;
}

/** An old pending proof could have matched an unrelated inline citation. Open
 * workflows with a touching footnote must carry the new exact host binding. */
export function requireStoredFootnoteBindings(spec,coverages,bytes,phase) {
  const lines=lineList(bytes);
  if(!lines.some(line=>line.includes("[^")))return;
  const footnotes=footnoteQuoteIndex(lines,spec.phases[phase].evidence);
  for(const [index,line] of lines.entries())for(const match of verbatimQuotes(line)){
    const bound=footnotes(index+1,match.index,match.index+match[0].length);
    if(!bound||bound.ignored)continue;
    const valid=bound.locators.length===1&&coverages.every(coverage=>coverage?.quotations?.some(row=>
      row.binding==="adjacent-footnote"&&row.line===index+1&&row.contextStart===match.index&&row.matches===true
      &&row.text===line.slice(match.index,bound.end)&&row.footnote?.id===bound.footnote.id
      &&row.footnote?.definitionLine===bound.footnote.definitionLine&&row.refs?.length===1
      &&["file","start","end"].every(key=>row.refs[0][key]===bound.locators[0][key])));
    if(!valid)throw new Error("当前开放验收缺少逐字引句的唯一脚注定位证明，须按当前稿重新核验");
  }
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
  // Always recompute host neutrality, including for old receipts. Neither a
  // prior overbroad direct label nor a supplied neutralSpans field is authority.
  for(const {start,end} of neutralTextSpans(record.text))mask.fill(0,start,end);
  for(let i=0;i<mask.length;i++)if(/[\s\p{P}]/u.test(record.text[i]))mask[i]=0;
  return mask;
}
function objectKind(part) {
  return part?.objectCheck?JSON.stringify([part.objectCheck.kind,part.objectCheck.file??part.objectCheck.source??null]):"external";
}

/** A touching marker is equivalent syntax only after both current roles have
 * independently matched the same bound quotation. The quote, the definition,
 * and any assertion outside the literal marker retain their ordinary masks. */
function agreedFootnoteMarkerSpans(first,second,record,other) {
  if(!/^[a-f0-9]{64}$/u.test(first.candidateSha256??"")||first.candidateSha256!==second.candidateSha256
    ||![first,second].every(summary=>summary.pending?.length===0&&summary.rejected?.length===0&&Array.isArray(summary.quotations))
    ||record.text!==other.text||record.line!==other.line||typeof record.lineText!=="string"||record.lineText!==other.lineText)return [];
  const blockStart=record.lineText.indexOf(record.text);
  if(blockStart<0||blockStart!==record.lineText.lastIndexOf(record.text))return [];
  const onRecord=summary=>summary.quotations.filter(row=>row.block===record.block&&row.line===record.line);
  const left=onRecord(first),right=onRecord(second);
  const positive=row=>row.binding==="adjacent-footnote"&&row.matches===true&&!row.excludedLocators?.length
    &&row.lineText===record.lineText&&row.refs?.length===1&&typeof row.footnote?.id==="string"
    &&Number.isSafeInteger(row.footnote.definitionLine)&&row.footnote.definitionLine>0&&row.footnote.definitionLine!==record.line;
  return left.flatMap(row=>{
    const peers=right.filter(peer=>peer.contextStart===row.contextStart);
    if(!positive(row)||left.filter(peer=>peer.contextStart===row.contextStart).length!==1||peers.length!==1)return [];
    const peer=peers[0];
    if(!positive(peer)||row.text!==peer.text||row.footnote.id!==peer.footnote.id||row.footnote.definitionLine!==peer.footnote.definitionLine)return [];
    const [source]=row.refs,[otherSource]=peer.refs;
    if(!/^[a-f0-9]{64}$/u.test(source.sha256??"")||!["file","start","end","sha256"].every(key=>source[key]===otherSource[key])
      ||JSON.stringify(source.origin)!==JSON.stringify(otherSource.origin))return [];
    const quote=[...verbatimQuotes(record.lineText)].find(match=>match.index===row.contextStart);
    if(!quote||!row.text.startsWith(quote[0])||record.lineText.slice(row.contextStart,row.contextStart+row.text.length)!==row.text)return [];
    const marker=/^\s*(\[\^([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\])$/u.exec(row.text.slice(quote[0].length));
    const quoteStart=row.contextStart-blockStart,end=quoteStart+row.text.length;
    if(!marker||marker[2].toLowerCase()!==row.footnote.id||quoteStart<0||end>record.text.length
      ||[record,other].some(proof=>proof.parts.some(part=>part.start<end&&part.end>quoteStart&&part.status!=="supported")))return [];
    return [[end-marker[1].length,end]];
  });
}

/** Return differing spans and the stable factual union required of both roles. */
export function classificationDisagreements(first,second) {
  return first.records.flatMap(record=>{
    const other=second.records.find(row=>row.block===record.block);if(!other)return [];
    const a=factualMask(record),b=factualMask(other),different=new Uint8Array(a.length),required=new Uint8Array(a.length),objects=new Uint8Array(a.length);
    for(const [start,end] of agreedFootnoteMarkerSpans(first,second,record,other)){a.fill(0,start,end);b.fill(0,start,end);}
    for(let i=0;i<a.length;i++) {
      required[i]=a[i]||b[i];different[i]=a[i]!==b[i]?1:0;
      if(a[i]&&b[i]) {
        const find=row=>row.parts.find(part=>(part.start??0)<=i&&(part.end??row.text.length)>i);
        if(objectKind(find(record))!==objectKind(find(other))){different[i]=1;objects[i]=1;}
      }
    }
    const factualSpans=maskSpans(different,record.text),requiredSpans=maskSpans(required,record.text);
    return factualSpans.length?[{block:record.block,line:record.line,text:record.text,factualSpans,requiredSpans,
      disputeId:digest(JSON.stringify([first.candidateSha256??null,record.block,record.lineText??record.text])),
      ...(objects.some(Boolean)?{objectSpans:maskSpans(objects,record.text)}:{}),
      basis:"核验对事实范围或证据对象存在分歧。requiredSpans 是扣除宿主有界中性语法后的双方事实并集；按真实对象补证，保留正确正文。纯编号/合法定位及 neutralSpans 可等价，未知修饰、解释与大白话中的事实不能跳过；仍无依据时 block 请求裁定。"}]:[];
  });
}

/** Used by checkpoint restoration and submission; never borrows the other role's proof. */
export function recordMeetsDispute(record,dispute) {
  if(!record||record.text!==dispute.text||!Array.isArray(record.parts)||!record.parts.length)return false;
  const mask=factualMask(record),neutral=neutralMask(record.text),spans=dispute.requiredSpans?.length?dispute.requiredSpans:dispute.factualSpans?.length?dispute.factualSpans:[[0,dispute.text.length]];
  return spans.every(([a,b])=>{
    for(let i=a;i<b;i++)if(dispute.text[i]?.trim()&&!/[\s\p{P}]/u.test(dispute.text[i])&&!neutral[i]&&!mask[i])return false;
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
  const objectCheck={type:"object",properties:{kind:{type:"string",enum:["registered-excerpts","candidate"]},check:{type:"string",enum:["count","contains","excludes","line-status","line-range","citation-count","citations-marked","citations-leading-marked","citation-profile"]},
    file:string,source:string,line:integer,expected:{anyOf:[integer,{type:"string",enum:["registered","unregistered"]}]},quote:string,marker:string,
    start:integer,end:integer,mode:{type:"string",enum:["subset","exact"]}},required:["kind","check"],additionalProperties:false,
    description:"direct 专用，与 evidence 互斥。registered-excerpts: count(file,expected条/句/项)、contains/excludes(file,quote单行确切文本)、line-status(file,line,expected登记状态)、line-range(file,start,end,mode，按 inventory)，只核本地登记摘录，不证明网页全文，勿与其他事实或来源合用。candidate: citation-count(source,expected可识别同行引用行数)、citations-marked(source,marker确切字面)、citations-leading-marked(source,marker确切行首)、citation-profile(source，按块照填 inventory 的 objectCheckHint)，须先读当前全稿。参数/读取/谓词冲突留在核验侧；真实对象不符须核验者显式 unsupported+finding。"};
  return { offset: { ...integer, minimum: 0, description: "inventory 的起始位置，使用上页 next.offset。" },
    count: { ...integer, minimum: 1, maximum: INVENTORY_LIMIT, description: "inventory 每页 1–24 块，下一页按返回的 next 原样传入 offset/count。" },
    block: { ...string, description: "status 可选：只取这一块已有的详细证明；省略时只返回进度摘要。" }, entries: { type: "array", minItems: 1, maxItems: RECORD_LIMIT,
    description: "每次提交1至12块，按 inventory 分页分批提交；不能把全文超过12块塞进一次调用。", items: { type: "object", properties: {
    block: string, parts: { type: "array", items: { type: "object", properties: {
      quote: { ...string, description: "单一判断可省略，自动取该块完整原文；复合判断须逐段连续覆盖本块，不能把下一块文字并入。匹配失败按 coverage-span 的 part/cursor/expectedSuffix 修正核验参数，不得改写正文或省掉事实。" },
      kind: { type: "string", enum: KINDS }, status: { type: "string", enum: STATUSES,
        description: "direct/inference 给事实判定；nonfactual 用 supported；hypothesis 宿主固定 uncertain，不能成为已证前提。" }, basis: string, repair: string,
      sourceRelation: { type: "string", enum: ["supports", "contradicts", "insufficient"], description: "direct/inference 必填：原始证据对该断言字面含义的关系。error-example 核展示的错误推理，只能 contradicts/insufficient，并提供 evidence；明确错例的状态由宿主固定，不作为已证前提。" },
      finding: { type: "object", properties: { kind: { type: "string", enum: ["missing-evidence", "contradiction", "scope", "invalid-inference"] }, quote: string, fix: string }, required: ["kind", "quote", "fix"], additionalProperties: false },
      evidence: { type: "array", items: ref }, inference: {...inference,description:"常规推导填结构证据；inventory 明示 bounded-non-entailment inferenceHint 的同源段只填事实判定与依据，宿主复算并保存推导；未支持仍给实际 finding。"}, objectCheck,
    }, required: ["kind", "status", "basis"], additionalProperties: false } },
  }, required: ["block", "parts"], additionalProperties: false } } };
}
