import { digest, keyOf, readBytes } from "./policy.mjs";
import { decimal, canonicalDecimal, lineList, quantityRelation } from "./preflight.mjs";
import { originalReviewContract, projectPolicyReference } from "./evidence.mjs";
import { SOURCE_ARITHMETIC_TOOL } from "./source-arithmetic.mjs";

export const ORIGINAL_RECHECK_VIEW = "original-evidence/5";
export const ORIGINAL_RECHECK_TOOL = "building_loop_original_recheck";
export const ORIGINAL_RELATIONS = Object.freeze({ supports:"保留", contradicts:"改正", insufficient:"待证" });

const string = {type:"string"};
const ref = {type:"object",properties:{file:string,start:{type:"integer",minimum:1},end:{type:"integer",minimum:1},quote:string},
  required:["file","quote"],anyOf:[{required:["start"]},{required:["end"]}],additionalProperties:false};

export function originalRecheckSchema() {
  return {type:"array",minItems:1,maxItems:1,description:"只提交 prepare 返回的当前一条原句。数字、算式和凭据标识由宿主从已读原文及本角色的运算取得。",
    items:{type:"object",properties:{
      id:string,sourceRelation:{enum:Object.keys(ORIGINAL_RELATIONS)},
      grounds:{enum:["source-statement","calculation","missing-premise","project-rule"],description:"source-statement 用原文明示的支持或反证；calculation 核可计算量；缺少必要信息选 missing-premise + insufficient；项目规则解释才用 project-rule。"},
      evidence:{type:"array",minItems:1,maxItems:12,items:ref},
      quote:{...string,description:"contradicts 必填，逐字定位被反证的短句。待证默认核整条原句；仅其中一项待证时可定位该项的完整分句。"},
      counterQuote:{...string,description:"source-statement + contradicts 必填。已引来源中明确相反的值或陈述；单纯缺少所需输入只说明不足。"},
      limitation:{...string,description:"材料明示限制时可填来自 evidence 的逐字短句。对同一主体已见相关记录时，具体指出该记录还缺哪一条件。"},
      policy:{...ref,description:"project-rule 必填，本角色已读的当前总纲条款。"},
    },required:["id","sourceRelation","grounds","evidence"],additionalProperties:false}};
}

/** A calculator output proves an operation, never a conclusion about its author.
 * Keep only the latest result for this role and current disputed original. */
export function rememberOriginalCalculation(frame,active,spec,result) {
  const dispute=active?.originalDispute, role=frame.role;
  if (!dispute || dispute.view!==ORIGINAL_RECHECK_VIEW || dispute.status!=="checking" ||
      dispute.actors?.[role]!==frame.agent?.id || !["reviewer","auditor"].includes(role)) return;
  const id=dispute.ids.find(id=>!dispute.rechecks[role][id]);
  if (!id || originalReviewContract(frame,active,spec)?.binding!==dispute.binding) return;
  const proofId=digest(JSON.stringify([dispute.binding,id,frame.agent.id,result]));
  const previous=dispute.calculations?.[role];
  const alternatives=previous?.id===id ? [previous,...(previous.alternatives??[])].filter(c=>c.proofId!==proofId).map(({proofId,result})=>({proofId,result})) : [];
  (dispute.calculations??={})[role]={id,proofId,result,...(alternatives.length?{alternatives}:{})};
  frame.changed=true;
  return {proofId};
}

const numbers = value => [...value.matchAll(/[+−-]?\d+(?:[,\u202f\u00a0]\d{3})*(?:\.\d+)?/gu)];
function sameValue(a,b) {
  const x=decimal(canonicalDecimal(a),true), y=decimal(canonicalDecimal(b),true);
  return x.n*y.scale===y.n*x.scale;
}
const present = (text,raw) => numbers(text).some(match=>match[0]===raw);
const short = (text,n) => text.length<=n ? text : [...text].slice(0,n-1).join("")+"…";
const literal = (text,part) => typeof part==="string" && part.trim().length>0 && text.includes(part);

