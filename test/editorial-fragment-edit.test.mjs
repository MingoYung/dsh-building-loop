import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { documentCoverage } from "../governance/coverage.mjs";
import { digest } from "../governance/policy.mjs";
import { fixture, host, policy } from "./helpers.mjs";

const candidate = "candidate.md";
const duplicate = "重复的待核段。";
const before = Buffer.from("\uFEFF# 核验🌧️\r\n- C1：原稿缺证。" + duplicate + "\r\n另一段。" + duplicate + "\n末行保持。\r");
const replacement = "原始记录确认本段的表述📌。";
const note = "补查后按原始记录修正这一处表述";

test("the supplement tool uses a read block ID to edit one repeated fragment and preserves adjacent bytes", () =>
  fixture(async (root, write) => {
    const configured = structuredClone(policy);
    const unit = configured.units.K01;
    unit.claims = ["C1"];
    unit.calculations = {};
    unit.phases.supplement.read.push("notes.md");
    unit.phases.supplement.write.push("notes.md");
    write("BUILDING-LOOP.json", JSON.stringify(configured));
    write(candidate, before);
    write("notes.md", before);

    const initial = documentCoverage(before).blocks;
    const repeated = initial.filter(block => block.text === duplicate);
    assert.deepEqual(repeated.map(({ line }) => line), [2, 3]);
    const edits = (block = repeated[0].id) => [{ block, newText: replacement }];
    const initialArgs = { beforeSha256: digest(before), note };
    const lineEdit = (line, newText = replacement) => [{ line, newText }];
    const documentPath = path.join(root, candidate);
    const harness = host(root, { automaticCoverage: false });
    const executor = (await harness.flow("root", "advance")).childId;
    assert.equal((await harness.file(executor, "read", candidate)).fragments, undefined);
    await assert.rejects(harness.file(executor, "edit", candidate, { ...initialArgs, edits: edits() }), /补查执行者|写白名单/);
    await assert.rejects(harness.file(executor, "edit", candidate, { ...initialArgs, edits: lineEdit(2) }), /补查执行者|写白名单/);
    await harness.flow(executor, "submit");

    const reviewer = (await harness.flow("root", "advance")).childId;
    const { coverage } = await harness.flow(reviewer, "prepare");
    assert.equal((await harness.file(reviewer, "read", candidate)).fragments, undefined);
    await assert.rejects(harness.file(reviewer, "edit", candidate, { ...initialArgs, edits: edits() }), /写白名单/);
    const finding = { kind: "missing-evidence", quote: "原稿缺证", fix: "按原始记录补查并局部改稿" };
    const basis = "目前这条来稿缺少能够支持结论的原始记录，须退回补查。";
    await harness.coverage(reviewer, "record", { entries: coverage.blocks.map(block => ({ block: block.id, parts: [
      block.text.includes(finding.quote)
        ? { kind: "direct", status: "unsupported", sourceRelation: "insufficient", basis, finding }
        : { kind: "nonfactual", status: "supported", basis: "测试文稿的结构标签，仅用于核对锚点和保留范围。" },
    ] })) });
    const result = await harness.flow(reviewer, "review", { checks: [{ id: "C1", status: "unsupported", basis, finding }] });
    assert.equal(result.phase, "supplement-ready");
    const repair = (await harness.flow("root", "advance")).childId;

    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: edits() }), /读取当前版本/);
    const read = await harness.file(repair, "read", candidate, { start: 2, count: 1 });
    assert.deepEqual(read.fragments, initial.filter(block => block.line === 2).map(({ id, line, start, end }) => ({ block: id, line, start, end })));
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: edits(repeated[1].id) }), /不在当前实际已读范围/);
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: lineEdit(3) }), /不在当前实际已读范围/);
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, oldText: duplicate, newText: replacement }), /anchor-ambiguous.*\{line,newText\}/u);
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: [...edits(), ...edits()] }), /不能重叠/);
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: [...edits(), ...lineEdit(2)] }), /不能重叠/);
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: [{ ...edits()[0], line: 2 }] }), /块编号或行号/);
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: [{ ...edits()[0], newText: "跨行\n改稿" }] }), /单行/);
    assert.equal((await harness.file(repair, "read", "notes.md")).fragments, undefined);
    await assert.rejects(harness.file(repair, "edit", "notes.md", { ...initialArgs, edits: edits() }), /授权候选文稿/);
    assert.deepEqual(fs.readFileSync(documentPath), before);

    const landed = await harness.file(repair, "edit", candidate, { ...initialArgs, edits: edits() });
    const expected = Buffer.from(before.toString("utf8").replace(duplicate, replacement));
    assert.equal(landed.sha256, digest(expected));
    assert.deepEqual(fs.readFileSync(documentPath), expected);
    assert.deepEqual(fs.readFileSync(path.join(root, ".building-loop", "latest_backup", candidate)), before);
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: edits() }), /stale-source/);
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, beforeSha256: landed.sha256,
      edits: edits(repeated[1].id) }), /读取当前版本/);
    assert.deepEqual(fs.readFileSync(documentPath), expected);

    const current = await harness.file(repair, "read", candidate, { start: 1, count: 2 });
    const corrected = "- C1：按核验记录改正。（出处：evidence.md 第 2 行）";
    await assert.rejects(harness.file(repair, "edit", candidate, { ...initialArgs, edits: lineEdit(2, corrected) }), /stale-source/);
    const lineLanded = await harness.file(repair, "edit", candidate, {
      beforeSha256: current.sha256, note, edits: lineEdit(2, corrected),
    });
    const wholeLineExpected = Buffer.from("\uFEFF# 核验🌧️\r\n" + corrected + "\r\n另一段。" + duplicate + "\n末行保持。\r");
    assert.equal(lineLanded.sha256, digest(wholeLineExpected));
    assert.deepEqual(fs.readFileSync(documentPath), wholeLineExpected);
    assert.deepEqual(fs.readFileSync(path.join(root, ".building-loop", "latest_backup", candidate)), before);
  }));
