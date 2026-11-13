import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { parseInputContracts } from "./input-contracts.mjs";
import { parseRecipeInputs } from "./diagnostic-recipe-inputs.mjs";

export const AUTHORITY = "BUILDING-LOOP.json";
export const MANAGED = ".building-loop";
const BASE_PHASES = ["intake", "first-review", "supplement", "final-review"];
export const PHASES = [...BASE_PHASES, "first-audit", "final-audit", "diagnosis"];
const LIMIT = 256 * 1024;

/** The workspace has no authority to grant any Building-loop project access. */
export class MissingProjectAuthority extends Error {
  constructor(root) {
    super(`当前工作区缺少 ${path.join(root, AUTHORITY)}。请切换到已配置的项目，或由维护者创建授权清单后重试。`);
    this.name = "MissingProjectAuthority";
  }
}

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const keyOf = value => process.platform === "win32" ? value.toLowerCase() : value;

/** 只接受普通项目相对路径，内部记录由宿主专用调用访问。 */
export function relativeName(value, internal = false) {
  if (typeof value !== "string" || !value || value.length > 500) throw new Error("需要明确的项目相对文件路径");
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[:*?"<>|\x00-\x1f]|[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error("拒绝绝对路径、通配符、路径别名和上级目录");
  }
  const first = parts[0].toLowerCase();
  if (!internal && [AUTHORITY.toLowerCase(), MANAGED, ".git"].includes(first)) throw new Error("授权文件和运行记录由宿主管理");
  return parts.join("/");
}

/** 文件不存在是可预期状态，其他读取错误向上保留。 */
function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** 解析真实工作区并防止项目范围覆盖 DSH 私人数据目录。 */
export function workspaceRoot(value, hostHome) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("请先选择本地项目目录");
  const root = fs.realpathSync.native(value);
  if (!stat(root)?.isDirectory()) throw new Error("工作区需要是本地目录");
  const home = fs.realpathSync.native(hostHome);
  const overlap = (a, b) => {
    const relative = path.relative(a, b);
    return relative === "" || !path.isAbsolute(relative) && !relative.startsWith(".." + path.sep) && relative !== "..";
  };
  if (overlap(root, home) || overlap(home, root)) throw new Error("工作区不能与 DSH 数据目录重叠");
  return root;
}

/** 逐段拒绝链接、硬链接和别名，创建父目录也走同一规则。 */
function resolveFile(root, name, createParents = false) {
  const parts = relativeName(name, true).split("/");
  let file = root;
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    const final = i === parts.length - 1;
    let entry = stat(file);
    if (!entry && !final && createParents) {
      try { fs.mkdirSync(file); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      entry = stat(file);
    }
    if (!entry) {
      if (!final) return { file: path.join(root, ...parts), entry: null };
      return { file, entry: null };
    }
    if (entry.isSymbolicLink() || keyOf(fs.realpathSync.native(file)) !== keyOf(file)
      || (final ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory())) {
      throw new Error("拒绝链接、硬链接、路径别名和非普通文件");
    }
  }
  return { file, entry: stat(file) };
}

/** 打开后再次核文件身份和大小，防止检查与读取之间被替换。 */
export function readBytes(root, name, limit = LIMIT) {
  const { file, entry } = resolveFile(root, name);
  if (!entry) return null;
  if (entry.size > limit) throw new Error("文件超过受控工具的大小上限");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1 || !opened.isFile() || opened.size > limit) {
      throw new Error("文件身份在读取前发生变化");
    }
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error("文件超过受控工具的大小上限");
    return bytes.subarray(0, size);
  } finally {
    fs.closeSync(fd);
  }
}

/** 严格解码 UTF-8，损坏字节需要修复后才能作为证据。 */
export function text(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** 比较文件当前版本，同时区分不存在和空文件。 */
export function equal(left, right) {
  return left === null ? right === null : right !== null && left.equals(right);
}

/** 同卷暂存、刷新、核改前版本后替换，失败清理暂存。 */
export function replaceBytes(root, name, bytes, before, limit = LIMIT) {
  const { file } = resolveFile(root, name, bytes !== null);
  if (bytes === null) {
    if (!equal(readBytes(root, name, limit), before)) throw new Error("文件在写入前发生变化");
    if (before !== null) fs.unlinkSync(file);
    return;
  }
  if (bytes.length > limit) throw new Error("内容超过受控工具的大小上限");
  const temp = path.join(path.dirname(file), ".building-loop-write-" + randomUUID());
  let staged = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    staged = true;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (!equal(readBytes(root, name, limit), before)) throw new Error("文件在写入前发生变化");
    fs.renameSync(temp, file);
    staged = false;
  } finally { if (staged) fs.unlinkSync(temp); }
}

