/**
 * 左栏「智库」那行右边的同步状态小字(智库同步统一方案第 1 步;点开是 VaultSyncPanel)。
 * 放得下就写整句,放不下收成最短的写法、库名不截(方案「进度在哪看」:淡勾 / 进度圈 + 百分比 / 圆点 + 篇数 / 红点),整句在悬停提示和面板里。
 * 字只从 vaultSyncText 取 —— 状态栏、通知、智库菜单同一份。这个库没有任何同步在跑(只在这台)时不占地方;
 * 网页 / 手机没有这几个桥,状态源是空的,也就不画(M1 / M2 / M4 另做)。
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Check } from 'lucide-react'
import { useI18n } from '../i18n'
import { useVaultSync } from './vaultSyncStore'
import { vaultSyncTip, vaultSyncWords, type VaultSyncShort, type VaultSyncWords } from './vaultSyncText'
import { VaultSyncPanel } from './VaultSyncPanel'
import { registerVaultSyncPanel } from './panelBus'
import './vaultSync.css'

/** 桌面才有的几个桥:都没有 = 没有同步可说(网页 / 手机)。 */
export const hasSyncBridges = (): boolean =>
  typeof window !== 'undefined' && !!(window.amadeusSync || window.remoteSync || window.tangu?.cloudInvoke)


function Ring({ pct }: { pct: number | null }) {
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <svg className={`vsync-ring${pct === null ? ' is-busy spin' : ''}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r={r} className="vsync-ring-track" />
      <circle cx="6" cy="6" r={r} className="vsync-ring-fill" strokeDasharray={`${pct === null ? c * 0.3 : (c * pct) / 100} ${c}`} transform="rotate(-90 6 6)" />
    </svg>
  )
}

/** 小字前面的那枚记号(整句和最短写法共用一套)。 */
function Mark({ short }: { short: VaultSyncShort }) {
  switch (short.kind) {
    case 'check': return <Check size={12} className="vsync-mark-check" aria-hidden="true" />
    case 'ring': return <Ring pct={short.pct} />
    case 'dot': return <span className="vsync-dot is-warning" aria-hidden="true" />
    case 'error': return <span className="vsync-dot is-danger" aria-hidden="true" />
    default: return null
  }
}

function shortLabel(short: VaultSyncShort): string {
  switch (short.kind) {
    case 'ring': return short.pct === null ? '' : `${short.pct}%`
    case 'dot': return String(short.n)
    case 'text': return short.text
    default: return ''
  }
}

/** 整句放不放得下:库名的完整宽度 + 整句小字 + 图标 / 箭头 / 间距 > 这一行的宽 → 收短。只用布局宽度(offset / scroll),缩放下不混坐标系。 */
function useCompact(rowRef: RefObject<HTMLElement | null>, fullRef: RefObject<HTMLElement | null>, deps: unknown[]): boolean {
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const full = fullRef.current
      const title = row.querySelector<HTMLElement>('.t2s-special-title')
      if (!full || !title) return
      const cs = getComputedStyle(row)
      const gap = parseFloat(cs.columnGap) || 7
      const fixed = [...row.children].reduce((a, el) => {
        const e = el as HTMLElement
        if (e.contains(title) || e.contains(full)) return a
        return a + e.offsetWidth + gap
      }, 0)
      const icon = row.querySelector<HTMLElement>('.t2s-special-ic')?.offsetWidth ?? 0
      const need = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + icon + gap + title.scrollWidth + gap + full.offsetWidth + fixed
      setCompact(need > row.clientWidth + 0.5)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    measure()
    return () => ro.disconnect()
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return compact
}

export function VaultSyncChip({ vault, name, rowRef }: {
  vault: { root: string | null; side: 'local' | 'cloud' }
  /** 面板标题里的库名 */
  name: string
  /** 这一行(量宽度、面板贴着它弹) */
  rowRef: RefObject<HTMLElement | null>
}) {
  const { t, locale } = useI18n()
  const view = useVaultSync(vault)
  const words: VaultSyncWords = vaultSyncWords(view, view.now, t)
  const fullRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const shown = hasSyncBridges() && view.state !== 'off'
  const compact = useCompact(rowRef, fullRef, [words.text, name, shown, locale])

  useEffect(() => (shown ? registerVaultSyncPanel(() => setOpen(true)) : undefined), [shown])

  if (!shown) return null
  const tip = vaultSyncTip(view, words, t)
  const label = compact ? shortLabel(words.short) : words.text
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`vsync-chip tone-${words.tone}${compact ? ' is-compact' : ''}`}
        data-state={view.state}
        title={tip}
        aria-label={tip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
      >
        <Mark short={words.short} />
        {label && <span className="vsync-chip-text">{label}</span>}
        {/* 量整句宽度用:不显示、不进读屏 */}
        <span ref={fullRef} className="vsync-chip-measure" aria-hidden="true"><Mark short={words.short} />{words.text}</span>
      </button>
      {open && <VaultSyncPanel vault={vault} name={name} view={view} anchorRef={rowRef} onClose={() => { setOpen(false); btnRef.current?.focus() }} />}
    </>
  )
}
