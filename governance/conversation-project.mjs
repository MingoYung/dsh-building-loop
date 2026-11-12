import fs from "node:fs";
import path from "node:path";
import { AUTHORITY, MANAGED, MissingProjectAuthority, authority, digest, keyOf, parseAuthority, readBytes, replaceWithHistory, text, workspaceRoot } from "./policy.mjs";
import { sessionProjectMode } from "./session-mode.mjs";
import { deliverableTableContract } from "./deliverable-table.mjs";

export const GOAL = "PROJECT-GOAL.md";
export const INDEX = "INDEX.md";
export const DELIVERY = "DELIVERY.md";
export const BOOK = "TASK-LEDGER.md";
export const MATERIALS = "CONVERSATION-INPUT.md";
export const STARTER = "# 交付稿\n\n<!-- 由接单执行方在此写入第一版交付。 -->\n";
const FIRST = "receipts/K01-first.json";
const FINAL = "receipts/K01-final.json";
const IDENTITY = MANAGED + "/conversation-start.json";
const OWNER_TABLE = "owner-table/1";

/** Only exact, ordinary host-owned paths can become private project roots. */
function directory(file) {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!entry?.isDirectory() || entry.isSymbolicLink() || keyOf(fs.realpathSync.native(file)) !== keyOf(file)) {
    throw new Error("会话项目目录身份不符");
  }
  return file;
}

function projectLocation(hostHome, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) throw new Error("缺少有效的会话标识");
  const base = path.join(fs.realpathSync.native(hostHome), "building-loop-projects");
  return { base, root: path.join(base, digest(sessionId)) };
}

/** Recompute the folder from the DSH owner and verify the exact accepted proposal identity. */
export function privateProjectRoot(hostHome, sessionId, proposalId) {
  const { base, root } = projectLocation(hostHome, sessionId);
  directory(base);
  directory(root);
  const record = privateIdentity(root);
  if (record.spec !== "building-loop-private-project/1" || record.sessionId !== sessionId || record.proposalId !== proposalId) {
    throw new Error("会话项目与已确认的任务不一致");
  }
  return root;
}

function privateIdentity(root) {
  const bytes = readBytes(root, IDENTITY, 2048);
  if (!bytes) throw new Error("会话项目缺少宿主开工记录");
  return JSON.parse(text(bytes));
}

/** Only newly initialized, already bound private projects opt into this intake. */
export function privateProjectUsesOwnerTable(root) {
  return privateIdentity(root).intakeAuthority === OWNER_TABLE;
}

/** Keep every permission fixed by the host. Model text is used only for the goal and acceptance criteria. */
function privatePolicy(sessionId, input) {
  const evidence = input ? [MATERIALS] : [];
  const read = [DELIVERY, INDEX, ...evidence];
  return {
    spec: "building-loop/1",
    coordinator: { read: [GOAL, INDEX, FIRST, FINAL], write: [GOAL, BOOK] },
    goalContext: [GOAL], ledgerContext: [GOAL, INDEX], ledgerDocument: BOOK,
    ...(input ? { sourcePins: { [MATERIALS]: { sha256: digest(input), kind: "primary", locator: "dsh-session/" + encodeURIComponent(sessionId) } } } : {}),
    units: { K01: { candidate: DELIVERY, requireSourcePins: true, phases: {
      intake: { read, write: [DELIVERY] },
      "first-review": { read, receipt: FIRST, evidence },
      supplement: { read: [...read, FIRST, FINAL], write: [DELIVERY] },
      "final-review": { read, receipt: FINAL, evidence },
    } } },
  };
}

/** Preserve the selected native text and its event locator as data for the execution and review roles. */
function materialDocument(materials) {
  if (!materials?.length) return null;
  return ["# 会话提供的材料", "", "以下是该会话里用户提供的原文摘录。它们可证明收到的内容，外部事件仍需独立查证。", "",
    ...materials.flatMap(item => {
      const fences = item.text.match(/~+/gu) ?? [];
      const fence = "~".repeat(Math.max(3, ...fences.map(run => run.length + 1)));
      return ["## 用户消息事件 " + item.seq, "", "摘录 SHA-256 " + item.sha256, "", fence, item.text, fence, ""];
    }), ""].join("\n");
}