/** 规范授权路径数组并拒绝重复登记。 */
function pathList(value = []) {
  if (!Array.isArray(value) || value.length > 80) throw new Error("授权文件须为路径数组");
  const paths = value.map(item => relativeName(item));
  if (new Set(paths.map(keyOf)).size !== paths.length) throw new Error("授权文件路径重复");
  return paths;
}

/** 清单结构只接受已定义字段，拼写错误须显式修正。 */
function object(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + "须为对象");
  if (fields && Object.keys(value).some(name => !fields.includes(name))) throw new Error(label + "包含未知字段");
  return value;
}

/** 把各角色读写权限解析成统一形式。 */
function grants(value, label, fields = []) {
  object(value, label, ["read", "write", ...fields]);
  return { read: pathList(value.read), write: pathList(value.write) };
}

/** 路径匹配遵循当前平台大小写规则，避免 Windows 别名绕过。 */
export function includes(paths, name) {
  return paths.some(item => keyOf(item) === keyOf(name));
}

export const hierarchyModuleId = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;

/** Resolve a module only through a trusted exact grant or the host's private namespace. */
export function hierarchyBodyPath(hierarchy, id, managed) {
  if (!hierarchy || typeof id !== "string" || !hierarchyModuleId.test(id)) throw new Error("模块编号须为不超过 40 字符的小写字母、数字和短横线");
  if (hierarchy.private && managed) return relativeName("modules/" + id + ".md");
  if (!Object.hasOwn(hierarchy.modules, id)) throw new Error("模块正文没有明确路径授权");
  return hierarchy.modules[id];
}

function hierarchyPolicy(value, coordinator, goalContext, protectedFiles, ledgerDocument) {
  object(value, "三级文件契约", ["overview", "index", "modules", "private"]);
  if (value.private !== undefined && value.private !== true) throw new Error("三级文件私有路径标记无效");
  const anchor = entry => {
    object(entry, "导航章节", ["path", "heading"]);
    const file = relativeName(entry.path);
    const { heading } = entry;
    if (!/\.md$/iu.test(file) || !includes(coordinator.read, file) || typeof heading !== "string" ||
      !heading.trim() || heading !== heading.trim() || heading.length > 80 || /[\x00-\x1f]/u.test(heading)) {
      throw new Error("导航章节须指定总控可读的 Markdown 文件和准确标题");
    }
    return { path: file, heading };
  };
  const overview = anchor(value.overview), index = anchor(value.index);
  if (!includes(goalContext, overview.path) || includes(goalContext, index.path) ||
    [overview.path, index.path].some(file => includes(protectedFiles, file) || file === ledgerDocument)) {
    throw new Error("一级总纲须在目标清单内，二级索引不得与目标、账本、指令、证据或回执重合");
  }
  const modules = Object.create(null);
  const declared = Object.entries(object(value.modules ?? {}, "模块路径授权"));
  if (declared.length > 40 || value.private && declared.length) throw new Error("模块路径授权数量或来源无效");
  for (const [id, name] of declared) {
    const file = relativeName(name);
    if (!hierarchyModuleId.test(id) || !/\.md$/iu.test(file) || !includes(coordinator.read, file) ||
      !includes(coordinator.write, file) || includes([...goalContext, index.path, ...protectedFiles, ...Object.values(modules)], file) ||
      ledgerDocument && includes([ledgerDocument], file)) throw new Error("模块正文须有唯一的总控精确读写授权且独立于中央文件");
    modules[id] = file;
  }
  return { overview, index, modules, private: value.private === true };
}

/** A named test or fixture cannot qualify as implementation work. */
export function isImplementationPath(file) {
  const parts = file.toLowerCase().split("/");
  const name = parts.pop();
  return !parts.some(part => /^(?:tests?|__tests__|specs?|fixtures?)$/u.test(part)) &&
    !/^(?:tests?|conftest|spec)(?:[._-]|$)|[._-](?:tests?|spec)\.[^.]+$/u.test(name) &&
    /\.(?:py|js|jsx|mjs|cjs|ts|tsx|mts|cts|go|rs|java|kt|cs|c|cc|cpp|h|hpp|rb|php|swift)$/u.test(name);
}

