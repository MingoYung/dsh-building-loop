import os from "node:os";
import path from "node:path";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { BUILDING_LOOP_PROJECT_REMOTE } from "./project-remote.cjs";
import { changeProjectSetting, projectSnapshot, setupProjectSetting } from "./project-settings.mjs";
import { workspaceRoot } from "./policy.mjs";

export const name = "building-loop-project-settings";
export const inject = ["agents", "agentPresets", "sessionQuery", "typert"];
const service = "buildingLoopProject";
const methods = ["get", "set", "setup"];
const initializers = [];
const presets = new Set(["building-loop", "paidan"]);
const badRequest = message => new RemoteError("gateway/bad-request", message, {});

/** Resolve project scope from the current DSH session. The browser cannot supply a directory or act on a child. */
class ProjectSettingsService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, service);
    for (const initialize of initializers) initialize.call(this);
    this.hostHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
  }

  async session(sessionId) {
    if (this.ctx.invocation?.peer?.principal?.kind !== "owner") {
      throw new RemoteError("gateway/forbidden", "只有 DSH 所有者可管理项目授权", {});
    }
    const live = () => this.ctx.agents.get(sessionId);
    let agent = live(), header, preset;
    if (!agent) {
      let observed;
      try {
        observed = await this.ctx.sessionQuery.observeSession(sessionId);
        header = observed.header;
        preset = observed.projections?.values?.agentPreset;
      } catch {
        throw badRequest("会话尚未就绪，请重新打开设置");
      } finally { observed?.[Symbol.dispose](); }
      agent = live();
    }
    if (agent) {
      header = agent.session.header;
      preset = this.ctx.agentPresets.presetForSession(agent.session);
    }
    if (header?.parentSession || !presets.has(typeof preset === "string" ? preset : preset?.id)) {
      throw badRequest("仅 Building-loop 主会话可设置项目协作");
    }
    try { return { root: workspaceRoot(header.cwd, this.hostHome), agent }; }
    catch { return { root: null, agent }; }
  }

  async get({ sessionId }) {
    const { root } = await this.session(sessionId);
    return root ? projectSnapshot(this.hostHome, root, sessionId) : {
      enabled: false, workspace: "", status: "unavailable", message: "请先为当前会话选择本地项目目录",
    };
  }

  async update(sessionId, operation) {
    const { root, agent } = await this.session(sessionId);
    if (!root) throw badRequest("请先为当前会话选择本地项目目录");
    if (agent && agent.status !== "idle") throw badRequest("请等待当前会话停止运行，再调整项目协作");
    try { return operation(root); }
    catch (error) { throw badRequest(error.message); }
  }

  async set({ sessionId, enabled }) {
    return this.update(sessionId, root => changeProjectSetting(this.hostHome, root, sessionId, enabled));
  }

  async setup({ sessionId, ...selection }) {
    return this.update(sessionId, root => setupProjectSetting(this.hostHome, root, sessionId, selection));
  }
}

// Bind each endpoint to its requested session and reuse Gateway's native resource and codec checks.
for (const method of methods) {
  Remote({ name: method, resources: { session: request => request.sessionId } })(
    ProjectSettingsService.prototype[method],
    { kind: "method", name: method, private: false, static: false, addInitializer: initialize => initializers.push(initialize) },
  );
}

export function apply(ctx) {
  ctx.typert.register({
    package: BUILDING_LOOP_PROJECT_REMOTE.package,
    face: "host", schemas: [], invocations: BUILDING_LOOP_PROJECT_REMOTE.descriptors,
    model: {
      services: [{ key: service, exportName: "BuildingLoopProjectService", tags: [], types: [],
        members: methods.map(name => ({ kind: "method", name, signature: `${name}(request: ProjectRequest): Promise<ProjectSnapshot>` })) }],
      events: [], objects: [],
    },
  });
  new ProjectSettingsService(ctx);
}
