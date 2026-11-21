// @vitest-environment happy-dom
/**
 * 长命令不挡插话(11-20):用户插话时被移到后台的命令结束后,引擎落库一条 <background_update> user 行交回模型。
 * 对人它不是用户说的话:画成每条命令一行的系统行(同审批结局行的排法),不摆成用户气泡、不露 XML。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocaleProvider } from '../../i18n'
import { EditorialMessage } from './EditorialMessage'
import { useApp } from '../../stores/appStore'
import type { UiMessage } from '../../types'
import '../../tangu/store/standalone'

const SID = 's-bg'
const content = [
  '<background_update>',
  'Commands that were moved to the background when the user sent a message have ended:',
  '',
  '[finished] process bg_a (run_bash call c-1): npm test',
  'It exited with code 0 after 47s in total.',
  '',
  '[timed_out] process bg_b (run_bash call c-2): npm run e2e',
  'It was still running 30m 0s after it was moved to the background, so it was stopped (ran 30m 12s in total).',
  '',
  'Their output is not included here. Read it with read_process_output (the process_id above; ended processes are kept for 30 minutes), then carry on with the task.',
  '</background_update>',
].join('\n')

let host: HTMLDivElement
let root: Root
const initial = useApp.getState()
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useApp.setState(initial, true)
})

describe('<background_update> 结局行', () => {
  it('画成系统行:每条命令一行、命令原文在旁边,不是用户气泡、不露标签', async () => {
    const msg = { id: 'u-bg', role: 'user', content, status: 'done', timestamp: 2 } as UiMessage
    await act(async () => root.render(React.createElement(LocaleProvider, {
      children: React.createElement(EditorialMessage, { msg, fileCtx: { cfg: useApp.getState().cfg, sessionId: SID, onOpenPreview: () => {} } as never }),
    })))
    const box = host.querySelector('[data-background-update]')
    expect(box?.getAttribute('data-background-update')).toBe('2')
    expect(box?.classList.contains('t2-sys')).toBe(true)
    const rows = [...host.querySelectorAll('.t2-apv-update-row')]
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['approved', 'failed'])
    expect(rows[0].textContent).toContain('npm test')
    expect(rows[0].textContent).toMatch(/后台命令已结束|Background command finished/)
    expect(rows[0].textContent).toContain('0')
    expect(rows[1].textContent).toMatch(/超过时限|time limit/)
    expect(host.textContent).not.toContain('<background_update>')
    expect(host.textContent).not.toContain('read_process_output')
  })
})