function goalDocument(proposal, ownerTable) {
  const task = ownerTable ? [
    "## 目标", "完成用户直接确认的开工任务，逐项依据完整开工原文和授权材料判断。", "",
    "## 交付与验收", "按原文明确的表头与编号提交。先核对每项输入、适用规则和依赖条件，交付前复核答案、依据与编号。", "",
    "## 已确认范围", "工作范围以用户直接开工原文和当前项目授权为准。", "",
  ] : ["## 目标", proposal.goal, "", "## 交付与验收", proposal.deliverable,
    "", "## 已确认范围", proposal.scope, ""];
  return ["# 项目总纲", "", ...task,
    ...(proposal.instruction ? ["## 用户直接开工指令",
      "完整原文由宿主随 prepare 读包交给本阶段子会话（会话事件 " + proposal.userSeq + "）。", ""] : []),
    ...(proposal.directive ? ["## 用户直接开工指令摘录（会话事件 " + proposal.userSeq + "）",
      ...proposal.directive.split(/\r?\n/u).map(line => "> " + line), ""] : []),
    "## 分块入口", "[项目索引](INDEX.md)", ""].join("\n");
}

/** Build in a sibling staging directory, then publish the complete set with one rename. */
function createPrivateProject(hostHome, sessionId, proposal) {
  const { base, root } = projectLocation(hostHome, sessionId);
  fs.mkdirSync(base, { recursive: true });
  directory(base);
  if (fs.lstatSync(root, { throwIfNoEntry: false })) {
    // A crash after publication but before durable acceptance can safely retry this exact proposal.
    return privateProjectRoot(hostHome, sessionId, proposal.id);
  }
  const stage = fs.mkdtempSync(path.join(base, "." + path.basename(root) + "-stage-"));
  try {
    // The accepted direct instruction is already bound to the owner's native event.
    // An explicit table task can therefore use host text instead of a proposed answer.
    const ownerTable = !!deliverableTableContract(proposal.instruction);
    const input = materialDocument(proposal.materials);
    const manifest = JSON.stringify(privatePolicy(sessionId, input), null, 2) + "\n";
    parseAuthority(Buffer.from(manifest));
    const files = {
      [GOAL]: goalDocument(proposal, ownerTable),
      [INDEX]: "# 项目索引\n\n- [项目总纲](PROJECT-GOAL.md)\n- K01 · [交付稿](DELIVERY.md)\n- [任务账本](TASK-LEDGER.md)\n" +
        (input ? "- [会话提供的材料](CONVERSATION-INPUT.md)\n" : ""),
      [DELIVERY]: STARTER,
      [BOOK]: "# 任务账本\n\n- K01 已确认，待派单。目标与范围见 [项目总纲](PROJECT-GOAL.md)。\n",
      [AUTHORITY]: manifest,
      ...(input ? { [MATERIALS]: input } : {}),
      [IDENTITY]: JSON.stringify({ spec: "building-loop-private-project/1", sessionId, proposalId: proposal.id,
        ...(ownerTable ? { intakeAuthority: OWNER_TABLE } : {}) }) + "\n",
    };
    const markers = Object.create(null);
    for (const [file, content] of Object.entries(files)) {
      replaceWithHistory(stage, file, content, "宿主按确认方案初始化会话项目", "start/" + proposal.id, markers);
    }
    fs.renameSync(stage, root);
  } finally {
    // Only remove the unique directory this attempt created, never the published project.
    if (fs.lstatSync(stage, { throwIfNoEntry: false })) fs.rmSync(directory(stage), { recursive: true });
  }
  return privateProjectRoot(hostHome, sessionId, proposal.id);
}

/** Start can reuse an effective exact grant. Consent to a task never broadens file permissions. */
export function initializeConversationProject(hostHome, sessionId, nativeCwd, proposal) {
  const { root: published } = projectLocation(hostHome, sessionId);
  if (fs.lstatSync(published, { throwIfNoEntry: false })) {
    // Resume the already published binding before consulting any newer workspace grant.
    privateProjectRoot(hostHome, sessionId, proposal.id);
    return { kind: "private" };
  }
  let root;
  try { root = workspaceRoot(nativeCwd, hostHome); }
  catch { /* The DSH default workspace and a chat with no folder use private storage. */ }
  if (root) {
    try {
      const policy = authority(root);
      const mode = sessionProjectMode(hostHome, root, sessionId);
      if (mode ?? !policy.sessionOptIn) return { kind: "workspace", root };
    } catch (error) {
      if (!(error instanceof MissingProjectAuthority)) throw error;
    }
  }
  createPrivateProject(hostHome, sessionId, proposal);
  return { kind: "private" };
}

/** A blank template or a bare heading cannot enter independent review as a drafted delivery. */
export function requirePrivateDraft(bytes) {
  const body = text(bytes).replace(/<!--[\s\S]*?-->/gu, "");
  if (!body.split(/\r?\n/u).some(line => !/^\s*(?:#|`{3,}|~{3,})/u.test(line) && /[\p{L}\p{N}]/u.test(line.replace(/\[[xX]\]/gu, "")))) {
    throw new Error("请先按已确认目标在交付稿写入实际正文，再读回提交首次验收");
  }
}
