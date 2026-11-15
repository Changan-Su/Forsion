/** 自动成对的两个本机偏好(设置 → 笔记),缺省都开;只把显式的 `0` 当关。
 *  · 括号和引号:正文(bodyAutoPair.ts)与代码块(codeAutoPair.ts)共用。沿用 R-27 代码块配对那个 key ——
 *    以前关掉代码块配对的人,正文配对也是关的。
 *  · Markdown 符号:选中文字后敲 `* _ ~ = $ %` 包住选区(unified/keyboard.ts 的 wrapSelectionPlugin);关掉 = 照旧替换选区。
 *    `*` `_` 反引号的打字成对要等「行内标记进正文」那一步,到时也挂在这个开关上。 */
import { useSyncExternalStore } from 'react'
import { registerMessages } from '../../../i18n'

registerMessages({
  'settings.notes.autoPairBracketsLabel': { zh: '自动补全括号和引号', en: 'Auto-close brackets and quotes' },
  'settings.notes.autoPairBracketsHint': {
    // ⚠️ 文案里别写花括号:i18nCoverage 按括号配平静态抽取本片段。
    zh: '在正文和代码块里输入左括号或引号时自动补上另一半；紧挨着再输入同一个闭合符号会直接跳过，在空的一对中间退格会把两个一起删掉。',
    en: 'Typing an opening bracket or quote in the body or a code block inserts the closing half. Typing the same closing character next to it steps over it, and Backspace inside an empty pair removes both.',
  },
  'settings.notes.autoPairMarkdownLabel': { zh: '自动补全 Markdown 符号', en: 'Auto-pair Markdown symbols' },
  'settings.notes.autoPairMarkdownHint': {
    zh: '选中文字后输入 * 或 _ 设为斜体，再输入一次变粗体；输入 ~ = $ % 用这个符号把文字包起来，连按两次 ~ 变删除线。关掉后，输入这些符号会替换掉选中的文字。',
    en: 'With text selected, typing * or _ makes it italic and typing it again makes it bold. Typing ~, =, $ or % wraps the text in that symbol, and a second ~ turns it into strikethrough. When this is off, these symbols replace the selected text.',
  },
})

const BRACKETS_KEY = 'amadeus.notes.codeAutoPair'
const MARKDOWN_KEY = 'amadeus.notes.markdownAutoPair'
const BRACKETS_EVENT = 'amadeus:notes-code-autopair'
const MARKDOWN_EVENT = 'amadeus:notes-markdown-autopair'

function read(key: string): boolean {
  try { return localStorage.getItem(key) !== '0' } catch { return true }
}

function write(key: string, event: string, on: boolean): void {
  try { localStorage.setItem(key, on ? '1' : '0') } catch { /* 私有模式:本次会话照样切 */ }
  try { window.dispatchEvent(new Event(event)) } catch { /* 非浏览器环境 */ }
}

function subscribe(key: string, event: string): (fn: () => void) => () => void {
  return (fn) => {
    const onStorage = (e: StorageEvent): void => { if (!e.key || e.key === key) fn() }
    window.addEventListener(event, fn)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(event, fn)
      window.removeEventListener('storage', onStorage)
    }
  }
}

/** 括号和引号自动成对(正文 + 代码块)。每次按键现读,设置里一切换立即生效。 */
export const bracketAutoPairEnabled = (): boolean => read(BRACKETS_KEY)
export const setBracketAutoPairEnabled = (on: boolean): void => write(BRACKETS_KEY, BRACKETS_EVENT, on)
const onBrackets = subscribe(BRACKETS_KEY, BRACKETS_EVENT)
export function useBracketAutoPair(): boolean {
  return useSyncExternalStore(onBrackets, bracketAutoPairEnabled, () => true)
}

/** Markdown 符号(选中后敲 `* _ ~ = $ %` 包住选区)。 */
export const markdownAutoPairEnabled = (): boolean => read(MARKDOWN_KEY)
export const setMarkdownAutoPairEnabled = (on: boolean): void => write(MARKDOWN_KEY, MARKDOWN_EVENT, on)
const onMarkdown = subscribe(MARKDOWN_KEY, MARKDOWN_EVENT)
export function useMarkdownAutoPair(): boolean {
  return useSyncExternalStore(onMarkdown, markdownAutoPairEnabled, () => true)
}
