/** Space 左面板的悬停预览卡(触发与收起在 Ribbon.tsx,规则在 spacePeekRules.ts)。
 *  卡里是**活的** View,不是截图:脱离 Dockview 直接调 def.factory,leaf 是合成的(同 MiniColumnHost 的先例)。
 *  预览不进布局 —— 不 openView、不动暂存,收起即卸载。
 *  ⚠️ 卡片元素自己不许带 transform / filter / backdrop-filter:它会变成里面 fixed 浮层(View 自己的右键菜单、
 *  悬停提示,按视口坐标定位)的包含块,整体偏移。材质画在 ::before 上(engine.css 的 .rb-peek)。 */
import { Suspense, forwardRef, useState, type CSSProperties } from 'react'
import { ExtendViewHost } from './ExtendViewHost'
import { presentInlineExtension } from './extendView'
import { Skeleton, ViewErrorBoundary, skeletonVariantOf } from './Skeleton'
import { getView } from './viewRegistry'
import { label } from './types'
import type { Leaf, SpaceDefinition } from './types'
import type { PersistedPanel } from './layoutPersist'

function PeekView({ spaceId, view }: { spaceId: string; view: PersistedPanel }) {
  // ponytail: 参数改动只活在这张卡里(不写回暂存 / 布局);左栏 View 的档位已由 Space 锁在条目上,目前没有要记的。
  const [params, setParams] = useState<Record<string, unknown>>(view.params ?? {})
  const def = getView(view.type)
  if (!def) return null
  const id = `peek:${spaceId}:${view.type}`
  const leaf: Leaf = {
    id, type: view.type, loc: 'left', params,
    setTitle: () => {},
    setParams: (p) => setParams((cur) => ({ ...cur, ...p })),
    close: () => {},
  }
  return (
    <ExtendViewHost present={presentInlineExtension} ownerKey={id}>
      {(extendView) => (
        <div className="wb-view wb-view--left">
          <ViewErrorBoundary>
            <Suspense fallback={<Skeleton variant={skeletonVariantOf(view.type, 'left')} />}>
              {def.factory({ leaf, params, extendView })}
            </Suspense>
          </ViewErrorBoundary>
        </div>
      )}
    </ExtendViewHost>
  )
}

/** 头部(Space 名 + 多个 View 时的图标页签)与当前那个 View。按 Space 重挂(页签归零),外面那张卡不动 —— 换图标不重播入场。 */
function PeekContent({ space, views, onBeforeClick }: { space: SpaceDefinition; views: PersistedPanel[]; onBeforeClick(): void }) {
  const [tab, setTab] = useState(0)
  const at = Math.min(tab, views.length - 1)
  const view = views[at]
  const Icon = space.icon
  return (
    <>
      <div className="rb-peek-head">
        {Icon && <Icon size={14} />}
        <span className="rb-peek-name">{label(space.name)}</span>
        {views.length > 1 && views.map((v, i) => {
          const def = getView(v.type)
          const TabIcon = def?.icon
          const title = def ? label(def.displayName) : v.type
          return (
            <button key={i} type="button" className={`rb-peek-tab${i === at ? ' is-on' : ''}`} aria-label={title} title={title} aria-pressed={i === at} onClick={() => setTab(i)}>
              {TabIcon ? <TabIcon size={14} /> : title.slice(0, 1)}
            </button>
          )
        })}
      </div>
      {/* 只管 View 里的点击:头部换页签不算「操作这个 Space」。 */}
      <div className="rb-peek-body" onClickCapture={onBeforeClick}>
        <PeekView key={at} spaceId={space.id} view={view} />
      </div>
    </>
  )
}

export const SpacePeek = forwardRef<HTMLDivElement, {
  space: SpaceDefinition
  views: PersistedPanel[]
  style: CSSProperties
  /** View 里的点击落地之前(捕获阶段)调:Ribbon 借它先切到这个 Space。 */
  onBeforeClick(): void
  /** 卡里的右键(React 树上的后代都算,含 View 挂到 body 的菜单):Ribbon 借它认出「这不是条上的右键」。 */
  onContextMenuCapture(e: React.MouseEvent): void
}>(function SpacePeek({ space, views, style, onBeforeClick, onContextMenuCapture }, ref) {
  return (
    <div ref={ref} className="rb-peek" role="region" aria-label={label(space.name)} data-space={space.id} style={style} onContextMenuCapture={onContextMenuCapture}>
      <PeekContent key={space.id} space={space} views={views} onBeforeClick={onBeforeClick} />
    </div>
  )
})
