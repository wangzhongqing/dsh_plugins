<h1 align="center">dsh-opencode-zen-connect</h1>

<p align="center"><b>Bring OpenCode's free models into DeepSeek Harness — zero config, zero cost, works out of the box.</b></p>

<p align="center">
  <a href="https://github.com/wangzhongqing/dsh_plugins/actions/workflows/ci.yml"><img src="https://github.com/wangzhongqing/dsh_plugins/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#install">Install</a> ·
  <a href="#who-runs-what--dsh-or-opencode">Who runs what</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#acknowledgements">Acknowledgements</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

A standalone [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle plugin. It exposes the **free models** of the locally installed [OpenCode](https://opencode.ai) CLI (`deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `big-pickle`, `hy4-flash-free`, `flint-40b-free`, `longcat-2.5-free`, …) in DSH's model picker — no API key, no sign-in, no cost.

The plugin **starts or reuses** a local `opencode serve` (127.0.0.1:40961) and bridges its event stream to OpenAI-compatible SSE through a loopback shim, which DSH's pi-ai adapter consumes. Nothing goes through a third-party relay.

## Who runs what — DSH or OpenCode?

This is the first thing to get straight, because it decides which DSH capabilities survive and which do not.

**Both inference and tool execution happen inside the OpenCode process. DSH only asks, renders and consumes the stream.** Evidence (the `bash` tool printing its own `PPID`):

```
PID  PPID COMMAND
72854     1 /Users/zhongqing/.local/bin/opencode serve --port 40961
82735 72854 /bin/zsh -c ps -o pid,ppid,command -p $$,$PPID ...
```

The tool subprocess's parent is `opencode serve`, not DSH. Concretely:

| Step | Executed by |
|---|---|
| Picking a model, sending the question, rendering the reply | **DSH** |
| Inference (token generation) | **OpenCode** → upstream gateway |
| Multi-turn context storage | **OpenCode**'s session |
| Tool calls and execution (`bash`/`read`/`edit`…) | **OpenCode**'s own tools, inside the session's `directory` |
| Permission decisions | **OpenCode**'s permission system |

So this plugin is essentially **a translator**: it turns DSH's OpenAI-shaped request into an OpenCode session API call, then turns OpenCode's event stream back into OpenAI SSE. It does not — cannot — inject DSH's own tools into the model. `POST /session/{id}/message` accepts `tools` only as `{toolName: boolean}` toggles, never arbitrary tool schemas.

Three consequences you must know:

1. **DSH's tools are not in play — OpenCode's same-named tools are.** `bash`/`read`/`edit` share names but not implementations. DSH's `bash` has its own sandbox and approval policy; here OpenCode simply spawns a `zsh`.
2. **Permissions belong to OpenCode, not DSH.** DSH's `--approval-policy` has **no authority** over tool calls on the OpenCode side. To tighten them you must change OpenCode's own permission config.
3. **Only DSH's conversational shell lives in DSH**: session list, message history, attachments, UI cards. What the model remembers and which commands it ran is known only to OpenCode.

This is also why no amount of patching makes DSH's tools available to these free models — the path does not exist architecturally.

## Acknowledgements

The core idea and the first implementation come from [sanser9/dsh-opencode-connect](https://github.com/sanser9/dsh-opencode-connect) (MIT). This repository is a fork that adds four fixes on top: multi-turn context, tool working directory, event-stream subscription, and message shaping.

Two other DSH community plugins contributed no code, but their failures are the premise that made this route findable. They deserve explicit credit:

**[viztor/dsh-opencode-patch](https://github.com/viztor/dsh-opencode-patch)** — took the path of "patch the gateway headers inside DSH's pi-ai adapter": forge the `User-Agent`, inject a real `ses_…` session id, reconstruct parent-session lineage, and append the `read`/`bash` tool schemas the free tier demands. The author then honestly recorded the outcome in the README — with everything in place, Zen's `-free` models **still return `403 FreeTierError` outside OpenCode**, while the identical request against a paid model returns `200`:

> The gate is not in the request. Measured.

That single sentence saved the most expensive hours of this project. The reason this plugin never attempts header forgery is precisely that record.

One note on evidence strength: **that is its measurement, not mine.** I did not reproduce `403 FreeTierError` on my machine — I reproduced a different form of the same wall, `429 FreeUsageLimitError`. The distinction matters: `403` means "this request is not recognised as a legitimate client"; `429` means "recognised, but the free quota is exhausted." My account/egress was in the exhausted state, so every attempt returned 429. That is also precisely why **only the "go through the opencode process" route could be verified as working** — other routes stop at 429 or 403 regardless of what you change, so you cannot tell "headers still wrong" apart from "quota exhausted."

`dsh-opencode-patch` also measured its own claim, and so did I: running its plugin row with its documented provider configuration inside DSH produced a result consistent with its record —

```
[dsh-opencode-patch] active for providers [opencode, opencode-go]
→ 429: {"type":"error","error":{"type":"FreeUsageLimitError",
   "message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai);
   subscribe to OpenCode Go to keep going: https://opencode.ai/go"},"code":"FREE_TIER","status":429}
```

(It returns 429 here where the README records 403 — same wall, depending on whether the account is currently judged "quota exhausted" or "unauthorised client".)

**[jiujiezongheti/zen-useragent](https://github.com/jiujiezongheti/zen-useragent)** — approached the same boundary from the opposite side. It patches `llm-pi-ai` and `pi-ai` on disk and narrows the free-tier conditions to three: UA starting with `opencode/`, `x-opencode-session` naming a session the account already knows, and `body.tools` containing a function tool called `read`. That inference has real value — it bounds the candidate space of "what the gateway actually inspects" — and this plugin's understanding of request shape draws on it.

But its conclusion is falsifiable, and we falsified it point by point. Below are **real runs inside the DSH host** (`dsh --profile headless --patch …`), not inferences from its README and not bare HTTP:

| zen-useragent's claim | Measured |
|---|---|
| All three conditions ⇒ 200 | All three satisfied; `curl`, `node` and `bun` all get `429 FreeUsageLimitError`, `Retry-After: 36501` |
| The free tier requires no auth | `Bearer public`, a real `oc_sk_…` key, and no header at all — all 429 |
| The difference is in the headers | Byte-level ClientHello comparison: cipher-suite list, extension order, JA3 all identical — still one 200 and one 429 |
| — | **Same second, same IP, same session**: the official `opencode` CLI gets 200 every time; every other client gets 429 every time |

Configured its documented way inside DSH — `llm-pi-ai` provider `opencodezen` with `baseURL: https://opencode.ai/zen/v1`, `User-Agent: opencode/1.18.18`, and a real `ses_…` session — and loaded through its own plugin row:

```
[dsh-plugin-zen-useragent] zen session: ses_e1286e887ffepf5z6MA2f3JUPJ (from opencode client DB)
[dsh-plugin-zen-useragent] already patched (.../dsh-llm-pi-ai/lib/index.js)
[dsh-plugin-zen-useragent] could not locate @earendil-works/pi-ai/api/openai-completions.js — tools fix NOT applied
→ 429: {"type":"error","error":{"type":"FreeUsageLimitError",
   "message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai);
   subscribe to OpenCode Go to keep going: https://opencode.ai/go"},"code":"QUOTA"}
```

Note that third line: **its own third condition — injecting `read` into `tools` — never took effect.** On that machine it could not find `@earendil-works/pi-ai/api/openai-completions.js`, reported `tools fix NOT applied`, and sent the request anyway. So only two of its three conditions were actually live, and those two did not stop the 429.

At the same moment, on the same machine, this plugin's control run (going through `opencode serve`):

```
{"type":"text","text":"MINE_WORKS"}
```

Its own note that "a self-made session always 403s, you must use a session the account knows" suggests the author reached a 403, missed the cause, and kept adding to the request. Adding to it forever terminates in nothing, because what is being judged is not what the request carries — it is **whether the connection belongs to opencode's own process**.

Which is why this plugin exists: since forged requests cannot pass, do not forge — **actually run an opencode and let it make the request**. `opencode serve`'s session API carries the full identity inherently; the request originates from it, and the free tier lets it through.

Each of those two repositories proves the same boundary from a different direction: dsh-opencode-patch falsified "fixing the headers is enough" by direct experiment, and zen-useragent triangulated the boundary by ablation. Without both records, the obvious thing to try would be header patching — and that road is closed.

## Risk notice

> **This plugin relies on OpenCode CLI's free tier and is an unofficial integration.** If upstream changes its free policy or API, the plugin may need updates or stop working. Evaluate the risk yourself; use official vendor APIs when you need long-term stability.

To be clear about what this does: **it saves you from switching between OpenCode and DSH.** You can already use these models for free in a terminal — the plugin just wires the same local capability into DSH's model picker. It provides no accounts, shares no credentials, and bypasses no billing (free models are not billed anyway).

## Features

- **Zero configuration** — install OpenCode CLI and this plugin, restart DSH, and every free model shows up in the picker. No API key, no login.
- **Automatic model discovery** — reads the live catalog from the local `opencode serve` at startup (`/config/providers`) and refreshes it every 5 minutes, so upstream model changes appear in the picker without a restart. Free models are labelled with a `· Free` suffix.
- **Manages the OpenCode server** — reuses an already-running `opencode serve` (never hijacks or restarts it); spawns one only when nothing answers, and reclaims it on DSH shutdown.
- **Secure loopback shim** — a 32-byte random secret per process, bound to `127.0.0.1` only, with `Host`/`Origin` loopback checks. pi-ai never sees the real OpenCode address, only the shim's one-time token.
- **Streaming + usage** — translates OpenCode `message.part.delta` events into OpenAI-compatible SSE with deltas, a finish chunk and token usage; aborts release the upstream connection immediately.
- **Zero cost** — every model declares `cost: 0`, so DSH usage accounting never reports phantom spend.

## Install

### Prerequisites

1. **Node.js** `^22.19.0` or `>=24.0.0`
2. **DeepSeek Harness** (desktop app or `dsh` CLI)
3. **OpenCode CLI ≥ 1.18.0** — the free-tier version gate:

   ```bash
   # official installer (macOS / Linux)
   curl -fsSL https://opencode.ai/install | bash

   # or via npm
   npm install -g opencode-ai

   opencode --version   # must be >= 1.18.0
   ```

   The binary is looked up in this order:

   ```
   ~/.local/share/dsh-opencode-connect/bin/opencode
   ~/.local/bin/opencode
   /usr/local/bin/opencode
   opencode on PATH
   ```

### Install the plugin

```bash
# from npm (once published)
dsh plugin install dsh-opencode-zen-connect

# from source
git clone https://github.com/wangzhongqing/dsh_plugins.git
cd dsh-opencode-zen-connect
npm install --omit=dev
npm run build
dsh plugin install "$PWD"
```

Then **restart DSH**. An `OpenCode` group appears in the model picker.

## How it works

> Want the short answer to "is DSH executing this, or OpenCode?" — see [Who runs what](#who-runs-what--dsh-or-opencode), which includes the `ps` output.

```text
DSH model picker
  -> DSH PiAiAdapter (provider: opencode)
  -> local loopback shim (random port + in-process secret, OpenAI-compatible /v1/chat/completions)
  -> local opencode serve (127.0.0.1:40961, spawned or reused by the plugin)
  -> OpenCode free models
  -> SSE event stream (message.part.delta)
  -> stream-bridge -> OpenAI SSE
  -> DSH streams the reply
```

Design notes:

- **The shim is the only exit.** pi-ai only receives the shim's address and one-time token; the real OpenCode address never leaves the process, and the shim rejects every non-loopback request.
- **Two catalog sources.** The live catalog from `opencode serve` wins; a built-in static roster (`src/catalog.js`) is the fallback so the picker is never empty.
- **5-minute self-healing.** If the live catalog was not ready at startup, a background timer retries and notifies DSH to refresh the adapter.

## Fallback roster

Used when `opencode serve` is unreachable at startup (`src/catalog.js`). The live catalog always takes precedence.

| Model id | Context |
|---|---|
| `big-pickle` | 200K |
| `mimo-v2.6-flash-free` | 200K |
| `deepseek-v4.1-flash-free` | 200K |
| `glm-5.3-flash-free` | 200K |
| `minimax-m3.1-flash-free` | 1M |
| `nemotron-3-ultra-free` | 1M |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No `OpenCode` group in the picker | Plugin not active. Check the DSH log for `dsh-opencode-zen-connect` startup lines and that the profile's `cordis.patch.yml` has the `llm-opencode-zen` row. |
| Group present, no models | `opencode serve` is not running. Run `opencode serve --port 40961` manually to see the error; confirm CLI ≥ 1.18.0. |
| `Provider is not configured: opencode` | Known issue in older builds (empty auth resolution). Upgrade to 0.1.0+. |
| `no opencode binary found` | Binary not in the lookup paths. Install it or symlink it to `~/.local/bin/opencode`. |
| Port 40961 taken | The plugin probes first; if a non-opencode program holds the port, free it or move that program. |
| Replies cut off | Free-tier rate/context limits. Start a new session or switch models. |

Logs:

```bash
tail -f ~/Library/Application\ Support/DSH\ Desktop/logs/host/*.log   # macOS desktop
grep dsh-opencode-zen-connect ~/Library/Application\ Support/DSH\ Desktop/logs/host/*.log
```

## Development

```bash
git clone https://github.com/wangzhongqing/dsh_plugins.git
cd dsh-opencode-zen-connect
npm install       # only @earendil-works/pi-ai
npm run build     # src/*.js -> dist/*.js (plain copy, no transpilation)
npm test          # Node's built-in test runner, no extra dependencies
```

```
src/
  index.js            plugin entry: provider, adapter, 5-minute catalog refresh
  shim.js             local OpenAI-compatible HTTP shim (auth + loopback guards)
  stream-bridge.js    OpenCode SSE -> OpenAI SSE translation
  opencode-server.js  opencode serve lifecycle + HTTP client
  catalog.js          model catalog (live + fallback roster)
  loopback.js         loopback detection and port binding
scripts/build.mjs     build (src -> dist)
tests/                Node built-in test runner suites (12 cases)
cordis.patch.yml      bundle declaration (llm-opencode-zen row)
.github/workflows/    CI (Node 22.19 / 24 x Linux / macOS)
marketplace/          Awesome DSH Plugin submission draft
```

Local debugging: `link:` this repo into a DSH profile's `dependencies`, restart `dsh web`, and expect these log lines:

```
dsh-opencode-zen-connect: opencode server ready at http://127.0.0.1:40961
dsh-opencode-zen-connect: shim listening at http://127.0.0.1:xxxxx
dsh-opencode-zen-connect: registered opencode provider
```

## Disclaimer

This project is not affiliated with OpenCode or DeepSeek; it is a community-maintained third-party DSH plugin. Free-model availability, rate limits and billing are decided entirely by upstream, with no guarantees from this project.

## License

[MIT](LICENSE) © 2026 wangzhongqing
