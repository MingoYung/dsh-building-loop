import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUTHORITY, MANAGED, PHASES, authority, digest, includes, keyOf, readBytes, relativeName, replaceBytes,
  replaceWithHistory, text, workspaceRoot,
} from "./policy.mjs";
import {
  QUALITY, citation, claimRow, deliveryQuality, lineList, numericChecks, plainLastIssues,
  rejectedClaims, reviewedQuality, supplementChecks, repairBaseline,
} from "./preflight.mjs";
import { checkSourceNarrative, coverageFindings, evidenceReference, expectedClaims, readInventory } from "./evidence.mjs";
import { TERMINAL, beginLedgerReview, captureRequest, ledgerAction, ledgerSummary, noteContextRead, trackUnit } from "./ledger.mjs";
import { goalSnapshot, needsRevalidation, requireGoalRead } from "./goals.mjs";
import { CoverageRecordError, classificationDisagreements, coverageAction, coverageSchema, coverageSummary, requireDisputedProof, recordMeetsDispute, documentCoverage, citationLineCounts } from "./coverage.mjs";

export const name = "building-loop-governance";
export const inject = ["agents", "subagents", "systemPrompt", "tools"];
const WORKFLOW = "building_loop";
const FILE = "building_loop_file";
const ASSESS = "building_loop_quality";
const LEDGER = "building_loop_ledger";
const COVERAGE = "building_loop_coverage";
const STATE_LIMIT = 8 * 1024 * 1024;
const EMPTY = { read: [], write: [] };

const BEGIN = {
  dispatch: "intake",
  "review-ready": "first-review",
  "supplement-ready": "supplement",
  "final-review-ready": "final-review",
  "goal-review-ready": "final-review",
  "first-audit-ready": "first-audit",
  "final-audit-ready": "final-audit",
};
const LEDGER_BASIS_RULE="账本 basis 只说明本项处置与当前目标或验收结果的关系；不要复述运行历史、宿主已有计数或哈希，宿主字段由账本导出负责。确需涉及数量时沿用原字段单位，全文块数不是行数。这是写作约束，不代替对依据内容的核实。";

const RULES = {
  intake: "接单。按指定二级索引找到候选，第一轮按任务单保留原稿送审。读回候选后用 submit 交接。来源真伪由独立核验方查，接单阶段缺少来源读权不构成阻塞。仅候选缺失或明确无法执行的任务才 block。宿主通知总控。",
  "first-review": "首次验收。独立打开候选和每条引用的原文，核数字、行号和适用范围。无出处或原文不支持就填 unsupported，不代为补查。",
  supplement: "补查。先读当前目标和退回回执，旧派单与新目标冲突时以当前目标为准。用 preflight 获取待改项，按原始证据原位修订，保留已证内容及要求的编号。按目标做必要改动；未要求时不要增加新的全稿计数、逐处标注或外部整页声明。无据的额外说法可删或收窄，不把内部修订说明混入成稿。出处路径和原文行写在同行。若保留稿件引用行数，修改后读回再用 preflight 的实测值核对。完整读回后 submit 带六项 quality。",
  "final-review": "终审。回到修订稿和原始证据，重新核对所有断言与改动。只有所有要求都支持才关单。",
  "first-audit": "独立反证复核。只看当前目标、正文和原始证据，重新逐块判断，不依赖第一核验者的回执。核完全文后用 building_loop audit 提交。",
  "final-audit": "修订稿独立反证复核。重新核全文与逐项推导，正确内容保留，证据不足写明确最小修正。核完用 building_loop audit 提交。",
};
const COVERAGE_RULE = '必须先完整读正文和当前目标，再 building_loop_coverage inventory 取得宿主全文清单（分页读取全部），用 record 为每块提交 parts；一块只有一段可省 quote，多段须连续逐字覆盖。标题、表格、脚注、括号和引用后补充句同样要核。复合句的独立判断拆开。直接转述用 direct + evidence 的原文逐字 quote；推导用 inference，列 premises、scope（对象/概念/条件）、assumptions（无则 []）、counterexample。自然语言推导 rule=source-warrant 须给原文 warrant 桥接关系；形式规则或配置计算按工具契约。检查概念是否一致、条件有无倒置、相关能否推出因果、样本能否推广；能构造前提成立结论却不成立的反例，就不得 supported。证据不足可直接 unsupported/uncertain + repair，不必伪造证明。正确直接转述不要求新增事实；明确 [推测]/[假设]/[未证实] 才能分类 hypothesis，纯标题等才是 nonfactual。每条写具体 basis。coverage status 的 pending 必须清零才能交回执。结构齐全不等于语义正确，需要自己对原文核对。';
const REVIEW_FORMAT = '先完整读当前目标文件、候选和引用原文。事实与写法分别判定：有据的事实应 supported，禁止因可选解释、排版或材料未提供的精度判 unsupported。事实退回须 finding={kind:"missing-evidence"|"contradiction"|"scope",quote:候选中实际存在的原句片段,fix:最小修正}；contradiction 还须 file/start/end 指向已读反证。不要要求补写原稿没有的新事实。事实支持后用 building_loop_quality assess：六项短依据、sourceRefs(file/start/end)、unverifiedSources、unlisted(line/basis)、revise；goalFit={pass,basis}明确现稿是否满足当前目标，符合便可通过，无需为“修订”而改字。质量退回须 revisions=[{field,change,requirement:{file,start,end}}]引用实际读取的目标或项目规则；可选改进放 suggestions，不阻止验收。最后 review 逐条 checks，支持项填 id/status="supported"/file/start/end/basis。空列表填 []。';
const QUALITY_RULE = "质量说明按任务规模写，小任务每项一两句具体内容。资料标实际来源及未证事项，结论和方法交代边界与取舍，给一个可行备选，先摘要后证据并留一句大白话。必要时引用文件和行号，细节留在正文，回执不用重复全文或哈希。";
const EVIDENCE_RULE = "sourceRefs 只填下列 evidence 白名单内的原始证据；候选、外部未核来稿和项目规则不能混充。unlisted 只填尚未编号、仍需查证的实际事实；空行、没有事实主张的标题、已核或已编号内容不要填，没有遗漏时填 []。需要判断的标题事实仍须列出。";
// Semantic alignment is an explicit review duty, not a host claim that quote
// hashes or two model approvals establish entailment in arbitrary prose.
const SOURCE_ALIGNMENT_RULE = "逐项对齐原文与结论的对象、关系、数值口径、统计层次、量词和适用条件。原文未说明的口径或层次须写未知，不能用领域常识补成来源事实。每个可独立证伪的修饰、量词或对象关系须单独拆成 parts 判断；主干有据不能替未证的括注、标签、原因说明或其他附加断言背书。direct 只作忠实转述，加入新概念或关系就须显式推导；找不到桥接原文时记录证据不足，不猜补。对本稿或产物自身完整性、计数、标注情况的主张，必须回到当前完整产物核查所指范围；外部来源只能证明外部事实，不能证明本稿怎样写。相应范围未核或无法支持时须 uncertain/unsupported 并要求删改，不能拿外部来源身份代替产物核查。";
const OBJECT_RULE="区分三个证据对象：外部事实用实际原文 evidence；已登记摘录的数量、成员或逐字范围用 direct.objectCheck 的 registered-excerpts；当前稿引用行数或逐处标记用 direct.objectCheck 的 candidate。已登记摘录无某字面不证明完整网页没有该内容，稿件自述也不能用外部标题证明。纯定位、编号和格式边界不另作事实；错例后说明及大白话若含事实仍逐项核。";
const EXAMPLE_RULE = '原句明确以“误读：”“错例：”“错误推理：”或 [误读]/[错例] 开头时，按 error-example 单列：sourceRelation 核其中展示的推理是 contradicts 或 insufficient，evidence 给实际反证或不足依据。宿主保留它作为已标注的错例，不作为已证前提；不要求作者为了核验换一个同义标签。没有显式标签绝不能用此分类。';
const LITERAL_RULE = '每个事实段还须 sourceRelation=supports|contradicts|insufficient，单独判断原文对这句话字面含义的关系。不得猜测作者有意举反例、在做测试或暗含否定；正文没有明确标注错误，就当成作者提出的断言。识别到原文与断言相反必须退回，不能一边说矛盾一边 supported。inventory 标 requiresInference 的块中有明确推导关系，推导片段用 inference 并交证明；不能把两个前提的组合叫直接转述来省证明。原文引句须逐字，但候选可以忠实翻译或同义转述，不要求字字相同。';
const COVERAGE_REJECTION_RULE = '覆盖中的事实退回必须 finding={kind:missing-evidence|contradiction|scope|invalid-inference,quote:该段实际错误断言,fix:最小修正}；contradiction 还须 evidence 原文反证。只说“可以更详细”“结尾未复述全部要点”不是事实错误：不作外部事实主张的阅读建议或收尾可 nonfactual，必要写法走 quality，选做改进放 suggestions。不能把正确但简短的句子判 uncertain 来要求扩写。记录时的分类或参数错误由核验方修正，禁止因此让作者返工。';
// Different inspection method, same admissibility standard. This is a mitigation
// for shared prompt bias, not proof that two calls to one model are independent.
const AUDIT_METHOD = '反证路线：逐块先固定原句提出的对象、量词、条件、因果方向和概念含义，再回原文寻找能使结论不成立的具体情形。检查“完成/成功”等相近词是否偷换、充分条件是否倒置、群体相关是否升级个体因果。不能猜作者意图，也不靠多数票；对正确内容须说明为何现有范围内反例不成立。仍用同一全文覆盖和证据门槛，不能只抽查危险句。';
const COORDINATOR = {
  dispatch: "派单。确认任务、单元与范围，advance 签发接单。",
  "review-ready": "接单方已交付。advance 发起首次独立核验。",
  "supplement-ready": "核验退回。依据回执用 advance 发起补查，默认续用执行会话。",
  "final-review-ready": "补查已交付。advance 发起终审。",
  "goal-review-ready": "目标已改变或旧验收版本失效。advance 续用核验会话验证当前交付，原事实记录保留。",
  "first-audit-ready": "首次核验暂通过，尚未验收。advance 启动独立反证子会话，不能提前关单。",
  "final-audit-ready": "修订核验暂通过，尚未验收。advance 续用独立反证子会话核全文与推导，之后才能复盘账本。",
  blocked: "先确认解阻条件，再用 advance 恢复原阶段和原子会话。模型首次中断可以续派，反复中断则把实际阻塞记入台账。",
  "ledger-review": "本轮事实已验收。必须用 building_loop_ledger 的 read 读最新账本，并读取授权的项目现状文件和本轮验收回执。结合当前目标、变更和已有成果，对每条未结事项决定 keep/resume/defer/completed/covered/obsolete，说明原因。完成、被覆盖或失效须附当前原文行依据。用账本 review 关单，保留和续做均由现状判断。"+LEDGER_BASIS_RULE,
  closed: "单元已验收关单。读通过回执、核对执行身份并更新授权台账。汇报先给结论，再按需展开出处、方法、备选和未证边界，最后一句大白话。",
};

