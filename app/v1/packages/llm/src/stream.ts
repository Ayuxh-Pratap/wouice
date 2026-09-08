/**
 * Parsing a server-sent-event stream of chat completions.
 *
 * Pure, and separate from the client, because this is the part with edge cases
 * in it: frames arrive split across network reads, `data:` lines carry JSON that
 * may itself contain newlines, and the terminating sentinel is not JSON at all.
 * A parser that only works when every chunk happens to end on a frame boundary
 * passes every casual test and drops text in production.
 *
 * Streaming rather than waiting for the whole response is what makes it possible
 * to tell a slow model from a stopped one - the distinction the fixed timeout
 * could not make.
 */

export interface SseProgress {
  /** Text deltas, in order. */
  deltas: string[]
  /** Whatever could not be parsed yet; feed it back with the next chunk. */
  rest: string
  /** The stream said it was finished. */
  done: boolean
  /** 'stop', 'length', or whatever the server reported. */
  finishReason: string | null
}

interface StreamFrame {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
  error?: { message?: string }
}

/**
 * Consume as much of `buffer + chunk` as forms complete lines.
 *
 * Anything after the last newline is returned in `rest` rather than parsed: it
 * is the front half of a frame whose back half has not arrived.
 */
export function consumeSse(buffer: string, chunk: string): SseProgress {
  const text = buffer + chunk
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) {
    return { deltas: [], rest: text, done: false, finishReason: null }
  }

  const complete = text.slice(0, lastNewline)
  const rest = text.slice(lastNewline + 1)

  const deltas: string[] = []
  let done = false
  let finishReason: string | null = null

  for (const rawLine of complete.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || !line.startsWith('data:')) continue

    const payload = line.slice(5).trim()
    // The end sentinel is a bare token, not JSON. Parsing it would throw on
    // every single stream.
    if (payload === '[DONE]') {
      done = true
      continue
    }

    let frame: StreamFrame
    try {
      frame = JSON.parse(payload) as StreamFrame
    } catch {
      // A frame we cannot read is not a reason to discard the ones we can.
      continue
    }

    if (frame.error?.message) {
      throw new Error(frame.error.message)
    }

    const choice = frame.choices?.[0]
    const delta = choice?.delta?.content
    if (typeof delta === 'string' && delta.length > 0) deltas.push(delta)
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason
      done = true
    }
  }

  return { deltas, rest, done, finishReason }
}