function testCaseIds(ids, minimum, maximum) {
  return Array.isArray(ids) && ids.length >= minimum && ids.length <= maximum &&
    ids.every(id => typeof id === "string" && id && id.length <= 120 && id.trim() === id && !/[\x00-\x1f]/u.test(id)) &&
    new Set(ids).size === ids.length;
}

function codeTaskPolicy(value, phases) {
  object(value, "代码任务契约", ["sources", "tests", "diagnostics"]);
  let diagnostics;
  if (value.diagnostics !== undefined) {
    const { checkSet, protocol, recipes, reviewRecipes, syntaxRecipe, inputContracts, recipeInputs } = object(value.diagnostics, "快速诊断授权",
      ["checkSet", "protocol", "recipes", "reviewRecipes", "syntaxRecipe", "inputContracts", "recipeInputs"]);
    const runnerId = id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id);
    if (!value.tests?.regression || !runnerId(checkSet) || protocol !== undefined && protocol !== 1 && protocol !== 2) {
      throw new Error("快速诊断须在签名回归契约中登记受信检查集编号");
    }
    if (recipes !== undefined && (protocol !== 2 || !Array.isArray(recipes) || recipes.length > 16 ||
      new Set(recipes).size !== recipes.length || !recipes.every(runnerId))) {
      throw new Error("复现配方须在第二版诊断契约中登记唯一的受信配方编号");
    }
    if (reviewRecipes !== undefined && (protocol !== 2 || !Array.isArray(reviewRecipes) || !reviewRecipes.length ||
      reviewRecipes.length > 16 || new Set(reviewRecipes).size !== reviewRecipes.length ||
      !reviewRecipes.every(id => runnerId(id) && recipes?.includes(id)))) {
      throw new Error("代码核验配方须为第二版诊断契约中已登记配方的唯一非空子集");
    }
    if (syntaxRecipe !== undefined && (!runnerId(syntaxRecipe) || !reviewRecipes?.includes(syntaxRecipe))) {
      throw new Error("语法配方须单独指定一个已授权的代码核验配方");
    }
    const input = parseInputContracts(inputContracts, reviewRecipes, syntaxRecipe);
    const inputShapes = parseRecipeInputs(recipeInputs, recipes, reviewRecipes, syntaxRecipe, input);
    diagnostics = { checkSet, ...(protocol === 2 ? { protocol, recipes: recipes ?? [],
      ...(reviewRecipes ? { reviewRecipes } : {}), ...(syntaxRecipe ? { syntaxRecipe } : {}) } : {}) };
    if (input) diagnostics.inputContracts = input;
    if (inputShapes) diagnostics.recipeInputs = inputShapes;
  }
  const sources = pathList(value.sources);
  const grants = value.tests?.regression ? [phases.intake, phases.supplement] : [phases.intake];
  if (!sources.length || sources.some(file => !isImplementationPath(file) ||
    !grants.some(grant => includes(grant.read, file) && includes(grant.write, file)))) {
    throw new Error("代码任务须登记执行阶段精确可读写的实现文件，不能用测试或文档充当实现");
  }
  if (value.tests === undefined) {
    if (sources.some(file => !/\.py$/iu.test(file))) throw new Error("未支持结构比较的实现文件须配置受信测试回执");
    return { sources };
  }
  const entry = object(value.tests, "受信测试契约", ["file", "publicKey", "previousSuiteSha256", "suiteSha256", "requiredCases", "regression"]);
  const file = relativeName(entry.file);
  const { publicKey, previousSuiteSha256, suiteSha256, requiredCases } = entry;
  if (!testCaseIds(requiredCases, 1, 80) || !/^[a-f0-9]{64}$/u.test(suiteSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(previousSuiteSha256 ?? "") || previousSuiteSha256 === suiteSha256) {
    throw new Error("受信测试须登记唯一的新增必测用例和不同的新旧测试套件 SHA-256");
  }
  try {
    const der = Buffer.from(publicKey, "base64");
    if (der.toString("base64") !== publicKey || der.length !== 44 ||
      createPublicKey({ key: der, type: "spki", format: "der" }).asymmetricKeyType !== "ed25519") throw new Error();
  } catch { throw new Error("受信测试须登记 Base64 编码的 Ed25519 SPKI 公钥"); }
  let regression;
  if (entry.regression !== undefined) {
    const definition = object(entry.regression, "代码回归契约", ["baselineFile", "previousCases", "inputs"]);
    const baselineFile = relativeName(definition.baselineFile);
    const { previousCases } = definition;
    const inputs = pathList(definition.inputs);
    if (!testCaseIds(previousCases, 0, 240) || previousCases.some(id => requiredCases.includes(id))) {
      throw new Error("代码回归契约须登记完整且不与新增必测用例重叠的旧测试编号");
    }
    regression = { baselineFile, previousCases, inputs };
  }
  return { sources, tests: { file, publicKey, previousSuiteSha256, suiteSha256, requiredCases, ...(regression ? { regression } : {}) },
    ...(diagnostics ? { diagnostics } : {}) };
}

