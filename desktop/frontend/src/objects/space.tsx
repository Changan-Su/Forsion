/**
 * Space 这类对象的宿主那半(LCL 对象层,正典:仓根 docs/ToBeImproved/LCL对象动作统一方案_2026-11-07)。
 *
 * 一处定义:它是谁(id 校验、名字图标)、点一下去哪(窗口锁写在这里一次)、能对它做什么(打开 / 在新窗口中打开 /
 * 添加到桌面 / 删除)。Ribbon、主位槽、收纳面板、主页、新标签页、手机底栏右键出的都是这一份;
 * 各界面只另给「本处」那几项(移出收纳夹、主位放哪个 Space…)。
 *
 * 打开 Space 的入口(收纳面板、主页、插件 ctx.app.openSpace / ctx.spaces.open、Agent 命令、小组件、forsion:// 深链)
 * 一律走 `openObject({ type: 'space', id })` → 这里的 `open`,于是都认「Space 窗口只开自己」。
 */
import { AppWindow, ArrowUpRight, MonitorDown, Trash2 } from 'lucide-react'
import {
  getDetachApi, label, openObject, pinSpaceToHome, registerObjectAction, registerObjectType, setActiveSpace, switchSpace, useSpaceStore, WINDOW_SPACE_ID,
  OBJECT_REASON, type ActionResult, type ObjectRef, type OpenMode,
} from '@lcl/engine'
import { SPACE_ID_RE } from '../../../shared/spaceAppearance'
import { deleteUserSpace, isUserSpace } from '../userSpaces'
import { registerMessages, translate } from '../i18n'

registerMessages({
  'objects.space.label': { zh: 'Space', en: 'Space' },
  'objects.space.open': { zh: '打开', en: 'Open' },
  'objects.space.openInNewWindow': { zh: '在新窗口中打开', en: 'Open in new window' },
  'objects.space.addToDesktop': { zh: '添加到桌面', en: 'Add to desktop' },
  'objects.space.addToHome': { zh: '添加到主屏幕', en: 'Add to Home screen' },
  'objects.space.delete': { zh: '删除 Space…', en: 'Delete Space…' },
  'objects.space.deleteOk': { zh: '删除', en: 'Delete' },
  'objects.space.gone': { zh: '这个 Space 已经不在了', en: 'This Space no longer exists' },
  'objects.space.changed': { zh: '这个 Space 刚刚变过，请重新打开菜单再试', en: 'This Space just changed. Open the menu again and retry.' },
})

export const SPACE = 'space'
export const spaceRef = (id: string): ObjectRef => ({ type: SPACE, id })
export const isSpaceId = (id: string): boolean => SPACE_ID_RE.test(id)

const spaceDef = (id: string) => useSpaceStore.getState().spaces.find((s) => s.id === id)

/** 这个 Space 点一下会开到它自己的窗口去(本窗口是锁在别的 Space 上的 Space 窗口)。主页据此决定要不要先放离场动效。 */
export function spaceOpensElsewhere(id: string): boolean {
  return !!WINDOW_SPACE_ID && WINDOW_SPACE_ID !== id && !!getDetachApi()?.openSpace
}

/** 点一下 = 进这个 Space;Space 窗口锁在自己的 Space 上切不走,改成把它开到它自己的窗口(原 launchSpace 的口径)。
 *  `animate`:人在菜单里点的「打开」走带推移动效的 switchSpace;程序入口(openObject:插件、Agent、深链、主页磁贴)
 *  保持同步的 setActiveSpace —— 切完要接着在新 Space 里开东西(见 spaceTransition.ts 顶注)。 */
function openSpace(id: string, how: OpenMode, animate = false): void {
  const api = getDetachApi()
  if (how === 'newWindow' || spaceOpensElsewhere(id)) {
    if (!api?.openSpace) throw new Error(OBJECT_REASON.unavailable)
    api.openSpace(id)
    return
  }
  if (WINDOW_SPACE_ID && WINDOW_SPACE_ID !== id) throw new Error(OBJECT_REASON.unavailable) // 锁着又开不了窗:不悄悄切走
  if (animate) switchSpace(id)
  else setActiveSpace(id)
}

