import path from "node:path";
import { digest, includes, keyOf, readBytes, text } from "./policy.mjs";
import { parser } from "./vendor/python-parser.cjs";

const moduleName = /^[\p{ID_Start}_][\p{ID_Continue}]*(?:\.[\p{ID_Start}_][\p{ID_Continue}]*)*$/u;
const dynamicName = /^(?:__import__|importlib|exec|eval|globals|locals|vars|getattr|setattr|runpy)$/u;

function children(node) {
  const result = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function importStatement(node, source) {
  const tokens = children(node).filter(child => child.name !== "Comment").map(child => source.slice(child.from, child.to));
  const split = tokens.indexOf("import");
  const from = tokens[0] === "from" ? tokens.slice(1, split).join("") : "";
  const members = [];
  for (const item of tokens.slice(split + 1).join(" ").split(",")) {
    const [name, alias] = item.trim().replace(/^[()]\s*|\s*[()]$/gu, "").trim().split(/\s+as\s+/u);
    if (name) members.push({ name: name.replaceAll(" ", ""), alias });
  }
  return { from, members };
}

function localModule(local, base) {
  return [base + ".py", path.posix.join(base, "__init__.py")].map(value => local.get(keyOf(value))).filter(Boolean);
}

function importTargets(file, statement, local) {
  const { from, members } = statement;
  const prefix = /^\.+/u.exec(from)?.[0] ?? "";
  const directory = prefix ? path.posix.join(path.posix.dirname(file), ...Array(prefix.length - 1).fill("..")) : ".";
  if (directory === ".." || directory.startsWith("../")) return [];
  const parent = from.slice(prefix.length);
  if (parent && !moduleName.test(parent)) return [];
  return members.filter(({ name }) => moduleName.test(name) || parent && name === "*").map(({ name, alias }) => {
    const imported = parent || name;
    const base = path.posix.join(directory, imported.replaceAll(".", "/"));
    const candidates = localModule(local, base);
    const binding = alias || (from ? name : name.split(".")[0]);
    const possibleSubmodule = parent && name !== "*" ? localModule(local, path.posix.join(base, name)) : [];
    return { module: imported, candidates, binding, prefix: !from && !alias ? name : binding,
      member: parent ? name : null, possibleSubmodule };
  });
}

function nameParts(node, source) {
  if (node.name === "VariableName") return source.slice(node.from, node.to);
  if (node.name !== "MemberExpression" || node.lastChild?.name !== "PropertyName") return "";
  const parent = nameParts(node.firstChild, source);
  return parent && parent + "." + source.slice(node.lastChild.from, node.lastChild.to);
}

function inImport(node) {
  for (let item = node.parent; item; item = item.parent) {
    if (item.name === "ImportStatement") return true;
    if (item.name === "Script" || item.name === "Body") return false;
  }
  return false;
}

function loadIsCallReceiver(node) {
  let receiver = node;
  for (let parent = receiver.parent; parent?.name === "MemberExpression" && parent.firstChild?.from === receiver.from;
    parent = receiver.parent) receiver = parent;
  return receiver.parent?.name === "CallExpression" && receiver.parent.firstChild?.from === receiver.from;
}

function literalString(node, source) {
  if (node?.name !== "String") return;
  // Only unescaped literal identifiers can become field or error facts.
  return /^(["'])([\p{ID_Start}_][\p{ID_Continue}_-]*)\1$/u.exec(source.slice(node.from, node.to))?.[2];
}

function fieldRead(node, source) {
  if (node.name === "CallExpression" && /\.get$/u.test(nameParts(node.firstChild, source))) {
    return literalString(node.lastChild?.firstChild?.nextSibling, source);
  }
  if (node.name === "MemberExpression" && node.firstChild?.nextSibling?.name === "[" &&
    node.firstChild.nextSibling.nextSibling?.nextSibling?.name === "]") {
    return literalString(node.firstChild.nextSibling.nextSibling, source);
  }
}

function walk(root, visit, descend = () => true) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    if (descend(node)) pending.push(...children(node));
  }
}

function rejectionCode(node, source) {
  const value = node.lastChild;
  if (value?.name === "CallExpression" && value.lastChild?.name === "ArgList" &&
      (node.name === "RaiseStatement" || /(?:error|fail|reject|invalid)/iu.test(nameParts(value.firstChild, source)))) {
    return literalString(value.lastChild.firstChild?.nextSibling, source);
  }
  if (node.name !== "ReturnStatement" || value?.name !== "DictionaryExpression") return;
  const fields = children(value);
  for (const [index, item] of fields.entries()) {
    if (literalString(item, source) === "error" && fields[index + 1]?.name === ":") {
      return literalString(fields[index + 2], source);
    }
  }
}

/** Preserve definite validation sites separately from callable/import edges.
 * A field read is never proof of validation by itself. Require an explicit
 * conditional branch with a literal rejection, and keep weaker field guards
 * so a plausible local validation is not falsely attributed elsewhere. */
function functionResponsibilities(file, source, functions, lineOf) {
  const definitions = [], validation = [], rejectionSites = [], rejections = new Set();
  for (const node of functions) {
    const parts = children(node);
    const named = parts.find(item => item.name === "VariableName");
    const body = parts.find(item => item.name === "Body");
    if (!named || !body) continue;
    const symbol = source.slice(named.from, named.to);
    definitions.push({ file, symbol, line: lineOf(named.from) });
    const assignments = new Map();
    const direct = new Set(children(body).map(item => item.from));
    const conditionals = [];
    walk(body, item => {
      if (item.name === "IfStatement") conditionals.push(item);
      if (["RaiseStatement", "ReturnStatement"].includes(item.name)) {
        const code = rejectionCode(item, source);
        if (code) rejections.add(code);
      }
      if (!["AssignStatement", "UpdateStatement"].includes(item.name) || item.firstChild?.name !== "VariableName") return;
      const name = source.slice(item.firstChild.from, item.firstChild.to);
      const field = item.name === "AssignStatement" && item.firstChild.nextSibling?.name === "AssignOp" &&
        item.firstChild.nextSibling.nextSibling?.to === item.lastChild?.to && fieldRead(item.lastChild, source);
      const top = direct.has(item.from);
      assignments.set(name, assignments.has(name) || !field || !top ? null : { field, offset: item.to });
    }, item => !["FunctionDefinition", "ClassDefinition", "LambdaExpression"].includes(item.name));
    for (const branch of conditionals) {
      const parts = children(branch);
      for (const [index, part] of parts.entries()) {
        if (!["if", "elif"].includes(part.name) || parts[index + 2]?.name !== "Body") continue;
        const condition = parts[index + 1];
        const fields = new Set();
        const directFields = new Set();
        const principal = condition.firstChild?.name === "not" ? condition.firstChild.nextSibling : condition;
        const firstCheck = principal?.name === "BinaryExpression" && principal.firstChild?.nextSibling?.name === "or"
          ? principal.firstChild : undefined;
        if (firstCheck?.name === "CallExpression" && nameParts(firstCheck.firstChild, source) === "isinstance") {
          const subject = firstCheck.lastChild?.firstChild?.nextSibling;
          const binding = subject?.name === "VariableName" ? assignments.get(source.slice(subject.from, subject.to)) : null;
          const field = subject && (fieldRead(subject, source) || (binding?.offset <= subject.from ? binding.field : null));
          if (field) directFields.add(field);
        }
        walk(condition, item => {
          const explicit = fieldRead(item, source);
          if (explicit) fields.add(explicit);
          if (item.name !== "VariableName") return;
          const binding = assignments.get(source.slice(item.from, item.to));
          if (binding?.offset <= item.from) fields.add(binding.field);
        });
        const exits = children(parts[index + 2]).filter(item => ["RaiseStatement", "ReturnStatement"].includes(item.name));
        for (const exit of exits) {
          const code = rejectionCode(exit, source);
          if (code) rejectionSites.push({ file, symbol, code, line: lineOf(exit.from) });
          for (const field of fields) validation.push({ file, symbol, field, line: lineOf(exit.from),
            ...(code && (fields.size === 1 || directFields.has(field)) ? { code } : {}) });
        }
      }
    }
  }
  return { definitions, validation, rejectionSites, rejections: [...rejections] };
}

/** Only prove directly resolvable syntactic calls. An alias that is rebound
 * or handed to another expression is uncertain and cannot disprove prose. */
function localCalls(file, source, imports, callNodes, names, lineOf) {
  const aliases = new Map();
  const bindings = new Map();
  const uncertainTargets = new Set();
  let uncertainAll = names.some(({ value }) => dynamicName.test(value));
  for (const { statement, targets, scope } of imports) {
    if (statement.members.some(({ name }) => name === "*") || statement.from === "importlib") uncertainAll = true;
    for (const item of targets) {
      bindings.set(item.binding, (bindings.get(item.binding) ?? 0) + 1);
      if (item.possibleSubmodule.length) {
        for (const target of [...item.possibleSubmodule, ...item.candidates]) uncertainTargets.add(target);
        continue;
      }
      // Keep the statically resolved standard JSON codec separate from project
      // modules. A shadowing local json.py always wins over this inference.
      const jsonCodec = item.module === "json" && !item.candidates.length && !statement.from.startsWith(".");
      if (!jsonCodec && (item.candidates.length !== 1 || item.candidates[0] === file || item.member === "*")) continue;
      const alias = { ...item, scope, to: item.candidates[0], jsonCodec };
      if (!aliases.has(item.binding)) aliases.set(item.binding, []);
      aliases.get(item.binding).push(alias);
    }
  }
  const shadowed = new Set();
  for (const { value, node } of names) {
    if (!aliases.has(value) || inImport(node) || loadIsCallReceiver(node)) continue;
    shadowed.add(value);
  }
  // A proven sibling codec call cannot refute another call when any JSON
  // binding in the module has been passed around, shadowed or rebound.
  const jsonBindings = [...aliases].filter(([, items]) => items.some(item => item.jsonCodec));
  const uncertainCodec = uncertainAll || jsonBindings.some(([binding, items]) =>
    bindings.get(binding) !== 1 || shadowed.has(binding) || items.some(item => item.scope !== "Script"));
  const calls = [], jsonDecoders = [];
  for (const call of callNodes) {
    const syntax = nameParts(call.firstChild, source);
    if (!syntax) continue;
    const root = syntax.split(".")[0];
    const matches = (aliases.get(root) ?? []).filter(item => item.member ? syntax === item.prefix : syntax.startsWith(item.prefix + "."));
    if (matches.length > 1 || matches.length && (bindings.get(root) !== 1 || shadowed.has(root) || matches[0].scope !== "Script")) {
      for (const { to } of matches) if (to) uncertainTargets.add(to);
      continue;
    }
    const resolved = matches[0];
    if (!resolved) continue;
    const symbol = resolved.member ?? syntax.slice(resolved.prefix.length + 1);
    if (resolved.jsonCodec) {
      if (!uncertainCodec && ["load", "loads"].includes(symbol)) jsonDecoders.push({ file, line: lineOf(call.from), symbol: "json." + symbol });
    } else calls.push({ file, line: lineOf(call.from), target: resolved.to, symbol });
  }
  return { calls, jsonDecoders, uncertainAll, uncertainTargets: [...uncertainTargets] };
}

/** Bound facts to exact signed readable source bytes and use only declared
 * local paths. This inventory does not execute Python or infer call reach. */
export function pythonImportEvidence(frame, artifacts, { responsibilities = false } = {}) {
  const files = artifacts.filter(row => row.sha256 && /\.py$/iu.test(row.path) && includes(frame.reads, row.path));
  const local = new Map(files.map(({ path }) => [keyOf(path), path]));
  const checkedFiles = [], unparsedFiles = [], edges = [], ambiguous = [], calls = [], uncertainCalls = [];
  const definitions = [], validation = [], rejectionSites = [], jsonDecoders = [], localRejections = [], sourceIdentifiers = [];
  let responsibilitiesTruncated = false;
  let truncated = false;
  for (const { path: file, sha256 } of files) {
    if (checkedFiles.length + unparsedFiles.length >= 64) { truncated = true; break; }
    const bytes = readBytes(frame.root, file);
    if (!bytes || digest(bytes) !== sha256) throw new Error("已签名源码已变化：" + file);
    const source = text(bytes).replace(/\r\n?/gu, "\n");
    const imports = [], callNodes = [], names = [], functions = [];
    const identifiers = new Set();
    let invalid = false;
    parser.parse(source).iterate({ enter(node) {
      if (node.type.isError) invalid = true;
      if (node.name === "ImportStatement") imports.push(node.node);
      if (node.name === "CallExpression") callNodes.push(node.node);
      if (node.name === "VariableName") {
        const value = source.slice(node.from, node.to);
        names.push({ node: node.node, value });
        if (responsibilities) identifiers.add(value);
      }
      if (responsibilities && node.name === "String") {
        const value = literalString(node.node, source);
        if (value) identifiers.add(value);
      }
      if (responsibilities && node.name === "FunctionDefinition" && node.node.parent?.name === "Script") functions.push(node.node);
    } });
    if (invalid) { unparsedFiles.push(file); continue; }
    checkedFiles.push(file);
    const starts = [0, ...[...source.matchAll(/\n/gu)].map(match => match.index + 1)];
    const lineOf = offset => {
      let lo = 0, hi = starts.length;
      while (hi - lo > 1) {
        const middle = (lo + hi) >> 1;
        if (starts[middle] <= offset) lo = middle;
        else hi = middle;
      }
      return lo + 1;
    };
    const bindings = imports.map(node => {
      const statement = importStatement(node, source);
      const targets = importTargets(file, statement, local);
      const direct = new Set();
      for (const { candidates, module } of targets) {
        if (candidates.length === 1 && candidates[0] !== file) direct.add(candidates[0]);
        if (candidates.length > 1 && ambiguous.length < 64) ambiguous.push({ file, module });
      }
      if (direct.size && edges.length < 64) edges.push({ file, line: lineOf(node.from), imports: [...direct] });
      else if (direct.size) truncated = true;
      return { statement, targets, scope: node.parent?.name };
    });
    const resolved = localCalls(file, source, bindings, callNodes, names, lineOf);
    if (responsibilities) {
      const current = functionResponsibilities(file, source, functions, lineOf);
      if (definitions.length + current.definitions.length > 128 || validation.length + current.validation.length > 128 ||
        rejectionSites.length + current.rejectionSites.length > 128 || jsonDecoders.length + resolved.jsonDecoders.length > 64 ||
        current.rejections.length > 128 || identifiers.size > 512) {
        responsibilitiesTruncated = true;
      }
      definitions.push(...current.definitions.slice(0, 128 - definitions.length));
      validation.push(...current.validation.slice(0, 128 - validation.length));
      rejectionSites.push(...current.rejectionSites.slice(0, 128 - rejectionSites.length));
      jsonDecoders.push(...resolved.jsonDecoders.slice(0, 64 - jsonDecoders.length));
      if (current.rejections.length && !responsibilitiesTruncated) localRejections.push({ file, codes: current.rejections });
      if (!responsibilitiesTruncated) sourceIdentifiers.push({ file, identifiers: [...identifiers] });
    }
    // Deduplicate repeated calls to one symbol. A large call inventory must
    // not invalidate the pre-existing bounded static import inventory.
    const unique = new Map();
    for (const call of resolved.calls) {
      const key = JSON.stringify([call.target, call.symbol]);
      if (!unique.has(key)) unique.set(key, call);
    }
    if (calls.length + unique.size > 64 || resolved.uncertainAll) uncertainCalls.push({ file });
    else if (resolved.uncertainTargets.length) uncertainCalls.push({ file, targets: resolved.uncertainTargets });
    calls.push(...[...unique.values()].slice(0, 64 - calls.length));
  }
  return { kind: "python-static-local", checkedFiles, unparsedFiles, edges, ambiguous, truncated, calls,
    uncertainCalls, ...(responsibilities ? { definitions, validation, rejectionSites, jsonDecoders, localRejections, sourceIdentifiers,
      responsibilitiesTruncated } : {}),
    scope: "仅登记当前可读取的 Python 本地静态导入和可定位的直接调用语法。别名传播、动态调用、间接调用和实际运行路径需另行验证。" };
}
