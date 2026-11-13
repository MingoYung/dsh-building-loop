import { goalSnapshot } from "./goals.mjs";
import { inspectArchitectureImports } from "./code-review.mjs";
import { digest, includes, keyOf, readBytes, replaceWithHistory } from "./policy.mjs";
import { architectureDocument, architectureImportsSection, architectureProseLines } from "./project-hierarchy.mjs";

const declaration = /^(?:[-+*]\s+|\d+[.)]\s+)?(?:\*\*)?\x60?([^\s`:：()（）]+\.py)\x60?(?:\*\*)?(?:\s*[（(][^）)]{1,80}[）)])?\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?/iu;
const sentence = /[。！？!?；;]|\.(?=\s|$)/u;
const notCurrent = /(?:不|未|无|禁止|避免|只能|否则|如果|若|计划|拟|将|应|需要|建议|可选|可能|目标|改为|待|示例|例如|比如|回退|反例|误写|旧版|原先|历史|通过|经由|间接|委托|(?:\b(?:does not|never|should|may|could|would|will|planned|previously|formerly|indirectly|via|if|example|incorrect)\b))/iu;
const relation = /(?:直接\s*)?(调用|导入|\bcalls?\b|\bimports?\b)\s*/giu;
const name = /^(\x60)?([\p{ID_Start}_][\p{ID_Continue}./-]*)(?:\x60|(?=[\s、，,和及与。！？；;:(（]|$))/u;
const list = /^(?:\s*(?:、|，|,|和|及|与|\band\b)\s*)/iu;

function moduleLookup(files) {
  const aliases = new Map();
  for (const file of files) {
    const module = file.replace(/\.py$/iu, "").replace(/\/__init__$/u, "").replaceAll("/", ".");
    for (const alias of new Set([file, module, module.split(".").at(-1), file.split("/").at(-1)])) {
      if (aliases.has(alias) && aliases.get(alias) !== file) aliases.set(alias, null);
      else aliases.set(alias, file);
    }
  }
  return token => {
    const path = aliases.get(token);
    if (path !== undefined) return path;
    // A module-qualified call identifies its module if the exact prefix is
    // already unique. An ordinary variable name never becomes a module here.
    const split = token.lastIndexOf(".");
    return split > 0 ? aliases.get(token.slice(0, split)) : undefined;
  };
}

function mentionedTargets(tail, locate) {
  const result = [];
  let rest = tail;
  while (rest) {
    const item = name.exec(rest);
    if (!item || !locate(item[2])) break;
    result.push(locate(item[2]));
    const delimiter = list.exec(rest.slice(item[0].length));
    if (!delimiter) break;
    rest = rest.slice(item[0].length + delimiter[0].length);
  }
  return result;
}

/** Validate only explicit current claims attached to a named module. Local
 * module identity, relation and line are data. Interpretations of a sentence,
 * uncertain call binding and future designs stay with independent review. */
export function inspectArchitectureProse(source, graph) {
  const locate = moduleLookup(graph.checkedFiles);
  const conflicting = [];
  for (const [line, row] of architectureProseLines(source)) {
    const label = declaration.exec(row);
    const from = label && locate(label[1]);
    if (!from) continue;
    const body = row.slice(label[0].length);
    for (const claim of body.split(sentence)) {
      if (notCurrent.test(claim)) continue;
      for (const verb of claim.matchAll(relation)) {
        const kind = /导入|import/iu.test(verb[1]) ? "import" : "call";
        const uncertainty = kind === "call" && graph.uncertainCalls.find(row => row.file === from);
        if (uncertainty && !uncertainty.targets) continue;
        const known = kind === "import" ? graph.edges.filter(edge => edge.file === from).flatMap(edge =>
          edge.imports.map(target => ({ target, line: edge.line }))) : graph.calls.filter(call => call.file === from);
        for (const target of mentionedTargets(claim.slice(verb.index + verb[0].length), locate)) {
          if (target === from || uncertainty?.targets?.includes(target) || known.some(edge => edge.target === target) ||
              conflicting.some(item => item.line === line && item.relation === kind && item.to === target)) continue;
          conflicting.push({ line, from, to: target, relation: kind, actual: known.map(({ target, line }) => ({ file: target, line })) });
          if (conflicting.length >= 12) return conflicting;
        }
      }
    }
  }
  return conflicting;
}

/** Signed bytes supersede the planning-time graph. The coordinator receives
 * only registered module names and line positions, never source contents. */
export function inspectEngineeringArchitectureClaims(frame, spec, active, graph) {
  if (!spec.architecture?.importsHeading || !active?.codeIntake?.qualification) return { conflicts: [], calls: [] };
  const current = graph ?? inspectArchitectureImports(frame, spec, active);
  const source = readBytes(frame.root, spec.architecture.file);
  if (!source || digest(source) !== current.sha256) throw new Error("检查架构调用关系时架构稿已变化");
  return { conflicts: inspectArchitectureProse(source.toString("utf8"), current.graph), calls: current.graph.calls };
}

export function architectureClaimIssues(conflicts) {
  return conflicts.map(({ line, from, to, relation, actual }) => {
    const verb = relation === "call" ? "调用" : "导入";
    const targets = [...new Set(actual.map(item => item.file + "（" + from + " 第 " + item.line + " 行）"))];
    return "架构稿第 " + line + " 行称 " + from + " 直接" + verb + " " + to +
      "，当前签名源码" + (targets.length ? "可定位的直接" + verb + "为 " + targets.join("、") : "没有可定位的本地直接" + verb) +
      "。请按实际路径改写，间接关系写清中间模块。";
  });
}

/** A plan is published by the coordinator under the same lock as dispatch. */
export function registerEngineeringArchitecture(frame, unit, spec, tag) {
  const active = frame.state.units[unit];
  if (!spec.architecture || frame.role !== "coordinator" || !includes(frame.writes, spec.architecture.file) ||
    active && active.owner !== frame.agent.id) throw new Error("只有获授权的本单元总控能登记架构稿");
  if (active && !["review-ready", "final-review-ready", "architecture-sync", "architecture-repair", "ledger-review", "blocked"].includes(active.phase)) {
    throw new Error("只在派单前、代码待审或架构退回时登记架构稿；正在工作的子会话须先结束阶段");
  }
  const goal = goalSnapshot(frame);
  const diagnostics = spec.codeTask.diagnostics;
  let plan = architectureDocument(frame, spec.architecture, diagnostics);
  const previous = frame.state.engineeringArchitecture?.[keyOf(plan.file)];
  if (previous?.goalSha256 !== goal.sha256 && previous?.contentsSha256 === plan.contentsSha256) {
    throw new Error("目标已变化，请把受影响的架构、回退与验证计划实际更新到 " + plan.file);
  }
  if (active?.phase === "architecture-repair" && active.engineeringArchitecture?.contentsSha256 === plan.contentsSha256) {
    throw new Error("架构已退回，请实际修改对应内容后再登记");
  }
  const imports = inspectArchitectureImports(frame, spec, active);
  const claims = inspectEngineeringArchitectureClaims(frame, spec, active, imports);
  if (claims.conflicts.length) throw new Error(architectureClaimIssues(claims.conflicts).join("\n"));
  if (imports && !imports.match) {
    replaceWithHistory(frame.root, plan.file, before => {
      if (!before || digest(before) !== imports.sha256) throw new Error("静态导入生成时架构正文已变化，请重新登记");
      return imports.proposed;
    }, "宿主根据当前代码更新实际本地静态导入", tag, frame.state.markers);
    plan = architectureDocument(frame, spec.architecture, diagnostics);
  }
  const snapshot = { ...plan, goalSha256: goal.sha256, unit, owner: frame.agent.id };
  frame.state.engineeringArchitecture = { ...frame.state.engineeringArchitecture, [keyOf(plan.file)]: snapshot };
  if (active) {
    active.engineeringArchitecture = snapshot;
    if (active.phase === "architecture-sync") {
      active.phase = active.architectureSyncResume;
      delete active.architectureSyncResume;
    } else if (active.phase === "architecture-repair") {
      active.phase = active.codeReviewRejection ? "supplement-ready" : "final-review-ready";
    } else if (active.phase === "ledger-review" && previous?.sha256 !== snapshot.sha256) {
      active.phase = "final-review-ready";
    } else if (active.phase === "blocked" && ["first-review", "first-audit", "final-review", "final-audit"].includes(active.resumePhase) &&
      previous?.sha256 !== snapshot.sha256) {
      active.phase = "final-review-ready";
      delete active.pendingReceipt;
      delete active.resumePhase;
    }
  }
  frame.changed = true;
  return { unit, phase: active?.phase ?? "dispatch", architecture: snapshot };
}

export function engineeringArchitectureCurrent(frame, spec, snapshot, active, checkImports = true) {
  if (!spec.architecture) return true;
  const file = spec.architecture.file;
  const bytes = readBytes(frame.root, file);
  if (snapshot?.file !== file || !bytes || snapshot.sha256 !== digest(bytes) ||
    snapshot.goalSha256 !== goalSnapshot(frame).sha256) return false;
  try {
    const plan = architectureDocument(frame, spec.architecture, spec.codeTask.diagnostics);
    // Rebuild the typed data from the exact document before any runner uses the
    // stored examples. The validated data must still be that revision's data.
    if (plan.sha256 !== snapshot.sha256 || JSON.stringify(plan.examples) !== JSON.stringify(snapshot.examples)) return false;
    if (!checkImports || !spec.architecture.importsHeading) return true;
    const imports = inspectArchitectureImports(frame, spec, active);
    return imports.match && !inspectEngineeringArchitectureClaims(frame, spec, active, imports).conflicts.length;
  }
  catch { return false; }
}

export function requireEngineeringArchitecture(frame, unit, spec, active, checkImports = true) {
  if (!spec.architecture) return;
  const snapshot = active?.engineeringArchitecture ?? frame.state.engineeringArchitecture?.[keyOf(spec.architecture.file)];
  if (snapshot?.unit !== unit || snapshot.owner !== (frame.assignment?.[1].owner ?? frame.agent.id) ||
    !engineeringArchitectureCurrent(frame, spec, snapshot, active, checkImports)) {
    throw new Error("请总控维护当前目标的架构稿 " + spec.architecture.file + "，再用 building_loop architecture 登记实际版本");
  }
  return snapshot;
}

/** Include only the exact authorized path and next action in coordinator packets. */
export function engineeringArchitectureStatus(frame, unit) {
  const spec = frame.policy.units[unit];
  if (!spec?.architecture || frame.role !== "coordinator") return;
  const active = frame.state.units[unit];
  const { file, headings, examplesHeading } = spec.architecture;
  const contract = { file, headings, ...(examplesHeading ? { examplesHeading } : {}) };
  if (active?.phase === "architecture-repair") {
    return { ...contract, status: "repair", receipt: active.receipt, next: { action: "architecture", unit } };
  }
  if (active?.phase === "architecture-sync") {
    const sync = { ...contract, status: "sync", next: { action: "architecture", unit } };
    try {
      const { conflicts } = inspectEngineeringArchitectureClaims(frame, spec, active);
      return conflicts.length ? { ...sync, conflicts: architectureClaimIssues(conflicts) } : sync;
    } catch (error) { return { ...sync, reason: error.message }; }
  }
  try {
    const snapshot = requireEngineeringArchitecture(frame, unit, spec, active);
    return { ...contract, status: "registered", sha256: snapshot.sha256 };
  } catch (error) {
    return { ...contract, status: "required", reason: error.message, next: { action: "architecture", unit } };
  }
}

/** Preserve the designated generated body when the coordinator edits prose. */
export function requireHostImportSectionUnchanged(frame, file, proposed) {
  const spec = Object.values(frame.policy.units).find(unit => unit.architecture?.importsHeading && includes([unit.architecture.file], file));
  if (!spec) return;
  const current = architectureImportsSection(frame, spec);
  const next = architectureImportsSection(frame, spec, proposed);
  if (current.source.slice(current.bodyStart, current.bodyEnd).trim() !== next.source.slice(next.bodyStart, next.bodyEnd).trim()) {
    throw new Error("静态导入章节由宿主生成。保留该章节原文，用 building_loop architecture 更新");
  }
}

/** Only the actual coordinator-owned architecture location can route repair
 * to the coordinator. Mixed findings still require the original code repair. */
export function engineeringRepair(proof) {
  const architecture = proof.architecture?.status === "revise";
  const code = proof.files.some(row => (row.comments ?? [row.comment]).some(comment => comment?.status === "missing")) ||
    proof.constraints.some(row => row.status === "revise") || proof.findings.some(row => row.owner !== "coordinator");
  return { architecture, code };
}