/** 进一个 Space(调用方不关心结果时用)。 */
export function launchSpace(id: string): void { void openObject(spaceRef(id)) }

let installed = false
export function installSpaceObject(): void {
  if (installed) return
  installed = true

  registerObjectType({
    type: SPACE,
    label: () => translate('objects.space.label'),
    isValidId: isSpaceId,
    info: (ref) => {
      const def = spaceDef(ref.id)
      return def ? { title: label(def.name), icon: def.icon } : undefined
    },
    subscribe: (cb) => useSpaceStore.subscribe((s, p) => { if (s.spaces !== p.spaces) cb() }),
    openModes: ['here', 'newWindow'],
    open: (ref, how) => openSpace(ref.id, how),
    // 定义对象本身当版本:同 id 重新注册(配方更新、删了又建一个同名的)就不是弹菜单时那个了
    snapshot: (ref) => spaceDef(ref.id),
    verify: (ref, snap) => {
      const def = spaceDef(ref.id)
      if (!def) return translate('objects.space.gone')
      return snap !== undefined && snap !== def ? translate('objects.space.changed') : null
    },
    uri: (ref) => `forsion://space/${encodeURIComponent(ref.id)}`,
  })

  registerObjectAction({
    id: 'space.open',
    types: [SPACE],
    group: 'open',
    order: 0,
    icon: ArrowUpRight,
    title: () => translate('objects.space.open'),
    // 只在「就地切过去」有意义时列:当前就在它里面不列;Space 窗口里点它会开新窗口,和下一项重复,也不列
    when: ([r]) => !WINDOW_SPACE_ID && r.id !== useSpaceStore.getState().activeSpaceId,
    run: ([r]) => openSpace(r.id, 'here', true),
  })

  registerObjectAction({
    id: 'space.openInNewWindow',
    types: [SPACE],
    group: 'open',
    order: 1,
    icon: AppWindow,
    title: () => translate('objects.space.openInNewWindow'),
    when: (_refs, cx) => cx.caps.openWindow,
    run: ([r]) => openSpace(r.id, 'newWindow'),
  })

  // 同一件事两种执行:电脑上放桌面快捷方式,手机上钉到主屏(原来是两个接缝、两处菜单)
  registerObjectAction({
    id: 'space.addToDesktop',
    types: [SPACE],
    group: 'share',
    icon: MonitorDown,
    title: (_refs, cx) => translate(cx.caps.desktopShortcut ? 'objects.space.addToDesktop' : 'objects.space.addToHome'),
    when: (_refs, cx) => cx.caps.desktopShortcut || cx.caps.pinHome,
    run: ([r], cx) => {
      const add = getDetachApi()?.addSpaceToDesktop
      if (cx.caps.desktopShortcut && add) { add(r.id); return }
      const def = spaceDef(r.id)
      if (!def || !pinSpaceToHome(r.id, label(def.name))) throw new Error(OBJECT_REASON.unavailable)
    },
  })

  registerObjectAction({
    id: 'space.delete',
    types: [SPACE],
    group: 'danger',
    icon: Trash2,
    title: () => translate('objects.space.delete'),
    // 只有用户自己建的 Space 能删;插件带来的 Space 跟着插件走
    when: ([r]) => isUserSpace(r.id),
    confirm: ([r]) => ({
      title: translate('spaces.deleteConfirm', { name: label(spaceDef(r.id)?.name ?? r.id) }),
      confirm: translate('objects.space.deleteOk'),
      danger: true,
    }),
    // deleteUserSpace 失败时自己 toast 过了(ipcErrorText),这里不再报一次
    run: async ([r]): Promise<ActionResult[]> => [(await deleteUserSpace(r.id)) ? { ref: r, ok: true } : { ref: r, ok: false, reason: OBJECT_REASON.reported }],
  })
}
