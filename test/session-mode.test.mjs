import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { digest } from "../governance/policy.mjs";
import { sessionProjectMode, setSessionProjectMode, workspaceStateFile } from "../governance/session-mode.mjs";
import { fixture, host, policy } from "./helpers.mjs";

test("the project switch survives host restart and isolates chats in the same workspace", async () => fixture(async root => {
  const home = process.env.DSH_HOME;
  const h = host(root);
  h.coordinator("other");

  // Existing authorized chats keep their project capabilities until changed.
  assert.equal(sessionProjectMode(home, root, "root"), undefined);
  assert.ok(h.visible("root").includes("building_loop"));
  setSessionProjectMode(home, root, "root", false);

  assert.deepEqual(h.visible("root"), []);
  assert.match(h.prompt("root"), /role=chat phase=disabled/);
  assert.equal((await h.preStep("root")).kind, "enter");
  for (const native of ["read", "glob", "grep", "pwsh", "terminal"]) {
    assert.match(h.guard("root", native), /禁止直接调用/);
  }
  await assert.rejects(h.file("root", "read", "overview.md"), /项目模式已关闭/);
  await assert.rejects(h.file("root", "write", "overview.md", { content: "越权写入", note: "写入测试" }), /项目模式已关闭/);
  await assert.rejects(h.flow("root", "advance"), /项目模式已关闭/);
  await assert.rejects(h.ledger("root", "read"), /项目模式已关闭/);
  await h.user("root", 1, "关闭项目模式后的普通聊天。");
  await h.user("other", 1, "仍处于项目模式的工作请求。");
  assert.equal((await h.flow("other", "status")).role, "coordinator");
  assert.equal((await h.file("other", "read", "overview.md")).path, "overview.md");
  assert.deepEqual((await h.ledger("other", "read")).items.map(item => item.title), ["仍处于项目模式的工作请求。"]);

  const reopened = host(root);
  assert.equal(sessionProjectMode(home, root, "root"), false);
  assert.deepEqual(reopened.visible("root"), []);
  setSessionProjectMode(home, root, "root", true);
  assert.equal(sessionProjectMode(home, root, "root"), true);
  assert.equal((await reopened.flow("root", "status")).role, "coordinator");
  const ledger = await reopened.ledger("root", "read");
  assert.ok(ledger.items.every(item => item.title !== "关闭项目模式后的普通聊天。"));
}));

test("a child inherits the actual owner switch and active work can still settle", async () => fixture(async root => {
  const home = process.env.DSH_HOME;
  const h = host(root);
  h.coordinator("other");
  const dispatch = await h.flow("root", "advance");
  assert.equal((await h.flow(dispatch.childId, "status")).role, "executor");

  assert.throws(() => setSessionProjectMode(home, root, "root", false), /子会话执行中的阶段/);
  assert.equal(sessionProjectMode(home, root, "root"), undefined);
  setSessionProjectMode(home, root, "other", false);
  assert.equal((await h.flow(dispatch.childId, "status")).role, "executor");
  await h.interrupt(dispatch.childId, 4);
  setSessionProjectMode(home, root, "root", false);

  // Even an explicit child-level record cannot reenable the parent's workflow.
  setSessionProjectMode(home, root, dispatch.childId, true);
  assert.deepEqual(h.visible(dispatch.childId), []);
  assert.match(h.prompt(dispatch.childId), /role=blocked phase=project-disabled/);
  await assert.rejects(h.preStep(dispatch.childId), /项目模式已关闭/);
  await assert.rejects(h.file(dispatch.childId, "read", "candidate.md"), /项目模式已关闭/);
  await h.interrupt(dispatch.childId, 5);
  await h.usage(dispatch.childId, 1, 1, 1234);
  assert.deepEqual(h.warnings, []);

  setSessionProjectMode(home, root, "root", true);
  const resumed = await h.flow("root", "advance");
  assert.equal(resumed.childId, dispatch.childId);
  assert.equal(resumed.reused, true);
  assert.equal((await h.flow(dispatch.childId, "status")).role, "executor");
}));

test("a newly configured project requires each root to opt in, and children follow their own root", async () => fixture(async (root, write) => {
  const home = process.env.DSH_HOME;
  write("BUILDING-LOOP.json", JSON.stringify({ ...policy, sessionOptIn: true }));
  const h = host(root);
  h.coordinator("other");
  h.restoreChild("unassigned-child", "other");

  assert.deepEqual(h.visible("root"), []);
  assert.equal((await h.preStep("root")).kind, "enter");
  assert.match(h.prompt("root"), /尚未启用/);
  assert.match(h.prompt("unassigned-child"), /role=blocked phase=project-disabled/);
  await assert.rejects(h.preStep("unassigned-child"), /尚未启用/);
  assert.match((await h.flow("root", "status")).blocked, /尚未启用/);
  await h.user("root", 1, "开启前的普通对话");
  setSessionProjectMode(home, root, "root", true);
  assert.equal((await h.flow("root", "status")).role, "coordinator");
  assert.deepEqual(h.visible("other"), []);
  await h.user("other", 1, "另一条未开启会话的对话");
  assert.deepEqual((await h.ledger("root", "read")).items, []);

  await h.user("root", 2, "项目任务");
  const dispatch = await h.flow("root", "advance");
  assert.equal((await h.flow(dispatch.childId, "status")).role, "executor");
  assert.deepEqual((await h.ledger("root", "read")).items.map(item => item.title), ["项目任务", "工作单元 K01"]);
}));

test("missing workspaces allow only root chat and invalid persisted mode never grants access", async () => fixture(async (root, write) => {
  const home = process.env.DSH_HOME;
  const noFolder = host(undefined);
  assert.match(noFolder.prompt("root"), /role=chat phase=unconfigured/);
  assert.equal((await noFolder.preStep("root")).kind, "enter");
  await assert.rejects(noFolder.file("root", "read", "overview.md"), /未选择本地项目目录/);
  await noFolder.user("root", 1, "无目录聊天");
  noFolder.restoreChild("child", "root");
  await assert.rejects(noFolder.preStep("child"), /未选择本地项目目录/);

  const h = host(root);
  setSessionProjectMode(home, root, "root", false);
  write("BUILDING-LOOP.json", "{bad manifest");
  assert.equal((await h.preStep("root")).kind, "enter");
  setSessionProjectMode(home, root, "root", true);
  await assert.rejects(h.preStep("root"), SyntaxError);

  const modePath = path.join(home, "building-loop-state", "session-mode",
    workspaceStateFile(root).slice(0, -5), digest("root") + ".json");
  fs.writeFileSync(modePath, JSON.stringify({ spec: "unknown", enabled: false }));
  assert.deepEqual(h.visible("root"), []);
  await assert.rejects(h.preStep("root"), /会话设置无效/);
  await assert.rejects(h.file("root", "read", "overview.md"), /会话设置无效/);
  assert.throws(() => setSessionProjectMode(home, root, "root", true), /会话设置无效/);
  setSessionProjectMode(home, root, "root", false);
  assert.equal(sessionProjectMode(home, root, "root"), false);
  assert.equal((await h.preStep("root")).kind, "enter");
}));
