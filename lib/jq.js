// A practical jq subset for Jqui.
//
// The goal is the 90% of jq people actually type in an API client: paths,
// pipes, array iteration, map/select/sort_by, comparisons and defaults. It is
// not a full jq implementation: variables, reduce/foreach, user-defined
// functions and string interpolation are deliberately out of scope.
//
// Expressions are compiled to a small AST once, then evaluated against a
// parsed JSON value. Evaluation always yields an array of outputs, because a
// jq filter is a stream filter (`,`, `.[]` and `select` can produce zero,
// one or many results).

export class JqError extends Error {
  constructor(message, position) {
    super(message);
    this.name = "JqError";
    this.position = position;
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;

  const push = (type, value, pos) => tokens.push({ type, value, pos });

  while (i < n) {
    const c = source[i];

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i += 1;
      continue;
    }

    if (c === "#") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }

    if (c === '"') {
      const pos = i;
      i += 1;
      let out = "";
      let closed = false;
      while (i < n) {
        const ch = source[i];
        if (ch === '"') {
          i += 1;
          closed = true;
          break;
        }
        if (ch === "\\") {
          i += 1;
          if (i >= n) break;
          const esc = source[i];
          i += 1;
          if (esc === "u") {
            const hex = source.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new JqError("字符串里的 \\u 需要四位十六进制数字", i);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else if (esc === "r") out += "\r";
          else if (esc === "b") out += "\b";
          else if (esc === "f") out += "\f";
          else if (esc === "/" || esc === "\\" || esc === '"') out += esc;
          else throw new JqError(`不支持的字符串转义 \\${esc}`, i - 2);
        } else {
          out += ch;
          i += 1;
        }
      }
      if (!closed) throw new JqError("字符串没有结束的双引号", pos);
      push("string", out, pos);
      continue;
    }

    if (c >= "0" && c <= "9") {
      const pos = i;
      let j = i;
      while (j < n && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === ".") {
        j += 1;
        while (j < n && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === "e" || source[j] === "E") {
        j += 1;
        if (source[j] === "+" || source[j] === "-") j += 1;
        while (j < n && /[0-9]/.test(source[j])) j += 1;
      }
      push("number", Number(source.slice(i, j)), pos);
      i = j;
      continue;
    }

    if (IDENT_START.test(c)) {
      const pos = i;
      let j = i + 1;
      while (j < n && IDENT_PART.test(source[j])) j += 1;
      push("ident", source.slice(i, j), pos);
      i = j;
      continue;
    }

    if (c === "@") {
      const pos = i;
      let j = i + 1;
      while (j < n && IDENT_PART.test(source[j])) j += 1;
      if (j === i + 1) throw new JqError("@ 后面需要一个格式名，例如 @json", pos);
      push("format", source.slice(i + 1, j), pos);
      i = j;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === "//" || two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "..") {
      push(two === ".." ? "dotdot" : "op", two, i);
      i += 2;
      continue;
    }

    const singles = {
      ".": "dot",
      "[": "[",
      "]": "]",
      "{": "{",
      "}": "}",
      "(": "(",
      ")": ")",
      "|": "pipe",
      ",": "comma",
      ":": "colon",
      ";": "semi",
      "?": "question",
      "+": "op",
      "-": "op",
      "*": "op",
      "/": "op",
      "%": "op",
      "<": "op",
      ">": "op",
    };
    const type = singles[c];
    if (!type) {
      throw new JqError(`无法识别的字符 \`${c}\``, i);
    }
    push(type, c, i);
    i += 1;
  }

  push("eof", "", n);
  return tokens;
}

const KEYWORD_BOUNDARY = new Set([
  "then",
  "else",
  "elif",
  "end",
  "and",
  "or",
  "as",
  "reduce",
  "foreach",
]);

function startsExpression(token) {
  if (!token) return false;
  if (["dot", "dotdot", "[", "{", "(", "string", "number", "format"].includes(token.type)) {
    return true;
  }
  if (token.type === "ident") return !KEYWORD_BOUNDARY.has(token.value);
  return false;
}

class Parser {
  constructor(tokens, source) {
    this.tokens = tokens;
    this.source = source;
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  next() {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  at(type, value) {
    const token = this.peek();
    if (!token || token.type !== type) return false;
    if (value !== undefined && token.value !== value) return false;
    return true;
  }

  match(type, value) {
    if (!this.at(type, value)) return false;
    this.index += 1;
    return true;
  }

  expect(type, what) {
    const token = this.peek();
    if (!token || token.type !== type) {
      throw new JqError(`这里需要${what || ` \`${type}\``}，却遇到 \`${token ? token.value : "结尾"}\``, token ? token.pos : this.source.length);
    }
    this.index += 1;
    return token;
  }

  matchIdent(name) {
    if (this.at("ident", name)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  parseProgram() {
    const first = this.parsePipe();
    if (!this.at("comma")) return first;
    const items = [first];
    while (this.match("comma")) items.push(this.parsePipe());
    return { type: "comma", items };
  }

  parsePipe() {
    let left = this.parseAlternative();
    while (this.match("pipe")) {
      const right = this.parseAlternative();
      left = { type: "pipe", left, right };
    }
    return left;
  }

  parseAlternative() {
    let left = this.parseOr();
    while (this.at("op", "//")) {
      this.next();
      const right = this.parseOr();
      left = { type: "alternative", left, right };
    }
    return left;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.matchIdent("or")) {
      const right = this.parseAnd();
      left = { type: "binary", op: "or", left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseComparison();
    while (this.matchIdent("and")) {
      const right = this.parseComparison();
      left = { type: "binary", op: "and", left, right };
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    const ops = ["==", "!=", "<=", ">=", "<", ">"];
    while (this.at("op") && ops.includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseAdditive();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.at("op") && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.at("op") && ["*", "/", "%"].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  parseUnary() {
    if (this.at("op", "-")) {
      this.next();
      return { type: "unary", op: "negate", expr: this.parseUnary() };
    }
    if (this.at("ident", "not") && startsExpression(this.peek(1))) {
      this.next();
      return { type: "unary", op: "not", expr: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let base = this.parsePrimary();
    for (;;) {
      if (this.match("question")) {
        base = { type: "tryEmpty", expr: base };
        continue;
      }
      if (this.match("dot")) {
        const token = this.peek();
        if (token.type === "ident" || token.type === "string") {
          this.next();
          base = apply(base, { kind: "key", key: token.value });
          continue;
        }
        throw new JqError("`.` 后面需要字段名或字符串", token.pos);
      }
      if (this.at("[")) {
        base = this.parseBracket(base);
        continue;
      }
      break;
    }
    return base;
  }

  parseBracket(base) {
    const open = this.expect("[", " `[` ");
    if (this.match("]")) return apply(base, { kind: "iterate" });

    if (this.at("colon")) {
      this.next();
      const end = this.parseOptionalInt();
      this.expect("]");
      return apply(base, { kind: "slice", start: null, end });
    }

    if (this.at("number") || (this.at("op", "-") && this.peek(1).type === "number")) {
      const start = this.parseOptionalInt();
      if (this.match("colon")) {
        const end = this.parseOptionalInt();
        this.expect("]");
        return apply(base, { kind: "slice", start, end });
      }
      this.expect("]");
      return apply(base, { kind: "index", index: start });
    }

    if (this.at("string")) {
      const key = this.next().value;
      this.expect("]");
      return apply(base, { kind: "key", key });
    }

    const expr = this.parseProgram();
    this.expect("]");
    const segment = { kind: "indexExpr", expr, pos: open.pos };
    return apply(base, segment);
  }

  parseOptionalInt() {
    let sign = 1;
    if (this.match("op", "-")) sign = -1;
    if (!this.at("number")) return null;
    return sign * this.next().value;
  }

  parsePrimary() {
    const token = this.peek();

    if (this.match("dotdot")) return { type: "recurse" };

    if (this.match("dot")) {
      const nextToken = this.peek();
      if (nextToken.type === "ident" || nextToken.type === "string") {
        this.next();
        return apply({ type: "identity" }, { kind: "key", key: nextToken.value });
      }
      if (this.at("[")) return this.parseBracket({ type: "identity" });
      return { type: "identity" };
    }

    if (this.at("[")) {
      this.next();
      if (this.match("]")) return { type: "array", expr: null };
      const expr = this.parseProgram();
      this.expect("]");
      return { type: "array", expr };
    }

    if (this.at("{")) return this.parseObject();
    if (this.at("(")) {
      this.next();
      const expr = this.parseProgram();
      this.expect(")");
      return expr;
    }
    if (this.at("number")) return { type: "literal", value: this.next().value };
    if (this.at("string")) return { type: "literal", value: this.next().value };
    if (this.at("format")) return { type: "format", name: this.next().value };

    if (this.at("ident")) {
      const name = token.value;

      if (name === "true") {
        this.next();
        return { type: "literal", value: true };
      }
      if (name === "false") {
        this.next();
        return { type: "literal", value: false };
      }
      if (name === "null") {
        this.next();
        return { type: "literal", value: null };
      }
      if (name === "if") {
        this.next();
        return this.parseIf();
      }
      if (name === "as" || name === "reduce" || name === "foreach") {
        throw new JqError(`暂不支持 \`${name}\`；请改用 map / select / sort_by 等内置函数`, token.pos);
      }
      if (KEYWORD_BOUNDARY.has(name)) {
        throw new JqError(`这里不应出现 \`${name}\``, token.pos);
      }

      this.next();
      const args = [];
      if (this.match("(")) {
        if (!this.at(")")) {
          args.push(this.parseProgram());
          while (this.match("semi")) args.push(this.parseProgram());
        }
        this.expect(")");
      }
      return { type: "call", name, args, pos: token.pos };
    }

    throw new JqError(`无法解析的表达式片段 \`${token.value || "结尾"}\``, token.pos);
  }

  parseIf() {
    const condition = this.parsePipe();
    if (!this.matchIdent("then")) {
      throw new JqError("`if` 之后需要 `then`", this.peek().pos);
    }
    const consequent = this.parsePipe();
    let alternate = { type: "identity" };

    if (this.matchIdent("elif")) {
      alternate = this.parseIf();
    } else if (this.matchIdent("else")) {
      alternate = this.parsePipe();
    }

    if (!this.matchIdent("end")) {
      throw new JqError("`if` 需要以 `end` 结束", this.peek().pos);
    }
    return { type: "if", condition, consequent, alternate };
  }

  parseObject() {
    this.expect("{");
    const entries = [];
    while (!this.at("}")) {
      const token = this.peek();
      let keyName = null;
      let keyExpr = null;

      if (token.type === "ident" || token.type === "string") {
        this.next();
        keyName = token.value;
      } else if (this.match("(")) {
        keyExpr = this.parseProgram();
        this.expect(")");
      } else {
        throw new JqError("对象的键需要是名字、字符串或 `(表达式)`", token.pos);
      }

      let value;
      if (this.match("colon")) {
        value = this.parsePipe();
      } else if (keyName !== null) {
        value = apply({ type: "identity" }, { kind: "key", key: keyName });
      } else {
        throw new JqError("对象条目缺少 `:` 和值", token.pos);
      }

      entries.push({ keyName, keyExpr, value });
      if (!this.match("comma")) break;
    }
    this.expect("}");
    return { type: "object", entries };
  }
}

function apply(base, segment) {
  return { type: "apply", base, segment };
}

export function compile(source) {
  const text = String(source === undefined || source === null ? "" : source).trim();
  if (!text) return { type: "identity" };
  const parser = new Parser(tokenize(text), text);
  const ast = parser.parseProgram();
  if (!parser.at("eof")) {
    throw new JqError(`表达式末尾还有多余内容 \`${parser.peek().value}\``, parser.peek().pos);
  }
  return ast;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function truthy(value) {
  return value !== null && value !== undefined && value !== false;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonStringify(value) {
  const encoded = JSON.stringify(value === undefined ? null : value);
  return encoded === undefined ? "null" : encoded;
}

function toText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  return jsonStringify(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    if (typeof b !== "object") return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function typeRank(value) {
  if (value === null || value === undefined) return 0;
  if (value === false) return 1;
  if (value === true) return 2;
  if (typeof value === "number") return 3;
  if (typeof value === "string") return 4;
  if (Array.isArray(value)) return 5;
  if (typeof value === "object") return 6;
  return 7;
}

function compareValues(a, b) {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (rankA <= 2) return 0;
  if (rankA === 3) return a === b ? 0 : a < b ? -1 : 1;
  if (rankA === 4) return a === b ? 0 : a < b ? -1 : 1;
  if (rankA === 5) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      const result = compareValues(a[i], b[i]);
      if (result !== 0) return result;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  if (rankA === 6) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    const length = Math.min(aKeys.length, bKeys.length);
    for (let i = 0; i < length; i += 1) {
      const result = compareValues(aKeys[i], bKeys[i]);
      if (result !== 0) return result;
    }
    if (aKeys.length !== bKeys.length) return aKeys.length < bKeys.length ? -1 : 1;
    for (const key of aKeys) {
      const result = compareValues(a[key], b[key]);
      if (result !== 0) return result;
    }
    return 0;
  }
  return String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1;
}

function firstOutput(node, input, ctx) {
  const outputs = evalNode(node, input, ctx);
  return outputs.length ? outputs[0] : null;
}

function requireString(value, what) {
  if (typeof value !== "string") {
    throw new JqError(`${what || "这个函数"} 需要一个字符串，实际是 ${typeName(value)}`);
  }
  return value;
}

function requireArray(value, what) {
  if (!Array.isArray(value)) {
    throw new JqError(`${what || "这个函数"} 需要一个数组，实际是 ${typeName(value)}`);
  }
  return value;
}

function typeName(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function pathLabel(segments) {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) out += `.${segment}`;
    else out += `[${jsonStringify(segment)}]`;
  }
  return out || ".";
}

function applyKey(value, key) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    throw new JqError(`不能用字段名 ${jsonStringify(key)} 索引数组`);
  }
  if (typeof value === "object") {
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
  }
  throw new JqError(`不能用字段名 ${jsonStringify(key)} 索引 ${typeName(value)}`);
}

function applyIndex(value, index) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const position = index < 0 ? value.length + index : index;
    return position >= 0 && position < value.length ? value[position] : null;
  }
  if (typeof value === "object") {
    const key = String(index);
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
  }
  throw new JqError(`不能用下标 ${index} 索引 ${typeName(value)}`);
}

function applySlice(value, start, end) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && !Array.isArray(value)) {
    throw new JqError(`不能对 ${typeName(value)} 取切片`);
  }
  const length = value.length;
  let from = start === null || start === undefined ? 0 : start;
  let to = end === null || end === undefined ? length : end;
  if (from < 0) from = Math.max(0, length + from);
  if (to < 0) to = Math.max(0, length + to);
  from = Math.min(Math.max(0, from), length);
  to = Math.min(Math.max(0, to), length);
  if (to < from) to = from;
  return value.slice(from, to);
}

function iterate(value) {
  if (Array.isArray(value)) return value.slice();
  if (isPlainObject(value)) return Object.keys(value).map((key) => value[key]);
  if (value === null || value === undefined) {
    throw new JqError("不能遍历 null；如果这是可选的，写成 `[]?`");
  }
  throw new JqError(`不能遍历 ${typeName(value)}`);
}

function applySegment(value, segment, ctx) {
  switch (segment.kind) {
    case "key":
      return [applyKey(value, segment.key)];
    case "index":
      return [applyIndex(value, segment.index)];
    case "iterate":
      return iterate(value);
    case "slice":
      return [applySlice(value, segment.start, segment.end)];
    case "indexExpr": {
      const keys = evalNode(segment.expr, value, ctx);
      const out = [];
      for (const key of keys) {
        if (typeof key === "number") out.push(applyIndex(value, key));
        else if (typeof key === "string") out.push(applyKey(value, key));
        else throw new JqError("下标表达式必须得到数字或字符串");
      }
      return out;
    }
    default:
      throw new JqError("内部错误：未知的路径片段");
  }
}

function walk(value, out) {
  out.push(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) walk(value[key], out);
  }
}

function collectPaths(value, out, current, leavesOnly) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const path = current.concat([i]);
      if (!leavesOnly || !Array.isArray(value[i]) && !isPlainObject(value[i])) out.push(path);
      collectPaths(value[i], out, path, leavesOnly);
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const path = current.concat([key]);
      if (!leavesOnly || !Array.isArray(value[key]) && !isPlainObject(value[key])) out.push(path);
      collectPaths(value[key], out, path, leavesOnly);
    }
  }
}

function getPath(value, path) {
  let current = value;
  for (const key of path) {
    if (typeof key === "number") current = applyIndex(current, key);
    else current = applyKey(current, key);
  }
  return current;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneJson(value[key]);
    return out;
  }
  return value;
}

