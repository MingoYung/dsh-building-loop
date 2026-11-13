import { inputContractCases, parseInputContracts } from "./input-contracts.mjs";
import { responsibilityClause } from "./architecture-responsibilities.mjs";
import { digest, includes, keyOf, readBytes, relativeName, scopedEditContent } from "./policy.mjs";

const MAX_FILES = 8;
const MAX_REPLACEMENTS = 16;
const MAX_PLAN_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/u;
const PROPOSAL_ID = /^rollback-[a-f0-9]{64}$/u;
const dataObject = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));

/** Only owner configuration chooses the exact editable files, optional
 * baseline storage, fixed runner recipes and post-rollback expectations. */
export function parseArchitectureRollback(value, headings, sources, diagnostics, goalContext) {
  if (value === undefined) return;
  const invalid = () => new Error("回退演练须登记当前架构章节、授权源码和完整的回退后公开检查");
  if (!dataObject(value, ["heading", "files", "contracts", "restore"]) ||
    !headings.includes(value.heading) || diagnostics?.protocol !== 2 ||
    !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES ||
    value.files.some(file => !sources.includes(file)) ||
    new Set(value.files.map(keyOf)).size !== value.files.length) throw invalid();

  const restore = value.restore === undefined ? [] : value.restore;
  if (!Array.isArray(restore) || restore.length > MAX_FILES || restore.some(row =>
    !dataObject(row, ["file", "source"]) || !value.files.includes(row.file) || relativeName(row.source) !== row.source ||
    includes(sources, row.source)) || new Set(restore.map(row => keyOf(row.file))).size !== restore.length ||
    new Set(restore.map(row => keyOf(row.source))).size !== restore.length) throw invalid();

  const contracts = parseInputContracts(value.contracts, diagnostics.reviewRecipes, diagnostics.syntaxRecipe);
  if (!contracts || contracts.some(row => !dataObject(row, ["id", "recipe", "examples"]) ||
    row.examples.some(({ requirement, diagnosticCases }) => !requirement || diagnosticCases !== undefined ||
      relativeName(requirement.file) !== requirement.file || !includes(goalContext, requirement.file)))) throw invalid();
  return { heading: value.heading, files: value.files, contracts, ...(restore.length ? { restore } : {}) };
}

/** JSON.parse accepts duplicate keys. A plan displayed with two different
 * values must not silently execute whichever value appears last. */
function uniqueJson(text) {
  const result = JSON.parse(text);
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:]/gu);
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ":") {
      const keys = stack.at(-1);
      const key = JSON.parse(token);
      if (keys.has(key)) throw new Error("duplicate rollback JSON key");
      keys.add(key);
    }
  }
  return result;
}

const editText = (text, empty) => typeof text === "string" && (empty || text.length > 0) &&
  text.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text);

/** The fenced plan and an executor proposal use the same exact-file, literal
 * replacement contract. This shared check admits neither commands nor paths
 * supplied outside the maintainer's declared scope. */
function rollbackOperations(config, { edits = [], restore = [] }, invalid) {
  if (!Array.isArray(edits) || !Array.isArray(restore) || edits.length + restore.length < 1 ||
    edits.length + restore.length > MAX_FILES) throw invalid();
  const seen = new Set();
  const accept = file => {
    if (!config.files.includes(file) || seen.has(keyOf(file))) return false;
    seen.add(keyOf(file));
    return true;
  };
  let count = 0;
  for (const row of edits) {
    if (!dataObject(row, ["file", "replacements"]) || !accept(row.file) || !Array.isArray(row.replacements) ||
      !row.replacements.length || row.replacements.length > MAX_REPLACEMENTS || row.replacements.some(replacement =>
        !dataObject(replacement, ["oldText", "newText"]) || !editText(replacement.oldText, false) ||
        !editText(replacement.newText, true) || replacement.oldText === replacement.newText)) throw invalid();
    count += row.replacements.length;
  }
  if (count > MAX_REPLACEMENTS || restore.some(file => !config.restore?.some(row => row.file === file) || !accept(file)) ||
    Buffer.byteLength(JSON.stringify({ edits, restore })) > MAX_PLAN_BYTES) throw invalid();
  return { edits, restore };
}

