// @vitest-environment happy-dom
// openManual() 的编排层 —— 「两份一起落盘、绝不覆盖、按语言开对的那份」这套顺序没有别的地方能验:
// amadeusManual.test.ts 验的是**内容**,manual-note.check.cjs 验的是**渲染**,落盘链两者都碰不到
// (tutorial-note.check.cjs 自己也把这段标了 SKIP:台架没有 vault 后端)。
//
// 尤其钉住 Codex 09-05 F1 那条:两份原本合在一个 try 里,另一份写失败会连**手上这份已经在盘上的**
// 都打不开 —— 用户点了「打开使用手册」什么都不发生。分开 try 之后这里逐条钉。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = new Map<string, string>()
const fail = { list: false, read: false, write: null as string | null }

vi.mock('@amadeus/api', () => ({
  amadeus: {
    listPages: () => (fail.list ? Promise.reject(new Error('list boom')) : Promise.resolve([...files.keys()])),
    readTextFile: (p: string) => (fail.read ? Promise.reject(new Error('read boom')) : Promise.resolve(files.get(p) ?? null)),
    writeTextFile: (p: string, text: string) => {
      if (fail.write && p === fail.write) return Promise.reject(new Error('write boom'))
      files.set(p, text)
      return Promise.resolve()
    },
  },
}))

const refreshPages = vi.fn(() => Promise.resolve())
let vaultRoot: string | null = '/vault'
vi.mock('@amadeus/store/pageStore', () => ({
  usePageStore: { getState: () => ({ vaultRoot, refreshPages }) },
}))

const openNote = vi.fn((_path: string) => Promise.resolve())
vi.mock('./amadeusNav', () => ({ openNote: (p: string) => openNote(p) }))

let locale: 'zh' | 'en' = 'zh'
vi.mock('./i18n', async (orig) => {
  const real = (await orig()) as typeof import('./i18n')
  return { ...real, currentLocale: () => locale }
})

const { openManual, MANUAL_PATHS } = await import('./amadeusManual')

const toasts: Array<{ text: string; error: boolean }> = []
window.addEventListener('amadeus:toast', (e) => toasts.push((e as CustomEvent).detail))

beforeEach(() => {
  files.clear()
  toasts.length = 0
  openNote.mockClear()
  refreshPages.mockClear()
  fail.list = false
  fail.read = false
  fail.write = null
  vaultRoot = '/vault'
  locale = 'zh'
})

describe('openManual 落盘编排', () => {
  it('两份都不在时:两份都生成,打开当前语言那一份', async () => {
    await openManual()
    expect([...files.keys()].sort()).toEqual([MANUAL_PATHS.en, MANUAL_PATHS.zh].sort())
    // 落盘的是 compileV4 的产物:frontmatter(schema + canvas)在前,正文在后
    for (const [p_, h1] of [[MANUAL_PATHS.zh, '# Amadeus 使用手册'], [MANUAL_PATHS.en, '# Amadeus User Manual']] as const) {
      const src = files.get(p_) ?? ''
      expect(src.startsWith('---\namadeus_schema: amadeus.page/4\n'), `${p_} 缺结构键`).toBe(true)
      expect(src.includes(`\n${h1}\n`), `${p_} 缺 H1`).toBe(true)
    }
    expect(openNote).toHaveBeenCalledWith(MANUAL_PATHS.zh)
    expect(toasts).toEqual([])
  })

  it('界面是英文时开英文那份(两份仍然都生成)', async () => {
    locale = 'en'
    await openManual()
    expect(files.size).toBe(2)
    expect(openNote).toHaveBeenCalledWith(MANUAL_PATHS.en)
  })

  it('已存在的手册**绝不覆盖** —— 用户在上面改的东西就是他的笔记了', async () => {
    files.set(MANUAL_PATHS.zh, '# 我自己改过的手册\n')
    await openManual()
    expect(files.get(MANUAL_PATHS.zh)).toBe('# 我自己改过的手册\n')
    expect(files.get(MANUAL_PATHS.en)?.length).toBeGreaterThan(1000) // 另一份该生成的照常生成
    expect(openNote).toHaveBeenCalledWith(MANUAL_PATHS.zh)
  })

  it('名册取不到时保守当「已存在」,一个字都不写(读失败同理 —— 覆盖是原子 rename,不可逆)', async () => {
    files.set(MANUAL_PATHS.zh, 'mine')
    fail.list = true
    await openManual()
    expect(files.get(MANUAL_PATHS.zh)).toBe('mine')
    expect(files.has(MANUAL_PATHS.en)).toBe(false) // listPages 失败 → 两份都判「已存在」
    expect(openNote).toHaveBeenCalledWith(MANUAL_PATHS.zh)
  })

  it('⚠️Codex F1:另一份写失败时,手上这份照常打开,并且出声(不静默少一份)', async () => {
    fail.write = MANUAL_PATHS.en
    await openManual()
    expect(files.has(MANUAL_PATHS.zh)).toBe(true)
    expect(openNote).toHaveBeenCalledWith(MANUAL_PATHS.zh) // ← 合在一个 try 里时这里是 0 次
    expect(toasts).toHaveLength(1)
    expect(toasts[0].error).toBe(true)
  })

  it('当前语言那份写失败:出声并且不打开(没什么可打开的)', async () => {
    fail.write = MANUAL_PATHS.zh
    await openManual()
    expect(openNote).not.toHaveBeenCalled()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].error).toBe(true)
  })

  it('没开笔记库:提示,不写盘,不打开', async () => {
    vaultRoot = null
    await openManual()
    expect(files.size).toBe(0)
    expect(openNote).not.toHaveBeenCalled()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].error).toBe(false)
  })
})