// The mechanical path accepts a single comparison or scalar result, optionally
// preceded by its input expression. Unrecognised prose remains a textual review.
// Words which could assert a separate fact cannot be discarded after a comma.
const check = /(?:复核|核验|验算|核对|复算|交叉检查|cross[- ]check|recomput\w*|recalculat\w*|verif(?:y|ied|ication))/iu;
const quantity = /(?:[=＝]|\b(?:equals|is|are|yields)\b|(?:为|得|是|出|等于))\s*[+-]?\d/iu;
const numeric = /[+−-]?\d+(?:[,\u202f\u00a0]\d{3})*(?:\.\d+)?/u;
const procedure = /(?:编制(?:人|员|办法|方法)|制表(?:员|人)|规(?:定|程)|采用|实际(?:上)?(?:使用|依据|来自|源于|通过)|\b(?:method(?:ology)?|protocol|procedure|policy|used|obtained by|derived from|computed by|calculated by|based on)\b)/iu;
const chronology = /(?:之前|之后|以前|以后|先于|晚于|早于|前(?:者|期|值|数值|周期|观测|状态)|后(?:者|期|值|数值|周期|观测|状态)|\b(?:before|after|prior to|subsequent to)\b)/iu;
const directOrder = /(?:之前|之后|以前|以后|先于|晚于|早于|事前|事后|前期|后期|当时|先.{1,18}(?:再|后)|\b(?:before|after|prior|following|subsequent|earlier|later|initial|final)\b)/iu;
const directProcedure = /(?:规定|规程|规范|采用|使用|来自|通过|得自|\b(?:use[ds]?|procedure|protocol|policy|method|measured by|obtained by|derived from|calculated (?:from|by)|based on)\b)/iu;
const unavailable = /(?:(?:未|没(?:有)?|不)(?:随[^。；;，,\n]{1,32})?(?:记录|记载|提供|说明|披露|收录|附|给出)|(?:缺少|缺乏|不详|未知)|\b(?:unknown|missing|unavailable|not (?:given|recorded|provided|specified|documented))\b)/iu;
const needsConversion = /(?:可(?:以|由|从)?[^。；;]{0,48}(?:换算|推算|算出)|(?:换算|推算)(?:得到|出)|\b(?:derive|work out|calculate).{0,45}from\b)/iu;
const sourceLimit = /(?:不能|无法|不可|不足以|无从|cannot|insufficient to|does not (?:allow|permit))/iu;
const endsWithAmount = /[+−-]?\d+(?:\.\d+)?(?:\s*(?:[%％‰°]|\p{L}{1,12}(?:\/\p{L}{1,8})?))?$/u;
const directUnits = { "％":"%", "米":"m","毫米":"mm","厘米":"cm","千米":"km","克":"g","千克":"kg","公斤":"kg","毫克":"mg", "毫秒":"ms","秒":"s","秒钟":"s",second:"s",seconds:"s","分钟":"min","分":"min",minute:"min",minutes:"min","小时":"h",hour:"h",hours:"h" };
function rawUnit(text,match) {
  const token=/^\s*(分钟|毫秒|小时|秒钟|千克|公斤|毫米|厘米|千米|毫克|[%％‰]|[a-zA-Zμ°]+(?:\/[a-zA-Z]+[²³]?)?|[件盒人次秒分米克])(?=$|[^\p{Script=Latin}])/u.exec(text.slice(match.index+match[0].length))?.[1];
  return token;
}
function followingUnit(text,match) {
  const raw=rawUnit(text,match);return directUnits[raw]??raw;
}
function claimBody(line) {
  return line.replace(/^\s*(?:[-*+]\s+)?(?:\*\*)?C\d+(?:\*\*)?\s*[:：]?\s*/u,"").trim().replace(/[。.!?！？]+$/u,"");
}
function arithmeticClaim(body) {
  if (procedure.test(body) || chronology.test(body) || /[；;。!?！？]|\.(?!\d)|(?:并且|而且|并(?:已|将|由|由此|按|被)|且|同时|随后|然后)|\b(?:therefore|whereas|and then|and also)\b/iu.test(body)) return false;
  const clauses=body.split(/，|,(?!\d)/u).map(x=>x.trim());
  if (clauses.length>2) return false;
  if (clauses.length===2 && !/^(?:按|据|由|用|把|将|从|根据|using\b|by\b|from\b)/iu.test(clauses[0])) return false;
  if (clauses.length===2 && !(numeric.test(clauses[0]) && /[+−-]|减|加|扣|除|乘/u.test(clauses[0])) &&
      !/(?:计算|验算|核对|对照|比较|比较后|比对|difference)$/iu.test(clauses[0])) return false;
  const last=clauses.at(-1);
  // The final result must terminate the proposition. A subsequent assertion
  // such as a sign-off or a chronology cannot ride on the arithmetic receipt.
  const suffix=check.exec(last);
  if (suffix) {
    const rest=last.slice(suffix.index+suffix[0].length).trim();
    return rest==="" || endsWithAmount.test(rest);
  }
  return (clauses.length===2 || /(?:差值|总和|计算|相加|相减|[+−×÷=＝]|\b(?:sum|difference|calculat\w*)\b)/iu.test(last)) && quantity.test(last) && endsWithAmount.test(last);
}

function scopeSubject(text,marker) {
  const idx=text.search(marker);
  return idx<0?"":text.slice(0,idx).replace(/(?:规定|档案|原文|材料|本次|这次|公布的|报告的|编制人|快报的)/gu," ").trim();
}
function sameSubject(a,b) {
  // Bind a reported relationship on ONE source clause. Stable symbol names are
  // stronger than an accidental shared written character (e.g. two meters).
  const ids=s=>s.match(/\b(?:[A-Z]{1,}|[A-Z]+\d+)\b/gu)??[];
  const exact=ids(a);
  if (exact.length) return exact.some(k=>ids(b).includes(k));
  const core=text=>text.split(/[：:，,；;]/u).at(-1).trim().replace(/\s+/gu,"")
    .replace(/(?:计数|数量|数值|数|值|量)$/u,"");
  const subject=core(a),reported=core(b);
  // A shared suffix (e.g. two firms or two counters) cannot bind an owner.
  // Require the full subject at a clause boundary; aliases need an explicit witness.
  return !!subject && !!reported && (reported.startsWith(subject) || subject.startsWith(reported));
}

function requireSourceScope(body,listed) {
  const clauses=listed.flatMap(ref=>ref.quote.split(/[。；;!?\n]/u)).filter(clause=>!unavailable.test(clause));
  const scope=scopeSubject(body,procedure);
  if (procedure.test(body) && !clauses.some(clause=>directProcedure.test(clause) &&
      (!scope || sameSubject(scope,scopeSubject(clause,directProcedure))))) {
    throw Error("所引同一条原文须明确所核主体与采用的方法，不能把另一对象的规程合到本条原稿。缺少相关记录时用 missing-premise。");
  }
  if (chronology.test(body) && !clauses.some(clause=>directOrder.test(clause))) {
    throw Error("原句的事件先后需要相应的来源文字，所给引文未证明时序。");
  }
}

// A broad authorized range is not the quoted text. Resolve the quote within that
// range and require the entire computed token on the covered physical row.
function operandCitations(frame,result,evidence) {
  const cache=new Map();
  return result.operands.map(op=>{
    const ref=evidence.find(ref=>{
      if (keyOf(ref.file)!==keyOf(op.file) || ref.sha256!==op.sha256 || op.line<ref.start || op.line>ref.end) return false;
      const key=keyOf(ref.file);
      if (!cache.has(key)) {
        const raw=readBytes(frame.root,ref.file);
        if (!raw || digest(raw)!==ref.sha256) throw Error("复算引用的来源版本已失效。");
        cache.set(key,lineList(raw));
      }
      const lines=cache.get(key), row=lines[op.line-1], start=ref.start-1, i=op.line-1;
      const excerpt=lines.slice(start,ref.end).join("\n"), from=excerpt.indexOf(ref.quote);
      if (from<0 || from!==excerpt.lastIndexOf(ref.quote)) return false;
      const lineStart=i===start?0:lines.slice(start,i).join("\n").length+1;
      const lo=Math.max(0,from-lineStart), hi=Math.min(row.length,from+ref.quote.length-lineStart);
      if (hi<=lo) return false;
      const raw=op.raw??op.value;
      if (op.raw && /\p{L}/u.test(op.raw)) {
        const at=row.indexOf(raw);
        return at>=lo && at+raw.length<=hi && at===row.lastIndexOf(raw);
      }
      const hits=numbers(row).filter(m=>m[0]===raw);
      // For repeated CSV cells the full row includes the host-verified column.
      return hits.length===1 ? hits[0].index>=lo && hits[0].index+raw.length<=hi : hits.length>1 && lo===0 && hi===row.length;
    });
    if (!ref) throw Error("计算的每个原始操作数均须落在实际引句的物理行和完整数值范围内。");
    return ref;
  });
}

