import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const AUTHORITY = "BUILDING-LOOP.json";
export const MANAGED = ".building-loop";
const BASE_PHASES = ["intake", "first-review", "supplement", "final-review"];
export const PHASES = [...BASE_PHASES, "first-audit", "final-audit"];
const LIMIT = 256 * 1024;

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

/** 解析项目权威清单，核角色隔离、证据只读和来源凭据。 */
export function authority(root) {
  const bytes = readBytes(root, AUTHORITY, 64 * 1024);
  if (!bytes) throw new Error("需要项目维护者配置 " + AUTHORITY);
  const source = object(JSON.parse(text(bytes)), "授权文件", ["spec", "instructions", "coordinator", "units", "sourcePins", "ledgerContext", "goalContext", "ledgerDocument"]);
  if (source.spec !== "building-loop/1") throw new Error("不支持的授权文件版本");
  const coordinator = grants(source.coordinator, "总控");
  const ledgerContext = pathList(source.ledgerContext);
  if (ledgerContext.length > 3 || ledgerContext.some(file => !includes(coordinator.read, file))) throw new Error("账本现状依据须在总控读授权内，最多三份");
  const goalContext = pathList(source.goalContext ?? source.ledgerContext);
  if (goalContext.length > 3 || goalContext.some(file => !includes(coordinator.read, file))) throw new Error("项目目标须为总控可读的中央文件，最多三份");
  const instructions = pathList(source.instructions);
  if (instructions.length > 3 || instructions.some(file => !includes(coordinator.read, file) || includes(coordinator.write, file))) {
    throw new Error("注入的项目规则须在总控只读授权中，最多三份");
  }
  const units = Object.create(null);
  const mutable = [...coordinator.write];
  const receiptsSeen = new Set();
  for (const [id, value] of Object.entries(object(source.units, "工作单元"))) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(id) || Object.keys(units).length >= 80) throw new Error("工作单元编号或数量无效");
    object(value, "工作单元", ["candidate", "claims", "continuation", "phases", "calculations", "requireSourcePins", "covers", "plainLast", "cacheReadRotationThreshold"]);
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
    units[id] = { candidate, claims, continuation, phases, calculations, covers,
      requireSourcePins: value.requireSourcePins === true, plainLast: value.plainLast !== false,
      cacheReadRotationThreshold: value.cacheReadRotationThreshold };
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
  // Auditors inherit only the relevant candidate/evidence read scope. Review receipts
  // are removed, so an independent pass cannot read the first model's verdict.
  for (const unit of Object.values(units)) for (const prefix of ["first", "final"]) {
    const grant = unit.phases[prefix + "-review"];
    unit.phases[prefix + "-audit"] = { ...grant, write: [], read: grant.read.filter(file => !receiptsSeen.has(keyOf(file))) };
  }
  return { hash: digest(bytes), coordinator, instructions, units, sourcePins, ledgerContext, goalContext, ledgerDocument };
}

/** 受控写入事务维护正文、单份改前备份和逐文件更新记录。 */
export function replaceWithHistory(root, file, content, note, tag, markers, rollback) {
  const before = readBytes(root, file);
  const after = Buffer.from(content, "utf8");
  if (equal(before, after)) return { path: file, changed: false, sha256: digest(after) };
  const log = MANAGED + "/changes/" + file + ".md";
  const backup = MANAGED + "/latest_backup/" + file;
  const oldLog = readBytes(root, log);
  const summary = note.trim().replace(/\s+/g, " ").slice(0, 500);
  const record = "- " + new Date().toISOString() + " " + tag + " " + summary + " SHA-256 " + digest(after) + "\n";
  const history = Buffer.from(record + (oldLog ? text(oldLog) : ""), "utf8");
  if (history.length > LIMIT || after.length > LIMIT) throw new Error("内容或更新日志超过受控工具的大小上限");
  // Optional compensation joins a generated projection to its surrounding host
  // state transaction. Each undo requires our exact written bytes, so a concurrent
  // external edit is reported rather than silently overwritten during recovery.
  const write=(name,value,previous)=>{
    replaceBytes(root,name,value,previous);
    rollback?.push(()=>replaceBytes(root,name,previous,value));
  };
  const marker = keyOf(file);
  if (markers[marker] !== tag) {
    if (before) write(backup,before,readBytes(root,backup));
    if (oldLog) {
      const logBackup = MANAGED + "/latest_backup/" + log;
      write(logBackup,oldLog,readBytes(root,logBackup));
    }
  }
  write(log,history,oldLog);
  try { write(file,after,before); }
  catch (error) {
    if(!rollback)replaceBytes(root,log,oldLog,history);
    throw error;
  }
  markers[marker] = tag;
  return { path: file, changed: true, sha256: digest(after), log, ...(before ? { backup } : {}) };
}
