import { useRef, type Dispatch, type SetStateAction } from 'react'
import { create } from 'zustand'
import type { Attachment, SkillInfo } from '../../types'
import type { RefChip } from './Composer2'

/** 一个会话里写了还没发出去的那份输入:输入框里的字,连同挂在它上面的附件 / 引用 / 技能和 @ 选出来的绑定。
 *  它们是一份东西 —— 只按会话存文字的话,切走再回来 `@某人` 三个字还在,绑定却已经被别的会话里的打字清掉了。 */
export interface ComposerDraft {
  text: string
  attachments: Attachment[]
  wsFiles: Attachment[]
  /** 显式加的引用芯片(自动那条是主区当前文件的派生量,不存)。 */
  refChips: RefChip[]
  pinnedSkills: SkillInfo[]
  mentionedSlug: string
  mentionAgents: string[]
  mentionedProjects: Array<{ name: string; path: string }>
}

const EMPTY: ComposerDraft = { text: '', attachments: [], wsFiles: [], refChips: [], pinnedSkills: [], mentionedSlug: '', mentionAgents: [], mentionedProjects: [] }

/** 还没有会话的「新对话」那一份:主页、主区的空白对话、侧栏聊天共用。会话 id 是 UUID,撞不上。 */
export const NEW_CHAT_DRAFT = 'new'

/** 草稿按会话存在这里,输入框(Composer2)只是它的视图:同一个会话开在主区和侧栏是同一份;切会话、关标签、换 Space 都不丢。
 *  ponytail: 只放内存 —— 重启即清,多窗口各一份。要跨重启就把 text 落 localStorage(附件是 base64,别落)。 */
export const useComposerDrafts = create<Record<string, ComposerDraft>>(() => ({}))

export function setDraftField<K extends keyof ComposerDraft>(key: string, field: K, value: SetStateAction<ComposerDraft[K]>): void {
  useComposerDrafts.setState((all) => {
    const cur = all[key] ?? EMPTY
    const next = typeof value === 'function' ? value(cur[field]) : value
    return next === cur[field] ? all : { ...all, [key]: { ...cur, [field]: next } }
  }, true)
}

/** 发出去了 → 清掉那一份。keepText:这次发的不是输入框里的字(实时转写),字留着。 */
export function clearDraft(key: string, keepText = false): void {
  useComposerDrafts.setState((all) => {
    const cur = all[key]
    if (!cur) return all
    const { [key]: _sent, ...rest } = all
    return keepText && cur.text ? { ...rest, [key]: { ...EMPTY, text: cur.text } } : rest
  }, true)
}

const isBlank = (d: ComposerDraft | undefined): boolean =>
  !d || (!d.text && !d.attachments.length && !d.wsFiles.length && !d.refChips.length && !d.pinnedSkills.length)

/** 把一份草稿挪到另一个会话名下;那边已经有东西就不动(谁的草稿都不许被顶掉)。 */
export function moveDraft(from: string, to: string): void {
  useComposerDrafts.setState((all) => {
    const cur = all[from]
    if (from === to || isBlank(cur) || !isBlank(all[to])) return all
    const { [from]: _moved, ...rest } = all
    return { ...rest, [to]: cur }
  }, true)
}

/** 草稿里一个字段的 [值, setter],用法同 useState。setter 写的是**调用那一刻**输入框对着的那个会话(与原先的组件内 state
 *  同语义:语音转写、撤回插话这类迟到的写入落在眼前这个输入框里);要写指定会话用上面三个函数。 */
export function useDraftField<K extends keyof ComposerDraft>(key: string, field: K): [ComposerDraft[K], Dispatch<SetStateAction<ComposerDraft[K]>>] {
  const value = useComposerDrafts((all) => (all[key] ?? EMPTY)[field])
  const keyRef = useRef(key)
  keyRef.current = key
  const set = useRef<Dispatch<SetStateAction<ComposerDraft[K]>>>((v) => setDraftField(keyRef.current, field, v)).current
  return [value, set]
}
