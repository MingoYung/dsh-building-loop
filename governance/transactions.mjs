import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AUTHORITY, digest, hierarchyBodyPath, historyPaths, keyOf, readBytes, replaceBytes, text } from "./policy.mjs";
import { isLedgerVolume } from "./ledger-projection.mjs";

export const STATE_LIMIT = 8 * 1024 * 1024;
export const LEDGER_TURN_ENDS = Object.freeze(["error", "max-tokens", "blocked", "completed", "aborted", "interrupted"]);
const JOURNAL_LIMIT = 2 * STATE_LIMIT;
const FILE_LIMIT = 256 * 1024;
const JOURNAL_SPEC = "building-loop-ledger-transaction/1";
const VOLUME_JOURNAL_SPEC = "building-loop-ledger-transaction/2";
const MODULE_JOURNAL_SPEC = "building-loop-module-transaction/1";
const EVENT_SPEC = "building-loop-ledger-event/1";
const EVENT_LIMIT = 4096;
const EVENT_NAME = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.json$/u;
const OWNER = /^owner-([1-9]\d{0,9})-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const WINDOWS_CLAIM_DELAYS = [10, 25, 50, 100];
const CLAIM_WAIT = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_LOCK_ERRORS = new Set(["EPERM", "EBUSY", "EACCES", "EBADF"]);
const unknownLock = () => new Error("工作台账锁来源未知，需维护者确认旧进程已退出后核对宿主状态");
const stateDigest = bytes => bytes === null ? null : digest(bytes);
const journalName = file => file + ".ledger-txn";
const recordBytes = value => value === null ? null : value.toString("base64");

/** Only an unacquired lock may be retried as ordinary contention. */
export class WorkspaceLockBusy extends Error {
  constructor() {
    super("工作台账正在更新，请按当前台账重试");
    this.code = "BUILDING_LOOP_LOCK_BUSY";
  }
}

class LockPathObservation extends Error {}

/** Windows can expose a delete-pending directory between lstat, realpath,
 * readdir and rmdir. Re-read the name without following a link. A stable
 * noncanonical path or persistent permission failure still fails closed.
 */
function observeLock(lock, operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (error.code === "ENOENT") return;
      const delay = WINDOWS_CLAIM_DELAYS[attempt];
      if (process.platform !== "win32" || delay === undefined ||
          !(error instanceof LockPathObservation || WINDOWS_LOCK_ERRORS.has(error.code))) {
        throw error instanceof LockPathObservation ? unknownLock() : error;
      }
      try { if (!fs.lstatSync(lock, { throwIfNoEntry: false })) return; }
      catch (probe) {
        if (probe.code === "ENOENT") return;
        if (!WINDOWS_LOCK_ERRORS.has(probe.code)) throw probe;
      }
      Atomics.wait(CLAIM_WAIT, 0, 0, delay);
    }
  }
}

/** Remove the empty directory only. A new owner always publishes it nonempty. */
function removeEmptyLock(lock) {
  try { fs.rmdirSync(lock); }
  catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) return;
    if (process.platform === "win32" && WINDOWS_LOCK_ERRORS.has(error.code)) {
      const entry = fs.lstatSync(lock, { throwIfNoEntry: false });
      // A replacement owner may have published between the empty read and
      // rmdir. Preserve it and let the next claim observe the new owner.
      if (!entry || entry.isDirectory() && !entry.isSymbolicLink() && fs.readdirSync(lock).length) return;
    }
    throw error;
  }
}

/** Owner names are unique, so concurrent recovery cannot unlink a fresh claim. */
function dropOwner(lock, owner) {
  observeLock(lock, () => fs.unlinkSync(path.join(lock, owner)));
  observeLock(lock, () => removeEmptyLock(lock));
}

/** Retire only a verifiably dead PID. Alive, reused, inaccessible and legacy
 * owners stay in place. An interrupted retirement can leave an empty directory.
 */
function retireLock(lock) {
  const entry = fs.lstatSync(lock, { throwIfNoEntry: false });
  if (!entry) return;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw unknownLock();
  if (keyOf(fs.realpathSync.native(lock)) !== keyOf(lock)) throw new LockPathObservation();
  const owners = fs.readdirSync(lock, { withFileTypes: true });
  if (!owners.length) { removeEmptyLock(lock); return; }
  const match = owners.length === 1 && owners[0].isFile() && OWNER.exec(owners[0].name);
  if (!match || Number(match[1]) > 0x7fffffff) throw unknownLock();
  try { process.kill(Number(match[1]), 0); }
  catch (error) {
    if (error.code !== "ESRCH") throw new WorkspaceLockBusy();
    dropOwner(lock, owners[0].name);
    return;
  }
  throw new WorkspaceLockBusy();
}