function setPath(value, path, next) {
  if (!path.length) return next;
  const key = path[0];
  const rest = path.slice(1);
  if (typeof key === "number") {
    const array = Array.isArray(value) ? value.slice() : [];
    const position = key < 0 ? array.length + key : key;
    const target = position >= 0 ? position : array.length;
    array[target] = setPath(array[target], rest, next);
    return array;
  }
  const object = isPlainObject(value) ? { ...value } : {};
  object[key] = setPath(object[key], rest, next);
  return object;
}

function deleteAtPath(value, path) {
  if (!path.length) return value;
  const key = path[0];
  const rest = path.slice(1);
  if (!path.length) return value;
  if (Array.isArray(value)) {
    const array = value.slice();
    if (typeof key === "number") {
      const position = key < 0 ? array.length + key : key;
      if (rest.length) array[position] = deleteAtPath(array[position], rest);
      else if (position >= 0 && position < array.length) array.splice(position, 1);
    }
    return array;
  }
  if (isPlainObject(value)) {
    const object = { ...value };
    if (rest.length) object[key] = deleteAtPath(object[key], rest);
    else delete object[key];
    return object;
  }
  return value;
}

function deepContains(value, target) {
  if (typeof value === "string" && typeof target === "string") return value.includes(target);
  if (Array.isArray(value) && Array.isArray(target)) {
    return target.every((item) => value.some((candidate) => deepContains(candidate, item)));
  }
  if (isPlainObject(value) && isPlainObject(target)) {
    return Object.keys(target).every(
      (key) => Object.prototype.hasOwnProperty.call(value, key) && deepContains(value[key], target[key]),
    );
  }
  return deepEqual(value, target);
}

