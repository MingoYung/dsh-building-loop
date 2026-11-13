import fs from "node:fs";
import path from "node:path";
import { digest, keyOf, readBytes, replaceBytes, text } from "./policy.mjs";
import { checkedEngineeringCheckpoint, ownerEngineeringReplacement, ownerEngineeringUnit } from "./engineering-handoff.mjs";
import { withWorkspaceLock } from "./transactions.mjs";

const SPEC = "building-loop-conversation-start/1";
const LIMIT = 64 * 1024;
const DIRECT_LIMIT = 8000;
const ID = /^[0-9a-f]{64}$/u;
const PHASES = new Set(["proposed", "discussing", "starting", "started"]);
const APPROVALS = new Set(["owner-message", "owner-button"]);
const DIRECT = /^(?:请\s*)?(?:现在\s*)?(?:(?:开始|启动)(?:项目建设|建设|调研|研究)|启动\s*building[- ]loop)\s*[:：]\s*([\s\S]+)$/iu;
const FOLLOW_PRIOR = /^(?:请\s*)?按(?:刚才|上面|之前|前面)?(?:已经|已)?确认的(?:范围|方案|目标)\s*(?:现在\s*)?开始(?:项目建设|建设|调研|研究|执行)?/u;
const STANDALONE = /^(?:(?:好|好的)[，,\s]+)?(?:请\s*)?(?:现在\s*)?(?:开始(?:项目建设|建设|调研|研究|执行)?|启动\s*building[- ]loop)吧?[。.!！]?$/iu;
const NATURAL_START = /^(?:请\s*)?(?:现在\s*)?开始(?:项目建设|建设|调研|研究(?=\s))\s*(.+)$/u;
const META_OR_NEGATION = /(?:先别|别|不要|不用|无需|不必)\s*(?:真的\s*)?(?:开工|启动|开始|执行)|只是(?:在)?(?:讨论|举例|问|引用|测试)|(?:^|[\n；;])\s*(?:举例|示例|例子|只作演示)\s*[:：]?/u;
const QUESTION_ABOUT_COMMAND = /是什么(?:意思)?|什么意思|(?:词|句|说法|表达|措辞|这几个字)的(?:含义|意思|用法)|这个词|这句话|怎么(?:用|说|判断|理解)|如何(?:用|说|判断|理解)|要不要|是不是|会怎样|^(?:怎么|如何|的意思)/u;
const TEMPORAL_TAIL = /^(?:之前|以后|之后|前(?:[，,的\s]|我们|我|需要|先|要|做什么|有)|后(?:[，,的\s]|我们|我|需要|先|要|会)|的时候|时[，,\s]|需要先|应该先|指的是)/u;
const TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/u;
const UNPAIRED_SURROGATE = /\p{Surrogate}/u;

function startIntent(input) {
  if (!input || TEXT_CONTROL.test(input) || META_OR_NEGATION.test(input)) return { kind: "none" };
  if (STANDALONE.test(input)) return { kind: "existing" };
  const prior = FOLLOW_PRIOR.exec(input);
  if (prior && /^[。.!！]?$/u.test(input.slice(prior[0].length).trim())) return { kind: "existing" };
  if (DIRECT.test(input) && !QUESTION_ABOUT_COMMAND.test(input)) return { kind: "direct" };
  if (prior && /^[，,。]\s*\S/u.test(input.slice(prior[0].length)) && !/[?？]/u.test(input) && !QUESTION_ABOUT_COMMAND.test(input)) {
    return { kind: "direct" };
  }
  const natural = NATURAL_START.exec(input);
  if (natural && natural[1].trim().length >= 4 && !/[?？]/u.test(natural[1]) &&
    !QUESTION_ABOUT_COMMAND.test(natural[1]) && !TEMPORAL_TAIL.test(natural[1].trim())) {
    return { kind: "direct" };
  }
  return { kind: "none" };
}

