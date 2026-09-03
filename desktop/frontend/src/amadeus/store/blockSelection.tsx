/** 块选中(Notion 式,非编辑态):点拖拽手柄 / 拖拽 / 空白处框选进入,选中块高亮描边;
 *  键盘:Backspace/Delete 删(可多块)、Cmd+C 复制 md 源文、Cmd+X 剪切、Cmd+V 粘为新块、
 *  Cmd+D 复制块、Enter 回编辑、↑↓ 移动选中(单块)、Esc/点旁处/进入编辑 清除。
 *  多选仅由框选/拖拽产生;跨页残留由 loadPage 清。 */
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { usePageStore } from './pageStore'
import { useUiStore } from './uiStore'
import { marqueeHits } from '../lib/marquee'
import { isEmbedBlock, isWidgetBlock } from '../lib/blockKind'
import { zoomOf } from '../lib/clampMenu'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'blocksel.copiedN': { zh: '已复制 {n} 块', en: '{n} blocks copied' },
  'blocksel.copiedOne': { zh: '已复制块内容', en: 'Block copied' },
  'blocksel.cutN': { zh: '已剪切 {n} 块', en: '{n} blocks cut' },
  'blocksel.cutOne': { zh: '已剪切块', en: 'Block cut' },
})

export const useBlockSelection = create<{
  ids: Set<string>
  activeEmbed: string | null // 正在“二次选中/编辑源码”的嵌入块(![[...]]);同时至多一个
  select(id: string | null): void // 单选(替换)
  setMany(ids: string[]): void // 框选/拖拽多选
  setActiveEmbed(id: string | null): void // 嵌入块进入/退出源码编辑
  clear(): void
}>((set) => ({
  ids: new Set(),
  activeEmbed: null,
  select: (id) => set({ ids: id ? new Set([id]) : new Set(), activeEmbed: null }),
  setMany: (ids) => set({ ids: new Set(ids), activeEmbed: null }),
  setActiveEmbed: (id) => set({ activeEmbed: id }),
  clear: () => set({ ids: new Set(), activeEmbed: null }),
}))

// 换页清选中(残留 id 可能撞上新页顺序号块)。
usePageStore.subscribe((s, prev) => {
  if (s.activePage === prev.activePage) return
  const st = useBlockSelection.getState()
  if (st.ids.size || st.activeEmbed) st.clear()
})

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  if (!el) return false
  return !!el.closest?.('input, textarea, select, [contenteditable="true"], .ProseMirror')
}

// 空白处才起框选:排除块内容/手柄/菜单/交互控件(含列宽拖杆),且须在编辑器内。
const isBlankTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  if (!el || !el.closest?.('.page-view')) return false
  return !el.closest?.(
    '.block-body, .block-gutter, .drag-handle, .block-add, .col-resizer, .ctx-menu, input, textarea, [contenteditable="true"], .ProseMirror, a, button',
  )
}

// deleteBlock 是 async(内部 await backlinks 检查):多块必须串行,否则并发调用各自快照同一
// manifest、后 commit 覆盖前 commit → 只删掉一个 / 留下悬空引用(codex P1)。
async function deleteSerial(ids: string[]): Promise<void> {
  for (const b of ids) await usePageStore.getState().deleteBlock(b)
}

