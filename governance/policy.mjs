import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const AUTHORITY = "BUILDING-LOOP.json";
export const MANAGED = ".building-loop";
export const PHASES = ["intake", "first-review", "supplement", "final-review"];
const LIMIT = 256 * 1024;

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const keyOf = value => process.platform === "win32" ? value.toLowerCase() : value;

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

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

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

export function text(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function equal(left, right) {
  return left === null ? right === null : right !== null && left.equals(right);
}

export function replaceBytes(root, name, bytes, before) {
  const { file } = resolveFile(root, name, bytes !== null);
  if (bytes === null) {
    if (!equal(readBytes(root, name), before)) throw new Error("文件在写入前发生变化");
    if (before !== null) fs.unlinkSync(file);
    return;
  }
  if (bytes.length > LIMIT) throw new Error("内容超过受控工具的大小上限");
  const temp = path.join(path.dirname(file), ".building-loop-write-" + randomUUID());
  let staged = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    staged = true;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (!equal(readBytes(root, name), before)) throw new Error("文件在写入前发生变化");
    fs.renameSync(temp, file);
    staged = false;
  } finally { if (staged) fs.unlinkSync(temp); }
}

function pathList(value = []) {
  if (!Array.isArray(value) || value.length > 80) throw new Error("授权文件须为路径数组");
  const paths = value.map(item => relativeName(item));
  if (new Set(paths.map(keyOf)).size !== paths.length) throw new Error("授权文件路径重复");
  return paths;
}

function object(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + "须为对象");
  if (fields && Object.keys(value).some(name => !fields.includes(name))) throw new Error(label + "包含未知字段");
  return value;
}

function grants(value, label, fields = []) {
  object(value, label, ["read", "write", ...fields]);
  return { read: pathList(value.read), write: pathList(value.write) };
}

export function includes(paths, name) {
  return paths.some(item => keyOf(item) === keyOf(name));
}

export function authority(root) {
  const bytes = readBytes(root, AUTHORITY, 64 * 1024);
  if (!bytes) throw new Error("需要项目维护者配置 " + AUTHORITY);
  const source = object(JSON.parse(text(bytes)), "授权文件", ["spec", "instructions", "coordinator", "units"]);
  if (source.spec !== "building-loop/1") throw new Error("不支持的授权文件版本");
  const coordinator = grants(source.coordinator, "总控");
  const instructions = pathList(source.instructions);
  if (instructions.length > 3 || instructions.some(file => !includes(coordinator.read, file) || includes(coordinator.write, file))) {
    throw new Error("注入的项目规则须在总控只读授权中，最多三份");
  }
  const units = Object.create(null);
  const mutable = [...coordinator.write];
  const receiptsSeen = new Set();
  for (const [id, value] of Object.entries(object(source.units, "工作单元"))) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(id) || Object.keys(units).length >= 80) throw new Error("工作单元编号或数量无效");
    object(value, "工作单元", ["candidate", "claims", "continuation", "phases"]);
    const candidate = relativeName(value.candidate);
    const claims = value.claims ?? [];
    if (!Array.isArray(claims) || claims.length > 64 || claims.some(claim => typeof claim !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(claim))
      || new Set(claims).size !== claims.length) throw new Error("断言编号无效或重复");
    const continuation = value.continuation ?? "reuse";
    if (!["reuse", "fresh"].includes(continuation)) throw new Error("未知续派方式");
    const phases = Object.create(null);
    object(value.phases, "阶段", PHASES);
    for (const phase of PHASES) {
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
    if (includes(coordinator.write, candidate) || PHASES.some(phase => phases[phase].write.some(file => includes(coordinator.write, file)))) {
      throw new Error("总控和执行方的写入授权须分开");
    }
    mutable.push(...PHASES.flatMap(phase => phases[phase].write));
    units[id] = { candidate, claims, continuation, phases };
  }
  const protectedFiles = [...instructions, ...Object.values(units).flatMap(unit => [
    unit.phases["first-review"].receipt, unit.phases["final-review"].receipt,
    ...unit.phases["first-review"].evidence, ...unit.phases["final-review"].evidence,
  ])];
  if (mutable.some(file => includes(protectedFiles, file))) throw new Error("指令、原始证据和核验回执不能授予模型写权");
  return { hash: digest(bytes), coordinator, instructions, units };
}

export function replaceWithHistory(root, file, content, note, tag, markers) {
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
  const marker = keyOf(file);
  if (markers[marker] !== tag) {
    if (before) replaceBytes(root, backup, before, readBytes(root, backup));
    if (oldLog) {
      const logBackup = MANAGED + "/latest_backup/" + log;
      replaceBytes(root, logBackup, oldLog, readBytes(root, logBackup));
    }
  }
  replaceBytes(root, log, history, oldLog);
  try { replaceBytes(root, file, after, before); }
  catch (error) {
    replaceBytes(root, log, oldLog, history);
    throw error;
  }
  markers[marker] = tag;
  return { path: file, changed: true, sha256: digest(after), log, ...(before ? { backup } : {}) };
}