/** Read only a top-level Markdown fence with a dedicated marker. Surrounding
 * explanation remains ordinary prose and is still independently reviewed. */
export function parseArchitectureRollbackFence(config, nodes, body, firstLine, htmlHidden) {
  if (!config) return;
  const fences = nodes.filter(node => node.type === "code" && node.meta === "building-loop-rollback");
  if (!fences.length) return;
  const invalid = () => new Error("回退章节须使用一个闭合的 json building-loop-rollback 围栏，仅允许已登记文件的局部替换或签名基线恢复");
  const [fence] = fences;
  if (fences.length !== 1 || fence.lang !== "json" || Buffer.byteLength(fence.value) > MAX_PLAN_BYTES) throw invalid();
  const raw = body.slice(fence.position.start.offset, fence.position.end.offset).split(/\r\n|\n|\r/u);
  const opener = /^[ \t]{0,3}(\x60{3,}|~{3,})[ \t]*json[ \t]+building-loop-rollback[ \t]*$/u.exec(raw[0])?.[1];
  const closer = /^[ \t]{0,3}(\x60{3,}|~{3,})[ \t]*$/u.exec(raw.at(-1))?.[1];
  if (!opener || !closer || opener[0] !== closer[0] || closer.length < opener.length) throw invalid();
  let plan;
  try { plan = uniqueJson(fence.value); }
  catch { throw invalid(); }
  if (!dataObject(plan, ["edits", "restore", "proposal"])) throw invalid();
  const start = firstLine + fence.position.start.line - 1;
  const end = firstLine + fence.position.end.line - 1;
  if (htmlHidden?.slice(start - 1, end).some(Boolean)) throw invalid();
  const location = { heading: config.heading, start, end, sha256: digest(fence.value) };
  if (Object.hasOwn(plan, "proposal")) {
    if (Object.keys(plan).length !== 1 || typeof plan.proposal !== "string" || !PROPOSAL_ID.test(plan.proposal)) throw invalid();
    return { ...location, proposal: plan.proposal };
  }
  return { ...location, ...rollbackOperations(config, plan, invalid) };
}

function requireExactBytes(frame, file, sha256) {
  const bytes = readBytes(frame.root, file, MAX_FILE_BYTES);
  if ((bytes ? digest(bytes) : null) !== sha256) throw new Error("回退演练的已签名文件已变化：" + file);
  return bytes;
}

function afterEdits(bytes, sha256, edits, file) {
  try {
    return Buffer.from(scopedEditContent(bytes, { beforeSha256: sha256, edits }), "utf8");
  } catch (error) {
    throw new Error("回退演练无法应用 " + file + " 的局部替换：" + error.message);
  }
}

function signedBinding(frame, qualification) {
  if (!SHA.test(qualification?.receiptSha256 ?? "") || !SHA.test(qualification.goalSha256 ?? "")) {
    throw new Error("回退演练须绑定当前已签名源码");
  }
  return { policySha256: frame.policy.hash, goalSha256: qualification.goalSha256, receiptSha256: qualification.receiptSha256,
    originalArtifactsSha256: digest(JSON.stringify(qualification.artifacts)) };
}

function rollbackBaselinePins(frame, config, operations, original, baselineArtifacts) {
  const baseline = new Map(baselineArtifacts.map(row => [row.path, row.sha256]));
  return original.filter(row => operations.restore.includes(row.path)).map(({ path: file }) => {
    const { source } = config.restore.find(row => row.file === file);
    const sha256 = baseline.get(file);
    if (original.some(row => keyOf(row.path) === keyOf(source)) || !SHA.test(sha256 ?? "")) {
      throw new Error("没有可用的签名回退基线：" + file);
    }
    return { file, source, sha256, bytes: requireExactBytes(frame, source, sha256) };
  });
}

const pinMetadata = pins => pins.map(({ file, source, sha256 }) => ({ file, source, sha256 }));
const artifactDigest = artifacts => digest(JSON.stringify(artifacts.map(({ path, sha256 }) => ({ path, sha256 }))));

/** Materialize the counterfactual bytes in memory. The original signed
 * inventory remains the qualification and includes unchanged runner inputs. */
