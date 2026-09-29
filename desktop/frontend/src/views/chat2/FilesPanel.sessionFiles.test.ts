// @vitest-environment happy-dom
/**
 * M1B:手机 / web 把整端切到「我的电脑」后,文件面板顶上多一组「本会话的文件」= 那个会话在那台电脑上的引擎沙箱
 * (手机发的附件、agent 的产物)。host 工作区那几组列的是那台电脑的真目录,看不到会话沙箱。
 *   ① 当前会话在 unit 上 → 有这一组,按 sessionId 取数(listWorkspace(cfg, sid)),行尾常显下载键 → downloadWorkspaceFile(cfg, sid, path);
 *   ② 右键菜单没有「删除」(unit 上 workspaceDelete=false,引擎那条路由本就 deny-remote);
 *   ③ 焦点在本端(桌面本机 / 手机云端)→ 没有这一组;
 *   ④ 没有任何工作区时也照样显示这一组(不被「没有本地工作区」提示吞掉)。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/backendService', () => ({
  listWorkspace: vi.fn(async () => [
    { path: '/k9-result.txt', size: 12, mimeType: 'text/plain', updatedAt: 0 },
    { path: '/k9-attach.txt', size: 10, mimeType: 'text/plain', updatedAt: 0 },
  ]),
  readWorkspaceFile: vi.fn(),
  downloadWorkspaceFile: vi.fn(async () => {}),
  deleteWorkspaceFile: vi.fn(),
}))
import { listWorkspace, downloadWorkspaceFile } from '../../services/backendService'
import { LocaleProvider, translateFor } from '../../i18n'
import { FilesPanel } from './FilesPanel'
import { useApp } from '../../stores/appStore'
import { bindSession, clearSessionBindings, resetFocusForTests, useEngineFocus } from '../../services/engine/targets'
import type { WorkspaceDescriptor } from '../../types'

const SID = 'sess-remote-1'
const UNIT = '6f99bfba-c9dc-4e10-9b51-43e50fde8db1'
const initial = useApp.getState()
let host: HTMLDivElement
let root: Root

async function render(workspaces: WorkspaceDescriptor[] = []): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, {
    children: React.createElement(FilesPanel, { workspaces, onOpenPreview: () => {} }),
  })))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const group = (): HTMLElement | null => host.querySelector('[data-ws-scope="session"]')
const rows = (): string[] => [...host.querySelectorAll('[data-ws-scope="session"] [data-ws-file]')].map((e) => e.getAttribute('data-ws-file') || '')

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.mocked(listWorkspace).mockClear()
  vi.mocked(downloadWorkspaceFile).mockClear()
  useApp.setState({ activeId: SID })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useApp.setState(initial, true)
  resetFocusForTests()
  clearSessionBindings()
})

describe('FilesPanel ×「本会话的文件」(M1B)', () => {
  it('会话在别的电脑上 → 列出会话沙箱、行尾下载键按会话下载;没有工作区也照样显示', async () => {
    useEngineFocus.setState({ ref: Object.freeze({ kind: 'unit' as const, unitId: UNIT }), name: 'K9 Studio Mac' })
    bindSession(SID, { kind: 'unit', unitId: UNIT }) // S4:会话在那台上(绑定是判据)
    await render([])
    expect(group()?.textContent).toContain(translateFor('zh', 'panel.files.sessionFiles'))
    expect(vi.mocked(listWorkspace)).toHaveBeenCalledWith(expect.anything(), SID, undefined)
    expect(rows()).toEqual(['/k9-attach.txt', '/k9-result.txt'])
    const btn = host.querySelector('[data-ws-file="/k9-result.txt"] [data-download]') as HTMLButtonElement
    expect(btn?.getAttribute('aria-label')).toBe(translateFor('zh', 'panel.action.download'))
    await act(async () => btn.click())
    expect(vi.mocked(downloadWorkspaceFile)).toHaveBeenCalledWith(expect.anything(), SID, '/k9-result.txt', undefined)
  })

  it('右键菜单:预览 / 下载,没有删除(unit 上工作区删除不可用)', async () => {
    useEngineFocus.setState({ ref: Object.freeze({ kind: 'unit' as const, unitId: UNIT }), name: null })
    bindSession(SID, { kind: 'unit', unitId: UNIT })
    await render([])
    const row = host.querySelector('[data-ws-file="/k9-attach.txt"]') as HTMLElement
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
    const items = [...document.querySelectorAll('.ctx-menu button, [role="menu"] button, .menu-item')].map((b) => (b.textContent || '').trim()).filter(Boolean)
    expect(items).toContain(translateFor('zh', 'panel.action.download'))
    expect(items).not.toContain(translateFor('zh', 'panel.action.delete'))
  })

  it('焦点在本端 → 没有这一组(桌面本机 / 手机云端照旧)', async () => {
    await render([{ key: 'cloud:p', name: 'P', kind: 'cloud', project: 'P' } as WorkspaceDescriptor])
    expect(group()).toBeNull()
    expect(host.querySelector('[data-ws-scope="project"]')).not.toBeNull()
  })

  it('新文案 zh / en 成对,英文不含汉字', () => {
    for (const k of ['panel.files.sessionFiles', 'panel.files.sessionEmpty']) {
      expect(translateFor('zh', k)).not.toBe(k)
      const en = translateFor('en', k)
      expect(en).not.toBe(k)
      expect(/[一-龥]/.test(en)).toBe(false)
    }
  })
})
