import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BOOK, DELIVERY, GOAL, INDEX, MATERIALS, STARTER, initializeConversationProject, privateProjectRoot, requirePrivateDraft,
} from "../governance/conversation-project.mjs";
import { AUTHORITY, MANAGED, authority, digest, historyPaths, keyOf } from "../governance/policy.mjs";
import { setSessionProjectMode } from "../governance/session-mode.mjs";

const plan = {
  id: digest("已确认的计划"),
  goal: "定位 DSH 更新后预设加载失败的原因",
  deliverable: "提交带复现步骤、可核对出处和明确验收条件的诊断报告",
  scope: "只整理本会话提供的材料，已有项目路径依照当前授权处理",
};
const firstReceipt = "receipts/K01-first.json";
const finalReceipt = "receipts/K01-final.json";
const identity = MANAGED + "/conversation-start.json";

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "building-loop-private-project-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const home = path.join(sandbox, "host"), cwd = path.join(sandbox, "用户项目");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return { sandbox, home, cwd };
}

/** Check source bytes and directory entries together so extra writes cannot hide behind correct output. */
function files(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).filter(file => fs.statSync(path.join(root, file)).isFile())
    .map(file => [file.replaceAll(path.sep, "/"), digest(fs.readFileSync(path.join(root, file)))]));
}

function nativeAuthority(cwd, sessionOptIn = false) {
  const value = {
    spec: "building-loop/1", sessionOptIn, coordinator: { read: ["总纲.md"], write: [] }, goalContext: ["总纲.md"],
    units: { native: { candidate: "已有稿.md", phases: {
      intake: { read: ["已有稿.md"], write: [] },
      "first-review": { read: ["已有稿.md"], receipt: "首审.json" },
      supplement: { read: ["已有稿.md"], write: ["已有稿.md"] },
      "final-review": { read: ["已有稿.md"], receipt: "终审.json" },
    } } },
  };
  fs.writeFileSync(path.join(cwd, AUTHORITY), JSON.stringify(value) + "\n");
  fs.writeFileSync(path.join(cwd, "总纲.md"), "# 已有项目\n");
  fs.writeFileSync(path.join(cwd, "已有稿.md"), "用户已有交付稿\n");
}

test("confirmed plan initializes a private exact-policy project without touching the user folder", t => {
  const { home, cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, GOAL), "同名用户文件\n");
  fs.writeFileSync(path.join(cwd, DELIVERY), "同名用户交付稿\n");
  const before = files(cwd);
  assert.deepEqual(initializeConversationProject(home, "chat-a", cwd, plan), { kind: "private" });
  const root = privateProjectRoot(home, "chat-a", plan.id);
  assert.equal(root, path.join(home, "building-loop-projects", digest("chat-a")));
  assert.deepEqual(files(cwd), before);
  assert.equal(fs.existsSync(path.join(cwd, AUTHORITY)), false);
  const goal = fs.readFileSync(path.join(root, GOAL), "utf8");
  for (const text of [plan.goal, plan.deliverable, plan.scope, "[项目索引](INDEX.md)"]) assert.ok(goal.includes(text));
  assert.ok(fs.readFileSync(path.join(root, INDEX), "utf8").includes(DELIVERY));
  assert.equal(fs.readFileSync(path.join(root, DELIVERY), "utf8"), STARTER);
  assert.ok(fs.readFileSync(path.join(root, BOOK), "utf8").includes("K01"));
  for (const file of [GOAL, INDEX, DELIVERY, BOOK, AUTHORITY, identity]) {
    const history = fs.readFileSync(path.join(root, historyPaths(file).log), "utf8");
    assert.ok(history.includes("初始化会话项目"), file);
  }

  const policy = authority(root), { phases } = policy.units.K01;
  assert.deepEqual(Object.keys(policy.units), ["K01"]);
  assert.equal(policy.units.K01.candidate, DELIVERY);
  assert.equal(policy.units.K01.requireSourcePins, true);
  assert.deepEqual(policy.coordinator, { read: [GOAL, INDEX, firstReceipt, finalReceipt], write: [GOAL, BOOK] });
  assert.deepEqual(policy.goalContext, [GOAL]);
  assert.deepEqual(policy.ledgerContext, [GOAL, INDEX]);
  assert.equal(policy.ledgerDocument, BOOK);
  assert.deepEqual(phases.intake, { read: [DELIVERY, INDEX], write: [DELIVERY] });
  assert.deepEqual(phases.supplement, { read: [DELIVERY, INDEX, firstReceipt, finalReceipt], write: [DELIVERY] });
  for (const phase of ["first-review", "final-review", "first-audit", "final-audit"]) {
    assert.deepEqual(phases[phase].read, [DELIVERY, INDEX]);
    assert.deepEqual(phases[phase].write, []);
    assert.deepEqual(phases[phase].evidence, []);
  }
  assert.deepEqual(Object.keys(policy.sourcePins), []);
});

