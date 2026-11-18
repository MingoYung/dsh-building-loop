import { AUTHORITY, digest, keyOf, parseAuthority, readBytes } from "./policy.mjs";
import { registeredSourceRows } from "./evidence.mjs";

// Keep the encoding of older shape/pin records so an already blocked workspace
// can prove its previous grant without trusting a newly supplied copy of it.
const fingerprint = value => digest(Buffer.from(JSON.stringify(value, null, 2) + "\n"));
const reject = () => { throw new Error("运行期间授权清单发生变化，需项目维护者核对"); };

function sourceView(policy, excluded) {
  const { hash, sourcePins, ...grants } = policy;
  const routes = Object.create(null);
  const units = Object.create(null);
  for (const [id, unit] of Object.entries(grants.units)) {
    // Only registered review evidence can explain a change in a working
    // role's read scope. Coordinator grants, write paths and all other fields
    // (including review duties, evidence receipts and materials) stay exact.
    const evidence = new Set(["first-review", "final-review"].flatMap(p => unit.phases[p].evidence).map(keyOf));
    const phases = Object.fromEntries(Object.entries(unit.phases).map(([name, grant]) => {
      const masked = { ...grant };
      for (const field of ["read", "evidence"]) if (grant[field]) {
        masked[field] = grant[field].filter(file => {
          const key = keyOf(file);
          if (!excluded.has(key) || !evidence.has(key)) return true;
          (routes[key] ??= []).push([id, name, field]);
          return false;
        });
      }
      return [name, masked];
    }));
    units[id] = { ...unit, phases };
  }
  const identity = Object.fromEntries(Object.entries(sourcePins).filter(([file]) => !excluded.has(file))
    .map(([file, { kind, locator, observation }]) => [file, { kind, locator, ...(observation ? { observation: observation.file } : {}) }]));
  return { shape: fingerprint({ ...grants, units, sourcePins: identity }), routes };
}

export function authorityVersions(policy) {
  const entries = Object.entries(policy.sourcePins);
  const research = sourceView(policy, new Set(entries.map(([file]) => file)));
  return {
    shape: sourceView(policy, new Set()).shape,
    pins: Object.fromEntries(entries.map(([file,pin]) => [file, fingerprint([pin.sha256, pin.observation?.sha256 ?? null])])),
    research: { ...research, identities: Object.fromEntries(entries.map(([file, pin]) =>
      [file, fingerprint([pin.kind, pin.locator, pin.observation?.file ?? null])])) },
  };
}

/** Prove the exact non-source grant and the role routes for every surviving
 * source, then authenticate the changed acquisition records before adoption.
 * Historic grants with just a digest can prove additions by subtracting them
 * from the new policy. Removed historic paths cannot be guessed. */
export function sourceAuthorityChanges(root, policy, previous, current, previousHash) {
  if (!previous?.pins || !previous.shape) reject();
  const added = Object.keys(current.pins).filter(file => !Object.hasOwn(previous.pins,file));
  const removed = Object.keys(previous.pins).filter(file => !Object.hasOwn(current.pins,file));
  const retained = Object.keys(current.pins).filter(file => Object.hasOwn(previous.pins,file));
  const old = previous.research, next = current.research;
  if (old) {
    if (old.shape !== next.shape || retained.some(file =>
      JSON.stringify(old.routes[file]) !== JSON.stringify(next.routes[file]))) reject();
  } else if (removed.length || sourceView(policy, new Set(added)).shape !== previous.shape) {
    // A rolling pre-edit grant can recover a legacy deletion. Verify its bytes
    // against the durable state before consulting any old identity or route.
    const backup = readBytes(root, AUTHORITY + ".bak", 64 * 1024);
    if (!backup || digest(backup) !== previousHash) reject();
    const restored = authorityVersions(parseAuthority(backup));
    if (restored.shape !== previous.shape) reject();
    return sourceAuthorityChanges(root, policy, restored, current, previousHash);
  }
  const refreshed = retained.filter(file => previous.pins[file] !== current.pins[file] ||
    old && old.identities[file] !== next.identities[file]);
  if (!added.length && !removed.length && !refreshed.length) reject();

  const byUnit = new Map();
  for (const [kind, files] of Object.entries({ added, removed, refreshed })) for (const file of files) {
    const routes = kind === "removed" ? old.routes[file] : next.routes[file];
    if (!routes?.length) reject();
    if (kind !== "removed") {
      const pin = policy.sourcePins[file];
      if (!pin.observation) reject();
      registeredSourceRows(root, file, readBytes(root, file), pin);
    }
    for (const id of new Set(routes.map(([id]) => id))) {
      const row = byUnit.get(id) ?? { added: [], removed: [], refreshed: [] };
      row[kind].push(file);
      byUnit.set(id, row);
    }
  }
  return byUnit;
}

/** Never transplant a read stamp, verdict or pending activation to a different
 * authority. Persist the old and new policy digests, retain native identities,
 * and keep the old on-disk receipt as history until the two new reviews finish. */
export function restartSourceReview(unit, from, to, changes, goal) {
  const previous = unit.authorityUpdate;
  if (previous) {
    // Coalesce revisions that arrived before the executor resubmitted.
    const pending = new Map();
    for (const kind of ["added","removed","refreshed"]) for (const file of previous[kind]) pending.set(file,kind);
    for (const [kind, files] of Object.entries(changes)) for (const file of files) {
      const prior = pending.get(file);
      if (prior === "added" && kind === "removed") pending.delete(file);
      else pending.set(file, prior === "removed" && kind === "added" ? "refreshed" : prior === "added" ? "added" : kind);
    }
    changes = Object.fromEntries(["added","removed","refreshed"].map(kind => [kind, [...pending.keys()].filter(file => pending.get(file) === kind)]));
    from = previous.from;
  }
  const record = { owner: unit.owner, executor: unit.executor, serial: unit.serial, phase: "supplement-ready", goal,
    authorityUpdate: { from, to, ...changes } };
  for (const key of ["reviewer", "auditor", "executorUsage", "rotations", "outcomeClarification", "metricClarification"]) {
    if (unit[key] !== undefined) record[key] = unit[key];
  }
  return record;
}
