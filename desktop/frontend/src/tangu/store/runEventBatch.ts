import type { AgentRunEvent } from '../../../../../tangu-agent/src/contracts/clientTypes'

/** Only the UI consumer batches deltas. The transport still deduplicates every original seq.
 * First output is immediate; subsequent compatible deltas share a 40ms window. A different
 * event is an ordering barrier (especially tool calls, approvals, turn boundaries and done).
 * Timers, not rAF: hidden windows must continue receiving and settling runs.
 */
export function createRunEventBatch(deliver: (event: AgentRunEvent) => void) {
  let pending: AgentRunEvent | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let deliveredAt = -Infinity
  let closed = false
  const send = (event: AgentRunEvent) => { deliveredAt = Date.now(); deliver(event) }
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const event = pending
    pending = undefined // clear before calling out: done/endRun can synchronously abort this subscription
    if (event) send(event)
  }
  return {
    push(event: AgentRunEvent) {
      if (closed) return
      if (!isDelta(event)) { flush(); send(event); return }
      if (pending && !compatible(pending, event)) flush()
      if (!pending && Date.now() - deliveredAt >= 40) { send(event); return }
      pending = pending
        ? { ...event, payload: { ...event.payload, delta: pending.payload.delta + event.payload.delta } }
        : event
      // Bound a queued burst too; normal streaming is only a few hundred characters per window.
      if (Date.now() - deliveredAt >= 40 || pending.payload.delta.length >= 64 * 1024) { flush(); return }
      if (timer === undefined) timer = setTimeout(flush, Math.max(0, 40 - (Date.now() - deliveredAt)))
    },
    flush,
    close() { closed = true; flush() },
  }
}

function isDelta(event: AgentRunEvent): boolean {
  return (event.type === 'token' || event.type === 'reasoning' || event.type === 'tool_stream'
    || (event.type === 'subagent' && ['token', 'reasoning', 'tool_stream'].includes(event.payload?.phase)))
    && typeof event.payload?.delta === 'string'
}

function compatible(a: AgentRunEvent, b: AgentRunEvent): boolean {
  if (a.type !== b.type) return false
  // Identity AND metadata must match: parallel tool ids/names and future payload fields
  // must never be folded into a neighbouring stream. Preserve the last original seq.
  const keys = Object.keys(a.payload).filter((k) => k !== 'delta')
  return keys.length === Object.keys(b.payload).filter((k) => k !== 'delta').length
    && keys.every((k) => Object.hasOwn(b.payload, k) && Object.is(a.payload[k], b.payload[k]))
}