function rollbackSnapshot(frame, config, qualification, operations, baselineArtifacts) {
  const candidate = signedBinding(frame, qualification);
  const edits = new Map(operations.edits.map(row => [row.file, row.replacements]));
  const original = qualification.artifacts;
  const pins = rollbackBaselinePins(frame, config, operations, original, baselineArtifacts);
  const restores = new Map(pins.map(({ file, bytes }) => [file, bytes]));
  const changed = [];
  const files = [...edits.keys(), ...operations.restore];
  for (const file of files) {
    if (!original.some(row => row.path === file)) throw new Error("回退演练文件没有当前签名：" + file);
  }
  let totalBytes = 0;
  const artifacts = original.map(({ path, sha256 }) => {
    const before = requireExactBytes(frame, path, sha256);
    let after = before;
    if (edits.has(path)) after = afterEdits(before, sha256, edits.get(path), path);
    else if (restores.has(path)) after = restores.get(path);
    totalBytes += after?.length ?? 0;
    if ((after?.length ?? 0) > MAX_FILE_BYTES || totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("回退演练副本超过受控大小");
    }
    const afterSha256 = after ? digest(after) : null;
    if (afterSha256 !== sha256) changed.push({ file: path, beforeSha256: sha256, afterSha256 });
    return { path, sha256: afterSha256, contentBase64: after?.toString("base64") ?? null };
  });
  if (!changed.length) throw new Error("回退演练步骤未改变任何签名文件");
  const binding = {
    ...candidate,
    rehearsalArtifactsSha256: artifactDigest(artifacts),
    ...(pins.length ? { baselinePins: pinMetadata(pins) } : {}),
  };
  return { binding, artifacts, changed, files };
}

/** A trusted runner may refresh an equivalent signed receipt. Proposals stay
 * attached to those same signed bytes; executed proofs pin the exact receipt. */
function proposalId(binding, operations) {
  const { receiptSha256, ...versions } = binding;
  return "rollback-" + digest(JSON.stringify([versions, operations]));
}

/** A scoped executor may describe the exact changes without disclosing source
 * literals to the coordinator. The host stores this internal record. */
export function prepareRollbackProposal(frame, spec, qualification, edits, restore, baselineArtifacts = []) {
  const config = spec.architecture?.rollback;
  if (!config) throw new Error("本单元未启用签名副本回退演练");
  const operations = rollbackOperations(config, { edits, restore }, () =>
    new Error("回退方案仅允许已登记文件的局部替换或签名基线恢复"));
  const { binding, files } = rollbackSnapshot(frame, config, qualification, operations, baselineArtifacts);
  return { id: proposalId(binding, operations), binding, files, ...operations };
}

function rehearsalPlan(frame, spec, plan, proposal) {
  const config = spec.architecture?.rollback;
  if (!plan?.rollback || plan.rollback.heading !== config.heading) {
    throw new Error("请在架构回退章节登记 json building-loop-rollback 实跑步骤");
  }
  if (plan.file !== spec.architecture.file || digest(readBytes(frame.root, plan.file) ?? "") !== plan.sha256) {
    throw new Error("回退演练须绑定当前架构稿");
  }
  const reference = plan.rollback.proposal;
  if (reference && proposal?.id !== reference) throw new Error("回退步骤未引用当前已登记方案");
  const operations = rollbackOperations(config, reference ? proposal : plan.rollback, () =>
    new Error("回退步骤不在项目授权范围内"));
  return { reference, operations };
}

function rehearsalChecks(frame, config) {
  return inputContractCases(config.contracts).map(check => {
    const clause = responsibilityClause(frame, check);
    if (!clause) throw new Error("回退检查条款已变化或不是完整可见句：" + check.id);
    return { ...check, clause };
  });
}

function rehearsalBinding(snapshotBinding, plan, checks, { reference, operations }) {
  if (reference && proposalId(snapshotBinding, operations) !== reference) throw new Error("回退方案的签名源码已变化，请重新登记");
  return { ...snapshotBinding, architectureSha256: plan.sha256, rollbackSha256: plan.rollback.sha256,
    checksSha256: digest(JSON.stringify(checks)), ...(reference ? { proposalId: reference } : {}) };
}

/** Bind the visible architecture instructions and their owner checks to the
 * exact copy produced from the signed candidate. */
