/**
 * Tests for terminal-locale-font.
 *
 * Covers the host half's pure `enrichSpec` (locale + PATH injection) and the
 * client half's classic-script format contract, which is the failure mode that
 * silently kills the whole plugin combo on boot.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import { enrichSpec } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/**
 * enrichSpec falls back to process.env for locale detection, so tests that care
 * about "no ambient locale" must run with the host's locale vars cleared.
 * Without this the suite passes or fails depending on the developer's shell.
 */
function withoutAmbientLocale(fn) {
	const keys = ["LANG", "LC_ALL", "LC_CTYPE"];
	const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	for (const k of keys) delete process.env[k];
	try {
		return fn();
	} finally {
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

/** Run lib/client.js the way the web boot does: as a classic script. */
function loadClientAsClassicScript() {
	const registered = [];
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load: (entry) => registered.push(entry),
			},
		},
	};
	// vm.Script parses as a classic script — any top-level import/export throws.
	new vm.Script(clientSource).runInNewContext(sandbox);
	return registered;
}

// ---------------------------------------------------------------------------
// Locale injection
// ---------------------------------------------------------------------------

test("injects a UTF-8 locale when the ambient env has none", () => {
	withoutAmbientLocale(() => {
		const spec = enrichSpec({ command: "zsh" }, { locale: "zh_CN.UTF-8" });
		assert.equal(spec.env.LANG, "zh_CN.UTF-8");
		assert.equal(spec.env.LC_CTYPE, "zh_CN.UTF-8");
	});
});

test("a UTF-8 LANG does not mask a non-UTF-8 LC_ALL", () => {
	// LC_ALL wins over LANG. `LC_ALL=C LANG=C.UTF-8` yields US-ASCII, so zsh
	// still garbles multibyte paths — the plugin must not skip the fix here.
	const spec = enrichSpec(
		{ env: { LC_ALL: "C", LANG: "C.UTF-8" } },
		{ locale: "zh_CN.UTF-8" },
	);
	assert.equal(spec.env.LC_ALL, "zh_CN.UTF-8");
});

test("respects an existing UTF-8 locale instead of overwriting it", () => {
	const spec = enrichSpec(
		{ env: { LANG: "en_US.UTF-8" } },
		{ locale: "zh_CN.UTF-8" },
	);
	assert.equal(spec.env.LANG, "en_US.UTF-8");
});

test("replaces an ambient non-UTF-8 LC_ALL, which would otherwise win", () => {
	const spec = enrichSpec(
		{ env: { LC_ALL: "C" } },
		{ locale: "zh_CN.UTF-8" },
	);
	assert.equal(spec.env.LC_ALL, "zh_CN.UTF-8");
});

test("does not add LC_ALL when the env never had one", () => {
	const spec = enrichSpec({}, { locale: "zh_CN.UTF-8" });
	assert.equal(spec.env.LC_ALL, undefined);
});

test("an empty locale disables injection", () => {
	const spec = enrichSpec({ env: {} }, { locale: "" });
	assert.equal(spec.env.LANG, undefined);
	assert.equal(spec.env.LC_CTYPE, undefined);
});

// ---------------------------------------------------------------------------
// PATH injection
// ---------------------------------------------------------------------------

test("prepends missing extraPath entries", () => {
	const spec = enrichSpec(
		{ env: { PATH: "/usr/bin:/bin" } },
		{ extraPath: ["/opt/homebrew/bin"] },
	);
	assert.equal(spec.env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
});

test("does not duplicate entries already on PATH", () => {
	const spec = enrichSpec(
		{ env: { PATH: "/opt/homebrew/bin:/usr/bin" } },
		{ extraPath: ["/opt/homebrew/bin"] },
	);
	assert.equal(spec.env.PATH, "/opt/homebrew/bin:/usr/bin");
});

test("keeps extraPath order when several are missing", () => {
	const spec = enrichSpec(
		{ env: { PATH: "/usr/bin" } },
		{ extraPath: ["/opt/homebrew/bin", "/opt/homebrew/sbin"] },
	);
	assert.equal(spec.env.PATH, "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin");
});

test("ignores empty and non-string extraPath entries", () => {
	const spec = enrichSpec(
		{ env: { PATH: "/usr/bin" } },
		{ extraPath: ["", null, 42, "/opt/homebrew/bin"] },
	);
	assert.equal(spec.env.PATH, "/opt/homebrew/bin:/usr/bin");
});

// ---------------------------------------------------------------------------
// Spec integrity
// ---------------------------------------------------------------------------

test("never mutates the input spec", () => {
	const spec = { command: "zsh", env: { PATH: "/usr/bin" } };
	enrichSpec(spec, { locale: "zh_CN.UTF-8", extraPath: ["/opt/homebrew/bin"] });
	assert.deepEqual(spec.env, { PATH: "/usr/bin" });
	assert.equal(spec.command, "zsh");
});

test("preserves unrelated spec fields", () => {
	const spec = enrichSpec(
		{ command: "zsh", args: ["-i"], cwd: "/tmp" },
		{ locale: "zh_CN.UTF-8" },
	);
	assert.equal(spec.command, "zsh");
	assert.deepEqual(spec.args, ["-i"]);
	assert.equal(spec.cwd, "/tmp");
});

test("passes a non-object spec through untouched", () => {
	assert.equal(enrichSpec(null), null);
	assert.equal(enrichSpec(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Client half: classic-script format contract
// ---------------------------------------------------------------------------

test("client.js parses as a classic script (no top-level import/export)", () => {
	// vm.Script throws on ESM syntax, which is exactly what the boot combo does.
	assert.doesNotThrow(() => new vm.Script(clientSource));
});

test("client.js registers through __ModuleLoader__ and exports the expected API", () => {
	const registered = loadClientAsClassicScript();
	assert.equal(registered.length, 1);
	assert.equal(registered[0].id, "@zhongqing/dsh-terminal-locale-font");

	const mod = registered[0].factory(() => {
		throw new Error("client half must not require anything");
	});
	assert.equal(typeof mod.apply, "function");
	assert.equal(typeof mod.buildCss, "function");
	assert.equal(typeof mod.STYLE_ID, "string");
	// Array created inside the vm realm has a different Array.prototype, so
	// deepStrictEqual would reject it even though it is structurally empty.
	assert.equal(Array.isArray(mod.inject), true);
	assert.equal(mod.inject.length, 0);
});

test("buildCss targets xterm rows with !important and a CJK fallback", () => {
	const [entry] = loadClientAsClassicScript();
	const mod = entry.factory(() => {});
	const css = mod.buildCss("'Test Font'");
	assert.match(css, /\.xterm \.xterm-rows/);
	assert.match(css, /!important/);
	assert.match(css, /'Test Font'/);
	// The shipped stack must keep a CJK fallback or Chinese paths render as tofu.
	assert.match(mod.FONT_STACK, /PingFang SC/);
});
