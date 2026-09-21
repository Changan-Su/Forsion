/** Sandbox = 开发加载器,不是隔离环境。
 *  它把项目文件夹里的插件直接加载进**正在运行的这个** Forsion:真应用、用户的真笔记库、
 *  与已安装插件同权。所以「加载」按钮上方那段话不可折叠、不可关闭 —— 用户按下去之前必须看见。
 *  证据(setup 抛错 / 视图 mount 抛错 / 这个插件自己的 console)收在这里,一键带回对话。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2, Play, RotateCw, ShieldAlert, Square, Trash2 } from 'lucide-react'
import { clearDevPluginLogs, reloadDevPlugin, useDevPluginState } from '@amadeus/plugins/devSandbox'
import { useI18n } from '../../i18n'
import { useCodeStudio } from '../../stores/codeStudioStore'
import { isNearBottom, sandboxPrompt } from './sandboxModel'
import { normPath } from './studioModel'
import type { ProductSummary } from '../../../../shared/products'
import './studioMessages'

export type SandboxState = 'unavailable' | 'unloaded' | 'active' | 'blocked' | 'failed'
type Busy = 'load' | 'unload' | 'reload' | null

export interface SandboxPanelProps {
  root: string
  product: ProductSummary | null
  onPrompt(text: string, plan?: boolean): void
  /** 宿主的 devLoad 标志改过之后重新读一次产物(上层据此决定还提不提 Sandbox / 热重载)。 */
  onProductChanged(): void
}

