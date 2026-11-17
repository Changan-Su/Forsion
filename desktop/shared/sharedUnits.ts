/**
 * 名册里「别人共享给当前账号的 Unit」(units:list 带 `{ shared: true }` 时回包里的 `shared` 兄弟键)。
 * 主进程(绑定设备页、拒绝给共享行开窗)和渲染层(账号面板)用同一个解析,面板上画出来的行和主进程认的行才对得上。
 *
 * 回包形状一概不信:
 *   - 没有 `shared` 键 = 云端 / Extend 是旧版,当「没有这一组」(undefined);
 *   - `shared` 在但不是数组 = 不知道(也回 undefined,调用方别据此当成「被撤了」);
 *   - 单行缺字段 / 字段类型不对 / `enter` 不是两个已知值 → 丢掉那一行。
 * 纯函数,无 Electron / DOM 依赖。
 */
import type { UnitInfo, UnitSharedInfo, UnitSharedLabel } from '../../tangu-agent/src/contracts/clientTypes'

export type { UnitSharedInfo, UnitSharedLabel }

/** 共享给当前账号的一行(shared 必有)。 */
export type SharedUnit = UnitInfo & { shared: UnitSharedInfo }

/** 设备 id 白名单(同 electron/unitShortcut.ts 的 UNIT_ID_RE、服务端 UNIT_ID_PATH)。 */
const UNIT_ID_RE = /^[0-9a-zA-Z-]{8,64}$/
/** 插件 manifest id(同生态约定的外部 manifest id 规则)。 */
const MANIFEST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const GROUP_ID_RE = /^[0-9a-zA-Z_.:-]{1,128}$/

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/** `{ zh, en }` 文案:至少有一种语言;别的键一概丢。都没有 = null。 */
function label(v: unknown, max: number): UnitSharedLabel | null {
  const o = obj(v)
  if (!o) return null
  const zh = text(o.zh, max)
  const en = text(o.en, max)
  if (!zh && !en) return null
  return { ...(zh ? { zh } : {}), ...(en ? { en } : {}) }
}

/** 按界面语言取:当前语言缺了就回落到有的那一种。 */
export function sharedLabel(l: UnitSharedLabel | null | undefined, lang: 'zh' | 'en'): string {
  if (!l) return ''
  return (lang === 'en' ? l.en || l.zh : l.zh || l.en) || ''
}

/** 一行;不合格 = null(丢掉这一行)。 */
export function parseSharedUnit(raw: unknown): SharedUnit | null {
  const r = obj(raw)
  if (!r) return null
  const id = r.id
  if (typeof id !== 'string' || !UNIT_ID_RE.test(id)) return null
  const name = text(r.name, 200)
  if (!name) return null
  const s = obj(r.shared)
  if (!s) return null
  const g = obj(s.group)
  const groupId = g?.id
  if (typeof groupId !== 'string' || !GROUP_ID_RE.test(groupId)) return null
  const title = label(g?.title, 120)
  if (!title) return null
  const roleLabel = label(s.roleLabel, 60)
  if (!roleLabel) return null
  const enter = s.enter
  if (enter !== 'frame' && enter !== 'none') return null
  // 能进的行必须带地址(真正的校验在主进程:validateSharedWebUrl)。不能进的行即使带了地址也原样留着 ——
  // 进不进只由 enter 决定(主进程绑定时核 enter === 'frame'),不靠「没地址」这层碰巧挡住。
  const webUrl = typeof r.webUrl === 'string' && r.webUrl ? r.webUrl : undefined
  if (enter === 'frame' && !webUrl) return null
  // 点了打开什么:只认「打开某个插件的主 Space」;写坏了 = 没给(这一行照样显示,只是点不动)
  const o = obj(s.open)
  const open = o && o.kind === 'space' && typeof o.plugin === 'string' && MANIFEST_ID_RE.test(o.plugin) ? { kind: 'space' as const, plugin: o.plugin } : undefined
  return {
    id,
    name,
    platform: typeof r.platform === 'string' ? r.platform : null,
    icon: typeof r.icon === 'string' && r.icon ? r.icon.slice(0, 8) : null,
    online: r.online === true,
    ...(r.sleeping === true ? { sleeping: true } : {}),
    shared: { group: { id: groupId, title }, roleLabel, enter, ...(open && enter === 'none' ? { open } : {}) },
    ...(webUrl ? { webUrl } : {}),
  }
}

/** 回包的 json(`{ units, shared? }`)→ 共享行;undefined = 没这一组 / 不知道(见文件头)。同 id 只留第一行。 */
export function parseSharedUnits(json: unknown): SharedUnit[] | undefined {
  const j = obj(json)
  if (!j || !Array.isArray(j.shared)) return undefined
  const out: SharedUnit[] = []
  const seen = new Set<string>()
  for (const raw of j.shared) {
    const u = parseSharedUnit(raw)
    if (!u || seen.has(u.id)) continue
    seen.add(u.id)
    out.push(u)
  }
  return out
}

/** 本机开发 / 台架用的回环地址(云端地址自己就是 http 回环时,才允许共享行用 http://<…>.localhost)。 */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
}

/**
 * 共享行的进入地址(名册给的 webUrl)能不能用;能用回规整后的地址(去掉片段),不能用 = null。
 *   - 协议 https;例外:云端自己是 http 回环(本机开发 / 台架)时,允许 http://<…>.localhost;
 *   - 不带用户名密码;
 *   - 源 ≠ 云端的源(不能借共享行把登录头补到云端自己身上);
 *   - 路径以 `/api/units/<这台的 id>/proxy/` 开头,其后不含解码后才冒出来的 `..` / `.` / `\`。
 */
export function validateSharedWebUrl(raw: unknown, unitId: string, cloudBase: string | null): string | null {
  if (typeof raw !== 'string' || !raw || !UNIT_ID_RE.test(unitId) || !cloudBase) return null
  let u: URL, cloud: URL
  try { u = new URL(raw); cloud = new URL(cloudBase) } catch { return null }
  if (u.username || u.password) return null
  if (u.protocol === 'http:') {
    const devCloud = cloud.protocol === 'http:' && isLoopbackHost(cloud.hostname)
    if (!devCloud || !u.hostname.endsWith('.localhost') || u.hostname === '.localhost') return null
  } else if (u.protocol !== 'https:') return null
  if (u.origin === cloud.origin) return null
  const prefix = `/api/units/${unitId}/proxy/`
  if (!u.pathname.startsWith(prefix)) return null
  let rest: string
  try { rest = decodeURIComponent(u.pathname.slice(prefix.length)) } catch { return null }
  if (rest.includes('\\') || rest.split('/').some((s) => s === '..' || s === '.')) return null
  u.hash = ''
  return u.href
}

/** 共享行补登录头的前缀:`<webUrl 的源>/api/units/<id>/proxy/`(只这台自己的子域;不含云端中转)。 */
export function sharedFramePrefix(webUrl: string, unitId: string): string {
  return `${new URL(webUrl).origin}/api/units/${unitId}/proxy/`
}
