# 技能开关（skill-scope）技术方案

日期：2026-10-18
对应产品设计：[product-design.md](./product-design.md)
目标宿主：DeepSeek Harness ≥ 0.1.7-rc.1（本机 0.2.1-rc.2 实测结构）

## 结论先说

**用「同名影子注册」实现按会话过滤，不改宿主、不碰 skill 文件。**

宿主 `@deepseek-ai/dsh-skill` 的注册表是 host + 按 scope 分层，读取时合并「全局层 + 当前 scope 的祖先链」，**最近的层赢同名**。而 `agent.ctx.skills.register()` 注册的东西落进**那个 agent 自己的层**——比任何 provider 层都近。

所以对一个想隐藏的 skill：在 agent 层注册一个**同名**条目，把真实 `description` / `content` / `path` 原样带上，但把 `invocation.modelInvocable` 设成 `false`。效果：

- 内置目录（`@deepseek-ai/dsh-tool-skill`）在发目录前过 `isModelInvocable`，这条直接出局 → 从 `<available_skills>` 消失；
- 内置 `skill` 工具加载前也检查同一个标志 → 明确回 `skill "x" is not available for model invocation`；
- `userInvocable: true` 保留 → `/x` 手势和 `/` 菜单照旧能用；
- 目录消息自己会发现 digest 变了并发布**替换目录**，不需要我们操作消息；
- 撤掉影子 → provider 的原始条目重新胜出，下一步目录里回来。

全程零文件写入，且只影响被注册的那个 agent。

## 为什么不是别的三条路

| 方案 | 为什么不选 |
|---|---|
| 改 `SKILL.md` 的 `disable-model-invocation` | 全局永久状态。这正是现有技能中心的做法，也正是用户不想要的。 |
| 自己实现一个 skill provider 干活 | provider 层比 agent 层**远**。同名永远被真 provider 赢掉，过滤不掉。 |
| 接管 `skill` 工具 + 自己发目录 | 可行（`anchored-standard` 预设的 `skill-search.mjs` 就是这么干的），但要自己重建目录渲染、digest、替换消息、`/name` 手势注入一整套。为了「过滤」重写整条链路，风险和后续升级成本都不划算。影子法把这些全部复用。 |

## 数据结构

一个 JSON 文件：`$DSH_HOME/skill-scope.json`（默认 `~/.dsh/skill-scope.json`）。

```json
{
  "version": 1,
  "global": { "office": false },
  "workspaces": { "/Users/z/Software/ProjA": { "office": true, "tdd": false } },
  "sessions": { "0f3c…": { "ppt-master": true } }
}
```

三条约定：

- **只存显式覆盖**。没出现 = 继承上一层，不是 `false`。这是「面板能说出是谁决定的」的前提。
- **层键**：`global` 无键；`workspace` 用项目根绝对路径；`session` 用 session id。
- **空层自动删掉**。会话关掉后不会留下 `{}` 垃圾。

解析：

```
resolve(name, {workspaceKey, sessionId}):
  session[name] ? → 它
  workspace[name] ? → 它
  global[name] ? → 它
  否则 → true（默认显示）
```

## 宿主半区（`lib/index.js`）

职责三件：维护状态、给面板供数据、把开关落到 agent 层。

### 事件接线

```js
inject = ['skills']

ctx.on('agent/created',   ({agent}) => reconcile(agent))
ctx.on('agent/disposed',  ({agent}) => dropShadows(agent))
ctx.on('agent/pre-step',  async ({agent, signal}, next) => { await reconcile(agent, signal); return next() })
```

- `agent/created` 拿到的 `agent` 就是「按 agent 隔离的入口」，用它注册的一切随该 agent 处置而撤销。这个监听器**返回 promise 并被 await**：`agent/created` 走 `ctx.serial` 派发，await 会把创建公告压到影子注册完成之后，从而消掉「首个请求看到未过滤目录」的竞态，而不必赌 `agent/pre-step` 在瀑布链里的顺序。
- `agent/pre-step` 是兜底：工作区切换、手工改文件、漏掉任何信号，都在下一步前修正。**且同步发生在 `await next()` 之前**——这样无论内置目录监听器排在链的哪一侧，看到的都是修正后的集合。
- 官方指引明确要求：`agent.ctx` 上的注册要自己持有 disposer 并在插件卸载时清理，`agent.ctx` 不会因为插件卸载自动撤销。所以每个 agent 的 disposer 存在 `appliedStubs` 里，`agent/disposed` 和插件 effect 都清。

