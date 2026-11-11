import fs from "node:fs";
import path from "node:path";
import { PHASES, digest, keyOf, readBytes, replaceBytes, text } from "./policy.mjs";
import { STATE_LIMIT, withWorkspaceLock } from "./transactions.mjs";

const SPEC = "building-loop-session-mode/1";
const LIMIT = 1024;

/** Match the workspace state and lock used by dispatch and ledger mutations. */
export function workspaceStateFile(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("请先选择本地项目目录");
  return digest(keyOf(root)) + ".json";
}

/** Bind a choice to both identities. A session ID never becomes part of a path. */
function modePath(workspaceFile, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200 || /[\x00-\x1f]/u.test(sessionId)) {
    throw new Error("缺少有效的 DSH 会话标识");
  }
  return "session-mode/" + workspaceFile.slice(0, -5) + "/" + digest(sessionId) + ".json";
}

/** Missing state retains the behavior of pre-switch sessions. Corruption denies access. */
function decode(bytes) {
  if (bytes === null) return undefined;
  const value = JSON.parse(text(bytes));
  if (value?.spec !== SPEC || typeof value.enabled !== "boolean") throw new Error("Building-loop 会话设置无效");
  return value.enabled;
}

/** Read the explicit choice for a native session in its canonical workspace. */
export function sessionProjectMode(hostHome, root, sessionId) {
  const home = fs.realpathSync.native(hostHome);
  return decode(readBytes(home, "building-loop-state/" + modePath(workspaceStateFile(root), sessionId), LIMIT));
}

/** Disabling an active child phase would leave it unable to submit or report interruption. */
function checkOwnedActiveUnit(stateHome, workspaceFile, sessionId) {
  const bytes = readBytes(stateHome, workspaceFile, STATE_LIMIT);
  if (bytes === null) return;
  const state = JSON.parse(text(bytes));
  if (Object.values(state.units).some(unit => unit.owner === sessionId && PHASES.includes(unit.phase))) {
    throw new Error("当前会话仍有子会话执行中的阶段。请先等待交付或停止该阶段，再关闭项目模式。");
  }
}

/** Apply an operator choice atomically, under the same lock as project actions. */
export function setSessionProjectMode(hostHome, root, sessionId, enabled) {
  if (typeof enabled !== "boolean") throw new Error("项目模式须为开或关");
  const home = fs.realpathSync.native(hostHome);
  const workspaceFile = workspaceStateFile(root);
  const name = modePath(workspaceFile, sessionId);
  const stateHome = path.join(home, "building-loop-state");
  fs.mkdirSync(stateHome, { recursive: true });
  if (keyOf(fs.realpathSync.native(stateHome)) !== keyOf(stateHome)) throw new Error("Building-loop 宿主状态目录无效");
  return withWorkspaceLock(stateHome, workspaceFile, () => {
    const before = readBytes(stateHome, name, LIMIT);
    try {
      if (decode(before) === enabled) return enabled;
    } catch (error) {
      // The operator can recover a damaged record by first explicitly closing
      // access. A damaged record alone never permits enabling project mode.
      if (enabled) throw error;
    }
    if (!enabled) checkOwnedActiveUnit(stateHome, workspaceFile, sessionId);
    replaceBytes(stateHome, name, Buffer.from(JSON.stringify({ spec: SPEC, enabled })), before, LIMIT);
    return enabled;
  });
}