function mergeObjects(left, right, deep) {
  const out = { ...left };
  for (const key of Object.keys(right)) {
    if (deep && isPlainObject(out[key]) && isPlainObject(right[key])) {
      out[key] = mergeObjects(out[key], right[key], true);
    } else {
      out[key] = right[key];
    }
  }
  return out;
}

function addValues(left, right) {
  if (left === null || left === undefined) return right;
  if (right === null || right === undefined) return left;
  if (typeof left === "number" && typeof right === "number") return left + right;
  if (typeof left === "string" && typeof right === "string") return left + right;
  if (Array.isArray(left) && Array.isArray(right)) return left.concat(right);
  if (isPlainObject(left) && isPlainObject(right)) return mergeObjects(left, right, false);
  throw new JqError(`不能把 ${typeName(left)} 和 ${typeName(right)} 相加`);
}

function subtractValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.filter((item) => !right.some((other) => deepEqual(item, other)));
  }
  throw new JqError(`不能把 ${typeName(left)} 和 ${typeName(right)} 相减`);
}

function multiplyValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return left * right;
  if (isPlainObject(left) && isPlainObject(right)) return mergeObjects(left, right, true);
  throw new JqError(`不能把 ${typeName(left)} 和 ${typeName(right)} 相乘`);
}

