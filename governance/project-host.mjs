import os from "node:os";
import path from "node:path";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { BUILDING_LOOP_PROJECT_REMOTE } from "./project-remote.cjs";
import { conversationStartSnapshot, decideConversationStart, latestConversationUser, startedConversationProject } from "./conversation-start.mjs";
import { existingConversationProject, initializeConversationProject } from "./conversation-project.mjs";

export const name = "building-loop-conversation-start";
export const inject = ["agents", "agentPresets", "sessionQuery", "sessionController", "typert"];
const service = "buildingLoopProject";
const methods = ["proposal", "decide"];
const initializers = [];
const presets = new Set(["building-loop", "paidan"]);
const badRequest = message => new RemoteError("gateway/bad-request", message, {});
const NOTICE = "building-loop-start";

/** Detect a wake already accepted by the native inbox or log, including after restart. */
function needsWake(session, started) {
  if (!started?.wake) return false;
  const id = started.proposal.id;
  return !session.wakes.has(id) && !session.agent?.inbox.nextTurn.some(message =>
    message.source.kind === NOTICE && message.source.proposalId === id);
}

/** Read the actual DSH conversation and authorize only its owner. */
class ConversationStartService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, service);
    for (const initialize of initializers) initialize.call(this);
    this.hostHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
  }

  async session(sessionId) {
    if (this.ctx.invocation?.peer?.principal?.kind !== "owner") {
      throw new RemoteError("gateway/forbidden", "只有 DSH 所有者可处理会话开工提议", {});
    }
    let observed;
    try { observed = await this.ctx.sessionQuery.observeSession(sessionId); }
    catch { throw badRequest("会话尚未就绪，请重新打开会话"); }
    try {
      const agent = this.ctx.agents.get(sessionId);
      const header = agent?.session.header ?? observed.header;
      const preset = agent ? this.ctx.agentPresets.presetForSession(agent.session) : observed.projections?.values?.agentPreset;
      if (header?.parentSession || header?.origin === "subagent" || !presets.has(typeof preset === "string" ? preset : preset?.id)) {
        throw badRequest("仅 Building-loop 主会话可处理开工提议");
      }
      const events = observed.events;
      const wakes = new Set(events.filter(event => event.type === "user/message" && event.data.source.kind === NOTICE)
        .map(event => event.data.source.proposalId));
      return { agent, header, cursor: observed.cursor, current: latestConversationUser(events, observed.inheritedEventCount), wakes };
    } finally { observed[Symbol.dispose](); }
  }

  async proposal({ sessionId }) {
    const session = await this.session(sessionId);
    try {
      const snapshot = conversationStartSnapshot(this.hostHome, sessionId, session.current);
      if (snapshot.status === "started" && needsWake(session, startedConversationProject(this.hostHome, sessionId))) {
        return { ...snapshot, status: "proposed", message: "项目已经建档。再次选择开始可继续执行。" };
      }
      return snapshot;
    }
    catch (error) { throw badRequest(error.message); }
  }

  async decide({ sessionId, proposalId, decision }) {
    let session = await this.session(sessionId);
    if (decision === "start" && !session.agent) {
      const pending = conversationStartSnapshot(this.hostHome, sessionId, session.current);
      if (pending.proposal?.id === proposalId && (pending.status === "proposed" ||
        pending.status === "started" && needsWake(session, startedConversationProject(this.hostHome, sessionId)))) {
        // Let DSH restore the normal preset and native inbox for a closed conversation.
        const resolved = await this.ctx.sessionController.agents.resolveAgent(sessionId);
        if (resolved.error) throw badRequest("会话恢复失败，请重新打开后确认");
        session = await this.session(sessionId);
      }
    }
    try {
      if (session.agent && session.agent.session.seq !== session.cursor + 1) throw new Error("当前会话已有新消息，请按最新提议确认");
      const result = decideConversationStart(this.hostHome, sessionId, session.current, proposalId, decision,
        task => initializeConversationProject(this.hostHome, sessionId, session.header.cwd, task), {
          inspect: task => existingConversationProject(this.hostHome, sessionId, session.header.cwd, task),
        });
      if (result.status === "started" && needsWake(session, startedConversationProject(this.hostHome, sessionId))) {
        if (!session.agent) throw new Error("项目已经建档，重新打开会话后可以继续");
        // A host notice wakes the same session without manufacturing a second user request.
        session.agent.followup({ id: "building-loop-start-" + proposalId, role: "user", source: {
          kind: NOTICE, proposalId, form: "notice", summary: "用户已确认开工",
        }, content: [{ type: "text", text: "Building-loop 宿主确认已建档。按当前已确认的项目总纲和阶段开始执行。" }] });
      }
      return result;
    } catch (error) { throw badRequest(error.message); }
  }
}

// These owner operations remain scoped to the exact requested native session.
for (const method of methods) {
  Remote({ name: method, resources: { session: request => request.sessionId } })(
    ConversationStartService.prototype[method],
    { kind: "method", name: method, private: false, static: false, addInitializer: initialize => initializers.push(initialize) },
  );
}

export function apply(ctx) {
  ctx.typert.register({
    package: BUILDING_LOOP_PROJECT_REMOTE.package,
    face: "host", schemas: [], invocations: BUILDING_LOOP_PROJECT_REMOTE.descriptors,
    model: {
      services: [{ key: service, exportName: "BuildingLoopProjectService", tags: [], types: [],
        members: methods.map(name => ({ kind: "method", name, signature: `${name}(request: ConversationRequest): Promise<ConversationSnapshot>` })) }],
      events: [], objects: [],
    },
  });
  new ConversationStartService(ctx);
}
