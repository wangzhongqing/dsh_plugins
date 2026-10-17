/**
 * Host-half tests against a fake harness context.
 *
 * The behavior that matters is the shadow registration: a hidden skill must
 * be re-registered into the agent's own skill layer with
 * `modelInvocable: false`, and re-enabled skills must lift that shadow. These
 * tests drive the real `apply()` with a stub context, so the wiring — event
 * names, argument shapes, disposal — is covered too.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply, name, inject } from '../lib/index.js';

/**
 * A minimal cordis-like context that records what the plugin does.
 * @param {object} [options] - overrides.
 * @returns {object} fake context plus inspection helpers.
 */
function fakeContext(options = {}) {
  const listeners = new Map();
  const registered = [];
  const routes = [];
  const warnings = [];
  const catalog = options.catalog ?? [];
  const services = {
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
    agents: { get: (id) => options.agents?.[id] },
    workingDirectory: undefined,
  };
  return {
    logger: { warn: (message) => warnings.push(String(message)) },
    /** Optional-service read, exactly as cordis exposes it. */
    get: (serviceName) => services[serviceName],
    skills: {
      async list() {
        return catalog.map((skill) => ({
          name: skill.name,
          description: skill.description,
          provider: 'filesystem',
          source: 'user-agents',
          invocation: { modelInvocable: true, userInvocable: true },
          ...(skill.path === undefined ? {} : { path: skill.path }),
        }));
      },
      async get(skillName) {
        const found = catalog.find((skill) => skill.name === skillName);
        if (found === undefined) return undefined;
        return {
          name: found.name,
          description: found.description,
          content: found.content ?? `body of ${found.name}`,
          provider: 'filesystem',
          source: 'user-agents',
          invocation: { modelInvocable: true, userInvocable: true },
          ...(found.path === undefined ? {} : { path: found.path }),
        };
      },
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    effect: (callback) => callback(),
    emit: async (event, payload) => {
      for (const listener of listeners.get(event) ?? []) {
        await listener(payload, async () => ({ kind: 'accept', messages: [] }));
      }
    },
    inspect: {
      registered,
      routes,
      warnings,
      /** Swap the stub agents service (the plugin reads it through ctx.get). */
      setAgents: (implementation) => {
        services.agents = implementation;
      },
    },
  };
}

/**
 * Build a fake live agent whose scoped skills registry records shadows.
 * @param {object} [options] - session id and cwd.
 * @returns {object} the agent plus its registration log.
 */
function fakeAgent(options = {}) {
  const shadows = new Map();
  const agent = {
    session: { id: options.id ?? 'sess-1', header: { cwd: options.cwd ?? '/tmp/workspace' } },
    injected: [],
    inject(message) {
      this.injected.push(message);
    },
    ctx: {
      skills: {
        register(skill) {
          shadows.set(skill.name, skill);
          return () => shadows.delete(skill.name);
        },
      },
    },
  };
  return { agent, shadows };
}

test('the plugin declares its identity and dependency', () => {
  assert.equal(name, 'skill-scope');
  assert.deepEqual(inject, ['skills']);
});

test('a disabled skill is shadowed with modelInvocable false and keeps its body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-scope-host-'));
  try {
    const ctx = fakeContext({
      catalog: [{ name: 'office', description: 'Office documents' }, { name: 'ppt-master', description: 'Decks' }],
    });
    apply(ctx, { storePath: join(dir, 'state.json') });
    const { agent, shadows } = fakeAgent({ cwd: dir });

    await ctx.emit('agent/created', { agent });
    assert.equal(shadows.size, 0, 'nothing is hidden by default');

    // Persist a session-layer switch and let the pre-step sync pick it up.
    const route = ctx.inspect.routes.find((entry) => entry.path.endsWith('/set'));
    const body = JSON.stringify({ layer: 'session', key: 'sess-1', name: 'office', enabled: false });
    await route.handler(
      { method: 'POST', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(body); } },
      { statusCode: 0, setHeader() {}, end() {} },
    );
    await ctx.emit('agent/pre-step', { agent, signal: undefined });

    const shadow = shadows.get('office');
    assert.ok(shadow, 'the disabled skill must be registered into the agent layer');
    assert.deepEqual(shadow.invocation, { modelInvocable: false, userInvocable: true });
    assert.equal(shadow.content, 'body of office');
    assert.equal(shadow.description, 'Office documents');
    assert.equal(shadows.has('ppt-master'), false, 'enabled skills stay untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('re-enabling lifts the shadow so the provider entry wins again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-scope-host-'));
  try {
    const ctx = fakeContext({ catalog: [{ name: 'office', description: 'Office documents' }] });
    apply(ctx, { storePath: join(dir, 'state.json') });
    const { agent, shadows } = fakeAgent({ cwd: dir });
    await ctx.emit('agent/created', { agent });

    const setRoute = ctx.inspect.routes.find((entry) => entry.path.endsWith('/set'));
    const call = async (enabled) => {
      const body = JSON.stringify({ layer: 'session', key: 'sess-1', name: 'office', enabled });
      await setRoute.handler(
        { method: 'POST', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(body); } },
        { statusCode: 0, setHeader() {}, end() {} },
      );
    };

    await call(false);
    assert.equal(shadows.has('office'), true);
    await call(true);
    assert.equal(shadows.has('office'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the state payload reports the deciding layer for each skill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-scope-host-'));
  try {
    const ctx = fakeContext({
      catalog: [{ name: 'office', description: 'Office documents' }, { name: 'ppt-master', description: 'Decks' }],
    });
    apply(ctx, { storePath: join(dir, 'state.json') });
    const setRoute = ctx.inspect.routes.find((entry) => entry.path.endsWith('/set'));

    const body = JSON.stringify({ layer: 'global', name: 'office', enabled: false, cwd: dir });
    let payload;
    await setRoute.handler(
      { method: 'POST', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(body); } },
      { statusCode: 0, setHeader() {}, end(text) { payload = JSON.parse(text); } },
    );

    const office = payload.skills.find((row) => row.name === 'office');
    const deck = payload.skills.find((row) => row.name === 'ppt-master');
    assert.equal(office.enabled, false);
    assert.equal(office.origin, 'global');
    assert.equal(deck.enabled, true);
    assert.equal(deck.origin, 'default');
    assert.deepEqual(payload.counts, { enabled: 1, total: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-loopback callers are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-scope-host-'));
  try {
    const ctx = fakeContext({ catalog: [] });
    apply(ctx, { storePath: join(dir, 'state.json') });
    const route = ctx.inspect.routes.find((entry) => entry.path.endsWith('/state'));
    let status;
    await route.handler(
      { method: 'GET', url: '/', socket: { remoteAddress: '10.0.0.7' }, headers: {} },
      { statusCode: 0, setHeader() {}, end() { status = this.statusCode; } },
    );
    assert.equal(status, 403);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loading a skill injects its body into the live agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-scope-host-'));
  try {
    const ctx = fakeContext({ catalog: [{ name: 'office', description: 'Office documents' }] });
    apply(ctx, { storePath: join(dir, 'state.json') });
    const { agent } = fakeAgent({ cwd: dir, id: 'sess-live' });
    ctx.inspect.setAgents({ get: (id) => (id === 'sess-live' ? agent : undefined) });

    const loadRoute = ctx.inspect.routes.find((entry) => entry.path.endsWith('/load'));
    const body = JSON.stringify({ sessionId: 'sess-live', name: 'office' });
    let payload;
    await loadRoute.handler(
      { method: 'POST', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(body); } },
      { statusCode: 0, setHeader() {}, end(text) { payload = JSON.parse(text); } },
    );

    assert.equal(payload.ok, true);
    assert.equal(agent.injected.length, 1);
    const text = agent.injected[0].content[0].text;
    assert.match(text, /<skill_content name="office">/);
    assert.match(text, /body of office/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabled: the plugin installs no routes at all', async () => {
  const ctx = fakeContext({ catalog: [] });
  apply(ctx, { enabled: false });
  assert.equal(ctx.inspect.routes.length, 0);
});
