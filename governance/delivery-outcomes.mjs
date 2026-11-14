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

const escape = text => text.replace(/[|\\{}()[\]^$+*?.-]/gu, "\\$&");
const scalar = /^[\p{L}\p{N}][\p{L}\p{N}_ -]{0,31}$/u;
const statusTypes = ["decided", "missing", "inconsistent", "clarify"];
const brief = (value, limit) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= limit && !/[\r\n]/u.test(value);
// These tokens mark unresolved speech acts even when placed in a result
// field. A workflow disposition such as "待补" is itself actionable.
const unresolved = /(?:^|\s)(?:是否|若|如果|除非|可能|或许|未定|未确定|不确定|待定|待确认|待澄清|有待|需确认|需澄清|暂无法|无法确定|maybe\b|if\b|whether\b|unknown\b|undecided\b|unresolved\b|to be determined\b)|(?:是否|除非|若是|待确认|待澄清)/iu;

/** Match the outcome field, not an occurrence of a result word in prose.
 * The chosen witness is always literal and bounded inside the actual line. */
function declarationsAt(raw, id, summary) {
  const subject = escape(id);
  const delimiter = summary ? "(?:[ \\t]*[：:][ \\t]*|[ \\t]+)" : "[ \\t]*[：:][ \\t]*";
  const result = "([\\p{L}\\p{N}][\\p{L}\\p{N}_ -]{0,31})";
  const pattern = new RegExp(`(?:^|[\\s：:、，,；;。.!！])(${subject}${delimiter}${result})(?=[\\t ]*(?:$|[。.!！；;，,、（(]))|(\\|[ \\t]*${subject}[ \\t]*\\|[ \\t]*${result}[ \\t]*\\|)`, "gu");
  return [...raw.matchAll(pattern)].filter(match => {
    if(summary) return true;
    const prefix=raw.slice(0,match.index + match[0].indexOf(match[1] ?? match[3]));
    return /^\s*(?:(?:[-*+]\s+|\d+[.)]\s+))?(?:(?:\*\*)?C\d+(?:\*\*)?\s*[:：]\s*)?$/u.test(prefix);
  }).map(match => {
    const quote = (match[1] ?? match[3]).trimEnd();
    const decision = (match[2] ?? match[4]).trim();
    return { quote, decision };
  });
}

