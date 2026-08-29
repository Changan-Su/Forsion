/**
 * 内置插件「主页」= Home Space + `homepage` 一个视图。参照旧 `apps/Archived/Forsion-Desktop` 的桌面首页
 * (壁纸 + 大时钟 + AI 输入区 + 底部 Dock)在 LCL 引擎里重写;旧版 Dock 上管的那排「app」,
 * 在 Genesis 里对应的概念就是 **Space**,所以坞直接列 spaceRegistry,不另存一份图标表。
 *
 * 为什么是宿主原生视图而不是真外置插件(同 browser/terminal/calendar 那条理由):外置插件 API 是
 * `new Function(setup(ctx))` + 纯 DOM mount,而这个视图要读 spaceRegistry 并 `setActiveSpace`、
 * 要走 `openNewChat` + appStore.send 的新对话门面 —— 都是宿主内部面。所以做成宿主原生形态,
 * 只在插件页以插件卡露出并可开关:关掉 = 视图反注册 + Space 撤下(ribbon 图标消失)。
 *
 * ⚠️两处注册点(与 builtins/calendar 同一条不对称,理由逐字相同):
 *  · **启动** = `spaces.tsx` 的 SPACES 里按开关声明式带上 —— 保住 ribbon 的默认槽位(注册序 = 默认序,
 *    主页排第一),也保住「上次退出停在主页」的启动恢复(registerSpaces 的 fallback 会把**未注册**的
 *    活动 Space 打回产品默认并持久化)。
 *  · **运行时开关** = installHomepageSpace / removeHomepageSpace(builtins/index 的 applyBuiltin 调,
 *    含跨窗 storage 事件)。installHomepageSpace 幂等,启动那次注册过就不再动。
 *
 * 视图走 lazyRetry:本模块被 builtins/index 静态引,而 index 要能在 node 单测里导入
 * (HomepageView 里的 useApp / engine store 在 node 里活不下来)。
 */
import { Suspense } from 'react'
import { House } from 'lucide-react'
import {
  registerView, registerSpace, unregisterSpace, addRibbonIcon, removeRibbonIcon,
  setActiveSpace, useSpaceStore, useWorkspace, Skeleton,
} from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel } from '@lcl/engine'
import { lazyRetry } from '../lazyRetry'
import { registerMessages } from '../i18n'
import { useApp } from '../stores/appStore'
import { PRODUCT } from '../product'
import { SpaceButton } from '../components/SpaceButton'

const HomepageView = lazyRetry(() => import('../views/HomepageView').then((m) => ({ default: m.HomepageView })))

