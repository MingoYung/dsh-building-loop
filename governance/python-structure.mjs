import { parser } from "./vendor/python-parser.cjs";
import { digest, text } from "./policy.mjs";

const TRAILING_COMMA = new Set(["ArgList", "ParamList", "ArrayExpression", "DictionaryExpression", "SetExpression",
  "TupleExpression", "ImportStatement", "TypeParamList"]);
const CLOSING = new Set([")", "]", "}"]);

function stringLiteral(value) {
  const match = /^([rub]?)("""|'''|"|')([\s\S]*)\2$/iu.exec(value);
  // A changed escape spelling alone is ambiguous. Let the trusted tests resolve it.
  if (!match || match[3].includes("\\")) return null;
  return [match[1].toLowerCase() === "b" ? "bytes" : "text", match[3]];
}

function numericLiteral(value) {
  const spelling = value.toLowerCase().replaceAll("_", "");
  if (/^(?:[0-9]+|0[xob][a-f0-9]+)$/u.test(spelling)) return ["int", BigInt(spelling).toString()];
  if (spelling.endsWith("j")) return ["imaginary", Number(spelling.slice(0, -1)).toString()];
  return ["float", Number(spelling).toString()];
}

function syntaxChildren(node) {
  const children = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "Comment") children.push(child);
  }
  return children;
}

function ignoredDocstring(node) {
  if (node?.name !== "ExpressionStatement") return false;
  const expressions = syntaxChildren(node);
  if (expressions.length !== 1) return false;
  const expression = expressions[0];
  return expression.name === "String" || (expression.name === "ContinuedString" &&
    syntaxChildren(expression).every(child => child.name === "String"));
}

/** This is a conservative structural check, not an interpreter or a test result. */
export function pythonStructure(bytes) {
  const source = text(bytes).replace(/\r\n?/gu, "\n");
  const parts = [];
  let statements = 0;

  function stringPieces(node) {
    const pieces = [];
    function literal(kind, value) {
      if (value === "") return;
      const previous = pieces.at(-1);
      if (previous?.kind === kind) previous.value = previous.value === null || value === null ? null : previous.value + value;
      else pieces.push({ kind, value });
    }
    function collect(string) {
      const value = source.slice(string.from, string.to);
      if (string.name === "ContinuedString") {
        syntaxChildren(string).forEach(collect);
      } else if (string.name === "FormatString") {
        const opening = /^[fr]+("""|'''|"|')/iu.exec(value);
        if (!opening) throw new SyntaxError("Python format string cannot be certified");
        let from = string.from + opening[0].length;
        const addFragment = to => {
          const fragment = source.slice(from, to);
          literal("text", fragment.includes("\\") ? null : fragment.replace(/\{\{|\}\}/gu, pair => pair[0]));
        };
        for (const replacement of syntaxChildren(string)) {
          addFragment(replacement.from);
          pieces.push({ replacement });
          from = replacement.to;
        }
        addFragment(string.to - opening[1].length);
      } else {
        const parsed = stringLiteral(value);
        if (parsed) literal(parsed[0], parsed[1]);
        else literal(/^[rb]*b/iu.test(value) ? "bytes" : "text", null);
      }
    }
    collect(node);
    return pieces;
  }

  function visit(node, depth) {
    if (node.type.isError || depth > 256) throw new SyntaxError("Python syntax cannot be certified");
    const name = node.name;
    const children = syntaxChildren(node);
    if (["String", "ContinuedString", "FormatString"].includes(name)) {
      parts.push(["String"]);
      for (const { replacement, kind, value } of stringPieces(node)) {
        if (replacement) visit(replacement, depth + 1);
        else parts.push([kind, value]);
      }
      parts.push(null);
      return;
    }
    // Redundant parentheses and statement groups do not change Python execution.
    if (["ParenthesizedExpression", "StatementGroup"].includes(name)) {
      for (const child of children) if (!["(", ")", ";"].includes(child.name)) visit(child, depth + 1);
      return;
    }
    if (name === "Script" || name === "Body") {
      const index = children.findIndex(child => child.name !== ":");
      if (ignoredDocstring(children[index])) children.splice(index, 1);
      if (name === "Script") statements = children.length;
    }
    if (!children.length && !["Script", "Body"].includes(name)) {
      const value = source.slice(node.from, node.to);
      parts.push([name, name === "Number" ? numericLiteral(value) : value]);
      return;
    }
    parts.push([name]);
    for (const [index, child] of children.entries()) {
      const trailingComma = TRAILING_COMMA.has(name) && child.name === "," &&
        (!children[index + 1] || CLOSING.has(children[index + 1].name));
      if (!trailingComma && !(name === "ImportStatement" && ["(", ")"].includes(child.name))) visit(child, depth + 1);
    }
    parts.push(null);
  }
  // Visit error nodes even if the containing construct is normalized away.
  const tree = parser.parse(source);
  try {
    tree.iterate({ enter: node => { if (node.type.isError) throw new SyntaxError("Python syntax cannot be certified"); } });
    visit(tree.topNode, 0);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return { sha256: digest(JSON.stringify(parts)), statements };
}
