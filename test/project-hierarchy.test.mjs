import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { apply } from "../governance/index.mjs";
import { decideConversationStart, latestConversationUser, proposeConversationTask } from "../governance/conversation-start.mjs";
import { GOAL, INDEX, initializeConversationProject, privateProjectRoot } from "../governance/conversation-project.mjs";
import { authority, digest, historyPaths } from "../governance/policy.mjs";
import { fixture } from "./helpers.mjs";

const title = "恢复策略";
const id = "restore-policy";
const modulePath = "modules/restore-policy.md";
const request = `新增模块 ${id}：${title}`;
const moduleArgs = { action: "add-module", module: id, title,
  content: "# 恢复策略\n\n从已确认快照恢复，记录校验结果。\n", note: "按已确认请求新增恢复模块" };

function user(seq, text, source = { kind: "user" }) {
  return { type: "user/message", seq, data: { source, content: [{ type: "text", text }] } };
}

function approvePrivate(cwd, home) {
  fs.unlinkSync(path.join(cwd, "BUILDING-LOOP.json"));
  const current = latestConversationUser([user(1, "开始建设：记录恢复策略")]);
  const { proposal } = proposeConversationTask(home, "root", current, { goal: "记录策略", deliverable: "形成可读交付", scope: "恢复项目" });
  decideConversationStart(home, "root", current, proposal.id, "start",
    approved => initializeConversationProject(home, "root", cwd, approved), { typed: true });
  return privateProjectRoot(home, "root", proposal.id);
}

function native(cwd, initialMessage) {
  const root = { id: "root", session: { seq: 21, header: { cwd } } };
  const child = { id: "child", session: { seq: 21, header: { cwd, parentSession: "root" } } };
  let message = initialMessage;
  const tools = new Map();
  apply({
    agents: { get: id => id === "root" ? root : id === "child" ? child : undefined },
    subagents: {}, systemPrompt: { context() {} }, on() {}, logger: { warn() {} },
    tools: { register(tool) { tools.set(tool.name, tool); }, guard() {} },
    sessionQuery: { async observeSession() {
      return { events: [message], inheritedEventCount: 0, cursor: 20, [Symbol.dispose]() {} };
    } },
  });
  const file = (args, agent = root) => tools.get("building_loop_file").execute(args, { agent });
  return { file, child, setMessage(event) { message = event; } };
}

test("native owner publishes a new private module in place and can read its exact route", () => fixture(async cwd => {
  const project = approvePrivate(cwd, process.env.DSH_HOME);
  const host = native(cwd, user(20, request));
  const goal = fs.readFileSync(path.join(project, GOAL));
  // A trailing sibling makes it observable that the link is inserted in the requested section.
  const beforeIndex = fs.readFileSync(path.join(project, INDEX), "utf8") + "\n## 审核记录\n\n保留原字节。\n";
  fs.writeFileSync(path.join(project, INDEX), beforeIndex);
  const result = await host.file(moduleArgs);
  assert.deepEqual(result, { module: id, route: [GOAL, INDEX, modulePath], sha256: digest(moduleArgs.content), changed: true });
  const pathRead = await Promise.all(result.route.map(file => host.file({ action: "read", path: file })));
  assert.match(pathRead[0].lines.map(row => row[1]).join("\n"), /\[项目索引\]\(INDEX\.md\)/u);
  assert.match(pathRead[1].lines.map(row => row[1]).join("\n"), /\[恢复策略\]\(modules\/restore-policy\.md\)/u);
  assert.equal(pathRead[2].sha256, result.sha256);
  assert.deepEqual(fs.readFileSync(path.join(project, GOAL)), goal);
  const afterIndex = fs.readFileSync(path.join(project, INDEX), "utf8");
  assert.equal(afterIndex.replace("\n- [恢复策略](modules/restore-policy.md)\n\n", ""), beforeIndex);
  assert.ok(afterIndex.indexOf(modulePath) < afterIndex.indexOf("## 审核记录"));
  const history = historyPaths(INDEX);
  assert.equal(fs.readFileSync(path.join(project, history.backup), "utf8"), beforeIndex);
  const log = fs.readFileSync(path.join(project, history.log));
  assert.equal((await host.file(moduleArgs)).changed, false);
  assert.deepEqual(fs.readFileSync(path.join(project, history.log)), log);
  assert.ok((await host.file({ action: "list" })).read.includes(modulePath));
  await assert.rejects(host.file({ ...moduleArgs, content: "# 不同正文\n" }), /已登记/u);
}));

