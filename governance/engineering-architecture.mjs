import { goalSnapshot } from "./goals.mjs";
import { inspectArchitectureImports } from "./code-review.mjs";
import { architectureResponsibilitiesCurrent, responsibilityClause } from "./architecture-responsibilities.mjs";
import { architectureBrokenFactLinks, architectureHeadingSpans, architectureLineOffsets, architectureLinkReplacementOnly,
  linkedResponsibilityConflicts } from "./architecture-prose-coverage.mjs";
import { prepareRollbackRehearsal, rollbackRehearsalCurrent, rollbackScopeBody } from "./architecture-rollback.mjs";
import { requireCodeRegressionCurrent } from "./code-intake.mjs";
import { inputContractCases } from "./input-contracts.mjs";
import { digest, includes, keyOf, readBytes, replaceWithHistory, text } from "./policy.mjs";
import { architectureDocument, architectureProseLines, generatedArchitectureSection } from "./project-hierarchy.mjs";
import { pythonImportEvidence } from "./python-dependencies.mjs";

const declaration = /^(?:[-+*]\s+|\d+[.)]\s+)?(?:\*\*)?\x60?([^\s`:：()（）]+\.py)\x60?(?:\*\*)?(?:\s*[（(](?:\[[^\]\r\n]{1,80}\]\([^()\s]{1,128}\)|[^）)\r\n]){1,80}[）)])?\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?/iu;
const moduleItem = /^(?:\*\*)?\x60?([^\s\x60:：()（）]+\.py)\x60?(?:\*\*)?(?:\s*[（(][^）)]{1,80}[）)])?(?:\*\*)?\s*$/iu;
const sentence = /[。！？!?；;]|\.(?=\s|$)/u;
const notCurrent = /(?:不|未|无|禁止|避免|只能|否则|如果|若|计划|拟|将|应|需要|建议|可选|可能|目标|改为|待|示例|例如|比如|回退|反例|误写|旧版|原先|历史|通过|经由|间接|委托|(?:\b(?:does not|never|should|may|could|would|will|planned|previously|formerly|indirectly|via|if|example|incorrect)\b))/iu;
const relation = /(?:直接\s*)?(调用|导入|\bcalls?\b|\bimports?\b)\s*/giu;
const importDirection = /^\s*(?:导入方向(?:固定(?:为)?)?|(?:静态|直接)导入关系|(?:static |direct )?import (?:direction|chain))\s*[:：]\s*/iu;
const importModule = /^(?:\x60([\p{ID_Start}_][\p{ID_Continue}./-]*)\x60|([\p{ID_Start}_][\p{ID_Continue}.-]*))$/u;
const name = /^(\x60)?([\p{ID_Start}_][\p{ID_Continue}./-]*)(?:\x60|(?=[\s、，,和及与。！？；;:(（]|$))/u;
const list = /^(?:\s*(?:、|，|,|和|及|与|\band\b)\s*)/iu;
const ownership = /^(?:(?:当前|实际|负责|直接)\s*)*(?:校验|验证|检查|判验|(?:(?:directly|currently)\s+)?(?:validates?|checks?))\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60(.*)$/iu;
const implementation = /^(?:(?:当前|实际|负责|直接)\s*)*(?:定义|实现|(?:directly\s+)?(?:defines?|implements?))\s*\x60([\p{ID_Start}_][\p{ID_Continue}_]*)\s*(?:\(\))?\x60/u;
const delegated = /(?:通过|经由|间接|委托|delegat\w*|indirectly|\bvia\b)/iu;
const ownershipNotCurrent = /(?:计划|拟由|拟将|将来|后续|未来|改为|待改|迁移至|移交给|以前|此前|旧版|历史上|示例|反例|误写|尚未|不再|并不(?:负责|实际|直接)|\b(?:formerly|previously|planned|instead|future|would|will|should|example|no longer|used to)\b)/iu;
const inlineLabel = /\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60/gu;
const groupGuard = /(?:校验|验证|检查|\bvalidates?\b|\bchecks?\b)\s*(?:[（(]\s*([^（()）]{1,160})[）)]|([^；;。!?！？（()）]{1,160}))/giu;
const guardField = /^(?:\x60([a-z_][a-z0-9_-]*)\x60|([a-z_][a-z0-9_-]*))(?:\s*(?:各自)?(?:字段|结构|类型(?:面|检查)?)(?:(?:并|且|及|与).+)?)?$/iu;
const explicitGuardDelegate = /由[^。！？,，、；;:\x60]{1,36}(?:校验|验证|检查)|\bvalidated by\b/iu;
const rejectionDecision = /(?:做|作|给出|执行)\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60\s*(?:判定|判断)|\b(?:decides?|determines?)\s+\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60/iu;
const conditionalRejection = /(?:超出|超过|不符(?:合)?|失败|缺失|无效|畸形|否则|对照)[^，,。！？；;\x60]{0,16}(?:给出|返回|抛出|报出)\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60/iu;
const shapeRejection = /^(?:(?:当前|实际|负责|直接)\s*)*(?:校验|验证|检查)\s*[\p{L}\p{N}_ -]{1,24}(?:形态|形状|结构|格式|类型)\s*[（(]\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60\s*[）)]/iu;
const decisionOutcome = /(?:判定|判断|核定)[^，,。！？；;（）()]{1,32}[（(]\s*(?:超出|超过|不符(?:合)?|失败|缺失|无效|畸形)\s*(?:→|->)\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60\s*[）)]/iu;
const conditionOutcome = /(?:未知|缺失|不存在|不符(?:合)?|失败|无效|畸形|不(?:是|为|属于)|\b(?:unknown|missing|malformed|invalid|not (?:an?|the))\b)[^\x60，,。！？；;（）()→]{0,28}?(?:→|->|当(?:作)?|视为)\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60/giu;
const assignedCodes = /(?:^|[，,:：])\s*(?:错误码(?:由本模块|仅|只)?负责|(?:this (?:module|file) )?(?:owns|is responsible for) error codes?)\s*(\x60[\p{ID_Start}_][\p{ID_Continue}_-]*\x60(?:\s*(?:\/|、|\band\b)\s*\x60[\p{ID_Start}_][\p{ID_Continue}_-]*\x60){0,7})/giu;
const guardedAlternatives = /(?:检查|校验|验证|以及|并核对)\s*[\p{L}\p{N}_ -]{1,24}(?:是否属于|是否为|仅允许|只能是)\s*\x60[\p{ID_Start}_][\p{ID_Continue}_-]*\x60(?:\s*(?:\/|、|或)\s*\x60[\p{ID_Start}_][\p{ID_Continue}_-]*\x60){1,7}\s*[（(]\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60(?=[，,）)])/iu;
const forwardsRejection = /(?:透传|转发|原样|包装|序列化|下游|上游|代为|沿用|保留)/u;
const documentsResponse = /(?:端到端|对外|调用方(?:收到|看到)|交(?:给|由)|\b(?:pass[- ]?through|forwards?|propagates?|serializes?|end[- ]to[- ]end|caller (?:sees|receives))\b)/iu;
const explicitJsonDecoder = /(?:调用|使用|通过|(?:→|->)|\b(?:calls?|uses?)\b|\b(?:and|using)\b|(?:并|用))\s*\x60(json\.loads?)\x60(?!\s*(?:\/|或|\bor\b))/iu;
const failingJsonDecoder = /(?:^|[，,：:])\s*\x60(json\.loads?)\x60\s*(?:解析)?失败(?:时)?\s*(?:直接)?(?:返回|抛出|给出|报出|输出)\s*\x60/iu;
const checkBeforeRejection = /\x60([\p{ID_Start}_][\p{ID_Continue}_]*)\x60\s*(?:校验|验证|检查|判断|分发)(?:\s*(?:与|和|及)[^，,。！？；;]{1,28}?)?\s*(之前|之后)\s*(?:直接)?(?:返回|抛出|给出|报出)\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60/iu;
const rejectionBeforeCode = /^\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60\s*(先于|晚于|\b(?:precedes|follows)\b)\s*\x60([\p{ID_Start}_][\p{ID_Continue}_-]*)\x60/iu;
const parseDelegation = /(?:交付(?:给)?|交给|传给|委托(?:给|由)?)\s*(\x60[^\x60]+\x60|[\p{ID_Start}_][\p{ID_Continue}.-]*)\s*(?:解析|解码)|\b(?:hands?|passes?|delegates?)\b[^。;；]{0,60}\bto\s+(\x60[^\x60]+\x60|[\p{ID_Start}_][\p{ID_Continue}.-]*)\s+for\s+(?:JSON\s+)?(?:parsing|decoding)/iu;
const rawInput = /(?:原始(?:文本|字符串|输入|字节)|\b(?:raw\s+(?:input|text|bytes)|JSON)\b)/iu;
const decodedInput = /(?:解码后|解析后|已(?:经)?(?:解析|解码)|\b(?:already\s+)?decoded\b)/iu;
const negatedResponsibility = /(?:无需|不负责|不(?:做|校验|检查|验证|判定|判断|给出|返回|抛出|报出)|没有(?:做|校验|检查|验证)|\b(?:never|does not|do not|without)\b)/iu;
const absentSources = /(?:^|[，,])\s*(?:当前|现有)?\s*(?:还)?(?:没有|不存在|缺少|尚无)\s*([^，,。!?！？；;]{1,220}?)\s*(?:的)?(?:源代码|源码|源文件)(?=$|[\s，,。!?！？；;])/u;
const currentlyBounded = /^(?:当前(?:工作区)?|工作区(?:当前|现有|现在)|(?:目前|现阶段)(?:工作区)?)/u;

function moduleLookup(files) {
  const aliases = new Map();
  for (const file of files) {
    const module = file.replace(/\.py$/iu, "").replace(/\/__init__$/u, "").replaceAll("/", ".");
    for (const alias of new Set([file, module, module.split(".").at(-1), file.split("/").at(-1)])) {
      if (aliases.has(alias) && aliases.get(alias) !== file) aliases.set(alias, null);
      else aliases.set(alias, file);
    }
  }
  return (token, qualifiedCall = true) => {
    const path = aliases.get(token);
    if (path !== undefined) return path;
    // A module-qualified call identifies its module if the exact prefix is
    // already unique. An ordinary variable name never becomes a module here.
    const split = token.lastIndexOf(".");
    return qualifiedCall && split > 0 ? aliases.get(token.slice(0, split)) : undefined;
  };
}

function mentionedTargets(tail, locate) {
  const result = [];
  let rest = tail;
  while (rest) {
    const item = name.exec(rest);
    if (!item || !locate(item[2])) break;
    result.push(locate(item[2]));
    const delimiter = list.exec(rest.slice(item[0].length));
    if (!delimiter) break;
    rest = rest.slice(item[0].length + delimiter[0].length);
  }
  return result;
}

/** A complete, explicitly labeled arrow asserts adjacent static imports.
 * Multiple destinations can be grouped only at the end of a chain. Resolve
 * every alias first, so an ambiguous path never becomes an accusation. */
function importDirectionConflicts(expression, line, locate, graph) {
  const wholeCode = /^\x60([^\x60]+(?:→|->)[^\x60]+)\x60$/u.exec(expression)?.[1];
  const parts = (wholeCode ?? expression).split(/\s*(?:→|->)\s*/u);
  if (parts.length < 2 || parts.length > 12) return [];
  const groups = parts.map(part => {
    const group = /^(?:\((.+)\)|（(.+)）)$/u.exec(part.trim());
    const body = (group?.[1] ?? group?.[2] ?? part).trim();
    // Slash inside a quoted file is a path separator. An unquoted slash
    // separates aliases only when the entire token is not a known path.
    const destinations = [];
    for (const [index, item] of body.split(/\s*(?:[,，、]|\band\b)\s*/iu).entries()) {
      // Only a complete destination list may be followed by a distinct,
      // explicitly marked clause. Do not parse that clause as a module alias.
      if (index && /^(?:后[两三四五六七八九十\d]+者(?:之间)?|其余(?:模块)?|其他(?:模块)?)\s*(?:之间)?\s*(?:只允许|仅允许|不得|不允许)/u.test(item.trim())) break;
      const path = !item.includes("\x60") && locate(item, false);
      if (path) destinations.push(path);
      else for (const token of item.split(/\s*\/\s*(?=(?:[^\x60]*\x60[^\x60]*\x60)*[^\x60]*$)/u)) {
        const alias = importModule.exec(token.trim());
        destinations.push(alias && locate(alias[1] ?? alias[2], false));
      }
    }
    return destinations;
  });
  if (groups.some((files, index) => files.some(file => !file) || index < groups.length - 1 && files.length !== 1)) return [];
  return groups.slice(0, -1).flatMap(([from], index) => {
    if (graph.ambiguous?.some(row => row.file === from)) return [];
    const actual = graph.edges.filter(edge => edge.file === from).flatMap(edge =>
      edge.imports.map(file => ({ file, line: edge.line })));
    return [...new Set(groups[index + 1])].filter(to => from !== to && !actual.some(edge => edge.file === to))
      .map(to => ({ line, from, to, relation: "import", actual }));
  });
}

function explicitImportClauses(row, line, locate, graph) {
  const label = importDirection.exec(row);
  if (!label || graph.truncated) return [];
  // Continue across a semicolon only for an explicit, independently
  // resolvable arrow in this same labeled import statement.
  const paragraph = row.slice(label[0].length).split(/[。！？!?]|\.(?=\s|$)/u)[0];
  return paragraph.split(/[；;]/u).flatMap(clause => importDirectionConflicts(clause.trim(), line, locate, graph));
}

/** Only a current statement about exact registered module names can refute
 * host-observed presence. An incomplete list or an unresolved alias stays
 * informational. This reads document text, never arbitrary source paths. */
export function inspectArchitectureSourcePresence(source, modules) {
  const locate = moduleLookup(modules.map(row => row.file));
  const present = new Set(modules.filter(row => row.presence === "present").map(row => row.file));
  return architectureProseLines(source).flatMap(([line, row]) => {
    if (!currentlyBounded.test(row) || ownershipNotCurrent.test(row) || /(?:如果|假如|假设|举例|仅指|只指|不代表)/u.test(row)) return [];
    const claim = absentSources.exec(row)?.[1];
    if (!claim) return [];
    const tokens = claim.split(/\s*(?:、|，|,|和|及|与|\band\b)\s*/iu);
    const files = tokens.map(token => {
      const alias = importModule.exec(token.trim());
      return alias && locate(alias[1] ?? alias[2], false);
    });
    if (!files.length || files.some(file => !file)) return [];
    const contradicted = [...new Set(files.filter(file => present.has(file)))];
    return contradicted.length ? [{ line, relation: "source-presence", actual: contradicted.map(file => ({ file })) }] : [];
  });
}

/** A definite alternate owner requires a source-backed symbol or the same
 * guarded field and rejection code. Without a resolvable direct call, absence
 * of a local witness says nothing about which module owns the behavior. */
function responsibilityConflict(claim, line, from, graph) {
  if (graph.responsibilitiesTruncated || delegated.test(claim) || ownershipNotCurrent.test(claim)) return;
  const text = claim.trim();
  const definition = implementation.exec(text);
  const validation = ownership.exec(text);
  if (!definition && !validation) return;
  const calls = graph.calls.filter(row => row.file === from);
  const uncertainty = graph.uncertainCalls.find(row => row.file === from);
  if (uncertainty && !uncertainty.targets) return;
  const isCalled = row => !uncertainty?.targets?.includes(row.file) &&
    calls.some(call => call.target === row.file && call.symbol === row.symbol);
  if (definition) {
    const symbol = definition[1];
    const candidates = graph.definitions?.filter(row => row.symbol === symbol) ?? [];
    if (candidates.length !== 1 || candidates[0].file === from || !isCalled(candidates[0])) return;
    return { line, from, relation: "definition", symbol, actual: candidates };
  }
  const [, field, description] = validation;
  const codes = new Set([...description.matchAll(inlineLabel)].map(match => match[1]));
  if (!codes.size || graph.localRejections?.some(row => row.file === from && row.codes.some(code => codes.has(code)))) return;
  const sites = graph.validation?.filter(row => row.field === field) ?? [];
  if (sites.some(row => row.file === from)) return;
  const candidates = sites.filter(row => codes.has(row.code));
  if (!candidates.length || new Set(candidates.map(row => row.file)).size !== 1 || !candidates.every(isCalled)) return;
  return { line, from, relation: "validation", field, actual: candidates };
}

/** Grouped guards and named decision codes can be checked only against a
 * unique current source witness. A module that references the field, emits
 * the code itself, or uses dynamic resolution remains for human review. */
function sourceResponsibilityConflicts(claim, line, from, locate, graph) {
  if (graph.responsibilitiesTruncated || graph.truncated || graph.unparsedFiles?.length ||
    ownershipNotCurrent.test(claim) || negatedResponsibility.test(claim)) return [];
  const result = [];
  const isUnique = rows => rows.length && new Set(rows.map(row => row.file)).size === 1;
  const uncertain = file => graph.uncertainCalls.some(row => row.file === file && !row.targets);
  const hasIdentifier = (file, identifier) => graph.sourceIdentifiers?.find(row => row.file === file)?.identifiers.includes(identifier);
  const hasRejection = (file, code) => graph.localRejections?.some(row => row.file === file && row.codes.includes(code));
  if (uncertain(from)) return result;
  if (!delegated.test(claim) && !explicitGuardDelegate.test(claim)) {
    for (const [, parenthesized, separated] of claim.matchAll(groupGuard)) {
      // Match exact source identifiers in a bounded enumeration. Other list
      // entries can be prose, so do not infer translations or alternate names.
      const entries = (parenthesized ?? separated).split(/[/、,，]/u);
      if (entries.length < 2 || entries.length > 8) continue;
      const fields = new Set(entries.flatMap(entry => {
        const match = guardField.exec(entry.trim());
        return match ? [match[1] ?? match[2]] : [];
      }));
      for (const field of fields) {
        const guards = graph.validation?.filter(row => row.field === field) ?? [];
        if (!hasIdentifier(from, field) && isUnique(guards) && guards.every(row => row.file !== from) && guards.some(row => row.code)) {
          result.push({ line, from, relation: "validation", field, actual: guards });
        }
      }
    }
  }
  const decision = rejectionDecision.exec(claim);
  // A direct condition-to-code statement or named code responsibility
  // needs a unique literal rejection site. Describing what an external
  // caller receives does not assign the branch to the transport module.
  if (!delegated.test(claim) && !forwardsRejection.test(claim) && !documentsResponse.test(claim)) {
    const codes = new Set([decision?.[1] ?? decision?.[2],
      conditionalRejection.exec(claim)?.[1], shapeRejection.exec(claim.trim())?.[1], decisionOutcome.exec(claim)?.[1]]);
    for (const [, code] of claim.matchAll(conditionOutcome)) codes.add(code);
    for (const [, names] of claim.matchAll(assignedCodes)) {
      for (const [, code] of names.matchAll(inlineLabel)) codes.add(code);
    }
    const guardedCode = guardedAlternatives.exec(claim)?.[1];
    // A semantic label may differ from its field identifier. This narrow
    // case still requires the exact code in a unique parsed field guard.
    const guardedSites = guardedCode ? graph.validation?.filter(row => row.code === guardedCode) ?? [] : [];
    if (isUnique(guardedSites)) codes.add(guardedCode);
    for (const code of codes) {
      if (!code || hasIdentifier(from, code) || hasRejection(from, code)) continue;
      const actual = graph.rejectionSites?.filter(row => row.code === code) ?? [];
      if (isUnique(actual) && actual[0].file !== from) result.push({ line, from, relation: "decision", code, actual });
    }
  }
  const decoder = (explicitJsonDecoder.exec(claim) ?? failingJsonDecoder.exec(claim))?.[1];
  const localDecoders = graph.jsonDecoders?.filter(row => row.file === from) ?? [];
  if (decoder && !notCurrent.test(claim.replace(/\x60[^\x60]+\x60/gu, "")) && !documentsResponse.test(claim) &&
      !/(?:两者|二者|等价|类似|equivalent|alternatives?)/iu.test(claim) && localDecoders.length &&
      !localDecoders.some(row => row.symbol === decoder)) {
    result.push({ line, from, relation: "json-decoder-call", symbol: decoder, actual: localDecoders });
  }
  const delegation = parseDelegation.exec(claim);
  const targetName = (delegation?.[1] ?? delegation?.[2])?.replace(/^\x60|\x60$/gu, "");
  const target = targetName && locate(targetName, false);
  if (target && target !== from && rawInput.test(claim) && !decodedInput.test(claim) && !uncertain(target) &&
    !graph.edges.some(edge => edge.file === from && edge.imports.includes(target))) {
    const decoders = graph.jsonDecoders ?? [];
    if (isUnique(decoders) && decoders[0].file === from) {
      result.push({ line, from, to: target, relation: "json-decoding", actual: decoders });
    }
  }
  return result;
}

/** Explicit precedence between a rejection and a named check is verifiable
 * only when both resolve to unique early guards in the same function. */
function rejectionOrderConflict(claim, line, from, graph) {
  if (graph.responsibilitiesTruncated || graph.truncated || graph.unparsedFiles?.length ||
      ownershipNotCurrent.test(claim) || negatedResponsibility.test(claim) ||
      delegated.test(claim) || forwardsRejection.test(claim) || documentsResponse.test(claim)) return;
  const fieldOrder = checkBeforeRejection.exec(claim);
  const codeOrder = rejectionBeforeCode.exec(claim);
  if (!fieldOrder && !codeOrder) return;
  const [, name, direction, code] = fieldOrder ?? [null, codeOrder[3], codeOrder[2], codeOrder[1]];
  const before = /^(?:之前|先于|precedes)$/iu.test(direction);
  const guards = graph.orderedGuards?.filter(row => row.file === from) ?? [];
  const emissions = guards.filter(row => row.code === code);
  if (emissions.length !== 1) return;
  const [emission] = emissions;
  const checks = guards.filter(row => row.functionLine === emission.functionLine && row.code !== code &&
    (fieldOrder ? row.field === name : row.code === name));
  if (checks.length !== 1 || (emission.line < checks[0].line) === before) return;
  return { line, from, relation: "rejection-order", code, check: name, claimedBefore: before, actual: [emission, checks[0]] };
}

/** Validate only explicit current claims attached to a named module. Local
 * module identity, relation and line are data. Uncertain responsibility, call
 * binding and future designs stay with independent review. */
export function inspectArchitectureProse(source, graph) {
  const locate = moduleLookup(graph.checkedFiles);
  const conflicting = [];
  for (const [line, row, parentItem] of architectureProseLines(source)) {
    for (const conflict of explicitImportClauses(row, line, locate, graph)) {
      conflicting.push(conflict);
      if (conflicting.length >= 12) return conflicting;
    }
    const label = declaration.exec(row);
    const parent = !moduleItem.test(row) && parentItem && moduleItem.exec(parentItem);
    const module = (label || parent)?.[1];
    const from = module && locate(module);
    if (!from) continue;
    const body = label ? row.slice(label[0].length) : row;
    for (const claim of body.split(sentence)) {
      const order = rejectionOrderConflict(claim, line, from, graph);
      if (order) conflicting.push(order);
      if (conflicting.length >= 12) return conflicting;
      if (!label) continue;
      const responsibility = responsibilityConflict(claim, line, from, graph);
      const sourceClaims = sourceResponsibilityConflicts(claim, line, from, locate, graph);
      for (const conflict of [...(responsibility ? [responsibility] : []), ...sourceClaims]) {
        conflicting.push(conflict);
        if (conflicting.length >= 12) return conflicting;
      }
      if (notCurrent.test(claim)) continue;
      for (const verb of claim.matchAll(relation)) {
        const kind = /导入|import/iu.test(verb[1]) ? "import" : "call";
        const uncertainty = kind === "call" && graph.uncertainCalls.find(row => row.file === from);
        if (uncertainty && !uncertainty.targets) continue;
        const known = kind === "import" ? graph.edges.filter(edge => edge.file === from).flatMap(edge =>
          edge.imports.map(target => ({ target, line: edge.line }))) : graph.calls.filter(call => call.file === from);
        for (const target of mentionedTargets(claim.slice(verb.index + verb[0].length), locate)) {
          if (target === from || uncertainty?.targets?.includes(target) || known.some(edge => edge.target === target) ||
              conflicting.some(item => item.line === line && item.relation === kind && item.to === target)) continue;
          conflicting.push({ line, from, to: target, relation: kind, actual: known.map(({ target, line }) => ({ file: target, line })) });
          if (conflicting.length >= 12) return conflicting;
        }
      }
    }
  }
  return conflicting;
}

/** Signed bytes supersede the planning-time graph. The coordinator receives
 * only registered module names and line positions, never source contents. */
export function inspectEngineeringArchitectureClaims(frame, spec, active, graph, proposed) {
  const qualification = active?.codeIntake?.qualification;
  if (!qualification || !(spec.architecture?.importsHeading || spec.architecture?.proseReview)) return { conflicts: [], calls: [] };
  const current = spec.architecture.importsHeading ? graph ?? inspectArchitectureImports(frame, spec, active) : undefined;
  const source = readBytes(frame.root, spec.architecture.file);
  if (!source || current && digest(source) !== current.sha256) throw new Error("检查架构调用关系时架构稿已变化");
  const prose = proposed ?? source.toString("utf8");
  const linked = spec.architecture.proseReview && architectureResponsibilitiesCurrent(frame, spec, qualification,
    digest(JSON.stringify(qualification.artifacts))) ? linkedResponsibilityConflicts(prose, qualification.architectureResponsibilities.rows,
      { sources: spec.codeTask.sources }) : [];
  return { conflicts: [...linked, ...(current ? inspectArchitectureProse(prose, current.graph) : [])], calls: current?.graph.calls ?? [] };
}

/** Preserve a small metadata-only view of explicitly registered files. A
 * read failure cannot become a statement that the source is absent. */
function architectureSourceInventory(frame, spec) {
  const rows = spec.codeTask.sources.slice(0, 64).map(file => {
    try {
      const bytes = readBytes(frame.root, file);
      return bytes ? { file, presence: "present", sha256: digest(bytes) } : { file, presence: "missing" };
    } catch {
      return { file, presence: "unknown" };
    }
  });
  return { rows, truncated: spec.codeTask.sources.length > rows.length };
}

/** The executable subsection has one source for both displayed scope and
 * the rehearsal's expectations. Outside it reviewers still check prose. */
function inspectLockedRollbackScope(frame, spec, active, proposed) {
  const rollback = spec.architecture.rollback;
  if (!rollback?.lockedScope || !active?.codeIntake?.qualification || !active.rollbackProposal) return;
  const section = generatedArchitectureSection(frame, { architecture: { file: spec.architecture.file, heading: rollback.heading } },
    proposed, "heading");
  const eol = /\r\n|\n|\r/u.exec(section.source)?.[0] ?? "\n";
  const expected = rollbackScopeBody(rollback, active.rollbackProposal.id);
  const current = section.source.slice(section.bodyStart, section.bodyEnd).trim().replace(/\r\n?/gu, "\n");
  return { match: current === expected, proposed: current === expected ? section.source :
    section.source.slice(0, section.bodyStart) + eol + eol + expected.replaceAll("\n", eol) +
      (section.bodyEnd < section.source.length ? eol + eol : eol) + section.source.slice(section.bodyEnd) };
}

function generatedArchitectureHeadings(architecture, active) {
  const { importsHeading, responsibilitiesHeading, rollback } = architecture;
  return [importsHeading, responsibilitiesHeading,
    rollback?.lockedScope && active?.codeIntake?.qualification && active.rollbackProposal && rollback.heading].filter(Boolean);
}

/** Generate a separate factual section; plans and historical claims stay in
 * normal review sections. Do not transfer raw source or trace events. */
export function inspectArchitectureResponsibilitiesSection(frame, spec, active, proposed) {
  if (!spec.architecture?.responsibilities) return;
  const section = generatedArchitectureSection(frame, spec, proposed, "responsibilitiesHeading");
  const qualification = active?.codeIntake?.qualification;
  const artifactsSha256 = qualification && digest(JSON.stringify(qualification.artifacts));
  const claims = spec.architecture.responsibilities;
  const eol = /\r\n|\n|\r/u.exec(section.source)?.[0] ?? "\n";
  const fmt = value => JSON.stringify(value).replace(/[\x60<>]/gu, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  const verified = qualification && architectureResponsibilitiesCurrent(frame, spec, qualification, artifactsSha256);
  const contract = claims.map(row => {
    const clause = responsibilityClause(frame, row);
    if (!clause) throw new Error("关键职责 " + row.id + " 的原条款已变或不是完整可见句，请维护者核对");
    const proof = verified && qualification.architectureResponsibilities.rows.find(item => item.id === row.id);
    return proof ? { id: row.id, clause, mode: proof.mode, trigger: proof.trigger, decision: proof.actual,
      response: proof.response, traceSha256: proof.traceSha256 } :
      { id: row.id, clause, mode: row.mode, trigger: row.trigger, planned: row.owner, status: "等待当前签名稿与实际运行" };
  });
  const modes = { business: "业务判定", fallback: "入口兜底", forwarding: "原结果透传" };
  const expected = ["由宿主按当前签名源码和实际运行生成。其他章节如引用这些职责，请使用编号并保留实际归属。", "",
    ...contract.map(({ id, mode, clause, decision, planned }) =>
      "- " + (spec.architecture.proseReview ? '<a id="bl-fact-' + id + '"></a>' : "") + "`" + id + "` · " + modes[mode] + " · 条款 " + clause.file + ":" + clause.start + "–" + clause.end +
      (decision ? " · 已验证：" + decision.file + ":" + decision.line + "（" + decision.symbol + "）" :
        " · 计划：" + planned.file + "；等待当前签名稿与实际运行")),
    "", "\x60\x60\x60text", ...contract.map(fmt), "\x60\x60\x60"].join("\n");
  const { source, bodyStart, bodyEnd } = section;
  const current = source.slice(bodyStart, bodyEnd).trim().replace(/\r\n?/gu, "\n");
  const match = current === expected;
  return { ...section, match, proposed: match ? source : source.slice(0, bodyStart) + eol + eol + expected.replaceAll("\n", eol) +
    (bodyEnd < source.length ? eol + eol : eol) + source.slice(bodyEnd), contract };
}

/** Supply only names, presence and proven direct local edges. In particular,
 * this projection must not stamp source reads or change any role's grants. */
export function engineeringArchitectureSourceFacts(frame, unit) {
  const spec = frame.policy.units[unit];
  const active = frame.state.units[unit];
  if (!spec?.architecture || frame.role !== "coordinator" || !includes(frame.writes, spec.architecture.file) ||
    active && active.owner !== frame.agent.id) return;
  const { rows, truncated } = architectureSourceInventory(frame, spec);
  const facts = { modules: rows.map(({ file, presence }) => ({ file, presence })),
    ...(truncated ? { truncated } : {}) };
  if (!spec.architecture.importsHeading || truncated || rows.some(row => row.presence !== "present")) return facts;
  try {
    const paths = rows.map(row => row.file);
    const graph = pythonImportEvidence({ root: frame.root, reads: paths },
      rows.map(({ file, sha256 }) => ({ path: file, sha256 })));
    if (!graph.truncated && !graph.unparsedFiles.length && !graph.ambiguous.length && graph.checkedFiles.length === paths.length) {
      facts.directLocalImports = paths.map(file => ({ file,
        imports: [...new Set(graph.edges.filter(edge => edge.file === file).flatMap(edge => edge.imports))] }));
    }
  } catch {
    // A changed or unreadable file withholds the import graph only. Exact
    // source validation still takes place under the registration transaction.
  }
  return facts;
}

export function architectureClaimIssues(conflicts) {
  return conflicts.map(({ line, from, to, relation, actual, field, symbol, code, check, claimedBefore, id }) => {
    if (relation === "linked-responsibility") {
      const [decision] = actual;
      return "架构稿第 " + line + " 行把「" + id + "」的实际判定写在 " + from + "。同版实证在 " + decision.file +
        " 第 " + decision.line + " 行 " + decision.symbol + "。请按实际角色修改原句。";
    }
    if (relation === "source-presence") {
      return "架构稿第 " + line + " 行称当前源码缺失。宿主已确认这些登记源码存在：" +
        actual.map(row => row.file).join("、") + "。请按当前项目状态描述。";
    }
    if (relation === "json-decoder-call") {
      const witnesses = [...new Set(actual.map(row => row.file + " 第 " + row.line + " 行 " + row.symbol))];
      return "架构稿第 " + line + " 行称 " + from + " 调用 " + symbol + "。当前签名源码可定位的是 " +
        witnesses.join("、") + "。请按真实调用改写。";
    }
    if (relation === "json-decoding") {
      const witnesses = actual.map(row => row.file + " 第 " + row.line + " 行 " + row.symbol);
      return "架构稿第 " + line + " 行称 " + from + " 将解析交给 " + to + "。当前签名源码的 JSON 解码位置为 " +
        witnesses.join("、") + "。请区分 JSON 解码和后续请求校验。";
    }
    if (relation === "decision") {
      const witnesses = actual.map(row => row.file + " 第 " + row.line + " 行 " + row.symbol);
      return "架构稿第 " + line + " 行将「" + code + "」判定归于 " + from + "。当前签名源码的明确拒绝分支在 " +
        witnesses.join("、") + "。请区分规则参数和实际拒绝分支。";
    }
    if (relation === "rejection-order") {
      const [emission, other] = actual;
      return "架构稿第 " + line + " 行称「" + code + "」判定" + (claimedBefore ? "先于" : "晚于") +
        "「" + check + "」检查。当前签名源码 " + from + " 的 " + emission.symbol + " 在第 " + emission.line +
        " 行触发「" + emission.code + "」，第 " + other.line + " 行触发「" + other.code + "」。请按实际顺序描述。";
    }
    if (relation === "definition" || relation === "validation") {
      const claimed = relation === "definition" ? "实现 " + symbol : "校验字段 " + field;
      const witnesses = [...new Set(actual.map(row => row.file + " 第 " + row.line + " 行 " + row.symbol +
        (row.code ? "（" + row.code + "）" : "")))];
      return "架构稿第 " + line + " 行将「" + claimed + "」归于 " + from + "。当前签名源码的明确实现位置为 " +
        witnesses.join("、") + "。请区分调用协调与实际执行职责。";
    }
    const verb = relation === "call" ? "调用" : "导入";
    const targets = [...new Set(actual.map(item => item.file + "（" + from + " 第 " + item.line + " 行）"))];
    return "架构稿第 " + line + " 行称 " + from + " 直接" + verb + " " + to +
      "，当前签名源码" + (targets.length ? "可定位的直接" + verb + "为 " + targets.join("、") : "没有可定位的本地直接" + verb) +
      "。请按实际路径改写，间接关系写清中间模块。";
  });
}
/** Resolve broken references against the responsibility IDs authorized for this unit. */
export function engineeringArchitectureLinkIssues(frame, spec, source, active) {
  const architecture = spec?.architecture;
  if (!architecture?.proseReview) return [];
  if (source === undefined) {
    const bytes = readBytes(frame.root, architecture.file);
    if (!bytes) return [];
    source = text(bytes);
  }
  return architectureBrokenFactLinks(source, architecture.responsibilities.map(({ id }) => id), {
    protectedHeadings: generatedArchitectureHeadings(architecture, active),
    authoredHeadings: architecture.headings,
  });
}

/** A broken link outside a unique authored section has a line-scoped splice. */
export function architectureLinkRepairAction(file, issue) {
  return { action: "edit", path: file, ...(issue.lineScoped ? {} : { heading: issue.heading }),
    required: ["beforeSha256", "note", "edits"], lines: issue.editLines ?? [issue.line, issue.end] };
}

/** A plan is published by the coordinator under the same lock as dispatch. */
export function registerEngineeringArchitecture(frame, unit, spec, tag, rollbackProof) {
  const active = frame.state.units[unit];
  if (!spec.architecture || frame.role !== "coordinator" || !includes(frame.writes, spec.architecture.file) ||
    active && active.owner !== frame.agent.id) throw new Error("只有获授权的本单元总控能登记架构稿");
  if (active && !["review-ready", "final-review-ready", "architecture-sync", "architecture-repair", "ledger-review", "blocked", "diagnosis-repair-ready"].includes(active.phase)) {
    throw new Error("只在派单前、代码待审或架构退回时登记架构稿；正在工作的子会话须先结束阶段");
  }
  const goal = goalSnapshot(frame);
  const diagnostics = spec.codeTask.diagnostics;
  // An opted-in rollback subsection becomes host-authored once signed. A
  // stale draft fence cannot prevent replacing it with the current proposal.
  const bytes = readBytes(frame.root, spec.architecture.file);
  const source = bytes && text(bytes);
  const linkIssues = source ? engineeringArchitectureLinkIssues(frame, spec, source, active) : [];
  if (linkIssues.length) {
    return { unit, phase: active?.phase ?? "dispatch", status: "architecture-broken-links", issues: linkIssues,
      responsibilityIds: spec.architecture.responsibilities.map(({ id }) => id), next: { action: "architecture", unit } };
  }
  const linkResume = active?.phase === "architecture-repair" && active.architectureLinkResume;
  const resumeExecution = linkResume && ["intake", "supplement"].includes(linkResume.phase);
  const pendingCodeRepair = active?.phase === "diagnosis-repair-ready" ||
    active?.phase === "blocked" && ["intake", "supplement"].includes(active.resumePhase) || resumeExecution;
  const locked = source && !pendingCodeRepair && inspectLockedRollbackScope(frame, spec, active, source);
  const draftSpec = locked && !locked.match ? { ...spec.architecture, rollback: undefined } : spec.architecture;
  let plan = architectureDocument(frame, draftSpec, diagnostics);
  const qualification = active?.codeIntake?.qualification;
  const previous = frame.state.engineeringArchitecture?.[keyOf(plan.file)];
  if (previous?.goalSha256 !== goal.sha256 && previous?.contentsSha256 === plan.contentsSha256) {
    throw new Error("目标已变化，请把受影响的架构、回退与验证计划实际更新到 " + plan.file);
  }
  if (active?.phase === "architecture-repair" && !linkResume && active.engineeringArchitecture?.contentsSha256 === plan.contentsSha256) {
    throw new Error("架构已退回，请实际修改对应内容后再登记");
  }
  // Verified diagnosis may point at code that still cannot parse. Pin only
  // the owner's current plan here; signed submission checks the repaired source.
  const imports = pendingCodeRepair ? undefined : inspectArchitectureImports(frame, spec, active);
  const original = imports?.proposed ?? source;
  const responsibilities = inspectArchitectureResponsibilitiesSection(frame, spec, pendingCodeRepair ? undefined : active, original);
  const withResponsibilities = responsibilities?.proposed ?? original;
  const rollbackScope = !pendingCodeRepair && inspectLockedRollbackScope(frame, spec, active, withResponsibilities);
  const updated = rollbackScope?.proposed ?? withResponsibilities;
  // Ignore claims in the draft rollback section the host is about to replace.
  // Keep existing diagnostics on the original positions for ordinary plans.
  const checkSource = locked && !locked.match ? locked.proposed : source;
  const inventory = architectureSourceInventory(frame, spec);
  const presenceConflicts = inventory.truncated ? [] : inspectArchitectureSourcePresence(checkSource, inventory.rows);
  if (presenceConflicts.length) throw new Error(architectureClaimIssues(presenceConflicts).join("\n"));
  if (!pendingCodeRepair) {
    const claims = inspectEngineeringArchitectureClaims(frame, spec, active, imports, checkSource);
    if (claims.conflicts.length) throw new Error(architectureClaimIssues(claims.conflicts).join("\n"));
  }
  if (updated !== source) {
    replaceWithHistory(frame.root, plan.file, before => {
      if (!before || digest(before) !== plan.sha256) throw new Error("宿主生成架构章节时正文已变化，请重新登记");
      return updated;
    }, "宿主按当前证据生成静态导入或关键职责", tag, frame.state.markers);
    frame.changed = true;
    plan = architectureDocument(frame, spec.architecture, diagnostics);
  }
  if (spec.architecture.rollback && qualification && !pendingCodeRepair) {
    try {
      const signed = requireCodeRegressionCurrent(frame, unit, active, spec, goal);
      const current = { ...qualification, receiptSha256: signed.receiptSha256 };
      const baseline = active.codeIntake.regression.artifacts;
      if (spec.architecture.rollback.lockedScope && !active.rollbackProposal) throw new Error("此回退章节须引用执行方登记的当前签名提议");
      if (!rollbackProof) {
        return { unit, phase: active.phase, rehearsal: prepareRollbackRehearsal(frame, spec, current, plan, baseline, active.rollbackProposal) };
      }
      if (!rollbackRehearsalCurrent(frame, spec, current, plan, rollbackProof, baseline, active.rollbackProposal, true)) {
        return { unit, phase: active.phase, status: "superseded", next: { action: "architecture", unit } };
      }
    } catch (error) {
      return { unit, phase: active.phase, status: "rollback-plan-required", reason: error.message, next: { action: "architecture", unit } };
    }
  }
  const snapshot = { ...plan, goalSha256: goal.sha256, unit, owner: frame.agent.id };
  if (rollbackProof && qualification && !pendingCodeRepair) snapshot.rollbackRehearsal = rollbackProof;
  frame.state.engineeringArchitecture = { ...frame.state.engineeringArchitecture, [keyOf(plan.file)]: snapshot };
  if (active) {
    active.engineeringArchitecture = snapshot;
    if (rollbackProof) delete active.rollbackFailure;
    if (active.phase === "architecture-sync") {
      active.phase = active.architectureSyncResume;
      delete active.architectureSyncResume;
    } else if (active.phase === "architecture-repair") {
      if (linkResume) {
        if (resumeExecution) {
          active.phase = "blocked";
          active.resumePhase = linkResume.phase;
          active.actor = linkResume.actor;
          active.blocked = "架构引用已修复，请续派原执行会话，按现稿完成签名与送审";
        } else {
          active.phase = linkResume.phase;
        }
        delete active.architectureLinkResume;
      } else {
        active.phase = active.codeReviewRejection ? "supplement-ready" : "final-review-ready";
      }
    } else if (active.phase === "ledger-review" && previous?.sha256 !== snapshot.sha256) {
      active.phase = "final-review-ready";
    } else if (active.phase === "blocked" && ["first-review", "first-audit", "final-review", "final-audit"].includes(active.resumePhase) &&
      previous?.sha256 !== snapshot.sha256) {
      active.phase = "final-review-ready";
      delete active.pendingReceipt;
      delete active.resumePhase;
    }
  }
  frame.changed = true;
  return { unit, phase: active?.phase ?? "dispatch", architecture: snapshot };
}

export function engineeringArchitectureCurrent(frame, spec, snapshot, active, checkImports = true) {
  if (!spec.architecture) return true;
  const file = spec.architecture.file;
  const bytes = readBytes(frame.root, file);
  if (snapshot?.file !== file || !bytes || snapshot.sha256 !== digest(bytes) ||
    snapshot.goalSha256 !== goalSnapshot(frame).sha256) return false;
  try {
    const plan = architectureDocument(frame, spec.architecture, spec.codeTask.diagnostics);
    // Rebuild the typed data from the exact document before any runner uses the
    // stored examples. The validated data must still be that revision's data.
    if (plan.sha256 !== snapshot.sha256 || JSON.stringify(plan.examples) !== JSON.stringify(snapshot.examples)) return false;
    if (!checkImports) return true;
    if (spec.architecture.rollback && active?.codeIntake?.qualification) {
      const signed = requireCodeRegressionCurrent(frame, snapshot.unit, active, spec, goalSnapshot(frame));
      const current = { ...active.codeIntake.qualification, receiptSha256: signed.receiptSha256 };
      if (spec.architecture.rollback.lockedScope && !inspectLockedRollbackScope(frame, spec, active)?.match) return false;
      if (!rollbackRehearsalCurrent(frame, spec, current, plan,
        snapshot.rollbackRehearsal, active.codeIntake.regression.artifacts, active.rollbackProposal)) return false;
    }
    if (spec.architecture.responsibilities && !inspectArchitectureResponsibilitiesSection(frame, spec, active).match) return false;
    if (!spec.architecture.importsHeading) return !inspectEngineeringArchitectureClaims(frame, spec, active).conflicts.length;
    const imports = inspectArchitectureImports(frame, spec, active);
    return imports.match && !inspectEngineeringArchitectureClaims(frame, spec, active, imports).conflicts.length;
  }
  catch { return false; }
}

export function requireEngineeringArchitecture(frame, unit, spec, active, checkImports = true) {
  if (!spec.architecture) return;
  const snapshot = active?.engineeringArchitecture ?? frame.state.engineeringArchitecture?.[keyOf(spec.architecture.file)];
  if (snapshot?.unit !== unit || snapshot.owner !== (frame.assignment?.[1].owner ?? frame.agent.id) ||
    !engineeringArchitectureCurrent(frame, spec, snapshot, active, checkImports)) {
    throw new Error("请总控维护当前目标的架构稿 " + spec.architecture.file + "，再用 building_loop architecture 登记实际版本");
  }
  return snapshot;
}

/** Include only the exact authorized path and next action in coordinator packets. */
export function engineeringArchitectureStatus(frame, unit) {
  const spec = frame.policy.units[unit];
  if (!spec?.architecture || frame.role !== "coordinator") return;
  const active = frame.state.units[unit];
  const { file, headings, examplesHeading, importsHeading, responsibilitiesHeading } = spec.architecture;
  const generatedHeadings = generatedArchitectureHeadings(spec.architecture, active);
  const contract = { file, headings, editableHeadings: headings.filter(heading => !generatedHeadings.includes(heading)),
    generatedHeadings, ...(examplesHeading ? { examplesHeading } : {}), ...(importsHeading ? { importsHeading } : {}),
    ...(responsibilitiesHeading ? { responsibilitiesHeading, generated: "关键职责由宿主生成，请保留该章节及原文。其他章节用职责编号引用，说明计划和验证方式。" +
      (spec.architecture.proseReview ? "引用用 [显示文字](#bl-fact-职责编号)。" : "不要另写一份当前判定位置。"),
      responsibilityIds: spec.architecture.responsibilities.map(({ id }) => id) } : {}) };
  if (spec.architecture.rollback) {
    const { heading, files, restore, contracts } = spec.architecture.rollback;
    const proposal = active?.rollbackProposal;
    const signed = active?.codeIntake?.qualification;
    contract.rollback = { heading, files, ...(restore ? { restore: restore.map(({ file }) => file) } : {}),
      checks: inputContractCases(contracts).map(({ id, expected, requirement }) => ({ id, expected, requirement })) };
    if (!signed) {
      contract.rollback.rule = rollbackScopeRule(spec.architecture.rollback.lockedScope, false);
    } else if (proposal?.binding.policySha256 === frame.policy.hash && proposal.binding.goalSha256 === goalSnapshot(frame).sha256 &&
      proposal.binding.originalArtifactsSha256 === digest(JSON.stringify(signed.artifacts))) {
      contract.rollback.rule = rollbackScopeRule(spec.architecture.rollback.lockedScope, true);
      contract.rollback.proposal = { id: proposal.id, files: proposal.files };
      contract.rollback.fence = "```json building-loop-rollback\n" + JSON.stringify({ proposal: proposal.id }) + "\n```";
    } else {
      contract.rollback.rule = "检查当前回退章节的已授权实跑步骤，再用 architecture 在隔离副本上演练。";
    }
  }
  let issues;
  try {
    issues = engineeringArchitectureLinkIssues(frame, spec, undefined, active);
  } catch (error) {
    return { ...contract, status: "required", reason: error.message, next: { action: "architecture", unit } };
  }
  if (issues.length) {
    return { ...contract, status: "broken-links", issues, edit: architectureLinkRepairAction(file, issues[0]),
      ...(active?.phase === "architecture-repair" ? { receipt: active.receipt } : {}), next: { action: "architecture", unit } };
  }
  if (active?.phase === "architecture-repair") {
    return { ...contract, status: "repair", receipt: active.receipt, next: { action: "architecture", unit } };
  }
  if (active?.phase === "architecture-sync") {
    const sync = { ...contract, status: "sync", next: { action: "architecture", unit } };
    if (active.rollbackFailure) {
      sync.rollback.failed = active.rollbackFailure.failures.map(({ id, outcome }) => ({ id, outcome }));
      sync.next = { action: "advance", unit };
    }
    try {
      const { conflicts } = inspectEngineeringArchitectureClaims(frame, spec, active);
      const responsibilities = inspectArchitectureResponsibilitiesSection(frame, spec, active);
      return { ...sync, ...(conflicts.length ? { conflicts: architectureClaimIssues(conflicts) } : {}),
        ...(responsibilities ? { responsibilities: responsibilities.contract } : {}) };
    } catch (error) { return { ...sync, reason: error.message }; }
  }
  const pendingCodeRepair = active?.phase === "diagnosis-repair-ready" ||
    active?.phase === "blocked" && ["intake", "supplement"].includes(active.resumePhase);
  try {
    const snapshot = requireEngineeringArchitecture(frame, unit, spec, active, !pendingCodeRepair);
    return { ...contract, status: "registered", sha256: snapshot.sha256 };
  } catch (error) {
    return { ...contract, status: "required", reason: error.message, next: { action: "architecture", unit } };
  }
}

/** Restrict an already hash-checked splice to the bound coordinator's named authored section. */
export function validateCoordinatorArchitectureEdit(frame, unit, file, before, proposed, heading) {
  const spec = frame.policy.units[unit];
  const active = frame.state.units[unit];
  const architecture = spec?.architecture;
  if (frame.role !== "coordinator" || !architecture || !includes([architecture.file], file) ||
      !includes(frame.reads, file) || !includes(frame.writes, file) || active && active.owner !== frame.agent.id) {
    throw new Error("总控只能局部编辑当前单元已授权读写的架构稿");
  }
  // Retain the BOM and exact line endings for the bytes around the authorized body.
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before);
  const original = architectureHeadingSpans(source);
  const edited = architectureHeadingSpans(proposed);
  const protectedTitles = generatedArchitectureHeadings(architecture, active);
  if (heading === undefined) {
    const issues = engineeringArchitectureLinkIssues(frame, spec, source, active);
    const offsets = architectureLineOffsets(source);
    const previous = issues.filter(issue => issue.lineScoped).find(issue => {
      const [first, last] = issue.editLines ?? [issue.line, issue.end];
      const start = offsets[first - 1], end = offsets[last];
      const prefix = source.slice(0, start), suffix = source.slice(end);
      return proposed.length >= prefix.length + suffix.length && proposed.startsWith(prefix) && proposed.endsWith(suffix) &&
        architectureLinkReplacementOnly(source.slice(start, end), proposed.slice(start, proposed.length - suffix.length),
          issue.unknownRefs, architecture.responsibilities.map(({ id }) => id));
    });
    const after = engineeringArchitectureLinkIssues(frame, spec, proposed, active);
    const count = rows => rows.reduce((total, row) => total + row.unknownRefs.length, 0);
    if (!previous || count(after) >= count(issues) || original.length !== edited.length ||
        original.some((row, index) => row.depth !== edited[index].depth || row.title !== edited[index].title)) {
      throw new Error("省略标题只可在宿主定位的单处失效引用范围内修正链接，须保留其他原始字节和标题结构");
    }
    return proposed;
  }
  if (typeof heading !== "string" || !heading.trim()) throw new Error("架构稿局部编辑须指定一个人工正文标题");
  const positions = original.flatMap((row, index) => row.title === heading ? [index] : []);
  if (positions.length !== 1) throw new Error("架构稿局部编辑须指定一个唯一可见的正文标题");
  const [position] = positions;
  const section = original[position];
  const next = edited[position];
  if (section.depth === 1 && !architecture.headings.includes(section.title)) {
    throw new Error("架构稿局部编辑须指定正文小节，文件标题和导言须保留");
  }
  if (original.some((row, index) => {
    if (!protectedTitles.includes(row.title)) return false;
    const after = original.slice(index + 1).find(other => other.depth <= row.depth)?.start ?? source.length;
    return section.start < after && row.start < section.stop;
  })) {
    throw new Error("架构稿局部编辑须避开宿主生成章节");
  }
  if (original.length !== edited.length || original.some((row, index) => {
    const replacement = edited[index];
    return row.depth !== replacement.depth ||
      source.slice(row.start, row.bodyStart) !== proposed.slice(replacement.start, replacement.bodyStart);
  }) || source.slice(0, section.bodyStart) !== proposed.slice(0, next.bodyStart) ||
      source.slice(section.stop) !== proposed.slice(next.stop)) {
    throw new Error("架构稿局部编辑只能修改指定正文，须保留其他章节、标题和原始字节");
  }
  return proposed;
}

function rollbackScopeRule(locked, signed) {
  if (locked) return signed ? "此章由宿主按当前提议和授权条款生成。直接用 architecture 实跑。自由说明写到其他架构章节。" :
    "派单前本节写要恢复与保留的行为。签名后宿主用当前提议和登记条款生成实跑章节。";
  return signed ? "核对提议对应的回退意图，将给出的围栏加入当前回退章节，再用 architecture 实跑。" :
    "派单前本节只写要恢复与保留的行为。执行方签名送审后，宿主会给出可引用的实跑提议和准确围栏。";
}

/** Preserve the designated generated body when the coordinator edits prose. */
export function requireHostImportSectionUnchanged(frame, file, proposed) {
  const spec = Object.values(frame.policy.units).find(unit => unit.architecture && includes([unit.architecture.file], file));
  for (const field of ["importsHeading", "responsibilitiesHeading"]) {
    if (!spec?.architecture[field]) continue;
    const current = generatedArchitectureSection(frame, spec, undefined, field);
    const next = generatedArchitectureSection(frame, spec, proposed, field);
    if (current.source.slice(current.bodyStart, current.bodyEnd).trim() !== next.source.slice(next.bodyStart, next.bodyEnd).trim()) {
      throw new Error(spec.architecture[field] + " 章节由宿主生成。保留该章节原文，用 building_loop architecture 更新");
    }
  }
  // Apply the extra guard only while this exact unit has current signed code.
  // The same architecture file may become editable for a later project's plan.
  for (const [id, active] of Object.entries(frame.state.units)) {
    const current = frame.policy.units[id];
    if (!current?.architecture?.rollback?.lockedScope || current.architecture.file !== file ||
      active.owner !== frame.agent.id || !["architecture-repair", "ledger-review", "review-ready", "final-review-ready"].includes(active.phase) ||
      active.engineeringArchitecture?.rollbackRehearsal?.status !== "passed") continue;
    if (!inspectLockedRollbackScope(frame, current, active, proposed)?.match) {
      throw new Error("已实跑的回退范围由宿主生成。保留该章，其他架构正文可按授权修订");
    }
  }
}

/** Only the actual coordinator-owned architecture location can route repair
 * to the coordinator. Mixed findings still require the original code repair. */
export function engineeringRepair(proof) {
  const architecture = proof.architecture?.status === "revise";
  const code = proof.files.some(row => (row.comments ?? [row.comment]).some(comment => comment?.status === "missing")) ||
    proof.constraints.some(row => row.status === "revise") || proof.findings.some(row => row.owner !== "coordinator");
  return { architecture, code };
}
