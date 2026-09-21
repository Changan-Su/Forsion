/** deep link 通用径的身份参数安全闸(Codex 评审 F1)。
 *  这层是无鉴权 OS 级入口的最后一道:URL 语法测试(deepLinkPlan.test)拦不住「语法合法但打开了
 *  不该打开的东西」——主机绝对路径注入 wsfile、后缀错配把白板塞进笔记编辑器,都在这里判。 */
import { describe, expect, it, vi } from 'vitest'
import { registerView, useSpaceStore, useWorkspace } from '@lcl/engine'
import type { ViewDefinition } from '@lcl/engine'
import { entityParamsSafe, registerDeepLinkOpener, resolveDeepLink } from './deepLinkInstall'
import { VIEW_FILE_MATCH } from './viewFileMatch'

/** 造一个只带元数据的 ViewDefinition(factory 不会被调用)。 */
const def = (d: Partial<ViewDefinition> & { type: string }): ViewDefinition =>
  ({ displayName: d.type, factory: () => null, ...d }) as ViewDefinition

const EDITOR = def({ type: 'amadeus-editor', kind: 'entity', idParam: 'notePath', fileMatch: VIEW_FILE_MATCH['amadeus-editor'] })
const DASH = def({ type: 'dashboard', kind: 'entity', idParam: 'dashPath', fileMatch: VIEW_FILE_MATCH['dashboard'] })
const WSFILE = def({ type: 'wsfile', kind: 'entity', idParam: 'path' }) // ⚠️ 无 fileMatch,path=主机绝对路径
const CHAT = def({ type: 'chat', kind: 'entity', idParam: 'sessionId' })
const CALENDAR = def({ type: 'calendar', kind: 'collection' })

describe('entityParamsSafe', () => {
  it('⚠️wsfile:主机绝对路径一律拒(它没有 fileMatch,直读 readHostFile)', () => {
    expect(entityParamsSafe(WSFILE, { path: '/Users/me/.ssh/id_rsa' })).toBe(false)
    expect(entityParamsSafe(WSFILE, { path: 'C:\\Users\\me\\secrets.txt' })).toBe(false)
    expect(entityParamsSafe(WSFILE, { path: '\\\\server\\share\\x.md' })).toBe(false) // UNC
    expect(entityParamsSafe(WSFILE, { path: '相对/也拒.md' })).toBe(false) // 含斜杠 → 非 id 形态
  })

  it('⚠️后缀错配拒:白板/仪表盘不许塞进笔记编辑器(compiler 会改写载荷=毁档)', () => {
    expect(entityParamsSafe(EDITOR, { notePath: '画板.excalidraw.md' })).toBe(false)
    expect(entityParamsSafe(EDITOR, { notePath: '总览.dashboard.md' })).toBe(false)
    expect(entityParamsSafe(EDITOR, { notePath: '论文.pdf' })).toBe(false)
    expect(entityParamsSafe(DASH, { dashPath: '普通笔记.md' })).toBe(false)
  })

  it('文件类正路:后缀归属本 view 且路径安全 → 放行(中文路径照常)', () => {
    expect(entityParamsSafe(EDITOR, { notePath: '项目/会议纪要 2026-08.md' })).toBe(true)
    expect(entityParamsSafe(DASH, { dashPath: '面板/总览.dashboard.md' })).toBe(true)
  })

  it('文件类:路径穿越拒(反斜杠形态是 URL 层归一不掉的那种)', () => {
    expect(entityParamsSafe(EDITOR, { notePath: '..\\..\\secret.md' })).toBe(false)
    expect(entityParamsSafe(EDITOR, { notePath: '/绝对路径.md' })).toBe(false)
  })

  it('非文件类 entity 只收 id 形态', () => {
    expect(entityParamsSafe(CHAT, { sessionId: 'abc-123_X' })).toBe(true)
    expect(entityParamsSafe(CHAT, { sessionId: '../../etc' })).toBe(false)
    expect(entityParamsSafe(CHAT, { sessionId: '' })).toBe(false)
  })

  it('不带身份参数 / 非 entity → 放行(开空壳视图无害;collection 不消费身份)', () => {
    expect(entityParamsSafe(WSFILE, {})).toBe(true)
    expect(entityParamsSafe(EDITOR, {})).toBe(true)
    expect(entityParamsSafe(CALENDAR, { date: '2026-08-25' })).toBe(true)
  })
})

/** view 专属落地(registerDeepLinkOpener):造物的 product 靠它改开独立窗口。这层同样是任意网页可达的入口。 */
describe('registerDeepLinkOpener', () => {
  const TYPE = 'dl-opener-probe'
  const intent = (extra: Record<string, unknown> = {}) =>
    ({ kind: 'view', view: TYPE, params: { id: 'p_0123456789ab' }, ...extra }) as unknown as Parameters<typeof resolveDeepLink>[0]

  it('注册后接管落地:不走主区 openView、不因 &space= 切走主窗;反注册后回到缺省路径', async () => {
    registerView({ type: TYPE, kind: 'entity', idParam: 'id', displayName: TYPE, factory: () => null })
    const openView = vi.spyOn(useWorkspace.getState(), 'openView').mockReturnValue(null as never)
    const before = useSpaceStore.getState().activeSpaceId
    const seen: Array<Record<string, string>> = []
    const off = registerDeepLinkOpener(TYPE, (params) => { seen.push(params); return true })

    // `space` 指向一个不存在的 Space:若先切 Space 再问 opener,这里会直接 false(也就证明了顺序)。
    expect(await resolveDeepLink(intent({ space: 'no-such-space' }))).toBe(true)
    expect(seen).toEqual([{ id: 'p_0123456789ab' }])
    expect(openView).not.toHaveBeenCalled()
    expect(useSpaceStore.getState().activeSpaceId).toBe(before)

    off()
    expect(await resolveDeepLink(intent())).toBe(true)
    expect(openView).toHaveBeenCalledWith(TYPE, { id: 'p_0123456789ab' }, 'main')
    openView.mockRestore()
  })

  it('⚠️形态闸仍在 opener 之前:带斜杠的 id 到不了 opener', async () => {
    const open = vi.fn(() => true)
    const off = registerDeepLinkOpener(TYPE, open)
    expect(await resolveDeepLink({ kind: 'view', view: TYPE, params: { id: '../../etc' } } as never)).toBe(false)
    expect(open).not.toHaveBeenCalled()
    off()
  })
})