function divideValues(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    if (right === 0) throw new JqError("不能除以 0");
    return left / right;
  }
  if (typeof left === "string" && typeof right === "string") {
    if (right === "") return left.split("");
    return left.split(right);
  }
  throw new JqError(`不能把 ${typeName(left)} 和 ${typeName(right)} 相除`);
}

function moduloValues(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    if (right === 0) throw new JqError("不能对 0 取模");
    return left % right;
  }
  throw new JqError("取模需要两个数字");
}

function binaryValues(op, left, right) {
  switch (op) {
    case "+":
      return addValues(left, right);
    case "-":
      return subtractValues(left, right);
    case "*":
      return multiplyValues(left, right);
    case "/":
      return divideValues(left, right);
    case "%":
      return moduloValues(left, right);
    case "==":
      return deepEqual(left, right);
    case "!=":
      return !deepEqual(left, right);
    case "<":
      return compareValues(left, right) < 0;
    case "<=":
      return compareValues(left, right) <= 0;
    case ">":
      return compareValues(left, right) > 0;
    case ">=":
      return compareValues(left, right) >= 0;
    case "and":
      return truthy(left) && truthy(right);
    case "or":
      return truthy(left) || truthy(right);
    default:
      throw new JqError(`未知运算符 ${op}`);
  }
}

