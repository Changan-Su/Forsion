/**
 * 给 Web Storage 套一层键前缀:页面里所有 `localStorage` / `sessionStorage` 的读写都落在 `<prefix>` 下面,
 * 同一浏览器、同一源里别的身份存下的键既读不到也写不着。只在 Unit 网页的委托管理员角色下装(web/src/unitShim.ts),
 * 必须先于应用模块求值(不少模块在顶层就读存储)。
 *
 * 用 Proxy 而不是一个普通对象:调用方除了 getItem / setItem,还有 `Object.keys(localStorage)`、`localStorage[k]`、
 * `key(i)` / `length` 遍历,这些都要只看见本前缀下的键。`storage` 事件里的 key 仍是底层原样的(带前缀),
 * 按固定键比对的跨窗口同步在这个角色下自然不触发。
 */
export function scopedStorage(raw: Storage, prefix: string): Storage {
  const own = (): string[] => {
    const out: string[] = []
    for (let i = 0; i < raw.length; i++) {
      const k = raw.key(i)
      if (k !== null && k.startsWith(prefix)) out.push(k.slice(prefix.length))
    }
    return out
  }
  const api: Storage = {
    get length() { return own().length },
    key: (i: number) => own()[i] ?? null,
    getItem: (k: string) => raw.getItem(prefix + String(k)),
    setItem: (k: string, v: string) => raw.setItem(prefix + String(k), String(v)),
    removeItem: (k: string) => raw.removeItem(prefix + String(k)),
    clear: () => { for (const k of own()) raw.removeItem(prefix + k) },
  }
  const methods = new Set<PropertyKey>(['length', 'key', 'getItem', 'setItem', 'removeItem', 'clear'])
  return new Proxy(api, {
    get: (t, p) => (methods.has(p) || typeof p === 'symbol' ? Reflect.get(t, p) : (raw.getItem(prefix + String(p)) ?? undefined)),
    set: (t, p, v) => { if (typeof p === 'symbol' || methods.has(p)) return false; raw.setItem(prefix + String(p), String(v)); return true },
    has: (t, p) => methods.has(p) || (typeof p === 'string' && raw.getItem(prefix + p) !== null),
    deleteProperty: (t, p) => { if (typeof p === 'string' && !methods.has(p)) raw.removeItem(prefix + p); return true },
    ownKeys: () => own(),
    getOwnPropertyDescriptor: (t, p) => {
      if (typeof p !== 'string' || methods.has(p)) return undefined
      const v = raw.getItem(prefix + p)
      return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true }
    },
  })
}

/** 把 window 上的 localStorage / sessionStorage 换成带前缀的那份。返回是否两者都换上了(换不上 = 调用方当失败处理)。 */
export function installScopedStorage(prefix: string): boolean {
  let ok = true
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const wrapped = scopedStorage(window[name], prefix)
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => wrapped })
      if (window[name] !== wrapped) ok = false
    } catch { ok = false }
  }
  return ok
}
