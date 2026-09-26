/**
 * 内置插件「造物」= Creations Space + `artificial`(栅格)/ `product`(单个作品)两个视图。
 * 管的是**这台电脑上做出来的东西**:Coding Space 产出的网页应用、插件,以后还会有别的种类
 * (种类表在 views/artificial/productKinds —— 加一类就加一行)。
 *
 * 为什么是宿主原生视图而不是真外置插件(同 browser/terminal/calendar/homepage 那条理由):
 * 外置插件 API 是 `new Function(setup(ctx))` + 纯 DOM mount,拿不到 <webview>(要主进程开 webviewTag),
 * 也够不着 setActiveSpace / codeStudioStore 这些宿主内部面。所以做成宿主原生形态,
 * 只在插件页以插件卡露出并可开关:关掉 = 视图反注册 + Space 撤下(ribbon 图标消失)。
 *
 * ⚠️两处注册点(与 builtins/homepage 同一条不对称,理由逐字相同):
 *  · **启动** = `spaces.tsx` 的 SPACES 里按开关声明式带上(保住 ribbon 默认槽位与启动恢复);
 *  · **运行时开关** = installArtificialSpace / removeArtificialSpace(builtins/index 的 applyBuiltin 调)。
 *    installArtificialSpace 幂等,启动那次注册过就不再动。
 *
 * 视图走 lazyRetry:本模块被 builtins/index 静态引,而 index 要能在 node 单测里导入
 * (builtins/address.test.ts 就直接 import './index')。
 */
import { Suspense } from 'react'
import { AppWindow, Blocks } from 'lucide-react'
import {
  registerView, registerSpace, unregisterSpace, addRibbonIcon, removeRibbonIcon,
  setActiveSpace, useSpaceStore, useWorkspace, Skeleton,
} from '@lcl/engine'
import type { SpaceDefinition, SidebarDefaults } from '@lcl/engine'
import { lazyRetry, preloadWhenIdle } from '../lazyRetry'
import { useApp } from '../stores/appStore'
import { PRODUCT } from '../product'
import { windowKind } from '../windowKind'
import { SpaceButton } from '../components/SpaceButton'
import { registerDeepLinkOpener } from '../deepLinkInstall'
import { productIdFromParams } from '../views/artificial/productKinds'
import '../views/artificial/artificialMessages' // 插件卡的说明文案在启动期就要在场(视图是懒载的)

const ArtificialView = lazyRetry(() => import('../views/artificial/ArtificialView').then((m) => ({ default: m.ArtificialView })))
const ProductView = lazyRetry(() => import('../views/artificial/ProductView').then((m) => ({ default: m.ProductView })))

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()

/** 造物不带侧栏:一屏栅格,侧栏在这儿只会把居中排版挤歪(同 agents / public)。 */
const ARTIFICIAL_SIDE_VIEWS: SidebarDefaults = { left: [], right: [], bottom: [] }

export const artificialSpace: SpaceDefinition = {
  id: 'artificial',
  name: () => app().tr('space.artificial'),
  icon: Blocks,
  sidebarDefaults: ARTIFICIAL_SIDE_VIEWS,
  build() {
    ws().setSidebarDefaults(ARTIFICIAL_SIDE_VIEWS)
    ws().openView('artificial', {}, 'main')
    ws().initializeSidebar('left', false)
    ws().initializeSidebar('right', false)
    ws().initializeSidebar('bottom', false)
  },
}

/** 产品档案点名 + 宿主真有产物注册表(桌面 electron;Tangu Web / 移动端无 productsList → 整条不出现)。
 *  判据与 spaces.tsx 里 Coding Space 的那条同款:档案过滤 × 运行时能力闸叠加。 */
export const artificialAvailable = (): boolean =>
  PRODUCT.nativeFeatures === undefined && PRODUCT.spaces.includes('artificial') && !!window.tangu?.productsList

