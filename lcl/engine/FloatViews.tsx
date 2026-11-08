/** workspace.open 挂进浮层(View / Space / 窗口作用域)的 View(workspaceOpen.ts)。SpaceFloatLayer 旁边各挂一份
 *  (WorkspaceHost / SingleColumnHost),经 portal 渲染进各自的浮层元素 —— 留在壳的 React 树里,语言 / 主题这些上下文照常。
 *  leaf 是合成的(同 SpacePeek / FloatingViewSurface 的先例):参数只活在这张卡里,不进布局;「在主面板显示」把当前参数
 *  带去主区开那个主视图,然后收掉这张卡。 */
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, X } from 'lucide-react'
import { Skeleton, ViewErrorBoundary, skeletonVariantOf } from './Skeleton'
import { getView } from './viewRegistry'
import { useWorkspace } from './workspaceStore'
import { useEngineI18n } from './i18nSeam'
import { reducedMotion } from './spring'
import { floatViewsSnapshot, registerFloatViewRenderer, subscribeFloatViews, type FloatViewRec } from './workspaceOpen'
import type { Leaf } from './types'

function FloatViewCard({ rec }: { rec: FloatViewRec }): ReactElement | null {
  const { t } = useEngineI18n()
  const [params, setParams] = useState<Record<string, unknown>>(() => ({ ...rec.view.params }))
  const paramsRef = useRef(params)
  paramsRef.current = params
  // 同一份再开:换成新参数(gen),卡片轻跳一下(nudge,同 Mini 再开)
  const gen = useRef(rec.gen)
  useLayoutEffect(() => {
    if (gen.current === rec.gen) return
    gen.current = rec.gen
    setParams({ ...rec.view.params })
  })
  const nudge = useRef(rec.nudge)
  useEffect(() => {
    if (nudge.current === rec.nudge) return
    nudge.current = rec.nudge
    if (!reducedMotion()) rec.handle.el.animate?.([{ scale: '1' }, { scale: '0.97' }, { scale: '1' }], { duration: 280, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' })
  })
  const leaf = useMemo<Leaf>(() => ({
    id: rec.id,
    type: rec.view.type,
    loc: 'main',
    get params() { return paramsRef.current },
    setTitle: () => {},
    setParams: (next) => setParams({ ...next }),
    close: () => rec.close(),
  }), [rec])
  const def = getView(rec.view.type)
  if (!def) return null
  // 「在主面板显示」:就在这扇窗的主区开主视图(当前参数带过去),然后收掉这张卡。浮层宿主只挂在工作台窗口里,主区总在
  const showInMain = getView(rec.mainView.type) ? (): void => {
    const main = rec.mainView
    const carry = main.type === rec.view.type ? paramsRef.current : { ...main.params, ...paramsRef.current }
    const leaf = useWorkspace.getState().openView(main.type, carry, 'main')
    if (!leaf) return // 没开成(没有工作台)就别收卡
    // singleton 复用时 openView 不改参数(同 multiWindow 的主面板交接):补一笔,否则停在主区原来那份上
    leaf.setParams({ ...leaf.params, ...carry })
    rec.close()
  } : undefined
  return (
    <div className="lcl-float-view" data-form={rec.form}>
      <header className="lcl-float-view-head" {...(rec.sheet ? {} : { 'data-float-drag': '' })}>
        <span className="lcl-float-view-title">{rec.title}</span>
        {showInMain && <button type="button" className="lcl-float-view-btn" aria-label={t('lcl.mini.showMain')} title={t('lcl.mini.showMain')} onClick={showInMain}>
          <ExternalLink size={14} />
        </button>}
        <button type="button" className="lcl-float-view-btn" aria-label={t('lcl.tab.close')} title={t('lcl.tab.close')} onClick={() => rec.close()}>
          <X size={14} />
        </button>
      </header>
      <div className="lcl-float-view-body" data-view={rec.view.type}>
        <ViewErrorBoundary>
          <Suspense fallback={<Skeleton variant={skeletonVariantOf(rec.view.type, 'right')} />}>
            {def.factory({ leaf, params, surface: { form: rec.form, showInMain } })}
          </Suspense>
        </ViewErrorBoundary>
      </div>
    </div>
  )
}

/** 挂在 SpaceFloatLayer 里(一扇窗一个工作台壳,所以只有一份)。没挂它的窗口(Mini、Floating Panel)workspace.open
 *  的浮层档回 unavailable。 */
export function FloatViews(): ReactElement {
  const recs = useSyncExternalStore(subscribeFloatViews, floatViewsSnapshot, floatViewsSnapshot)
  useLayoutEffect(() => registerFloatViewRenderer(), [])
  return <>{recs.map((rec) => createPortal(<FloatViewCard rec={rec} />, rec.handle.el, rec.id))}</>
}
