// @vitest-environment happy-dom
// 被拒记录跨窗口:每个窗口只写自己那把键,读的时候合起来(Codex 11-23:共写一把键会后写盖先写、主窗激活会抹掉别的窗口还在被拒的记录)。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const OTHER = 'forsion_plugin_host_denials:other-window'
const rec = (api: string, code: string, at: number) => ({ api, code, at })

beforeEach(() => { localStorage.clear(); vi.resetModules(); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
const load = () => import('./hostDenials')

describe('被拒记录跨窗口', () => {
  it('别的窗口写的记录合进来;本窗记的另起一把键,不覆盖它', async () => {
    localStorage.setItem(OTHER, JSON.stringify({ acme: [rec('ctx.tangu.connectChannel', 'external-engine', 1)] }))
    const m = await load()
    m.followHostDenials({ owner: false })
    m.noteHostDenial('acme', 'ctx.tangu.request', 'external-engine')
    expect(m.useHostDenials.getState().byPlugin.acme.map((d) => d.api).sort()).toEqual(['ctx.tangu.connectChannel', 'ctx.tangu.request'])
    expect(JSON.parse(localStorage.getItem(OTHER)!).acme).toHaveLength(1)
  })

  it('本窗插件重新激活只撤本窗的记录,别的窗口那条还在', async () => {
    localStorage.setItem(OTHER, JSON.stringify({ acme: [rec('ctx.tangu.request', 'external-engine', 1)] }))
    const m = await load()
    m.followHostDenials({ owner: false })
    m.noteHostDenial('acme', 'ctx.tangu.connectChannel', 'external-engine')
    m.resetHostDenials('acme')
    expect(m.useHostDenials.getState().byPlugin.acme).toEqual([rec('ctx.tangu.request', 'external-engine', 1)])
  })

  it('主窗开机清掉所有窗口上一次留下的键', async () => {
    localStorage.setItem(OTHER, JSON.stringify({ acme: [rec('ctx.tangu.request', 'external-engine', 1)] }))
    const m = await load()
    m.followHostDenials({ owner: true })
    expect(localStorage.getItem(OTHER)).toBeNull()
    expect(m.useHostDenials.getState().byPlugin).toEqual({})
  })
})
