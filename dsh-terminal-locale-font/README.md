# @zhongqing/dsh-terminal-locale-font

> 修复 DeepSeek Harness 侧栏/浏览器终端（尤其 zsh）的**方块、问号乱码**。

host 端补齐 UTF-8 locale 与登录级 PATH，client 端补齐 Nerd Font / CJK 字体栈。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## 它修什么

用 DSH 侧栏终端时，如果你看到：

- 中文目录名变成 `方块`/`问号`/`\M-^N` 之类的乱码
- `starship`、`fzf`、`zoxide`、`eza` 全部 `command not found`
- PATH 修好后，powerline 分隔符和图标又变成方块

这三件事是**同一个根因的三层表现**，必须一起修。本插件一次解决全部三层。

## 根因（已在 PTY 层面逐字节复现）

侧栏终端由 Electron GUI 进程 `subprocess.spawnTerminal()` 拉起，子进程环境 = GUI 进程环境 + `DSH_SESSION_ID`，**不含任何 `LANG`/`LC_*`**，且 zsh 以 `zsh -i`（非登录）启动、PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`。

由此产生三层问题：

**1. 乱码主因**

没有 UTF-8 locale 时，zsh 无法在提示符里打印多字节路径（如 `王鑫`），会把 UTF-8 序列中的 C1 字节 metafy 成字面量 `\M-^N` 之类的转义并混入裸前导字节（hexdump 复现：`e7 5c 4d 2d 5e 4e …`）。xterm.js 按 UTF-8 解码到非法序列，渲染成替换字形 —— 即用户看到的**方块/问号乱码**。

**2. `command not found`**

非登录 shell 不走 `/etc/zprofile` 的 `path_helper`，`/opt/homebrew/bin` 不在 PATH，`.zshrc` 里的 starship/fzf/zoxide 全部找不到。

**3. PUA 豆腐块**

PATH 修好后 starship（catppuccin-powerline）与 `eza --icons` 会输出 Powerline/Nerd 图标（U+E0B0/E0B6 等私用区字符），而 xterm 写死的字体栈（`ui-monospace … Menlo, Consolas`）不含这些字形，会重新渲染成方块 —— 必须与字体修复**一起**上线。

## 机制

### Host（`lib/index.js`）

启动时包装一次 `ctx.subprocess.spawnTerminal`，为每个终端子进程的 env 合并：

- **`LANG` / `LC_CTYPE = locale`**（默认 `zh_CN.UTF-8`）：仅当现有环境不提供任何 UTF-8 locale 时注入；若存在非 UTF-8 的 `LC_ALL` 则一并替换，否则它会压过 LANG。已是 UTF-8 locale（如 `en_US.UTF-8`）则完全尊重、不覆盖。
- **`extraPath`**（默认 `/opt/homebrew/bin`、`/opt/homebrew/sbin`）：缺失时**前置**去重到 PATH，等价于登录 shell 的 path_helper 效果。

#### locale 优先级处理（v0.1.1 修复）

locale 的优先级是 **`LC_ALL` > `LC_CTYPE` > `LANG`**。

一个容易被忽略的陷阱：`LC_ALL=C LANG=C.UTF-8` 的实际 charmap 是 **US-ASCII**，zsh 依然会 metafy 多字节路径。所以判断"是否已有 UTF-8 locale"时**必须看实际生效的那个值**，不能"任一含 UTF-8 就算有"。

```sh
# 验证：LC_ALL 会压过 LANG
$ env -i LC_ALL=C LANG=C.UTF-8 locale charmap
US-ASCII
```

v0.1.0 的实现用了 `some()`（任一含 UTF-8 即通过），在这个场景下会**跳过修复**，导致插件在本该救命的场景失效。v0.1.1 改为按优先级取第一个非空值判断，并加了对应测试。

### Client（`lib/client.js`）

注入一份文档级样式，用 `!important` 覆盖 xterm DOM 渲染器的字体：

```css
.xterm .xterm-rows, .xterm .composition-view, .xterm .xterm-accessibility-tree {
  font-family: 'DSH Nerd Icons', 'MesloLGL Nerd Font Mono', 'MesloLGS Nerd Font Mono',
    'Maple Mono NF', ui-monospace, SFMono-Regular, Menlo, Consolas,
    'PingFang SC', 'Hiragino Sans GB', 'Heiti SC', monospace !important;
}
```

- `!important` 同时压过 xterm 重注入的主题规则（无 `!important`）和 IME 合成层的内联 `style.fontFamily`。
- 字体栈已按本机字体 cmap 实测校验（MesloLGL/MesloLGS Nerd Font Mono、Maple Mono NF 均覆盖 U+E0B0/U+E0B6/U+E725）；Meslo 与 Menlo 度量兼容，CJK 落到与原栈相同的 PingFang，网格对齐（WidthCache 按原栈测量）漂移可忽略。首个 `DSH Nerd Icons` 是 terminal-plus 内嵌的 unicode-range 仅限 PUA 的字面，缺席时自动跳过。
- 本宿主的 client 插件收不到行内 config（dsh-pet 等同类插件同样如此），故字体栈是 client 端**文档化常量** `FONT_STACK`，要改直接编辑 `lib/client.js`。

#### 格式契约（重要）

web 启动把每个插件的 client 入口当**经典 `<script>`** 拼接加载，`lib/client.js` 里**不允许出现顶层 `import`/`export`**——一个 ESM token 就会让整条 combo 报 `SyntaxError: Unexpected token 'export'`、该入口激活失败。

文件必须保持 `window.__ModuleLoader__.load({ id, factory })` 注册格式，导出走 factory 内的 `exports.apply = …; exports.inject = …`（`inject` 是运行期宿主服务名数组，本插件为 `[]`）。

门禁 `npm run static-check` 用 `vm.Script` 按经典脚本解析把关，`npm test` 里的 vm 用例按 web 启动同款方式执行该文件。

## 安装

desktop profile 由 Electron 应用管理，CLI 拒绝写入，故手动三步：

```sh
# 1) 依赖 + bundle 栈
pnpm --dir ~/.dsh/profiles/desktop add "file:$PWD"
#    再把 "@zhongqing/dsh-terminal-locale-font" 追加进
#    ~/.dsh/profiles/desktop/package.json → dsh.profile.bundles 末尾

