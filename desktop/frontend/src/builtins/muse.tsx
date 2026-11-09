/**
 * 内置插件「Muse」= Muse Space:主=`muse-library`(**稳定的宿主视图**,2026-11-08 起画宿主的「今日简报」,views/museBrief),
 * 右=Muse 面板的管理面(状态 / 审批 / 在想 / 叫醒时机 / 最近几轮,复用 components/MuseView 的 manage 摆法)。
 * 11-08 之前主区画的是卜算子自建插件 agent-muse 的 home 视图(main.js);用户定直接换成模板:main.js 留在
 * agents/muse/Space/ 不删,但不再装载(electron/amadeus/ipc.ts 的 readAgentSpacePlugins 跳过 muse),也不加切回开关。
 * 为什么主槽不直接放 `plugin:*`:持久化布局冷启动恢复时插件还没求值,plugin:* 视图会被整个丢掉;布局里永远只存宿主类型。
 * ⚠️类型名沿用 09-10 的 `muse-library`:命名布局 `space:muse` 里存的主区就是这个名字,换新名 = 老布局打不开;纯 Library 浏览器叫 `muse-files`。
 * 形态照 builtins/calendar:
 *  · **启动** = spaces.tsx 的 SPACES 里按开关声明式带上(ribbon 默认序 + 启动恢复);
 *  · **运行时开关** = installMuseSpace / removeMuseSpace(applyBuiltin 调),幂等。
 * 视图 lazyRetry:builtins/index 要能在 node 单测里导入。
 * 「Agent Space 赋予其他 agent」的扩展位:museSpace 由 agentSpaceFor(slug) 生成,只是今天只注册 muse。
 */
import { Suspense } from 'react'
import { Sparkles } from 'lucide-react'
import {
  registerView, registerSpace, unregisterSpace, addRibbonIcon, removeRibbonIcon,
  setActiveSpace, useSpaceStore, useWorkspace, Skeleton,
} from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel, ViewProps } from '@lcl/engine'
import { lazyRetry } from '../lazyRetry'
import { useApp } from '../stores/appStore'
import { PRODUCT } from '../product'
import { SpaceButton } from '../components/SpaceButton'
import { openSession } from '../sessionNav'

const MuseLibraryView = lazyRetry(() => import('../views/MuseLibraryView').then((m) => ({ default: m.MuseLibraryView })))
const MuseViewLazy = lazyRetry(() => import('../components/MuseView').then((m) => ({ default: m.MuseView })))
const MuseBriefLazy = lazyRetry(() => import('../views/museBrief/MuseBriefView').then((m) => ({ default: m.MuseBriefView })))

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()

/** 右栏 = 管理面(方案 B / D):状态、要你批准、上一轮在想、什么时候叫醒它、最近几轮;待办和在跟的进了主区的卡。 */
function MusePanel() {
  const cfg = useApp((s) => s.cfg)
  const sessions = useApp((s) => s.sessions)
  return <MuseViewLazy cfg={cfg} sessions={sessions} onInjected={(id) => openSession(id)} variant="manage" />
}

/** Muse Space 主槽 = 宿主画的「今日简报」(2026-11-08 方案 D;用户定:老用户直接换成它,卜算子以前写的 main.js 不再加载、文件留着、
 *  没有切回的开关)。Muse 私聊旁的 Desk 空闲面也是这个视图(AgentDesk 的 MUSE_HOME_VIEW)。 */
function MuseHome(props: ViewProps) {
  return <Suspense fallback={<Skeleton variant="document" />}><MuseBriefLazy {...props} /></Suspense>
}

/** 通用形状:某个 agent 的 Space = 主槽 `<slug>-library`(它自建的插件视图 / 空白态)+ 右栏它的面板。今天只实例化 muse。 */
export function agentSpaceFor(slug: 'muse'): SpaceDefinition {
  const side: Record<'left' | 'right', PersistedPanel[]> = { left: [], right: [{ type: `${slug}-panel`, params: {} }] }
  return {
    id: slug,
    name: () => app().tr('space.muse'),
    icon: Sparkles,
    sidebarDefaults: side,
    pinned: { main: [{ type: `${slug}-library`, params: {} }], right: side.right },
    build() {
      ws().setSidebarDefaults(side)
      ws().openView(`${slug}-library`, {}, 'main')
      ws().openView(`${slug}-panel`, {}, 'right')
    },
  }
}

export const museSpace: SpaceDefinition = agentSpaceFor('muse')

/** 旧档案点名 + 本地 tangu 后端;Unit 宿主 = tangu 包 + 本地引擎(判定单源 features/runtime,与 Inbox 同一条)。 */
export { museAvailable } from '../features/runtime'

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