/** 解析项目权威清单，核角色隔离、证据只读和来源凭据。 */
export function authority(root) {
  const bytes = readBytes(root, AUTHORITY, 64 * 1024);
  if (!bytes) throw new MissingProjectAuthority(root);
  return parseAuthority(bytes);
}

/** 新建授权也通过现有宿主解析器，写入前就检查角色隔离。 */
export function parseAuthority(bytes) {
  if (bytes.length > 64 * 1024) throw new Error("授权文件超过大小上限");
  const source = object(JSON.parse(text(bytes)), "授权文件", ["spec", "sessionOptIn", "instructions", "coordinator", "units", "sourcePins", "ledgerContext", "goalContext", "ledgerDocument", "requiredLinesGoal", "hierarchy"]);
  if (source.spec !== "building-loop/1") throw new Error("不支持的授权文件版本");
  if (source.sessionOptIn !== undefined && typeof source.sessionOptIn !== "boolean") throw new Error("sessionOptIn 须为布尔值");
  const coordinator = grants(source.coordinator, "总控");
  const ledgerContext = pathList(source.ledgerContext);
  if (ledgerContext.length > 3 || ledgerContext.some(file => !includes(coordinator.read, file))) throw new Error("账本现状依据须在总控读授权内，最多三份");
  const goalContext = pathList(source.goalContext ?? source.ledgerContext);
  if (goalContext.length > 3 || goalContext.some(file => !includes(coordinator.read, file))) throw new Error("项目目标须为总控可读的中央文件，最多三份");
  const requiredLinesGoal=source.requiredLinesGoal===undefined?undefined:relativeName(source.requiredLinesGoal);
  if(requiredLinesGoal&&!includes(goalContext,requiredLinesGoal))throw new Error("requiredLinesGoal 须指向 goalContext 中的目标文件");
  const instructions = pathList(source.instructions);
  if (instructions.length > 3 || instructions.some(file => !includes(coordinator.read, file) || includes(coordinator.write, file))) {
    throw new Error("注入的项目规则须在总控只读授权中，最多三份");
  }
  const units = Object.create(null);
  const architectureEntries = new Map();
  const mutable = [...coordinator.write];
  const receiptsSeen = new Set();
  for (const [id, value] of Object.entries(object(source.units, "工作单元"))) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(id) || Object.keys(units).length >= 80) throw new Error("工作单元编号或数量无效");
    object(value, "工作单元", ["candidate", "claims", "continuation", "phases", "calculations", "requireSourcePins", "covers", "plainLast", "cacheReadRotationThreshold", "codeTask", "architecture"]);
    if (value.architecture !== undefined) architectureEntries.set(id, value.architecture);
    if (value.plainLast !== undefined && typeof value.plainLast !== "boolean") throw new Error("plainLast 须为布尔值；非文字产物由项目维护者明确关闭");
    if (value.cacheReadRotationThreshold !== undefined && (!Number.isSafeInteger(value.cacheReadRotationThreshold) || value.cacheReadRotationThreshold < 1)) {
      throw new Error("cacheReadRotationThreshold 须为正整数；未配置时不按用量轮换");
    }
    if (value.requireSourcePins !== undefined && typeof value.requireSourcePins !== "boolean") throw new Error("requireSourcePins 须为布尔值");
    const candidate = relativeName(value.candidate);
    const covers = value.covers ?? [];
    if (!Array.isArray(covers) || covers.length > 80 || covers.some(id => typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))
      || new Set(covers).size !== covers.length) throw new Error("covers 须列出唯一的被替代账目编号");
    const claims = value.claims ?? [];
    if (!Array.isArray(claims) || claims.length > 64 || claims.some(claim => typeof claim !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(claim))
      || new Set(claims).size !== claims.length) throw new Error("断言编号无效或重复");
    const continuation = value.continuation ?? "reuse";
    if (!["reuse", "fresh"].includes(continuation)) throw new Error("未知续派方式");
    const phases = Object.create(null);
    object(value.phases, "阶段", BASE_PHASES);
    for (const phase of BASE_PHASES) {
      const review = phase.endsWith("review");
      const raw = value.phases[phase];
      const access = grants(raw, phase, review ? ["receipt", "evidence"] : []);
      if (!includes(access.read, candidate)) throw new Error("当前阶段需要候选文件读权");
      if (review) {
        if (access.write.length) throw new Error("核验方只读，回执由机制写入");
        const receipt = relativeName(raw.receipt);
        if (receiptsSeen.has(keyOf(receipt))) throw new Error("核验回执路径重复");
        receiptsSeen.add(keyOf(receipt));
        const evidence = pathList(raw.evidence);
        if (includes([...access.read, ...instructions], receipt)
          || evidence.some(file => !includes(access.read, file) || keyOf(file) === keyOf(candidate))) {
          throw new Error("核验回执与候选、证据和规则文件必须分开");
        }
        phases[phase] = { ...access, receipt, evidence };
      } else {
        phases[phase] = access;
      }
    }
    if (includes(coordinator.write, candidate) || BASE_PHASES.some(phase => phases[phase].write.some(file => includes(coordinator.write, file)))) {
      throw new Error("总控和执行方的写入授权须分开");
    }
    mutable.push(...BASE_PHASES.flatMap(phase => phases[phase].write));
    const calculations = Object.create(null);
    for (const [claim, formula] of Object.entries(object(value.calculations ?? {}, "复算规则"))) {
      if (!claims.includes(claim)) throw new Error("复算规则须绑定已登记的断言编号");
      object(formula, "复算规则", ["kind", "source", "keyColumn", "valueColumn", "before", "after", "decimals", "line", "sourceUnit", "units", "scope"]);
      const { kind, keyColumn, valueColumn, before, after, decimals = 2 } = formula;
      const source = relativeName(formula.source);
      if (kind === "source-number") {
        if (![undefined,"claim","document"].includes(formula.scope)
          || !Number.isSafeInteger(formula.line) || formula.line < 1 || typeof formula.sourceUnit !== "string" || !formula.sourceUnit.trim()
          || !Array.isArray(formula.units) || !formula.units.length || formula.units.length > 8
          || formula.units.some(unit => typeof unit !== "string" || !unit.trim() || unit.length > 40)
          || !includes(phases.supplement.read,source) || ["first-review","final-review"].some(phase=>!includes(phases[phase].evidence,source))) {
          throw new Error("原文数值核对须配置原文行、原文单位和等价交付单位，并授权各核验阶段读取");
        }
        calculations[claim] = { kind, source, line:formula.line, sourceUnit:formula.sourceUnit, units:formula.units, scope:formula.scope ?? "claim" };
        continue;
      }
      if (kind !== "percent-decrease" || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 6
        || [keyColumn, valueColumn, before, after].some(item => typeof item !== "string" || !item.trim() || item.length > 80)
        || keyColumn === valueColumn || before === after) throw new Error("无效的 CSV 降幅复算规则");
      if (!includes(phases.supplement.read, source) || !includes(phases["final-review"].evidence, source)) {
        throw new Error("复算原始文件须在补查读授权和终审证据授权内");
      }
      calculations[claim] = { kind, source, keyColumn, valueColumn, before, after, decimals };
    }
    const codeTask = value.codeTask === undefined ? undefined : codeTaskPolicy(value.codeTask, phases);
    units[id] = { candidate, claims, continuation, phases, calculations, covers,
      requireSourcePins: value.requireSourcePins === true, plainLast: value.plainLast !== false,
      cacheReadRotationThreshold: value.cacheReadRotationThreshold, ...(codeTask ? { codeTask } : {}) };
  }
  const sourcePins = Object.create(null);
  for (const [path, entry] of Object.entries(object(source.sourcePins ?? {}, "来源凭据"))) {
    const file = relativeName(path);
    object(entry, "来源凭据", ["sha256", "kind", "locator", "observation"]);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") || !["primary", "secondary", "synthetic"].includes(entry.kind)
      || typeof entry.locator !== "string" || !entry.locator.trim() || entry.locator.length > 1000) throw new Error("来源凭据需要原始摘要、类型和可追查位置");
    if (sourcePins[keyOf(file)]) throw new Error("来源凭据路径重复");
    let observation;
    if (entry.observation !== undefined) {
      object(entry.observation, "获取回执凭据", ["file", "sha256"]);
      const receipt = relativeName(entry.observation.file);
      if (entry.kind === "synthetic" || !/^https?:\/\//i.test(entry.locator.trim())
        || keyOf(receipt) === keyOf(file) || receiptsSeen.has(keyOf(receipt))
        || Object.values(units).some(unit => keyOf(unit.candidate) === keyOf(receipt))
        || !/^[a-f0-9]{64}$/.test(entry.observation.sha256 ?? "")) {
        throw new Error("获取回执须为独立登记的只读文件，提供 SHA-256，不能由候选或验收回执自证");
      }
      observation = { file: receipt, sha256: entry.observation.sha256 };
    }
    sourcePins[keyOf(file)] = { sha256: entry.sha256, kind: entry.kind, locator: entry.locator.trim(), ...(observation ? { observation } : {}) };
  }
  for (const unit of Object.values(units)) {
    if (unit.requireSourcePins && ["first-review", "final-review"].some(phase =>
      unit.phases[phase].evidence.some(file => !sourcePins[keyOf(file)]))) throw new Error("本单元要求每份原始证据登记来源凭据");
  }
  const protectedFiles = [...instructions, ...Object.values(sourcePins).flatMap(pin => pin.observation ? [pin.observation.file] : []), ...Object.values(units).flatMap(unit => [
    unit.phases["first-review"].receipt, unit.phases["final-review"].receipt,
    ...unit.phases["first-review"].evidence, ...unit.phases["final-review"].evidence,
  ])];
  if (mutable.some(file => includes(protectedFiles, file))) throw new Error("指令、原始证据和核验回执不能授予模型写权");
  if(requiredLinesGoal&&includes(mutable,requiredLinesGoal))throw new Error("requiredLinesGoal 须对总控和执行、核验角色只读");
  if (Object.values(units).some(unit => includes(goalContext, unit.candidate)
    || Object.values(unit.phases).some(phase => phase.write.some(file => includes(goalContext,file))
      || phase.receipt && includes(goalContext,phase.receipt) || phase.evidence?.some(file => includes(goalContext,file))))) {
    throw new Error("目标文件须与候选、模块写入、证据和回执分开");
  }
  // The optional ledger projection is an explicitly authorized host document,
  // never an inferred filename or a source that can justify its own dispositions.
  const ledgerDocument=source.ledgerDocument===undefined?undefined:relativeName(source.ledgerDocument);
  if(ledgerDocument&&(!includes(coordinator.write,ledgerDocument)
    ||includes([...goalContext,...ledgerContext,...protectedFiles,...Object.values(units).map(unit=>unit.candidate)],ledgerDocument))) {
    throw new Error("ledgerDocument 须在 coordinator.write 精确授权，并与目标、现状依据、指令、候选、来源及验收回执分开");
  }
  const modelFiles = [...coordinator.read, ...mutable, ...protectedFiles, ...goalContext, ...ledgerContext,
    ...Object.values(units).flatMap(unit => Object.values(unit.phases).flatMap(grant => grant.read))];
  const testProofPaths = Object.values(units).flatMap(unit => {
    const tests = unit.codeTask?.tests;
    return tests ? [tests.file, ...(tests.regression ? [tests.regression.baselineFile] : [])] : [];
  });
  const testInputs = Object.values(units).flatMap(unit => unit.codeTask?.tests?.regression?.inputs ?? []);
  if (new Set(testProofPaths.map(keyOf)).size !== testProofPaths.length ||
    testProofPaths.some(file => includes([...modelFiles, ...testInputs], file))) {
    throw new Error("受信测试回执须是唯一的宿主读取路径，不得进入模型授权或作为证据");
  }
  // Auditors inherit only the relevant candidate/evidence read scope. Review receipts
  // are removed, so an independent pass cannot read the first model's verdict.
  for (const unit of Object.values(units)) for (const prefix of ["first", "final"]) {
    const grant = unit.phases[prefix + "-review"];
    unit.phases[prefix + "-audit"] = { ...grant, write: [], read: grant.read.filter(file => !receiptsSeen.has(keyOf(file))) };
  }
  const hierarchy = source.hierarchy === undefined ? undefined : hierarchyPolicy(source.hierarchy, coordinator, goalContext, protectedFiles, ledgerDocument);
  const managedImportSections = new Map();
  for (const [id, entry] of architectureEntries) {
    object(entry, "架构验收", ["module", "headings", "importsHeading", "examplesHeading"]);
    const file = hierarchyBodyPath(hierarchy, entry.module, false);
    const unit = units[id];
    const review = [unit.phases["first-review"], unit.phases["final-review"]];
    const editable = [...unit.phases.intake.write, ...unit.phases.supplement.write];
    if (!goalContext.length || hierarchy.private || !unit.codeTask?.tests?.regression || unit.plainLast || unit.claims.length ||
      unit.requireSourcePins || Object.keys(sourcePins).length || requiredLinesGoal ||
      review.some(grant => !includes(grant.read, file) || grant.evidence.length || editable.some(path => !includes(grant.read, path))) ||
      editable.some(path => !isImplementationPath("reviewed" + path.slice(path.lastIndexOf("."))))) {
      throw new Error("架构验收须登记三级项目中的签名纯代码单元，架构由总控写且两道核验可精确读取");
    }
    const headings = entry.headings;
    if (!Array.isArray(headings) || !headings.length || headings.length > 12 || new Set(headings).size !== headings.length ||
      headings.some(heading => typeof heading !== "string" || !heading.trim() || heading !== heading.trim() || heading.length > 80 || /[\x00-\x1f]/u.test(heading))) {
      throw new Error("架构验收须明确登记 1 至 12 个唯一正文标题");
    }
    const importsHeading = entry.importsHeading;
    if (importsHeading !== undefined && (typeof importsHeading !== "string" || !importsHeading.trim() ||
      importsHeading !== importsHeading.trim() || importsHeading.length > 80 || /[\x00-\x1f]/u.test(importsHeading) ||
      headings.includes(importsHeading) || unit.codeTask.sources.some(source => !/\.py$/iu.test(source)))) {
      throw new Error("静态导入章节须独立于人工核验标题，且当前只支持登记的 Python 源码");
    }
    const examplesHeading = entry.examplesHeading;
    const diagnostics = unit.codeTask.diagnostics;
    // Executable examples use the maintainer's data-only recipe grants; a
    // compiler recipe accepts a source location and is never an example entry.
    if (examplesHeading !== undefined && (!headings.includes(examplesHeading) || examplesHeading === importsHeading ||
      !diagnostics?.reviewRecipes?.some(recipe => recipe !== diagnostics.syntaxRecipe))) {
      throw new Error("架构示例须指定一个已登记的人工核验章节，并明确授权第二版诊断中的运行配方");
    }
    if (managedImportSections.has(keyOf(file)) && managedImportSections.get(keyOf(file)) !== importsHeading) {
      throw new Error("共用架构稿的工程单元须使用相同的宿主静态导入章节");
    }
    managedImportSections.set(keyOf(file), importsHeading);
    unit.architecture = { file, headings, ...(importsHeading ? { importsHeading } : {}), ...(examplesHeading ? { examplesHeading } : {}) };
  }
  return { hash: digest(bytes), sessionOptIn: source.sessionOptIn === true, coordinator, instructions, units, sourcePins, ledgerContext, goalContext, ledgerDocument, requiredLinesGoal, hierarchy };
}

