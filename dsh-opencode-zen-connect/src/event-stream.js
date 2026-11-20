/**
 * A live subscription to the OpenCode server's SSE event stream.
 *
 * Two traps here, both verified against opencode 1.19.5:
 *
 *  * `/event?sessionID=<id>` acknowledges with `server.connected` and then
 *    stops delivering `message.part.delta`. Never subscribe that way.
 *  * `/event` with no `directory` only streams events for sessions opened in
 *    the server's *own* directory, so a session created with
 *    `?directory=<somewhere else>` emits nothing at all.
 *
 * So subscribe per workdir, and drop other sessions' frames by hand.
 *
 * The server does not replay, so the subscription has to be live before the
 * prompt is sent — `openLiveEventStream` blocks until `server.connected`.
 * @module dsh-opencode-zen-connect/event-stream
 */

/**
 * Subscribe and return a frame pump.
 * @returns {Promise<{nextFrame: () => Promise<object | undefined>, cancel: () => void}>}
 */
export async function openLiveEventStream(baseUrl, sessionId, workdir, signal) {
  const url = `${baseUrl}/event?directory=${encodeURIComponent(workdir)}`
  const res = await fetch(url, { signal })
  if (!res.ok || res.body === null) {
    throw new Error(`opencode event stream: HTTP ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const nextFrame = async () => {
    for (;;) {
      const sep = buffer.indexOf('\n\n')
      if (sep !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)

        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('')

        if (data.length === 0) continue
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        // Frames from other sessions in the same workspace are not ours.
        const frameSession = parsed?.properties?.sessionID
        if (typeof frameSession === 'string' && frameSession !== sessionId) continue
        return parsed
      }

      const { value, done } = await reader.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }

  // Block until the server confirms this subscription exists.
  for (;;) {
    const frame = await nextFrame()
    if (frame === undefined) {
      throw new Error('opencode event stream closed before subscribing')
    }
    if (frame.type === 'server.connected') break
  }

  return { nextFrame, cancel: () => { void reader.cancel().catch(() => {}) } }
}