### reconcile

```
desired = 该 agent 当前应隐藏的名字集合（按两层解析：会话 > 全局）
for 已注册但不再需要 → dispose()           // 打开
for 需要但未注册 → ctx.skills.get(name, {scope: agent})
                  → agent.ctx.skills.register({...真实内容, invocation:{modelInvocable:false,userInvocable:true}})
```

`ctx.skills.get()` 用的是**全局**注册表并带 `scope: agent`，拿到的是「这个 agent 本该看到的那一份」。

**scope 是必须的，不是可选的。** 预设会各自挂载 `skill-filesystem`，所以用户技能落在**那个预设的层**里；不带 scope 的读取只能看到宿主平面（全局层）的运行时技能。这正是「设置页只显示 15 个」的原因——那 15 个是 `univer-office` 的运行时注册，62 个文件系统技能当时根本不在读取结果里。

失败处理：`get` 抛错（provider 挂了）或 `register` 抛错都只记 warn 并跳过，绝不让一个坏 skill 打断整步。

### 没有 session 时借用 live agent 的 scope

设置页没有会话，但用户要看的是真实目录。做法是按优先级借一个 live agent 的 scope：先找 cwd 匹配的，再退到任意一个；一个都没有时保持宿主平面视图。

这不是权宜之计——catalog 本来就是 per-scope 的，没有 scope 就没有「用户会看到什么」这件事可谈。

### 工作区键（数据层仍然生效）

```js
cwd = await ctx.workingDirectory.ensure(agent, signal)   // 拿不到就退化到 session.header.cwd
workspaceKey = findProjectRoot(cwd, existsSync, ['.git'])
```

`findProjectRoot` 是纯函数（在 `lib/shared.js`），注入 `exists` 便于测试。

界面没有工作区档，但这一层**在解析里是活的**：`disabledNames()` 三层都扫，`resolveSkill()` 也按 会话 > 工作区 > 全局 取值。所以手写状态文件里的 `workspaces` 覆盖会真的生效，`test/host.test.js` 有对应用例（子目录继承、其他目录不受影响）。不删这一层是因为它是数据面能力，缺的只是一个挂得住的 UI 位置。

### 路由

四条 exact 路由，全部挂在 `/api/plugins/zhongqing-skill-scope/`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `state` | 面板数据：全量 skill + 解析结果 + 决定层 |
| POST | `set` | 写一条覆盖（`enabled: true/false/null`） |
| POST | `reset` | 清空一层 |
| POST | `load` | 立即加载：把正文 `agent.inject()` 进会话 |

安全边界沿用本机插件家族的既有做法：
- 只接受 loopback socket（`127/8`、`::1`、`::ffff:127.0.0.1`）；
- `sec-fetch-site: cross-site` 直接 403；
- `POST` body 上限 64KB，非 JSON 返回 400；
- `layer` 白名单校验，`enabled` 只接受 `true / false / null`。

### 写入串行化

`ScopeStore` 内部一条 promise 链：读 → 改 → 写临时文件 → rename。两个面板点击不会因为并发读改写而丢一个。单次写失败不会毒化后续写入（链在 catch 后继续）。

## 浏览器半区（`lib/client.js`）

**必须是经典脚本**，不能有顶层 `import`/`export`——宿主的 combo 加载会因为一个 ESM token 整体失败。所以用 `window.__ModuleLoader__.load({id, factory})` 形态，React 从 `require('react')` 拿。

### 三个挂载点

| slot | 用途 | 关键点 |
|---|---|---|
| `conversation.input.left` | 药丸 + 面板 | `inject: (sessionId) => ...` 拿到会话 id；`kind: "list"`，`order: 20` |
| `conversation.session.header.corner` | 会话入口 | `single`，标题栏最右角；不依赖 `inputState`，新会话也渲染 |
| `settings.section` | 全局默认页 | `kind: "list"`，提供 `label` 与 `locale` |

