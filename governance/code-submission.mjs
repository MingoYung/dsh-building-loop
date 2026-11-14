import { lineList } from "./preflight.mjs";
import { digest, includes, keyOf, readBytes } from "./policy.mjs";

/** Compute gaps only against reads of the exact current file version. */
export function unreadCodeRanges(seen, sha256, count) {
  const gaps = [];
  let cursor = 1;
  for (const [start, end] of seen?.hash === sha256 ? seen.ranges : []) {
    if (start > count) break;
    if (start > cursor) gaps.push([cursor, start - 1]);
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor <= count) gaps.push([cursor, count]);
  return gaps;
}

/** Open the exact current readback set after checking the signed artifact set. */
export function codeSubmissionReadback(frame, active, spec, goal, qualification) {
  const artifacts = new Map(qualification.artifacts.map(row => [keyOf(row.path), row]));
  const baseline = new Map(active.codeIntake.regression.artifacts.map(row => [keyOf(row.path), row.sha256]));
  const candidate = artifacts.get(keyOf(spec.candidate));
  if (!candidate?.sha256) throw new Error("候选文件尚未交付");
  const targets = new Map(goal.files.map(({ file, sha256 }) => [keyOf(file), { path: file, sha256 }]));
  targets.set(keyOf(candidate.path), candidate);
  for (const file of spec.codeTask.sources) {
    const key = keyOf(file), artifact = artifacts.get(key);
    if (artifact?.sha256 && artifact.sha256 !== baseline.get(key) && includes(frame.reads, file)) targets.set(key, artifact);
  }
  const pending = [];
  for (const { path, sha256 } of targets.values()) {
    if (!includes(frame.reads, path)) throw new Error("送审读回文件不在本阶段读白名单：" + path);
    const bytes = readBytes(frame.root, path);
    if (!bytes || digest(bytes) !== sha256) throw new Error("送审文件已经变化，请重新检查签名回归和当前版本：" + path);
    const lines = lineList(bytes);
    const ranges = unreadCodeRanges(active.seen?.[keyOf(path)], sha256, lines.length);
    if (ranges.length) pending.push({ path, sha256, bytes, lines, ranges });
  }
  return pending;
}

/** Keep full logical lines intact, including the original terminator for identity checks. */
function logicalSpans(content) {
  const spans = [];
  let start = 0;
  for (const ending of content.matchAll(/\r\n|\n|\r/gu)) {
    const end = ending.index + ending[0].length;
    spans.push({ start, end });
    start = end;
  }
  spans.push({ start, end: content.length });
  return spans;
}

/**
 * An exact splice proves positional identity only for full lines wholly inside
 * untouched spans. Echo everything else as actual landed text before stamping it.
 */
export function editedCodeReadback(edit, landed, previousRead, maxBytes) {
  const oldLines = logicalSpans(edit.before);
  const oldStarts = new Map(oldLines.map(({ start, end }, i) => [start, { end, line: i + 1 }]));
  const newLines = logicalSpans(edit.after);
  const visible = lineList(landed);
  const carried = [], rows = [];
  let nextSpan = 0, nextSeen = 0, bytesUsed = 0;
  const seen = previousRead?.hash === edit.beforeSha256 ? previousRead.ranges : [];
  for (const [i, { start, end }] of newLines.entries()) {
    while (edit.untouched[nextSpan]?.newEnd <= start) nextSpan++;
    const span = edit.untouched[nextSpan];
    const from = span && span.newStart <= start && end <= span.newEnd && end > start
      ? span.oldStart + start - span.newStart : undefined;
    const old = oldStarts.get(from);
    const line = i + 1;
    if (old && old.end === from + end - start) {
      while (seen[nextSeen]?.[1] < old.line) nextSeen++;
      if (seen[nextSeen]?.[0] <= old.line) carried.push([line, line]);
      continue;
    }
    const row = [line, visible[i]];
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (rows.length < 250 && bytesUsed + size <= maxBytes) {
      rows.push(row);
      bytesUsed += size;
    }
  }
  return { carried, rows };
}
