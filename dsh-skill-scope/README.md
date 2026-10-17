# @zhongqing/dsh-skill-scope

按 **会话 / 工作区 / 全局** 三层控制 DSH 的技能目录。

关掉的 skill 不再进入模型看到的 `<available_skills>`，也不再占用上下文；需要时再打开，或者手动「立即加载」把正文塞进下一步。**全程不改动任何 `SKILL.md`** —— 这也是它和技能中心的根本区别：技能中心改的是 frontmatter，是永久全局状态，你在 PPT 会话里关掉的东西，回到代码仓库也是关的。

## 三层怎么叠

| 层 | 在哪改 | 影响范围 | 持久化 |
|---|---|---|---|
| 全局默认 | 设置页 →「技能开关」 | 所有工作区和会话 | 是 |
| 工作区默认 | 会话顶部 workspace 名字旁 | 该目录（最近的 `.git` 根）下所有会话 | 是 |
| 会话临时 | 输入框左侧「技能 58/62」那个药丸 | 当前会话 | 否，重开会话回到工作区默认 |

**就近覆盖**：会话 > 工作区 > 全局；某一层没提到的 skill 继承上一层；都没提到则默认显示。所以刚装上时什么都不变。

「能不能下层关掉上层开的」——能。不设锁，但面板里每行都有徽章写着**当前是哪一层决定的**，一眼看得出是谁关的。

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

它会带时间戳备份 `package.json` 与 `cordis.patch.yml`，然后加依赖、加 bundle、加 loader 行；重复运行不会重复添加。手工改的话是这两处：

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

改完重启宿主。

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
- 工作区键是绝对路径，目录改名后旧键成孤儿（不影响使用）。
- 浏览器两个挂载点的视觉位置还没在真实页面里核过（本轮无浏览器控制）。
- `agent/pre-step` 的时序在集成测试里是直接调用监听器验证的，没有跑完整瀑布链。

## License

MIT
