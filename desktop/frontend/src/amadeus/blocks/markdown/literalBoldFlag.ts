// PROBE (inline-literal-bold): switch for "bold delimiters are real text characters".
// Off by default; behaviour with the switch off must equal main.
// On via `?litbold=1` on the page URL, localStorage `amx.probe.litbold` = '1', or setLiteralBold(true) (tests).
let override: boolean | null = null

export function setLiteralBold(v: boolean | null): void {
  override = v
}

export function literalBoldEnabled(): boolean {
  if (override != null) return override
  try {
    if (typeof location !== 'undefined' && /[?&]litbold=1(?:&|$)/.test(location.search)) return true
    if (typeof localStorage !== 'undefined' && localStorage.getItem('amx.probe.litbold') === '1') return true
  } catch {
    /* storage blocked */
  }
  return false
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// ── save ──
const literalUnsafeCache = new WeakMap<object, unknown[]>()
function literalUnsafe(list: any[]): unknown[] {
  let hit = literalUnsafeCache.get(list)
  if (hit) return hit
  hit = []
  for (const u of list) {
    if ((u.character === '*' || u.character === '_') && u.inConstruct === 'phrasing' && !u.atBreak) continue
    if (u.atBreak && u.character === '*') {
      hit.push({ ...u, after: '(?:[ \\t\\r\\n]|\\*[ \\t\\r\\n*])', _compiled: undefined })
      continue
    }
    if (u.atBreak && u.character === '_') {
      hit.push({ ...u, after: '(?:[ \\t\\r\\n]|_[ \\t\\r\\n_])', _compiled: undefined })
      continue
    }
    hit.push(u)
  }
  literalUnsafeCache.set(list, hit)
  return hit
}

/** Wrap the mdast `text` handler: with the switch on, `*` / `_` in text are written as-is (see file head). */
export function withLiteralStars<H extends (node: any, parent: any, state: any, info: any) => string>(handler: H): H {
  return function literalStarsText(node: any, parent: any, state: any, info: any): string {
    if (!literalBoldEnabled() || !Array.isArray(state?.unsafe)) return handler(node, parent, state, info)
    const orig = state.unsafe
    state.unsafe = literalUnsafe(orig)
    try {
      return handler(node, parent, state, info)
    } finally {
      state.unsafe = orig
    }
  } as H
}

/* eslint-enable @typescript-eslint/no-explicit-any */
