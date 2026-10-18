/**
 * 登录名(有昵称用昵称)的唯一读法(2026-10-18,主页插件化 S5):内置主页的问候和插件的 `ctx.app.watchAccountName` 共用。
 * 桌面走主进程的 authStatus / onAuthChanged;网页版 Unit 走 window.tangu.account(只有 username)。没登录 / 拿不到 = 空串。
 */
export function watchAccountName(cb: (name: string) => void): () => void {
  const t = typeof window !== 'undefined' ? window.tangu : undefined
  let alive = true
  let last: string | null = null
  const emit = (name: string): void => { if (alive && name !== last) { last = name; cb(name) } }
  const read = (): void => {
    const auth = t?.authStatus?.().then((a) => (a?.loggedIn ? (a.nickname || a.username || '') : ''))
      ?? t?.account?.status().then((a) => (a.loggedIn ? a.username || '' : ''))
    void (auth ?? Promise.resolve('')).then(emit, () => {})
  }
  read()
  const off = t?.onAuthChanged?.(read) ?? t?.account?.subscribe(read)
  return () => { alive = false; off?.() }
}
