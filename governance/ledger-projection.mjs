import { digest, includes, keyOf, MANAGED, readBytes, replaceWithHistory, text } from "./policy.mjs";

const FLAT_FORMAT = "building-loop-ledger/2";
const VOLUME_FORMAT = "building-loop-ledger/3";
const VOLUME_LIMIT = 192 * 1024;

/** Derive a host-only namespace from the exact configured document and owner. */
export function ledgerVolumeDirectory(file, owner) {
  return MANAGED + "/ledger/" + digest(keyOf(file) + "\0" + owner);
}

export function isLedgerVolume(file, owner, volume) {
  if (typeof file !== "string" || typeof owner !== "string") return false;
  const directory = ledgerVolumeDirectory(file, owner);
  return typeof volume === "string" && volume.startsWith(directory + "/")
    && /^part-[1-9]\d{0,5}\.md$/u.test(volume.slice(directory.length + 1));
}

/** Render stored strings as literal Markdown text. */
function literal(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()#!|]/g, "\\$&").replace(/\r\n|\n|\r/g, "<br>");
}

/** Keep source locators and the distinction between a decision and its evidence. */
function renderItem(item) {
  const { disposition } = item;
  const { evidence, coverage } = disposition ?? {};
  const lines = ["", "### " + literal(item.id), "", "名称：" + literal(item.title), "当前状态：" + literal(item.status),
    (disposition ? "总控处置理由（模型判断）：" : "账项说明（登记内容）：") + literal(disposition?.basis ?? item.note)];
  if (disposition) lines.push("已登记处置：" + literal(disposition.outcome) + "；核对单元：" + literal(disposition.checkpoint));
  if (evidence) lines.push("已核定位证据：" + literal(evidence.file) + " 第 " + evidence.start + "–" + evidence.end + " 行；SHA-256 " + literal(evidence.sha256));
  if (coverage) lines.push("覆盖关系：" + literal(coverage.unit) + "；验收回执 " + literal(coverage.receipt) + "；回执 SHA-256 " + literal(coverage.receiptHash)
    + "；候选 SHA-256 " + literal(coverage.candidateSha256) + "；目标 SHA-256 " + literal(coverage.goal?.sha256));
  if (item.origin) lines.push("原始请求：" + literal(item.origin.session) + "；事件 " + item.origin.event + "；SHA-256 " + literal(item.origin.sha256));
  if (item.retirement?.outcome === "superseded") {
    const { newUnit, confirmedBy, userEvent, userSha256, oldGoalSha256, newGoalSha256 } = item.retirement;
    lines.push("所有者确认替换为工作单元 " + literal(newUnit) + "；确认会话 " + literal(confirmedBy) + "；事件 " + userEvent
      + "；原文 SHA-256 " + literal(userSha256) + "；原目标 SHA-256 " + literal(oldGoalSha256) + "；新目标 SHA-256 " + literal(newGoalSha256));
  }
  if (item.lastInterruption) lines.push("宿主最近中断：" + literal(item.lastInterruption.phase) + "；" + literal(item.lastInterruption.reason));
  if (item.updatedAt) lines.push("最近登记时间：" + literal(item.updatedAt));
  return lines.join("\n") + "\n";
}

function summary(items, units, owner, revision) {
  const counts = items.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  return ["# 当前总控账本快照", "", "账本 revision：" + revision, "总控：" + literal(owner), "条目总数：" + items.length, "",
    "状态统计：" + Object.entries(counts).map(([status, count]) => literal(status) + " = " + count).join("；"), "",
    "## 当前工作单元", "", "| 单元 | 当前阶段 | 当前回执 |", "|---|---|---|",
    ...units.map(([id, unit]) => "| " + literal(id) + " | " + literal(unit.phase) + " | " + literal(unit.receipt ?? "未生成") + " |")];
}

/** Keep old volume assignments. Only a new row or a row whose amended text
 * exceeds its volume's free space needs a new location.
 */
function splitVolumes(rows, directory, previous) {
  const locations = previous?.locations ?? {};
  const byVolume = new Map();
  const pending = [];
  function add(number, row) {
    let volume = byVolume.get(number);
    if (!volume) {
      const header = "# 账本卷 " + number + "\n";
      volume = { number, header, path: directory + "/part-" + number + ".md", rows: [], bytes: Buffer.byteLength(header) };
      byVolume.set(number, volume);
    }
    if (volume.bytes + row.bytes > VOLUME_LIMIT) return false;
    volume.rows.push(row);
    volume.bytes += row.bytes;
    return true;
  }
  for (const row of rows) {
    const number = locations[row.id];
    const unchanged = !previous?.versions || previous.versions[row.id] === digest(row.content);
    if (unchanged && Number.isSafeInteger(number) && number > 0 && add(number, row)) continue;
    pending.push(row);
  }
  const append = pending.filter(row => {
    const number = locations[row.id];
    return !Number.isSafeInteger(number) || number < 1 || !add(number, row);
  });
  let tail = Math.max(1, previous?.tail ?? 1);
  for (const row of append) {
    if (!add(tail, row) && !add(++tail, row)) throw new Error("单一账项超过分卷大小上限");
  }
  // A moved or handed-off item must not leave an old body looking current.
  for (let number = 1; number <= tail; number++) if (!byVolume.has(number)) add(number, { content: "", bytes: 0, placeholder: true });
  return { tail, volumes: [...byVolume.values()].sort((a, b) => a.number - b.number) };
}

