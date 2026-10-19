// 笔记顶栏(.amx-toolbar)里的「文档 | 画布」胶囊(用户 2026-08-17 拍板:跟路径/分享/置顶同一行)。
//
// 2026-10-19 起是视图模式标准的公共零件(lcl `ViewModeSwitch`,方案 docs/ToBeImproved/视图模式切换标准方案_2026-10-19 选 A):
// 外观照旧(两格 118×24、最左),UnifiedPage 另把同一份 `useViewModes` 登记给 ⌥⌘V 与命令面板。
//
// ── 为什么是 portal,而不是「状态进店 + 顶栏按 path 比对」(2026-08-18 改) ──────────────
// 旧写法:UnifiedPage 把 `{path, on, toggle}` 发布进 uiOverlay 的**单个全局槽**,顶栏拿 `barPath`
// 跟它比对后决定画不画。用户实报两次「画布模式看不到胶囊」,第二次给了确定复现:**开机还原到一篇
// md 笔记时必不显示,点过别的笔记才出来**。那个协议有三条各自都能造成这个症状的路,而且都难复现:
//   · `barPath = activePage ?? notePath` —— 只要 activePage 指向别的路径,比对就恒假;
//   · 发布在 effect 里,而订阅方在同一次提交里挂载(生产的顶栏与 UnifiedPage 共用 `unifiedRoute` 这道门);
//   · 单槽多写者:任一实例卸载时清槽,活着的那个不会重新发布。
// (第二条我拿 harness 的 `&udelay` 实测**排除**了;前后两条都还站得住。)
// 与其继续二分,不如把这一整类可能性拿掉:胶囊由 UnifiedPage **自己渲染**,portal 进**它所在那个
// pane 自己的**顶栏插槽。没有路径比对(结构上就是同一个 pane),没有全局槽(没有别的写者),
// 没有先后(插槽找不到就等 MutationObserver,找到即挂)。
import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Frame } from 'lucide-react'
import { ViewModeSwitch, type ViewModesSpec } from '@lcl/engine'
import { registerMessages, translate, useI18n } from '../../i18n'

registerMessages({
  'canvasseg.aria': { zh: '编辑模式', en: 'Editing mode' },
  'canvasseg.doc': { zh: '文档', en: 'Document' },
  'canvasseg.canvas': { zh: '画布', en: 'Canvas' },
})

/** 顶栏里给胶囊留的空位(amadeusViews / harness 各画一个)。 */
export const SEG_SLOT = 'amx-modeseg-slot'

/** 「文档 / 画布」的看法登记(UnifiedPage 的 useViewModes 与顶栏胶囊共用这一份)。 */
export function canvasModesSpec(on: boolean, toggle: () => void): ViewModesSpec {
  return {
    modes: [
      { value: 'doc', label: translate('canvasseg.doc'), icon: FileText },
      { value: 'canvas', label: translate('canvasseg.canvas'), icon: Frame },
    ],
    value: on ? 'canvas' : 'doc',
    onChange: (v) => { if ((v === 'canvas') !== on) toggle() },
    ariaLabel: translate('canvasseg.aria'),
  }
}

/** 有 leafId(在面板里)就画登记的那份(悬停提示带 ⌥⌘V);不在面板里(harness / 嵌入)按传进来的状态画。 */
export function CanvasModeSeg({ on, toggle, leafId }: { on: boolean; toggle: () => void; leafId?: string | null }): React.ReactElement {
  useI18n() // 订阅语言:不在面板里的那条按 translate() 现取名字
  return leafId
    ? <ViewModeSwitch className="amx-modeseg" leafId={leafId} />
    : <ViewModeSwitch className="amx-modeseg" spec={canvasModesSpec(on, toggle)} />
}

/** 把胶囊投进**本 pane** 的顶栏插槽。`anchor` 是 UnifiedPage 自己树里的任意一个在场节点 ——
 *  靠它 `closest('.amx-pane')` 定位到本 pane(分屏下两个 pane 各找各的)。
 *  ⚠️ 插槽可能**晚于**本组件出现(顶栏整块挂在 `barPath` 这道门后面,它要等一次异步分类才落定),
 *  所以找不到时挂 MutationObserver 等,而不是认命返回 null —— 这正是旧写法栽过的那一跤。 */
export function CanvasSegPortal({ anchor, on, toggle, leafId }: {
  anchor: HTMLElement | null
  on: boolean
  toggle: () => void
  leafId?: string | null
}): React.ReactElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const pane = anchor?.closest('.amx-pane') ?? anchor?.ownerDocument?.body
    if (!pane) return
    const find = (): void => setSlot(pane.querySelector<HTMLElement>(`.${SEG_SLOT}`))
    find()
    const mo = new MutationObserver(find)
    mo.observe(pane, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [anchor])
  if (!slot) return null
  return createPortal(<CanvasModeSeg on={on} toggle={toggle} leafId={leafId} />, slot)
}
