/**
 * 设备(Forsion Unit)的「添加到桌面」与 Unit 窗的链接 —— 双击它,这台设备开在**它自己的窗口**里(不露出 Forsion 主窗)。
 * 落盘、图标、同名加序号、三个平台的产物全是 spaceShortcut.ts 那一套(WindowShortcutKind = UNIT_SHORTCUT),这里只有设备特有的部分:
 *
 *   · 链接 `forsion://unit/<设备 id>?window=standalone`;**快捷方式里只有设备 id**,地址、令牌、局域网 IP 一概不进。
 *     id 先过 UNIT_ID_RE(同服务端 UNIT_ID_PATH)才进链接。
 *   · 设备名字是名册数据(别的设备自己报上来的),**不可信**:只用作文件名 / 显示名,先过 safeShortcutName 洗
 *     (路径分隔符、控制字符、双向覆写、前后的点和空格、限长、洗空用缺省名);名字不进 mac 的 launch 脚本、
 *     .desktop 的 Exec=、.lnk 的参数,plist / .desktop 里出现的地方各按格式转义(spaceShortcut.windowShortcutPlan)。
 *   · 主进程再校验一遍(resolveUnitShortcutTarget):渲染层只给 id、兜底名、图标;id 过正则且必须在**此刻主进程读到的名册**里,
 *     名字取名册里那一条的。名册读不到(没登录 / 网络 / 没有名册桥)≠ 设备不存在,各回各的码,什么都不写。
 *
 * 无 Electron 依赖(纯 node,可测)。
 */
import type { ShortcutResult } from '../shared/products'
import { windowShortcutAppUserModelId, windowShortcutIdFromUrl, windowShortcutLink, type WindowShortcutKind } from './spaceShortcut'

/** 设备 id 的白名单(同服务端 UNIT_ID_PATH、渲染层 runLocation.UNIT_ID_RE)。 */
export const UNIT_ID_RE = /^[0-9a-zA-Z-]{8,64}$/
export const isUnitId = (id: unknown): id is string => typeof id === 'string' && UNIT_ID_RE.test(id)

export const UNIT_SHORTCUT: WindowShortcutKind = {
  host: 'unit',
  isId: isUnitId,
  aumid: 'Forsion.Unit',
  bundle: 'net.forsion.unit-shortcut',
  plistKey: 'ForsionUnitId',
  scriptComment: '# Forsion device shortcut: opens this device in its own Forsion window.',
}

export const unitWindowLink = (id: string): string => windowShortcutLink(UNIT_SHORTCUT, id)
export const unitWindowIdFromUrl = (raw: unknown): string | null => windowShortcutIdFromUrl(UNIT_SHORTCUT, raw)
export const unitAppUserModelId = (id: string): string => windowShortcutAppUserModelId(UNIT_SHORTCUT, id)

/** 名册里的一条(主进程只看这几个字段)。 */
export interface RosterUnit { id: string; name: string; icon?: string | null; platform?: string | null }

/** 主进程读名册的结果:units = 读到了;其余是「不知道」的几种,**不能**当空名册。 */
export type RosterRead =
  | { ok: true; units: RosterUnit[] }
  | { ok: false; code: 'signed_out' | 'roster_unavailable'; detail?: string }

export type UnitShortcutResult = ShortcutResult | { ok: false; code: 'signed_out' | 'roster_unavailable'; detail?: string }

/** 把 units:list 处理器的原样回包({status, json})折成 RosterRead。抛错 / 非 200 / 形状不对 = roster_unavailable,401 = signed_out。 */
export function parseRosterResponse(res: unknown): RosterRead {
  const r = res as { status?: unknown; json?: { units?: unknown } } | null
  if (!r || typeof r !== 'object') return { ok: false, code: 'roster_unavailable', detail: 'empty response' }
  if (r.status === 401) return { ok: false, code: 'signed_out' }
  if (r.status !== 200) return { ok: false, code: 'roster_unavailable', detail: `status ${String(r.status)}` }
  const list = r.json?.units
  if (!Array.isArray(list)) return { ok: false, code: 'roster_unavailable', detail: 'malformed roster' }
  const units: RosterUnit[] = []
  for (const u of list) {
    if (!u || typeof u !== 'object') continue
    const { id, name, icon, platform } = u as Record<string, unknown>
    if (typeof id !== 'string') continue
    units.push({ id, name: typeof name === 'string' ? name : '', icon: typeof icon === 'string' ? icon : null, platform: typeof platform === 'string' ? platform : null })
  }
  return { ok: true, units }
}

/**
 * 「添加到桌面」IPC 入参的主进程校验。渲染层传什么都不信:id 先过正则(不过 = not_found,连名册都不读),
 * 再现读名册确认是当前账号名下的设备;名字取名册里的。读名册失败按「不知道」回自己的码。
 */
export async function resolveUnitShortcutTarget(
  raw: unknown,
  readRoster: () => Promise<RosterRead>,
): Promise<{ ok: true; unit: RosterUnit } | { ok: false; code: 'not_found' | 'signed_out' | 'roster_unavailable'; detail?: string }> {
  const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
  if (!isUnitId(id)) return { ok: false, code: 'not_found' }
  let roster: RosterRead
  try { roster = await readRoster() } catch (e) { return { ok: false, code: 'roster_unavailable', detail: e instanceof Error ? e.message : String(e) } }
  if (!roster.ok) return roster
  const unit = roster.units.find((u) => u.id === id)
  return unit ? { ok: true, unit } : { ok: false, code: 'not_found' }
}

// ── Unit 窗的重启恢复(单独一份 unit-windows.json,不进独立窗那份清单:老版本不认这个文件,降级不会多出一扇空窗)──

export interface UnitWindowEntry { unit: string; bounds: { x: number; y: number; width: number; height: number } }

/** 读回来的清单:每条的设备 id 仍要过白名单、位置大小要是有限数。文件读坏(JSON 坏 / 不是数组)→ null = 不知道,调用方据此不写回。 */
export function parseUnitWindowState(raw: string): UnitWindowEntry[] | null {
  let arr: unknown
  try { arr = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(arr)) return null
  const out: UnitWindowEntry[] = []
  for (const x of arr) {
    const e = x as { unit?: unknown; bounds?: Record<string, unknown> } | null
    const b = e?.bounds
    if (!e || !isUnitId(e.unit) || !b || out.some((o) => o.unit === e.unit)) continue
    const n = (k: string): number | null => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? Math.round(b[k] as number) : null)
    const [bx, by, w, h] = [n('x'), n('y'), n('width'), n('height')]
    if (bx === null || by === null || w === null || h === null || w <= 0 || h <= 0) continue
    out.push({ unit: e.unit, bounds: { x: bx, y: by, width: w, height: h } })
  }
  return out
}