/** 挂在 PageView:选中态键盘处理 + 点旁处清除 + 空白框选(渲染框选矩形)。 */
export function BlockSelectionKeys() {
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeEl = useRef<HTMLDivElement>(null)

  // 键盘 + 点旁处清除
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const ids = [...useBlockSelection.getState().ids]
      if (!ids.length) return
      if (isTypingTarget(e.target)) return // 焦点在输入处:不抢键
      const ps = usePageStore.getState()
      const id = ids[0] // 单块操作的锚点
      if (!ps.blocks[id]) {
        useBlockSelection.getState().clear()
        return
      }
      const mod = e.metaKey || e.ctrlKey
      const stop = (): void => {
        e.preventDefault()
        e.stopPropagation()
      }
      const joined = (): string => ids.map((b) => ps.blocks[b]?.content ?? '').filter(Boolean).join('\n\n')
      if (e.key === 'Escape') {
        stop()
        useBlockSelection.getState().clear()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        stop()
        useBlockSelection.getState().clear()
        void deleteSerial(ids)
      } else if (e.key === 'Enter' && ids.length === 1) {
        stop()
        const content = ps.blocks[id]?.content ?? ''
        if (isEmbedBlock(content)) {
          useBlockSelection.getState().setActiveEmbed(id) // 只读嵌入块:回车进源码编辑(= 双击同款)
        } else if (!isWidgetBlock(content)) {
          useBlockSelection.getState().clear()
          ps.requestFocus(id, 'end') // 文本块:回车回到编辑
        } // 书签等其它 widget:自有改址入口,回车不动
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && ids.length === 1) {
        stop()
        const order = ps.flatOrder()
        const i = order.indexOf(id)
        const next = order[e.key === 'ArrowUp' ? i - 1 : i + 1]
        if (next) {
          // option A:相邻仍是只读块 → 继续选中穿过;是文本块 → 退出选中态、光标落进文本(首/末视觉行)。
          if (isWidgetBlock(ps.blocks[next]?.content ?? '')) {
            useBlockSelection.getState().select(next)
          } else {
            useBlockSelection.getState().clear()
            ps.requestFocus(next, e.key === 'ArrowUp' ? 'end' : 'start')
          }
        }
      } else if (mod && (e.key === 'c' || e.key === 'C')) {
        stop()
        void navigator.clipboard.writeText(joined())
        useUiStore
          .getState()
          .notify(ids.length > 1 ? translate('blocksel.copiedN', { n: ids.length }) : translate('blocksel.copiedOne'))
      } else if (mod && (e.key === 'x' || e.key === 'X')) {
        stop()
        void navigator.clipboard.writeText(joined()).then(() => {
          useBlockSelection.getState().clear()
          void deleteSerial(ids)
        })
        useUiStore
          .getState()
          .notify(ids.length > 1 ? translate('blocksel.cutN', { n: ids.length }) : translate('blocksel.cutOne'))
      } else if (mod && (e.key === 'v' || e.key === 'V') && ids.length === 1) {
        stop()
        void navigator.clipboard.readText().then((t) => {
          const text = t.trim()
          if (!text) return
          const nid = usePageStore.getState().insertBlockAfter(id, undefined, text)
          if (nid) useBlockSelection.getState().select(nid)
        })
      } else if (mod && (e.key === 'd' || e.key === 'D')) {
        stop()
        ids.forEach((b) => ps.duplicateBlock(b))
      }
    }
    const onPointerDown = (e: PointerEvent): void => {
      const st = useBlockSelection.getState()
      if (!st.ids.size && !st.activeEmbed) return
      const el = e.target as HTMLElement | null
      if (el?.closest?.('.ctx-menu')) return
      const host = el?.closest?.('[data-block-id]') as HTMLElement | null
      const hid = host?.dataset.blockId
      if (hid && (st.ids.has(hid) || st.activeEmbed === hid)) return // 点选中块 / 活动嵌入内:保留
      st.clear() // 框选会在移动时重新选中,纯点击则保持清除
    }
    // shift+点击任意块 = 选中整块(拖拽手柄外的快捷选择),与点手柄同为单选替换。
    // 正在编辑本块时放行,交给浏览器原生 shift+点击扩选文本;点手柄本身走其 onClick。
    const onShiftMouseDown = (e: MouseEvent): void => {
      if (!e.shiftKey || e.button !== 0) return
      const el = e.target as HTMLElement | null
      if (el?.closest?.('.block-gutter')) return
      const host = el?.closest?.('[data-block-id]') as HTMLElement | null
      const id = host?.dataset.blockId
      if (!id || host!.contains(document.activeElement)) return
      e.preventDefault() // 拦焦点转移 + 原生取词
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      useBlockSelection.getState().select(id)
      // 吞掉紧随的 click:否则 shift+点击嵌入里的「打开/展开」等按钮会既选中块、又触发其 onClick(Codex L3)。
      const swallow = (ev: Event): void => {
        ev.stopPropagation()
        ev.preventDefault()
        window.removeEventListener('click', swallow, true)
      }
      window.addEventListener('click', swallow, true)
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    }
    // 嵌入块“二次选中→编辑源码”:双击拖拽手柄,或 shift+双击嵌入本体 → 露出可编辑的 ![[…]] 源码行。
    // 嵌入组件本体(画布/图片)的普通双击留给它自己,故本体触发需 shift。
    const onDblClick = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      const host = el?.closest?.('[data-block-id][data-embed]') as HTMLElement | null
      const id = host?.dataset.blockId
      if (!id) return
      const onHandle = !!el?.closest?.('.block-gutter')
      if (!e.shiftKey && !onHandle) return
      // 只有内容确是 ![[...]] 的真嵌入才进源码编辑:书签块也带 data-embed 但无 embedTarget,
      // 否则会存下一个不显示任何 UI 的僵尸 activeEmbed(Codex L4)。
      const content = (usePageStore.getState().blocks[id]?.content ?? '').trim()
      if (!/^!\[\[[^\]\n]+\]\]$/.test(content)) return
      e.preventDefault()
      useBlockSelection.getState().setActiveEmbed(id)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('mousedown', onShiftMouseDown, true)
    window.addEventListener('dblclick', onDblClick, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('mousedown', onShiftMouseDown, true)
      window.removeEventListener('dblclick', onDblClick, true)
    }
  }, [])

  // 空白处框选:pointerdown 记起点,移动超阈值起框,实时相交测试选中块。
  useEffect(() => {
    let start: { x: number; y: number } | null = null
    let active = false
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !isBlankTarget(e.target)) return
      start = { x: e.clientX, y: e.clientY }
      active = false
    }
    const onMove = (e: PointerEvent): void => {
      if (!start) return
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (!active && Math.hypot(dx, dy) < 4) return // 阈值:区分点击与框选
      if (!active) document.body.classList.add('amx-marquee-active') // 框选期禁文本选中
      active = true
      const x = Math.min(start.x, e.clientX)
      const y = Math.min(start.y, e.clientY)
      const box = { x, y, w: Math.abs(dx), h: Math.abs(dy) }
      setRect(box)
      const hits: string[] = []
      document.querySelectorAll<HTMLElement>('.page-view [data-block-id]').forEach((el) => {
        if (el.dataset.blockId && marqueeHits(box, el.getBoundingClientRect())) hits.push(el.dataset.blockId)
      })
      useBlockSelection.getState().setMany(hits)
    }
    const onUp = (): void => {
      const wasActive = active
      start = null
      active = false
      document.body.classList.remove('amx-marquee-active')
      setRect(null)
      if (wasActive) {
        // 吞掉框选尾随的 click:否则 .page-tail 的 onClick 会误插块、别处误清选(codex P3)。
        const swallow = (ev: Event): void => {
          ev.stopPropagation()
          ev.preventDefault()
          window.removeEventListener('click', swallow, true)
        }
        window.addEventListener('click', swallow, true)
        setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true) // pointercancel/系统手势也要清理,别漏 body 类(codex P2)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      document.body.classList.remove('amx-marquee-active')
    }
  }, [])

  // rect 是视口 px;fixed 元素在 zoom 祖先里 left/top/宽高都会被再乘一遍 → 整体除掉(见 engine/menuAnchor)。
  // ponytail: 首帧 ref 还是空 → z=1,但那一帧矩形恰好是 0×0(刚按下),看不见,不值得为它多一次 layout effect。
  const z = zoomOf(marqueeEl.current)
  return rect ? (
    <div ref={marqueeEl} className="amx-marquee" style={{ left: rect.x / z, top: rect.y / z, width: rect.w / z, height: rect.h / z }} />
  ) : null
}
