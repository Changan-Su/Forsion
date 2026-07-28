/**
 * updater 的纯逻辑(无 electron / electron-updater 依赖,可在 node 下单测)。
 * updater.ts 引用这里;别在本文件 import electron,否则单测无法在非 Electron 环境加载。
 */

/** GitHub releaseNotes 可能是 string / Array<{ note }> / null → 归一为纯字符串(供 UI 展示)。 */
export function notesToString(notes: unknown): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes || undefined
  if (Array.isArray(notes)) {
    const s = notes.map((n: any) => (n?.note ?? '')).filter(Boolean).join('\n\n')
    return s || undefined
  }
  return undefined
}

/** 版本串拆成 { 主版本三段, prerelease 标识数组 };忽略 build 元数据(+xxx,semver 规定不参与比较)。 */
function parse(v: string): { main: number[]; pre: Array<string | number> } {
  const clean = v.trim().replace(/^v/i, '').split('+')[0]
  const dash = clean.indexOf('-')
  const mainStr = dash < 0 ? clean : clean.slice(0, dash)
  const preStr = dash < 0 ? '' : clean.slice(dash + 1)
  const main = mainStr.split('.').map((n) => parseInt(n, 10) || 0)
  const pre = preStr
    ? preStr.split('.').map((id) => (/^\d+$/.test(id) ? parseInt(id, 10) : id))
    : []
  return { main, pre }
}

/** 该版本是不是预发布(带 `-beta.1` 这类后缀)。 */
export function isPrerelease(v: string): boolean {
  return parse(v).pre.length > 0
}

/**
 * semver 优先级比较:remote 比 current 新返回 true。
 *
 * ⚠️ 必须按 semver 而不是「按点切开逐段比数字」——后者会把 `2.7.3-beta.1` 解析成 [2,7,3,1]
 * (`parseInt('3-beta')` = 3),于是 beta 比正式版 `2.7.3` 还"新",**切到测试版通道的用户
 * 永远升不回正式版**。这是做 beta 通道时最容易踩空的一处。
 *
 * 规则(semver §11):主版本三段逐段比数字;三段相同时,**有 prerelease 的一方更旧**
 * (`2.7.3-beta.1` < `2.7.3`);两边都有 prerelease 则逐标识比较,数字段按数值、
 * 非数字段按字典序,数字段永远小于非数字段;前缀相同时标识多的更新。
 */
export function isNewer(remote: string, current: string): boolean {
  const a = parse(remote)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.main.length, b.main.length); i++) {
    const x = a.main[i] || 0
    const y = b.main[i] || 0
    if (x !== y) return x > y
  }
  // 主版本相同:无 prerelease > 有 prerelease
  if (!a.pre.length && !b.pre.length) return false
  if (!a.pre.length) return true
  if (!b.pre.length) return false
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return false // a 的标识更少 = 更旧
    if (y === undefined) return true
    if (x === y) continue
    const xn = typeof x === 'number'
    const yn = typeof y === 'number'
    if (xn !== yn) return !xn // 数字段优先级低于非数字段
    return xn ? (x as number) > (y as number) : String(x) > String(y)
  }
  return false
}
