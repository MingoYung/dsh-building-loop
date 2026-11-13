import { isDeepStrictEqual } from "node:util";
import { inputContractCases } from "./input-contracts.mjs";
import { digest, includes, keyOf, relativeName } from "./policy.mjs";

function expectedOutput(value) {
  if (value === undefined) return {};
  if (typeof value !== "string" || Buffer.byteLength(value) > 2048) throw new Error("expectedJson 须为不超过 2 KiB 的 JSON 文本");
  try { return { json: JSON.parse(value) }; }
  catch { throw new Error("expectedJson 不是有效 JSON"); }
}

// Restrict a grounded comparison to the behavior actually asserted. Bare
// exploratory probes retain their full-JSON comparison for older callers.
export function runtimeExpectation({ expectedExitCode, expectedJson, expectedPointer, expectedOperator }, requirement) {
  const expected = { exitCode: expectedExitCode, ...expectedOutput(expectedJson) };
  if (expectedPointer !== undefined && (!Object.hasOwn(expected, "json") || typeof expectedPointer !== "string" ||
      expectedPointer.length > 256 || !/^(?:\/(?:[^~/]|~[01])*)*$/u.test(expectedPointer))) {
    throw new Error("expectedPointer 须为有效 JSON Pointer，并同时提供 expectedJson");
  }
  if (expectedOperator !== undefined && (!["at-most", "at-least"].includes(expectedOperator) ||
      expectedPointer === undefined || !Number.isFinite(expected.json))) {
    throw new Error("数值上限或下限须提供 expectedPointer、数字 expectedJson 及 at-most 或 at-least");
  }
  if (requirement && Object.hasOwn(expected, "json")) {
    if (expectedPointer === undefined || expected.json && typeof expected.json === "object" && !Array.isArray(expected.json)) {
      throw new Error("可用于退回的 JSON 复现须用 expectedPointer 选择具体行为字段，并只提供该字段的标量或数组预期");
    }
    const field = pointerSegments(expectedPointer).at(-1);
    // A literal status/error identifier must appear in the actual clause. A
    // grounded numeric or ordered-array constraint can be described in prose.
    if (/^(?:error|status|(?:error[_-]?)?code)$/iu.test(field ?? "") &&
        ["string", "number"].includes(typeof expected.json) && !clauseLiterals(requirement).has(String(expected.json))) {
      throw new Error("预期返回码 " + expected.json + " 须逐字见于对应条款。推测的结果只可探索，不得用于退回");
    }
  }
  if (requirement && expected.exitCode !== 0 && !clauseLiterals(requirement).has(String(expected.exitCode))) {
    throw new Error("非零预期退出码须逐字见于对应条款");
  }
  return { ...expected, ...(expectedPointer === undefined ? {} : { pointer: expectedPointer }),
    ...(expectedOperator === undefined ? {} : { operator: expectedOperator }) };
}