test("confirmed conversation excerpts are pinned as read-only source material for execution and review", t => {
  const { home, cwd } = fixture(t);
  const session = "conversation with material";
  const quoted = ["启动日志显示无法加载预设。\n~~~\n这段话来自用户原文。", "对照组首次启动后正常。"];
  const materials = quoted.map((text, index) => ({ seq: 15 + index, sha256: digest(text), text }));
  initializeConversationProject(home, session, cwd, { ...plan, materials });
  const root = privateProjectRoot(home, session, plan.id);
  const bytes = fs.readFileSync(path.join(root, MATERIALS));
  const source = bytes.toString("utf8");
  for (const item of materials) {
    assert.ok(source.includes(`用户消息事件 ${item.seq}`));
    assert.ok(source.includes(item.sha256));
    assert.ok(source.includes(item.text));
  }
  assert.ok(source.includes("外部事件仍需独立查证"));
  assert.ok(source.includes("~~~~\n" + quoted[0] + "\n~~~~"));
  assert.ok(fs.readFileSync(path.join(root, INDEX), "utf8").includes(`[会话提供的材料](${MATERIALS})`));
  assert.ok(fs.existsSync(path.join(root, historyPaths(MATERIALS).log)));
  assert.deepEqual(fs.readdirSync(cwd), []);

  const policy = authority(root), { phases } = policy.units.K01;
  assert.deepEqual(policy.sourcePins[keyOf(MATERIALS)], {
    sha256: digest(bytes), kind: "primary", locator: "dsh-session/" + encodeURIComponent(session),
  });
  assert.ok(!policy.coordinator.read.includes(MATERIALS));
  assert.ok(!policy.coordinator.write.includes(MATERIALS));
  assert.deepEqual(phases.intake, { read: [DELIVERY, INDEX, MATERIALS], write: [DELIVERY] });
  assert.deepEqual(phases.supplement, { read: [DELIVERY, INDEX, MATERIALS, firstReceipt, finalReceipt], write: [DELIVERY] });
  for (const phase of ["first-review", "final-review", "first-audit", "final-audit"]) {
    assert.deepEqual(phases[phase].read, [DELIVERY, INDEX, MATERIALS]);
    assert.deepEqual(phases[phase].write, []);
    assert.deepEqual(phases[phase].evidence, [MATERIALS]);
  }
});

test("retry preserves the draft and a second chat in the same folder has its own project", t => {
  const { home, cwd } = fixture(t);
  initializeConversationProject(home, "chat-a", cwd, plan);
  const first = privateProjectRoot(home, "chat-a", plan.id);
  fs.writeFileSync(path.join(first, DELIVERY), "# 首次交付\n\n已填写正文。\n");
  const started = files(first);
  assert.deepEqual(initializeConversationProject(home, "chat-a", cwd, { ...plan, goal: "重试输入不得覆盖原目标" }), { kind: "private" });
  assert.deepEqual(files(first), started);
  assert.throws(() => initializeConversationProject(home, "chat-a", cwd, { ...plan, id: digest("不同提议") }), /与已确认的任务不一致/);

  const secondPlan = { ...plan, id: digest("第二个确认"), goal: "调查另一个独立问题" };
  initializeConversationProject(home, "chat-b", cwd, secondPlan);
  const second = privateProjectRoot(home, "chat-b", secondPlan.id);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(path.join(second, DELIVERY), "utf8"), STARTER);
  assert.ok(fs.readFileSync(path.join(second, GOAL), "utf8").includes(secondPlan.goal));
  assert.throws(() => privateProjectRoot(home, "chat-b", plan.id), /与已确认的任务不一致/);
  assert.deepEqual(files(first), started);
  assert.deepEqual(fs.readdirSync(cwd), []);
  assert.deepEqual(fs.readdirSync(path.dirname(first)).sort(), [path.basename(first), path.basename(second)].sort());
});

