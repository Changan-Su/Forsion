import { describe, expect, it } from 'vitest'
import { autoVersionName, historyMode, runEnded, sameProject } from './gitHistory'
import { __dictSnapshot } from '../../i18n'
import type { GitPanelStatus, GitRepoState } from '../../../../shared/products'
import type { UiMessage } from '../../types'
import './studioMessages'

const message = (role: UiMessage['role'], content: string): UiMessage => ({ id: `${role}:${content.slice(0, 8)}`, role, content, status: 'done', timestamp: 1 })
const status = (patch: Partial<GitPanelStatus> & { state: GitRepoState }): GitPanelStatus => ({ available: true, dirty: false, writable: false, ...patch })

describe('historyMode', () => {
  it('老宿主(没有 git 桥)不渲染 git 那一段,而不是误报「没装 git」', () => {
    expect(historyMode(null)).toEqual({ mode: 'unsupported', reasonKey: '' })
    expect(historyMode(undefined)).toEqual({ mode: 'unsupported', reasonKey: '' })
  })

  it('本机没有 git → 安装引导', () => {
    expect(historyMode(status({ state: 'none', available: false })).mode).toBe('install')
  })

  it('可写:尚未建仓时才提前交代会创建 .git,已建仓不再啰嗦', () => {
    expect(historyMode(status({ state: 'none', writable: true }))).toEqual({ mode: 'writable', reasonKey: 'studio.history.firstVersionNote' })
    expect(historyMode(status({ state: 'owned', writable: true }))).toEqual({ mode: 'writable', reasonKey: '' })
  })

  it('只读的三种理由各自成句,不能糊成一句「不能保存」', () => {
    expect(historyMode(status({ state: 'foreign' }))).toEqual({ mode: 'readonly', reasonKey: 'studio.history.readonlyForeign' })
    expect(historyMode(status({ state: 'nested' }))).toEqual({ mode: 'readonly', reasonKey: 'studio.history.readonlyNested' })
    // 有仓、不嵌套、却仍不可写 = 项目在托管根之外(随手导入的目录)。
    expect(historyMode(status({ state: 'owned' }))).toEqual({ mode: 'readonly', reasonKey: 'studio.history.readonlyOutside' })
  })

  it('仪器:返回的文案键都在字典里(键名打错不会报错,只会把键名渲染出来)', () => {
    const dict = __dictSnapshot()
    const states: GitRepoState[] = ['none', 'owned', 'foreign', 'nested']
    const keys = [
      historyMode(status({ state: 'none', available: false })).reasonKey,
      ...states.flatMap(state => [historyMode(status({ state, writable: true })).reasonKey, historyMode(status({ state })).reasonKey]),
    ].filter(Boolean)
    expect(keys.length).toBeGreaterThan(3)
    expect(keys.filter(key => !(key in dict.zh) || !(key in dict.en))).toEqual([])
  })
})

describe('autoVersionName', () => {
  it('取最后一条用户消息的首个非空行,并把空白压平', () => {
    const name = autoVersionName([
      message('user', 'Build a landing page'),
      message('assistant', 'Done.'),
      message('user', '\n\n  把标题   改成   两行  \n细节随意\n'),
      message('assistant', 'Done.'),
    ])
    expect(name).toBe('把标题 改成 两行')
  })

  it('中文与 emoji 按码点截断,不会把代理对拦腰砍成半个字符', () => {
    const long = `${'版'.repeat(80)}🎉`
    const name = autoVersionName([message('user', long)])
    expect([...name]).toHaveLength(72)
    expect(name.endsWith('…')).toBe(true)
    expect([...name].slice(0, -1).every(point => point === '版')).toBe(true)
    const emoji = autoVersionName([message('user', `${'🎉'.repeat(80)}`)])
    expect([...emoji]).toHaveLength(72)
    expect(emoji).not.toContain('�')
    expect([...emoji].slice(0, -1).every(point => point === '🎉')).toBe(true)
  })

  it('正好 72 个码点不加省略号', () => {
    const exact = 'a'.repeat(72)
    expect(autoVersionName([message('user', exact)])).toBe(exact)
    expect(autoVersionName([message('user', 'a'.repeat(73))])).toHaveLength(72)
  })

  it('没有用户消息、或最后一条是空的(纯附件),回落到通用名而不是顶着上一轮的标题', () => {
    const fallback = autoVersionName([])
    expect(fallback).toBe('AI 改动')
    expect(autoVersionName([message('assistant', 'hello')])).toBe(fallback)
    expect(autoVersionName([message('user', '第一轮的标题'), message('assistant', 'ok'), message('user', '   \n\t\n ')])).toBe(fallback)
  })
})


/** 自动版本的沿判 + 「还是同一个项目」守卫:两者错了都**不会红**,只会静默多存 / 少存版本。 */
describe('runEnded', () => {
  it('只认 true→false 这一沿:挂载时不补,跑着的时候不提前存', () => {
    expect(runEnded(true, false)).toBe(true)
    expect(runEnded(false, false)).toBe(false) // 挂载时本就不在跑 = 不补提交
    expect(runEnded(true, true)).toBe(false) // 挂载时正在跑,下一帧还在跑 = 不存
    expect(runEnded(false, true)).toBe(false) // 刚开始跑
  })

  it('一轮生成只触发一次:消息更新导致 effect 重跑也不再补第二个版本', () => {
    // 调用点的真实形状:previous 存在 ref 里,每次 effect 先读旧值再写新值。
    let previous = false
    let fired = 0
    const tick = (running: boolean) => {
      if (runEnded(previous, running)) fired++
      previous = running
    }
    // 挂载(false)→ 开跑 → 跑着时消息流进来(effect 重跑,running 仍是 true)→ 跑完 → 跑完之后消息还在变
    for (const running of [false, true, true, false, false, false]) tick(running)
    expect(fired).toBe(1)
    // 第二轮生成应当再存一版。
    for (const running of [true, false]) tick(running)
    expect(fired).toBe(2)
  })
})

describe('sameProject', () => {
  it('尾斜杠 / 反斜杠算同一个项目,别的项目与空值一律不算', () => {
    expect(sameProject('/projects/a', '/projects/a')).toBe(true)
    expect(sameProject('/projects/a', '/projects/a/')).toBe(true)
    expect(sameProject('C:\\projects\\a', 'C:/projects/a')).toBe(true)
    expect(sameProject('/projects/a', '/projects/b')).toBe(false)
    expect(sameProject('/projects/a', '/projects/ab')).toBe(false)
    // 异步回来时用户已经退回工作台(activeProject = null)→ 绝不把结果记到任何项目头上。
    expect(sameProject('/projects/a', null)).toBe(false)
    expect(sameProject('/projects/a', undefined)).toBe(false)
    expect(sameProject('/projects/a', '')).toBe(false)
    expect(sameProject('', '')).toBe(false)
  })
})
