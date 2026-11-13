const STDIN_MODES = ["forbidden", "optional", "required"];
const ARGUMENT_TYPES = ["text", "source"];
const shape = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));
const between = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** A registered shape only restricts data sent to an already approved recipe. */
export function parseRecipeInputs(value, recipes, reviewRecipes, syntaxRecipe, inputContracts) {
  if (value === undefined) return;
  const invalid = () => new Error("recipeInputs 须为第二版已授权配方登记 argv 类型、最少参数、stdin 模式及样例文件数量");
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw invalid();
  const rules = Object.entries(value).map(([recipe, row]) => {
    if (!recipes?.includes(recipe) || !shape(row, ["args", "stdin", "files"]) || !STDIN_MODES.includes(row.stdin) ||
      !shape(row.args, ["types", "min"]) || !Array.isArray(row.args.types) || row.args.types.length > 24 ||
      !row.args.types.every(type => ARGUMENT_TYPES.includes(type)) || !between(row.args.min, 0, row.args.types.length) ||
      !shape(row.files, ["min", "max"]) || !between(row.files.max, 0, 12) || !between(row.files.min, 0, row.files.max)) throw invalid();
    const syntax = recipe === syntaxRecipe;
    if (syntax && (row.args.min !== 1 || row.args.types.length !== 1 || row.args.types[0] !== "source" ||
        row.stdin !== "forbidden" || row.files.max !== 0) ||
      !syntax && reviewRecipes?.includes(recipe) && (row.args.min > 0 || row.files.min > 0) ||
      inputContracts?.some(contract => contract.recipe === recipe) && row.stdin === "forbidden") {
      throw new Error("recipeInputs 与当前编译、独立核验或异常输入配方的调用方式冲突：" + recipe);
    }
    return [recipe, { args: { min: row.args.min, types: [...row.args.types] }, stdin: row.stdin,
      files: { min: row.files.min, max: row.files.max } }];
  });
  return Object.fromEntries(rules);
}

export class DiagnosticRecipeInputError extends Error {
  constructor(recipe, field, expected, message) {
    super(message);
    this.result = { status: "invalid-input", reason: "recipe-input-invalid", recipe, field, expected, message };
  }
}

/** The role's actual snapshot source names are the only valid source arguments. */
export function validateRecipeInputs(probe, expected, authorizedSources) {
  if (!expected) return;
  const reject = (field, message) => { throw new DiagnosticRecipeInputError(probe.recipe, field, expected, message); };
  const { args = [], stdin, files = [] } = probe;
  if (!between(args.length, expected.args.min, expected.args.types.length)) {
    reject("args", "参数数量须为 " + expected.args.min + "–" + expected.args.types.length + "。");
  }
  const invalidSource = args.findIndex((argument, index) => expected.args.types[index] === "source" && !authorizedSources.includes(argument));
  if (invalidSource >= 0) reject("args", "第 " + (invalidSource + 1) + " 个参数须为当前授权快照的实际源码路径。");
  if (expected.stdin === "forbidden" && stdin !== undefined) reject("stdin", "此配方不接受 stdin，请省略该字段。");
  if (expected.stdin === "required" && stdin === undefined) reject("stdin", "此配方须提供 stdin。空文本可用空字符串表示。");
  if (!between(files.length, expected.files.min, expected.files.max)) {
    reject("files", "样例文件数量须为 " + expected.files.min + "–" + expected.files.max + "。");
  }
}

/** Reuse the same shape in discovery and in argument-correction results. */
export function visibleRecipeInputs(diagnostics, recipes = diagnostics?.recipes) {
  const entries = Object.entries(diagnostics?.recipeInputs ?? {}).filter(([recipe]) => recipes?.includes(recipe));
  return entries.length ? Object.fromEntries(entries) : undefined;
}
