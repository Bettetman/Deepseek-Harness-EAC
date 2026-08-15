/**
 * dsh-tool-vision — browser half.
 *
 * A "视觉模型" section inside the Web UI settings page: edits the
 * `tool-vision` settings namespace (API endpoint, key, model, bridge
 * options) through the settings scope transport. Changes hot-apply via the
 * host settings provider — no restart needed.
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-tool-vision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS = ".__tv_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__tv_quick{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__tv_quickTitle{grid-column:1/-1;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__tv_field{display:flex;flex-direction:column;gap:4px}" +
      ".__tv_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__tv_override{font-size:10px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__tv_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tv_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__tv_row{display:flex;align-items:center;gap:8px}" +
      ".__tv_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__tv_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__tv_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__tv_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__tv_btn:disabled{opacity:.5;cursor:default}" +
      ".__tv_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__tv_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__tv_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__tv_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}" +
      "@media(max-width:560px){.__tv_quick{grid-template-columns:minmax(0,1fr)}}";
    var tagId = "dsh-tool-vision/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-tool-vision";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "toolVision";
    var inject = ["slots", "locale", "settingsScope"];
    var zh = {
      nav: "视觉模型",
      intro: "外置视觉模型配置：Agent 通过 inspect_image 工具把图片发给该端点分析。修改后即时生效（settings.yaml 热重载）。",
      quickTitle: "快速配置（也可在下方手动修改）",
      provider: "视觉服务商",
      presetModel: "预设模型",
      customModel: "自定义（在下方填写）",
      apiKeyHint: "留空保持当前密钥。密钥只写不读，不会回显。",
      maxTokens: "最大输出 Tokens",
      timeoutMs: "请求超时（毫秒）",
      maxImageBytes: "本地图片大小上限（字节）",
      bridgeTextOnly: "图片桥接（文本模型贴图自动转 inspect_image 指引）",
      bridgeExportDir: "桥接图片导出目录（空 = 系统临时目录）",
      multimodalModels: "多模态白名单（逗号分隔，这些模型直收图片块）",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 tool-vision 命名空间？）",
      overridden: "已覆盖",
      loading: "加载中…"
    };
    var en = {
      nav: "Vision Model",
      intro: "External vision model config: the agent sends images to this endpoint via the inspect_image tool. Changes apply immediately (settings.yaml hot-reload).",
      quickTitle: "Quick setup (or edit the fields below)",
      provider: "Vision provider",
      presetModel: "Preset model",
      customModel: "Custom (enter below)",
      apiKeyHint: "Leave blank to keep the current key. The key is write-only and never echoed.",
      maxTokens: "Max output tokens",
      timeoutMs: "Request timeout (ms)",
      maxImageBytes: "Max local image size (bytes)",
      bridgeTextOnly: "Image bridge (pasted images on text-only models become inspect_image hints)",
      bridgeExportDir: "Bridge export dir (empty = system temp)",
      multimodalModels: "Multimodal whitelist (comma-separated; these models receive image blocks directly)",
      save: "Save",
      reset: "Reset",
      saved: "Saved",
      saving: "Saving…",
      error: "Save failed",
      unavailable: "Settings namespace unavailable (tool-vision namespace not registered server-side?)",
      overridden: "overridden",
      loading: "Loading…"
    };

    // ── field spec ────────────────────────────────────────────────────────
    var FIELDS = [
      { key: "baseURL", label: "API Base URL", type: "text", placeholder: "https://api.openai.com/v1" },
      { key: "apiKey", label: "API Key", type: "password", secret: true },
      { key: "apiKeyEnv", label: "API Key 环境变量（apiKey 为空时读取）", type: "text" },
      { key: "model", label: "视觉模型", type: "text", placeholder: "gpt-4o-mini" },
      { key: "maxTokens", label: "最大输出 Tokens", type: "number" },
      { key: "timeoutMs", label: "请求超时（毫秒）", type: "number" },
      { key: "maxImageBytes", label: "图片大小上限（字节）", type: "number" },
      { key: "bridgeTextOnly", label: "图片桥接开关", type: "checkbox" },
      { key: "bridgeExportDir", label: "桥接导出目录", type: "text" },
      { key: "multimodalModels", label: "多模态白名单（逗号分隔）", type: "csv" }
    ];
    var ZH_HINTS = {
      apiKey: "apiKeyHint",
      maxTokens: "maxTokens",
      timeoutMs: "timeoutMs",
      maxImageBytes: "maxImageBytes",
      bridgeTextOnly: "bridgeTextOnly",
      bridgeExportDir: "bridgeExportDir",
      multimodalModels: "multimodalModels"
    };
    var PROVIDERS = [
      { id: "zhipu", label: "智谱 AI（GLM）", baseURL: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "GLM_API_KEY", models: ["glm-4v-flash", "glm-4v-plus", "glm-4v"] },
      { id: "dashscope", label: "阿里云百炼（通义千问 VL）", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyEnv: "DASHSCOPE_API_KEY", models: ["qwen-vl-plus", "qwen-vl-max", "qwen2.5-vl-72b-instruct"] },
      { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", models: ["gpt-4o-mini", "gpt-4o"] },
      { id: "siliconflow", label: "硅基流动 SiliconFlow", baseURL: "https://api.siliconflow.cn/v1", keyEnv: "SILICONFLOW_API_KEY", models: ["Qwen/Qwen2.5-VL-32B-Instruct", "Pro/Qwen/Qwen2.5-VL-7B-Instruct"] },
      { id: "moonshot", label: "月之暗面 Kimi", baseURL: "https://api.moonshot.cn/v1", keyEnv: "MOONSHOT_API_KEY", models: ["moonshot-v1-8k-vision-preview"] },
      { id: "custom", label: "自定义（手动填写）", baseURL: "", keyEnv: "VISION_API_KEY", models: [] }
    ];

    function labelOf(f) {
      return f.label;
    }

    // ── component ─────────────────────────────────────────────────────────
    function VisionSection(props) {
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [draft, setDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);

      react.useEffect(function () {
        scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); if (scope.dispose) scope.dispose(); };
      }, [scope]);
      // Seed the draft ONLY when the snapshot becomes ready — never on value
      // churn. settingsScope.getSnapshot() returns a fresh object per call,
      // so depending on snapshot.value would reset user input on every render
      // (typing appears dead).
      react.useEffect(function () {
        if (ready) setDraft(function (prev) { return Object.assign({}, prev, valueToDraft(snapshot.value)); });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__tv_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__tv_status" }, t("loading"));

      var value = snapshot.value;
      var user = snapshot.user || {};

      function fieldDraft(f) {
        if (f.type === "csv") return draft[f.key] !== void 0 ? draft[f.key] : draftToCsv(value[f.key]);
        if (f.type === "checkbox") return draft[f.key] !== void 0 ? draft[f.key] : Boolean(value[f.key]);
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[f.key] ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) {
          var next = Object.assign({}, prev);
          next[f.key] = v;
          return next;
        });
        setNotice(null);
        setError(null);
      }

      function setFields(fields) {
        setDraft(function (prev) { return Object.assign({}, prev, fields); });
        setNotice(null);
        setError(null);
      }

      var baseURLDraft = fieldDraft(FIELDS[0]);
      var modelDraft = fieldDraft(FIELDS[3]);
      var selectedProvider = PROVIDERS.find(function (p) { return p.baseURL && p.baseURL === baseURLDraft; }) || PROVIDERS[PROVIDERS.length - 1];

      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        var writes = FIELDS.map(function (f) {
          var d = fieldDraft(f);
          if (f.type === "csv") {
            var arr = String(d).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
            var cur = value[f.key] || [];
            if (arr.length === cur.length && arr.every(function (x, i) { return x === cur[i]; })) return Promise.resolve();
            return scope.set(f.key, arr);
          }
          if (f.type === "checkbox") {
            if (Boolean(d) === Boolean(value[f.key])) return Promise.resolve();
            return Boolean(d) ? scope.set(f.key, true) : scope.unset(f.key);
          }
          if (f.type === "password") {
            if (!d) return Promise.resolve(); // blank keeps the current key
            if (d === String(value[f.key] ?? "")) return Promise.resolve();
            return scope.set(f.key, d);
          }
          if (String(d) === String(value[f.key] ?? "")) return Promise.resolve();
          if (String(d).trim() === "" && !(f.key in user)) return Promise.resolve();
          return String(d).trim() === "" ? scope.unset(f.key) : scope.set(f.key, f.type === "number" ? Number(d) : d);
        });
        Promise.all(writes).then(function () {
          setBusy(false); setNotice(t("saved"));
          if (scope.load) scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function reseedDraft() {
        if (typeof scope.load === "function") {
          var p = scope.load();
          if (p && typeof p.then === "function") {
            p.then(function () {
              var fresh = scope.getSnapshot();
              if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
            }).catch(function () {});
            return;
          }
        }
        setTimeout(function () {
          var fresh = scope.getSnapshot();
          if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
        }, 120);
      }

      function onReset() {
        setBusy(true); setNotice(null); setError(null);
        Promise.all(FIELDS.map(function (f) { return scope.unset(f.key); })).then(function () {
          setBusy(false); setNotice(t("saved"));
          reseedDraft();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      return h("div", { className: "__tv_root" },
        h("p", { className: "__tv_hint", style: { margin: "0 0 4px" } }, t("intro")),
        h("div", { className: "__tv_quick" },
          h("div", { className: "__tv_quickTitle" }, t("quickTitle")),
          h("label", { className: "__tv_field" },
            h("span", { className: "__tv_label" }, t("provider")),
            h("select", {
              className: "__tv_input",
              value: selectedProvider.id,
              onChange: function (e) {
                var provider = PROVIDERS.find(function (p) { return p.id === e.target.value; });
                if (!provider) return;
                if (provider.id === "custom") {
                  setFields({ baseURL: "", apiKeyEnv: provider.keyEnv, model: "" });
                  return;
                }
                setFields({ baseURL: provider.baseURL, apiKeyEnv: provider.keyEnv, model: provider.models[0] || "" });
              }
            }, PROVIDERS.map(function (p) {
              return h("option", { key: p.id, value: p.id }, p.label);
            }))
          ),
          selectedProvider.models.length ? h("label", { className: "__tv_field" },
            h("span", { className: "__tv_label" }, t("presetModel")),
            h("select", {
              className: "__tv_input",
              value: selectedProvider.models.indexOf(modelDraft) >= 0 ? modelDraft : "__custom",
              onChange: function (e) {
                if (e.target.value !== "__custom") setFields({ model: e.target.value });
              }
            },
              selectedProvider.models.map(function (m) { return h("option", { key: m, value: m }, m); }),
              h("option", { value: "__custom" }, t("customModel"))
            )
          ) : h("div", { className: "__tv_field" },
            h("span", { className: "__tv_label" }, t("presetModel")),
            h("span", { className: "__tv_hint" }, t("customModel"))
          )
        ),
        FIELDS.map(function (f) {
          var overridden = f.key in user;
          if (f.type === "checkbox") {
            return h("label", { key: f.key, className: "__tv_field" },
              h("span", { className: "__tv_row" },
                h("input", { className: "__tv_check", type: "checkbox", checked: Boolean(fieldDraft(f)), onChange: function (e) { setField(f, e.target.checked); } }),
                h("span", { className: "__tv_label" }, labelOf(f)),
                overridden ? h("span", { className: "__tv_override" }, t("overridden")) : null
              ),
              f.key in ZH_HINTS ? h("span", { className: "__tv_hint" }, t(ZH_HINTS[f.key])) : null
            );
          }
          return h("label", { key: f.key, className: "__tv_field" },
            h("span", { className: "__tv_label" },
              labelOf(f),
              overridden ? h("span", { className: "__tv_override" }, t("overridden")) : null
            ),
            h("input", {
              className: "__tv_input",
              type: f.type === "password" ? "password" : f.type === "number" ? "number" : "text",
              value: fieldDraft(f),
              placeholder: f.type === "password" ? (overridden ? "••••••••" : t("apiKeyHint")) : (f.placeholder || ""),
              onChange: function (e) { setField(f, e.target.value); }
            }),
            f.key in ZH_HINTS ? h("span", { className: "__tv_hint" }, t(ZH_HINTS[f.key])) : null
          );
        }),
        h("div", { className: "__tv_actions" },
          h("button", { type: "button", className: "__tv_btn __tv_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__tv_btn", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__tv_status" }, notice) : null,
          busy ? h("span", { className: "__tv_status" }, t("saving")) : null,
          error ? h("span", { className: "__tv_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i += 1) {
        var f = FIELDS[i];
        out[f.key] = f.type === "csv" ? draftToCsv(value[f.key]) : f.type === "checkbox" ? Boolean(value[f.key]) : String(value[f.key] ?? "");
      }
      return out;
    }
    function draftToCsv(arr) {
      return Array.isArray(arr) ? arr.join(", ") : String(arr ?? "");
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-tool-vision: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: "tool-vision" });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "tool-vision",
          order: 20,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(VisionSection, Object.assign({}, props, { scope: scope }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
