import { inspectArchitectureClaimWitness } from "./architecture-claim-witness.mjs";
import { inputContractCases } from "./input-contracts.mjs";
import { markdownStructure } from "./markdown-structure.mjs";
import { digest, readBytes, text } from "./policy.mjs";
import { pythonImportEvidence } from "./python-dependencies.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;
const SYMBOL = /^[A-Za-z_][A-Za-z0-9_]{0,119}$/u;
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
const own = (value, key) => value !== null && typeof value === "object" && Object.hasOwn(value, key);
const hasOnly = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));
const plainField = value => typeof value === "string" && value.length > 0 && value.length <= 120 &&
  value.isWellFormed() && !/[\x00-\x1f\x7f]/u.test(value);
const typeOfInput = (value, type) => {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && !Number.isInteger(value);
  return typeof value === type;
};

/** Owner-only configuration connects a narrowly typed predicate to one fixed,
 * separately registered public response. Models cannot supply either at review. */
export function parseArchitectureResponsibilities(rows, sources, diagnostics) {
  const invalid = () => new Error("关键职责须登记唯一编号、已授权源码、支持的触发条件和绑定当前条款的完整公开示例");
  if (!Array.isArray(rows) || !rows.length || rows.length > 8 || diagnostics?.protocol !== 2) throw invalid();
  const examples = new Map(inputContractCases(diagnostics.inputContracts).filter(row => row.publicExample).map(row => [row.id, row]));
  const ids = new Set(), linked = new Set();
  return rows.map(row => {
    if (!hasOnly(row, ["id", "mode", "trigger", "owner", "exampleId"]) || typeof row.id !== "string" ||
      !ID.test(row.id) || ids.has(row.id) || !hasOnly(row.owner, ["file", "symbol"]) || !sources.includes(row.owner.file) ||
      row.owner.symbol !== undefined && (typeof row.owner.symbol !== "string" || !SYMBOL.test(row.owner.symbol))) throw invalid();
    const example = examples.get(row.exampleId);
    if (!example?.requirement || linked.has(row.exampleId)) throw invalid();
    const { trigger, mode } = row;
    const input = example.raw ? undefined : JSON.parse(example.input.stdin);
    const code = example.expected.json?.error;
    if (mode === "business") {
      const inputType = hasOnly(trigger, ["kind", "argument", "type", "test"]) && trigger.kind === "input-type" &&
        trigger.argument === 0 && TYPES.has(trigger.type) && ["is", "not"].includes(trigger.test) &&
        typeOfInput(input, trigger.type) === (trigger.test === "is");
      const field = hasOnly(trigger, ["kind", "argument", "field", "test"]) && trigger.kind === "field-presence" &&
        trigger.argument === 0 && plainField(trigger.field) && ["missing", "present"].includes(trigger.test) &&
        typeOfInput(input, "object") && own(input, trigger.field) === (trigger.test === "present");
      if (example.raw || !inputType && !field) throw invalid();
    } else if (mode === "fallback") {
      if (!hasOnly(trigger, ["kind", "name"]) || trigger.kind !== "exception" || typeof trigger.name !== "string" ||
        !SYMBOL.test(trigger.name)) throw invalid();
    } else if (mode === "forwarding") {
      if (example.raw || !hasOnly(trigger, ["kind", "file", "symbol"]) || trigger.kind !== "delegate" || trigger.file === row.owner.file ||
        !sources.includes(trigger.file) || trigger.symbol !== undefined &&
        (typeof trigger.symbol !== "string" || !SYMBOL.test(trigger.symbol))) throw invalid();
    } else throw invalid();
    if (mode !== "forwarding" && (typeof code !== "string" || !plainField(code))) throw invalid();
    ids.add(row.id);
    linked.add(row.exampleId);
    return { id: row.id, mode, trigger, owner: row.owner, exampleId: row.exampleId, requirement: example.requirement,
      ...(mode !== "forwarding" ? { response: { code } } : {}) };
  });
}

/** The owner must pin a visible clause. Markdown examples, quotes, HTML and a
 * clipped condition cannot serve as the authority for a responsibility. */
export function responsibilityClause(frame, row) {
  const { file, start, end, quote } = row.requirement;
  const bytes = readBytes(frame.root, file);
  if (!bytes) return;
  const lines = bytes.toString("utf8").split(/\r\n|\n|\r/u);
  const excerpt = lines.slice(start - 1, end).join("\n");
  const index = excerpt.indexOf(quote);
  if (end > lines.length || index < 0 || excerpt.indexOf(quote, index + quote.length) !== -1) return;
  const offset = lines.slice(0, start - 1).reduce((sum, line) => sum + line.length + 1, index);
  const { paragraphs } = markdownStructure(lines, { collectParagraphs: true });
  const span = paragraphs.find(({ start: a, end: b }) => a.offset <= offset && offset + quote.length <= b.offset);
  if (!span) return;
  const source = lines.join("\n");
  const before = source.slice(span.start.offset, offset).trimEnd();
  const after = source.slice(offset + quote.length, span.end.offset);
  const sentenceEnd = value => /[。！？.!?]$/u.test(value.replace(/\x60[^\x60\r\n]+\x60/gu, " ").trimEnd());
  // A later independent sentence can be an owner locator, but never a suffix
  // of the conditional sentence it purports to express.
  if (before.trim() && !sentenceEnd(before) || after.trim() && !sentenceEnd(quote) &&
    !/^(?:[。！？]|[.!?](?:\s|$))/u.test(after)) return;
  return { file, start, end, sha256: digest(bytes), quoteSha256: digest(quote) };
}