test("native module writes reject authorization and chapter bypasses without modifying files", () => fixture(async cwd => {
  const project = approvePrivate(cwd, process.env.DSH_HOME);
  const host = native(cwd, user(20, request, { kind: "user", principal: { kind: "share" } }));
  const goal = fs.readFileSync(path.join(project, GOAL), "utf8");
  await assert.rejects(host.file(moduleArgs), /所有者明确请求/u);
  host.setMessage(user(20, "例如：" + request));
  await assert.rejects(host.file(moduleArgs), /所有者明确请求/u);
  host.setMessage(user(20, request));
  await assert.rejects(host.file(moduleArgs, host.child), /只有当前项目的总控/u);
  await assert.rejects(host.file({ ...moduleArgs, module: "different" }), /所有者明确请求/u);
  await assert.rejects(host.file({ action: "write", path: GOAL, note: "故意尝试重复目标", content: goal + "\n## 目标\n\n尾部追加。\n" }), /末尾追加|导航章节/u);
  await assert.rejects(host.file({ action: "write", path: GOAL, note: "尝试跨章节写入", content: goal.replace("记录策略", "改目标").replace("形成可读交付", "改交付") }), /一个已有章节/u);
  assert.equal(fs.readFileSync(path.join(project, GOAL), "utf8"), goal);
  assert.equal(fs.existsSync(path.join(project, modulePath)), false);
  const corrected = goal.replace("记录策略", "按现状更新恢复策略");
  await assert.rejects(host.file({ action: "write", path: GOAL, heading: "交付与验收", note: "尝试修改另一个章节", content: corrected }), /不在 heading/u);
  assert.equal((await host.file({ action: "write", path: GOAL, heading: "目标", note: "只就地更新现有目标", content: corrected })).changed, true);
  assert.equal(fs.readFileSync(path.join(project, GOAL), "utf8"), corrected);
}));

test("a failed module publication restores the staged body, index, and their history", () => fixture(async cwd => {
  const project = approvePrivate(cwd, process.env.DSH_HOME);
  const host = native(cwd, user(20, request));
  const indexPath = path.join(project, INDEX);
  const before = fs.readFileSync(indexPath);
  const history = historyPaths(INDEX);
  const logBefore = fs.readFileSync(path.join(project, history.log));
  const rename = fs.renameSync;
  fs.renameSync = (old, next) => {
    if (next === indexPath) {
      assert.equal(fs.readFileSync(path.join(project, modulePath), "utf8"), moduleArgs.content);
      throw new Error("controlled index publish failure");
    }
    return rename(old, next);
  };
  try { await assert.rejects(host.file(moduleArgs), /controlled index publish failure/u); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.deepEqual(fs.readFileSync(path.join(project, history.log)), logBefore);
  assert.equal(fs.existsSync(path.join(project, history.backup)), false);
  assert.equal(fs.existsSync(path.join(project, modulePath)), false);
  assert.equal(fs.existsSync(path.join(project, historyPaths(modulePath).log)), false);
  assert.equal((await host.file(moduleArgs)).changed, true);
}));

test("a new index version between route planning and history staging is preserved", () => fixture(async cwd => {
  const project = approvePrivate(cwd, process.env.DSH_HOME);
  const host = native(cwd, user(20, request));
  const index = path.join(project, INDEX);
  const body = path.join(project, modulePath);
  fs.mkdirSync(path.dirname(body));
  const external = fs.readFileSync(index, "utf8") + "\n## 外部维护\n\n此处是其他作者写入。\n";
  const lstat = fs.lstatSync;
  let observed = 0;
  fs.lstatSync = (file, ...args) => {
    if (file === body && ++observed === 2) fs.writeFileSync(index, external);
    return lstat(file, ...args);
  };
  try { await assert.rejects(host.file(moduleArgs), /文件发生外部修改.*INDEX\.md/u); }
  finally { fs.lstatSync = lstat; }
  assert.equal(fs.readFileSync(index, "utf8"), external);
  assert.equal(fs.existsSync(body), false);
  assert.ok(!(await host.file({ action: "list" })).read.includes(modulePath));
  assert.equal((await host.file(moduleArgs)).changed, true);
  assert.match(fs.readFileSync(index, "utf8"), /此处是其他作者写入。/u);
}));

for (const unknown of [false, true]) {
  test(unknown ? "new third-party bytes after index publication are kept for recovery" :
    "restoring the old index before state commit cannot publish an orphan module", () => fixture(async cwd => {
    const home = process.env.DSH_HOME;
    const project = approvePrivate(cwd, home);
    const host = native(cwd, user(20, request));
    const index = path.join(project, INDEX);
    const original = fs.readFileSync(index, "utf8");
    const replacement = unknown ? original + "\n## 外部维护\n\n不能覆盖的新内容。\n" : original;
    const rename = fs.renameSync;
    let replaced = false;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (!replaced && to === index) {
        assert.match(fs.readFileSync(index, "utf8"), /modules\/restore-policy\.md/u);
        fs.writeFileSync(index, replacement);
        replaced = true;
      }
      return result;
    };
    try {
      await assert.rejects(host.file(moduleArgs), error => {
        if (!unknown) return /文件发生外部修改.*INDEX\.md/u.test(error.message);
        return error instanceof AggregateError && error.errors.some(item => /已保留当前内容.*INDEX\.md/u.test(item.message));
      });
    } finally { fs.renameSync = rename; }
    assert.ok(replaced);
    assert.equal(fs.readFileSync(index, "utf8"), replacement);
    const files = fs.readdirSync(path.join(home, "building-loop-state"));
    assert.equal(files.some(file => file.endsWith(".ledger-txn")), unknown);
    if (unknown) {
      await assert.rejects(host.file({ action: "list" }), /已保留当前内容.*INDEX\.md/u);
      assert.equal(fs.readFileSync(index, "utf8"), replacement);
    } else {
      assert.equal(fs.existsSync(path.join(project, modulePath)), false);
      assert.equal((await host.file(moduleArgs)).changed, true);
    }
  }));
}

