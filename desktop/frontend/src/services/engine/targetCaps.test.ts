// P1-K6 S2 · targetCaps 与 unitWeb 的远端允许清单对账:unit 目标上为 false 的能力,对应路由在
// desktop/electron/engineRoutes.generated.ts 里必须是 deny-remote(路由表翻了 → 这里红 → 去改 caps,别让手机发一条注定 403 的请求,
// 也别让 caps 把一条其实允许的路由藏起来)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_ROUTES } from '../../../../electron/engineRoutes.generated'
import { capsForRef, capsForVia, type TargetCaps } from './targetCaps'

const accessOf = (method: string, path: string): string | undefined =>
  ENGINE_ROUTES.find((r) => r.method === method && r.path === path)?.access

/** 每个「unit 上为 false」的能力 → 它挡住的那些路由。 */
const DENIED: Array<[keyof TargetCaps, Array<[string, string]>]> = [
  ['hardDeleteSession', [['DELETE', '/agent/sessions/:id']]],
  ['rewind', [['POST', '/agent/sessions/:id/messages/delete']]],
  ['checkpointRestore', [['POST', '/agent/sessions/:id/checkpoints/restore']]],
  ['putSessionConfig', [['PUT', '/agent/sessions/:id/config']]],
  ['workspaceDelete', [['POST', '/agent/workspace/delete']]],
  ['externalEngines', [['GET', '/agent/engines'], ['GET', '/agent/engines/:id/capabilities'], ['GET', '/agent/engines/:id/assets']]],
]

afterEach(() => vi.unstubAllGlobals())

describe('targetCaps × 远端允许清单', () => {
  it.each(DENIED)('unit.%s = false ⇔ 对应路由 deny-remote', (cap, routes) => {
    expect(capsForVia('unit')[cap]).toBe(false)
    for (const [m, p] of routes) expect(accessOf(m, p), `${m} ${p}`).toBe('deny-remote')
  })

  it('unit 上为 true 的会话能力,它们用到的路由远端 allow(PATCH 配置 / 上传 / 读 / 下载 / 事件流 / 答审批)', () => {
    const caps = capsForVia('unit')
    expect(caps.remoteApprover).toBe(true)
    expect(caps.hostFs).toBe(true)
    for (const [m, p] of [
      ['PATCH', '/agent/sessions/:id/config'], ['POST', '/agent/workspace/upload'], ['GET', '/agent/workspace/read'],
      ['GET', '/agent/workspace/download'], ['GET', '/agent/runs/:id/events'], ['POST', '/agent/runs/:runId/approvals/:approvalId'],
      ['POST', '/agent/sessions/:id/aside'], ['GET', '/health'], ['GET', '/agent/special/config'],
    ]) expect(accessOf(m, p), `${m} ${p}`).toBe('allow')
  })

  it('unit 不能直链资源(缩略图走 blob,凭据永不进 URL)', () => {
    expect(capsForVia('unit').directAssetUrl).toBe(false)
    for (const via of ['local', 'cloud', 'unitPage'] as const) expect(capsForVia(via).directAssetUrl).toBe(true)
  })

  it('home 的三种来路维持改造前行为:本机 / 云端不是远端审批;设备页按 window.tangu.remoteCaller / hostFiles', () => {
    expect(capsForVia('local').remoteApprover).toBe(false)
    expect(capsForVia('cloud')).toMatchObject({ remoteApprover: false, hostFs: false, putSessionConfig: true, hardDeleteSession: true })
    vi.stubGlobal('window', { tangu: { unitPage: true, remoteCaller: true, hostFiles: false } })
    expect(capsForVia('unitPage')).toMatchObject({ remoteApprover: true, hostFs: false })
    expect(capsForRef({ kind: 'home' }).remoteApprover).toBe(true)
    vi.stubGlobal('window', { tangu: { mobile: true } })
    expect(capsForRef({ kind: 'home' })).toMatchObject({ remoteApprover: false, hostFs: false })
    expect(capsForRef({ kind: 'unit', unitId: 'x' })).toMatchObject({ remoteApprover: true, putSessionConfig: false })
  })
})