/** A line is evidence only for the same input whose authenticated execution
 * matched the full registered response. The same code on an unvisited guard,
 * or in a different kind of branch, cannot establish this responsibility. */
export function selectArchitectureResponsibility(claim, actual, executed) {
  if (!Array.isArray(executed) || !executed.length) return { status: "unavailable", reason: "execution-trace-unavailable" };
  const lines = new Set(executed.map(({ path, line }) => path + ":" + line));
  const visited = actual.filter(witness => lines.has(witness.file + ":" + witness.line) &&
    [witness.callLine, witness.outputLine].every(line => line === undefined || lines.has(witness.file + ":" + line)) &&
    // CPython need not emit a line event on an except header. The separate
    // handler emission and output location are stronger evidence in this case.
    (witness.mode === "fallback" || witness.conditionLine === undefined || lines.has(witness.file + ":" + witness.conditionLine)));
  if (visited.length !== 1) return { status: "unresolved", reason: visited.length ? "multiple-executed-decisions" : "no-executed-typed-decision",
    ...(visited.length ? { actual: visited } : {}) };
  const [observed] = visited;
  if (observed.file !== claim.owner.file || claim.owner.symbol !== undefined && observed.symbol !== claim.owner.symbol ||
    claim.response !== undefined && observed.code !== claim.response.code) {
    return { status: "mismatch", reason: "decision-position-or-result", actual: observed };
  }
  return { status: "passed", actual: observed };
}

export function architectureResponsibilityResult(frame, spec, qualification, rows) {
  const claims = spec.architecture?.responsibilities;
  if (!claims) return;
  const artifacts = qualification.artifacts.filter(({ path }) => spec.codeTask.sources.includes(path));
  const sourceFrame = { root: frame.root, reads: spec.codeTask.sources };
  return claims.map(claim => {
    const { id, exampleId } = claim;
    const result = rows?.find(row => row.id === exampleId);
    const clause = responsibilityClause(frame, claim);
    if (!clause) return { id, status: "unavailable", reason: "responsibility-clause-stale-or-incomplete" };
    if (!result) return { id, status: "unavailable", reason: "execution-trace-unavailable" };
    const inventory = inspectArchitectureClaimWitness(sourceFrame, artifacts, claim);
    const selection = selectArchitectureResponsibility(claim, inventory.actual ?? [], result.executed);
    const { executed, ...response } = result;
    return { id, exampleId, mode: claim.mode, trigger: claim.trigger, clause, ...selection, response,
      ...(selection.status === "passed" ? { traceSha256: digest(JSON.stringify(executed)) } : {}) };
  });
}

export function architectureResponsibilitiesCurrent(frame, spec, qualification, artifactsSha256) {
  const claims = spec.architecture?.responsibilities;
  if (!claims) return true;
  const proof = qualification?.architectureResponsibilities;
  return proof?.version === 1 && proof.policySha256 === frame.policy.hash && proof.artifactsSha256 === artifactsSha256 &&
    proof.rows?.length === claims.length && claims.every((claim, index) => {
      const row = proof.rows[index];
      const clause = responsibilityClause(frame, claim);
      return clause && row?.id === claim.id && row.status === "passed" && row.exampleId === claim.exampleId &&
        JSON.stringify(row.clause) === JSON.stringify(clause);
    });
}

const outcome = "`([A-Za-z][A-Za-z0-9_-]{0,63})`";
const outcomeList = "(?:`[A-Za-z][A-Za-z0-9_-]{0,63}`(?:\\s*(?:、|,|，|和|及|and|or|或)\\s*`[A-Za-z][A-Za-z0-9_-]{0,63}`)*)";
const ownerName = "(?:`([\\p{L}_][\\p{L}\\p{N}_.\\/-]*)`|([\\p{L}_][\\p{L}\\p{N}_.\\/-]*))";
const ownerReturns = new RegExp("由\\s*" + ownerName + "\\s*(?:直接\\s*)?(?:负责\\s*(?:返回|给出|判定)?|返回|给出|判定)\\s*(" + outcomeList + ")", "gu");
const ownerDecides = new RegExp("(" + outcomeList + ")\\s*(?:两项|均)?\\s*(?:可以|可能|可)?由\\s*" + ownerName + "\\s*(?:直接\\s*)?(?:判定|判断|负责|返回)", "gu");
const englishOwner = new RegExp("^(?:" + ownerName + ")\\s+(?:directly\\s+)?(?:returns?|rejects?\\s+with|emits?|produces?)\\s+(" +
  outcomeList + ")\\s*[.!]?$", "giu");
