/**
 * skill-scope — host half.
 *
 * ## The problem this solves
 *
 * Every skill under a discovered root is advertised to the model in every
 * session, so a deck-writing workflow and a code-repository workflow see the
 * same catalog. The shipped levers are both wrong for this: the skill center
 * rewrites `disable-model-invocation` in `SKILL.md` (a permanent, global edit
 * that follows you into every other workspace), and agent presets swap the
 * whole composition (far too coarse for "not this one, today").
 *
 * ## How the filter works
 *
 * The skill registry is layered host+per-scope, and the *nearest* layer wins a
 * duplicate name. A registration made through `agent.ctx.skills.register()`
 * files into that agent's own layer, which is nearer than every provider layer
 * — so a same-name runtime entry replaces the real skill **for that agent
 * only**, with no file writes and no effect on any other session.
 *
 * A disabled skill is therefore re-registered as a stub carrying the real
 * description and body, but with `modelInvocable: false`:
 *
 *   - the built-in catalog filters on `isModelInvocable`, so the skill leaves
 *     `<available_skills>` for this session (and the built-in republishes the
 *     replacement catalog automatically, because the digest changed);
 *   - the built-in `skill` tool refuses to load it ("not available for model
 *     invocation"), so the name cannot be used even from memory;
 *   - `userInvocable` stays true, so an explicit `/name` gesture and the `/`
 *     menu still reach it — turning a switch off hides the skill from the
 *     model, it does not lock the human out.
 *
 * Nothing is copied, moved, or rewritten on disk. Removing the stub restores
 * the provider's entry, which reappears in the catalog on the next step.
 *
 * ## Layers
 *
 * `global` → `workspace` → `session`, nearest last. A layer only stores skills
 * it explicitly touched; everything else inherits. Default is ON.
 *
 * @module skill-scope
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { ScopeStore, storePath } from './store.js';
import {
  LAYER_LABELS,
  countEnabled,
  emptyState,
  findProjectRoot,
  layerMap,
  resolveSkill,
} from './shared.js';

/** Stable cordis plugin name. */
export const name = 'skill-scope';

/**
 * Read an OPTIONAL service without declaring it in `inject`.
 *
 * Cordis throws on a plain property read for a service the plugin did not
 * declare (`cannot get property "x" without inject`), and declaring it would
 * make the plugin inactive in profiles that lack it. `ctx.get(name, false)`
 * is the documented optional read: it returns the current implementation, or
 * undefined.
 * @param {object} ctx - host context.
 * @param {string} serviceName - service key.
 * @returns {object|undefined} the service.
 */
function optional(ctx, serviceName) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(serviceName, false) ?? undefined;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Services required before the switches can be enforced. */
export const inject = ['skills'];

const Config = z.object({
  /** Master switch; false unloads the enforcement while keeping the stored state. */
  enabled: z.boolean().default(true),
  /** Store file override; empty means `<dshHome>/skill-scope.json`. */
  storePath: z.string().default(''),
  /** Directory names that mark a workspace root. */
  projectRootMarkers: z.array(z.string()).default(['.git']),
});

/** Marker used by the injected message so the UI can recognize its own rows. */
const LOAD_SOURCE_KIND = 'skill-invocation';

/**
 * Build the model-facing `<skill_content>` block. Mirrors the shared renderer
 * in `@deepseek-ai/dsh-skill` so a manually loaded skill looks identical to
 * one loaded through the tool.
 * @param {{name: string, content: string, provider?: string, resourceBase?: object}} skill - loaded skill.
 * @returns {string} the block.
 */
function renderSkillContent(skill) {
  const base = skill.resourceBase;
  const hint = base === undefined
    ? [`Resources for this skill are managed by provider "${skill.provider ?? 'unknown'}".`, 'Load referenced resources only as needed.']
    : base.kind === 'directory'
      ? [`Base directory for this skill: ${base.path}`, 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.']
      : base.kind === 'url'
        ? [`Base URL for this skill: ${base.url}`, 'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.']
        : [`Resources for this skill: ${base.description}`, 'Load referenced resources only as needed.'];
  const attr = String(skill.name).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return [
    `<skill_content name="${attr}">`,
    '<skill_resources>',
    ...hint,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n');
}

/**
 * Build one frozen user-role message carrying a skill body.
 * @param {{name: string}} skill - skill identity.
 * @param {string} text - rendered block.
 * @returns {object} message accepted by `agent.inject()`.
 */
function skillMessage(skill, text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: LOAD_SOURCE_KIND, name: skill.name, form: 'instructions' }),
  });
}

