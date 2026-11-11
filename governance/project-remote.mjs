import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol/remote-info";

const service = "buildingLoopProject";
const id = z.string().regex(/^[a-f0-9]{64}$/u);
const request = z.object({ sessionId: z.string().min(1).max(200).regex(/^[^\x00-\x1f]+$/u) });
const proposal = z.object({
  id, userSeq: z.number().int().nonnegative(), goal: z.string(), deliverable: z.string(), scope: z.string(),
});
const snapshot = z.object({
  status: z.enum(["idle", "proposed", "discussing", "started"]), proposal: proposal.optional(), message: z.string().optional(),
});

/** Both carriers validate the same session-scoped input. Only the user may decide a proposal. */
function definition(schema, type) {
  const codec = (value, symbol) => ({
    mode: "strict", typeSymbol: `dsh-building-loop#${symbol}`, create: () => value, jsonSchema: z.toJSONSchema(value),
  });
  const input = codec(schema.strict(), type);
  return {
    service, invocation: { kind: "direct" },
    parameters: [{ name: "request", source: "json", codec: input, strictCodec: input }],
    result: codec(snapshot, "ConversationSnapshot"),
  };
}

export const BUILDING_LOOP_PROJECT_REMOTE = createTypertRemoteInfo({
  package: "dsh-building-loop",
  methods: {
    [`${service}/proposal`]: definition(request, "ConversationRequest"),
    [`${service}/decide`]: definition(request.extend({ proposalId: id, decision: z.enum(["start", "discuss"]) }), "ConversationDecision"),
  },
}, z);
