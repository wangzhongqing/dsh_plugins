/**
 * terminal-locale-font — client half.
 *
 * FORMAT CONTRACT (host boot pipeline): the web boot fetches every bundle's
 * client entry as a CLASSIC <script> (combo URL dsh-app://app/plugins/??...).
 * A classic script must not contain top-level `import`/`export` — one ESM
 * token anywhere makes the whole combo fail with
 * `SyntaxError: Unexpected token 'export'` and the entry never activates.
 * Client halves therefore register through window.__ModuleLoader__.load and
 * hand back a CommonJS-shaped module; this file is intentionally NOT ESM.
 *
 * What it fixes: xterm.js (DOM renderer) hard-codes its rows font family
 * (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`) and re-injects
 * it into a theme <style> on every theme/font update, WITHOUT `!important`.
 * Menlo/Consolas carry no Powerline (U+E0B0/E0B6) or Nerd-Font icon glyphs,
 * so once the host half lets starship catppuccin-powerline / eza --icons run,
 * every powerline separator and icon would render as tofu (方块). This half
 * injects one document-level stylesheet whose `!important` beats both the
 * injected theme rule (equal specificity, `!important` wins) and the inline
 * `compositionView.style.fontFamily` set by the IME composition helper.
 *
 * Font stack (verified against this machine's installed fonts — cmap checked:
 * MesloLGL/MesloLGS Nerd Font Mono and Maple Mono NF all cover
 * U+E0B0/U+E0B6/U+E725), ordered:
 *   1. `DSH Nerd Icons` — PUA-only unicode-range face embedded by
 *      dsh-better-sidebar-terminal-plus (skipped gracefully when absent);
 *   2. system Nerd Fonts (Menlo-metric compatible, matches the user's own
 *      terminal);
 *   3. the original stack, plus PingFang/Hiragino/Heiti for CJK fallback.
 * Client plugins do not receive row config in this host, so the stack lives
 * here rather than in cordis.patch.yml config — edit FONT_STACK to change it.
 *
 * @module terminal-locale-font/client
 */
window.__ModuleLoader__.load({
	id: "@zhongqing/dsh-terminal-locale-font",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const STYLE_ID = "dsh-terminal-locale-font";

		const FONT_STACK =
			"'DSH Nerd Icons', 'MesloLGL Nerd Font Mono', 'MesloLGS Nerd Font Mono', " +
			"'Maple Mono NF', ui-monospace, SFMono-Regular, Menlo, Consolas, " +
			"'PingFang SC', 'Hiragino Sans GB', 'Heiti SC', monospace";

		const buildCss = (fontStack = FONT_STACK) =>
			".xterm .xterm-rows, .xterm .composition-view, .xterm .xterm-accessibility-tree {" +
			` font-family: ${fontStack} !important; }`;

		const apply = (ctx) => {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = buildCss();
			(document.head ?? document.documentElement).appendChild(style);
			try {
				ctx?.effect?.(() => () => style.remove());
			} catch {
				/* effect cleanup is best-effort */
			}
		};

		// Host service dependencies for the apply phase — this plugin needs none.
		const inject = [];

		exports.STYLE_ID = STYLE_ID;
		exports.FONT_STACK = FONT_STACK;
		exports.buildCss = buildCss;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
