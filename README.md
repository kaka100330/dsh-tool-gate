# dsh-tool-gate

渐进披露（progressive disclosure）插件：把第三方工具与部分内置工具按**家族**收进
每个家族一个的网关工具，让 wire 上的 `tools` 数组在会话内**逐字节恒定**，
从而不再因为「工具定义变了」而重付整段提示前缀。

## 为什么

DSH 把当前可见的工具定义随每个请求发给模型。工具越多，这段前缀越长：

| 家族 | 工具数 | 约 tok |
| --- | ---: | ---: |
| Blender | 15 | 6,725 |
| MCP 管理 | 25 | 4,338 |
| 图像 | 6 | 2,980 |
| 视频 | 6 | 2,745 |
| GitHub | 14 | 2,178 |
| 搜索 | 9 | 1,665 |
| 记忆 | 8 | 1,633 |
| MCP 服务器 | 1 | 149 |
| **会话检索**（内置） | 5 | 1,242 |
| **日程**（内置） | 4 | 1,868 |
| **收起合计** | **93** | **≈25,523** |

常驻的是 36 个核心工具（约 7.5k）、7 个 OPS 工具（约 2.5k）、5 个上下文工具（约 1.2k）
和 10 个网关（约 1.6k）。**代价约 1.6k tok，换回约 25k tok。**

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
blender  { action: "list" }                          → 该家族全部成员的名字、说明、完整参数
blender  { action: "call", tool: "blender_rt_do",
           arguments: { ... } }                      → 调用成员，返回值与直接调用一致
```

同一会话内第二次 `list` 只回一句提示（定义已经在历史里了，不必再占一次上下文）。

模型若直接调用已收起的成员名，会被拦下并提示改走网关 —— 那不是工具本身坏了。
（`interceptDirectCalls` 与 `guardFallback` 可分别关掉。）

## 家族

**家族不是写死的。** 每个第三方插件包自动成为一个家族：本插件从工具注册处
回溯出「哪个包注册了这个工具」，把同一包的成员归到一族，用包名推出家族 id，
再按包名去 `lib/family-labels.js` 取一个好看的名字（取不到就用 id）。

所以**新装一个插件、重载一次，它的工具就会被收进自己的网关**，不需要改本插件的任何代码。
例子（id 由包名推导）：

| 包 | 家族 id | 网关 |
| --- | --- | --- |
| `dsh-blender-plugin` | `blender_plugin` | `blender`（`family-labels.js` 里给了短名） |
| `@perrylink/dsh-github` | `github` | `github` |
| `dsh-image-gen` | `image_gen` | `image` |
| `dsh-image-gen`（未来新装的 `dsh-acme-widgets`） | `acme_widgets` | `acme_widgets` |

`lib/family-labels.js` 只负责**外观**（中文名、一句话说明、可选的短网关名）。
删掉它也能跑，只是网关会叫 `blender_plugin` 这种 id 名。

**内置家族**（按显式工具名归属，`builtinFamilies` 总开关控制，默认开）：

| 家族 | 网关 | 成员 | ≈tok |
| --- | --- | --- | --- |
| 会话检索 | `session` | `session_search` `session_event_search` `session_event_read` `session_event_trace` `session_trace` | 1,242 |
| 日程 | `schedule` | `schedule_create` `schedule_list` `schedule_update` `schedule_delete` | 1,868 |

内置家族走**显式工具名**匹配（列在 `BUILTIN_FAMILY_TOOLS`），因为它们和常驻控制面
（`plugin_manager` 等）同属一个包，按包归属会连常驻工具一起收走 —— 这是唯一保留的
白名单，而且只点名工具、不点名插件。

关掉任一家族 = 该家族不折叠、成员直接常驻 wire、网关消失。
设置页里 `families` 表是**覆盖项**（改名、合并、改网关名、显式点名成员），不是完整清单。

## 设置页

插件详情页是自建页面，从宿主只读路由 `GET /api/dsh-tool-gate/describe` 取实时清单：

- **总开关** —— 关闭即完全不介入。
- **家族折叠** —— 内置家族总开关；然后每个家族一行：开关 + 成员数 + ≈tok + 网关名 + 成员名单。
- **提示词披露** —— 总开关 + **每个插件一行开关**（不只是会注入提示词的那几个）。
  后端把「拥有工具的包」「家族定义里点名的包」「已经能归属出提示词的包」三者取并集，
  所以将来某个插件开始注入提示词时，**不需要改本插件**就会出现可用的开关行。
  不能披露的行不隐藏，而是灰显并写明原因（`无注入` / `不可披露`），并标注 `内置` 或第三方。
- **行为细节** —— list 详细度、直呼拦截、执行期守卫、并发声明、会话内冻结、未知归属策略。
- 底部三个批量按钮：全部家族折叠 / 全部家族常驻 / 全部插件可披露。

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
    gatewayPrefix: ""              # 网关名前缀，留空即用家族名
    families:
      blender:
        packages: [dsh-blender-plugin]
      mcp_servers:
        prefixes: ["mcp__"]
```

