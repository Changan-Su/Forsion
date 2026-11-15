/** 插件接进宿主模板流程(templateHooks.ts):处理器的顺序 / 不改 / 抛错、额外模板文件夹、新笔记出生问插件的取舍。
 *  真窗口那一半(编辑器一打开就是模板、取消钮、落盘):scripts/plugin-birth-race.check.cjs(check:pluginbirth)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BirthNoticeHost } from './templateHooks'

type Hooks = typeof import('./templateHooks')
const toasts: Array<{ text: string; level?: string }> = []

async function fresh(): Promise<Hooks> {
  vi.resetModules()
  toasts.length = 0
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail } })
  vi.stubGlobal('window', {
    dispatchEvent: (e: { type: string; detail?: { text: string; level?: string } }) => { if (e.type === 'amadeus:toast' && e.detail) toasts.push(e.detail); return true },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  const hooks = await import('./templateHooks')
  ;(await import('../../i18n')).setLocaleGlobal('zh') // resetModules 后 i18n 是新实例:重新钉中文(同 testSetup)
  return hooks
}

/** 记账的假提示:show 了几次、当前文案、能不能点取消。 */
function fakeNotice() {
  const log: string[] = []
  let cancel: (() => void) | null = null
  let open = false
  const host: BirthNoticeHost = {
    show(text, label, onCancel) {
      log.push(`show:${text}|${label}`)
      cancel = onCancel
      open = true
      return () => { open = false; log.push('hide') }
    },
  }
  return { host, log, isOpen: () => open, cancel: () => cancel?.() }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const info = { templatePath: 'templates/t.md', targetPath: 'Note.md', kind: 'insert' as const }

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('registerTemplateProcessor', () => {
  it('按注册顺序跑,后一个拿前一个的输出;null = 不改;全都不改 → changed:false', async () => {
    const h = await fresh()
    const seen: string[] = []
    h.registerTemplateProcessor('a', () => 'A', { id: 'p', name: 'A', process: (s) => { seen.push(`a:${s}`); return `${s}+a` } })
    h.registerTemplateProcessor('b', () => 'B', { id: 'p', name: 'B', process: () => null })
    h.registerTemplateProcessor('c', () => 'C', { id: 'p', name: 'C', process: async (s, i) => { seen.push(`c:${s}:${i.kind}`); return `${s}+c` } })
    expect(await h.runTemplateProcessors('src', info)).toEqual({ ok: true, text: 'src+a+c', changed: true })
    expect(seen).toEqual(['a:src', 'c:src+a:insert'])

    const h2 = await fresh()
    h2.registerTemplateProcessor('a', () => 'A', { id: 'p', name: 'A', process: () => null })
    expect(await h2.runTemplateProcessors('src', info)).toEqual({ ok: true, text: 'src', changed: false })
  })

  it('抛错 = 这次插入作废,提示点名插件;后面的处理器不再跑', async () => {
    const h = await fresh()
    const later = vi.fn(() => 'x')
    h.registerTemplateProcessor('bad', () => 'Bad Plugin', { id: 'p', name: 'P', process: () => { throw new Error('boom') } })
    h.registerTemplateProcessor('later', () => 'L', { id: 'p', name: 'L', process: later })
    expect(await h.runTemplateProcessors('src', info)).toEqual({ ok: false })
    expect(later).not.toHaveBeenCalled()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].text).toContain('Bad Plugin')
    expect(toasts[0].text).toContain('boom')
  })

  it('停用(disposer)后不再参与;跑的途中被停用的,结果不要', async () => {
    const h = await fresh()
    let release: (v: string) => void = () => {}
    const off = h.registerTemplateProcessor('slow', () => 'S', { id: 'p', name: 'S', process: () => new Promise<string>((r) => { release = r }) })
    const run = h.runTemplateProcessors('src', info)
    await tick()
    off()
    release('late')
    expect(await run).toEqual({ ok: true, text: 'src', changed: false })
    expect(h.hasTemplateProcessors()).toBe(false)
  })

  it('同 id 再注册 = 原位顶替;形状不对直接抛 TypeError', async () => {
    const h = await fresh()
    h.registerTemplateProcessor('a', () => 'A', { id: 'p', name: 'A', process: (s) => `${s}1` })
    h.registerTemplateProcessor('b', () => 'B', { id: 'p', name: 'B', process: (s) => `${s}b` })
    h.registerTemplateProcessor('a', () => 'A', { id: 'p', name: 'A', process: (s) => `${s}2` })
    expect((await h.runTemplateProcessors('', info)).ok && (await h.runTemplateProcessors('', info))).toMatchObject({ text: '2b' })
    expect(() => h.registerTemplateProcessor('a', () => 'A', { id: '', name: 'A', process: () => null })).toThrow(TypeError)
    expect(() => h.registerTemplateProcessor('a', () => 'A', { id: 'x', name: 'A' } as never)).toThrow(TypeError)
  })

  it('folders():去重、规范化,库外 / 绝对路径 / 盘符 / 空段不认;抛错和超时的不贡献', async () => {
    const h = await fresh()
    h.registerTemplateProcessor('a', () => 'A', { id: 'p', name: 'A', process: () => null, folders: () => ['Tpl', 'Tpl/', 'Tpl\\Sub', '../Out', '/abs', 'C:/win', 'a//b', './x', '', 42 as never] })
    h.registerTemplateProcessor('b', () => 'B', { id: 'p', name: 'B', process: () => null, folders: async () => ['Tpl', 'More'] })
    h.registerTemplateProcessor('c', () => 'C', { id: 'p', name: 'C', process: () => null, folders: () => { throw new Error('x') } })
    h.registerTemplateProcessor('d', () => 'D', { id: 'p', name: 'D', process: () => null })
    expect((await h.templateFolders()).sort()).toEqual(['More', 'Tpl', 'Tpl/Sub'])
  })

  it('folders() 迟迟不回:2 秒后照样给出别人的', async () => {
    vi.useFakeTimers()
    try {
      const h = await fresh()
      h.registerTemplateProcessor('a', () => 'A', { id: 'p', name: 'A', process: () => null, folders: () => new Promise<string[]>(() => {}) })
      h.registerTemplateProcessor('b', () => 'B', { id: 'p', name: 'B', process: () => null, folders: () => ['Ok'] })
      const got = h.templateFolders()
      await vi.advanceTimersByTimeAsync(2100)
      expect(await got).toEqual(['Ok'])
    } finally { vi.useRealTimers() }
  })
})

