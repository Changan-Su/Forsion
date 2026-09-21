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
export const imageStudioAvailable = (): boolean => hasNativeFeature('tangu')
const sides: SidebarDefaults = {
  left: [{ type: 'image-studio-chat', params: {} }],
  right: [{ type: 'image-studio-assets', params: {} }, { type: 'image-studio-inspector', params: {} }], bottom: [],
}
export const imageStudioSpace: SpaceDefinition = {
  id: 'image-studio', name: () => translate('imageStudio.title'), icon: Images,
  sidebarDefaults: sides, resizableSides: { left: true, right: true }, sideDefaultScale: { left: 1.2 },
  build() {
    const ws = useWorkspace.getState()
    ws.setSidebarDefaults(sides)
    ws.openView('image-studio', {}, 'main')
    ws.openView('image-studio-chat', {}, 'left')
    ws.initializeSidebar('right', false); ws.initializeSidebar('bottom', false)
  },
}
export function installImageStudioViews(): void {
  registerView({ type: 'image-studio', kind: 'page', displayName: () => translate('imageStudio.title'), icon: Images, singleton: true, factory: p => <Suspense fallback={<Skeleton variant="document" />}><Studio {...p} /></Suspense> })
  registerView({ type: 'image-studio-chat', kind: 'aux', displayName: () => translate('imageStudio.chat'), icon: MessageCircle, singleton: true, factory: p => <Suspense fallback={<Skeleton variant="list" />}><Chat {...p} /></Suspense> })
  registerView({ type: 'image-studio-assets', kind: 'aux', displayName: () => translate('imageStudio.assets'), icon: Layers, singleton: true, factory: () => <Suspense fallback={<Skeleton variant="list" />}><Assets /></Suspense> })
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
