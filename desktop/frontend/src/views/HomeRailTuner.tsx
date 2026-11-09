// 开发用:主页左右栏收起的手感调节面板(只在 dev 构建里画;命令面板「主页：调节侧栏收起」开合)。
// 数值存本机 localStorage forsion.dev.homeRails,刷新不丢;定下来的数要回写成 homeRails.ts 的缺省,这块面板不进生产。
import { useRef, useState } from 'react'
import { registerMessages, useI18n } from '../i18n'
import { RAIL_GEOMETRY, RAIL_TUNE_RANGE, railThresholds, resetRailTuning, setRailTunerOpen, setRailTuning, type RailGeometry, type RailLayout, type RailMode } from './homeRails'

registerMessages({
  'home.tune.title': { zh: '侧栏收起调节（开发用）', en: 'Side rail folding (dev)' },
  'home.tune.now': { zh: '主页宽 {w} · 左栏{left} · 右栏{right} · 栏宽 {rail} · 中间 {center}', en: 'Home {w} · left {left} · right {right} · rail {rail} · center {center}' },
  'home.tune.mode.open': { zh: '展开', en: 'open' },
  'home.tune.mode.strip': { zh: '图标条', en: 'strip' },
  'home.tune.mode.hidden': { zh: '隐藏', en: 'hidden' },
  'home.tune.mode.empty': { zh: '空', en: 'empty' },
  'home.tune.rule': {
    zh: '没有比例，全是像素：主页宽减去中间、两边的外边和缝，剩下的平分给展开的栏。放不下先把栏缩到最窄，再把中间缩到最窄，还不够才收：先收左栏，再收右栏。',
    en: 'No ratios, only pixels: home width minus the center, margins and gaps is split between the open rails. When it runs out, rails shrink to their minimum, then the center shrinks to its minimum, and only then rails fold: left first, then right.',
  },
  'home.tune.both': { zh: '两栏都有卡：≥{full} 全宽三栏 · ≥{open} 三栏 · ≥{left} 先收左栏 · ≥{strips} 两栏都收', en: 'Both rails used: ≥{full} full width · ≥{open} three columns · ≥{left} left folds · ≥{strips} both fold' },
  'home.tune.right': { zh: '只有右栏：≥{open} 展开 · ≥{strip} 图标条', en: 'Right rail only: ≥{open} open · ≥{strip} icon strip' },
  'home.tune.never': { zh: '无', en: 'never' },
  'home.tune.k.centerW': { zh: '中间宽', en: 'Center width' },
  'home.tune.k.centerWNote': { zh: '会改输入框和坞的宽度', en: 'Changes the composer and dock width' },
  'home.tune.k.centerMin': { zh: '中间最窄', en: 'Center minimum' },
  'home.tune.k.centerMinNote': { zh: '等于中间宽 = 中间不缩', en: 'Equal to center width = never shrinks' },
  'home.tune.k.railW': { zh: '侧栏最宽', en: 'Rail maximum' },
  'home.tune.k.railMin': { zh: '侧栏最窄', en: 'Rail minimum' },
  'home.tune.k.gap': { zh: '栏和中间的缝', en: 'Gap to the center' },
  'home.tune.k.edge': { zh: '外边', en: 'Outer margin' },
  'home.tune.reset': { zh: '恢复默认', en: 'Reset' },
  'home.tune.copy': { zh: '复制数值', en: 'Copy values' },
  'home.tune.copied': { zh: '已复制', en: 'Copied' },
  'home.tune.close': { zh: '关闭', en: 'Close' },
})

const KNOBS: readonly { k: keyof RailGeometry; note?: boolean }[] = [
  { k: 'centerW', note: true }, { k: 'centerMin', note: true }, { k: 'railW' }, { k: 'railMin' }, { k: 'gap' }, { k: 'edge' },
]

