/**
 * 本机多 Unit 的渲染层半身(接口与语义以 shared/localUnits.ts 为准,主进程那半在 electron/):
 * - useLocalUnits:名册快照缓存。头像面板 / 头像角标挂载时拉一次,之后跟 onChanged(任一实例改了名册、标记文件或运行状态)。
 *   **读不出 ≠ 空**:list() 抛错或回包不像快照 → failed,面板按「读不出本机 Unit 列表」画,不按空名册画,也不给写操作入口;
 *   之前读到过的 self(在不在文件夹 Unit 里)照旧用。
 * - localUnitCall:写操作 / 打开一律走它。IPC 抛错(主进程没接这条通道、不是主窗)或回包不对 → { ok:false, code:'io' },不往上抛。
 * - localUnitErrorText:每个错误码一句人话;cancelled(用户在系统对话框里取消)不说话。
 * - LocalUnitIcon:标记文件里的 icon 可以是 emoji,也可以是宿主图标名(和 Space 同一套取值);空 = 文件夹。
 * 渲染层只拿 id,路径只用来显示(displayPath),从不回传给主进程。
 */
import React from 'react'
import { create } from 'zustand'
import { Folder } from 'lucide-react'
import type { SpaceDefinition } from '@lcl/engine'
import type { LocalUnitRow, LocalUnitsApi, LocalUnitsErrorCode, LocalUnitsResult, LocalUnitsSnapshot } from '../../../shared/localUnits'
import { registerMessages, translate } from '../i18n'
import { vocabIcon } from '../amadeus/plugins/pluginIcon'
import { renderAppIconPng, type AppIconGlyph } from '../spaceShortcut'

registerMessages({
  'unit.local.missing': { zh: '找不到这个文件夹', en: 'Folder not found' },
  'unit.local.mismatch': { zh: '文件夹对不上', en: "Folder doesn't match" },
  'unit.local.unreadable': { zh: '读不出本机 Unit 列表', en: "Couldn't read the Units on this computer" },
  'unit.local.openOwn': { zh: '在自己的窗口打开', en: 'Open in own window' },
  'unit.local.edit': { zh: '改名字和图标…', en: 'Name and icon…' },
  'unit.local.revealMac': { zh: '在访达中显示', en: 'Show in Finder' },
  'unit.local.revealWin': { zh: '在资源管理器中显示', en: 'Show in File Explorer' },
  'unit.local.revealLinux': { zh: '在文件管理器中显示', en: 'Show in file manager' },
  'unit.local.remove': { zh: '从列表移除…', en: 'Remove from list…' },
  'unit.local.add': { zh: '添加 Unit…', en: 'Add Unit…' },
  'unit.local.openFailed': { zh: '没能打开「{name}」：{error}', en: 'Couldn\'t open "{name}": {error}' },
  'unit.local.actionFailed': { zh: '没做成：{error}', en: "That didn't work: {error}" },
  'unit.local.fallbackName': { zh: 'Forsion 本机 Unit', en: 'Forsion Unit' },
  // 错误码 → 人话(主进程的 message 不直接给人看:可能带路径和英文栈)
  'unit.local.err.nameInvalid': { zh: '这个名字用不了：不能留空、不能太长，也不能只有符号。', en: "That name won't work. It can't be empty, too long, or only symbols." },
  'unit.local.err.pathExists': { zh: '那里已经有同名的文件夹了，换个名字或位置。', en: "There's already a folder with that name there. Try another name or location." },
  'unit.local.err.parentInvalid': { zh: '这个位置用不了：找不到，或者没有权限写入。', en: "That location can't be used. It doesn't exist or isn't writable." },
  'unit.local.err.notAUnit': { zh: '这个文件夹不是 Forsion Unit（里面没有能读的 forsion-unit.json）。', en: "That folder isn't a Forsion Unit (there's no readable forsion-unit.json in it)." },
  'unit.local.err.channelMismatch': { zh: '这个 Unit 是另一个版本的 Forsion 建的（安装版和开发版不混用），这里打不开。', en: "That Unit was made by another build of Forsion (release and development builds don't mix), so it can't be opened here." },
  'unit.local.err.duplicateId': { zh: '这个文件夹像是从另一个 Unit 拷贝出来的，两份会互相顶掉登录，暂时不能加入。', en: 'This folder looks like a copy of another Unit. The two would keep signing each other out, so it can\'t be added for now.' },
  'unit.local.err.registryUnreadable': { zh: '读不出本机 Unit 列表，这次什么都没改。', en: "Couldn't read the list of Units on this computer, so nothing was changed." },
  'unit.local.err.notFound': { zh: '列表里已经没有这个 Unit 了。', en: "That Unit isn't on the list anymore." },
  'unit.local.err.isSelf': { zh: '正在用的这个 Unit 不能这样做。', en: "You can't do that to the Unit you're in." },
  'unit.local.err.io': { zh: '读写文件时出了问题，稍后再试。', en: 'Something went wrong reading or writing files. Try again in a moment.' },
})

const ERR_KEY: Record<Exclude<LocalUnitsErrorCode, 'cancelled'>, string> = {
  name_invalid: 'unit.local.err.nameInvalid',
  path_exists: 'unit.local.err.pathExists',
  parent_invalid: 'unit.local.err.parentInvalid',
  not_a_unit: 'unit.local.err.notAUnit',
  channel_mismatch: 'unit.local.err.channelMismatch',
  duplicate_id: 'unit.local.err.duplicateId',
  registry_unreadable: 'unit.local.err.registryUnreadable',
  not_found: 'unit.local.err.notFound',
  is_self: 'unit.local.err.isSelf',
  io: 'unit.local.err.io',
}

