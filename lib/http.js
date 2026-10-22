// HTTP execution through the bundled xh binary.
//
// gpui-shell's native fetch is capability-gated per exact host, method and
// path, which cannot support an arbitrary-URL API client. xh is a small,
// script-friendly HTTP client with real TLS, proxies and redirects; it is
// shipped beside main.js and granted through `capabilities.fs.execute`.
//
// The request body is written to a data-directory file and passed as `@file`,
// so a large body never has to fit on a command line.

import * as fs from "fs/promises";
import path from "path";
import process from "process";
import { bundledToolPath, fallbackCommand, managedToolPath, WINDOWS } from "./runtime.js";
import { msg } from "./i18n.js";
import { parseJsonText } from "./json-view.js";

const DEFAULT_TIMEOUT_SECONDS = 60;

export async function resolveTool(name) {
  const managed = managedToolPath(name);
  if (managed) {
    try {
      if (await fs.exists(managed)) return managed;
    } catch (error) {
      // Fall through to the bundled copy.
    }
  }
  const bundled = bundledToolPath(name);
  try {
    if (await fs.exists(bundled)) return bundled;
  } catch (error) {
    // Fall through to PATH.
  }
  return fallbackCommand(name);
}

export function normalizeUrl(raw) {
  let url = String(raw ?? "").trim();
  if (!url) throw new Error(msg("请先填写请求 URL", "Enter a request URL first"));
  if (/\s/.test(url)) throw new Error(msg("URL 里不能有空白字符", "URL must not contain whitespace"));
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    url = "https://" + url;
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(msg("只支持 http:// 和 https:// 请求", "Only http:// and https:// requests are supported"));
  }
  const rest = url.replace(/^https?:\/\//i, "");
  if (!rest || rest.startsWith("/")) {
    throw new Error(
      msg(
        "URL 缺少主机名，例如 https://api.example.com/v1/items",
        "URL is missing a host, e.g. https://api.example.com/v1/items",
      ),
    );
  }
  return url;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Parses the headers textarea: one `Name: value` pair per line. */
export function parseHeaderLines(text) {
  const headers = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new Error(
        msg(
          `请求头第 ${index + 1} 行缺少冒号，应写成 \`Name: value\``,
          `Header line ${index + 1} is missing a colon; use \`Name: value\``,
        ),
      );
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!HEADER_NAME.test(name)) {
      throw new Error(
        msg(
          `请求头第 ${index + 1} 行的名称 \`${name}\` 不合法`,
          `Invalid header name \`${name}\` on line ${index + 1}`,
        ),
      );
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(
        msg(
          `请求头第 ${index + 1} 行的值不能包含换行`,
          `Header value on line ${index + 1} must not contain a newline`,
        ),
      );
    }
    headers.push({ name, value });
  }
  return headers;
}

function hasHeader(headers, name) {
  return headers.some((header) => header.name.toLowerCase() === name.toLowerCase());
}

/**
 * The headers xh will send, plus Jqui's defaults: a User-Agent when none is
 * set, and `application/json` for a JSON-looking body with no Content-Type.
 */
export function buildEffectiveHeaders(headers, body) {
  const out = headers.map((header) => ({ name: header.name, value: header.value }));
  if (!hasHeader(out, "User-Agent")) {
    out.push({ name: "User-Agent", value: "Jqui/0.1.0" });
  }
  if (body && body.length && !hasHeader(out, "Content-Type")) {
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      out.push({ name: "Content-Type", value: "application/json" });
    }
  }
  return out;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function bodyFrom(value) {
  return value === null || value === undefined ? "" : String(value);
}

/** The equivalent curl command, for the cURL tab. */
export function buildCurlPreview(request) {
  const headers = buildEffectiveHeaders(request.headers || [], bodyFrom(request.body));
  const parts = ["curl"];
  if (request.followRedirects) parts.push("-L");
  if (request.insecure) parts.push("-k");
  parts.push("-X", request.method);
  for (const header of headers) {
    parts.push("-H", shellQuote(`${header.name}: ${header.value}`));
  }
  const body = bodyFrom(request.body);
  if (body) {
    const preview = body.length > 2000 ? body.slice(0, 2000) + "\n... (body truncated in preview)" : body;
    parts.push("--data-binary", shellQuote(preview));
  }
  parts.push(shellQuote(request.url));
  return parts.join(" \\\n  ");
}

function headerItem(header, valueFile) {
  // xh reads an `@`-prefixed request-item value from a file. Routing every
  // header value through a file keeps quotes, percent signs and cmd.exe
  // metacharacters out of the Windows batch command line entirely.
  return `${header.name}:@${valueFile}`;
}

