import z from "@deepseek-ai/schemastery";

/**
 * Every field is `.volatile()`: the Loader hands `apply` live references and
 * commits profile edits in place without remounting, so a toggle in the plugin
 * manager takes effect on the next turn instead of after a restart.
 *
 * Every field also carries `.description()`: `dsh-settings` reads
 * `entry.fiber.runtime.Config`, turns it into a form via `toJSON()`, and shows
 * `meta.description` next to the control. That is why this bundle ships no
 * hand-written controls for the config itself.
 *
 * `apply` receives the live (volatile) config object, where each volatile field
 * is a `{ get() }` reference rather than a plain value — `readConfig` in
 * `lib/index.js` unwraps them on every read (same pattern as `dsh-free-search`).
 */
export const Config = z.object({
  // ——— master switch —————————————————————————————————————————————
  enabled: z.boolean().default(false).volatile()
    .description("总开关。关闭时完全不介入，wire 上照旧是全部工具（本插件从不修改注册表，只改 wire）。"),

  // ——— the four settings-page switches ————————————————————————————
  concurrencyDelegate: z.boolean().default(false).volatile()
    .description("网关调用是否沿用成员工具自身的并发安全声明。开启后同一轮的多个网关调用可能并发执行；关闭则一律串行（更保守）。"),

  listDetail: z.boolean().default(true).volatile()
    .description("action=list 是否返回成员的完整参数定义。开启便于模型一次调对；关闭只返回工具名与一句话说明，省 token 但可能多试一轮。"),

  staticNotice: z.boolean().default(true).volatile()
    .description("是否在系统提示中加一句“这些工具已收进网关”的固定说明。关闭后模型只能从工具自身的描述得知，可能更少主动 list。"),

  guardFallback: z.boolean().default(true).volatile()
    .description("是否额外挂一道执行期守卫（tools.guard），拦住绕过网关的直呼。比 tools/pre-execute 更严格，且不会引起工具集变化。"),

  // ——— interception ——————————————————————————————————————————————
  interceptDirectCalls: z.boolean().default(true).volatile()
    .description("模型直接调用已收起工具时是否拦截并给出改走网关的提示。关闭后直呼会正常执行（工具仍在注册表里，只是不在 wire 上）。"),

  // ——— builtin families ————————————————————————————————————————————
  builtinFamilies: z.boolean().default(true).volatile()
    .description("是否把内置（第一方）插件的可选工具也收进各自的网关。关闭后第一方工具全部常驻 wire，只有第三方插件折叠。"),

  autoFamilies: z.boolean().default(true).volatile()
    .description("自动成族：每个注册了工具的插件包自动成为一个家族，无需事先登记。关闭后只有下面 families 里显式列出的家族生效。"),

  degenerateThreshold: z.number().min(0).step(1).default(3).volatile()
    .description("退化家族抑制阈值 k：可折叠成员总共要省下 k 倍「网关自身的成本」，这个家族才值得建网关。默认 3。调高＝更少家族、更多工具常驻；0 = 只要能省一点就折叠。某个家族的 families.<id>.force 可单独豁免。"),

  verifyAttribution: z.boolean().default(true).volatile()
    .description("归属校验：注册期归属指向引擎/装配包（dsh-agent-loop 等）、或与静态声明的包冲突时，改判给真正声明的包，认不出就把工具露出（宁可多花 token 也不藏错）。关闭则完全信任注册期归属。"),

  // ——— prompt disclosure ————————————————————————————————————————————
  promptDisclosure: z.boolean().default(false).volatile()
    .description("总开关：是否把已折叠家族的插件提示词从上下文里摘掉，改为在 action=list 时随成员定义一并披露。关闭时插件提示词照旧每轮注入（与未安装本插件时完全一致）。"),

  promptPlugins: z.dict(z.object({
    enabled: z.boolean().default(false).description("是否为该插件启用提示词动态披露"),
  })).default({}).volatile()
    .description("逐插件的提示词披露开关（key = 包名）。只有总开关与本开关同时打开，该插件的提示词才改为随 list 披露。留空则全部保持现状。"),

  // ——— families ——————————————————————————————————————————————————
  // The dict itself is volatile; its members must NOT be, or schemastery refuses
  // the schema ("volatile fields require a fixed object path without an enclosing
  // volatile field"). Marking the dict live still makes every key editable.
  families: z.dict(z.object({
    label: z.string().default("").description("家族显示名（写进网关工具的描述）"),
    description: z.string().default("").description("写进网关工具描述的一句话说明"),
    enabled: z.boolean().default(true).description("是否收起该家族"),
    gateway: z.string().default("").description("自定义网关工具名（留空则用家族 id）"),
    packages: z.array(z.string()).default([]).description("把指定包并入该家族（用于合并多个插件共用一个网关）"),
    prefixes: z.array(z.string()).default([]).description("归属到该家族的工具名前缀"),
    tools: z.array(z.string()).default([]).description("显式成员工具名（用于从一个包里只挑几个工具）"),
    aliases: z.array(z.string()).default([])
      .description("该家族可接受的曾用配置键（例如 subagent2）。家族 id 由包名推导后会变，别名让旧写法继续生效；设置页会标出用了哪个曾用名。"),
    force: z.boolean().default(false)
      .description("强制成族：跳过退化判定（节省不足网关成本 k 倍时本来不折叠），用于你明知会亏也要收起的家族。"),
    promptDisclosure: z.boolean().default(false)
      .description("是否把该家族的插件提示词从上下文摘掉，改为在 action=list 时随成员定义披露。仅在该家族已收起、且总开关打开时生效。"),
  })).default({}).volatile()
    .description("家族覆盖表：家族本身由插件自动发现，这里只用于改名、关掉某个家族、或把几个插件合并到一个网关。留空表示全部按默认。"),

  unknownOwnerPolicy: z.union([z.const("expose"), z.const("collapse")]).default("expose").volatile()
    .description("认不出归属的工具怎么处理。expose = 留在 wire 上（安全，省得少）；collapse = 一并收起（省得多，但可能收错）。"),

  alwaysExpose: z.array(z.string()).default([]).volatile()
    .description("强制常驻 wire 的工具名（无论归属哪个家族）。"),

  alwaysHide: z.array(z.string()).default([]).volatile()
    .description("强制从 wire 收起的工具名（即使它属于核心，不会出现在核心保留集里）。"),

  residentTools: z.array(z.string()).default([]).volatile()
    .description("额外常驻 wire 的工具名：与内置保留集同等对待，既不会被收起，也不会成为某个家族的唯一成员。用于把某个插件的少数工具钉在 wire 上。"),

  diskScan: z.union([z.const("on"), z.const("off")]).default("on").volatile()
    .description("是否允许为认不出归属的工具扫描已安装的 bundle 源码。on = 新装插件的工具能立刻成族（结果按注册表版本缓存，注册稳定后不再扫描）；off = 只用实时归属与内置表，认不出的一律交给 unknownOwnerPolicy。"),

  gatewayPrefix: z.string().default("").volatile()
    .description("网关工具名前缀，留空则直接用家族名（blender_plugin / mcp_servers / github / …）。"),

  maxDescriptionChars: z.number().min(0).step(1).default(0).volatile()
    .description("网关描述的字数上限（按码点）。0 = 不限制，整段插件的自述原样进入网关描述——描述是插件作者写给模型的，长度由作者负责。若描述总量重新吃紧，可在这里设一个止损值（例如 300）。"),

  ptcMode: z.union([z.const("disable"), z.const("ignore")]).default("disable").volatile()
    .description("检测到 PTC（run_code）呈现模式时的行为。disable = 本插件整体停用（推荐）；ignore = 继续工作（未验证）。"),

  freeze: z.boolean().default(true).volatile()
    .description("会话内冻结工具集。关闭后每轮重算（会重新触发前缀重写，失去本插件的意义）。"),

  schemaVersion: z.number().default(2).volatile().hidden()
    .description("内部：plugin record 结构版本。"),
});

export default Config;
