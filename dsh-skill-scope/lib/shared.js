/**
 * skill-scope — pure state model, shared by the host half, the browser half,
 * and the unit tests.
 *
 * The model is three layers of per-skill switches that are resolved
 * nearest-last:
 *
 *   global  →  workspace  →  session
 *
 * Every layer stores an EXPLICIT override map (`{ [skillName]: boolean }`).
 * A layer that never mentioned a skill inherits from the layer below it; an
 * absent entry is not the same as `false`, so the panel can report which layer
 * actually made the decision instead of guessing.
 *
 * The default for a skill no layer mentions is ON, so installing the plugin
 * changes nothing until a switch is flipped.
 *
 * @module skill-scope/shared
 */

/** Layer order, coarsest first. Resolution walks it in reverse. */
export const LAYERS = Object.freeze(['global', 'workspace', 'session']);

/** Stored schema version. Bumping it discards unknown future files safely. */
export const STATE_VERSION = 1;

/** Human-facing layer labels, used by routes and the panel alike. */
export const LAYER_LABELS = Object.freeze({
  global: '全局',
  workspace: '工作区',
  session: '会话',
});

/**
 * A brand-new store: no overrides anywhere, so every skill is ON.
 * @returns {object} empty state.
 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    global: {},
    workspaces: {},
    sessions: {},
  };
}

/** @param {unknown} value @returns {boolean} whether value is a plain object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce an arbitrary parsed file into the current shape.
 *
 * A corrupt or future-versioned file must never take the harness down: the
 * worst acceptable outcome is losing the overrides, never a throw at boot.
 * @param {unknown} raw - parsed JSON (or anything).
 * @returns {object} a valid state object.
 */
export function normalizeState(raw) {
  const state = emptyState();
  if (!isRecord(raw)) return state;
  if (raw.version !== undefined && raw.version !== STATE_VERSION) return state;
  state.global = normalizeMap(raw.global);
  if (isRecord(raw.workspaces)) {
    for (const [key, map] of Object.entries(raw.workspaces)) {
      if (typeof key !== 'string' || key === '') continue;
      const normalized = normalizeMap(map);
      if (Object.keys(normalized).length > 0) state.workspaces[key] = normalized;
    }
  }
  if (isRecord(raw.sessions)) {
    for (const [key, map] of Object.entries(raw.sessions)) {
      if (typeof key !== 'string' || key === '') continue;
      const normalized = normalizeMap(map);
      if (Object.keys(normalized).length > 0) state.sessions[key] = normalized;
    }
  }
  return state;
}

/**
 * Keep only `string → boolean` pairs.
 * @param {unknown} value - candidate map.
 * @returns {Record<string, boolean>} filtered copy.
 */
function normalizeMap(value) {
  const map = {};
  if (!isRecord(value)) return map;
  for (const [name, enabled] of Object.entries(value)) {
    if (typeof name !== 'string' || name === '') continue;
    if (typeof enabled !== 'boolean') continue;
    map[name] = enabled;
  }
  return map;
}

/**
 * Read one layer's override map without creating it.
 * @param {object} state - store state.
 * @param {'global'|'workspace'|'session'} layer - layer name.
 * @param {string} [key] - workspace path or session id; ignored for `global`.
 * @returns {Record<string, boolean>} the map, or an empty object.
 */
export function layerMap(state, layer, key) {
  if (layer === 'global') return state.global ?? {};
  if (layer === 'workspace') return (key !== undefined && state.workspaces?.[key]) || {};
  if (layer === 'session') return (key !== undefined && state.sessions?.[key]) || {};
  return {};
}

/**
 * One skill's explicit value in one layer.
 * @param {object} state - store state.
 * @param {'global'|'workspace'|'session'} layer - layer name.
 * @param {string} [key] - workspace path or session id.
 * @param {string} name - skill name.
 * @returns {boolean|undefined} the override, or undefined when uninvolved.
 */
export function readOverride(state, layer, key, name) {
  const map = layerMap(state, layer, key);
  return Object.hasOwn(map, name) ? map[name] : undefined;
}

/**
 * Resolve the effective switch for one skill.
 *
 * Session beats workspace beats global; the first layer carrying an explicit
 * value wins, otherwise the skill is ON by default.
 * @param {object} state - store state.
 * @param {string} name - skill name.
 * @param {{workspaceKey?: string, sessionId?: string}} [keys] - resolution keys.
 * @returns {{enabled: boolean, origin: 'global'|'workspace'|'session'|'default'}} the decision.
 */
