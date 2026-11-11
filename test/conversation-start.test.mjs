import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  conversationDiscussion, conversationStartSnapshot, decideConversationStart, groundConversationMaterials, latestConversationUser,
  proposeConversationTask, startedConversationProject,
} from "../governance/conversation-start.mjs";
import { digest } from "../governance/policy.mjs";

const human = (seq, text, kind = "user") => ({ type: "user/message", seq, data: { source: { kind }, content: [{ type: "text", text }] } });
const pendingTask = { goal: "查清 DSH 更新后预设加载失败", deliverable: "提供可复现步骤、原始日志和根因报告", scope: "本会话内整理已提供的版本和日志" };
const privateBinding = () => ({ kind: "private" });

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "building-loop-start-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test("human authority is taken from native, own, latest events only", () => {
  const raw = [human(2, "启动 Building-loop：调研旧任务"), human(5, "普通聊天"), human(7, "开始建设", "plugin")];
  assert.equal(latestConversationUser(raw, 3).seq, 5);
  assert.equal(latestConversationUser(raw, 3).previous, undefined);
  assert.equal(latestConversationUser(raw).previous.seq, 2);
  assert.equal(latestConversationUser(raw).authorization.kind, "none");
  assert.equal(latestConversationUser(raw, 8), undefined);
  for (const text of ["‘开始调研’这句话是什么意思？", "继续", "如果我说开始调研，会怎样？", "开始调研怎么用？", "开始建设是什么意思", "开始建设：这句话的意思", "开始研究生阶段需要哪些准备", "开始调研这个词的含义要怎么判断", "开始建设之前，我们先看看方案", "开始调研这个说法的意思", "开始建设：不要真的启动", "开始建设：验证插件\n示例：这段只展示格式", "> 开始建设：做一个模型"]) {
    assert.equal(latestConversationUser([human(8, text)]).authorization.kind, "none", text);
  }
  for (const text of ["启动 Building-loop：调研 DSH 报错", "开始调研 DSH 的启动错误", "按刚才确认的范围开始调研，交一份有来源的报告。"]) {
    assert.equal(latestConversationUser([human(8, text)]).authorization.kind, "direct", text);
  }
  assert.equal(latestConversationUser([human(8, "按刚才确认的范围开始调研。")]).authorization.kind, "existing");
  assert.equal(latestConversationUser([human(8, "好，开始吧。")]).authorization.kind, "existing");
  const shared = human(9, "启动 Building-loop：调研 DSH 报错");
  shared.data.source.principal = { kind: "share", subject: "another principal" };
  assert.equal(latestConversationUser([shared]).authorization.kind, "none");
});

test("ordinary conversation writes nothing and model proposal never activates project authority", t => {
  const home = fixture(t), current = latestConversationUser([human(10, "想查清故障，并做成报告")]);
  assert.deepEqual(conversationStartSnapshot(home, "chat-a", current), { status: "idle" });
  assert.equal(startedConversationProject(home, "chat-a"), undefined);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.throws(() => proposeConversationTask(home, "chat-a", undefined, pendingTask), /没有可确认/);
  assert.throws(() => proposeConversationTask(home, "chat-a", current, { goal: "目".repeat(1200), deliverable: "稿".repeat(1600), scope: "范".repeat(1600) }), /10 KiB/);
  const pending = proposeConversationTask(home, "chat-a", current, pendingTask);
  assert.equal(pending.status, "proposed");
  assert.equal(pending.proposal.userSeq, 10);
  assert.equal(startedConversationProject(home, "chat-a"), undefined);
  assert.deepEqual(conversationStartSnapshot(home, "chat-b", current), { status: "idle" });
  assert.deepEqual(proposeConversationTask(home, "chat-a", current, { ...pendingTask, goal: "模型后来改了主意" }), pending);
  let writes = 0;
  const start = () => { writes++; return privateBinding(); };
  assert.throws(() => decideConversationStart(home, "chat-a", { ...current, authorization: { kind: "direct" } }, pending.proposal.id,
    "start", start, { typed: true }), /消息已经变化/);
  assert.equal(writes, 0);
  const accepted = decideConversationStart(home, "chat-a", current, pending.proposal.id, "start", start);
  assert.equal(accepted.changed, true);
  assert.equal(accepted.status, "started");
  assert.deepEqual(startedConversationProject(home, "chat-a"), {
    proposal: pending.proposal, binding: privateBinding(), source: { seq: current.seq, sha256: current.sha256 }, method: "owner-button", wake: true,
  });
  const after = latestConversationUser([human(10, "想查清故障，并做成报告"), human(12, "先问一下另外的问题")]);
  assert.equal(decideConversationStart(home, "chat-a", after, pending.proposal.id, "start", start).changed, false);
  assert.equal(writes, 1);
});

