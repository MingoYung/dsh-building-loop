import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUTHORITY, MANAGED, PHASES, authority, digest, includes, keyOf, readBytes, relativeName, replaceBytes,
  replaceWithHistory, text, workspaceRoot,
} from "./policy.mjs";

export const name = "building-loop-governance";
export const inject = ["agents", "subagents", "systemPrompt", "tools"];
const WORKFLOW = "building_loop";
const FILE = "building_loop_file";
const EMPTY = { read: [], write: [] };

const BEGIN = {
  dispatch: "intake",
  "review-ready": "first-review",
  "supplement-ready": "supplement",
  "final-review-ready": "final-review",
};

const RULES = {
  intake: "接单。按指定二级索引找到候选。第一轮只做任务单允许的工作，保留送审原稿。读回候选后用 building_loop 的 submit 交接，证据不足则用 block。宿主通知总控。",
  "first-review": "首次验收。独立打开候选和每条引用的原文，核数字、行号和适用范围。无出处或原文不支持就填 unsupported，不代为补查。",
  supplement: "补查。读取退回回执和原始材料，按证据替换错误数字、口径或结论，不能只在错误断言旁加备注。保留断言编号，出处路径写在同一行。写工具自动备份并记日志。读回候选后用 submit。",
  "final-review": "终审。回到修订稿和原始证据，重新核对所有断言与改动。只有所有要求都支持才关单。",
};
const REVIEW_FORMAT = '用 building_loop 的 review 提交每项结果，宿主写回执和通知总控。受支持项填写 id、status="supported"、file=原文项目相对路径、start/end=实际读过的原文首末行、basis=支持理由。无来源或不支持的项填 id、status="unsupported"、basis=原因。候选行由宿主按编号和出处查找。';
const COORDINATOR = {
  dispatch: "派单。确认任务、单元与范围，advance 签发接单。",
  "review-ready": "接单方已交付。advance 发起首次独立核验。",
  "supplement-ready": "核验退回。依据回执用 advance 发起补查，默认续用执行会话。",
  "final-review-ready": "补查已交付。advance 发起终审。",
  blocked: "先确认回执的解阻条件，再用 advance 恢复原阶段。",
  closed: "单元已验收关单。核对通过回执和执行身份，更新授权台账并汇报。",
};

const string = { type: "string" };
const number = { type: "integer" };
const lineList = value => text(value).split(/\r\n|\n|\r/);
const isReview = phase => phase.endsWith("review");
const buffer = value => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");

function tool(name, description, action, properties, execute) {
  return {
    name, description,
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: action }, ...properties },
      required: ["action"],
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

function requireText(value, label, limit = 1200) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("需要" + label);
  return value.trim();
}

function unitOf(frame, id) {
  if (!Object.hasOwn(frame.policy.units, id)) throw new Error("该工作单元未获授权");
  return frame.policy.units[id];
}

function viewUnits(frame) {
  return Object.keys(frame.policy.units).map(id => {
    const unit = Object.hasOwn(frame.state.units, id) ? frame.state.units[id] : undefined;
    if (!unit) return { unit: id, phase: "dispatch", next: "intake" };
    const { phase, executor, reviewer, receipt, unsupported, blocked } = unit;
    return {
      unit: id, phase, executor, reviewer, receipt, unsupported, blocked,
      next: phase === "blocked" ? unit.resumePhase : BEGIN[phase],
      owned: unit.owner === frame.agent.id,
    };
  });
}

