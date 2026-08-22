/** 「当前这篇笔记」的只读派生(大纲 / 字数)—— v3 与 v4 两条路由统一在此。
 *
 *  v3:正文在 pageStore 的 blocks 里,标题按块序扫,跳转靠 `[data-block-id]`。
 *  v4:activePage 恒为 null、正文活在 UnifiedPage 私有的 pipe 里(**根本不进 store**),
 *      所以要经 unified/lifecycle 的接缝去现问那一份实例。
 *
 *  刷新节拍:`linkGraphVersion`(v4 每次落盘 bump,防抖 800ms)+ unified 实例集合的版本
 *  (实例挂载/卸载)。即 v4 的大纲/字数在停手约 1s 后跟上,与反链/图谱同一节拍。 */
import { useMemo, useSyncExternalStore } from 'react'
import { usePageStore, v4PathOf } from '../store/pageStore'
import { subscribeUnified, unifiedBody, unifiedGen, unifiedHeadings, unifiedRevealHeading } from '../unified/lifecycle'

export interface OutlineHead {
  level: number
  text: string
  key: string
  /** 点击跳转(两条路由各自的落点封在这里,调用方不再分叉)。 */
  go: () => void
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/

/** 当前这篇是不是 v4(判据单源 = pageStore.v4PathOf,插件块表面用的是同一条)。 */
function useV4Path(): string | null {
  const activePage = usePageStore((s) => s.activePage)
  const notePath = usePageStore((s) => s.activeNotePath)
  return v4PathOf({ activePage, activeNotePath: notePath })
}

export function useNoteOutline(): OutlineHead[] {
  const v4Path = useV4Path()
  const manifest = usePageStore((s) => s.manifest)
  const blocks = usePageStore((s) => s.blocks)
  const version = usePageStore((s) => s.linkGraphVersion)
  const instances = useSyncExternalStore(subscribeUnified, unifiedGen, unifiedGen)
  return useMemo<OutlineHead[]>(() => {
    if (v4Path) {
      return (unifiedHeadings(v4Path) ?? []).map((h, i) => ({
        level: h.level,
        text: h.text,
        key: `u:${i}`,
        go: () => unifiedRevealHeading(v4Path, i, h.text), // 带文本复核:序号在这之间可能已漂
      }))
    }
    if (!manifest) return []
    const out: OutlineHead[] = []
    for (const row of manifest.root.children)
      for (const col of row.columns)
        for (const ref of col.children)
          for (const line of (blocks[ref.ref]?.content ?? '').split('\n')) {
            const m = HEADING_RE.exec(line.trim())
            if (m) out.push({
              level: m[1].length,
              text: m[2],
              key: `${ref.ref}:${out.length}`,
              go: () => document.querySelector(`[data-block-id="${ref.ref}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
            })
          }
    return out
    // version / instances 只作刷新触发器,不参与计算。
  }, [v4Path, manifest, blocks, version, instances])
}

/** 当前这篇的字符数(不计空白);没有打开的笔记 → null。 */
export function useNoteChars(): number | null {
  const v4Path = useV4Path()
  const activePage = usePageStore((s) => s.activePage)
  const blocks = usePageStore((s) => s.blocks)
  const version = usePageStore((s) => s.linkGraphVersion)
  const instances = useSyncExternalStore(subscribeUnified, unifiedGen, unifiedGen)
  return useMemo(() => {
    if (v4Path) {
      const body = unifiedBody(v4Path)
      return body == null ? null : body.replace(/\s/g, '').length
    }
    if (!activePage) return null
    return Object.values(blocks).map((b) => b.content).join(' ').replace(/\s/g, '').length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v4Path, activePage, blocks, version, instances])
}