全部走 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`，宿主在 owner 折叠时自动撤销。

### 状态

一个 controller，一份 `useSyncExternalStore` 快照：`{layer, filter, busy, error, data, open, sessionId, cwd}`。`data` 是 host 返回的整份面板数据——每次写操作都由 host 回最新快照，所以开关、徽章、计数永远自洽，不需要前端自己算。

### 样式

只引用 `--dsw-alias-*` 主题 token，不写死颜色。深浅色、主题切换都跟着宿主走。开关用原生 `<button role="switch" aria-checked>`，键盘可用。

## 测试

`npm test`（`node --test`），38 个用例：

1. **纯模型**（`test/shared.test.js`，13 个）：就近覆盖、清覆盖回继承、空层清理、不可变写入、坏文件/未来版本降级、非布尔丢弃、键隔离、计数、项目根发现。
2. **存储**（`test/store.test.js`，6 个）：缺文件、往返、坏 JSON、并发串行、失败不毒化、批量写。
3. **宿主**（`test/host.test.js`，7 个）：用假 context 驱动真实 `apply()`，验证「关掉 → 影子注册且 `modelInvocable:false`、正文与描述保留」「打开 → 影子撤销」「面板能说出决定层」「非 loopback 403」「立即加载把 `<skill_content>` 送进 agent」「`enabled:false` 时零路由」。
4. **真注册表集成**（`test/registry-integration.test.js` + `test/e2e-real-registry.test.js`，6 个）：见上「验证状态」。
5. **包契约**（`test/packaging.test.js`，6 个）：经典脚本加载、导出形态、manifest 一致性、路由与代码对齐、可选服务读取约束。

## 验证状态

已经用**真实实现**验证过的（`test/e2e-real-registry.test.js`，挂真 Cordis + 真 `SkillRegistry`）：

- 关掉一个 skill → 该 agent 的 `isModelInvocable` 集合里确实没它，另一个 agent 照旧看得见；
- 正文仍可取到且 `modelInvocable: false`（正是内置 `skill` 工具拒绝的那一条）；
- 打开 → provider 条目在下次读取时回来；
- 插件自带技能被列为不可开关（`switchable: false`），写接口返回 409；
- 面板能说出每一行是哪一层决定的；
- reset 回到继承。

顺带被真实宿主抓到并修掉的问题：**`ctx.webServer` / `ctx.agents` / `ctx.workingDirectory` 不能在 `inject` 之外直接读**——Cordis 会抛 `cannot get property "x" without inject`。全部改成 `ctx.get(name, false)`（`lib/index.js` 的 `optional()` 助手），这样精简组合里也确实能跑。

包契约也测了（`test/packaging.test.js`）：经典脚本形态能被宿主加载器接住、`apply`/`inject` 导出正确、manifest 三处名字一致、声明的路由都在宿主半区里、以及宿主半区不再直接读可选服务。

## 还没验证的部分

诚实列出来，装上去之后要补：

- **`agent/pre-step` 在真宿主里的先后。** 兜底逻辑仍在 `await next()` 之前完成注册，但真正的保证已经前移：`agent/created` 现在 await 影子注册，创建公告走 `ctx.serial`，所以首个请求之前影子已经在位。`pre-step` 退化成「工作区切换 / 外部改文件」的校正路径，不再承担首次过滤。
- **浏览器两个 slot 的视觉位置**是否会挤到原有控件，需要在真实页面里看（本轮没有可用的浏览器控制，只有静态形态验证）。
- **`workingDirectory` 缺失时的降级路径**已写（回退 `session.header.cwd`）并测过 fake 路径，但没在真组合里跑。

## 安装（desktop profile）

desktop profile 由 Electron 应用管理，CLI 拒绝写入，得手工改两处：

1. profile 的 `package.json`：`dependencies` 加 `"@zhongqing/dsh-skill-scope": "file:/Users/zhongqing/Software/Personal/dsh_plugins/dsh-skill-scope"`，`dsh.profile.bundles` 加同名。
2. profile 的 `cordis.patch.yml`：加一行 insert，`id: zhongqing-skill-scope`。

然后重启宿主。web profile 可以用 `dsh plugin --profile web add`。
