// Small two-language layer for the interface and for messages raised by the
// request/update helpers.
//
// The UI reads `t(key)` during render, so switching a language only needs a
// notify. Helper modules use `msg(zh, en)` at the point a message is created.

const STORAGE_KEY = "jqui.language.v1";

const ZH = {
  "language.switch": "切换界面语言",

  "request.send": "发送",
  "request.sending": "请求中",
  "request.urlAria": "请求 URL",
  "request.samples": "示例",
  "request.tools": "工具",
  "request.headers": "请求头",
  "request.body": "请求体",
  "request.formatJson": "格式化 JSON",
  "request.headersHint": "每行一个请求头，例如 Authorization: Bearer …",
  "request.bodyHint": "请求体会原样发送；JSON 会自动补上 Content-Type: application/json。",
  "request.followRedirects": "跟随重定向",
  "request.insecure": "跳过 TLS 校验",
  "request.timeout": "超时 60s · 请求体 {size}",
  "request.poweredByXh": "由 xh {version} 执行",
  "request.headersAria": "请求头",
  "request.bodyAria": "请求体",
  "request.formatted": "请求体已格式化",
  "request.invalidJson": "请求体不是合法 JSON",

  "response.tab.body": "响应",
  "response.tab.raw": "原始",
  "response.tab.headers": "响应头",
  "response.tab.curl": "cURL",
  "response.section.body": "响应体",
  "response.section.headers": "响应头",
  "response.copy": "复制",
  "response.clear": "清空",
  "response.failed": "请求失败",
  "response.jqFailed": "jq 执行失败；下面显示原始 JSON",
  "response.xhMissingTitle": "xh 不可用",
  "response.xhMissingBody":
    "未找到可用的 xh。Jqui 通过应用目录里的 xh 发送请求（Windows 下是 xh.exe）。请放入对应平台的 xh 可执行文件，并允许清单中的 capabilities.fs.execute。",
  "response.loading": "正在请求…",
  "response.emptyTitle": "发送一个请求，查看 JSON 响应",
  "response.emptyBody":
    "支持任意方法、URL、请求头和 JSON 请求体；响应可以用 jq 表达式筛选，并在中文原文、Unicode 转义和隐藏之间切换。",
  "response.noResults": "jq 没有返回结果",
  "response.noResultsHint": "试试 `.` 查看整个文档，或 `.items[]` 展开数组。",
  "response.rawTruncated": "原始响应过长，显示已截断；可切换到 jq 或使用“复制”获取完整内容。",
  "response.rawBeautify": "美化 JSON",
  "response.rawBeautifyTooltip": "按 JSON 格式化完整响应（不受 jq 筛选影响）",
  "response.rawFull": "完整响应 · 不应用 jq",
  "response.noHeaders": "没有响应头",
  "response.curlNote": "Jqui 通过 xh 执行；这个 curl 命令可以直接在终端里复现请求。",
  "response.copiedJson": "已复制 JSON",
  "response.copiedRaw": "已复制原始响应",
  "response.copiedHeaders": "已复制响应头",
  "response.copiedCurl": "已复制 cURL 命令",
  "response.copiedResponse": "已复制响应",
  "response.copiedLine": "已复制该行",
  "response.nothing": "没有可复制的内容",
  "response.copyFailed": "复制失败",
  "response.truncatedNote": "… 内容较长，显示已截断；可以复制完整内容。",

  "jq.expressionAria": "jq 查询表达式",
  "jq.run": "运行",
  "jq.help": "语法帮助",
  "jq.helpTitle": "jq 语法速查",
  "jq.pretty": "美化",
  "jq.prettyTooltip": "勾选为 2 空格缩进；取消为紧凑 JSON",
  "jq.sortKeys": "排序键",
  "jq.sortKeysTooltip": "按字段名排序对象",
  "jq.wrap": "换行",
  "jq.wrapTooltip": "长行按窗口宽度自动换行",
  "jq.raw": "原文",
  "jq.escape": "转义",
  "jq.hide": "隐藏",
  "jq.unicode": "Unicode",
  "jq.unicodeTooltip":
    "Unicode 字符显示：原文 / \\uXXXX 转义 / 隐藏；例如中文可以显示为 \\u4e2d\\u6587",
  "jq.rawTooltip": "显示原始 Unicode 字符，例如中文",
  "jq.escapeTooltip": "把中文等非 ASCII 字符转成 JSON 的 \\uXXXX 转义",
  "jq.hideTooltip": "用 · 替换中文等非 ASCII 字符",
  "jq.results": "{count} 个结果",
  "jq.resultsTruncated": "结果 {count} 条（显示前 {max} 条）",
  "jq.noResults": "无结果",
  "jq.cjkCount": "中文 {count} 字",
  "jq.truncated": "显示已截断",
  "jq.builtinNote":
    "当前使用内置 jq 子集：路径、管道、map/select/sort_by 等；把对应平台的 jq 可执行文件放到应用目录可获得完整 jq。",
  "jq.fullNote":
    "由 jq {version} 执行，支持完整 jq 语法：变量、reduce/foreach、自定义函数、正则等。",
  "jq.help.identity": "整个文档",
  "jq.help.field": "取字段",
  "jq.help.expand": "展开数组 / 对象",
  "jq.help.index": "取下标",
  "jq.help.multiple": "多个结果",
  "jq.help.pipe": "管道",
  "jq.help.default": "缺失时使用默认值",
  "jq.help.map": "映射数组",
  "jq.help.filter": "过滤数组",
  "jq.help.sort": "排序",
  "jq.help.group": "分组",
  "jq.help.structure": "结构信息",
  "jq.help.entries": "键值对转换",
  "jq.help.object": "构造新对象",
  "jq.help.array": "构造新数组",

  "samples.title": "载入示例",
  "samples.description": "示例会替换当前 URL、请求头和请求体。",
  "samples.github": "GitHub 仓库",
  "samples.httpbin": "POST 中文 JSON",

  "tools.title": "工具与更新",
  "tools.subtitle": "从 GitHub Releases 检查 xh / jq 的新版本 · {platform}",
  "tools.check": "检查更新",
  "tools.checking": "检查中",
  "tools.current": "当前 {version}",
  "tools.latest": "最新 {version}",
  "tools.upToDate": "已是最新",
  "tools.notChecked": "未检查；点击右上角“检查更新”",
  "tools.update": "更新",
  "tools.releases": "发布页",
  "tools.note":
    "更新安装在应用数据目录的 tools/ 下并保留 .bak，优先级高于随应用附带的版本；不会修改应用目录。",
  "tools.updated": "{tool} 已更新到 {version}",
  "tools.updateFailed": "{tool} 更新失败：{message}",
  "tools.wait": "请等待当前请求或 jq 查询完成后再更新",
  "tools.checkFirst": "请先检查更新",
  "tools.notDetected": "未检测到",

  "status.ready": "就绪",
  "status.requesting": "请求中…",
  "status.failed": "请求失败",
  "status.xhUnavailable": "xh 不可用",
  "version": "Jqui 0.1.0",
};