test("discussion and changed messages cannot start stale proposals", t => {
  const home = fixture(t);
  const first = human(10, "想要报告"), second = human(12, "再讨论一下范围");
  const a = latestConversationUser([first]), b = latestConversationUser([first, second]);
  const old = proposeConversationTask(home, "chat", a, pendingTask).proposal;
  assert.deepEqual(conversationStartSnapshot(home, "chat", b), { status: "idle" });
  assert.throws(() => decideConversationStart(home, "chat", b, old.id, "start", privateBinding), /消息已经变化/);
  const latest = proposeConversationTask(home, "chat", b, pendingTask).proposal;
  assert.notEqual(latest.id, old.id);
  assert.throws(() => decideConversationStart(home, "chat", b, old.id, "start", privateBinding), /提议已变化/);
  const discussed = decideConversationStart(home, "chat", b, latest.id, "discuss");
  assert.equal(discussed.status, "discussing");
  assert.equal(decideConversationStart(home, "chat", b, latest.id, "discuss").changed, false);
  assert.deepEqual(conversationDiscussion(home, "chat"), pendingTask);
  const newMessage = latestConversationUser([second, human(15, "开始")]);
  assert.deepEqual(conversationStartSnapshot(home, "chat", newMessage), { status: "idle" });
  assert.equal(proposeConversationTask(home, "chat", newMessage, pendingTask).status, "discussing");
  assert.throws(() => decideConversationStart(home, "chat", newMessage, latest.id, "start", privateBinding, { typed: true }), /已处理/);
  assert.equal(startedConversationProject(home, "chat"), undefined);
});

test("a typed start binds the immediately preceding pending proposal or its own explicit task text", t => {
  const home = fixture(t), first = human(14, "我们把刚才讨论的目标落到可复现报告");
  const pending = proposeConversationTask(home, "existing", latestConversationUser([first]), pendingTask).proposal;
  const wrongPrevious = latestConversationUser([first, human(17, "还有个新问题"), human(19, "开始")]);
  assert.throws(() => decideConversationStart(home, "existing", wrongPrevious, pending.id, "start", privateBinding, { typed: true }), /消息已经变化/);
  const later = latestConversationUser([first, human(19, "开始调研")]);
  assert.equal(conversationStartSnapshot(home, "existing", later).proposal.id, pending.id);
  const binding = { kind: "workspace", root: home };
  assert.equal(decideConversationStart(home, "existing", later, pending.id, "start", () => binding, { typed: true }).changed, true);
  assert.deepEqual(startedConversationProject(home, "existing").binding, binding);

  const text = "启动 Building-loop：调研 DSH 更新后预设加载失败";
  const explicit = latestConversationUser([human(3, text)]);
  const direct = proposeConversationTask(home, "direct", explicit, pendingTask).proposal;
  assert.equal(direct.userSeq, explicit.seq);
  assert.equal(direct.directive, text);
  assert.equal(decideConversationStart(home, "direct", explicit, direct.id, "start", privateBinding, { typed: true }).status, "started");
});

test("an interrupted initialization retries the same confirmed proposal and becomes active only after success", t => {
  const home = fixture(t), initial = latestConversationUser([human(10, "想要报告")]);
  const pending = proposeConversationTask(home, "chat", initial, pendingTask).proposal;
  assert.throws(() => decideConversationStart(home, "chat", initial, pending.id, "start", () => { throw new Error("模拟建档失败"); }), /模拟建档失败/);
  assert.equal(startedConversationProject(home, "chat"), undefined);
  const later = latestConversationUser([human(10, "想要报告"), human(20, "现在看下状态")]);
  assert.match(conversationStartSnapshot(home, "chat", later).message, /确认已保存/);
  assert.equal(proposeConversationTask(home, "chat", later, { ...pendingTask, goal: "后续的其他内容" }).proposal.id, pending.id);
  assert.throws(() => decideConversationStart(home, "chat", later, pending.id, "start", () => ({ kind: "workspace", root: "../escape" })), /绑定无效/);
  assert.equal(decideConversationStart(home, "chat", later, pending.id, "start", proposal => {
    assert.deepEqual(proposal, pending);
    return privateBinding();
  }).changed, true);
  assert.deepEqual(startedConversationProject(home, "chat"), {
    proposal: pending, binding: privateBinding(), source: { seq: initial.seq, sha256: initial.sha256 }, method: "owner-button", wake: true,
  });
});

