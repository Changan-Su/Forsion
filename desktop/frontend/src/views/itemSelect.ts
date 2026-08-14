/**
 * 工作区三档列表(会话 / 文件树 / 笔记树)共用的「点击语义 + 多选」。
 *
 * 一套判据只写这一处(用户拍板的统一交互):
 *   裸击          = 打开 + 只选它
 *   ⌘ / Ctrl 击   = 在新标签页打开(选中同裸击)
 *   shift 击      = 不打开,从锚点到本项的**连续范围**
 *   option/alt 击 = 不打开,逐个加/减选(即 Finder 里 ⌘ 的角色 —— ⌘ 在这儿被指派给了新标签页)
 *
 * range 的顺序**取自 DOM**(容器内 [data-sel-id] 的文档序):三棵树都是惰性展开的,父组件手里
 * 根本没有「当前可见项」的线性表,而 DOM 顺序恰好就是用户眼里从上到下的顺序 —— 用它,免得为了
 * 一个 shift 范围去把三棵树的展开态全部提升到父组件。
 */
import { useRef, useState, type RefObject } from 'react'

export interface ClickMods { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }
export type SelectMode = 'replace' | 'toggle' | 'range'
export interface ClickAct {
  /** same=就地打开;new=新标签页;none=只动选中态(shift/alt)。 */
  open: 'same' | 'new' | 'none'
  select: SelectMode
}

/** 修饰键 → 动作。优先级 shift > alt > ⌘/Ctrl(组合键按更「保守」的那个算:只选中,不打开)。 */
export function clickAct(e: ClickMods): ClickAct {
  if (e.shiftKey) return { open: 'none', select: 'range' }
  if (e.altKey) return { open: 'none', select: 'toggle' }
  if (e.metaKey || e.ctrlKey) return { open: 'new', select: 'replace' }
  return { open: 'same', select: 'replace' }
}

/** 纯函数:算点击后的新选中集与新锚点。ids = 当前可见项的顺序(仅 range 用得上)。 */
export function nextSelection(
  prev: string[],
  anchor: string | null,
  id: string,
  mode: SelectMode,
  ids: string[],
): { sel: string[]; anchor: string | null } {
  if (mode === 'toggle') {
    const has = prev.includes(id)
    // 取消选中时锚点不动:接着 shift 点仍以原锚点拉范围(取消掉的那项本来也不该当锚)。
    return { sel: has ? prev.filter((x) => x !== id) : [...prev, id], anchor: has ? anchor : id }
  }
  if (mode === 'range') {
    const a = anchor && ids.includes(anchor) ? anchor : id
    const i = ids.indexOf(a)
    const j = ids.indexOf(id)
    if (i < 0 || j < 0) return { sel: [id], anchor: id } // 项不在可见表里(树收起了)→ 退化成单选
    // 锚点**保持不动**:连着 shift 点不同的项 = 反复改同一个范围,这才是 Finder/VSCode 的手感。
    return { sel: ids.slice(Math.min(i, j), Math.max(i, j) + 1), anchor: a }
  }
  return { sel: [id], anchor: id }
}

export interface ItemSelect {
  /** 当前选中项(range 时按可见顺序,其余按点击先后)。 */
  ids: string[]
  has(id: string): boolean
  /** 处理一次行点击:更新选中态,返回该开不开、开哪儿(调用方自己去开)。 */
  click(id: string, e: ClickMods): ClickAct
  /** 右键/操作的「作用集合」:id 已在多选里 → 整批;否则就它自己。 */
  batch(id: string): string[]
  /** 改成只选 id(右键落在未选中项上时用)。 */
  only(id: string): void
  clear(): void
}

/** scope = 装着这些行的容器 ref;行上打 data-sel-id 即可(range 顺序、清选都靠它)。 */
export function useItemSelect(scope: RefObject<HTMLElement | null>): ItemSelect {
  const [ids, setIds] = useState<string[]>([])
  const anchor = useRef<string | null>(null)
  const cur = useRef(ids)
  cur.current = ids

  const visible = (): string[] =>
    Array.from(scope.current?.querySelectorAll<HTMLElement>('[data-sel-id]') ?? [])
      .map((el) => el.dataset.selId ?? '')
      .filter(Boolean)

  const set = (next: string[], a: string | null): void => { cur.current = next; anchor.current = a; setIds(next) }

  return {
    ids,
    has: (id) => ids.includes(id),
    click: (id, e) => {
      const act = clickAct(e)
      const r = nextSelection(cur.current, anchor.current, id, act.select, act.select === 'range' ? visible() : [])
      set(r.sel, r.anchor)
      return act
    },
    batch: (id) => (cur.current.length > 1 && cur.current.includes(id) ? [...cur.current] : [id]),
    only: (id) => set([id], id),
    clear: () => set([], null),
  }
}