## 归属怎么认

**工具归属**（决定哪些工具被收起）按优先级四层：

1. **实时注册包装**（`internal/get` 拿到的 tools 实例，包一层 `register`）——
   从调用栈回溯到最近的 `package.json` 的 `name`。本插件挂载后发生的注册全走这条。
2. **读盘扫描**（`lib/tool-scan.js`）—— 本插件挂载前就已注册完的工具，注册早已结束，
   没人观察得到。于是去问安装的包本身：谁的源码里出现 `name: "<这个工具>"`（或
   `name: 常量` + `const 常量 = "…"`），这个工具就属于谁。**装新插件不需要改本仓库
   任何文件**，重启即生效。只扫 profile 的 bundle 列表、只查还没归属的名字，
   一次约 0.5 秒，结果按 profile 缓存。
3. **内置表**（`lib/builtin-attribution.js`，141 条）—— 第一方包的兜底，且只认
   「注册表当前真的有」的名字，避免为没装的插件造网关。
4. **认不出** —— 按 `unknownOwnerPolicy` 决定留在 wire（默认）还是收起。

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
  `@deepseek-ai/dsh-tool-session-query`，而该包已登记为 `session` 家族，所以打开它的插件开关后
  那段说明同样只在 `session` 的 `list` 里出现。`schedule` 目前没有任何提示词贡献，因此它的开关行
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


## 文件

```
lib/index.js         插件入口：assemble 钩子、按 agent 状态、网关同步、拦截装配、路由装配
lib/config.js        schemastery Config（全字段 volatile + 中文说明 → 设置页表单可用）
lib/owner.js         工具归属识别（实时包装 / 栈回溯 / 读盘扫描 / 内置表兜底）
lib/tool-scan.js     读盘扫描：问已安装的包「这个工具名在哪」，装新插件不用改仓库
lib/discovery.js     从归属快照推导家族表：一个插件包 = 一个家族
lib/family-labels.js 家族外观（中文名、说明、可选短网关名）——只有这一层是手写的
lib/families.js      家族表装配、归属解析、冻结面构造（code-unit 排序）
lib/gateways.js      网关的 defineTool 定义与注册
lib/dispatch.js      list / call 的实现（含 turn 语义上抛、提示词回吐）
lib/guard.js         pre-execute 拦截 + tools.guard 兜底
lib/state.js         每个 agent 的状态、plugin record 读写
lib/prompt-scan.js   提示词披露：三层归属、替换注册项的 text provider、文本缓存
lib/prompt-attribution.js  生成的提示词归属快照
lib/bridge.js        设置页只读路由 /api/dsh-tool-gate/describe
lib/client.js        设置页（React，无构建步骤，自建页面）
scripts/gen-attribution.mjs         重新生成工具归属表（顺便把包名归一化）
scripts/gen-prompt-attribution.mjs  重新生成提示词归属表（装新插件后跑一次）
scripts/dev-link.mjs                把宿主包 junction 到本地 node_modules（仅开发/测试）
test/run.mjs                        单元测试
test/e2e.mjs                        端到端（fake host 驱动真实 apply()，13 个场景）
test/client.mjs                     渲染冒烟：用最小 React shim 跑一遍设置页组件
```

设计文档在 `docs/`：`设计蓝图.md`（为什么这么设计）、`落地方案.md`（实现规格与验收）、
`工具家族与权重.md`（141 个工具逐项 tok 权重）。

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

10 个家族在设置页上的实时清单（`curl /api/dsh-tool-gate/describe`，v0.4.0，家族 id 由包名推导）：
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
node test/run.mjs    # 单元：Config / 家族 / 冻结面 / 网关 schema / 派发 / 状态隔离 / record
node test/e2e.mjs    # 端到端：fake host 驱动真实 apply()，13 个场景（含 refreshContext 与作用域注册回归）
node test/client.mjs # 渲染冒烟：最小 React shim 跑一遍设置页，抓出悬空变量与 hook 顺序问题
```
