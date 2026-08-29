/**
 * 扶桑根 P2P 隐藏窗 preload:RTCPeerConnection/DataChannel 只在 renderer 侧存在,主进程没有——
 * 用一个 about:blank 隐藏窗当 WebRTC 宿主(Chromium 自带栈,零新依赖),本 preload 是它的全部代码。
 *
 * 职责:按主进程指令建对端(发起/应答)、非涓流采集 SDP(**限时**——STUN 不可达时 Chromium 的
 * gathering complete 可拖 30s+,而 B 侧应答还活在隧道派发的 30s 超时里;host 候选在 LAN 上
 * 本来就够连)、DataChannel 文本帧双向搬运。协议语义(信用窗口/abort 口径)全在主进程 unitP2p.ts,
 * 这里只是哑管道。窗口 backgroundThrottling:false(p2pWindow),定时器不被隐藏节流。
 */
import { ipcRenderer } from 'electron'

interface Peer { pc: RTCPeerConnection; dc: RTCDataChannel | null }
const peers = new Map<string, Peer>()

/** 非涓流采集:complete 或限时(4s)先到者胜,发当下已有的候选。 */
const gather = (pc: RTCPeerConnection, ms = 4000): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onState)
      resolve()
    }
    function onState(): void { if (pc.iceGatheringState === 'complete') done() }
    pc.addEventListener('icegatheringstatechange', onState)
  })

const closePeer = (peerId: string, notify: boolean): void => {
  const p = peers.get(peerId)
  if (!p) return
  peers.delete(peerId)
  try { p.dc?.close() } catch { /* 已关 */ }
  try { p.pc.close() } catch { /* 已关 */ }
  if (notify) ipcRenderer.send('p2p:closed', peerId)
}

const wireDc = (peerId: string, dc: RTCDataChannel): void => {
  const p = peers.get(peerId)
  if (p) p.dc = dc
  dc.onopen = () => ipcRenderer.send('p2p:open', peerId)
  dc.onmessage = (e) => { if (typeof e.data === 'string') ipcRenderer.send('p2p:message', peerId, e.data) }
  dc.onclose = () => closePeer(peerId, true)
  dc.onerror = () => closePeer(peerId, true)
}

const makePc = (peerId: string, stun: string[]): RTCPeerConnection => {
  const pc = new RTCPeerConnection({ iceServers: stun.length ? [{ urls: stun }] : [] })
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      closePeer(peerId, true)
    }
  }
  peers.set(peerId, { pc, dc: null })
  return pc
}

// A 侧:建对端 + DataChannel,出 offer。
ipcRenderer.on('p2p:make-offer', (_e, peerId: string, stun: string[]) => {
  void (async () => {
    try {
      const pc = makePc(peerId, stun)
      wireDc(peerId, pc.createDataChannel('unit')) // 有序可靠(默认)——帧协议要的就是 TCP 语义
      await pc.setLocalDescription(await pc.createOffer())
      await gather(pc)
      ipcRenderer.send('p2p:sdp', peerId, pc.localDescription?.sdp ?? null, null)
    } catch (e) {
      closePeer(peerId, false)
      ipcRenderer.send('p2p:sdp', peerId, null, String((e as Error)?.message || e))
    }
  })()
})

// B 侧:收 offer 出 answer,DataChannel 等对面开过来。
ipcRenderer.on('p2p:accept-offer', (_e, peerId: string, stun: string[], offerSdp: string) => {
  void (async () => {
    try {
      const pc = makePc(peerId, stun)
      pc.ondatachannel = (e) => wireDc(peerId, e.channel)
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      await pc.setLocalDescription(await pc.createAnswer())
      await gather(pc)
      ipcRenderer.send('p2p:sdp', peerId, pc.localDescription?.sdp ?? null, null)
    } catch (e) {
      closePeer(peerId, false)
      ipcRenderer.send('p2p:sdp', peerId, null, String((e as Error)?.message || e))
    }
  })()
})

// A 侧:answer 回来收尾握手。
ipcRenderer.on('p2p:finish', (_e, peerId: string, answerSdp: string) => {
  void (async () => {
    const p = peers.get(peerId)
    if (!p) return
    try {
      await p.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch {
      closePeer(peerId, true)
    }
  })()
})

ipcRenderer.on('p2p:send', (_e, peerId: string, text: string) => {
  const dc = peers.get(peerId)?.dc
  if (!dc || dc.readyState !== 'open') {
    console.warn(`[p2p] 丢帧:${peerId} 信道未开(${dc?.readyState ?? 'no-dc'})`) // 静默丢=下一个时序 bug 不可见
    return
  }
  try { dc.send(text) } catch { closePeer(peerId, true) }
})

ipcRenderer.on('p2p:close', (_e, peerId: string) => closePeer(peerId, false))
