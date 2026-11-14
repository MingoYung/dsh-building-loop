import { digest, readBytes } from "./policy.mjs";
import { lineList } from "./preflight.mjs";
import { markdownStructure } from "./markdown-structure.mjs";

const idPattern = "[A-Za-z0-9][A-Za-z0-9_-]{0,31}";
const ids = new RegExp(`^${idPattern}(?:\\s*[,，、]\\s*${idPattern})*$`, "u");
const declarations = [
  new RegExp(`(?:^|[。！？.!?；;]\\s*)为\\s+(${idPattern}(?:\\s*[,，、]\\s*${idPattern})+)\\s*分别(?:写清|给出|说明|列出)(?:各自(?:的)?)?(?:处置(?:结果)?|结果|结论|决定)(?=[。！？.!?；;，,、]|和|及|与|$)`, "gu"),
  /^(?:[-*]\s+)?(?:逐项结果|结果项)\s*[:：]\s*(.+?)\s*$/gmu,
];

/** The inventory comes from visible, explicit owner requirements. Existing
 * free prose and ordinary factual C labels do not imply a result contract. */
export function declaredDeliveryOutcomes(text) {
  if (typeof text !== "string") return [];
  const original = lineList(Buffer.from(text));
  const { visible } = markdownStructure(original);
  return visible.flatMap((row, i) => {
    return declarations.flatMap(pattern => [...row.matchAll(pattern)]).flatMap(match => {
      if (!ids.test(match[1].trim())) return [];
      return match[1].split(/[,，、]/u).map(id => ({ id: id.trim(), line: i + 1 }));
    });
  });
}

export function deliveryOutcomeContract(frame, spec, goal) {
  const items = new Map();
  for (const { file, sha256 } of goal.files) {
    const bytes = readBytes(frame.root, file);
    if (!bytes || digest(bytes) !== sha256) throw new Error("逐项交付核对期间总纲发生变化");
    for (const item of declaredDeliveryOutcomes(bytes.toString("utf8"))) {
      items.set(item.id, { ...item, file });
    }
  }
  // A private project's generated prose can be amended by its coordinator.
  // Preserve direct outcome IDs from the owner's accepted opening too.
  const opening = frame.managed ? frame.started?.proposal?.instruction : undefined;
  for (const item of declaredDeliveryOutcomes(opening)) {
    if (!items.has(item.id)) items.set(item.id, { ...item, ownerEvent: frame.started.proposal.userSeq });
  }
  if (!items.size) return null;
  if (items.size > 32) throw new Error("逐项交付验收上限为 32 项，请拆分当前授权单元");
  const contract = { items: [...items.values()], summary: spec.plainLast !== false, goalSha256: goal.sha256 };
  return { ...contract, sha256: digest(JSON.stringify(contract)) };
}

export function deliveryOutcomeInstructions(contract) {
  if (!contract) return null;
  return {
    ...contract,
    bodyFormat: "正文每项先写 `事项编号：短结果`，同一行再写原始记录和规则。正文同一编号只能有一个结果字段。",
    ...(contract.summary ? { summaryFormat: "大白话先逐项写 `事项编号：短结果`，使用正文相同结果，各项用句号或分号隔开。" } : {}),
    reviewFormat: "先逐项核原始记录 original-fact、正文与大白话 project-application。用 review 或 audit 提交本角色 outcomes。decided 包含 id、status、decision、basis、body、需要时的 summary；body 和 summary 各只放 {line,quote}。",
  };
}

