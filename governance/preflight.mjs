import { digest, includes, keyOf, readBytes, text } from "./policy.mjs";
import { footnoteDefinition, footnoteId, markdownStructure } from "./markdown-structure.mjs";

export const QUALITY = {
  sources: "资料的原始出处、核实办法和仍待证的部分",
  conclusion: "可支持的结论、修订理由与适用范围",
  method: "采用的方法、复算或反查及其局限",
  alternatives: "可行的备选、取舍和更合适的提议",
  detail: "先摘要后依据的层次、读者需要的细节",
  plain: "面向读者的一句大白话",
};

export const lineList = bytes => text(bytes).split(/\r\n|\n|\r/);
const escape = value => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

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

/** Catch explicit required rows on the author side before review pays to
 * read the whole draft. Reuse the same unique row lookup as the reviewer. */
export function requiredClaimRowIssues(lines, ids) {
  return ids.filter(id=>!claimRow(lines,id)?.body.trim()).map(id=>
    id+" 需要保留唯一的编号断言行，格式为 `"+id+"：正文`。业务标签放在冒号之后，例如 `"+id+"：E1 的判断……`");
}

/** 识别准确路径及原文行范围，排除同名前缀和备份别名。 */
export function citation(body, file) {
  const pattern = new RegExp("(^|[\\s:：\\x60\"'“‘(（\\[【〔<《,，、；;])" + escape(file)
    + "(?=$|[\\s#:,：，、。；;\\x60\"'”’）)\\]】〕>》]|\\.(?:\\s|$))", process.platform === "win32" ? "gi" : "g");
  const row = body.replaceAll("\\", "/");
  let mentioned = false;
  // A filename may first appear as a topic and only later carry its locator.
  // Prefer the first explicit range, but never hide an invalid explicit range
  // behind a later good one. Bare mentions retain their existing no-range shape.
  for (const match of row.matchAll(pattern)) {
    mentioned = true;
    const after = row.slice(match.index + match[0].length);
    const range = /^\s*(?:\x60\s*)?(?:#L(\d+)(?:-L?(\d+))?|[:：](\d+)(?:[-–—](\d+))?|第\s*(\d+)(?:\s*[-–—、至到]\s*(\d+))?\s*行)/i.exec(after);
    if (!range) continue;
    const start = Number(range[1] ?? range[3] ?? range[5]);
    const end = Number(range[2] ?? range[4] ?? range[6] ?? start);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start ? { start, end } : null;
  }
  return mentioned ? { start: null, end: null } : null;
}

const exactLineRange = "(?:#L\\d+(?:-L?\\d+)?|[:：]\\d+(?:[-–—]\\d+)?|第\\s*\\d+(?:\\s*[-–—、至到]\\s*\\d+)?\\s*行)";

/** Parse a single locator with no surrounding prose or second source. Unknown
 * paths return only diagnostics and are never opened by this parser. */
export function exactCitationLocator(value, files) {
  let body=value.trim().replace(/^(?:出处|来源|证据|source|evidence)\s*[:：]\s*/iu, "").replaceAll("\\", "/");
  if (/^`[^`]+`$/u.test(body)) body=body.slice(1,-1);
  for (const file of files) {
    const name=escape(file);
    if (!new RegExp("^(?:`"+name+"`|"+name+")\\s*"+exactLineRange+"$",process.platform==="win32"?"iu":"u").test(body)) continue;
    const cited=citation(body,file);
    return cited?.start ? {locators:[{file,...cited}],excludedLocators:[]}
      : {locators:[],excludedLocators:[{file,locator:body,reason:"invalid-range"}]};
  }
  const unknown=/^(?:`([^`\r\n]+)`|([^\s`"'“”‘’()（）\[\]【】<>:：#;,，、；]+))\s*(?:#L\d+(?:-L?\d+)?|[:：]\d+(?:[-–—]\d+)?|第\s*\d+(?:\s*[-–—、至到]\s*\d+)?\s*行)$/iu.exec(body);
  const file=unknown?.[1]??unknown?.[2];
  return file&&/^[^\s`"'“”‘’()（）\[\]【】<>:：#;,，、；]+\.[A-Za-z0-9_-]+$/u.test(file)
    ? {locators:[],excludedLocators:[{file,locator:body,reason:"unapproved-source"}]} : null;
}

/** Bind the literal adjacent annotation and its physical end to this quote.
 * Later locators can belong to different assertions on the same line. */
export function adjacentCitationLocator(line, quoteEnd, files) {
  const annotation=/^\s*(?:（([^（）\r\n]*)）|\(([^()\r\n]*)\)|\[([^\[\]\r\n]*)\]|【([^【】\r\n]*)】)/u.exec(line.slice(quoteEnd));
  if(!annotation)return null;
  const bound=exactCitationLocator(annotation.slice(1).find(value=>value!==undefined),files);
  return bound?{...bound,end:quoteEnd+annotation[0].length}:null;
}

/** Escape parity matters only outside a literal code span. */
function escapedMarkdown(text, index) {
  let slashes=0;
  while(index>0&&text[--index]==="\\")slashes++;
  return slashes%2===1;
}

const touchingFootnote=new RegExp("^\\[\\^("+footnoteId+")\\]","u");
const footnoteMarkers=new RegExp("\\[\\^("+footnoteId+")\\]","gu");
const finalFootnoteMarker=new RegExp("\\[\\^("+footnoteId+")\\]$","u");

/** Quotes explicitly presented as original words are the only automatic targets. */
export function verbatimQuotes(line) {
  return line.matchAll(/(?:原文|原句|逐字引文)\s*(?:为|是|写道|[:：])?\s*[“"]([^”"\n]{1,2000})[”"]/gu);
}

/** Hide literal spans while preserving original offsets. A code span may cross
 * a soft line break, but cannot claim an owner or definition. */
function footnoteProse(lines) {
  let fence=null,hidden=null,paragraph=[];
  const rows=lines.map(line=>{
    const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if(fence){if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;return "";}
    if(!hidden&&marker){fence=marker[1];return "";}
    if(!hidden&&/^(?: {4}|\t)/u.test(line))return "";
    let at=0,result="";
    while(at<line.length){
      if(hidden){
        const close=hidden.exec(line.slice(at)),end=close?at+close.index+close[0].length:line.length;
        result+=" ".repeat(end-at);at=end;if(close)hidden=null;
      }else{
        const open=/<!--|<(pre|code)\b[^>]*>/iu.exec(line.slice(at));
        if(!open){result+=line.slice(at);break;}
        const start=at+open.index;
        result+=line.slice(at,start)+" ".repeat(open[0].length);at=start+open[0].length;
        hidden=open[1]?new RegExp("</"+open[1]+"\\s*>","iu"):/-->/u;
      }
    }
    return result;
  });
  const flush=()=>{
    if(!paragraph.length)return;
    const text=paragraph.map(index=>rows[index]).join("\n"),runs=[...text.matchAll(/`+/gu)];
    const next=[],last=new Map();
    for(let i=runs.length-1;i>=0;i--){next[i]=last.get(runs[i][0].length);last.set(runs[i][0].length,i);}
    let masked="",at=0;
    for(let i=0;i<runs.length;i++){
      if(next[i]===undefined||escapedMarkdown(text,runs[i].index))continue;
      const start=runs[i].index,close=runs[next[i]],end=close.index+close[0].length;
      masked+=text.slice(at,start)+text.slice(start,end).replace(/[^\n]/gu,character=>" ".repeat(character.length));
      at=end;i=next[i];
    }
    masked+=text.slice(at);
    masked.split("\n").forEach((line,i)=>{rows[paragraph[i]]=line;});
    paragraph=[];
  };
  for(const [index,row] of rows.entries()){
    if(!row.trim()){flush();continue;}
    if(footnoteDefinition.test(row)||/^ {0,3}(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>)/u.test(row))flush();
    paragraph.push(index);
    if(footnoteDefinition.test(row))flush();
  }
  flush();
  return rows;
}

/** Bound required literals and authority fences to unambiguous live rows.
 * Preserve physical offsets, including wholly hidden rows for duplicate tests.
 * This conservatively excludes HTML, quotations and indented code rather
 * than treating arbitrary rendered markup as a literal preservation proof.
 */
export function requiredLineMarkdown(lines) {
  const { fences, visible, standaloneFootnotes, continuedFootnotes } = markdownStructure(lines);
  return { fences, live: visible.map(line => !!line.trim()), visible, standaloneFootnotes, continuedFootnotes };
}

/** Resolve only one quote-owned Markdown marker and one single-line definition.
 * Return an explicit unresolved binding when the apparent owner has no unique
 * location, so the caller cannot borrow a different source from its prose. */
export function footnoteQuoteIndex(lines, files) {
  const visible=footnoteProse(lines),definitions=new Map(),owners=new Map();
  for(const [index,row] of visible.entries()){
    const definition=footnoteDefinition.exec(row);
    if(definition){
      const id=definition[1].toLowerCase(),entries=definitions.get(id)??[];
      entries.push({line:index+1,text:lines[index].slice(definition[0].length)});definitions.set(id,entries);
    }
    for(const marker of row.matchAll(footnoteMarkers)){
      if(marker.index<(definition?.[0].length??0)||escapedMarkdown(row,marker.index))continue;
      const id=marker[1].toLowerCase();owners.set(id,(owners.get(id)??0)+1);
    }
  }
  return (line,quoteStart,quoteEnd)=>{
    const row=lines[line-1],tail=row.slice(quoteEnd),space=/^\s*/u.exec(tail)[0].length,start=quoteEnd+space;
    // Literal marker demonstrations never gain authority or use a nearby
    // fallback citation. Full coverage still checks the prose independently.
    if(/^\s*(?:\\+|`+)\[\^/u.test(tail))return {ignored:true};
    if(!tail.slice(space).startsWith("[^"))return null;
    if(!visible[line-1]?.[quoteStart]?.trim()||!visible[line-1]?.slice(start).startsWith("[^"))return {ignored:true};
    const marker=touchingFootnote.exec(row.slice(start));
    const end=marker?start+marker[0].length:start+2;
    const id=marker?.[1]?.toLowerCase(),entries=definitions.get(id)??[];
    const footnote={id:id??null,...(entries.length===1?{definitionLine:entries[0].line}:{})};
    const rejected=reason=>({end,footnote,locators:[],excludedLocators:[{reason,footnoteId:id??null}]});
    if(!marker)return rejected("malformed-footnote");
    if(/^\s*(?:\[\^|\()/u.test(row.slice(end))||owners.get(id)!==1||entries.length>1)return rejected("ambiguous-footnote");
    if(!entries.length)return rejected("unresolved-footnote");
    const entry=entries[0];
    let next=entry.line;
    while(next<lines.length&&!lines[next].trim())next++;
    if(/^(?: {4}|\t)/u.test(lines[next]??""))return rejected("ambiguous-footnote");
    const exact=exactCitationLocator(entry.text.trim().replace(/[。.]$/u,""),files);
    return exact?{...exact,end,footnote}:rejected("unresolved-footnote");
  };
}

/** Remove only recognized locators. Facts after a citation remain in the comparison. */
function conclusion(body, files = [], normalize = value => value.normalize("NFKC")) {
  let result = normalize(body).replaceAll("−", "-").replaceAll("\\", "/");
  for (const file of files) {
    const locator = new RegExp(escape(normalize(file))
      + "\\s*(?:#L\\d+(?:-L?\\d+)?|[:：]\\d+(?:[-–—]\\d+)?|第\\s*\\d+(?:\\s*[-–—、至到]\\s*\\d+)?\\s*行)", "gi");
    result = result.replace(locator, "");
  }
  return result.replace(/(?:出处|来源|证据|source|evidence)\s*[:：]/gi, "");
}

/** 消除排版差异，标题或标点调整不能伪装成实质补查。 */
function normalized(body) {
  return body.normalize("NFKC").replace(/[\s,，。;；!?“”‘’\x60*_()\[\]【】〔〕]+/g, "").toLowerCase();
}

/** Read only an explicit visible error label on this very sentence/span.
 * Markdown and numbered labels change presentation, never quoted source bytes.
 */
export function errorExample(value) {
  let visible=value.normalize("NFKC").trimStart();
  for(let depth=0;depth<8;depth++){
    const next=visible.replace(/^(?:>\s*|#{1,6}\s+|[-+*]\s+|\d{1,9}[.)]\s+)/u,"");
    if(next===visible)break;visible=next.trimStart();
  }
  visible=visible.replace(/(\*\*|__|\*|_)([^\r\n]+?)\1/gu,"$2");
  const number="(?:\\d+|[零〇一二两三四五六七八九十百千]+)";
  const ordinal="(?:\\s*(?:第\\s*)?"+number+"|\\s*\\(\\s*"+number+"\\s*\\))";
  // A short parenthetical description does not change an explicit label. Allow
  // one non-nested description and one ordinal in either order; no vocabulary
  // inside the description is privileged. NFKC also covers Chinese parentheses.
  const annotation="\\s*\\((?![ \\t]*\\))[^()\\r\\n]{1,64}\\)";
  const suffix="(?:(?:"+ordinal+")(?:"+annotation+")?|(?:"+annotation+")(?:"+ordinal+")?)?";
  const label="(?:误读|错例|错误示例|错误推理)"+suffix;
  const match=visible.match(new RegExp("^(?:\\[\\s*"+label+"\\s*\\]|【\\s*"+label+"\\s*】|"+label+"\\s*:)\\s*:?(.*)$","u"));
  return !!match&&/[^\s:。.!！?？]/u.test(match[1]);
}

/** Fingerprint only the cited, actually observed source range. Whole-file hashes
 * authenticate the read version; per-line content fingerprints detect substantive
 * new information without treating unrelated file edits or line shifts as proof.
 */
function repairReferences(root,spec,body,readable,seen,extra=[]) {
  const files=spec.phases?.["final-review"]?.evidence??[];
  const candidates=[...extra,...files.flatMap(file=>{const range=citation(body,file);return range?.start?[{file,...range}]:[];})];
  const refs=[];
  for(const ref of candidates){
    const {file,start,end}=ref;
    if(!includes(files,file)||!includes(readable,file)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start)continue;
    const bytes=readBytes(root,file),observed=seen?.[keyOf(file)];
    if(!bytes||observed?.hash!==digest(bytes)||!observed.ranges.some(([a,b])=>a<=start&&b>=end))continue;
    const lines=lineList(bytes);if(end>lines.length)continue;
    const lineHashes=lines.slice(start-1,end).map(normalized).filter(Boolean).map(digest);
    const item={file,start,end,sha256:digest(bytes),rangeHash:digest(JSON.stringify(lineHashes)),lineHashes};
    if(!refs.some(old=>keyOf(old.file)===keyOf(file)&&old.start===start&&old.end===end))refs.push(item);
  }
  return refs;
}

/** A scope return may be repaired by an explicit local limitation while keeping
 * its factual core. Group equivalent surface markers so renaming “本例” to
 * “本样例” alone does not masquerade as a new limitation.
 */
function scopeMarkers(value) {
  return [/(?:本|该)(?:样例|样本|案例|记录|观察|实验|试验|场景|例)/u.test(value)?"specified-case":null,
    /(?:仅|只)(?:限于|在|对|适用于|针对)/u.test(value)?"explicit-limitation":null].filter(Boolean);
}

/** Bind a new factual return to its actual rejected substring and evidence state.
 * This is a repair baseline, not a semantic verdict about a later new source.
 */
export function repairBaseline(root,spec,lines,finding,readable,seen,extra=[]) {
  const quote=finding.finding?.quote??finding.quote,line=lines[finding.line-1];
  const context=finding.text??line;
  if(typeof quote!=="string"||!quote.trim()||typeof line!=="string"||!line.includes(quote)||!context.includes(quote))throw new Error("退回片段须来自当前候选原文");
  const contextStart=finding.contextStart??line.indexOf(context),start=contextStart+context.indexOf(quote);
  if(contextStart<0||context.indexOf(quote,context.indexOf(quote)+1)!==-1)throw new Error("退回 finding.quote 在本段必须唯一定位，请缩小或补足实际错误片段；不要把正确前缀列入退回");
  if(line.slice(contextStart,contextStart+context.length)!==context)throw new Error("退回片段位置与当前正文不一致");
  return {version:1,quote,line:finding.line,start,end:start+quote.length,candidateSha256:digest(readBytes(root,spec.candidate)),
    kind:finding.finding?.kind,scopeMarkers:scopeMarkers(context),...(finding.footnote?{footnote:finding.footnote}:{}),
    ...(finding.inlineQuote?{inlineQuote:true}:{}),
    refs:repairReferences(root,spec,finding.footnote||finding.inlineQuote?"":line,readable,seen,extra)};
}

/** Group only Markdown paragraph continuations, keeping physical source rows.
 * A soft wrap is presentation, while a blank paragraph, heading, new list item,
 * quote/table/HTML/code boundary must never manufacture a joined assertion.
 */
function repairParagraphs(lines) {
  const groups=[];let rows=[],fence=null;
  const flush=()=>{if(rows.length){groups.push(rows);rows=[];}};
  for(const [index,text] of lines.entries()){
    const row={line:index+1,text},marker=/^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
    if(marker||fence){
      flush();groups.push([row]);
      if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;}
      continue;
    }
    if(!text.trim()){flush();continue;}
    // Indented code cannot interrupt an existing paragraph (including a list
    // item's paragraph). Without a blank/structural boundary it is a soft wrap.
    const isolated=!rows.length&&/^(?: {4}|\t)/u.test(text)
      ||/^ {0,3}(?:#{1,6}(?:\s|$)|>|\||<|(?:---+|___+|\*\*\*+)\s*$|\[[^\]]+\]:)/u.test(text);
    if(isolated){flush();groups.push([row]);continue;}
    if(/^ {0,3}(?:[-+*]|\d+[.)])\s+/u.test(text))flush();
    rows.push(row);
  }
  flush();return groups;
}

/** Locate every retained occurrence while ignoring cosmetic Unicode/spacing edits.
 * Offsets refer to NFKC text only for contextual stance checks; saved baselines
 * retain the exact original quotation and UTF-16 source offsets separately.
 */
function repairOccurrences(lines,quote,footnote) {
  const target=normalized(quote),result=[];if(!target)return result;
  for(const rows of repairParagraphs(lines)){
    const lineAt=[],parts=rows.map(row=>{
      const part=row.text.normalize("NFKC"),offset=lineAt.length;
      lineAt.length+=part.length+1;lineAt.fill(row.line,offset);return part;
    });
    const display=parts.join("\n"),positions=[];let searchable="";
    for(let i=0;i<display.length;i++)for(const char of normalized(display[i])){searchable+=char;positions.push(i);}
    for(let cursor=0;;){
      const at=searchable.indexOf(target,cursor);if(at<0)break;
      const start=positions[at],end=positions[at+target.length-1]+1;
      cursor=at+target.length;
      if(footnote?.id){
        // Presentation normalization may remove an underscore from the quote,
        // but it cannot merge two different literal footnote identifiers.
        const close=display.indexOf("]",end);
        const identifier=close>=end&&close-end<=64?finalFootnoteMarker.exec(display.slice(start,close+1))?.[1]:null;
        if(identifier?.toLowerCase()!==footnote.id)continue;
      }
      const before=display.slice(0,start),after=display.slice(end);
      const sentenceStart=Math.max(...[...before.matchAll(/[。；;!?！？]/gu)].map(match=>match.index+1),0);
      const tail=after.search(/[。；;!?！？]/u),sentenceEnd=tail<0?display.length:end+tail+1;
      result.push({line:lineAt[start],endLine:lineAt[end-1],text:display,
        sentence:display.slice(sentenceStart,sentenceEnd).replaceAll("\n"," "),
        before:display.slice(sentenceStart,start).replaceAll("\n"," "),after:display.slice(end,sentenceEnd).replaceAll("\n"," ")});
    }
  }
  return result;
}

/** Accept only unambiguous local withdrawal forms as a changed author stance.
 * Teaching labels apply to this sentence, never following unlabelled assertions.
 * These surface forms grant another full review; they do not prove the negation.
 */
function withdrawnOccurrence(item) {
  if(errorExample(item.sentence))return true;
  const prefix=item.before.replace(/[*_]/gu,"").split(/[，,:：]/u).at(-1).trim();
  const suffix=item.after.replace(/[*_]/gu,"").trim();
  const denial=/^(?:并非|不是|不能(?:据此)?(?:断言|认为|说|得出)|不应(?:断言|认为|说)|无法(?:据此)?(?:证明|断言|得出)|没有证据(?:证明|支持))\s*[“"‘'(（]?\s*$/u;
  const retracted=/^[”"’')）]?\s*(?:(?:这一|这个|该)(?:说法|结论|断言))?\s*(?:不成立|不正确|是错误的?(?:说法|结论|断言)?|没有依据|缺乏依据)(?:[，,。；;!?！？\s]|$)/u;
  return denial.test(prefix)||retracted.test(suffix);
}

/** The retained quote and its touching marker must still own a unique source.
 * No separately cited same-line source can count as a repaired footnote. */
function repairedFootnoteLocators(lines,item,baseline,footnotes) {
  if(item.line!==item.endLine)return [];
  const row=lines[item.line-1],target=normalized(baseline.quote);
  return [...verbatimQuotes(row)].flatMap(match=>{
    const bound=footnotes(item.line,match.index,match.index+match[0].length);
    return bound?.footnote&&bound.footnote.id===baseline.footnote.id&&normalized(row.slice(match.index,bound.end))===target ? bound.locators : [];
  });
}

/** Recheck only the retained inline attribution. A later matching citation on
 * its line is separate evidence and cannot satisfy this specific repair. */
function repairedInlineLocators(lines,item,baseline,files) {
  if(item.line!==item.endLine)return [];
  const row=lines[item.line-1],target=normalized(baseline.quote);
  return [...verbatimQuotes(row)].flatMap(match=>{
    const bound=adjacentCitationLocator(row,match.index+match[0].length,files);
    return bound&&normalized(row.slice(match.index,bound.end))===target ? bound.locators : [];
  });
}

/** Evaluate one returned span. Source changes qualify only for re-review and only
 * when they are cited at the retained assertion and read in this supplement.
 */
function checkRepairSpan(root,spec,lines,readable,active,finding,footnotes) {
  const baseline=finding.repairBaseline?.attribution??finding.repairBaseline;
  const quote=baseline?.version===1?baseline.quote:finding.finding?.quote??finding.quote;
  if(typeof quote!=="string"||!quote.trim())return null; // Explicit legacy full-line fallback below.
  const occurrences=repairOccurrences(lines,quote,baseline?.footnote);
  const unresolved=[],evidence=[];let withdrawn=0,limited=0;
  for(const item of occurrences){
    if(withdrawnOccurrence(item)){withdrawn++;continue;}
    if(baseline?.kind==="scope"&&scopeMarkers(item.sentence).some(marker=>!baseline.scopeMarkers?.includes(marker))){limited++;continue;}
    const refs=baseline?.version!==1?[]:baseline.footnote
      ? repairReferences(root,spec,"",readable,active.seen,repairedFootnoteLocators(lines,item,baseline,footnotes))
      : baseline.inlineQuote
      ? repairReferences(root,spec,"",readable,active.seen,repairedInlineLocators(lines,item,baseline,spec.phases["final-review"].evidence))
      : repairReferences(root,spec,item.sentence,readable,active.seen);
    const fresh=refs.filter(ref=>{
      const old=(baseline?.refs??[]).filter(value=>keyOf(value.file)===keyOf(ref.file));
      return ref.lineHashes.length>0&&ref.lineHashes.some(hash=>!old.some(value=>value.lineHashes?.includes(hash)));
    });
    if(fresh.length)evidence.push({line:item.line,endLine:item.endLine,refs:fresh});
    else for(let line=item.line;line<=item.endLine;line++)unresolved.push(line);
  }
  return {quote,baseline:baseline?.version===1?"precise-v1":"legacy-quote-no-evidence-snapshot",unresolved:[...new Set(unresolved)],
    resolution:unresolved.length?"unchanged":evidence.length?"new-evidence-for-review":limited?"explicit-scope-for-review":withdrawn?"explicitly-withdrawn":"removed-or-rewritten",evidence};
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
      const body = row ? conclusion(row.body, [rule.source], quantityText) : "";
      // A literal ×100% is a formula multiplier, while 24% in a claim is a result.
      const percentages = quantityScanner(["%"])(body).filter(quantity => quantity.unit)
        .filter(quantity => !(quantity.complete && quantity.value === "100" && /[×*]\s*$/u.test(body.slice(0, quantity.start))));
      const correct = percentages.length > 0 && percentages.every(quantity => quantity.complete && equalNumber(quantity.value, expected));
      const coversRows = cites?.start && cites.start <= Math.min(before.line, after.line)
        && cites.end >= Math.max(before.line, after.line) && cites.end <= lineList(bytes).length;
      const issue = !correct ? "结论中的降幅应为 " + expected + "%"
        : !coversRows ? "出处须引用 " + rule.source + " 中两条原始数据行" : null;
      return {
        id, ok: issue === null, issue, expected: expected + "%", reported: percentages.map(quantity => quantity.value + "%"),
        source: rule.source, sourceHash: digest(bytes), before, after, formula: "(基准-对照)/基准×100",
      };
    } catch (error) { return { id, ok: false, source: rule.source, issue: error.message }; }
  });
}

/** Normalize presentation width without flattening a unit exponent into a digit. */
function quantityText(value) {
  return value.replace(/[^\u00b2\u00b3\u00b9\u2070-\u209f]+/gu, span => span.normalize("NFKC"));
}

const quantityNumber = /(?<![\d\p{Script=Latin}\p{Script=Greek}.])([+-]?\d+(?:\.\d+)?)/gu;
// A glued symbol or an operator with an operand extends the unit. Plain
// punctuation and adjacent prose (for example “24 毫秒后”) remain boundaries.
const gluedUnitSuffix = /^(?:[\p{Script=Latin}\p{Script=Greek}\p{N}\u2070-\u209f%‰°′″]|[+−-]\d)/u;
const compoundUnitSuffix = /^\s*(?:[\/⁄∕^·⋅*×÷]\s*[\p{L}\p{N}°%‰(+−-]|\.(?=[\p{Script=Latin}\p{Script=Greek}]|\d)|每[\p{L}]|平方|立方)/u;
const spacedUnitFactor = /^\s+(?:s|ms|μs|ns|min|h|m|cm|mm|km|g|kg|K|Hz|N|Pa|W|V|A)(?=$|[\s\p{P}\p{S}])/u;

function unitSpelling(value) {
  // SI symbols stay exact (ms and mS differ). English descriptive phrases
  // retain the earlier case-insensitive source match.
  const descriptive = /^[A-Za-z]+(?:\s+[A-Za-z]+)+$/u.test(value);
  return value.split(/\s+/u).map(word => descriptive
    ? word.replace(/[A-Za-z]/g, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`)
    : escape(word)).join("\\s+");
}

function completeUnit(body, start, end) {
  let suffix = body.slice(end);
  // A presentation wrapper can close at the unit boundary. Any operator or
  // glued suffix after the closing marker still belongs to the quantity.
  const wrapper = /(?<![*_`])(\*{1,3}|_{1,3}|`{1,3})$/u.exec(body.slice(Math.max(0, start - 4), start));
  if (wrapper && suffix.startsWith(wrapper[1])) suffix = suffix.slice(wrapper[1].length);
  return !gluedUnitSuffix.test(suffix) && !compoundUnitSuffix.test(suffix) && !spacedUnitFactor.test(suffix);
}

/** Use the configured aliases to locate a quantity, then check its whole unit
 * boundary. Sharing this scanner prevents source, claim, and document scope
 * from accepting different prefixes. Unit symbols preserve their case. */
function quantityScanner(aliases) {
  const spellings = [...new Set(aliases.map(unit => quantityText(unit.trim())))]
    .sort((left, right) => right.length - left.length);
  const unitPattern = new RegExp("^\\s*(?:个\\s*)?(" + spellings.map(unitSpelling).join("|") + ")", "u");
  return body => [...body.matchAll(quantityNumber)].map(match => {
    const after = match.index + match[0].length;
    const unit = unitPattern.exec(body.slice(after));
    const end = after + (unit?.[0].length ?? 0);
    return { value: match[1], start: match.index, end, unit: unit?.[1], complete: !!unit && completeUnit(body, match.index, end) };
  });
}

/** Check direct numerical restatements; conversions require a different declared formula. */
function sourceNumber(bytes, rule, lines, id, evidence) {
  const sourceLines = lineList(bytes);
  const source = quantityText(sourceLines[rule.line - 1] ?? "").replaceAll("−", "-");
  const matches = quantityScanner([rule.sourceUnit])(source).filter(quantity => quantity.unit);
  if (matches.length !== 1 || !matches[0].complete) throw new Error("原文指定行须含唯一的数值与完整单位");
  const expected = matches[0].value;
  const row = claimRow(lines,id);
  const body = row ? conclusion(row.body, [rule.source], quantityText) : "";
  const quantities = quantityScanner(rule.units)(body);
  const values = quantities.map(quantity => quantity.value);
  const cited = row && citation(row.body,rule.source);
  const rowOk = quantities.length > 0 && quantities.every(quantity => quantity.complete && equalNumber(quantity.value, expected))
    && cited?.start <= rule.line && cited?.end >= rule.line && cited.end <= sourceLines.length;
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
  const scan = quantityScanner([...rule.units, rule.sourceUnit]);
  const beforeBound = /(?:[<>≤≥]=?|超过|不足|至少|至多|大于|小于|多于|少于|高于|低于|不满|不超过|不低于|more\s+than|less\s+than|longer\s+than|shorter\s+than|at\s+least|at\s+most|over|under)\s*(?:约|大约)?\s*$/i;
  const afterBound = /^\s*(?:以上|以下|以外|以内|左右以外|或更多|或更少|[<>≤≥]=?)/;
  const compareAfter = /^\s*(?:略|稍|更|还|要|偏|稍微|略微)*\s*(?:长|短|多|少|大|小|高|低)/;
  const issues = [];
  for (const [index,line] of lines.entries()) {
    const body = conclusion(line, evidence, quantityText);
    const quantities = scan(body).filter(quantity => quantity.unit);
    // A direct restatement does not authorize extra operands or derived values in
    // the same line. Locators and URLs are metadata, not arithmetic operands.
    const statement = body.replace(/https?:\/\/[^\s）)\]】>"'“”]+/gi, "");
    const additionalNumbers = quantities.length ? scan(statement)
      .map(quantity => quantity.value).filter(value => !equalNumber(value, expected)) : [];
    if (additionalNumbers.length) issues.push({line:index+1,text:line,reported:additionalNumbers,
      issue:"直接转述同一行包含其他操作数或结果；换算须另行登记原始量、单位与复算规则，不能混入本条直接转述"});
    for (const match of quantities) {
      const before = body.slice(0, match.start).split(/[，,。；;!?！？\n]/).at(-1);
      const after = body.slice(match.end).split(/[，,。；;!?！？\n]/)[0];
      const comparison = beforeBound.test(before) || afterBound.test(after)
        || /比\s*$/.test(before) && compareAfter.test(after);
      // A bare source numeral provides no warrant for an "exact" value. Only
      // positive precision labels adjacent to this quantity are checked here;
      // "the excerpt provides no finer value" has no such quantity-label pair.
      const exactness = /(?:精确值|精确数值|准确值|确切值|exact(?:ly)?|precisely)[^。；;，,!?！？]{0,24}$/i.test(before)
        || /^\s*(?:就是|即为|是|为|为其)\s*(?:精确值|精确数值|准确值|确切值)/.test(after);
      if (!match.complete || !equalNumber(match.value, expected) || comparison || exactness) {
        issues.push({line:index+1,text:line,reported:match.value,issue:!match.complete
          ? "全文直接转述的完整单位须与已登记单位一致，不能将乘除、指数或后缀留在单位之外"
          : exactness
          ? "原文给出数字不等于证明精确值；直接转述不得自行升级精度，改为说明原文给出的数值与未知边界"
          :comparison
          ? "直接转述契约没有授权给原文数值添加上下界或长短比较；删去无据推断，或先登记支持该关系的证据与核验规则"
          : "全文直接转述应为原文的 "+expected+" "+rule.units[0]+"，不能在说明段另添未经支持的数字"});
      }
    }
  }
  return issues;
}

/** Check the final substantive paragraph without confusing a displayed label with
 * a closing explanation. Non-prose deliverables may explicitly opt out in policy.
 */
export function plainLastIssues(spec, lines) {
  if (spec.plainLast === false) return [];
  const visible=value=>value.replace(/[*_~]/gu,"").trim();
  const labelled=/^(?:#{1,6}\s*)?(?:大白话|直白说明)\s*[:：]\s*\S/u;
  const heading=/^(?:#{1,6}\s+)?(?:大白话|直白说明)\s*[:：]?\s*$/u;
  const structure = markdownStructure(lines);
  let last = -1;
  let section = false;
  for (let index = 0; index < lines.length; index++) {
    if (!structure.closingRows[index] || /^(?: {4}|\t)/u.test(lines[index])) continue;
    const line = visible(structure.visible[index]);
    if (!labelled.test(line) && !heading.test(line)) continue;
    last = index;
    section = heading.test(line);
  }
  // An explicit standalone line can follow a list without a blank separator.
  // Its own trailing explanation must still be the final substantive paragraph.
  const tail=last<0?[]:lines.slice(last+(section?1:0));
  const paragraphs=tail.join("\n").trim().split(/\n\s*\n/u).filter(Boolean);
  const body=tail.slice(section?0:1);
  const blockBoundary = /^\s*(?:#{1,6}\s|```|~~~|\||[-*+]\s|\d+[.)]\s|>|\[\^[^\]]+\]:|<(?:!--|\/?[A-Za-z][^>]*>)|(?:---+|___+|\*\*\*+)\s*$)/u;
  const newLabel = /^\s*(?:\[|【)?(?:错例|误读|错误示例|错误推理|附录)(?:\s*(?:第)?(?:\d+|[零〇一二两三四五六七八九十百千]+))?(?:\]|】|\s*[:：])/u;
  const appended = body.some(line => blockBoundary.test(line) || newLabel.test(visible(line)) || errorExample(line));
  const explanationVisible = !section || structure.visible.slice(last + 1).some(line => line.trim());
  if (last >= 0 && paragraphs.length === 1 && explanationVisible && !appended) return [];
  const footnoteClosing = lines.findIndex((line, index) => structure.continuedFootnotes[index]
    && !/^(?: {4}| *\t)/u.test(line) && (labelled.test(visible(line)) || heading.test(visible(line))));
  return ["正文末尾须有代码/HTML/引用块之外的独立行‘大白话：…’或‘直白说明：…’，可直接接在列表后；其解释之后不能再放错例、附录或其他段落。",
    ...(footnoteClosing < 0 ? [] : ["第 " + (footnoteClosing + 1) + " 行仍属于上一脚注定义。请在脚注定义之后插入空行，让末尾说明成为独立正文。"])];
}

/** 补查提交前逐项检查退回、遗漏事实及可复算数字。 */
export function supplementChecks(root, spec, lines, readable, active) {
  const issues = plainLastIssues(spec, lines);
  const repairs=[],legacy=[];
  const footnotes=active.coverageRejections?.some(finding=>finding.repairBaseline?.footnote||finding.repairBaseline?.attribution?.footnote)
    ? footnoteQuoteIndex(lines,spec.phases["final-review"].evidence) : null;
  // New receipts bind the actual rejected substring, not surrounding correct
  // prose. Every retained assertion needs real revision or newly read evidence.
  for (const finding of active.coverageRejections ?? []) {
    const repair=checkRepairSpan(root,spec,lines,readable,active,finding,footnotes);
    if(repair){repairs.push({...repair,channel:"coverage",block:finding.block});
      if(repair.unresolved.length)issues.push("全文退回 "+finding.block+" 的实际片段仍未修订或补入已读新证据，当前第 "+repair.unresolved.join("、")+" 行："+repair.quote
        +"。修改正确前缀或文件其他行不算落实；可删除/实质修订、在该句明确否定或标为错例，或同行引用本轮已读的新证据后重核。"+(repair.baseline.startsWith("legacy")?"旧回执无证据快照，不能据文件变化宣称补证成功。":""));
    }else{
      legacy.push({channel:"coverage",block:finding.block,guarantee:"legacy-whole-line-only"});
      if(typeof finding.lineText==="string"&&lines.some(line=>normalized(line)===normalized(finding.lineText)))issues.push("全文退回 "+finding.block+" 第 "+finding.line+" 行未落实（legacy 整行比较，无精确片段保证）："+finding.repair);
    }
  }
  for (const finding of active.unlisted ?? []) {
    // Older receipts could wrongly classify a blank line as a fact. A blank can
    // never carry an assertion; ignoring that legacy entry prevents an impossible repair.
    if (!finding.text.trim()) continue;
    const repair=checkRepairSpan(root,spec,lines,readable,active,finding);
    if(repair){repairs.push({...repair,channel:"unlisted"});
      if(repair.unresolved.length)issues.push("原验收第 "+finding.line+" 行的未登记事实仍未修订或补入已读新证据（按实际片段匹配，当前第 "+repair.unresolved.join("、")+" 行）："+repair.quote
        +(repair.baseline.startsWith("legacy")?"；旧回执无证据快照，不能据文件变化宣称补证成功。":""));
    }else{
      legacy.push({channel:"unlisted",line:finding.line,guarantee:"legacy-whole-line-only"});
      const current=lines.flatMap((line,index)=>normalized(line)===normalized(finding.text)?[index+1]:[]);
      if(current.length)issues.push("原验收第 "+finding.line+" 行的未登记事实仍未修订或编号溯源（legacy 整行按原文匹配，当前第 "+current.join("、")+" 行；不是按旧行号读取新稿；无精确片段保证）");
    }
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
  return { ok: issues.length === 0, issues, calculations,repairs,legacy };
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
