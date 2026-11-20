/**
 * OpenCode server lifecycle and HTTP client.
 * @module dsh-opencode-zen-connect/opencode-server
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Fixed port the plugin's own opencode server listens on. */
export const OPENCODE_SERVER_PORT = 40961

/** The server's base URL once running. */
export const OPENCODE_SERVER_URL = `http://127.0.0.1:${OPENCODE_SERVER_PORT}`

/** Locate the persistently installed opencode binary. */
export function resolveOpenCodeBinary() {
  const candidates = [
    path.join(os.homedir(), '.local', 'share', 'dsh-opencode-connect', 'bin', 'opencode'),
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'opencode'
}

/** Whether the opencode binary is present and executable. */
export function hasOpenCodeBinary() {
  const bin = resolveOpenCodeBinary()
  if (bin === undefined) return false
  if (bin === 'opencode') return true
  try {
    const { execSync } = require('node:child_process')
    execSync(`${JSON.stringify(bin)} --version`, { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Probe whether an OpenCode server is already listening at OPENCODE_SERVER_URL.
 */
export function probeRunningServer(timeoutMs = 3_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(OPENCODE_SERVER_URL + '/session', {
    method: 'GET',
    signal: controller.signal,
  })
    .then(res => res.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer))
}

/**
 * Bring up the OpenCode server: probe for an existing one first, and spawn
 * the owned process only when nothing answers.
 */
export async function ensureOpenCodeServer(logger) {
  const running = await probeRunningServer()
  if (running) {
    return {
      ready: Promise.resolve(),
      url: OPENCODE_SERVER_URL,
      child: undefined,
      owned: false,
      close: async () => {},
    }
  }

  const binary = resolveOpenCodeBinary()
  if (binary === undefined) {
    throw new Error('dsh-opencode-zen-connect: no opencode binary found; install one at ~/.local/share/dsh-opencode-connect/bin/opencode')
  }

  logger?.info?.(`dsh-opencode-zen-connect: spawning opencode server from ${binary}`)

  const child = spawn(binary, ['serve', '--port', String(OPENCODE_SERVER_PORT)], {
    env: {
      ...process.env,
      XDG_STATE_HOME: path.join(os.homedir(), '.local', 'share', 'opencode'),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d) => { stdout += d.toString() })
  child.stderr?.on('data', (d) => { stderr += d.toString() })
  const exited = new Promise(resolve => { child.on('exit', () => resolve()) })

  let childError
  child.on('error', (err) => { childError = err })

  const ready = new Promise((resolve, reject) => {
    let attempts = 0
    const MAX_ATTEMPTS = 40
    const tick = async () => {
      if (childError !== undefined) return reject(childError)
      if (child.exitCode === null && childError === undefined) {
        attempts += 1
        try {
          const res = await fetch(OPENCODE_SERVER_URL + '/session', {
            method: 'GET',
            signal: AbortSignal.timeout(1_500),
          })
          if (res.ok) return resolve()
        } catch {}
        if (attempts >= MAX_ATTEMPTS) {
          return reject(new Error(
            `opencode server did not become reachable within ${MAX_ATTEMPTS * 500} ms; stdout=${stdout.slice(-400)} stderr=${stderr.slice(-400)}`
          ))
        }
        setTimeout(tick, 500)
      } else {
        reject(new Error(`opencode serve exited early; stdout=${stdout.slice(-400)} stderr=${stderr.slice(-400)}`))
      }
    }
    void tick()
  })

  return {
    ready,
    url: OPENCODE_SERVER_URL,
    child,
    owned: true,
    close: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await Promise.race([exited, new Promise(r => setTimeout(r, 3_000))])
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    },
  }
}

/**
 * Create an OpenCode session. Returns the session id.
 *
 * `workdir`, when given, becomes the session's `directory`: OpenCode resolves
 * its built-in tools (bash/read/glob/grep/edit/write/...) against it, which is
 * what puts them in the DSH workspace instead of the server's own directory.
 */
export async function createOpenCodeSession(baseUrl, title, signal, workdir) {
  const query = workdir === undefined ? '' : `?directory=${encodeURIComponent(workdir)}`
  const res = await fetch(`${baseUrl}/session${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    signal,
  })
  if (!res.ok) {
    throw new Error(`opencode create session failed: HTTP ${res.status}`)
  }
  const body = await res.json()
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw new Error('opencode create session: no id in response')
  }
  return body.id
}

/** Fetch the live model catalog from the running OpenCode server. */
export async function fetchOpenCodeCatalog(baseUrl, signal) {
  try {
    const res = await fetch(`${baseUrl}/config/providers`, { signal })
    if (!res.ok) return { models: [], fetchedAtMs: Date.now() }
    const body = await res.json()
    const provider = body.providers?.find(p => p.id === 'opencode')
    const models = Object.values(provider?.models ?? {})
      // Only surface the free tier. OpenCode's provider exposes its entire
      // paid roster (cost.input/output > 0) alongside the free models; those
      // need a paid OpenCode subscription and must not appear in this free
      // route. Keep entries with no cost metadata (e.g. an offline fallback)
      // so a sparse catalog never silently empties the picker.
      .filter(m => m.status === 'active' && (!m.cost || (m.cost.input === 0 && m.cost.output === 0)))
      .map(m => ({
        id: m.id,
        providerID: m.providerID,
        name: m.name,
        contextWindow: m.limit?.context ?? 200_000,
        maxTokens: m.limit?.output,
        capabilities: m.capabilities ?? {},
        status: m.status,
        cost: m.cost,
        variants: m.variants ?? {},
      }))
    return { models, fetchedAtMs: Date.now() }
  } catch {
    return { models: [], fetchedAtMs: Date.now() }
  }
}

/**
 * Post one message to a session and resolve with its usage.
 *
 * `workdir` must match the session's directory; OpenCode resolves the prompt
 * (and the tools it triggers) against it. The response settles only after the
 * whole turn — every step, including tool calls — has finished.
 */
export async function sendOpenCodeMessage(baseUrl, sessionId, workdir, payload, signal) {
  const query = workdir === undefined ? '' : `?directory=${encodeURIComponent(workdir)}`
  const res = await fetch(`${baseUrl}/session/${sessionId}/message${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    throw new Error(`opencode message failed: HTTP ${res.status} ${bodyText.slice(0, 300)}`)
  }
  const body = await res.json()
  if (body.info?.error !== undefined) {
    const data = body.info.error.data
    throw new Error(
      `opencode model error: ${data?.message ?? body.info.error.name} (status ${data?.statusCode})`,
    )
  }
  const tokens = body.info?.tokens
  return {
    usage: tokens === undefined
      ? undefined
      : { input: tokens.input ?? 0, output: tokens.output ?? 0 },
  }
}
