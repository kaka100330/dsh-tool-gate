window.__ModuleLoader__.load({
  id: "dsh-tool-gate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useReducer } = React;

    /**
     * Host entry id: the bundle's package name. The settings page renders on this
     * bundle's own detail page under `plugins.bundle.config`, whose owner props do
     * NOT carry a form — only `view` — so the form is fetched here by entry id.
     */
    const ENTRY_ID = "dsh-tool-gate";

    const CSS = [
      "[data-dsh-tg]{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px}",
      "[data-dsh-tg] *{box-sizing:border-box}",
      "[data-dsh-tg] .dsh-tg-lead{margin:0 0 14px;color:var(--dsw-alias-label-tertiary,#8a919e);font-size:12px;line-height:18px}",
      "[data-dsh-tg] .dsh-tg-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}",
      "[data-dsh-tg] .dsh-tg-row{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
      "[data-dsh-tg] .dsh-tg-row:first-child{border-top:0;padding-top:2px}",
      "[data-dsh-tg] .dsh-tg-main{flex:1;min-width:0}",
      "[data-dsh-tg] .dsh-tg-name{font-size:13px;line-height:20px;font-weight:500}",
      "[data-dsh-tg] .dsh-tg-hint{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}",
      "[data-dsh-tg] .dsh-tg-toggle{position:relative;flex:none;width:36px;height:20px;margin-top:2px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-bg-skeleton,#d9dde4);cursor:pointer;transition:background .15s ease}",
      "[data-dsh-tg] .dsh-tg-toggle[data-on=\"true\"]{background:var(--dsw-alias-brand-primary,#4f7cff)}",
      "[data-dsh-tg] .dsh-tg-toggle:disabled{opacity:.45;cursor:default}",
      "[data-dsh-tg] .dsh-tg-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:transform .15s ease}",
      "[data-dsh-tg] .dsh-tg-toggle[data-on=\"true\"] .dsh-tg-knob{transform:translateX(16px)}",
      "[data-dsh-tg] .dsh-tg-group{margin:18px 0 0;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#5c6370)}",
      "[data-dsh-tg] .dsh-tg-status{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}",
      "[data-dsh-tg] .dsh-tg-status[data-error=\"true\"]{color:var(--dsw-alias-state-error-primary,#e5484d)}",
      "[data-dsh-tg] .dsh-tg-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}",
    ].join("");

    /** Inject the stylesheet once per document. */
    function useStyles() {
      useEffect(() => {
        const id = "dsh-tool-gate-style";
        if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return;
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-tool-gate";
        tag.dataset.pluginCss = id;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }, []);
    }

    /** The switches this page owns, in display order. */
    const FIELDS = [
      {
        group: "总开关",
        field: "enabled",
        label: "启用工具网关",
        hint: "把第三方工具按家族收进网关，使 wire 上的工具数组在会话内逐字节恒定。关闭时本插件完全不介入。",
      },
      {
        group: "行为",
        field: "listDetail",
        label: "list 返回完整参数定义",
        hint: "开启时 action=list 返回成员的名字、说明与完整参数定义，模型一次就能调对；关闭更省 token，但可能多试一轮。",
      },
      {
        group: "行为",
        field: "staticNotice",
        label: "在系统提示里说明网关",
        hint: "加一句「这些工具已收进网关」的固定说明，帮模型知道要去 list。这段文字会占用少量固定前缀。",
      },
      {
        group: "行为",
        field: "interceptDirectCalls",
        label: "拦截绕过网关的直呼",
        hint: "模型直接调用已收起工具时给出提示、改走网关。关闭后直呼会正常执行（工具仍在注册表里）。",
      },
      {
        group: "行为",
        field: "guardFallback",
        label: "额外挂执行期守卫",
        hint: "再挂一道 tools.guard 兜住重入路径里的直呼。更严格，且不会引起工具集变化。",
      },
      {
        group: "行为",
        field: "concurrencyDelegate",
        label: "沿用成员自身的并发安全声明",
        hint: "开启后同一轮的多个网关调用可能并发执行；关闭则一律串行（更保守）。",
      },
      {
        group: "高级",
        field: "freeze",
        label: "会话内冻结工具集",
        hint: "只有冻结才能让前缀不再变化。关掉会每轮重算，等于失去本插件的意义，仅用于排查。",
      },
    ];

    /** Read one field's value out of a form snapshot. */
    function valueOf(snapshot, field) {
      const value = snapshot === undefined ? undefined : snapshot.value;
      return value !== null && typeof value === "object" ? value[field] : undefined;
    }

    /**
     * Bind the Host-backed form.
     *
     * Reads come from the controller's snapshot, writes go through `mutate`, which
     * is revision-fenced: a stale editor is refused instead of silently
     * overwriting a concurrent change.
     */
    function useForm(scope) {
      const [, bump] = useReducer((n) => n + 1, 0);
      useEffect(() => {
        if (scope === undefined || scope === null) return undefined;
        const off = scope.subscribe(() => bump());
        return typeof off === "function" ? off : undefined;
      }, [scope]);
      const state = scope === undefined || scope === null ? undefined : scope.getSnapshot();
      const write = (field, value) => {
        if (scope === undefined || scope === null) return;
        void scope.mutate(
          [{ op: value === undefined ? "unset" : "set", path: [field], ...(value === undefined ? {} : { value }) }],
          state === undefined ? undefined : state.revision,
        );
      };
      return { state, write };
    }

    /** One switch row. */
    function Row(props) {
      return h(
        "li",
        { className: "dsh-tg-row" },
        h(
          "div",
          { className: "dsh-tg-main" },
          h("div", { className: "dsh-tg-name" }, props.label),
          props.hint === undefined ? null : h("p", { className: "dsh-tg-hint" }, props.hint),
        ),
        h(
          "button",
          {
            type: "button",
            role: "switch",
            "aria-checked": props.checked,
            "aria-label": props.label,
            className: "dsh-tg-toggle",
            "data-on": props.checked ? "true" : "false",
            "data-field": props.field,
            disabled: props.disabled,
            onClick: () => props.onChange(!props.checked),
          },
          h("span", { className: "dsh-tg-knob" }),
        ),
      );
    }

    /** The full page shown on this bundle's detail page. */
    function SettingsPage(props) {
      useStyles();
      const { state, write } = useForm(props.form);
      const status = state === undefined ? "loading" : state.status;
      const writable = state !== undefined && state.writable === true;
      const ready = status === "ready";
      const disabled = !ready || !writable;

      const groups = [];
      for (const field of FIELDS) {
        const last = groups[groups.length - 1];
        if (last !== undefined && last.group === field.group) last.fields.push(field);
        else groups.push({ group: field.group, fields: [field] });
      }

      let notice = null;
      if (disabled) {
        notice = h(
          "p",
          { className: "dsh-tg-status", "data-error": status === "unavailable" ? "true" : "false" },
          status === "unavailable"
            ? "这个 profile 没有暴露本插件的配置，无法在此编辑。"
            : ready
              ? "当前配置为只读。"
              : "正在读取配置…",
        );
      }

      return h(
        "div",
        { "data-dsh-tg": "" },
        h(
          "p",
          { className: "dsh-tg-lead" },
          "把第三方工具按家族收进 8 个固定网关工具，使 wire 上的工具数组在会话内逐字节恒定，"
            + "从而不再因为工具定义变化而重付整段提示前缀。改动即时生效，无需重启。",
        ),
        notice,
        ...groups.map((group) =>
          h(
            "div",
            { key: group.group },
            h("p", { className: "dsh-tg-group" }, group.group),
            h(
              "ul",
              { className: "dsh-tg-list" },
              ...group.fields.map((field) =>
                h(Row, {
                  key: field.field,
                  field: field.field,
                  label: field.label,
                  hint: field.hint,
                  checked: valueOf(state, field.field) === true,
                  disabled,
                  onChange: (next) => write(field.field, next),
                }),
              ),
            ),
          ),
        ),
        h(
          "p",
          { className: "dsh-tg-status" },
          "家族的包名/前缀映射、强制常驻与强制收起、网关前缀等高级项，可在 profile 的 cordis.patch.yml 中本插件的 config 段调整。",
        ),
      );
    }

    /** One-line summary for the plugin card. */
    function Summary(props) {
      const { state } = useForm(props.form);
      if (state === undefined || state.status !== "ready") return null;
      return h(
        "p",
        { className: "dsh-tg-summary" },
        valueOf(state, "enabled") === true
          ? "工具网关已启用：第三方工具按家族收起，wire 工具数组在会话内保持恒定。"
          : "工具网关未启用：全部工具照常上 wire。打开开关即可启用。",
      );
    }

    /** `plugins.bundle.config` cell: the page manager asks for one view at a time. */
    function BundleConfig(props) {
      if (props === undefined || props === null) return null;
      if (props.view === "summary") return h(Summary, { form: props.form });
      if (props.view !== "page") return null;
      return h(SettingsPage, { form: props.form });
    }

    function apply(ctx) {
      /** The form for this bundle's own entry; created lazily so a profile without it still loads. */
      const scope = ctx.configForms.get(ENTRY_ID);
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          { name: "plugins.bundle.config", key: ENTRY_ID, inject: () => ({ form: scope }) },
          BundleConfig,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "configForms"];
    exports.name = "dsh-tool-gate";
    return module.exports;
  },
});