// IDs contain only letters, digits, underscores and hyphens. Interpolate
// them outside character classes, where a bare hyphen is already literal.
const scalar = /^[\p{L}\p{N}][\p{L}\p{N}_ -]{0,31}$/u;
const statusTypes = ["decided", "missing", "inconsistent", "clarify"];
const brief = (value, limit) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= limit && !/[\r\n]/u.test(value);
const summaryLabel = /^(?:#{1,6}\s*)?(?:大白话|直白说明)\s*(?:[:：]|$)/u;
// These tokens mark unresolved speech acts even when placed in a result
// field. A workflow disposition such as "待补" is itself actionable.
const unresolved = /(?:^|\s)(?:是否|若|如果|除非|可能|或许|未定|未确定|不确定|待定|待确认|待澄清|有待|需确认|需澄清|暂无法|无法确定|maybe\b|if\b|whether\b|unknown\b|undecided\b|unresolved\b|to be determined\b)|(?:是否|除非|若是|待确认|待澄清)/iu;

/** A complete question may be followed by an operational note. Persist only
 * the single question and never infer an answer or choose among questions. */
function clarificationQuestion(value) {
  if (!brief(value, 360)) return null;
  const marks = [...value.matchAll(/[？?]/gu)];
  if (marks.length !== 1 || marks[0].index === 0) return null;
  const question = value.slice(0, marks[0].index + 1);
  return /[\p{L}\p{N}]/u.test(question) ? question : null;
}

/** Match the outcome field, not an occurrence of a result word in prose.
 * The chosen witness is always literal and bounded inside the actual line. */
function declarationsAt(raw, id, summary) {
  const subject = id;
  const delimiter = summary ? "(?:[ \\t]*[：:][ \\t]*|[ \\t]+)" : "[ \\t]*[：:][ \\t]*";
  const result = "([\\p{L}\\p{N}][\\p{L}\\p{N}_ -]{0,31})";
  const pattern = new RegExp(`(?:^|[\\s：:、，,；;。.!！])(${subject}${delimiter}${result})(?=[\\t ]*(?:$|[。.!！；;，,、（(]))|(\\|[ \\t]*${subject}[ \\t]*\\|[ \\t]*${result}[ \\t]*\\|)`, "gu");
  return [...raw.matchAll(pattern)].filter(match => {
    const prefix = raw.slice(0, match.index + match[0].indexOf(match[1] ?? match[3]));
    if (summary) {
      // A summary field begins a sentence or a semicolon-delimited item.
      // Mentions such as "假设 E3：..." cannot supply an operative result.
      const content = prefix.trim().replace(summaryLabel, "").trim();
      return content === "" || /[；;。.!！]$/u.test(content);
    }
    return /^\s*(?:(?:[-*+]\s+|\d+[.)]\s+))?(?:(?:\*\*)?C\d+(?:\*\*)?\s*[:：]\s*)?$/u.test(prefix);
  }).map(match => {
    const quote = (match[1] ?? match[3]).trimEnd();
    const decision = (match[2] ?? match[4]).trim();
    return { quote, decision };
  });
}

function candidateView(bytes) {
  const lines = lineList(bytes);
  const syntax = markdownStructure(lines, { collectOutcomeRows: true });
  let summaryStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const row = syntax.visible[i].replace(/[*_~]/gu, "").trim();
    if (syntax.closingRows[i] && summaryLabel.test(row)) summaryStart = i;
  }
  return { lines, syntax, summaryStart };
}

function outcomeLocation(view, input, summary) {
  if (!Number.isSafeInteger(input?.line) || !brief(input.quote, 240)) return null;
  const i = input.line - 1;
  const raw = view.lines[i];
  const visible = view.syntax.visible[i];
  const at = visible?.indexOf(input.quote) ?? -1;
  if (at < 0 || visible.indexOf(input.quote, at + 1) >= 0 || summary&&!view.syntax.closingRows[i] ||
      raw.slice(at, at + input.quote.length) !== input.quote || summary !== (i >= view.summaryStart)) {
    return null;
  }
  return { line: input.line, quote: input.quote, start: at, end: at + input.quote.length };
}

function locate(view, input, summary) {
  const location = outcomeLocation(view, input, summary);
  if (!location) throw new Error("逐项结论引句须唯一定位在相应的当前正文或大白话，不能引用隐藏示例或另一位置");
  return location;
}

