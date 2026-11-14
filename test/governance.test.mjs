import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authority, readBytes, relativeName, replaceWithHistory } from "../governance/policy.mjs";

function fixture(run) {
  const base = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, "dsh-building-loop-test-"));
  const root = path.join(dir, "workspace");
  fs.mkdirSync(root);
  try { return run(root, dir); }
  finally {
    assert.equal(path.dirname(fs.realpathSync.native(dir)), base);
    assert.match(path.basename(dir), /^dsh-building-loop-test-/);
    fs.rmSync(dir, { recursive: true });
  }
}

test("rejects glob, escape and Windows path aliases", () => {
  for (const name of ["../outside", "a/../outside", "/abs", "C:drive", "C:\\abs", "\\\\server\\share",
    "**/*", "part/file.txt:stream", "file.txt.", "file.txt ", "NUL.txt", "COM1.md",
    "BUILDING-LOOP.json", ".building-loop/changes/candidate.md.md", ".git/config"]) {
    assert.throws(() => relativeName(name), name);
  }
  assert.equal(relativeName("模块\\候选.md"), "模块/候选.md");
});

test("rejects an explicitly listed link, hard link or junction", () => fixture((root, dir) => {
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const secret = path.join(outside, "data.md");
  fs.writeFileSync(secret, "outside");
  fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  fs.linkSync(secret, path.join(root, "alias.md"));
  assert.throws(() => readBytes(root, "linked/data.md"), /链接|别名/);
  assert.throws(() => readBytes(root, "alias.md"), /链接|别名/);
}));

test("keeps one byte-exact backup per file and same-phase retries", () => fixture(root => {
  const source = path.join(root, "candidate.md");
  fs.writeFileSync(source, "original\n");
  const markers = Object.create(null);
  const first = replaceWithHistory(root, "candidate.md", "revision 1\n", "correct evidence", "K01/1", markers);
  assert.equal(fs.readFileSync(path.join(root, first.backup), "utf8"), "original\n");
  const next = replaceWithHistory(root, "candidate.md", "revision 2\n", "refine wording", "K01/1", markers);
  assert.equal(fs.readFileSync(path.join(root, next.backup), "utf8"), "original\n");
  const log = fs.readFileSync(path.join(root, next.log));
  assert.equal(replaceWithHistory(root, "candidate.md", "revision 2\n", "retry", "K01/1", markers).changed, false);
  assert.deepEqual(fs.readFileSync(path.join(root, next.log)), log);
  const later = replaceWithHistory(root, "candidate.md", "revision 3\n", "new batch", "K01/2", markers);
  assert.equal(fs.readFileSync(path.join(root, later.backup), "utf8"), "revision 2\n");
  assert.equal(fs.readFileSync(source, "utf8"), "revision 3\n");
}));

test("forbids coordinator writes to candidate and evidence or duplicate receipts", () => fixture(root => {
  const doc = {
    spec: "building-loop/1",
    coordinator: { read: ["overview.md"], write: ["ledger.md"] },
    units: { K01: {
      candidate: "candidate.md",
      phases: {
        intake: { read: ["candidate.md"] },
        "first-review": { read: ["candidate.md", "source.csv"], evidence: ["source.csv"], receipt: "first.json" },
        supplement: { read: ["candidate.md"], write: ["candidate.md"] },
        "final-review": { read: ["candidate.md", "source.csv"], evidence: ["source.csv"], receipt: "final.json" },
      },
    } },
  };
  function install() { fs.writeFileSync(path.join(root, "BUILDING-LOOP.json"), JSON.stringify(doc)); }
  install();
  assert.equal(authority(root).units.K01.continuation, "reuse");
  doc.coordinator.write.push("candidate.md");
  install();
  assert.throws(() => authority(root), /写入授权/);
  doc.coordinator.write.pop();
  doc.coordinator.write.push("source.csv");
  install();
  assert.throws(() => authority(root), /不能授予/);
  doc.coordinator.write.pop();
  doc.units.K01.phases["final-review"].receipt = "first.json";
  install();
  assert.throws(() => authority(root), /回执路径重复/);
}));
