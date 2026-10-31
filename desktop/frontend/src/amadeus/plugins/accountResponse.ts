/** Keep account/plugin response branches revocable until every body is consumed or cancelled. */
export function leaseAccountResponse(response: Response, check: () => void, cleanup: () => void, signal: AbortSignal): Response {
  let branches = 1
  const wrap = (source: Response): Response => {
    check()
    const reader = source.body?.getReader()
    let finished = false
    let abortBody: (() => void) | undefined
    const finish = () => {
      if (finished) return
      finished = true
      if (abortBody) signal.removeEventListener('abort', abortBody)
      if (--branches === 0) cleanup()
    }
    const body = reader ? new ReadableStream<Uint8Array>({
      start(controller) {
        abortBody = () => {
          controller.error(signal.reason ?? new DOMException('Account or plugin changed', 'AbortError'))
          void reader.cancel(signal.reason).catch(() => {})
          finish()
        }
        signal.addEventListener('abort', abortBody, { once: true })
        if (signal.aborted) abortBody()
      },
      async pull(controller) {
        try {
          check()
          const { done, value } = await reader.read()
          check()
          if (done) { controller.close(); finish() } else controller.enqueue(value)
        } catch (e) { controller.error(e); void reader.cancel(e).catch(() => {}); finish() }
      },
      async cancel(reason) { finish(); await reader.cancel(reason) },
    }, { highWaterMark: 0 }) : null
    if (!reader) finish()
    const guarded = new Response(body, { status: source.status, statusText: source.statusText, headers: source.headers })
    Object.defineProperties(guarded, { url: { value: source.url }, redirected: { value: source.redirected }, type: { value: source.type } })
    for (const method of ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const) {
      const consume = guarded[method].bind(guarded)
      Object.defineProperty(guarded, method, { configurable: true, value: async () => { check(); const value = await consume(); check(); return value } })
    }
    const clone = guarded.clone.bind(guarded)
    Object.defineProperty(guarded, 'clone', { value: () => { check(); const copied = clone(); branches++; return wrap(copied) } })
    return guarded
  }
  return wrap(response)
}