describe('registerNoteBirth / askNoteBirth', () => {
  it('没人注册 → null,不挂提示', async () => {
    const h = await fresh()
    const n = fakeNotice()
    expect(await h.askNoteBirth('a.md', { notice: n.host })).toBeNull()
    expect(n.log).toEqual([])
  })

  it('按注册顺序一个个问,第一个非 null 胜出;后面的不再问;info 带 path / folder / signal', async () => {
    const h = await fresh()
    const calls: string[] = []
    let seenInfo: unknown = null
    h.registerNoteBirth('p1', () => 'P1', { id: 'b', initial: (i) => { calls.push('p1'); seenInfo = i; return null } })
    h.registerNoteBirth('p2', () => 'P2', { id: 'b', initial: async () => { calls.push('p2'); return '# hi' } })
    h.registerNoteBirth('p3', () => 'P3', { id: 'b', initial: () => { calls.push('p3'); return 'never' } })
    const n = fakeNotice()
    expect(await h.askNoteBirth('Inbox/Sub/untitled.md', { notice: n.host })).toEqual({ text: '# hi', pluginId: 'p2' })
    expect(calls).toEqual(['p1', 'p2'])
    expect(seenInfo).toMatchObject({ path: 'Inbox/Sub/untitled.md', folder: 'Inbox/Sub' })
    expect((seenInfo as { signal: AbortSignal }).signal.aborted).toBe(true) // 问完即放手
    expect(n.log).toEqual([]) // 快答不闪提示
    expect(await h.askNoteBirth('root.md', { notice: n.host })).toEqual({ text: '# hi', pluginId: 'p2' })
  })

  it('空串也算答复(胜出);非字符串按「不给」', async () => {
    const h = await fresh()
    h.registerNoteBirth('p1', () => 'P1', { id: 'b', initial: () => 42 as never })
    h.registerNoteBirth('p2', () => 'P2', { id: 'b', initial: () => '' })
    expect(await h.askNoteBirth('a.md', { notice: fakeNotice().host })).toEqual({ text: '', pluginId: 'p2' })
  })

  it('抛错 / reject 的插件跳过(提示点名),接着问下一个', async () => {
    const h = await fresh()
    h.registerNoteBirth('bad', () => 'Bad', { id: 'b', initial: () => { throw new Error('nope') } })
    h.registerNoteBirth('bad2', () => 'Bad2', { id: 'b', initial: () => Promise.reject(new Error('nope2')) })
    h.registerNoteBirth('good', () => 'Good', { id: 'b', initial: () => 'ok' })
    expect(await h.askNoteBirth('a.md', { notice: fakeNotice().host })).toEqual({ text: 'ok', pluginId: 'good' })
    expect(toasts.map((t) => t.text).join('\n')).toMatch(/Bad[\s\S]*nope[\s\S]*Bad2[\s\S]*nope2/)
  })

  it('慢的插件:过了提示延时才挂「正在准备」+ 取消(带插件名);答完收起', async () => {
    const h = await fresh()
    let answer: (v: string) => void = () => {}
    h.registerNoteBirth('slow', () => 'Slow Plugin', { id: 'b', initial: () => new Promise<string>((r) => { answer = r }) })
    const n = fakeNotice()
    const asked = h.askNoteBirth('a.md', { notice: n.host, noticeDelayMs: 10 })
    await tick(30)
    expect(n.isOpen()).toBe(true)
    expect(n.log[0]).toMatch(/^show:「Slow Plugin」正在准备这篇笔记…\|取消$/)
    answer('# done')
    expect(await asked).toEqual({ text: '# done', pluginId: 'slow' })
    expect(n.isOpen()).toBe(false)
  })

  it('点取消 → null,插件的 signal 被 abort,迟到的答复不要', async () => {
    const h = await fresh()
    let signal: AbortSignal | undefined
    let answer: (v: string) => void = () => {}
    const second = vi.fn(() => 'second')
    h.registerNoteBirth('hang', () => 'Hang', { id: 'b', initial: (i) => { signal = i.signal; return new Promise<string>((r) => { answer = r }) } })
    h.registerNoteBirth('p2', () => 'P2', { id: 'b', initial: second })
    const n = fakeNotice()
    const asked = h.askNoteBirth('a.md', { notice: n.host, noticeDelayMs: 0 })
    await tick(10)
    n.cancel()
    expect(await asked).toBeNull()
    expect(signal?.aborted).toBe(true)
    expect(second).not.toHaveBeenCalled() // 取消 = 整次都不等了
    expect(n.isOpen()).toBe(false)
    answer('late') // 不抛、不影响下一次
    expect(await h.askNoteBirth('b.md', { notice: n.host, noticeDelayMs: 0, capMs: 20 })).toBeNull() // hang 还在:超时
  })

  it('上限内没答 → null,提示点名插件;笔记照旧空白', async () => {
    const h = await fresh()
    h.registerNoteBirth('hang', () => 'Hang Plugin', { id: 'b', initial: () => new Promise<string>(() => {}) })
    expect(await h.askNoteBirth('a.md', { notice: fakeNotice().host, capMs: 20 })).toBeNull()
    expect(toasts.at(-1)?.text).toContain('Hang Plugin')
    expect(h.NOTE_BIRTH_CAP_MS).toBe(600_000) // 宽裕上限:插件可能在弹框问用户
  })

  it('等的途中插件被停用 → 跳过它问下一个;同 id 被顶替同理', async () => {
    const h = await fresh()
    let s1: AbortSignal | undefined
    let s1AbortedWhenP2Asked: boolean | undefined
    const off = h.registerNoteBirth('p1', () => 'P1', { id: 'b', initial: (i) => { s1 = i.signal; return new Promise<string>(() => {}) } })
    h.registerNoteBirth('p2', () => 'P2', { id: 'b', initial: (i) => { s1AbortedWhenP2Asked = s1?.aborted; expect(i.signal).not.toBe(s1); return 'from p2' } })
    const asked = h.askNoteBirth('a.md', { notice: fakeNotice().host })
    await tick()
    off()
    expect(await asked).toEqual({ text: 'from p2', pluginId: 'p2' })
    expect(s1AbortedWhenP2Asked).toBe(true) // 被跳过的那个先收到 abort,再问下一个:两个弹框不同时开
    expect(h.hasNoteBirthProviders()).toBe(true)

    const h2 = await fresh()
    h2.registerNoteBirth('p1', () => 'P1', { id: 'b', initial: () => new Promise<string>(() => {}) })
    const asked2 = h2.askNoteBirth('a.md', { notice: fakeNotice().host })
    await tick()
    h2.registerNoteBirth('p1', () => 'P1', { id: 'b', initial: () => 'replacement' }) // 重载:同 key 原位顶替
    expect(await asked2).toBeNull() // 这一问里旧的跳过;新的是问完之后才登记的那一代,下一次才问它
    expect(await h2.askNoteBirth('b.md', { notice: fakeNotice().host })).toEqual({ text: 'replacement', pluginId: 'p1' })
  })

  it('问的途中再来一次出生(插件在 initial 里新建 / 用户又点新建)不再问,防递归', async () => {
    const h = await fresh()
    let inner: Promise<unknown> | null = null
    const initial = vi.fn((i: { path: string }) => {
      if (i.path === 'outer.md') inner = h.askNoteBirth('inner.md', { notice: fakeNotice().host })
      return 'filled'
    })
    h.registerNoteBirth('p', () => 'P', { id: 'b', initial })
    expect(await h.askNoteBirth('outer.md', { notice: fakeNotice().host })).toEqual({ text: 'filled', pluginId: 'p' })
    expect(await inner).toBeNull()
    expect(initial).toHaveBeenCalledTimes(1)
  })

  it('形状不对直接抛 TypeError', async () => {
    const h = await fresh()
    expect(() => h.registerNoteBirth('p', () => 'P', { id: ' ', initial: () => null })).toThrow(TypeError)
    expect(() => h.registerNoteBirth('p', () => 'P', { id: 'x' } as never)).toThrow(TypeError)
  })
})
