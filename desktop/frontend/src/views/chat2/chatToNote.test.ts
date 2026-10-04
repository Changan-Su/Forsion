// 整段对话整理成笔记:对话记录的拼法(只取正文、尾部截断)与模型标题的拆法。
import { describe, it, expect } from 'vitest'
import type { UiMessage } from '../../types'
import { splitNoteTitle, transcriptOf } from './chatToNote'

const msg = (role: UiMessage['role'], content: string): UiMessage => ({ id: Math.random().toString(36), role, content, status: 'done', timestamp: 1 })

describe('transcriptOf', () => {
  it('只取用户 / 助手两侧,空正文跳过,本地通知行不进', () => {
    expect(transcriptOf([msg('user', '怎么部署?'), msg('system', '已切换模型'), msg('assistant', '先 build'), msg('assistant', '  ')]))
      .toBe('User:\n怎么部署?\n\nAssistant:\n先 build')
  })
  it('助手侧摘掉建议围栏(= 复制按钮那份正文)', () => {
    const t = transcriptOf([msg('assistant', '结论是 A\n\n```forsion-suggest\n[{"title":"x"}]\n```')])
    expect(t).toContain('结论是 A')
    expect(t).not.toContain('forsion-suggest')
  })
  it('超长 → 保留尾部 20k 字', () => {
    const t = transcriptOf([msg('user', 'a'.repeat(30_000)), msg('assistant', 'END')])
    expect(t.length).toBe(20_000)
    expect(t.endsWith('END')).toBe(true)
  })
})

describe('splitNoteTitle', () => {
  it('首个一级标题 → 文件名,并从正文剥掉', () => {
    expect(splitNoteTitle('# 部署流程\n\n## 步骤\n1. build', '未命名')).toEqual({ title: '部署流程', body: '## 步骤\n1. build' })
  })
  it('文件名非法字符换成空格;没有标题用 fallback', () => {
    expect(splitNoteTitle('# a/b: c?\nx', 'f').title).toBe('a b c')
    expect(splitNoteTitle('正文', '旧会话名')).toEqual({ title: '旧会话名', body: '正文' })
  })
})