/** Only bounded explicit text from a native human event can waive a click. */
function authorizationOf(input) {
  return input.length > DIRECT_LIMIT || UNPAIRED_SURROGATE.test(input) ? { kind: "none" } : startIntent(input);
}

function ownHuman(event, inheritedEventCount) {
  return event?.type === "user/message" && event.data?.source?.kind === "user" &&
    Number.isSafeInteger(event.seq) && event.seq >= inheritedEventCount && event.seq >= 0;
}

function ownerEvent(event) {
  // DSH attaches `principal` only for a non-owner Remote sender.
  return !Object.hasOwn(event.data.source, "principal");
}

function textBlocks(event) {
  const content = Array.isArray(event.data.content) ? event.data.content : [];
  return content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text);
}

/** Use the two newest non-inherited DSH human events. Assistant text, tool output and injected context cannot authorize start. */
export function latestConversationUser(events, inheritedEventCount = 0) {
  const human = [];
  for (let index = events.length - 1; index >= 0 && human.length < 2; index--) {
    const event = events[index];
    if (!ownHuman(event, inheritedEventCount)) continue;
    const original = textBlocks(event).join("\n").trim();
    human.push({ seq: event.seq, sha256: digest(original), text: original, owner: ownerEvent(event) });
  }
  if (!human.length) return undefined;
  const [latest, prior] = human;
  return { ...latest, authorization: latest.owner ? authorizationOf(latest.text) : { kind: "none" }, ...(prior ? { previous: source(prior) } : {}) };
}

function materialTexts(values) {
  if (!Array.isArray(values) || values.length > 4 || values.some(value =>
    typeof value !== "string" || !value.trim() || value.length > 1200 || /\x00/u.test(value))) {
    throw new Error("会话材料最多四段，每段需要原样摘录且不超过 1200 字符");
  }
  const unique = [...new Set(values)];
  if (Buffer.byteLength(unique.join("\n"), "utf8") > 6 * 1024) throw new Error("会话材料合计最多 6 KiB");
  return unique;
}

/** Bind model-selected excerpts to exact owner text in the current native conversation, never to a model summary or another chat. */
export function groundConversationMaterials(events, inheritedEventCount, excerpts) {
  const requested = materialTexts(excerpts);
  const found = new Map();
  for (let index = events.length - 1; index >= 0 && found.size < requested.length; index--) {
    const event = events[index];
    if (!ownHuman(event, inheritedEventCount) || !ownerEvent(event)) continue;
    const blocks = textBlocks(event);
    for (const text of requested) {
      if (!found.has(text) && blocks.some(block => block.includes(text))) found.set(text, { seq: event.seq, sha256: digest(text), text });
    }
  }
  if (found.size !== requested.length) throw new Error("会话材料须为本会话用户实际提供的逐字摘录");
  return requested.map(text => found.get(text));
}

/** Persist and validate only previously grounded excerpt values and their version, with no file paths. */
function checkedMaterials(materials) {
  if (!Array.isArray(materials)) throw new Error("会话材料记录无效");
  const values = materialTexts(materials.map(item => item?.text));
  if (values.length !== materials.length || materials.some(item => !validSource(item) || digest(item.text) !== item.sha256)) {
    throw new Error("会话材料记录无效");
  }
  return materials.map(({ seq, sha256, text }) => ({ seq, sha256, text }));
}

/** A proposal records the exact native turn it summarizes without retaining unrelated chat text. */
function source(user) {
  return { seq: user.seq, sha256: user.sha256 };
}

function validSource(user) {
  return !!user && Number.isSafeInteger(user.seq) && user.seq >= 0 && typeof user.sha256 === "string" && ID.test(user.sha256);
}

function sameSource(left, right) {
  return validSource(left) && validSource(right) && left.seq === right.seq && left.sha256 === right.sha256;
}

function trustedText(current) {
  return current?.owner === true && validSource(current) && typeof current.text === "string" && digest(current.text) === current.sha256 ? current.text : "";
}