const uncertainOwnership = /(?:不得|不能|不会|计划|示例|例如|比如|反例|原先|历史|未来|建议|兜底|解码|透传|原样|转发|交由|委托|经由|间接|可(?:以|能)?由|或由|不(?:应|是|由|负责)|\b(?:examples?|e\.g\.|forward\w*|pass[- ]?through|fallback|delegate\w*|plans?|can|may|might|should|shouldn't|never|not|previously)\b)/iu;
const ownerClauses = /`[^`\r\n]+`|[。！？；;]|[.!?](?=\s|$)/gu;

function responsibilitySentences(line) {
  const clauses = [];
  let from = 0;
  for (const match of line.matchAll(ownerClauses)) {
    if (match[0].startsWith("`")) continue;
    clauses.push(line.slice(from, match.index));
    from = match.index + match[0].length;
  }
  return [...clauses, line.slice(from)];
}

function visibleOutcomeAssignments(frame, files, sources) {
  const owners = new Map();
  for (const source of sources) {
    const basename = source.split("/").at(-1);
    for (const name of new Set([source, basename, basename.slice(0, -3)])) {
      owners.set(name, owners.has(name) ? null : source);
    }
  }
  const assignments = new Map();
  for (const { file, sha256 } of files) {
    const bytes = readBytes(frame.root, file);
    if (!bytes || digest(bytes) !== sha256) return;
    const lines = text(bytes).split(/\r\n|\n|\r/u);
    const { paragraphs } = markdownStructure(lines, { collectParagraphs: true });
    for (const { start, end } of paragraphs) {
      // Restrict the gate to one visible line and one explicit clause; headings,
      // quoted examples and fragments split by Markdown remain review material.
      if (start.line !== end.line) continue;
      const line = lines[start.line - 1].slice(start.column - 1, end.column - 1);
      for (const clause of responsibilitySentences(line)) {
        const prose = clause.replace(/`[^`]+`/gu, "");
        const uncertain = uncertainOwnership.test(prose) || /[“”‘’「」『』"]/u.test(prose);
        const hits = [
          ...[...clause.matchAll(ownerReturns)].map(([, quoted, bare, codes]) => ({ owner: quoted ?? bare, codes })),
          ...[...clause.matchAll(ownerDecides)].map(([, codes, quoted, bare]) => ({ owner: quoted ?? bare, codes })),
          ...[...clause.trim().matchAll(englishOwner)].map(([, quoted, bare, codes]) => ({ owner: quoted ?? bare, codes })),
        ];
        for (const { owner, codes } of hits) {
          for (const [, code] of codes.matchAll(new RegExp(outcome, "gu"))) {
            const assigned = uncertain ? null : owners.get(owner);
            if (!assignments.has(code)) assignments.set(code, new Map());
            assignments.get(code).set(assigned ?? null, { file, start: start.line, end: end.line, sha256 });
          }
        }
      }
    }
  }
  return assignments;
}

/** Gate only a signed, unambiguous positive owner clause that is contradicted
 * by concrete decision sites. Formats and indirect calls remain independent review. */
export function signedExplicitResponsibilityIssues(frame, spec, signed, goal) {
  const sources = spec?.codeTask?.sources;
  if (!sources?.length || sources.some(source => !/\.py$/iu.test(source)) || !goal?.files?.length || !signed?.artifacts) return [];
  const artifacts = signed.artifacts.filter(({ path, sha256 }) => sha256 && sources.includes(path));
  if (artifacts.length !== sources.length || new Set(artifacts.map(({ path }) => path)).size !== sources.length) return [];
  const assignments = visibleOutcomeAssignments(frame, goal.files, sources);
  if (!assignments?.size) return [];
  const graph = pythonImportEvidence({ root: frame.root, reads: sources }, artifacts, { responsibilities: true });
  if (graph.truncated || graph.responsibilitiesTruncated || graph.decisionSitesTruncated ||
      graph.unparsedFiles.length || graph.checkedFiles.length !== sources.length) return [];
  return [...assignments].flatMap(([code, owners]) => {
    if (owners.size !== 1) return [];
    const [[expected, requirement]] = owners;
    if (!expected) return [];
    const sites = graph.decisionSites.filter(row => row.code === code);
    const actualOwners = new Set(sites.map(row => row.guardOwner ?? row.file));
    if (actualOwners.size !== 1 || actualOwners.has(expected)) return [];
    const [actualOwner] = actualOwners;
    const unlocatedOwner = graph.sourceIdentifiers.find(row => row.file === expected)?.identifiers.includes(code);
    if (graph.localRejections.some(row => row.file === expected && row.codes.includes(code)) ||
        unlocatedOwner ||
        graph.uncertainCalls.some(row => [expected, actualOwner].includes(row.file))) return [];
    return [{ code, expected: { file: expected, requirement },
      actual: sites.map(({ file, symbol, line, guardOwner }) => ({ file, symbol, line, ...(guardOwner ? { guardOwner } : {}) })),
      reason: "wrong-responsibility" }];
  });
}
