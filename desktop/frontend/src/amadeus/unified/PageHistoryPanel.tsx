/** 「⋯ → 版本历史」面板(评审 C-20):左列历史版本(相对时间 + 绝对时间 · 大小),右侧只读预览(原文 / 与当前对比),
 *  底部「恢复此版本」→ 二次确认 → unified/pageHistory 的 restorePageVersion。
 *  外壳复用 Amadeus 的 .dialog-overlay / .dialog(层 4 浮层,DESIGN §3);挂 body(display:contents 载体 + .tangu-lovable 取色桥,
 *  同 RemoveDialog),不被编辑器滚动容器 / 堆叠上下文裁掉。对比复用聊天侧的 DiffView(diff2html);本组件由调用方懒加载,
 *  diff2html 的样式不进编辑器首包。预览里的 CRLF 只在展示层抹平,存的与写回的都是原字节。 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createTwoFilesPatch } from 'diff'
import { X } from 'lucide-react'
import type { PageHistoryEntry } from '@amadeus-shared/ipc'
import { amadeus } from '../api'
import { useI18n } from '../../i18n'
import { formatDateTime, formatRelative } from '../../format/time'
import { fmtSize } from '../../services/fileKinds'
import { DiffView } from '../../components/DiffView'
import { ConfirmDialog } from '../components/Dialogs'
import { flushUnifiedPath } from './lifecycle'
import { restorePageVersion } from './pageHistory'
import { shortWriteError } from './writeSafety'
import './pageHistory.css'

/** 同聊天侧 toolDiff 的口径:再大就不算 diff(主线程同步算,卡界面)。 */
const MAX_DIFF_INPUT = 200_000
const lf = (s: string): string => s.replace(/\r\n?/g, '\n')
const noteName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