function flattenArray(value, depth, out) {
  if (depth > 0 && Array.isArray(value)) {
    for (const item of value) flattenArray(item, depth - 1, out);
  } else {
    out.push(value);
  }
}

function compareByKey(left, right) {
  return compareValues(left.key, right.key);
}

function entriesOf(value) {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({ key: index, value: item }));
  }
  if (isPlainObject(value)) {
    return Object.keys(value).map((key) => ({ key, value: value[key] }));
  }
  throw new JqError(`to_entries 需要数组或对象，实际是 ${typeName(value)}`);
}

function objectFromEntries(value) {
  requireArray(value, "from_entries");
  const out = {};
  for (const entry of value) {
    if (!isPlainObject(entry)) throw new JqError("from_entries 的每一项都需要是对象");
    const key =
      entry.key !== undefined
        ? entry.key
        : entry.Key !== undefined
          ? entry.Key
          : entry.name !== undefined
            ? entry.name
            : entry.Name;
    const item = entry.value !== undefined ? entry.value : entry.Value;
    if (key === undefined) throw new JqError("from_entries 的每一项都需要 key");
    out[String(key)] = item;
  }
  return out;
}

function regexFlags(flags) {
  if (!flags) return "";
  let out = "";
  for (const flag of String(flags)) {
    if ("gimsuy".includes(flag) && !out.includes(flag)) out += flag;
  }
  return out;
}

function matchObject(match, input) {
  const captures = [];
  for (let i = 1; i < match.length; i += 1) {
    const text = match[i];
    if (text === undefined) continue;
    captures.push({
      offset: match.index + (match[0].indexOf(text) >= 0 ? match[0].indexOf(text) : 0),
      length: text.length,
      string: text,
      name: null,
    });
  }
  return {
    offset: match.index,
    length: match[0].length,
    string: match[0],
    captures,
  };
}

function jqOrderedKeys(value) {
  return Object.keys(value).sort(compareValues);
}

