import assert from "node:assert/strict";
import { test } from "node:test";
import { collectArchitectureClaimWitnesses, inspectArchitectureClaimWitness } from "../governance/architecture-claim-witness.mjs";
import { digest } from "../governance/policy.mjs";
import { fixture } from "./helpers.mjs";

const response = { code: "invalid-request" };
const business = { mode: "business", trigger: { kind: "input-type", argument: 0, type: "object", test: "not" }, response };
const fallback = { mode: "fallback", trigger: { kind: "exception", name: "Exception" }, response };
const forwarding = { mode: "forwarding", trigger: { kind: "delegate", file: "engine.py" } };
const engine = [
  "def response(code):",
  '    return {"error": code, "status": "error"}',
  "",
  "def compute(request):",
  "    if not isinstance(request, dict):",
  '        return response("invalid-request")',
  "    return request",
].join("\n") + "\n";
const transport = [
  "import json",
  "from engine import compute as invoke",
  'FALLBACK = {"error": "invalid-request", "status": "error"}',
  "",
  "def entry(request):",
  "    try:",
  "        result = invoke(request)",
  "    except Exception:",
  "        result = dict(FALLBACK)",
  "    print(json.dumps(result))",
].join("\n") + "\n";

function rows(sources, claim) {
  return collectArchitectureClaimWitnesses(Object.entries(sources).map(([file, source]) => ({ file, source })), claim)
    ?.map(({ sha256, ...row }) => row);
}

test("one response code can have distinct business, exception and forwarded locations", () => {
  const source = { "cli.py": transport, "engine.py": engine };
  assert.deepEqual(rows(source, business), [{
    file: "engine.py", symbol: "compute", mode: "business", line: 6, end: 6, conditionLine: 5, code: "invalid-request",
  }]);
  assert.deepEqual(rows(source, fallback), [{
    file: "cli.py", symbol: "entry", mode: "fallback", line: 9, end: 9, conditionLine: 8, code: "invalid-request", outputLine: 10,
  }]);
  assert.deepEqual(rows(source, forwarding), [{
    file: "cli.py", symbol: "entry", mode: "forwarding", line: 10, end: 10, conditionLine: 7, callLine: 7,
    target: { file: "engine.py", symbol: "compute" },
  }]);
});

test("witnesses come from current granted bytes and preserve all ambiguous alternatives", () => fixture(async (root, write) => {
  write("engine.py", engine);
  write("cli.py", transport);
  write("other.py", engine);
  const pair = [{ path: "engine.py", sha256: digest(engine) }, { path: "cli.py", sha256: digest(transport) }];
  const inspect = (claim, artifacts = pair, reads = pair.map(item => item.path)) =>
    inspectArchitectureClaimWitness({ root, reads }, artifacts, claim);
  assert.equal(inspect({ ...business, owner: { file: "engine.py" } }).status, "matched");
  const wrong = inspect({ ...business, owner: { file: "cli.py" } });
  assert.equal(wrong.status, "mismatch");
  assert.equal(wrong.actual[0].sha256, pair[0].sha256);
  assert.equal(inspect({ ...business, owner: { file: "engine.py", symbol: "entry" } }).status, "mismatch");
  assert.equal(inspect({ ...business, owner: { file: "engine.py" }, response: { code: "other" } }).status, "mismatch");
  assert.deepEqual(inspect({ ...business, owner: { file: "engine.py" } }, pair, ["engine.py"]), { status: "unresolved", actual: [] });
  const all = [...pair, { path: "other.py", sha256: digest(engine) }];
  const ambiguity = inspect({ ...business, owner: { file: "engine.py" } }, all, all.map(item => item.path));
  assert.equal(ambiguity.status, "unresolved");
  assert.deepEqual(ambiguity.actual.map(item => item.file), ["engine.py", "other.py"]);
  write("cli.py", transport + "# later edit\n");
  assert.deepEqual(inspect({ ...business, owner: { file: "engine.py" } }), { status: "unresolved", actual: [] });
}));

test("field predicates distinguish presence, unrelated codes and compound or shadowed conditions", () => {
  const source = [
    "class Rejected(ValueError):",
    "    pass",
    "",
    "def confirm(req):",
    '    if "label" not in req:',
    '        raise Rejected("missing-label")',
    '    if "extra" in req:',
    '        return {"error":"unknown-field"}',
  ].join("\n");
  const field = { mode: "business", trigger: { kind: "field-presence", argument: 0, field: "label", test: "missing" } };
  assert.deepEqual(rows({ "validate.py": source }, field)?.map(item => [item.line, item.code]), [[6, "missing-label"]]);
  assert.deepEqual(rows({ "validate.py": source }, { ...field, trigger: { ...field.trigger, test: "present" } }), []);
  assert.deepEqual(rows({ "validate.py": source }, { ...field, trigger: { ...field.trigger, field: "other" } }), []);

  const inline = engine.replace('dict):\n        return response', 'dict): return response');
  const condition = engine.replace('dict):', 'dict) or not request:');
  const rebound = engine.replace("    if not", "    request = None\n    if not");
  const shadowed = "isinstance = lambda obj, kind: True\n" + engine;
  const wrongFactory = engine.replace('{"error": code, "status": "error"}', '{"status": "error", "message": code}');
  for (const unproven of [inline, condition, rebound, shadowed, wrongFactory]) {
    assert.deepEqual(rows({ "engine.py": unproven }, business), []);
  }
  assert.equal(rows({ "engine.py": engine, "unparsed.py": "def bad(" }, business), undefined);
  assert.equal(rows({ "engine.py": "from external import *\n" + engine }, business), undefined);
});

test("transport evidence requires an unmodified delegation and emitted fallback value", () => {
  const source = { "cli.py": transport, "engine.py": engine };
  const noOutput = transport.replace("print(json.dumps(result))", "return None");
  const modified = transport.replace("    print", '    result["error"] = "changed"\n    print');
  const mutatedConstant = transport.replace("def entry(request):", 'FALLBACK.update({"error":"replacement"})\n\ndef entry(request):');
  const rebound = transport.replace("    try:", "    invoke = lambda value: value\n    try:");
  const inline = transport.replace("    except Exception:\n        result", "    except Exception: result");
  const customEncoder = transport.replace("json.dumps(result)", "json.dumps(result, cls=CustomEncoder)");
  const captured = transport.replace("    print(json.dumps(result))",
    '    def change():\n        result["error"] = "changed"\n    change()\n    print(json.dumps(result))');
  for (const rejected of [noOutput, modified, mutatedConstant, inline]) {
    assert.deepEqual(rows({ ...source, "cli.py": rejected }, fallback), []);
  }
  for (const rejected of [noOutput, modified, rebound, customEncoder, captured]) {
    assert.deepEqual(rows({ ...source, "cli.py": rejected }, forwarding), []);
  }
  const alias = "import engine as compute_module\ndef passthrough(req):\n    return compute_module.compute(req)\n";
  assert.equal(rows({ ...source, "cli.py": alias }, forwarding)?.[0].callLine, 3);
  const inlineBranch = "from engine import compute\ndef entry(req):\n    if req is None: return compute(req)\n";
  assert.deepEqual(rows({ ...source, "cli.py": inlineBranch }, forwarding), []);
  assert.deepEqual(rows({ ...source, "json.py": "def dumps(value):\n    return 'changed'\n" }, forwarding), []);
});
