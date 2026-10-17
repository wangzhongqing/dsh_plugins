/**
 * Packaging tests: the two contracts a host-visible plugin can silently break.
 *
 * 1. The browser half must load as a CLASSIC script — the web boot fetches it
 *    through a combo URL and one ESM token (`import`/`export` at top level)
 *    makes the whole combo fail with no useful error. Evaluating it in a bare
 *    vm context with only `window.__ModuleLoader__` proves the shape.
 * 2. The manifests must agree on the package name, the client entry, and the
 *    loader row id, or the row resolves to nothing at boot.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read a file from the package root.
 * @param {string} relative - path inside the package.
 * @returns {string} file contents.
 */
function read(relative) {
  return readFileSync(join(root, relative), 'utf8');
}

/**
 * Evaluate the client bundle the way the host does and return the captured
 * module definition.
 * @returns {object} `{ id, factory }`.
 */
function loadClientDefinition() {
  let captured;
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
    console,
  };
  vm.createContext(sandbox);
  new vm.Script(read('lib/client.js')).runInContext(sandbox);
  assert.ok(captured, 'the client must register through window.__ModuleLoader__.load');
  return captured;
}

test('the client half loads as a classic script and exports apply + inject', () => {
  const definition = loadClientDefinition();
  assert.equal(definition.id, '@zhongqing/dsh-skill-scope');
  const reactStub = { createElement: () => ({}), useSyncExternalStore: () => ({}) };
  const exports = definition.factory((name) => (name === 'react' ? reactStub : {}));
  assert.equal(typeof exports.apply, 'function');
  // The bundle runs in its own vm realm, so compare through a plain copy.
  assert.deepEqual([...exports.inject], ['slots', 'locale']);
});

test('the client half contains no top-level ESM token', () => {
  const source = read('lib/client.js');
  for (const line of source.split('\n')) {
    assert.doesNotMatch(line, /^\s*import\s/, `top-level import found: ${line}`);
    assert.doesNotMatch(line, /^\s*export\s/, `top-level export found: ${line}`);
  }
});

test('package.json points every entry at a real file', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@zhongqing/dsh-skill-scope');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  for (const file of pkg.files) {
    // A packaged entry may be a directory (`lib`), so probe existence instead
    // of reading it.
    assert.ok(existsSync(join(root, file)), `missing packaged entry: ${file}`);
  }
});

test('the bundle patch and the naming manifest agree on the loader row', () => {
  const patch = read('cordis.patch.yml');
  const naming = JSON.parse(read('dsh-plugin.naming.json'));
  const rowId = naming.names.loaderIds[0];
  assert.match(patch, new RegExp(`id: ${rowId}`));
  assert.match(patch, /@zhongqing\/dsh-skill-scope/);
  assert.equal(naming.plugin.packageName, '@zhongqing/dsh-skill-scope');
});

test('every declared route appears in the host half', () => {
  const naming = JSON.parse(read('dsh-plugin.naming.json'));
  const source = read('lib/index.js');
  for (const route of naming.names.routes) {
    assert.ok(source.includes(route.path), `route missing from host half: ${route.path}`);
  }
});

test('the host half declares only services it actually injects', () => {
  const source = read('lib/index.js');
  // `skills` is injected; everything else must be read through ctx.get() so the
  // plugin stays active in profiles that lack it.
  assert.match(source, /export const inject = \['skills'\]/);
  assert.doesNotMatch(source, /ctx\.webServer\./, 'webServer must be read via ctx.get');
  assert.doesNotMatch(source, /ctx\.agents\./, 'agents must be read via ctx.get');
  assert.doesNotMatch(source, /ctx\.workingDirectory\./, 'workingDirectory must be read via ctx.get');
});
