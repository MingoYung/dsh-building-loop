// turn-resume —— building-loop自有插件。
//
// 解决什么：模型输出触到 token 上限时，agent loop 会以 `max-tokens` 结束本回合。
// 而 `goal-round-driver` 是故意在这一刻解除自动续轮的（见其 lib/index.js 里
// `case "turn/end": if (event.data.reason.kind === "max-tokens") { disarm(state); return; }`）。
// 两件事叠在一起，结果就是一段没写完的活停在半路，要人手打一句「继续」。
// 本插件补这句续写。DeepSeek 坏参数则走宿主的同一步请求重试，
// 不开启新回合，也不改写未执行的参数。
//
// 四条安全边界：
//   1. 注入消息的 source 必须显式写成 { kind: "plugin", plugin: NAME }。
//      省略 source 会被 DSH 解析成 { kind: "user" }，等于让插件冒充人类指令、
//      拿到人类级权限（依据：dsh-tool-goal 的 hasDirectHumanInput 只认
//      source.kind === "user"，其注释明写「non-human producers must supply
//      their own source rather than inheriting this authority」）。
//   2. 连续续轮有上限。触顶就停手并记一条日志，绝不让两个空转的回合互相喂。
//   3. 任何非 `max-tokens` 的回合结束都清零计数 —— 人来过、活干完了、报错了，
//      都算「局面变了」，不继承上一段的计数。
//   4. 截断续轮只管根代理；已确定未执行的坏参数才在同一步重试，
//      适用于此预设的根和子会话。
// 动态导入而不是静态 import：静态导入一旦解析失败，本模块根本不会求值，
// apply() 也就永远不被调用，整行插件会以「import 失败」告终。动态导入 +
// 兜底实现让这条链断在哪一环都还能跑。
let importedCreateUserMessage;
try {
  ({ createUserMessage: importedCreateUserMessage } = await import("@deepseek-ai/dsh-llm"));
} catch {
  importedCreateUserMessage = void 0;
}

export const name = "turn-resume";

/** 用原生 agent 句柄确定会话，在重试时刷新该会话的运行时提示。 */
export const inject = ["agents", "systemPrompt"];

const DEFAULT_MAX_CONSECUTIVE = 3;

const DEFAULT_TEXT =
  "上一回合的输出被 token 上限截断了。请从断点继续，不要重复已经写过的内容；" +
  "如果其实已经写完，直接说明完成，不要补写。";
const MALFORMED_TOOL_INPUT = "DeepSeek Messages stream: tool input is invalid JSON";
const MALFORMED_RETRIES_PER_TURN = 2;
const RETRY_TEXT = "该步原响应的工具参数不是有效 JSON，本步的调用没有执行。仅在这次恢复请求中依据已落盘结果" +
  "重新生成一个当前需要的调用，参数只填契约需要的字段，引号和换行按 JSON 转义。后续已有工具结果时，继续当前阶段。";

// 依赖注入失败时的最小等价实现：DSH 的 createUserMessage 就是
// { ...input, role: "user", id: <uuid> }。走到这里说明解析链没接上，
// 降级也要能跑，而不是整个模式挂掉。
const makeUserMessage =
  typeof importedCreateUserMessage === "function"
    ? importedCreateUserMessage
    : (input) => ({ ...input, role: "user", id: globalThis.crypto.randomUUID() });

export function apply(ctx, config = {}) {
  const maxConsecutive =
    Number.isInteger(config.maxConsecutive) && config.maxConsecutive > 0
      ? config.maxConsecutive
      : DEFAULT_MAX_CONSECUTIVE;
  const text = typeof config.text === "string" && config.text.trim() !== "" ? config.text : DEFAULT_TEXT;

  /** @type {Map<string, number>} 会话 id → 连续被截断的次数 */
  const streaks = new Map();
  /** 每个原生会话的当前回合预算。一次失败最多重试一次，同回合合计两次。 */
  const malformed = new WeakMap();

  ctx.systemPrompt.context({
    name: "building-loop.tool-input-retry", order: 131, interpolate: false,
    text({ agent }) {
      const budget = malformed.get(agent);
      // DSH retains delivered runtime context in history. Pin this instruction
      // to the failed position so later steps do not treat it as a new failure.
      return budget?.hintStep ? `坏参数恢复 · 回合 ${budget.turn} 第 ${budget.hintStep} 步。${RETRY_TEXT}` : "";
    },
  });

  ctx.effect(function* () {
    ctx.on("agent/request-error", ({ agent, turn, step, provider, failure, signal }, next) => {
      if (provider !== "deepseek-official" || failure?.code !== "MALFORMED_RESPONSE" ||
          failure.message !== MALFORMED_TOOL_INPUT || !agent || ctx.agents.get(agent.id) !== agent) return next();
      if (signal.aborted || !Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(step) || step < 1) return;

      // DSH has settled a discarded assistant/attempt here and has yet to enter
      // tools.execute. The native retry re-generates the same step; a failure
      // thrown by tool execution never comes through this hook.
      let budget = malformed.get(agent);
      if (budget?.turn !== turn) {
        budget = { turn, steps: new Set(), hintStep: null };
        malformed.set(agent, budget);
      }
      if (budget.steps.has(step) || budget.steps.size >= MALFORMED_RETRIES_PER_TURN) return;
      budget.steps.add(step);
      budget.hintStep = step;
      ctx.logger.info(`turn-resume: retrying malformed tool input for ${agent.id}, turn ${turn}, step ${step}`);
      return { kind: "retry" };
    });

    ctx.on("session/event", (session, event) => {
      if (!["assistant/message", "step/end", "turn/end"].includes(event.type)) return;

      // 只认这个会话自己的 agent：其它树、子代理的树都会冒泡到这里。
      const agent = ctx.agents.get(session.id);
      if (agent === void 0 || agent.session !== session) return;
      if (event.type !== "turn/end") {
        const budget = malformed.get(agent);
        if (budget?.turn === event.data?.turn && budget.hintStep === event.data.step) budget.hintStep = null;
        return;
      }
      malformed.delete(agent);
      if (!ctx.agents.roots().includes(agent)) return;

      if (event.data?.reason?.kind !== "max-tokens") {
        streaks.delete(session.id);
        return;
      }

      const count = (streaks.get(session.id) ?? 0) + 1;
      streaks.set(session.id, count);
      if (count > maxConsecutive) {
        ctx.logger.warn(
          `turn-resume: session ${session.id} was truncated ${count} times in a row; not resuming again`,
        );
        return;
      }

      // turn/end 落盘时本回合的驱动未必已经回到 idle。等它静下来再排下一次，
      // 免得和正在收尾的那一步抢队列。
      Promise.resolve(agent.whenIdle()).then(
        () => {
          if (ctx.agents.get(agent.id) !== agent) return;
          try {
            agent.followup(
              makeUserMessage({
                content: [{ type: "text", text }],
                source: { kind: "plugin", plugin: name },
              }),
            );
          } catch (error) {
            ctx.logger.warn(`turn-resume: could not resume session ${session.id}: ${String(error)}`);
          }
        },
        () => {},
      );
    });
  }, "turn-resume resume-on-truncation");
}
