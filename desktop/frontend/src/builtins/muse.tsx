/**
 * 内置插件「Muse」= Muse Space:主=`muse-library`(**稳定的宿主视图**,内部渲染 Muse **自建插件** agent-muse 的 home 视图;
 * 没有就以 Library 浏览器打底 + 一行提示),右=Muse 面板(待批 / 追踪 / TODO,复用 components/MuseView)。
 * 为什么主槽不直接放 `plugin:agent-muse:home`:持久化布局冷启动恢复时插件还没求值,plugin:* 视图会被整个丢掉
 * (08-27 那个「插件 Space 重启后点进去是 Tangu 内容」的机理);布局里永远只存宿主类型就没这条路。
 * ⚠️类型名沿用 09-10 的 `muse-library`(那天它是 Library 浏览器):命名布局 `space:muse` 里存的主区就是这个名字,
 * 换新名 = 老布局 applyNamed 成功、build() 不跑、插件视图永远出不来;沿用旧名 = 零迁移。纯 Library 浏览器改叫 `muse-files`。
 * 热重载见 builtins/agentSpaceSync。形态照 builtins/calendar:
 *  · **启动** = spaces.tsx 的 SPACES 里按开关声明式带上(ribbon 默认序 + 启动恢复);
 *  · **运行时开关** = installMuseSpace / removeMuseSpace(applyBuiltin 调),幂等。
 * 视图 lazyRetry:builtins/index 要能在 node 单测里导入。
 * 「Agent Space 赋予其他 agent」的扩展位:museSpace 由 agentSpaceFor(slug) 生成,只是今天只注册 muse
 * (库树端点 /agent/special/muse/library 也还只有 muse 的;换成 per-slug 端点即可推广)。
 */
import { Suspense, useEffect } from 'react'
import { Sparkles } from 'lucide-react'
import {
  registerView, registerSpace, unregisterSpace, addRibbonIcon, removeRibbonIcon,
  setActiveSpace, useSpaceStore, useWorkspace, Skeleton,
} from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel, ViewProps } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { PluginViewHost } from '../pluginViews'
import { getMuseStatus } from '../services/backendService'
import { agentPluginId, syncAgentSpace } from './agentSpaceSync'
import { lazyRetry } from '../lazyRetry'
import { useApp } from '../stores/appStore'
import { PRODUCT } from '../product'
import { SpaceButton } from '../components/SpaceButton'
import { openSession } from '../sessionNav'

const MuseLibraryView = lazyRetry(() => import('../views/MuseLibraryView').then((m) => ({ default: m.MuseLibraryView })))
const MuseViewLazy = lazyRetry(() => import('../components/MuseView').then((m) => ({ default: m.MuseView })))

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()

function MusePanel() {
  const cfg = useApp((s) => s.cfg)
  const sessions = useApp((s) => s.sessions)
  return <MuseViewLazy cfg={cfg} sessions={sessions} onInjected={(id) => openSession(id)} />
}

/** Muse Space 主槽:agent-muse 插件注册了 home 视图 → 用 pluginViews 同一份 DOM-mount 契约渲染它;否则空白态。
 *  挂载时与每 20s 拉一次 status 按戳热重载(面板关着也能刷新)。 */
function MuseHome(props: ViewProps) {
  const cfg = useApp((s) => s.cfg)
  const tr = useApp((s) => s.tr)
  const def = usePluginStore((s) => s.views.find((o) => o.pluginId === agentPluginId('muse') && o.item.id === 'home')?.item)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      if (!alive) return
      const st = await getMuseStatus(cfg).catch(() => null)
      if (alive) await syncAgentSpace(cfg, 'muse', st?.spaceStamp)
      if (alive) timer = setTimeout(() => void tick(), 20_000)
    }
    void tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [cfg])
  if (def) return <div data-muse-space="plugin" style={{ height: '100%', minHeight: 0 }}><PluginViewHost def={def} {...props} /></div>
  return (
    <div data-muse-space="empty" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="hint" style={{ padding: '8px 14px 0', flex: 'none' }}>{tr('muse.spaceEmpty')}</div>
      <div style={{ flex: 1, minHeight: 0 }}><Suspense fallback={<Skeleton variant="document" />}><MuseLibraryView {...props} /></Suspense></div>
    </div>
  )
}

/** 通用形状:某个 agent 的 Space = 主槽 `<slug>-library`(它自建的插件视图 / 空白态)+ 右栏它的面板。今天只实例化 muse。 */
export function agentSpaceFor(slug: 'muse'): SpaceDefinition {
  const side: Record<'left' | 'right', PersistedPanel[]> = { left: [], right: [{ type: `${slug}-panel`, params: {} }] }
  return {
    id: slug,
    name: () => app().tr('space.muse'),
    icon: Sparkles,
    sidebarDefaults: side,
    build() {
      ws().setSidebarDefaults(side)
      ws().openView(`${slug}-library`, {}, 'main')
      ws().openView(`${slug}-panel`, {}, 'right')
    },
  }
}

export const museSpace: SpaceDefinition = agentSpaceFor('muse')

/** 产品档案点名 + 本地 tangu 后端(端点都是本地特性;Tangu Web 无 backendStatus → 不注册)。 */
export const museAvailable = (): boolean => PRODUCT.spaces.includes('muse') && !!window.tangu?.backendStatus

export function installMuseViews(): void {
  registerView({
    type: 'muse-library', kind: 'page', displayName: () => app().tr('view.museHome'), icon: Sparkles,
    factory: (props) => <MuseHome {...props} />, singleton: true,
  })
  registerView({
    type: 'muse-files', kind: 'page', displayName: () => app().tr('view.museLibrary'), icon: Sparkles,
    factory: (props) => <Suspense fallback={<Skeleton variant="document" />}><MuseLibraryView {...props} /></Suspense>, singleton: true,
  })
  registerView({
    type: 'muse-panel', kind: 'aux', displayName: () => app().tr('view.musePanel'), icon: Sparkles,
    factory: () => <Suspense fallback={<Skeleton variant="list" />}><div style={{ padding: 12, overflowY: 'auto', height: '100%' }}><MusePanel /></div></Suspense>, singleton: true,
  })
}

export function installMuseSpace(): void {
  if (useSpaceStore.getState().spaces.some((s) => s.id === museSpace.id)) return
  registerSpace(museSpace)
  addRibbonIcon({ id: `space:${museSpace.id}`, side: 'top', component: ({ expanded }) => <SpaceButton space={museSpace} expanded={expanded} /> })
}

/** 撤下 Space:停在里面就先切走。**不删命名布局**(重新启用即原样回来,同 calendar)。 */
export function removeMuseSpace(): void {
  if (useSpaceStore.getState().activeSpaceId === museSpace.id) setActiveSpace(PRODUCT.defaultSpace)
  unregisterSpace(museSpace.id)
  removeRibbonIcon(`space:${museSpace.id}`)
}