const EN = {
  "language.switch": "Switch interface language",

  "request.send": "Send",
  "request.sending": "Sending",
  "request.urlAria": "Request URL",
  "request.samples": "Examples",
  "request.tools": "Tools",
  "request.headers": "Headers",
  "request.body": "Body",
  "request.formatJson": "Format JSON",
  "request.headersHint": "One header per line, e.g. Authorization: Bearer …",
  "request.bodyHint": "The body is sent as-is; JSON gets Content-Type: application/json automatically.",
  "request.followRedirects": "Follow redirects",
  "request.insecure": "Skip TLS verification",
  "request.timeout": "Timeout 60s · Body {size}",
  "request.poweredByXh": "Powered by xh {version}",
  "request.headersAria": "Request headers",
  "request.bodyAria": "Request body",
  "request.formatted": "Request body formatted",
  "request.invalidJson": "Request body is not valid JSON",

  "response.tab.body": "Response",
  "response.tab.raw": "Raw",
  "response.tab.headers": "Headers",
  "response.tab.curl": "cURL",
  "response.section.body": "Body",
  "response.section.headers": "Headers",
  "response.copy": "Copy",
  "response.clear": "Clear",
  "response.failed": "Request failed",
  "response.jqFailed": "jq failed; showing the original JSON",
  "response.xhMissingTitle": "xh unavailable",
  "response.xhMissingBody":
    "xh was not found. Jqui sends requests through xh in the application directory (xh.exe on Windows). Add the executable for your platform and allow capabilities.fs.execute in the manifest.",
  "response.loading": "Requesting…",
  "response.emptyTitle": "Send a request to see the JSON response",
  "response.emptyBody":
    "Any method, URL, headers and JSON body are supported. Filter the response with jq, and switch Chinese text between literal, Unicode escapes and hidden.",
  "response.noResults": "jq returned no results",
  "response.noResultsHint": "Try `.` for the whole document, or `.items[]` to expand an array.",
  "response.rawTruncated": "The raw response is long and truncated; use jq or Copy for the full content.",
  "response.rawBeautify": "Beautify JSON",
  "response.rawBeautifyTooltip": "Format the full response as JSON (the jq filter is not applied)",
  "response.rawFull": "Full response · jq not applied",
  "response.noHeaders": "No response headers",
  "response.curlNote": "Jqui runs this through xh; the curl command can reproduce it in a terminal.",
  "response.copiedJson": "JSON copied",
  "response.copiedRaw": "Raw response copied",
  "response.copiedHeaders": "Response headers copied",
  "response.copiedCurl": "cURL command copied",
  "response.copiedResponse": "Response copied",
  "response.copiedLine": "Line copied",
  "response.nothing": "Nothing to copy",
  "response.copyFailed": "Copy failed",
  "response.truncatedNote": "… Content is long and truncated; copy for the full value.",

  "jq.expressionAria": "jq query expression",
  "jq.run": "Run",
  "jq.help": "Syntax help",
  "jq.helpTitle": "jq cheat sheet",
  "jq.pretty": "Pretty",
  "jq.prettyTooltip": "Checked: two-space indentation; unchecked: compact JSON",
  "jq.sortKeys": "Sort keys",
  "jq.sortKeysTooltip": "Sort object keys by name",
  "jq.wrap": "Wrap",
  "jq.wrapTooltip": "Wrap long lines to the window width",
  "jq.raw": "Literal",
  "jq.escape": "Escape",
  "jq.hide": "Hide",
  "jq.unicode": "Unicode",
  "jq.unicodeTooltip":
    "Unicode display: literal / \\uXXXX escape / hide; e.g. Chinese can be shown as \\u4e2d\\u6587",
  "jq.rawTooltip": "Show Unicode characters literally, e.g. 中文",
  "jq.escapeTooltip": "Escape Chinese and other non-ASCII characters as JSON \\uXXXX",
  "jq.hideTooltip": "Replace Chinese and other non-ASCII characters with ·",
  "jq.results": "{count} results",
  "jq.resultsTruncated": "{count} results (showing first {max})",
  "jq.noResults": "No results",
  "jq.cjkCount": "{count} CJK chars",
  "jq.truncated": "Display truncated",
  "jq.builtinNote":
    "Using the built-in jq subset (paths, pipes, map/select/sort_by…). Add a native jq executable to the application directory for full jq.",
  "jq.fullNote":
    "Powered by jq {version}: variables, reduce/foreach, user functions, regex and the full builtin set.",
  "jq.help.identity": "Whole document",
  "jq.help.field": "Field access",
  "jq.help.expand": "Expand array / object",
  "jq.help.index": "Index",
  "jq.help.multiple": "Multiple outputs",
  "jq.help.pipe": "Pipe",
  "jq.help.default": "Default when missing",
  "jq.help.map": "Map array",
  "jq.help.filter": "Filter array",
  "jq.help.sort": "Sort",
  "jq.help.group": "Group",
  "jq.help.structure": "Structure info",
  "jq.help.entries": "Entries conversion",
  "jq.help.object": "Build an object",
  "jq.help.array": "Build an array",

  "samples.title": "Load an example",
  "samples.description": "An example replaces the current URL, headers and body.",
  "samples.github": "GitHub repo",
  "samples.httpbin": "POST Chinese JSON",

  "tools.title": "Tools & updates",
  "tools.subtitle": "Check xh / jq releases on GitHub · {platform}",
  "tools.check": "Check for updates",
  "tools.checking": "Checking",
  "tools.current": "Current {version}",
  "tools.latest": "Latest {version}",
  "tools.upToDate": "Up to date",
  "tools.notChecked": "Not checked; use “Check for updates” above",
  "tools.update": "Update",
  "tools.releases": "Releases",
  "tools.note":
    "Updates install under tools/ in the application data directory and keep a .bak. They take precedence over the bundled version and never modify the application directory.",
  "tools.updated": "{tool} updated to {version}",
  "tools.updateFailed": "{tool} update failed: {message}",
  "tools.wait": "Wait for the current request or jq query before updating",
  "tools.checkFirst": "Check for updates first",
  "tools.notDetected": "not detected",

  "status.ready": "Ready",
  "status.requesting": "Requesting…",
  "status.failed": "Request failed",
  "status.xhUnavailable": "xh unavailable",
  "version": "Jqui 0.1.0",
};

const DICTIONARIES = { zh: ZH, en: EN };

let language = "zh";

export function normalizeLanguage(value) {
  return value === "en" ? "en" : "zh";
}

export function loadLanguage() {
  try {
    return normalizeLanguage(localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    return "zh";
  }
}

export function saveLanguage(value) {
  try {
    localStorage.setItem(STORAGE_KEY, normalizeLanguage(value));
  } catch (error) {
    // Language persistence is optional.
  }
}

export function setLanguage(value) {
  language = normalizeLanguage(value);
}

export function getLanguage() {
  return language;
}

export function isEnglish() {
  return language === "en";
}

export function t(key, params) {
  const dictionary = DICTIONARIES[language] || ZH;
  let text = dictionary[key] ?? ZH[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Inline two-language message for helper modules. */
export function msg(zh, en) {
  return language === "en" ? en : zh;
}
