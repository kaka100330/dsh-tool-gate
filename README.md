# dsh-tool-gate

渐进披露（progressive disclosure）插件：把第三方工具按**家族**收进 8 个固定网关工具，
让 wire 上的 `tools` 数组在会话内**逐字节恒定**，从而不再因为「工具定义变了」而重付整段提示前缀。

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
| **收起合计** | **84** | **≈22,413** |

常驻的是 45 个核心工具（约 9.0k）、7 个 OPS 工具（约 2.5k）、5 个上下文工具（约 1.2k）
和 8 个网关（约 1.0k）。**代价约 1k tok，换回约 22k tok。**

省的不只是单次长度。只要工具集在会话中途变化（某个插件加载/卸载、某个 MCP 服务器连上），
提示缓存的前缀就整段失效，后续每一轮都要重新计价。冻结工具集之后这件事不再发生。

## 三个承重事实（都已在宿主源码核对）

1. `system-prompt/assemble` waterfall 的**返回值权威** —— 监听器可以替换工具列表。
2. 执行时不看这张列表：`dispatchToolBody` 从注册表解析定义，所以收起的工具**照样能跑**。
3. 请求头只在工具字节变化时才改写 —— 冻结之后前缀不再变化。

## 怎么用

装在插件页，默认 **关闭**。打开后你会看到 8 个网关工具，每个两个动作：

```
blender  { action: "list" }                          → 该家族全部成员的名字、说明、完整参数
blender  { action: "call", tool: "blender_rt_do",
           arguments: { ... } }                      → 调用成员，返回值与直接调用一致
```

同一会话内第二次 `list` 只回一句提示（定义已经在历史里了，不必再占一次上下文）。

模型若直接调用已收起的成员名，会被拦下并提示改走网关 —— 那不是工具本身坏了。
（`interceptDirectCalls` 与 `guardFallback` 可分别关掉。）

## 设置页

插件详情页有开关：启用、list 返回完整定义、系统提示里说明网关、拦截直呼、执行期守卫、
沿用成员并发声明、会话内冻结。改动即时生效，无需重启。

其余项在 profile 的 `cordis.patch.yml` 本插件 `config` 段：

```yaml
- id: dsh-tool-gate
  name: dsh-tool-gate
  config:
    enabled: true
    unknownOwnerPolicy: collapse   # 认不出归属的工具一并收起（默认 expose，更安全）
    alwaysExpose: [some_tool]      # 强制常驻
    alwaysHide: []                 # 强制收起
    gatewayPrefix: ""              # 网关名前缀，留空即用家族名
    families:                      # 归属表：包名精确匹配 / 工具名前缀
      blender:
        packages: [dsh-blender-plugin]
      mcp_servers:
        prefixes: ["mcp__"]
```

## 归属怎么认

按优先级三层：

1. **实时注册包装**（`internal/get` 拿到的 tools 实例，包一层 `register`）——
   从调用栈回溯到最近的 `package.json` 的 `name`。新装插件立刻正确。
2. **内置表**（`lib/builtin-attribution.js`，141 条）—— 覆盖本插件挂载前就已注册的工具。
3. **认不出** —— 按 `unknownOwnerPolicy` 决定留在 wire（默认）还是收起。

`mcp__<server>__<tool>` 自动归到 `mcp_servers` 家族，按服务器名分组。

## 边界与诚实的话

- **`list` 返回的定义会永久留在上下文里**。一个家族 list 一次，就等于把那个家族的定义付了一次。
  收益来自「只 list 真正要用的家族」，以及「不再因为工具集抖动而反复重付前缀」。
- **PTC（`run_code`）呈现模式下自动让路**：那个作用域本来就只放一个工具，没什么可收的。
- **子代理各自独立冻结**，互不干扰。会话恢复时从 plugin record 记的名字重建（不存 schema，
  免得继承旧版本的参数形状）。
- **不修改注册表**（网关本身是普通工具）。关掉开关后所有工具下一轮就回来。
- 明确**不**承诺：`reason: "series"` 的请求头重写（goal round driver 会开新 series），
  以及模型自己要求换工具集的情况。

## 文件

```
lib/index.js      插件入口：assemble 钩子、按 agent 状态、网关同步、拦截装配
lib/config.js     schemastery Config（全字段 volatile + 中文说明 → 设置页自动生成）
lib/owner.js      归属识别（实时包装 / 栈回溯 / 内置表）
lib/families.js   家族表、归属解析、冻结面构造（code-unit 排序）
lib/gateways.js   8 个网关的 defineTool 定义与注册
lib/dispatch.js   list / call 的实现（含 turn 语义上抛）
lib/guard.js      pre-execute 拦截 + tools.guard 兜底
lib/state.js      每个 agent 的状态、plugin record 读写
lib/client.js     设置页（React，无构建步骤）
scripts/gen-attribution.mjs   从 data/attribution.json 重新生成内置表
scripts/dev-link.mjs         把宿主包 junction 到本地 node_modules（仅开发/测试）
test/run.mjs                  单元测试
test/e2e.mjs                  端到端（fake host 驱动真实 apply()）
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

## 实测（desktop profile，141 个工具的真实会话）

| 项 | 值 |
| --- | --- |
| 开启前 wire 工具数 | 141（JSON 126,265 字节 ≈ 39.5k tok） |
| 开启后 wire 工具数 | 65 = 45 核心 + 7 OPS + 5 上下文 + 8 网关 |
| 开启后 JSON | 55,809 字节 ≈ 17.4k tok |
| **净省** | **70,456 字节 ≈ 22.0k tok / 请求** |
| 8 个网关自身成本 | 5,040 字节 ≈ 1.6k tok |
| 被收起的 84 个成员定义 | 75,496 字节 ≈ 23.6k tok |

关键证据：开启后整个会话**只发生一次** `request/header` 重写（`reason: "change"`），
之后 190 多个事件、近 30 轮请求全部复用同一份工具数组 —— 前缀不再重付。
`plugin:tool-gate/state` 与 `plugin:tool-gate/dispatch` 记录已落在会话日志里。

冒烟（8 个网关各 list 一次 + call 一次）：list 全部返回正确成员数
（blender 15 / mcp 25 / github 14 / search 9 / hindsight 8 / video 6 / image 6 / mcp_servers 1），
call 全部成功路由；其中 blender 成员自身报 `ECONNREFUSED 127.0.0.1:9876`（addon 未运行），
属成员内部错误、原样透出，网关转发本身正常。直呼 `gh_repo` 被拦并提示改走网关。

子代理的 wire 是 **64** 个而非 65 —— 子代理作用域本来就没有 `ops_discover_tools`。
冻结面是「过滤 assemble 给出的列表」，不写死名字表，所以每个 agent 各自得到自己那份。

## 自测

```
node scripts/dev-link.mjs <宿主 @deepseek-ai 目录>   # 只需一次
node test/run.mjs    # 单元：Config / 家族 / 冻结面 / 网关 schema / 派发 / 状态隔离 / record
node test/e2e.mjs    # 端到端：no-op / 冻结 / 重入幂等 / 拦截 / turn 语义 / PTC / 隔离 / 活开关
```