const clauseLiterals = requirement => new Set(requirement.quote.match(/[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/gu));
const pointerSegments = pointer => pointer.split("/").slice(1).map(token => token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
const regexLiteral = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const conditionalClause = /(?:\b(?:if|when|whenever|provided\s+that|assuming|unless)\b|\b(?:in|for)\s+(?:the\s+)?case\s+(?:of|that)\b|如果|若|倘若|仅当|一旦|除非|前提(?:是|为)|(?:^|[。！？；，\s])当|[\p{L}\p{N}）)]\s*时(?=[，,。\s]|则|返回|输出|应|须))/iu;
const GROUNDING_VERSION = 2;

export function hasConditionalContext(text) {
  return conditionalClause.test(text.replace(/\x60[^\x60\r\n]+\x60/gu, " "));
}

function projectedOutput(value, pointer) {
  for (const field of pointerSegments(pointer)) {
    if (!value || typeof value !== "object" || Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(field) ||
      !Object.hasOwn(value, field)) return undefined;
    value = value[field];
  }
  return value;
}

function matchesValue(actual, { json, operator }) {
  if (operator === "at-most") return Number.isFinite(actual) && actual <= json;
  if (operator === "at-least") return Number.isFinite(actual) && actual >= json;
  return isDeepStrictEqual(actual, json);
}

function hasExpectedValue(actual, expected) {
  const projected = expected.pointer === undefined ? actual : projectedOutput(actual, expected.pointer);
  return projected !== undefined && matchesValue(projected, expected);
}

function namesExitCode(quote, exitCode) {
  const explicit = [...quote.matchAll(/(?:\b(?:exit|return)\s+(?:code|status)|退出码|退出状态)\s*(?:为|是|is|=|[:：])?\s*\x60?(\d+)\x60?(?!\d)/giu)];
  if (explicit.length) return explicit.every(match => Number(match[1]) === exitCode);
  return exitCode === 0 && /(?:正常退出|\b(?:exits? normally|normal exit)\b)/iu.test(quote);
}

/** Compare literal, output-specific assertions. A token elsewhere in the
 * clause can describe the input, another branch or an unrelated number. */
function clauseGrounding(requirement, expected) {
  if (!requirement?.clauseComplete || requirement.conditionalContext) return;
  const { quote } = requirement;
  if (hasConditionalContext(quote)) return;
  if (/(?:不得|不能|不会|禁止|除非|例如|比如|示例|反例|否则|或者|\b(?:not|never|unless|example|e\.g\.|otherwise|or)\b)/iu.test(quote)) return;
  const exit = namesExitCode(quote, expected.exitCode);
  if (!Object.hasOwn(expected, "json")) return exit ? { kind: "clause", version: GROUNDING_VERSION, exit: true } : undefined;
  const inline = [...quote.matchAll(/(?:\b(?:returns?|outputs?|responds?\s+with)\s+(?:exactly\s+)?|返回\s*|输出\s*|响应(?:为|是)\s*)\x60([^\x60\r\n]+)\x60/giu)].flatMap(([, value]) => {
    try {
      const parsed = JSON.parse(value);
      return parsed !== null && typeof parsed === "object" ? [parsed] : [];
    } catch { return []; }
  });
  if (inline.length && inline.every(value => hasExpectedValue(value, expected))) {
    return { kind: "clause", version: GROUNDING_VERSION, field: true, exit };
  }
  const segments = pointerSegments(expected.pointer);
  // A leaf name does not establish the location of a nested JSON value.
  if (segments.length !== 1) return;
  const field = segments[0];
  if (/^(?:error|(?:error[_-]?)?code)$/iu.test(field) && typeof expected.json === "string" && !expected.operator) {
    const returned = [...quote.matchAll(/(?:\breturns?\s+|返回\s*|报(?:错|出)?\s*)\x60([a-z0-9]+(?:[-_][a-z0-9]+)+)\x60/giu)];
    if (returned.length && returned.every(([, code]) => code === expected.json)) {
      return { kind: "clause", version: GROUNDING_VERSION, field: true, exit };
    }
  }
  const operators = expected.operator === "at-most" ? "(?:at most|<=|≤|至多|不超过|上限(?:为|是)?)"
    : expected.operator === "at-least" ? "(?:at least|>=|≥|至少|不小于|下限(?:为|是)?)" : "(?:equals?|为|是|=)";
  const namedField = "(?:响应|输出|返回(?:值|的)?|\\b(?:response|output))\\s*(?:(?:字段|field)\\s*)?\\x60" +
    regexLiteral(field) + "\\x60";
  const mentions = [...quote.matchAll(new RegExp(namedField, "giu"))];
  if (mentions.length !== 1) return;
  const literal = regexLiteral(JSON.stringify(expected.json));
  const namedValue = new RegExp("^\\s*(?:is\\s+)?" + operators + "\\s*(?:\\x60" + literal +
    "\\x60|" + literal + "(?=$|[\\s,，;；:：!?！？。]|\\.(?![\\p{L}\\p{N}_.-])))", "iu");
  const [{ 0: mention, index }] = mentions;
  if (namedValue.test(quote.slice(index + mention.length))) return { kind: "clause", version: GROUNDING_VERSION, field: true, exit };
}

function sameRegisteredClause(requirement, registered) {
  return !!requirement && !!registered && keyOf(requirement.file) === keyOf(registered.file) &&
    requirement.start === registered.start && requirement.end === registered.end && requirement.quote === registered.quote;
}

function registeredGrounding(requirement, registered, expected) {
  if (requirement?.visibleClause && sameRegisteredClause(requirement, registered.requirement)) {
    return { kind: "registered-example", version: GROUNDING_VERSION, caseId: registered.id, exit: true, field: true };
  }
  if (!registered.requirement && expected.pointer !== undefined) return clauseGrounding(requirement, expected);
}

function parseRegisteredInput(stdin) {
  if (typeof stdin !== "string") return;
  try { return { json: JSON.parse(stdin) }; }
  catch { return undefined; }
}

/** The maintainer approves recipes. Models only supply data, and the
 * compiler recipe receives the exact signed filename as its only argument. */
export function reviewProbeRequest(args, frame, active, spec, architecture, requirement) {
  const { reviewRecipes, syntaxRecipe } = spec.codeTask.diagnostics ?? {};
  const { assertion, exampleId, file, recipe, stdin, expectedExitCode, expectedJson, expectedPointer, expectedOperator } = args;
  if (args.requirement !== undefined && (!requirement || assertion !== "runtime")) {
    throw new Error("条款引用仅用于 runtime，须为本角色已读的当前目标原文");
  }
  if (assertion === "architecture") {
    if ([file, recipe, stdin, expectedExitCode, expectedJson, expectedPointer, expectedOperator].some(value => value !== undefined)) {
      throw new Error("架构示例只填写 exampleId，输入和预期由已登记的架构稿提供");
    }
    const example = architecture?.examples?.cases.find(row => row.id === exampleId);
    if (!example) throw new Error("当前架构稿没有该可执行示例");
    return { type: assertion, exampleId, file: architecture.file, start: architecture.examples.start, end: architecture.examples.end,
      input: { recipe: example.recipe, ...(example.stdin === undefined ? {} : { stdin: example.stdin }) },
      expected: { exitCode: example.expectedExitCode,
        ...(Object.hasOwn(example, "expectedJson") ? { json: example.expectedJson } : {}) } };
  }
  if (!["runtime", "syntax"].includes(assertion) || assertion === "syntax" && exampleId !== undefined) {
    throw new Error("复核断言类型无效");
  }
  const source = relativeName(file);
  if (!includes(frame.reads, source) || !spec.codeTask.sources.includes(source) ||
    !active.codeIntake.qualification?.artifacts.some(row => row.path === source && row.sha256)) {
    throw new Error("复现须定位到当前签名且可读取的源码");
  }
  if (assertion === "syntax") {
    if (!syntaxRecipe || [recipe, stdin, expectedExitCode, expectedJson, expectedPointer, expectedOperator].some(value => value !== undefined)) {
      throw new Error("语法复核需要维护者登记编译配方，只填写当前源码 file");
    }
    return { type: assertion, file: source, input: { recipe: syntaxRecipe, args: [source] }, expected: { exitCode: 0 } };
  }
  if (exampleId !== undefined) {
    const registered = inputContractCases(spec.codeTask.diagnostics?.inputContracts).find(row => row.publicExample && row.id === exampleId);
    if (!registered || !reviewRecipes?.includes(registered.input.recipe) || registered.input.recipe === syntaxRecipe) {
      throw new Error("该行为复核示例未获授权");
    }
    if (recipe !== undefined || stdin !== undefined) throw new Error("登记示例使用已固定的配方和输入，请省略 recipe 和 stdin");
    if (expectedExitCode !== undefined && expectedExitCode !== registered.expected.exitCode) {
      throw new Error("预期退出码与已登记示例不一致");
    }
    const { exitCode, json } = registered.expected;
    const supplied = [expectedJson, expectedPointer, expectedOperator].some(value => value !== undefined);
    const expected = supplied ? runtimeExpectation({ ...args, expectedExitCode: exitCode }) : registered.expected;
    if (!Object.hasOwn(expected, "json") || !hasExpectedValue(json, expected)) {
      throw new Error("预期 JSON 或所选字段与已登记示例不一致");
    }
    const grounding = registeredGrounding(requirement, registered, expected);
    return { type: assertion, file: source, input: registered.input, expected, contractCase: exampleId,
      ...(requirement ? { requirement } : {}), ...(grounding ? { grounding } : {}) };
  }
  if (!reviewRecipes?.includes(recipe) || recipe === syntaxRecipe) throw new Error("该行为复核配方未获授权");
  if (!Number.isSafeInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 0xffffffff) {
    throw new Error("行为复核须先提供预期退出码 expectedExitCode");
  }
  const expected = runtimeExpectation(args, requirement);
  const input = { recipe, ...(stdin === undefined ? {} : { stdin }) };
  const structuredInput = parseRegisteredInput(stdin);
  // The recipe receives the bytes approved in the contract. JSON object order
  // and whitespace cannot make a caller accidentally run a different example.
  const candidates = structuredInput && requirement
    ? inputContractCases(spec.codeTask.diagnostics?.inputContracts).filter(row =>
      row.input.recipe === recipe && isDeepStrictEqual(structuredInput, parseRegisteredInput(row.input.stdin))) : [];
  const exact = candidates.find(row => sameRegisteredClause(requirement, row.requirement)) ?? candidates[0];
  const consistent = exact && exact.expected.exitCode === expected.exitCode &&
    (!Object.hasOwn(expected, "json") || hasExpectedValue(exact.expected.json, expected));
  // The project contract has priority over a model's proposed expectation for
  // the same input. An unrelated clause or a different expected response is advisory.
  const grounding = exact ? consistent && registeredGrounding(requirement, exact, expected)
    : clauseGrounding(requirement, expected);
  return { type: assertion, file: source, expected,
    ...(consistent && grounding?.kind === "registered-example" ? { input: exact.input, contractCase: exact.id } : { input }),
    ...(requirement ? { requirement } : {}), ...(grounding ? { grounding } : {}) };
}

export function reviewProbeId(binding, check) {
  return "probe-" + digest(JSON.stringify({ binding, check })).slice(0, 36);
}

/** An unavailable runner or clipped relevant output provides no verdict. */
export function compareReviewProbe(check, result) {
  if (check.type === "runtime" && check.grounding?.kind === "registered-example" &&
    result.status === "execution-timeout" && result.snapshotSha256) {
    return { outcome: "mismatch", actual: { status: "execution-timeout" } };
  }
  if (!["passed", "failed"].includes(result.status) || !result.probe) return { outcome: "unavailable" };
  const { exitCode, stdout, truncated } = result.probe;
  const actual = { exitCode };
  if (check.type === "syntax") {
    if (truncated || stdout === undefined) return { outcome: "unavailable" };
    let output;
    try { output = JSON.parse(stdout); }
    catch { return { outcome: "unavailable" }; }
    if (exitCode === 0 && output?.status === "parsed") return { outcome: "match", actual };
    if (exitCode === 1 && output?.status === "syntax-error" && Number.isSafeInteger(output.line) && output.line > 0) {
      return { outcome: "mismatch", actual: { ...actual, line: output.line } };
    }
    return { outcome: "unavailable" };
  }
  let match = exitCode === check.expected.exitCode;
  if (Object.hasOwn(check.expected, "json") && match) {
    if (truncated || stdout === undefined) return { outcome: "unavailable" };
    const { json, pointer, operator } = check.expected;
    try {
      const output = JSON.parse(stdout);
      const projected = pointer === undefined ? output : projectedOutput(output, pointer);
      if (projected === undefined) {
        const field = pointer === undefined ? undefined : pointerSegments(pointer).at(-1);
        if (check.requirement && !check.grounding?.field && !clauseLiterals(check.requirement).has(field)) {
          return { outcome: "unavailable", reason: "missing-unstated-field" };
        }
        actual.output = "missing-field";
      } else actual.json = projected;
    } catch { actual.output = "invalid-json"; }
    match = Object.hasOwn(actual, "json") && matchesValue(actual.json, { json, operator });
  }
  return { outcome: match ? "match" : "mismatch", actual };
}

export function reviewProbeRows(frame, active, binding) {
  const saved = active.codeReviewProbes;
  return saved?.actor === frame.agent.id && saved.serial === active.serial && saved.binding === binding ? saved.rows : [];
}

export function requireReviewProbeCapacity(rows, id, type) {
  // Required registered examples have their own slots. A reviewer can
  // exhaust exploratory runs without making a correct review impossible.
  if (type !== "architecture" && !rows.some(row => row.id === id) &&
    rows.filter(row => row.type !== "architecture").length >= 16) {
    throw new Error("当前核验已使用 16 次探索复现。已登记的架构示例仍可运行");
  }
}

export function saveReviewProbe(frame, active, binding, id, check, result) {
  const resultRow = compareReviewProbe(check, result);
  if (resultRow.outcome === "unavailable") return { id, ...resultRow };
  const rows = reviewProbeRows(frame, active, binding);
  const { input, expected, ...location } = check;
  const { outcome, actual } = resultRow;
  const pin = value => ({ exitCode: value.exitCode,
    ...(value.line ? { line: value.line } : {}),
    ...(value.status ? { status: value.status } : {}),
    ...(Object.hasOwn(value, "json") ? { jsonSha256: digest(JSON.stringify(value.json)) } : {}),
    ...(value.output ? { output: value.output } : {}) });
  // Keep potentially sensitive candidate stdout inside the current role's
  // tool response. The coordinator-visible receipt stores only its pin.
  // A JSON assertion cannot prove an unstated exit-code expectation. Record
  // that mismatch as an observation even if the clause establishes a field.
  const blocking = check.type !== "runtime" || !!(outcome === "mismatch" && (actual.status === "execution-timeout" ||
    (actual.exitCode !== expected.exitCode ? check.grounding?.exit : check.grounding?.field)));
  const summary = blocking && check.type === "runtime" ? runtimeProofSummary(expected, actual, pin(actual)) : undefined;
  const entry = { id, ...location, recipe: input.recipe, expected: pin(expected), outcome, actual: pin(actual),
    snapshotSha256: result.snapshotSha256, inputSha256: digest(JSON.stringify(input)),
    ...(check.type === "runtime" ? { blocking, ...(!blocking && outcome === "mismatch"
      ? { reason: "expectation-not-established-by-clause" } : {}) } : {}),
    ...(location.requirement && outcome === "mismatch" && blocking ? { replay: { input, expected }, summary } : {}) };
  requireReviewProbeCapacity(rows, id, check.type);
  active.codeReviewProbes = { actor: frame.agent.id, serial: active.serial, binding,
    rows: [...rows.filter(row => row.id !== id), entry] };
  frame.changed = true;
  return { ...entry, actual };
}

/** Keep runtime findings tied to host observations while avoiding disclosure
 * of arbitrary stdout in the persisted review receipt. */
function runtimeProofSummary(expected, actual, pin) {
  const { exitCode, pointer, operator } = expected;
  if (actual.status === "execution-timeout") {
    return { expected: "登记示例应在运行器执行限时内返回，退出码 " + exitCode, actual: "运行器确认执行超时" };
  }
  if (actual.exitCode !== exitCode || !Object.hasOwn(expected, "json")) {
    return { expected: "退出码 " + exitCode, actual: "实际退出码 " + actual.exitCode };
  }
  const target = pointer ? "JSON 字段 " + pointer : "完整 JSON 响应";
  const expectation = JSON.stringify(expected.json);
  const format = value => value.length <= 180 ? value : "SHA-256 " + digest(value);
  const relation = operator === "at-most" ? " ≤ " : operator === "at-least" ? " ≥ " : " = ";
  const observed = actual.output === "missing-field" ? "缺少字段" : actual.output === "invalid-json" ? "输出无法解析为 JSON"
    : typeof actual.json === "number" || typeof actual.json === "boolean" || actual.json === null ? String(actual.json)
      : "值摘要 SHA-256 " + pin.jsonSha256;
  return { expected: target + relation + format(expectation), actual: target + " 实测 " + observed };
}

export function isGroundedRuntimeProof(proof) {
  return proof?.type === "runtime" && proof.outcome === "mismatch" && proof.blocking === true &&
    !!proof.requirement && proof.grounding?.version === GROUNDING_VERSION && !!proof.replay && !!proof.summary;
}

/** A proof can only support a finding by this actor for the bound bytes. */
export function reviewReproduction(frame, active, binding, id, location) {
  const proof = reviewProbeRows(frame, active, binding).find(row => row.id === id);
  if (!proof || proof.type !== location.type || keyOf(proof.file) !== keyOf(location.file)) {
    throw new Error("复现证明不属于当前角色、签名版本或发现位置");
  }
  if (proof.outcome !== "mismatch") throw new Error("实际运行符合预期，不能将该复现作为退回理由");
  if (proof.type === "runtime" && !isGroundedRuntimeProof(proof)) {
    throw new Error("探索复现不能用于退回。使用明确约定该输出的当前条款或绑定条款的已登记示例，重跑实际复现");
  }
  if (proof.actual.line && (location.start > proof.actual.line || location.end < proof.actual.line) ||
    proof.exampleId && (location.end < proof.start || location.start > proof.end)) {
    throw new Error("发现位置未覆盖实际出错行或已登记示例");
  }
  return proof;
}