function candidateView(bytes) {
  const lines = lineList(bytes);
  const syntax = markdownStructure(lines);
  let summaryStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const row = syntax.visible[i].replace(/[*_~]/gu, "").trim();
    if (syntax.closingRows[i] && /^(?:#{1,6}\s*)?(?:大白话|直白说明)\s*(?:[:：]|$)/u.test(row)) summaryStart = i;
  }
  return { lines, syntax, summaryStart };
}

function locate(view, input, summary) {
  if (!Number.isSafeInteger(input?.line) || !brief(input.quote, 240)) throw new Error("逐项结论须绑定当前稿可见行与逐字 quote");
  const i = input.line - 1;
  const raw = view.lines[i];
  const visible = view.syntax.visible[i];
  const at = visible?.indexOf(input.quote) ?? -1;
  if (at < 0 || visible.indexOf(input.quote, at + 1) >= 0 || summary&&!view.syntax.closingRows[i] ||
      raw.slice(at, at + input.quote.length) !== input.quote || summary !== (i >= view.summaryStart)) {
    throw new Error("逐项结论引句须唯一定位在相应的当前正文或大白话，不能引用隐藏示例或另一位置");
  }
  return { line: input.line, quote: input.quote, start: at, end: at + input.quote.length };
}

function provesSubject(ref, id) {
  return typeof ref.quote === "string" && new RegExp(`(?<![A-Za-z0-9_-])${escape(id)}(?![A-Za-z0-9_-])`, "u").test(ref.quote);
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
  const proof = partsOn(coverage, view, location).find(part =>
    part.status === "supported" && part.assertion === "project-application" &&
    part.inference?.rule === "project-policy" && part.inference.policy.some(ref => ref.goalSha256 === goalSha256) &&
    part.inference.premises.some(ref => provesSubject(ref, id)));
  if (!proof) throw new Error(id + " 的正文或大白话结论缺本角色已核的 project-application 证明，须逐字绑定当前条款及该项记录");
  return proof;
}

const proofHash = proof => digest(JSON.stringify(proof));

/** The case's raw record and the recommendation are separate assertions
 * even when they appear in one physical row. */
function originalRecord(coverage, line, id, applied) {
  const facts = coverage.records.filter(record => record.line === line).flatMap(record => record.parts);
  const proof = facts.find(part => part.status === "supported" && part.assertion === "original-fact" &&
    (part.evidence ?? part.inference?.premises ?? []).some(ref => provesSubject(ref, id) &&
      applied.inference.premises.some(premise =>
        ref.file === premise.file && ref.sha256 === premise.sha256 && ref.evidenceSpan === premise.evidenceSpan)));
  if (!proof) throw new Error(id + " 的正文缺同一记录的 original-fact 证明，须将原始事实与项目处置分别核对");
  return proof;
}

function decideRow(view, item, row, coverage, contract) {
  const { id } = item;
  if (!statusTypes.includes(row.status) || !brief(row.basis, 500)) throw new Error(id + " 缺逐项结论状态或简短判断依据");
  const body = row.body && locate(view, row.body, false);
  const summary = row.summary && locate(view, row.summary, true);
  const result = { id, status: row.status, basis: row.basis, ...(body ? { body } : {}), ...(summary ? { summary } : {}) };
  if (row.status === "clarify") {
    if (!body || !brief(row.question, 360) || !/[？?]$/u.test(row.question) || row.decision !== undefined) {
      throw new Error(id + " 的待澄清须给相关正文和可回答的具体问题，不填处置结果");
    }
    return { ...result, question: row.question, bodyProof: proofHash(application(coverage, view, body, id, contract.goalSha256)) };
  }
  if (row.status !== "decided") {
    if (row.decision !== undefined || row.question !== undefined || row.status === "inconsistent" && (!body || !summary)) {
      throw new Error(id + " 未达标时不填处置值；正文和总结不一致须分别定位");
    }
    return result;
  }
  if (!body || contract.summary && !summary || !brief(row.decision, 32) || !scalar.test(row.decision) || unresolved.test(row.decision) || row.question !== undefined) {
    throw new Error(id + " 须分别定位正文和已要求的大白话，并给明确处置结果");
  }
  const check = (loc, inSummary) => {
    const found = view.syntax.visible.flatMap((raw, i) => (i >= view.summaryStart) === inSummary ?
      declarationsAt(raw, id, inSummary).map(field => ({ ...field, line: i + 1 })) : []);
    if (found.length !== 1 || found[0].line !== loc.line || found[0].quote !== loc.quote || found[0].decision !== row.decision) {
      throw new Error(id + " 须逐字指向唯一的「事项编号：结果」字段；条件、提及和其他事项不是本项明确处置");
    }
    return application(coverage, view, loc, id, contract.goalSha256);
  };
  const applied = check(body,false);
  return { ...result, decision: row.decision, bodyProof: proofHash(applied),
    originalProof: proofHash(originalRecord(coverage, body.line, id, applied)),
    ...(summary ? { summaryProof: proofHash(check(summary,true)) } : {}) };
}

/** A report belongs to this role and this candidate. Ledger validation calls
 * the same normalizer over persisted inputs and independent source proofs. */
export function reviewDeliveryOutcomes(contract, bytes, coverage, actor, input) {
  if (!contract) return null;
  if (!Array.isArray(input) || input.length !== contract.items.length) throw new Error("请按 prepare.outcomeContract 提交所有逐项交付判断 outcomes");
  const byId = new Map(input.map(row => [row?.id, row]));
  if (byId.size !== input.length || contract.items.some(item => !byId.has(item.id))) throw new Error("逐项交付编号必须逐个对应当前目标，不能漏交、重复或借用编号");
  const view = candidateView(bytes);
  const items = contract.items.map(item => decideRow(view, item, byId.get(item.id), coverage, contract));
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
