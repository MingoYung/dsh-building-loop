import { digest, includes, keyOf, readBytes, relativeName, text } from "./policy.mjs";
import { citation, lineList } from "./preflight.mjs";

// This failure belongs to a candidate locator only after the acquisition receipt
// and the current snapshot have been authenticated against the configured pins.
export class UnobservedExcerptError extends Error {}

/** Enumerate explicit factual rows as well as the project's required minimum. */
export function expectedClaims(spec, lines) {
  const discovered = lines.flatMap(line => {
    const match = /^\s*(?:[-*]\s+|\d+[.)]\s+)?(?:\*\*)?(C\d+)(?:\*\*)?\s*[:：]/.exec(line);
    return match ? [match[1]] : [];
  });
  return [...new Set([...spec.claims, ...discovered])];
}

/** Match an independently acquired excerpt receipt to exact snapshot lines. */
function observationRegistry(root, file, bytes, pin) {
  const receipt = pin.observation;
  const raw = readBytes(root, receipt.file);
  if (!raw || digest(raw) !== receipt.sha256) throw new Error("资料的获取回执缺失或已变更 " + receipt.file);
  const sources = JSON.parse(text(raw))?.sources;
  if (!Array.isArray(sources)) throw new Error("获取回执缺少 sources 记录");
  const prefix = receipt.file.slice(0, receipt.file.lastIndexOf("/") + 1);
  const matches = sources.filter(row => typeof row?.snapshot === "string"
    && keyOf(relativeName(prefix + row.snapshot)) === keyOf(file));
  const row = matches[0];
  if (matches.length !== 1 || row.snapshotSha256 !== pin.sha256 || row.finalUrl !== pin.locator
    || !Number.isInteger(row.status) || row.status < 200 || row.status > 299
    || !/^[a-f0-9]{64}$/.test(row.responseSha256 ?? "") || !Number.isFinite(Date.parse(row.fetchedAt))) {
    throw new Error("获取回执的快照、取得位置或响应元数据与当前来源凭据不一致 " + file);
  }
  const excerpts = row.exactQuotes;
  if (!Array.isArray(excerpts) || !excerpts.length || excerpts.length > 250
    || excerpts.some(quote => typeof quote !== "string" || !quote.trim() || /[\r\n]/u.test(quote))
    || new Set(excerpts).size !== excerpts.length) throw new Error("获取回执须列出不同的单行逐字摘录 " + file);
  const lines = lineList(bytes);
  const observed = new Set(excerpts);
  const occurrences = new Map();
  for (const line of lines) if (observed.has(line)) occurrences.set(line, (occurrences.get(line) ?? 0) + 1);
  if (excerpts.some(quote => occurrences.get(quote) !== 1)) throw new Error("逐字摘录在快照中缺失或定位不唯一 " + file);
  return { observation: { ...receipt, fetchedAt: row.fetchedAt, responseSha256: row.responseSha256 },
    registered: lines.flatMap((quote,index)=>observed.has(quote)?[{line:index+1,quote}]:[]) };
}

/** External quotations may use only registered lines; registry metadata is a
 * separate object and must never silently widen this original evidence gate. */
function observedExcerpt(root, file, bytes, pin, start, end) {
  const result=observationRegistry(root,file,bytes,pin),allowed=new Set(result.registered.map(row=>row.line));
  if (Array.from({length:end-start+1},(_,i)=>start+i).some(line=>!allowed.has(line))) {
    throw new UnobservedExcerptError("所引范围含未登记为外部原文的快照行，请使用已登记的逐字摘录行 " + file
      + "（行号：" + [...allowed].slice(0,24).join("、") + (allowed.size>24?"等":"") + "）。如果正文只引了说明行，需退回实际缺源，不要私自换出处通过。");
  }
  return result.observation;
}

/** Recheck both source and optional acquisition receipt before using a saved proof. */
export function sourceVersionCurrent(root, ref) {
  const bytes = readBytes(root, ref.file);
  if (!bytes || digest(bytes) !== ref.sha256) return false;
  const observation = ref.origin?.observation;
  if (!observation) return true;
  const receipt = readBytes(root, observation.file);
  return !!receipt && digest(receipt) === observation.sha256;
}

/** The shared source gate always checks authority and pins. Only the private
 * host revalidation path may omit a new model-read stamp; it never records one. */
function checkedSource(frame,active,spec,input,{whole=false,host=false}={}) {
  const file=relativeName(input?.file),grant=spec.phases[active.phase];
  if(!includes(grant.evidence,file)||!includes(grant.read,file))throw new Error("资料引用不在本轮证据授权中 "+file);
  const bytes=readBytes(frame.root,file),lines=bytes&&lineList(bytes),seen=active.seen?.[keyOf(file)];
  const start=whole?1:input.start,end=whole?lines?.length:input.end;
  if(!bytes||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end>lines.length
    ||(!host&&(seen?.hash!==digest(bytes)||!seen.ranges.some(([a,b])=>a<=start&&b>=end)))) {
    throw new Error("资料引用须对应本轮实际读过的当前原文行 "+file);
  }
  const sha256=digest(bytes),pin=frame.policy.sourcePins[keyOf(file)];
  if(spec.requireSourcePins&&!pin)throw new Error("资料缺少项目维护者登记的来源凭据 "+file);
  if(pin&&pin.sha256!==sha256)throw new Error("资料与登记的原始版本不符，须重新核验来源 "+file);
  return {file,bytes,lines,start,end,sha256,pin};
}

/** Validate a source against actual reads, current bytes and an optional origin pin. */
export function evidenceReference(frame, active, spec, input) {
  const {file,bytes,start,end,sha256,pin}=checkedSource(frame,active,spec,input);
  const observation=pin?.observation&&observedExcerpt(frame.root,file,bytes,pin,start,end);
  return {file,start,end,sha256,origin:pin
    ?{kind:pin.kind,locator:pin.locator,integrity:"matches-pin",...(observation?{observation}:{})}
    :{kind:"unregistered",integrity:"observed-local-bytes"}};
}

/** Read the authenticated registered-excerpt set as its own object. Metadata and
 * unregistered snapshot lines stay distinct from externally quoted evidence. */
export function registeredObservation(frame,active,spec,file,{host=false}={}) {
  const checked=checkedSource(frame,active,spec,{file},{whole:true,host});
  const {bytes,lines,sha256,pin}=checked;
  if(!pin?.observation)throw new Error("该来源没有登记摘录获取回执，不能证明摘录集合的范围");
  const result=observationRegistry(frame.root,checked.file,bytes,pin);
  return {source:{file:checked.file,sha256,origin:{kind:pin.kind,locator:pin.locator,integrity:"matches-pin",observation:result.observation}},
    lines,registered:result.registered};
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
