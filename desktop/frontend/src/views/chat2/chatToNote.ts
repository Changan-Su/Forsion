/**
 * 整段对话一键整理成笔记(对标 ChatGPT Space「对话变 Page」,2026-10-01)。会话右键菜单的「整理成笔记」走这里:
 *
 * - 内容:用户 / 助手两侧正文(助手侧 = 复制按钮那份,建议 / 任务 / 作品围栏已摘)拼成对话记录,交给正文 AI 的
 *   `custom` 动作(引擎 `POST /agent/inline`,不落会话、无工具)提炼成一篇独立笔记 —— 不是原文照搬。
 *   不新增引擎动作:旧引擎 / 云端引擎也认 custom,零协议变更。
 * - 落点:库根,文件名 = 模型给的一级标题(剥掉,标题由文件名承担),重名加 `-2`… ;建成即打开(navigateToNote)。
 * - 入口门控:宿主没有 Amadeus 或没有正文 AI(readTangu().complete)就不出菜单项,不画点了没反应的按钮。
 */
import type { UiMessage } from '../../types'
import { useApp } from '../../stores/appStore'
import { notifyApp } from '../../stores/notificationStore'
import { registerMessages, translate } from '../../i18n'
import { readTangu } from '../../amadeus/plugins/tanguSeam'
import { amadeus } from '../../amadeus/api'
import { navigateToNote } from '../../amadeus/store/pageStore'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { amadeusAvailable } from '../../features/runtime'
import { splitSuggestions } from './suggest'

registerMessages({
  'chat.toNote.action': { zh: '整理成笔记', en: 'Turn into note' },
  'chat.toNote.working': { zh: '正在把对话整理成笔记…', en: 'Turning the chat into a note…' },
  'chat.toNote.empty': { zh: '这段对话还没有可整理的内容', en: 'This chat has nothing to turn into a note yet' },
  'chat.toNote.done': { zh: '已整理成笔记「{name}」', en: 'Saved as the note “{name}”' },
  'chat.toNote.failed': { zh: '没能整理成笔记：{reason}', en: 'Couldn’t turn the chat into a note: {reason}' },
  'chat.toNote.workingTail': { zh: '对话较长，只整理最近的部分…', en: 'This chat is long; only the most recent part will be turned into a note…' },
  'chat.toNote.emptyAnswer': { zh: '模型没有返回内容', en: 'the model returned nothing' },
  'chat.toNote.nameTaken': { zh: '同名笔记太多（已试到 -20）', en: 'too many notes with that name (tried up to -20)' },
})

/** 模型读的指令(英文,见 CLAUDE.md 提示词英文化)。⚠️ live 台架 `--only inline` 里有一份同文拷贝,改这里要一起改。 */
export const CHAT_TO_NOTE_INSTRUCTION = [
  'The text in <selection> is a chat transcript between a user and an AI assistant.',
  'Turn it into a standalone, well-organized note that someone can reread later without the chat.',
  'Start with exactly one "# " heading that names the topic.',
  'Keep the conclusions, decisions, facts, numbers, code and step-by-step instructions; drop greetings, filler, retries and back-and-forth.',
  'Use headings, lists and tables where they help. Do not mention that it came from a chat.',
  'Write in the language the user wrote in.',
].join(' ')

/** 引擎 SELECTION_MAX = 20k 字;取**尾部**(结论通常在后面)。
 *  ponytail: 超长对话只看最后 20k 字(开工提示里会说),要整段就得改成分段提炼再合并。 */
const TRANSCRIPT_MAX = 20_000

function fullTranscript(messages: UiMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = (m.role === 'assistant' ? splitSuggestions(m.content).text : m.content).trim()
    if (text) parts.push(`${m.role === 'user' ? 'User' : 'Assistant'}:\n${text}`)
  }
  return parts.join('\n\n')
}

export function transcriptOf(messages: UiMessage[]): string {
  const all = fullTranscript(messages)
  return all.length > TRANSCRIPT_MAX ? all.slice(-TRANSCRIPT_MAX) : all
}

/** 模型给的 markdown → { 标题, 正文 }:首个一级标题当文件名并从正文剥掉;没有就用 fallback。 */
export function splitNoteTitle(md: string, fallback: string): { title: string; body: string } {
  const m = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(md)
  const raw = m ? m[1] : fallback
  const title = raw.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback
  return { title, body: (m ? md.slice(m[0].length) : md).replace(/^\s*\n/, '') }
}

export function canTurnChatIntoNote(): boolean {
  return amadeusAvailable() && !!readTangu()?.complete
}

/** 只新建、不覆盖(create:true = 宿主原子的仅新建);重名依次试 `-2`…`-20`。返回落盘路径,全被占 → null。 */
async function writeFresh(title: string, md: string): Promise<string | null> {
  for (let n = 1; n <= 20; n++) {
    const path = `${n === 1 ? title : `${title}-${n}`}.md`
    if ((await amadeus.readTextFile?.(path)?.catch(() => null)) != null) continue
    const r = await amadeus.writeTextFile(path, md, { create: true, base: textFingerprint('') })
    if (r && r.ok === false) continue
    return path
  }
  return null
}

export async function turnChatIntoNote(sessionId: string): Promise<boolean> {
  const complete = readTangu()?.complete
  if (!complete) return false
  const app = useApp.getState()
  const session = [...app.sessions, ...app.archivedSessions].find((s) => s.id === sessionId)
  try {
    // 历史读取也在 try 里:失败要走下面的失败回执(调用方 void 掉了 Promise,漏在外面 = 用户什么也看不到)。
    if (!app.messagesBySession[sessionId]?.length) await app.loadSessionHistory(sessionId)
    const msgs = useApp.getState().messagesBySession[sessionId] || []
    const transcript = transcriptOf(msgs)
    if (!transcript) {
      notifyApp({ text: translate('chat.toNote.empty'), level: 'info', inAppOnly: true })
      return false
    }
    // 截了尾就明说(Codex 评审:超长对话只看最后 20k 字,不说的话用户以为整段都进了笔记)。
    notifyApp({ text: translate(fullTranscript(msgs).length > TRANSCRIPT_MAX ? 'chat.toNote.workingTail' : 'chat.toNote.working'), level: 'info', inAppOnly: true })
    const r = await complete({ action: 'custom', instruction: CHAT_TO_NOTE_INSTRUCTION, selection: transcript, title: session?.title || undefined })
    if (!r.text.trim()) throw new Error(translate('chat.toNote.emptyAnswer'))
    const { title, body } = splitNoteTitle(r.text, session?.title?.trim() || translate('amadeus.default.note'))
    const path = await writeFresh(title, body.trimEnd() + '\n')
    if (!path) throw new Error(translate('chat.toNote.nameTaken'))
    notifyApp({ text: translate('chat.toNote.done', { name: title }), level: 'success', receipt: true })
    navigateToNote(path)
    return true
  } catch (e) {
    notifyApp({ text: translate('chat.toNote.failed', { reason: e instanceof Error ? e.message : String(e) }), level: 'error', inAppOnly: true })
    return false
  }
}