/** deep link `forsion://open?view=product&id=…` 的退订句柄(见下面 installArtificialViews)。 */
let unregisterProductLink: (() => void) | null = null

/** 视图注册(启动 + 运行时开启共用)。 */
export function installArtificialViews(): void {
  preloadWhenIdle(ArtificialView, ProductView)
  registerView({
    type: 'artificial', kind: 'page',
    displayName: () => app().tr('view.artificial'), icon: Blocks,
    factory: () => <Suspense fallback={<Skeleton variant="list" />}><ArtificialView /></Suspense>,
    closable: true, singleton: true,
  })
  // 单个作品:可以同时开几个(各自一个 guest),所以**不是** singleton;身份参数只有 id。
  registerView({
    type: 'product', kind: 'entity', idParam: 'id',
    displayName: () => app().tr('view.product'), icon: AppWindow,
    factory: (props) => <Suspense fallback={<Skeleton variant="document" />}><ProductView {...props} /></Suspense>,
    closable: true, singleton: false,
  })

  // deep link 落点改成**独立窗口**:作品是「一个能跑起来的东西」,点链接就该像点一个 app,
  // 而不是在当前工作区里多开一个标签、把用户正干的事挤走。
  // 只主窗接(deep link 一律定向主窗);拿到的 params 自己再判一次形态 —— 通用闸只保证「像个 id」。
  // 独立窗里的 `product` 视图确实存在:main.tsx 在分流 DetachedRoot 之前就调了 installEngine()
  //(→ installBuiltins → 本函数),卫星窗与主窗跑的是同一份注册表。
  if (windowKind() === 'main' && !unregisterProductLink) {
    // ⚠️外部拉起要先过宿主那一问(productsExternalLaunchAllowed):产物在、且用户在本机为它建过桌面快捷方式。
    // 深链是任意网页可达的输入,而作品页面握着 Forsion Connect 代理(读账号、花额度)—— 一个下载来的文件夹
    // 配一条链接不该零点击跑起来;一串不存在的 id 也不该各开一个空窗口(Codex 评审)。应用内点开不走这条路。
    unregisterProductLink = registerDeepLinkOpener('product', async (params) => {
      const id = productIdFromParams(params)
      const open = window.tangu?.openDetached
      const allowed = window.tangu?.productsExternalLaunchAllowed
      if (!id || !open || !allowed) return false // 形态不合 / 没有开窗能力 / 老宿主没有这道闸 → 「链接目标不可用」
      if (!(await allowed(id).catch(() => false))) return false
      void open([{ type: 'product', params: { id } }])
      return true
    })
  }
}

/** Space + ribbon 图标(幂等:启动那次由 registerSpaces 按槽位注册过就不重复)。 */
export function installArtificialSpace(): void {
  if (useSpaceStore.getState().spaces.some((s) => s.id === artificialSpace.id)) return
  registerSpace(artificialSpace)
  addRibbonIcon({
    id: `space:${artificialSpace.id}`,
    side: 'top',
    component: ({ expanded }) => <SpaceButton space={artificialSpace} expanded={expanded} />,
  })
}

/** 撤下 Space:停在造物里就先切走(切走会顺手把该 Space 的布局存进命名槽)。
 *  **不删命名布局** —— 重新启用即原样回来(同 builtins/homepage 与 userSpaces.removePluginSpace)。 */
export function removeArtificialSpace(): void {
  if (useSpaceStore.getState().activeSpaceId === artificialSpace.id) setActiveSpace(PRODUCT.defaultSpace)
  unregisterSpace(artificialSpace.id)
  removeRibbonIcon(`space:${artificialSpace.id}`)
  // 视图随后会被 applyBuiltin 反注册;deep link 的 opener 也一并撤掉,免得留一条指着不存在视图的路
  //(resolveDeepLink 会先查 getView,留着也不会误开,但没道理留)。
  unregisterProductLink?.()
  unregisterProductLink = null
}