const string = { type: "string" };
const number = { type: "integer" };
const isReview = phase => phase.endsWith("review");
const isAudit = phase => phase.endsWith("audit");
const buffer = value => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
// Accepted control receipts expose counts/hashes, not the entire candidate through
// copied coverage records. Detailed proof stays in host state for authorized roles.
const coverageReceipt = ({ records, ...summary }) => summary;

/** 统一 DSH 工具契约，所有变更按非并发工具串行提交。 */
function tool(name, description, action, properties, execute, required = []) {
  return {
    name, description,
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: action }, ...properties },
      required: ["action", ...required],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await execute(args, exec)));
    },
  };
}

/** 限制交接说明的大小并拒绝空理由。 */
function requireText(value, label, limit = 1200) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("需要" + label);
  return value.trim();
}

/** 从已解析的授权清单取单元，防止模型自创越权单元。 */
function unitOf(frame, id) {
  if (!Object.hasOwn(frame.policy.units, id)) throw new Error("该工作单元未获授权");
  return frame.policy.units[id];
}

/** Private checkpoint identity binds material, never grants a model source reads.
 * The same read-only identity check is used by immediate coordinator notices.
 */
function checkpointBinding(frame,spec) {
  const candidate=readBytes(frame.root,spec.candidate);
  const evidence=[...new Set([...(spec.phases["first-review"].evidence??[]),...(spec.phases["final-review"].evidence??[])])];
  const observations=evidence.flatMap(file=>frame.policy.sourcePins[keyOf(file)]?.observation?.file??[]);
  return {policy:frame.policy.hash,candidateSha256:candidate?digest(candidate):null,goalSha256:goalSnapshot(frame).sha256,
    sources:[...new Set([...evidence,...observations])].map(file=>{const bytes=readBytes(frame.root,file);return {file,sha256:bytes?digest(bytes):null};}),
    context:[...new Set([...frame.policy.instructions,...spec.phases["first-review"].read,...spec.phases["final-review"].read])]
      .filter(file=>file!==spec.candidate&&!evidence.includes(file))
      .map(file=>{const bytes=readBytes(frame.root,file);return {file,sha256:bytes?digest(bytes):null};})};
}

/** Report an actual reconciliation transition without exposing either proof.
 * The notice is derived from current disputes, so successful resolution or a
 * version invalidation cannot leave behind a misleading historical fault label.
 */
function reconciliationNotice(frame,unit) {
  if(!unit?.reconciliation?.length)return {};
  const nextPhase=unit.phase==="blocked"?unit.resumePhase:BEGIN[unit.phase]??unit.phase;
  if(!["first-review","final-review","first-audit","final-audit"].includes(nextPhase))return {};
  const id=Object.keys(frame.state.units).find(key=>frame.state.units[key]===unit);
  if(!id||JSON.stringify(unit.reconciliationBinding)!==JSON.stringify(checkpointBinding(frame,unitOf(frame,id))))return {};
  if(unit.reconciliationExhausted)return {reason:"classification-reconciliation-unresolved",disputeCount:unit.reconciliation.length,
    nextRole:null,nextPhase:null,reasonNote:"当前版本的一次定向重核后仍有分歧，验收未通过。保留双方证明，等待维护者明确争议范围或更新有效材料；无需再次原样 advance。"};
  return {reason:"classification-reconciliation",disputeCount:unit.reconciliation.length,
    nextRole:nextPhase?.endsWith("audit")?"auditor":"reviewer",nextPhase,
    reasonNote:"这是核验分类分歧的正常重核流程，尚未认定系统故障；只按当前争议重核，不凭阶段回转编造故障原因。"};
}

/** 向总控只暴露阶段、身份和回执入口，正文仍走文件授权。 */
function viewUnits(frame) {
  return Object.keys(frame.policy.units).map(id => {
    const unit = Object.hasOwn(frame.state.units, id) ? frame.state.units[id] : undefined;
    if (!unit) return { unit: id, phase: "dispatch", next: "intake" };
    const { phase, executor, reviewer, auditor, receipt, unsupported, qualityRejected, blocked, interruptions } = unit;
    const notice=reconciliationNotice(frame,unit);
    const stale=needsRevalidation(frame,id,unit)||!!unit.reconciliationExhausted&&!notice.reason;
    return {
      unit: id, phase, executor, reviewer, auditor, receipt, unsupported, qualityRejected, blocked, interruptions,
      ...notice,
      ...(frame.policy.units[id].cacheReadRotationThreshold ? {executorUsage:{session:executor,
        cacheReadTokens:unit.executorUsage?.[executor]?.cacheReadTokens??0,
        threshold:frame.policy.units[id].cacheReadRotationThreshold,rotations:unit.rotations??[]}} : {}),
      next: notice.reason==="classification-reconciliation-unresolved"?null:stale?"final-review":phase==="blocked"?unit.resumePhase:BEGIN[phase],
      goalStale: stale,
      owned: unit.owner === frame.agent.id,
    };
  });
}

