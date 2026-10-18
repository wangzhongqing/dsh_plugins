/**
 * skill-scope — browser half.
 *
 * FORMAT CONTRACT (host boot pipeline): the web boot fetches every bundle's
 * client entry as a CLASSIC <script>. A classic script must not contain
 * top-level `import`/`export`; one ESM token makes the whole combo fail and the
 * entry never activates. This file registers through
 * `window.__ModuleLoader__.load` and is intentionally NOT ESM.
 *
 * Surfaces (two layers: this session, and the global default):
 *   - `conversation.input.dock` — a full-width bar above the composer card:
 *     how much of the catalog this session sees, plus the button that opens the
 *     switch list.
 *   - `settings.section` — a "技能开关" settings page holding the global defaults.
 *
 * There is no workspace layer. The workspace row's "..." menu is hard-coded in
 * `@deepseek-ai/dsh-client-ui-workspace` (rename + delete only) and exposes no
 * slot, so there is no honest place to hang a workspace-scoped entrance.
 *
 * Styling uses host theme tokens only, so light/dark and theme swaps follow
 * the host. All copy goes through the locale service.
 *
 * @module skill-scope/client
 */
window.__ModuleLoader__.load({
  id: '@zhongqing/dsh-skill-scope',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    var h = React.createElement;

    /** Locale namespace owned by this plugin. */
    var NS = 'skill-scope';

    var zh = {
      title: '技能开关',
      intro: '控制技能目录：本会话的临时开关，以及所有会话共用的全局默认。关掉的技能不会出现在模型看到的目录里，也不占上下文；再次打开就回来，需要正文时再手动加载。',
      tabSession: '本会话',
      tabGlobal: '全局默认',
      sessionHint: '只影响当前会话；关掉的技能模型看不到，也不占上下文。',
      globalHint: '影响所有会话，是继承的起点。',
      enabled: '显示',
      disabled: '隐藏',
      load: '立即加载',
      loaded: '已排入下一步',
      pluginOwned: '插件自带',
      pluginOwnedHint: '由插件注册，关掉可能影响该插件；只列出不可开关。',
      inherit: '跟随上层',
      originDefault: '默认',
      originGlobal: '全局',
      originSession: '会话',
      reset: '本层恢复默认',
      count: '{enabled}/{total}',
      pillTitle: '技能开关：{enabled}/{total} 可见',
      pillLabel: '技能',
      hiddenCount: '已隐藏 {n}',
      openPanel: '管理',
      loading: '读取中…',
      close: '关闭',
      filter: '筛选技能',
      empty: '这个目录里没有技能。',
      failed: '操作失败：{message}',
    };

    var en = {
      title: 'Skill switches',
      intro: 'Control the skill catalog: this session\'s switches, plus the global default shared by every session. A hidden skill leaves the model catalog and stops costing context; turning it back on restores it, and loading its body is a separate click.',
      tabSession: 'This session',
      tabGlobal: 'Global defaults',
      sessionHint: 'Affects this session only; hidden skills leave the model catalog and stop costing context.',
      globalHint: 'Affects every session; the root of inheritance.',
      enabled: 'Shown',
      disabled: 'Hidden',
      load: 'Load now',
      loaded: 'Queued for the next step',
      pluginOwned: 'plugin',
      pluginOwnedHint: 'Registered by a plugin; hiding it could break that plugin, so it is listed but locked.',
      inherit: 'Inherit',
      originDefault: 'Default',
      originGlobal: 'Global',
      originSession: 'Session',
      reset: 'Reset this layer',
      count: '{enabled}/{total}',
      pillTitle: 'Skill switches: {enabled}/{total} visible',
      pillLabel: 'Skills',
      hiddenCount: '{n} hidden',
      openPanel: 'Manage',
      loading: 'loading…',
      close: 'Close',
      filter: 'Filter skills',
      empty: 'No skills in this directory.',
      failed: 'Action failed: {message}',
    };

    /**
     * Tiny message formatter for `{name}` placeholders.
     * @param {string} template - copy with placeholders.
     * @param {Record<string, string|number>} [values] - replacements.
     * @returns {string} the formatted string.
     */
    function format(template, values) {
      // A missing dictionary key must never blank a surface: fall back to the
      // key itself, and to an empty string for a template that is not a string.
      if (typeof template !== 'string') return '';
      if (values === undefined) return template;
      return template.replace(/\{([a-zA-Z]+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      );
    }

    // ── styles ──────────────────────────────────────────────────────────────
    var CSS = `
.sks-corner{display:flex;align-items:center}
.sks-cornerBtn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:999px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;line-height:18px;cursor:pointer;white-space:nowrap;transition:background .12s,color .12s}
.sks-cornerBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sks-cornerBtn[data-open="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.sks-cornerLabel{font-weight:500}
.sks-cornerCount{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.sks-cornerOff{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.sks-panel{position:relative;z-index:1200;width:min(420px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 96px));display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);border:.5px solid var(--dsw-alias-border-l1);overflow:hidden}
.sks-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.sks-headTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);flex:1;min-width:0}
.sks-close{width:24px;height:24px;border-radius:var(--dsw-radius-sm);border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1}
.sks-close:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.sks-tabs{display:flex;gap:4px;padding:8px 12px 0}
.sks-tab{flex:1;height:28px;border-radius:var(--dsw-radius-md);border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.sks-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sks-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-weight:600}
.sks-hint{padding:6px 12px 0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.sks-tools{display:flex;gap:8px;padding:8px 12px}
.sks-search{flex:1;height:28px;padding:0 10px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.sks-search:focus{border-color:var(--dsw-alias-state-business-primary)}
.sks-reset{height:28px;padding:0 10px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sks-reset:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sks-list{flex:1;min-height:0;overflow-y:auto;padding:4px 6px 10px}
.sks-row{display:flex;align-items:flex-start;gap:10px;padding:8px 8px;border-radius:var(--dsw-radius-md)}
.sks-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sks-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sks-name{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.sks-name[data-off="true"]{color:var(--dsw-alias-label-secondary)}
.sks-desc{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sks-badge{flex:none;height:16px;padding:0 6px;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:16px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary)}
.sks-badge[data-origin="session"]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted)}
.sks-badge[data-origin="global"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.sks-side{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.sks-switch{position:relative;width:34px;height:20px;border-radius:999px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-bg-layer-4);transition:background .12s}
.sks-switch[data-on="true"]{background:var(--dsw-alias-state-business-primary)}
.sks-switch:disabled{opacity:.5;cursor:default}
.sks-locked{height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:17px;white-space:nowrap;cursor:help}
.sks-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-inverted);transition:transform .12s}
.sks-switch[data-on="true"] .sks-knob{transform:translateX(14px)}
.sks-load{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:10.5px;cursor:pointer;padding:0}
.sks-load:hover{color:var(--dsw-alias-state-business-primary);text-decoration:underline}
.sks-empty{padding:20px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.sks-error{padding:6px 12px 10px;color:var(--dsw-alias-state-error-primary);font-size:11.5px}
.sks-section{display:flex;flex-direction:column;gap:12px;padding:4px 0 8px}
.sks-sectionHead{display:flex;flex-direction:column;gap:4px}
.sks-sectionTitle{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sks-sectionIntro{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.sks-sectionBar{display:flex;align-items:center;gap:8px}
.sks-sectionList{display:flex;flex-direction:column;gap:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:4px}
`;

    /** Inject the stylesheet once. */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      var id = '@zhongqing/dsh-skill-scope';
      if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = id;
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── API client ──────────────────────────────────────────────────────────
    var API = {
      state: '/api/plugins/zhongqing-skill-scope/state',
      set: '/api/plugins/zhongqing-skill-scope/set',
      reset: '/api/plugins/zhongqing-skill-scope/reset',
      load: '/api/plugins/zhongqing-skill-scope/load',
    };

    /**
     * POST JSON and parse the JSON reply.
     * @param {string} path - route.
     * @param {object} body - payload.
     * @returns {Promise<object>} parsed reply.
     */
    async function post(path, body) {
      var response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || response.status + ' ' + response.statusText);
      return data;
    }

    /**
     * Fetch the switch state for one session/cwd.
     * @param {{sessionId?: string, cwd?: string}} query - resolution inputs.
     * @returns {Promise<object>} payload.
     */
    async function fetchState(query) {
      var params = new URLSearchParams();
      if (query.sessionId) params.set('sessionId', query.sessionId);
      if (query.cwd) params.set('cwd', query.cwd);
      var query$ = params.toString();
      var response = await fetch(API.state + (query$ ? '?' + query$ : ''));
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || response.status + ' ' + response.statusText);
      return data;
    }

    // ── shared switch list ──────────────────────────────────────────────────
    /**
     * One row: description, deciding layer badge, switch, optional load button.
     * @param {object} props - row data and handlers.
     * @returns {object} React element.
     */
    function SkillRow(props) {
      var row = props.row;
      var t = props.t;
      var originKey = 'origin' + row.origin.charAt(0).toUpperCase() + row.origin.slice(1);
      var badgeText = t[originKey] || row.originLabel;
      return h(
        'div',
        { className: 'sks-row' },
        h(
          'div',
          { className: 'sks-main' },
          h(
            'div',
            { className: 'sks-name', 'data-off': row.enabled ? 'false' : 'true' },
            row.name,
            h('span', { className: 'sks-badge', 'data-origin': row.origin }, badgeText),
          ),
          row.description
            ? h('div', { className: 'sks-desc' }, row.description)
            : null,
        ),
        h(
          'div',
          { className: 'sks-side' },
          row.switchable === false
            ? h('span', { className: 'sks-locked', title: t.pluginOwnedHint }, t.pluginOwned)
            : h(
                'button',
                {
                  type: 'button',
                  className: 'sks-switch',
                  role: 'switch',
                  'aria-checked': row.enabled ? 'true' : 'false',
                  'aria-label': row.name,
                  title: row.enabled ? t.enabled : t.disabled,
                  'data-on': row.enabled ? 'true' : 'false',
                  disabled: props.busy ? true : undefined,
                  onClick: function () {
                    props.onToggle(row, !row.enabled);
                  },
                },
                h('span', { className: 'sks-knob' }),
              ),
          props.canLoad
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sks-load',
                  title: t.load,
                  onClick: function () {
                    props.onLoad(row);
                  },
                },
                props.loadedName === row.name ? t.loaded : t.load,
              )
            : null,
        ),
      );
    }

    /**
     * The switch panel: layer tabs, filter, rows, reset.
     * @param {object} props - injected controller and helpers.
     * @returns {object} React element.
     */
    function SwitchPanel(props) {
      var controller = props.controller;
      var state = controller.useSnapshot();
      var t = props.t;
      var layer = state.layer;
      var query = state.filter.toLowerCase();
      var rows = state.data === undefined
        ? []
        : state.data.skills.filter(function (row) {
            if (query === '') return true;
            return (row.name + ' ' + (row.description || '')).toLowerCase().indexOf(query) !== -1;
          });
      var hint = layer === 'session' ? t.sessionHint : t.globalHint;
      return h(
        'div',
        { className: 'sks-panel', role: 'dialog', 'aria-label': t.title },
        h(
          'div',
          { className: 'sks-head' },
          h('span', { className: 'sks-headTitle' }, t.title),
          h(
            'button',
            {
              type: 'button',
              className: 'sks-close',
              title: t.close,
              'aria-label': t.close,
              onClick: function () { controller.close(); },
            },
            '\u00d7',
          ),
        ),
        h(
          'div',
          { className: 'sks-tabs', role: 'tablist' },
          h(
            'button',
            {
              type: 'button',
              className: 'sks-tab',
              role: 'tab',
              'aria-selected': layer === 'session' ? 'true' : 'false',
              'data-active': layer === 'session' ? 'true' : 'false',
              onClick: function () { controller.setLayer('session'); },
            },
            t.tabSession,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'sks-tab',
              role: 'tab',
              'aria-selected': layer === 'global' ? 'true' : 'false',
              'data-active': layer === 'global' ? 'true' : 'false',
              onClick: function () { controller.setLayer('global'); },
            },
            t.tabGlobal,
          ),
        ),
        h('div', { className: 'sks-hint' }, hint),
        h(
          'div',
          { className: 'sks-tools' },
          h('input', {
            className: 'sks-search',
            type: 'search',
            placeholder: t.filter,
            value: state.filter,
            onChange: function (event) { controller.setFilter(event.target.value); },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'sks-reset',
              title: t.reset,
              onClick: function () { controller.resetLayer(); },
            },
            t.reset,
          ),
        ),
        state.error === undefined ? null : h('div', { className: 'sks-error' }, format(t.failed, { message: state.error })),
        h(
          'div',
          { className: 'sks-list' },
          rows.length === 0
            ? h('div', { className: 'sks-empty' }, t.empty)
            : rows.map(function (row) {
                return h(SkillRow, {
                  key: row.name,
                  row: row,
                  t: t,
                  busy: state.busy,
                  canLoad: true,
                  loadedName: state.loadedName,
                  onToggle: function (target, next) { controller.toggle(target, next, layer); },
                  onLoad: function (target) { controller.load(target); },
                });
              }),
        ),
      );
    }

    /**
     * Build the controller shared by every surface. One controller per plugin
     * instance keeps a single fetch cache and one open panel.
     * @returns {object} controller.
     */
    function createController() {
      var listeners = new Set();
      var snapshot = {
        layer: 'session',
        filter: '',
        busy: false,
        error: undefined,
        loadedName: undefined,
        data: undefined,
        open: false,
        sessionId: undefined,
        cwd: undefined,
        anchor: undefined,
      };
      var api = {
        getSnapshot: function () { return snapshot; },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
      };
      /**
       * Publish a new snapshot.
       * @param {object} patch - changed fields.
       */
      function set(patch) {
        snapshot = Object.assign({}, snapshot, patch);
        listeners.forEach(function (listener) { listener(); });
      }
      /**
       * Reload from the host and publish.
       * @returns {Promise<void>} completion.
       */
      async function refresh() {
        try {
          var data = await fetchState({ sessionId: snapshot.sessionId, cwd: snapshot.cwd });
          set({ data: data, error: undefined });
        } catch (error) {
          set({ error: String(error && error.message ? error.message : error) });
        }
      }
      return {
        store: api,
        /**
         * Select the session this panel speaks for.
         * @param {string|undefined} sessionId - live session id.
         * @param {string|undefined} cwd - working directory hint.
         */
        bind: function (sessionId, cwd) {
          if (snapshot.sessionId === sessionId && snapshot.cwd === cwd) return;
          set({ sessionId: sessionId, cwd: cwd, data: undefined });
          void refresh();
        },
        /**
         * Open the panel anchored to an element.
         * @param {Element|undefined} anchor - the pill button.
         */
        open: function (anchor) {
          set({ open: true, anchor: anchor });
          void refresh();
        },
        close: function () { set({ open: false }); },
        /**
         * Switch the edited layer.
         * @param {'global'|'workspace'|'session'} layer - layer name.
         */
        setLayer: function (layer) { set({ layer: layer }); },
        /**
         * Filter text.
         * @param {string} filter - query.
         */
        setFilter: function (filter) { set({ filter: filter }); },
        /**
         * Flip one switch in one layer.
         * @param {object} row - the skill row.
         * @param {boolean} next - desired state.
         * @param {'global'|'workspace'|'session'} layer - target layer.
         */
        toggle: async function (row, next, layer) {
          var data = snapshot.data;
          if (data === undefined) return;
          var key = layer === 'workspace' ? data.workspaceKey : layer === 'session' ? data.sessionId : undefined;
          if (layer !== 'global' && !key) {
            set({ error: 'workspace or session unknown' });
            return;
          }
          set({ busy: true, error: undefined });
          try {
            var payload = await post(API.set, {
              layer: layer,
              key: key,
              name: row.name,
              enabled: next,
              sessionId: snapshot.sessionId,
              cwd: snapshot.cwd,
            });
            set({ data: payload, busy: false });
          } catch (error) {
            set({ busy: false, error: String(error && error.message ? error.message : error) });
          }
        },
        /**
         * Drop every override in the active layer.
         */
        resetLayer: async function () {
          var data = snapshot.data;
          if (data === undefined) return;
          var layer = snapshot.layer;
          var key = layer === 'workspace' ? data.workspaceKey : layer === 'session' ? data.sessionId : undefined;
          set({ busy: true, error: undefined });
          try {
            var payload = await post(API.reset, {
              layer: layer,
              key: key,
              sessionId: snapshot.sessionId,
              cwd: snapshot.cwd,
            });
            set({ data: payload, busy: false });
          } catch (error) {
            set({ busy: false, error: String(error && error.message ? error.message : error) });
          }
        },
        /**
         * Queue one skill's body for the session's next step.
         * @param {object} row - the skill row.
         */
        load: async function (row) {
          if (!snapshot.sessionId) {
            set({ error: 'no live session' });
            return;
          }
          try {
            await post(API.load, { sessionId: snapshot.sessionId, name: row.name });
            set({ loadedName: row.name });
          } catch (error) {
            set({ error: String(error && error.message ? error.message : error) });
          }
        },
        refresh: refresh,
      };
    }

    /**
     * Subscribe a component to the controller store.
     * @param {object} store - the store face.
     * @returns {object} the current snapshot.
     */
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    }

    /**
     * Compact status pill in the session header's far-right corner
     * (`conversation.session.header.corner`).
     *
     * Reads as a quiet counter — "技能 62/62" — and opens the switch panel on
     * click. Kept in the header rather than above the composer because the
     * composer dock only renders once a session has an input state; a brand-new
     * session would leave the control invisible exactly when the user first
     * wants it.
     * @param {object} props - injected controller and locale.
     * @returns {object|null} React element.
     */
    function HeaderCornerPill(props) {
      var controller = props.controller;
      var state = useStore(controller.store);
      var t = props.t;
      var data = state.data;
      var counts = data === undefined ? undefined : data.counts;
      var off = counts === undefined ? 0 : counts.total - counts.enabled;
      var left;
      var top;
      var placement = 'up';
      if (state.open && state.anchor !== undefined && typeof state.anchor.getBoundingClientRect === 'function') {
        var rect = state.anchor.getBoundingClientRect();
        var width = Math.min(420, window.innerWidth - 24);
        left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
        // The dock sits above the composer, so the panel opens upward and
        // clamps to the viewport rather than running off the top of the screen.
        top = rect.top - 8;
        placement = 'up';
      }
      return h(
        'div',
        { className: 'sks-corner' },
        h(
          'button',
          {
            type: 'button',
            className: 'sks-cornerBtn',
            'data-open': state.open ? 'true' : 'false',
            title: counts === undefined
              ? t.title
              : format(t.pillTitle, { enabled: counts.enabled, total: counts.total }),
            onClick: function (event) {
              if (state.open) controller.close();
              else controller.open(event.currentTarget);
            },
          },
          h('span', { className: 'sks-cornerLabel' }, t.pillLabel),
          counts === undefined
            ? h('span', { className: 'sks-cornerCount' }, t.loading)
            : h('span', { className: 'sks-cornerCount' }, format(t.count, { enabled: counts.enabled, total: counts.total })),
          counts === undefined || off === 0
            ? null
            : h('span', { className: 'sks-cornerOff' }, format(t.hiddenCount, { n: off })),
        ),
        state.open && left !== undefined
          ? h(
              'div',
              {
                className: 'sks-panelWrap',
                'data-placement': placement,
                style: { left: left + 'px', top: top + 'px', transform: 'translateY(-100%)' },
              },
              h(SwitchPanel, { controller: controller, t: t }),
            )
          : null,
      );
    }

    /**
     * The settings page listing global defaults.
     * @param {object} props - injected controller and locale.
     * @returns {object} React element.
     */
    function SettingsSection(props) {
      var controller = props.controller;
      var state = useStore(controller.store);
      var t = props.t;
      var data = state.data;
      var rows = data === undefined
        ? []
        : data.skills.filter(function (row) {
            var query = state.filter.toLowerCase();
            if (query === '') return true;
            return (row.name + ' ' + (row.description || '')).toLowerCase().indexOf(query) !== -1;
          });
      return h(
        'div',
        { className: 'sks-section' },
        h(
          'div',
          { className: 'sks-sectionHead' },
          h('h2', { className: 'sks-sectionTitle' }, t.title),
          h('p', { className: 'sks-sectionIntro' }, t.intro),
        ),
        h(
          'div',
          { className: 'sks-sectionBar' },
          h('input', {
            className: 'sks-search',
            type: 'search',
            placeholder: t.filter,
            value: state.filter,
            onChange: function (event) { controller.setFilter(event.target.value); },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'sks-reset',
              title: t.globalHint,
              onClick: function () { controller.resetLayer(); },
            },
            t.reset,
          ),
        ),
        state.error === undefined ? null : h('div', { className: 'sks-error' }, format(t.failed, { message: state.error })),
        h(
          'div',
          { className: 'sks-sectionList' },
          rows.length === 0
            ? h('div', { className: 'sks-empty' }, data === undefined ? t.empty : t.empty)
            : rows.map(function (row) {
                return h(SkillRow, {
                  key: row.name,
                  row: row,
                  t: t,
                  busy: state.busy,
                  canLoad: false,
                  loadedName: undefined,
                  onToggle: function (target, next) { controller.toggle(target, next, 'global'); },
                  onLoad: function () {},
                });
              }),
        ),
      );
    }

    /**
     * Mount both surfaces.
     * @param {object} ctx - client root context (slots, locale).
     */
    function apply(ctx) {
      ensureStyle();
      var controller = createController();
      var disposeLocale = ctx.locale.register(NS, { zh: zh, en: en });
      var t = function (key, values) {
        return format(ctx.locale.bind(NS)(key) || key, values);
      };
      ctx.effect(function () { return disposeLocale; }, 'skill-scope: dictionaries');

      var disposers = [];

      // Session header, far-right corner: the session entrance.
      disposers.push(
        ctx.slots.inject('conversation.session.header.corner', function () {
          return ctx.slots.register(
            {
              name: 'conversation.session.header.corner',
              id: 'skill-scope-corner',
              locale: NS,
              inject: function (sessionId) {
                controller.bind(sessionId, undefined);
                return { controller: controller, t: t };
              },
            },
            HeaderCornerPill,
          );
        }),
      );

      // Settings page: global defaults.
      disposers.push(
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'skill-scope',
              order: 40,
              label: function () { return t('title'); },
              locale: NS,
              inject: function () {
                controller.bind(undefined, undefined);
                return { controller: controller, t: t };
              },
            },
            SettingsSection,
          );
        }),
      );

      ctx.effect(function () {
        return function () {
          for (var dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              /* slot owner already collapsed */
            }
          }
        };
      }, 'skill-scope: surfaces');
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
