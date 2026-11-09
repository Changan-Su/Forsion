/**
 * `ctx.spaces`(2026-10-18,主页插件化 S3 / S4):Space 列表、打开、图标、近况那一行、商店 / 成就两格,以及 Ribbon 上区的收纳架。
 * 收纳架写的就是 Ribbon 那一份(views/homeShelf,内置主页也用它),不另存。manifest 声明 `spaces` 才注入(改的是用户的 Ribbon)。
 */
import { label, openObject, openObjectMenu, spaceOpensElsewhere, useRibbonStore, useSpaceStore, type SheetMenuItem } from '@lcl/engine'
import { claimHostMount, mountHostReact } from '@lcl/components'
import type { PluginContext } from './types'
import { RIBBON_ACTION_PREFIX } from './ribbonAction'
import { pluginText } from './pluginText'
import {
  shelfAddFolder, shelfMove, shelfMoveIntoFolder, shelfMoveOut, shelfRemoveFolder, shelfRenameFolder, shelfReorderFolder, shelfTiles,
} from '../../views/homeShelf'

/** 商店、成就两格(Ribbon 条目 id);2026-11-09 起后面再接首方 Ribbon 动作(`rb-plugin-*`,活动中心等,和内置主页的坞同一份)。 */
const ACTIONS = ['rb-market', 'rb-achievements'] as const

type Api = NonNullable<PluginContext['spaces']>

/** Space 的图标,不是 Space 就找 Ribbon 条目(商店 / 成就)。 */
function SpaceIcon({ id, size }: { id: string; size: number }) {
  const space = useSpaceStore((s) => s.spaces.find((x) => x.id === id)?.icon)
  const item = useRibbonStore((s) => s.items.find((i) => i.id === id)?.icon)
  const Icon = space ?? item
  return Icon ? <Icon size={size} /> : null
}

export function createSpacesApi({ alive, own }: { alive: () => boolean; own: (off: () => void) => () => void }): Api {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    list: () => useSpaceStore.getState().spaces.map((s) => ({ id: s.id, name: label(s.name) })),
    subscribe: (cb) => {
      if (!alive() || typeof cb !== 'function') return () => {}
      const fire = (): void => { if (alive()) cb() }
      const a = useSpaceStore.subscribe((s, p) => { if (s.spaces !== p.spaces || s.activeSpaceId !== p.activeSpaceId) fire() })
      const b = useRibbonStore.subscribe((s, p) => { if (s.order !== p.order || s.folders !== p.folders || s.items !== p.items) fire() })
      return own(() => { a(); b() })
    },
    // 走对象层的打开(objects/space.tsx):本窗口是锁在某个 Space 上的 Space 窗口时,开到它自己的窗口(同 Ribbon、主页)
    open: async (id) => {
      const sid = str(id)
      if (!alive() || !useSpaceStore.getState().spaces.some((s) => s.id === sid)) return false
      if (!(await openObject({ type: 'space', id: sid }, 'here', { kind: 'plugin' })).ok) return false
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      return true
    },
    // 跟着 store 走:同 id 重注册换了图标(插件更新 iconFile)就原地重画,挂的时候还没注册的等它注册上;退订在树里,卸载一起走
    mountIcon: (el, id, opts) => {
      if (!(el instanceof HTMLElement)) throw new TypeError('mountIcon needs an HTMLElement')
      if (!alive()) return () => {}
      const size = typeof opts?.size === 'number' && opts.size > 0 ? Math.min(opts.size, 256) : 20
      return own(mountHostReact(el, <SpaceIcon id={str(id)} size={size} />).dispose)
    },
    // 近况那一行由宿主画进 el、跟着数据自己更新(日历那一行只在有人挂着时才去读日历库)
    mountStatus: (el, id) => {
      if (!(el instanceof HTMLElement)) throw new TypeError('mountStatus needs an HTMLElement')
      if (!alive()) return () => {}
      let off: (() => void) | null = null, cancelled = false
      const mine = claimHostMount(el)
      void import('../../views/homeCardStatus').then((m) => {
        if (cancelled || !mine()) return
        off = m.mountCardStatus(el, str(id))
      }, (e) => console.error('[spaces] status mount failed', e))
      return own(() => { cancelled = true; off?.(); off = null })
    },
    actions: () => {
      const items = useRibbonStore.getState().items
      const ids = [...ACTIONS, ...items.filter((i) => i.id.startsWith(RIBBON_ACTION_PREFIX)).map((i) => i.id)]
      return ids.flatMap((id) => {
        const item = items.find((i) => i.id === id)
        return item ? [{ id, name: item.tooltip ? label(item.tooltip) : '', run: () => { if (alive()) item.onClick?.() } }] : []
      })
    },
    // 对象层那份 Space 菜单(和 Ribbon、主页、收纳面板同一份)+ 插件这一处的几项;行的清洗同 ctx.ui.contextMenu 的口径(最多 20 行)
    contextMenu: (event, id, extra) => {
      const sid = str(id)
      if (!alive() || !event || typeof (event as MouseEvent).clientX !== 'number') return false
      if (!useSpaceStore.getState().spaces.some((s) => s.id === sid)) return false
      const rows: SheetMenuItem[] = (Array.isArray(extra) ? extra : []).slice(0, 20).flatMap((it, i) => {
        if (!it || typeof it.run !== 'function') return []
        const text = pluginText(it.label).trim().slice(0, 80)
        if (!text) return []
        const run = it.run
        return [{
          id: `plugin-${i}`, label: text, danger: !!it.danger, disabled: !!it.disabled,
          ...(typeof it.checked === 'boolean' ? { checked: it.checked } : {}),
          run: () => { if (alive()) try { run() } catch (e) { console.error('[spaces] menu item threw', e) } },
        }]
      })
      const target = event.currentTarget instanceof Element ? event.currentTarget : event.target instanceof Element ? event.target : null
      const opened = openObjectMenu({
        refs: [{ type: 'space', id: sid }], place: { kind: 'plugin-space' }, placeSections: rows.length ? [{ items: rows }] : [],
        x: event.clientX, y: event.clientY, returnFocus: target,
      })
      if (opened) { event.preventDefault(); event.stopPropagation() }
      return opened
    },
    opensElsewhere: (id) => spaceOpensElsewhere(str(id)),
    shelf: {
      items: () => {
        const { order, folders } = useRibbonStore.getState()
        return shelfTiles(useSpaceStore.getState().spaces, order, folders).tiles.map((t) => (t.kind === 'space'
          ? { kind: 'space' as const, id: t.id, spaceId: t.space.id, name: label(t.space.name) }
          : { kind: 'folder' as const, id: t.id, name: t.folder.name, spaceIds: t.members.map((m) => m.id) }))
      },
      move: (id, targetId) => { if (alive()) shelfMove(str(id), str(targetId)) },
      moveIntoFolder: (folderId, id) => { if (alive()) shelfMoveIntoFolder(str(folderId), str(id)) },
      moveOutOfFolder: (id) => { if (alive()) shelfMoveOut(str(id)) },
      reorderFolder: (folderId, id, targetId) => { if (alive()) shelfReorderFolder(str(folderId), str(id), str(targetId)) },
      addFolder: (name) => { const n = str(name).trim().slice(0, 60); if (alive() && n) shelfAddFolder(n) },
      renameFolder: (id, name) => { const n = str(name).trim().slice(0, 60); if (alive() && n) shelfRenameFolder(str(id), n) },
      removeFolder: (id) => { if (alive()) shelfRemoveFolder(str(id)) },
    },
  }
}
