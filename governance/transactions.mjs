import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AUTHORITY, digest, historyPaths, keyOf, readBytes, replaceBytes, text } from "./policy.mjs";

export const STATE_LIMIT = 8 * 1024 * 1024;
const JOURNAL_LIMIT = 2 * STATE_LIMIT;
const FILE_LIMIT = 256 * 1024;
const JOURNAL_SPEC = "building-loop-ledger-transaction/1";
const OWNER = /^owner-([1-9]\d{0,9})-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const WINDOWS_CLAIM_DELAYS = [10, 25, 50, 100];
const CLAIM_WAIT = new Int32Array(new SharedArrayBuffer(4));
const busy = () => new Error("工作台账正在更新，请按当前台账重试");
const unknownLock = () => new Error("工作台账锁来源未知，需维护者确认旧进程已退出后核对宿主状态");
const stateDigest = bytes => bytes === null ? null : digest(bytes);
const journalName = file => file + ".ledger-txn";
const recordBytes = value => value === null ? null : value.toString("base64");

/** Remove the empty directory only. A new owner always publishes it nonempty. */
function removeEmptyLock(lock) {
  try { fs.rmdirSync(lock); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
}

/** Owner names are unique, so concurrent recovery cannot unlink a fresh claim. */
function dropOwner(lock, owner) {
  try { fs.unlinkSync(path.join(lock, owner)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  removeEmptyLock(lock);
}

/** Retire only a verifiably dead PID. Alive, reused, inaccessible and legacy
 * owners stay in place. An interrupted retirement can leave an empty directory.
 */
function retireLock(lock) {
  const entry = fs.lstatSync(lock, { throwIfNoEntry: false });
  if (!entry) return;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw unknownLock();
  let owners;
  try {
    if (keyOf(fs.realpathSync.native(lock)) !== keyOf(lock)) throw unknownLock();
    owners = fs.readdirSync(lock, { withFileTypes: true });
  } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!owners.length) { removeEmptyLock(lock); return; }
  const match = owners.length === 1 && owners[0].isFile() && OWNER.exec(owners[0].name);
  if (!match || Number(match[1]) > 0x7fffffff) throw unknownLock();
  try { process.kill(Number(match[1]), 0); }
  catch (error) {
    if (error.code !== "ESRCH") throw busy();
    dropOwner(lock, owners[0].name);
    return;
  }
  throw busy();
}

/** Claim the lock with a complete same-volume owner directory. This avoids
 * an interruption between claiming an empty file and writing its owner PID.
 */
export function withWorkspaceLock(home, file, operation) {
  const lock = path.join(home, file + ".lock");
  retireLock(lock);
  const staged = fs.mkdtempSync(path.join(home, file + ".claim-"));
  const owner = "owner-" + process.pid + "-" + randomUUID();
  let acquired = false;
  try {
    fs.closeSync(fs.openSync(path.join(staged, owner), "wx", 0o600));
    for (let attempt = 0; ; attempt++) {
      if (fs.lstatSync(lock, { throwIfNoEntry: false })) throw busy();
      try { fs.renameSync(staged, lock); break; }
      catch (error) {
        if (fs.lstatSync(lock, { throwIfNoEntry: false })) throw busy();
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
    if (acquired) dropOwner(lock, owner);
    else { dropOwner(staged, owner); removeEmptyLock(staged); }
  }
}

export function hasLedgerJournal(home, file) {
  return !!fs.lstatSync(path.join(home, journalName(file)), { throwIfNoEntry: false });
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

/** Reconcile a single generated-ledger transaction under its workspace lock.
 * The authoritative state rename is the commit point. Before it, restore only
 * known transaction bytes; after it, require that all published bytes match.
 */
export function recoverLedgerJournal(home, file, root, policy) {
  const name = journalName(file);
  const raw = readBytes(home, name, JOURNAL_LIMIT);
  if (!raw) return;
  let journal;
  try { journal = JSON.parse(text(raw)); }
  catch { throw new Error("未完成账本事务的日志损坏，需维护者核对"); }
  if (!journal || journal.spec !== JOURNAL_SPEC || journal.policy !== policy.hash ||
      typeof policy.ledgerDocument !== "string" || journal.ledger !== policy.ledgerDocument) {
    throw new Error("未完成账本事务的授权清单或日志不匹配，需维护者核对");
  }
  const isDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (!isDigest(journal.after) || journal.before !== null && !isDigest(journal.before) || journal.before === journal.after ||
      !Array.isArray(journal.writes) || journal.writes.length < 2 || journal.writes.length > 4) {
    throw new Error("未完成账本事务的版本记录无效，需维护者核对");
  }
  const managed = historyPaths(journal.ledger);
  const allowed = new Set([journal.ledger, managed.log, managed.backup, managed.logBackup]);
  const state = stateDigest(readBytes(home, file, STATE_LIMIT));
  const committed = state === journal.after;
  if (!committed && state !== journal.before) throw new Error("未完成账本事务的宿主状态已变化，需维护者核对");
  const targets = journal.writes.map(item => {
    if (!item || !allowed.delete(item.file) || !isDigest(item.after)) throw new Error("未完成账本事务的写入范围无效，需维护者核对");
    return { root, file: item.file, before: storedBytes(item.before, FILE_LIMIT), after: item.after, limit: FILE_LIMIT };
  });
  if (allowed.has(journal.ledger) || allowed.has(managed.log)) throw new Error("未完成账本事务的正文或更新日志记录缺失");
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

/** Persist generated ledger files before the authoritative state, with one
 * recoverable journal. Ordinary state-only transactions retain their path.
 */
export function commitWorkspaceState(home, frame, next) {
  if (next.length > STATE_LIMIT) throw new Error("内容超过受控工具的大小上限");
  const { file, root, policy, old, ledgerWrites } = frame;
  // Idempotent retry must not replace the one rolling pre-commit backup.
  if (!ledgerWrites?.length && old?.equals(next)) return;
  const backup = file + ".bak";
  const backupBefore = old ? readBytes(home, backup, STATE_LIMIT) : null;
  if (!ledgerWrites?.length) {
    if (old) replaceBytes(home, backup, old, backupBefore, STATE_LIMIT);
    replaceBytes(home, file, next, old, STATE_LIMIT);
    return;
  }
  const name = journalName(file);
  const raw = Buffer.from(JSON.stringify({ spec: JOURNAL_SPEC, policy: policy.hash, ledger: policy.ledgerDocument,
    before: stateDigest(old), after: digest(next), backupBefore: recordBytes(backupBefore),
    writes: ledgerWrites.map(item => ({ file: item.file, before: recordBytes(item.before), after: digest(item.after) })) }));
  policyCurrent(root, policy.hash);
  replaceBytes(home, name, raw, null, JOURNAL_LIMIT);
  try {
    for (const item of ledgerWrites) {
      policyCurrent(root, policy.hash);
      replaceBytes(root, item.file, item.after, item.before);
    }
    if (old) replaceBytes(home, backup, old, backupBefore, STATE_LIMIT);
    policyCurrent(root, policy.hash);
    replaceBytes(home, file, next, old, STATE_LIMIT);
  } catch (error) {
    try { recoverLedgerJournal(home, file, root, policy); }
    catch (failure) { throw new AggregateError([error, failure], "宿主提交失败，未完成账本事务仍待核对", { cause: error }); }
    throw error;
  }
  replaceBytes(home, name, null, raw, JOURNAL_LIMIT);
}