/** Claim the lock with a complete same-volume owner directory. This avoids
 * an interruption between claiming an empty file and writing its owner PID.
 */
export function withWorkspaceLock(home, file, operation, warnCleanup) {
  const lock = path.join(home, file + ".lock");
  observeLock(lock, () => retireLock(lock));
  const occupied = () => observeLock(lock, () => fs.lstatSync(lock, { throwIfNoEntry: false }));
  // Windows mkdtemp needs an explicit extended-length path. Keep the normal
  // sibling path for owner creation, publication and cleanup of this claim.
  const prefix = path.join(home, file + ".claim-");
  const staged = path.join(path.dirname(prefix), path.basename(fs.mkdtempSync(path.toNamespacedPath(prefix))));
  const owner = "owner-" + process.pid + "-" + randomUUID();
  let acquired = false;
  try {
    fs.closeSync(fs.openSync(path.join(staged, owner), "wx", 0o600));
    for (let attempt = 0; ; attempt++) {
      if (occupied()) throw new WorkspaceLockBusy();
      try { fs.renameSync(staged, lock); break; }
      catch (error) {
        if (occupied()) throw new WorkspaceLockBusy();
        // Windows can briefly refuse the same-volume directory rename while
        // no owner has won. Retry the staged claim only, before any writes.
        const delay = WINDOWS_CLAIM_DELAYS[attempt];
        if (process.platform !== "win32" || delay === undefined || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        Atomics.wait(CLAIM_WAIT, 0, 0, delay);
      }
    }
    acquired = true;
    return operation();
  } finally {
    // Cleanup is separate from the operation result. In particular, a failed
    // rmdir after commit must not cause the host to replay the mutation.
    try { dropOwner(acquired ? lock : staged, owner); }
    catch (error) { warnCleanup?.(error); }
  }
}

export function hasLedgerJournal(home, file) {
  return !!fs.lstatSync(path.join(home, journalName(file)), { throwIfNoEntry: false });
}

const eventDirectory = file => "automatic/" + file;
const eventIdentity = event => digest(event.session + "/" + event.seq);
const sessionId = value => typeof value === "string" && !!value && value.length <= 200 && !/[\x00-\x1f]/u.test(value);

/** Publish an immutable intent before attempting the contended workspace lock.
 * Distinct delivery filenames avoid replacing another process's open file.
 * Replays still share one logical ID. The full user message stays in DSH.
 */
export function persistLedgerEvent(home, file, event) {
  const name = eventDirectory(file) + "/" + eventIdentity(event) + "." + randomUUID() + ".json";
  const raw = Buffer.from(JSON.stringify({ spec: EVENT_SPEC, ...event }));
  replaceBytes(home, name, raw, null, EVENT_LIMIT);
}

/** Temporary staging files never count as complete events. */
function pendingEventNames(home, file) {
  const directory = path.join(home, eventDirectory(file));
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!entry) return [];
  if (!entry.isDirectory() || entry.isSymbolicLink() || keyOf(fs.realpathSync.native(directory)) !== keyOf(directory)) {
    throw new Error("自动账本事件目录不是普通宿主目录");
  }
  return fs.readdirSync(directory).filter(leaf => EVENT_NAME.test(leaf));
}

export const hasPendingLedgerEvents = (home, file) => pendingEventNames(home, file).length > 0;

/** Validate protected host intents before applying them inside the workspace transaction. */
export function pendingLedgerEvents(home, file) {
  const entries = [];
  for (const leaf of pendingEventNames(home, file)) {
    const name = eventDirectory(file) + "/" + leaf;
    const raw = readBytes(home, name, EVENT_LIMIT);
    if (!raw) continue;
    const event = JSON.parse(text(raw));
    const request = event?.kind === "request" && typeof event.title === "string" && !!event.title &&
      event.title.length <= 120 && /^[a-f0-9]{64}$/u.test(event.sha256);
    const end = event?.kind === "turn-end" && sessionId(event.parent) && LEDGER_TURN_ENDS.includes(event.reason);
    if (event?.spec !== EVENT_SPEC || !sessionId(event.session) || !Number.isSafeInteger(event.seq) || event.seq < 0 ||
        !Number.isSafeInteger(event.time) || event.time < 0 || !(request || end) || !leaf.startsWith(eventIdentity(event) + ".")) {
      throw new Error("自动账本事件记录损坏，需维护者核对");
    }
    entries.push({ name, raw, event });
  }
  return entries.sort((a, b) => a.event.time - b.event.time || a.event.session.localeCompare(b.event.session) || a.event.seq - b.event.seq);
}

