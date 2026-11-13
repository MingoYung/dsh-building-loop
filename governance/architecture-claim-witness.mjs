import path from "node:path";
import { digest, includes, keyOf, readBytes, text } from "./policy.mjs";
import { parser } from "./vendor/python-parser.cjs";

const MAX_SOURCES = 64;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_WITNESSES = 128;
const identifier = /^[\p{ID_Start}_][\p{ID_Continue}_]*$/u;
const typeNames = new Map([["dict", "object"], ["list", "array"], ["str", "string"], ["int", "integer"],
  ["float", "number"], ["bool", "boolean"]]);
const builtinErrors = new Set(["BaseException", "Exception", "ValueError", "TypeError", "KeyError", "IndexError", "LookupError",
  "RuntimeError", "ArithmeticError", "OverflowError", "ZeroDivisionError", "OSError", "EOFError", "AssertionError", "UnicodeError",
  "UnicodeDecodeError", "UnicodeEncodeError", "NotImplementedError"]);
const dynamicBindingNames = new Set(["exec", "eval", "globals", "locals", "vars", "__import__"]);
const jsonFormatting = new Set(["ensure_ascii", "separators", "sort_keys", "indent"]);

function parts(node) {
  const result = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.name !== "Comment") result.push(child);
  }
  return result;
}

const statements = node => parts(node).filter(child => child.name !== ":");
const sourceText = (source, node) => node && source.slice(node.from, node.to);

function name(source, node) {
  if (node?.name === "VariableName") return sourceText(source, node);
  const [receiver, dot, member] = parts(node);
  if (node?.name !== "MemberExpression" || dot?.name !== "." || member?.name !== "PropertyName") return;
  const prefix = name(source, receiver);
  return prefix && prefix + "." + sourceText(source, member);
}

