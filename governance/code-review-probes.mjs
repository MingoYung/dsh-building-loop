import { isDeepStrictEqual } from "node:util";
import { digest, includes, keyOf, relativeName } from "./policy.mjs";

function expectedOutput(value) {
  if (value === undefined) return {};
  if (typeof value !== "string" || Buffer.byteLength(value) > 2048) throw new Error("expectedJson 须为不超过 2 KiB 的 JSON 文本");
  try { return { json: JSON.parse(value) }; }
  catch { throw new Error("expectedJson 不是有效 JSON"); }
}

// Restrict a grounded comparison to the behavior actually asserted. Bare
// exploratory probes retain their full-JSON comparison for older callers.
function runtimeExpectation({ expectedExitCode, expectedJson, expectedPointer, expectedOperator }, requirement) {
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

function projectedOutput(value, pointer) {
  for (const field of pointerSegments(pointer)) {
    if (!value || typeof value !== "object" || Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(field) ||
      !Object.hasOwn(value, field)) return undefined;
    value = value[field];
  }
  return value;
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
  if (!["runtime", "syntax"].includes(assertion) || exampleId !== undefined) throw new Error("复核断言类型无效");
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
  if (!reviewRecipes?.includes(recipe) || recipe === syntaxRecipe) throw new Error("该行为复核配方未获授权");
  if (!Number.isSafeInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 0xffffffff) {
    throw new Error("行为复核须先提供预期退出码 expectedExitCode");
  }
  const expected = runtimeExpectation(args, requirement);
  return { type: assertion, file: source, input: { recipe, ...(stdin === undefined ? {} : { stdin }) }, expected,
    ...(requirement ? { requirement } : {}) };
}

export function reviewProbeId(binding, check) {
  return "probe-" + digest(JSON.stringify({ binding, check })).slice(0, 36);
}

/** An unavailable runner or clipped relevant output provides no verdict. */
export function compareReviewProbe(check, result) {
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
        const field = pointerSegments(pointer).at(-1);
        if (check.requirement && !clauseLiterals(check.requirement).has(field)) return { outcome: "unavailable", reason: "missing-unstated-field" };
        actual.output = "missing-field";
      } else actual.json = projected;
    } catch { actual.output = "invalid-json"; }
    match = Object.hasOwn(actual, "json") && (operator === "at-most" ? Number.isFinite(actual.json) && actual.json <= json :
      operator === "at-least" ? Number.isFinite(actual.json) && actual.json >= json : isDeepStrictEqual(actual.json, json));
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
    ...(Object.hasOwn(value, "json") ? { jsonSha256: digest(JSON.stringify(value.json)) } : {}),
    ...(value.output ? { output: value.output } : {}) });
  // Keep potentially sensitive candidate stdout inside the current role's
  // tool response. The coordinator-visible receipt stores only its pin.
  const entry = { id, ...location, recipe: input.recipe, expected: pin(expected), outcome, actual: pin(actual),
    snapshotSha256: result.snapshotSha256, inputSha256: digest(JSON.stringify(input)),
    ...(location.requirement && outcome === "mismatch" ? { replay: { input, expected } } : {}) };
  requireReviewProbeCapacity(rows, id, check.type);
  active.codeReviewProbes = { actor: frame.agent.id, serial: active.serial, binding,
    rows: [...rows.filter(row => row.id !== id), entry] };
  frame.changed = true;
  return { ...entry, actual };
}

/** A proof can only support a finding by this actor for the bound bytes. */
export function reviewReproduction(frame, active, binding, id, location) {
  const proof = reviewProbeRows(frame, active, binding).find(row => row.id === id);
  if (!proof || proof.type !== location.type || keyOf(proof.file) !== keyOf(location.file)) {
    throw new Error("复现证明不属于当前角色、签名版本或发现位置");
  }
  if (proof.outcome !== "mismatch") throw new Error("实际运行符合预期，不能将该复现作为退回理由");
  if (proof.type === "runtime" && (!proof.requirement || !proof.replay)) {
    throw new Error("探索复现不能用于退回。先用已读条款原文和可观察预期重新执行 runtime probe");
  }
  if (proof.actual.line && (location.start > proof.actual.line || location.end < proof.actual.line) ||
    proof.exampleId && (location.end < proof.start || location.start > proof.end)) {
    throw new Error("发现位置未覆盖实际出错行或已登记示例");
  }
  return proof;
}
