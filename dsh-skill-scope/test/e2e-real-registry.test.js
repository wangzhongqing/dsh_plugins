/**
 * End-to-end host test: run the plugin's real `apply()` against the real
 * Cordis context and the real `@deepseek-ai/dsh-skill` registry.
 *
 * The stub tests prove the wiring; this one proves the effect. Three things
 * make it a real integration rather than a happy-path mock:
 *
 *   - the registry is the shipped implementation, so a change in how scope
 *     layers merge breaks this test;
 *   - the scope key is the **agent object**, exactly what the built-in
 *     `skill` tool passes (`{ scope: exec.agent }`). Keyed identity is the
 *     part easiest to get subtly wrong, so it is pinned here;
 *   - services are mounted as a real Cordis row (`provide` + `set`), which is
 *     how the host composition mounts them.
 *
 * If the shadow ever stops shadowing, this is the test that fails.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry, { isModelInvocable } from '@deepseek-ai/dsh-skill';
import { createScope } from '@deepseek-ai/dsh-scope';
import { apply } from '../lib/index.js';

/**
 * Boot the real registry, a provider serving the given skills, and stub
 * `agents` / `webServer` rows the plugin injects.
 * @param {readonly string[]} names - skill names the provider serves.
 * @returns {Promise<object>} harness with ctx, agents, routes and emit().
 */
async function boot(names) {
  const app = new Context();
  const registryFiber = app.plugin(SkillRegistry);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const host = registryFiber.ctx;

  host.skills.registerProvider(() => ({
    name: 'filesystem',
    async list() {
      return names.map((name) => ({
        name,
        description: `${name} description`,
        source: 'user-agents',
        invocation: { modelInvocable: true, userInvocable: true },
        rank: 500,
        provider: 'filesystem',
      }));
    },
    async get(candidate) {
      return {
        name: candidate.name,
        description: candidate.description,
        content: `real body of ${candidate.name}`,
        provider: 'filesystem',
        source: 'user-agents',
        invocation: { modelInvocable: true, userInvocable: true },
      };
    },
  }));

  const agents = [];
  const routes = new Map();
  const services = {
    agents: {
      get: (id) => agents.find((agent) => agent.session.id === id),
    },
    webServer: {
      register: (route) => {
        routes.set(route.path.split('/').pop(), route);
        return () => {};
      },
    },
  };
  // A real Cordis row: `ctx.provide()` publishes a service from this fiber.
  const serviceFiber = host.plugin({
    name: 'test-service-row',
    apply(inner) {
      for (const [serviceName, value] of Object.entries(services)) inner.provide(serviceName, value);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const ctx = serviceFiber.ctx;
  const events = new Map();
  const realOn = ctx.on.bind(ctx);
  ctx.on = (event, listener) => {
    const list = events.get(event) ?? [];
    list.push(listener);
    events.set(event, list);
    return realOn(event, listener);
  };

  return {
    ctx,
    agents,
    routes,
    /**
     * Drive one agent lifecycle event through the plugin's listeners.
     * @param {string} event - event name.
     * @param {object} payload - event payload.
     * @returns {Promise<void>} completion.
     */
    async emit(event, payload) {
      for (const listener of events.get(event) ?? []) {
        await listener(payload, async () => ({ kind: 'accept', messages: [] }));
      }
    },
  };
}

/**
 * Build a live agent whose scoped skills registry is the real one. The scope
 * key is the agent object itself, matching `{ scope: exec.agent }` in the
 * built-in skill tool.
 * @param {object} ctx - host context.
 * @param {string} cwd - working directory.
 * @param {string} [id] - session id.
 * @returns {object} agent facade.
 */
function makeAgent(ctx, cwd, id = 'sess-e2e') {
  const agent = {
    session: { id, header: { cwd } },
    injected: [],
    inject(message) {
      this.injected.push(message);
    },
  };
  agent.ctx = createScope(ctx, agent).ctx;
  return agent;
}

/**
 * Model-invocable names one agent can see — the same call the built-in
 * catalog makes before rendering `<available_skills>`.
 * @param {object} agent - agent facade.
 * @returns {Promise<string[]>} visible names.
 */
async function visibleFor(agent) {
  const listed = await agent.ctx.skills.list({ scope: agent });
  return listed.filter(isModelInvocable).map((skill) => skill.name);
}

/**
 * Drive one plugin route with a JSON body and return the parsed reply.
 * @param {object} route - route descriptor.
 * @param {object} payload - JSON payload.
 * @returns {Promise<{status: number, body: object|undefined}>} reply.
 */
async function callRoute(route, payload) {
  const body = JSON.stringify(payload);
  let text = '';
  const req = {
    method: 'POST',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(body);
    },
  };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk) {
      if (chunk !== undefined) text = String(chunk);
    },
  };
  await route.handler(req, res);
  return { status: res.statusCode, body: text === '' ? undefined : JSON.parse(text) };
}

