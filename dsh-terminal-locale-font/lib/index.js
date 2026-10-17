/**
 * terminal-locale-font — host half.
 *
 * DeepSeek Harness spawns sidebar/browser terminals from the GUI process
 * environment, which (unlike Terminal.app/iTerm2) carries NO LANG/LC_* locale
 * and only a minimal PATH, and launches zsh non-login (`zsh -i`). Two
 * consequences on macOS:
 *
 *   1. Without a UTF-8 locale, zsh cannot print multibyte paths in its prompt:
 *      it metafies the C1 bytes of the UTF-8 sequence and emits literal
 *      `\M-^N`-style escapes plus raw lead bytes. xterm.js decodes that as
 *      invalid UTF-8 and renders replacement glyphs — the classic 方块/问号
 *      garbling users see next to Chinese directory names.
 *   2. `/etc/zprofile`'s path_helper never runs (not a login shell), so
 *      /opt/homebrew/bin stays off PATH and starship/fzf/zoxide/eza/bat fail
 *      with `command not found`; once PATH is fixed, the starship
 *      catppuccin-powerline prompt emits Nerd-Font/PUA glyphs that also need a
 *      capable font (handled by the client half, lib/client.js).
 *
 * This half wraps `ctx.subprocess.spawnTerminal` once at startup and merges
 * two things into every terminal spawn's env:
 *   - a UTF-8 locale (LANG/LC_CTYPE; LC_ALL only when it would defeat us),
 *     skipped when the ambient environment already provides a UTF-8 locale;
 *   - config.extraPath directories that are missing from PATH (login-shell
 *     parity), prepended and de-duplicated.
 *
 * Everything is exposed as Config (`locale`, `extraPath`) through the plugin
 * row in the profile's cordis.patch.yml.
 *
 * @module terminal-locale-font
 */
import z from "@deepseek-ai/schemastery";

const name = "terminal-locale-font";

const Config = z.object({
  /** UTF-8 locale injected when the ambient env provides none. "" disables. */
  locale: z.string().default("zh_CN.UTF-8"),
  /** Directories prepended to the terminal child PATH when missing. */
  extraPath: z.array(z.string()).default(["/opt/homebrew/bin", "/opt/homebrew/sbin"]),
});

const PATCHED = Symbol.for("terminal-locale-font.patched");
const LOCALE_KEYS = ["LC_ALL", "LC_CTYPE", "LANG"];

function ambientValue(env, key) {
  return env[key] !== undefined ? env[key] : process.env[key];
}

function hasUtf8Locale(env) {
	// Locale precedence is LC_ALL > LC_CTYPE > LANG. A UTF-8 LANG does NOT save
	// you when LC_ALL is set to something else: `LC_ALL=C LANG=C.UTF-8` yields
	// charmap US-ASCII, and zsh metafies multibyte paths exactly as it does with
	// no locale at all. So judge the value that actually wins, not any value.
	for (const key of LOCALE_KEYS) {
		const value = ambientValue(env, key);
		if (typeof value === "string" && value.length > 0) {
			return value.toUpperCase().includes("UTF-8");
		}
	}
	return false;
}

/**
 * Return a copy of a spawnTerminal spec whose env gains a UTF-8 locale and a
 * login-shell PATH. Never mutates the input spec.
 */
export function enrichSpec(spec, config = {}) {
  if (!spec || typeof spec !== "object") return spec;
  const env = { ...(spec.env ?? {}) };

  const locale = typeof config.locale === "string" ? config.locale.trim() : "";
  if (locale && !hasUtf8Locale(env)) {
    env.LANG = locale;
    env.LC_CTYPE = locale;
    // An ambient non-UTF-8 LC_ALL would override LANG/LC_CTYPE — replace it.
    if (ambientValue(env, "LC_ALL") !== undefined) env.LC_ALL = locale;
  }

  const extraPath = Array.isArray(config.extraPath)
    ? config.extraPath.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
  if (extraPath.length) {
    const base = env.PATH ?? process.env.PATH ?? "";
    const parts = base.split(":").filter(Boolean);
    const missing = extraPath.filter((entry) => !parts.includes(entry));
    if (missing.length || parts.length === 0) {
      env.PATH = [...missing, ...parts].join(":");
    }
  }

  return { ...spec, env };
}

function patchSubprocess(ctx, config) {
  let subprocess;
  try {
    subprocess = ctx.subprocess ?? (typeof ctx.get === "function" ? ctx.get("subprocess") : undefined);
  } catch {
    return false;
  }
  if (!subprocess || typeof subprocess.spawnTerminal !== "function") return false;
  if (subprocess[PATCHED]) return true;

  const original = subprocess.spawnTerminal.bind(subprocess);
  subprocess.spawnTerminal = (spec, ...rest) => original(enrichSpec(spec, config), ...rest);
  subprocess[PATCHED] = true;
  try {
    ctx.logger?.info?.("[terminal-locale-font] patched subprocess.spawnTerminal (locale + PATH injection)");
  } catch {
    /* logging must never break the patch */
  }
  return true;
}

export function apply(ctx, config = {}) {
  if (patchSubprocess(ctx, config)) return;
  // The subprocess service normally exists by the time this patch layer runs;
  // retry briefly for load-order surprises instead of failing silently.
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (patchSubprocess(ctx, config) || attempts >= 50) clearInterval(timer);
  }, 200);
  timer.unref?.();
}

export { Config, name };
