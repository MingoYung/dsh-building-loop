const MAX_CASES = 24;
const MAX_JSON = 2048;
const MAX_STDIN = 8192;
const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;
const BOUNDARY_VALUES = Object.freeze({ array: [], object: {}, null: null, boolean: true, number: 0, string: "", missing: undefined });
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHARS = /[\x00-\x1f\x7f]/u;

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

function target(root, path) {
  let value = root;
  for (const segment of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value) !== (typeof segment === "number") ||
      !own(value, segment)) throw new Error("异常输入检查的路径在合法输入中不存在或路径类型不符");
    value = value[segment];
  }
  return value;
}

/** Authority only: a known-good JSON request and exact expected responses
 * define one-change checks. Defaults for a missing optional field therefore
 * remain under project authority, as does error precedence across fields. */
export function parseInputContracts(value, reviewRecipes, syntaxRecipe) {
  if (value === undefined) return;
  const invalid = () => new Error("异常输入契约须登记授权 JSON 配方、合法样例、路径、异常类型及明确预期");
  if (!Array.isArray(value) || !value.length || value.length > 8) throw invalid();
  const ids = new Set();
  let cases = 0;
  for (const row of value) {
    if (!object(row, ["id", "recipe", "seed", "expectedExitCode", "expectedJson", "checks"]) ||
      typeof row.id !== "string" || !CONTRACT_ID.test(row.id) || ids.has(row.id) ||
      !reviewRecipes?.includes(row.recipe) || row.recipe === syntaxRecipe || !own(row, "seed") ||
      !own(row, "expectedJson") || !boundedJson(row.seed, MAX_STDIN - 1) || !boundedJson(row.expectedJson, MAX_JSON) ||
      !validCode(row.expectedExitCode) || !Array.isArray(row.checks) || !row.checks.length || row.checks.length > MAX_CASES) throw invalid();
    ids.add(row.id);
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
  for (const { id, recipe, seed, expectedExitCode, expectedJson, checks } of contracts ?? []) {
    const add = (caseId, stdin, exitCode, json, shape) => {
      const input = { recipe, stdin: JSON.stringify(stdin) + "\n" };
      if (Buffer.byteLength(input.stdin) > MAX_STDIN) throw new Error("异常输入契约样例超过复现输入限制");
      result.push({ id: caseId, input, expected: { exitCode: exitCode ?? 0, json }, ...(shape ? { shape } : {}) });
    };
    add(id + ":seed", seed, expectedExitCode, expectedJson);
    for (const [index, check] of checks.entries()) {
      for (const type of check.invalid) {
        add(id + ":" + (index + 1) + ":" + type, mutate(seed, check.path, type), check.expectedExitCode,
          check.expectedJson, { path: check.path, type });
      }
    }
  }
  return result;
}
