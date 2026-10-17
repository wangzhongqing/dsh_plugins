/**
 * Store tests: durability, serialization, and the "never throw at boot" rule.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ScopeStore } from '../lib/store.js';
import { resolveSkill } from '../lib/shared.js';

/**
 * Run one test body against a throwaway directory.
 * @param {(dir: string) => Promise<void>} body - test body.
 * @returns {Promise<void>} completion.
 */
async function withTempDir(body) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-scope-test-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a missing store file reads as the empty state', async () => {
  await withTempDir(async (dir) => {
    const store = new ScopeStore(join(dir, 'nested', 'skill-scope.json'));
    assert.deepEqual(await store.read(), {
      version: 1,
      global: {},
      workspaces: {},
      sessions: {},
    });
  });
});

test('a write round-trips through the file', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'skill-scope.json');
    const store = new ScopeStore(path);
    await store.write('session', 'sess-1', 'office', false);

    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(raw.sessions['sess-1'], { office: false });
    assert.equal(resolveSkill(await store.read(), 'office', { sessionId: 'sess-1' }).enabled, false);
  });
});

test('a malformed file reads as empty instead of throwing', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'skill-scope.json');
    await writeFile(path, '{ not json', 'utf8');
    const warnings = [];
    const store = new ScopeStore(path, { warn: (message) => warnings.push(message) });
    assert.deepEqual((await store.read()).global, {});
    assert.equal(warnings.length, 1);
  });
});

test('concurrent writes serialize instead of losing one', async () => {
  await withTempDir(async (dir) => {
    const store = new ScopeStore(join(dir, 'skill-scope.json'));
    await Promise.all([
      store.write('global', undefined, 'alpha', false),
      store.write('global', undefined, 'beta', false),
      store.write('global', undefined, 'gamma', true),
    ]);
    const state = await store.read();
    assert.deepEqual(state.global, { alpha: false, beta: false, gamma: true });
  });
});

test('one failed write does not poison the queue', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'skill-scope.json');
    const store = new ScopeStore(path);
    // A directory where the store expects a file makes the write fail.
    await rm(path, { force: true });
    const blocking = join(path);
    await writeFile(join(dir, 'placeholder'), '', 'utf8');
    const broken = new ScopeStore(join(dir, 'placeholder', 'x.json'));
    await assert.rejects(broken.write('global', undefined, 'alpha', false));
    // The same store still works afterwards.
    await store.write('global', undefined, 'beta', false);
    assert.deepEqual((await store.read()).global, { beta: false });
    await rm(blocking, { force: true });
  });
});

test('writeMany commits several overrides in one file write', async () => {
  await withTempDir(async (dir) => {
    const store = new ScopeStore(join(dir, 'skill-scope.json'));
    await store.writeMany([
      { layer: 'global', name: 'alpha', enabled: false },
      { layer: 'workspace', key: '/repo', name: 'beta', enabled: true },
    ]);
    const state = await store.read();
    assert.deepEqual(state.global, { alpha: false });
    assert.deepEqual(state.workspaces['/repo'], { beta: true });
  });
});