export function prepareRollbackRehearsal(frame, spec, qualification, plan, baselineArtifacts = [], proposal) {
  const config = spec.architecture?.rollback;
  if (!config) return;
  const parsed = rehearsalPlan(frame, spec, plan, proposal);
  const checks = rehearsalChecks(frame, config);
  const snapshot = rollbackSnapshot(frame, config, qualification, parsed.operations, baselineArtifacts);
  const binding = rehearsalBinding(snapshot.binding, plan, checks, parsed);
  return { binding, artifacts: snapshot.artifacts, checks, changed: snapshot.changed };
}

/** RunInputContractBatch has already authenticated each response. Keep a
 * receipt per fixed check so a partial batch cannot count as a rehearsal. */
export function finishRollbackRehearsal(prepared, observed) {
  const checks = prepared.checks.map(({ id }) => id);
  const receipts = Array.isArray(observed?.receipts) ? observed.receipts : [];
  const failures = Array.isArray(observed?.failures) ? observed.failures : [];
  const complete = observed?.status === "passed" && observed.total === checks.length && observed.passed === checks.length &&
    failures.length === 0 && receipts.length === checks.length &&
    checks.every(id => receipts.some(row => row?.id === id && SHA.test(row.snapshotSha256 ?? "")));
  return { version: 1, status: complete ? "passed" : observed?.status === "failed" ? "failed" : "unavailable",
    binding: prepared.binding, changed: prepared.changed, total: checks.length, passed: observed?.passed ?? 0,
    receipts, failures };
}

function storedSnapshotBinding(frame, config, qualification, operations, baselineArtifacts, changed) {
  const candidate = signedBinding(frame, qualification);
  const original = qualification.artifacts;
  const pins = rollbackBaselinePins(frame, config, operations, original, baselineArtifacts);
  const editable = new Set(operations.edits.map(({ file }) => file));
  const restore = new Map(pins.map(({ file, sha256 }) => [file, sha256]));
  const versions = new Map(original.map(({ path, sha256 }) => [path, sha256]));
  const derived = new Map();
  if (!Array.isArray(changed) || !changed.length || changed.length > MAX_FILES) throw new Error("回退演练缺少已验证副本摘要");
  for (const row of changed) {
    if ((!editable.has(row.file) && !restore.has(row.file)) || derived.has(row.file) || !versions.has(row.file) ||
      versions.get(row.file) !== row.beforeSha256 || !SHA.test(row.afterSha256 ?? "") || row.beforeSha256 === row.afterSha256 ||
      restore.has(row.file) && restore.get(row.file) !== row.afterSha256) throw new Error("回退演练副本摘要不匹配");
    derived.set(row.file, row.afterSha256);
  }
  const rehearsalArtifactsSha256 = artifactDigest(original.map(({ path, sha256 }) => ({ path, sha256: derived.get(path) ?? sha256 })));
  return { ...candidate, rehearsalArtifactsSha256, ...(pins.length ? { baselinePins: pinMetadata(pins) } : {}) };
}

/** The asynchronous publisher does one strict rebuild before storing a proof.
 * Later review steps have already verified the signed candidate. Recompute only
 * the binding, check receipt inventory, and reread any private baseline pin. */
export function rollbackRehearsalCurrent(frame, spec, qualification, plan, proof, baselineArtifacts = [], proposal, strict = false) {
  if (!spec.architecture?.rollback) return true;
  if (proof?.version !== 1 || proof.status !== "passed") return false;
  try {
    const config = spec.architecture.rollback;
    const parsed = rehearsalPlan(frame, spec, plan, proposal);
    const checks = rehearsalChecks(frame, config);
    const snapshot = strict ? rollbackSnapshot(frame, config, qualification, parsed.operations, baselineArtifacts) :
      { binding: storedSnapshotBinding(frame, config, qualification, parsed.operations, baselineArtifacts, proof.changed), changed: proof.changed };
    const binding = rehearsalBinding(snapshot.binding, plan, checks, parsed);
    const rechecked = finishRollbackRehearsal({ binding, checks, changed: snapshot.changed }, proof);
    return rechecked.status === "passed" && JSON.stringify(binding) === JSON.stringify(proof.binding) &&
      (!strict || JSON.stringify(snapshot.changed) === JSON.stringify(proof.changed));
  } catch {
    return false;
  }
}
