# 本 fork 的优化记录（dsh-opencode-zen-connect）

本文件记录从上游 `sanser9/dsh-opencode-connect` fork 到本仓库 `dsh-opencode-zen-connect`
所做的全部改动。上游插件已经把本机 OpenCode CLI 的免费模型接进了 DeepSeek Harness（DSH），
本 fork 在其基础上修复了两个影响实际使用的问题，并完成了归属与身份的改名。

---

## 优化一：让免费模型显示「推理强度 / 思考等级」档位并真正生效

### 问题

上游插件接入的模型在 DSH 模型选择器里**没有推理强度下拉框**。但 OpenCode 的很多免费模型
本身是支持 reasoning effort / variant 的（例如 `deepseek-v4.1-flash-free` 支持 `low/high/max`，
`glm-5.3-flash-free` 支持 `low/high/max`，`hy4-flash-free` 支持 `none/high`）。
也就是说：能力在 OpenCode 侧存在，只是没有被 DSH 识别和透传。

### 根因（两处断点）

要理解根因，需要看清 DSH 侧的机制（来自 DSH asar 源码追踪）：

1. DSH 的 `reasoningInfo(model)` 从 pi-ai 模型描述符上的两个字段生成下拉档位：

   ```js
   if (!model.reasoning) return {}
   return {
     reasoning: {
       efforts: getSupportedThinkingLevels(model).map(level => ({
         id: level, name: level[0].toUpperCase() + level.slice(1)
       })),
       ...(defaultLevel === undefined ? {} : { defaultEffort: defaultLevel }),
     },
   }
   ```

   `getSupportedThinkingLevels(model)` 的逻辑：

   ```js
   if (!model.reasoning) return ['off']
   return THINKING_LEVELS.filter(level => {
     const mapped = model.thinkingLevelMap?.[level]
     if (mapped === null) return false                       // 显式 pin 成 null = 不支持
     if (level === 'xhigh' || level === 'max') return mapped !== undefined
     return true                                             // undefined 视为「支持，用默认」
   })
   ```

   `THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']`。
   关键：**不支持的档位必须显式写成 `null`**，否则 undefined 会被当成「支持」。

2. UI 的 `effortChoices` 直接来自 `currentChoice.model.reasoning`（由
   `resolveModelInfo → adapter.resolveModel → normalizeModelInfo` 解析得到），
   而不是 `listModels`。所以档位能否显示，取决于 `resolveModel` 返回的模型描述符上
   有没有 `reasoning` + `thinkingLevelMap`。

上游插件两处都没做：

- `toPiModel()` 构造的 pi-ai 模型描述符**没有** `reasoning` / `thinkingLevelMap` 字段 → DSH 不显示档位。
- 请求链路（shim → stream-bridge → opencode）**不透传** variant → 即使选了档位也不生效。

### 修复（4 个文件 + 1 个新文件）

**① `src/opencode-server.js` — catalog 保留 variants**

`fetchOpenCodeCatalog()` 在映射模型时保留上游的 variants：

```js
variants: m.variants ?? {},
```

**② `src/reasoning.js`（新文件）— variants → pi-ai reasoning 字段的纯函数**

```js
export const THINKING_LEVELS = Object.freeze(
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
)

export function reasoningFromVariants(variants) {
  if (!variants || typeof variants !== 'object') return { reasoning: false }
  const has = level => Object.hasOwn(variants, level)
  const supported = THINKING_LEVELS.filter(has)
  if (supported.length === 0) return { reasoning: false }
  const thinkingLevelMap = {}
  for (const level of THINKING_LEVELS) {
    thinkingLevelMap[level] = has(level) ? level : null   // 不支持的 pin 成 null
  }
  return { reasoning: true, thinkingLevelMap }
}
```

两个刻意的设计：

- **不支持的档位 pin 成 `null`**：因为 pi-ai 对 undefined 的 `low/high` 等会视为
  「支持，用 provider 默认」，只有 `null` 才会被 `getSupportedThinkingLevels` 过滤掉。
- **不设置 `off`**：没有 effort 时 pi-ai 不发 `reasoning_effort`，让 opencode 用它自己的默认 variant。

**③ `src/index.js` — 描述符带上 reasoning + 请求带上 variant**

- `toPiModel()` 里 `const reasoning = reasoningFromVariants(info.variants)`，
  返回对象加 `...reasoning`，并在 compat 里显式声明 `supportsReasoningEffort: true`
  （pi-ai 据此决定是否在 wire 上发 `reasoning_effort`）。
- `streamChat()` 闭包接收并向下传 `variant: params.variant`。

**④ `src/shim.js` — 从 OpenAI 兼容请求里取出 effort**

`/v1/chat/completions` 调用 streamChat 时：

```js
variant: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
```

**⑤ `src/stream-bridge.js` — variant 落到 opencode message**

发给 opencode 的 message body 加：

```js
...(variant !== undefined ? { variant } : {}),
```

实测 opencode 接受并回显顶层 `variant` 字段（见下方验证）。

### 端到端数据流（打通后）

```text
DSH UI 选档位 (如 high)
  → pi-ai 把 reasoningEffort 编成 body.reasoning_effort = "high"
  → shim.js 读 body.reasoning_effort → variant="high"
  → stream-bridge.js 写进 opencode message.variant = "high"
  → opencode 用对应 variant 推理（回显 info.variant="high"）
```

