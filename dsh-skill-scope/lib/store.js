/**
 * skill-scope — persistence for the layer switches.
 *
 * Written as one small JSON file under the DSH home rather than a storage
 * domain, because this plugin must keep working on hosts whose storage
 * facility is not mounted, and the payload (three small maps of booleans) has
 * none of the properties a domain would earn: no large records, no
 * cross-table reads, no migration surface worth a version ladder.
 *
 * Writes are serialized through one promise chain per path, so two panel
 * clicks cannot interleave two read-modify-write cycles and lose one.
 *
 * @module skill-scope/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { emptyState, normalizeState, writeOverride } from './shared.js';

/** Default file name inside the DSH home. */
const FILE_NAME = 'skill-scope.json';

/**
 * Resolve the store path.
 * @param {string} dshHome - harness configuration root.
 * @returns {string} absolute JSON path.
 */
export function storePath(dshHome) {
  return join(dshHome, FILE_NAME);
}

/**
 * One JSON-file store with a serialized write chain.
 */
export class ScopeStore {
  /**
   * @param {string} path - absolute JSON path.
   * @param {{warn?: (message: string) => void}} [options] - logging seam.
   */
  constructor(path, options = {}) {
    this.path = path;
    this.warn = options.warn ?? (() => {});
    this.chain = Promise.resolve();
  }

  /**
   * Read and normalize the current state. A missing or corrupt file reads as
   * the empty state — never as an error, because this runs on every step.
   * @returns {Promise<object>} the state.
   */
  async read() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`skill-scope: cannot read ${this.path}: ${String(error)}`);
      return emptyState();
    }
    try {
      return normalizeState(JSON.parse(text));
    } catch (error) {
      this.warn(`skill-scope: ignoring malformed ${this.path}: ${String(error)}`);
      return emptyState();
    }
  }

  /**
   * Apply one override on top of the freshest state and persist it.
   * @param {'global'|'workspace'|'session'} layer - layer name.
   * @param {string|undefined} key - workspace path or session id.
   * @param {string} name - skill name.
   * @param {boolean|null} enabled - override, or null to inherit.
   * @returns {Promise<object>} the committed state.
   */
  write(layer, key, name, enabled) {
    const next = this.chain.then(async () => {
      const current = await this.read();
      const committed = writeOverride(current, layer, key, name, enabled);
      await this.persist(committed);
      return committed;
    });
    // Keep the chain alive after a rejected write, or one disk error would
    // poison every later write.
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Replace several overrides in one commit (used by "reset this layer").
   * @param {Array<{layer: string, key?: string, name: string, enabled: boolean|null}>} entries - operations.
   * @returns {Promise<object>} the committed state.
   */
  writeMany(entries) {
    const next = this.chain.then(async () => {
      let state = await this.read();
      for (const entry of entries) state = writeOverride(state, entry.layer, entry.key, entry.name, entry.enabled);
      await this.persist(state);
      return state;
    });
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Atomically replace the file (write to a sibling, then rename).
   * @param {object} state - state to persist.
   * @returns {Promise<void>} completion.
   */
  async persist(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
  }
}
