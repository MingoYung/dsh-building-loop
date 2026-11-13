const MAX_CASES = 24;
const MAX_EXAMPLES = 8;
const MAX_JSON = 2048;
const MAX_STDIN = 8192;
const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;
const BOUNDARY_VALUES = Object.freeze({ array: [], object: {}, null: null, boolean: true, number: 0, string: "", missing: undefined });
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHARS = /[\x00-\x1f\x7f]/u;
const INVALID_STDIN_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

const own = (value, key) => value != null && Object.hasOwn(value, key);
const object = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => fields.includes(key));
const jsonType = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const validCode = value => value === undefined || Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const validSegment = segment => typeof segment === "string" && segment.length > 0 && segment.length <= 120 &&
  segment.isWellFormed() && !CONTROL_CHARS.test(segment) && !UNSAFE_KEYS.has(segment) || Number.isSafeInteger(segment) && segment >= 0;

function validJson(value, depth = 0) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.isWellFormed();
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || depth >= 24) return false;
  return Object.entries(value).every(([key, child]) => key.isWellFormed() && validJson(child, depth + 1));
}

function boundedJson(value, bytes) {
  return validJson(value) && Buffer.byteLength(JSON.stringify(value)) <= bytes;
}

function validRequirement(row) {
  return object(row, ["file", "start", "end", "quote"]) &&
    typeof row.file === "string" && row.file.length > 0 && row.file.length <= 500 &&
    Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) && row.start > 0 && row.end >= row.start &&
    row.end - row.start <= 64 && typeof row.quote === "string" && row.quote.trim() && row.quote.length <= 400 &&
    row.quote.isWellFormed();
}

function target(root, path) {
  let value = root;
  for (const segment of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value) !== (typeof segment === "number") ||
      !own(value, segment)) throw new Error("异常输入检查的路径在合法输入中不存在或路径类型不符");
    value = value[segment];
  }
  return value;
}

/** Authority only: single-field variants and exact public examples share one
 * isolated runner. Multi-item order and shared-dependency behavior need whole
 * examples because mutating one field cannot express every interaction. */
export function parseInputContracts(value, reviewRecipes, syntaxRecipe) {
  if (value === undefined) return;
  const invalid = () => new Error("异常输入契约须登记授权 JSON 配方和明确预期，可用合法样例加单字段变体，或登记完整公开示例");
  if (!Array.isArray(value) || !value.length || value.length > 8) throw invalid();
  const ids = new Set();
  let cases = 0, exampleCount = 0;
  for (const row of value) {
    if (!object(row, ["id", "recipe", "seed", "expectedExitCode", "expectedJson", "checks", "examples"]) ||
      typeof row.id !== "string" || !CONTRACT_ID.test(row.id) || ids.has(row.id) ||
      !reviewRecipes?.includes(row.recipe) || row.recipe === syntaxRecipe) throw invalid();
    ids.add(row.id);
    const { examples } = row;
    if (examples !== undefined) {
      if (!Array.isArray(examples) || !examples.length || examples.length > MAX_EXAMPLES) throw invalid();
      const exampleIds = new Set();
      for (const example of examples) {
        if (!object(example, ["id", "input", "stdin", "expectedJson", "expectedExitCode", "requirement"]) ||
          !CONTRACT_ID.test(typeof example.id === "string" ? example.id : "") || exampleIds.has(example.id) ||
          own(example, "input") === own(example, "stdin") ||
          (own(example, "input") ? !boundedJson(example.input, MAX_STDIN - 1) :
            typeof example.stdin !== "string" || !example.stdin.isWellFormed() ||
            INVALID_STDIN_CHARS.test(example.stdin) || Buffer.byteLength(example.stdin) > MAX_STDIN || !example.requirement) ||
          !own(example, "expectedJson") ||
          !boundedJson(example.expectedJson, MAX_JSON) || !validCode(example.expectedExitCode) ||
          example.requirement !== undefined && !validRequirement(example.requirement)) throw invalid();
        exampleIds.add(example.id);
        exampleCount++;
      }
    }
    const hasVariants = ["seed", "expectedExitCode", "expectedJson", "checks"].some(key => own(row, key));
    if (!hasVariants) {
      if (!examples) throw invalid();
      continue;
    }
    if (!own(row, "seed") || !own(row, "expectedJson") || !boundedJson(row.seed, MAX_STDIN - 1) ||
      !boundedJson(row.expectedJson, MAX_JSON) || !validCode(row.expectedExitCode) ||
      !Array.isArray(row.checks) || !row.checks.length || row.checks.length > MAX_CASES) throw invalid();
    cases++;
    const mutations = new Set();
    for (const check of row.checks) {
      if (!object(check, ["path", "invalid", "expectedExitCode", "expectedJson"]) ||
        !Array.isArray(check.path) || check.path.length > 8 || !check.path.every(validSegment) ||
        !Array.isArray(check.invalid) || !check.invalid.length || check.invalid.length > 7 ||
        !check.invalid.every(type => typeof type === "string" && own(BOUNDARY_VALUES, type)) ||
        !own(check, "expectedJson") || !boundedJson(check.expectedJson, MAX_JSON) || !validCode(check.expectedExitCode)) throw invalid();
      const original = target(row.seed, check.path);
      for (const type of check.invalid) {
        const key = JSON.stringify([check.path, type]);
        if (type === jsonType(original) || type === "missing" && (!check.path.length || typeof check.path.at(-1) === "number") ||
          mutations.has(key)) throw invalid();
        mutations.add(key);
        cases++;
      }
    }
  }
  if (cases > MAX_CASES) throw new Error("异常输入契约最多展开 24 条检查（含合法对照）");
  if (exampleCount > MAX_EXAMPLES) throw new Error("输入契约最多登记 8 条完整公开示例");
  inputContractCases(value);
  return value;
}