export function HomeRailTuner({ geo, homeW, has, modes }: { geo: RailGeometry; homeW: number; has: { left: boolean; right: boolean }; modes: RailLayout }): React.JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  // 按住标题拖着走:调的时候别挡住要看的那一栏(只记在这一次打开里)
  const ref = useRef<HTMLElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const grab = (e: React.PointerEvent): void => {
    const el = ref.current, host = el?.offsetParent as HTMLElement | null
    if (e.button !== 0 || !el || !host || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const hr = host.getBoundingClientRect(), r = el.getBoundingClientRect()
    const z = el.offsetWidth ? r.width / el.offsetWidth : 1 // 外层有 CSS zoom 时换回布局 px
    const dx = e.clientX - r.left, dy = e.clientY - r.top
    const maxX = host.clientWidth - el.offsetWidth, maxY = host.clientHeight - el.offsetHeight
    const move = (ev: PointerEvent): void => setPos({
      x: Math.min(Math.max(0, (ev.clientX - dx - hr.left) / z), Math.max(0, maxX)),
      y: Math.min(Math.max(0, (ev.clientY - dy - hr.top) / z), Math.max(0, maxY)),
    })
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const th = railThresholds(geo)
  const n = (v: number | null): string => (v == null ? t('home.tune.never') : String(v))
  const mode = (m: RailMode, shown: boolean): string => t(shown ? `home.tune.mode.${m}` : 'home.tune.mode.empty')
  const custom = (Object.keys(RAIL_GEOMETRY) as (keyof RailGeometry)[]).some((k) => geo[k] !== RAIL_GEOMETRY[k])
  const copy = (): void => {
    void navigator.clipboard?.writeText(JSON.stringify(geo)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400) }, () => undefined)
  }
  return (
    <section ref={ref} className="hp-tuner" aria-label={t('home.tune.title')} style={pos ? { left: pos.x, top: pos.y, bottom: 'auto' } : undefined} onPointerDown={(e) => e.stopPropagation()}>
      <header className="hp-tuner-h" onPointerDown={grab}>
        <b>{t('home.tune.title')}</b>
        <button type="button" className="hp-tuner-x" onClick={() => setRailTunerOpen(false)}>{t('home.tune.close')}</button>
      </header>
      <p className="hp-tuner-now" data-testid="hp-tuner-now">
        {t('home.tune.now', { w: homeW, left: mode(modes.left, has.left), right: mode(modes.right, has.right), rail: modes.railW, center: modes.centerW })}
      </p>
      <p className="hp-tuner-th">{t('home.tune.both', { full: n(th.both.full), open: n(th.both.open), left: n(th.both.leftStrip), strips: n(th.both.strips) })}</p>
      <p className="hp-tuner-th">{t('home.tune.right', { open: n(th.right.open), strip: n(th.right.strip) })}</p>
      <div className="hp-tuner-knobs">
        {KNOBS.map(({ k, note }) => {
          const [lo, hi] = RAIL_TUNE_RANGE[k]
          return (
            <label key={k} className={`hp-tuner-knob${geo[k] !== RAIL_GEOMETRY[k] ? ' on' : ''}`}>
              <span className="hp-tuner-name">{t(`home.tune.k.${k}`)}{note && <small>{t(`home.tune.k.${k}Note`)}</small>}</span>
              <input type="range" min={lo} max={hi} step={k === 'gap' || k === 'edge' ? 2 : 4} value={geo[k]} data-knob={k} onChange={(e) => setRailTuning(k, Number(e.currentTarget.value))} />
              <output>{geo[k]}</output>
            </label>
          )
        })}
      </div>
      <p className="hp-tuner-rule">{t('home.tune.rule')}</p>
      <footer className="hp-tuner-f">
        <button type="button" disabled={!custom} onClick={resetRailTuning}>{t('home.tune.reset')}</button>
        <button type="button" onClick={copy}>{t(copied ? 'home.tune.copied' : 'home.tune.copy')}</button>
      </footer>
    </section>
  )
}
