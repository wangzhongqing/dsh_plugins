/**
 * One OpenCode session per DSH conversation.
 *
 * Creating a session per request is what made the bridge answer only one turn:
 * every request started from an empty OpenCode session and had to be fed a
 * flattened transcript. Reusing a session lets OpenCode keep the real
 * conversation state, so a follow-up only has to carry the new question.
 *
 * Sessions are created with `?directory=<workdir>` so that OpenCode's own tools
 * (bash/read/glob/grep/edit/write/...) run in the DSH workspace rather than in
 * the server's own directory.
 * @module dsh-opencode-zen-connect/session-registry
 */

import { createOpenCodeSession } from './opencode-server.js'

/** conversationKey -> OpenCode session id */
const SESSIONS = new Map()

/**
 * The session for this conversation, created on first use.
 *
 * A failed prompt invalidates the entry (see `forgetSession`) so the next turn
 * starts from a clean session instead of talking to a broken one.
 */
export async function ensureSession(baseUrl, key, workdir, signal) {
  const cached = SESSIONS.get(key)
  if (cached !== undefined) return cached

  const sessionId = await createOpenCodeSession(baseUrl, `dsh ${key.slice(0, 12)}`, signal, workdir)
  SESSIONS.set(key, sessionId)
  return sessionId
}

/** Drop one cached session, keyed the same way `ensureSession` takes it. */
export function forgetSession(key) {
  SESSIONS.delete(key)
}

/** Drop every cached session (plugin teardown). */
export function forgetAllSessions() {
  SESSIONS.clear()
}

/** Test hook: how many conversations are currently pinned to a session. */
export function sessionCount() {
  return SESSIONS.size
}