function splitResponse(stdout) {
  const crlf = stdout.indexOf("\r\n\r\n");
  const lf = stdout.indexOf("\n\n");
  let index = -1;
  let separator = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    index = crlf;
    separator = 4;
  } else if (lf >= 0) {
    index = lf;
    separator = 2;
  }

  if (index < 0) {
    if (/^HTTP\/[\d.]+\s+\d{3}/i.test(stdout)) {
      return { headersText: stdout, body: "" };
    }
    return { headersText: "", body: stdout };
  }
  return { headersText: stdout.slice(0, index), body: stdout.slice(index + separator) };
}

function parseHeaders(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const statusLine = lines.shift() || "";
  const headers = [];

  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && headers.length) {
      headers[headers.length - 1].value += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }

  const statusMatch = statusLine.match(/^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/i);
  const statusText = statusMatch ? statusMatch[2].trim() : "";
  const display = [statusLine]
    .concat(headers.map((header) => `${header.name}: ${header.value}`))
    .filter((line) => line.trim())
    .join("\n");
  return { statusLine, statusText, headers, text: display };
}

function headerValue(headers, name) {
  const match = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return match ? match.value : "";
}

function xhFailure(code, stderr) {
  const detail = String(stderr || "").trim();
  const lower = detail.toLowerCase();
  let hint = "";
  if (lower.includes("timed out") || lower.includes("timeout")) {
    hint = msg("请求超时", "request timed out");
  } else if (lower.includes("dns") || lower.includes("resolve")) {
    hint = msg("无法解析主机名", "could not resolve host");
  } else if (lower.includes("certificate") || lower.includes("tls") || lower.includes("ssl")) {
    hint = msg(
      "TLS 证书校验失败；自签名证书可打开“跳过 TLS 校验”",
      "TLS certificate verification failed; enable “Skip TLS verification” for a self-signed certificate",
    );
  } else if (lower.includes("connection refused") || lower.includes("connect")) {
    hint = msg("无法连接到服务器", "could not connect to the server");
  }
  return `${msg(`xh 退出码 ${code}`, `xh exited with ${code}`)}${hint ? ` (${hint})` : ""}${detail ? `\n${detail}` : ""}`;
}

async function removeIfPresent(file) {
  try {
    if (await fs.exists(file)) await fs.unlink(file);
  } catch (error) {
    // A leftover temp file is not worth failing a request over.
  }
}

// On Windows gpui-shell starts a child with an empty environment, and Winsock
// refuses to initialise without SystemRoot. cmd.exe is the smallest reliable
// way to give xh back the handful of variables it needs: the batch file below
// sets them, then runs xh with fully quoted arguments.
function batchQuote(value) {
  const text = String(value);
  if (/[\r\n"]/.test(text)) {
    throw new Error(
      msg(
        "在 Windows 上，URL 不能包含双引号或换行；URL 里的双引号请写成 %22。",
        "On Windows a URL cannot contain a double quote or newline; encode a quote as %22.",
      ),
    );
  }
  return '"' + text.replace(/%/g, "%%") + '"';
}

function proxyEnvironment() {
  const names = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ];
  const out = [];
  for (const name of names) {
    const value = process.env[name];
    if (value) out.push(`${name}=${value}`);
  }
  return out;
}

