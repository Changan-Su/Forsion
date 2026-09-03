// @vitest-environment happy-dom
// 导出 CSV 的 **host 门控**三分支。单独一支测试:台架(真 Chromium)只跑得到 'download' 那一条,
// 'host'(Electron IPC)与 'off'(移动端不渲染按钮)在那边**够不着** —— 门控写错了不会有任何东西翻红。
// 与 scripts/platform-parity.check.cjs 的 KNOWN_GATES 是同一条契约的两半:那边管「登记了没」,这里管「判对了没」。
import { afterEach, describe, expect, it } from 'vitest'
import { csvExportMode } from './csvExport'

type W = typeof globalThis & { amadeus?: unknown; tangu?: unknown }
const w = globalThis as W

afterEach(() => {
  delete w.amadeus
  delete w.tangu
})

describe('csvExportMode(host 门控)', () => {
  it("Electron 桌面(window.amadeus.exportCsv 在)→ 'host'(走主进程保存对话框)", () => {
    w.amadeus = { exportCsv: () => Promise.resolve(null) }
    expect(csvExportMode()).toBe('host')
  })

  it("Tangu Web(有 amadeus 云桥但没有 exportCsv)→ 'download'(浏览器 Blob 下载)", () => {
    w.amadeus = { savePage: () => Promise.resolve() } // 云桥有别的方法,唯独没有这条 IPC
    expect(csvExportMode()).toBe('download')
  })

  it("没有任何桥(台架 / 裸浏览器)→ 'download'", () => {
    expect(csvExportMode()).toBe('download')
  })

  it("移动端(window.tangu.mobile)→ 'off':按钮整个不渲染,不给死按钮", () => {
    w.tangu = { mobile: true }
    expect(csvExportMode()).toBe('off')
  })

  it('移动端即便挂了个非函数的 exportCsv 也不当 host(桥的形状不对就别走 IPC)', () => {
    w.tangu = { mobile: true }
    w.amadeus = { exportCsv: 'nope' }
    expect(csvExportMode()).toBe('off')
  })
})
