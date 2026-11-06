// turn-resume —— building-loop自有插件。
//
// 解决什么：模型输出触到 token 上限时，agent loop 会以 `max-tokens` 结束本回合。
// 而 `goal-round-driver` 是故意在这一刻解除自动续轮的（见其 lib/index.js 里
// `case "turn/end": if (event.data.reason.kind === "max-tokens") { disarm(state); return; }`）。
// 两件事叠在一起，结果就是一段没写完的活停在半路，要人手打一句「继续」。
// 本插件补的就是这一句，并且给自己划死边界（见下）。
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
//   4. 只管根代理，不管子代理。子代理被截断由它的父代理读错误后决定怎么办，
//      不在这里替它做决定（缩小爆炸半径）。
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

/** 取 agent 句柄要走 agents 服务；不依赖别的服务。 */
export const inject = ["agents"];

const DEFAULT_MAX_CONSECUTIVE = 3;

const DEFAULT_TEXT =
  "上一回合的输出被 token 上限截断了。请从断点继续，不要重复已经写过的内容；" +
  "如果其实已经写完，直接说明完成，不要补写。";

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

  ctx.effect(function* () {
    ctx.on("session/event", (session, event) => {
      if (event.type !== "turn/end") return;

      // 只认这个会话自己的 agent：其它树、子代理的树都会冒泡到这里。
      const agent = ctx.agents.get(session.id);
      if (agent === void 0 || agent.session !== session) return;
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