export function SandboxPanel({ root, product, onPrompt, onProductChanged }: SandboxPanelProps) {
  const { t } = useI18n()
  const devLoad = product?.devLoad === true
  // 清单被写坏(kind 退成 unknown)而授权还在:照样要看得到报错、卸得掉 —— pluginId 取宿主随授权存下的那个。
  // **开启**仍只认真插件项目:devLoad 为 false 时这里只剩 kind === 'plugin' 一条路(主进程也再拒一次)。
  const pluginId = product && (product.kind === 'plugin' || devLoad) ? product.pluginId ?? null : null
  const dev = useDevPluginState(pluginId)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  /** 标志位已经写进去了、但那次重载没成功:重试只重跑重载,绝不再写一次标志。 */
  const [reloadPending, setReloadPending] = useState(false)
  const [note, setNote] = useState('')
  const mounted = useRef(true)
  // 加载 / 卸载 / 重载共用一把锁:busy 这个 state 要等下一次渲染才拦得住按钮,同一帧里的第二次点击靠它。
  const inFlight = useRef(false)
  const logList = useRef<HTMLOListElement>(null)
  const stick = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // 只有原本就贴着底才跟着新输出走;用户往上翻看历史时不许把他拽回去。
  useEffect(() => {
    const element = logList.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [dev.logs.length])
  const onScroll = useCallback(() => {
    const element = logList.current
    if (element) stick.current = isNearBottom(element.scrollTop, element.scrollHeight, element.clientHeight)
  }, [])

  const bridge = window.tangu
  const canLoad = !!bridge?.productsUpdate && !!product && !!pluginId
  const state: SandboxState = !canLoad ? 'unavailable'
    : dev.blocked ? 'blocked'
      : dev.setupError ? 'failed'
        : dev.loaded && dev.active ? 'active' : 'unloaded'
  // 这个面板可以在项目切走之后还活着(命令面板开的临时面板)。落盘动作回来之后一律先确认还是同一个项目。
  const current = () => mounted.current && normPath(useCodeStudio.getState().activeProject || '') === normPath(root)

  const runReload = async (kind: Busy): Promise<void> => {
    if (!pluginId || inFlight.current) return
    inFlight.current = true
    setBusy(kind); setError('')
    try {
      await reloadDevPlugin(pluginId)
      if (mounted.current) setReloadPending(false)
    } catch (e) {
      if (mounted.current) { setError(String((e as Error).message || e)); setReloadPending(true) }
    } finally { inFlight.current = false; if (mounted.current) setBusy(null) }
  }
  /** 加载 / 卸载 = 先改宿主的标志,再重载插件,最后让上层重新读产物。
   *  重载那半失败也必须回报上层:标志已经落盘了,界面继续显示「未加载」才是真的危险。 */
  const apply = async (next: boolean): Promise<void> => {
    if (!product || !pluginId || !bridge?.productsUpdate || inFlight.current) return
    inFlight.current = true
    setBusy(next ? 'load' : 'unload'); setError(''); setReloadPending(false)
    let flagged = false
    try {
      await bridge.productsUpdate(product.id, { devLoad: next })
      flagged = true
      await reloadDevPlugin(pluginId)
    } catch (e) {
      if (mounted.current) { setError(String((e as Error).message || e)); setReloadPending(flagged) }
    } finally {
      inFlight.current = false
      if (flagged && current()) onProductChanged()
      if (mounted.current) setBusy(null)
    }
  }

  if (!canLoad) {
    return <div className="csu-panel-body csu-sandbox" data-sandbox-state="unavailable">
      <p className="csu-hint" role="status">{t(bridge?.productsUpdate ? 'studio.sandbox.notPlugin' : 'studio.sandbox.unavailable')}</p>
    </div>
  }
  const stateLabel = state === 'active' ? t('studio.sandbox.stateActive')
    : state === 'blocked' ? t('studio.sandbox.stateBlocked')
      : state === 'failed' ? t('studio.sandbox.stateFailed') : t('studio.sandbox.stateUnloaded')
  const stateHint = state === 'active' ? t('studio.sandbox.activeHint')
    : state === 'blocked' ? (dev.blocked === 'dev-fileext' ? t('studio.sandbox.blockedFileext')
      : dev.blocked === 'api' ? t('studio.sandbox.blockedApi')
        : dev.blocked === 'minApp' ? t('studio.sandbox.blockedMinApp')
          : t('studio.sandbox.blockedOther', { reason: dev.blockedReason || dev.blocked || '' }))
      : state === 'failed' ? t('studio.sandbox.failedHint') : t('studio.sandbox.unloadedHint')
  const evidence = { pluginId: pluginId, setupError: dev.setupError, mountErrors: dev.mountErrors, logs: dev.logs }
  const empty = !dev.setupError && !dev.mountErrors.length && !dev.logs.length

  return <div className="csu-panel-body csu-sandbox" data-sandbox-state={state} data-plugin-id={pluginId}>
    <section className="csu-sandbox-head">
      <p className="csu-sandbox-status" role="status"><strong data-sandbox-state-label>{stateLabel}</strong><span>{stateHint}</span></p>
      {dev.shadowsInstalled && <p className="csu-hint" data-sandbox-shadow>{t('studio.sandbox.shadow')}</p>}
      {/* 不可关闭、不可折叠:这是按下「加载」之前必须读到的那一段。 */}
      <p className="csu-sandbox-trust" data-sandbox-trust><ShieldAlert size={14} aria-hidden="true" /><span>{t('studio.sandbox.trust')}</span></p>
      <div className="csu-sandbox-actions">
        {devLoad
          ? <button type="button" data-action="sandbox-unload" disabled={busy !== null} onClick={() => void apply(false)}>
            {busy === 'unload' ? <Loader2 size={14} className="csx-spin" /> : <Square size={13} />}{t(busy === 'unload' ? 'studio.sandbox.unloading' : 'studio.sandbox.unload')}
          </button>
          : <button type="button" className="csu-primary" data-action="sandbox-load" disabled={busy !== null || state === 'blocked'} onClick={() => void apply(true)}>
            {busy === 'load' ? <Loader2 size={14} className="csx-spin" /> : <Play size={13} />}{t(busy === 'load' ? 'studio.sandbox.loading' : 'studio.sandbox.load')}
          </button>}
        {devLoad && <button type="button" data-action="sandbox-reload" disabled={busy !== null} onClick={() => void runReload('reload')}>
          <RotateCw size={13} className={busy === 'reload' ? 'csx-spin' : ''} />{t(busy === 'reload' ? 'studio.sandbox.reloading' : 'studio.sandbox.reload')}
        </button>}
      </div>
      {!!error && <p className="csu-error" role="alert" data-sandbox-error="action">{error}
        {reloadPending && <button type="button" data-action="sandbox-retry" disabled={busy !== null} onClick={() => void runReload('reload')}>{t('studio.sandbox.retry')}</button>}
      </p>}
      {reloadPending && <p className="csu-hint" data-sandbox-halfdone>{t('studio.sandbox.halfDone')}</p>}
    </section>

    <section className="csu-sandbox-evidence">
      {!!dev.setupError && <div className="csu-sandbox-block" data-sandbox-error="setup">
        <h3>{t('studio.sandbox.setupError')}</h3><pre>{dev.setupError}</pre>
      </div>}
      {dev.mountErrors.length > 0 && <div className="csu-sandbox-block" data-sandbox-error="mount">
        <h3>{t('studio.sandbox.mountErrors')}</h3>
        <ul>{dev.mountErrors.map(item => <li key={`${item.viewId}:${item.at}`}><AlertCircle size={13} /><code>{item.viewId}</code><span>{item.message}</span></li>)}</ul>
      </div>}
      <div className="csu-sandbox-block csu-sandbox-logs">
        <h3>{t('studio.sandbox.console')}</h3>
        {empty
          ? <p className="csu-hint">{t('studio.sandbox.noEvidence')}</p>
          : <ol ref={logList} onScroll={onScroll} aria-label={t('studio.sandbox.console')}>
            {dev.logs.map((item, index) => <li key={`${item.at}:${index}`} data-sandbox-log data-level={item.level}><span>{item.level}</span><span>{item.text}</span></li>)}
          </ol>}
      </div>
    </section>

    <div className="csu-sandbox-send">
      <input aria-label={t('studio.sandbox.note')} placeholder={t('studio.sandbox.note')} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
      <button type="button" className="csu-primary" data-action="sandbox-send" onClick={() => onPrompt(sandboxPrompt({ ...evidence, note }), false)}>{t('studio.sandbox.send')}</button>
      <button type="button" data-action="sandbox-clear" disabled={!dev.logs.length} onClick={() => clearDevPluginLogs(pluginId)}><Trash2 size={13} />{t('studio.sandbox.clear')}</button>
    </div>
  </div>
}

export default SandboxPanel