/** 安装预设内的工具、强制注入和事件记录，普通模式独立运行。 */
export function apply(ctx, config = {}) {
  const presetId = config.presetId ?? "building-loop";
  const hostHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
  const stateHome = path.join(hostHome, "building-loop-state");
  fs.mkdirSync(stateHome, { recursive: true });
  const restrictedAgents = new WeakSet();

  /** Hide inherited native tools inside this agent's own scope. Runtime guards
   * remain authoritative, including calls made without the advertised schema.
   */
  function restrictVisible(agent) {
    if (!agent?.ctx?.tools || restrictedAgents.has(agent)) return;
    scope(agent); // Establish the governed identity before changing its tool view.
    const names = agent.ctx.tools.view(agent).restrictableNames;
    agent.ctx.tools.restrict({ allow: [...names].filter(name => [WORKFLOW,FILE,ASSESS,LEDGER,COVERAGE].includes(name)) });
    restrictedAgents.add(agent);
  }

  /** Registration admission is recalculated each step; it never grants file rights. */
  function visible(roles) {
    return ({ agent }) => {
      try {
        // DSH snapshots tool schemas before evaluating runtime-context text.
        // Admission runs earlier, so restrict here even on a fresh child's first
        // request; the later context/pre-step calls remain idempotent fallbacks.
        restrictVisible(agent);
        return roles.includes(scope(agent).role);
      } catch { return false; }
    };
  }

  /** 每次操作重新读取清单和持久状态，以真实父子会话确定权限。 */
  function scope(agent) {
    if (!agent || ctx.agents.get(agent.id) !== agent) throw new Error("只接受当前 DSH 会话的调用");
    const root = workspaceRoot(agent.session.header.cwd, hostHome);
    const policy = authority(root);
    const file = digest(keyOf(root)) + ".json";
    const old = readBytes(stateHome, file, STATE_LIMIT);
    let state = old ? JSON.parse(text(old)) : { spec: "building-loop-state/1", policy: policy.hash, units: {}, markers: {} };
    if (state.spec !== "building-loop-state/1") throw new Error("工作台账版本无效");
    if (state.policy !== policy.hash) {
      if (Object.values(state.units).some(unit => !TERMINAL.has(unit.phase))) throw new Error("运行期间授权清单发生变化，需项目维护者核对");
      state = { ...state, policy: policy.hash, units: {} };
    }
    state.units = Object.assign(Object.create(null), state.units);
    state.markers = Object.assign(Object.create(null), state.markers);
    const parent = agent.session.header.parentSession;
    const child = parent !== undefined || agent.session.header.origin === "subagent";
    let assignment;
    if (child) {
      assignment = Object.entries(state.units).find(([, unit]) =>
        unit.owner === parent && unit.actor === agent.id && PHASES.includes(unit.phase));
    }
    const role = child ? !assignment ? "idle" : isAudit(assignment[1].phase) ? "auditor" : isReview(assignment[1].phase) ? "reviewer" : "executor" : "coordinator";
    const grant = assignment ? unitOf({ policy }, assignment[0]).phases[assignment[1].phase] : child ? EMPTY : policy.coordinator;
    // goalContext explicitly grants read-only central context to working roles.
    const reads = role === "idle" ? [] : [...new Set([...grant.read, ...policy.instructions, ...policy.goalContext])];
    // The authority grants the host permission to generate this projection;
    // model file writes cannot replace a complete state-derived snapshot.
    const writes=grant.write.filter(file=>!policy.ledgerDocument||keyOf(file)!==keyOf(policy.ledgerDocument));
    return { agent, root, policy, file, old, state, role, assignment, reads, writes };
  }

  /** 同工作区状态共用独占锁，操作成功后原子落盘。 */
  function change(agent, operation) {
    const info = scope(agent);
    const lock = path.join(stateHome, info.file + ".lock");
    let fd;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("工作台账正在更新，请按当前台账重试");
      throw error;
    }
    let frame;
    try {
      frame = scope(agent);
      if (frame.file !== info.file) throw new Error("工作区在动作前发生变化");
      let result, invalidation;
      try { result = operation(frame); }
      catch(error) {
        // A failed replacement must retire the old block proof; otherwise an
        // executor could close with a judgment the reviewer just invalidated.
        if (!(error instanceof CoverageRecordError) || !frame.changed) throw error;
        invalidation = error;
      }
      if (frame.changed) {
        // Workflow and ledger share a rolling pre-edit snapshot as well as the lock.
        const backup = frame.file + ".bak";
        if (frame.old) replaceBytes(stateHome, backup, frame.old, readBytes(stateHome, backup, STATE_LIMIT), STATE_LIMIT);
        replaceBytes(stateHome, frame.file, buffer(frame.state), frame.old, STATE_LIMIT);
      }
      if (invalidation) throw invalidation;
      return result;
    } catch(error) {
      // A configured ledger file may already have been published when host-state
      // persistence fails. Restore its bytes, change log and rolling backups; do
      // not let an uncommitted closed snapshot survive a reported failed action.
      const failures=[];
      for(const undo of [...(frame?.rollback??[])].reverse())try{undo();}catch(failure){failures.push(failure);}
      if(failures.length)throw new AggregateError([error,...failures],"宿主提交失败，账本文件回滚也未完全成功；当前操作未完成，需要核对宿主台账与导出文件",{cause:error});
      throw error;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  /** 同阶段重试沿用改前备份，跨阶段建立新的改前边界。 */
  function tag(frame) {
    if (frame.assignment) {
      const [id, unit] = frame.assignment;
      return unit.owner + "/" + id + "/" + unit.serial + "/" + unit.phase;
    }
    return frame.agent.id + "/coordinator/" + Object.values(frame.state.units)
      .map(unit => unit.serial + "-" + unit.phase).join("_");
  }

  /** Record only lines actually returned to the caller, preserving exact versions. */
  function seenLines(frame, file, bytes, start, end) {
    if (end < start) return;
    const hash = digest(bytes);
    if (frame.assignment) {
      const active = frame.assignment[1], key = keyOf(file);
      const previous = active.seen?.[key];
      active.seen ??= {};
      Object.defineProperty(active.seen,key,{value:{hash,ranges:mergeRanges([...(previous?.hash===hash?previous.ranges:[]),[start,end]])},
        configurable:true,enumerable:true,writable:true});
      frame.changed = true;
    }
    noteContextRead(frame,file,hash,start,end);
  }

  /** Keep at most one current-version checkpoint for each independent role. */
  function refreshCheckpoints(frame,active,spec) {
    const binding=checkpointBinding(frame,spec),same=value=>JSON.stringify(value)===JSON.stringify(binding);
    if(active.restoredCheckpointBinding&&!same(active.restoredCheckpointBinding)) {
      // A restored memo has already become the active proof/read state. Retire
      // that copy as well, including nonfactual blocks with no source references.
      delete active.coverage;delete active.assessment;delete active.restoredCheckpointBinding;
      active.seen={};frame.changed=true;
    }
    for(const key of ["reviewerCheckpoint","auditorCheckpoint"])if(active[key]&&!same(active[key].binding)) {
      delete active[key];frame.changed=true;
    }
    if(active.reconciliationBinding&&!same(active.reconciliationBinding)) {
      for(const field of ["reconciliation","reconciliationBinding","reconciliationRound","reconciliationExhausted"])delete active[field];
      frame.changed=true;
    }
    return binding;
  }

  function ownCheckpoint(frame,active,spec) {
    return {actor:active.actor,phase:active.phase,binding:checkpointBinding(frame,spec),
      seen:structuredClone(active.seen??{}),coverage:structuredClone(active.coverage),
      ...(frame.role==="reviewer"&&active.assessment?{assessment:structuredClone(active.assessment)}:{})};
  }

  /** Deliver a bounded, visible reading packet and phase contract in one call.
   * Hash-valid earlier reads are reused only within the same working checkpoint;
   * reading in the host without returning the lines never counts as model reading.
   */
  function prepareInputs(args, exec) {
    return change(exec.agent, frame => {
      if (frame.role === "idle") throw new Error("当前子会话没有已授权的工作阶段");
      const assignment = frame.assignment;
      const owned=Object.values(frame.state.units).filter(row=>row.owner===frame.agent.id);
      const current = assignment?.[1] ?? owned.find(row=>!TERMINAL.has(row.phase)) ?? owned.at(-1);
      const spec = assignment && unitOf(frame,assignment[0]);
      const phase = assignment?.[1].phase ?? current?.phase ?? "dispatch";
      if(spec)refreshCheckpoints(frame,current,spec);
      const order = [...new Set([...frame.policy.goalContext,...frame.policy.instructions,
        ...(spec?[spec.candidate]:[]),...frame.reads])].filter(file=>includes(frame.reads,file));
      const files=[], pending=[];let bytesUsed=0;
      for (const file of order) {
        const bytes=readBytes(frame.root,file);
        if (!bytes) continue; // Future receipts may be authorized before they exist.
        const lines=lineList(bytes),hash=digest(bytes);
        const prior=(assignment?current.seen:current?.ledgerSeen)?.[keyOf(file)];
        const ranges=prior?.hash===hash?prior.ranges:[];
        const unread=lines.map((_,i)=>i+1).filter(line=>!ranges.some(([a,b])=>a<=line&&b>=line));
        if (!unread.length) continue;
        const start=unread[0];const returned=[];
        for(let line=start;line<=lines.length&&returned.length<250;line++) {
          const row=[line,lines[line-1]],size=Buffer.byteLength(JSON.stringify(row));
          if(bytesUsed+size>32*1024)break;
          returned.push(row);bytesUsed+=size;
        }
        if(returned.length) {
          files.push({path:file,sha256:hash,totalLines:lines.length,lines:returned});
          seenLines(frame,file,bytes,start,returned.at(-1)[0]);
        }
        const end=returned.at(-1)?.[0]??start-1;
        if (unread.some(line=>line>end)) pending.push({path:file,start:end+1,
          next:returned.length?"再次 prepare 或按行 read":"单行超过读包限额，请用 building_loop_file read 显式读取"});
      }
      let coverage, manuscriptCounts;
      if(spec&&["reviewer","auditor"].includes(frame.role)) {
        try {
          requireGoalRead(frame,current);
          const bytes=reviewCandidate(frame,current,spec);
          coverage=coverageAction(frame,current,spec,{action:"inventory",count:24},{maxBytes:16*1024});
          manuscriptCounts=candidateMeasurements(frame,current,spec,bytes);
        } catch(error) { coverage={pendingRead:true,reason:error.message}; }
      }
      const next = frame.role==="auditor" ? "逐块 coverage record，全部完成后 audit"
        : frame.role==="reviewer" ? "逐块 coverage record，再 quality assess 和 review"
        : phase==="supplement" ? "按退回项修改，读回、preflight、submit"
        : frame.role==="executor"&&phase==="intake" ? "保留原稿 submit" : phase==="ledger-review" ? "ledger read 后逐项 ledger review"
        : phase==="closed" ? "已关单，按回执和账本汇报，不再推进已完成阶段" : BEGIN[phase] ? "按当前阶段 advance" : "等待当前工作会话交付";
      return {role:frame.role,phase,unit:assignment?.[0],files,pending,complete:pending.length===0,
        ...reconciliationNotice(frame,current),
        ...(coverage?{coverage}:{}),...(spec?{claims:spec.claims,plainLast:spec.plainLast}:{}),next,
        ...(manuscriptCounts?.length?{citationLineCounts:manuscriptCounts}:{}),
        ...(["reviewer","auditor"].includes(frame.role)&&current.reconciliation?.length?{reconciliation:current.reconciliation}:{}),
        contract:frame.role==="auditor"||frame.role==="reviewer"?{
          direct:{kind:"direct",status:"supported|unsupported|uncertain",sourceRelation:"supports|contradicts|insufficient",basis:"具体判断",
            evidence:[{file:"授权原文",start:1,end:1,quote:"对应行逐字引句"}]},
          rejected:{kind:"inference",status:"unsupported",sourceRelation:"insufficient",basis:"具体缺口",
            finding:{kind:"invalid-inference",quote:"候选真实原句",fix:"最小修正"}},
          ...(coverage?.blocks?.some(block=>/\[(?:摘录范围|稿件自述)\]/u.test(block.text))?{objectCheckExamples:{
            excerptCount:{kind:"registered-excerpts",check:"count",file:"原句明确写出的来源路径",expected:1},
            citingLineCount:{kind:"candidate",check:"citation-count",source:"原句所说的被引用来源，不是候选文件",expected:6},
            note:"示例数字须换成待核原句的数量；count 与 citation-count 分属不同对象。这里只核整个登记集合的摘录条数，不能把其中列举的几个例子当全部摘录。"}}:{}),
          ...(frame.role==="auditor"?{finalSubmission:{action:"audit"},finalSubmissionNote:"全部块已记录后仅提交此动作，unit可省略；checks/quality/note/全文不被audit消费，不要重发。"}:{}),
          ...(current.reconciliationRound?{targetedReview:"只补 pending 中不足的本角色记录；已保存并满足目标范围的证明无需重发。核验方可以用 review 省略 checks，宿主重验本角色同版本编号检查。若真实事实缺证，提交具体退回。"}:{}),
          note:"简单块每次 record 最多12块；复杂推导建议每批2–4块，避免工具参数生成超限，证明字段不可省。非事实用 nonfactual + supported + basis；明确假设用 hypothesis；错例用 error-example + evidence。形式P→Q/P/Q须同一命题，asserts不填right。"
        }:undefined};
    });
  }

  /** 文件入口集中执行白名单、实际已读行记录、日志和滚动备份。 */
  function fileAction(args, exec) {
    return change(exec.agent, frame => {
      if (frame.role === "idle") throw new Error("当前子会话没有已授权的工作阶段");
      if (args.action === "list") return { read: frame.reads, write: frame.writes };
      if (args.action === "search") {
        const query = requireText(args.query, "搜索字面量", 120);
        const paths = args.path === undefined ? frame.reads : [relativeName(args.path)];
        const matches = [];
        for (const file of paths) {
          if (!includes(frame.reads, file)) throw new Error("该文件不在当前读白名单");
          const bytes = readBytes(frame.root, file);
          if (!bytes) continue;
          const lines = lineList(bytes);
          for (let i = 0; i < lines.length && matches.length < 40; i++) {
            if (lines[i].includes(query)) matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 800) });
          }
          if (matches.length >= 40) break;
        }
        return { matches };
      }
      const file = relativeName(args.path);
      if (args.action === "write") {
        if(frame.policy.ledgerDocument&&keyOf(file)===keyOf(frame.policy.ledgerDocument))throw new Error("该文件是宿主生成的完整账本快照，只能由 building_loop_ledger export/review 更新，不能手写覆盖");
        if (!includes(frame.writes, file)) throw new Error("该文件不在当前写白名单");
        if (typeof args.content !== "string") throw new Error("需要 UTF-8 正文");
        const note = requireText(args.note, "改动理由", 500);
        const result = replaceWithHistory(frame.root, file, args.content, note, tag(frame), frame.state.markers);
        frame.changed = result.changed;
        return result;
      }
      if (!includes(frame.reads, file)) throw new Error("该文件不在当前读白名单");
      if (args.action === "history") {
        const history = readBytes(frame.root, MANAGED + "/changes/" + file + ".md");
        return { path: file, recent: history ? lineList(history).slice(0, 12) : [] };
      }
      if (args.action !== "read") throw new Error("未知文件动作");
      const bytes = readBytes(frame.root, file);
      if (!bytes) throw new Error("授权文件目前不存在");
      const lines = lineList(bytes);
      const start = args.start ?? 1;
      const count = args.count ?? 150;
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 250) {
        throw new Error("行范围无效，单次最多 250 行");
      }
      seenLines(frame,file,bytes,start,Math.min(start+count-1,lines.length));
      return { path: file, totalLines: lines.length, sha256: digest(bytes),
        lines: lines.slice(start - 1, start - 1 + count).map((line, index) => [start + index, line]) };
    });
  }

  /** 只允许拥有该单元的总控推进，阻塞单元可保留待后续处理。 */
  function prepare(frame, id) {
    if (frame.role !== "coordinator") throw new Error("只有总控可以推进阶段");
    const spec = unitOf(frame, id);
    const prior = Object.hasOwn(frame.state.units, id) ? frame.state.units[id] : null;
    if (prior && prior.owner !== frame.agent.id) throw new Error("此工作单元由其他总控持有");
    if (Object.entries(frame.state.units).some(([key, unit]) => key !== id && !TERMINAL.has(unit.phase) && unit.phase !== "blocked")) {
      throw new Error("当前工作区另有未结单的单元");
    }
    if(prior?.reconciliationExhausted&&reconciliationNotice(frame,prior).reason) {
      throw new Error("当前版本的分类定向重核已结束且仍未一致，请先由维护者明确争议范围或更新有效材料");
    }
    const revalidating = needsRevalidation(frame, id, prior)||prior?.reconciliationExhausted;
    const phase = revalidating ? "final-review"
      : prior?.phase === "blocked" ? prior.resumePhase : BEGIN[prior?.phase ?? "dispatch"];
    if (!phase) throw new Error("当前阶段尚未交付或已经关单");
    const role = isAudit(phase) ? "auditor" : isReview(phase) ? "reviewer" : "executor";
    const threshold=spec.cacheReadRotationThreshold;
    const used=prior?.executorUsage?.[prior.executor]?.cacheReadTokens??0;
    // Rotation occurs only between completed executor stages. An interrupted
    // checkpoint, reviewer or auditor always resumes its bound identity.
    const rotate=phase==="supplement" && prior?.phase!=="blocked" && spec.continuation==="reuse"
      && threshold!==undefined && used>=threshold;
    const reusable = revalidating ? prior?.reviewer : prior?.phase === "blocked" ? prior.actor
      : rotate ? undefined
      : phase === "supplement" && spec.continuation === "fresh" ? undefined : prior?.[role];
    return { prior, phase, role, reusable, rotate, used, threshold, serial: (prior?.serial ?? 0) + 1 };
  }

  /** 先绑定阶段和执行身份再唤醒子会话，派发失败恢复原状态。 */
  async function advance(args, exec) {
    const agent = exec.agent;
    const id = args.unit;
    const prepared = prepare(scope(agent), id);
    const resident = prepared.reusable && ctx.agents.get(prepared.reusable);
    if (resident) await waitIdle(resident, exec.signal);
    exec.signal.throwIfAborted();
    const childId = prepared.reusable ?? randomUUID();
    const next = change(agent, frame => {
      const plan = prepare(frame, id);
      if (plan.phase !== prepared.phase || plan.serial !== prepared.serial || plan.reusable !== prepared.reusable) {
        throw new Error("工作单元已经由其他调用推进");
      }
      const spec = unitOf(frame, id),binding=checkpointBinding(frame,spec);
      const resumeSame=plan.prior?.phase==="blocked"&&plan.prior.actor===childId&&plan.prior.resumePhase===plan.phase
        &&JSON.stringify(plan.prior.materialBinding)===JSON.stringify(binding);
      const record = {
        ...(plan.prior ?? {}), owner: agent.id, actor: childId, [plan.role]: childId,
        phase: plan.phase, serial: plan.serial,materialBinding:binding,
        // An interrupted same-role checkpoint retains what that same session saw.
        // Current hashes are rechecked by every evidence/goal/candidate consumer.
        seen: resumeSame ? plan.prior.seen ?? {} : {}, goal: goalSnapshot(frame),
      };
      delete record.blocked;
      delete record.resumePhase;
      delete record.assessment;
      refreshCheckpoints(frame,record,spec);
      if (plan.rotate) {
        record.rotations=[...(record.rotations??[]),{from:plan.prior.executor,to:childId,
          cacheReadTokens:plan.used,threshold:plan.threshold,phase:plan.phase,
          reason:"cache-read-threshold",at:new Date().toISOString()}];
      }
      // A blocked auditor can be redirected to the reviewer after a goal change.
      // Only the exact same actor, phase and material binding may retain active
      // proof; checking merely "blocked" would transfer one role's proof to another.
      if (!resumeSame) delete record.coverage;
      if (!resumeSame) delete record.interruptions;
      if (!resumeSame) delete record.restoredCheckpointBinding;
      const saved=record[plan.role+"Checkpoint"];
      if(record.reconciliation?.length&&saved?.actor===childId&&saved.phase===plan.phase&&plan.prior?.phase!=="blocked") {
        // Restore only this role's own observed lines and proofs. The disputed
        // blocks must be redone; untouched blocks remain subject to final full
        // source/hash validation. Never copy the other reviewer's proof or reads.
        record.seen=structuredClone(saved.seen);
        record.coverage=structuredClone(saved.coverage);
        record.restoredCheckpointBinding=structuredClone(saved.binding);
        for(const dispute of record.reconciliation) {
          const entry=record.coverage.records[dispute.block];
          // Only this actor's current, sufficient evidence can be retained.
          // Final coverage rechecks the saved proof with this phase's grants.
          if(!entry||dispute.objectSpans?.length||!recordMeetsDispute(entry,dispute))delete record.coverage.records[dispute.block];
        }
        if(saved.assessment)record.assessment=structuredClone(saved.assessment);
      }
      if (plan.phase === "supplement" && record.unsupported?.length && !record.rejected) {
        const candidate = readBytes(frame.root, spec.candidate);
        if (!candidate) throw new Error("无法为旧退回记录建立候选基线");
        record.rejected = rejectedClaims(frame.root, spec, lineList(candidate),
          record.unsupported.map(id => ({ id })), spec.phases.supplement.read);
      }
      frame.state.units[id] = record;
      trackUnit(frame, id, record);
      frame.changed = true;
      const brief = "工作单元 " + id + " 进入 " + plan.phase + "。候选文件 " + spec.candidate
        + (record.receipt && plan.phase === "supplement" ? "。请读取退回回执 " + record.receipt : "")
        + "。执行前依据已注入的阶段规则与授权范围。"
        // Reviewer/auditor activation never consumes the coordinator's free-text
        // note, which can contain previous verdicts or proposed answers. Required
        // user changes belong in authorized project files, read at the new stage.
        + (plan.role!=="executor"?"独立依据当前授权目标、候选和原始材料核验，不预设结论。"
          : args.note===undefined?"":"\n本次任务要求 "+requireText(args.note,"任务说明"));
      return { workspace: frame.root, phase: plan.phase, serial: plan.serial, brief };
    });
    const content = [{ type: "text", text: next.brief }];
    try {
      if (prepared.reusable) {
        await ctx.subagents.sendMessage(agent, childId, content, { signal: exec.signal });
      } else {
        const selection = agent.model.current();
        await ctx.subagents.startActivation({
          provider: "spawn", childId, label: id + " " + next.phase,
          delivery: "parent", signal: exec.signal,
          request: {
            parent: agent, cwd: next.workspace, agentPreset: presetId, prompt: content, maxDepth: 1,
            ...(selection ? { agentOptions: selection } : {}),
          },
        });
      }
    } catch (error) {
      change(agent, frame => {
        const record = frame.state.units[id];
        if (record?.actor === childId && record.phase === next.phase && record.serial === next.serial) {
          if (prepared.prior) frame.state.units[id] = prepared.prior;
          else delete frame.state.units[id];
          frame.changed = true;
        }
      });
      throw error;
    }
    return { unit: id, phase: next.phase, childId, reused: Boolean(prepared.reusable),
      ...(prepared.rotate?{rotation:{from:prepared.prior.executor,to:childId,cacheReadTokens:prepared.used,
        threshold:prepared.threshold,reason:"cache-read-threshold"}}:{}) };
  }

  /** 中断保留原阶段，恢复时续回同一个子会话。 */
  function pause(active, reason) {
    active.blocked = reason;
    active.resumePhase = active.phase;
    active.phase = "blocked";
  }

  /** Cross-check review metadata against concrete rejected factual spans.
   * unlisted is repair debt, not an index of every heading or a summary of what
   * was read. Contradictory metadata stays with the reviewer, never the author.
   */
  function consistentUnlisted(frame,active,spec,bytes,value,coverage) {
    const lines=lineList(bytes),findings=coverageFindings(value,lines);
    if(!findings.length)return findings;
    const snapshot=coverage??coverageSummary(frame,active,spec,false),manifest=documentCoverage(bytes);
    return findings.map((finding,index)=>{
      const quote=value[index].quote??finding.text;
      const start=typeof quote==="string"&&quote.trim()?finding.text.indexOf(quote):-1;
      if(start<0||quote.length>2000||finding.text.indexOf(quote,start+1)!==-1) {
        throw new Error("[building-loop/metadata] unlisted.quote 须为该候选行内可唯一定位的实际待核事实原文；混合行请明确给 quote，不要填结构标题或解释文字");
      }
      const rejectedSpans=manifest.blocks.filter(block=>block.line===finding.line).flatMap(block=>{
        const record=snapshot.records.find(row=>row.block===block.id);
        return (record?.parts??[]).filter(part=>["direct","inference"].includes(part.kind)
          &&part.status!=="supported"&&part.finding).map(part=>{
          // A rejected compound part may contain an otherwise correct prefix.
          // Only its explicitly located finding becomes author repair debt.
          const rejected=part.finding.quote,at=part.quote.indexOf(rejected);
          if(at<0||part.quote.indexOf(rejected,at+1)!==-1)throw new Error("[building-loop/metadata] coverage.finding.quote 在本段无法唯一定位，先明确实际拒绝范围，不能把整个复合段都变成缺源债");
          return [block.start+part.start+at,block.start+part.start+at+rejected.length];
        });
      });
      for(let offset=start;offset<start+quote.length;offset++)if(finding.text[offset].trim()
        &&!rejectedSpans.some(([a,b])=>a<=offset&&b>offset)) {
        throw new Error("[building-loop/metadata] unlisted 第 "+finding.line+" 行与全文核验记录不一致，字符 "+offset
          +" 不在实际待核/拒绝的事实范围内。先在 coverage 对真实事实缺口给 direct/inference 与 finding，或删除误填的 unlisted；"
          +"已经核为 nonfactual、明确假设/错例或 supported 的内容不能生成作者缺源债。混合行用 quote 只定位真实问题，不要求作者改正确标题。原文="+JSON.stringify(quote.slice(0,240)));
      }
      const relevant=snapshot.rejected.filter(row=>row.line===finding.line&&row.repairBaseline
        &&row.repairBaseline.start<start+quote.length&&row.repairBaseline.end>start);
      const priorRefs=relevant.flatMap(row=>row.repairBaseline.refs);
      const scopeOnly=relevant.length&&relevant.every(row=>row.finding.kind==="scope");
      return {...finding,quote,repairBaseline:repairBaseline(frame.root,spec,lines,
        {...finding,quote,...(scopeOnly?{finding:{kind:"scope",quote}}:{})},frame.reads,active.seen,priorRefs)};
    });
  }

  /** 独立核验方提交判断，宿主核引用并绑定当前材料版本。 */
  function assess(args, exec) {
    return change(exec.agent, frame => {
      if (frame.role !== "reviewer") {
        throw new Error("只有本单元的独立核验方可提交质量判断");
      }
      const [id, active] = frame.assignment;
      // Child identity already binds exactly one active assignment. Missing transport
      // metadata may use that binding; an explicitly different unit never can.
      if (args.unit !== undefined && args.unit !== id) throw new Error("unit 与本会话授权不匹配，当前单元为 " + id);
      requireGoalRead(frame, active);
      const bytes = reviewCandidate(frame, active, unitOf(frame, id));
      const checks = reviewedQuality(args, args.revise);
      if (typeof args.goalFit?.pass !== "boolean") throw new Error("goalFit 须判断当前候选是否满足本轮目标");
      const goalFit = { pass: args.goalFit.pass, basis: requireText(args.goalFit.basis, "目标验收依据") };
      const revisions = validateRevisions(frame, active, args.revisions ?? [], args.revise);
      if (!goalFit.pass) checks.conclusion = { pass: false, basis: goalFit.basis };
      const spec = unitOf(frame, id);
      if (!Array.isArray(args.sourceRefs) || !args.sourceRefs.length || args.sourceRefs.length > 64) throw new Error("请逐份提交实际读取的 sourceRefs");
      const refs = args.sourceRefs.map(ref => evidenceReference(frame, active, spec, ref));
      checkSourceNarrative(frame, active, args.sources);
      if (!Array.isArray(args.unverifiedSources) || args.unverifiedSources.length > 64
        || args.unverifiedSources.some(item => typeof item !== "string" || !item.trim() || item.length > 1000)) throw new Error("请在 unverifiedSources 记录未核资料，空列表填 []");
      const unlisted = consistentUnlisted(frame,active,spec,bytes,args.unlisted);
      if (unlisted.length) checks.sources = { pass: false, basis: checks.sources.basis + "。候选存在未登记待核事实" };
      active.assessment = { hash: digest(bytes), checks, refs, unlisted, unverifiedSources: args.unverifiedSources,
        goalFit, revisions, suggestions: (args.suggestions ?? []).map(item => requireText(item,"可选建议")) };
      frame.changed = true;
      return { unit: id, assessed: true, observedSources: refs, actualReads: readInventory(frame, active),
        revise: Object.keys(checks).filter(field => !checks[field].pass), next: "review" };
    });
  }

  /** Candidate inventory is readable only by the assigned reviewer or blind auditor. */
  function cover(args, exec) {
    return change(exec.agent, frame => {
      if (!["reviewer", "auditor"].includes(frame.role)) throw new Error("全文覆盖仅本阶段核验或独立反证角色可访问，总控无正文读权");
      const [id, active] = frame.assignment;
      requireGoalRead(frame, active);
      const spec = unitOf(frame, id);
      refreshCheckpoints(frame,active,spec);
      reviewCandidate(frame, active, spec);
      return coverageAction(frame, active, spec, args);
    });
  }

  /** Finalize a blind second opinion. Pending acceptance is never ledger evidence. */
  function audit(frame, id, active, spec) {
    if (frame.role !== "auditor" || active.actor === active.reviewer || active.actor === active.executor) throw new Error("独立反证须使用不同于执行及首次核验的子会话");
    requireGoalRead(frame, active);
    const bytes = reviewCandidate(frame, active, spec);
    const pending = active.pendingReceipt;
    if (!pending || pending.candidateSha256 !== digest(bytes) || pending.goal.sha256 !== active.goal.sha256) throw new Error("待复核回执与当前正文或目标不一致，需重新核验");
    if(needsRevalidation(frame,id,active))throw new Error("待复核的来源或获取回执版本已经变化，请总控重新推进核验");
    const coverage = coverageSummary(frame, active, spec);
    requireDisputedProof(active,coverage.records,true);
    const layout = plainLastIssues(spec,lineList(bytes));
    // New source reads cannot retroactively validate old quoted proof.
    coverageSummary(frame, { ...active, coverage: { ...pending.coverage,
      records: Object.fromEntries(pending.coverage.records.map(record => [record.block, record])) } }, spec);
    const calculations = numericChecks(frame.root, spec, lineList(bytes), frame.reads);
    const conflicts = classificationDisagreements(pending.coverage, coverage);
    if (!coverage.rejected.length && !layout.length && conflicts.length && calculations.every(row => row.ok)) {
      active.reconciliation = conflicts;
      active.reconciliationBinding=checkpointBinding(frame,spec);
      active.auditorCheckpoint=ownCheckpoint(frame,active,spec);
      if(active.reconciliationRound) {
        // A changed span after the targeted pass does not earn another round
        // on identical inputs. An unresolved disagreement remains unaccepted.
        active.reconciliationExhausted=true;
        pause(active,"定向重核后仍有分类分歧，需维护者核定范围或更新材料；当前候选未验收。");
        trackUnit(frame,id,active,true);
      } else {
        active.reconciliationRound=1;
        active.phase = active.phase === "first-audit" ? "review-ready" : "final-review-ready";
      }
      return;
    }
    const unsupported = calculations.filter(row => !row.ok).map(row => row.id);
    const decision = coverage.rejected.length || unsupported.length || layout.length ? "reject" : "accept";
    const receipt = { ...pending, decision, calculations, unsupported, coverage: coverageReceipt(pending.coverage),
      ...(active.reconciliationRound?{classificationReview:{targetedRounds:active.reconciliationRound,remainingDisputes:conflicts.length}}:{}),
      qualityRejected: layout.length ? [...new Set([...(pending.qualityRejected??[]),"plain"])] : pending.qualityRejected,
      formatIssues: layout,
      independentAudit: { auditor: frame.agent.id, method: "counterexample-and-concept-mapping", coverage: coverageReceipt(coverage), actualReads: readInventory(frame, active) } };
    const receiptBytes = buffer(receipt);
    replaceWithHistory(frame.root, active.receipt, text(receiptBytes), "独立反证 " + decision, tag(frame), frame.state.markers);
    active.unsupported = unsupported;
    active.qualityRejected = receipt.qualityRejected;
    active.rejected = rejectedClaims(frame.root, spec, lineList(bytes), calculations.filter(row => !row.ok), frame.reads);
    active.coverageRejections = coverage.rejected;
    active.proof = { reviewer: pending.reviewer, reviewerCoverage: pending.coverage,
      auditor: frame.agent.id, auditorCoverage: coverage };
    active.rejectedCandidate = decision === "reject" ? digest(bytes) : null;
    active.phase = "supplement-ready";
    delete active.pendingReceipt;
    delete active.reconciliation;
    delete active.reconciliationBinding;
    delete active.reconciliationRound;
    delete active.reconciliationExhausted;
    delete active.reviewerCheckpoint;
    delete active.auditorCheckpoint;
    if (decision === "accept") {
      beginLedgerReview(frame, id, active, receiptBytes);
      delete active.quality;
    }
  }

  /** Attach bounded manuscript measurements after this actor has read the current version. */
  function candidateMeasurements(frame,active,spec,bytes) {
    const lines=lineList(bytes);
    const observed=active.seen?.[keyOf(spec.candidate)];
    const selfClaims=lines.filter(line=>/\[稿件自述\]/u.test(line));
    if(selfClaims.length&&observed?.hash===digest(bytes)&&observed.ranges.some(([a,b])=>a===1&&b>=lines.length)) {
      // These are current manuscript counts from an authorized candidate read.
      // They do not certify any other part of the author's claim or the source.
      const evidence=spec.phases[active.phase].evidence??spec.phases["final-review"].evidence;
      const files=evidence.filter(file=>includes(frame.reads,file)&&selfClaims.some(line=>citation(line,file)));
      return citationLineCounts(bytes,files).map(({lines,...row})=>({
        ...row,lines:lines.slice(0,24),...(lines.length>24?{linePreviewTruncated:true}:{})}));
    }
    return [];
  }

  /** Preserve the existing repair gates and expose the measurements separately. */
  function preflightCandidate(frame,active,spec,bytes) {
    const counts=candidateMeasurements(frame,active,spec,bytes);
    const result=supplementChecks(frame.root,spec,lineList(bytes),frame.reads,active);
    return counts.length?{...result,citationLineCounts:counts}:result;
  }

  /** 验收回执由宿主写入，事实通过后还必须完成账本复盘。 */
  function report(args, exec) {
    return change(exec.agent, frame => {
      if (!frame.assignment) throw new Error("当前会话没有可交付阶段");
      const [id, active] = frame.assignment;
      if (args.unit !== undefined && args.unit !== id) throw new Error("unit 与本会话授权不匹配，当前单元为 " + id);
      const spec = unitOf(frame, id);
      refreshCheckpoints(frame,active,spec);
      if (["reviewer", "auditor"].includes(frame.role) && active.goal?.sha256 !== goalSnapshot(frame).sha256) {
        active.phase = "goal-review-ready";
        active.seen = {};
        delete active.assessment;
        frame.changed = true;
        return { unit: id, phase: active.phase, parent: active.owner, reason: "目标变更，原验收停止，advance 重新验收当前目标" };
      }
      if (args.action === "block") {
        pause(active, requireText(args.note, "阻塞原因、责任人和恢复条件"));
        if(active.reconciliationRound)active.reconciliationExhausted=true;
        trackUnit(frame, id, active, true);
      } else if (args.action === "submit" && frame.role === "executor") {
        const bytes = readBytes(frame.root, spec.candidate);
        if (!bytes) throw new Error("候选文件尚未交付");
        const seen = active.seen[keyOf(spec.candidate)];
        if (seen?.hash !== digest(bytes) || !seen.ranges.some(([a, b]) => a === 1 && b >= lineList(bytes).length)) {
          throw new Error("请先完整读回当前候选文件");
        }
        if (active.phase === "supplement") {
          requireGoalRead(frame, active, true);
          const preflight = preflightCandidate(frame,active,spec,bytes);
          if (!preflight.ok) throw new Error("[building-loop/preflight] " + preflight.issues.join("；"));
          const evidenceOnly=active.qualityRejected?.every(field=>field==="sources")
            &&preflight.repairs.some(item=>item.resolution==="new-evidence-for-review");
          if (active.qualityRejected?.length && active.rejectedCandidate === digest(bytes)&&!evidenceOnly) {
            throw new Error("质量退回须落实到候选正文，不能只重写提交说明");
          }
          active.quality = deliveryQuality(args.quality, active.quality, active.qualityRejected);
          active.phase = "final-review-ready";
        } else {
          active.phase = "review-ready";
        }
      } else if (args.action === "audit") {
        audit(frame, id, active, spec);
      } else if (args.action === "review" && frame.role === "reviewer") {
        requireGoalRead(frame, active);
        const grant = spec.phases[active.phase];
        const bytes = reviewCandidate(frame, active, spec);
        const lines = lineList(bytes);
        const hash = digest(bytes);
        const previous=active.reconciliationRound&&active.pendingReceipt?.reviewer===exec.agent.id
          &&active.pendingReceipt.candidateSha256===hash&&active.pendingReceipt.goal?.sha256===active.goal.sha256
          ? active.pendingReceipt.checks : undefined;
        // Reuse only the assigned reviewer's own numbered checks, then run the
        // normal source, citation and read validation on every check again.
        let checked = reviewChecks(frame, active, spec, grant, args.checks??previous, lines);
        const coverage = coverageSummary(frame, active, spec);
        requireDisputedProof(active,coverage.records,true);
        if(active.assessment?.hash===hash)consistentUnlisted(frame,active,spec,bytes,active.assessment.unlisted,coverage);
        // Evaluate each configured number even when another claim has already failed.
        const calculations = numericChecks(frame.root, spec, lines, frame.reads);
        const mismatches = new Map(calculations.filter(result => !result.ok).map(result => [result.id, result.issue]));
        checked = checked.map(check => mismatches.has(check.id)
          ? { ...check, status: "unsupported", basis: "脚本复算未通过 " + mismatches.get(check.id) } : check);
        const unsupported = checked.filter(check => check.status !== "supported").map(check => check.id);
        const qualityChecks = active.assessment?.hash === hash ? active.assessment.checks : null;
        const layout = plainLastIssues(spec,lines);
        if (qualityChecks && layout.length) qualityChecks.plain = {pass:false,basis:layout.join("；")};
        if (!unsupported.length && !qualityChecks) throw new Error("请先用 building_loop_quality 提交当前候选的六项独立质量判断，再执行 review");
        const observedSources = qualityChecks ? active.assessment.refs?.map(ref => evidenceReference(frame, active, spec, ref)) : [];
        if (!unsupported.length && (!observedSources?.length || checked.some(check => !observedSources.some(ref =>
          keyOf(ref.file) === keyOf(check.file) && ref.sha256 === check.sha256 && ref.start <= check.end && ref.end >= check.start)))) {
          throw new Error("资料核验须覆盖每份支持结论的实际原文，请重新提交 sourceRefs");
        }
        const qualityRejected = qualityChecks ? Object.keys(qualityChecks).filter(field => !qualityChecks[field].pass) : [];
        const decision = unsupported.length || qualityRejected.length || coverage.rejected.length ? "reject" : "pending-audit";
        active.rejected = rejectedClaims(frame.root, spec, lines, checked.filter(check => check.status !== "supported"), frame.reads);
        const receipt = {
          unit: id, phase: active.phase, reviewer: exec.agent.id, decision, candidateSha256: hash,
          goal: active.goal, goalFit: active.assessment?.goalFit,
          unsupported, qualityRejected, checks: checked, calculations, coverage: coverageReceipt(coverage), formatIssues: layout,
          ...(active.quality ? { quality: active.quality } : {}),
          ...(qualityChecks ? { qualityChecks } : {}),
          observedSources, actualReads: readInventory(frame, active),
          ...(qualityChecks ? { unlisted: active.assessment.unlisted, unverifiedSources: active.assessment.unverifiedSources,
            revisions: active.assessment.revisions, suggestions: active.assessment.suggestions } : {}),
        };
        const receiptBytes = buffer(receipt);
        replaceWithHistory(frame.root, grant.receipt, text(receiptBytes), "独立核验 " + decision,
          tag(frame), frame.state.markers);
        active.receipt = grant.receipt;
        active.unsupported = unsupported;
        active.qualityRejected = qualityRejected;
        active.rejectedCandidate = decision === "reject" ? hash : null;
        active.unlisted = qualityChecks ? active.assessment.unlisted : [];
        active.coverageRejections = coverage.rejected;
        active.phase = "supplement-ready";
        if (decision === "pending-audit") {
          // Save while the original reviewer phase/identity is still available;
          // the private memo is never included in the public receipt or status.
          active.reviewerCheckpoint=ownCheckpoint(frame,{...active,phase:receipt.phase},spec);
          active.pendingReceipt = { ...receipt, coverage };
          active.phase = receipt.phase === "first-review" ? "first-audit-ready" : "final-audit-ready";
        } else {
          // A factual rejection is now author repair work, not an unresolved
          // classifier dispute. Retire every memo belonging to the old branch.
          for(const field of ["reviewerCheckpoint","auditorCheckpoint","reconciliation","reconciliationBinding","reconciliationRound","reconciliationExhausted","restoredCheckpointBinding","pendingReceipt"])
            delete active[field];
        }
        delete active.assessment;
      } else {
        throw new Error("当前角色和阶段不允许此动作");
      }
      if (active.phase !== "blocked") active.seen = {};
      frame.changed = true;
      return { unit: id, phase: active.phase, receipt: active.receipt, unsupported: active.unsupported,
        qualityRejected: active.qualityRejected, parent: active.owner,...reconciliationNotice(frame,active) };
    });
  }

  /** 阶段动作统一入口，持久回执成功后再通知父会话。 */
  async function workflow(args, exec) {
    if (args.action === "prepare") return prepareInputs(args,exec);
    if (args.action === "status") {
      try {
        const frame = scope(exec.agent);
        if (frame.role === "coordinator") return { role: frame.role, units: viewUnits(frame), read: frame.reads, write: frame.writes };
        const assignment = frame.assignment;
        return { role: frame.role, unit: assignment?.[0], phase: assignment?.[1].phase, read: frame.reads, write: frame.writes };
      } catch (error) { return { blocked: String(error.message) }; }
    }
    if (args.action === "advance") return advance(args, exec);
    if (args.action === "preflight") {
      const frame = scope(exec.agent);
      const assignment = frame.assignment;
      if (!assignment || assignment[1].phase !== "supplement") {
        throw new Error("只有本单元的补查执行方可预检");
      }
      if (args.unit !== undefined && args.unit !== assignment[0]) throw new Error("unit 与本会话授权不匹配，当前单元为 " + assignment[0]);
      const spec = unitOf(frame, assignment[0]);
      const bytes = readBytes(frame.root, spec.candidate);
      if (!bytes) throw new Error("候选文件尚未交付");
      return preflightCandidate(frame,assignment[1],spec,bytes);
    }
    const { parent, ...result } = report(args, exec);
    try {
      const notice = "building-loop 已落盘 " + JSON.stringify(result);
      await ctx.subagents.sendMessage(exec.agent, parent, [{ type: "text", text: notice }], { signal: exec.signal });
      // Signal DSH to finish after this persisted result, avoiding a paid idle tail.
      exec.concludeTurn?.();
      return { ...result, notified: true, turnConcluded: true };
    } catch {
      // A failed parent notification is not a completed handoff. Keep the normal
      // loop/final-delivery path available; never conclude this case prematurely.
      return { ...result, notified: false };
    }
  }

  const deny = exec => {
    if ([WORKFLOW, FILE, ASSESS, LEDGER, COVERAGE].includes(exec.name)) return undefined;
    return "[building-loop/denied] 原生工具 " + exec.name + " 禁止直接调用。使用受控文件或派单入口";
  };
  ctx.tools.guard(deny);
  ctx.on("tools/pre-execute", (exec, next) => {
    const reason = deny(exec);
    return reason ? { kind: "deny", reason } : next();
  });
  ctx.on("agent/pre-step", async (request, next) => {
    restrictVisible(request.agent);
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    return { ...decision, messages: decision.messages.filter(message => message.source?.kind !== "agent-instructions") };
  });
  ctx.on("session/event", (session, event) => {
    if (event.type === "assistant/message") {
      const agent=ctx.agents.get(session.id),{turn,step,usage}=event.data??{};
      // Missing usage stays unknown. Only DSH's measured cache-read field counts;
      // cumulative traffic is not confused with a context-window measurement.
      if(agent?.session!==session||!Number.isSafeInteger(turn)||!Number.isSafeInteger(step)
        ||turn<1||step<1||!Number.isSafeInteger(usage?.cacheReadTokens)||usage.cacheReadTokens<0)return;
      try { change(agent,frame=>{
        const active=Object.values(frame.state.units).find(row=>row.owner===session.header.parentSession
          && (row.executor===session.id||Object.hasOwn(row.executorUsage??{},session.id)));
        if(!active)return;
        active.executorUsage??={};
        const previous=active.executorUsage[session.id]??{cacheReadTokens:0,turnSteps:{}};
        const ranges=previous.turnSteps[turn]??[];
        if(ranges.some(([a,b])=>a<=step&&b>=step))return;
        const total=previous.cacheReadTokens+usage.cacheReadTokens;
        if(!Number.isSafeInteger(total))throw new Error("执行会话累计用量超过安全整数范围");
        active.executorUsage[session.id]={cacheReadTokens:total,turnSteps:{...previous.turnSteps,[turn]:mergeRanges([...ranges,[step,step]])}};
        frame.changed=true;
      }); } catch(error) {ctx.logger.warn("building-loop 无法记录执行会话用量 "+error.message);}
      return;
    }
    if (event.type === "user/message") {
      if (event.data?.source?.kind !== "user") return;
      const agent = ctx.agents.get(session.id);
      try { if (agent?.session === session) change(agent, frame => captureRequest(frame, event)); }
      catch (error) { ctx.logger.warn("building-loop 无法登记用户消息 " + error.message); }
      return;
    }
    if (event.type !== "turn/end" || !["error", "max-tokens", "blocked", "completed"].includes(event.data?.reason?.kind)) return;
    const agent = ctx.agents.get(session.id);
    if (agent?.session !== session || session.header.parentSession === undefined) return;
    try {
      change(agent, frame => {
        if (!frame.assignment) return;
        const [id, active] = frame.assignment;
        // A conversational end without a workflow receipt is not a delivery.
        // Preserve a resumable checkpoint instead of leaving an idle actor in an active phase.
        pause(active, event.data.reason.kind === "completed"
          ? "子会话已结束但本阶段未提交宿主回执。总控可从原阶段续派到同一会话。"
          : "子会话中断 " + event.data.reason.kind + "，本阶段未交付。总控可续派到原会话。");
        trackUnit(frame, id, active, true);
        active.interruptions = (active.interruptions ?? 0) + 1;
        frame.changed = true;
      });
    } catch (error) { ctx.logger.warn("building-loop 无法记录子会话中断 " + error.message); }
  });

  ctx.tools.register(tool(FILE, "按当前角色的准确路径白名单列出、读取、字面搜索或原子写入 UTF-8 文件。写入自动维护一份改前备份和逐文件日志。history 取授权文件的最近更新。", ["list", "read", "search", "write", "history"], {
    path: string, query: string, content: string, note: string, start: number, count: number,
  }, fileAction), {when:visible(["coordinator","executor","reviewer","auditor"])});

  const qualityFields = Object.fromEntries(Object.entries(QUALITY).map(([key, description]) => [key, { ...string, description }]));
  ctx.tools.register(tool(COVERAGE, "按宿主全文清单逐块核验。inventory分页取全文；record每次1–12块，部分错误只重交invalid块；status默认只给进度，可用block取单块证明。", ["inventory", "record", "status"], coverageSchema(), cover), {when:visible(["reviewer","auditor"])});
  const qualityNames = Object.keys(QUALITY);
  const referenceSchema = { type: "object", properties: { file: string, start: number, end: number }, required: ["file", "start", "end"], additionalProperties: false };
  ctx.tools.register(tool(ASSESS, "独立核验方在 review 前记录六项质量依据。每项一句具体判断，revise 列出要退回的项，均通过时填 []。此工具不关单。", ["assess"], {
    unit: { ...string, description: "可省略，宿主沿用当前子会话唯一已授权单元；显式编号须与授权一致。" }, ...qualityFields,
    goalFit: { type: "object", properties: { pass: { type: "boolean" }, basis: string }, required: ["pass","basis"], additionalProperties: false },
    revisions: { type: "array", items: { type: "object", properties: {
      field: { type: "string", enum: qualityNames }, change: string, requirement: referenceSchema,
    }, required: ["field","change","requirement"], additionalProperties: false } },
    suggestions: { type: "array", items: string, maxItems: 12 },
    revise: { type: "array", items: { type: "string", enum: qualityNames } },
    sourceRefs: { type: "array", description: "仅当前 evidence 白名单中实际读过的原始证据，不含候选或项目规则。", items: referenceSchema },
    unverifiedSources: { type: "array", items: string },
    unlisted: { type: "array", description: "仅当前coverage中仍被拒绝且有finding的未编号事实，不能填已核标题/假设/错例/支持项。混合行须用quote限定真实缺口；无遗漏填[]。", items: { type: "object", properties: { line: number, quote: string, basis: string }, required: ["line", "basis"], additionalProperties: false } },
  }, assess, [...qualityNames, "revise", "sourceRefs", "unverifiedSources", "unlisted", "goalFit"]), {when:visible(["reviewer"])});
  ctx.tools.register(tool(LEDGER, "总控登记后续计划、临时需求和搁置事项。每轮事实验收后read最新账本和项目现状，再逐项review。配置ledgerDocument时，review成功会由宿主生成完整当前账本；export也可生成阻塞时的当前快照，不改变验收状态。不要手写该文件。"+LEDGER_BASIS_RULE, ["read", "record", "review", "export"], {
    unit: { ...string, description: "复盘时指定单元；record(kind=interrupted) 指明已有宿主中断的单元时，返回原 unit-账项，勿重复登记。独立搁置任务可省略。" }, id: string, kind: { type: "string", enum: ["planned", "temporary", "interrupted"] },
    title: string, note: string, originId: string, includeClosed: { type: "boolean" },
    expectedItemSha256: { ...string, description: "显式修改已有独立账项时必填；取最近 ledger read 对应项目的 itemSha256。新增项目和原请求归类不填。" },
    decisions: { type: "array", items: { type: "object", properties: {
      id: string, outcome: { type: "string", enum: ["keep", "resume", "defer", "completed", "covered", "obsolete"] },
      basis: {...string,description:LEDGER_BASIS_RULE}, evidence: referenceSchema, coveredBy: string,
    }, required: ["id", "outcome", "basis"], additionalProperties: false } },
  }, (args, exec) => change(exec.agent, frame => ledgerAction(frame, args))), {when:visible(["coordinator"])});
  ctx.tools.register(tool(WORKFLOW, "每阶段先prepare获取授权读包、版本、待读页和契约；重复prepare只给未读或变化内容。advance仅总控，preflight/submit仅执行，review仅核验，audit仅独立反证；交付后自动结束本轮。", ["prepare", "status", "advance", "preflight", "submit", "review", "audit", "block"], {
    unit: { ...string, description: "总控 advance 必填；子会话动作省略时沿用宿主唯一授权单元。" }, note: string,
    checks: { type: "array", description: "这里只提交 claims/正文 C数字 的事实编号（如 C1/C2/C3）；B开头的全文块只在 building_loop_coverage record 提交，不放这里。", items: {
      type: "object", properties: {
        id: string, status: { type: "string", enum: ["supported", "unsupported"] },
        line: { ...number, description: "退回项在候选中没有编号行时填写候选行号" },
        file: { ...string, description: "supported 或 finding.kind=contradiction 均必填。实际已读原文路径，与 id/status 同级，不放 finding 内。" },
        start: { ...number, description: "supported 或 contradiction 必填。原文起始行，1 起计，与 id/status 同级。" },
        end: { ...number, description: "supported 或 contradiction 必填。原文结束行，1 起计，与 id/status 同级。" },
        basis: { ...string, description: "为何支持或为何不足" },
        finding: { type: "object", properties: { kind: { type: "string", enum: ["missing-evidence","contradiction","scope"] },
          quote: string, fix: string }, required: ["kind","quote","fix"], additionalProperties: false },
      }, required: ["id", "status", "basis"], additionalProperties: false,
    } },
    quality: { type: "object", properties: qualityFields, required: qualityNames, additionalProperties: false },
  }, workflow), {when:visible(["coordinator","executor","reviewer","auditor"])});

  ctx.systemPrompt.context({
    name: "building-loop.phase", order: 130, required: true, interpolate: false,
    text({ agent, scope: owner }) {
      try {
        restrictVisible(agent ?? owner);
        const frame = scope(agent ?? owner);
        const assignment = frame.assignment;
        const units = frame.role === "coordinator" ? viewUnits(frame) : null;
        const current = units?.find(unit => unit.owned && unit.goalStale)
          ?? units?.find(unit => unit.owned && !TERMINAL.has(unit.phase) && unit.phase !== "blocked")
          ?? units?.find(unit => unit.owned && unit.phase === "blocked");
        const closed = units?.length && units.every(unit => TERMINAL.has(unit.phase));
        const phase = assignment?.[1].phase ?? (units ? current?.phase ?? (closed ? "closed" : "dispatch") : "idle");
        const rule = frame.role === "coordinator"
          ? (current?.reason==="classification-reconciliation-unresolved"?current.reasonNote:current?.goalStale ? COORDINATOR["goal-review-ready"] : COORDINATOR[phase] ?? "等待当前阶段交付或核验回执。") + " 总控只读写白名单内的中央文件和回执。"
          : RULES[phase] ?? "本子会话当前无工作授权，等待总控。";
        const descriptor = "building-loop role=" + frame.role + " phase=" + phase;
        if (frame.role === "idle") return descriptor + "\n" + rule + " 宿主已负责阶段通知，直接结束本轮，不再调用工具或复述正文。";
        const shared = frame.policy.instructions.map(file => {
          const bytes = readBytes(frame.root, file, 12 * 1024);
          return bytes ? "项目规则 " + file + "\n" + text(bytes) : "";
        }).filter(Boolean);
        const goals = frame.policy.goalContext.map(file => {
          const bytes = readBytes(frame.root, file, 12 * 1024);
          return bytes ? "当前目标（高于旧派单说明） " + file + "\n" + text(bytes) : "当前目标缺失 " + file;
        });
        const detail = assignment ? {
          unit: assignment[0], candidate: unitOf(frame, assignment[0]).candidate,
          ...(frame.role !== "auditor" ? { receipt: assignment[1].receipt } : {}),
          ...(["reviewer", "auditor"].includes(frame.role) ? { claims: unitOf(frame, assignment[0]).claims,
            evidence: unitOf(frame, assignment[0]).phases[phase].evidence } : {}),
          ...(["reviewer","auditor"].includes(frame.role) && assignment[1].reconciliation ? { targetedDisputeCount: assignment[1].reconciliation.length } : {}),
          ...(phase === "final-review" && assignment[1].quality ? { executionQuality: assignment[1].quality } : {}),
        } : units;
        return [descriptor, rule, "本阶段先 building_loop prepare 获取真实可见读包和参数契约；pending仍有页就继续prepare或按行read。已读且版本未变不需重复读。交付后宿主结束本轮，不额外收尾或通知。",
          ...(frame.role === "reviewer" ? [REVIEW_FORMAT, EVIDENCE_RULE] : []),
          ...(frame.role === "auditor" ? [AUDIT_METHOD,'逐块 record 完成后最终只提交 building_loop {"action":"audit"}，unit可省略；不要重复发送 checks、quality、note 或全文。宿主从已落盘证明生成回执。'] : []),
          ...(["reviewer", "auditor"].includes(frame.role) ? [COVERAGE_RULE, SOURCE_ALIGNMENT_RULE, OBJECT_RULE, COVERAGE_REJECTION_RULE, LITERAL_RULE, EXAMPLE_RULE] : []),
          ...(phase === "supplement" || frame.role === "reviewer" ? [QUALITY_RULE] : []),
          ...(assignment && unitOf(frame,assignment[0]).plainLast ? ["正文最后一个实质段须明确标为大白话或直白说明，错例、出处和附录放在它之前。"] : []),
          "文件与阶段用 building_loop 和 building_loop_file。" + (frame.role === "reviewer" ? "质量判断用 building_loop_quality。" : ""),
          ...(frame.role === "coordinator" ? ["计划、临时需求和中断事项记入 building_loop_ledger。用户消息已自动登记待判定，结合现状分类处置。",
            ...(frame.policy.ledgerDocument?["账本快照 "+frame.policy.ledgerDocument+" 由宿主在 ledger review 成功后自动生成；需要当前快照用 ledger export，不调用 file write 二次转写。"]:[]),
            "已有请求用 originId 关联记录，不另起同义任务。独立计划不能借其他工作的验收标 completed；取消用 obsolete，被成果满足用 covered。covered 必须 coveredBy 指向当前目标下验收通过的单元；read 返回覆盖关系。",
            JSON.stringify({ ledger: ledgerSummary(frame).items.map(({ id, kind, title, status }) => ({ id, kind, title, status })) })] : []),
          JSON.stringify({ read: frame.reads, write: frame.writes, detail }), ...shared, ...goals].join("\n");
      } catch (error) {
        return "building-loop role=blocked phase=authority\n" + error.message + "。请项目维护者核对 " + AUTHORITY + "。";
      }
    },
  });
}

