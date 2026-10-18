# @zhongqing/dsh-skill-scope

按 **本会话 / 全局默认** 两层控制 DSH 的技能目录。

关掉的 skill 不再进入模型看到的 `<available_skills>`，也不再占用上下文；需要时再打开，或者手动「立即加载」把正文塞进下一步。**全程不改动任何 `SKILL.md`** —— 这也是它和技能中心的根本区别：技能中心改的是 frontmatter，是永久全局状态，你在 PPT 会话里关掉的东西，回到代码仓库也是关的。

## 两层怎么叠

| 层 | 在哪改 | 影响范围 | 持久化 |
|---|---|---|---|
| 全局默认 | 设置页 →「技能开关」 | 所有会话 | 是 |
| 会话临时 | 输入框上方那条「技能 62/62」 | 当前会话 | 否，重开会话回到全局默认 |

**就近覆盖**：会话 > 全局；会话层没提到的继承全局；都没提到则默认显示。所以刚装上时什么都不变。

> 原本设计有工作区层，已移除：工作区行的「··」菜单条目是宿主硬编码的（只有重命名/删除），不暴露任何 slot，没有诚实的挂载点。

## 哪些能开关

面板里列出**全部**技能，但只有**你自己装的**能开关：

- **可开关**：文件系统里的 skill（`~/.agents/skills`、`~/.dsh/skills`、项目内的 `.agents/skills` 等），有 `SKILL.md`。
- **列出但锁住**：插件在运行时注册的技能（例如 `univer-office` 的 `office` / `univer-*`）。它们没有指令文件，是该插件的路由入口，关掉会让插件行为异常，所以只显示「插件自带」徽章，不给开关。写接口也会对它们返回 409。

列表全部来自运行时注册表，没有任何硬编码名单——增删 skill、换台机器、给别人装，都按各自的实际技能来。

## 「关掉」不等于禁用

- 模型看不到、调不动（内置 `skill` 工具会明确回 `not available for model invocation`）；
- 但在输入框打 `/skill-name` 仍然可用，`/` 菜单里也还在（带「仅用户可调用」标记）；
- 磁盘上什么都不变。

开关是给上下文减负的，不是给用户设限的。

## 生效时机

下一步就生效，不用重开会话。

## 安装

### web profile

```sh
dsh plugin --profile web add @zhongqing/dsh-skill-scope
```

### desktop profile

desktop profile 由 Electron 应用管理，CLI 拒绝写入。仓库里带了一个幂等脚本：

```sh
./scripts/install-desktop.sh
```

它会带时间戳备份两个清单，然后加依赖、加 bundle、加 loader 行，**并把包实际拷进 profile 的 `node_modules`**（只改清单是不够的——宿主按包名从 profile 自己的 `node_modules` 解析），最后验证能从 profile 解析到才返回成功。重复运行不会重复添加。

手工改的话是这三处：

1. `~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": {
    "@zhongqing/dsh-skill-scope": "file:/Users/zhongqing/Software/Personal/dsh_plugins/dsh-skill-scope"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …
        "@zhongqing/dsh-skill-scope"
      ]
    }
  }
}
```

2. `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- insert:
    - id: zhongqing-skill-scope
      name: '@zhongqing/dsh-skill-scope'
      config:
        enabled: true
```

3. 把包拷进 `~/.dsh/profiles/desktop/node_modules/@zhongqing/dsh-skill-scope/`（排除源码树里的 `node_modules`，否则会遮掉宿主的 cordis/dsh 包）。

三步都做完，在 profile 目录里 `node -e "import('@zhongqing/dsh-skill-scope')"` 能成功，才说明装对了。然后重启宿主。

## 配置

挂在 profile 的 `cordis.patch.yml` 那一行上：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉后不装路由、不做任何过滤，已存的状态保留。 |
| `storePath` | 空 | 空则用 `$DSH_HOME/skill-scope.json`。 |
| `projectRootMarkers` | `[".git"]` | 判定工作区根的目录名。 |

## 状态文件

`~/.dsh/skill-scope.json`：

```json
{
  "version": 1,
  "global": { "office": false },
  "workspaces": { "/Users/z/proj": { "office": true } },
  "sessions": { "0f3c…": { "ppt-master": true } }
}
```

只存**显式覆盖**——没出现就是继承。文件坏了或版本更新会整份忽略（回到全开），不会让宿主起不来。

## HTTP 路由

全部限 loopback，前缀 `/api/plugins/zhongqing-skill-scope/`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `state` | 面板数据（`?sessionId=&cwd=`） |
| POST | `set` | 写一条覆盖 `{layer, key, name, enabled}` |
| POST | `reset` | 清空一层 `{layer, key}` |
| POST | `load` | 立即加载 `{sessionId, name}` |

「立即加载」用 `agent.inject()`，按宿主设计不会唤醒空闲 agent——点了之后在会话里发一句话，正文才随那一步进上下文。界面会提示「已排入下一步」。

## 开发

```sh
npm install
npm test          # node --test，38 个用例（含真注册表集成）
npm run static-check
npm run validate  # 命名清单校验（--strict）
```

测试分五层：纯状态模型、存储、宿主接线、**真 `@deepseek-ai/dsh-skill` 注册表集成**、包契约。第四层是关键的——它证明「在 agent 层注册同名影子能真的把 skill 从该 agent 的目录里摘掉」，而不是证明一个假设。

设计与实现细节：

- [产品设计](docs/product-design.html) · [技术方案](docs/technical-design.html) —— 带侧栏目录的网页阅读版
- 纯文本源：[`docs/product-design.md`](./docs/product-design.md) · [`docs/technical-design.md`](./docs/technical-design.md)

## 已知限制

- 会话层不持久化（有意的）。
- **工作区层没有 UI 入口，但数据层是活的**：状态文件里的 `workspaces` 按目录（最近的 `.git` 祖先）给默认值，子目录会话会继承。工作区行的「··」菜单不暴露 slot，所以只能手写文件。有测试覆盖。
- 浏览器两个挂载点的视觉位置还没在真实页面里核过（本轮无浏览器控制）。
- `agent/pre-step` 的时序在集成测试里是直接调用监听器验证的，没有跑完整瀑布链。

## License

MIT