# 2) 配置行：追加进 ~/.dsh/profiles/desktop/cordis.patch.yml（见下）

# 3) 完全退出并重新打开 DeepSeek Harness（插件只在启动时装配）
```

卸载：删除 bundles 条目与依赖（`pnpm remove`）、删掉 patch 行、重启。

## 配置

`cordis.patch.yml` 行内 config，**改后需重启**：

```yaml
- id: zhongqing-terminal-locale-font
  name: '@zhongqing/dsh-terminal-locale-font'
  config:
    locale: zh_CN.UTF-8     # 设为 "" 可关闭 locale 注入
    extraPath:
      - /opt/homebrew/bin
      - /opt/homebrew/sbin  # 按需增删；清空数组可关闭 PATH 注入
```

## 开发

```sh
npm install
npm test               # 16 个用例：enrichSpec 全分支 + locale 优先级 + 客户端格式契约
npm run static-check   # 两个入口语法 + 按经典脚本解析 client.js
```

无 TypeScript / 构建步骤，**源码即发布物**（`npm pack` 产物 = `lib` + 清单 + README + LICENSE）。

### 项目结构

```
dsh-terminal-locale-font/
├── lib/
│   ├── index.js               # host：包装 spawnTerminal，注入 locale + PATH
│   └── client.js              # client：注入 xterm 字体样式（经典脚本格式）
├── test/
│   └── lib.test.js            # 16 个用例
├── cordis.patch.yml           # bundle patch（默认配置）
├── dsh.plugin.json            # 插件清单
├── dsh-plugin.naming.json     # 命名约定清单
└── package.json
```

## 已知边界

- 只对 **DOM 渲染器**有效（本宿主 xterm 6.0.0 即 DOM 渲染器）；若未来切 canvas/WebGL 渲染，行字体回归 `fontFamily` 选项，需另行处理。
- **未验证图形界面下的实际像素渲染**（需应用重启后在真实侧栏终端目检：提示符 `王鑫` 正常、starship 电源线图标非方块、启动无 `command not found`）。
- 非 macOS 的目录（Homebrew 为 Intel 路径 `/usr/local/bin` 等）需自行调整 `extraPath`。
- locale 修复只处理**子进程环境**；如果 `.zshrc` 自己显式 `export LC_ALL=C`，仍会被覆盖掉——那种情况需要改 shell 配置，不是插件的职责。

## 许可证

[MIT](./LICENSE)