test("effective existing grants are reused, while off and unselected opt-in grants remain private", t => {
  const { home, cwd } = fixture(t);
  nativeAuthority(cwd);
  const original = files(cwd);
  assert.deepEqual(initializeConversationProject(home, "legacy", cwd, plan), { kind: "workspace", root: cwd });
  assert.deepEqual(fs.readdirSync(home), []);
  assert.deepEqual(files(cwd), original);

  setSessionProjectMode(home, cwd, "off", false);
  assert.deepEqual(initializeConversationProject(home, "off", cwd, plan), { kind: "private" });
  assert.equal(authority(privateProjectRoot(home, "off", plan.id)).units.native, undefined);
  assert.deepEqual(files(cwd), original);

  nativeAuthority(cwd, true);
  const optIn = files(cwd);
  assert.deepEqual(initializeConversationProject(home, "unselected", cwd, plan), { kind: "private" });
  assert.equal(authority(privateProjectRoot(home, "unselected", plan.id)).units.native, undefined);
  setSessionProjectMode(home, cwd, "enabled", true);
  assert.deepEqual(initializeConversationProject(home, "enabled", cwd, plan), { kind: "workspace", root: cwd });
  assert.deepEqual(files(cwd), optIn);
});

test("a published private project survives a later native grant during confirmation retry", t => {
  const { home, cwd } = fixture(t);
  initializeConversationProject(home, "chat", cwd, plan);
  const privateRoot = privateProjectRoot(home, "chat", plan.id);
  const before = files(privateRoot);
  nativeAuthority(cwd);
  assert.deepEqual(initializeConversationProject(home, "chat", cwd, plan), { kind: "private" });
  assert.deepEqual(files(privateRoot), before);
});

test("missing and DSH-overlapping workspace paths initialize only an isolated project", t => {
  const { home } = fixture(t);
  const defaultFolder = path.join(home, "workspace");
  fs.mkdirSync(defaultFolder);
  fs.writeFileSync(path.join(defaultFolder, GOAL), "默认工作区的用户文件\n");
  const original = files(defaultFolder);
  assert.deepEqual(initializeConversationProject(home, "no-folder", undefined, plan), { kind: "private" });
  assert.deepEqual(initializeConversationProject(home, "default-folder", defaultFolder, plan), { kind: "private" });
  assert.notEqual(privateProjectRoot(home, "no-folder", plan.id), privateProjectRoot(home, "default-folder", plan.id));
  assert.deepEqual(files(defaultFolder), original);
});

test("corrupt and linked native authority do not create a replacement project or change the user's files", t => {
  const { home, cwd, sandbox } = fixture(t);
  fs.writeFileSync(path.join(cwd, AUTHORITY), "{破损\n");
  const damaged = files(cwd);
  assert.throws(() => initializeConversationProject(home, "corrupt", cwd, plan), SyntaxError);
  assert.deepEqual(files(cwd), damaged);
  assert.deepEqual(fs.readdirSync(home), []);
  fs.unlinkSync(path.join(cwd, AUTHORITY));

  const foreign = path.join(sandbox, "foreign.json");
  fs.writeFileSync(foreign, JSON.stringify({ spec: "building-loop/1", coordinator: {}, units: {} }));
  fs.linkSync(foreign, path.join(cwd, AUTHORITY));
  assert.throws(() => initializeConversationProject(home, "linked", cwd, plan), /链接/);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(fs.statSync(foreign).nlink, 2);
});

test("corrupt identity and a linked private root fail closed without overwriting the target", t => {
  const { home, cwd, sandbox } = fixture(t);
  initializeConversationProject(home, "chat", cwd, plan);
  const root = privateProjectRoot(home, "chat", plan.id);
  fs.writeFileSync(path.join(root, identity), "{broken record\n");
  const broken = files(root);
  assert.throws(() => privateProjectRoot(home, "chat", plan.id), SyntaxError);
  assert.throws(() => initializeConversationProject(home, "chat", cwd, plan), SyntaxError);
  assert.deepEqual(files(root), broken);

  const target = path.join(sandbox, "outside-private-projects");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, GOAL), "外部文件必须保留\n");
  const original = files(target);
  const alias = path.join(path.dirname(root), digest("alias"));
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => initializeConversationProject(home, "alias", cwd, plan), /目录身份不符/);
  assert.throws(() => privateProjectRoot(home, "alias", plan.id), /目录身份不符/);
  assert.deepEqual(files(target), original);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test("a starter or a draft containing only headings, comments and Markdown markers cannot enter review", () => {
  for (const contents of [STARTER, "", " \t\n", "# 交付稿\n\n## 诊断\n", "<!-- 只有内部注释 -->\n\n# 交付稿\n",
    "# 交付稿\n\n---\n", "# 交付稿\n\n- [ ]\n- [x]\n"]) {
    assert.throws(() => requirePrivateDraft(Buffer.from(contents)), /写入实际正文/);
  }
  assert.doesNotThrow(() => requirePrivateDraft(Buffer.from("# 交付稿\n\n本次诊断先复现插件加载失败。\n")));
});
