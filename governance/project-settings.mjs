import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AUTHORITY, MissingProjectAuthority, authority, digest, equal, keyOf, parseAuthority, readBytes, relativeName, replaceBytes, text } from "./policy.mjs";
import { sessionProjectMode, setSessionProjectMode, workspaceStateFile } from "./session-mode.mjs";
import { withWorkspaceLock } from "./transactions.mjs";

/** A legacy policy remains active by default; the wizard requires a separate choice in each chat. */
export function projectSnapshot(hostHome, root, sessionId) {
  let mode;
  try {
    mode = sessionProjectMode(hostHome, root, sessionId);
    const policy = authority(root);
    const firstUnit = Object.values(policy.units)[0];
    const evidencePaths = [...new Set(Object.values(policy.units).flatMap(unit =>
      [...unit.phases["first-review"].evidence, ...unit.phases["final-review"].evidence]))];
    return {
      enabled: mode ?? !policy.sessionOptIn,
      workspace: root,
      status: "ready",
      ...(policy.goalContext[0] ? { goalFile: policy.goalContext[0] } : {}),
      ...(firstUnit ? { candidateFile: firstUnit.candidate, evidencePaths } : {}),
    };
  } catch (error) {
    return {
      enabled: false, workspace: root, status: error instanceof MissingProjectAuthority ? "missing" : "invalid",
      ...(error instanceof MissingProjectAuthority ? {} : {
        message: "项目授权无法读取或验证，请核对工作区中的 BUILDING-LOOP.json。",
        canDisable: mode !== false,
      }),
    };
  }
}

/** Activate only an already verified workspace. Disabling also works with a broken or removed policy. */
export function changeProjectSetting(hostHome, root, sessionId, enabled) {
  if (enabled) authority(root);
  setSessionProjectMode(hostHome, root, sessionId, enabled);
  return projectSnapshot(hostHome, root, sessionId);
}

/** File selection names the exact UTF-8 evidence and freezes the bytes actually present at save time. */
function setupSelection(root, selection) {
  const goalFile = relativeName(selection.goalFile);
  const candidateFile = relativeName(selection.candidateFile);
  if (!Array.isArray(selection.evidencePaths) || selection.evidencePaths.length > 32) throw new Error("最多授权 32 份原始证据");
  const evidence = selection.evidencePaths.map(file => relativeName(file));
  const names = [goalFile, candidateFile, ...evidence];
  if (new Set(names.map(keyOf)).size !== names.length) throw new Error("项目目标、交付文件和原始证据须分别选择，路径不能重复");

  const goal = readBytes(root, goalFile);
  const candidate = readBytes(root, candidateFile);
  if (goal !== null) text(goal);
  if (candidate !== null) text(candidate);
  const description = selection.goalDescription?.trim();
  if (goal === null && !description) throw new Error("新建项目目标文件时，请填写项目目标，或选择已有目标文件");
  if (description?.length > 8000) throw new Error("项目目标最多 8000 字符");

  const sourcePins = Object.fromEntries(evidence.map(file => {
    const bytes = readBytes(root, file);
    if (bytes === null) throw new Error("找不到选定的原始证据 " + file);
    text(bytes);
    return [file, { sha256: digest(bytes), kind: "primary", locator: file }];
  }));
  // The receipt folder is unique to this setup and grants no model write access.
  const receipts = "building-loop-receipts-" + randomUUID();
  const first = receipts + "/K01-first.json";
  const final = receipts + "/K01-final.json";
  if (readBytes(root, first) !== null || readBytes(root, final) !== null) throw new Error("核验回执路径已被占用，请重新保存");
  const review = receipt => ({ read: [candidateFile, ...evidence], receipt, evidence });
  const policy = {
    spec: "building-loop/1", sessionOptIn: true,
    coordinator: { read: [goalFile, first, final], write: [] }, goalContext: [goalFile], ledgerContext: [goalFile], sourcePins,
    units: { K01: {
      candidate: candidateFile, requireSourcePins: true,
      phases: {
        intake: { read: [candidateFile], write: [] },
        "first-review": review(first),
        supplement: { read: [candidateFile, first, final, ...evidence], write: [candidateFile] },
        "final-review": review(final),
      },
    } },
  };
  const staged = [];
  if (goal === null) staged.push([goalFile, Buffer.from("# 项目目标\n\n" + description + "\n")]);
  if (candidate === null) staged.push([candidateFile, Buffer.from("# 交付稿\n")]);
  const manifest = Buffer.from(JSON.stringify(policy, null, 2) + "\n");
  parseAuthority(manifest);
  staged.push([AUTHORITY, manifest]);
  return staged;
}

/** Setup shares the governance lock. Publish authority last, and roll back only files created by this attempt. */
export function setupProjectSetting(hostHome, root, sessionId, selection) {
  const stateHome = path.join(fs.realpathSync.native(hostHome), "building-loop-state");
  fs.mkdirSync(stateHome, { recursive: true });
  if (keyOf(fs.realpathSync.native(stateHome)) !== keyOf(stateHome)) throw new Error("Building-loop 宿主状态目录无效");
  withWorkspaceLock(stateHome, workspaceStateFile(root), () => {
    if (readBytes(root, AUTHORITY, 64 * 1024) !== null) {
      throw new Error("当前工作区已有授权清单。请重新打开设置核对授权后再开启会话协作");
    }
    const staged = setupSelection(root, selection);
    const created = [];
    try {
      for (const [file, bytes] of staged) {
        replaceBytes(root, file, bytes, null, undefined, { createOnly: true });
        created.push([file, bytes]);
      }
    } catch (error) {
      const failures = [];
      for (const [file, bytes] of created.reverse()) {
        try {
          if (equal(readBytes(root, file), bytes)) replaceBytes(root, file, null, bytes);
        } catch (cleanup) { failures.push(cleanup); }
      }
      if (failures.length) throw new AggregateError([error, ...failures], "保存未完成，请核对已生成的项目文件后重试");
      throw error;
    }
  });
  try { return changeProjectSetting(hostHome, root, sessionId, true); }
  catch (error) {
    const current = projectSnapshot(hostHome, root, sessionId);
    if (current.status !== "ready") throw error;
    return { ...current, message: "项目授权已保存。请用仅此会话开关启用项目协作。" };
  }
}
