/**
 * 扶桑根 P2P 主进程管理器:隐藏窗(WebRTC 宿主)生命周期 + 对端注册表 + FrameChannel 适配。
 *
 * 一窗多对端:A 侧发起(makeOffer→finish)与 B 侧应答(acceptOffer)共用同一个隐藏窗;
 * 窗懒建,崩了/关了 = 全部对端 closed(上层各自收尾)。IPC 只认这扇窗的 webContents
 * (sender 校验——别的 renderer 伪造 p2p:* 帧不予理会)。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { FrameChannel } from './unitP2p'

/** 缺省 STUN:国内可达优先(Google 系被墙)。LAN 场景 host 候选就能连,不依赖这俩。
 *  可用 shell 配置 unitP2pStun 覆盖(纯连接基建,不进 UNIT_CONFIG_RW——不是 UI 偏好)。 */
export const DEFAULT_STUN = ['stun:stun.qq.com:3478', 'stun:stun.miwifi.com:3478']

interface PeerEntry {
  msgCbs: ((text: string) => void)[]
  closeCbs: (() => void)[]
  closed: boolean
  /** SDP 结果(offer/answer 采集完成时兑现)。 */
  sdpResolve: ((sdp: string) => void) | null
  sdpReject: ((e: Error) => void) | null
  openResolve: (() => void) | null
}

export interface P2pManagerDeps {
  preloadPath: string
  stunServers: () => string[]
  log: (m: string) => void
}

export class P2pManager {
  private deps: P2pManagerDeps
  private win: BrowserWindow | null = null
  /** 创建期共享 Promise:并发首连各建一窗、后者覆盖前者 = 前者的对端全聋 + 窗残留(Codex H3)。 */
  private winCreating: Promise<BrowserWindow> | null = null
  private peers = new Map<string, PeerEntry>()
  private ipcWired = false
  /** 窗口世代:closeAll 时 +1,作废一切在途创建(否则关停期间飞着的 createWindow 落地成孤儿窗)。 */
  private gen = 0

  constructor(deps: P2pManagerDeps) {
    this.deps = deps
  }

  private wireIpc(): void {
    if (this.ipcWired) return
    this.ipcWired = true
    const fromWin = (e: Electron.IpcMainEvent): boolean => !!this.win && !this.win.isDestroyed() && e.sender.id === this.win.webContents.id
    ipcMain.on('p2p:sdp', (e, peerId: string, sdp: string | null, err: string | null) => {
      if (!fromWin(e)) return
      const p = this.peers.get(peerId)
      if (!p) return
      if (sdp) p.sdpResolve?.(sdp)
      else p.sdpReject?.(new Error(err || 'SDP 采集失败'))
      p.sdpResolve = null
      p.sdpReject = null
    })
    ipcMain.on('p2p:open', (e, peerId: string) => {
      if (!fromWin(e)) return
      const p = this.peers.get(peerId)
      p?.openResolve?.()
      if (p) p.openResolve = null
    })
    ipcMain.on('p2p:message', (e, peerId: string, text: string) => {
      if (!fromWin(e)) return
      const p = this.peers.get(peerId)
      if (!p || p.closed) return
      for (const cb of p.msgCbs) cb(String(text))
    })
    ipcMain.on('p2p:closed', (e, peerId: string) => {
      if (!fromWin(e)) return
      this.finishPeer(peerId)
    })
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win
    if (this.winCreating) return this.winCreating
    this.winCreating = this.createWindow().finally(() => { this.winCreating = null })
    return this.winCreating
  }