function compatibleTyped(current, bound) {
  const { kind } = authorizationOf(trustedText(current));
  return kind === "direct" && sameSource(current, bound) ||
    kind === "existing" && sameSource(current.previous, bound) && current.seq > bound.seq;
}

function field(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || TEXT_CONTROL.test(value)) {
    throw new Error(name + "需要具体内容，最多 " + max + " 字符");
  }
  return value.trim();
}

function fields(task) {
  const details = {
    goal: field(task?.goal, "任务目标", 1200),
    deliverable: field(task?.deliverable, "交付物和验收条件", 1600),
    scope: field(task?.scope, "工作范围", 1600),
  };
  if (Buffer.byteLength(Object.values(details).join("\n"), "utf8") > 10 * 1024) {
    throw new Error("任务目标、交付物和工作范围合计最多 10 KiB");
  }
  return details;
}

function proposalId(sessionId, user, details, materials, directive, instruction, ownerUnit, replaceUnit) {
  const identity = [sessionId, user.seq, user.sha256, details, materials, directive];
  // Preserve every existing proposal ID, including approved records awaiting a retry.
  if (instruction !== undefined) identity.push(instruction);
  if (ownerUnit !== undefined) identity.push({ ownerUnit });
  if (replaceUnit !== undefined) identity.push({ replaceUnit });
  return digest(JSON.stringify(identity));
}

/** The activation can point only to a session-private project or the host's canonical workspace. */
function activation(value) {
  if (value?.kind === "private" && Object.keys(value).length === 1) return { kind: "private" };
  if (value?.kind === "workspace" && Object.keys(value).length === 2 + Number(Object.hasOwn(value, "checkpoint")) && typeof value.root === "string" &&
    value.root.length <= 32767 && !value.root.includes("\0") && path.isAbsolute(value.root) && path.normalize(value.root) === value.root) {
    return { kind: "workspace", root: value.root,
      ...(Object.hasOwn(value, "checkpoint") ? { checkpoint: checkedEngineeringCheckpoint(value.checkpoint) } : {}) };
  }
  throw new Error("Building-loop 开工项目绑定无效");
}

/** Use DSH-managed state beside existing workbooks. Native IDs never become directory names. */
function storage(hostHome, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200 || /[\x00-\x1f]/u.test(sessionId)) {
    throw new Error("缺少有效的 DSH 会话标识");
  }
  const root = path.join(fs.realpathSync.native(hostHome), "building-loop-state");
  const file = "conversation-start-" + digest(sessionId) + ".json";
  return { root, file };
}

function verifyRoot(root) {
  if (keyOf(fs.realpathSync.native(root)) !== keyOf(root) || !fs.lstatSync(root).isDirectory()) {
    throw new Error("Building-loop 宿主状态目录无效");
  }
}

function load(root, file, sessionId) {
  const bytes = readBytes(root, file, LIMIT);
  if (bytes === null) return { bytes };
  const record = JSON.parse(text(bytes));
  if (record?.spec !== SPEC || !PHASES.has(record.phase) || !validSource(record.source) ||
    !ID.test(record.proposal?.id ?? "") || record.proposal.userSeq !== record.source.seq ||
    (["starting", "started"].includes(record.phase) && (!validSource(record.approval) || !APPROVALS.has(record.approval.method)))) {
    throw new Error("Building-loop 开工记录无效");
  }
  const details = fields(record.proposal), materials = checkedMaterials(record.proposal.materials ?? []);
  const { instruction, ownerUnit, replaceUnit } = record.proposal;
  const directive = record.proposal.directive === undefined ? null : field(record.proposal.directive, "开工原文摘录", 512);
  if (instruction !== undefined && (directive !== null || typeof instruction !== "string" || instruction !== instruction.trim() ||
    authorizationOf(instruction).kind !== "direct" || digest(instruction) !== record.source.sha256)) {
    throw new Error("开工指令原文与会话版本不符");
  }
  if (ownerUnit !== undefined && (typeof ownerUnit !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/u.test(ownerUnit) ||
    instruction && ownerEngineeringUnit(instruction) !== ownerUnit)) throw new Error("开工原文与工程工作单元不符");
  if (replaceUnit !== undefined && (typeof replaceUnit !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/u.test(replaceUnit) ||
    instruction && ownerEngineeringReplacement(instruction) !== replaceUnit)) throw new Error("开工原文与旧工程单元替换不符");
  if (record.proposal.id !== proposalId(sessionId, record.source, details, materials, directive, instruction, ownerUnit, replaceUnit) ||
    materials.some(item => item.seq > record.source.seq)) {
    throw new Error("Building-loop 开工记录与会话版本不符");
  }
  if (record.phase === "started") {
    activation(record.binding);
    if (typeof record.wake !== "boolean") throw new Error("Building-loop 开工唤醒记录无效");
  }
  if (record.phase === "starting" && record.binding !== undefined) activation(record.binding);
  return { bytes, record };
}

