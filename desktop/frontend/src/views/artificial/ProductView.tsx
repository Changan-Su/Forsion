/**
 * 一个产物 = 一个 <webview>(造物 Space 的 `product` 视图)。
 *
 * ⚠️**只读 `params.id`,别的参数一律不看**:这个视图是 forsion:// deep link 的落点(任意网页可唤起),
 * 而它打开的页面里住着 Forsion Connect 代理 —— 多认一个参数就是多一个可被拼进 URL 的口子。
 * id 过 productIdFromParams 的形态闸后交给主进程,URL 由 `productsServe` 给出,渲染层从不自己拼。
 *
 * guest 的承载方式与 Coding Studio 预览逐字相同:Electron 会在**任一祖先被摘下**时销毁 guest,
 * 而 Dockview 会在视图还活着时重建那些祖先 → 走 StudioGuestSurface 把 <webview> 传送到壳上,
 * 只让它跟随这块空锚点的几何(该组件注释里有完整病理)。分区沿用 BROWSER_PARTITION:
 * 主进程的 will-attach-webview 本来就会强制改写分区,这里另起一个只会自欺。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Code2, ExternalLink, Loader2, RotateCw } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { getView, setActiveSpace, useSpaceStore, useWorkspace } from '@lcl/engine'
import { StudioGuestSurface } from '../coding/StudioGuestSurface'
import { Webview } from '../../builtins/browserView'
import { BROWSER_PARTITION } from '../../../../shared/browser'
import type { ProductSummary } from '../../../../shared/products'
import { useCodeStudio } from '../../stores/codeStudioStore'
import { useI18n } from '../../i18n'
import { productIdFromParams, serveOutcome, type ServeOutcome } from './productKinds'
import './artificialMessages'
import './artificial.css'

interface Guest extends HTMLElement { reload(): void }

export function ProductView({ leaf, params }: ViewProps) {
  const { t } = useI18n()
  const id = productIdFromParams(params)
  const [status, setStatus] = useState<'loading' | 'ready' | ServeOutcome>('loading')
  const [url, setUrl] = useState('')
  const [product, setProduct] = useState<ProductSummary | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const guest = useRef<Guest | null>(null)
  /** 序号闸 = 竞态闸 + 卸载闸(与 ArtificialView.load 同一条)。连点重载会让两个应答同时在飞,
   *  而**先落地的不一定是后发的** —— 没有它,早发的那次会覆盖晚发的 url / product。
   *  卸载与换 id 时由 effect 的清理把它推进一格:之后回来的应答认不出自己,一律不再落 state。 */
  const request = useRef(0)
  const canEdit = useSpaceStore((s) => s.spaces.some((sp) => sp.id === 'coding')) && !!getView('code-studio')

  /** 取产物档案:作品起不来(没有网页入口)时也要拿到名字与项目根,「继续编辑」才有去处。 */
  const loadProfile = useCallback(async (seq: number) => {
    const get = window.tangu?.productsGet
    if (!id || !get) return
    try {
      const p = await get(id)
      if (seq === request.current && p) setProduct(p)
    } catch { /* 档案取不到只是少了名字与「继续编辑」,主状态已经是对的 */ }
  }, [id])

  const serve = useCallback(async () => {
    const start = window.tangu?.productsServe
    if (!id || !start) { setStatus('gone'); return }
    const seq = ++request.current
    setStatus('loading')
    try {
      const r = await start(id)
      if (seq !== request.current) return
      setUrl(r.url)
      setProduct(r.product)
      setStatus('ready')
    } catch (e) {
      if (seq !== request.current) return
      const outcome = serveOutcome(e)
      setStatus(outcome)
      if (outcome === 'unservable') void loadProfile(seq)
    }
  }, [id, loadProfile])

  useEffect(() => {
    void serve()
    return () => { request.current++ } // 卸载 / 换 id:作废飞在路上的应答(见 request 的注释)
  }, [serve])
  // 标签页标题 = 作品名(布局持久化会把它存下来,重启后不必等 productsServe 回来才认得出这个标签)。
  useEffect(() => { if (product) leaf.setTitle(product.name) }, [leaf, product])

  /** guest 被传送到壳上,落在 Dockview 的焦点捕获容器之外 → 点进作品里不会激活这块面板,
   *  关标签、标签命令都会打到别的面板上。把激活显式接回来(同 CodeStudioView → StudioPreview)。 */
  const activate = useCallback(() => useWorkspace.getState().activateLeaf(leaf.id), [leaf.id])

  /** 回编码工作室继续改。setActiveSpace 同步换整份布局,同 tick 开项目会与布局应用赛跑(同 deepLinkInstall)。 */
  const editInStudio = useCallback((p: ProductSummary) => {
    setActiveSpace('coding')
    requestAnimationFrame(() => { useCodeStudio.getState().openProject(p.root, p.name) })
  }, [])

  return (
    <div className="art-product" data-product-view data-product-id={id ?? ''} data-status={status}>
      <div className="art-bar">
        <span className="art-bar-name">{product?.name ?? t('view.product')}</span>
        <button
          className="btn ghost sm" data-action="reload" title={t('artificial.product.reload')} aria-label={t('artificial.product.reload')}
          // 没有网页入口的作品重载多少次都是同一个结果 —— 不给一颗永远点不出结果的按钮。
          disabled={status === 'unservable'}
          onClick={() => (status === 'ready' ? guest.current?.reload() : void serve())}
        >
          <RotateCw size={14} />
        </button>
        <button
          className="btn ghost sm" data-action="external" title={t('artificial.product.openExternal')} aria-label={t('artificial.product.openExternal')}
          disabled={!url} onClick={() => { void window.tangu?.openExternal?.(url) }}
        >
          <ExternalLink size={14} />
        </button>
        {canEdit && product && (
          <button
            className="btn ghost sm" data-action="edit" title={t('artificial.action.edit')} aria-label={t('artificial.action.edit')}
            onClick={() => editInStudio(product)}
          >
            <Code2 size={14} />
          </button>
        )}
      </div>

      {status === 'loading' && <div className="art-state" role="status" data-state="loading"><Loader2 size={16} className="spin" /> {t('artificial.product.loading')}</div>}
      {status === 'gone' && <div className="art-state" role="alert" data-state="gone"><div className="art-state-title">{t('artificial.product.gone')}</div></div>}
      {/* 永久性拒绝(这类作品没有网页入口):**不给重试**,给唯一还走得通的那条出路。 */}
      {status === 'unservable' && (
        <div className="art-state" role="alert" data-state="unservable">
          <div className="art-state-title">{t('artificial.product.unservable')}</div>
          <p>{t('artificial.product.unservableBody')}</p>
          {canEdit && product && (
            <button className="btn sm" data-action="edit-instead" onClick={() => editInStudio(product)}>{t('artificial.action.edit')}</button>
          )}
        </div>
      )}
      {status === 'error' && (
        <div className="art-state" role="alert" data-state="error">
          <div className="art-state-title">{t('artificial.product.failed')}</div>
          <button className="btn sm" data-action="retry" onClick={() => { void serve() }}>{t('common.retry')}</button>
        </div>
      )}
      {status === 'ready' && (
        <>
          {/* 锚点必须渲染在 StudioGuestSurface 之前:它的第一个 layout effect 就要读这个 ref。 */}
          <div ref={anchor} className="art-anchor" />
          <StudioGuestSurface anchorRef={anchor} onActivate={activate}>
            <div className="art-guest">
              <Webview
                ref={(el: HTMLElement | null) => { guest.current = el as Guest | null }}
                className="art-frame"
                data-product-id={id ?? ''}
                src={url}
                partition={BROWSER_PARTITION}
                // 站内 target=_blank 要能触发主进程的 window-open 钩子(它 deny 掉并回投成内置浏览器标签),
                // 不加这条则整类链接被 guest 静默吞掉(同 builtins/browserView)。
                allowpopups="true"
              />
            </div>
          </StudioGuestSurface>
        </>
      )}
    </div>
  )
}
