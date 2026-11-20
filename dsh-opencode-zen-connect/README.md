<h1 align="center">dsh-opencode-zen-connect</h1>

<p align="center"><b>把 OpenCode 的免费模型接入 DeepSeek Harness —— 零配置、零费用、开箱即用。</b></p>

<p align="center">
  <a href="https://github.com/wangzhongqing/dsh_plugins/actions/workflows/ci.yml"><img src="https://github.com/wangzhongqing/dsh_plugins/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#安装">安装</a> ·
  <a href="#谁在执行dsh-还是-opencode">谁在执行</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="#致谢">致谢</a> ·
  <a href="#故障排查">故障排查</a> ·
  <a href="#开发">开发</a>
</p>

---

一个独立的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle 插件。它把本机已安装的 [OpenCode](https://opencode.ai) CLI 的**免费模型**（`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`big-pickle`、`hy4-flash-free`、`flint-40b-free` 等）接入 DSH 的模型选择器，让你在 DSH 里直接使用，无需 API Key、无需登录、不产生任何费用。

插件会**自动拉起或复用**本机的 `opencode serve`（127.0.0.1:40961），再通过一层本地 loopback shim 把 OpenCode 的事件流翻译成 OpenAI 兼容的 SSE，交给 DSH 的 pi-ai 适配器。整个过程不经过任何第三方中转，凭据（如果有）始终留在你自己的机器上。

## 谁在执行？DSH 还是 OpenCode？

这是使用本插件前最该搞清楚的一件事，因为它决定了哪些 DSH 能力还在、哪些不在。

**模型推理和工具执行都在 OpenCode 进程里，DSH 只负责发问、渲染和收流。** 实测证据（`bash` 工具打印自己的 `PPID`）：

```
PID  PPID COMMAND
72854     1 /Users/zhongqing/.local/bin/opencode serve --port 40961
82735 72854 /bin/zsh -c ps -o pid,ppid,command -p $$,$PPID ...
```

工具子进程的父进程就是 `opencode serve`，不是 DSH。具体分工：

| 环节 | 由谁执行 |
|---|---|
| 选模型、发问题、渲染流式回复 | **DSH** |
| 模型推理（token 生成） | **OpenCode** → 上游网关 |
| 多轮上下文存储 | **OpenCode** 的 session |
| 工具调用与执行（`bash`/`read`/`edit`…） | **OpenCode** 自带的工具，在该 session 的 `directory` 里跑 |
| 权限判定（是否允许跑某条命令） | **OpenCode** 的 permission 体系 |

所以这个插件本质上是**一层翻译器**：把 DSH 的 OpenAI 格式请求翻译成 OpenCode 的 session API 调用，再把 OpenCode 的事件流翻译回 OpenAI SSE。它没有（也无法）把 DSH 自己的工具注入给模型——`POST /session/{id}/message` 的 `tools` 字段只接受 `{工具名: 布尔}` 开关，不接受任意的工具 schema。

由此产生三个必须知道的后果：

1. **DSH 的工具不可用，用的是 OpenCode 的同名工具**。`bash`/`read`/`edit` 名字一样但实现不同——比如 DSH 的 `bash` 有自己的沙箱与审批策略，而这里是 OpenCode 直接 `spawn` 一个 `zsh`。
2. **权限由 OpenCode 管，不由 DSH 管**。你在 DSH 里设的 `--approval-policy` 对 OpenCode 侧的工具调用**没有约束力**。要收紧，得改 OpenCode 自己的 permission 配置。
3. **只有 DSH 的「对话外壳」在 DSH 里**：会话列表、消息历史、附件、UI 卡片这些都是 DSH 的；但模型想起来什么、跑过什么命令，只有 OpenCode 知道。

这也是为什么这个插件修不了「让 DSH 的工具给免费模型用」—— 不是代码问题，是架构上就没有这条通路。

## 致谢

这个插件的核心思路和第一版代码来自 [sanser9/dsh-opencode-connect](https://github.com/sanser9/dsh-opencode-connect)（MIT）。本仓库是它的 fork，在上面补了多轮上下文、工具目录、事件流订阅和消息整形四类修复。

另外两个 DSH 社区插件没有贡献代码，但它们的失败是这条路能被走通的前提——值得单独写清楚：

**[viztor/dsh-opencode-patch](https://github.com/viztor/dsh-opencode-patch)** — 选择「在 DSH 的 pi-ai 适配器里补齐网关要求的请求头」这条路：伪造 `User-Agent`、注入真实 `ses_…` 会话 id、复刻父会话血统、给免费层请求体补 `read`/`bash` 工具 schema。作者在 README 里诚实地记录了自己的结论——这些全部到位之后，Zen 的 `-free` 模型**在 OpenCode 之外仍然返回 `403 FreeTierError`**，而同一份请求换成付费模型返回 `200`：

> 网关的那道闸不在请求里，实测如此。

一句话省掉后来者最贵的那段时间。本插件之所以从一开始就不去改 header，正是因为这份记录。

**[jiujiezongheti/zen-useragent](https://github.com/jiujiezongheti/zen-useragent)** — 从相反的方向逼近同一个边界。它对 `llm-pi-ai` 与 `pi-ai` 落盘打补丁，把免费层的判定条件收敛为三条：UA 以 `opencode/` 开头、`x-opencode-session` 是账号已知会话、`body.tools` 含名为 `read` 的工具。这套推断本身很有价值——它划定了「网关到底在看什么」的候选范围，本插件对请求形状的理解也参考了它。

但它给出的结论是可以被证伪的，而我们逐个证伪了：

| zen-useragent 的判断 | 实测 |
|---|---|
| 满足三条即 200 | 三条全满足，`curl` / `node` / `bun` 一律 `429 FreeUsageLimitError`，`Retry-After: 36501` |
| 免费档不要求认证 | 带 `Bearer public`、带 `oc_sk_…` key、完全不带，三者皆 429 |
| 差异在请求头 | 逐字节比对 TLS ClientHello：cipher suite 列表、extension 顺序、JA3 全一致，仍一个 200 一个 429 |
| — | **同一秒、同一 IP、同一会话**：官方 `opencode` CLI 恒 200，其他一切客户端恒 429 |

它 README 里「自造会话必 403、必须用账号已知会话」这条经验，说明作者已经摸到过 403 但没找到成因，于是不断往请求里加料。加到最后一无所有——因为判定的不是请求携带的内容，而是**这条连接背后是不是 opencode 自己的进程**。

这就是本插件存在的理由：既然伪造请求过不去，那就不要伪造——**真的去跑一个 opencode，让它自己发请求**。`opencode serve` 的会话 API 天然携带全部「身份」，请求由它发出，免费层照常放行。

两个仓库各自用不同方式证明了同一条边界：dsh-opencode-patch 用正面实验证伪了「补全请求头就能过」，zen-useragent 用消融实验逼近了判定的边界。没有这两份记录，最省事的做法是去改 header，而那条路走不通。

## 风险提示

> **本插件依赖 OpenCode CLI 的免费层，属于非官方集成方式。** 上游一旦调整免费策略或接口，插件可能需要跟着更新，甚至可能失效。请自行评估后使用；需要长期稳定与合规性时，请使用各家的官方 API。

需要说明的是，这个插件做的事情很普通：**省掉在 OpenCode 和 DSH 之间来回切换的麻烦**。你本来就能在终端里免费用这些模型，插件只是把同一份本地能力接到 DSH 的模型选择器上——不提供账号、不共享凭据、不绕过计费（免费模型本身也不计费）。

## 功能特性

- **零配置接入** —— 装好 OpenCode CLI 和本插件，重启 DSH 即可在模型选择器里看到全部免费模型，不需要任何 API Key 或登录。
- **免费模型自动发现** —— 启动时从本机 `opencode serve` 的 `/config/providers` 读取当前可用的免费模型；上游新增或下线模型时，插件每 5 分钟自动刷新一次目录，模型选择器随之更新（模型名统一带 `· Free` 后缀，一眼可辨）。
- **自动管理 OpenCode 服务** —— 检测到本机已有 `opencode serve` 在跑就直接复用（不抢占、不重启）；没有才按需拉起，并在 DSH 退出时干净地回收自己启动的进程。
- **安全 loopback shim** —— 每次进程启动生成一个 32 字节随机 secret，仅绑定 `127.0.0.1`，并校验 `Host` / `Origin` 必须是回环地址；真实的 OpenCode 服务地址不暴露给 pi-ai，适配器只拿到 shim 的地址与一次性 token。
- **流式输出与用量回传** —— 把 OpenCode 的 `message.part.delta` 事件流翻译成 OpenAI 兼容 SSE，包含增量文本、结束帧与 token 用量；中断（用户停止、切换会话）时立即释放上游连接。
- **零费用** —— 所有模型的 `cost` 都被声明为 0，DSH 的用量统计不会虚报开销。

## 安装

### 前置条件

1. **Node.js** `^22.19.0` 或 `>=24.0.0`（DSH 自身的要求）
2. **DeepSeek Harness**（桌面版或 `dsh` CLI）
3. **OpenCode CLI ≥ 1.18.0** —— 免费层的版本门槛。安装方式任选：

   ```bash
   # 官方安装脚本（macOS / Linux）
   curl -fsSL https://opencode.ai/install | bash

   # 或通过 npm
   npm install -g opencode-ai

   # 验证版本（必须 >= 1.18.0）
   opencode --version
   ```

   插件按以下顺序查找二进制，任一命中即可：

   ```
   ~/.local/share/dsh-opencode-connect/bin/opencode
   ~/.local/bin/opencode
   /usr/local/bin/opencode
   PATH 上的 opencode
   ```

   > 提示：如果你的 `opencode` 不在上述位置，把它软链到 `~/.local/bin/opencode` 即可。

### 安装插件

```bash
# 方式一：从 npm（发布后）
dsh plugin install dsh-opencode-zen-connect

# 方式二：从源码（开发/自用）
git clone https://github.com/wangzhongqing/dsh_plugins.git
cd dsh-opencode-zen-connect
npm install --omit=dev
npm run build
dsh plugin install "$PWD"
```

安装完成后**重启 DSH**（或让宿主重新加载 profile），模型选择器里会出现 `OpenCode` 分组。

## 工作原理

> 想先知道「到底是 DSH 在执行还是 OpenCode 在执行」，直接看 [谁在执行？](#谁在执行dsh-还是-opencode)——那里有 `ps` 实测输出。

```text
DSH 模型选择器
  -> DSH PiAiAdapter（provider: opencode）
  -> 本地 loopback shim（随机端口 + 进程内随机 secret，OpenAI 兼容 /v1/chat/completions）
  -> 本机 opencode serve（127.0.0.1:40961，由插件拉起或复用）
  -> OpenCode 免费模型
  -> SSE 事件流（message.part.delta）
  -> stream-bridge 翻译为 OpenAI SSE
  -> DSH 渲染流式回复
```

关键设计：

- **shim 是唯一出口**：pi-ai 只看到 shim 的地址和一次性 token，OpenCode 服务的真实地址不外泄；shim 拒绝一切非回环请求。
- **一个对话一个 session**：`src/session-registry.js` 以「工作目录 + 首个人类问题」的哈希作为对话标识，同一个 DSH 对话的所有轮次复用同一个 OpenCode session，多轮上下文由 OpenCode 自己保存，不再靠把历史压成纯文本重发（旧实现每轮新建 session，因此只有第一轮有上下文）。
- **工具跑在 DSH 工作区**：建 session 时把 DSH 的工作目录作为 `?directory=` 传给 OpenCode，于是 OpenCode 自带的 13 个工具（`bash`/`read`/`glob`/`grep`/`edit`/`write`/`task`/`webfetch`/`websearch`/`todowrite`/`skill`/`question`/`invalid`）就在该目录执行。这是唯一的通路 —— `POST /session/{id}/message` 的 `tools` 字段只接受 `{工具名: 布尔}` 开关，无法把 DSH 自己的工具 schema 传下去。
- **目录双来源**：启动时优先读 `opencode serve` 的实时目录；读不到时退回内置的静态名单（`src/catalog.js`），保证模型选择器不会空着。
- **5 分钟自愈**：如果启动时实时目录没拿到（服务还没就绪），后台定时器会在后续轮询里补上并通知 DSH 刷新适配器。

## 内置兜底模型名单

当 `opencode serve` 暂时不可达时，插件用以下名单兜底（`src/catalog.js`）：

| 模型 id | 上下文 |
|---|---|
| `big-pickle` | 200K |
| `mimo-v2.6-flash-free` | 200K |
| `deepseek-v4.1-flash-free` | 200K |
| `glm-5.3-flash-free` | 200K |
| `minimax-m3.1-flash-free` | 1M |
| `nemotron-3-ultra-free` | 1M |

实时目录可用时以实时目录为准，上表只是兜底。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 模型选择器里没有 `OpenCode` 分组 | 插件未激活：检查 DSH 日志里是否有 `dsh-opencode-zen-connect` 的启动记录；确认 profile 的 `cordis.patch.yml` 有 `llm-opencode-zen` 行。 |
| 分组在但模型列表为空 | `opencode serve` 没起来。手动执行 `opencode serve --port 40961` 看报错；确认 CLI 版本 ≥ 1.18.0（旧版免费层不可用）。 |
| 发送消息报 `Provider is not configured: opencode` | 旧版本的已知问题（auth resolver 返回空）。升级到 0.1.0 及以上。 |
| 报 `no opencode binary found` | 二进制不在查找路径里。按上文装好，或软链到 `~/.local/bin/opencode`。 |
| 端口 40961 被占用 | 插件会先探测该端口；若被别的程序占用且不是 opencode，换一个程序或释放端口。 |
| 回复中途截断 | OpenCode 免费层有速率/上下文限制，长对话会被上游拒绝。开新会话或换一个模型。 |
| 多轮不记得上一轮 | 0.2.1 起已修（旧版每轮新建 session）。升级后确认 `src/session-registry.js` 存在。 |
| 模型不调工具 / 调了但改错目录 | 0.2.1 起已修：session 用 `?directory=<DSH 工作目录>` 创建。若你的会话没有工作目录提示，会回退到 `process.cwd()`。 |
| 回复里混进思考过程 | 0.2.1 起已修：`message.part.delta` 的 `field` 恒为 `text`（连 reasoning 也是），必须靠前序 `message.part.updated` 的 `part.type` 过滤。 |
| 回答答非所问（讲起技能清单） | 0.2.1 起已修：DSH 会在真问题之后追加自己的 `user` 消息（cwd 提醒、技能清单、标题生成），需按 `INJECTED_PATTERNS` 跳过。 |

查看日志：

```bash
# macOS 桌面版
tail -f ~/Library/Application\ Support/DSH\ Desktop/logs/host/*.log

# 只看本插件
grep dsh-opencode-zen-connect ~/Library/Application\ Support/DSH\ Desktop/logs/host/*.log
```

## 开发

```bash
git clone https://github.com/wangzhongqing/dsh_plugins.git
cd dsh-opencode-zen-connect
npm install            # 只装 @earendil-works/pi-ai
npm run build          # src/*.js -> dist/*.js（纯拷贝，无编译）
npm test               # Node 内置 test runner，零额外依赖
```

目录结构：

```
src/
  index.js            插件入口：注册 provider、适配器、5 分钟目录刷新
  shim.js             本地 OpenAI 兼容 HTTP shim（鉴权 + 回环校验 + 路由）
  stream-bridge.js    OpenCode SSE -> OpenAI SSE 翻译
  message-shape.js    DSH 消息整形（取真实问题 / system / 工作目录 / 对话标识）
  session-registry.js 一个 DSH 对话复用同一个 OpenCode session
  event-stream.js     /event 实时订阅（按 directory 订阅，按 sessionID 过滤）
  opencode-server.js  opencode serve 生命周期 + HTTP 客户端
  catalog.js          模型目录（实时 + 兜底名单）
  loopback.js         回环地址判定与端口绑定
scripts/build.mjs     构建（src -> dist）
tests/                Node 内置 test runner 测试（26 个用例）
cordis.patch.yml      bundle 声明（llm-opencode-zen 行）
.github/workflows/    CI（Node 22.19 / 24 × Linux / macOS）
marketplace/          Awesome DSH Plugin 收录草稿
```

本地调试：把本仓库 `link:` 进某个 DSH profile 的 `dependencies`，重启 `dsh web`，日志里应出现：

```
dsh-opencode-zen-connect: opencode server ready at http://127.0.0.1:40961
dsh-opencode-zen-connect: shim listening at http://127.0.0.1:xxxxx
dsh-opencode-zen-connect: registered opencode provider
```

## 免责声明

本项目与 OpenCode、DeepSeek 均无隶属关系，是一个社区维护的第三方 DSH 插件。免费模型的可用性、速率限制与计费规则完全由上游决定，本项目不提供任何保证。使用即表示你理解并接受这一点，并自行承担由此产生的风险。

## License

[MIT](LICENSE) © 2026 wangzhongqing
