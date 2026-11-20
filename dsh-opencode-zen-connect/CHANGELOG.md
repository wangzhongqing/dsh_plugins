# Changelog

## 0.2.1 — 2026-11-20

修复两个让免费模型实际不可用的结构性问题，并顺带修掉三个语义错误。

### 修复

- **多轮真的能续上下文**：旧实现每个请求都 `POST /session` 新建会话，再把整段历史压成
  `[1] user: …` / `[2] assistant: …` 的纯文本重发，所以只有第一轮有记忆。现在
  `src/session-registry.js` 以「工作目录 + 首个人类问题」的哈希标识一个 DSH 对话，同一
  对话的所有轮次复用同一个 OpenCode session，只发本轮新问题。
- **能调用本地工具**：`POST /session/{id}/message` 的 `tools` 字段只接受 `{工具名: 布尔}`
  开关，无法携带自定义 schema，所以 DSH 自己的工具传不下去。改为建 session 时带
  `?directory=<DSH 工作目录>`，让 OpenCode 自带的 13 个工具（`bash`/`read`/`glob`/`grep`/
  `edit`/`write`/`task`/`webfetch`/`websearch`/`todowrite`/`skill`/`question`/`invalid`）
  在该目录执行。
- **收得到流式增量**：`/event?sessionID=<id>` 回了 `server.connected` 之后就再也不推
  `message.part.delta`；而 `/event` 不带 `directory` 时只推服务器自己目录下会话的事件。
  改为 `GET /event?directory=<工作目录>` 订阅，再按 `properties.sessionID` 手工丢弃别的
  会话的帧；并在发 prompt 之前就确认订阅已生效（服务端不重放事件）。新增
  `src/event-stream.js`。
- **回答不再答非所问**：DSH 不只发一条 user 消息 —— 真问题之后还会追加自己的 cwd
  system-reminder、技能清单、标题生成请求。旧实现取「最后一条 user」就取到技能清单，
  模型于是长篇讲某个 skill。新增 `src/message-shape.js`，按 `INJECTED_PATTERNS` 跳过
  注入块取真实问题，system prompt 改用 `system` 字段单独下发。
- **思考过程不再混进正文**：`message.part.delta` 的 `field` 恒为 `"text"`（连 reasoning
  part 也是），所以按 `field` 过滤无效。改为用前序 `message.part.updated` 的
  `part.type` 建 `partID → type` 映射，只转发 `text` 类型。
- **终止信号改为 `session.idle`**：带工具的回合有多个 step（`step-start → reasoning →
  tool → step-finish → …`），在 `step-finish` 处结束会截断答案。
- **message body 的 model 改为嵌套**：`model: { providerID, modelID }`；旧实现传的是扁平
  顶层 `providerID`/`modelID`，不符合 schema。

### 新增

- `src/message-shape.js`、`src/session-registry.js`、`src/event-stream.js` 三个模块，以及
  `tests/message-shape.test.mjs`（10 个用例）。测试总数 16 → 26，全绿。
- `opencode-server.js` 新增 `sendOpenCodeMessage()`，`createOpenCodeSession()` 增加可选
  `workdir` 形参；删除已被 `event-stream.js` 取代的 `streamOpenCodeSessionEvents()`。

### 文档

- README / README.en.md 新增「谁在执行？DSH 还是 OpenCode？」一节，用 `ps` 实测输出说明
  推理与工具执行都在 OpenCode 进程内，并列出由此产生的三个后果（DSH 工具不可用、权限
  不由 DSH 管、只有对话外壳在 DSH 里）。
- README / README.en.md 新增「致谢」一节，记录 upstream `sanser9/dsh-opencode-connect`，
  以及 `viztor/dsh-opencode-patch` 与 `jiujiezongheti/zen-useragent` 两个仓库的作用——它们
  没有贡献代码，但各自用不同方式证伪了「改请求头就能过免费层」，是这条路能被找到的前提。

