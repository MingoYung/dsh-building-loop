import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AUTHORITY, authority, digest } from "../governance/policy.mjs";
import { changeProjectSetting, projectSnapshot, setupProjectSetting } from "../governance/project-settings.mjs";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "building-loop-project-settings-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "host"), root = path.join(base, "项目");
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  return { home, root, file: name => path.join(root, name) };
}

test("wizard pins the chosen file bytes, preserves existing documents and opts in only the current session", t => {
  const { home, root, file } = fixture(t);
  const goal = "# 项目现状\n保留此内容。\n";
  const candidate = "# 交付稿\n有待核实的文字。\n";
  const evidence = "状态,毫秒\n改动前,32\n改动后,24\n";
  fs.writeFileSync(file("目标.md"), goal);
  fs.writeFileSync(file("候选.md"), candidate);
  fs.writeFileSync(file("原始记录.csv"), evidence);
  assert.equal(projectSnapshot(home, root, "chat-a").status, "missing");
  assert.throws(() => changeProjectSetting(home, root, "chat-a", true), /缺少/);
  const selection = { goalFile: "目标.md", candidateFile: "候选.md", evidencePaths: ["原始记录.csv"] };
  assert.deepEqual(setupProjectSetting(home, root, "chat-a", selection), {
    enabled: true, workspace: root, status: "ready", goalFile: "目标.md", candidateFile: "候选.md", evidencePaths: ["原始记录.csv"],
  });
  assert.equal(projectSnapshot(home, root, "chat-b").enabled, false);
  assert.equal(changeProjectSetting(home, root, "chat-b", true).enabled, true);
  assert.equal(changeProjectSetting(home, root, "chat-a", false).enabled, false);
  assert.equal(projectSnapshot(home, root, "chat-b").enabled, true);
  assert.equal(fs.readFileSync(file("目标.md"), "utf8"), goal);
  assert.equal(fs.readFileSync(file("候选.md"), "utf8"), candidate);
  assert.equal(fs.readFileSync(file("原始记录.csv"), "utf8"), evidence);
  const policy = authority(root), unit = policy.units.K01;
  assert.equal(policy.sessionOptIn, true);
  assert.equal(policy.sourcePins["原始记录.csv"].sha256, digest(evidence));
  assert.equal(policy.sourcePins["原始记录.csv"].observation, undefined);
  assert.equal(unit.requireSourcePins, true);
  assert.deepEqual(policy.coordinator.write, []);
  assert.deepEqual(unit.phases.intake.write, []);
  assert.deepEqual(unit.phases.supplement.write, ["候选.md"]);
  const saved = fs.readFileSync(file(AUTHORITY));
  assert.throws(() => setupProjectSetting(home, root, "chat-b", selection), /已有授权清单/);
  assert.deepEqual(fs.readFileSync(file(AUTHORITY)), saved);
});

test("wizard rejects escaped, missing, linked and overlapping file choices before creating anything", t => {
  const { home, root, file } = fixture(t);
  const selection = { goalFile: "目标.md", goalDescription: "核对数据。", candidateFile: "候选.md", evidencePaths: [] };
  for (const alternate of [
    { goalFile: "../越界.md" }, { candidateFile: AUTHORITY }, { candidateFile: "目标.md" },
    { goalDescription: " " }, { evidencePaths: ["缺失.csv"] },
  ]) {
    assert.throws(() => setupProjectSetting(home, root, "chat-a", { ...selection, ...alternate }));
    assert.deepEqual(fs.readdirSync(root), []);
  }
  fs.writeFileSync(file("原始.csv"), "证据\n");
  fs.linkSync(file("原始.csv"), file("另一个名称.csv"));
  assert.throws(() => setupProjectSetting(home, root, "chat-a", { ...selection, evidencePaths: ["另一个名称.csv"] }), /拒绝链接/);
  assert.deepEqual(fs.readdirSync(root).sort(), ["原始.csv", "另一个名称.csv"].sort());
});

test("wizard creates explicitly named goal and starter, and preserves malformed pre-existing authority", t => {
  const { home, root, file } = fixture(t);
  const selection = { goalFile: "docs/目标.md", goalDescription: "核对数据。", candidateFile: "交付.md", evidencePaths: [] };
  fs.writeFileSync(file(AUTHORITY), "{bad json");
  assert.equal(projectSnapshot(home, root, "chat-a").status, "invalid");
  assert.throws(() => setupProjectSetting(home, root, "chat-a", selection), /已有授权清单/);
  assert.equal(fs.readFileSync(file(AUTHORITY), "utf8"), "{bad json");
  fs.unlinkSync(file(AUTHORITY));
  const ready = setupProjectSetting(home, root, "chat-a", selection);
  assert.equal(ready.enabled, true);
  assert.equal(fs.readFileSync(file("docs/目标.md"), "utf8"), "# 项目目标\n\n核对数据。\n");
  assert.equal(fs.readFileSync(file("交付.md"), "utf8"), "# 交付稿\n");
});