function callFunction(name, args, input, ctx) {
  switch (name) {
    case "empty":
      return [];
    case "not":
      return [!truthy(input)];
    case "length": {
      if (input === null || input === undefined) return [0];
      if (typeof input === "string") return [input.length];
      if (Array.isArray(input)) return [input.length];
      if (isPlainObject(input)) return [Object.keys(input).length];
      if (typeof input === "number") return [Math.abs(input)];
      throw new JqError(`length 不支持 ${typeName(input)}`);
    }
    case "utf8bytelength":
      return [new TextEncoder().encode(requireString(input, "utf8bytelength")).length];
    case "type":
      return [typeName(input)];
    case "values":
      return input === null || input === undefined ? [] : [input];
    case "arrays":
      return Array.isArray(input) ? [input] : [];
    case "objects":
      return isPlainObject(input) ? [input] : [];
    case "iterables":
      return Array.isArray(input) || isPlainObject(input) ? [input] : [];
    case "numbers":
      return typeof input === "number" ? [input] : [];
    case "strings":
      return typeof input === "string" ? [input] : [];
    case "booleans":
      return typeof input === "boolean" ? [input] : [];
    case "nulls":
      return input === null ? [null] : [];
    case "keys":
    case "keys_unsorted": {
      if (Array.isArray(input)) return [input.map((_item, index) => index)];
      if (isPlainObject(input)) {
        return [name === "keys" ? Object.keys(input).sort(compareValues) : Object.keys(input)];
      }
      throw new JqError(`keys 需要数组或对象，实际是 ${typeName(input)}`);
    }
    case "tostring":
      return [toText(input)];
    case "tonumber":
      if (typeof input === "number") return [input];
      if (typeof input === "string") {
        const value = Number(input);
        if (Number.isFinite(value)) return [value];
        throw new JqError(`不能把 ${jsonStringify(input)} 转成数字`);
      }
      throw new JqError(`tonumber 需要数字或字符串，实际是 ${typeName(input)}`);
    case "tojson":
      return [jsonStringify(input)];
    case "fromjson":
      try {
        return [JSON.parse(requireString(input, "fromjson"))];
      } catch (error) {
        throw new JqError(`fromjson 解析失败：${error.message}`);
      }
    case "ascii_downcase":
      return [requireString(input, "ascii_downcase").toLowerCase()];
    case "ascii_upcase":
      return [requireString(input, "ascii_upcase").toUpperCase()];
    case "ltrimstr": {
      const prefix = requireString(firstOutput(args[0], input, ctx), "ltrimstr");
      const text = requireString(input, "ltrimstr");
      return [text.startsWith(prefix) ? text.slice(prefix.length) : text];
    }
    case "rtrimstr": {
      const suffix = requireString(firstOutput(args[0], input, ctx), "rtrimstr");
      const text = requireString(input, "rtrimstr");
      return [text.endsWith(suffix) ? text.slice(0, text.length - suffix.length) : text];
    }
    case "startswith": {
      const target = firstOutput(args[0], input, ctx);
      if (typeof input === "string" && typeof target === "string") return [input.startsWith(target)];
      if (Array.isArray(input) && Array.isArray(target)) return [deepContains(input.slice(0, target.length), target)];
      throw new JqError("startswith 需要两个字符串或两个数组");
    }
    case "endswith": {
      const target = firstOutput(args[0], input, ctx);
      if (typeof input === "string" && typeof target === "string") return [input.endsWith(target)];
      if (Array.isArray(input) && Array.isArray(target)) return [deepContains(input.slice(-target.length), target)];
      throw new JqError("endswith 需要两个字符串或两个数组");
    }
    case "split": {
      const separator = requireString(firstOutput(args[0], input, ctx), "split");
      const text = requireString(input, "split");
      return [separator === "" ? text.split("") : text.split(separator)];
    }
    case "join": {
      const separator = toText(firstOutput(args[0], input, ctx));
      const array = requireArray(input, "join");
      return [array.map((item) => (item === null || item === undefined ? "" : toText(item))).join(separator)];
    }
    case "contains":
    case "inside": {
      const target = firstOutput(args[0], input, ctx);
      return name === "contains" ? [deepContains(input, target)] : [deepContains(target, input)];
    }
    case "add": {
      const array = requireArray(input, "add");
      if (!array.length) return [null];
      let total = array[0];
      for (let i = 1; i < array.length; i += 1) total = addValues(total, array[i]);
      return [total];
    }
    case "flatten": {
      const depth = args.length ? firstOutput(args[0], input, ctx) : null;
      const limit = typeof depth === "number" ? depth : Infinity;
      const out = [];
      flattenArray(input, limit, out);
      return [out];
    }
    case "reverse": {
      if (Array.isArray(input)) return [input.slice().reverse()];
      if (typeof input === "string") return [input.split("").reverse().join("")];
      throw new JqError(`reverse 需要数组或字符串，实际是 ${typeName(input)}`);
    }
    case "sort": {
      const array = requireArray(input, "sort");
      return [array.slice().sort(compareValues)];
    }
    case "sort_by": {
      const array = requireArray(input, "sort_by");
      const decorated = array.map((value) => ({ value, key: firstOutput(args[0], value, ctx) }));
      decorated.sort(compareByKey);
      return [decorated.map((item) => item.value)];
    }
    case "group_by": {
      const array = requireArray(input, "group_by");
      const decorated = array.map((value) => ({ value, key: firstOutput(args[0], value, ctx) }));
      decorated.sort(compareByKey);
      const groups = [];
      let current = null;
      let currentKey;
      for (const item of decorated) {
        if (current === null || compareValues(item.key, currentKey) !== 0) {
          current = [];
          currentKey = item.key;
          groups.push(current);
        }
        current.push(item.value);
      }
      return [groups];
    }
    case "unique": {
      const array = requireArray(input, "unique");
      const sorted = array.slice().sort(compareValues);
      const out = [];
      for (const item of sorted) {
        if (!out.length || !deepEqual(out[out.length - 1], item)) out.push(item);
      }
      return [out];
    }
    case "unique_by": {
      const array = requireArray(input, "unique_by");
      const decorated = array.map((value) => ({ value, key: firstOutput(args[0], value, ctx) }));
      decorated.sort(compareByKey);
      const out = [];
      let lastKey;
      for (const item of decorated) {
        if (!out.length || compareValues(item.key, lastKey) !== 0) {
          out.push(item.value);
          lastKey = item.key;
        }
      }
      return [out];
    }
    case "min":
    case "max": {
      const array = requireArray(input, name);
      if (!array.length) return [null];
      let best = array[0];
      for (const item of array.slice(1)) {
        const order = compareValues(item, best);
        if ((name === "min" && order < 0) || (name === "max" && order > 0)) best = item;
      }
      return [best];
    }
    case "min_by":
    case "max_by": {
      const array = requireArray(input, name);
      if (!array.length) return [null];
      let best = array[0];
      let bestKey = firstOutput(args[0], best, ctx);
      for (const item of array.slice(1)) {
        const key = firstOutput(args[0], item, ctx);
        const order = compareValues(key, bestKey);
        if ((name === "min_by" && order < 0) || (name === "max_by" && order > 0)) {
          best = item;
          bestKey = key;
        }
      }
      return [best];
    }
    case "map": {
      if (Array.isArray(input)) {
        const out = [];
        for (const item of input) out.push(...evalNode(args[0], item, ctx));
        return [out];
      }
      if (isPlainObject(input)) {
        const out = {};
        for (const key of Object.keys(input)) {
          const values = evalNode(args[0], input[key], ctx);
          if (values.length) out[key] = values[0];
        }
        return [out];
      }
      throw new JqError(`map 需要数组或对象，实际是 ${typeName(input)}`);
    }
    case "map_values": {
      if (Array.isArray(input)) {
        const out = [];
        for (const item of input) {
          const values = evalNode(args[0], item, ctx);
          if (values.length) out.push(values[0]);
        }
        return [out];
      }
      if (isPlainObject(input)) {
        const out = {};
        for (const key of Object.keys(input)) {
          const values = evalNode(args[0], input[key], ctx);
          if (values.length) out[key] = values[0];
        }
        return [out];
      }
      throw new JqError(`map_values 需要数组或对象，实际是 ${typeName(input)}`);
    }
    case "select": {
      const condition = evalNode(args[0], input, ctx);
      return condition.some(truthy) ? [input] : [];
    }
    case "any":
    case "all": {
      const array = Array.isArray(input) ? input : isPlainObject(input) ? Object.values(input) : null;
      if (!array) throw new JqError(`${name} 需要数组或对象，实际是 ${typeName(input)}`);
      if (!args.length) {
        return [name === "any" ? array.some(truthy) : array.every(truthy)];
      }
      const matches = array.map((item) => evalNode(args[0], item, ctx).some(truthy));
      return [name === "any" ? matches.some(Boolean) : matches.every(Boolean)];
    }
    case "first": {
      if (args.length) {
        const values = evalNode(args[0], input, ctx);
        return values.length ? [values[0]] : [];
      }
      if (Array.isArray(input)) return input.length ? [input[0]] : [];
      if (typeof input === "string") return input.length ? [input[0]] : [];
      throw new JqError(`first 需要数组或字符串，实际是 ${typeName(input)}`);
    }
    case "last": {
      if (args.length) {
        const values = evalNode(args[0], input, ctx);
        return values.length ? [values[values.length - 1]] : [];
      }
      if (Array.isArray(input)) return input.length ? [input[input.length - 1]] : [];
      if (typeof input === "string") return input.length ? [input[input.length - 1]] : [];
      throw new JqError(`last 需要数组或字符串，实际是 ${typeName(input)}`);
    }
    case "nth": {
      const n = firstOutput(args[0], input, ctx);
      if (typeof n !== "number") throw new JqError("nth 的第一个参数需要数字");
      const values = args.length > 1 ? evalNode(args[1], input, ctx) : Array.isArray(input) ? input : null;
      if (!values) throw new JqError("nth 需要数组或第二个参数");
      const position = n < 0 ? values.length + n : n;
      return position >= 0 && position < values.length ? [values[position]] : [];
    }
    case "limit": {
      const n = firstOutput(args[0], input, ctx);
      if (typeof n !== "number") throw new JqError("limit 的第一个参数需要数字");
      return evalNode(args[1], input, ctx).slice(0, Math.max(0, n));
    }
    case "range": {
      const values = args.map((arg) => firstOutput(arg, input, ctx));
      let start = 0;
      let end = values[0];
      let step = 1;
      if (values.length >= 2) {
        start = values[0];
        end = values[1];
      }
      if (values.length >= 3) step = values[2];
      if (typeof end !== "number" || typeof start !== "number" || typeof step !== "number") {
        throw new JqError("range 的参数都需要数字");
      }
      if (step === 0) throw new JqError("range 的步长不能是 0");
      const out = [];
      if (step > 0) {
        for (let value = start; value < end; value += step) out.push(value);
      } else {
        for (let value = start; value > end; value += step) out.push(value);
      }
      return out;
    }
    case "to_entries":
      return [entriesOf(input)];
    case "from_entries":
      return [objectFromEntries(input)];
    case "with_entries": {
      const entries = entriesOf(input);
      const out = [];
      for (const entry of entries) out.push(...evalNode(args[0], entry, ctx));
      return [objectFromEntries(out)];
    }
    case "has": {
      const key = firstOutput(args[0], input, ctx);
      if (Array.isArray(input)) return [typeof key === "number" && key >= 0 && key < input.length];
      if (isPlainObject(input)) return [Object.prototype.hasOwnProperty.call(input, String(key))];
      if (typeof input === "string") return [typeof key === "number" && key >= 0 && key < input.length];
      throw new JqError(`has 需要数组、对象或字符串，实际是 ${typeName(input)}`);
    }
    case "in": {
      const container = firstOutput(args[0], input, ctx);
      if (Array.isArray(container)) return [typeof input === "number" && input >= 0 && input < container.length];
      if (isPlainObject(container)) return [Object.prototype.hasOwnProperty.call(container, String(input))];
      throw new JqError(`in 需要一个数组或对象，实际是 ${typeName(container)}`);
    }
    case "paths":
    case "leaf_paths": {
      const out = [];
      collectPaths(input, out, [], name === "leaf_paths");
      return [out];
    }
    case "getpath":
      return [getPath(input, firstOutput(args[0], input, ctx))];
    case "setpath": {
      const path = firstOutput(args[0], input, ctx);
      if (!Array.isArray(path)) throw new JqError("setpath 的第一个参数需要路径数组");
      return [setPath(input, path, firstOutput(args[1], input, ctx))];
    }
    case "delpaths": {
      const paths = firstOutput(args[0], input, ctx);
      if (!Array.isArray(paths)) throw new JqError("delpaths 需要一个路径数组");
      let out = cloneJson(input);
      for (const path of paths.slice().sort((a, b) => b.length - a.length)) {
        if (Array.isArray(path)) out = deleteAtPath(out, path);
      }
      return [out];
    }
    case "test": {
      const pattern = requireString(firstOutput(args[0], input, ctx), "test");
      const flags = args.length > 1 ? requireString(firstOutput(args[1], input, ctx), "test") : "";
      const text = requireString(input, "test");
      return [new RegExp(pattern, regexFlags(flags)).test(text)];
    }
    case "match": {
      const pattern = requireString(firstOutput(args[0], input, ctx), "match");
      const flags = args.length > 1 ? requireString(firstOutput(args[1], input, ctx), "match") : "";
      const text = requireString(input, "match");
      const match = new RegExp(pattern, regexFlags(flags)).exec(text);
      return match ? [matchObject(match, text)] : [];
    }
    case "capture": {
      const pattern = requireString(firstOutput(args[0], input, ctx), "capture");
      const flags = args.length > 1 ? requireString(firstOutput(args[1], input, ctx), "capture") : "";
      const text = requireString(input, "capture");
      const match = new RegExp(pattern, regexFlags(flags)).exec(text);
      if (!match) return [];
      const out = {};
      for (const key of Object.keys(match.groups || {})) out[key] = match.groups[key];
      return [out];
    }
    case "sub":
    case "gsub": {
      const pattern = requireString(firstOutput(args[0], input, ctx), name);
      const replacement = toText(firstOutput(args[1], input, ctx));
      const flags = args.length > 2 ? requireString(firstOutput(args[2], input, ctx), name) : "";
      const text = requireString(input, name);
      const regex = new RegExp(pattern, regexFlags(flags) + (name === "gsub" ? "g" : ""));
      return [text.replace(regex, replacement)];
    }
    case "error":
      throw new JqError(args.length ? toText(firstOutput(args[0], input, ctx)) : "error");
    case "path": {
      const out = [];
      collectPaths(input, out, [], false);
      return out;
    }
    default:
      throw new JqError(`未知函数 \`${name}\`；支持 keys、length、map、select、sort_by、group_by、to_entries 等`);
  }
}