/**
 * Register the switches, the routes, and the enforcement.
 * @param {object} ctx - host context (skills, webServer, agents, logger).
 * @param {object} [config] - plugin config.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const markers = Array.isArray(config.projectRootMarkers) && config.projectRootMarkers.length > 0
    ? config.projectRootMarkers
    : ['.git'];
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const file = typeof config.storePath === 'string' && config.storePath !== ''
    ? config.storePath
    : storePath(dshHome);
  const store = new ScopeStore(file, { warn: (message) => ctx.logger?.warn?.(message) });

  /** In-memory mirror of the store; invalidated by our own writes. */
  let state = emptyState();
  let stateLoaded = false;
  /** Live agents: agent → true. Kept so a switch change can push to every session. */
  const live = new Map();
  /** Per-agent shadow entries: agent → Map<skillName, {dispose}>. */
  const appliedStubs = new Map();

  /**
   * Current state, reading the file at most once per invalidation.
   * @returns {Promise<object>} the state.
   */
  const getState = async () => {
    if (!stateLoaded) {
      state = await store.read();
      stateLoaded = true;
    }
    return state;
  };

  /**
   * Commit one override and push the change into every live agent.
   * @param {'global'|'workspace'|'session'} layer - layer name.
   * @param {string|undefined} key - workspace path or session id.
   * @param {string} name - skill name.
   * @param {boolean|null} enabled - override, or null to inherit.
   * @returns {Promise<object>} the committed state.
   */
  const commit = async (layer, key, name, enabled) => {
    const next = await store.write(layer, key, name, enabled);
    state = next;
    stateLoaded = true;
    await resyncAll();
    return next;
  };

  /**
   * Resolve the workspace key for one agent.
   * @param {object} agent - live agent.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string|undefined>} project root, or undefined when unknown.
   */
  const workspaceKeyOf = async (agent, signal) => {
    let cwd = agent?.session?.header?.cwd;
    try {
      const workingDirectory = optional(ctx, 'workingDirectory');
      if (workingDirectory !== undefined) cwd = await workingDirectory.ensure(agent, signal);
    } catch {
      /* fall back to the header cwd */
    }
    if (typeof cwd !== 'string' || cwd === '') return undefined;
    return findProjectRoot(cwd, (path) => existsSync(path), markers);
  };

  /**
   * Names this agent should currently hide from the model.
   * @param {object} agent - live agent.
   * @param {object} current - state.
   * @param {string|undefined} workspaceKey - resolved workspace key.
   * @returns {string[]} disabled skill names.
   */
  const disabledNames = (agent, current, workspaceKey) => {
    const sessionId = agent?.session?.id;
    const keys = { workspaceKey, sessionId };
    const names = new Set();
    for (const layer of ['global', 'workspace', 'session']) {
      const map = layerMap(current, layer, layer === 'global' ? undefined : layer === 'workspace' ? workspaceKey : sessionId);
      for (const skillName of Object.keys(map)) if (resolveSkill(current, skillName, keys).enabled === false) names.add(skillName);
    }
    return [...names];
  };

  /**
   * Bring one agent's stub set in line with the switches: register a stub for
   * every disabled skill, drop the stub for every enabled one.
   * @param {object} agent - live agent.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<void>} completion.
   */
  const reconcile = async (agent, signal) => {
    const scoped = agent?.ctx?.skills;
    if (scoped === undefined || typeof scoped.register !== 'function') return;
    const current = await getState();
    const workspaceKey = await workspaceKeyOf(agent, signal);
    const desired = new Set(disabledNames(agent, current, workspaceKey));
    const applied = appliedStubs.get(agent) ?? new Map();
    appliedStubs.set(agent, applied);

    // Lift stubs whose skill is enabled again.
    for (const [skillName, entry] of [...applied]) {
      if (desired.has(skillName)) continue;
      try {
        entry.dispose();
      } catch {
        /* a disposed scope already owns teardown */
      }
      applied.delete(skillName);
    }

    // Shadow the rest.
    for (const skillName of desired) {
      if (applied.has(skillName)) continue;
      let real;
      try {
        real = await ctx.skills.get(skillName, { scope: agent, signal });
      } catch (error) {
        ctx.logger?.warn?.(`skill-scope: cannot read skill "${skillName}": ${String(error)}`);
        continue;
      }
      if (real === undefined) continue;
      try {
        const dispose = scoped.register({
          name: skillName,
          description: real.description,
          ...(real.whenToUse === undefined ? {} : { whenToUse: real.whenToUse }),
          content: real.content,
          ...(real.resourceBase === undefined ? {} : { resourceBase: real.resourceBase }),
          ...(real.path === undefined ? {} : { path: real.path }),
          provider: 'skill-scope',
          source: 'runtime',
          invocation: { modelInvocable: false, userInvocable: true },
        });
        applied.set(skillName, { dispose });
      } catch (error) {
        ctx.logger?.warn?.(`skill-scope: cannot shadow skill "${skillName}": ${String(error)}`);
      }
    }
  };

  /** Per-agent applied stubs. */

  /** Re-reconcile every live agent (after a switch changes). */
  const resyncAll = async () => {
    for (const agent of live.keys()) {
      try {
        await reconcile(agent);
      } catch (error) {
        ctx.logger?.warn?.(`skill-scope: resync failed: ${String(error)}`);
      }
    }
  };

  // Awaited, not fire-and-forget: `agent/created` is dispatched through
  // `ctx.serial`, so returning the promise holds the creation announcement
  // until the shadows are registered. That closes the race where the agent's
  // first request could see an unfiltered catalog, instead of relying on the
  // pre-step hook to win a waterfall ordering contest.
  ctx.on('agent/created', async ({ agent }) => {
    live.set(agent, true);
    try {
      await reconcile(agent);
    } catch (error) {
      ctx.logger?.warn?.(`skill-scope: initial sync failed: ${String(error)}`);
    }
  });
  ctx.on('agent/disposed', ({ agent }) => {
    const applied = appliedStubs.get(agent);
    if (applied !== undefined) for (const entry of applied.values()) {
      try {
        entry.dispose();
      } catch {
        /* scope teardown already ran */
      }
    }
    appliedStubs.delete(agent);
    live.delete(agent);
  });

  // The pre-step sync makes the filter correct even when a signal is missed
  // (a workspace switch, a state file edited on disk while the process runs).
  // Work before `await next()` so the catalog listener — wherever it sits in
  // the chain — observes the new stub set.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      state = await store.read();
      stateLoaded = true;
      await reconcile(agent, signal);
    } catch (error) {
      ctx.logger?.warn?.(`skill-scope: pre-step sync failed: ${String(error)}`);
    }
    return next();
  });

  /**
   * Find a live agent to borrow a catalog scope from when no session was named.
   *
   * Prefers an agent whose working directory is the queried one, then any live
   * agent. Returns undefined when nothing is live, which leaves the caller with
   * the host-plane catalog.
   * @param {string} cwd - working directory the caller asked about.
   * @param {object} agents - the agents service, when mounted.
   * @returns {Promise<object|undefined>} a live agent usable as a scope.
   */
  const anyLiveAgentFor = async (cwd, agents) => {
    let all = [];
    try {
      all = typeof agents?.list === 'function' ? agents.list() : [];
    } catch {
      return undefined;
    }
    if (!Array.isArray(all) || all.length === 0) return undefined;
    let best;
    for (const candidate of all) {
      if (candidate?.ctx === undefined) continue;
      best ??= candidate;
      let candidateCwd = candidate?.session?.header?.cwd;
      try {
        const workingDirectory = optional(ctx, 'workingDirectory');
        if (workingDirectory !== undefined) candidateCwd = await workingDirectory.ensure(candidate);
      } catch {
        /* keep the header cwd */
      }
      if (candidateCwd === cwd) return candidate;
    }
    return best;
  };

  /**
   * Build the panel payload for one session: every skill the model could see,
   * its resolved switch, and which layer decided it.
   * @param {{sessionId?: string, cwd?: string}} query - resolution inputs.
   * @returns {Promise<object>} the payload.
   */
  const describe = async (query) => {
    const current = await getState();
    const agents = optional(ctx, 'agents');
    const agent = query.sessionId === undefined ? undefined : agents?.get?.(query.sessionId);
    let cwd = query.cwd ?? agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd === '') cwd = process.cwd();
    const workspaceKey = findProjectRoot(cwd, (path) => existsSync(path), markers);
    const sessionId = query.sessionId;
    // The catalog is per-scope, not global: presets mount their own
    // `skill-filesystem` row, so every user skill lives in that preset's layer
    // and a scope-less read sees only the host-plane runtime skills (the
    // univer-office family). With no live session to borrow a scope from, walk
    // the live agents and use the first one whose working directory matches —
    // that is the most representative catalog this host can offer.
    let scope = agent;
    if (scope === undefined) scope = await anyLiveAgentFor(cwd, agents);
    const skills = await ctx.skills.list({
      cwd,
      ...(scope === undefined ? {} : { scope }),
    });
    const keys = { workspaceKey, sessionId };
    const rows = skills.map((skill) => {
      const decision = resolveSkill(current, skill.name, keys);
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        ...(skill.path === undefined ? {} : { path: skill.path }),
        enabled: decision.enabled,
        origin: decision.origin,
        originLabel: decision.origin === 'default' ? '默认' : LAYER_LABELS[decision.origin],
        // A skill without an instruction file is registered by a plugin at
        // runtime, not installed by the user. Those belong to whichever plugin
        // owns them (univer-office routes through `office`), so hiding one could
        // break that plugin's own behavior. They stay listed and visible but
        // cannot be switched off.
        switchable: typeof skill.path === 'string' && skill.path !== '',
        source: typeof skill.path === 'string' && skill.path !== '' ? 'installed' : 'plugin',
        layers: {
          global: layerMap(current, 'global', undefined)[skill.name],
          workspace: layerMap(current, 'workspace', workspaceKey)[skill.name],
          session: layerMap(current, 'session', sessionId)[skill.name],
        },
      };
    });
    // Count only what the user controls; including plugin-owned skills would
    // report a total that can never change.
    const counts = countEnabled(
      current,
      rows.filter((row) => row.switchable).map((row) => row.name),
      keys,
    );
    const visible = rows.filter((row) => row.enabled).length;
    return {
      cwd,
      workspaceKey,
      sessionId: sessionId ?? null,
      counts,
      visible,
      layers: LAYER_LABELS,
      skills: rows,
    };
  };

  // ── HTTP routes ────────────────────────────────────────────────────────────
  // `webServer` is read lazily, inside `ctx.inject`. A plain `ctx.get()` at
  // apply() time runs before the host's webserver row is mounted, so it would
  // return undefined and silently register nothing — the panel then loads with
  // no data while the browser half looks perfectly fine.
  ctx.inject(['webServer'], (routeCtx) => {
    const webServer = optional(routeCtx, 'webServer') ?? routeCtx.webServer;
    if (webServer === undefined) return;
    const json = (res, status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    };
    const readBody = async (req) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) return undefined;
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return {};
      try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
      } catch {
        return undefined;
      }
    };
    const guard = (req, res, method) => {
      if (req.method !== method) {
        json(res, 405, { error: `method not allowed: ${req.method}` });
        return false;
      }
      // Same fence as the other local servers in this family: the socket must
      // be loopback, and a browser must be same-origin.
      const remote = req.socket?.remoteAddress ?? '';
      const loopback = remote === '::1' || remote === '::ffff:127.0.0.1' || /^127\./.test(remote);
      if (!loopback) {
        json(res, 403, { error: 'forbidden: loopback-only' });
        return false;
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        json(res, 403, { error: 'forbidden: cross-site' });
        return false;
      }
      return true;
    };
    const routes = [
      {
        kind: 'exact',
        path: '/api/plugins/zhongqing-skill-scope/state',
        handler: async (req, res) => {
          if (!guard(req, res, 'GET')) return;
          try {
            const url = new URL(req.url ?? '/', 'http://x');
            const sessionId = url.searchParams.get('sessionId') ?? undefined;
            const cwd = url.searchParams.get('cwd') ?? undefined;
            json(res, 200, await describe({ sessionId, cwd }));
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/plugins/zhongqing-skill-scope/set',
        handler: async (req, res) => {
          if (!guard(req, res, 'POST')) return;
          const body = await readBody(req);
          if (body === undefined) {
            json(res, 400, { error: 'invalid JSON body' });
            return;
          }
          const { layer, key, name: skillName, enabled } = body;
          if (!['global', 'workspace', 'session'].includes(layer)) {
            json(res, 400, { error: 'layer must be global, workspace, or session' });
            return;
          }
          if (typeof skillName !== 'string' || skillName === '') {
            json(res, 400, { error: 'name is required' });
            return;
          }
          if (enabled !== true && enabled !== false && enabled !== null) {
            json(res, 400, { error: 'enabled must be true, false, or null' });
            return;
          }
          // Plugin-owned skills (registered at runtime, no instruction file) are
          // not the user's to hide: the owning plugin routes through them.
          try {
            const described = await describe({
              sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
              cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
            });
            const target = described.skills.find((row) => row.name === skillName);
            if (target !== undefined && target.switchable === false) {
              json(res, 409, { error: `skill "${skillName}" is owned by a plugin and cannot be switched` });
              return;
            }
          } catch {
            /* fall through: a failed probe must not block a legitimate write */
          }
          try {
            await commit(layer, typeof key === 'string' && key !== '' ? key : undefined, skillName, enabled);
            json(res, 200, await describe({
              sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
              cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
            }));
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/plugins/zhongqing-skill-scope/reset',
        handler: async (req, res) => {
          if (!guard(req, res, 'POST')) return;
          const body = await readBody(req);
          if (body === undefined) {
            json(res, 400, { error: 'invalid JSON body' });
            return;
          }
          const { layer, key } = body;
          if (!['global', 'workspace', 'session'].includes(layer)) {
            json(res, 400, { error: 'layer must be global, workspace, or session' });
            return;
          }
          try {
            const current = await getState();
            const map = layerMap(current, layer, layer === 'global' ? undefined : key);
            const names = Object.keys(map);
            const reply = async () => describe({
              sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
              cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
            });
            if (names.length === 0) {
              json(res, 200, await reply());
              return;
            }
            state = await store.writeMany(names.map((skillName) => ({ layer, key, name: skillName, enabled: null })));
            stateLoaded = true;
            await resyncAll();
            json(res, 200, await reply());
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/plugins/zhongqing-skill-scope/load',
        handler: async (req, res) => {
          if (!guard(req, res, 'POST')) return;
          const body = await readBody(req);
          if (body === undefined) {
            json(res, 400, { error: 'invalid JSON body' });
            return;
          }
          const { sessionId, name: skillName } = body;
          if (typeof sessionId !== 'string' || typeof skillName !== 'string') {
            json(res, 400, { error: 'sessionId and name are required' });
            return;
          }
          const agent = optional(ctx, 'agents')?.get?.(sessionId);
          if (agent === undefined) {
            json(res, 404, { error: 'that session is not live in this process' });
            return;
          }
          try {
            const cwd = await workspaceKeyOf(agent).then((root) => root ?? agent.session?.header?.cwd);
            const skill = await ctx.skills.get(skillName, { scope: agent, cwd });
            if (skill === undefined) {
              json(res, 404, { error: `unknown skill "${skillName}"` });
              return;
            }
            agent.inject(skillMessage(skill, renderSkillContent(skill)));
            json(res, 200, {
              ok: true,
              queued: true,
              // `inject()` deliberately does not wake the agent, so the body
              // rides the next step the session already takes.
              note: '已排入下一步；发送任意消息后正文进入上下文。',
            });
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
    ];
    routeCtx.effect(() => {
      const disposers = routes.map((route) => webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'skill-scope: routes');
  });
}