test("an owner button recovering a failed typed start requires the native wake", t => {
  const home = fixture(t), current = latestConversationUser([human(3, "开始调研：定位预设加载失败并写出报告")]);
  const { proposal } = proposeConversationTask(home, "chat", current, pendingTask);
  assert.throws(() => decideConversationStart(home, "chat", current, proposal.id, "start", () => { throw new Error("disk busy"); }, { typed: true }), /disk busy/);
  assert.equal(decideConversationStart(home, "chat", current, proposal.id, "start", privateBinding).status, "started");
  assert.equal(startedConversationProject(home, "chat").method, "owner-message");
  assert.equal(startedConversationProject(home, "chat").wake, true);
});

test("conversation materials bind only bounded exact text blocks from owner messages in this chat", t => {
  const home = fixture(t);
  const logs = human(9, "运行日志：\n[ERROR] PRESET_NOT_FOUND · 24 ms\n请保留原始单位。");
  const latest = human(23, "把这个失败按版本做一份可复现调研。");
  const shared = human(17, "未经所有者提供的远程材料");
  shared.data.source.principal = { kind: "share", subject: "another principal" };
  const split = human(18, "分块左侧");
  split.data.content.push({ type: "text", text: "分块右侧" });
  const assistant = { type: "assistant/message", seq: 19, data: { content: [{ type: "text", text: "模型声称已验证" }] } };
  const events = [human(3, "继承自旧会话的日志"), logs, human(14, "注入的后台信息", "plugin"), shared, split, assistant, latest];
  const exact = "[ERROR] PRESET_NOT_FOUND · 24 ms";
  const selected = groundConversationMaterials(events, 5, [exact, "可复现调研", exact]);
  assert.deepEqual(selected, [
    { seq: 9, sha256: digest(exact), text: exact }, { seq: 23, sha256: digest("可复现调研"), text: "可复现调研" },
  ]);
  for (const invalid of ["继承自旧会话的日志", "注入的后台信息", "未经所有者提供的远程材料", "模型声称已验证", "分块左侧\n分块右侧", "PRESET_NOT_FOUND · 24%"]) {
    assert.throws(() => groundConversationMaterials(events, 5, [invalid]), /实际提供/, invalid);
  }
  assert.throws(() => groundConversationMaterials(events, 5, ["太".repeat(1201)]), /1200/);
  assert.throws(() => groundConversationMaterials(events, 5, ["一", "二", "三", "四"].map(letter => letter.repeat(1200))), /6 KiB/);
  const current = latestConversationUser(events, 5);
  const pending = proposeConversationTask(home, "chat", current, pendingTask, selected).proposal;
  assert.deepEqual(pending.materials, selected);
  assert.throws(() => proposeConversationTask(home, "other", current, pendingTask, [{ ...selected[0], seq: 27 }]), /尚未发生/);
  assert.throws(() => proposeConversationTask(home, "other", current, pendingTask, [{ ...selected[0], text: "模型改写" }]), /材料记录无效/);
  decideConversationStart(home, "chat", current, pending.id, "start", privateBinding);
  assert.deepEqual(startedConversationProject(home, "chat").proposal.materials, selected);
});

test("restored authority rejects an activation copied from another chat or a changed confirmed task", t => {
  const home = fixture(t);
  const current = latestConversationUser([human(1, "启动 Building-loop：调研 DSH 报错")]);
  const { proposal } = proposeConversationTask(home, "original", current, pendingTask);
  decideConversationStart(home, "original", current, proposal.id, "start", privateBinding, { typed: true });
  const recordFile = id => path.join(home, "building-loop-state", "conversation-start-" + digest(id) + ".json");
  fs.copyFileSync(recordFile("original"), recordFile("other"));
  assert.throws(() => startedConversationProject(home, "other"), /记录与会话版本不符/);
  const record = JSON.parse(fs.readFileSync(recordFile("original"), "utf8"));
  assert.equal(record.approval.method, "owner-message");
  record.proposal.scope += "，并读取其他项目";
  fs.writeFileSync(recordFile("original"), JSON.stringify(record));
  assert.throws(() => startedConversationProject(home, "original"), /记录与会话版本不符/);
});
