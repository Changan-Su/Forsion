/**
 * Agent 自建 Space 插件的热重载(2026-09-11)。**不监听文件**:引擎在 Muse 周期收尾时刷新 status.spaceStamp
 * (Space 目录内最大 mtime),桌面看到戳变了才只重载 `agent-<slug>` 这一个插件(pluginStore.reloadOne;全量
 * reloadExternal 会把所有插件拆装一遍并关掉它们的标签页)。加载失败(setup 抛错 / manifest 缺失或坏)经
 * /agent/special/muse/feedback 回写成 [feedback] 行,Muse 下个周期自己修。
 * 调用点:MuseView 轮询(4s)+ MuseHome 挂载(20s),按戳去重,谁先看到谁做;应用刚起第一次观察到戳会白重载一次(无害)。
 */
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { postMuseFeedback } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'

const loadedStamp = new Map<string, number>()
const reportedStamp = new Map<string, number>()

export const agentPluginId = (slug: string): string => `agent-${slug}`

export async function syncAgentSpace(cfg: TanguDesktopConfig, slug: string, stamp: number | null | undefined): Promise<void> {
  if (typeof stamp !== 'number') return // 旧引擎没有戳 → 不同步(启动时装的那份就是全部)
  if (loadedStamp.get(slug) === stamp) return
  loadedStamp.set(slug, stamp) // 先记后做:并发调用只有一个真跑
  const id = agentPluginId(slug)
  try {
    await usePluginStore.getState().reloadOne(id)
  } catch (e) {
    loadedStamp.delete(slug) // 下次轮询再试
    console.warn(`[agent-space] reload ${id} failed`, e)
    return
  }
  const st = usePluginStore.getState()
  const p = st.plugins.find((x) => x.id === id)
  const err = st.lastSetupError[id] || (p?.blocked === 'invalid' ? p.blockedReason || 'manifest.json invalid' : '')
  if (err && slug === 'muse' && reportedStamp.get(slug) !== stamp) {
    reportedStamp.set(slug, stamp) // 同一份内容只报一次
    void postMuseFeedback(cfg, `Space plugin failed to load: ${err.slice(0, 500)}`).catch(() => {})
  }
}

/** 测试用:清掉戳记忆。 */
export function __resetAgentSpaceSync(): void { loadedStamp.clear(); reportedStamp.clear() }