/** Return only the managed history paths derived from an exact project file. */
export function historyPaths(file) {
  const log = MANAGED + "/changes/" + file + ".md";
  return { log, backup: MANAGED + "/latest_backup/" + file, logBackup: MANAGED + "/latest_backup/" + log };
}

/** Match every literal fragment against the same original UTF-8 file. */
export function scopedEditContent(before, { beforeSha256, oldText, newText, edits }, recordSplice) {
  if (before === null) throw new Error("局部编辑只适用于已有文件，新建文件请用 write");
  const currentSha256 = digest(before);
  if (currentSha256 !== beforeSha256) {
    throw new Error("局部编辑的文件摘要不匹配（stale-source，当前摘要 " + currentSha256 + "）。请先用 read 读取当前文件再重试");
  }
  if (edits !== undefined && (oldText !== undefined || newText !== undefined)) {
    throw new Error("局部编辑须使用 oldText/newText 或 edits，不能同时使用");
  }
  const replacements = edits ?? [{ oldText, newText }];
  if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 32) {
    throw new Error("一次局部编辑须提供 1 到 32 项替换");
  }
  // Keep the BOM and existing line endings outside the explicitly replaced spans.
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before);
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const current = decoded.slice(bom.length);
  // read returns numbered lines. Match those lines in the file's CRLF form when it has uniform CRLF.
  const crlf = current.includes("\r\n") && !/(?<!\r)\n|\r(?!\n)/u.test(current);
  const fileNewlines = value => crlf ? value.replace(/\r?\n/gu, "\r\n") : value;
  const ranges = replacements.map((row, index) => {
    const old = row?.oldText, next = row?.newText;
    if (typeof old !== "string" || typeof next !== "string" || !old.isWellFormed() || !next.isWellFormed() ||
        (!old && (current || replacements.length !== 1))) {
      throw new Error("第 " + (index + 1) + " 项须提供 oldText 和 newText；仅空文件允许空 oldText");
    }
    const from = fileNewlines(old);
    const start = current.indexOf(from);
    const duplicate = start >= 0 && from !== "" && current.indexOf(from, start + 1) !== -1;
    if (start < 0 || duplicate) {
      const recovery = start < 0 ? "anchor-not-found：逐字复制当前 read 返回的一个较短片段"
        : "anchor-ambiguous：在当前 read 返回的范围内加一行相邻原文，使片段唯一";
      throw new Error("第 " + (index + 1) + " 项 oldText 须在当前文件中恰好出现一次。"
        + recovery + "。本次未落盘，未运行检查。");
    }
    return { start, end: start + from.length, to: fileNewlines(next) };
  }).sort((a, b) => a.start - b.start);
  const pieces = [];
  const untouched = [];
  let cursor = 0, position = 0;
  function keepThrough(end) {
    if (end === cursor) return;
    const kept = current.slice(cursor, end);
    pieces.push(kept);
    untouched.push({ oldStart: cursor, newStart: position, newEnd: position + kept.length });
    position += kept.length;
  }
  for (const { start, end, to } of ranges) {
    if (start < cursor) throw new Error("同一次局部编辑的替换范围不能重叠");
    keepThrough(start);
    pieces.push(to);
    position += to.length;
    cursor = end;
  }
  keepThrough(current.length);
  const after = pieces.join("");
  recordSplice?.({ before: current, after, beforeSha256, untouched });
  return bom + after;
}