test("configured projects authorize exact module files and can insert both missing navigation levels", () => fixture(async (cwd, write) => {
  const source = JSON.parse(fs.readFileSync(path.join(cwd, "BUILDING-LOOP.json"), "utf8"));
  const body = "reference/recovery notes.md";
  source.coordinator.read.push("docs/index.md", body);
  source.coordinator.write = ["overview.md", body];
  source.hierarchy = { overview: { path: "overview.md", heading: "导航" }, index: { path: "docs/index.md", heading: "正文" },
    modules: { [id]: body } };
  write("BUILDING-LOOP.json", JSON.stringify(source));
  assert.equal(authority(cwd).hierarchy.modules[id], body);
  const current = latestConversationUser([user(1, "开始建设：按现有项目添加恢复策略")]);
  const home = process.env.DSH_HOME;
  const { proposal } = proposeConversationTask(home, "root", current, { goal: "恢复策略", deliverable: "登记正文", scope: "既有项目" });
  decideConversationStart(home, "root", current, proposal.id, "start",
    accepted => initializeConversationProject(home, "root", cwd, accepted), { typed: true });
  fs.mkdirSync(path.join(cwd, "docs"));
  const first = "\uFEFF# 总纲\r\n\r\n## 导航\r\n\r\n原目录。\r\n\r\n## 范围\r\n\r\n保留。\r\n";
  const second = "# 分块\r\n\r\n## 正文\r\n\r\n## 待办\r\n\r\n保留。\r\n";
  write("overview.md", first);
  write("docs/index.md", second);
  const host = native(cwd, user(20, request));
  await assert.rejects(host.file({ action: "write", path: body, note: "提前写孤立正文", content: "# 孤立\n" }), /先用 add-module/u);
  assert.deepEqual((await host.file(moduleArgs)).route, ["overview.md", "docs/index.md", body]);
  const actualFirst = fs.readFileSync(path.join(cwd, "overview.md"), "utf8");
  const actualSecond = fs.readFileSync(path.join(cwd, "docs/index.md"), "utf8");
  assert.equal(actualFirst.replace("\r\n- [项目索引](docs/index.md)\r\n\r\n", ""), first);
  assert.equal(actualSecond.replace("\r\n- [恢复策略](../reference/recovery%20notes.md)\r\n\r\n", ""), second);
  assert.equal((await host.file({ action: "read", path: body })).sha256, digest(moduleArgs.content));
}));