/** Repeated application after a crash is harmless; remove only after commit. */
export function clearLedgerEvents(home, pending, warnCleanup) {
  for (const { name, raw } of pending) {
    try { replaceBytes(home, name, null, raw, EVENT_LIMIT); }
    catch (error) { warnCleanup(error); }
  }
}

/** Refuse noncanonical stored bytes or oversized before images before writes. */
function storedBytes(value, limit) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("未完成账本事务的改前记录无效");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit || recordBytes(bytes) !== value) throw new Error("未完成账本事务的改前记录无效");
  return bytes;
}

function policyCurrent(root, expected) {
  if (stateDigest(readBytes(root, AUTHORITY)) !== expected) throw new Error("未完成账本事务的授权清单已变化，需维护者核对");
}

/** Reconcile a generated ledger or module transaction under its workspace lock.
 * The authoritative state rename is the commit point. Before it, restore only
 * known transaction bytes; after it, require that all published bytes match.
 */
export function recoverLedgerJournal(home, file, root, policy, managed = false) {
  const name = journalName(file);
  const raw = readBytes(home, name, JOURNAL_LIMIT);
  if (!raw) return;
  let journal;
  try { journal = JSON.parse(text(raw)); }
  catch { throw new Error("未完成账本事务的日志损坏，需维护者核对"); }
  if (!journal || journal.policy !== policy.hash) {
    throw new Error("未完成账本事务的授权清单或日志不匹配，需维护者核对");
  }
  let required, optional = [];
  if (journal.spec === MODULE_JOURNAL_SPEC && policy.hierarchy && (!policy.hierarchy.private || managed)) {
    required = [hierarchyBodyPath(policy.hierarchy, journal.module, managed), policy.hierarchy.index.path];
    optional = [policy.hierarchy.overview.path];
  } else if (journal.spec === JOURNAL_SPEC && typeof policy.ledgerDocument === "string" && journal.ledger === policy.ledgerDocument) {
    required = [journal.ledger];
  } else if (journal.spec === VOLUME_JOURNAL_SPEC && typeof policy.ledgerDocument === "string" && journal.ledger === policy.ledgerDocument
      && typeof journal.owner === "string" && Array.isArray(journal.volumes) && journal.volumes.length > 0
      && new Set(journal.volumes).size === journal.volumes.length && journal.volumes.every(file => isLedgerVolume(journal.ledger, journal.owner, file))) {
    // A listed volume must have both its body and history in the journal. The
    // index may be unchanged when regenerating a missing or restored volume.
    required = journal.volumes;
    optional = [journal.ledger];
  } else throw new Error("未完成账本或模块事务的授权清单与日志不匹配，需维护者核对");
  const isDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (!isDigest(journal.after) || journal.before !== null && !isDigest(journal.before) ||
      !Array.isArray(journal.writes) || journal.writes.length < required.length * 2 ||
      journal.writes.length > (required.length + optional.length) * 4) {
    throw new Error("未完成账本事务的版本记录无效，需维护者核对");
  }
  const allowed = new Set([...required, ...optional].flatMap(item => [item, ...Object.values(historyPaths(item))]));
  const state = stateDigest(readBytes(home, file, STATE_LIMIT));
  // Older publications could have identical state bytes on both sides. With
  // no durable commit point, restore their known before images for a safe retry.
  const committed = journal.before !== journal.after && state === journal.after;
  if (!committed && state !== journal.before) throw new Error("未完成账本事务的宿主状态已变化，需维护者核对");
  const targets = journal.writes.map(item => {
    if (!item || !allowed.delete(item.file) || !isDigest(item.after)) throw new Error("未完成账本事务的写入范围无效，需维护者核对");
    return { root, file: item.file, before: storedBytes(item.before, FILE_LIMIT), after: item.after, limit: FILE_LIMIT };
  });
  if (required.some(item => allowed.has(item) || allowed.has(historyPaths(item).log)) ||
      optional.some(item => allowed.has(item) !== allowed.has(historyPaths(item).log))) {
    throw new Error("未完成账本或模块事务的正文或更新日志记录缺失");
  }
  const backupBefore = storedBytes(journal.backupBefore, STATE_LIMIT);
  if (journal.before !== null) targets.push({ root: home, file: file + ".bak", before: backupBefore, after: journal.before, limit: STATE_LIMIT });
  // Read and classify every target before modifying any of them. Unknown edits
  // leave both the journal and all workspace files available to the maintainer.
  const measured = targets.map(item => {
    const current = readBytes(item.root, item.file, item.limit);
    const currentHash = stateDigest(current);
    const matchesBefore = currentHash === stateDigest(item.before);
    if (currentHash !== item.after && (committed || !matchesBefore)) {
      throw new Error("未完成账本事务的文件发生外部变化，已保留当前内容，需维护者核对 " + item.file);
    }
    return { ...item, current, matchesBefore };
  });
  policyCurrent(root, policy.hash);
  if (stateDigest(readBytes(home, file, STATE_LIMIT)) !== state) throw new Error("未完成账本事务的宿主状态已变化，需维护者核对");
  if (!committed) for (const item of measured.reverse()) {
    if (item.matchesBefore) continue;
    policyCurrent(root, policy.hash);
    replaceBytes(item.root, item.file, item.before, item.current, item.limit);
  }
  replaceBytes(home, name, null, raw, JOURNAL_LIMIT);
}

