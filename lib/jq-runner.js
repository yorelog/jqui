// jq execution through the bundled jq binary, with the JavaScript subset as a
// fallback for hosts that do not ship one.
//
// Running real jq buys the whole language: variables, reduce/foreach, user
// functions, regex helpers and all of the builtins. The filter and the input
// travel as files, so no expression ever needs shell quoting.

import * as fs from "fs/promises";
import path from "path";
import process from "process";
import { JqError, evaluate } from "./jq.js";
import { resolveTool } from "./http.js";
import { msg } from "./i18n.js";

const MAX_RESULTS = 20000;
const MAX_ERROR_CHARS = 900;

let fallbackReason = null;

export function jqIsBundledFallback() {
  return fallbackReason !== null;
}

export async function checkJq() {
  try {
    const command = await resolveTool("jq");
    const result = await process.run(command, ["--version"], { timeoutMs: 8000 });
    return result.code === 0;
  } catch (error) {
    return false;
  }
}

function cleanError(stderr, code) {
  let text = String(stderr || "").trim();
  if (!text) return msg(`jq 退出码 ${code}`, `jq exited with ${code}`);
  text = text.replace(/\(at [^)]*:\d+\):\s*/g, "");
  text = text.replace(/\(at <[^>]*>\):\s*/g, "");
  text = text.replace(
    /\bat <top-level>, line (\d+), column (\d+):/g,
    msg("第 $1 行第 $2 列：", "line $1, column $2: "),
  );
  text = text.replace(/^jq: error:?\s*/gm, "");
  text = text.replace(/^jq: 1 compile error\s*$/gm, "").trim();
  if (text.length > MAX_ERROR_CHARS) text = text.slice(0, MAX_ERROR_CHARS) + "\n…";
  return text;
}

async function removeIfPresent(file) {
  try {
    if (await fs.exists(file)) await fs.unlink(file);
  } catch (error) {
    // Best effort.
  }
}

/**
 * Evaluates a jq expression and returns its output stream.
 * Resolves to `{ values, backend }`.
 */
export async function runJq(expression, input, options = {}) {
  const dataDir = process.dataDir;
  if (!dataDir) {
    return evaluateWithBuiltin(expression, input);
  }

  const filter = String(expression ?? "").trim() || ".";
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputFile = path.join(dataDir, `jqui-${stamp}.json`);
  const filterFile = path.join(dataDir, `jqui-${stamp}.jq`);

  try {
    const json = JSON.stringify(input === undefined ? null : input);
    await fs.writeFile(inputFile, json === undefined ? "null" : json);
    await fs.writeFile(filterFile, filter + "\n");

    const command = await resolveTool("jq");
    let result;
    try {
      result = await process.run(command, ["-c", "-f", filterFile, inputFile], { timeoutMs: 30000 });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message.includes("program not found")) {
        fallbackReason = msg("找不到 jq；已改用内置 jq 子集", "jq was not found; using the built-in subset");
        return evaluateWithBuiltin(expression, input);
      }
      throw new JqError(msg(`无法运行 jq：${message}`, `Could not run jq: ${message}`));
    }

    if (result.code !== 0) {
      throw new JqError(cleanError(result.stderr, result.code));
    }
    fallbackReason = null;

    const lines = String(result.stdout || "")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    const values = [];
    for (const line of lines) {
      if (values.length >= (options.maxResults || MAX_RESULTS)) {
        throw new JqError(
          msg(
            `jq 返回了超过 ${options.maxResults || MAX_RESULTS} 条结果，请用 limit(...) 或更精确的查询缩小范围`,
            `jq returned more than ${options.maxResults || MAX_RESULTS} results; use limit(...) or a narrower query`,
          ),
        );
      }
      try {
        values.push(JSON.parse(line));
      } catch (error) {
        throw new JqError(
          msg(
            `jq 输出无法解析为 JSON：${line.slice(0, 200)}`,
            `jq output is not valid JSON: ${line.slice(0, 200)}`,
          ),
        );
      }
    }
    return { values, backend: "jq" };
  } finally {
    await removeIfPresent(inputFile);
    await removeIfPresent(filterFile);
  }
}

function evaluateWithBuiltin(expression, input) {
  try {
    const values = evaluate(expression, input, { maxOutputs: 100000 });
    return { values, backend: "builtin" };
  } catch (error) {
    if (error instanceof JqError) throw error;
    throw new JqError(error && error.message ? error.message : String(error));
  }
}