function mutate(seed, path, type) {
  const value = structuredClone(BOUNDARY_VALUES[type]);
  if (!path.length) return value;
  const changed = structuredClone(seed);
  const parent = target(changed, path.slice(0, -1));
  const field = path.at(-1);
  if (type === "missing") delete parent[field];
  else parent[field] = value;
  return changed;
}

/** Callers run these through the same exact-version, data-only diagnostic
 * recipe as other code reproductions. Only failed rows need to reach actors. */
export function inputContractCases(contracts) {
  const result = [];
  for (const { id, recipe, seed, expectedExitCode, expectedJson, checks, examples = [] } of contracts ?? []) {
    const add = (caseId, stdin, exitCode, json, details, raw = false) => {
      const input = { recipe, stdin: raw ? stdin : JSON.stringify(stdin) + "\n" };
      if (Buffer.byteLength(input.stdin) > MAX_STDIN) throw new Error("异常输入契约样例超过复现输入限制");
      result.push({ id: caseId, input, expected: { exitCode: exitCode ?? 0, json }, ...details });
    };
    if (checks) add(id + ":seed", seed, expectedExitCode, expectedJson);
    for (const [index, check] of (checks ?? []).entries()) {
      for (const type of check.invalid) {
        add(id + ":" + (index + 1) + ":" + type, mutate(seed, check.path, type), check.expectedExitCode,
          check.expectedJson, { shape: { path: check.path, type } });
      }
    }
    for (const example of examples) {
      const raw = own(example, "stdin");
      add(id + ":example:" + example.id, raw ? example.stdin : example.input, example.expectedExitCode, example.expectedJson,
        { publicExample: true, ...(raw ? { raw: true } : {}), ...(example.requirement ? { requirement: example.requirement } : {}) }, raw);
    }
  }
  return result;
}

/** Discovery exposes the owner-approved expectations without regenerating
 * or repeatedly transferring large request bodies to model sessions. */
export function publicInputExamples(contracts) {
  return inputContractCases(contracts).filter(row => row.publicExample)
    .map(({ id, input, expected, requirement }) => ({ id, recipe: input.recipe, expected, ...(requirement ? { requirement } : {}) }));
}
