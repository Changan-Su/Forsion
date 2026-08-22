/**
 * 多通道(微信/Telegram/QQ)状态 store:15s 轮询 GET /agent/channels + 设置/连接动作。
 * 与 appStore 单向解耦(经 getState() 读 cfg/tr);每次刷新把「已启用通道 → 工作区文件夹」
 * 快照写进 appStore.channelWorkspaces,供侧栏会话列表按文件夹分组(替代旧的 wechat 硬编码组)。
 * 失败纪律:云端/老后端无 /agent/channels 时静默(通道仅内置本地后端可用)。
 */
import { create } from 'zustand'
import { useApp } from './appStore'
import {
  listChannels, saveChannelConfig, connectChannel, disconnectChannel,
  type ChannelStatus, type ChannelConfigPatch,
} from '../services/backendService'
import type { ChannelKind, WorkspaceDescriptor } from '../types'

export type { ChannelStatus }

let pollTimer: number | null = null

const cfg = () => useApp.getState().cfg

/** 通道显示名(设置卡与侧栏文件夹同源)。 */
export function channelLabel(kind: ChannelKind): string {
  const tr = useApp.getState().tr
  return tr(`channel.name.${kind}`)
}

function pushWorkspaces(channels: ChannelStatus[]): void {
  const folders: WorkspaceDescriptor[] = channels
    .filter((c) => c.enabled && c.workspace)
    .map((c) => ({ key: c.workspace, name: channelLabel(c.kind), kind: 'channel', channel: c.kind, path: c.workspace, system: true }))
  const prev = useApp.getState().channelWorkspaces
  // 浅比较避免每 15s 触发一次全侧栏重渲。
  const same = prev.length === folders.length && prev.every((p, i) => p.key === folders[i].key && p.name === folders[i].name && p.channel === folders[i].channel)
  if (!same) useApp.setState({ channelWorkspaces: folders })
}

interface ChannelsState {
  channels: ChannelStatus[]
  available: boolean
  loaded: boolean
  refresh(): Promise<void>
  save(kind: ChannelKind, patch: ChannelConfigPatch): Promise<void>
  connect(kind: ChannelKind): Promise<{ label: string; sessionId: string }>
  disconnect(kind: ChannelKind, accountId?: string): Promise<void>
  startPolling(): void
  stopPolling(): void
}

export const useChannels = create<ChannelsState>((set, get) => ({
  channels: [],
  available: false,
  loaded: false,

  refresh: async () => {
    if (!window.tangu?.backendStatus) return // 通道仅内置本地后端形态可用
    try {
      const r = await listChannels(cfg())
      // 形状防御:老后端/桩若 200 返回但缺 channels,undefined 会毒化 store,侧栏迭代直接崩(ErrorBoundary 整片吃掉会话列表)
      const channels = Array.isArray(r.channels) ? r.channels : []
      set({ channels, available: !!r.available, loaded: true })
      pushWorkspaces(channels)
    } catch { /* 静默:断连/云端/老后端 */ }
  },

  save: async (kind, patch) => {
    await saveChannelConfig(cfg(), kind, patch)
    await get().refresh()
  },

  connect: async (kind) => {
    const r = await connectChannel(cfg(), kind)
    await get().refresh()
    void useApp.getState().refreshSessions(cfg()) // 连接即新会话 → 列表立即可见
    return r
  },

  disconnect: async (kind, accountId) => {
    await disconnectChannel(cfg(), kind, accountId)
    await get().refresh()
  },

  startPolling: () => {
    if (pollTimer != null) return
    const tick = () => {
      if (useApp.getState().connState !== 'ok') return
      void get().refresh()
    }
    pollTimer = window.setInterval(tick, 15_000)
    tick()
  },

  stopPolling: () => {
    if (pollTimer != null) { window.clearInterval(pollTimer); pollTimer = null }
  },
}))