export function resolveSkill(state, name, keys = {}) {
  const sessionId = keys.sessionId;
  const workspaceKey = keys.workspaceKey;
  const sessionValue = sessionId === undefined ? undefined : readOverride(state, 'session', sessionId, name);
  if (sessionValue !== undefined) return { enabled: sessionValue, origin: 'session' };
  const workspaceValue = workspaceKey === undefined ? undefined : readOverride(state, 'workspace', workspaceKey, name);
  if (workspaceValue !== undefined) return { enabled: workspaceValue, origin: 'workspace' };
  const globalValue = readOverride(state, 'global', undefined, name);
  if (globalValue !== undefined) return { enabled: globalValue, origin: 'global' };
  return { enabled: true, origin: 'default' };
}

/**
 * Copy a state object deeply enough for a write (maps are the only nesting).
 * @param {object} state - state to copy.
 * @returns {object} an independent copy.
 */
function cloneState(state) {
  return {
    version: STATE_VERSION,
    global: { ...state.global },
    workspaces: Object.fromEntries(
      Object.entries(state.workspaces ?? {}).map(([key, map]) => [key, { ...map }]),
    ),
    sessions: Object.fromEntries(
      Object.entries(state.sessions ?? {}).map(([key, map]) => [key, { ...map }]),
    ),
  };
}

/**
 * The map object a write targets, created on demand.
 * @param {object} state - state being mutated (already a clone).
 * @param {'global'|'workspace'|'session'} layer - layer name.
 * @param {string} [key] - workspace path or session id.
 * @returns {Record<string, boolean>} the live map.
 */
function targetMap(state, layer, key) {
  if (layer === 'global') return state.global;
  if (layer === 'workspace') {
    if (key === undefined) throw new Error('skill-scope: workspace layer requires a key');
    state.workspaces[key] ??= {};
    return state.workspaces[key];
  }
  if (layer === 'session') {
    if (key === undefined) throw new Error('skill-scope: session layer requires a key');
    state.sessions[key] ??= {};
    return state.sessions[key];
  }
  throw new Error(`skill-scope: unknown layer "${layer}"`);
}

/**
 * Set or clear one override, returning a new state (never mutates the input).
 *
 * `enabled === null` clears the override so the layer falls back to inheritance.
 * Empty layer maps are dropped, which keeps a deleted session from leaving a
 * permanent `{}` entry behind.
 * @param {object} state - current state.
 * @param {'global'|'workspace'|'session'} layer - layer name.
 * @param {string|undefined} key - workspace path or session id.
 * @param {string} name - skill name.
 * @param {boolean|null} enabled - true/false to override, null to inherit.
 * @returns {object} the new state.
 */
export function writeOverride(state, layer, key, name, enabled) {
  if (!LAYERS.includes(layer)) throw new Error(`skill-scope: unknown layer "${layer}"`);
  if (typeof name !== 'string' || name === '') throw new Error('skill-scope: skill name is required');
  const next = cloneState(normalizeState(state));
  const map = targetMap(next, layer, key);
  if (enabled === null) delete map[name];
  else if (typeof enabled === 'boolean') map[name] = enabled;
  else throw new Error('skill-scope: enabled must be true, false, or null');
  if (layer === 'workspace' && key !== undefined && Object.keys(next.workspaces[key] ?? {}).length === 0) {
    delete next.workspaces[key];
  }
  if (layer === 'session' && key !== undefined && Object.keys(next.sessions[key] ?? {}).length === 0) {
    delete next.sessions[key];
  }
  return next;
}

/**
 * Count switched-on skills over a known catalog.
 * @param {object} state - store state.
 * @param {readonly string[]} names - skill names in the catalog.
 * @param {{workspaceKey?: string, sessionId?: string}} [keys] - resolution keys.
 * @returns {{enabled: number, total: number}} the counts.
 */
export function countEnabled(state, names, keys = {}) {
  let enabled = 0;
  for (const name of names) if (resolveSkill(state, name, keys).enabled) enabled += 1;
  return { enabled, total: names.length };
}

/**
 * Nearest ancestor containing a project marker (`.git` by default).
 *
 * Mirrors the host's own project-root rule, so a session opened in a
 * subdirectory shares its workspace switches with the repository root.
 * @param {string} cwd - starting directory.
 * @param {(path: string) => boolean} exists - marker probe.
 * @param {readonly string[]} [markers] - directory names marking a root.
 * @returns {string} the project root, or `cwd` when no marker is found.
 */
export function findProjectRoot(cwd, exists, markers = ['.git']) {
  let dir = cwd;
  for (;;) {
    for (const marker of markers) {
      if (exists(`${dir}/${marker}`)) return dir;
    }
    const parent = dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
    if (parent === dir || parent === '') return cwd;
    dir = parent;
  }
}
