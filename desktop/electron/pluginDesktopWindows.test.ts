/** 插件桌面小窗的主进程名册(electron/pluginDesktopWindows.ts):只认主窗、第一次询问记住答案、读不出来不写回、每插件 3 扇、
 *  窗口名一次性放行、同 key 不另开、mac 点完交还前台、主窗换页全关。真窗口那半在 scripts/desktop-window.check.cjs。
 *  负对照(11-26 已实跑红):读失败的两道闸(ensureGrant、writeGrant)都去掉 →「授权文件读不出来」红;countOf 不算挂起的 →「每个插件最多 3 扇」红;
 *  handleWindowOpen 放行任意前缀名 →「只放行刚发出去的名字」红;released 不看前台是不是自己 →「前台已经是 Forsion」红。
 *  评审补的(11-26 实跑红):开着的不排除正在关的 →「关的过程中同 key 马上重开」红;换屏从当前位置夹并改记住的 →「拔掉副屏」红;
 *  写回时丢掉认不出来的条目 →「原样写回」红;不看主窗换页代数 →「还在等询问的 prepare」红。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginDesktopWindows, GRANTS_FILE, POSITIONS_FILE, type PluginDesktopDeps } from './pluginDesktopWindows'
import type { DesktopScreen } from '../shared/desktopWindow'

const screen: DesktopScreen = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 800 }, scaleFactor: 2 }

class FakeContents {
  destroyed = false
  sent: unknown[][] = []
  handlers = new Map<string, (...a: unknown[]) => void>()
  isDestroyed(): boolean { return this.destroyed }
  send(...a: unknown[]): void { this.sent.push(a) }
  on(ev: string, fn: (...a: unknown[]) => void): this { this.handlers.set(ev, fn); return this }
  setWindowOpenHandler(): void {}
}
class FakeWin {
  destroyed = false
  visible = false
  onTop: unknown[] = []
  ignore: unknown[] = []
  bounds: unknown = null
  webContents = new FakeContents()
  listeners = new Map<string, () => void>()
  isDestroyed(): boolean { return this.destroyed }
  setMenu(): void {}
  setAlwaysOnTop(...a: unknown[]): void { this.onTop = a }
  setVisibleOnAllWorkspaces(): void {}
  setBounds(b: unknown): void { this.bounds = b }
  setIgnoreMouseEvents(...a: unknown[]): void { this.ignore.push(a) }
  showInactive(): void { this.visible = true }
  hide(): void { this.visible = false }
  isVisible(): boolean { return this.visible }
  on(ev: string, fn: () => void): this { this.listeners.set(ev, fn); return this }
  close(): void { if (this.destroyed) return; this.destroyed = true; this.listeners.get('closed')?.() }
  destroy(): void { this.close() }
}

let dir: string
let mainWc: FakeContents
let other: FakeContents
let confirm: ReturnType<typeof vi.fn>
let mac: { front: ReturnType<typeof vi.fn>; activate: ReturnType<typeof vi.fn> }

function make(over: Partial<PluginDesktopDeps> = {}) {
  return createPluginDesktopWindows({
    userDataDir: dir, platform: 'darwin',
    mainContents: () => mainWc as unknown as Electron.WebContents,
    screens: () => [screen], cursorWorkArea: () => screen.workArea,
    confirm: confirm as unknown as PluginDesktopDeps['confirm'], onChanged: () => {}, mac, selfPid: 100,
    ...over,
  })
}
const req = (over: Record<string, unknown> = {}) => ({ pluginId: 'pet', pluginName: 'Pet', key: '', title: '', width: 160, height: 160, pin: true, ...over })
/** prepare + 主窗 window.open + did-create-window,走完一扇。 */
async function open(m: ReturnType<typeof make>, over: Record<string, unknown> = {}) {
  const r = await m.prepare(mainWc as unknown as Electron.WebContents, req(over))
  if (!r.ok) return { r, win: null }
  const win = new FakeWin()
  if (!r.existing) m.onDidCreateWindow(win as unknown as Electron.BrowserWindow, { frameName: r.frameName })
  return { r, win }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-test-'))
  mainWc = new FakeContents(); other = new FakeContents()
  confirm = vi.fn(async () => true)
  mac = { front: vi.fn(async () => ({ pid: 42 })), activate: vi.fn(async () => true) }
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('只认主窗', () => {
  it('别的窗口来开:不问授权、不开窗;那扇已经在主窗开着 = elsewhere', async () => {
    const m = make()
    expect(await m.prepare(other as unknown as Electron.WebContents, req())).toEqual({ ok: false, reason: 'unavailable' })
    expect(confirm).not.toHaveBeenCalled()
    await open(m)
    expect(await m.prepare(other as unknown as Electron.WebContents, req())).toEqual({ ok: false, reason: 'elsewhere' })
  })
})

describe('第一次询问', () => {
  it('问一次、记住允许;同插件再开不再问', async () => {
    const m = make()
    await open(m)
    await open(m, { key: 'b' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(path.join(dir, GRANTS_FILE), 'utf8')).grants).toEqual({ pet: 'allow' })
    expect(m.grantOf('pet')).toBe('allow')
  })
  it('不允许也记住:之后直接 denied,不再问', async () => {
    confirm.mockResolvedValue(false)
    const m = make()
    expect((await m.prepare(mainWc as unknown as Electron.WebContents, req())).ok).toBe(false)
    expect(await m.prepare(mainWc as unknown as Electron.WebContents, req())).toEqual({ ok: false, reason: 'denied' })
    expect(confirm).toHaveBeenCalledTimes(1)
  })
  it('授权文件读不出来:照样问,问完不写回(不拿坏文件去盖)', async () => {
    fs.writeFileSync(path.join(dir, GRANTS_FILE), '{oops')
    const m = make()
    expect((await open(m)).r.ok).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(path.join(dir, GRANTS_FILE), 'utf8')).toBe('{oops')
  })
  it('同时开两扇只弹一个框', async () => {
    let yes!: (v: boolean) => void
    confirm.mockImplementation(() => new Promise<boolean>((r) => { yes = r }))
    const m = make()
    const a = m.prepare(mainWc as unknown as Electron.WebContents, req({ key: 'a' }))
    const b = m.prepare(mainWc as unknown as Electron.WebContents, req({ key: 'b' }))
    await Promise.resolve(); await Promise.resolve()
    yes(true)
    expect([(await a).ok, (await b).ok]).toEqual([true, true])
    expect(confirm).toHaveBeenCalledTimes(1)
  })
  it('收回授权:关掉它所有的小窗,下次再问', async () => {
    const m = make()
    const { win } = await open(m)
    m.revoke('pet')
    expect(win!.destroyed).toBe(true)
    expect(m.grantOf('pet')).toBeNull()
    await open(m)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})

describe('护栏与复用', () => {
  it('每个插件最多 3 扇(挂起的也算);别的插件不受影响', async () => {
    const m = make()
    await open(m, { key: '1' })
    await open(m, { key: '2' })
    await m.prepare(mainWc as unknown as Electron.WebContents, req({ key: '3' })) // 挂起,还没 window.open
    expect(await m.prepare(mainWc as unknown as Electron.WebContents, req({ key: '4' }))).toEqual({ ok: false, reason: 'limit', limit: 3 })
    expect((await open(m, { pluginId: 'other' })).r.ok).toBe(true)
  })
  it('同插件同 key 已开着:交回同一个名字(existing),不另开', async () => {
    const m = make()
    const first = await open(m)
    const again = await m.prepare(mainWc as unknown as Electron.WebContents, req())
    expect(again.ok && again.existing && first.r.ok && again.frameName === first.r.frameName).toBe(true)
    expect(m.list()).toHaveLength(1)
  })
  it('尺寸夹到工作区一半;位置按 key 记,关了再开回到原处', async () => {
    const m = make()
    const { r, win } = await open(m, { width: 5000, height: 5000 })
    expect(r.ok && r.bounds.width === 720 && r.bounds.height === 400).toBe(true)
    m.setBounds(mainWc as unknown as Electron.WebContents, r.ok ? r.id : '', { x: 200, y: 300 })
    win!.close()
    const back = await m.prepare(mainWc as unknown as Electron.WebContents, req({ width: 100, height: 100 }))
    expect(back.ok && back.bounds).toEqual({ x: 200, y: 300, width: 100, height: 100 })
    expect(JSON.parse(fs.readFileSync(path.join(dir, POSITIONS_FILE), 'utf8')).bounds['pet#']).toMatchObject({ x: 200, y: 300 })
  })
  it('位置文件读不出来:放缺省位置,之后也不写回', async () => {
    fs.writeFileSync(path.join(dir, POSITIONS_FILE), 'not json')
    const m = make()
    const { r, win } = await open(m)
    expect(r.ok && r.bounds).toEqual({ x: 1256, y: 641, width: 160, height: 160 })
    win!.close()
    m.persistNow()
    expect(fs.readFileSync(path.join(dir, POSITIONS_FILE), 'utf8')).toBe('not json')
  })
  it('别的窗口来挪:不理', async () => {
    const m = make()
    const { r } = await open(m)
    expect(m.setBounds(other as unknown as Electron.WebContents, r.ok ? r.id : '', { x: 5, y: 5 })).toBeNull()
  })
})

describe('窗口名与开窗选项', () => {
  it('只放行刚发出去的名字;不是我们的前缀 = null(交给原处理器)', async () => {
    const m = make()
    expect(m.handleWindowOpen({ frameName: '', url: 'https://example.com' })).toBeNull()
    expect(m.handleWindowOpen({ frameName: 'forsion-plugin-desktop-guess', url: 'about:blank' })).toEqual({ action: 'deny' })
    const r = await m.prepare(mainWc as unknown as Electron.WebContents, req())
    if (!r.ok) throw new Error('prepare failed')
    expect(m.handleWindowOpen({ frameName: r.frameName, url: 'https://evil.example' })).toEqual({ action: 'deny' })
    const allow = m.handleWindowOpen({ frameName: r.frameName, url: 'about:blank' })
    expect(allow?.action).toBe('allow')
    expect(allow && 'overrideBrowserWindowOptions' in allow && allow.overrideBrowserWindowOptions).toMatchObject({
      frame: false, transparent: true, hasShadow: false, skipTaskbar: true, focusable: false, type: 'panel', alwaysOnTop: true,
    })
  })
  it('建好的窗:置顶、不抢焦点地显示;关了从名册划掉并告诉主窗', async () => {
    const m = make()
    const { r, win } = await open(m)
    expect(win!.visible).toBe(true)
    expect(win!.onTop).toEqual([true, 'floating'])
    win!.close()
    expect(m.list()).toHaveLength(0)
    expect(mainWc.sent).toContainEqual(['desktopWindow:closed', r.ok ? r.id : ''])
  })
  it('主窗换页(重载):全关', async () => {
    const m = make()
    m.attachMain(mainWc as unknown as Electron.WebContents)
    const { win } = await open(m)
    mainWc.handlers.get('did-start-navigation')!({}, 'app://x', false, true)
    expect(win!.destroyed).toBe(true)
  })
  it('暂时全部藏起来 / 全部显示', async () => {
    const m = make()
    const { win } = await open(m)
    m.setHidden(true)
    expect(win!.visible).toBe(false)
    m.setHidden(false)
    expect(win!.visible).toBe(true)
  })
})

describe('点穿与 mac 交还前台', () => {
  it('鼠标进到宠物上:关点穿、记下此刻的前台;松手交还(只在前台是 Forsion 时切)', async () => {
    const m = make()
    const { r, win } = await open(m)
    const id = r.ok ? r.id : ''
    m.passThrough(mainWc as unknown as Electron.WebContents, id, true)
    m.passThrough(mainWc as unknown as Electron.WebContents, id, false)
    expect(win!.ignore).toEqual([[true, { forward: true }], [false]])
    await vi.waitFor(() => expect(mac.front).toHaveBeenCalled())
    await Promise.resolve()
    m.released(mainWc as unknown as Electron.WebContents, id)
    expect(mac.activate).toHaveBeenCalledWith(42, 100)
  })
  it('前台已经是 Forsion 自己(用户本来就在用它):不切', async () => {
    mac.front.mockResolvedValue({ pid: 100 })
    const m = make()
    const { r } = await open(m)
    m.passThrough(mainWc as unknown as Electron.WebContents, r.ok ? r.id : '', false)
    await vi.waitFor(() => expect(mac.front).toHaveBeenCalled())
    await Promise.resolve()
    m.released(mainWc as unknown as Electron.WebContents, r.ok ? r.id : '')
    expect(mac.activate).not.toHaveBeenCalled()
  })
  it('Linux 没有 forward:恒不点穿', async () => {
    const m = make({ platform: 'linux' })
    const { r, win } = await open(m)
    expect(r.ok && r.clickThrough).toBe(false)
    m.passThrough(mainWc as unknown as Electron.WebContents, r.ok ? r.id : '', true)
    expect(win!.ignore).toEqual([])
  })
})

describe('11-26 评审补的几条', () => {
  const mw = (): Electron.WebContents => mainWc as unknown as Electron.WebContents
  it('关的过程中(Electron 还没关完)同 key 马上重开:另开一扇,不交回那扇要死的', async () => {
    const m = make()
    const { r, win } = await open(m)
    win!.close = () => { /* 先不关完:模拟 Electron 异步关窗 */ }
    m.close(r.ok ? r.id : '')
    const again = await m.prepare(mw(), req())
    expect(again.ok && !again.existing && again.id !== (r.ok ? r.id : '')).toBe(true)
  })
  it('主窗换页时还在等询问的 prepare:回来作废,不替旧页占名额', async () => {
    let answer!: (v: boolean) => void
    confirm.mockImplementation(() => new Promise<boolean>((res) => { answer = res }))
    const m = make()
    const p = m.prepare(mw(), req({ key: 'a' }))
    m.closeAll() // 主窗重载
    answer(true)
    expect(await p).toEqual({ ok: false, reason: 'unavailable' })
    expect(m._pending.size).toBe(0)
  })
  it('位置文件里认不出来的条目原样写回', async () => {
    fs.writeFileSync(path.join(dir, POSITIONS_FILE), JSON.stringify({ version: 1, bounds: { 'other#k': { x: null, y: 5, width: 10, height: 10 } } }))
    const m = make()
    const { r } = await open(m)
    m.setBounds(mw(), r.ok ? r.id : '', { x: 200, y: 300 })
    m.persistNow()
    const saved = JSON.parse(fs.readFileSync(path.join(dir, POSITIONS_FILE), 'utf8')).bounds
    expect(saved['other#k']).toEqual({ x: null, y: 5, width: 10, height: 10 })
    expect(saved['pet#']).toMatchObject({ x: 200, y: 300 })
  })
  it('拔掉副屏:窗口夹回主屏,但记住的还是用户摆的位置;插回来再开回到原处', async () => {
    const side: DesktopScreen = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
    let screens = [screen, side]
    const m = make({ screens: () => screens })
    const { r, win } = await open(m)
    m.setBounds(mw(), r.ok ? r.id : '', { x: 2000, y: 300 })
    screens = [screen]
    m.screensChanged()
    expect((win!.bounds as { x: number }).x).toBeLessThanOrEqual(1440 - 32)
    // 夹过的位置推给渲染层照收(渲染层不回送 setBounds,见 pluginDesktopWindow.test「换屏」)
    const pushed = mainWc.sent.find((s) => s[0] === 'desktopWindow:screensChanged') as [string, unknown, Record<string, unknown>]
    expect(pushed[2][r.ok ? r.id : '']).toEqual(win!.bounds)
    win!.close()
    expect(JSON.parse(fs.readFileSync(path.join(dir, POSITIONS_FILE), 'utf8')).bounds['pet#']).toMatchObject({ x: 2000, y: 300 })
    screens = [screen, side]
    const back = await m.prepare(mw(), req())
    expect(back.ok && back.bounds).toMatchObject({ x: 2000, y: 300 })
  })
  it('撤回时授权文件写不成:报 false(设置页别显示成已撤回)', async () => {
    const m = make()
    await open(m)
    fs.writeFileSync(path.join(dir, GRANTS_FILE), '{ broken')
    expect(m.revoke('pet')).toBe(false)
    expect(fs.readFileSync(path.join(dir, GRANTS_FILE), 'utf8')).toBe('{ broken')
  })
  it('子窗页面的 moveTo / resizeTo 与 beforeunload 都拦下', async () => {
    const m = make()
    const { win } = await open(m)
    for (const ev of ['content-bounds-updated', 'will-prevent-unload', 'will-navigate']) {
      const prevent = vi.fn()
      win!.webContents.handlers.get(ev)?.({ preventDefault: prevent })
      expect(prevent, ev).toHaveBeenCalled()
    }
  })
  it('离开宠物再进来:重新记前台(这期间用户可能换了应用)', async () => {
    const m = make()
    const { r } = await open(m)
    const id = r.ok ? r.id : ''
    m.passThrough(mw(), id, false)
    await vi.waitFor(() => expect(mac.front).toHaveBeenCalledTimes(1))
    mac.front.mockResolvedValue({ pid: 77 })
    m.passThrough(mw(), id, true)
    m.passThrough(mw(), id, false)
    await vi.waitFor(() => expect(mac.front).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    m.released(mw(), id)
    expect(mac.activate).toHaveBeenLastCalledWith(77, 100)
  })
})
