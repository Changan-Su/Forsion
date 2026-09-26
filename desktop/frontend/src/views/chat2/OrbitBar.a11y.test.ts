// @vitest-environment happy-dom
/**
 * 团队状态条的实时区域(集成遗留 L-5):以前整条 .t2o-bar 是 role=status,头像组(role=img)的可访问名带着
 * 每位成员的工作状态,状态一变读屏就把整条连同成员名单再念一遍。现在只有「人数 · 工作中 / 等审批」那行是 status。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrbitBar } from './OrbitBar'

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${Object.values(v).join('|')}` : k) }), registerMessages: () => {} }))
vi.mock('zustand/react/shallow', () => ({ useShallow: (f: unknown) => f }))
vi.mock('../../stores/appStore', () => {
  const state = {
    agentDefs: [{ slug: 'a', name: 'Ann' }, { slug: 'b', name: 'Bo' }], agentAvatars: {}, engines: [], teams: [], defaultAgentSlug: 'a',
    modelsResp: null, setSessionGroup: () => {}, ensureTeamSession: async () => null, setSeedOnce: () => {}, toast: () => {},
    teamWorkBySession: { s1: { a: { status: 'working' }, b: { status: 'waiting' } } },
  }
  return { useApp: (sel: (s: typeof state) => unknown) => sel(state) }
})
vi.mock('../../sessionNav', () => ({ openSession: () => {}, rotateSolo: async () => {} }))
vi.mock('../../components/GroupChatSetup', () => ({ GroupChatSetup: () => null }))
vi.mock('../../components/TeamEditor', () => ({ TeamEditor: () => null }))
vi.mock('../../components/EngineIcon', () => ({ EngineIcon: () => null }))
vi.mock('../../components/AgentAvatar', () => ({ AgentAvatar: () => React.createElement('span', { 'aria-hidden': true }) }))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it('头像组不在任何实时区域里;实时区域只有人数 / 工作状态那一行', async () => {
  await act(async () => root.render(React.createElement(OrbitBar, { sessionId: 's1', running: true, cfg: { groupChat: true, groupAgents: ['a', 'b'] } })))
  const avatars = host.querySelector('.t2o-bar-avatars')!
  expect(avatars.getAttribute('role')).toBe('img')
  expect(avatars.getAttribute('aria-label')).toContain('Ann')
  expect(avatars.closest('[role="status"], [aria-live]')).toBeNull()
  const live = [...host.querySelectorAll('[role="status"]')]
  expect(live.map((el) => el.className)).toEqual(['t2o-bar-sub', 't2o-bar-note'])
  expect(live[0].textContent).toContain('orbit.bar.working')
})

it('加入 / 退出提示的实时区域常驻挂载(空着也在),内容出现时才会被读屏播报', async () => {
  await act(async () => root.render(React.createElement(OrbitBar, { sessionId: 's1', running: false, cfg: { groupChat: true, groupAgents: ['a', 'b'] } })))
  const note = host.querySelector('.t2o-bar-note')
  expect(note, '没有提示时也要先挂着(带内容新插入的 region 通常不播)').not.toBeNull()
  expect(note!.getAttribute('role')).toBe('status')
  expect(note!.textContent).toBe('')
})

it('任何断点都不把实时区域 display:none 掉(≤360px 只能视觉隐藏,否则移出无障碍树、状态不再播报;Codex 第三轮 H1-6)', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const style = document.createElement('style')
  style.textContent = readFileSync(join(__dirname, 'orbits.css'), 'utf8')
  document.head.append(style)
  try {
    const live = document.createElement('span')
    live.className = 't2o-bar-sub'
    live.setAttribute('role', 'status')
    const note = document.createElement('span')
    note.className = 't2o-bar-note'
    note.setAttribute('role', 'status')
    const bar = document.createElement('div')
    bar.className = 't2o-bar'
    bar.append(live, note)
    document.body.append(bar)
    let hiddenRules = 0
    let mediaSeen = 0
    const offenders: string[] = []
    const walk = (rules: CSSRuleList, media: string): void => {
      for (const rule of [...rules]) {
        const nested = (rule as CSSMediaRule).cssRules
        if (nested && !(rule as CSSStyleRule).selectorText) { mediaSeen++; walk(nested, (rule as CSSMediaRule).media?.mediaText || media); continue }
        const r = rule as CSSStyleRule
        if (!r.selectorText || r.style?.display !== 'none') continue
        hiddenRules++
        for (const el of [live, note]) {
          let hit = false
          try { hit = el.matches(r.selectorText) } catch { /* 伪类等 happy-dom 不认的选择器:不涉及这两个元素 */ }
          if (hit) offenders.push(`${media ? `@media ${media} ` : ''}${r.selectorText}`)
        }
      }
    }
    walk(style.sheet!.cssRules, '')
    expect(mediaSeen, '前置:确实解析到了 @media 块(否则等于没查断点)').toBeGreaterThan(0)
    expect(hiddenRules, '前置:确实扫到了 display:none 规则').toBeGreaterThan(0)
    expect(offenders).toEqual([])
    bar.remove()
  } finally { style.remove() }
})
