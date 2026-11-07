import { digest, includes, keyOf, readBytes, relativeName } from "./policy.mjs";
import { citation, lineList } from "./preflight.mjs";

/** Enumerate explicit factual rows as well as the project's required minimum. */
export function expectedClaims(spec, lines) {
  const discovered = lines.flatMap(line => {
    const match = /^\s*(?:[-*]\s+|\d+[.)]\s+)?(?:\*\*)?(C\d+)(?:\*\*)?\s*[:：]/.exec(line);
    return match ? [match[1]] : [];
  });
  return [...new Set([...spec.claims, ...discovered])];
}

/** Validate a source against actual reads, current bytes and an optional origin pin. */
export function evidenceReference(frame, active, spec, input) {
  const file = relativeName(input?.file);
  const grant = spec.phases[active.phase];
  if (!includes(grant.evidence, file)) throw new Error("资料引用不在本轮证据授权中 " + file);
  const bytes = readBytes(frame.root, file);
  const seen = active.seen[keyOf(file)];
  const { start, end } = input;
  if (!bytes || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start
    || end > lineList(bytes).length || seen?.hash !== digest(bytes)
    || !seen.ranges.some(([a, b]) => a <= start && b >= end)) {
    throw new Error("资料引用须对应本轮实际读过的当前原文行 " + file);
  }
  const sha256 = digest(bytes);
  const pin = frame.policy.sourcePins[keyOf(file)];
  if (spec.requireSourcePins && !pin) throw new Error("资料缺少项目维护者登记的来源凭据 " + file);
  if (pin && pin.sha256 !== sha256) throw new Error("资料与登记的原始版本不符，须重新核验来源 " + file);
  return { file, start, end, sha256, origin: pin
    ? { kind: pin.kind, locator: pin.locator, integrity: "matches-pin" }
    : { kind: "unregistered", integrity: "observed-local-bytes" } };
}

/** Build the read inventory from the host's coverage records, never model prose. */
export function readInventory(frame, active) {
  return frame.reads.flatMap(file => {
    const observed = active.seen[keyOf(file)];
    const bytes = observed && readBytes(frame.root, file);
    return observed ? [{ file, sha256: observed.hash, ranges: observed.ranges, current: !!bytes && digest(bytes) === observed.hash }] : [];
  });
}

/** Reject the earlier false-read case even when it is hidden in a source narrative. */
export function checkSourceNarrative(frame, active, note) {
  const candidates = new Set([
    ...frame.policy.coordinator.read, ...frame.policy.instructions,
    ...Object.values(frame.policy.units).flatMap(unit => Object.values(unit.phases).flatMap(phase => phase.read)),
    ...(note.match(/[\p{L}\p{N}_.@-]+(?:\/[\p{L}\p{N}_.@-]+)+\.(?:md|json|csv|txt|yml|yaml|mjs|js|py)\b/gu) ?? []),
  ]);
  for (const file of candidates) {
    if (!citation(note, file)) continue;
    const seen = active.seen[keyOf(file)];
    const bytes = includes(frame.reads, file) && readBytes(frame.root, file);
    if (!bytes || seen?.hash !== digest(bytes)) {
      throw new Error("资料说明提及本轮未实际读取的文件 " + file + "，请读取后再判断，或改在 unverifiedSources 中记录");
    }
  }
}

/** Store unresolved factual prose as exact candidate-line findings for supplement. */
export function coverageFindings(value, lines) {
  if (!Array.isArray(value) || value.length > 64) throw new Error("请用 unlisted 列出未编号、仍需核验的事实行，完成覆盖核对时填 []");
  return value.map(item => {
    if (!Number.isSafeInteger(item?.line) || item.line < 1 || item.line > lines.length
      || typeof item.basis !== "string" || !item.basis.trim() || item.basis.length > 1200) throw new Error("未登记事实须给候选行号及原因");
    const text = lines[item.line - 1];
    if (!text.trim()) throw new Error("unlisted 只登记尚未编号的真实待核事实，不能把空行列为退回项；没有待核事实时填 []");
    if (expectedClaims({ claims: [] }, [text]).length) throw new Error("已编号断言请在 checks 逐条判断，不得重复填入 unlisted；没有其他待核事实时填 []");
    return { line: item.line, basis: item.basis.trim(), text };
  });
}
