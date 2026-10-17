/**
 * Integration test against the real @deepseek-ai/dsh-skill registry.
 *
 * The plugin's central claim — "a runtime registration in the agent's own
 * layer hides a provider skill from that agent only" — is an assumption about
 * the shipped registry, not about our code. A stub registry would happily
 * confirm a wrong design, so this test mounts the real Cordis + SkillRegistry
 * and asserts the observable outcome instead:
 *
 *   - the hidden skill leaves the model-invocable set for that agent,
 *   - every other agent still sees it,
 *   - loading it through the agent's own view reports `modelInvocable: false`
 *     (which is what the built-in `skill` tool refuses on),
 *   - disposing the shadow restores the provider's entry.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry, { isModelInvocable } from '@deepseek-ai/dsh-skill';
import { createScope } from '@deepseek-ai/dsh-scope';

/**
 * Boot a real registry with one filesystem-style provider.
 * @param {readonly string[]} names - skills the provider serves.
 * @returns {Promise<{ctx: object, dispose: () => Promise<void>}>} booted app.
 */
async function bootRegistry(names) {
  const app = new Context();
  const fiber = app.plugin(SkillRegistry);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ctx = fiber.ctx;
  ctx.skills.registerProvider(() => ({
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
  return { ctx, dispose: async () => { await app.fiber?.dispose?.(); } };
}

/**
 * Register the shadow the plugin registers for a hidden skill.
 * @param {object} scoped - the agent's scoped context.
 * @param {string} name - skill to hide.
 * @returns {() => void} disposer.
 */
function shadow(scoped, name) {
  return scoped.skills.register({
    name,
    description: `${name} description`,
    content: `real body of ${name}`,
    provider: 'skill-scope',
    source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: true },
  });
}

test('a scoped shadow hides one skill from one agent and nobody else', async () => {
  const { ctx } = await bootRegistry(['office', 'ppt-master']);
  const agentKey = { id: 'agent-A' };
  const scope = createScope(ctx, agentKey);

  const shadowed = shadow(scope.ctx, 'office');

  const forAgent = await scope.ctx.skills.list({ scope: agentKey });
  const visible = forAgent.filter(isModelInvocable).map((skill) => skill.name);
  assert.deepEqual(visible, ['ppt-master'], 'the hidden skill must leave the agent catalog');

  const globalVisible = (await ctx.skills.list({})).filter(isModelInvocable).map((skill) => skill.name);
  assert.deepEqual(globalVisible, ['office', 'ppt-master'], 'other scopes must keep the skill');

  // This flag is exactly what the built-in `skill` tool refuses on.
  const loaded = await scope.ctx.skills.get('office', { scope: agentKey });
  assert.equal(loaded.content, 'real body of office', 'the body stays loadable for a human gesture');
  assert.equal(isModelInvocable(loaded), false);

  // Lifting the shadow restores the provider entry on the very next read.
  shadowed();
  const restored = (await scope.ctx.skills.list({ scope: agentKey }))
    .filter(isModelInvocable)
    .map((skill) => skill.name);
  assert.deepEqual(restored, ['office', 'ppt-master']);
});

test('two agents can disagree about the same skill', async () => {
  const { ctx } = await bootRegistry(['office']);
  // Scope keys are compared by identity, so each scope keeps its own key object.
  const keyA = { id: 'A' };
  const keyB = { id: 'B' };
  const scopeA = createScope(ctx, keyA);
  const scopeB = createScope(ctx, keyB);
  const hideInA = shadow(scopeA.ctx, 'office');

  const a = (await scopeA.ctx.skills.list({ scope: keyA })).filter(isModelInvocable).map((s) => s.name);
  const b = (await scopeB.ctx.skills.list({ scope: keyB })).filter(isModelInvocable).map((s) => s.name);
  assert.deepEqual(a, [], 'agent A hid the skill');
  assert.deepEqual(b, ['office'], 'agent B never touched it');
  hideInA();
});
