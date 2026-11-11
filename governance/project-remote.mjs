import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol/remote-info";

const service = "buildingLoopProject";
const file = z.string().min(1).max(500);
const request = z.object({ sessionId: z.string().min(1).max(200).regex(/^[^\x00-\x1f]+$/u) });
const snapshot = z.object({
  enabled: z.boolean(), workspace: z.string(), status: z.enum(["ready", "missing", "invalid", "unavailable"]),
  goalFile: file.optional(), candidateFile: file.optional(), evidencePaths: z.array(file).optional(), message: z.string().optional(),
  canDisable: z.boolean().optional(),
});
const setup = request.extend({
  goalFile: file, goalDescription: z.string().max(8000).optional(), candidateFile: file, evidencePaths: z.array(file).max(32),
});

/** Both carriers validate the same named arguments, with no client-provided working directory. */
function definition(schema, type) {
  const codec = (value, symbol) => ({
    mode: "strict", typeSymbol: `dsh-building-loop#${symbol}`, create: () => value, jsonSchema: z.toJSONSchema(value),
  });
  const input = codec(schema.strict(), type);
  return {
    service, invocation: { kind: "direct" },
    parameters: [{ name: "request", source: "json", codec: input, strictCodec: input }],
    result: codec(snapshot, "ProjectSnapshot"),
  };
}

export const BUILDING_LOOP_PROJECT_REMOTE = createTypertRemoteInfo({
  package: "dsh-building-loop",
  methods: {
    [`${service}/get`]: definition(request, "GetProject"),
    [`${service}/set`]: definition(request.extend({ enabled: z.boolean() }), "SetProject"),
    [`${service}/setup`]: definition(setup, "SetupProject"),
  },
}, z);
