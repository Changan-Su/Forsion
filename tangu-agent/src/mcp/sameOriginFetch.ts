/** MCP origins are configured trust boundaries (including local HTTP servers).
 * Enforce that boundary on redirects AND SSE endpoint events. Never forward a body,
 * session id or arbitrary configured credential to a different origin.
 */
export function sameOriginFetch(endpoint: URL): typeof fetch {
  const origin = endpoint.origin;
  return async (input, init) => {
    let request = new Request(input, init);
    for (let hop = 0; hop <= 10; hop++) {
      const url = new URL(request.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
        throw new Error('MCP cross-origin request is not allowed');
      }
      request.signal.throwIfAborted();
      // clone preserves the original request body for same-origin 307/308 replay.
      const response = await fetch(request.clone(), { redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('MCP redirect has no Location');
      if (hop === 10) throw new Error('Too many MCP redirects');
      const next = new URL(location, request.url);
      if (next.origin !== origin) throw new Error('MCP cross-origin redirect is not allowed');
      const method = request.method;
      if ((response.status === 303 && !['GET', 'HEAD'].includes(method)) || ([301, 302].includes(response.status) && method === 'POST')) {
        const headers = new Headers(request.headers);
        for (const key of [...headers.keys()]) if (/^(content-|transfer-encoding$)/i.test(key)) headers.delete(key);
        request = new Request(next, { method: 'GET', headers, signal: request.signal });
      } else request = new Request(next, request);
    }
    throw new Error('Too many MCP redirects');
  };
}
