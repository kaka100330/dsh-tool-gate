window.__ModuleLoader__.load({
  id: "dsh-tool-gate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useMemo, useReducer, useState } = React;

    /**
     * Host entry id: the bundle's package name. The settings page renders on this
     * bundle's own detail page under `plugins.bundle.config`, whose owner props do
     * NOT carry a form — only `view` — so the form is fetched here by entry id.
     */
    const ENTRY_ID = "dsh-tool-gate";

    /** Read-only host route that returns the live inventory this page renders. */
    const BRIDGE = "/api/dsh-tool-gate/describe";

    const CSS = [
      "[data-dsh-tg]{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px}",
      "[data-dsh-tg] *{box-sizing:border-box}",
      "[data-dsh-tg] .dsh-tg-lead{margin:0 0 14px;color:var(--dsw-alias-label-tertiary,#8a919e);font-size:12px;line-height:18px}",
      "[data-dsh-tg] .dsh-tg-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}",
      "[data-dsh-tg] .dsh-tg-row{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
      "[data-dsh-tg] .dsh-tg-row:first-child{border-top:0;padding-top:2px}",
      "[data-dsh-tg] .dsh-tg-main{flex:1;min-width:0}",
      "[data-dsh-tg] .dsh-tg-name{font-size:13px;line-height:20px;font-weight:500;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      "[data-dsh-tg] .dsh-tg-hint{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}",
      "[data-dsh-tg] .dsh-tg-meta{margin:3px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a919e);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}",
      "[data-dsh-tg] .dsh-tg-toggle{position:relative;flex:none;width:36px;height:20px;margin-top:2px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-bg-skeleton,#d9dde4);cursor:pointer;transition:background .15s ease}",
      "[data-dsh-tg] .dsh-tg-toggle[data-on=\"true\"]{background:var(--dsw-alias-brand-primary,#4f7cff)}",
      "[data-dsh-tg] .dsh-tg-toggle:disabled{opacity:.45;cursor:default}",
      "[data-dsh-tg] .dsh-tg-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:transform .15s ease}",
      "[data-dsh-tg] .dsh-tg-toggle[data-on=\"true\"] .dsh-tg-knob{transform:translateX(16px)}",
      "[data-dsh-tg] .dsh-tg-group{margin:22px 0 0;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#5c6370)}",
      "[data-dsh-tg] .dsh-tg-group:first-of-type{margin-top:16px}",
      "[data-dsh-tg] .dsh-tg-badge{flex:none;padding:0 6px;border-radius:4px;font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8a919e);background:var(--dsw-alias-bg-skeleton,rgba(0,0,0,.05))}",
      "[data-dsh-tg] .dsh-tg-badge[data-kind=\"builtin\"]{color:var(--dsw-alias-brand-primary,#4f7cff);background:rgba(79,124,255,.12)}",
      "[data-dsh-tg] .dsh-tg-badge[data-kind=\"off\"]{color:var(--dsw-alias-label-tertiary,#8a919e)}",
      "[data-dsh-tg] .dsh-tg-status{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}",
      "[data-dsh-tg] .dsh-tg-status[data-error=\"true\"]{color:var(--dsw-alias-state-error-primary,#e5484d)}",
      "[data-dsh-tg] .dsh-tg-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}",
      "[data-dsh-tg] .dsh-tg-empty{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}",
      "[data-dsh-tg] .dsh-tg-bar{display:flex;gap:8px;margin:14px 0 0;flex-wrap:wrap}",
      "[data-dsh-tg] .dsh-tg-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:inherit;cursor:pointer}",
      "[data-dsh-tg] .dsh-tg-btn:disabled{opacity:.45;cursor:default}",
    ].join("");

    /** Inject the stylesheet once per document. */
    function useStyles() {
      useEffect(() => {
        const id = "dsh-tool-gate-style";
        if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return;
        const tag = document.createElement("style");
        tag.dataset.pluginCss = id;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }, []);
    }

    /** Approximate token weight, matching the host's own bytes/3.2 estimate. */
    function tokens(count) {
      if (count === undefined || count === null) return "?";
      if (count >= 1000) return (count / 1000).toFixed(1) + "k";
      return String(count);
    }

    /**
     * Read the config form's snapshot but DO NOT subscribe.
     *
     * The form is a mutable controller, not a store hook; `useFormState` below
     * subscribes once per page and re-reads on every change.
     */
    function readForm(form) {
      if (form === undefined || form === null || typeof form.getSnapshot !== "function") {
        return { status: "unavailable", value: {}, revision: undefined, writable: false, mode: undefined };
      }
      try {
        return form.getSnapshot();
      } catch {
        return { status: "unavailable", value: {}, revision: undefined, writable: false, mode: undefined };
      }
    }

    /** Subscribe to one config form and re-render on change. */
    function useFormState(form) {
      const [, bump] = useReducer((n) => n + 1, 0);
      const [snapshot, setSnapshot] = useState(() => readForm(form));
      useEffect(() => {
        if (form === undefined || form === null || typeof form.subscribe !== "function") return undefined;
        setSnapshot(readForm(form));
        const unsubscribe = form.subscribe(() => {
          setSnapshot(readForm(form));
          bump();
        });
        return typeof unsubscribe === "function" ? unsubscribe : undefined;
      }, [form]);
      return snapshot;
    }

    /** Read one top-level field from the snapshot, honouring the schema default. */
    function valueOf(snapshot, field, fallback) {
      const value = snapshot?.value;
      if (value === null || typeof value !== "object") return fallback;
      const raw = value[field];
      return raw === undefined ? fallback : raw;
    }

    /** Read `dict[key]`, or undefined. */
    function dictAt(snapshot, field, key) {
      const dict = valueOf(snapshot, field, undefined);
      if (dict === null || typeof dict !== "object") return undefined;
      return dict[key];
    }

    /** A switch that renders the design's own toggle instead of a checkbox. */
    function Toggle({ on, disabled, label, onToggle }) {
      return h(
        "button",
        {
          type: "button",
          className: "dsh-tg-toggle",
          role: "switch",
          "aria-checked": on ? "true" : "false",
          "aria-label": label,
          "data-on": on ? "true" : "false",
          disabled: disabled === true,
          onClick: onToggle,
        },
        h("span", { className: "dsh-tg-knob" }),
      );
    }

    /** One labelled row with a switch on the right. */
    function Row({ label, hint, meta, badges, on, disabled, onToggle }) {
      return h(
        "li",
        { className: "dsh-tg-row" },
        h(
          "div",
          { className: "dsh-tg-main" },
          h(
            "div",
            { className: "dsh-tg-name" },
            h("span", null, label),
            ...(badges ?? []).map((badge, index) =>
              h("span", { key: index, className: "dsh-tg-badge", "data-kind": badge.kind }, badge.text),
            ),
          ),
          hint === undefined ? null : h("p", { className: "dsh-tg-hint" }, hint),
          meta === undefined ? null : h("p", { className: "dsh-tg-meta" }, meta),
        ),
        h(Toggle, { on, disabled, label, onToggle }),
      );
    }

    /**
     * The page.
     *
     * Two data sources, on purpose: the config form owns *what is switched on*
     * (and is the only writer), while the bridge owns *what exists right now*
     * (member counts, token weights, which plugins inject prompt text). Neither
     * can be derived from the other — the registry changes without a config edit.
     */
    function SettingsPage({ form }) {
      useStyles();
      const snapshot = useFormState(form);
      const ready = snapshot.status === "ready" && snapshot.writable === true;
      const [inventory, setInventory] = useState({ status: "loading" });
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState(undefined);
      const [reloadKey, setReloadKey] = useState(0);

      useEffect(() => {
        let cancelled = false;
        const controller = typeof AbortController === "function" ? new AbortController() : undefined;
        setInventory((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
        fetch(BRIDGE, { method: "GET", credentials: "same-origin", signal: controller?.signal })
          .then((response) => response.json())
          .then((body) => {
            if (cancelled) return;
            if (body?.ok === true) setInventory({ status: "ready", value: body.value });
            else setInventory({ status: "error", message: body?.error ?? "unknown error" });
          })
          .catch((error) => {
            if (cancelled) return;
            setInventory({ status: "error", message: String(error?.message ?? error) });
          });
        return () => {
          cancelled = true;
          controller?.abort();
        };
      }, [reloadKey]);

      /** Write one config path, then refresh the inventory. */
      const write = (path, value) => {
        if (form === undefined || form === null || typeof form.mutate !== "function") return;
        setBusy(true);
        setMessage(undefined);
        const operations = [{ op: "set", path, value }];
        Promise.resolve(form.mutate(operations, snapshot.revision))
          .then(() => {
            setMessage({ text: "已保存", error: false });
            setReloadKey((key) => key + 1);
          })
          .catch((error) => setMessage({ text: String(error?.message ?? error), error: true }))
          .finally(() => setBusy(false));
      };

      /** Write several paths in one revision-checked batch. */
      const writeAll = (operations) => {
        if (form === undefined || form === null || typeof form.mutate !== "function") return;
        if (operations.length === 0) return;
        setBusy(true);
        setMessage(undefined);
        Promise.resolve(form.mutate(operations, snapshot.revision))
          .then(() => {
            setMessage({ text: "已保存", error: false });
            setReloadKey((key) => key + 1);
          })
          .catch((error) => setMessage({ text: String(error?.message ?? error), error: true }))
          .finally(() => setBusy(false));
      };

      const enabled = valueOf(snapshot, "enabled", false) === true;
      const builtinFamilies = valueOf(snapshot, "builtinFamilies", true) !== false;
      const autoFamilies = valueOf(snapshot, "autoFamilies", true) !== false;
      const promptDisclosure = valueOf(snapshot, "promptDisclosure", false) === true;
      const data = inventory.status === "ready" ? inventory.value : undefined;

      const familyRows = useMemo(() => data?.families ?? [], [data]);
      /**
       * Every plugin gets a row, not just the ones injecting prose today: the whole
       * point is that a plugin which starts injecting tomorrow needs no code change
       * here. Rows that cannot be disclosed yet render greyed out with a reason.
       */
      const pluginRows = useMemo(() => data?.plugins ?? [], [data]);

      const header =
        data === undefined
          ? undefined
          : `wire 上 ${data.wireToolCount} 个工具；已收起 ${data.families.filter((family) => family.enabled).length}`
            + ` 个家族，约省 ${tokens(data.savedTokens)} tok。`;

      return h(
        "div",
        { "data-dsh-tg": "true" },
        h(
          "p",
          { className: "dsh-tg-lead" },
          "第三方与低频工具按家族收进网关：wire 上的 tool 定义在会话内逐字节恒定，"
            + "成员的名字、说明与参数只在第一次 action=list 时才进入上下文。",
        ),
        h(
          "ul",
          { className: "dsh-tg-list" },
          h(Row, {
            label: "启用工具网关",
            hint: "总开关。关闭时本插件完全不介入：不注册网关、不折叠任何工具、不改提示词。",
            on: enabled,
            disabled: busy || !ready,
            onToggle: () => write(["enabled"], !enabled),
          }),
        ),

        // ——— families ———
        h("h4", { className: "dsh-tg-group" }, "家族折叠"),
        data === undefined
          ? h("p", { className: "dsh-tg-empty" }, inventory.status === "error"
            ? `读取家族清单失败：${inventory.message}`
            : "正在读取家族清单…")
          : h(
            "ul",
            { className: "dsh-tg-list" },
            h(Row, {
              label: "自动成族",
              hint: "每个注册了工具的插件自动成为一个家族，无需事先登记；新装的插件下次生效时自动折叠。关闭后只有下面显式配置过的家族生效。",
              on: autoFamilies,
              disabled: busy || !ready || !enabled,
              onToggle: () => write(["autoFamilies"], !autoFamilies),
            }),
            h(Row, {
              label: "内置插件也折叠",
              hint: "第一方插件的可选工具（会话检索、日程等）同样收进各自的网关。关闭后只有第三方插件折叠。",
              on: builtinFamilies,
              disabled: busy || !ready || !enabled,
              onToggle: () => write(["builtinFamilies"], !builtinFamilies),
            }),
            ...familyRows
              .filter((family) => family.hidden !== true)
              .map((family) =>
                h(Row, {
                  key: family.id,
                  label: family.label,
                  hint: family.description,
                  meta:
                    `${family.count} 个工具 · ≈${tokens(family.tokens)} tok · 网关 ${family.gateway}`
                    + (family.members.length > 0 ? `\n${family.members.join("  ")}` : ""),
                  badges: [
                    ...(family.builtin ? [{ kind: "builtin", text: "内置" }] : []),
                    ...(family.auto === false ? [{ kind: "off", text: "手动" }] : []),
                  ],
                  on: family.enabled,
                  disabled: busy || !ready || !enabled,
                  onToggle: () =>
                    write(["families", family.id, "enabled"], !family.enabled),
                }),
              ),
          ),

        // ——— prompt disclosure ———
        h("h4", { className: "dsh-tg-group" }, "提示词披露"),
        h(
          "ul",
          { className: "dsh-tg-list" },
          h(Row, {
            label: "插件提示词随 list 披露",
            hint: "总开关。开启后，已折叠家族的插件提示词不再每轮注入，改为在该家族 action=list 时"
              + "随成员定义一并返回。默认关闭（与未安装本插件时完全一致）。",
            on: promptDisclosure,
            disabled: busy || !ready || !enabled,
            onToggle: () => write(["promptDisclosure"], !promptDisclosure),
          }),
        ),
        data === undefined
          ? null
          : pluginRows.length === 0
            ? h("p", { className: "dsh-tg-empty" }, "没有检测到任何插件。")
            : h(
              "ul",
              { className: "dsh-tg-list" },
              ...pluginRows.map((plugin) => {
                const current = dictAt(snapshot, "promptPlugins", plugin.package);
                const on = current?.enabled === true;
                const blocked = plugin.disclosureAvailable !== true;
                const families = plugin.families ?? [];
                const names = plugin.names ?? [];
                // Say what the switch would do, including "nothing" — a row that
                // cannot be disclosed states why instead of pretending. The host
                // names the reason (`reason`); these are its answers.
                const hint = blocked
                  ? REASON_HINT[plugin.reason]?.(plugin, families) ?? "提示词保持现状（始终注入）。"
                  : `随家族「${families.join("」「")}」的 list 披露`
                    + (plugin.required ? "；其中含必需上下文，永不摘除" : "");
                const meta = names.length === 0
                  ? `未向提示词注入内容${plugin.toolCount > 0 ? ` · ${plugin.toolCount} 个工具` : ""}`
                  : `${names.join("  ")}${plugin.chars > 0 ? ` — 约 ${plugin.chars} 字符` : ""}`;
                return h(Row, {
                  key: plugin.package,
                  label: plugin.package,
                  hint,
                  meta,
                  badges: [
                    ...(plugin.thirdParty ? [] : [{ kind: "builtin", text: "内置" }]),
                    ...(blocked ? [{ kind: "off", text: names.length === 0 ? "无注入" : "不可披露" }] : []),
                  ],
                  on,
                  disabled: busy || !ready || !enabled || !promptDisclosure || blocked,
                  onToggle: () => write(["promptPlugins", plugin.package, "enabled"], !on),
                });
              }),
            ),

        // ——— behaviour ———
        h("h4", { className: "dsh-tg-group" }, "行为细节"),
        h(
          "ul",
          { className: "dsh-tg-list" },
          ...BEHAVIOUR.map((field) => {
            // A behaviour row is either a boolean or an enum with two named
            // states (`value` is the "on" state). Anything else would need a
            // third control shape, which this list deliberately does not have.
            const current = valueOf(snapshot, field.field, field.default);
            const isOn = field.value === undefined ? current === true : current === field.value;
            const nextValue = field.value === undefined
              ? !isOn
              : isOn
                ? field.off ?? false
                : field.value;
            return h(Row, {
              key: field.field,
              label: field.label,
              hint: field.hint,
              on: isOn,
              disabled: busy || !ready || !enabled,
              onToggle: () => write([field.field], nextValue),
            });
          }),
        ),

        // ——— status ———
        header === undefined ? null : h("p", { className: "dsh-tg-status" }, header),
        message === undefined
          ? null
          : h("p", { className: "dsh-tg-status", "data-error": message.error ? "true" : "false" }, message.text),
        ready
          ? null
          : h(
            "p",
            { className: "dsh-tg-status" },
            snapshot.status === "loading"
              ? "正在读取配置…"
              : snapshot.status === "unavailable"
                ? "此部署不提供该插件的配置写入。"
                : "配置当前只读。",
          ),
        h(
          "div",
          { className: "dsh-tg-bar" },
          h(
            "button",
            {
              type: "button",
              className: "dsh-tg-btn",
              disabled: busy,
              onClick: () => setReloadKey((key) => key + 1),
            },
            "刷新清单",
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-tg-btn",
              disabled: busy || !ready || data === undefined,
              onClick: () => {
                const operations = [];
                for (const family of familyRows) {
                  operations.push({ op: "set", path: ["families", family.id, "enabled"], value: true });
                }
                writeAll(operations);
              },
            },
            "全部家族折叠",
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-tg-btn",
              disabled: busy || !ready || data === undefined,
              onClick: () => {
                const operations = [];
                for (const family of familyRows) {
                  operations.push({ op: "set", path: ["families", family.id, "enabled"], value: false });
                }
                writeAll(operations);
              },
            },
            "全部家族常驻",
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-tg-btn",
              disabled: busy || !ready || data === undefined,
              onClick: () => {
                const operations = [{ op: "set", path: ["promptDisclosure"], value: true }];
                for (const plugin of pluginRows) {
                  if (plugin.disclosureAvailable !== true) continue;
                  operations.push({ op: "set", path: ["promptPlugins", plugin.package, "enabled"], value: true });
                }
                writeAll(operations);
              },
            },
            "全部插件可披露",
          ),
        ),
      );
    }

    /**
     * Why a row is greyed out, one line per host-reported reason.
     *
     * The host does the deciding (`lib/prompt-scan.js` `reasonFor`); this only
     * chooses the words. Keeping the mapping here means a new reason shows a
     * generic sentence rather than "undefined".
     */
    const REASON_HINT = {
      "no-prose": () => "该插件当前没有向提示词注入内容。",
      "no-switch": () => "勾选上面的开关后，该插件的提示词才改为随 list 披露。",
      "master-off": () => "先打开上方的「提示词动态披露」总开关。",
      "requires-collapse": (_plugin, families) =>
        `所属家族「${families.join("」「")}」尚未收起，提示词保持现状。`,
      "required-only": () => "该插件注入的全部是必需上下文（身份/策略等），永不摘除。",
      "no-family": () => "未归属到任何家族，无法确定由哪个网关携带这些说明。",
      unowned: () => "无法确定是哪个包注入的，保持现状（始终注入）。",
    };

    /** The switches under 行为细节. */
    const BEHAVIOUR = [
      {
        field: "listDetail",
        default: true,
        label: "list 返回完整参数定义",
        hint: "关闭后 list 只返回工具名与一句话说明，省 token 但模型可能要试一轮才知道参数。",
      },
      {
        field: "interceptDirectCalls",
        default: true,
        label: "拦截对已收起工具的直接调用",
        hint: "模型直接点名已收起的工具时，回一句「改走网关」的提示，而不是让它执行。",
      },
      {
        field: "guardFallback",
        default: true,
        label: "额外的执行期守卫",
        hint: "在 tools/pre-execute 之外再挂一道 tools.guard，拦住绕过网关的直呼。",
      },
      {
        field: "concurrencyDelegate",
        default: false,
        label: "网关调用沿用成员的并发声明",
        hint: "开启后同一轮的多个网关调用可能并发执行；关闭则一律串行（更保守）。",
      },
      {
        field: "freeze",
        default: true,
        label: "会话内冻结工具集",
        hint: "关闭后每轮重算工具集，会重新触发前缀重写，失去本插件的意义。",
      },
      {
        field: "unknownOwnerPolicy",
        default: "expose",
        value: "collapse",
        off: "expose",
        label: "认不出归属的工具一并收起",
        hint: "关闭（默认）：认不出归属就留在 wire 上。开启：也收起，省得更多但可能收错。",
      },
      {
        field: "diskScan",
        default: "on",
        value: "on",
        off: "off",
        label: "允许扫描已安装 bundle 以识别归属",
        hint: "开启后用实时归属加磁盘扫描，新装插件的工具能立刻成族。关闭则只用实时归属与内置表，认不出的一律按上一项处理。",
      },
    ];

    /** One-line summary for the plugin row in the plugin manager list. */
    function Summary() {
      const [inventory, setInventory] = useState(undefined);
      useEffect(() => {
        let cancelled = false;
        fetch(BRIDGE, { method: "GET", credentials: "same-origin" })
          .then((response) => response.json())
          .then((body) => {
            if (!cancelled && body?.ok === true) setInventory(body.value);
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, []);
      if (inventory === undefined) return h("p", { className: "dsh-tg-summary" }, "工具网关（渐进披露）");
      return h(
        "p",
        { className: "dsh-tg-summary" },
        `wire 上 ${inventory.wireToolCount} 个工具 · 收起 `
          + `${inventory.families.filter((family) => family.enabled).length} 个家族 · 约省 `
          + `${tokens(inventory.savedTokens)} tok`,
      );
    }

    /** Slot entry: the plugin manager asks for the page and the summary separately. */
    function BundleConfig(props) {
      const form = props?.form;
      if (props?.view === "summary") return h(Summary, null);
      if (props?.view !== "page") return null;
      return h(SettingsPage, { form });
    }

    /** Register the page against this bundle's own detail page. */
    function apply(ctx) {
      const form = ctx.configForms.get(ENTRY_ID);
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          { name: "plugins.bundle.config", key: ENTRY_ID, inject: () => ({ form }) },
          BundleConfig,
        ),
      );
    }

    module.exports = { apply, inject: ["slots", "configForms"] };
    return module.exports;
  },
});
