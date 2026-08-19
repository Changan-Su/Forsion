// 笔记顶栏(.amx-toolbar)里的「文档 | 画布」胶囊(用户 2026-08-17 拍板:跟路径/分享/置顶同一行)。
//
// **复用**云端/本地那颗 `.t2s-vaultseg`(另一个消费者是 VaultSideSwitch),本仓只补两条:
// 顶栏尺寸(`.amx-modeseg`,在 amadeus/styles.css)与滑块朝右的 `data-side='canvas'`
// (写在 sidebar2.css 组件本体旁,让「本组件认哪些 data-side」只有一处答案)。
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

/** 顶栏里给胶囊留的空位(amadeusViews / harness 各画一个)。 */
export const SEG_SLOT = 'amx-modeseg-slot'

export function CanvasModeSeg({ on, toggle }: { on: boolean; toggle: () => void }): React.ReactElement {
  return (
    <div className="t2s-vaultseg amx-modeseg" role="tablist" aria-label="编辑模式">
      <div className="t2s-vaultseg-thumb" data-side={on ? 'canvas' : 'doc'} />
      <button type="button" role="tab" aria-selected={!on} className={on ? '' : 'on'}
        onClick={() => { if (on) toggle() }}>文档</button>
      <button type="button" role="tab" aria-selected={on} className={on ? 'on' : ''}
        onClick={() => { if (!on) toggle() }}>画布</button>
    </div>
  )
}

/** 把胶囊投进**本 pane** 的顶栏插槽。`anchor` 是 UnifiedPage 自己树里的任意一个在场节点 ——
 *  靠它 `closest('.amx-pane')` 定位到本 pane(分屏下两个 pane 各找各的)。
 *  ⚠️ 插槽可能**晚于**本组件出现(顶栏整块挂在 `barPath` 这道门后面,它要等一次异步分类才落定),
 *  所以找不到时挂 MutationObserver 等,而不是认命返回 null —— 这正是旧写法栽过的那一跤。 */
export function CanvasSegPortal({ anchor, on, toggle }: {
  anchor: HTMLElement | null
  on: boolean
  toggle: () => void
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
  return createPortal(<CanvasModeSeg on={on} toggle={toggle} />, slot)
}
