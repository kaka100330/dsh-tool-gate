# dsh-tool-gate

渐进披露（progressive disclosure）插件：把第三方工具与部分内置工具按**家族**收进
每个家族一个的网关工具，让 wire 上的 `tools` 数组在会话内**逐字节恒定**，
从而不再因为「工具定义变了」而重付整段提示前缀。

## 为什么

DSH 把当前可见的工具定义随每个请求发给模型。工具越多，这段前缀越长：

| 家族 | 工具数 | 约 tok |
| --- | ---: | ---: |
| Blender Plugin | 15 | 6,725 |
| MCP Connector | 25 | 4,338 |
| Image Gen | 6 | 2,980 |
| Video Storyboard | 6 | 2,745 |
| Github | 14 | 2,178 |
| Free Search | 9 | 1,665 |
| Hindsight Coding Agents | 8 | 1,633 |
| MCP Servers | 1 | 149 |
| **Session Query**（内置） | 5 | 1,242 |
| **Schedule**（内置） | 4 | 1,868 |
| **收起合计** | **93** | **≈25,523** |

常驻的是 36 个核心工具（约 7.5k）、18 个 OPS 工具（约 7.1k）、5 个上下文工具（约 1.2k）
和网关本身（每个约 0.2k）。**代价约 1.6k tok，换回约 25k tok。**