/** Publish the generated files and their rolling histories with the caller's
 * ledger transaction. Small projects keep their legacy flat document.
 */
export function projectLedger(frame, view, units) {
  const file = frame.policy.ledgerDocument;
  if (!file) return { configured: false, exported: false, authority: "host-state",
    next: "项目维护者可配置 ledgerDocument 并加入 coordinator.write；未配置时保留现有文档，宿主台账仍为权威。" };
  if (frame.role !== "coordinator" || !includes(frame.policy.coordinator.write, file)) throw new Error("账本导出缺少总控的精确路径授权");
  const owner = frame.agent.id;
  const items = [...view.items].sort((a, b) => a.id.localeCompare(b.id));
  const rows = items.map(item => {
    const content = renderItem(item);
    return { id: item.id, content, bytes: Buffer.byteLength(content) };
  });
  const previous = frame.state.ledgerProjection;
  const flat = [...summary(items, units, owner, view.revision), "", "## 全部当前账项", "", "| ID | 类型 | 当前状态 | 名称 |", "|---|---|---|---|",
    ...items.map(item => "| " + [item.id, item.kind, item.status, item.title].map(literal).join(" | ")), ""].join("\n")
    + rows.map(row => row.content).join("");
  const directory = ledgerVolumeDirectory(file, owner);
  // Alternating two authorized coordinators changes the shared index. Each
  // keeps its prior partition map under the private namespace for stable reads.
  const saved = frame.state.ledgerVolumeMaps?.[directory];
  const prior = saved;
  const plan = prior || Buffer.byteLength(flat) > VOLUME_LIMIT ? splitVolumes(rows, directory, prior) : null;
  const writes = [];
  function publish(destination, content) {
    return replaceWithHistory(frame.root, destination, content, "宿主导出当前账本 revision " + view.revision,
      owner + "/ledger/" + view.revision, frame.state.markers, batch => writes.push(...batch));
  }
  const locations = Object.create(null);
  const versions = Object.create(null);
  const volumeMetadata = plan?.volumes.map(({ number, path, header, rows }) => {
    const items = rows.filter(row => !row.placeholder);
    for (const row of items) {
      locations[row.id] = number;
      versions[row.id] = digest(row.content);
    }
    const content = header + items.map(row => row.content).join("");
    return { number, path, itemCount: items.length, sha256: publish(path, content).sha256 };
  }) ?? [];
  const content = plan ? [...summary(items, units.filter(([, unit]) => !["closed", "retired"].includes(unit.phase)).slice(0, 20), owner, view.revision),
    "", "## 账本卷", "", "按账项编号用 building_loop_ledger lookup 回查原登记、处置及依据。各卷保留完整可读正文。", "",
    ...volumeMetadata.map(volume => "- " + volume.path + " · " + volume.itemCount + " 项 · SHA-256 " + volume.sha256), ""].join("\n") : flat;
  const result = publish(file, content);
  if (writes.length) frame.ledgerWrites = writes;
  const projection = { format: plan ? VOLUME_FORMAT : FLAT_FORMAT, path: file, revision: view.revision, owner,
    sha256: result.sha256, ...(plan ? { volumes: volumeMetadata } : { itemIds: items.map(item => item.id) }) };
  if (plan) {
    frame.state.ledgerVolumeMaps ??= {};
    const nextMap = { tail: plan.tail, locations, versions };
    if (JSON.stringify(saved) !== JSON.stringify(nextMap)) {
      frame.state.ledgerVolumeMaps[directory] = nextMap;
      frame.changed = true;
    }
  }
  if (JSON.stringify(previous) !== JSON.stringify(projection)) {
    frame.state.ledgerProjection = projection;
    frame.changed = true;
  }
  if (writes.length) frame.changed = true;
  return { configured: true, exported: true, ...projection, itemCount: items.length, changed: writes.length > 0 };
}

/** A stale projection must not be represented as the current item location. */
export function ledgerItemDocument(frame, projection, id, revision) {
  if (!projection || projection.revision !== revision) return null;
  if (projection.format === FLAT_FORMAT && projection.itemIds.includes(id)) return { path: projection.path, sha256: projection.sha256 };
  const locations = frame.state.ledgerVolumeMaps?.[ledgerVolumeDirectory(projection.path, projection.owner)]?.locations;
  const volume = projection.volumes?.find(row => row.number === locations?.[id]);
  return volume ? { path: volume.path, sha256: volume.sha256 } : null;
}
