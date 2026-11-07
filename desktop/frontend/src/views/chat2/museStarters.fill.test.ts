// 卜算子建议填进草稿(主页卡和新对话页三行共用 fillStarter,评审 11-07):
// 不冲掉人自己写的字;建议挂的引用芯片在文字删空时摘掉 —— 不靠新对话页组件挂着。
import { afterEach, expect, it } from 'vitest'
import type { MuseStarter } from '../../types'
import { fillStarter } from './MuseStarters'
import { setDraftField, useComposerDrafts } from './composerDrafts'

const KEY = 'test-draft'
const VAULT = '/Users/x/vault'
const note: MuseStarter = { id: 's1', text: '接着写周报', source: { kind: 'note', label: '周报', ref: `${VAULT}/周报.md` } }
const chat: MuseStarter = { id: 's2', text: '回顾昨天那个 bug', source: { kind: 'session', label: '昨天那个 bug', ref: 'abc' } }
const draft = () => useComposerDrafts.getState()[KEY]

afterEach(() => useComposerDrafts.setState({}, true))

it('does not overwrite text the user typed', () => {
  setDraftField(KEY, 'text', '我写到一半的话')
  expect(fillStarter(KEY, note, VAULT)).toBe(false)
  expect(draft().text).toBe('我写到一半的话')
  expect(draft().refChips).toEqual([])
})

it('swaps one untouched suggestion for the next, chip included', () => {
  expect(fillStarter(KEY, note, VAULT)).toBe(true)
  expect(draft().refChips.map((c) => c.kind)).toEqual(['note'])
  expect(fillStarter(KEY, chat, VAULT)).toBe(true)
  expect(draft().text).toBe(chat.text)
  expect(draft().refChips.map((c) => c.kind)).toEqual(['session'])
  // 改过之后就是人自己的话了
  setDraftField(KEY, 'text', `${chat.text},顺便看看日志`)
  expect(fillStarter(KEY, note, VAULT)).toBe(false)
})

it('drops the suggestion chip once the text is cleared, without the new-chat rows mounted', () => {
  fillStarter(KEY, note, VAULT)
  setDraftField(KEY, 'refChips', (prev) => [...prev, { token: '[[mine]]', name: 'mine', kind: 'note' }])
  setDraftField(KEY, 'text', '')
  expect(draft().refChips.map((c) => c.token)).toEqual(['[[mine]]'])
  // 清空之后再填不算覆盖
  expect(fillStarter(KEY, chat, VAULT)).toBe(true)
})