function save(root, file, record, before) {
  const bytes = Buffer.from(JSON.stringify(record) + "\n");
  replaceBytes(root, file, bytes, before, LIMIT);
  return bytes;
}

function snapshot(record, current) {
  if (record?.phase === "started") return { status: "started", proposal: record.proposal };
  // An already-authorized but interrupted setup keeps its stable ID so the same operation can be retried.
  if (record?.phase === "starting") return { status: "proposed", proposal: record.proposal, message: "开工确认已保存。再次选择开始可恢复建档。" };
  if (record && (sameSource(current, record.source) || record.phase === "proposed" && compatibleTyped(current, record.source))) {
    return { status: record.phase, proposal: record.proposal };
  }
  return { status: "idle" };
}

/** For an idle, ordinary chat this performs no writes and keeps no duplicate message history. */
export function conversationStartSnapshot(hostHome, sessionId, current) {
  const { root, file } = storage(hostHome, sessionId);
  try { verifyRoot(root); }
  catch (error) { if (error.code === "ENOENT") return { status: "idle" }; throw error; }
  return snapshot(load(root, file, sessionId).record, current);
}

/** Stage authority may recover an activation across restarts without relying on current prompt history. */
export function startedConversationProject(hostHome, sessionId) {
  const { root, file } = storage(hostHome, sessionId);
  try { verifyRoot(root); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  const { record } = load(root, file, sessionId);
  if (record?.phase !== "started") return undefined;
  return { proposal: record.proposal, binding: activation(record.binding), source: source(record.source), method: record.approval.method, wake: record.wake };
}

/** Retain a declined task for conversational context after restart without exposing any source material. */
export function conversationDiscussion(hostHome, sessionId) {
  const { root, file } = storage(hostHome, sessionId);
  try { verifyRoot(root); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  const { record } = load(root, file, sessionId);
  return record?.phase === "discussing" ? fields(record.proposal) : undefined;
}

/** The model can save one bounded proposal per actual human turn. It has no authority to accept it. */
export function proposeConversationTask(hostHome, sessionId, current, task, excerpts = []) {
  if (!validSource(current)) throw new Error("当前会话还没有可确认的人类消息");
  const details = fields(task), materials = checkedMaterials(excerpts);
  if (materials.some(item => item.seq > current.seq)) throw new Error("会话材料不能来自尚未发生的消息");
  const { root, file } = storage(hostHome, sessionId);
  fs.mkdirSync(root, { recursive: true });
  verifyRoot(root);
  return withWorkspaceLock(root, file, () => {
    const { bytes, record } = load(root, file, sessionId);
    const visible = snapshot(record, current);
    if (visible.status !== "idle") return visible;
    if (record && current.seq <= record.source.seq) throw new Error("当前会话消息版本已经变化");
    const original = trustedText(current);
    const direct = startIntent(original).kind === "direct";
    if (!direct && record?.phase === "discussing" && JSON.stringify(fields(record.proposal)) === JSON.stringify(details)) {
      return { status: "discussing", proposal: record.proposal };
    }
    if (direct && original.length > DIRECT_LIMIT) {
      throw new Error("开工指令原文最多 " + DIRECT_LIMIT + " 个 UTF-16 码元，请缩短指令并重新发送");
    }
    if (direct && UNPAIRED_SURROGATE.test(original)) throw new Error("开工指令含无效 Unicode，请重新发送");
    const instruction = direct ? original : undefined;
    const ownerUnit = ownerEngineeringUnit(original);
    const replaceUnit = ownerEngineeringReplacement(original);
    const id = proposalId(sessionId, current, details, materials, null, instruction, ownerUnit, replaceUnit);
    const proposal = { id, userSeq: current.seq, ...details, ...(instruction ? { instruction } : {}),
      ...(ownerUnit ? { ownerUnit } : {}), ...(replaceUnit ? { replaceUnit } : {}), ...(materials.length ? { materials } : {}) };
    save(root, file, { spec: SPEC, phase: "proposed", source: source(current), proposal }, bytes);
    return { status: "proposed", proposal };
  });
}

/** Apply only an owner action or a recognized native human start message. The initializer must be synchronous and replay-safe for proposal.id. */
export function decideConversationStart(hostHome, sessionId, current, proposalId, decision, initialize, { typed = false, inspect } = {}) {
  if (typeof proposalId !== "string" || !ID.test(proposalId) || !["start", "discuss"].includes(decision) ||
    (typed && decision !== "start") || (decision === "start" && typeof initialize !== "function")) {
    throw new Error("开工决定需要有效的提议标识和动作");
  }
  const { root, file } = storage(hostHome, sessionId);
  verifyRoot(root);
  return withWorkspaceLock(root, file, () => {
    const { bytes, record } = load(root, file, sessionId);
    if (record?.proposal.id !== proposalId) throw new Error("开工提议已变化，请按当前会话重新确认");
    if (record.phase === "started" && decision === "start") {
      return { ...snapshot(record, current), changed: false, binding: activation(record.binding) };
    }
    if (record.phase === "discussing" && decision === "discuss" && sameSource(current, record.source)) {
      return { ...snapshot(record, current), changed: false };
    }
    const authorized = typed ? compatibleTyped(current, record.source) : sameSource(current, record.source) || compatibleTyped(current, record.source) ||
      record.phase === "starting" && validSource(current);
    if (!authorized) throw new Error("开工提议对应的消息已经变化，请按当前会话重新确认");
    if (!["proposed", "starting"].includes(record.phase) || record.phase === "starting" && decision === "discuss") {
      throw new Error("当前开工提议已处理，请先核对会话状态");
    }
    if (decision === "discuss") {
      const discussed = { ...record, phase: "discussing" };
      save(root, file, discussed, bytes);
      return { ...snapshot(discussed, current), changed: true };
    }

    // Inspect existing grants without side effects. Invalid engineering targets
    // cannot leave a permanently approved, unrecoverable proposal behind.
    const existing = record.binding ?? inspect?.(record.proposal);
    if (existing) activation(existing);
    // Approval is committed before any project files are made. If initialization fails, retry the same immutable proposal.
    const starting = record.phase === "starting" ? record : {
      ...record, phase: "starting", approval: { ...source(current), method: typed ? "owner-message" : "owner-button" },
      ...(existing ? { binding: existing } : {}),
    };
    const approved = record.phase === "starting" ? bytes : save(root, file, starting, bytes);
    const initialized = existing ?? initialize(starting.proposal, current);
    if (initialized && typeof initialized.then === "function") throw new Error("建档必须在当前宿主事务内完成");
    const binding = activation(initialized);
    // A button that completes a failed typed start must wake the now-idle chat.
    const started = { ...starting, phase: "started", binding, wake: !typed };
    save(root, file, started, approved);
    return { ...snapshot(started, current), changed: true, binding };
  });
}