function fieldsFor(view, id, inSummary) {
  return view.syntax.visible.flatMap((raw, i) => {
    if ((i >= view.summaryStart) !== inSummary) return [];
    if (inSummary ? !view.syntax.closingRows[i] : !view.syntax.outcomeRows[i]) return [];
    return declarationsAt(raw, id, inSummary).map(field => ({ ...field, line: i + 1 }));
  });
}

/** Report the structural requirement to the author before reviewers spend
 * effort on the full draft. Genuine questions stay eligible for escalation. */
export function deliveryOutcomeLayoutIssues(contract, bytes) {
  if (!contract) return [];
  const view = candidateView(bytes);
  return contract.items.flatMap(({ id }) => {
    const body = fieldsFor(view, id, false);
    const summary = contract.summary ? fieldsFor(view, id, true) : [];
    if (body.length === 1 && unresolved.test(body[0].decision)) return [];
    if (body.length !== 1) return [id + " 的正文须有一个唯一可定位的「事项编号：明确结果」字段，将解释和出处写在字段后"];
    if (contract.summary && (summary.length !== 1 || summary[0].decision !== body[0].decision)) {
      return [id + " 的大白话缺与正文同值的可定位处置字段，按同一事项编号和结果复述"];
    }
    return [];
  });
}

/** Inventory includes current host-located fields so reviewers can copy a
 * short exact witness instead of extracting a unique quote by guessing. */
export function deliveryOutcomeFields(contract, bytes) {
  if (!contract) return null;
  const view = candidateView(bytes);
  return contract.items.map(({ id }) => ({
    id,
    body: fieldsFor(view, id, false),
    ...(contract.summary ? { summary:fieldsFor(view,id,true) } : {}),
  }));
}

function provesSubject(ref, id) {
  return typeof ref.quote === "string" && new RegExp(`(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_-])`, "u").test(ref.quote);
}

function partsOn(coverage, view, location) {
  return coverage.records.filter(record => record.line === location.line).flatMap(record => {
    const raw = view.lines[record.line - 1];
    const start = raw.indexOf(record.text);
    if (start < 0 || raw.indexOf(record.text, start + 1) >= 0) return [];
    return record.parts.filter(part => start + part.start <= location.start && start + part.end >= location.end);
  });
}

function application(coverage, view, location, id, goalSha256) {
  return partsOn(coverage, view, location).find(part =>
    part.status === "supported" && part.assertion === "project-application" &&
    part.inference?.rule === "project-policy" && part.inference.policy.some(ref => ref.goalSha256 === goalSha256) &&
    part.inference.premises.some(ref => provesSubject(ref, id)));
}

const proofHash = proof => digest(JSON.stringify(proof));

/** The case's raw record and the recommendation are separate assertions
 * even when they appear in one physical row. */
function originalRecord(coverage, line, id, applied) {
  const facts = coverage.records.filter(record => record.line === line).flatMap(record => record.parts);
  return facts.find(part => part.status === "supported" && part.assertion === "original-fact" &&
    (part.evidence ?? part.inference?.premises ?? []).some(ref => provesSubject(ref, id) &&
      applied.inference.premises.some(premise =>
        ref.file === premise.file && ref.sha256 === premise.sha256 && ref.evidenceSpan === premise.evidenceSpan)));
}

/** Shared by the final proof gate and its preflight. Host positions are
 * directions for the current actor to inspect, never automatic judgments. */
function requiredProofs(view, item, body, summary, coverage, contract) {
  const applied = application(coverage, view, body, item.id, contract.goalSha256);
  return [
    { field: "body", assertion: "project-application", location: body, proof: applied },
    { field: "original", assertion: "original-fact", location: { line: body.line },
      proof: applied && originalRecord(coverage, body.line, item.id, applied) },
    ...(summary ? [{ field: "summary", assertion: "project-application", location: summary,
      proof: application(coverage, view, summary, item.id, contract.goalSha256) }] : []),
  ];
}

