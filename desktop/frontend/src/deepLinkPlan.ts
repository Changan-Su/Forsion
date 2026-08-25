/**
 * forsion:// URL 解析与校验(P1)——**纯函数,零依赖**(node 可测,同 sessionOpenPlan 模式)。
 * 语法正典:docs/ToBeImproved/View基座统一化方案_2026-08-25.md §4.1。
 *   实体短径  forsion://note/<path>  /session/<id>  /space/<id>  /agent/<slug>
 *   通用径    forsion://open?view=<type>[&space=<id>][&<params...>]
 * 安全口径(§4.3):只产出「导航意图」;绝对路径/越级段拒收;`__` 前缀查询参数丢弃
 * (__type/__loc 是 Dockview 内部键,外部 URL 不许注入)。view 白名单在 resolver(那里有注册表)。
 */

export interface DeepLinkIntent {
  kind: 'note' | 'session' | 'space' | 'agent' | 'view'
  /** note=vault 相对路径;session/space/agent=id/slug。 */
  ref?: string
  /** kind=view:目标 view type(含 plugin:<pid>:<vid> 形态)。 */
  view?: string
  /** kind=view:可选的先行 Space 切换。 */
  space?: string
  params: Record<string, string>
}

/** id/slug/view-type 白形态:字母数字下划线连字符,外加 `:`(插件 view 命名空间)。 */
export const isSafeId = (s: string, max: number): boolean => !!s && s.length <= max && /^[A-Za-z0-9_:-]+$/.test(s)

/** vault 相对路径:拒绝空段 / `.` / `..` / 盘符绝对路径(与 amadeus-asset:// 协议同口径的穿越防线)。 */
export function isSafeVaultPath(p: string): boolean {
  if (!p || p.length > 1024) return false
  if (/^[A-Za-z]:[\\/]/.test(p)) return false
  const segs = p.split(/[\\/]/)
  return segs.every((s) => s !== '' && s !== '.' && s !== '..')
}

/** decode 失败(裸 %)按原文放行——链接可能本来就没编码(程序构造的中文 URL)。
 *  NFC 归一:浏览器/剪贴板来源多为 NFC,mac 文件系统对 NFC/NFD 输入解析到同一文件,归一后匹配面最大。 */
const dec = (s: string): string => {
  try { return decodeURIComponent(s).normalize('NFC') } catch { return s.normalize('NFC') }
}

export function parseDeepLink(raw: string): DeepLinkIntent | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (u.protocol !== 'forsion:') return null
  const host = u.hostname.toLowerCase()
  const path = dec(u.pathname.replace(/^\//, ''))
  const params: Record<string, string> = {}
  u.searchParams.forEach((v, k) => {
    // ⚠️ searchParams 的键值 WHATWG 已经 percent-decode 过 —— 再 dec() 一次会把字面 % 序列
    // (如文件名里真有 `%E4`)错误二次解码;只需 NFC 归一。pathname 才保留编码、才需要手动 decode。
    if (!k.startsWith('__') && k.length <= 64 && v.length <= 2048) params[k.normalize('NFC')] = v.normalize('NFC')
  })
  switch (host) {
    case 'note': return isSafeVaultPath(path) ? { kind: 'note', ref: path, params } : null
    case 'session': return isSafeId(path, 128) ? { kind: 'session', ref: path, params } : null
    case 'space': return isSafeId(path, 64) ? { kind: 'space', ref: path, params } : null
    case 'agent': return isSafeId(path, 64) ? { kind: 'agent', ref: path, params } : null
    case 'open': {
      const view = params.view
      delete params.view
      const space = params.space
      delete params.space
      if (!view || !isSafeId(view, 128)) return null
      if (space !== undefined && !isSafeId(space, 64)) return null
      return { kind: 'view', view, space, params }
    }
    default: return null // 未知实体段:报「需要升级」由调用方处理;这里不猜
  }
}