/** 错误码 → 一句人话;cancelled → null(不说话);认不出的码按 io 说。 */
export function localUnitErrorText(code: LocalUnitsErrorCode | string | undefined): string | null {
  if (code === 'cancelled') return null
  return translate((ERR_KEY as Record<string, string>)[code ?? ''] ?? ERR_KEY.io)
}

/** 「在访达中显示」按平台换字(Windows 资源管理器、Linux 文件管理器)。 */
export function revealLabelKey(platform: string | undefined = window.tangu?.platform): string {
  if (platform === 'win32') return 'unit.local.revealWin'
  if (platform === 'darwin') return 'unit.local.revealMac'
  return 'unit.local.revealLinux'
}

/** 回包像不像快照(主进程版本不对、半截回包 → 不认,当读不出)。 */
function isSnapshot(x: unknown): x is LocalUnitsSnapshot {
  if (!x || typeof x !== 'object') return false
  const s = x as Partial<LocalUnitsSnapshot>
  const selfOk = !!s.self && (s.self.kind === 'default' || (s.self.kind === 'folder' && typeof s.self.id === 'string'))
  return selfOk && Array.isArray(s.units) && (s.registry === 'ok' || s.registry === 'unreadable')
    && typeof s.defaultParent === 'string' && typeof s.defaultParentDisplay === 'string'
}

export interface LocalUnitsState {
  /** 最近一次读到的快照;null = 还没读到过。 */
  snapshot: LocalUnitsSnapshot | null
  /** 最近一次 list() 失败(抛错 / 回包不对):界面按「读不出」画,沿用 snapshot 里的 self。 */
  failed: boolean
  refresh: () => Promise<void>
}

let seq = 0
let unhook: (() => void) | null = null
let hookedApi: LocalUnitsApi | null = null

export const useLocalUnits = create<LocalUnitsState>((set) => ({
  snapshot: null,
  failed: false,
  refresh: async () => {
    const api = window.tangu?.localUnits
    if (!api) return
    if (hookedApi !== api) {
      unhook?.()
      hookedApi = api
      try { unhook = api.onChanged(() => { void useLocalUnits.getState().refresh() }) } catch { unhook = null }
    }
    const my = ++seq
    let snap: unknown
    try { snap = await api.list() } catch { snap = undefined }
    if (my !== seq) return
    if (isSnapshot(snap)) set({ snapshot: snap, failed: false })
    else set({ failed: true })
  },
}))

/** 测试用:清掉缓存和 onChanged 订阅(换了 window.tangu 之后)。 */
export function resetLocalUnitsForTest(): void {
  unhook?.()
  unhook = null
  hookedApi = null
  seq++
  useLocalUnits.setState({ snapshot: null, failed: false })
}

/** 调一次本机 Unit 接口:抛错 / 回包不对 → io;调完顺手刷新一次快照(onChanged 之外的保险)。 */
export async function localUnitCall<T extends object = object>(run: (api: LocalUnitsApi) => Promise<LocalUnitsResult<T>>): Promise<LocalUnitsResult<T>> {
  const api = window.tangu?.localUnits
  if (!api) return { ok: false, code: 'io' }
  try {
    const r = await run(api)
    if (r && typeof r === 'object' && typeof (r as { ok?: unknown }).ok === 'boolean') return r
    return { ok: false, code: 'io' }
  } catch {
    return { ok: false, code: 'io' }
  } finally {
    void useLocalUnits.getState().refresh()
  }
}

/** 「添加到桌面」的图标字形:和面板行同一套取值(emoji / 宿主图标名 / 空 = 文件夹)。 */
export function localUnitGlyph(icon: string | null | undefined): AppIconGlyph {
  const v = (icon ?? '').trim()
  const Named = v ? vocabIcon(v) : undefined
  if (Named) return { kind: 'component', Icon: Named as unknown as NonNullable<SpaceDefinition['icon']> }
  if (v) return { kind: 'emoji', text: Array.from(v).slice(0, 8).join('') }
  return { kind: 'component', Icon: Folder as unknown as NonNullable<SpaceDefinition['icon']> }
}

/** 把这台本机 Unit 放到桌面:图标在这里画好交过去(主进程只认 id,名字按标记文件取)。 */
export async function addLocalUnitToDesktop(u: Pick<LocalUnitRow, 'id' | 'icon'>): Promise<LocalUnitsResult> {
  const iconPng = await renderAppIconPng(localUnitGlyph(u.icon)).catch(() => undefined)
  return localUnitCall((api) => api.addToDesktop(u.id, { ...(iconPng ? { iconPng } : {}), fallbackName: translate('unit.local.fallbackName') }))
}

/** 标记文件里的图标:宿主图标名 → 那枚线条图标;别的非空串 → 当 emoji 画;空 → 文件夹。 */
export function LocalUnitIcon({ icon, size = 14 }: { icon?: string | null; size?: number }): React.ReactElement {
  const v = (icon ?? '').trim()
  if (!v) return <Folder size={size} />
  const Named = vocabIcon(v)
  if (Named) return <Named size={size} />
  return <span className="unitsw-emoji" aria-hidden="true">{v}</span>
}