function evalNode(node, input, ctx) {
  switch (node.type) {
    case "identity":
      return [input];
    case "literal":
      return [node.value];
    case "recurse": {
      const out = [];
      walk(input, out);
      return out;
    }
    case "apply": {
      const bases = evalNode(node.base, input, ctx);
      const out = [];
      for (const base of bases) out.push(...applySegment(base, node.segment, ctx));
      return out;
    }
    case "pipe": {
      const out = [];
      for (const value of evalNode(node.left, input, ctx)) {
        out.push(...evalNode(node.right, value, ctx));
      }
      return out;
    }
    case "comma": {
      const out = [];
      for (const item of node.items) out.push(...evalNode(item, input, ctx));
      return out;
    }
    case "alternative": {
      const left = evalNode(node.left, input, ctx).filter(truthy);
      return left.length ? left : evalNode(node.right, input, ctx);
    }
    case "binary": {
      const left = evalNode(node.left, input, ctx);
      const right = evalNode(node.right, input, ctx);
      const out = [];
      for (const a of left) for (const b of right) out.push(binaryValues(node.op, a, b));
      return out;
    }
    case "unary": {
      if (node.op === "not") return [!truthy(input)];
      const value = firstOutput(node.expr, input, ctx);
      if (typeof value !== "number") throw new JqError("一元负号需要一个数字");
      return [-value];
    }
    case "array": {
      if (!node.expr) return [[]];
      return [evalNode(node.expr, input, ctx)];
    }
    case "object": {
      const out = {};
      for (const entry of node.entries) {
        const key = entry.keyName !== null ? entry.keyName : toText(firstOutput(entry.keyExpr, input, ctx));
        const values = evalNode(entry.value, input, ctx);
        if (values.length) out[key] = values[0];
      }
      return [out];
    }
    case "if": {
      const condition = evalNode(node.condition, input, ctx);
      return condition.some(truthy)
        ? evalNode(node.consequent, input, ctx)
        : evalNode(node.alternate, input, ctx);
    }
    case "tryEmpty": {
      try {
        return evalNode(node.expr, input, ctx);
      } catch (error) {
        if (error instanceof JqError) return [];
        throw error;
      }
    }
    case "call":
      return callFunction(node.name, node.args, input, ctx);
    case "format": {
      if (node.name === "json") return [jsonStringify(input)];
      if (node.name === "text") return [toText(input)];
      if (node.name === "uri") return [encodeURIComponent(requireString(input, "@uri"))];
      if (node.name === "csv" || node.name === "tsv") {
        const array = requireArray(input, `@${node.name}`);
        const separator = node.name === "csv" ? "," : "\t";
        return [
          array
            .map((item) => {
              if (item === null || item === undefined) return "";
              const text = toText(item);
              if (node.name === "tsv") return text.replace(/\t/g, "\\t");
              return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
            })
            .join(separator),
        ];
      }
      throw new JqError(`暂不支持格式 @${node.name}`);
    }
    default:
      throw new JqError("内部错误：未知的语法节点");
  }
}

/**
 * Compiles and evaluates a jq expression against a JSON value.
 *
 * Returns the output stream. Throws JqError with a human-readable message for
 * both syntax and runtime errors.
 */
export function evaluate(source, input, options = {}) {
  const ast = typeof source === "string" ? compile(source) : source;
  const ctx = { maxOutputs: options.maxOutputs || 100000 };
  const values = evalNode(ast, input, ctx);
  if (values.length > ctx.maxOutputs) {
    throw new JqError(`查询结果超过 ${ctx.maxOutputs} 条，请用 limit(...) 或更精确的路径缩小范围`);
  }
  return values;
}

/** A compact one-line description of a syntax error, for the UI. */
export function jqErrorMessage(error) {
  if (error instanceof JqError) return error.message;
  return error && error.message ? error.message : String(error);
}
