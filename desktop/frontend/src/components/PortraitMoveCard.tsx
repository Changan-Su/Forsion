import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Bookmark, Loader2, Undo2 } from 'lucide-react'
import { useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import type { EngineTarget } from '../services/engine/targets'
import { decidePortraitMove, getPortraitMove, scanPortraitMove, type PortraitMoveItem, type PortraitMoveView } from '../services/backendService'
import { HUMAN_CHANGED_EVENT } from '../services/humanCollaboration'
import './humanMessages'
import './selfUpdates.css'
import './humanCollaboration.css'

/** 「我 › 画像」的搬家卡:人点了才扫,逐条挪进画像或留着;挪的那张卡上可以撤销。引擎侧 agents/portraitMove.ts。
 *  云端 / 远端没有这个接口,旧引擎也没有:整张卡不出现。 */
export function PortraitMoveCard({ engine }: { engine: EngineTarget }) {
  const { t } = useI18n()
  const agentDefs = useApp((s) => s.agentDefs)
  const [view, setView] = useState<PortraitMoveView | null>(null)
  const [off, setOff] = useState(false), [later, setLater] = useState(false), [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [movedHere, setMovedHere] = useState<string[]>([]) // 这张卡上挪的:上一轮挪好的不再显示
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const errorText = (e: any) => e?.code === 'PORTRAIT_FULL' ? t('human.move.full') : e?.code === 'PORTRAIT_MOVE_GONE' ? t('human.move.gone') : String(e?.message || e)
  const load = useCallback(async () => {
    try { const v = await getPortraitMove(engine); if (alive.current) setView(v) }
    catch (e: any) { if (!alive.current) return; if (e?.status === 404 || e?.code === 'HUMAN_REMOTE_DENIED' || e?.code === 'HUMAN_LOCAL_ONLY') setOff(true); else setError(errorText(e)) }
  }, [engine.key, engine.base])
  useEffect(() => { void load() }, [load])
  const scanning = !!view?.scanning
  useEffect(() => {
    if (!scanning) return
    const timer = window.setTimeout(() => void load(), 700)
    return () => window.clearTimeout(timer)
  }, [scanning, view, load])
  if (off) return null
  const scan = async () => {
    setError(''); setAsked(true)
    try { const v = await scanPortraitMove(engine); if (alive.current) setView(v) } catch (e) { if (alive.current) setError(errorText(e)) }
  }
  const decide = async (item: PortraitMoveItem, decision: 'move' | 'keep' | 'undo') => {
    if (busy) return
    setBusy(item.id); setError('')
    try {
      const v = await decidePortraitMove(engine, item.id, decision)
      if (decision === 'move') setMovedHere((l) => [...l, item.id])
      if (decision !== 'keep') window.dispatchEvent(new Event(HUMAN_CHANGED_EVENT))
      if (alive.current) setView(v)
    } catch (e) { if (alive.current) { setError(errorText(e)); void load() } }
    finally { if (alive.current) setBusy('') }
  }
  const names = (slugs: string[]) => slugs.map((s) => agentDefs.find((a) => a.slug === s)?.name || s).join(t('human.move.nameJoin'))
  const items = view?.items.filter((i) => i.state !== 'moved' || movedHere.includes(i.id)) ?? []
  const pending = items.filter((i) => i.state === 'pending').length
  const notices = view && !scanning && <>
    {view.scanError && <p className="agent-profile-error" role="alert">{t(view.scanError === 'PORTRAIT_MOVE_NO_MODEL' ? 'human.move.noModel' : 'human.move.failed')}</p>}
    {!!view.missed.length && <p className="human-notice" role="status" data-portrait-move-missed>{t('human.move.missed', { names: names(view.missed) })}</p>}
    {error && <p className="agent-profile-error" role="alert">{error}</p>}
  </>
  if (!view) return error ? <p className="agent-profile-error" role="alert">{error}</p> : null
  if (scanning) return <p className="portrait-move-entry" role="status" data-portrait-move-scanning><Loader2 size={13} className="spin" />{view.scanning?.total ? t('human.move.scanningOf', view.scanning) : t('human.move.scanning')}</p>
  if (later || !items.length) return <>{notices}
    {asked && !items.length && !view.scanError && <p className="human-notice" role="status" data-portrait-move-none>{t('human.move.none')}</p>}
    <p className="portrait-move-entry"><button type="button" className="profile-text-action" data-portrait-move-start onClick={() => pending ? setLater(false) : void scan()}>{pending ? t('human.move.resume', { n: pending }) : t('human.move.start')}</button></p>
  </>
  return <>{notices}<section className="portrait-move" data-portrait-move>
    <h4>{pending ? t('human.move.title', { n: pending }) : t('human.move.titleDone')}</h4>
    <p className="portrait-move-caption">{t('human.move.caption')}</p>
    <div className="self-rows">{items.map((item) => <article key={item.id} className="self-row" data-portrait-move-item={item.id} data-state={item.state}>
      <Bookmark size={15} className="self-row-ic" aria-hidden />
      <div className="self-row-kind">{t('human.move.from', { names: names(item.agents) })}</div>
      <div className="self-row-ops">
        {item.state === 'pending' && <>
          <button type="button" className="self-act" disabled={!!busy} onClick={() => void decide(item, 'move')}><ArrowRight size={12} />{t('human.move.do')}</button>
          <button type="button" className="self-act" disabled={!!busy} onClick={() => void decide(item, 'keep')}>{t('human.move.keep')}</button>
        </>}
        {item.state === 'moved' && <button type="button" className="self-act" disabled={!!busy} onClick={() => void decide(item, 'undo')}><Undo2 size={12} />{t('human.move.undo')}</button>}
      </div>
      <div className="self-row-main"><p>{item.fact}</p><p>{t('human.move.original', { text: item.content.replace(/^[-*+]\s+/, '') })}</p></div>
      {item.state !== 'pending' && <p className="self-row-note">{t(item.state === 'moved' ? 'human.move.moved' : 'human.move.unfinished')}</p>}
    </article>)}</div>
    <div className="portrait-move-foot"><button type="button" className="profile-text-action" onClick={() => { setLater(true); if (!pending) setMovedHere([]) }}>{t(pending ? 'human.move.later' : 'human.move.close')}</button></div>
  </section></>
}