export default function PageHistoryPanel({ path, locked, onClose }: { path: string; locked: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const titleId = useId()
  const [entries, setEntries] = useState<PageHistoryEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [texts, setTexts] = useState<Record<string, string | null>>({})
  const [tab, setTab] = useState<'content' | 'diff'>('content')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const confirmingRef = useRef(false)
  confirmingRef.current = confirming
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      // 手上没落盘的字先落一发(非严格:失败不挡着看历史),现文与列表才对得上「当前」。
      await flushUnifiedPath(path).catch(() => {})
      try {
        const [list, cur] = await Promise.all([amadeus.listPageHistory?.(path) ?? [], amadeus.readTextFile(path).catch(() => null)])
        if (!alive) return
        setEntries(list)
        setCurrent(cur)
        setSel(list[0]?.id ?? null)
      } catch (e) {
        if (alive) setLoadError(shortWriteError(e))
      }
    })()
    return () => { alive = false }
  }, [path])

  useEffect(() => {
    if (!sel || sel in texts) return
    let alive = true
    void (amadeus.readPageHistory?.(path, sel) ?? Promise.resolve(null)).catch(() => null).then((x) => {
      if (alive) setTexts((m) => ({ ...m, [sel]: x }))
    })
    return () => { alive = false }
  }, [path, sel, texts])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !confirmingRef.current) onClose() // 确认框开着时 Esc 只关确认框(它自己听)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const entry = entries?.find((e) => e.id === sel) ?? null
  const text = sel ? texts[sel] : undefined
  const diff = useMemo(() => {
    if (tab !== 'diff' || typeof text !== 'string' || current == null) return null
    const a = lf(current)
    const b = lf(text)
    if (a === b) return { kind: 'same' as const }
    if (a.length + b.length > MAX_DIFF_INPUT) return { kind: 'large' as const }
    return { kind: 'patch' as const, patch: createTwoFilesPatch(t('pghist.diff.current'), t('pghist.diff.version'), a, b, '', '', { context: 3 }) }
  }, [tab, text, current, t])

  const move = (d: 1 | -1): void => {
    if (!entries?.length) return
    const i = Math.max(0, entries.findIndex((e) => e.id === sel))
    const next = entries[Math.min(entries.length - 1, Math.max(0, i + d))]
    setSel(next.id)
    listRef.current?.querySelector<HTMLElement>(`[data-hist-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const doRestore = async (): Promise<void> => {
    if (!entry || busy) return
    setBusy(true)
    const ok = await restorePageVersion(path, entry)
    setBusy(false)
    if (ok) onClose()
  }

  return createPortal(
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <div className="dialog-overlay" onMouseDown={onClose}>
        <div className="dialog amx-hist" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="page-history" onMouseDown={(e) => e.stopPropagation()}>
          <div className="amx-hist-head">
            <div className="dialog-title" id={titleId}>{t('pghist.menu')}<span className="amx-hist-note">{noteName(path)}</span></div>
            <button type="button" className="amx-hist-close" onClick={onClose} title={t('pghist.close')} aria-label={t('pghist.close')}><X size={15} /></button>
          </div>
          <div className="amx-hist-body">
            {loadError != null ? (
              <div className="amx-hist-state">{t('pghist.loadFailed', { reason: loadError })}</div>
            ) : entries == null ? (
              <div className="amx-hist-state">{t('pghist.loading')}</div>
            ) : entries.length === 0 ? (
              <div className="amx-hist-state" data-hist-empty>{t('pghist.empty')}</div>
            ) : (
              <>
                <div
                  ref={listRef}
                  className="amx-hist-list"
                  role="listbox"
                  aria-label={t('pghist.listLabel')}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1) }
                  }}
                >
                  {entries.map((e) => (
                    <div
                      key={e.id}
                      className="amx-hist-row"
                      role="option"
                      aria-selected={e.id === sel}
                      data-hist-id={e.id}
                      onClick={() => setSel(e.id)}
                    >
                      <span className="amx-hist-rel">{formatRelative(e.at)}</span>
                      <span className="amx-hist-meta">{formatDateTime(e.at)} · {fmtSize(e.size)}</span>
                    </div>
                  ))}
                </div>
                <div className="amx-hist-preview">
                  <div className="amx-hist-tabs" role="tablist">
                    {(['content', 'diff'] as const).map((k) => (
                      <button key={k} type="button" role="tab" className="amx-hist-tab" aria-selected={tab === k} data-hist-tab={k} onClick={() => setTab(k)}>
                        {t(k === 'content' ? 'pghist.tab.content' : 'pghist.tab.diff')}
                      </button>
                    ))}
                  </div>
                  <div className="amx-hist-view" data-hist-view={tab}>
                    {text === undefined ? (
                      <div className="amx-hist-state">{t('pghist.loading')}</div>
                    ) : text === null ? (
                      <div className="amx-hist-state">{t('pghist.previewFailed')}</div>
                    ) : tab === 'content' ? (
                      <pre className="amx-hist-text">{lf(text)}</pre>
                    ) : diff?.kind === 'patch' ? (
                      <DiffView text={diff.patch} side={false} />
                    ) : (
                      <div className="amx-hist-state">{t(diff?.kind === 'large' ? 'pghist.tooLarge' : 'pghist.same')}</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="amx-hist-foot">
            <span className="amx-hist-hint">{t(locked ? 'pghist.lockedHint' : 'pghist.restoreHint')}</span>
            <button
              type="button"
              className="dialog-btn"
              data-primary
              data-hist-restore
              disabled={locked || busy || !entry || typeof text !== 'string'}
              onClick={() => setConfirming(true)}
            >
              {t('pghist.restore')}
            </button>
          </div>
        </div>
      </div>
      {confirming && entry && (
        <ConfirmDialog
          title={t('pghist.confirm.title', { time: formatDateTime(entry.at) })}
          message={t('pghist.confirm.msg')}
          confirmLabel={t('pghist.confirm.ok')}
          danger={false}
          onConfirm={() => { void doRestore() }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>,
    document.body,
  )
}