export function apply(ctx, config = {}) {
  const presetId = config.presetId ?? "building-loop";
  const hostHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
  const stateHome = path.join(hostHome, "building-loop-state");
  fs.mkdirSync(stateHome, { recursive: true });

  function scope(agent) {
    if (!agent || ctx.agents.get(agent.id) !== agent) throw new Error("只接受当前 DSH 会话的调用");
    const root = workspaceRoot(agent.session.header.cwd, hostHome);
    const policy = authority(root);
    const file = digest(keyOf(root)) + ".json";
    const old = readBytes(stateHome, file);
    let state = old ? JSON.parse(text(old)) : { spec: "building-loop-state/1", policy: policy.hash, units: {}, markers: {} };
    if (state.spec !== "building-loop-state/1") throw new Error("工作台账版本无效");
    if (state.policy !== policy.hash) {
      if (Object.values(state.units).some(unit => unit.phase !== "closed")) throw new Error("运行期间授权清单发生变化，需项目维护者核对");
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
    const role = child ? !assignment ? "idle" : isReview(assignment[1].phase) ? "reviewer" : "executor" : "coordinator";
    const grant = assignment ? unitOf({ policy }, assignment[0]).phases[assignment[1].phase] : child ? EMPTY : policy.coordinator;
    const reads = role === "idle" ? [] : [...new Set([...grant.read, ...policy.instructions])];
    return { agent, root, policy, file, old, state, role, assignment, reads, writes: grant.write };
  }

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
      if (frame.changed) replaceBytes(stateHome, frame.file, buffer(frame.state), frame.old);
      return result;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  function tag(frame) {
    if (frame.assignment) {
      const [id, unit] = frame.assignment;
      return unit.owner + "/" + id + "/" + unit.serial + "/" + unit.phase;
    }
    return frame.agent.id + "/coordinator/" + Object.values(frame.state.units)
      .map(unit => unit.serial + "-" + unit.phase).join("_");
  }

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
      return { path: file, totalLines: lines.length, sha256: digest(bytes),
        lines: lines.slice(start - 1, start - 1 + count).map((line, index) => [start + index, line]) };
    });
  }

  function prepare(frame, id) {
    if (frame.role !== "coordinator") throw new Error("只有总控可以推进阶段");
    const spec = unitOf(frame, id);
    const prior = Object.hasOwn(frame.state.units, id) ? frame.state.units[id] : null;
    if (prior && prior.owner !== frame.agent.id) throw new Error("此工作单元由其他总控持有");
    if (Object.entries(frame.state.units).some(([key, unit]) => key !== id && unit.phase !== "closed")) {
      throw new Error("当前工作区另有未结单的单元");
    }
    const phase = prior?.phase === "blocked" ? prior.resumePhase : BEGIN[prior?.phase ?? "dispatch"];
    if (!phase) throw new Error("当前阶段尚未交付或已经关单");
    const role = isReview(phase) ? "reviewer" : "executor";
    const reusable = prior?.phase === "blocked" ? prior.actor
      : phase === "supplement" && spec.continuation === "fresh" ? undefined : prior?.[role];
    return { prior, phase, role, reusable, serial: (prior?.serial ?? 0) + 1 };
  }

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
        phase: plan.phase, serial: plan.serial, seen: {},
      };
      delete record.blocked;
      delete record.resumePhase;
      frame.state.units[id] = record;
      frame.changed = true;
      const spec = unitOf(frame, id);
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

  function report(args, exec) {
    return change(exec.agent, frame => {
      if (!frame.assignment) throw new Error("当前会话没有可交付阶段");
      const [id, active] = frame.assignment;
      if (args.unit !== id) throw new Error("当前会话无该单元的权限");
      const spec = unitOf(frame, id);
      if (args.action === "block") {
        active.blocked = requireText(args.note, "阻塞原因、责任人和恢复条件");
        active.resumePhase = active.phase;
        active.phase = "blocked";
      } else if (args.action === "submit" && frame.role === "executor") {
        const bytes = readBytes(frame.root, spec.candidate);
        if (!bytes) throw new Error("候选文件尚未交付");
        const seen = active.seen[keyOf(spec.candidate)];
        if (seen?.hash !== digest(bytes) || !seen.ranges.some(([a, b]) => a === 1 && b >= lineList(bytes).length)) {
          throw new Error("请先完整读回当前候选文件");
        }
        active.phase = active.phase === "intake" ? "review-ready" : "final-review-ready";
      } else if (args.action === "review" && frame.role === "reviewer") {
        const grant = spec.phases[active.phase];
        const checked = reviewChecks(frame, active, spec, grant, args.checks);
        const unsupported = checked.filter(check => check.status !== "supported").map(check => check.id);
        const decision = unsupported.length ? "reject" : "accept";
        const receipt = { unit: id, phase: active.phase, reviewer: exec.agent.id, decision, unsupported, checks: checked };
        replaceWithHistory(frame.root, grant.receipt, text(buffer(receipt)), "独立核验 " + decision,
          tag(frame), frame.state.markers);
        active.receipt = grant.receipt;
        active.unsupported = unsupported;
        active.phase = decision === "accept" ? "closed" : "supplement-ready";
      } else {
        throw new Error("当前角色和阶段不允许此动作");
      }
      active.seen = {};
      frame.changed = true;
      return { unit: id, phase: active.phase, receipt: active.receipt, unsupported: active.unsupported, parent: active.owner };
    });
  }

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
    if (exec.name === WORKFLOW || exec.name === FILE) return undefined;
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

  ctx.tools.register(tool(FILE, "按当前角色的准确路径白名单列出、读取、字面搜索或原子写入 UTF-8 文件。写入自动维护一份改前备份和逐文件日志。history 取授权文件的最近更新。", ["list", "read", "search", "write", "history"], {
    path: string, query: string, content: string, note: string, start: number, count: number,
  }, fileAction));

  ctx.tools.register(tool(WORKFLOW, "查询流程，按状态派发、续用、交付或验收。advance 仅总控。submit 仅执行方。review 仅核验方，提交逐条 checks，回执由宿主生成。", ["status", "advance", "submit", "review", "block"], {
    unit: string, note: string,
    checks: { type: "array", items: {
      type: "object", properties: {
        id: string, status: { type: "string", enum: ["supported", "unsupported"] },
        file: { ...string, description: "支持项必填。实际读取的原文项目相对路径" },
        start: { ...number, description: "支持项必填。原文起始行，1 起计" },
        end: { ...number, description: "支持项必填。原文结束行，1 起计" },
        basis: { ...string, description: "为何支持或为何不足" },
      }, required: ["id", "status", "basis"], additionalProperties: false,
    } },
  }, workflow));

  ctx.systemPrompt.context({
    name: "building-loop.phase", order: 130, required: true, interpolate: false,
    text({ agent, scope: owner }) {
      try {
        const frame = scope(agent ?? owner);
        const assignment = frame.assignment;
        const units = frame.role === "coordinator" ? viewUnits(frame) : null;
        const current = units?.find(unit => unit.owned && unit.phase !== "closed");
        const closed = units?.length && units.every(unit => unit.phase === "closed");
        const phase = assignment?.[1].phase ?? (units ? current?.phase ?? (closed ? "closed" : "dispatch") : "idle");
        const rule = frame.role === "coordinator"
          ? (COORDINATOR[phase] ?? "等待当前阶段交付或核验回执。") + " 总控只读写白名单内的中央文件和回执。"
          : RULES[phase] ?? "本子会话当前无工作授权，等待总控。";
        const descriptor = "building-loop role=" + frame.role + " phase=" + phase;
        if (frame.role === "idle") return descriptor + "\n" + rule;
        const shared = frame.policy.instructions.map(file => {
          const bytes = readBytes(frame.root, file, 12 * 1024);
          return bytes ? "项目规则 " + file + "\n" + text(bytes) : "";
        }).filter(Boolean);
        const detail = assignment ? {
          unit: assignment[0], candidate: unitOf(frame, assignment[0]).candidate, receipt: assignment[1].receipt,
          ...(frame.role === "reviewer" ? { claims: unitOf(frame, assignment[0]).claims } : {}),
        } : units;
        return [descriptor, rule, ...(frame.role === "reviewer" ? [REVIEW_FORMAT] : []), "工具仅 building_loop 和 building_loop_file。",
          JSON.stringify({ read: frame.reads, write: frame.writes, detail }), ...shared].join("\n");
      } catch (error) {
        return "building-loop role=blocked phase=authority\n" + error.message + "。请项目维护者核对 " + AUTHORITY + "。";
      }
    },
  });
}

