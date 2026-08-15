/**
 * dsh-easy-setup — browser half.
 *
 * Two consolidated sections inside the Web UI settings page:
 *
 *   1. 人设管理 — content editor plus dsh-soul-md persona parameters.
 *   2. 高级设置 — skin management and one-click migration. Migration can
 *      pick a Codex / Claude Code folder (their install/config
 *      dir or a project dir), register it as a workspace, open a fresh
 *      session there, and AUTO-SEND the migration instruction through the
 *      session-scoped conversation service; the agent then performs the
 *      migration visibly in the conversation as tool calls.
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-easy-setup",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS = ".__es_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__es_field{display:flex;flex-direction:column;gap:4px}" +
      ".__es_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__es_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__es_textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__es_textarea{min-height:220px;resize:vertical;font-family:var(--dsw-alias-font-mono,monospace);line-height:1.5}" +
      ".__es_row{display:flex;align-items:center;gap:8px}" +
      ".__es_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__es_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__es_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__es_btn:disabled{opacity:.5;cursor:default}" +
      ".__es_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__es_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__es_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__es_ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}" +
      ".__es_path{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}" +
      ".__es_details{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__es_details summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}" +
      ".__es_prompt{white-space:pre-wrap;font-family:var(--dsw-alias-font-mono,monospace);font-size:11px;line-height:1.5;max-height:240px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__es_hub{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px}" +
      ".__es_tabs{display:flex;align-items:flex-end;gap:20px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".__es_tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;padding:7px 2px 8px;cursor:pointer}" +
      ".__es_tab:hover,.__es_tab[data-active=true]{color:var(--dsw-alias-label-primary)}" +
      ".__es_tab[data-active=true]{border-bottom-color:var(--dsw-alias-state-business-primary)}" +
      ".__es_panel{min-width:0}" +
      ".__es_group{display:flex;flex-direction:column;gap:10px}" +
      ".__es_group+.__es_group{border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}" +
      ".__es_groupTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}";
    var tagId = "dsh-easy-setup/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-easy-setup";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "easySetup";
    var zh = {
      save: "保存",
      saved: "已保存，即时生效",
      saving: "保存中…",
      personaNav: "人设管理",
      personaContent: "人设内容",
      personaSettings: "人设参数",
      personaIntro: "直接编辑人设卡（soul.md）：保存后约 300ms 热重载生效，无需重启。文件变更也会被 dsh-soul-md 自动监听。",
      personaBraceWarn: "内容包含双花括号定界符（提示词变量语法，soul-md 无转义），保存后对话会渲染失败——请改写这些位置后再保存。",
      loadFail: "读取人设失败",
      saveFail: "保存失败",
      missing: "（文件尚不存在，保存时将创建）",
      advancedNav: "高级设置",
      skinNav: "皮肤",
      migrationNav: "一键迁移（夺舍）",
      migrationIntro: "从 Codex / Claude Code 一键迁移：选择它们的安装/配置目录（如 ~/.codex、~/.claude，也可以是普通项目目录）→ 目录自动注册为工作区并新建对话 → 迁移指令自动发送，AI 会在对话里把技能（skills）、MCP 服务器和长期记忆（CLAUDE.md / AGENTS.md）全部搬进 DSH，每一步的工具调用全程可视化。",
      start: "选择文件夹并开始迁移",
      working: "处理中…",
      cancelHint: "已取消选择",
      sentHint: "已新建对话并自动发送迁移指令——切换到该对话即可观看 AI 逐步完成迁移。",
      failHint: "迁移启动失败",
      copyOnly: "仅复制迁移指令",
      viewPrompt: "查看迁移指令内容"
    };
    var en = {
      save: "Save",
      saved: "Saved — effective immediately",
      saving: "Saving…",
      personaNav: "Persona Management",
      personaContent: "Persona Content",
      personaSettings: "Persona Settings",
      personaIntro: "Edit the persona card (soul.md) directly; hot-reloads within ~300ms of saving — no restart needed.",
      personaBraceWarn: "The content contains double-brace delimiters (prompt-variable syntax; soul-md has no escape) — sending will fail to render. Rewrite those spots before saving.",
      loadFail: "Failed to load persona",
      saveFail: "Save failed",
      missing: "(file missing; created on save)",
      advancedNav: "Advanced Settings",
      skinNav: "Skins",
      migrationNav: "One-click Migration",
      migrationIntro: "Migrate from Codex / Claude Code in one click: pick their install/config folder (e.g. ~/.codex, ~/.claude — an ordinary project folder works too) → it becomes a workspace with a fresh session → the migration prompt is sent automatically, and the agent moves skills, MCP servers and memories into DSH with every tool call visible in the conversation.",
      start: "Pick folder & start",
      working: "Working…",
      cancelHint: "Cancelled",
      sentHint: "Session ready and the migration prompt was sent — switch to it and watch the agent migrate step by step.",
      failHint: "Failed to start migration",
      copyOnly: "Copy prompt only",
      viewPrompt: "View the migration prompt"
    };

    // ── remote face (easySetup) ───────────────────────────────────────────
    var looseCodec = () => ({
      mode: "strict",
      typeSymbol: "@deepseek-ai/dsh-easy-setup/types#Json",
      schema: { parse: (value) => value }
    });
    var descriptor = (method, parameters) => ({
      id: `@deepseek-ai/dsh-easy-setup#easySetup/${method}`,
      service: "easySetup",
      namespace: "easySetup",
      method,
      invocation: { kind: "direct" },
      parameters: parameters.map((name) => ({ name, wire: name, source: "json", codec: looseCodec() })),
      result: looseCodec()
    });
    var REMOTE = {
      package: "@deepseek-ai/dsh-easy-setup",
      descriptors: [
        descriptor("readPersona", []),
        descriptor("writePersona", ["content"]),
        descriptor("migrationPrompt", [])
      ]
    };

    function SettingsHub(props) {
      var tabs = props.tabs;
      var activeState = react.useState(tabs[0].id);
      var active = activeState[0];
      var setActive = activeState[1];
      return h("div", { className: "__es_hub" },
        h("div", { className: "__es_tabs", role: "tablist" }, tabs.map(function (tab) {
          return h("button", {
            key: tab.id,
            type: "button",
            role: "tab",
            className: "__es_tab",
            "aria-selected": active === tab.id,
            "data-active": active === tab.id,
            onClick: function () { setActive(tab.id); }
          }, tab.label);
        })),
        h("div", { className: "__es_panel", role: "tabpanel" }, props.renderSlot(props.slot, {}, { only: active }))
      );
    }

    function PersonaHub(props) {
      return h("div", { className: "__es_hub" },
        h("section", { className: "__es_group" },
          h("h3", { className: "__es_groupTitle" }, props.t("personaContent")),
          props.renderSlot("settings.persona.panel", {}, { only: "content" })
        ),
        h("section", { className: "__es_group" },
          h("h3", { className: "__es_groupTitle" }, props.t("personaSettings")),
          props.renderSlot("settings.persona.panel", {}, { only: "settings" })
        )
      );
    }

    // ── section 1: persona editor ────────────────────────────────────────
    function PersonaEditor(props) {
      var t = props.t;
      var remote = props.remote;
      var state = react.useState({ status: "loading", path: "", content: "", exists: true });
      var data = state[0];
      var setData = state[1];
      var draftState = react.useState("");
      var draft = draftState[0];
      var setDraft = draftState[1];
      var busyState = react.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];

      react.useEffect(function () {
        var alive = true;
        remote().then(function (svc) { return svc.readPersona(); }).then(function (res) {
          if (!alive) return;
          // typert 远程结果统一 { ok, value } 包装：host 方法的返回在 value 里。
          var data2 = res && res.ok ? res.value : null;
          if (!data2 || !data2.ok) { setData({ status: "error", path: "", content: "", exists: false }); return; }
          setData({ status: "ready", path: data2.path, content: data2.content || "", exists: data2.exists });
          setDraft(data2.content || "");
        }).catch(function () { if (alive) setData({ status: "error", path: "", content: "", exists: false }); });
        return function () { alive = false; };
      }, []);

      // soul-md 把 soul.md 当提示词模板渲染，双花括号是变量语法且无转义；
      // 含有它们的卡片会让整个对话渲染失败——保存前拦下并提示。
      var braces = /\{\{|\}\}/.test(draft);

      function onSave() {
        if (braces) return;
        setBusy("saving");
        remote().then(function (svc) { return svc.writePersona(draft); }).then(function (res) {
          var data2 = res && res.ok ? res.value : null;
          if (data2 && data2.ok) {
            setBusy("saved");
            setData(function (prev) { return { status: "ready", path: data2.path, content: draft, exists: true }; });
          } else {
            setBusy("error:" + ((data2 && data2.error) || (res && res.error && res.error.message) || "unknown"));
          }
        }).catch(function (e) { setBusy("error:" + String(e && e.message || e)); });
      }

      if (data.status === "loading") return h("p", { className: "__es_status" }, "…");
      if (data.status === "error") return h("p", { className: "__es_error" }, t("loadFail"));

      return h("div", { className: "__es_root" },
        h("p", { className: "__es_hint", style: { margin: 0 } }, t("personaIntro")),
        h("span", { className: "__es_path" }, data.path + (data.exists ? "" : " " + t("missing"))),
        h("textarea", {
          className: "__es_textarea",
          value: draft,
          onChange: function (e) { setDraft(e.target.value); setBusy(null); },
          spellCheck: false
        }),
        h("div", { className: "__es_actions" },
          h("button", { className: "__es_btn __es_btnPrimary", disabled: busy === "saving" || braces || draft === data.content, onClick: onSave }, busy === "saving" ? t("saving") : t("save")),
          braces ? h("span", { className: "__es_error" }, t("personaBraceWarn")) : null,
          busy === "saved" ? h("span", { className: "__es_ok" }, t("saved")) : null,
          typeof busy === "string" && busy.indexOf("error:") === 0 ? h("span", { className: "__es_error" }, t("saveFail") + ": " + busy.slice(6)) : null
        )
      );
    }

    // ── section 2: one-click migration ───────────────────────────────────
    function Migration(props) {
      var t = props.t;
      var ctx = props.ctx;
      var remote = props.remote;
      var state = react.useState({ status: "idle", prompt: "", path: "" });
      var data = state[0];
      var setState = state[1];

      react.useEffect(function () {
        var alive = true;
        remote().then(function (svc) { return svc.migrationPrompt(); }).then(function (res) {
          var data2 = res && res.ok ? res.value : null;
          if (alive && data2 && data2.ok) setState(function (prev) { return { status: prev.status, prompt: data2.prompt, path: prev.path }; });
        }).catch(function () {});
        return function () { alive = false; };
      }, []);

      function stagePrompt(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).catch(function () {});
        }
        return Promise.resolve();
      }

      // Resolve the session-scoped conversation face (same pattern the
      // conversation package's own scopedConversation helper uses), retrying
      // briefly while the fresh session lands in the list store.
      function scopedConversation(sessionId, remaining) {
        return new Promise(function (resolve, reject) {
          var attempt = function (left) {
            var scoped;
            var conversation;
            try {
              scoped = ctx.sessions.scope(sessionId);
              conversation = scoped ? scoped.get("conversation") : undefined;
            } catch (e) { /* retry below */ }
            if (conversation && typeof conversation.send === "function") { resolve(conversation); return; }
            if (left <= 0) { reject(new Error("无法在会话作用域内解析 conversation 服务")); return; }
            setTimeout(function () { attempt(left - 120); }, 120);
          };
          attempt(remaining);
        });
      }

      function onStart() {
        if (!ctx.workspaces || !ctx.sessions) {
          setState({ status: "error", prompt: data.prompt, path: "workspaces/sessions 服务不可用" });
          return;
        }
        setState({ status: "working", prompt: data.prompt, path: "" });
        ctx.workspaces.pickDirectory().then(function (path) {
          if (!path) { setState({ status: "idle", prompt: data.prompt, path: "" }); return null; }
          return ctx.workspaces.create({ path: path }).then(function (ws) {
            return ctx.workspaces.connectWorkspace(ws.workspaceId).then(function (sessionId) {
              ctx.sessions.open(sessionId);
              return scopedConversation(sessionId, 8000).then(function (conversation) {
                // Fire the migration turn; its tool calls unfold visibly in
                // the conversation view (send resolves when the turn ends).
                conversation.send(data.prompt).catch(function () {});
                setState({ status: "sent", prompt: data.prompt, path: path });
              });
            });
          });
        }).catch(function (e) {
          setState({ status: "error", prompt: data.prompt, path: String(e && e.message || e) });
        });
      }

      return h("div", { className: "__es_root" },
        h("p", { className: "__es_hint", style: { margin: 0 } }, t("migrationIntro")),
        h("div", { className: "__es_actions" },
          h("button", { className: "__es_btn __es_btnPrimary", disabled: data.status === "working" || !data.prompt, onClick: onStart },
            data.status === "working" ? t("working") : t("start")),
          data.prompt ? h("button", { className: "__es_btn", onClick: function () { stagePrompt(data.prompt); } }, t("copyOnly")) : null
        ),
        data.status === "sent" ? h("span", { className: "__es_ok" }, t("sentHint")) : null,
        data.status === "error" ? h("span", { className: "__es_error" }, t("failHint") + ": " + data.path) : null,
        data.path && data.status === "sent" ? h("span", { className: "__es_path" }, data.path) : null,
        data.prompt ? h("details", { className: "__es_details" },
          h("summary", null, t("viewPrompt")),
          h("pre", { className: "__es_prompt" }, data.prompt)
        ) : null
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    var inject = ["slots", "locale", "remote", "sessions", "workspaces"];

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-easy-setup: dictionaries");

      var mountPromise = ctx.remote.$mount(REMOTE).then(function (dispose) {
        ctx.effect(function () { return dispose; }, "dsh-easy-setup: remote face");
        return null;
      }, function (error) {
        console.error("dsh-easy-setup: remote face mount failed", error);
        throw error;
      });
      var remote = function () {
        var service = ctx.get("remote.easySetup");
        if (service) return Promise.resolve(service);
        return mountPromise.catch(function () {}).then(function () {
          var retry = ctx.get("remote.easySetup");
          if (!retry) throw new Error("easySetup 远程接口未注册");
          return retry;
        });
      };

      var modelLabel = function () { return ctx.locale.getSnapshot().active === "zh" ? "模型管理" : "Model Management"; };
      var pluginLabel = function () { return ctx.locale.getSnapshot().active === "zh" ? "插件管理" : "Plugin Management"; };
      var renameBuiltInSections = function () {
        var entries = ctx.slots.entries("settings.section");
        for (var i = 0; i < entries.length; i += 1) {
          if (entries[i].options.id === "models") entries[i].options.label = modelLabel;
          if (entries[i].options.id === "plugins") entries[i].options.label = pluginLabel;
        }
      };
      renameBuiltInSections();
      ctx.effect(function () { return ctx.slots.subscribe("settings.section", renameBuiltInSections); }, "dsh-easy-setup: managed built-in labels");

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "persona",
          order: 24,
          label: function () { return t("personaNav"); },
          locale: NS,
          children: { "settings.persona.panel": { kind: "list", scope: "root" } }
        }, function (props) {
          return h(PersonaHub, Object.assign({}, props, { t: t }));
        });
      });
      ctx.slots.inject("settings.persona.panel", function () {
        return ctx.slots.register({
          name: "settings.persona.panel",
          id: "content",
          order: 0,
          label: function () { return t("personaContent"); },
          locale: NS
        }, function (props) {
          return h(PersonaEditor, Object.assign({}, props, { remote: remote }));
        });
      });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "advanced",
          order: 90,
          label: function () { return t("advancedNav"); },
          locale: NS,
          children: { "settings.advanced.panel": { kind: "list", scope: "root" } }
        }, function (props) {
          return h(SettingsHub, Object.assign({}, props, { slot: "settings.advanced.panel", tabs: [
            { id: "skin", label: t("skinNav") },
            { id: "migration", label: t("migrationNav") }
          ] }));
        });
      });
      ctx.slots.inject("settings.advanced.panel", function () {
        return ctx.slots.register({
          name: "settings.advanced.panel",
          id: "migration",
          order: 10,
          label: function () { return t("migrationNav"); },
          locale: NS
        }, function (props) {
          return h(Migration, Object.assign({}, props, { remote: remote, ctx: ctx }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