> 这张表是 0.3.1 的原始测量，保留原样。0.9.0 之前「7 个 OPS 常驻」是错的：手写的保留表只列了
> 18 个 `ops_*` 里的 7 个，另外 11 个被折叠进了一个叫「Agent Loop」的家族。现在常驻判据由
> 归属加前缀推导，18 个全在 wire 上（见 [0.9.0 的改动](#090-的改动)）。

内置家族（会话检索、日程）可以在设置页用「内置工具家族」总开关一次关掉，
也可以逐家族关掉；关掉就是回到「工具常驻 wire、网关不存在」的老样子。

省的不只是单次长度。只要工具集在会话中途变化（某个插件加载/卸载、某个 MCP 服务器连上），
提示缓存的前缀就整段失效，后续每一轮都要重新计价。冻结工具集之后这件事不再发生。

## 三个承重事实（都已在宿主源码核对）

1. `system-prompt/assemble` waterfall 的**返回值权威** —— 监听器可以替换工具列表。
2. 执行时不看这张列表：`dispatchToolBody` 从注册表解析定义，所以收起的工具**照样能跑**。
3. 请求头只在工具字节变化时才改写 —— 冻结之后前缀不再变化。

## 怎么用

装在插件页，默认 **关闭**。打开后你会看到每个启用的家族各一个网关工具，每个两个动作：

```
blender_plugin  { action: "list" }                    → 该家族全部成员的名字、说明、完整参数
blender_plugin  { action: "call", tool: "blender_rt_do",
                 arguments: { ... } }                  → 调用成员，返回值与直接调用一致
```

这两个动作的含义**只在系统提示词里说一次**（`staticNotice` 那段说明），不再重复写进
每个网关的描述 —— 否则 12 个网关就是同一段话交 12 遍钱。网关自己的描述只说一件事：
**这个家族是做什么的**（`网关 · Blender Plugin：…`）。关掉 `staticNotice` 时系统提示词里没有那段话，
每个网关的描述会自动补一句最小可用说明，模型仍能自己摸到 `list`。

同一会话内第二次 `list` 只回一句提示（定义已经在历史里了，不必再占一次上下文）。

模型若直接调用已收起的成员名，会被拦下并提示改走网关 —— 那不是工具本身坏了。
（`interceptDirectCalls` 与 `guardFallback` 可分别关掉。）

## 家族

**家族不是写死的。** 每个第三方插件包自动成为一个家族：本插件从工具注册处
回溯出「哪个包注册了这个工具」，把同一包的成员归到一族，用包名推出家族 id。

**网关的描述也不是写死的。** 它读宿主自己的 `pluginPackages` 服务 —— 也就是设置页
「插件」列表显示的那段描述，同一个来源、同一套 locale 文件，所以两边永远不会打架。
两层兜底：`metaOf`（读 `locale/*.json`，读不到再读包的 `package.json`）→ 插件清单的
`description`。**新装一个插件，它的网关立刻有描述，本插件的代码一行都不用改。**
描述**原样使用、不截断也不换成第一句**：插件作者写给模型的话就是模型看到的全部内容，
截在半句上会把「这个插件是做什么的」那半句正好砍掉。设置页在描述后面标出来源
（`metaOf` / `manifest` / `你的配置` / `无`），一眼就能看出哪个网关还是空的。
想要上限的人可以配 `maxDescriptionChars`（默认 `0` = 不限），超长时按码点截断并加 `…`。

所以**新装一个插件的工具会被收进它自己的网关**，不需要改本插件的任何代码。
当前会话的 wire 是冻结的，所以插件在**下一个会话**里开始折叠——这一点是刻意的，
中途插入一个新网关等于让提示前缀重付一次。设置页的「刷新清单」只更新你看到的那张表。
例子（id 由包名推导）：

| 包 | 家族 id | 标签 | 网关 |
| --- | --- | --- | --- |
| `dsh-blender-plugin` | `blender_plugin` | `Blender Plugin` | `blender_plugin` |
| `@perrylink/dsh-github` | `github` | `Github` | `github` |
| `dsh-free-search` | `free_search` | `Free Search` | `free_search` |
| `@deepseek-ai/dsh-tool-fs` | `fs` | `FS` | `fs` |
| 未来新装的 `dsh-acme-widgets` | `acme_widgets` | `Acme Widgets` | `acme_widgets` |

**标签是包名的直译，不是意译。** `lib/family-labels.js` 去 `@scope` 前缀、去
`dsh-tool-` / `dsh-plugin-` / `dsh-` / `plugin-` 前缀，按 `-_.` 切词后首字母大写，
缩写词（`fs` `mcp` `api` `cli` `ui` `http` `url` `json` `ide`）保持全大写。
**网关名恒等于家族 id**（除非你配了 `gateway:` 或非空 `gatewayPrefix`），
所以 `session_query` 不会和别的 `session…` 撞在一个命名空间里，名单和页面也永远一致。
代价是 `GitHub` 会读成 `Github`、`Blender` 会读成 `Blender Plugin`——这正是包名说的。
想要回品牌大小写就写 `families.github.label: GitHub`，配置仍然最高优先。
**不再读宿主 locale 的标题**：那正是 `Hindsight` 被显示成能力词「记忆」的来路。

**内置家族**（按显式工具名归属，`builtinFamilies` 总开关控制，默认开）：

| 家族 | 标签 | 网关 | 成员 | ≈tok |
| --- | --- | --- | --- | --- |
| 会话检索 | `Session Query` | `session_query` | `session_search` `session_event_search` `session_event_read` `session_event_trace` `session_trace` | 1,242 |
| 日程 | `Schedule` | `schedule` | `schedule_create` `schedule_list` `schedule_update` `schedule_delete` | 1,868 |

内置家族走**显式工具名**匹配（列在 `BUILTIN_FAMILY_TOOLS`），因为它们和常驻控制面
（`plugin_manager` 等）同属一个包，按包归属会连常驻工具一起收走 —— 这是唯一保留的
白名单，而且只点名工具、不点名插件。

关掉任一家族 = 该家族不折叠、成员直接常驻 wire、网关消失。
设置页里 `families` 表是**覆盖项**（改名、合并、改网关名、显式点名成员），不是完整清单。

## 设置页

插件详情页是自建页面，从宿主路由 `GET /api/dsh-tool-gate/describe` 取实时清单
（唯一的写入口是 `POST /describe/refresh`，只重扫、不改配置）：

- **总开关** —— 关闭即完全不介入。
- **家族列表** —— 一行 = 一个家族：左侧是说明（描述 + 来源小字 + 成员数 + ≈tok + 网关名 +
  成员名单），右侧是折叠开关；第二行是该家族的提示词披露开关。
  后端把「拥有工具的包」「家族定义里点名的包」「已经能归属出提示词的包」三者取并集，
  所以将来某个插件开始注入提示词时，**不需要改本插件**就会出现可用的开关行。
  不能披露的行不隐藏，而是灰显并写明原因（`无注入` / `不可披露`），并标注 `内置` 或第三方。
- **未参与折叠（只读）** —— 没有家族的第三方包，以及一行「另有 N 个内置插件的包未参与折叠」的注脚。
  每行写明原因（已在该家族网关后 / 工具全部常驻 / 不注册工具 / 认不出归属 / 归属异常）。
- **自检（D1–D9）** —— 只有发现问题时才出现：红色是「本插件内部自相矛盾」，黄色是要留意，蓝色是说明。
- **行为细节** —— list 详细度、直呼拦截、执行期守卫、并发声明、会话内冻结、未知归属策略、建族阈值。
- 底部三个批量按钮：全部家族折叠 / 全部家族常驻 / 全部插件可披露。
- 右上角的「刷新清单」走 `POST /api/dsh-tool-gate/describe/refresh`：它会丢掉工具扫描
  的计划缓存与归属索引，重新读盘、重建家族表，再把新快照还给页面。**装完插件不用重启，
  点一下就能看到它。** 只影响你看到的清单：当前会话的 wire 是冻结的，新家族从**下一个会话**
  开始折叠（这一点页面也写着，免得「装了没生效」被当成坏了）。

改动即时生效，无需重启。其余项仍在 profile 的 `cordis.patch.yml` 本插件 `config` 段
（例如 `alwaysExpose` / `alwaysHide` / `gatewayPrefix` / 家族 `packages`）：

```yaml
- id: dsh-tool-gate
  name: dsh-tool-gate
  config:
    enabled: true
    unknownOwnerPolicy: collapse   # 认不出归属的工具一并收起（默认 expose，更安全）
    alwaysExpose: [some_tool]      # 强制常驻
    alwaysHide: []                 # 强制收起
    maxDescriptionChars: 0         # 网关描述的字数上限，0 = 不限（默认）
    degenerateThreshold: 3         # 建族门槛：可折叠节省须超过 3× 网关成本（默认 3）
    verifyAttribution: true        # 用已安装包的源码声明反证归属（默认开；关掉就退回「信实时答案」）
    families:            # 键是 family id（不是网关名、不是标签）；旧键名按 aliases 回退
      blender_plugin:
        label: Blender  # 唯一能盖掉派生标签的地方
        packages: [dsh-blender-plugin]
        force: true     # 省不回网关成本也建族
      mcp_servers:
        prefixes: ["mcp__"]
      hindsight-coding-agents:  # 不存在的键会被报成 unknown-family-key，不再静默
        aliases: [dsh, old_key]  # 让老配置继续生效
```

## 归属怎么认

**工具归属**（决定哪些工具被收起）按优先级四层，每条答案都带**来源与置信度**，不是光秃秃一个包名：

1. **实时注册包装**（`internal/get` 拿到的 tools 实例，包一层 `register`）——
   从注册所在的上下文与调用栈回溯到 `package.json` 的 `name`，再过 `canonicalPackage()`
   归一化（这一步是 0.9.0 加的：不做的话 `…/dsh` 这样的说明符会变成另一个身份）。
   本插件挂载后发生的注册全走这条。
2. **读盘扫描**（`lib/tool-scan.js`）—— 本插件挂载前就已注册完的工具，注册早已结束，
   没人观察得到。于是去问安装的包本身：谁的源码里出现 `name: "<这个工具>"`（或
   `name: 常量` + `const 常量 = "…"`），这个工具就属于谁；源码里的前缀常量
   （`const TOOL_PREFIX = "ops_"`）也算声明。**装新插件不需要改本仓库任何文件**，
   装上就生效。只扫 profile 的 bundle 列表、只查还没归属的名字，
   一次约 1.2 秒（1629 文件 / 25MB），按 profile 的 `package.json` 指纹缓存 ——
   安装必定改写它，所以不需要谁记得清缓存。
3. **内置表**（`lib/builtin-attribution.js`）—— 第一方包的兜底，置信度低，且只认
   「注册表当前真的有」的名字，避免为没装的插件造网关。
4. **认不出** —— 按 `unknownOwnerPolicy` 决定留在 wire（默认）还是收起。

**读盘扫描排在内置表前面**，哪怕内置表已经能答出这个名字：内置表记的是过去某个
profile，读盘问的是眼前这个。0.9.0 最初把内置表放在前面，结果 141 个名字的答案都来自
内置表、置信度全是「低」，页面上 9 个家族齐刷刷挂出「成员归属置信度低」—— 对从来没有
疑问的归属表示怀疑。现在内置表只负责「源码里查不到」的那部分；而已经答成「低」的名字
会被重新交给扫描（`registered()` 里 `confidence === "low"` 也会进待扫描集合），
包自己的源码一旦确认，答案就升级成高置信度，确认不了才留着内置表的说法。

拿到答案之后还要**校验**（`lib/attribution-verify.js`）：归属落在引擎包上
（`@deepseek-ai/dsh-agent-loop` 之类）时，先问包自己的源码认不认这个名字，认就改判给那个包；
改不了就降级为「未知」，也就是留在 wire 上。0.9.0 之前这个位置是「信」，于是 18 个 `ops_*`
全部记在引擎名下、成了一个叫「Agent Loop」的家族。同理，答案本来就是「未知」或「低」时，
只要某个包的源码声明了这个名字，就以声明为准（冷启动时工具在本插件挂载前就注册完了，
注册表只能答「未知」，而 profile 里的源码答得出）。

`mcp__<server>__<tool>` 自动归到 `mcp_servers` 家族，按服务器名分组。

认不出归属的工具按 `unknownOwnerPolicy` 决定留在 wire（默认）还是收起。
它不会凭空造出一个家族 —— 家族只由「能归属到某个包的已注册工具」推导，
所以卸载一个插件、重载一次，它的家族和网关就一起消失。

**提示词归属**（决定哪段插件提示词可被披露）也是三层，但方向相反 —— 认不出就不动：

1. **实时包装** `systemPrompt` 实例的 `section`/`context`（本插件之后挂载的插件）。
2. **静态快照** `lib/prompt-attribution.js`（`scripts/gen-prompt-attribution.mjs` 生成）——
   覆盖本插件之前就已注册的入口。注意这一层仍是**快照**：提示词的注册是函数调用，
   源码里没有可反查的注册表，所以新装插件若注入了提示词，需要重跑一次脚本才能认出
   （不认得的入口会保持原样注入，是安全方向）。工具那侧没有这个限制，见上。
3. **`mcp:<server>`** 无条件归到 MCP 服务器家族。

`required: true` 的上下文（工作目录、团队身份）、harness 身份、persona、审批与沙箱策略
永不摘除。认不出归属的入口保持原样注入。

## 提示词披露

开启后（默认**全关**，逐插件开）：

1. 从**第一轮**起，就把已折叠家族、且已开开关的插件提示词置为空字符串。宿主渲染时
   会丢掉空文本，所以这段文字从不出现在请求里，**前缀也不会因此变化**。
2. 置空时把**已解析好的文本**按 `family → [贡献]` 记在 agent 状态里。
3. 该家族 `action: "list"` 的返回里，成员定义之后追加这些文本（标注来源），只给一次。

所以它既不占常驻前缀，也不会造成缓存重算 —— 代价只是 `list` 那次多付一次这段文字。

**为什么要改注册而不是改 assembly。** 第一版在 `system-prompt/assemble` 的返回值里把
`contexts[i].text` 置空，结果系统提示词干净了、**运行时上下文里的文字还在**：
`dsh-agent-loop` 每步都会调 `systemPrompt.refreshContext(assembly, …)`，而它按
`accepted.name` **从注册表里的 provider 重新解析**文本，assembly 里的副本被覆盖了。
`dsh-system-prompt` 源码：

```js
const provider = providers.get(accepted.name);
contexts.push(provider === void 0 ? accepted : resolveContext(provider, context));
```

所以改的是**注册项自己的 `text` provider**（包一层：该摘就返回 `""` 并把真文本记下来）。
这样 `assemble()` 与 `refreshContext()` 两条路径看到的是同一个结果，从第一轮就稳定。
`test/e2e.mjs` 的场景 10 专门回归这一点：它调用真实的 `refreshContext` 并断言文字不会回来。

## 边界与诚实的话

- **`list` 返回的定义会永久留在上下文里**。一个家族 list 一次，就等于把那个家族的定义付了一次。
  收益来自「只 list 真正要用的家族」，以及「不再因为工具集抖动而反复重付前缀」。
- **提示词披露只对已折叠家族生效**。家族常驻时它的提示词准确，因此不摘。
- **PTC（`run_code`）呈现模式下自动让路**：那个作用域本来就只放一个工具，没什么可收的。
- **子代理各自独立冻结**，互不干扰。会话恢复时从 plugin record 记的名字重建（不存 schema，
  免得继承旧版本的参数形状）。
- **不修改注册表**（网关本身是普通工具）。关掉开关后所有工具下一轮就回来。
- 明确**不**承诺：`reason: "series"` 的请求头重写（goal round driver 会开新 series），
  以及模型自己要求换工具集的情况。
- **内置家族的提示词也走同一条披露通道**：`tool:session-query` 归属
  `@deepseek-ai/dsh-tool-session-query`，而该包已登记为 `session_query` 家族，所以打开它的插件开关后
  那段说明同样只在 `session_query` 的 `list` 里出现。`schedule` 目前没有任何提示词贡献，因此它的开关行
  会灰显并标注 `无注入`（有行、但不假装有用）。
- **包名统一用包自己声明的名字**。`data/attribution.json` 里第一方包写的是目录名
  （`dsh-tool-fs`），而实时栈回溯拿到的是 `@deepseek-ai/dsh-tool-fs`；不归一化的话，同一个
  插件会在页面上出现两行。`scripts/gen-attribution.mjs` 现在会按已安装的 `package.json`
  把名字改正（本次修正 19 个）。
- **MCP 服务器不是包**。`mcp:wincu` 这类身份代表「某个 MCP 服务器提供的工具」，服务器本身
  这里没有代码可开关，所以不出行；它的工具仍归属 `mcp_servers` 家族，那是另一行。
- **查成员必须带作用域**。宿主 `tools.schemas()` 不带参数时只看全局层；而
  `dsh-tool-schedule` 是在 `ctx.inject(["schedule"], …)` 的**子作用域**里注册那 4 个工具的
  （`dsh-tool-schedule/lib/index.js:498`）。早期版本用裸 `schemas()` 找成员，结果「日程」家族
  显示 0 个成员、`action:"list"` 回「没有可用的成员工具」，而工具其实就在同一个会话里可调用。
  现在 `membersOf()` 一律传 agent 作用域（`tools.schemas(agent)`），设置页读的是成员最多的那个
  作用域的视角。`test/e2e.mjs` 场景 13 专门钉住这条：作用域里注册的工具必须出现在 `list` 和
  设置页的清单里。
- **「有没有成员」也只认作用域视野**。判定空家族曾经用 `knownNames()`——它是**不受限制**的
  超集，被 `restrict` 掉、任何 agent 都调不到的名字仍算成员，于是 `fs_search` 这种家族照样挂上
  网关，模型拿到一个 `list` 只能回「没有成员」的工具。现在用 `callableNames(scope)`：各 agent
  `view(scope).visible` 的并集，只在完全没有作用域时才退化成不带作用域的视野。
  `test/e2e.mjs` 场景 16 用 `restrict()` 造出这个局面并断言网关不会出现、页面同一行是 `hidden`。
- **网关被撤回时会解冻**。冻结面是粘性的（这是前缀稳定的来源），所以一个中途消失的网关会一直
  留在冻结面里，而它收起的成员又回不来。撤回时清掉 `frozen`，下一轮按当前注册表重建；
  没有撤回的一轮不会重建（场景 17 两头都断言）。


## 文件

```
lib/index.js         插件入口：assemble 钩子、按 agent 状态、网关同步、拦截装配、路由装配
lib/config.js        schemastery Config（全字段 volatile + 中文说明 → 设置页表单可用）
lib/owner.js         工具归属识别（实时包装 / 栈回溯 / 读盘扫描 / 内置表兜底）
lib/tool-scan.js     读盘扫描：问已安装的包「这个工具名在哪」，装新插件不用改仓库
lib/discovery.js     从归属快照推导家族表：一个插件包 = 一个家族
lib/plugin-meta.js   网关描述的通用来源：读宿主的 pluginPackages（两层兜底 + mtime/上限缓存）
lib/family-labels.js 标签派生（包名 → 去前缀 → title-case，缩写词大写；没有表）
lib/ownership-channel.js  归属通道 + 包名归一化（canonicalPackage / barePackageName）与「第一方」判定
lib/engine-packages.js    引擎包与上下文包的判定（归属落在引擎上就降级为未知，不成族）
lib/attribution-verify.js 归属校验：拿包自己的源码声明反证、前缀认领、矛盾告警，纯函数
lib/resident.js           唯一的常驻判据（owner + 前缀推导，含 ops_* 规则）
lib/degenerate.js         建族门槛：可折叠成员与 k×网关成本的比较（k=3）
lib/diagnostics.js        自检 D1–D9，纯函数，输出给设置页
lib/families.js      家族表装配、归属解析、冻结面构造（code-unit 排序）
lib/gateways.js      网关的 defineTool 定义与注册（描述只说这个家族做什么）
lib/dispatch.js      list / call 的实现（含 turn 语义上抛、提示词回吐）
lib/guard.js         pre-execute 拦截 + tools.guard 兜底
lib/state.js         每个 agent 的状态、plugin record 读写
lib/prompt-scan.js   提示词披露：三层归属、替换注册项的 text provider、文本缓存
lib/prompt-attribution.js  生成的提示词归属快照
lib/bridge.js        设置页路由：只读 GET /describe，与唯一有副作用的 POST /describe/refresh
lib/client.js        设置页（React，无构建步骤，自建页面）
scripts/gen-attribution.mjs         重新生成工具归属表（顺便把包名归一化）
scripts/gen-prompt-attribution.mjs  重新生成提示词归属表（装新插件后跑一次）
scripts/dev-link.mjs                把宿主包 junction 到本地 node_modules（仅开发/测试）
test/run.mjs                        单元测试
test/e2e.mjs                        端到端（fake host 驱动真实 apply()，17 个场景）
test/client.mjs                     渲染冒烟：用最小 React shim 跑一遍设置页组件
test/naming.mjs                     命名/分类/校验层：包名归一化、家族命名、常驻判据、k=3 门槛、D1–D9
test/all.mjs                        五套件顺序跑（每套独立进程）
```

设计文档在 `docs/`：`设计蓝图.md`（为什么这么设计）、`落地方案.md`（实现规格与验收）、
`工具家族与权重.md`（141 个工具逐项 tok 权重）、`改进方案.md`（通用性审计与性能排名）、
`改进方案-网关描述与提示词分层.md`（0.7.0 的依据：描述来源、提示词分层、ungrouped 过滤）。

## 安装注意

`@deepseek-ai/schemastery` 是唯一运行时依赖。以 `link:` 方式装进 profile 时，
pnpm 只会把 profile 的 `node_modules` 指向本包，而本包自己的裸导入按**真实路径**解析，
因此需要在包目录里有一份可解析的宿主包：

```
node scripts/dev-link.mjs <宿主 @deepseek-ai 目录>
```

它把缺的包 junction 进本包 `node_modules/@deepseek-ai/`（已存在的跳过）。
宿主目录通常是 `<app>/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai`
或 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\@deepseek-ai`。

`dsh-tools` / `dsh-session` / `dsh-system-prompt` 三个 peer 在**运行时**不需要真实解析
（宿主在内存里路由），只有直接 `node test/*.mjs` 跑测试时才需要。

## 实测（desktop profile，v0.3.1 的真实会话）

> 本节是 0.3.1 的原始测量，**保留原样不复算**：里面的网关名（`blender` / `mcp` /
> `search` / `hindsight` / `image` / `session` / `video`）是 0.8.0 之前的短名，现在分别叫
> `blender_plugin` / `mcp_connector` / `free_search` / `hindsight_coding_agents` /
> `image_gen` / `session_query` / `video_storyboard`。数字不受影响（改名只动 label 与名字本身，
> 见下文 0.8.0 的字节账），所以不重测。

会话 `session-624ade42`，同一进程内切换插件配置后逐项测量。
「开启前」取同一会话里那次 `reason: "change"` 的 149 工具请求头（141 个原有工具
+ 8 个 wincu MCP 工具，后者是 MCP 服务器当时已连上的产物，与本插件无关）。

| 项 | 开启前 | 开启后 |
| --- | --- | --- |
| wire 工具数 | 149 | **58** = 36 核心 + 7 OPS + 5 上下文 + **10** 网关 |
| wire JSON | 154,001 字节 ≈ 48.1k tok | 52,444 字节 ≈ 16.4k tok |
| 系统提示词 | 14,305 字符 ≈ 4.5k tok | 9,167 字符 ≈ 2.9k tok |
| 运行时上下文 | 1,932 字符 | **513 字符** |
| **每轮净省** | — | **≈ 31.7k tok** |

两个来源分开记：
- **工具定义** 净省 101,557 字节 ≈ 31.7k tok（10 个网关自重 10,186 字节 ≈ 3.2k tok，
  被收起的 101 个成员 91,371 字节 ≈ 28.6k tok）。网关从 8 个变 10 个，是因为新增了
  内置家族 `session` 与 `schedule`。
- **提示词披露** 共收起 5,546 字符 ≈ 1.7k tok：
  `dsh-free-search` 2,576（`free-search:engines`）、`dsh-image-gen` 2,838
  （`image-defaults` 1,138 + `canvas` 281 是上下文，另计）、`@deepseek-ai/dsh-mcp-client` 3,248
  （`mcp:wincu`）、`@deepseek-ai/dsh-tool-session-query` 630（`tool:session-query`）。
  其中 image-gen 的两条是**运行时上下文**（每轮作为 user 消息重发），
  1,932 → 513 字符就是它消失的证据。

关键证据：
- 开启后整个会话**只发生一次** `request/header` 重写（`reason: "change"`），之后近 30 轮复用同一份工具数组 —— 前缀不再重付。
- `plugin:tool-gate/state` / `dispatch` 记录已落在会话日志里。
- **提示词在被隐藏的第一轮就已经是空的了**（不是用了才变），所以披露不会造成前缀缓存失效；
  代价是 `action: "list"` 的返回永久占用一次上下文。

冒烟（8 个第三方网关各 list 一次 + call 一次）：list 全部返回正确成员数
（blender 15 / mcp 25 / github 14 / search 9 / hindsight 8 / video 6 / image 6 / mcp_servers 1），
call 全部成功路由；其中 blender 成员自身报 `ECONNREFUSED 127.0.0.1:9876`（addon 未运行），
属成员内部错误、原样透出，网关转发本身正常。直呼 `gh_repo` 被拦并提示改走网关。

10 个家族在设置页上的实时清单（`curl /api/dsh-tool-gate/describe`，v0.4.0，家族 id 由包名推导；
**标签与网关名同样是 0.8.0 之前的**，id 没变）：
`blender_plugin` 15 / 8,415 tok、`github` 14 / 2,734、`hindsight_coding_agents` 8 / 2,047、
`image_gen` 6 / 3,730、`mcp_connector` 25 / 5,444、`mcp_servers` 1 / 187、
**`schedule` 4 / 1,870**、`free_search` 9 / 2,088、**`session_query` 5 / 1,244**、
`video_storyboard` 6 / 3,436。

wire 上的工具：**58** 个（36 CORE + 7 OPS + 5 Context + 10 网关），全部按 code-unit 排序，
没有任何被收起家族的成员泄漏（`gh_*` / `blender_rt_*` / `mcp__*` / `schedule_*` / `session_*` 均为零）。

子代理的 wire 是 **57** 个而非 58 —— 子代理作用域本来就没有 `ops_discover_tools` 与 `todo_write`。
冻结面是「过滤 assemble 给出的列表」，不写死名字表，所以每个 agent 各自得到自己那份。

## 自测

```
node scripts/dev-link.mjs <宿主 @deepseek-ai 目录>   # 只需一次
node test/run.mjs    # 单元：Config / 家族 / 冻结面 / 网关 schema / 派发 / 状态隔离 / record / 归属通道 / 扫描失效 / 标签派生
node test/e2e.mjs    # 端到端：fake host 驱动真实 apply()，17 个场景（含 refreshContext、作用域注册、空网关、撤回解冻）
node test/client.mjs # 渲染冒烟：最小 React shim 跑一遍设置页，抓出悬空变量与 hook 顺序问题
node test/naming.mjs # 0.9.0 四层：包名归一化 / 家族命名（永不含数字）/ 常驻判据 / 退化阈值 k=3 / 归属校验 R-a..R-c / 自检 D1–D9
node test/all.mjs    # 五套件顺序跑一遍（各自独立进程，互不共享全局状态）
```

## 0.9.0 的改动

三个 bug，一个根因：**归属与命名各有两个来源，而没有一个地方说哪个算数**。

| 现象 | 根因 |
| --- | --- |
| 网关叫 `subagent2` | id 冲突时追数字后缀，数字进了 wire 名、配置键、页面 id |
| 家族键是 `@vectorize-io/hindsight-coding-agents/dsh` | 归属原样记下模块说明符，没归一化成包名；`families.hindsight_coding_agents` 配了等于没配 |
| 18 个 `ops_*` 归到「Agent Loop」，7 个常驻、11 个被藏 | 「注册发生在谁的上下文里」被当成「谁注册的」；`dsh-ops` 往 agent 作用域注册，最近的那个 entry 是宿主。另外保留集是手写的 7 条 |

修复按四层分开，每层都只有一个判定点：

**身份层** —— `canonicalPackage()` 是唯一的包名归一化入口（去掉子路径、拒绝相对/绝对/协议 URL），
`owner.js` 的实时通道与栈回溯都过它；归属结果不再是一个字符串，而是 `OwnerIdentity { pkg, specifier, source, confidence, evidence }`。
新增 `engine-packages.js` 列出引擎包（`@deepseek-ai/dsh-agent-loop` 这类），
引擎包给出的归属一律降级为「未知」而不是成族 —— 未知意味着留在 wire 上，出错的方向是多花 token 而不是藏掉工具。
`attribution-verify.js` 拿已安装包的**源码声明**反证归属：R-a 前缀认领（`dsh-ops` 声明 `ops_`）、
R-b 引擎反证（包的源码写了这个名字，宿主就赢不了）、R-b2 未知/低置信度由声明补正、R-c 矛盾告警。
它修不了的一律降级露出，绝不凭空发明归属。
证据的**先后**也在身份层：读盘扫描排在内置表之前，且内置表答出来的「低置信度」名字会被
重新交给扫描核实 —— 反过来先问内置表，会让 141 个名字永远停在低置信度，页面上 9 个家族
一起报「成员归属置信度低」，而它们的归属从来没出过错。

**命名层** —— 四个名字一个含义：`familyId` = `wireName`（全局唯一、不含数字）、`label`（展示用，撞名时加包名末段）、
`configKey`（+`aliases`）。冲突时依次尝试 `subagent` → `subagent_tools` → `deepseek_ai_subagent`，
三次都不行就不建家族，并在自检里报 `id-collision`。数字后缀从此不再产生，只是**认得**（`subagent2..9` 当曾用名）。

这里有一条只有真跑起来才会发现的自指陷阱：**「哪些名字已被占用」不能包含本插件自己的网关**。
网关名是家族表的输出，把它当输入就成了「第一轮注册 `github`，第二轮发现 `github` 已被占，
于是家族改名 `github_tools`」—— 一个家族两个网关，而这一轮的冻结面还把旧名字一起冻住了。
所以 `reservedIds` 会先滤掉本插件拥有的所有工具；别人的同名工具仍然是真冲突，仍然要后缀。
线上实测这一条之前，`github` / `free_search` / `video_storyboard` 都被改成了 `*_tools`。

**分类层** —— 常驻判据收敛成 `resident.js` 的一个函数，由 owner + 前缀推导：
用户 pin、核心名、引擎包、`ops_*` 且 owner 是 `dsh-ops`、上下文包。
成族、藏工具、卡片计数、退化判定四处共用它，`keep-tools.js` 里那份手写 OPS 表删掉了。
建族还多了一道门槛（`degenerate.js`）：

```
可折叠节省 = Σ tokens(非常驻成员)
网关成本   = tokens(网关 schema + 描述) + 60
建族 ⇔ 可折叠成员 ≥ 1 且 可折叠节省 > 3 × 网关成本
```

`k = 3` 是可配置的（`degenerateThreshold`），`force: true` 可以按家族强行建族。
省不到三个网关的家族不建族、不建网关，工具全部常驻，页面上写清原因 —— 宁可没省，也不要一个「点开只有一个成员」的网关。

**呈现层** —— `ungrouped.reason` 不再默认 `resident`，而是按证据分五种：
`claimed`（已在该家族的网关后面）、`no-collapsible-members`、`no-tools`、`unowned`、`misattributed`（红标）。
**事实排在怀疑前面**：一行先陈述「它的工具全常驻」「它不注册工具」，只有在工具确实可折、
只是归属说不清时才标 `misattributed`。反过来（先怀疑）会让 `dsh-ops` 的 7 个常驻 `ops_*`
和 `billion-context` 的 5 个常驻上下文工具齐刷刷红成「归属异常」，而真相只是「这里没有可收的东西」。
新增自检 D1–D9（`diagnostics.js`），每次快照都跑一遍，问题直接显示在设置页顶部：

| 断言 | 严重度 | 含义 |
| --- | --- | --- |
| D1 `uncovered-tools` | error | 工具有归属，却既不常驻也不在任一家族 —— 归属逻辑漏了一块 |
| D2 `claimed-without-members` / `specifier-as-package` | error | 家族声明了某个包，但该包的工具不在里面 / packages 里出现模块说明符 |
| D3 `false-resident-reason` | error | 「工具全部常驻」这一行里还有工具不是常驻 —— 就是这次的那个错因 |
| D4 `wire-collides-with-tool` / `wire-has-digit` / `wire-duplicate` | error | 网关名撞工具名（会遮住真工具）、含数字、两个家族重名 |
| D5 `degenerate-family:below-threshold` | warn | 启用了，但省不回 `k×` 网关成本（可 `force: true` 或调低阈值） |
| D5 `degenerate-family:no-collectable-members` | info | 成员全部常驻，没有可折叠的东西 —— 事实陈述，不是缺陷 |
| D6 `low-confidence-attribution` | warn | 家族名下有归属置信度低的成员 |
| D7 `half-collapsed-family` | info | 一半常驻一半可折叠（合法，但要说出来） |
| D8 `unknown-family-key` / `config-alias` | warn / info | 配置键匹配不到任何家族 / 按曾用名生效了 |
| D9 `id-collision` | info | 某个包因为拿不到干净的名字而没被折叠 |

三条规则在线上实测后收窄过一次，都写进了自检，免得下一版再把它们放宽：

- D1 不把**本插件自己的网关**算成「有归属却没被任何家族收走」—— 网关是家族的脸，天生不在
  `family.packages` 里。之前它会对每个网关报一条 error。
- D2 只在「该包的工具落在了**别的**家族里」时才算错。一个包在当前安装里根本没注册工具
  （`fs_search`、`pwsh_persistent` 就是这样）或成员全部常驻，都不构成 split。
- D5 区分两种不成立：省不回成本（可改，黄）与没有可折叠的成员（不可改，蓝）。
  空家族（`no-members`）不再报 —— 它的插件本来就没注册工具。

设置页也跟着改：家族行多了「未折叠」标记、`配置键 X（曾用名：…）`、`可折叠 n/m（净省 X tok，网关成本 Y）`，
「未参与折叠」区写的是五种原因之一而不是干巴巴的「常驻」。

**迁移** —— 旧配置键不用改：`families.dsh`（旧说明符名）与 `families.subagent2`（旧数字名）都作为别名生效，
命中了会在自检里记一条 `config-alias`。反而要删的是那四个**止血键** —— 0.8.x 时期在 profile 的
`cordis.patch.yml` 里为绕开本 bug 加的四个家族键 `dsh`（顶替说明符名）/ `subagent2` / `agent_loop` / `fs:false`。
它们本来就是「让这个 bug 看起来不存在」的补丁：`agent_loop` 那个家族现在根本不会产生（`ops_*` 按规则常驻），
`subagent2` 的三个成员本来就是核心工具，`fs` 也一样。留着只会让人以为家族还在被压着。
（`schedule: false` 不属于止血键，那是用户自己的偏好，保留。）

必须提前说清楚的一件小事：止血键删掉之后，**`families.agent` / `families.mcp_servers` / `families.session_query` /
`families.tavily` 会在自检里变成 `unknown-family-key` 警告** —— 它们本来就已经失配了（这版 profile 里没有
这几个家族），只是 0.8.x 把这四行静默丢掉了。0.9.0 不替你删配置，只是不再假装没看见。


## 0.8.0 的改动

三件事，互相独立：名字不再意译、描述不再截短、装完插件当场就能看见。

### 标签从包名派生，整张表删掉

0.7.0 的标签链是「短名表 → 宿主 `meta.title` → id 驼峰化」。表里那 9 行把品牌
写成了能力词（`hindsight` → 记忆、`free_search` → 搜索、`image_gen` → 图像、
`mcp_connector` → MCP 管理），而表的优先级又高于宿主标题——于是 `hindsight` 家族
在页面上叫「记忆」，模型看到的网关描述是 `网关 · 记忆：…`。这既不是包名，也不是
插件作者写的标题，而是本仓库某一版某个人挑选的词。

现在 `lib/family-labels.js` 里**没有表了**，只有一条派生规则：

```js
// @vectorize-io/hindsight-coding-agents -> Hindsight Coding Agents
const PREFIXES = ["dsh-tool-", "dsh-plugin-", "dsh-", "plugin-"];
const ACRONYMS = new Set(["fs", "mcp", "api", "cli", "ui", "http", "url", "json", "ide"]);
```

去 `@scope` 前缀 → 去掉一个 `PREFIXES` 里的前缀 → 按 `[-_.\s]+` 切词 → 每词首字母
大写（缩写词整词大写）。**不再读宿主 locale 的 `title`**：那一层正是「记忆」的来源。

网关名同时回归家族 id。`gatewayName(prefix, familyId, explicit)` 在 `explicit` 为
`undefined` 时返回 `` `${prefix}${familyId}` ``，现场 `gatewayPrefix: ""`，所以
`session_query` 就叫 `session_query`，不再缩成 `session`。这一条不是审美问题：
网关名和家族 id 分家之后，roster、页面、配置键三处各说各的名字，而配置键一直是
family id——改名反倒让它们重新对齐了。

派生结果（实测 13 行）：

| 家族 id | 0.7.0 | 0.8.0 | 网关 0.7.0 → 0.8.0 |
| --- | --- | --- | --- |
| `blender_plugin` | Blender | **Blender Plugin** | `blender` → `blender_plugin` |
| `computer_use_win` | Computer Use Win | Computer Use Win | 不变 |
| `free_search` | 搜索 | **Free Search** | `search` → `free_search` |
| `fs` | 文件读写工具 | **FS** | `fs` → `fs` |
| `fs_search` | 文件搜索工具 | **FS Search** | `fs_search` → `fs_search` |
| `github` | GitHub | **Github** | `github` → `github` |
| `hindsight_coding_agents` | 记忆 | **Hindsight Coding Agents** | `hindsight` → `hindsight_coding_agents` |
| `image_gen` | 图像 | **Image Gen** | `image` → `image_gen` |
| `mcp_connector` | MCP 管理 | **MCP Connector** | `mcp` → `mcp_connector` |
| `schedule` | 日程 | **Schedule** | `schedule` → `schedule` |
| `session_query` | 会话检索 | **Session Query** | `session` → `session_query` |
| `tavily` | Tavily | Tavily | 不变 |
| `video_storyboard` | 视频 | **Video Storyboard** | `video` → `video_storyboard` |

代价说清楚：`GitHub` 变成 `Github`（纯派生认不出品牌），`Blender` 变成
`Blender Plugin`（包名里就带 `plugin`，派生如实反映）。退出通道是配置覆盖——
`families.github.label: GitHub` 仍然最高优先，`gateway:` 与 `gatewayPrefix` 同理。

### 网关描述不再截短

`lib/plugin-meta.js` 此前有 `DEFAULT_CAP = 120`，`summarize()` 会**只取第一句**再按
码点截到 120 并补 `…`。两处都错，而且错在同一个方向上：插件作者写给模型的那段话
才是模型应该看到的全部内容，本插件没有资格替作者删减。实测 `blender_plugin` 的原文
是 1251 B / 5 句，被砍成 217 B——砍掉的正好是「怎么用、有什么限制」那几句。

现在 `summarize()` 退化成压平：`String(text ?? "").replace(/\s+/g, " ").trim()`。
不找句末、不截断、不加省略号。**默认不设上限**；想设的人配
`maxDescriptionChars`（`0` = 不限，默认 `0`），只有 `> 0` 时才按码点截断并补 `…`。
上限是**读时**的，改了立刻生效：`readAt()` 的缓存键从 `mtimeMs` 变成
`{ mtimeMs, ceiling }`，命中还要比 ceiling——否则调大上限会读到旧截断值。

### 装完插件，当场看得见

用户报的现象是「停/启 tavily 之后，家族列表不更新，要再来一遍才出现」。归属链上
有**三处各管一段、谁也不通知谁的缓存**：

| # | 位置 | 原来 | 现在 |
| --- | --- | --- | --- |
| C1 | `lib/tool-scan.js` 扫描计划 | 按 profile 根缓存，注释写「只有安装才变」，但安装不让它失效 | 计划按 `manifestStamp(root)` 失效（`package.json` 的 `mtimeMs:size`，一次 `stat` 0.2 ms） |
| C2 | `lib/owner.js` `registered()` | 按 `${revision}\u0000${knownKey}` 记忆化，`revision` 只在本进程看到注册/注销时 +1 | 新增 `forget()`：清 `scanned`、弃 memo、`revision += 1`（**不清** `live` / `preexisting`，那两条是进程事实） |
| C3 | 设置页「刷新清单」 | 只重新 `GET /describe`，宿主侧什么都不重算 | 改走 `POST /api/dsh-tool-gate/describe/refresh`：`forgetScanCache()` → `ownerIndex.forget()` → `refreshFamilies({ force: true })` |

C1 是根因：插件安装**一定**会改写 profile 的 `package.json`（bundle 列表就在里面），
所以拿它的指纹做失效条件既便宜又准确，日常路径上不需要任何人记得调 `forget()`。
C2 留给指纹看不见的情况（同长度同秒改写、原地换包），C3 是用户手里的那个按钮。

`/refresh` 的边界：只收 **POST**（`GET` → 405，跨站 `Origin` → 403，仍然过
`isAllowed`），返回与 `/describe` **同形**的快照，所以页面拿到就能直接替换，不用
再发一次 GET。它只改「你看得见什么」——当前会话的 wire 是冻结的，新家族从**下一个
会话**开始折叠，页面上的提示语也这么写。这与「网关被撤回时解冻」不冲突：那是撤回
一个已经在用的网关，这是新装一个还没进来的。

### 空网关：判空要看「谁能调」，不是「注册表里有没有」

wire 上曾经多出一个 0 成员的 `fs_search` 网关：`dsh-ops` 用 `agent.restrict({deny})`
把 `read`/`glob`/`grep` 从 agent 作用域里挡掉了，但 `knownNames()` 是**不受限制**的
超集，仍然认为那几个名字存在；而页面按 `schemas(agent)`（只含 visible）算成员数，
算出来是 0，于是把行隐藏了。两边不一致的结果是：模型拿到一个 `list` 只能回「没有
成员」的工具，用户看不见它、也关不掉它。

判定改为 `callableNames(primaryScope)`：各 agent 的 `view(scope).visible` 并集，加上
正在装配的那个作用域；只有在完全没有作用域时才退化成不带作用域的视野（fake host 与
老调用点走这条，行为与之前一致）。`knownNames()` 保留，但只用于归属推导。

同一处还有第二个不一致：0 成员家族的 `promptDisclosure` 说 `available: true`，
`reason: "ready"`——给了一个翻不动也没意义的开关。现在改成 `available: false`、
`reason: "no-tools"`（页面本来就隐藏这些行，这是 API 层的一致性）。

### 网关被撤回时，解冻

`AgentState.adopt()` 是**粘性**的，这是刻意设计：冻结面变化就等于提示前缀重付，
所以一冻结就尽量不动。代价是中途消失的网关会一直留在冻结面里，而它收起的成员
又回不来——用户感觉是「这个家族死了」。

现在 `syncGateways()` 记住上一轮的名字集合，**有名字消失**就清掉所有 agent 的
`frozen` / `collapsed` / `collapsedNames` / `ready` / `noticeText`，并记一条
`gateway(s) withdrawn (…) ; re-freezing N agent(s)`。没有名字消失的那一轮不重建，
所以稳态仍然粘性（`test/e2e.mjs` 场景 17 两头都断言）。

还有一个必须一起做的细节：宿主在跑 `system-prompt/assemble` 之前就收好了 schema
列表，所以这一轮里被 dispose 的网关**仍在**待过滤的列表上；而冻结面的未知归属策略
是 `expose`，它会被当成未知工具留下。于是加了 `everWithdrawn` 集合：撤回过的名字
直接从这一轮的列表里滤掉，重新出现的名字再移出集合。

### 实测（desktop profile，13 个家族 / 12 个启用网关）

| 项 | 0.7.0 | 0.8.0 |
| --- | ---: | ---: |
| 12 个网关 description 正文 | 1412 B | **3880 B** |
| 网关整行（`网关 · label：detail`） | 1673 B | **4180 B** |
| roster（`本轮收起：` 那一行） | 238 B | **343 B** |
| 共享参数 schema ×12 | 4800 B | 4800 B |
| **合计** | **6711 B** | **9323 B（+2612 B ≈ +816 tok/轮）** |

也就是说，这一版是**用前缀换准确**：多付约 0.8k tok/轮，换来名字与插件作者原意一致、
描述完整。想按下限的人可以配 `maxDescriptionChars: 300`，那样是 2857 + 343 + 4800 =
**8000 B**，仍然比 0.7.0 多 1289 B，但比不限少 1323 B。

## 0.7.0 的改动

### 网关描述改为从宿主读，不再写死

此前每个家族的名字与一句话说明都写在 `lib/family-labels.js` 里（`BY_PACKAGE` 9 条 + `BY_ID` 1 条），
`lib/gateways.js` 用它们拼出 `${label} 家族的网关。${description}`。后果是：表里没有的包
（也就是**任何将来新装的插件**）只能拿家族 id 当描述；而 `lib/discovery.js` 早就留好了
`metadata` 注入口，`lib/index.js` 的 `resolveNow` 却**从来没传过**——一条一次都没接线的通路。

现在描述走宿主自己的 `pluginPackages`（设置页「插件」列表显示的就是它产的文本，同一个来源、
同一套 locale 文件，两边不会打架），三级兜底：

1. `metaOf(pkg)` —— 读 `locale/*.json` 的 `meta.description`，读不到再读包自己的 `package.json`；
2. 插件清单的 `description`；
3. `lib/family-labels.js` 的兜底句（只剩这一层是手写的）。

（第 3 层是手写文案，最终也是「记忆」「图像」这类意译词的藏身处——0.8.0 把它和整张标签表
一起删了，描述现在只有前两层，没有兜底句：说不出来就留空，页面标 `无`。）

**新模块 `lib/plugin-meta.js`** 负责这一切。要点都是被实测逼出来的：

- 每个 Loader entry 的 `baseUrl` 才是解析锚点。拿单一 profile 根去解析，第一方包全部落空。
- `readPluginMeta` 只对**裸包名**读 `package.json`，子路径 specifier（`dsh-ops/discovery`）永远读不到，
  所以先 `barePackageName` 再查。
- locale 文件必须是 `{ "meta": { "title", "description" } }`。宿主 `dictionariesOf` 读的是
  `parsed.meta.title`，旧版平铺写法被**静默忽略**——本插件自己的两个 locale 文件已一并修正。
- 按包记 `manifestPath` 与 mtime，文件没改就不重复读；`describe()` 永不抛。

（label 的取值链在 0.7.0 是「短名表 → 宿主 `meta.title` → id 驼峰化」；0.8.0 已把前两层都删掉，
改为纯粹从包名派生，见下文。）

### 网关使用说明只在系统提示词里说一次

`buildNotice` 早就在系统提示词里讲了 `list` / `call` 怎么用，而每个网关的描述又各带一遍同样的
4 行样板——12 个网关 **351 B × 12 = 4212 B**，占全部网关描述文本的 85%。

现在描述只说「这个家族是做什么的」，格式固定为 `网关 · Blender：…`；说明只在 notice 里出现一次，
notice 末尾补一行名单 `本轮收起：\`blender\` Blender · \`github\` GitHub · …`。
`staticNotice: false`（没有 notice）时，每个网关的描述自动补一句最小可用说明，
模型仍能自己摸到 `list`——这是唯一会变长的配置。

`reconcileGateways` 的比对从此看**网关自己的字节**（`[id, label, description, selfExplaining]`），
而不只是家族成员。否则切换 `staticNotice` 会出现「开关翻了、描述却还是旧的」——
描述恰恰是这段唯一的产物。

顺带把三个共享参数描述压到最短（序列化 400 B / 网关）：模型要知道的是怎么调网关，
不是网关为什么存在。

### 「未参与折叠」只列第三方

设置页那一段列出 38 行，其中 31 行是内置插件——它们的提示词根本不由本插件发往 wire，列出来
只会把真正需要注意的 4 行淹掉。现在服务端只保留 `thirdParty === true` 的行（实测 38 → 4），
省下的行数记在 `ungroupedBuiltin` 里，页面用一行小字交代「另有 N 个内置插件的包未参与折叠」。
同时把 `runtime.packages()` 的 key 走 `barePackageName` 归一化：`dsh-ops/discovery`、
`dsh-ops/mode-ptc` 这类子路径身份并回它们真正所属的包。

### 实测（desktop profile，12 个可见家族）

| 项 | 0.6.0 | 0.7.0 |
| --- | ---: | ---: |
| 12 个网关 description 合计 | 4964 B | **1648 B** |
| 共享参数 schema ×12 | 5676 B | **4800 B** |
| 系统提示词 notice | 1341 B | **897 B**（632 规则 + 265 名单） |
| **合计** | **11981 B ≈ 3.7k tok** | **7345 B ≈ 2.3k tok（−38.7%）** |

逐家族的 description 与 `docs/改进方案-网关描述与提示词分层.md` §8.2 的预算逐字节一致。

## 0.6.0 的改动

### 设置页合并成一个列表

此前页面有两段列表：一段是家族折叠（12 行），一段是提示词披露（42 行）。两者说的是
同一批东西——**一个家族就是它的插件包**（发现逻辑按包派生家族），于是同一个实体出现
两次，用户要在两处回答同一个问题。而 42 个插件行里只有 4 行真的可用，其余全是灰的。

0.6.0 把两段并成一段：一行 = 一个家族，折叠开关在右侧，提示词开关在行内第二行。

```jsonc
// families[] 每行新增
"promptDisclosure": {
  "available": true,                    // 现在打开是否真的会做事
  "reason": "ready",                    // ready|master-off|requires-collapse|required-only|no-family|unowned|no-prose|no-tools
  "chars": 2576,                        // 该家族贡献给提示词的字符数
  "names": ["free-search:engines"],
  "required": false,
  "enabled": true,                      // 开关自己的位置（与 available 分开）
  "hasText": true
}
// 顶层新增，只读；plugins[] 不再存在
"ungrouped": [
  { "package": "dsh-context", "reason": "no-tools", "chars": 0, "enabled": null, "thirdParty": true }
]
```

`reason` 与 `enabled` 是**两件事**：前者说开关能不能用，后者说它现在在哪一边。
一个家族开了披露又被重新展开时，开关仍然是「开」的——否则用户的设置就凭空消失了。

无家族的包（工具全常驻、或只注入提示词不注册工具）进 `ungrouped`，只读列出：它们仍
可能在往提示词里注入内容，藏起来会让人以为是漏了；但也不给一个翻不动、看着像坏的开关。
（0.7.0 起只列第三方，见上。）

配置随之升到 v2：`families[id].promptDisclosure: boolean` 取代 `promptPlugins[pkg].enabled`。
`lib/migrate.js` 在家族表解析之后跑一次幂等迁移，把 v1 的非空开关折到对应家族上再清空旧键
（无家族的包 drop 并记 debug 日志）。迁移之后只读家族标志，一个开关不再有两个真相。

## 0.5.0 的改动

### 归属改为读 carrier，栈回溯降为兜底

插件此前用两条路径判断「谁注册了这个工具」：栈回溯（找调用栈上最近的 `package.json`）
和 `ctx.fiber.name`。两者都不对：栈回溯在框架回调之间穿过时会认错包，而
`ctx.fiber.name` **永远是本插件自己**——于是设置页上出现一行 `dsh-tool-gate`，
里面装着别的插件的 15 个工具名和全部提示词段名。

正确做法是读 carrier。Cordis 把服务方法收到的 `this` 做成一个 traceable proxy，
其 `ctx` 属性就是**发起这次调用**的上下文；`cordis-plugin-loader` 又给每个插件的
上下文打了 `Symbol.for("cordis.entry")`，其 `options.name` 就是包名。所以：

```js
this.ctx[Symbol.for("cordis.entry")].options.name   // → "@acme/plugin-a"
```

根上下文（宿主自己的工具）没有这个标记，返回 `undefined` —— 这是正确答案，
不是「未知」。新增 `lib/ownership-channel.js` 统一这个通道，`owner.js` 与
`prompt-scan.js` 都改为先读它，栈回溯只在 carrier 缺失时兜底。

### 网关名不再触发磁盘扫描

`registered()` 会把「认不出归属」的名字交给磁盘扫描，而扫描要读遍 profile 里每个
bundle 的源码。插件自己注册的网关工具名不在任何 bundle 的源码里，所以**永远**认不出，
于是每次调用都要全量重扫。实测（真实清单，109 个名字）：

| | 每次 `registered()` |
| --- | --- |
| 含网关名 | 41.8 ms |
| 网关名排除 + 结果按 revision 缓存 | 0.02 ms |

顺带修掉了上面那行幽灵家族：网关名不再被归给任何包。`diskScan: "off"` 可以直接
关掉磁盘扫描，此时认不出的名字交给 `unknownOwnerPolicy` 处理。

### 其余修正

- **提示词归属**同样改走 carrier。此前每个提示词段都被记到本插件名下。
- **dispose 恢复**：`service[method] === wrapper` 永远为假（每次属性访问都返回新的
  proxy），所以恢复从来没执行过，包装器会一直留着让下次挂载再叠一层。改为无条件恢复。
- **`knownNames()`** 改用 `tools.view(scope).knownNames`。原来用 `schemas()`，
  后者会把每个工具的参数字典深拷贝一遍，而它每次装配都要跑。
- **`syncGateways()`** 改为按名字差量同步。原来任何一处变动都整批 dispose + 重新注册。
- **`isConcurrencySafe`** 带上调用方 agent 的 scope。原来无 scope 查询只看全局层，
  作用域内注册的成员会被读成不存在，并发委托对最需要它的家族静默失效。
- **前缀判定统一**：`@dsh-ops/` 在 `bridge.js` 里曾被当作第三方，而 `discovery.js`
  认为它是第一方。现在只有 `ownership-channel.js` 一处定义。
- **`residentTools`**：可以把工具钉在 wire 上，同时不让它成为某个家族的唯一成员。
- **空家族不再占网关**：家族定义或配置覆盖里点了名、却没有注册任何工具的包（桌面
  profile 里的 `agent`、`fs_search`），此前会拿到一个只能回答「没有成员」的网关，
  白占 wire 两个名额。现在这类家族不挂网关，设置页也不再显示那一行。判定用的是
  `knownNames()`（家族就是从它推出来的），不是某一个 agent 的视野 —— 后者看不到
  作用域内注册的工具，会把有成员的家族误判为空，从而在成员被收起的同时撤掉网关。
- **`describe()` 只读一次注册表**：13 个家族各调一次 `schemas()`（每次深拷贝全部
  参数 schema），实测 14 次调用 / 8.6 ms → 1 次 / 0.9 ms。
- **提示词条目可以自己声明不可摘除**：注册时传 `mutable: false`，本插件就不再
  按名字白名单猜。宿主不解释这个字段（只是原样保存注册对象），所以这是本插件与
  注册方之间的约定；判定读的是实时注册项，注册后再改也立即生效。

### 设置页

- 每行多一个 `reason`（`ready` / `no-switch` / `master-off` / `requires-collapse` /
  `required-only` / `no-family` / `unowned` / `no-prose`），灰显时会说清是哪一条不满足。
- 新增 `ungrouped[]`：列出「在 wire 上但不属于任何家族」的工具及其原因
  （`resident` / `mcp` / `unowned`）。此前这些工具在哪都没出现，看起来像插件没干活。
- bridge 负载 `schemaVersion` 升到 2；会话记录 `RECORD_SCHEMA_VERSION` 同样升到 2，
  但仍能读 v1（agent 行结构没变，拒读只会让升级后恢复的会话全部展开）。