function proofGap(id, {field, assertion, location}, blocks) {
  const {line, quote, start, end} = location;
  return {id, field, assertion, line, ...(quote ? {quote} : {}),
    blocks: blocks.filter(block => block.line === line &&
      (start === undefined || block.start <= start && block.end >= end)).map(block => block.id)};
}

/** The caller supplies only this role's current, revalidated records. A
 * genuinely unresolved item is left to the role's clarify/missing judgment. */
export function deliveryOutcomeProofGaps(contract, bytes, coverage, blocks) {
  if (!contract) return [];
  const view = candidateView(bytes);
  return contract.items.flatMap(item => {
    const [body, ...duplicates] = fieldsFor(view, item.id, false);
    if (!body || duplicates.length || unresolved.test(body.decision)) return [];
    const summaries = contract.summary ? fieldsFor(view, item.id, true) : [];
    const bodyLocation = outcomeLocation(view, body, false);
    if (!bodyLocation) return [];
    const summary = summaries.length === 1 && outcomeLocation(view, summaries[0], true);
    return requiredProofs(view, item, bodyLocation, summary, coverage, contract)
      .filter(row => !row.proof).map(row => proofGap(item.id, row, blocks));
  });
}

function decideRow(view, item, row, coverage, contract) {
  const { id } = item;
  if (!statusTypes.includes(row.status) || !brief(row.basis, 500)) throw new Error(id + " 缺逐项结论状态或简短判断依据");
  const body = row.body && locate(view, row.body, false);
  const summary = row.summary && locate(view, row.summary, true);
  const result = { id, status: row.status, basis: row.basis, ...(body ? { body } : {}), ...(summary ? { summary } : {}) };
  if (row.status === "clarify") {
    if (row.decision !== undefined) throw new Error(id + " 的 status=clarify 不能填 decision，等待用户选择");
    if (!body) throw new Error(id + " 的 status=clarify 须给 body:{line,quote} 定位实际规则缺口");
    const question = clarificationQuestion(row.question);
    if (!question) throw new Error(id + " 的 status=clarify 须在 question 字段给一个用户可以直接回答的问题，用问号标明");
    const proof = application(coverage, view, body, id, contract.goalSha256);
    if (!proof) throw new Error(id + " 的澄清位置缺本角色已核的 project-application 证明，须绑定当前条款及所涉实际记录");
    return { ...result, question, bodyProof: proofHash(proof) };
  }
  if (row.status !== "decided") {
    if (row.decision !== undefined || row.question !== undefined || row.status === "inconsistent" && (!body || !summary)) {
      throw new Error(id + " 未达标时不填处置值；正文和总结不一致须分别定位");
    }
    return result;
  }
  if (typeof row.decision === "string" && unresolved.test(row.decision)) {
    throw new Error(id + " 的 decision 仍未给明确处置。如果当前条款和实际记录确实无法确定处置，请用 status=clarify、body:{line,quote}、question、basis，省略 decision；材料已足够作答而稿件漏写才用 status=missing");
  }
  if (!brief(row.decision, 32) || !scalar.test(row.decision) || row.question !== undefined) {
    throw new Error(id + " 的 status=decided 须给明确处置的 decision 字段，不填 question");
  }
  if (!body || contract.summary && !summary) throw new Error(id + " 须分别定位正文和已要求的大白话");
  const check = (loc, inSummary) => {
    const found = fieldsFor(view, id, inSummary);
    if (found.length !== 1 || found[0].line !== loc.line || found[0].quote !== loc.quote || found[0].decision !== row.decision) {
      throw new Error(id + " 须逐字指向唯一的「事项编号：结果」字段；条件、提及和其他事项不是本项明确处置");
    }
  };
  check(body, false);
  if (summary) check(summary, true);
  return {result: { ...result, decision: row.decision }, proofs: requiredProofs(view, item, body, summary, coverage, contract)};
}

/** A report belongs to this role and this candidate. Ledger validation calls
 * the same normalizer over persisted inputs and independent source proofs. */
