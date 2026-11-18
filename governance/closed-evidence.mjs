import fs from "node:fs";
import path from "node:path";
import { digest, keyOf, readBytes, replaceBytes, text } from "./policy.mjs";

// Archive only bulky evidence after the existing acceptance and ledger gates close the unit.
// Routing, grants, task/goal status, receipt hashes and the ledger stay in the hot state.
const fields = ["proof", "coverage", "reviewerProofMemo", "auditorProofMemo", "codeIntake"];
const reference = "closedEvidence";
const version = "building-loop-closed-evidence/1";
const threshold = 64 * 1024;
const slot = new WeakMap();
// A restarted writer checks for an interrupted publication on its first
// state change. Bound the process cache across many independent workspaces.
const swept = new Set();
const json = value => Buffer.from(JSON.stringify(value), "utf8");

function archivePath(file, sha256) {
  if (!/^[0-9a-f]{64}\.json$/u.test(file) || !/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("宿主关单证据路径无效");
  return file + ".evidence/" + sha256 + ".json";
}

/** Only host-shaped immutable blobs for this exact workspace are collectible.
 * A hash-shaped name, unrelated file, link or corrupted blob is insufficient. */
function removeOwnedBlob(home,file,sha256,knownUnits,limit) {
  const name=archivePath(file,sha256), bytes=readBytes(home,name,limit);
  if(!bytes||digest(bytes)!==sha256)return;
  const saved=JSON.parse(text(bytes));
  if(saved?.spec!==version||saved.workspace!==file||!knownUnits.has(saved.unit)||
    !saved.evidence||typeof saved.evidence!=="object"||Array.isArray(saved.evidence))return;
  const keys=Object.keys(saved.evidence);
  if(!keys.length||!keys.every(key=>fields.includes(key)))return;
  replaceBytes(home,name,null,bytes,limit);
}

/** If either authority cannot be read as a known state, defer collection. */
function indexArchives(bytes) {
  if(bytes===null)return {ids:[],hashes:[]};
  const state=JSON.parse(text(bytes));
  if(state.spec!=="building-loop-state/1"||!state.units||typeof state.units!=="object"||Array.isArray(state.units))
    throw new Error("未知的宿主状态，已延后回收关单证据");
  const ids=Object.keys(state.units),hashes=[];
  for(const unit of Object.values(state.units))if(Object.hasOwn(unit,reference)) {
    if(unit[reference]?.spec!==version||!/^[a-f0-9]{64}$/u.test(unit[reference].sha256))throw new Error("未知归档索引，已延后回收关单证据");
    hashes.push(unit[reference].sha256);
  }
  return {ids,hashes};
}

/** Recovery runs under the workspace writer lock, before this transaction
 * publishes any sidecar. Uncommitted journal images remain untouchable.
 * Ordinary state/prepare writes do not enumerate the evidence directory. */
function pruneInterruptedPublication(home,file,next,limit) {
  const dir=path.join(home,file+".evidence"),entry=fs.lstatSync(dir,{throwIfNoEntry:false});
  if(!entry?.isDirectory()||entry.isSymbolicLink()||keyOf(fs.realpathSync.native(dir))!==keyOf(dir)||
      fs.lstatSync(path.join(home,file+".ledger-txn"),{throwIfNoEntry:false}))return;
  const current=readBytes(home,file,limit);
  if(!current)return;
  const keep=[indexArchives(current),indexArchives(readBytes(home,file+".bak",limit)),indexArchives(next)];
  const live=new Set(keep.flatMap(index=>index.hashes)),ids=new Set(keep.flatMap(index=>index.ids));
  for(const fileEntry of fs.readdirSync(dir,{withFileTypes:true})) {
    if(!fileEntry.isFile()||!/^([a-f0-9]{64})\.json$/u.test(fileEntry.name))continue;
    const hash=fileEntry.name.slice(0,64);
    if(live.has(hash))continue;
    try { removeOwnedBlob(home,file,hash,ids,limit); } catch { /* Foreign, locked or altered files are never collected blindly. */ }
  }
}

/** A successful commit rotates old into the one backup. Only the evicted
 * backup's blobs can become obsolete here; keep anything still in either root. */
export function retireBackupEvidence(home,file,evicted,backup,current,limit) {
  if(!evicted?.includes('"closedEvidence"')||fs.lstatSync(path.join(home,file+".ledger-txn"),{throwIfNoEntry:false}))return;
  const prior=indexArchives(evicted), keep=[indexArchives(backup),indexArchives(current)];
  const live=new Set(keep.flatMap(index=>index.hashes));
  const ids=new Set(prior.ids);
  for(const hash of new Set(prior.hashes))if(!live.has(hash))removeOwnedBlob(home,file,hash,ids,limit);
}

/** Only an authenticated, workspace/unit-bound sidecar can become runtime evidence. */
export function readClosedEvidence(home, file, id, ref, limit) {
  const bytes = readBytes(home, archivePath(file, ref.sha256), limit);
  if (!bytes || bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) throw new Error("关单证据归档缺失或摘要不符");
  const data = JSON.parse(text(bytes));
  if (data.spec !== version || data.workspace !== file || data.unit !== id ||
      JSON.stringify(Object.keys(data.evidence)) !== JSON.stringify(ref.fields)) throw new Error("关单证据归档归属或字段不符");
  return data.evidence;
}

/** Keep ordinary object reads, spread and edits working for old acceptance/reopen paths.
 * The host resolves an archive only when an evidence field is actually consumed. */
export function openWorkspaceEvidence(home, file, state, limit) {
  for (const [id, unit] of Object.entries(state.units)) {
    if (!Object.hasOwn(unit, reference)) continue;
    const ref = unit[reference];
    if (ref?.spec !== version || !Array.isArray(ref.fields) || !ref.fields.length || ref.fields.length > fields.length ||
        ref.fields.some(k => !fields.includes(k) || Object.hasOwn(unit,k)) || new Set(ref.fields).size !== ref.fields.length ||
        !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > limit) throw new Error("关单证据归档索引无效");
    archivePath(file, ref.sha256);
    delete unit[reference];
    const index = { ref, getters: new Map() };
    slot.set(unit,index);
    for (const key of ref.fields) {
      const get = () => (index.data ??= readClosedEvidence(home,file,id,ref,limit))[key];
      index.getters.set(key,get);
      Object.defineProperty(unit,key,{enumerable:true,configurable:true,get,
        set(value) { Object.defineProperty(unit,key,{value,writable:true,enumerable:true,configurable:true}); }});
    }
  }
  return state;
}

/** Publish immutable evidence first and the compact host pointer in the existing transaction.
 * A crash before the host commit leaves the prior state and backup readable. A retry with
 * identical evidence reuses the same blob. Active units always retain their full evidence. */
export function encodeWorkspaceEvidence(home, file, state, limit, maintenance) {
  const units = Object.create(null), pending = [];
  for (const [id, unit] of Object.entries(state.units)) {
    units[id] = unit;
    if (unit.phase !== "closed") continue;
    const keys = fields.filter(key => {
      const descriptor = Object.getOwnPropertyDescriptor(unit, key);
      return descriptor && (descriptor.get || descriptor.value !== undefined);
    });
    if (!keys.length) continue;
    const old = slot.get(unit);
    let ref;
    if (old && !old.data && keys.length === old.ref.fields.length &&
        keys.every(key => old.getters.has(key) && Object.getOwnPropertyDescriptor(unit,key).get === old.getters.get(key))) {
      ref = old.ref;
    } else {
      const evidence = Object.fromEntries(keys.map(key => [key,unit[key]]));
      const bytes = json({spec:version,workspace:file,unit:id,evidence});
      if (bytes.length < threshold) continue;
      if (bytes.length > limit) throw new Error("单份关单证据超过宿主归档上限");
      ref = {spec:version,sha256:digest(bytes),bytes:bytes.length,fields:keys};
      pending.push({ref,bytes});
    }
    // Copy hot values alone; Object spread would unnecessarily trigger every archive getter.
    const hot = Object.create(null);
    for (const key of Object.keys(unit)) if (!keys.includes(key)) hot[key] = unit[key];
    hot[reference] = ref;
    units[id] = hot;
  }
  const next = Buffer.from(JSON.stringify({...state,units},null,2) + "\n","utf8");
  if (next.length > limit) throw new Error("内容超过受控工具的大小上限");
  const workspace=path.join(home,file);
  if(maintenance&&(pending.length||!swept.has(workspace))) {
    try {
      pruneInterruptedPublication(home,file,next,limit);
      if(swept.size>=128)swept.delete(swept.values().next().value);
      swept.add(workspace);
    } catch(error) { maintenance.warnCleanup?.(error); }
  }
  for (const {ref,bytes} of pending) {
    const name = archivePath(file,ref.sha256), saved = readBytes(home,name,limit);
    if (!saved) replaceBytes(home,name,bytes,null,limit);
    else if (!saved.equals(bytes)) throw new Error("关单证据归档摘要冲突");
  }
  return next;
}