/** 合并已读范围，让多次分页读取能构成完整读回。 */
function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** 验收必须完整读过当前候选，禁止沿用旧版本阅读记录。 */
function reviewCandidate(frame, active, spec) {
  const bytes = readBytes(frame.root, spec.candidate);
  const seen = active.seen[keyOf(spec.candidate)];
  if (!bytes || seen?.hash !== digest(bytes) || !seen.ranges.some(([a, b]) => a === 1 && b >= lineList(bytes).length)) {
    throw new Error("验收前须完整读取当前候选正文");
  }
  return bytes;
}

/** Blocking quality requirements need a current rule locator; optional advice stays advisory. */
function validateRevisions(frame, active, revisions, fields) {
  if (!Array.isArray(revisions) || revisions.length > 12) throw new Error("revisions 须列出具体质量退回项");
  const results = revisions.map(item => {
    if (!fields.includes(item.field)) throw new Error("质量修订须对应 revise 中的字段");
    const { file, start, end } = item.requirement ?? {};
    const bytes = includes([...frame.policy.instructions, ...frame.policy.goalContext], file ?? "") && readBytes(frame.root, file);
    const seen = active.seen?.[keyOf(file ?? "")];
    if (!bytes || seen?.hash !== digest(bytes) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 1 || end < start || end > lineList(bytes).length || !seen.ranges.some(([a,b]) => a <= start && b >= end)) {
      throw new Error("质量退回须引用已读的当前目标或规则原文，选做建议请放 suggestions");
    }
    return { field: item.field, change: requireText(item.change,"最小质量改动"), requirement: { file,start,end,sha256:digest(bytes) } };
  });
  if (fields.some(field => !results.some(item => item.field === field))) throw new Error("每项 revise 都须有 revisions 的具体改动和要求出处");
  return results;
}