export function reviewDeliveryOutcomes(contract, bytes, coverage, actor, input, blocks = []) {
  if (!contract) return null;
  if (!Array.isArray(input) || input.length !== contract.items.length) throw new Error("请按 prepare.outcomeContract 提交所有逐项交付判断 outcomes");
  const byId = new Map(input.map(row => [row?.id, row]));
  if (byId.size !== input.length || contract.items.some(item => !byId.has(item.id))) throw new Error("逐项交付编号必须逐个对应当前目标，不能漏交、重复或借用编号");
  const view = candidateView(bytes);
  const gaps = [];
  const items = contract.items.map(item => {
    const decision = decideRow(view, item, byId.get(item.id), coverage, contract);
    if (!decision.proofs) return decision;
    for (const row of decision.proofs) {
      if (row.proof) decision.result[row.field + "Proof"] = proofHash(row.proof);
      else gaps.push(proofGap(item.id, row, blocks));
    }
    return decision.result;
  });
  if (gaps.length) throw new Error("逐项处置缺本角色的证据证明。先用 coverage inventory 读对应块并 record，已提交且正确的 outcomes 可以原样提交。outcomeProofGaps=" + JSON.stringify(gaps));
  return { actor, candidateSha256: digest(bytes), contractSha256: contract.sha256, items };
}

export function deliveryOutcomeDisagreements(first, second) {
  if(!first || !second || first.actor === second.actor || first.items.length !== second.items.length) {
    throw new Error("两道审核须分别提交当前逐项处置回执");
  }
  return first.items.filter((row, i) => {
    const other = second.items[i];
    return row.id !== other.id || row.status !== "decided" || other.status !== "decided" ||
      row.decision !== other.decision || row.body.line !== other.body.line || row.body.quote !== other.body.quote ||
      row.summary?.line !== other.summary?.line || row.summary?.quote !== other.summary?.quote;
  }).map(row => row.id);
}

export function requireAcceptedDeliveryOutcomes(contract, bytes, receipt, proof) {
  if (!contract) return;
  const first = receipt.deliveryOutcomes;
  const second = receipt.independentAudit?.deliveryOutcomes;
  if (first?.actor !== receipt.reviewer || second?.actor !== receipt.independentAudit?.auditor || first?.actor === second?.actor ||
      proof?.reviewer !== first?.actor || proof?.auditor !== second?.actor) throw new Error("账本关单缺少两位审核者独立的逐项处置回执");
  const inputs = result => result.items.map(({bodyProof, summaryProof, originalProof, ...row}) => row);
  const currentFirst = reviewDeliveryOutcomes(contract, bytes, proof.reviewerCoverage, first.actor, inputs(first));
  const currentSecond = reviewDeliveryOutcomes(contract, bytes, proof.auditorCoverage, second.actor, inputs(second));
  if (JSON.stringify(first) !== JSON.stringify(currentFirst) || JSON.stringify(second) !== JSON.stringify(currentSecond) ||
      deliveryOutcomeDisagreements(currentFirst, currentSecond).length) throw new Error("逐项处置或其两道证明已变化，停止关单");
}

export const deliveryOutcomeSchema = {
  type: "array", maxItems: 32,
  description: "仅 prepare 有 outcomeContract 时，两道审核各自提交。证据、正文明确处置、与大白话一致分别判断。",
  items: {
    type: "object", additionalProperties: false,
    properties: {
      id: { type: "string" },
      status: { enum: statusTypes },
      decision: { type: "string", maxLength: 32 },
      basis: { type: "string", maxLength: 500 },
      question: { type: "string", maxLength: 360 },
      ...Object.fromEntries(["body", "summary"].map(key => [key, {
        type: "object", additionalProperties: false, required: ["line", "quote"],
        properties: { line: { type: "integer", minimum: 1 }, quote: { type: "string", maxLength: 240 } },
      }])),
    }, required: ["id", "status", "basis"],
  },
};