async function runXh(command, args, timeoutSec) {
  const options = { timeoutMs: (timeoutSec + 15) * 1000 };

  if (!WINDOWS) {
    const environment = proxyEnvironment();
    if (environment.length) {
      return process.run("/usr/bin/env", environment.concat([command], args), options);
    }
    return process.run(command, args, options);
  }

  const dataDir = process.dataDir;
  const script = path.join(dataDir, `jqui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cmd`);
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const environment = new Map();
  environment.set("SystemRoot", systemRoot);
  environment.set("windir", systemRoot);
  const temp = process.env.TEMP || process.env.TMP || dataDir;
  environment.set("TEMP", temp);
  environment.set("TMP", temp);
  for (const name of [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    const value = process.env[name];
    if (value) environment.set(name, value);
  }
  const hostPath = process.env.PATH || process.env.Path;
  const basePath = `${systemRoot}\\System32;${systemRoot}`;
  environment.set("PATH", hostPath ? `${basePath};${hostPath}` : basePath);

  const lines = ["@echo off", "setlocal"];
  for (const [name, value] of environment) {
    if (/[\r\n"]/.test(value)) continue;
    lines.push(`set "${name}=${value.replace(/%/g, "%%")}"`);
  }
  lines.push([command].concat(args).map(batchQuote).join(" "));

  await fs.writeFile(script, lines.join("\r\n") + "\r\n");
  try {
    const cmd = process.env.ComSpec || process.env.COMSPEC || `${systemRoot}\\System32\\cmd.exe`;
    return await process.run(cmd, ["/d", "/c", script], { ...options, cwd: dataDir });
  } finally {
    await removeIfPresent(script);
  }
}

/**
 * Downloads a URL to `destination` with xh. The file is written by the child
 * process because this runtime's `fs.writeFile` does not persist binary data.
 */
export async function downloadFileWithXh(url, destination, timeoutSec = 300) {
  const command = await resolveTool("xh");
  const args = [
    "--download",
    "--output",
    destination,
    "--ignore-stdin",
    "--ignore-netrc",
    "--native-tls",
    "--follow",
    "--timeout",
    "60",
    url,
  ];
  const result = await runXh(command, args, timeoutSec);
  if (result.code !== 0) {
    const detail = String(result.stderr || "").trim();
    throw new Error(
      msg(
        `下载失败${detail ? `：${detail}` : `（xh 退出码 ${result.code}）`}`,
        `Download failed${detail ? `: ${detail}` : ` (xh exited with ${result.code})`}`,
      ),
    );
  }
  const stat = await fs.stat(destination);
  if (!stat.size) throw new Error(msg("下载结果为空文件", "Downloaded file is empty"));
  return stat.size;
}

/**
 * Sends one request with xh.
 *
 * `request` is `{ method, url, headers: [{name,value}], body, followRedirects,
 * insecure, timeoutSec }`.
 */
export async function performRequest(request) {
  const dataDir = process.dataDir;
  if (!dataDir) {
    throw new Error(
      msg(
        "这个应用没有数据目录，无法为 xh 准备请求体文件",
        "This application has no data directory, so xh cannot stage the request body",
      ),
    );
  }

  const timeoutSec = Number(request.timeoutSec) > 0 ? Number(request.timeoutSec) : DEFAULT_TIMEOUT_SECONDS;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bodyFile = path.join(dataDir, `jqui-${stamp}.body`);
  const body = bodyFrom(request.body);
  const method = String(request.method || "GET").toUpperCase();
  const headers = buildEffectiveHeaders(request.headers || [], body);
  const headerFiles = headers.map((_header, index) => path.join(dataDir, `jqui-${stamp}-h${index}.txt`));
  const temporary = [bodyFile].concat(headerFiles);

  try {
    if (body) await fs.writeFile(bodyFile, body);
    for (let index = 0; index < headers.length; index += 1) {
      await fs.writeFile(headerFiles[index], headers[index].value);
    }

    const command = await resolveTool("xh");
    const args = [
      "--print=hb",
      "--pretty=none",
      "--no-check-status",
      "--ignore-stdin",
      "--ignore-netrc",
      "--native-tls",
      "--timeout",
      String(Math.min(timeoutSec, 120)),
    ];

    if (request.followRedirects) args.push("--follow", "--max-redirects", "10");
    if (request.insecure) args.push("--verify", "no");

    args.push(method, request.url);
    for (let index = 0; index < headers.length; index += 1) {
      args.push(headerItem(headers[index], headerFiles[index]));
    }
    if (body && method !== "HEAD") args.push(`@${bodyFile}`);

    const startedAt = Date.now();
    let result;
    try {
      result = await runXh(command, args, timeoutSec);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message.includes("program not found")) {
        throw new Error(
          msg(
            "找不到 xh。请把 xh.exe（Windows）或对应平台的 xh 放在应用目录中，或安装到系统 PATH；并确认清单允许执行它（capabilities.fs.execute）。",
            "xh was not found. Put xh.exe (Windows) or the xh binary for your platform in the application directory, or on PATH, and allow capabilities.fs.execute.",
          ),
        );
      }
      throw new Error(msg(`无法运行 xh：${message}`, `Could not run xh: ${message}`));
    }
    const elapsed = Date.now() - startedAt;

    if (result.code !== 0) {
      throw new Error(xhFailure(result.code, result.stderr));
    }

    const stdout = String(result.stdout || "");
    if (!stdout.trim()) {
      throw new Error(
        msg(
          "xh 没有返回内容。请检查 URL，或打开“跳过 TLS 校验”再试。",
          "xh returned no response. Check the URL, or enable “Skip TLS verification” and try again.",
        ),
      );
    }

    const split = splitResponse(stdout);
    const parsed = parseHeaders(split.headersText);
    const responseBody = split.body;
    const json = parseJsonText(responseBody);
    const bytes = new TextEncoder().encode(responseBody).length;
    const status = Number((parsed.statusLine.match(/\s(\d{3})\s?/) || [])[1] || 0);

    return {
      status,
      statusText: parsed.statusText,
      statusLine: parsed.statusLine,
      milliseconds: elapsed,
      bytes,
      url: request.url,
      headers: parsed.headers,
      headersText: parsed.text,
      contentType: headerValue(parsed.headers, "Content-Type"),
      body: responseBody,
      isJson: json.ok,
      json: json.ok ? json.value : null,
      jsonError: json.ok ? null : json.error,
      requestHeaders: headers,
    };
  } finally {
    for (const file of temporary) await removeIfPresent(file);
  }
}

export { DEFAULT_TIMEOUT_SECONDS };
