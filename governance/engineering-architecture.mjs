import { goalSnapshot } from "./goals.mjs";
import { inspectArchitectureImports } from "./code-review.mjs";
import { digest, includes, keyOf, readBytes, replaceWithHistory, text } from "./policy.mjs";
import { architectureDocument, architectureImportsSection, architectureProseLines } from "./project-hierarchy.mjs";
import { pythonImportEvidence } from "./python-dependencies.mjs";

const declaration = /^(?:[-+*]\s+|\d+[.)]\s+)?(?:\*\*)?\x60?([^\s`:：()（）]+\.py)\x60?(?:\*\*)?(?:\s*[（(][^）)]{1,80}[）)])?\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?/iu;
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
const groupGuard = /(?:校验|验证|检查|\bvalidates?\b|\bchecks?\b)\s*[（(]\s*(\x60[\p{ID_Start}_][\p{ID_Continue}_-]*\x60(?:\s*[/、,，]\s*\x60[\p{ID_Start}_][\p{ID_Continue}_-]*\x60){1,7})\s*(?:(?:各自)?(?:字段|类型(?:面|检查)?))?[）)]/iu;
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
const failingJsonDecoder = /(?:^|[，,：:])\s*\x60(json\.loads?)\x60\s*(?:解析)?失败(?:时)?\s*(?:直接)?(?:返回|抛出|给出|报出)\s*\x60/iu;
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
  const group = groupGuard.exec(claim)?.[1];
  if (group && !delegated.test(claim)) {
    for (const [, field] of group.matchAll(inlineLabel)) {
      const guards = graph.validation?.filter(row => row.field === field) ?? [];
      if (!hasIdentifier(from, field) && isUnique(guards) && guards.every(row => row.file !== from) && guards.some(row => row.code)) {
        result.push({ line, from, relation: "validation", field, actual: guards });
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
export function inspectEngineeringArchitectureClaims(frame, spec, active, graph) {
  if (!spec.architecture?.importsHeading || !active?.codeIntake?.qualification) return { conflicts: [], calls: [] };
  const current = graph ?? inspectArchitectureImports(frame, spec, active);
  const source = readBytes(frame.root, spec.architecture.file);
  if (!source || digest(source) !== current.sha256) throw new Error("检查架构调用关系时架构稿已变化");
  return { conflicts: inspectArchitectureProse(source.toString("utf8"), current.graph), calls: current.graph.calls };
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
  return conflicts.map(({ line, from, to, relation, actual, field, symbol, code, check, claimedBefore }) => {
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
/** A plan is published by the coordinator under the same lock as dispatch. */
export function registerEngineeringArchitecture(frame, unit, spec, tag) {
  const active = frame.state.units[unit];
  if (!spec.architecture || frame.role !== "coordinator" || !includes(frame.writes, spec.architecture.file) ||
    active && active.owner !== frame.agent.id) throw new Error("只有获授权的本单元总控能登记架构稿");
  if (active && !["review-ready", "final-review-ready", "architecture-sync", "architecture-repair", "ledger-review", "blocked", "diagnosis-repair-ready"].includes(active.phase)) {
    throw new Error("只在派单前、代码待审或架构退回时登记架构稿；正在工作的子会话须先结束阶段");
  }
  const goal = goalSnapshot(frame);
  const diagnostics = spec.codeTask.diagnostics;
  let plan = architectureDocument(frame, spec.architecture, diagnostics);
  const previous = frame.state.engineeringArchitecture?.[keyOf(plan.file)];
  if (previous?.goalSha256 !== goal.sha256 && previous?.contentsSha256 === plan.contentsSha256) {
    throw new Error("目标已变化，请把受影响的架构、回退与验证计划实际更新到 " + plan.file);
  }
  if (active?.phase === "architecture-repair" && active.engineeringArchitecture?.contentsSha256 === plan.contentsSha256) {
    throw new Error("架构已退回，请实际修改对应内容后再登记");
  }
  const inventory = architectureSourceInventory(frame, spec);
  const presenceConflicts = inventory.truncated ? [] :
    inspectArchitectureSourcePresence(text(readBytes(frame.root, plan.file)), inventory.rows);
  if (presenceConflicts.length) throw new Error(architectureClaimIssues(presenceConflicts).join("\n"));
  // Verified diagnosis may point at code that still cannot parse. Pin only
  // the owner's current plan here; signed submission checks the repaired source.
  const pendingCodeRepair = active?.phase === "diagnosis-repair-ready" ||
    active?.phase === "blocked" && ["intake", "supplement"].includes(active.resumePhase);
  const imports = pendingCodeRepair ? undefined : inspectArchitectureImports(frame, spec, active);
  if (!pendingCodeRepair) {
    const claims = inspectEngineeringArchitectureClaims(frame, spec, active, imports);
    if (claims.conflicts.length) throw new Error(architectureClaimIssues(claims.conflicts).join("\n"));
  }
  if (imports && !imports.match) {
    replaceWithHistory(frame.root, plan.file, before => {
      if (!before || digest(before) !== imports.sha256) throw new Error("静态导入生成时架构正文已变化，请重新登记");
      return imports.proposed;
    }, "宿主根据当前代码更新实际本地静态导入", tag, frame.state.markers);
    plan = architectureDocument(frame, spec.architecture, diagnostics);
  }
  const snapshot = { ...plan, goalSha256: goal.sha256, unit, owner: frame.agent.id };
  frame.state.engineeringArchitecture = { ...frame.state.engineeringArchitecture, [keyOf(plan.file)]: snapshot };
  if (active) {
    active.engineeringArchitecture = snapshot;
    if (active.phase === "architecture-sync") {
      active.phase = active.architectureSyncResume;
      delete active.architectureSyncResume;
    } else if (active.phase === "architecture-repair") {
      active.phase = active.codeReviewRejection ? "supplement-ready" : "final-review-ready";
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
    if (!checkImports || !spec.architecture.importsHeading) return true;
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
  const { file, headings, examplesHeading } = spec.architecture;
  const contract = { file, headings, ...(examplesHeading ? { examplesHeading } : {}) };
  if (active?.phase === "architecture-repair") {
    return { ...contract, status: "repair", receipt: active.receipt, next: { action: "architecture", unit } };
  }
  if (active?.phase === "architecture-sync") {
    const sync = { ...contract, status: "sync", next: { action: "architecture", unit } };
    try {
      const { conflicts } = inspectEngineeringArchitectureClaims(frame, spec, active);
      return conflicts.length ? { ...sync, conflicts: architectureClaimIssues(conflicts) } : sync;
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

/** Preserve the designated generated body when the coordinator edits prose. */
export function requireHostImportSectionUnchanged(frame, file, proposed) {
  const spec = Object.values(frame.policy.units).find(unit => unit.architecture?.importsHeading && includes([unit.architecture.file], file));
  if (!spec) return;
  const current = architectureImportsSection(frame, spec);
  const next = architectureImportsSection(frame, spec, proposed);
  if (current.source.slice(current.bodyStart, current.bodyEnd).trim() !== next.source.slice(next.bodyStart, next.bodyEnd).trim()) {
    throw new Error("静态导入章节由宿主生成。保留该章节原文，用 building_loop architecture 更新");
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
