import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUTHORITY, MANAGED, PHASES, authority, digest, includes, keyOf, readBytes, relativeName, replaceBytes,
  replaceWithHistory, text, workspaceRoot,
} from "./policy.mjs";
import {
  QUALITY, citation, claimRow, deliveryQuality, lineList, numericChecks,
  rejectedClaims, reviewedQuality, supplementChecks,
} from "./preflight.mjs";
import { checkSourceNarrative, coverageFindings, evidenceReference, expectedClaims, readInventory } from "./evidence.mjs";
import { TERMINAL, beginLedgerReview, captureRequest, ledgerAction, ledgerSummary, noteContextRead, trackUnit } from "./ledger.mjs";
import { goalSnapshot, needsRevalidation, requireGoalRead } from "./goals.mjs";
import { classificationDisagreements, coverageAction, coverageSchema, coverageSummary } from "./coverage.mjs";

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

const RULES = {
  intake: "接单。按指定二级索引找到候选，第一轮按任务单保留原稿送审。读回候选后用 submit 交接。来源真伪由独立核验方查，接单阶段缺少来源读权不构成阻塞。仅候选缺失或明确无法执行的任务才 block。宿主通知总控。",
  "first-review": "首次验收。独立打开候选和每条引用的原文，核数字、行号和适用范围。无出处或原文不支持就填 unsupported，不代为补查。",
  supplement: "补查。先读当前目标和退回回执，旧派单与新目标冲突时以当前目标为准。用 preflight 获取待改项，按原始证据原位修订，保留编号，出处路径和原文行写在同一行，例如 第 2-3 行。勿把内部修订说明混入成稿。完整读回后 submit 带六项 quality。未读当前目标、未落实退回项或复算不符会被拦住。",
  "final-review": "终审。回到修订稿和原始证据，重新核对所有断言与改动。只有所有要求都支持才关单。",
  "first-audit": "独立反证复核。只看当前目标、正文和原始证据，重新逐块判断，不依赖第一核验者的回执。核完全文后用 building_loop audit 提交。",
  "final-audit": "修订稿独立反证复核。重新核全文与逐项推导，正确内容保留，证据不足写明确最小修正。核完用 building_loop audit 提交。",
};
const COVERAGE_RULE = '必须先完整读正文和当前目标，再 building_loop_coverage inventory 取得宿主全文清单（分页读取全部），用 record 为每块提交 parts；一块只有一段可省 quote，多段须连续逐字覆盖。标题、表格、脚注、括号和引用后补充句同样要核。复合句的独立判断拆开。直接转述用 direct + evidence 的原文逐字 quote；推导用 inference，列 premises、scope（对象/概念/条件）、assumptions（无则 []）、counterexample。自然语言推导 rule=source-warrant 须给原文 warrant 桥接关系；形式规则或配置计算按工具契约。检查概念是否一致、条件有无倒置、相关能否推出因果、样本能否推广；能构造前提成立结论却不成立的反例，就不得 supported。证据不足可直接 unsupported/uncertain + repair，不必伪造证明。正确直接转述不要求新增事实；明确 [推测]/[假设]/[未证实] 才能分类 hypothesis，纯标题等才是 nonfactual。每条写具体 basis。coverage status 的 pending 必须清零才能交回执。结构齐全不等于语义正确，需要自己对原文核对。';
const REVIEW_FORMAT = '先完整读当前目标文件、候选和引用原文。事实与写法分别判定：有据的事实应 supported，禁止因可选解释、排版或材料未提供的精度判 unsupported。事实退回须 finding={kind:"missing-evidence"|"contradiction"|"scope",quote:候选中实际存在的原句片段,fix:最小修正}；contradiction 还须 file/start/end 指向已读反证。不要要求补写原稿没有的新事实。事实支持后用 building_loop_quality assess：六项短依据、sourceRefs(file/start/end)、unverifiedSources、unlisted(line/basis)、revise；goalFit={pass,basis}明确现稿是否满足当前目标，符合便可通过，无需为“修订”而改字。质量退回须 revisions=[{field,change,requirement:{file,start,end}}]引用实际读取的目标或项目规则；可选改进放 suggestions，不阻止验收。最后 review 逐条 checks，支持项填 id/status="supported"/file/start/end/basis。空列表填 []。';
const QUALITY_RULE = "质量说明按任务规模写，小任务每项一两句具体内容。资料标实际来源及未证事项，结论和方法交代边界与取舍，给一个可行备选，先摘要后证据并留一句大白话。必要时引用文件和行号，细节留在正文，回执不用重复全文或哈希。";
const EVIDENCE_RULE = "sourceRefs 只填下列 evidence 白名单内的原始证据；候选、外部未核来稿和项目规则不能混充。unlisted 只填尚未编号、仍需查证的实际事实；空行、没有事实主张的标题、已核或已编号内容不要填，没有遗漏时填 []。需要判断的标题事实仍须列出。";
const EXAMPLE_RULE = '原句明确以“误读：”“错例：”“错误推理：”或 [误读]/[错例] 开头时，按 error-example 单列：sourceRelation 核其中展示的推理是 contradicts 或 insufficient，evidence 给实际反证或不足依据。宿主保留它作为已标注的错例，不作为已证前提；不要求作者为了核验换一个同义标签。没有显式标签绝不能用此分类。';
const LITERAL_RULE = '每个事实段还须 sourceRelation=supports|contradicts|insufficient，单独判断原文对这句话字面含义的关系。不得猜测作者有意举反例、在做测试或暗含否定；正文没有明确标注错误，就当成作者提出的断言。识别到原文与断言相反必须退回，不能一边说矛盾一边 supported。inventory 标 requiresInference 的块中有明确推导关系，推导片段用 inference 并交证明；不能把两个前提的组合叫直接转述来省证明。原文引句须逐字，但候选可以忠实翻译或同义转述，不要求字字相同。';
const COVERAGE_REJECTION_RULE = '覆盖中的事实退回必须 finding={kind:missing-evidence|contradiction|scope|invalid-inference,quote:该段实际错误断言,fix:最小修正}；contradiction 还须 evidence 原文反证。只说“可以更详细”“结尾未复述全部要点”不是事实错误：不作外部事实主张的阅读建议或收尾可 nonfactual，必要写法走 quality，选做改进放 suggestions。不能把正确但简短的句子判 uncertain 来要求扩写。记录时的分类或参数错误由核验方修正，禁止因此让作者返工。';
const COORDINATOR = {
  dispatch: "派单。确认任务、单元与范围，advance 签发接单。",
  "review-ready": "接单方已交付。advance 发起首次独立核验。",
  "supplement-ready": "核验退回。依据回执用 advance 发起补查，默认续用执行会话。",
  "final-review-ready": "补查已交付。advance 发起终审。",
  "goal-review-ready": "目标已改变或旧验收版本失效。advance 续用核验会话验证当前交付，原事实记录保留。",
  "first-audit-ready": "首次核验暂通过，尚未验收。advance 启动独立反证子会话，不能提前关单。",
  "final-audit-ready": "修订核验暂通过，尚未验收。advance 续用独立反证子会话核全文与推导，之后才能复盘账本。",
  blocked: "先确认解阻条件，再用 advance 恢复原阶段和原子会话。模型首次中断可以续派，反复中断则把实际阻塞记入台账。",
  "ledger-review": "本轮事实已验收。必须用 building_loop_ledger 的 read 读最新账本，并读取授权的项目现状文件和本轮验收回执。结合当前目标、变更和已有成果，对每条未结事项决定 keep/resume/defer/completed/covered/obsolete，说明原因。完成、被覆盖或失效须附当前原文行依据。用账本 review 关单，保留和续做均由现状判断。",
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

/** 向总控只暴露阶段、身份和回执入口，正文仍走文件授权。 */
function viewUnits(frame) {
  return Object.keys(frame.policy.units).map(id => {
    const unit = Object.hasOwn(frame.state.units, id) ? frame.state.units[id] : undefined;
    if (!unit) return { unit: id, phase: "dispatch", next: "intake" };
    const { phase, executor, reviewer, auditor, receipt, unsupported, qualityRejected, blocked, interruptions } = unit;
    return {
      unit: id, phase, executor, reviewer, auditor, receipt, unsupported, qualityRejected, blocked, interruptions,
      next: needsRevalidation(frame, id, unit) ? "final-review" : phase === "blocked" ? unit.resumePhase : BEGIN[phase],
      goalStale: needsRevalidation(frame, id, unit),
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
    return { agent, root, policy, file, old, state, role, assignment, reads, writes: grant.write };
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
    try {
      const frame = scope(agent);
      if (frame.file !== info.file) throw new Error("工作区在动作前发生变化");
      const result = operation(frame);
      if (frame.changed) {
        // Workflow and ledger share a rolling pre-edit snapshot as well as the lock.
        const backup = frame.file + ".bak";
        if (frame.old) replaceBytes(stateHome, backup, frame.old, readBytes(stateHome, backup, STATE_LIMIT), STATE_LIMIT);
        replaceBytes(stateHome, frame.file, buffer(frame.state), frame.old, STATE_LIMIT);
      }
      return result;
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
      if (frame.assignment && start <= lines.length) {
        const active = frame.assignment[1];
        const key = keyOf(file);
        const hash = digest(bytes);
        const coverage = Object.hasOwn(active.seen, key) ? active.seen[key] : undefined;
        const ranges = coverage?.hash === hash ? coverage.ranges : [];
        const end = Math.min(start + count - 1, lines.length);
        Object.defineProperty(active.seen, key, { value: { hash, ranges: mergeRanges([...ranges, [start, end]]) },
          configurable: true, enumerable: true, writable: true });
        frame.changed = true;
      }
      noteContextRead(frame, file, digest(bytes), start, Math.min(start + count - 1, lines.length));
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
    const revalidating = needsRevalidation(frame, id, prior);
    const phase = revalidating ? "final-review"
      : prior?.phase === "blocked" ? prior.resumePhase : BEGIN[prior?.phase ?? "dispatch"];
    if (!phase) throw new Error("当前阶段尚未交付或已经关单");
    const role = isAudit(phase) ? "auditor" : isReview(phase) ? "reviewer" : "executor";
    const reusable = revalidating ? prior?.reviewer : prior?.phase === "blocked" ? prior.actor
      : phase === "supplement" && spec.continuation === "fresh" ? undefined : prior?.[role];
    return { prior, phase, role, reusable, serial: (prior?.serial ?? 0) + 1 };
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
      const record = {
        ...(plan.prior ?? {}), owner: agent.id, actor: childId, [plan.role]: childId,
        phase: plan.phase, serial: plan.serial, seen: {}, goal: goalSnapshot(frame),
      };
      delete record.blocked;
      delete record.resumePhase;
      delete record.assessment;
      // Proof records belong to one role/checkpoint; only an interrupted stage may keep them.
      if (plan.prior?.phase !== "blocked") delete record.coverage;
      if (plan.prior?.phase !== "blocked") delete record.interruptions;
      const spec = unitOf(frame, id);
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
        + (args.note === undefined ? "" : "\n本次任务要求 " + requireText(args.note, "任务说明"));
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
    return { unit: id, phase: next.phase, childId, reused: Boolean(prepared.reusable) };
  }

  /** 中断保留原阶段，恢复时续回同一个子会话。 */
  function pause(active, reason) {
    active.blocked = reason;
    active.resumePhase = active.phase;
    active.phase = "blocked";
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
      const unlisted = coverageFindings(args.unlisted, lineList(bytes));
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
    const coverage = coverageSummary(frame, active, spec);
    // New source reads cannot retroactively validate old quoted proof.
    coverageSummary(frame, { ...active, coverage: { ...pending.coverage,
      records: Object.fromEntries(pending.coverage.records.map(record => [record.block, record])) } }, spec);
    const calculations = numericChecks(frame.root, spec, lineList(bytes), frame.reads);
    const conflicts = classificationDisagreements(pending.coverage, coverage);
    if (!coverage.rejected.length && conflicts.length && calculations.every(row => row.ok)) {
      active.reconciliation = conflicts;
      active.phase = active.phase === "first-audit" ? "review-ready" : "final-review-ready";
      return;
    }
    const unsupported = calculations.filter(row => !row.ok).map(row => row.id);
    const decision = coverage.rejected.length || unsupported.length ? "reject" : "accept";
    const receipt = { ...pending, decision, calculations, unsupported, coverage: coverageReceipt(pending.coverage),
      independentAudit: { auditor: frame.agent.id, coverage: coverageReceipt(coverage), actualReads: readInventory(frame, active) } };
    const receiptBytes = buffer(receipt);
    replaceWithHistory(frame.root, active.receipt, text(receiptBytes), "独立反证 " + decision, tag(frame), frame.state.markers);
    active.unsupported = unsupported;
    active.rejected = rejectedClaims(frame.root, spec, lineList(bytes), calculations.filter(row => !row.ok), frame.reads);
    active.coverageRejections = coverage.rejected;
    active.proof = { reviewer: pending.reviewer, reviewerCoverage: pending.coverage,
      auditor: frame.agent.id, auditorCoverage: coverage };
    active.rejectedCandidate = decision === "reject" ? digest(bytes) : null;
    active.phase = "supplement-ready";
    delete active.pendingReceipt;
    delete active.reconciliation;
    if (decision === "accept") {
      beginLedgerReview(frame, id, active, receiptBytes);
      delete active.quality;
    }
  }

  /** 验收回执由宿主写入，事实通过后还必须完成账本复盘。 */
  function report(args, exec) {
    return change(exec.agent, frame => {
      if (!frame.assignment) throw new Error("当前会话没有可交付阶段");
      const [id, active] = frame.assignment;
      if (args.unit !== undefined && args.unit !== id) throw new Error("unit 与本会话授权不匹配，当前单元为 " + id);
      const spec = unitOf(frame, id);
      if (["reviewer", "auditor"].includes(frame.role) && active.goal?.sha256 !== goalSnapshot(frame).sha256) {
        active.phase = "goal-review-ready";
        active.seen = {};
        delete active.assessment;
        frame.changed = true;
        return { unit: id, phase: active.phase, parent: active.owner, reason: "目标变更，原验收停止，advance 重新验收当前目标" };
      }
      if (args.action === "block") {
        pause(active, requireText(args.note, "阻塞原因、责任人和恢复条件"));
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
          const preflight = supplementChecks(frame.root, spec, lineList(bytes), frame.reads, active);
          if (!preflight.ok) throw new Error("[building-loop/preflight] " + preflight.issues.join("；"));
          if (active.qualityRejected?.length && active.rejectedCandidate === digest(bytes)) {
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
        let checked = reviewChecks(frame, active, spec, grant, args.checks, lines);
        const coverage = coverageSummary(frame, active, spec);
        // Evaluate each configured number even when another claim has already failed.
        const calculations = numericChecks(frame.root, spec, lines, frame.reads);
        const mismatches = new Map(calculations.filter(result => !result.ok).map(result => [result.id, result.issue]));
        checked = checked.map(check => mismatches.has(check.id)
          ? { ...check, status: "unsupported", basis: "脚本复算未通过 " + mismatches.get(check.id) } : check);
        const unsupported = checked.filter(check => check.status !== "supported").map(check => check.id);
        const qualityChecks = active.assessment?.hash === hash ? active.assessment.checks : null;
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
          unsupported, qualityRejected, checks: checked, calculations, coverage: coverageReceipt(coverage),
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
          active.pendingReceipt = { ...receipt, coverage };
          active.phase = receipt.phase === "first-review" ? "first-audit-ready" : "final-audit-ready";
        }
        delete active.assessment;
      } else {
        throw new Error("当前角色和阶段不允许此动作");
      }
      active.seen = {};
      frame.changed = true;
      return { unit: id, phase: active.phase, receipt: active.receipt, unsupported: active.unsupported,
        qualityRejected: active.qualityRejected, parent: active.owner };
    });
  }

  /** 阶段动作统一入口，持久回执成功后再通知父会话。 */
  async function workflow(args, exec) {
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
      return supplementChecks(frame.root, spec, lineList(bytes), frame.reads, assignment[1]);
    }
    const { parent, ...result } = report(args, exec);
    try {
      const notice = "building-loop 已落盘 " + JSON.stringify(result);
      await ctx.subagents.sendMessage(exec.agent, parent, [{ type: "text", text: notice }], { signal: exec.signal });
      return { ...result, notified: true };
    } catch {
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
  ctx.on("agent/pre-step", async (_request, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    return { ...decision, messages: decision.messages.filter(message => message.source?.kind !== "agent-instructions") };
  });
  ctx.on("session/event", (session, event) => {
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
  }, fileAction));

  const qualityFields = Object.fromEntries(Object.entries(QUALITY).map(([key, description]) => [key, { ...string, description }]));
  ctx.tools.register(tool(COVERAGE, "按宿主全文清单逐块核验。inventory 分页取全文，record 绑定连续原文、分类、逐字证据和推导，status 查未核与退回。仅核验/反证角色可用。", ["inventory", "record", "status"], coverageSchema(), cover));
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
    unlisted: { type: "array", description: "仅尚未编号且仍需查证的实际事实；空行、无事实标题和已核内容不填，无遗漏填 []。", items: { type: "object", properties: { line: number, basis: string }, required: ["line", "basis"], additionalProperties: false } },
  }, assess, [...qualityNames, "revise", "sourceRefs", "unverifiedSources", "unlisted", "goalFit"]));
  ctx.tools.register(tool(LEDGER, "总控登记后续计划、临时需求和搁置事项。每轮事实验收后 read 最新账本，读取项目现状，再逐项 review，保留、续做、延期或有依据地完成、覆盖、失效。", ["read", "record", "review"], {
    unit: string, id: string, kind: { type: "string", enum: ["planned", "temporary", "interrupted"] },
    title: string, note: string, originId: string, includeClosed: { type: "boolean" },
    decisions: { type: "array", items: { type: "object", properties: {
      id: string, outcome: { type: "string", enum: ["keep", "resume", "defer", "completed", "covered", "obsolete"] },
      basis: string, evidence: referenceSchema, coveredBy: string,
    }, required: ["id", "outcome", "basis"], additionalProperties: false } },
  }, (args, exec) => change(exec.agent, frame => ledgerAction(frame, args))));
  ctx.tools.register(tool(WORKFLOW, "按状态派发、续用、交付和验收。advance 仅总控。preflight/submit 仅执行方。review 仅核验方，先核全文覆盖、逐条 checks 与质量。audit 仅独立反证方，全文核毕后复核。宿主写回执。", ["status", "advance", "preflight", "submit", "review", "audit", "block"], {
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
  }, workflow));

  ctx.systemPrompt.context({
    name: "building-loop.phase", order: 130, required: true, interpolate: false,
    text({ agent, scope: owner }) {
      try {
        const frame = scope(agent ?? owner);
        const assignment = frame.assignment;
        const units = frame.role === "coordinator" ? viewUnits(frame) : null;
        const current = units?.find(unit => unit.owned && unit.goalStale)
          ?? units?.find(unit => unit.owned && !TERMINAL.has(unit.phase) && unit.phase !== "blocked")
          ?? units?.find(unit => unit.owned && unit.phase === "blocked");
        const closed = units?.length && units.every(unit => TERMINAL.has(unit.phase));
        const phase = assignment?.[1].phase ?? (units ? current?.phase ?? (closed ? "closed" : "dispatch") : "idle");
        const rule = frame.role === "coordinator"
          ? (current?.goalStale ? COORDINATOR["goal-review-ready"] : COORDINATOR[phase] ?? "等待当前阶段交付或核验回执。") + " 总控只读写白名单内的中央文件和回执。"
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
          ...(frame.role === "reviewer" && assignment[1].reconciliation ? { classificationDisagreements: assignment[1].reconciliation } : {}),
          ...(phase === "final-review" && assignment[1].quality ? { executionQuality: assignment[1].quality } : {}),
        } : units;
        return [descriptor, rule, ...(frame.role === "reviewer" ? [REVIEW_FORMAT, EVIDENCE_RULE] : []),
          ...(["reviewer", "auditor"].includes(frame.role) ? [COVERAGE_RULE, COVERAGE_REJECTION_RULE, LITERAL_RULE, EXAMPLE_RULE] : []),
          ...(phase === "supplement" || frame.role === "reviewer" ? [QUALITY_RULE] : []),
          "文件与阶段用 building_loop 和 building_loop_file。" + (frame.role === "reviewer" ? "质量判断用 building_loop_quality。" : ""),
          ...(frame.role === "coordinator" ? ["计划、临时需求和中断事项记入 building_loop_ledger。用户消息已自动登记待判定，结合现状分类处置。",
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