/**
 * Run a test body inside a throwaway project directory with a `.git` marker.
 * @param {(dir: string) => Promise<void>} body - test body.
 * @returns {Promise<void>} completion.
 */
async function withProject(body) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-scope-e2e-'));
  try {
    mkdirSync(join(dir, '.git'), { recursive: true });
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('apply() hides a session-disabled skill through the real registry', async () => {
  await withProject(async (dir) => {
    const harness = await boot(['office', 'ppt-master']);
    apply(harness.ctx, { storePath: join(dir, 'state.json') });

    const agent = makeAgent(harness.ctx, join(dir, 'sub'));
    harness.agents.push(agent);
    await harness.emit('agent/created', { agent });
    assert.deepEqual(await visibleFor(agent), ['office', 'ppt-master']);

    const setRoute = harness.routes.get('set');
    assert.ok(setRoute, 'the set route must be registered');

    const off = await callRoute(setRoute, {
      layer: 'session',
      key: 'sess-e2e',
      name: 'office',
      enabled: false,
    });
    assert.equal(off.status, 200);
    assert.deepEqual(await visibleFor(agent), ['ppt-master'], 'the real catalog must lose the skill');

    // The body stays reachable for an explicit human gesture (the `/name`
    // route stays open because userInvocable is left true).
    const loaded = await agent.ctx.skills.get('office', { scope: agent });
    assert.equal(loaded.content, 'real body of office');
    assert.equal(isModelInvocable(loaded), false);

    // A second agent is untouched by the first agent's switch.
    const other = makeAgent(harness.ctx, join(dir, 'sub'), 'sess-other');
    harness.agents.push(other);
    await harness.emit('agent/created', { agent: other });
    assert.deepEqual(await visibleFor(other), ['office', 'ppt-master']);

    const on = await callRoute(setRoute, {
      layer: 'session',
      key: 'sess-e2e',
      name: 'office',
      enabled: true,
    });
    assert.equal(on.status, 200);
    assert.deepEqual(await visibleFor(agent), ['office', 'ppt-master'], 're-enabling restores the provider entry');
  });
});

test('a workspace-layer switch reaches a session opened in a subdirectory', async () => {
  await withProject(async (dir) => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    const harness = await boot(['office', 'ppt-master']);
    apply(harness.ctx, { storePath: join(dir, 'state.json') });

    const repoRoot = join(dir, 'repo');
    const agent = makeAgent(harness.ctx, join(repoRoot, 'src', 'deep'));
    harness.agents.push(agent);
    await harness.emit('agent/created', { agent });

    const reply = await callRoute(harness.routes.get('set'), {
      layer: 'workspace',
      key: repoRoot,
      name: 'office',
      enabled: false,
    });
    assert.equal(reply.status, 200);
    assert.deepEqual(await visibleFor(agent), ['ppt-master'], 'a nested cwd inherits the repository switch');

    const outside = makeAgent(harness.ctx, join(dir, 'elsewhere'), 'sess-outside');
    harness.agents.push(outside);
    await harness.emit('agent/created', { agent: outside });
    assert.deepEqual(await visibleFor(outside), ['office', 'ppt-master']);
  });
});

test('the panel payload explains which layer decided each row', async () => {
  await withProject(async (dir) => {
    const harness = await boot(['office', 'ppt-master']);
    apply(harness.ctx, { storePath: join(dir, 'state.json') });

    const reply = await callRoute(harness.routes.get('set'), {
      layer: 'global',
      name: 'office',
      enabled: false,
      cwd: join(dir, 'work'),
    });
    assert.equal(reply.status, 200);
    const office = reply.body.skills.find((row) => row.name === 'office');
    const deck = reply.body.skills.find((row) => row.name === 'ppt-master');
    assert.equal(office.enabled, false);
    assert.equal(office.origin, 'global');
    assert.equal(deck.enabled, true);
    assert.equal(deck.origin, 'default');
    assert.deepEqual(reply.body.counts, { enabled: 1, total: 2 });
  });
});

test('reset returns a layer to inheritance', async () => {
  await withProject(async (dir) => {
    const harness = await boot(['office']);
    apply(harness.ctx, { storePath: join(dir, 'state.json') });

    await callRoute(harness.routes.get('set'), { layer: 'global', name: 'office', enabled: false, cwd: dir });
    const reset = await callRoute(harness.routes.get('reset'), { layer: 'global', cwd: dir });
    assert.equal(reset.status, 200);
    const row = reset.body.skills.find((entry) => entry.name === 'office');
    assert.equal(row.enabled, true);
    assert.equal(row.origin, 'default');
  });
});