function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function reviewChecks(frame, active, spec, grant, checks) {
  const bytes = readBytes(frame.root, spec.candidate);
  const candidate = bytes && lineList(bytes);
  const seen = active.seen[keyOf(spec.candidate)];
  if (!candidate || seen?.hash !== digest(bytes) || !seen.ranges.some(([a, b]) => a === 1 && b >= candidate.length)) {
    throw new Error("验收前须完整读取当前候选正文");
  }
  if (!Array.isArray(checks) || checks.length > 64) throw new Error("核验须逐条提交检查结果");
  const byId = new Map();
  for (const check of checks) {
    const id = check?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(id) || byId.has(id)
      || spec.claims.length && !spec.claims.includes(id)) throw new Error("核验编号无效、重复或超范围");
    byId.set(id, check);
  }
  const ids = spec.claims.length ? spec.claims : [...byId.keys()];
  if (!ids.length) throw new Error("至少需要一项核验结果");
  return ids.map(id => {
    const check = byId.get(id);
    if (!check) return { id, status: "unsupported", basis: "缺少核验结果" };
    const basis = requireText(check.basis, "核验依据", 600);
    if (check.status !== "supported") return { id, status: "unsupported", basis };
    const fail = reason => ({ id, status: "unsupported", basis: reason + "。" + basis });
    let file;
    try { file = relativeName(check.file); }
    catch { throw new Error(id + " 的支持项需要有效的原文路径"); }
    if (!includes(grant.evidence, file)) return fail("出处不在核验授权范围");
    const evidence = readBytes(frame.root, file);
    const coverage = active.seen[keyOf(file)];
    if (!evidence || coverage?.hash !== digest(evidence) || !Number.isSafeInteger(check.start) || !Number.isSafeInteger(check.end)
      || check.start < 1 || check.end < check.start || !coverage.ranges.some(([a, b]) => a <= check.start && b >= check.end)) {
      throw new Error(id + " 的原文行未读、行号无效或来源已变，请读取后重新核验");
    }
    let line = null;
    if (spec.claims.length) {
      const idPattern = new RegExp("^\\s*(?:[-*]\\s+|\\d+[.)]\\s+)?(?:\\*\\*)?" + id + "(?:\\*\\*)?\\s*[:：]");
      const matching = candidate.map((text, index) => ({ text, line: index + 1 })).filter(row => idPattern.test(row.text));
      if (matching.length !== 1 || !matching[0].text.replaceAll("\\", "/").includes(file)) {
        return fail("候选断言行缺少对应出处");
      }
      line = matching[0].line;
    }
    return { id, status: "supported", file, line, start: check.start, end: check.end, sha256: digest(evidence), basis };
  });
}

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
