import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, host } from "./helpers.mjs";

test("an unconfigured root can chat and gains project tools only after valid authority is added", async () => fixture(async (root, write) => {
  const file = path.join(root, "BUILDING-LOOP.json");
  const manifest = fs.readFileSync(file);
  fs.unlinkSync(file);
  const h = host(root);

  assert.deepEqual(h.visible("root"), []);
  assert.match(h.guard("root", "pwsh"), /禁止直接调用/);
  assert.match(h.guard("root", "read"), /禁止直接调用/);
  assert.match(h.prompt("root"), /role=chat phase=unconfigured/);
  await assert.rejects(h.file("root", "read", "overview.md"), /当前工作区缺少/);
  await assert.rejects(h.flow("root", "advance"), /当前工作区缺少/);

  await h.user("root", 1, "你好，聊个天。");
  const userMessage = { source: { kind: "user" }, content: [{ type: "text", text: "你好" }] };
  const localInstructions = { source: { kind: "agent-instructions" }, content: [] };
  assert.deepEqual(await h.preStep("root", [localInstructions, userMessage]), { kind: "enter", messages: [userMessage] });
  assert.equal(fs.existsSync(file), false);

  write("BUILDING-LOOP.json", manifest);
  assert.ok(h.visible("root").includes("building_loop"));
  assert.match(h.prompt("root"), /role=coordinator phase=dispatch/);
  assert.equal((await h.preStep("root")).kind, "enter");
  assert.equal((await h.flow("root", "status")).role, "coordinator");
  assert.deepEqual((await h.ledger("root", "read")).items, []);
}));

test("an unconfigured child or invalid manifest stops before the model", async () => fixture(async (root, write) => {
  const file = path.join(root, "BUILDING-LOOP.json");
  const h = host(root);
  assert.equal((await h.preStep("root")).kind, "enter");

  write("BUILDING-LOOP.json", "{broken");
  await assert.rejects(h.preStep("root"), SyntaxError);
  assert.deepEqual(h.visible("root"), []);
  assert.match(h.prompt("root"), /role=blocked phase=authority/);

  fs.unlinkSync(file);
  h.restoreChild("child", "root");
  await assert.rejects(h.preStep("child"), error => error.message.includes(file));
  assert.deepEqual(h.visible("child"), []);
  assert.match(h.prompt("child"), /role=blocked phase=authority/);
}));
