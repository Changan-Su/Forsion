import { Suspense } from 'react'
import { Images, MessageCircle, SlidersHorizontal, Layers } from 'lucide-react'
import { registerView, registerSpace, unregisterSpace, addRibbonIcon, removeRibbonIcon, addCommand, setActiveSpace, useSpaceStore, useWorkspace, Skeleton, type SpaceDefinition, type SidebarDefaults } from '@lcl/engine'
import { lazyRetry } from '../lazyRetry'
import { translate } from '../i18n'
import { hasNativeFeature } from '../features/runtime'
import { SpaceButton } from '../components/SpaceButton'
import { PRODUCT } from '../product'
import '../views/imageStudio/messages'

const Studio = lazyRetry(() => import('../views/imageStudio/ImageStudioView').then(m => ({ default: m.ImageStudioView })))
const Chat = lazyRetry(() => import('../views/imageStudio/ImageStudioPanels').then(m => ({ default: m.ImageStudioChat })))
const Assets = lazyRetry(() => import('../views/imageStudio/ImageStudioPanels').then(m => ({ default: m.ImageStudioAssets })))
const Inspector = lazyRetry(() => import('../views/imageStudio/ImageStudioPanels').then(m => ({ default: m.ImageStudioInspector })))
const Nav = lazyRetry(() => import('../views/imageStudio/ImageStudioPanels').then(m => ({ default: m.ImageStudioNav })))
export const imageStudioAvailable = (): boolean => hasNativeFeature('tangu')
/** 项目 + 详情(2026-10-04 用户定,同 Coding / Video Studio):左 = 项目导航,进项目后旁边多一个「图层」标签
 *  (ImageStudioView 开 / 收,所以不在默认里);主 = 启动台或画布;右 = 对话 | 属性,起手收起、进项目时带出来。 */
const sides: SidebarDefaults = {
  left: [{ type: 'image-studio-nav', params: {} }],
  right: [{ type: 'image-studio-chat', params: {} }, { type: 'image-studio-inspector', params: {} }], bottom: [],
}
export const imageStudioSpace: SpaceDefinition = {
  id: 'image-studio', name: () => translate('imageStudio.title'), icon: Images,
  // 导航用标准侧栏宽;对话那一栏要宽一点,跟着它从左边换到了右边。
  sidebarDefaults: sides, resizableSides: { left: true, right: true }, sideDefaultScale: { left: 1, right: 1.2 },
  pinned: { main: [{ type: 'image-studio', params: {} }], left: sides.left, right: [{ type: 'image-studio-chat', params: {} }] },
  build() {
    const ws = useWorkspace.getState()
    ws.setSidebarDefaults(sides)
    ws.openView('image-studio', {}, 'main')
    ws.openView('image-studio-nav', {}, 'left')
    ws.initializeSidebar('right', false); ws.initializeSidebar('bottom', false) // 右栏收起:对话与属性在暂存里,展开即还原
  },
}
export function installImageStudioViews(): void {
  registerView({ type: 'image-studio', kind: 'page', displayName: () => translate('imageStudio.title'), icon: Images, singleton: true, factory: p => <Suspense fallback={<Skeleton variant="document" />}><Studio {...p} /></Suspense> })
  registerView({ type: 'image-studio-nav', kind: 'collection', displayName: () => translate('imageStudio.title'), icon: Images, factory: () => <Suspense fallback={<Skeleton variant="list" />}><Nav /></Suspense> })
  registerView({ type: 'image-studio-chat', kind: 'aux', displayName: () => translate('imageStudio.chat'), icon: MessageCircle, singleton: true, factory: p => <Suspense fallback={<Skeleton variant="list" />}><Chat {...p} /></Suspense> })
  registerView({ type: 'image-studio-assets', kind: 'aux', displayName: () => translate('imageStudio.layers'), icon: Layers, singleton: true, factory: () => <Suspense fallback={<Skeleton variant="list" />}><Assets /></Suspense> })
  registerView({ type: 'image-studio-inspector', kind: 'aux', displayName: () => translate('imageStudio.inspector'), icon: SlidersHorizontal, singleton: true, factory: () => <Suspense fallback={<Skeleton variant="list" />}><Inspector /></Suspense> })
  addCommand({ id: 'builtin-image-studio-open', title: () => translate('imageStudio.open'), icon: Images, keywords: 'image studio canvas design 图像 画布 生图 设计', run: () => setActiveSpace('image-studio') })
}
export function installImageStudioSpace(): void {
  if (useSpaceStore.getState().spaces.some(s => s.id === imageStudioSpace.id)) return
  registerSpace(imageStudioSpace)
  addRibbonIcon({ id: 'space:image-studio', side: 'top', component: ({ expanded }) => <SpaceButton space={imageStudioSpace} expanded={expanded} /> })
}
export function removeImageStudioSpace(): void {
  if (useSpaceStore.getState().activeSpaceId === imageStudioSpace.id) {
    const fallback = useSpaceStore.getState().spaces.find(s => s.id !== imageStudioSpace.id && s.id === PRODUCT.defaultSpace) || useSpaceStore.getState().spaces.find(s => s.id !== imageStudioSpace.id)
    if (fallback) setActiveSpace(fallback.id)
  }
  unregisterSpace(imageStudioSpace.id); removeRibbonIcon('space:image-studio')
}