### 验证

- `17*23` → `391`（`cost 0`），真实宿主 headless 端到端通过。
- 「用 bash 列出本目录」→ 正确答出 DSH 工作目录里的 `marker.txt`。
- 三轮对话：`OK` → `4242` → `/Users/zhongqing/Software/Personal`（会话复用 + 工具落在正确目录）。
- 工具执行方实测：`ps -o pid,ppid,command` 输出 `82735 72854 /bin/zsh -c ...`，父进程
  `72854` 即 `opencode serve --port 40961` —— 工具由 OpenCode 执行，不是 DSH。

## 0.2.0 — 2026-11-18

从 `sanser9/dsh-opencode-connect` fork 到第 `wangzhongqing/dsh_plugins` 仓库，身份改名为
`dsh-opencode-zen-connect`。完整改动见 [`OPTIMIZATIONS.md`](./OPTIMIZATIONS.md)。

### 新增 / 修复

- **推理强度档位**：从 opencode 的 model variants 派生 pi-ai 的 `reasoning` +
  `thinkingLevelMap`，DSH 模型选择器现可按模型显示 `low / high / max` 等档位；
  新增 `src/reasoning.js` 纯函数与 `tests/reasoning.test.mjs`。
- **档位透传**：把 DSH 下发的 `reasoning_effort` 一路透传为 opencode message 的顶层
  `variant` 字段（实测 opencode 接受并回显），档位选择真正生效。
- **只显示免费模型**：catalog 过滤从「status=active」收紧为「active 且 cost 全为 0」，
  模型数从 90（78 个付费）降到 12 个免费模型，消除选择器干扰。
- **工程**：新增 `dsh.plugin.json`、`dsh-plugin.naming.json`（namespace `zhongqing`），
  修正归属 URL / CI badge / 版权，清理文档中 5 个不存在的兜底模型名。
- 16 个单元测试全绿；adapter probe 与 variant 透传端到端验证通过。

## 0.1.0 — 2026-10-22

首个公开版本。

### 功能

- 把 OpenCode CLI 的免费模型接入 DSH 模型选择器（自动发现 + 5 分钟刷新）
- 自动拉起或复用本机 `opencode serve`（127.0.0.1:40961）
- 安全 loopback shim：随机 secret、仅回环绑定、Host/Origin 校验
- OpenCode SSE → OpenAI 兼容 SSE 翻译，含流式增量、结束帧与 token 用量
- 内置兜底模型名单，实时目录不可达时模型选择器不空
- 模型名统一带 `· Free` 后缀；所有模型声明为零费用

### 修复（在公开前由测试发现）

- `OpenCodeCatalog` 的内部字段 `source` / `fetchedAtMs` 遮蔽了同名方法，
  导致 `catalog.source()` 抛错并被调用方的 `catch {}` 吞掉——**5 分钟目录
  刷新从未真正生效**。字段改名为 `_source` / `_fetchedAtMs`。
- `hostIsLoopback` 对 `[::1]` 形式解析错误（`split(':')[0]` 得到 `[`），
  IPv6 回环请求被误拒。
- `hostIsLoopback` 用 `startsWith('127.')` 判断 IPv4 回环，导致
  `127.0.0.1.evil.com` 这类主机名被误放行（DNS rebinding 形状）。改为
  锚定的四段式正则，并补齐方括号 IPv6 与端口解析。
- `shim.js` 内重复实现的两个回环守卫改为复用 `loopback.js`，避免两处漂移。

### 工程

- 源码移入 `src/`，`dist/` 由 `npm run build` 生成（纯拷贝），并提交入库
- 新增 12 个测试用例（Node 内置 test runner，零额外依赖）
- 新增 GitHub Actions CI（Node 22.19 / 24 × Linux / macOS）
- `@deepseek-ai/*` peer 范围改为带显式预发布分支的形式，避免 semver 静默
  排除预发布构建
