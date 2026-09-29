/**
 * 助手回答一键插回笔记(评审 G3-08;对话方案 D22 承诺的「保存到笔记」)。聊天操作行的「插入笔记」按钮走这里:
 *
 * - 落点:这条对话若由「问 Tangu」(G3-04)从某篇笔记的选区 / 块发起,那篇开着就插回那篇、落在被引用块之后;
 *   否则插进**最近用过**的那篇 v4 笔记实例(lifecycle 的 lastActive 口径,G1-02),光标所在顶层块之后,
 *   正文没被聚焦过就插在文末。只读 / 锁定 / 源码模式的实例不接。编辑器那半见 UnifiedPage 的 insertReply。
 * - 内容:摘掉建议 / 任务 / 作品围栏的正文(= 复制按钮给的那份;工具卡与思考本就不在正文里),公式定界符按聊天渲染
 *   同一口径归一(\( \) → $),由编辑器自己的解析器一个事务写入(Cmd+Z 一步撤回)。
 * - 只在点击时写;写完一条带「撤销」的回执,点名落到了哪篇。
 */
import { useSyncExternalStore } from 'react'
import type { UiMessage } from '../../types'
import { normalizeMath } from '../../services/mathNormalize'
import { subscribeUnified, unifiedHasAny, unifiedHasReplyTarget, unifiedInsertReply, type ReplyAnchor } from '../../amadeus/unified/lifecycle'
import { notifyApp } from '../../stores/notificationStore'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'chat.action.insertNote': { zh: '插入笔记', en: 'Insert into note' },
  'chat.insertNote.none': { zh: '没有可写入的笔记：开着的笔记是只读或已锁定', en: 'No writable note: the open notes are read-only or locked' },
  'chat.insertNote.done': { zh: '已插入「{name}」', en: 'Inserted into “{name}”' },
  'chat.insertNote.failed': { zh: '没能插入：笔记是只读、已锁定或处在源码模式', en: 'Couldn’t insert: the note is read-only, locked, or in source mode' },
  'chat.insertNote.undo': { zh: '撤销', en: 'Undo' },
  'chat.insertNote.undoStale': { zh: '笔记之后又有改动，请在笔记里撤销', en: 'The note has changed since — undo it in the note' },
})

/** 「问 Tangu」发起的出处:哪篇 + 标题锚 + 被引用的原文。 */
export interface AskOrigin {
  path: string
  anchor: ReplyAnchor
}

// Composer 把引用条拼成 `> 行` 前缀(composeOutgoing);askTanguQuote 的末行是 `— [[路径#标题]]`。
const ORIGIN_RE = /^> — \[\[([^\]|#\n]+)(?:#([^\]|\n]+))?\]\]\s*$/

/** 一条用户消息里的「问 Tangu」出处;没有 → null。原文 = 出处行之前连着的那几行引用(去掉 `> `)。 */
export function parseAskOrigin(content: string): AskOrigin | null {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = ORIGIN_RE.exec(lines[i])
    if (!m) continue
    const quoted: string[] = []
    for (let k = i - 1; k >= 0 && lines[k].startsWith('>'); k--) quoted.unshift(lines[k].replace(/^> ?/, ''))
    const heading = m[2]?.trim()
    const text = quoted.join('\n').trim()
    return { path: m[1].trim(), anchor: { ...(heading ? { heading } : {}), ...(text ? { text } : {}) } }
  }
  return null
}

/** assistantId 那条回答所在的对话由哪次「问 Tangu」发起:往回找最近一条带出处的用户消息(追问几轮后插回的也算)。 */
export function askOriginOf(messages: UiMessage[], assistantId: string): AskOrigin | null {
  const at = messages.findIndex((m) => m.id === assistantId)
  for (let i = (at < 0 ? messages.length : at) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const hit = parseAskOrigin(m.content)
    if (hit) return hit
  }
  return null
}

/** 要插进笔记的 markdown:正文原样(代码块 / 公式保留),公式定界符与聊天渲染同口径。 */
export function replyMarkdown(body: string): string {
  return normalizeMath(body).trim()
}

function noteName(path: string): string {
  return (path.split('/').pop() || path).replace(/\.md$/i, '')
}

/** 点「插入笔记」。返回是否插进去了(测试 / 调用方用;提示已在这里发)。 */
export function insertReplyToNote(body: string, origin: AskOrigin | null): boolean {
  const md = replyMarkdown(body)
  if (!md) return false
  if (!unifiedHasReplyTarget()) {
    notifyApp({ text: translate('chat.insertNote.none'), level: 'info', inAppOnly: true })
    return false
  }
  const done = unifiedInsertReply(md, origin)
  if (!done) {
    notifyApp({ text: translate('chat.insertNote.failed'), level: 'warning', inAppOnly: true })
    return false
  }
  notifyApp({
    text: translate('chat.insertNote.done', { name: noteName(done.path) }),
    level: 'success',
    receipt: true,
    durationMs: 8000,
    action: {
      label: translate('chat.insertNote.undo'),
      run: () => {
        if (!done.undo()) notifyApp({ text: translate('chat.insertNote.undoStale'), level: 'info', inAppOnly: true })
      },
    },
  })
  return true
}

/** 按钮的三态(实例挂上 / 卸下时刷新,锁定 = 换 key 重挂同样会通知):
 *  hidden = 一篇 v4 笔记都没开(不出按钮;Mini / 浮窗 / 手机上每条回答挂个灰按钮只是噪音,用户 09-29 拍板);
 *  disabled = 开着的全是只读 / 锁定(灰态,点了说明);ready = 有能接的(源码模式点了再说明,不另算一态)。 */
export type NoteInsertState = 'hidden' | 'disabled' | 'ready'
const insertState = (): NoteInsertState => (!unifiedHasAny() ? 'hidden' : unifiedHasReplyTarget() ? 'ready' : 'disabled')
export function useNoteInsertState(): NoteInsertState {
  return useSyncExternalStore(subscribeUnified, insertState)
}