const normClaim = value => value.normalize("NFKC").toLowerCase().replace(/[\s﹕:，,；;。！!?？“”"'「」『』]/gu,"")
  .replace(/\.(?!\d)/gu,"").replace(/[+−-]?\d+(?:\.\d+)?/gu,n=>"⟦"+n+"⟧");
function genuineOpposition(original,counter) {
  // Compare the actual quoted spans. Overlap is meaningful only in context;
  // an old value may legitimately occur inside its negation or correction.
  const a=normClaim(original), b=normClaim(counter);
  if (!a || !b || a===b) return false;
  if (!a.includes(b) && !b.includes(a)) return true;
  const [whole,part]=a.includes(b)?[a,b]:[b,a];
  const at=whole.indexOf(part),before=whole.slice(0,at),after=whole.slice(at+part.length);
  if (/(?:未|不|非|并非|没有|否认|not|never|no)$/iu.test(before) || /^(?:不实|不成立|被否定|isfalse)/iu.test(after)) return true;
  return /(?:更正(?:为)?|后(?:来)?改为|改成|修订为|改报|correctedto|revisedto)\S+/iu.test(after);
}

// Only link an auxiliary computation to a distinct, cited observation in the
// same signed source. A matching number in another entity's report is not a key.
function independentObservation(entry,body,refs,result,unit) {
  if (!unit || result.operands.some(op=>keyOf(op.file)!==keyOf(result.operands[0].file))) return;
  const target=entry.counterQuote??null, outputFile=result.operands.length?keyOf(result.operands[0].file):undefined;
  const ids=s=>s.match(/\b[A-Z][A-Z0-9]*\b/gu)??[];
  const originalIds=ids(body), claims=numbers(body);
  const expected=entry.claimValue ?? result.value;
  const expectedAt=claims.find(m=>sameValue(m[0],expected));
  function quantityLabel(s,index) {
    const prefix=s.slice(0,index).split(/[。；;:：,，]/u).at(-1).split("的").at(-1).trim();
    return prefix.replace(/(?:等于|为|是|=|equals|is)\s*$/iu,"").trim()
      .replace(/(?:结果|数值|计数|数量|值)$/u,"").trim();
  }
  const label=expectedAt && quantityLabel(body,expectedAt.index);
  const namedOwner=(text,index)=>{const words=text.slice(0,index).split(/[。；;:：,，]/u).at(-1).split("的");
    return words.length<2 ? "" : words.at(-2).trim().replace(/(?:得到|给出|公布|登记)$/u,"");};
  const owner=expectedAt && namedOwner(body,expectedAt.index);
  const matches=[];
  for (const ref of refs) {
    if ((outputFile && keyOf(ref.file)!==outputFile) || ref.start!==ref.end || (target && !literal(ref.quote,target))) continue;
    for (const clause of (target??ref.quote).split(/[。；;，,]/u)) {
      for(const m of numbers(clause)) {
        if (!sameValue(m[0],result.value) || followingUnit(clause,m)!==unit) continue;
        if (result.operands.some(op=>op.line===ref.start && sameValue(op.value,result.value))) continue;
        const qualifier=quantityRelation(clause,{start:m.index,end:m.index+m[0].length+(rawUnit(clause,m)?.length??0)});
        if (qualifier!==undefined && qualifier!=="exact") continue;
        const observedLabel=quantityLabel(clause,m.index);
        const otherOwner=namedOwner(clause,m.index);
        if (owner && otherOwner && !sameSubject(owner,otherOwner)) continue;
        if (owner && !otherOwner && !refs.some(r=>keyOf(r.file)===keyOf(ref.file) && r.quote.includes(owner) && label && r.quote.includes(label))) continue;
        const identities=originalIds.length && originalIds.every(id=>ids(ref.quote).includes(id));
        if (originalIds.length && !identities) continue;
        // Compare the named quantity adjacent to the number, not an arbitrary
        // word shared by the two documents. Named operands can qualify a compound
        // original's numeric observation when all their identifiers are explicit.
        if (!(label && label.length>=2 && observedLabel.endsWith(label)) && !(identities && !target && expectedAt)) continue;
        matches.push({file:ref.file,start:ref.start,end:ref.end,quote:clause.trim(),sha256:ref.sha256});
      }
    }
  }
  return matches.length===1 ? matches[0] : undefined;
}

// Compare the identity of a *reported observation* separately from the signed
// arithmetic. A short quotation may hide the record's owner or the name of
// the quantity. Recover those from the containing physical clause at the same
// source hash, never from another candidate row carrying the same number.
const reportBoundary = /(?:首发|年度|季度|本日|本期|本次|正式)?(?:交接单|交接表|公报|快报|汇总|报表|台账|报告|登记表|记录|登记|公布)(?:单|表)?(?:中|上|内|列示|显示|记载|公布|登记|的)?/u;
const recordSymbols = text => text.match(/\b[A-Z][A-Z0-9]*\b/gu) ?? [];
const trimOwner = value => value.trim().replace(/^(?:根据|按照|按|据|由|用)\s*/u,"").replace(/(?:的|本日|本期|本次)$/u,"").trim();
function beforeRecord(text) {
  const at=text.search(reportBoundary);
  return at<0 ? "" : trimOwner(text.slice(0,at));
}
// Structural headings delimit local evidence even when they do not repeat a
// word such as “report”. An unnamed boundary cannot lend the preceding owner.
function sectionHeading(row) {
  const heading=/^\s*(?:#{1,6}\s+(.+?)\s*#*|\[([^\]]+)\]|【([^】]+)】|([^:：]+)[:：])\s*$/u.exec(row);
  if (heading) return (heading[1]??heading[2]??heading[3]??heading[4]).trim();
  if (/^\s*(?:---+|===+|\*\*\*)\s*$/u.test(row)) return "";
  if (/^[\p{L}\p{M}][\p{L}\p{M}\d _-]{0,28}$/u.test(row.trim()) && !reportBoundary.test(row)) return row.trim();
}
function metricName(text) {
  return text.trim().replace(/(?:等于|为|是|=|equals|is)\s*$/iu,"").trim()
    .replace(/(?:的)?(?:数量|件数|盒数|个数|总数|数值|计数|数|值)$/u,"").trim();
}
function reportedKey(prefix) {
  const parts=prefix.trim().split(reportBoundary);
  const phrase=parts.at(-1).trim(), possession=phrase.split("的");
  return {owner:trimOwner(possession.length>1?possession.at(-2):parts.length>1?parts[0]:""),
    metric:metricName(possession.at(-1))};
}
function observationPrefix(frame,ref,result,needle) {
  const bytes=readBytes(frame.root,ref.file);
  if (!bytes || digest(bytes)!==ref.sha256) return;
  const lines=lineList(bytes),slice=lines.slice(ref.start-1,ref.end).join("\n");
  const at=slice.indexOf(needle);
  if (at<0 || at!==slice.lastIndexOf(needle)) return;
  const values=numbers(needle).filter(m=>sameValue(m[0],result.value));
  if (values.length!==1) return;
  const within=slice.slice(0,at+values[0].index).split("\n");
  const line=ref.start+within.length-1;
  const clause=within.at(-1).split(/[。；;]/u).at(-1).trim();
  const segments=clause.split(/[，,:：]/u);
  const lead=segments.length>1 ? segments.at(-2).trim() : "";
  return {lines,line,prefix:segments.at(-1),lead};
}
function checkReportedIdentity(frame,active,body,ref,result,entry,target,operandRefs,unit) {
  const found=observationPrefix(frame,ref,result,entry.counterQuote??ref.quote);
  if (!found) throw Error("独立登记的值无法唯一定位到已引原文行，请给出该条登记的具体引句。");
  const clauses=body.split(/[，,；;]/u),claimed=target!==undefined&&numbers(body).find(m=>sameValue(m[0],target));
  const subjectOfCheck=body.match(/^(.+?)(?:可用|可由|可供)/u)?.[1]??"";
  const prefix=claimed?body.slice(0,claimed.index).split(/[，,；;]/u).at(-1):subjectOfCheck;
  const expected=reportedKey(prefix), recorded=reportedKey(found.prefix);
  const named=beforeRecord(clauses[0])||body.match(/(?:与|同)([^，,。；;与同]{1,25}?)(?:初报|原报|快报|台账)(?:对照|比较)/u)?.[1];
  const ids=recordSymbols(body);
  // Plain arithmetic checking may mention an instrument but not a metric.
  // Bind its identity independently of the number. A declared metric, when
  // present, must be the same even for an explicitly matched instrument.
  const desiredOwner=named||expected.owner;
  let want=expected.metric,actual=recorded.metric,other=recorded.owner||beforeRecord(found.lead)||found.lead;
  if (!claimed && /(?:两条|多个|两个)(?:读数|数值|记录)$/u.test(subjectOfCheck)) want="";
  let scopeFrom=found.line;
  if (desiredOwner && want.startsWith(desiredOwner)) want=want.slice(desiredOwner.length).trim();
  if (desiredOwner && actual.startsWith(desiredOwner)) {
    other ||= desiredOwner;
    actual=actual.slice(desiredOwner.length).trim();
  }
  if (!other && desiredOwner && want && actual!==want && actual.endsWith(want)) {
    other ||= trimOwner(actual.slice(0,-want.length));
    actual=want;
  }
  const sameOwner=(a,b)=>a===b || (/^[A-Z][A-Z0-9]*$/u.test(a) && recordSymbols(b).includes(a));
  if (desiredOwner) {
    // Omitted owners can inherit a signed and actually read local heading.
    // Never cross an unread boundary or an independently acquired excerpt.
    if (!other && !ref.origin?.observation) {
      const seen=active?.seen?.[keyOf(ref.file)];
      for (let i=found.line-1;i>=1;i--) {
        if (seen?.hash!==ref.sha256 || !seen.ranges.some(([lo,hi])=>lo<=i&&i<=hi)) break;
        const row=found.lines[i-1];
        if (!row.trim()) break;
        const heading=sectionHeading(row);
        if (heading!==undefined) { other=heading;scopeFrom=i;break; }
        const names=row.split(/[。；;，,]/u).map(beforeRecord).filter(Boolean);
        if (names.length) { other=names.at(-1);scopeFrom=i;break; }
      }
    }
    if (!other || !sameOwner(desiredOwner,other)) throw Error("独立登记的主体与原稿不同或缺少可定位的所属上下文，请核对来源主体。");
  }
  if (ids.length && !ids.every(id=>recordSymbols(found.prefix+" "+other).includes(id))) {
    throw Error("所选独立登记没有对应原稿的编号主体，请核对该登记行。");
  }
  if (want && normClaim(want)!==normClaim(actual)) {
    // A ledger can name its own subtotal differently. This permits a literal
    // cross-check of its published number, never a claim that the two metric
    // names are equivalent. The calculation remains the sole counterproof.
    // Accept only a single local summary immediately following a bound pair of
    // before/after readings in its stated scope. Neither an unrelated metric
    // on another row nor the first of multiple matching summaries qualifies.
    const ops=result.operands, seen=active?.seen?.[keyOf(ref.file)];
    const lifecycle=operandRefs.map(r=>r.quote.match(/^([^，。；;\d]{1,20}?)(前|后)/u));
    const sequence=ops.length===2 && ops[1].line===ops[0].line+1 && found.line===ops[1].line+1
      && lifecycle.every(Boolean) && lifecycle[0][1]===lifecycle[1][1] && lifecycle[0][2]==="前" && lifecycle[1][2]==="后";
    const stem=lifecycle[0]?.[1]??"";
    const anchored=stem.length>=2 && want.startsWith(stem[0]) && actual.startsWith(stem[0]);
    const summary=reportBoundary.test(found.prefix) && !recorded.owner && desiredOwner && other===desiredOwner;
    if (entry.counterQuote && sequence && anchored && summary && !ref.origin?.observation && seen?.hash===ref.sha256) {
      let matches=0;
      for(let i=scopeFrom; i<=found.lines.length; i++) {
        const row=found.lines[i-1];
        if (!seen.ranges.some(([lo,hi])=>lo<=i&&i<=hi)) { matches=Infinity;break; }
        if (i>found.line && (!row.trim() || sectionHeading(row)!==undefined)) break;
        if (i<found.line && ops.some(op=>op.line===i)) continue;
        const owner=beforeRecord(row);
        if (i>found.line && owner && owner!==desiredOwner) break;
        if (numbers(row).some(m=>sameValue(m[0],result.value)&&followingUnit(row,m)===unit)) matches++;
      }
      if (matches===1) return "numeric-cross-check";
    }
    throw Error("所选独立登记的指标与原稿目标不是同一已识别量，或没有唯一、同主体的汇总可作数值对照。请引用该指标的原文或明确其对应关系。");
  }
  return "same-record";
}

function missingReason(line,quote,entry,evidence) {
  const body=claimBody(line),target=entry.missing??claimBody(quote);
  if (!literal(line,target)) throw Error("缺少证明的对象或关系须逐字取自本条原稿。");
  const clauses=body.split(/[，。；;!?！？]|,(?!\d)|\.(?!\d)/u).map(part=>part.trim()).filter(Boolean);
  const wholeClaim=normClaim(body),selected=normClaim(claimBody(quote));
  if (selected!==wholeClaim && !clauses.some(clause=>normClaim(clause)===selected))
    throw Error("待证的 quote 须定位完整分句。只核一条原句时可省略 quote。");
  if (entry.missing!==undefined && selected!==wholeClaim && !literal(quote,target))
    throw Error("旧 missing 与所选原稿分句不一致；只核当前分句时请删除 missing。");
  const pieces=evidence.flatMap(ref=>ref.quote.split(/[；;。!?\n]/u).map(text=>text.trim()).filter(Boolean));
  const chosen=entry.limitation;
  // Errors return neutral, role-read source excerpts, never the other decision.
  const context=" 原稿「"+short(body,120)+"」。本次已引："+evidence.slice(0,3).map(r=>r.file+"#"+r.start+"「"+short(r.quote,72)+"」").join("、");
  if (chosen!==undefined && !evidence.some(ref=>literal(ref.quote,chosen))) throw Error("limitation 须是本次已引原文中真实的资料边界。"+context);
  const sourceLimits=pieces.filter(piece=>unavailable.test(piece));
  // Old clients could name only the output of a derivation as 'missing'.
  // An explicitly undocumented input is a valid gap. The output noun alone
  // supplies no judgment on whether the operation can establish that output.
  const governing=clauses.find(clause=>literal(clause,target));
  if (entry.missing!==undefined && governing && needsConversion.test(governing) && !needsConversion.test(target) &&
      !sourceLimits.some(limit=>limit.split(/[，,]/u).some(part=>literal(part,target) && unavailable.test(part))))
    throw Error("旧 missing 只截出了换算原句的一部分，没有指明待证关系。请核完整推导分句；原句已绑定，可删除 missing。"+context);
  const subject=scopeSubject(body,procedure);
  // A document may state another actor's policy is missing alongside the actual
  // subject's published procedure; this cannot establish a gap for both actors.
  const hasSameSubjectRecord=!!subject && pieces.some(piece=>directProcedure.test(piece) &&
    !unavailable.test(piece) && sameSubject(subject,scopeSubject(piece,directProcedure)));
  const limits=sourceLimits.filter(piece=>!hasSameSubjectRecord || sameSubject(subject,piece));
  if (chosen && hasSameSubjectRecord && (!sameSubject(subject,chosen) || !(unavailable.test(chosen) || /(?:仅|限于|截至|除外|\b(?:only|limited to|except|until)\b)/iu.test(chosen)))) throw Error("所选择的范围说明未绑定该原句的主体。"+context);
  if ((!chosen && !limits.length) && (normClaim(target)===normClaim(body) && hasSameSubjectRecord ||
      pieces.some(piece=>normClaim(piece).includes(normClaim(target))))) {
    throw Error("请对照当前原句与已引原文，独立判断是否仍缺特定关系；如有，指出该关系与资料边界。已有该项陈述。"+context);
  }
  const limit=chosen??limits[0];
  if (limit && literal(line,limit) && !unavailable.test(limit)) throw Error("原稿本身不能作为资料覆盖边界。");
  // Keep observed text, absence in this material and the reviewer's unresolved
  // claim visibly separate; missing data never becomes a negative observation.
  const known=pieces.filter(piece=>!sourceLimits.includes(piece) && piece!==chosen);
  const established=short((known.length?known:evidence.map(ref=>ref.quote)).map(piece=>"「"+piece+"」").join("、"),390);
  const focused=selected!==wholeClaim ? claimBody(quote) : clauses.find(clause=>normClaim(clause)===normClaim(target) && normClaim(clause)!==wholeClaim);
  if (focused && known.some(piece=>normClaim(piece)===normClaim(focused)))
    throw Error("选中的待证分句已由所引原文直接陈述；请核实真正缺证的分句及其边界。"+context);
  const gap=(limit?"资料边界为「"+short(limit,160)+"」。":"上述摘录未给出该项所需的完整依据。")+
    (focused?"原稿「"+short(body,240)+"」中的「"+short(focused,180)+"」在本次引证下仍待证。":"原稿整体「"+short(body,240)+"」在本次引证下仍待证。");
  return {gap,basis:"本次所引记录载有"+established+"。"+gap,limitation:limit,focused};
}

// Only compare a selected scalar statement against an independently bound
// observation. A signed calculation of an equal number in another measure is
// insufficient. This check reports conflicting scope and never issues a vote.
function overlapsObservedMeasure(clause,calculation,inputs) {
  if (!clause || !calculation?.observed || !quantity.test(clause) || !endsWithAmount.test(clause) ||
      procedure.test(clause) || chronology.test(clause) || needsConversion.test(clause)) return false;
  const measure=text=>{
    const ms=numbers(text).filter(m=>sameValue(m[0],calculation.result.value));
    if (ms.length!==1) return;
    const [m]=ms,unit=followingUnit(text,m);
    if (!unit) return;
    const u=rawUnit(text,m),end=m.index+m[0].length+text.slice(m.index+m[0].length).indexOf(u)+u.length;
    const relation=quantityRelation(text,{start:m.index,end});
    if (relation && relation!=="exact") return;
    const label=text.slice(0,m.index).normalize("NFKC").toLowerCase().replace(/(?:为|是|等于|=|\b(?:is|equals))\s*$/iu,"")
      .replace(/的|\s+/gu,"").replace(/(?:额|值)$/u,"");
    return {unit,label};
  };
  const a=measure(clause),b=measure(calculation.observed.quote);
  if (!a || !b || a.unit!==b.unit) return false;
  if (b.label===a.label) return true;
  // In a compound statement "the two readings" may refer to the preceding
  // subjects. Resolve only a typed difference of a measurement named in both
  // original operand lines and in the published observation. Never guess a
  // different named entity or metric from a coincident value and unit.
  if (calculation.result.operation!=="difference" || !/^(?:两者|二者|这?两[个项组次台]|both\b|their\b|the two\b)/iu.test(clause)) return false;
  const difference=label=>label.match(/(.+?)(?:差|difference)$/iu)?.[1];
  const left=difference(a.label),right=difference(b.label);
  if (!left || !right) return false;
  let length=0;
  while (length<Math.min(left.length,right.length) && left.at(-1-length)===right.at(-1-length)) length++;
  const metric=left.slice(left.length-length);
  return metric.length>=2 && inputs?.length>=2 && inputs.every(ref=>normClaim(ref.quote).includes(metric));
}

// The reviewers choose the disputed proposition and its evidence. The host owns
// identifiers and values derived from them. An old explicit copy is checked.
function boundCalculation(frame,entry,dispute,evidence) {
  const saved=dispute.calculations?.[frame.role];
  if (!saved || saved.id!==entry.id) throw Error("尚无本角色当前原句的计算凭据。先调用 "+SOURCE_ARITHMETIC_TOOL+"（action=evaluate），按原文选择 operation 和 operands，再提交本条回执。");
  const candidates=[saved,...(saved.alternatives??[])];
  if (entry.calculation!==undefined) {
    const chosen=candidates.find(c=>c.proofId===entry.calculation);
    if (!chosen) throw Error("旧 calculation / proofId 不属于这条原稿及本角色；删除 calculation 并由宿主匹配。");
    return chosen;
  }
  if (candidates.length===1) return saved;
  const fitting=candidates.filter(c=>{
    try { operandCitations(frame,c.result,evidence); return true; }
    catch (error) { if (!String(error.message).includes("计算的每个原始操作数")) throw error;return false; }
  });
  if (fitting.length!==1) throw Error("本角色当前原句存在多个复算。请只引此断言所用的原始操作数，无法唯一绑定时保留待核。");
  return fitting[0];
}
const legacyValueError=()=>Error("旧 claimValue 与争议原句或独立登记值不符。删除 claimValue；数量反证请只在 quote 定位唯一目标数，宿主取数。");
function counterTarget(quote,copied) {
  const matches=numbers(claimBody(quote));
  if(matches.length!==1) throw Error("原稿 quote 含多个目标数或无目标数；请定位有且仅有一个数量的争议短句。");
  if(copied!==undefined && (typeof copied!=="string" || copied!==matches[0][0])) throw legacyValueError();
  return matches[0][0];
}

function calculationBasis(frame,entry,role,dispute,evidence,line,quote,auxiliary=false,authorCitations=evidence,active) {
  const proof=boundCalculation(frame,entry,dispute,evidence);
  const {result}=proof;
  const rawValues=result.operands.map(x=>x.raw??x.value);
  const citedOperands=operandCitations(frame,result,evidence);
  const body=claimBody(line);
  if (!auxiliary && (!arithmeticClaim(body) || entry.sourceRelation==="insufficient")) {
    throw Error("计算凭据仅可判定原稿的单一数量验算。含行为归因、时序或其他独立事实时，给出能证明整句的原文或记录尚缺前提。");
  }
  let compare=entry.sourceRelation==="contradicts" ? counterTarget(quote,entry.claimValue) : entry.claimValue;
  if (compare!==undefined && !(typeof compare==="string" && numbers(compare).length===1 && numbers(compare)[0][0]===compare)) throw legacyValueError();
  // The source calculator deliberately leaves unfamiliar count units as "原单位".
  // Recover only an unambiguous matching unit from the signed operand lines.
  const units=result.operands.map((op,i)=>{
    if (result.unit!=="原单位") return result.unit;
    const ref=citedOperands[i];
    const m=numbers(ref.quote).find(m=>m[0]===rawValues[i]);return m && followingUnit(ref.quote,m);
  });
  if (units.some(u=>u!==units[0])) throw Error("原数值的单位不能在当前引文中对齐。");
  const unit=units[0];
  const observed=auxiliary ? independentObservation({...entry,claimValue:compare},body,authorCitations,result,unit) : undefined;
  if (auxiliary && !observed) throw Error("辅助复算须与本角色所引、同一资料的独立观测值逐项对应。相同数字不能替代对象、单位或实际相反记录。");
  const comparisonText=auxiliary ? body : quote;
  const targetMatches=numbers(comparisonText).filter(m=>compare!==undefined ? m[0]===compare : sameValue(m[0],result.value));
  if (targetMatches.some(m=>{const suffix=comparisonText.slice(m.index+m[0].length); const u=rawUnit(comparisonText,m);
    const relation=quantityRelation(comparisonText,{start:m.index,end:m.index+m[0].length+(u?suffix.indexOf(u)+u.length:0)});
    return relation!==undefined && relation!=="exact";})) throw Error("原稿数量包含限定、区间或额外条件，不能用裸值作为等式证据。");
  if (unit && targetMatches.some(m=>followingUnit(comparisonText,m) && followingUnit(comparisonText,m)!==unit)) throw Error("原稿目标值与计算量纲不一致，不能仅凭数值作证。");
  const originalValues=numbers(body).map(m=>m[0]);
  const reportOnly=compare!==undefined && entry.sourceRelation==="supports" && !originalValues.length;
  if (compare!==undefined && !reportOnly && !present(quote,compare)) throw legacyValueError();
  if (entry.sourceRelation==="contradicts" && (compare===undefined || sameValue(compare,result.value))) {
    throw Error("数量反证须指出原稿中与本次复算不相等的实际值。");
  }
  if (entry.sourceRelation==="supports" && compare!==undefined && !sameValue(compare,result.value)) throw legacyValueError();
  const outputRows=evidence.filter(ref=>{
    if(result.operands.some(op=>keyOf(op.file)!==keyOf(ref.file))) return false;
    if (entry.counterQuote && !literal(ref.quote,entry.counterQuote)) return false;
    const recorded=entry.counterQuote??ref.quote;
    return numbers(recorded).some(m=>{
      if (!sameValue(m[0],result.value) || result.operands.some(op=>op.line>=ref.start && op.line<=ref.end &&
        (op.raw??op.value)===m[0])) return false;
      const observedUnit=followingUnit(recorded,m);
      if (unit && ((!observedUnit && (reportOnly||entry.counterQuote)) || (observedUnit && observedUnit!==unit))) return false;
      const u=rawUnit(recorded,m),tail=recorded.slice(m.index+m[0].length);
      const relation=quantityRelation(recorded,{start:m.index,end:m.index+m[0].length+(u?tail.indexOf(u)+u.length:0)});
      return relation===undefined || relation==="exact";
    });
  });
  const observedOutput=outputRows.length>0;
  if (reportOnly && (outputRows.length!==1 || !sameValue(compare,result.value))) throw legacyValueError();
  if (entry.counterQuote && (!observedOutput || outputRows.length!==1)) throw Error("counterQuote 未唯一对应本次所引独立登记的相反值及单位；请修正引文。");
  if (entry.sourceRelation==="supports" && !originalValues.length && outputRows.length!==1) throw Error("原稿没有给出对照数。请引用唯一对应的独立登记值，不能按重复数字选取。");
  if (entry.sourceRelation==="supports" && !observedOutput && compare===undefined &&
      !originalValues.some(v=>sameValue(v,result.value))) throw Error("给出可核对的原稿数量或独立登记的对照结果原文。");
  // An unrelated input (e.g. a container count) is not a checked operand merely
  // because an independently computed value occurs elsewhere in the same file.
  const ids=text=>text.match(/\b(?:[A-Z]{1,}|[A-Z]+\d+)\b/gu)??[];
  if (ids(body).some(id=>!evidence.some(ref=>ids(ref.quote).includes(id)))) throw Error("原稿所指的编号对象没有进入计算凭据的证据范围。");
  if (entry.sourceRelation==="supports" && originalValues.length &&
      originalValues.some(v=>!sameValue(v,result.value) && !rawValues.some(s=>present(s,v)))) {
    throw Error("原句另有未由本算式绑定的数量，须独立核该项所需输入。");
  }
  const expression=result.formula.replace(/\b[a-d]\b/gu,letter=>"("+rawValues[letter.charCodeAt(0)-97]+")");
  const observedKind=!auxiliary && outputRows.length===1 && (reportOnly || entry.counterQuote || !originalValues.length)
    ? checkReportedIdentity(frame,active,body,outputRows[0],result,entry,compare,citedOperands,unit) : undefined;
  const sourceRecord=observed??(reportOnly||entry.counterQuote ? outputRows[0] : null);
  return {proofId:proof.proofId,result,...(sourceRecord?{observed:sourceRecord,...(observedKind==="numeric-cross-check"?{comparison:observedKind}:{})}:{}),basis:(auxiliary?"辅助数值核对（仅限这项数量）：":"按已签名的原始数值复算，")+expression+" = "+result.value+" "+(unit??result.unit)+
    (sourceRecord?(observedKind==="numeric-cross-check"?"；同段汇总另记「"+short(sourceRecord.quote,120)+"」，仅交叉核对数值，本项反证依据为上述算式":"；独立登记原文「"+short(sourceRecord.quote,120)+"」"):"")+
    (reportOnly?"；此值来自所引登记记录。":compare===undefined?"。":"；原稿所称值为 "+compare+"。")};
}

/** Keep manuscript quotations, review decisions and source statements distinct
 * in downstream editorial proofs. Free-form text cannot silently become a new
 * claim about the source just because the attached citations are genuine. */
export function groundedOriginalReceipt(frame,active,dispute,entry,evidence,line,quote) {
  const {grounds,sourceRelation}=entry;
  if (!["source-statement","calculation","missing-premise","project-rule"].includes(grounds)) throw Error("用当前专用工具提交 grounds，区分原文、复算、缺少前提或项目规则。");
  if (entry.basis!==undefined || entry.gap!==undefined) throw Error("争议依据由已签名原文和计算凭据生成；自由填写的 basis/gap 不能签收。");
  const scope=grounds==="project-rule"?"project-rule":"evidence";
  if (entry.disputeScope!==undefined && entry.disputeScope!==scope) throw Error("disputeScope 与实际依据不符。");
  const conflictingFields=(entry.counterQuote!==undefined && !(["source-statement","calculation"].includes(grounds)&&sourceRelation==="contradicts")) ||
    ((entry.missing!==undefined || entry.limitation!==undefined) && grounds!=="missing-premise") || (entry.policy!==undefined && grounds!=="project-rule") ||
    (entry.claimValue!==undefined && !(grounds==="calculation" || grounds==="source-statement" && sourceRelation==="contradicts")) || (entry.calculation!==undefined && grounds==="project-rule");
  if (conflictingFields) throw Error("提交字段与本条 grounds 或 sourceRelation 冲突。");
  let basis,gap,calculation,policy,limitation,calculationEvidence,focused;
  if (grounds==="calculation") {
    calculation=calculationBasis(frame,entry,frame.role,dispute,evidence,line,quote,false,evidence,active);
    basis=calculation.basis;
  } else if (grounds==="missing-premise") {
    if (sourceRelation!=="insufficient") throw Error("缺少必要输入只能判证据不足，不能算作相反的实测结果。");
    ({basis,gap,limitation,focused}=missingReason(line,quote,entry,evidence));
  } else if (grounds==="project-rule") {
    const ref=entry.policy;
    if (sourceRelation!=="insufficient") {
      if (arithmeticClaim(claimBody(line))) throw Error("总纲条款不能以项目规则替代外部数值的复算证据。");
      requireSourceScope(claimBody(line),evidence);
    }
    policy=projectPolicyReference(frame,active,{...ref,start:ref?.start??ref?.end,end:ref?.end??ref?.start});
    basis="按当前总纲「"+short(policy.quote,165)+"」登记本角色对原句的项目判断。";
    gap="适用条款位于 "+policy.file+" 第 "+policy.start+" 行，所涉原稿为「"+short(quote,140)+"」。";
  } else {
    if (sourceRelation==="insufficient") throw Error("正缺少证明的原句用 missing-premise。");
    const body=claimBody(line);
    const recordProvesLimit=sourceRelation==="contradicts" && typeof entry.counterQuote==="string" && sourceLimit.test(entry.counterQuote);
    if ((arithmeticClaim(body) || needsConversion.test(body)) && !recordProvesLimit && !evidence.some(ref=>literal(ref.quote,body))) throw Error("原句主张可复算；请用 calculation 对数量验算，缺少输入用 missing-premise；直接反驳能否换算时引用明确的相反原文。");
    if (check.test(body) && !arithmeticClaim(body) && !evidence.some(ref=>literal(ref.quote,body))) {
      const tail=body.split(/[,，;；]|并且|而且|且|随后|然后|and then/iu).map(p=>p.trim()).filter(Boolean);
      if (tail.some(clause=>!check.test(clause) && !evidence.some(ref=>literal(ref.quote,clause)))) throw Error("复合原句中的额外陈述须有独立的原文见证，不能用算式或另一个主体的记录作证。");
    }
    requireSourceScope(body,sourceRelation==="contradicts" && entry.counterQuote ? evidence.filter(ref=>literal(ref.quote,entry.counterQuote)) : evidence);
    if (sourceRelation==="contradicts") {
      if (!evidence.some(ref=>literal(ref.quote,entry.counterQuote)) || unavailable.test(entry.counterQuote) ||
          !genuineOpposition(quote,entry.counterQuote)) throw Error("counterQuote 须逐字定位原文给出的直接相反记录；缺输入或缺少记载用 missing-premise。");
      basis="原稿争议短句「"+short(quote,140)+"」，本角色所引相反记录为「"+short(entry.counterQuote,180)+"」。";
    } else {
      basis="本角色判断所引原文支持原句。证据摘录："+short(evidence.map(ref=>"「"+ref.quote+"」").join("、"),300);
    }
  }
  // A signed result kept by the host is separate from what the reviewer
  // submitted. Do not manufacture a cited report value or evidence for a method.
  if (grounds==="source-statement" && entry.claimValue!==undefined && entry.calculation===undefined) {
    const target=counterTarget(quote,entry.claimValue),body=claimBody(line),m=numbers(body).find(x=>x[0]===target),unit=m && followingUnit(body,m);
    const alternatives=numbers(entry.counterQuote).filter(other=>!sameValue(other[0],target) && unit && followingUnit(entry.counterQuote,other)===unit);
    const linked=alternatives.filter(n=>independentObservation(entry,body,evidence,{value:n[0],operands:[]},unit));
    if (linked.length!==1) throw Error("旧 claimValue 未与直接相反的原文数量唯一对应；删除 claimValue 或核对争议目标数、主体及单位。");
  }
  if (grounds==="source-statement" && entry.calculation!==undefined) {
    if (sourceRelation!=="contradicts") throw Error("辅助计算用于实际数量反证，须有原稿目标数及直接相反记录。");
    calculation=calculationBasis(frame,entry,frame.role,dispute,evidence,line,quote,true);
  }
  if (grounds==="missing-premise") {
    const saved=dispute.calculations?.[frame.role];
    if (entry.calculation!==undefined && (!saved || saved.id!==entry.id || saved.proofId!==entry.calculation)) {
      throw Error("辅助复算须属于本角色当前原稿。");
    }
    if (saved?.id===entry.id) {
      const result=saved.result,body=claimBody(line);
      const explicit=entry.calculation!==undefined;
      if (explicit || (!saved.alternatives?.length && numbers(body).some(m=>sameValue(m[0],result.value)))) {
        const inputs=result.operands.map(op=>{
          const raw=readBytes(frame.root,op.file);
          if (!raw || digest(raw)!==op.sha256) throw Error("已签名的计算来源已更新。");
          return {file:op.file,start:op.line,end:op.line,sha256:op.sha256,quote:lineList(raw)[op.line-1]};
        });
        const supplemental={...entry,calculation:saved.proofId};
        const first=numbers(inputs[0].quote).find(m=>m[0]===(result.operands[0].raw??result.operands[0].value));
        const measuredUnit=result.unit==="原单位" ? first && followingUnit(inputs[0].quote,first) : result.unit;
        if (explicit || independentObservation(supplemental,body,evidence,result,measuredUnit)) {
          calculation=calculationBasis(frame,supplemental,frame.role,dispute,inputs,line,quote,true,evidence);
          calculationEvidence=inputs;
        }
      }
    }
  }
  if (focused && calculation && quantity.test(focused) && endsWithAmount.test(focused)) {
    if (overlapsObservedMeasure(focused,calculation,calculationEvidence))
      throw Error("选作待证的数量分句与本角色已复算且独立登记的量重合。请核对是否选错分句；若是另一个量，请引用区分两者的原文。");
    // A calculation bound to the whole original need not belong to a narrower
    // numerical claim. Keep the independent signed calculation in its own log.
    if (entry.calculation!==undefined) throw Error("指定的辅助复算没有绑定选中的数量分句；请核对其对象或删除 calculation。");
    calculation=undefined;
    calculationEvidence=undefined;
  }
  if (calculation && grounds!=="calculation") basis+=" "+calculation.basis;
  return {grounds,sourceRelation,scope,basis,gap:gap??("本次判断限于原稿「"+short(quote,160)+"」及所引行。"),
    ...(calculation?{calculation:{proofId:calculation.proofId,...calculation.result,...(calculation.observed?(calculation.comparison==="numeric-cross-check"?{numericCrossCheck:calculation.observed}:{observation:calculation.observed}):{})}}:{}),
    ...(calculationEvidence?{calculationEvidence}:{}),...(limitation?{limitation}:{}),...(policy?{policy}:{}),
    ...(entry.counterQuote?{counterQuote:entry.counterQuote}:{}),...(entry.missing?{missing:entry.missing}:{})};
}