function literal(source, node) {
  // Interpret only ordinary unescaped strings. Python string prefixes,
  // interpolation and escaping remain outside the static proof.
  return node?.name === "String" && /^(['"])([^'"\\\r\n]{1,120})\1$/u.exec(sourceText(source, node))?.[2] || undefined;
}

function fields(source, node) {
  if (node?.name !== "DictionaryExpression") return;
  const entries = new Map();
  const items = parts(node).slice(1, -1);
  for (let i = 0; i < items.length; i += 4) {
    const key = literal(source, items[i]);
    if (!key || items[i + 1]?.name !== ":" || !items[i + 2] || entries.has(key) ||
      items[i + 3] && items[i + 3].name !== ",") return;
    entries.set(key, items[i + 2]);
  }
  return entries;
}

function split(nodes, delimiter = ",") {
  const result = [[]];
  for (const node of nodes) {
    if (node.name === delimiter) result.push([]);
    else result.at(-1).push(node);
  }
  return result.filter(item => item.length);
}

function call(source, node) {
  if (node?.name !== "CallExpression") return;
  const [callee, args] = parts(node);
  if (args?.name !== "ArgList") return;
  return { callee: name(source, callee), args: split(parts(args).slice(1, -1)) };
}

function singleArg(invocation, index = 0) {
  const row = invocation?.args[index];
  return row?.length === 1 ? row[0] : undefined;
}

function assignment(source, node) {
  if (node?.name !== "AssignStatement") return;
  const [target, operator, value, extra] = parts(node);
  const key = target?.name === "VariableName" && name(source, target);
  if (key && operator?.name === "AssignOp" && sourceText(source, operator) === "=" && value && !extra) return { key, value };
}

function positionalParams(source, node) {
  const result = [];
  for (const [first] of split(parts(node).slice(1, -1))) {
    if (first.name === "*" || first.name === "**") break;
    if (first.name !== "VariableName") return [];
    result.push(name(source, first));
  }
  return result;
}

function localNodes(root, includeNestedScopes = false) {
  const pending = [...parts(root)].reverse();
  const result = [];
  while (pending.length) {
    const node = pending.pop();
    result.push(node);
    if (includeNestedScopes || !["FunctionDefinition", "ClassDefinition", "LambdaExpression", "DecoratedStatement"].includes(node.name)) {
      pending.push(...parts(node).reverse());
    }
  }
  return result;
}

function moduleImports(source, node) {
  const tokens = parts(node);
  const pivot = tokens.findIndex(child => child.name === "import");
  if (node.name !== "ImportStatement" || pivot < 0) return [];
  const from = pivot ? tokens.slice(1, pivot).map(item => sourceText(source, item)).join("") : "";
  const modules = tokens.slice(pivot + 1).filter(item => item.name !== "(" && item.name !== ")");
  return split(modules).map(group => {
    const aliasAt = group.findIndex(item => item.name === "as");
    const member = (aliasAt < 0 ? group : group.slice(0, aliasAt)).map(item => sourceText(source, item)).join("");
    const alias = aliasAt < 0 ? undefined : sourceText(source, group[aliasAt + 1]);
    return { from, member, binding: alias ?? (from ? member : member.split(".")[0]), prefix: alias ?? member };
  });
}

/** A write anywhere in the scope may shadow a builtin, parameter, helper or
 * import. Refuse unstable bindings before attributing a decision to them. */
function bindings(source, nodes) {
  const names = new Map();
  const add = (key, node) => { if (key) names.set(key, [...(names.get(key) ?? []), node]); };
  for (const node of nodes) {
    if (node.name === "ImportStatement") {
      for (const item of moduleImports(source, node)) add(item.binding, node);
      continue;
    }
    if (["FunctionDefinition", "ClassDefinition", "DecoratedStatement"].includes(node.name)) {
      const declaration = node.name === "DecoratedStatement" ? node.lastChild : node;
      add(sourceText(source, parts(declaration).find(child => child.name === "VariableName")), node);
      continue;
    }
    if (["AssignStatement", "UpdateStatement", "DeleteStatement", "ForStatement", "NamedExpression"].includes(node.name)) {
      const items = parts(node);
      const marker = items.findIndex(child => ["AssignOp", "UpdateOp", "in", ":="].includes(child.name));
      const targets = node.name === "DeleteStatement" ? items.slice(1) : items.slice(0, marker < 0 ? 1 : marker);
      for (const target of targets) {
        const variable = target.name === "VariableName" ? [target] : localNodes(target).filter(child => child.name === "VariableName");
        for (const item of variable) add(name(source, item), node);
      }
    }
    if (node.name === "TryStatement" || node.name === "WithStatement") {
      const items = parts(node);
      items.forEach((child, i) => { if (child.name === "as") add(name(source, items[i + 1]), node); });
    }
  }
  return names;
}

function readModule(source, file, sha256) {
  const tree = parser.parse(source);
  let invalid = false;
  tree.iterate({ enter(node) { if (node.type.isError) invalid = true; } });
  if (invalid) return;
  const top = parts(tree.topNode);
  const nodes = localNodes(tree.topNode);
  // Dynamic namespace inspection can alter bindings that do not appear as
  // assignments in the parsed program. Affected sources require other proof.
  const unpredictable = local => local.some(node => node.name === "CallExpression" && dynamicBindingNames.has(call(source, node)?.callee) ||
    node.name === "ImportStatement" && moduleImports(source, node).some(item => item.member === "*"));
  if (unpredictable(nodes)) return;
  const global = bindings(source, nodes);
  const functions = new Map();
  for (const node of top.filter(child => child.name === "FunctionDefinition")) {
    const [symbol, params, body] = [parts(node).find(child => child.name === "VariableName"),
      parts(node).find(child => child.name === "ParamList"), parts(node).find(child => child.name === "Body")];
    const functionName = name(source, symbol);
    if (!functionName || !body || global.get(functionName)?.length !== 1) continue;
    const nodes = localNodes(body);
    if (unpredictable(nodes)) continue;
    const local = bindings(source, nodes);
    // Include all formal names, including keyword-only and variadic bindings.
    const declared = new Set(split(parts(params).slice(1, -1)).map(group =>
      sourceText(source, group.find(child => child.name === "VariableName"))).filter(Boolean));
    functions.set(functionName, { functionName, params: positionalParams(source, params), declared, body, nodes, local });
  }
  const starts = [0, ...[...source.matchAll(/\n/gu)].map(match => match.index + 1)];
  const lineOf = offset => {
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) {
      const middle = (lo + hi) >> 1;
      if (starts[middle] <= offset) lo = middle;
      else hi = middle;
    }
    return lo + 1;
  };
  return { source, file, sha256, top, global, functions, lineOf,
    imports: top.flatMap(node => moduleImports(source, node).map(item => ({ ...item, node }))) };
}

const locallyBound = (routine, token) => routine.local.has(token) || routine.declared.has(token);
const isBuiltin = (module, routine, token) => !module.global.has(token) && !locallyBound(routine, token);

function rootPredicate(module, routine, node, trigger) {
  const { source } = module;
  const parameter = routine.params[trigger.argument];
  if (!parameter || routine.local.has(parameter)) return false;
  while (node.name === "ParenthesizedExpression" && parts(node).length === 3) node = parts(node)[1];
  if (trigger.kind === "field-presence") {
    const [field, first, second, subject, extra] = parts(node);
    return node.name === "BinaryExpression" && literal(source, field) === trigger.field &&
      (trigger.test === "missing" ? first?.name === "not" && second?.name === "in" && name(source, subject) === parameter && !extra :
        first?.name === "in" && name(source, second) === parameter && !subject);
  }
  if (trigger.kind !== "input-type") return false;
  if (node.name === "BinaryExpression") {
    const [subject, operation, second, third, extra] = parts(node);
    const negate = second?.name === "not";
    if (operation?.name !== "is" || (trigger.test === "not") !== negate || extra || !negate && third) return false;
    const type = negate ? third : second;
    if (type?.name === "None") return trigger.type === "null" && name(source, subject) === parameter;
    const invocation = call(source, subject), builtin = name(source, type);
    return invocation?.callee === "type" && invocation.args.length === 1 && isBuiltin(module, routine, "type") &&
      name(source, singleArg(invocation)) === parameter && typeNames.get(builtin) === trigger.type && isBuiltin(module, routine, builtin);
  }
  const [negate, inner] = parts(node);
  const negated = node.name === "UnaryExpression" && negate?.name === "not";
  if ((trigger.test === "not") !== negated) return false;
  const invocation = call(source, negated ? inner : node);
  const type = name(source, singleArg(invocation, 1));
  // Python isinstance(x, int) also accepts bool. Exact type(x) is int is a
  // separate assertion and is handled above.
  return trigger.type !== "integer" && invocation?.callee === "isinstance" && invocation.args.length === 2 &&
    isBuiltin(module, routine, "isinstance") && name(source, singleArg(invocation)) === parameter &&
    typeNames.get(type) === trigger.type && isBuiltin(module, routine, type);
}

function stableGlobalValue(module, routine, key) {
  if (!key || locallyBound(routine, key)) return;
  const [node, other] = module.global.get(key) ?? [];
  if (other || node?.parent?.name !== "Script") return;
  // Python dictionaries are mutable. Permit references to a literal only
  // through a proven copy or direct output, never through an escaping alias.
  const statements = [...module.top, ...module.top.flatMap(item => localNodes(item)),
    ...[...module.functions.values()].flatMap(routine => routine.nodes)];
  const escaped = statements.some(item => {
    if (item.name !== "VariableName" || name(module.source, item) !== key || item.from === node.firstChild?.from) return false;
    const parent = item.parent;
    if (parent?.name === "ReturnStatement") return true;
    const invoker = parent?.name === "ArgList" && parent.parent;
    const invocation = call(module.source, invoker);
    const symbol = module.functions.get(routine.functionName);
    return invocation?.callee !== "dict" || invocation.args.length !== 1 ||
      singleArg(invocation)?.from !== item.from || !isBuiltin(module, symbol, "dict") ||
      !(symbol.body.from <= item.from && symbol.body.to >= item.to);
  });
  if (!escaped) return assignment(module.source, node)?.value;
}

function rejection(module, routine, value) {
  const { source } = module;
  const codeIn = node => literal(source, fields(source, node)?.get("error"));
  if (value?.name === "DictionaryExpression") return codeIn(value);
  const invocation = call(source, value);
  if (!invocation?.callee) return;
  const { callee, args } = invocation;
  if (callee === "dict" && isBuiltin(module, routine, callee)) {
    if (args.length === 1 && args[0].length === 1) {
      const input = singleArg(invocation);
      return codeIn(input) ?? codeIn(stableGlobalValue(module, routine, name(source, input)));
    }
    if (!args.every(row => row.length === 3 && row[0].name === "VariableName" && row[1].name === "AssignOp")) return;
    const matches = args.filter(([key]) => name(source, key) === "error");
    if (matches.length === 1) return literal(source, matches[0][2]);
    return;
  }
  // A simple local factory is recognized by its actual dictionary return.
  // The helper's name carries no meaning for the check.
  const factory = module.functions.get(callee);
  if (!factory || locallyBound(routine, callee)) return;
  const helper = statements(factory.body).filter(node => !(node.name === "ExpressionStatement" && node.firstChild?.name === "String"));
  if (helper.length !== 1 || helper[0].name !== "ReturnStatement") return;
  const field = fields(source, helper[0].lastChild)?.get("error");
  const fixed = literal(source, field);
  if (fixed) return fixed;
  const index = factory.params.indexOf(name(source, field));
  if (index >= 0) return literal(source, singleArg(invocation, index));
}

function exceptionName(module, routine, token) {
  const { source } = module;
  if (!token || !identifier.test(token) || locallyBound(routine, token)) return false;
  if (isBuiltin(module, routine, token)) return builtinErrors.has(token);
  const [definition, other] = module.global.get(token) ?? [];
  if (other || definition?.name !== "ClassDefinition" || definition.parent?.name !== "Script") return false;
  const base = parts(definition).find(item => item.name === "ArgList");
  const body = statements(parts(definition).find(item => item.name === "Body"));
  const parent = name(source, parts(base)[1]);
  return parts(base).length === 3 && builtinErrors.has(parent) && !module.global.has(parent) &&
    body.every(item => item.name === "PassStatement" || item.name === "ExpressionStatement" && item.firstChild?.name === "String");
}

function raisedCode(module, routine, node) {
  const invocation = call(module.source, parts(node)[1]);
  if (invocation?.args.length !== 1 || !exceptionName(module, routine, invocation.callee)) return;
  return literal(module.source, singleArg(invocation));
}

/** Preserve the condition's own syntax tree and ignore expressions inside
 * other scopes. A business guard inside an exception handler is conditional
 * on that handler, so it cannot stand for a normal request check. */
function branchRows(node) {
  const children = parts(node);
  const rows = [];
  for (let index = 0; index < children.length; index++) {
    if (!["if", "elif", "except"].includes(children[index].name)) continue;
    const condition = children[index + 1];
    const body = children.slice(index + 1).find(item => item.name === "Body");
    if (condition?.name !== "Body" && body) rows.push({ condition, body });
  }
  return rows;
}

function belowHandler(node, root) {
  for (let parent = node.parent; parent && parent.from !== root.from; parent = parent.parent) {
    if (parent.name === "Body" && parent.parent?.name === "TryStatement" &&
      branchRows(parent.parent).some(({ body }) => body.from === parent.from)) return true;
  }
  return false;
}

function localImportTarget(modules, file, token) {
  const leading = /^\.+/u.exec(token)?.[0].length ?? 0;
  const parent = leading ? path.posix.join(path.posix.dirname(file), ...Array(leading - 1).fill("..")) : "";
  const requested = path.posix.join(parent, token.slice(leading).replaceAll(".", "/"));
  if (requested === ".." || requested.startsWith("../")) return [];
  return [requested + ".py", path.posix.join(requested, "__init__.py")].map(item => modules.get(keyOf(item))).filter(Boolean);
}

function importedTarget(module, modules, routine, callee) {
  if (!callee) return;
  const root = callee.split(".")[0];
  if (locallyBound(routine, root)) return;
  const [imported, extra] = module.global.get(root) ?? [];
  if (!imported || extra) return;
  const candidates = [];
  for (const item of module.imports.filter(row => row.binding === root && row.node.from === imported.from)) {
    if (item.from && callee === item.prefix) {
      for (const target of localImportTarget(modules, module.file, item.from)) candidates.push({ target, symbol: item.member });
    }
    if (!callee.startsWith(item.prefix + ".")) continue;
    const symbol = callee.slice(item.prefix.length + 1);
    if (!identifier.test(symbol)) continue;
    const token = item.from ? item.from + (item.from.endsWith(".") ? "" : ".") + item.member : item.member;
    for (const target of localImportTarget(modules, module.file, token)) candidates.push({ target, symbol });
  }
  const [candidate, other] = candidates;
  if (candidate && !other && candidate.target.functions.has(candidate.symbol)) return { file: candidate.target.file, symbol: candidate.symbol };
}

function jsonOutput(module, routine, value) {
  const { source } = module;
  const invocation = call(source, value);
  if (!invocation?.callee) return;
  const root = invocation.callee.split(".")[0];
  const [imported, extra] = module.global.get(root) ?? [];
  if (!imported || extra || locallyBound(routine, root)) return;
  const json = !module.localJson && module.imports.some(item => item.binding === root && item.node.from === imported.from &&
    ((!item.from && item.member === "json" && invocation.callee === item.prefix + ".dumps") ||
      (item.from === "json" && item.member === "dumps" && invocation.callee === item.prefix)));
  const formattingOnly = invocation.args.slice(1).every(([option, operator, setting, extra]) =>
    jsonFormatting.has(name(source, option)) && operator?.name === "AssignOp" && setting && !extra);
  return json && formattingOnly ? singleArg(invocation) : undefined;
}

function outputExpression(module, routine, node) {
  if (node.name === "ReturnStatement") return parts(node)[1];
  if (node.name !== "ExpressionStatement" || !isBuiltin(module, routine, "print")) return;
  const invocation = call(module.source, node.firstChild);
  if (invocation?.callee !== "print" || invocation.args.length !== 1) return;
  return jsonOutput(module, routine, singleArg(invocation));
}

function branchAncestors(node, body) {
  const ancestors = [];
  for (let parent = node.parent; parent && parent.from !== body.from; parent = parent.parent) {
    if (parent.name === "Body" && ["IfStatement", "TryStatement"].includes(parent.parent?.name)) {
      const items = parts(parent.parent);
      const index = items.findIndex(item => item.from === parent.from);
      const branch = [...items.slice(0, index)].reverse().find(item => ["if", "elif", "else", "try", "except", "finally"].includes(item.name));
      ancestors.push({ group: parent.parent.from, body: parent.from, kind: branch?.name });
    }
  }
  return ancestors;
}

function alternatives(left, right) {
  return left.some(a => right.some(b => a.group === b.group && a.body !== b.body &&
    (["if", "elif"].includes(a.kind) || ["if", "elif"].includes(b.kind) ||
      ["except", "else"].includes(a.kind) && ["except", "else"].includes(b.kind))));
}

/** Associate a simple assignment with its later output. Any intervening use
 * may overwrite or mutate the value, so only mutually exclusive alternatives
 * and a final try assignment followed by its handler can be skipped. */
function outputAfter(module, routine, assigned, key) {
  const { source } = module;
  if (routine.nodes.some(node => ["FunctionDefinition", "ClassDefinition", "LambdaExpression", "DecoratedStatement"].includes(node.name) &&
    localNodes(node, true).some(item => item.name === "VariableName" && name(source, item) === key))) return;
  const sourceBranches = branchAncestors(assigned, routine.body);
  const finalTry = assigned.parent?.name === "Body" && assigned.parent.parent?.name === "TryStatement" &&
    parts(assigned.parent.parent)[0]?.name === "try" && parts(assigned.parent.parent)[1]?.from === assigned.parent.from &&
    statements(assigned.parent).at(-1)?.from === assigned.from ? assigned.parent.parent.from : undefined;
  const possible = routine.nodes.filter(node => node.from > assigned.to && (node.parent?.from === assigned.parent?.from ||
    node.parent?.from === routine.body.from) && name(source, outputExpression(module, routine, node)) === key);
  return possible.find(sink => !routine.nodes.some(node => {
    if (node.from <= assigned.to || node.from >= sink.from || node.name !== "VariableName" || name(source, node) !== key) return false;
    const other = branchAncestors(node, routine.body);
    return !alternatives(sourceBranches, other) && !(finalTry !== undefined && other.some(row => row.group === finalTry && row.kind === "except"));
  }));
}

function row(module, routine, mode, evidence, condition, details) {
  return { file: module.file, symbol: routine.functionName, mode, sha256: module.sha256,
    line: module.lineOf(evidence.from), end: module.lineOf(evidence.to - 1), conditionLine: module.lineOf(condition.from), ...details };
}

function inlineBranch(module, node) {
  const block = node.parent;
  return block?.name === "Body" && block.parent?.name !== "FunctionDefinition" &&
    module.lineOf(block.from) === module.lineOf(node.from);
}

function decisionRows(module, routine, claim) {
  const { source } = module;
  const { mode, trigger } = claim;
  const result = [];
  for (const node of routine.nodes) {
    const business = mode === "business" && node.name === "IfStatement" && !belowHandler(node, routine.body);
    const fallback = mode === "fallback" && node.name === "TryStatement";
    if (!business && !fallback) continue;
    for (const { condition, body } of branchRows(node)) {
      const catches = condition.name === "TupleExpression" ? parts(condition).filter(item => item.name === "VariableName") : [condition];
      const applicable = business ? rootPredicate(module, routine, condition, trigger) :
        catches.some(item => name(source, item) === trigger.name && exceptionName(module, routine, trigger.name));
      if (!applicable) continue;
      for (const statement of statements(body)) {
        // A line event on an inline guard only proves evaluating the condition.
        if (inlineBranch(module, statement)) continue;
        const assigned = assignment(source, statement);
        const output = assigned && outputAfter(module, routine, statement, assigned.key);
        const code = statement.name === "RaiseStatement" && business ? raisedCode(module, routine, statement) :
          statement.name === "ReturnStatement" ? rejection(module, routine, parts(statement)[1]) :
          output ? rejection(module, routine, assigned.value) : undefined;
        if (code) result.push(row(module, routine, mode, statement, condition,
          { code, ...(output ? { outputLine: module.lineOf(output.from) } : {}) }));
      }
    }
  }
  return result;
}

function forwardingRows(module, modules, routine, trigger) {
  return routine.nodes.flatMap(node => {
    if (belowHandler(node, routine.body)) return [];
    const assigned = assignment(module.source, node);
    const value = assigned?.value ?? outputExpression(module, routine, node);
    const invocation = call(module.source, value);
    if (!invocation) return [];
    if (inlineBranch(module, node)) return [];
    const target = importedTarget(module, modules, routine, invocation.callee);
    if (!target || keyOf(target.file) !== keyOf(trigger.file) || trigger.symbol && target.symbol !== trigger.symbol) return [];
    const output = assigned ? outputAfter(module, routine, node, assigned.key) : node;
    return output ? [row(module, routine, "forwarding", output, node, { target, callLine: module.lineOf(value.from) })] : [];
  });
}

/** Enumerate exact source witnesses. Static evidence identifies where a
 * condition and emission are written. The caller binds actual execution to
 * these locations on the same signed bytes. */
export function collectArchitectureClaimWitnesses(sources, claim) {
  if (!sources.length || sources.length > MAX_SOURCES || sources.reduce((sum, item) => sum + Buffer.byteLength(item.source), 0) > MAX_SOURCE_BYTES) return;
  const modules = new Map();
  for (const { file, source, sha256 } of sources) {
    const module = readModule(source, file, sha256 ?? digest(source));
    if (!module || modules.has(keyOf(file))) return;
    modules.set(keyOf(file), module);
  }
  const localJson = modules.has(keyOf("json.py")) || modules.has(keyOf("json/__init__.py"));
  const rows = [];
  for (const module of modules.values()) {
    module.localJson = localJson;
    for (const routine of module.functions.values()) {
      rows.push(...(claim.mode === "forwarding" ? forwardingRows(module, modules, routine, claim.trigger) : decisionRows(module, routine, claim)));
      if (rows.length > MAX_WITNESSES) return;
    }
  }
  return [...new Map(rows.map(item => [JSON.stringify(item), item])).values()];
}

/** Read only exact, current signed Python artifacts. Return location metadata
 * to the caller, never source text or a read grant. */
export function inspectArchitectureClaimWitness(frame, artifacts, claim) {
  const unresolved = { status: "unresolved", actual: [] };
  const sources = [];
  for (const { path: file, sha256 } of artifacts) {
    if (!/\.py$/iu.test(file)) continue;
    if (!sha256 || !includes(frame.reads, file)) return unresolved;
    const bytes = readBytes(frame.root, file);
    if (!bytes || digest(bytes) !== sha256) return unresolved;
    sources.push({ file, source: text(bytes).replace(/\r\n?/gu, "\n"), sha256 });
  }
  const actual = collectArchitectureClaimWitnesses(sources, claim);
  if (!actual?.length) return unresolved;
  if (actual.length !== 1) return { status: "unresolved", actual };
  const [witness] = actual;
  const matchesOwner = keyOf(witness.file) === keyOf(claim.owner.file) &&
    (!claim.owner.symbol || witness.symbol === claim.owner.symbol);
  const matchesResponse = claim.mode === "forwarding" || witness.code === claim.response?.code;
  return { status: matchesOwner && matchesResponse ? "matched" : "mismatch", actual };
}
