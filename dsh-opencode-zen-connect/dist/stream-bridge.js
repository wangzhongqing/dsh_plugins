/**
 * Translate one OpenCode session's event stream into OpenAI-compatible SSE.
 *
 * The bridge keeps one OpenCode session per DSH conversation and reuses it
 * across turns, so the model holds real conversational state instead of
 * re-reading a flattened transcript. The session is created with the DSH
 * workspace as its `directory`, which is what lets OpenCode's own tools
 * (bash/read/glob/grep/edit/write/...) run in the right place — their schemas
 * cannot be forwarded, the message API only accepts `{tool: boolean}` switches.
 * @module dsh-opencode-zen-connect/stream-bridge
 */

import { Readable } from 'node:stream'

import { openLiveEventStream } from './event-stream.js'
import {
  conversationKey,
  lastUserText,
  systemText,
  workdirOf,
} from './message-shape.js'
import { sendOpenCodeMessage } from './opencode-server.js'
import { ensureSession, forgetSession } from './session-registry.js'

export async function bridgeOpenCodeToOpenAISSE(params) {
  const { opencodeUrl, model, messages, variant, signal, logger } = params

  const sse = new Readable({
    read() {},
  })
  let aborted = false
  let settled = false

  const push = (obj) => {
    if (aborted || settled) return
    const sseLine = `data: ${JSON.stringify(obj)}\n\n`
    if (!sse.push(Buffer.from(sseLine))) {
      sse.once('drain', () => {})
    }
  }

  const sseId = `chatcmpl-opencode-${Math.floor(Math.random() * 1e15)}`
  const modelLabel = model

  const emitSSEStart = () => {
    if (aborted || settled) return
    push({
      id: sseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelLabel,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })
  }

  const emitDelta = (content) => {
    if (aborted || settled) return
    if (content === undefined || content.length === 0) return
    push({
      id: sseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelLabel,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })
  }

  const emitFinish = (reason, usage) => {
    if (aborted || settled) return
    // Push directly: the shared push() helper checks `settled`, which this
    // function is about to set. Writing the frames first, then flipping the
    // flag, is what keeps the finish chunk from being dropped.
    const now = Math.floor(Date.now() / 1000)
    sse.push(Buffer.from(`data: ${JSON.stringify({
      id: sseId,
      object: 'chat.completion.chunk',
      created: now,
      model: modelLabel,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
    })}\n\n`))
    if (usage !== undefined) {
      sse.push(Buffer.from(`data: ${JSON.stringify({
        id: sseId,
        object: 'chat.completion.chunk',
        created: now,
        model: modelLabel,
        choices: [],
        usage: {
          prompt_tokens: usage.input,
          completion_tokens: usage.output,
          total_tokens: usage.input + usage.output,
        },
      })}\n\n`))
    }
    settled = true
    if (!aborted) sse.push(null)
  }

  const emitError = (message, code) => {
    if (aborted || settled) return
    // Same ordering as emitFinish: frame first, flag second.
    sse.push(Buffer.from(`data: ${JSON.stringify({
      id: sseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelLabel,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      error: { message, type: code, code },
    })}\n\n`))
    settled = true
    sse.push(null)
  }

  if (signal !== undefined) {
    signal.addEventListener('abort', () => {
      aborted = true
      sse.push(null)
    }, { once: true })
  }

  void (async () => {
    const workdir = workdirOf(messages)
    const key = conversationKey(messages, workdir)
    try {
      const sessionId = await ensureSession(opencodeUrl, key, workdir, signal)
      emitSSEStart()

      // OpenCode does not replay events, so the subscription has to be live
      // before the prompt goes out.
      const events = await openLiveEventStream(opencodeUrl, sessionId, workdir, signal)
      const system = systemText(messages)

      let promptPromise
      try {
        promptPromise = sendOpenCodeMessage(
          opencodeUrl,
          sessionId,
          workdir,
          {
            model: { providerID: 'opencode', modelID: model },
            // OpenCode accepts a top-level `variant` (its reasoning-effort
            // selector). DSH sends it as `reasoning_effort`; the shim forwards
            // it to us; simple tasks ignore it, reasoning models apply it.
            ...(variant !== undefined ? { variant } : {}),
            ...(system.length > 0 ? { system } : {}),
            parts: [{ type: 'text', text: lastUserText(messages) }],
          },
          signal,
        )
      } catch (error) {
        events.cancel()
        throw error
      }
      // The prompt must not reject into an unhandled rejection while streaming.
      promptPromise.catch(() => {})

      // `message.part.delta` carries no part type — its `field` is `"text"`
      // even for reasoning. The preceding `message.part.updated` for the same
      // partID does carry it, so track each part's type and forward only
      // answer text.
      const partTypes = new Map()
      let promptError

      for (;;) {
        const frame = await events.nextFrame()
        if (frame === undefined) break
        const type = frame.type ?? ''
        const props = frame.properties ?? {}

        if (type === 'message.part.delta') {
          if (partTypes.get(props.partID) !== 'text') continue
          const delta = props.delta
          if (typeof delta === 'string' && delta.length > 0) emitDelta(delta)
        } else if (type === 'message.part.updated') {
          const part = props.part
          if (typeof part?.id === 'string' && typeof part?.type === 'string') {
            partTypes.set(part.id, part.type)
          }
        } else if (type === 'session.idle') {
          // A turn spans several steps when OpenCode runs tools, so a
          // step-finish is not the end of the answer. session.idle is.
          break
        } else if (type === 'message.updated') {
          const info = props.info
          if (info?.error !== undefined) {
            const errMsg = typeof info.error === 'object' && info.error !== null
              ? JSON.stringify(info.error).slice(0, 300)
              : String(info.error)
            promptError = new Error(`opencode model error: ${errMsg}`)
            break
          }
        }
      }
      events.cancel()

      let usage
      try {
        usage = (await promptPromise).usage
      } catch (error) {
        // The session may be unusable; start the next turn from a fresh one.
        forgetSession(key)
        promptError = promptError ?? (error instanceof Error ? error : new Error(String(error)))
      }
      if (promptError !== undefined) {
        if (!(signal?.aborted)) emitError(promptError.message, 'opencode_upstream')
        return
      }

      if (signal?.aborted) {
        sse.push(null)
        return
      }
      emitFinish('stop', usage)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger?.error?.('dsh-opencode-zen-connect: stream bridge failed', error)
      if (!(signal?.aborted)) {
        emitError(msg, 'opencode_bridge')
      } else {
        sse.push(null)
      }
    }
  })()

  return sse
}
