/**
 * DSH -> OpenCode message shaping.
 *
 * DSH does not hand a provider one tidy user turn. A single request carries
 * several `system` messages (the agent prompt plus a title-generation prompt)
 * and, after the human question, further `user` messages that DSH injected
 * itself: the working-directory system-reminder and the skill catalogue.
 * Naively taking "the last user message" therefore sends the catalogue, and the
 * model answers that instead of the question.
 *
 * Everything here is pure so it can be unit-tested without a live server.
 * @module dsh-opencode-zen-connect/message-shape
 */

import { createHash } from 'node:crypto'

/** Markers DSH uses for blocks it appends around the human turn. */
const INJECTED_PATTERNS = [
  /^\s*<system-reminder>/,
  /A skill is a reusable set of task-specific instructions/,
  /^\s*Generate the session title from this JSON array/,
]

/** Where DSH states the workspace it wants tools to run in. */
const WORKDIR_PATTERN = /Current working directory:\s*"([^"]+)"/

/** Flatten an OpenAI-style message's content into plain text. */
export function textOf(msg) {
  const content = msg?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(c => c?.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n')
}

/** Whether a text block is DSH-injected context rather than the human turn. */
export function isInjectedContext(text) {
  return INJECTED_PATTERNS.some(pattern => pattern.test(text))
}

/** The human question: the last user message that is not injected context. */
export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i]?.role ?? 'user') !== 'user') continue
    const text = textOf(messages[i])
    if (text.length === 0) continue
    if (isInjectedContext(text)) continue
    return text
  }
  return 'Reply with exactly: PONG'
}

/** Every system instruction, joined into one `system` field. */
export function systemText(messages) {
  return messages
    .filter(m => m?.role === 'system')
    .map(textOf)
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * The workspace DSH wants tools to run in, read from its own system-reminder.
 * Falls back to the process cwd when no reminder is present.
 */
export function workdirOf(messages, fallback = process.cwd()) {
  for (const msg of messages) {
    const match = WORKDIR_PATTERN.exec(textOf(msg))
    if (match !== null) return match[1]
  }
  return fallback
}

/**
 * Stable identity for one DSH conversation.
 *
 * The first human turn never changes while a conversation lives, and the
 * workspace scopes where OpenCode will run tools, so their pair identifies the
 * OpenCode session to resume across turns.
 */
export function conversationKey(messages, workdir) {
  const first = messages.find(m => {
    if ((m?.role ?? 'user') !== 'user') return false
    const text = textOf(m)
    return text.length > 0 && !isInjectedContext(text)
  })
  return createHash('sha256')
    .update(workdir)
    .update('\u0000')
    .update(textOf(first ?? messages[0] ?? {}))
    .digest('hex')
    .slice(0, 32)
}
