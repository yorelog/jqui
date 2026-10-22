import { View, div, list } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, Scrollbar } from "gpui-base";
import {
  Button,
  Checkbox,
  ErrorAlert,
  InfoAlert,
  Input,
  InputState,
  Popover,
  Spinner,
  StatusBar,
  Tag,
  Textarea,
  TextareaState,
  TitleBar,
} from "gpui-component";

import {
  performRequest,
  buildCurlPreview,
  normalizeUrl,
  parseHeaderLines,
} from "./lib/http.js";
import { jqErrorMessage } from "./lib/jq.js";
import { runJq } from "./lib/jq-runner.js";
import { loadLanguage, saveLanguage, setLanguage, t } from "./lib/i18n.js";
import {
  downloadAndInstall,
  detectToolVersion,
  fetchLatestTool,
  isNewerVersion,
  platformLabel,
  releasePage,
} from "./lib/tools.js";
import {
  CHINESE_ESCAPE,
  CHINESE_HIDE,
  CHINESE_RAW,
  countCjk,
  flattenJson,
  formatBytes,
  formatMillis,
  stringifyCompact,
  stringifyPretty,
  transformText,
  truncateText,
} from "./lib/json-view.js";
import { METHODS, loadLastRequest, saveLastRequest } from "./lib/store.js";

const ROW_HEIGHT = 21;
const WRAP_KEY = "jqui.wrap.v1";
const RAW_PRETTY_KEY = "jqui.rawPretty.v1";
const MAX_LINES = 20000;
const MAX_RESULTS = 2000;
const MAX_RAW_DISPLAY = 400000;

const SAMPLES = [
  {
    id: "jsonplaceholder",
    label: "JSONPlaceholder",
    method: "GET",
    url: "https://jsonplaceholder.typicode.com/posts/1",
    headers: "Accept: application/json",
    body: "",
    jq: ".",
  },
  {
    id: "github",
    labelKey: "samples.github",
    method: "GET",
    url: "https://api.github.com/repos/longbridge/gpui-kit",
    headers: "Accept: application/vnd.github+json",
    body: "",
    jq: "{name, stars: .stargazers_count, language, description}",
  },
  {
    id: "httpbin",
    labelKey: "samples.httpbin",
    method: "POST",
    url: "https://httpbin.org/anything",
    headers: "Content-Type: application/json",
    body: '{\n  "hello": "世界",\n  "count": 42\n}',
    jq: ".",
  },
];

const JQ_HELP = [
  [".", "jq.help.identity"],
  [".user.name", "jq.help.field"],
  [".items[]", "jq.help.expand"],
  [".items[0].id", "jq.help.index"],
  [".a, .b", "jq.help.multiple"],
  [".a | .b", "jq.help.pipe"],
  ['.a // "default"', "jq.help.default"],
  ["map(.id)", "jq.help.map"],
  ["map(select(.ok))", "jq.help.filter"],
  ["sort_by(.id)", "jq.help.sort"],
  ["group_by(.type)", "jq.help.group"],
  ["keys / length / type", "jq.help.structure"],
  ["to_entries / from_entries", "jq.help.entries"],
  ["{name, stars: .stargazers_count}", "jq.help.object"],
  ["[.items[].id]", "jq.help.array"],
];

export default class Jqui extends View {
  init(_props, cx) {
    this.language = loadLanguage();
    setLanguage(this.language);
    const saved = loadLastRequest();

    this.method = saved.method;
    this.urlState = InputState.new("https://api.example.com/v1/items", saved.url);
    this.headersState = TextareaState.new(saved.headers);
    this.bodyState = TextareaState.new(saved.body);
    this.jqState = InputState.new(".", saved.jq);

    this.requestTab = saved.body ? "body" : "headers";
    this.responseTab = "response";
    this.responseSection = "body";
    this.pretty = true;
    this.sortKeys = false;
    this.wrapJson = loadWrapPreference();
    this.rawPretty = loadRawPrettyPreference();
    this.chineseMode = CHINESE_RAW;
    this.followRedirects = true;
    this.insecure = false;
    this.samplesOpen = false;

    this.loading = false;
    this.error = null;
    this.response = null;
    this.jqError = null;
    this.jqValues = null;
    this.totalResults = 0;
    this.visible = undefined;
    this.lines = [];
    this.linesTruncated = false;
    this.compactText = "";
    this.rawDisplay = "";
    this.rawTruncated = false;
    this.rawPrettyDisplay = "";
    this.rawPrettyTruncated = false;
    this.curlPreviewText = "";
    this.resultLimitHit = false;
    this.cjkCount = 0;
    this.jqTimer = null;
    this.jqLoading = false;
    this.jqRequestId = 0;
    this.jqBackend = "jq";
    this.jqReady = null;

    this.xhReady = null;
    this.xhError = null;
    this.xhVersion = null;
    this.jqVersion = null;

    this.latestTools = { xh: null, jq: null };
    this.checkingUpdates = false;
    this.updatingTool = null;
    this.toolsError = null;
    this.toolsMessage = null;

    this.urlState.on("change", (_event, cx) => cx.notify());
    this.urlState.on("submit", (_event, cx) => this.send(cx));
    this.headersState.on("change", (_event, cx) => cx.notify());
    this.bodyState.on("change", (_event, cx) => cx.notify());
    this.jqState.on("change", (_event, cx) => this.scheduleJq(cx));
    this.jqState.on("submit", (_event, cx) => this.applyJq(cx));

    this.rebuildView();
    this.checkTools(cx);
  }

  // ---------------------------------------------------------------- commands

  checkTools(cx) {
    cx.spawn(async (cx) => {
      try {
        this.xhVersion = await detectToolVersion("xh");
        this.xhReady = true;
        this.xhError = null;
      } catch (error) {
        this.xhReady = false;
        this.xhVersion = null;
        this.xhError = error && error.message ? error.message : String(error);
      }

      try {
        this.jqVersion = await detectToolVersion("jq");
        this.jqReady = true;
        this.jqBackend = "jq";
      } catch (error) {
        this.jqReady = false;
        this.jqVersion = null;
        this.jqBackend = "builtin";
      }
      cx.notify();
    });
  }

