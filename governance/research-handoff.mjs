import { digest, keyOf, readBytes } from "./policy.mjs";
import { lineList } from "./preflight.mjs";

export function researchPrerequisites(policy, unit) {
  return (policy.units[unit]?.researchDependencies ?? []).map(([id]) => id);
}

function sourcesAt(coverage, line) {
  const sources = new Map();
  for (const row of coverage?.records ?? []) {
    if (row.line !== line) continue;
    for (const part of row.parts) {
      if (part.status !== "supported") continue;
      for (const ref of [...(part.evidence ?? []), ...(part.inference?.premises ?? []), ...(part.inference?.warrant ?? []),
        ...(part.inference?.assumptions ?? []).map(item => item.evidence), ...(part.objectCheck?.sources ?? [])]) {
        if (!ref.origin || ref.origin.kind === "synthetic") continue;
        const { file, start, end, sha256, origin } = ref;
        const value = { file, start, end, sha256, locator: origin.locator,
          ...(origin.observation ? { observation: origin.observation.sha256 } : {}) };
        sources.set(JSON.stringify(value), value);
      }
    }
  }
  return [...sources.values()];
}

/** Only the selected numbered statements cross the research/engineering boundary.
 * Acceptance and source freshness come from the same host gate used at closure.
 */
export function researchInputs(frame, unit, acceptedVersion) {
  const ready = [], blocked = [];
  for (const [id, claims] of frame.policy.units[unit]?.researchDependencies ?? []) {
    const spec = frame.policy.units[id], active = frame.state.units[id];
    if (active?.phase !== "closed") {
      blocked.push({ unit: id, status: "pending", phase: active?.phase ?? "dispatch", claims });
      continue;
    }
    let receipt;
    try { receipt = acceptedVersion(frame, id, active); }
    catch {
      blocked.push({ unit: id, status: "stale", phase: active.phase, claims });
      continue;
    }
    const bytes = readBytes(frame.root, spec.candidate);
    const lines = bytes && lineList(bytes);
    if (!lines || digest(bytes) !== receipt.candidateSha256) {
      blocked.push({ unit: id, status: "stale", phase: active.phase, claims });
      continue;
    }
    const missing = [];
    for (const claim of claims) {
      const check = receipt.checks?.find(row => row.id === claim && row.status === "supported");
      const line = check?.line;
      const statement = lines[line - 1];
      // The review checks also carry a line number. Verify it still selects
      // this exact explicit statement before allowing it to guide code.
      const label = /^\s*(?:[-*]\s+|\d+[.)]\s+)?(?:\*\*)?(C\d+)(?:\*\*)?\s*[:：]/u.exec(statement ?? "")?.[1];
      const reviewer = sourcesAt(active.proof?.reviewerCoverage, line);
      const auditor = sourcesAt(active.proof?.auditorCoverage, line);
      if (label !== claim || !reviewer.length || !auditor.length) {
        missing.push(claim);
        continue;
      }
      const seen = new Set();
      const evidence = [...reviewer, ...auditor].filter(ref => {
        const key = [keyOf(ref.file), ref.start, ref.end, ref.sha256].join(":");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((left, right) => left.file.localeCompare(right.file) || left.start - right.start || left.end - right.end);
      const version = digest(JSON.stringify([id, claim, statement, evidence]));
      ready.push({ unit: id, claim, statement, source: { file: spec.candidate, line, sha256: receipt.candidateSha256 },
        evidence, version });
    }
    if (missing.length) blocked.push({ unit: id, status: "unproven", phase: active.phase, claims: missing });
  }
  return { ready, blocked, versions: ready.map(({ unit, claim, version }) => ({ unit, claim, version })) };
}

export function requireResearchInputs(frame, unit, acceptedVersion, previous) {
  const result = researchInputs(frame, unit, acceptedVersion);
  if (result.blocked.length) {
    const items = result.blocked.map(entry => entry.unit + " " + entry.claims.join("、") + " " + entry.status);
    throw new Error("工程依赖的资料尚未独立核验或已失效：" + items.join("；"));
  }
  if (previous && JSON.stringify(previous) !== JSON.stringify(result.versions)) {
    throw new Error("工程正在使用的资料结论已变化，须按当前证据重新派单并验收");
  }
  return result;
}
