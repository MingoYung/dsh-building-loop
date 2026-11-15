import { digest, includes, keyOf, readBytes, replaceWithHistory, researchReceiptPath } from "./policy.mjs";

const RESPONSE_LIMIT = 1024 * 1024;
const PAGE_CHARS = 8_000;

export function researchUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 1000) {
    throw new Error("资料查证只接受无登录凭据的 HTTPS 位置");
  }
  url.hash = "";
  return url.href;
}

/** Preserve the returned text and transport metadata, without claiming that a
 * search result or a successful response establishes publisher authenticity.
 */
export function researchResponse(result, fetchedAt) {
  const body = result?.body?.content;
  if (!Number.isInteger(result?.statusCode) || result.statusCode < 200 || result.statusCode >= 300 ||
    typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > RESPONSE_LIMIT) {
    throw new Error("未取得可登记的有效原文，请核对网址或改用可读取的官方原文");
  }
  return { url: researchUrl(result.url), body, status: result.statusCode,
    truncated: result.truncated === true, fetchedAt, hash: digest(body) };
}

export function researchPage(result, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= result.body.length) throw new Error("资料预览位置无效");
  const end = offset + PAGE_CHARS;
  return { source: result.url, responseSha256: result.hash, offset, text: result.body.slice(offset, end),
    ...(end < result.body.length ? { nextOffset: end } : {}), truncated: result.truncated };
}

/** Match researcher-selected excerpts to the host's actual response before
 * writing an immutable proof input. Excerpts are data, never instructions.
 */
export function sealResearchSource(frame, unit, file, result, excerpts, tag) {
  const spec = frame.policy.units[unit];
  if (!includes(spec.researchSources ?? [], file)) throw new Error("资料位置不在本单元的授权采集槽内");
  if (!Array.isArray(excerpts) || !excerpts.length || excerpts.length > 40 || new Set(excerpts).size !== excerpts.length ||
    excerpts.some(quote => typeof quote !== "string" || !quote.trim() || quote.length > 1200 || /[\r\n\u0000]/u.test(quote) ||
      !result.body.includes(quote) || result.body.indexOf(quote) !== result.body.lastIndexOf(quote))) {
    throw new Error("每条原文摘录须为本次响应内唯一、逐字、可定位的单行片段");
  }
  const key = keyOf(file), records = frame.state.researchAcquisitions ??= {};
  const prior = records[key];
  if (prior && prior.unit !== unit) throw new Error("采集位置属于其他资料单元");
  const snapshot = excerpts.join("\n") + "\n";
  const snapshotSha256 = digest(snapshot);
  const prefix = file.slice(0, file.lastIndexOf("/") + 1);
  const receiptFile = researchReceiptPath(file);
  const sourceRow = { snapshot: file.slice(prefix.length), snapshotSha256, finalUrl: result.url,
    fetchedAt: result.fetchedAt, status: result.status, responseSha256: result.hash, exactQuotes: excerpts,
    responseScope: result.truncated ? "truncated" : "available" };
  const existingSource = readBytes(frame.root, file), existingReceipt = readBytes(frame.root, receiptFile);
  if (!prior && (existingSource || existingReceipt)) {
    // A crash can leave the host receipt ahead of the state. Recover only
    // after matching the newly fetched body and all prior exact excerpts.
    let previous;
    try { previous = existingReceipt && JSON.parse(existingReceipt.toString("utf8")).sources[0]; }
    catch { throw new Error("采集位置存在无法核对的回执"); }
    if (!previous || (existingSource && digest(existingSource) !== snapshotSha256) ||
        Object.keys(sourceRow).some(key => key !== "fetchedAt" && JSON.stringify(sourceRow[key]) !== JSON.stringify(previous[key]))) {
      throw new Error("采集位置已有其他文件，请维护者核对");
    }
  }
  const receipt = JSON.stringify({ sources: [sourceRow] }, null, 2) + "\n";
  const pin = { sha256: snapshotSha256, kind: "secondary", locator: result.url,
    observation: { file: receiptFile, sha256: digest(receipt) } };
  if (prior && JSON.stringify(prior.pin) === JSON.stringify(pin) &&
      digest(readBytes(frame.root, file) ?? "") === pin.sha256 &&
      digest(readBytes(frame.root, receiptFile) ?? "") === pin.observation.sha256) return pin;
  replaceWithHistory(frame.root, receiptFile, receipt, "宿主绑定取得原文及版本", tag, frame.state.markers);
  replaceWithHistory(frame.root, file, snapshot, "宿主登记本次真实获取的原文摘录", tag, frame.state.markers);
  records[key] = { file, unit, pin };
  frame.changed = true;
  return pin;
}

export function restoreResearchPins(policy, state) {
  for (const [key, row] of Object.entries(state.researchAcquisitions ?? {})) {
    if (keyOf(row.file) !== key || !includes(policy.units[row.unit]?.researchSources ?? [], row.file) ||
        Object.hasOwn(policy.sourcePins, key)) continue;
    policy.sourcePins[key] = row.pin;
  }
}
