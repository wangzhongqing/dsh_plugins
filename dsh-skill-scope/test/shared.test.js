/**
 * Unit tests for the pure switch model.
 *
 * These cover the part that decides what the model sees, so a regression here
 * is a regression in the product's only real behavior.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LAYER_LABELS,
  STATE_VERSION,
  countEnabled,
  emptyState,
  findProjectRoot,
  layerMap,
  normalizeState,
  resolveSkill,
  writeOverride,
} from '../lib/shared.js';

test('a fresh store leaves every skill enabled and blames no layer', () => {
  const state = emptyState();
  assert.deepEqual(resolveSkill(state, 'ppt-master'), { enabled: true, origin: 'default' });
});

test('the nearest layer wins over every ancestor', () => {
  let state = emptyState();
  state = writeOverride(state, 'global', undefined, 'office', false);
  state = writeOverride(state, 'workspace', '/repo', 'office', true);
  state = writeOverride(state, 'session', 'sess-1', 'office', false);

  const keys = { workspaceKey: '/repo', sessionId: 'sess-1' };
  assert.deepEqual(resolveSkill(state, 'office', keys), { enabled: false, origin: 'session' });

  // Same workspace, different session: the workspace override applies.
  assert.deepEqual(resolveSkill(state, 'office', { workspaceKey: '/repo', sessionId: 'sess-2' }), {
    enabled: true,
    origin: 'workspace',
  });

  // Another workspace: the global default applies.
  assert.deepEqual(resolveSkill(state, 'office', { workspaceKey: '/other', sessionId: 'sess-3' }), {
    enabled: false,
    origin: 'global',
  });
});

test('clearing an override falls back to inheritance', () => {
  let state = writeOverride(emptyState(), 'session', 'sess-1', 'office', false);
  assert.equal(resolveSkill(state, 'office', { sessionId: 'sess-1' }).enabled, false);
  state = writeOverride(state, 'session', 'sess-1', 'office', null);
  assert.deepEqual(resolveSkill(state, 'office', { sessionId: 'sess-1' }), { enabled: true, origin: 'default' });
});

test('clearing the last override drops the empty layer entry', () => {
  let state = writeOverride(emptyState(), 'workspace', '/repo', 'office', true);
  assert.deepEqual(Object.keys(state.workspaces), ['/repo']);
  state = writeOverride(state, 'workspace', '/repo', 'office', null);
  assert.deepEqual(Object.keys(state.workspaces), []);
});

test('writes never mutate the state they were given', () => {
  const before = emptyState();
  const after = writeOverride(before, 'global', undefined, 'office', false);
  assert.deepEqual(before.global, {});
  assert.deepEqual(after.global, { office: false });
  assert.notEqual(before, after);
});

test('a corrupt file reads as the empty state instead of throwing', () => {
  assert.deepEqual(normalizeState(undefined), emptyState());
  assert.deepEqual(normalizeState('nope'), emptyState());
  assert.deepEqual(normalizeState({ version: STATE_VERSION, global: null }), emptyState());
});

test('a future schema version is discarded rather than half-read', () => {
  const future = { version: STATE_VERSION + 1, global: { office: false } };
  assert.deepEqual(normalizeState(future), emptyState());
});

test('non-boolean and non-string entries are dropped', () => {
  const state = normalizeState({
    version: STATE_VERSION,
    global: { office: 'yes', '': true, keep: false },
    workspaces: { '/repo': { a: 1, b: true }, '': { c: true } },
  });
  assert.deepEqual(state.global, { keep: false });
  assert.deepEqual(state.workspaces, { '/repo': { b: true } });
});

test('an override in one layer is invisible to another key', () => {
  const state = writeOverride(emptyState(), 'workspace', '/repo-a', 'office', false);
  assert.deepEqual(layerMap(state, 'workspace', '/repo-b'), {});
  assert.equal(resolveSkill(state, 'office', { workspaceKey: '/repo-b' }).enabled, true);
});

test('countEnabled reports the visible half of the catalog', () => {
  let state = writeOverride(emptyState(), 'global', undefined, 'a', false);
  state = writeOverride(state, 'global', undefined, 'b', true);
  assert.deepEqual(countEnabled(state, ['a', 'b', 'c']), { enabled: 2, total: 3 });
});

test('project root is the nearest ancestor holding a marker', () => {
  const roots = new Set(['/repo', '/repo/.git', '/repo/pkg/deep/.git']);
  const exists = (path) => roots.has(path);
  assert.equal(findProjectRoot('/repo/pkg/src', exists), '/repo');
  assert.equal(findProjectRoot('/repo/pkg/deep/lib', exists), '/repo/pkg/deep');
});

test('a directory with no marker is its own workspace', () => {
  assert.equal(findProjectRoot('/Users/x/loose', () => false), '/Users/x/loose');
});

test('every layer has a human label', () => {
  assert.deepEqual(Object.keys(LAYER_LABELS), ['global', 'workspace', 'session']);
});