registerMessages({
  'home.builtinDesc': {
    zh: '主页 Space:壁纸、时钟问候、Tangu 完整输入区,以及可收纳、排序的 Spaces。',
    en: 'Home Space: wallpaper, a clock, the full Tangu composer, and an organized shelf for your Spaces.',
  },
  'home.greet.morning': { zh: '早上好', en: 'Good morning' },
  'home.greet.afternoon': { zh: '下午好', en: 'Good afternoon' },
  'home.greet.evening': { zh: '晚上好', en: 'Good evening' },
  'home.greet.night': { zh: '夜深了', en: 'Working late' },
  'home.greet.morning.named': { zh: '早上好,{name}', en: 'Good morning, {name}' },
  'home.greet.afternoon.named': { zh: '下午好,{name}', en: 'Good afternoon, {name}' },
  'home.greet.evening.named': { zh: '晚上好,{name}', en: 'Good evening, {name}' },
  'home.greet.night.named': { zh: '夜深了,{name}', en: 'Working late, {name}' },
  'home.spaces': { zh: 'Spaces', en: 'Spaces' },
  'home.spaceCount': { zh: '{n} 个空间', en: '{n} spaces' },
  'home.newFolder': { zh: '新建收纳夹', en: 'New folder' },
  'home.showAll': { zh: '全部 Spaces', en: 'All Spaces' },
  'home.organizer.title': { zh: 'Space 收纳', en: 'Space organizer' },
  'home.organizer.hint': { zh: '拖动调整顺序,拖到收纳夹上即可归类;右键空白处也能打开这里', en: 'Drag to reorder or drop onto a folder. Right-click blank space to return here.' },
  'home.noSpaces': { zh: '还没有可打开的 Space', en: 'No Spaces are available yet' },
  'home.folderCount': { zh: '{n} 项', en: '{n} items' },
  'home.folderEmpty': { zh: '把下方架子里的 Space 拖到这个收纳夹上', en: 'Drag a Space from the shelf onto this folder' },
  'home.folderHint': { zh: '拖动可调整顺序,右键可移出收纳夹', en: 'Drag to reorder, or right-click to move an item out' },
  'home.wallpaper.open': { zh: '壁纸与主页外观', en: 'Wallpaper and Home appearance' },
  'home.wallpaper.title': { zh: '主页壁纸', en: 'Home wallpaper' },
  'home.wallpaper.subtitle': { zh: '选择舞台,玻璃和聚焦效果会随之响应', en: 'Choose the stage for glass and focus effects' },
  'home.wallpaper.source': { zh: '壁纸来源', en: 'Wallpaper source' },
  'home.wallpaper.theme': { zh: '主题背景', en: 'Theme' },
  'home.wallpaper.bing': { zh: '必应壁纸', en: 'Bing' },
  'home.wallpaper.custom': { zh: '自定义', en: 'Custom' },
  'home.wallpaper.themeHint': { zh: '使用随深浅模式与主题色自动变化的简约背景', en: 'Use a minimal background that follows appearance and accent colors' },
  'home.wallpaper.daily': { zh: '每日自动更新', en: 'Update daily' },
  'home.wallpaper.refresh': { zh: '刷新', en: 'Refresh' },
  'home.wallpaper.loading': { zh: '正在获取必应壁纸…', en: 'Loading Bing wallpapers…' },
  'home.wallpaper.bingError': { zh: '暂时无法获取必应壁纸,可以稍后重试', en: 'Bing wallpapers are unavailable right now. Try again later.' },
  'home.wallpaper.customReady': { zh: '你的自定义壁纸', en: 'Your custom wallpaper' },
  'home.wallpaper.customHint': { zh: '原图仅保存在这台设备上,最大 32 MB', en: 'The original stays on this device, up to 32 MB' },
  'home.wallpaper.replace': { zh: '更换图片', en: 'Replace image' },
  'home.wallpaper.remove': { zh: '移除并恢复主题', en: 'Remove and use theme' },
  'home.wallpaper.invalid': { zh: '请选择可读取的图片文件', en: 'Choose a readable image file' },
  'home.wallpaper.tooLarge': { zh: '图片超过 32 MB,请先压缩后再试', en: 'The image is over 32 MB. Compress it and try again.' },
  'home.wallpaper.focusBlur': { zh: '聚焦景深', en: 'Focus depth' },
  'home.wallpaper.focusBlurHint': { zh: '点击输入框进入输入模式时柔化背景', en: 'Soften the stage when the chat input enters input mode' },
  'home.wallpaper.vignette': { zh: '边缘压暗', en: 'Edge vignette' },
  'home.wallpaper.vignetteHint': { zh: '让文字和控件在明亮壁纸上保持清晰', en: 'Keep text and controls legible on bright images' },
})

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()

/** 主页不带侧栏:旧版首页也是整屏一块,侧栏在这儿只会把居中排版挤歪。 */
const HOME_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = { left: [], right: [] }

export const homepageSpace: SpaceDefinition = {
  id: 'home',
  name: () => app().tr('space.home'),
  icon: House,
  sidebarDefaults: HOME_SIDE_VIEWS,
  build() {
    ws().setSidebarDefaults(HOME_SIDE_VIEWS)
    ws().openView('homepage', {}, 'main')
  },
}

/** 产品档案点名才装(单品变体没有它)。收纳架在任何宿主都成立;
 *  Composer2 由视图自己按 Tangu Space 是否注册决定露不露。 */
export const homepageAvailable = (): boolean => PRODUCT.spaces.includes('home')

/** 视图注册(启动 + 运行时开启共用)。 */
export function installHomepageViews(): void {
  registerView({
    type: 'homepage',
    kind: 'page',
    displayName: () => app().tr('space.home'),
    icon: House,
    factory: (props) => <Suspense fallback={<Skeleton variant="document" />}><HomepageView {...props} /></Suspense>,
    closable: true,
    singleton: true,
  })
}

/** Space + ribbon 图标(幂等:启动那次由 registerSpaces 按槽位注册过就不重复)。 */
export function installHomepageSpace(): void {
  if (useSpaceStore.getState().spaces.some((s) => s.id === homepageSpace.id)) return
  registerSpace(homepageSpace)
  addRibbonIcon({
    id: `space:${homepageSpace.id}`,
    side: 'top',
    component: ({ expanded }) => <SpaceButton space={homepageSpace} expanded={expanded} />,
  })
}

/** 撤下 Space:停在主页里就先切走(切走会顺手把该 Space 的布局存进命名槽)。
 *  **不删命名布局** —— 重新启用即原样回来(同 builtins/calendar 与 userSpaces.removePluginSpace)。 */
export function removeHomepageSpace(): void {
  if (useSpaceStore.getState().activeSpaceId === homepageSpace.id) setActiveSpace(PRODUCT.defaultSpace)
  unregisterSpace(homepageSpace.id)
  removeRibbonIcon(`space:${homepageSpace.id}`)
}