  checkUpdates(cx) {
    if (this.checkingUpdates || this.updatingTool) return;
    this.checkingUpdates = true;
    this.toolsError = null;
    this.toolsMessage = null;
    cx.notify();

    cx.spawn(async (cx) => {
      const tools = ["xh", "jq"];
      const results = await Promise.allSettled(tools.map((tool) => fetchLatestTool(tool)));
      tools.forEach((tool, index) => {
        const result = results[index];
        if (result.status === "fulfilled") {
          this.latestTools[tool] = result.value;
        } else {
          const message =
            result.reason && result.reason.message ? result.reason.message : String(result.reason);
          this.latestTools[tool] = { error: message };
        }
      });
      this.checkingUpdates = false;
      cx.notify();
    });
  }

  updateTool(tool, cx) {
    if (this.updatingTool) return;
    if (this.loading || this.jqLoading) {
      this.toolsError = t("tools.wait");
      cx.notify();
      return;
    }
    const info = this.latestTools[tool];
    if (!info || !info.asset) {
      this.toolsError = t("tools.checkFirst");
      cx.notify();
      return;
    }

    this.updatingTool = tool;
    this.toolsError = null;
    this.toolsMessage = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const version = await downloadAndInstall(tool, info);
        if (tool === "xh") {
          this.xhVersion = version;
          this.xhReady = true;
          this.xhError = null;
        } else {
          this.jqVersion = version;
          this.jqReady = true;
          this.jqBackend = "jq";
        }
        this.latestTools[tool] = { ...info, version, installed: true };
        this.toolsMessage = t("tools.updated", { tool, version });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        this.toolsError = t("tools.updateFailed", { tool, message });
      } finally {
        this.updatingTool = null;
        cx.notify();
      }
    });
  }

  toggleLanguage(cx) {
    this.language = this.language === "zh" ? "en" : "zh";
    setLanguage(this.language);
    saveLanguage(this.language);
    cx.notify();
  }

  collectRequest() {
    const method = this.method;
    const url = normalizeUrl(this.urlState.value());
    const headers = parseHeaderLines(this.headersState.value());
    const body = method === "HEAD" ? "" : this.bodyState.value();
    return {
      method,
      url,
      headers,
      body,
      followRedirects: this.followRedirects,
      insecure: this.insecure,
      timeoutSec: 60,
    };
  }

  send(cx) {
    if (this.loading) return;

    let request;
    try {
      request = this.collectRequest();
    } catch (error) {
      this.error = error && error.message ? error.message : String(error);
      cx.notify();
      return;
    }

    this.urlState.set_value(request.url);
    this.error = null;
    this.jqError = null;
    this.loading = true;
    this.jqLoading = false;
    this.jqRequestId += 1;
    this.curlPreviewText = buildCurlPreview(request);
    saveLastRequest({
      method: request.method,
      url: request.url,
      headers: this.headersState.value(),
      body: this.bodyState.value(),
      jq: this.jqState.value(),
    });
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const response = await performRequest(request);
        this.response = response;
        this.jqValues = null;
        this.jqError = null;
        this.responseTab = response.isJson ? "response" : "raw";
        this.responseSection = "body";
        if (response.isJson) {
          const id = ++this.jqRequestId;
          this.jqLoading = true;
          await this.computeQuery(id, cx, response);
        } else {
          this.rebuildView();
        }
      } catch (error) {
        this.error = error && error.message ? error.message : String(error);
      } finally {
        this.loading = false;
        this.jqLoading = false;
        cx.notify();
      }
    });
  }

  scheduleJq(cx) {
    if (this.jqTimer) {
      this.jqTimer.cancel();
      this.jqTimer = null;
    }
    this.jqTimer = cx.timer.after(280, (cx) => {
      this.jqTimer = null;
      this.applyJq(cx);
    });
  }

  applyJq(cx) {
    if (!this.response || !this.response.isJson) {
      cx.notify();
      return;
    }
    const id = ++this.jqRequestId;
    this.jqLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await this.computeQuery(id, cx, this.response);
    });
  }

  async computeQuery(id, cx, response) {
    if (!response || !response.isJson) return;
    const expression = this.jqState.value().trim() || ".";
    try {
      const result = await runJq(expression, response.json, { maxResults: 20000 });
      if (id !== this.jqRequestId) return;
      this.jqValues = result.values;
      this.jqBackend = result.backend;
      this.jqError = null;
    } catch (error) {
      if (id !== this.jqRequestId) return;
      this.jqValues = [response.json];
      this.jqError = jqErrorMessage(error);
    }
    if (id !== this.jqRequestId) return;
    this.jqLoading = false;
    this.rebuildView();
    cx.notify();
  }

  rebuildView() {
    if (!this.response) {
      this.lines = [];
      this.compactText = "";
      this.rawDisplay = "";
      this.rawTruncated = false;
      this.rawPrettyDisplay = "";
      this.rawPrettyTruncated = false;
      this.totalResults = 0;
      this.visible = undefined;
      this.cjkCount = 0;
      this.curlPreviewText = this.buildPreviewSafe();
      return;
    }

    const mode = this.chineseMode;

    if (this.response.isJson) {
      const values = this.jqValues === null ? [this.response.json] : this.jqValues;
      this.totalResults = values.length;
      const shown = values.slice(0, MAX_RESULTS);
      this.resultLimitHit = values.length > MAX_RESULTS;
      this.visible = shown.length === 0 ? undefined : shown.length === 1 ? shown[0] : shown;

      if (this.visible === undefined) {
        this.lines = [];
        this.compactText = "";
      } else {
        const flat = flattenJson(this.visible, {
          mode,
          sortKeys: this.sortKeys,
          maxLines: MAX_LINES,
        });
        this.lines = flat.lines;
        this.linesTruncated = flat.truncated || this.resultLimitHit;
        this.compactText = stringifyCompact(this.visible, mode);
      }

      this.cjkCount = this.visible === undefined ? 0 : countCjk(stringifyCompact(this.visible, CHINESE_RAW));
    } else {
      this.lines = [];
      this.compactText = "";
      this.totalResults = 0;
      this.visible = undefined;
      this.linesTruncated = false;
      this.resultLimitHit = false;
      this.cjkCount = countCjk(this.response.body);
    }

    const raw = truncateText(transformText(this.response.body, mode), MAX_RAW_DISPLAY);
    this.rawDisplay = raw.text;
    this.rawTruncated = raw.truncated;

    if (this.rawPretty && this.response.isJson) {
      const pretty = truncateText(stringifyPretty(this.response.json, mode), MAX_RAW_DISPLAY);
      this.rawPrettyDisplay = pretty.text;
      this.rawPrettyTruncated = pretty.truncated;
    } else {
      this.rawPrettyDisplay = "";
      this.rawPrettyTruncated = false;
    }

    this.curlPreviewText = this.buildPreviewSafe();
  }

  buildPreviewSafe() {
    try {
      return buildCurlPreview(this.collectRequest());
    } catch (error) {
      return "";
    }
  }

  applySample(sample, cx) {
    this.method = sample.method;
    this.urlState.set_value(sample.url);
    this.headersState.set_value(sample.headers);
    this.bodyState.set_value(sample.body);
    this.jqState.set_value(sample.jq);
    this.requestTab = sample.body ? "body" : "headers";
    this.responseTab = "response";
    this.responseSection = "body";
    this.samplesOpen = false;
    this.error = null;
    this.jqError = null;
    this.response = null;
    this.jqValues = null;
    this.jqRequestId += 1;
    this.jqLoading = false;
    this.rebuildView();
    cx.notify();
  }

  formatBody(cx) {
    try {
      const value = JSON.parse(this.bodyState.value());
      this.bodyState.set_value(JSON.stringify(value, null, 2));
      window.push_toast({ title: t("request.formatted"), level: "success", timeout: 1400 });
    } catch (error) {
      window.push_toast({
        title: t("request.invalidJson"),
        description: error && error.message ? error.message : String(error),
        level: "error",
        timeout: 2400,
      });
    }
    cx.notify();
  }

  setChineseMode(mode, cx) {
    if (this.chineseMode === mode) return;
    this.chineseMode = mode;
    this.rebuildView();
    cx.notify();
  }

  setPretty(value, cx) {
    this.pretty = value;
    cx.notify();
  }

  setSortKeys(value, cx) {
    this.sortKeys = value;
    this.rebuildView();
    cx.notify();
  }

  setWrap(value, cx) {
    this.wrapJson = value;
    try {
      localStorage.setItem(WRAP_KEY, String(value));
    } catch (error) {
      // Preference persistence is optional.
    }
    cx.notify();
  }

  setRawPretty(value, cx) {
    this.rawPretty = value;
    try {
      localStorage.setItem(RAW_PRETTY_KEY, String(value));
    } catch (error) {
      // Preference persistence is optional.
    }
    this.rebuildView();
    cx.notify();
  }

  clearResponse(cx) {
    this.response = null;
    this.jqValues = null;
    this.jqError = null;
    this.error = null;
    this.jqRequestId += 1;
    this.jqLoading = false;
    this.rebuildView();
    cx.notify();
  }

  copyText(text, label, cx) {
    if (!text) {
      window.push_toast({ title: t("response.nothing"), level: "warning", timeout: 1600 });
      return;
    }
    try {
      cx.write_to_clipboard(text);
      window.push_toast({ title: label, level: "success", timeout: 1500 });
    } catch (error) {
      window.push_toast({
        title: t("response.copyFailed"),
        description: error && error.message ? error.message : String(error),
        level: "error",
        timeout: 2500,
      });
    }
  }

  copyCurrent(cx) {
    if (!this.response) {
      this.copyText(this.curlPreviewText, t("response.copiedCurl"), cx);
      return;
    }
    if (this.responseTab === "curl") {
      this.copyText(this.curlPreviewText, t("response.copiedCurl"), cx);
      return;
    }
    if (this.responseTab === "raw") {
      const text =
        this.rawPretty && this.response.isJson
          ? stringifyPretty(this.response.json, this.chineseMode)
          : transformText(this.response.body, this.chineseMode);
      this.copyText(text, t("response.copiedRaw"), cx);
      return;
    }
    if (this.responseSection === "headers") {
      this.copyText(this.response.headersText, t("response.copiedHeaders"), cx);
      return;
    }
    if (!this.response.isJson || this.visible === undefined) {
      this.copyText(this.response.body, t("response.copiedResponse"), cx);
      return;
    }
    this.copyText(
      this.pretty ? stringifyPretty(this.visible, this.chineseMode) : stringifyCompact(this.visible, this.chineseMode),
      t("response.copiedJson"),
      cx,
    );
  }

  copyLine(index, cx) {
    const line = this.lines[index];
    if (!line) return;
    this.copyText(line.plain, t("response.copiedLine"), cx);
  }

  hostOf(url) {
    const match = String(url || "").match(/^https?:\/\/([^/?#]+)/i);
    return match ? match[1] : url;
  }

  // ------------------------------------------------------------------ render

  render(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(colors.background)
      .text_color(colors.foreground)
      .child(this.renderTitleBar(cx))
      .child(this.renderRequestBar(cx))
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .gap(12)
          .px(12)
          .pb(12)
          .pt(10)
          .child(this.renderRequestPanel(cx))
          .child(this.renderResponsePanel(cx)),
      )
      .child(this.renderStatusBar(cx));
  }

  renderTitleBar(cx) {
    const colors = cx.theme().colors;
    return TitleBar.new().child(
      h_flex()
        .items_center()
        .gap(9)
        .child(
          div()
            .size(22)
            .rounded(6)
            .bg(colors.primary)
            .flex()
            .items_center()
            .justify_center()
            .child(
              div().text_size(10).font_bold().text_color(colors.primary_foreground).child("JQ"),
            ),
        )
        .child(div().text_size(13).font_medium().text_color(colors.foreground).child("Jqui"))
        .child(div().text_size(11).text_color(colors.muted_foreground).child("xh + jq")),
    );
  }

  renderRequestBar(cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .px(14)
      .py(10)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(colors.border)
      .child(this.renderMethodChips(cx))
      .child(Input.new(this.urlState).flex_1().h(34).text_size(12).aria_label(t("request.urlAria")))
      .child(
        Button.new("send-request")
          .primary()
          .h(34)
          .px(16)
          .label(this.loading ? t("request.sending") : t("request.send"))
          .loading(this.loading)
          .disabled(this.loading)
          .on_click((_event, cx) => this.send(cx)),
      )
      .child(this.renderSamplesPopover(cx))
      .child(this.renderToolsPopover(cx))
      .child(this.renderLanguageToggle(cx));
  }

  renderLanguageToggle(cx) {
    return Button.new("language-toggle")
      .ghost()
      .size("xsmall")
      .compact()
      .label(this.language === "zh" ? "EN" : "中文")
      .tooltip(t("language.switch"))
      .on_click((_event, cx) => this.toggleLanguage(cx));
  }

  renderMethodChips(cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .items_center()
      .gap(1)
      .p(2)
      .rounded(8)
      .bg(colors.muted)
      .children(
        METHODS.map((method) =>
          Button.new(`method-${method}`)
            .size("xsmall")
            .compact()
            .label(method)
            .when(this.method === method, (button) => button.primary())
            .when(this.method !== method, (button) => button.ghost())
            .on_click((_event, cx) => {
              this.method = method;
              cx.notify();
            }),
        ),
      );
  }

  renderSamplesPopover(cx) {
    const colors = cx.theme().colors;
    return Popover.new("samples", t("request.samples"))
      .open(this.samplesOpen)
      .on_open_change((open, cx) => {
        this.samplesOpen = open;
        cx.notify();
      })
      .content(
        v_flex()
          .w(380)
          .p(12)
          .gap(8)
          .bg(colors.surface)
          .border(1)
          .border_color(colors.border)
          .rounded(10)
          .shadow_md()
          .child(div().text_size(12).font_medium().child(t("samples.title")))
          .child(
            div()
              .text_size(11)
              .text_color(colors.muted_foreground)
              .child(t("samples.description")),
          )
          .children(
            SAMPLES.map((sample) =>
              Button.new(`sample-${sample.id}`)
                .outline()
                .h(34)
                .w_full()
                .px(10)
                .label(sample.labelKey ? t(sample.labelKey) : sample.label)
                .on_click((_event, cx) => this.applySample(sample, cx)),
            ),
          ),
      );
  }

  renderToolsPopover(cx) {
    const colors = cx.theme().colors;
    return Popover.new("tools", t("request.tools")).content(
      v_flex()
        .w(540)
        .p(12)
        .gap(9)
        .bg(colors.surface)
        .border(1)
        .border_color(colors.border)
        .rounded(10)
        .shadow_md()
        .child(
          h_flex()
            .items_center()
            .justify_between()
            .child(
              v_flex()
                .gap(2)
                .child(div().text_size(12).font_medium().child(t("tools.title")))
                .child(
                  div()
                    .text_size(10)
                    .text_color(colors.muted_foreground)
                    .child(t("tools.subtitle", { platform: platformLabel() })),
                ),
            )
            .child(
              Button.new("check-updates")
                .size("xsmall")
                .label(this.checkingUpdates ? t("tools.checking") : t("tools.check"))
                .loading(this.checkingUpdates)
                .disabled(this.checkingUpdates || Boolean(this.updatingTool))
                .on_click((_event, cx) => this.checkUpdates(cx)),
            ),
        )
        .when(Boolean(this.toolsError), (panel) =>
          panel.child(div().text_size(10).text_color(colors.destructive).child(this.toolsError)),
        )
        .when(Boolean(this.toolsMessage), (panel) =>
          panel.child(div().text_size(10).text_color(colors.primary).child(this.toolsMessage)),
        )
        .child(this.renderToolUpdateRow(cx, "xh"))
        .child(this.renderToolUpdateRow(cx, "jq"))
        .child(
          div()
            .text_size(9)
            .text_color(colors.muted_foreground)
            .child(t("tools.note")),
        ),
    );
  }

  renderToolUpdateRow(cx, tool) {
    const colors = cx.theme().colors;
    const current = tool === "xh" ? this.xhVersion : this.jqVersion;
    const info = this.latestTools[tool];
    const hasInfo = Boolean(info && !info.error);
    const newer = hasInfo && isNewerVersion(info.version, current);
    const updating = this.updatingTool === tool;

    return v_flex()
      .gap(6)
      .p(9)
      .rounded(8)
      .bg(colors.muted)
      .child(
        h_flex()
          .items_center()
          .gap(10)
          .child(
            div()
              .w(30)
              .flex_shrink_0()
              .text_size(12)
              .font_bold()
              .text_color(colors.foreground)
              .child(tool),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(
                h_flex()
                  .items_center()
                  .gap(10)
                  .child(
                    div()
                      .text_size(11)
                      .text_color(colors.foreground)
                      .child(t("tools.current", { version: current || t("tools.notDetected") })),
                  )
                  .when(hasInfo, (row) =>
                    row.child(
                      div()
                        .text_size(11)
                        .text_color(colors.primary)
                        .child(t("tools.latest", { version: info.version })),
                    ),
                  )
                  .when(hasInfo && !newer, (row) =>
                    row.child(
                      div()
                        .text_size(9)
                        .text_color(colors.muted_foreground)
                        .child(t("tools.upToDate")),
                    ),
                  ),
              )
              .when(Boolean(info && info.asset), (row) =>
                row.child(
                  div()
                    .text_size(9)
                    .text_color(colors.muted_foreground)
                    .truncate()
                    .child(`${info.asset.name} · ${formatBytes(info.asset.size)}`),
                ),
              )
              .when(!info, (row) =>
                row.child(
                  div()
                    .text_size(9)
                    .text_color(colors.muted_foreground)
                    .child(t("tools.notChecked")),
                ),
              )
              .when(Boolean(info && info.error), (row) =>
                row.child(
                  div().text_size(9).text_color(colors.destructive).child(info.error),
                ),
              ),
          )
          .when(updating, (row) => row.child(Spinner.new().size("xsmall")))
          .when(newer && !updating, (row) =>
            row.child(
              Button.new(`update-${tool}`)
                .primary()
                .size("xsmall")
                .compact()
                .label(t("tools.update"))
                .disabled(Boolean(this.updatingTool) || this.loading || this.jqLoading)
                .on_click((_event, cx) => this.updateTool(tool, cx)),
            ),
          )
          .child(
            Button.new(`release-${tool}`)
              .ghost()
              .size("xsmall")
              .compact()
              .label(t("tools.releases"))
              .on_click((_event, cx) =>
                cx.open_url((info && info.htmlUrl) || releasePage(tool)),
              ),
          ),
      );
  }

  renderRequestPanel(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .w(430)
      .h_full()
      .min_h(0)
      .rounded(12)
      .border(1)
      .border_color(colors.border)
      .bg(colors.surface)
      .shadow_sm()
      .overflow_hidden()
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .px(10)
          .py(8)
          .border_b(1)
          .border_color(colors.border)
          .child(
            h_flex()
              .items_center()
              .gap(4)
              .child(this.requestTabButton(cx, t("request.headers"), "headers", Boolean(this.headersState.value().trim())))
              .child(this.requestTabButton(cx, t("request.body"), "body", Boolean(this.bodyState.value().trim()))),
          )
          .child(
            this.requestTab === "body"
              ? Button.new("format-body")
                  .ghost()
                  .size("xsmall")
                  .compact()
                  .label(t("request.formatJson"))
                  .on_click((_event, cx) => this.formatBody(cx))
              : div(),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(10)
          .gap(8)
          .child(
            div().text_size(11).text_color(colors.muted_foreground).child(
              this.requestTab === "headers" ? t("request.headersHint") : t("request.bodyHint"),
            ),
          )
          .child(
            this.requestTab === "headers"
              ? Textarea.new(this.headersState)
                  .flex_1()
                  .min_h(0)
                  .appearance(false)
                  .bordered(false)
                  .text_size(12)
                  .font_family(cx.theme().typography.mono)
                  .aria_label(t("request.headersAria"))
              : Textarea.new(this.bodyState)
                  .flex_1()
                  .min_h(0)
                  .appearance(false)
                  .bordered(false)
                  .text_size(12)
                  .font_family(cx.theme().typography.mono)
                  .aria_label(t("request.bodyAria")),
          )
          .child(this.renderRequestOptions(cx)),
      );
  }

  requestTabButton(cx, label, key, dot) {
    const active = this.requestTab === key;
    return Button.new(`request-tab-${key}`)
      .size("xsmall")
      .compact()
      .label(dot ? `${label} ·` : label)
      .when(active, (button) => button.primary())
      .when(!active, (button) => button.ghost())
      .on_click((_event, cx) => {
        this.requestTab = key;
        cx.notify();
      });
  }

  renderRequestOptions(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .gap(6)
      .pt(6)
      .border_t(1)
      .border_color(colors.border)
      .child(
        h_flex()
          .items_center()
          .gap(16)
          .child(
            Checkbox.new("follow-redirects")
              .checked(this.followRedirects)
              .label(t("request.followRedirects"))
              .size("xsmall")
              .on_change((checked, cx) => {
                this.followRedirects = checked;
                cx.notify();
              }),
          )
          .child(
            Checkbox.new("insecure-tls")
              .checked(this.insecure)
              .label(t("request.insecure"))
              .size("xsmall")
              .on_change((checked, cx) => {
                this.insecure = checked;
                cx.notify();
              }),
          ),
      )
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            div()
              .text_size(10)
              .text_color(colors.muted_foreground)
              .child(
                t("request.timeout", { size: formatBytes(this.bodyState.value().length) }),
              ),
          )
          .child(
            div()
              .text_size(10)
              .text_color(colors.muted_foreground)
              .child(t("request.poweredByXh", { version: this.xhVersion || "" })),
          ),
      );
  }

  renderResponsePanel(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .min_h(0)
      .rounded(12)
      .border(1)
      .border_color(colors.border)
      .bg(colors.surface)
      .shadow_sm()
      .overflow_hidden()
      .child(this.renderResponseHeader(cx))
      .when(Boolean(this.error), (panel) =>
        panel.child(
          div()
            .px(10)
            .pt(8)
            .child(ErrorAlert.new("request-error", this.error).banner().title(t("response.failed"))),
        ),
      )
      .when(
        Boolean(
          this.response &&
            this.response.isJson &&
            this.responseTab === "response" &&
            this.responseSection === "body",
        ),
        (panel) => panel.child(this.renderJqBar(cx)),
      )
      .when(
        Boolean(
          this.response &&
            this.response.isJson &&
            this.responseTab === "response" &&
            this.responseSection === "body" &&
            this.jqError,
        ),
        (panel) =>
          panel.child(
            div()
              .px(10)
              .pt(8)
              .child(
                ErrorAlert.new("jq-error", this.jqError)
                  .banner()
                  .title(t("response.jqFailed")),
              ),
          ),
      )
      .when(this.xhReady === false, (panel) =>
        panel.child(
          div()
            .px(10)
            .pt(8)
            .child(
              InfoAlert.new("xh-missing", t("response.xhMissingBody"))
                .banner()
                .title(t("response.xhMissingTitle")),
            ),
        ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .when(this.loading && !this.response, (content) =>
            content
              .items_center()
              .justify_center()
              .gap(10)
              .child(Spinner.new().size("small"))
              .child(div().text_size(12).text_color(colors.muted_foreground).child(t("response.loading"))),
          )
          .when(!(this.loading && !this.response), (content) => content.child(this.renderResponseBody(cx))),
      );
  }

  renderResponseHeader(cx) {
    const colors = cx.theme().colors;
    const response = this.response;
    return h_flex()
      .items_center()
      .gap(10)
      .px(10)
      .py(8)
      .border_b(1)
      .border_color(colors.border)
      .child(
        h_flex()
          .items_center()
          .gap(3)
          .child(this.responseTabButton(cx, t("response.tab.body"), "response"))
          .when(this.responseTab === "response" && Boolean(response), (row) =>
            row
              .child(div().w(1).h(14).ml(4).mr(4).bg(colors.border))
              .child(this.responseSectionButton(cx, t("response.section.body"), "body"))
              .child(
                this.responseSectionButton(
                  cx,
                  `${t("response.section.headers")} · ${response.headers.length}`,
                  "headers",
                ),
              ),
          )
          .child(this.responseTabButton(cx, t("response.tab.raw"), "raw"))
          .child(this.responseTabButton(cx, t("response.tab.curl"), "curl")),
      )
      .child(div().flex_1())
      .when(Boolean(response), (row) =>
        row
          .child(this.statusTag(cx))
          .child(
            div()
              .text_size(11)
              .text_color(colors.muted_foreground)
              .child(`${formatMillis(response.milliseconds)} · ${formatBytes(response.bytes)}`),
          ),
      )
      .when(Boolean(this.response), (row) =>
        row
          .child(
            Button.new("copy-response")
              .ghost()
              .size("xsmall")
              .compact()
              .label(t("response.copy"))
              .on_click((_event, cx) => this.copyCurrent(cx)),
          )
          .child(
            Button.new("clear-response")
              .ghost()
              .size("xsmall")
              .compact()
              .label(t("response.clear"))
              .on_click((_event, cx) => this.clearResponse(cx)),
          ),
      );
  }

  statusTag(cx) {
    const response = this.response;
    if (!response) return div();
    const variant =
      response.status >= 200 && response.status < 300
        ? "success"
        : response.status >= 300 && response.status < 400
          ? "warning"
          : "danger";
    return Tag.new()
      .variant(variant)
      .rounded_full()
      .size("xsmall")
      .child(`${response.status}${response.statusText ? " " + response.statusText : ""}`);
  }

  responseTabButton(cx, label, key) {
    const active = this.responseTab === key;
    return Button.new(`response-tab-${key}`)
      .size("xsmall")
      .compact()
      .label(label)
      .when(active, (button) => button.primary())
      .when(!active, (button) => button.ghost())
      .on_click((_event, cx) => {
        this.responseTab = key;
        cx.notify();
      });
  }

  responseSectionButton(cx, label, section) {
    const active = this.responseSection === section;
    return Button.new(`response-section-${section}`)
      .size("xsmall")
      .compact()
      .label(label)
      .when(active, (button) => button.secondary())
      .when(!active, (button) => button.ghost())
      .on_click((_event, cx) => {
        this.responseSection = section;
        cx.notify();
      });
  }

  renderJqBar(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .border_b(1)
      .border_color(colors.border)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .px(10)
          .py(8)
          .child(
            div()
              .text_size(11)
              .font_medium()
              .font_family(cx.theme().typography.mono)
              .text_color(colors.primary)
              .child("jq"),
          )
          .child(Input.new(this.jqState).flex_1().h(30).text_size(12).aria_label(t("jq.expressionAria")))
          .when(this.jqLoading, (row) => row.child(Spinner.new().size("xsmall")))
          .child(
            Button.new("run-jq")
              .ghost()
              .size("xsmall")
              .compact()
              .label(t("jq.run"))
              .on_click((_event, cx) => this.applyJq(cx)),
          )
          .child(this.renderJqHelp(cx)),
      )
      .child(this.renderDisplayToolbar(cx));
  }

  renderJqHelp(cx) {
    const colors = cx.theme().colors;
    return Popover.new("jq-help", t("jq.help"))
      .content(
        v_flex()
          .w(470)
          .p(12)
          .gap(7)
          .bg(colors.surface)
          .border(1)
          .border_color(colors.border)
          .rounded(10)
          .shadow_md()
          .child(div().text_size(12).font_medium().child(t("jq.helpTitle")))
          .children(
            JQ_HELP.map(([syntax, descriptionKey]) =>
              h_flex()
                .items_start()
                .gap(12)
                .child(
                  div()
                    .w(210)
                    .flex_shrink_0()
                    .font_family(cx.theme().typography.mono)
                    .text_size(11)
                    .text_color(colors.primary)
                    .child(syntax),
                )
                .child(div().flex_1().text_size(11).text_color(colors.muted_foreground).child(t(descriptionKey))),
            ),
          )
          .child(
            div()
              .text_size(10)
              .text_color(colors.muted_foreground)
              .child(
                this.jqBackend === "builtin"
                  ? t("jq.builtinNote")
                  : t("jq.fullNote", { version: this.jqVersion || "" }),
              ),
          ),
      );
  }

  renderDisplayToolbar(cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .items_center()
      .gap(14)
      .px(10)
      .py(6)
      .child(
        Checkbox.new("pretty-json")
          .checked(this.pretty)
          .label(t("jq.pretty"))
          .tooltip(t("jq.prettyTooltip"))
          .size("xsmall")
          .on_change((checked, cx) => this.setPretty(checked, cx)),
      )
      .child(
        Checkbox.new("sort-keys")
          .checked(this.sortKeys)
          .label(t("jq.sortKeys"))
          .tooltip(t("jq.sortKeysTooltip"))
          .size("xsmall")
          .on_change((checked, cx) => this.setSortKeys(checked, cx)),
      )
      .child(
        Checkbox.new("wrap-json")
          .checked(this.wrapJson)
          .label(t("jq.wrap"))
          .tooltip(t("jq.wrapTooltip"))
          .size("xsmall")
          .on_change((checked, cx) => this.setWrap(checked, cx)),
      )
      .child(this.renderChineseToggle(cx))
      .child(div().flex_1())
      .when(this.totalResults > 1, (row) =>
        row.child(
          div()
            .text_size(10)
            .text_color(colors.muted_foreground)
            .child(
              this.resultLimitHit
                ? t("jq.resultsTruncated", { count: this.totalResults, max: MAX_RESULTS })
                : t("jq.results", { count: this.totalResults }),
            ),
        ),
      )
      .when(this.totalResults === 0, (row) =>
        row.child(div().text_size(10).text_color(colors.muted_foreground).child(t("jq.noResults"))),
      )
      .when(this.cjkCount > 0, (row) =>
        row.child(div().text_size(10).text_color(colors.muted_foreground).child(t("jq.cjkCount", { count: this.cjkCount }))),
      )
      .when(this.linesTruncated && this.pretty, (row) =>
        row.child(div().text_size(10).text_color(colors.muted_foreground).child(t("jq.truncated"))),
      );
  }

  renderChineseToggle(cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .items_center()
      .gap(5)
      .child(
        div()
          .text_size(10)
          .text_color(colors.muted_foreground)
          .tooltip(t("jq.unicodeTooltip"))
          .child(t("jq.unicode")),
      )
      .child(
        h_flex()
          .items_center()
          .gap(1)
          .p(1)
          .rounded(6)
          .bg(colors.muted)
          .child(this.chineseModeButton(cx, t("jq.raw"), CHINESE_RAW))
          .child(this.chineseModeButton(cx, t("jq.escape"), CHINESE_ESCAPE))
          .child(this.chineseModeButton(cx, t("jq.hide"), CHINESE_HIDE)),
      );
  }

  chineseModeButton(cx, label, mode) {
    const active = this.chineseMode === mode;
    const tooltip =
      mode === CHINESE_RAW
        ? t("jq.rawTooltip")
        : mode === CHINESE_ESCAPE
          ? t("jq.escapeTooltip")
          : t("jq.hideTooltip");
    return Button.new(`chinese-${mode}`)
      .size("xsmall")
      .compact()
      .label(label)
      .tooltip(tooltip)
      .when(active, (button) => button.primary())
      .when(!active, (button) => button.ghost())
      .on_click((_event, cx) => this.setChineseMode(mode, cx));
  }

  renderResponseBody(cx) {
    if (!this.response) return this.renderEmptyState(cx);
    if (this.responseTab === "raw") return this.renderRaw(cx);
    if (this.responseTab === "curl") return this.renderCurl(cx);
    if (this.responseSection === "headers") return this.renderHeaders(cx);
    if (!this.response.isJson) return this.renderRaw(cx);
    if (this.totalResults === 0) return this.renderNoResults(cx);
    if (!this.pretty) return this.renderCompact(cx);
    return this.renderJsonList(cx);
  }

  renderEmptyState(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .flex_1()
      .min_h(0)
      .items_center()
      .justify_center()
      .gap(10)
      .p(24)
      .child(
        div()
          .size(58)
          .rounded(14)
          .bg(colors.muted)
          .flex()
          .items_center()
          .justify_center()
          .child(div().text_size(20).font_bold().text_color(colors.muted_foreground).child("{ }")),
      )
      .child(div().text_size(14).font_medium().text_color(colors.foreground).child(t("response.emptyTitle")))
      .child(
        div()
          .max_w(430)
          .text_center()
          .text_size(11)
          .text_color(colors.muted_foreground)
          .child(t("response.emptyBody")),
      )
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .pt(4)
          .children(
            SAMPLES.map((sample) =>
              Button.new(`empty-sample-${sample.id}`)
                .outline()
                .size("xsmall")
                .label(sample.labelKey ? t(sample.labelKey) : sample.label)
                .on_click((_event, cx) => this.applySample(sample, cx)),
            ),
          ),
      );
  }

  renderNoResults(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .flex_1()
      .min_h(0)
      .items_center()
      .justify_center()
      .gap(6)
      .child(div().text_size(13).font_medium().child(t("response.noResults")))
      .child(
        div()
          .text_size(11)
          .text_color(colors.muted_foreground)
          .child(t("response.noResultsHint")),
      );
  }

  renderCompact(cx) {
    const colors = cx.theme().colors;
    const compact = truncateText(this.compactText || "null", MAX_RAW_DISPLAY);
    return div()
      .flex_1()
      .min_h(0)
      .overflow_scroll()
      .p(12)
      .child(
        div()
          .font_family(cx.theme().typography.mono)
          .text_size(12)
          .text_color(colors.foreground)
          .whitespace_normal()
          .child(compact.text),
      );
  }

  renderRaw(cx) {
    const colors = cx.theme().colors;
    const pretty = this.rawPretty && Boolean(this.response && this.response.isJson);
    const text = pretty ? this.rawPrettyDisplay : this.rawDisplay;
    const truncated = pretty ? this.rawPrettyTruncated : this.rawTruncated;

    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .items_center()
          .gap(12)
          .px(10)
          .py(6)
          .border_b(1)
          .border_color(colors.border)
          .when(Boolean(this.response && this.response.isJson), (row) =>
            row.child(
              Checkbox.new("raw-pretty")
                .checked(this.rawPretty)
                .label(t("response.rawBeautify"))
                .tooltip(t("response.rawBeautifyTooltip"))
                .size("xsmall")
                .on_change((checked, cx) => this.setRawPretty(checked, cx)),
            ),
          )
          .child(this.renderChineseToggle(cx))
          .child(div().flex_1())
          .when(pretty, (row) =>
            row.child(
              div()
                .text_size(9)
                .text_color(colors.muted_foreground)
                .child(t("response.rawFull")),
            ),
          ),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .id("raw-scroll")
          .overflow_scroll()
          .p(12)
          .child(
            div()
              .font_family(cx.theme().typography.mono)
              .text_size(12)
              .text_color(colors.foreground)
              .whitespace_normal()
              .child(text || ""),
          ),
      )
      .when(truncated, (panel) =>
        panel.child(
          div()
            .px(12)
            .py(6)
            .border_t(1)
            .border_color(colors.border)
            .text_size(10)
            .text_color(colors.muted_foreground)
            .child(t("response.rawTruncated")),
        ),
      );
  }

  renderHeaders(cx) {
    const colors = cx.theme().colors;
    const headers = this.response ? this.response.headers : [];
    if (!headers.length) {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .text_size(12)
        .text_color(colors.muted_foreground)
        .child(t("response.noHeaders"));
    }
    return div()
      .flex_1()
      .min_h(0)
      .id("headers-scroll")
      .overflow_scroll()
      .p(12)
      .child(
        v_flex()
          .gap(5)
          .children(
            headers.map((header) =>
              h_flex()
                .items_start()
                .gap(12)
                .child(
                  div()
                    .w(190)
                    .flex_shrink_0()
                    .font_family(cx.theme().typography.mono)
                    .text_size(11)
                    .text_color(colors.muted_foreground)
                    .child(header.name),
                )
                .child(
                  div()
                    .flex_1()
                    .font_family(cx.theme().typography.mono)
                    .text_size(11)
                    .text_color(colors.foreground)
                    .child(header.value),
                ),
            ),
          ),
      );
  }

  renderCurl(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        div()
          .flex_1()
          .min_h(0)
          .id("curl-scroll")
          .overflow_scroll()
          .p(12)
          .child(
            div()
              .font_family(cx.theme().typography.mono)
              .text_size(12)
              .text_color(colors.foreground)
              .whitespace_normal()
              .child(this.curlPreviewText || "curl "),
          ),
      )
      .child(
        div()
          .px(12)
          .py(6)
          .border_t(1)
          .border_color(colors.border)
          .text_size(10)
          .text_color(colors.muted_foreground)
          .child(t("response.curlNote")),
      );
  }

  renderJsonList(cx) {
    if (!this.lines.length) return this.renderNoResults(cx);

    if (this.wrapJson) {
      return v_flex()
        .relative()
        .flex_1()
        .min_h(0)
        .child(
          list(
            "json-lines-wrap",
            this.lines.length,
            (index) => String(index),
            (index, cx) => this.renderJsonWrappedRow(this.lines[index], cx),
          )
            .flex_1()
            .min_h(0)
            .on_item_click((key, cx) => this.copyLine(Number(key), cx)),
        )
        .child(Scrollbar.vertical("json-lines-wrap").absolute().inset_0());
    }

    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
      .child(
        v_virtual_list(
          "json-lines",
          this.lines.length,
          ROW_HEIGHT,
          (index) => String(index),
          (range, cx) => {
            const rows = [];
            for (let index = range.start; index < range.end; index += 1) {
              rows.push(this.renderJsonRow(this.lines[index], cx));
            }
            return rows;
          },
        )
          .flex_1()
          .min_h(0)
          .on_item_click((key, cx) => this.copyLine(Number(key), cx)),
      )
      .child(Scrollbar.vertical("json-lines").absolute().inset_0());
  }

  renderJsonWrappedRow(line, cx) {
    if (!line) return div();
    const colors = cx.theme().colors;
    const syntax = syntaxColors(cx);
    const chunks = [];
    for (const span of line.spans) {
      const characters = Array.from(span.text);
      for (let index = 0; index < characters.length; index += 18) {
        chunks.push({
          text: characters.slice(index, index + 18).join(""),
          kind: span.kind,
        });
      }
    }

    return h_flex()
      .w_full()
      .items_start()
      .py(2)
      .child(
        div()
          .w(44)
          .pr(9)
          .flex_shrink_0()
          .text_right()
          .text_size(9)
          .text_color(colors.muted_foreground)
          .child(String(line.no)),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .flex_wrap()
          .items_start()
          .pl(6 + line.depth * 14)
          .children(
            chunks.map((chunk) =>
              div()
                .font_family(cx.theme().typography.mono)
                .text_size(12)
                .text_color(syntaxColor(syntax, chunk.kind))
                .whitespace_nowrap()
                .when(chunk.kind === "key", (element) => element.font_medium())
                .child(chunk.text),
            ),
          ),
      );
  }

  renderJsonRow(line, cx) {
    if (!line) return div();
    const colors = cx.theme().colors;
    const syntax = syntaxColors(cx);
    return h_flex()
      .h(ROW_HEIGHT)
      .w_full()
      .items_center()
      .overflow_hidden()
      .child(
        div()
          .w(44)
          .pr(9)
          .flex_shrink_0()
          .text_right()
          .text_size(9)
          .text_color(colors.muted_foreground)
          .child(String(line.no)),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .overflow_hidden()
          .pl(6 + line.depth * 14)
          .children(
            line.spans.map((span) =>
              div()
                .font_family(cx.theme().typography.mono)
                .text_size(12)
                .text_color(syntaxColor(syntax, span.kind))
                .whitespace_nowrap()
                .when(span.kind === "key", (element) => element.font_medium())
                .child(span.text),
            ),
          ),
      );
  }

  renderStatusBar(cx) {
    const colors = cx.theme().colors;
    const response = this.response;
    const statusColor = this.error
      ? colors.destructive
      : this.loading
        ? colors.primary
        : response
          ? response.status >= 200 && response.status < 300
            ? "#22c55e"
            : response.status >= 300 && response.status < 400
              ? "#f59e0b"
              : colors.destructive
          : colors.muted_foreground;

    const statusText = this.error
      ? t("status.failed")
      : this.loading
        ? t("status.requesting")
        : response
          ? `${response.status} ${response.statusText || ""}`.trim()
          : t("status.ready");

    return StatusBar.new()
      .border_t(1)
      .border_color(colors.border)
      .left_content(
        h_flex()
          .items_center()
          .gap(7)
          .child(div().size(7).rounded_full().bg(statusColor))
          .child(div().text_size(11).text_color(colors.muted_foreground).child(statusText))
          .when(this.xhReady === false, (row) =>
            row.child(div().text_size(11).text_color(colors.destructive).child(t("status.xhUnavailable"))),
          ),
      )
      .right_content(
        div()
          .text_size(10)
          .text_color(colors.muted_foreground)
          .child(`${this.method} ${this.hostOf(this.urlState.value())} · ${t("version")}`),
      );
  }
}

function loadWrapPreference() {
  try {
    return localStorage.getItem(WRAP_KEY) !== "false";
  } catch (error) {
    return true;
  }
}

function loadRawPrettyPreference() {
  try {
    return localStorage.getItem(RAW_PRETTY_KEY) === "true";
  } catch (error) {
    return false;
  }
}

function syntaxColors(cx) {
  if (cx.theme().is_dark) {
    return {
      punct: "#8b949e",
      key: "#7dd3fc",
      string: "#86efac",
      number: "#fbbf24",
      boolean: "#c084fc",
      null: "#f87171",
    };
  }
  return {
    punct: "#94a3b8",
    key: "#0369a1",
    string: "#15803d",
    number: "#b45309",
    boolean: "#7e22ce",
    null: "#b91c1c",
  };
}

function syntaxColor(syntax, kind) {
  return syntax[kind] || syntax.punct;
}