  private async createWindow(): Promise<BrowserWindow> {
    this.wireIpc()
    const genAtStart = this.gen
    const win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // 隐藏窗定时器/ICE keepalive 不许被节流:信用窗口的 ack 循环与打洞保活都跑在这
        backgroundThrottling: false,
      },
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
      // 窗没了 = 全部对端断(RTCPeerConnection 随 renderer 灭)
      for (const id of [...this.peers.keys()]) this.finishPeer(id)
    })
    await win.loadURL('about:blank')
    if (this.gen !== genAtStart) { // 创建期间 closeAll 过:这扇窗已无主,就地销毁
      win.destroy()
      throw new Error('P2P 已关停(身份变化)')
    }
    this.win = win
    return win
  }

  private finishPeer(peerId: string): void {
    const p = this.peers.get(peerId)
    if (!p || p.closed) return
    p.closed = true
    p.sdpReject?.(new Error('对端已关闭'))
    p.sdpResolve = null
    p.sdpReject = null
    p.openResolve = null
    this.peers.delete(peerId)
    for (const cb of p.closeCbs) cb()
  }

  private newPeer(): { peerId: string; entry: PeerEntry } {
    const peerId = randomUUID()
    const entry: PeerEntry = { msgCbs: [], closeCbs: [], closed: false, sdpResolve: null, sdpReject: null, openResolve: null }
    this.peers.set(peerId, entry)
    return { peerId, entry }
  }

  private waitSdp(entry: PeerEntry, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SDP 采集超时')), timeoutMs)
      entry.sdpResolve = (sdp) => { clearTimeout(timer); resolve(sdp) }
      entry.sdpReject = (e) => { clearTimeout(timer); reject(e) }
    })
  }

  /** A 侧:建对端出 offer。返回 peerId + offer SDP。 */
  async makeOffer(): Promise<{ peerId: string; sdp: string }> {
    const win = await this.ensureWindow()
    const { peerId, entry } = this.newPeer()
    const done = this.waitSdp(entry, 8000)
    win.webContents.send('p2p:make-offer', peerId, this.deps.stunServers())
    try {
      return { peerId, sdp: await done }
    } catch (e) {
      this.closePeer(peerId)
      throw e
    }
  }

  /** B 侧:收 offer 出 answer。等信道开门由调用方 waitOpen。 */
  async acceptOffer(offerSdp: string): Promise<{ peerId: string; sdp: string }> {
    const win = await this.ensureWindow()
    const { peerId, entry } = this.newPeer()
    const done = this.waitSdp(entry, 8000)
    win.webContents.send('p2p:accept-offer', peerId, this.deps.stunServers(), offerSdp)
    try {
      return { peerId, sdp: await done }
    } catch (e) {
      this.closePeer(peerId)
      throw e
    }
  }

  /** A 侧:answer 回来收尾握手。 */
  finish(peerId: string, answerSdp: string): void {
    if (!this.win || this.win.isDestroyed() || !this.peers.has(peerId)) return
    this.win.webContents.send('p2p:finish', peerId, answerSdp)
  }

  /** 等 DataChannel 开门(打洞成败在此见分晓)。 */
  waitOpen(peerId: string, timeoutMs: number): Promise<void> {
    const p = this.peers.get(peerId)
    if (!p) return Promise.reject(new Error('对端不存在'))
    if (p.closed) return Promise.reject(new Error('对端已关闭'))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('P2P 打洞超时')), timeoutMs)
      p.openResolve = () => { clearTimeout(timer); resolve() }
      p.closeCbs.push(() => { clearTimeout(timer); reject(new Error('对端在握手期关闭')) })
    })
  }

  /** 把对端包成 FrameChannel(unitP2p 语义层的运输面)。 */
  channel(peerId: string): FrameChannel {
    return {
      send: (text) => {
        const p = this.peers.get(peerId)
        if (!p || p.closed || !this.win || this.win.isDestroyed()) throw new Error('信道已关闭')
        this.win.webContents.send('p2p:send', peerId, text)
      },
      onMessage: (cb) => { this.peers.get(peerId)?.msgCbs.push(cb) },
      onClose: (cb) => {
        const p = this.peers.get(peerId)
        if (!p || p.closed) { cb(); return }
        p.closeCbs.push(cb)
      },
      close: () => this.closePeer(peerId),
    }
  }

  closePeer(peerId: string): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('p2p:close', peerId)
    this.finishPeer(peerId)
  }

  /** 身份变化点(登录/登出/换号/401)必须全收:P2P 是**站着的已鉴权信道**,不像 T2 逐请求
   *  重验 owner——不收的话旧身份的对端在新身份下继续活着(advisor P0)。 */
  closeAll(): void {
    this.gen += 1 // 作废在途创建
    for (const id of [...this.peers.keys()]) this.closePeer(id)
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
