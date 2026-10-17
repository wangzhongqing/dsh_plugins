# dsh_plugins

个人维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件集合。

Agent skills 在独立仓库：[**my_skills**](https://github.com/wangzhongqing/my_skills)

## 包含的插件

| 插件 | 说明 | 许可证 |
|---|---|---|
| [dsh-skill-scope](./dsh-skill-scope/) | 按会话 / 工作区 / 全局三层控制技能目录，不改任何 `SKILL.md` | MIT |
| [dsh-terminal-locale-font](./dsh-terminal-locale-font/) | 修复 DSH 侧栏终端的方块/问号乱码与 `command not found` | MIT |

## 安装

DSH 插件是 npm 包，需要装配进 profile 并重启宿主。**不是**复制文件那么简单。

```bash
git clone https://github.com/wangzhongqing/dsh_plugins.git
cd dsh_plugins/<plugin-name>
npm install
```

然后按该插件 README 的「安装」章节操作——desktop profile 由 Electron 应用管理，CLI 拒绝写入，需要手动改 `package.json` 和 `cordis.patch.yml`。

## 目录约定

每个插件一个目录，遵循 DSH 插件约定：

```
dsh_plugins/
├── README.md                      # 本文件
├── .gitignore
└── <plugin-name>/
    ├── package.json               # 必需：npm 包清单 + dsh 字段
    ├── lib/                       # 插件实现
    │   ├── index.js               # host 入口
    │   └── client.js              # client 入口（经典脚本格式）
    ├── docs/                      # 产品设计与技术方案
    ├── scripts/                   # 安装/运维脚本
    ├── test/                      # 测试
    ├── cordis.patch.yml           # bundle patch
    ├── dsh.plugin.json            # 插件清单
    ├── dsh-plugin.naming.json     # 命名约定清单
    ├── README.md
    └── LICENSE
```

## 插件与 skill 的区别

| | Agent skill | DSH 插件 |
|---|---|---|
| 形态 | 一个 `SKILL.md` + 可选资源 | 一个 npm 包 |
| 生效方式 | 复制到 skills 目录 | 装配进 profile，重启宿主 |
| 能力边界 | 给 Agent 提供指令和工具 | 改变宿主行为（UI、进程、服务） |
| 仓库 | [my_skills](https://github.com/wangzhongqing/my_skills) | 本仓库 |

## 许可证

各插件的许可证见其各自目录下的 `LICENSE` 文件。