/** 覆盖项目最低断言与候选新增编号，再核每项原始出处。 */
function reviewChecks(frame, active, spec, grant, checks, candidate) {
  if (!Array.isArray(checks) || checks.length > 64) throw new Error("核验须逐条提交检查结果");
  const byId = new Map();
  const declared = expectedClaims(spec, candidate);
  for (const check of checks) {
    const id = check?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(id) || byId.has(id)
      || declared.length && !declared.includes(id)) throw new Error("核验编号无效、重复或超范围；checks 仅提交 " + declared.join(", ") + "。B开头块编号属于 building_loop_coverage，不放入 checks。");
    byId.set(id, check);
  }
  const ids = declared.length ? declared : [...byId.keys()];
  if (!ids.length) throw new Error("至少需要一项核验结果");
  return ids.map(id => {
    const check = byId.get(id);
    if (!check) throw new Error("核验参数缺少 " + id + " 的结果，请补齐 checks；未提交结果不等于候选事实错误");
    const basis = requireText(check.basis, "核验依据", 600);
    const reject = Number.isSafeInteger(check.line) ? { id, status: "unsupported", line: check.line } : { id, status: "unsupported" };
    if (check.status !== "supported") {
      const finding = check.finding;
      const row = claimRow(candidate, id) ?? (check.line ? { body: candidate[check.line-1] ?? "" } : null);
      if (!finding || !["missing-evidence","contradiction","scope"].includes(finding.kind)
        || typeof finding.quote !== "string" || !finding.quote.trim() || !row?.body.includes(finding.quote)) {
        throw new Error(id + " 的事实退回须 finding.kind、候选中真实存在的 quote 和最小 fix；表达建议不能填 unsupported");
      }
      const fix = requireText(finding.fix, "事实最小修正");
      if (finding.kind === "contradiction" && (typeof check.file !== "string" || !Number.isSafeInteger(check.start) || !Number.isSafeInteger(check.end))) {
        throw new Error(id + " 的反证参数不完整：file、start、end 必须与 id/status 同级，不能放在 finding 内；请修正参数后在原核验阶段重试");
      }
      const counterEvidence = finding.kind === "contradiction" ? evidenceReference(frame, active, spec, check) : undefined;
      return { ...reject, basis, finding: { kind:finding.kind, quote:finding.quote, fix }, ...(counterEvidence ? { counterEvidence } : {}) };
    }
    // A malformed evidence selection belongs to the reviewer. Do not convert it
    // into a factual rejection that forces an already-correct candidate to change.
    const invalid = reason => { throw new Error(id + " 的核验引用无效：" + reason
      + "。请在本轮证据白名单中选择候选同行的真实出处；确实缺源或不支持时，用 unsupported 和 finding 说明候选的实际缺陷"); };
    let file;
    try { file = relativeName(check.file); }
    catch { throw new Error(id + " 的支持项需要有效的原文路径"); }
    if (!includes(grant.evidence, file)) return invalid("出处不在核验授权范围");
    const evidence = readBytes(frame.root, file);
    const coverage = active.seen[keyOf(file)];
    if (!evidence || coverage?.hash !== digest(evidence) || !Number.isSafeInteger(check.start) || !Number.isSafeInteger(check.end)
      || check.start < 1 || check.end < check.start || !coverage.ranges.some(([a, b]) => a <= check.start && b >= check.end)) {
      throw new Error(id + " 的原文行未读、行号无效或来源已变，请读取后重新核验");
    }
    let line = Number.isSafeInteger(check.line) ? check.line : null;
    if (declared.length) {
      const row = claimRow(candidate, id);
      const cited = row && citation(row.body, file);
      if (!cited) return invalid("所选原文未出现在候选断言的同行出处");
      if (cited.start && (check.end < cited.start || check.start > cited.end
        || !coverage.ranges.some(([a, b]) => a <= cited.start && b >= cited.end))) return invalid("候选所引原文行与核验位置不一致或未完整读取");
      line = row.line;
    }
    const proof = evidenceReference(frame, active, spec, check);
    return { id, status: "supported", ...proof, line, basis };
  });
}

/** 续派前等原子会话收尾，超时保持原状态以便重试。 */
async function waitIdle(agent, signal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  bounded.throwIfAborted();
  let abort;
  try {
    await Promise.race([agent.whenIdle(), new Promise((_, reject) => {
      abort = () => reject(bounded.reason);
      bounded.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort) bounded.removeEventListener("abort", abort); }
}
