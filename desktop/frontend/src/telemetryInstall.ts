/**
 * 商店安装的遥测(契约 §9 plugin_install / plugin_deps)。四个入口(商店、对话里的插件卡、Muse 卡、插件引导)和「一键补前置」
 * 那条链共用这一个跟踪器:主进程 market:install 本身不动,阶段取安装进度最后报到的那一步,失败原因按报错原文归类成枚举
 * (shared/telemetryKeys.classifyInstallError),**原文不发**。id 是商店条目 id(公开的)。
 */
import { classifyInstallError, type InstallStage } from '../../shared/telemetryKeys'
import { onInstallProgress } from './services/marketService'
import { sendTelemetry, telemetryOn } from './telemetrySend'

export type InstallEntry = 'store' | 'chat-card' | 'muse-card' | 'plugin-onboarding' | 'deps'
const KINDS = ['plugin', 'skill', 'agent', 'space', 'theme', 'amadeus-plugin']
const SOURCES = ['github', 'npm', 'zip']

export interface InstallTracker {
  /** 装上了。type = 主进程实测的类型;pluginId = Forsion 插件的装载 id(拿来看它跑没跑起来);restart = 要不要重启后端。 */
  done(o: { type?: string; pluginId?: string; restart?: boolean }): void
  /** 没装上(e = 抛出来的那个错;只拿来归类)。 */
  fail(e: unknown): void
}
const NOOP: InstallTracker = { done() {}, fail() {} }

/** 装完之后 Forsion 插件跑没跑起来:setup 抛错 = activate;前置没齐 = deps;别的(用户本来就关着它等)算装成。
 *  按需加载插件仓库:对话消息里的插件卡被 node 测试整文件引用,静态 import 会把读 window 的模块一起拉进来(同 MarketPluginCards 的 postInstall)。 */
export async function activationProblem(pluginId: string | undefined): Promise<'activate' | 'deps' | null> {
  if (!pluginId) return null
  const { usePluginStore, unmetPluginDeps } = await import('@amadeus/plugins/pluginStore')
  const s = usePluginStore.getState()
  const p = s.plugins.find((x) => x.id === pluginId)
  if (!p || s.activeIds.includes(p.id)) return null
  if (s.lastSetupError[p.id]) return 'activate'
  return unmetPluginDeps(p, s).length ? 'deps' : null
}

/** 开始跟踪一次安装(点下去那一刻调)。没人接遥测就什么都不做。 */
export function trackMarketInstall(entry: InstallEntry, card: { id: string; type?: string; source?: string }): InstallTracker {
  if (!telemetryOn()) return NOOP
  const t0 = Date.now()
  let lastPhase: InstallStage | undefined
  let received = 0
  let off: (() => void) | null = null
  try {
    off = onInstallProgress((p) => {
      if (p.id !== card.id) return
      lastPhase = p.phase
      if (typeof p.received === 'number' && p.received > received) received = p.received
    })
  } catch { /* 没有进度事件就不知道阶段与大小 */ }
  let ended = false
  const end = (props: Record<string, unknown>, type: string | undefined): void => {
    if (ended) return
    ended = true
    try { off?.() } catch { /* ignore */ }
    sendTelemetry('plugin_install', {
      pluginId: card.id, pluginOfficial: true, entry,
      kind: KINDS.includes(type ?? '') ? type : 'other',
      source: SOURCES.includes(card.source ?? '') ? card.source : 'other',
      durationMs: Math.max(0, Date.now() - t0),
      ...(received > 0 ? { sizeKb: Math.ceil(received / 1024) } : {}),
      ...props,
    })
  }
  return {
    done(o) {
      const settle = (problem: 'activate' | 'deps' | null): void => end(problem
        ? { stage: 'activate', outcome: 'error', errorClass: problem, restart: !!o.restart }
        : { stage: 'done', outcome: 'done', restart: !!o.restart }, o.type || card.type)
      if (o.type !== 'amadeus-plugin') { settle(null); return }
      void activationProblem(o.pluginId).then(settle, () => settle(null)) // 遥测不拖累安装:查不了就按装成算
    },
    fail(e) {
      try {
        const err = e as { raw?: unknown; message?: unknown } | null
        const { stage, errorClass } = classifyInstallError(err?.raw ?? err?.message ?? e, lastPhase)
        end({ stage, outcome: 'error', errorClass }, card.type)
      } catch { /* ignore */ }
    },
  }
}

/** 一键补前置一整条链的结果(MarketModal.onInstallDeps)。failedAt = 第几步失败(从 1 数)。 */
export function reportDepsChain(o: { total: number; installed: number; failedAt?: number; outcome: 'ready' | 'not-ready' | 'not-running' | 'failed' }): void {
  sendTelemetry('plugin_deps', { total: o.total, installed: o.installed, ...(o.failedAt ? { failedAt: o.failedAt } : {}), outcome: o.outcome })
}
