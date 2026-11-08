/**
 * 焦点对象的底座:「此刻对着的是谁」,给命令面板「对当前对象」和对象快捷键用(第二期接)。
 *
 * 按范围(scope:窗口 / 某个 View 的 leaf id)各记一摞,谁申领谁释放(owner token):旧组件卸载只摘自己那条,
 * 不会清掉新组件的焦点。没有全局单例 setter —— 那样旧组件卸载会把新焦点一起清掉(Codex 评审)。
 * 菜单弹出时自己冻结目标(objects.ts freezeRefs),不读这里。
 */
import type { ObjectRef, Place } from './objects'

export interface FocusedObjects { refs: ObjectRef[]; place: Place }

export interface ObjectFocusClaim {
  /** 选中的换了:原地更新自己那条(不改变先后)。 */
  update(refs: ObjectRef[], place?: Place): void
  /** 焦点回到这里:把自己那条挪到最上面。 */
  activate(): void
  /** 只摘自己那条;重复调用无害。 */
  release(): void
}

interface Entry { token: symbol; refs: ObjectRef[]; place: Place }
const stacks = new Map<string, Entry[]>()
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of [...listeners]) { try { l() } catch (e) { console.error('[objectFocus] listener failed', e) } } }

/** 在 scope 里申领焦点(压到最上面)。 */
export function claimObjectFocus(scope: string, refs: ObjectRef[], place: Place): ObjectFocusClaim {
  const token = Symbol(scope)
  const stack = stacks.get(scope) ?? []
  stack.push({ token, refs, place })
  stacks.set(scope, stack)
  emit()
  const find = (): { s: Entry[]; i: number } | null => {
    const s = stacks.get(scope)
    const i = s ? s.findIndex((e) => e.token === token) : -1
    return s && i >= 0 ? { s, i } : null
  }
  return {
    update(next, nextPlace) {
      const f = find()
      if (!f) return
      f.s[f.i] = { token, refs: next, place: nextPlace ?? f.s[f.i].place }
      emit()
    },
    activate() {
      const f = find()
      if (!f || f.i === f.s.length - 1) return
      const [e] = f.s.splice(f.i, 1)
      f.s.push(e)
      emit()
    },
    release() {
      const f = find()
      if (!f) return
      f.s.splice(f.i, 1)
      if (!f.s.length) stacks.delete(scope)
      emit()
    },
  }
}

/** scope 里最上面那条;没有 = null。选中为空的那条也算「对着空」,返回 null,不往下找别人的。 */
export function focusedObjects(scope: string): FocusedObjects | null {
  const s = stacks.get(scope)
  const top = s?.[s.length - 1]
  return top && top.refs.length ? { refs: top.refs, place: top.place } : null
}

export function subscribeObjectFocus(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb) } }

export function __resetObjectFocusForTest(): void { stacks.clear(); listeners.clear() }