/** Plan or publish the same bounded document, rolling backup and history bytes. */
export function replaceWithHistory(root, file, content, note, tag, markers, stage) {
  const before = readBytes(root, file);
  const after = Buffer.from(typeof content === "function" ? content(before) : content, "utf8");
  if (equal(before, after)) return { path: file, changed: false, sha256: digest(after) };
  const { log, backup, logBackup } = historyPaths(file);
  const oldLog = readBytes(root, log);
  const summary = note.trim().replace(/\s+/g, " ").slice(0, 500);
  const record = "- " + new Date().toISOString() + " " + tag + " " + summary + " SHA-256 " + digest(after) + "\n";
  const history = Buffer.from(record + (oldLog ? text(oldLog) : ""), "utf8");
  if (history.length > LIMIT || after.length > LIMIT) throw new Error("内容或更新日志超过受控工具的大小上限");
  // Generated ledger exports register all byte pairs before any of these
  // targets are changed. Ordinary controlled file writes keep their own path.
  const writes = [];
  const marker = keyOf(file);
  if (markers[marker] !== tag) {
    if (before) writes.push({ file: backup, before: readBytes(root, backup), after: before });
    if (oldLog) writes.push({ file: logBackup, before: readBytes(root, logBackup), after: oldLog });
  }
  if (stage) stage([...writes, { file: log, before: oldLog, after: history }, { file, before, after }]);
  else {
    for (const write of writes) replaceBytes(root, write.file, write.after, write.before);
    replaceBytes(root, log, history, oldLog);
    try { replaceBytes(root, file, after, before); }
    catch (error) { replaceBytes(root, log, oldLog, history); throw error; }
  }
  markers[marker] = tag;
  return { path: file, changed: true, sha256: digest(after), log, ...(before ? { backup } : {}) };
}