/** Persist generated ledger or module files before the authoritative state, with one
 * recoverable journal. Ordinary state-only transactions retain their path.
 */
export function commitWorkspaceState(home, frame, next, warnCleanup) {
  if (next.length > STATE_LIMIT) throw new Error("内容超过受控工具的大小上限");
  const { file, root, policy, old, ledgerWrites, hierarchyWrites } = frame;
  const writes = hierarchyWrites?.writes ?? ledgerWrites;
  // Idempotent retry must not replace the one rolling pre-commit backup.
  if (!writes?.length && old?.equals(next)) return;
  const backup = file + ".bak";
  const backupBefore = old ? readBytes(home, backup, STATE_LIMIT) : null;
  if (!writes?.length) {
    if (old) replaceBytes(home, backup, old, backupBefore, STATE_LIMIT);
    replaceBytes(home, file, next, old, STATE_LIMIT);
    return;
  }
  const name = journalName(file);
  const volumes = !hierarchyWrites && writes.map(item => item.file).filter(name => isLedgerVolume(policy.ledgerDocument, frame.agent.id, name));
  const operation = hierarchyWrites ? { spec: MODULE_JOURNAL_SPEC, module: hierarchyWrites.module }
    : volumes.length ? { spec: VOLUME_JOURNAL_SPEC, ledger: policy.ledgerDocument, owner: frame.agent.id, volumes }
    : { spec: JOURNAL_SPEC, ledger: policy.ledgerDocument };
  const raw = Buffer.from(JSON.stringify({ ...operation, policy: policy.hash,
    before: stateDigest(old), after: digest(next), backupBefore: recordBytes(backupBefore),
    writes: writes.map(item => ({ file: item.file, before: recordBytes(item.before), after: digest(item.after) })) }));
  policyCurrent(root, policy.hash);
  replaceBytes(home, name, raw, null, JOURNAL_LIMIT);
  try {
    for (const item of writes) {
      policyCurrent(root, policy.hash);
      replaceBytes(root, item.file, item.after, item.before);
    }
    if (old) replaceBytes(home, backup, old, backupBefore, STATE_LIMIT);
    policyCurrent(root, policy.hash);
    if (hierarchyWrites || volumes.length) {
      // The workspace lock serializes host tools. Verify published targets again
      // because another editor can still change them before the state commit.
      const expected = [...(hierarchyWrites ? [{ file: policy.hierarchy.overview.path, sha256: hierarchyWrites.overviewSha256 }] : []),
        ...writes.map(item => ({ file: item.file, sha256: digest(item.after) }))];
      for (const item of expected) {
        if (stateDigest(readBytes(root, item.file, FILE_LIMIT)) !== item.sha256) {
          throw new Error("新增模块期间文件发生外部修改，请核对后重试 " + item.file);
        }
      }
    }
    replaceBytes(home, file, next, old, STATE_LIMIT);
  } catch (error) {
    try { recoverLedgerJournal(home, file, root, policy, frame.managed); }
    catch (failure) { throw new AggregateError([error, failure], "宿主提交失败，未完成账本事务仍待核对", { cause: error }); }
    throw error;
  }
  try { replaceBytes(home, name, null, raw, JOURNAL_LIMIT); }
  // The state rename above already committed this receipt. If unlink fails,
  // leave the journal for normal committed recovery and report cleanup alone.
  catch (error) { warnCleanup?.(error); }
}