---

## 优化二：只列出免费模型（不再把 90 个付费模型全塞进选择器）

### 问题

重启后模型选择器里出现了 **90 个** opencode 模型，其中只有 12 个是免费的。
其余 78 个是订阅付费模型，点了会用不了（或走订阅计费），严重干扰选择。

### 根因

`fetchOpenCodeCatalog()` 原本只按 `status === 'active'` 过滤：

```js
.filter(m => m.status === 'active')
```

而 opencode 的 `/config/providers` 里 90 个模型**全部**是 `active`，免费的只是其中
`cost.input === 0 && cost.output === 0` 的 12 个。付费模型与免费模型是不同的 model id
（例如付费的 `deepseek-v4.1-flash` 与免费的 `deepseek-v4.1-flash-free` 是两个条目）。

### 修复

`src/opencode-server.js` 的过滤条件改为：

```js
.filter(m => m.status === 'active'
  && (!m.cost || (m.cost.input === 0 && m.cost.output === 0)))
```

含义：

- 只保留 `cost` 全为 0 的免费层模型；
- `!m.cost`（无 cost 元数据）时仍保留，避免上游目录字段稀疏时把选择器清空。

过滤后剩 12 个：`mimo-v2.6-flash-free`、`glm-5.3-flash-free`、`beam-free`、
`flint-40b-free`、`hy4-flash-free`、`big-pickle`、`deepseek-v4.1-flash-free`、
`inkling-2-small-free`、`nemotron-3.5-super-vl-free`、`nemotron-3.5-lightning-free`、
`iceman-free`、`longcat-2.5-free`。其中 8 个带 variants，能在 DSH 里显示推理档位。

---

## 改名与归属（fork 身份）

- 包名 `dsh-opencode-connect` → `dsh-opencode-zen-connect`，版本 `0.1.0` → `0.2.0`。
- bundle patch 行 id `llm-opencode` → `llm-opencode-zen`。
- 作者 / repository / homepage / issues 改为 `wangzhongqing`，仓库指向
  `wangzhongqing/dsh_plugins` 的 `dsh-opencode-zen-connect/` 子目录。
- 新增 `dsh.plugin.json`、`dsh-plugin.naming.json`（namespace `zhongqing`），
  符合本仓库的插件目录约定。
- 修正 README 里的 CI badge、clone 地址、版权归属，并清理了 5 个上游文档里
  虚构的兜底模型名（`kimi-k3-free` 等，实际 `src/catalog.js` 只有 6 个兜底模型）。

**刻意保留的运行时契约**（这些不是插件名，改了会破坏功能）：

- opencode provider id `opencode`（`OPENCODE_PROVIDER`、`providerID`、catalog 各处）；
- 本地服务端口 `40961`；
- opencode 二进制查找路径 `~/.local/share/dsh-opencode-connect/bin/opencode`
  （这是定位 CLI 的路径，不是本插件名）；
- OpenAI 兼容端点 `/v1/models`、`/v1/chat/completions`。

---

## 验证方法

### 单元测试

```bash
node scripts/build.mjs   # src/*.js 纯拷贝到 dist/（manifest 测试要求两者一致）
npm test                 # 16 个用例全绿，含新增的 tests/reasoning.test.mjs
```

`tests/reasoning.test.mjs` 覆盖：无 variants → 非推理；deepseek 的 low/high/max 映射且
medium/minimal/xhigh pin null；全档位逐项映射；off 不配置。

### adapter probe（证明 DSH 侧拿得到档位元数据）

在 DSH profile 目录（`~/.dsh/profiles/desktop`）里跑一个脚本，import 插件 `dist/index.js`
的 `apply`，伪造 ctx 捕获 `registerAdapter` 注册的 adapter，再调用它的 `resolveModel`：

```js
const a = capturedAdapter
console.log((await a.resolveModel('opencode', 'deepseek-v4.1-flash-free')).reasoning)
// → { efforts: [{id:'off'},{id:'low'},{id:'high'},{id:'max'}] }
console.log((await a.resolveModel('opencode', 'mimo-v2.6-flash-free')).reasoning)
// → undefined（该模型无 variants，符合预期）
```

修复前后 `listModels` 数量：**90 → 12**；档位元数据在过滤后依然完整。

### variant 透传实测

直接 POST `http://127.0.0.1:40961/session/{id}/message`（model 用
`deepseek-v4.1-flash-free`，顶层加 `variant` 字段）：

- 无 `variant` → 回显 `info.variant = None`；
- `variant: "low"` → 回显 `"low"`；
- `variant: "max"` → 回显 `"max"`。

证明 opencode 接受并回显顶层 variant，透传链路成立。完整的 shim→bridge 注入测试用 spy
捕获 `variant` 参数：`reasoning_effort: 'max'` → `capturedVariant === 'max'`（HTTP 200、
SSE finish:stop）；无 effort → `capturedVariant === undefined`。

---

## 注意

- 改完源码/文档后需要 `npm run build` 让 `dist/` 与 `src/` 一致（manifest 测试会校验）。
- 装配到 profile 后需**重启 DSH** 才能在安装侧生效（DSH 在启动时读取 bundle 的 catalog）。
- 本 fork 依赖 OpenCode CLI 的免费层，属于非官方集成；上游策略变更可能导致需要跟进更新。
