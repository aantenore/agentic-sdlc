/**
 * A strict parser for the small, readable subset of YAML that GitHub workflow
 * files are written in. The project has no runtime dependencies, so tests that
 * need the structure of a workflow cannot lean on a YAML library.
 *
 * Supported: block mappings and sequences, plain / single-quoted /
 * double-quoted scalars, one-line flow sequences and the empty flow mapping,
 * literal block scalars (`|` and `|-`), and comments.
 *
 * Anything else is refused with the line number instead of being guessed at:
 * tabs, anchors and aliases, tags, folded scalars, multiple documents,
 * duplicate keys, multi-line plain scalars, and ": " inside a plain scalar.
 * A file that parses here is therefore plain, unambiguous YAML in the shape
 * the parser read; a file that does not is outside what this helper vouches
 * for, whatever other tools would make of it.
 */

export class YamlSubsetError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "YamlSubsetError";
    this.line = line ?? null;
  }
}

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?: +(.*))?$/u;
const UNSUPPORTED_START = /^[&*!>%@`]/u;

function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === "\"") index += 1;
      else if (char === quote) quote = null;
    } else if ((char === "'" || char === "\"") && (index === 0 || /[\s[,]/u.test(text[index - 1]))) {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/u.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

function resolvePlain(text) {
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(text)) return Number(text);
  if (/^-?(?:0|[1-9][0-9]*)\.[0-9]+$/u.test(text)) return Number(text);
  return text;
}

function parseQuoted(text, line) {
  const quote = text[0];
  let value = "";
  let index = 1;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          value += "'";
          index += 1;
          continue;
        }
        break;
      }
      value += char;
    } else if (char === "\\") {
      const escape = text[index + 1];
      const map = { n: "\n", t: "\t", "\"": "\"", "\\": "\\", "/": "/", 0: "\0" };
      if (!(escape in map)) throw new YamlSubsetError(`unsupported escape \\${escape}`, line);
      value += map[escape];
      index += 1;
    } else if (char === "\"") {
      break;
    } else {
      value += char;
    }
  }
  if (index >= text.length) throw new YamlSubsetError("unterminated quoted scalar", line);
  const rest = stripComment(text.slice(index + 1)).trim();
  if (rest) throw new YamlSubsetError(`unexpected text after a quoted scalar: ${rest}`, line);
  return value;
}

function splitFlow(inner, line) {
  const items = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (quote) {
      current += char;
      if (char === "\\" && quote === "\"") {
        current += inner[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === "'" || char === "\"") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current.trim());
      current = "";
    } else if (char === "[" || char === "{") {
      throw new YamlSubsetError("nested flow collections are not supported", line);
    } else {
      current += char;
    }
  }
  if (quote) throw new YamlSubsetError("unterminated quoted scalar in a flow sequence", line);
  if (current.trim() !== "" || items.length > 0) items.push(current.trim());
  return items;
}

function parseInline(raw, line) {
  const text = stripComment(raw).trim();
  if (text === "") return null;
  if (text[0] === "\"" || text[0] === "'") return parseQuoted(text, line);
  if (text[0] === "[") {
    if (!text.endsWith("]")) throw new YamlSubsetError("a flow sequence must close on the same line", line);
    return splitFlow(text.slice(1, -1), line).map((item) => {
      if (item === "") throw new YamlSubsetError("empty item in a flow sequence", line);
      return item[0] === "\"" || item[0] === "'" ? parseQuoted(item, line) : resolvePlain(item);
    });
  }
  if (text[0] === "{") {
    if (text !== "{}") throw new YamlSubsetError("only the empty flow mapping {} is supported", line);
    return {};
  }
  if (UNSUPPORTED_START.test(text)) {
    throw new YamlSubsetError(`unsupported YAML construct starting with '${text[0]}'`, line);
  }
  if (text.startsWith("- ") || text === "-") throw new YamlSubsetError("a sequence cannot start on a value line", line);
  if (text.includes(": ") || text.endsWith(":")) {
    throw new YamlSubsetError("a plain scalar cannot contain ': '; quote it or use a block", line);
  }
  return resolvePlain(text);
}

class Parser {
  constructor(source) {
    const normalized = source.replace(/\r\n?/gu, "\n");
    if (normalized.includes("\t")) {
      const at = normalized.split("\n").findIndex((candidate) => candidate.includes("\t"));
      throw new YamlSubsetError("tabs are not allowed", at + 1);
    }
    this.lines = normalized.split("\n").map((raw, index) => {
      const text = raw.trimStart();
      return { raw, number: index + 1, indent: raw.length - text.length, text: text.trimEnd() };
    });
    this.position = 0;
  }

  skipBlank() {
    while (this.position < this.lines.length) {
      const { text } = this.lines[this.position];
      if (text !== "" && !text.startsWith("#")) return;
      this.position += 1;
    }
  }

  peek() {
    this.skipBlank();
    return this.lines[this.position] ?? null;
  }

  parseDocument() {
    const first = this.peek();
    if (!first) return null;
    if (first.text === "---" || first.text === "...") {
      throw new YamlSubsetError("document markers are not supported", first.number);
    }
    const value = this.parseBlock(0);
    const extra = this.peek();
    if (extra) throw new YamlSubsetError("unexpected content after the document", extra.number);
    return value;
  }

  parseBlock(minimumIndent) {
    const line = this.peek();
    if (!line || line.indent < minimumIndent) return null;
    return line.text === "-" || line.text.startsWith("- ")
      ? this.parseSequence(line.indent)
      : this.parseMapping(line.indent);
  }

  parseMapping(indent) {
    const result = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) return result;
      if (line.indent > indent) throw new YamlSubsetError("unexpected indentation", line.number);
      if (line.text === "-" || line.text.startsWith("- ")) return result;
      const match = KEY.exec(stripComment(line.text));
      if (!match) throw new YamlSubsetError(`expected 'key: value', found: ${line.text}`, line.number);
      const [, key, rawValue = ""] = match;
      if (Object.hasOwn(result, key)) throw new YamlSubsetError(`duplicate key '${key}'`, line.number);
      this.position += 1;
      result[key] = this.parseValue(rawValue, indent, line.number, true);
    }
  }

  parseSequence(indent) {
    const result = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) return result;
      if (line.indent > indent) throw new YamlSubsetError("unexpected indentation", line.number);
      if (!(line.text === "-" || line.text.startsWith("- "))) return result;
      const after = /^-( *)(.*)$/u.exec(line.text);
      const rest = after[2];
      if (rest === "") {
        this.position += 1;
        result.push(this.parseBlock(indent + 1));
        continue;
      }
      if (KEY.test(stripComment(rest)) && !/^["'[{]/u.test(rest)) {
        // "- key: value" opens a mapping whose keys line up with the first one.
        const virtual = indent + 1 + after[1].length;
        this.lines[this.position] = { ...line, indent: virtual, text: rest };
        result.push(this.parseMapping(virtual));
        continue;
      }
      this.position += 1;
      result.push(this.parseValue(rest, indent, line.number, false));
    }
  }

  parseValue(rawValue, parentIndent, lineNumber, allowNested) {
    const value = rawValue.trim();
    const comment = stripComment(value);
    if (/^\|-?$/u.test(comment)) return this.parseLiteral(comment, parentIndent, lineNumber);
    if (comment === "" && allowNested) {
      const next = this.peek();
      if (next && next.indent > parentIndent) return this.parseBlock(next.indent);
      // A sequence may sit at the same indentation as the key that owns it.
      if (next && next.indent === parentIndent && (next.text === "-" || next.text.startsWith("- "))) {
        return this.parseSequence(parentIndent);
      }
      return null;
    }
    if (/^[|>]/u.test(comment)) {
      throw new YamlSubsetError("only literal block scalars (| and |-) are supported", lineNumber);
    }
    return parseInline(value, lineNumber);
  }

  parseLiteral(indicator, parentIndent, lineNumber) {
    const collected = [];
    let blockIndent = null;
    while (this.position < this.lines.length) {
      const line = this.lines[this.position];
      if (line.raw.trim() === "") {
        collected.push("");
        this.position += 1;
        continue;
      }
      if (blockIndent === null) {
        if (line.indent <= parentIndent) break;
        blockIndent = line.indent;
      }
      if (line.indent < blockIndent) break;
      collected.push(line.raw.slice(blockIndent).trimEnd());
      this.position += 1;
    }
    if (blockIndent === null) throw new YamlSubsetError("a literal block needs indented content", lineNumber);
    while (collected.length > 0 && collected.at(-1) === "") collected.pop();
    const body = collected.join("\n");
    return indicator === "|-" ? body : `${body}\n`;
  }
}

export function parseYamlSubset(source) {
  return new Parser(String(source)).parseDocument();
}
