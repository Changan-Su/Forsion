/**
 * 设置 → 外观(设置页规范 v1 · 方案 B,2026-11-17):整页是一份 SettingsPage 宿主描述,按「它改的是什么」分组 ——
 * 设计语言 → 配色与明暗 → 动效 → 层次与质感 → 大小、阅读与输入 → 字体,最后是开屏与图标(StartupAppearanceSettings 自带面板)。
 *
 * - 面板一律全宽单列(不再是两列网格 + 「占满整行」白名单:动效主题曾因没进白名单只占半边)。
 * - 选择卡网格、色卡轴、字体表是宿主 block;其余是标准行:行不带图标,二态一律开关,
 *   依赖毛玻璃的「外壳随内容取色」缩进挂在它下面,毛玻璃关着时灰掉不藏。
 * - Ribbon 两项不属于外观,搬去了 Space 页(RibbonSettings.tsx)。锚点、搜索词、i18n 键都不改名。
 * 状态都是本机偏好、即时生效、不进设置草稿(和搬过来之前一样)。方案与真图:docs/ToBeImproved/设置规范方案_2026-11-17/。
 */
import React, { useEffect, useState } from 'react'
import { FolderOpen, Layers3, MonitorCog, Moon, Palette, RefreshCw, Scaling, Sparkles, Sun, Type, Wind } from 'lucide-react'
import { useI18n } from '../i18n'
import { ThemeCard } from './ThemeCard'
import { ThemeSettingsPanel } from './ThemeSettingsPanel'
import { ThemePreview } from './ThemePreview'
import { StartupAppearanceSettings } from './StartupAppearanceSettings'
import { MotionThemeGrid } from './MotionThemeSection'
import { SettingsPage, type HostSettingsGroup, type HostSettingsItem } from './SettingsPage'
import { onRadioGroupKeyDown, radioTabIndex } from './radioGroupKeys'
import { backgroundSwatch, listLanguages, listSkins, skinSwatch, forcedSchemeForLanguage, SIGNALS } from '../theme/registry'
import { customAccentVars } from '../theme/lcl/lovableData'
import { setFadeOnly, useMotionPrefs } from '../theme/motionTheme'
import { isCalmOn, setCalmOn, type CalmKey } from '../theme/calm'
import { useTheme } from '../stores/themeStore'
import { UI_ZOOM_EVENT } from '@lcl/engine'
import { getUiZoom, setUiZoom } from '../uiZoom'
import { applyUiFonts, readFont, writeFont, type FontSlot } from '../uiFont'
import { listFonts, getFont } from '../fontPresets'
import { isSmoothCaretOn, setSmoothCaret as persistSmoothCaret } from '../smoothCaret'
import { loadHomepageWallpaperPrefs, onHomepageWallpaperPrefsChange, setHomepageWallpaperMotion } from '../views/homepageWallpaper'
import { selectionBarOrder, setSelectionBarOrder } from '../selectionActions'
import { SelectionActionsTable } from './SelectionActionsTable'
import { readTanguPrefs } from '../amadeus/plugins/tanguSeam'

export interface AppearanceSettingsProps {
  tabLabel: string
  themeLang: string
  themeSkin: string
  themeMode: 'light' | 'dark'
  themeModePref: 'light' | 'dark' | 'system'
  glassOn: boolean
  flatOn: boolean
  themeSeed: string
  onThemeChange: (lang: string, skin: string, pref: 'light' | 'dark' | 'system') => void
  onGlassChange: (on: boolean) => void
  onFlatChange: (on: boolean) => void
  onSeedChange: (hex: string) => void
  onReloadThemes?: () => void | Promise<void>
}

const ZOOM_PRESETS = [[0.8, 'settings.theme.zoomSmall'], [1, 'settings.theme.zoomStandard'], [1.2, 'settings.theme.zoomLarge']] as const
const COLOR_INPUT: React.CSSProperties = { width: 48, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }

export function AppearanceSettings(p: AppearanceSettingsProps): React.ReactElement {
  const { t } = useI18n()
  // 背景色轴 + 它的自定义 seed、强调色、外壳取色:直接读写 themeStore(不走 props 链 → 三端自动到位)
  const themeBg = useTheme((s) => s.bg)
  const setBg = useTheme((s) => s.setBg)
  const themeBgSeed = useTheme((s) => s.bgSeed)
  const setBgSeedValue = useTheme((s) => s.setBgSeedValue)
  const themeSignal = useTheme((s) => s.signal)
  const setSignal = useTheme((s) => s.setSignal)
  const ambientOn = useTheme((s) => s.ambient)
  const { fadeChosen, systemReduce } = useMotionPrefs()
  const [themesReloading, setThemesReloading] = useState(false)
  // 丝滑光标(默认关;localStorage,smoothCaret.ts 全局模块即时生效)
  const [smoothCaret, setSmoothCaret] = useState<boolean>(isSmoothCaretOn)
  // 主页壁纸动效:和主页壁纸面板里的开关是同一个值(主页那边听同一份偏好)
  const [homeMotion, setHomeMotion] = useState(() => loadHomepageWallpaperPrefs().motion)
  useEffect(() => onHomepageWallpaperPrefsChange(() => setHomeMotion(loadHomepageWallpaperPrefs().motion)), [])
  // 划线菜单的排法(缺省视图工具在前;localStorage,条每次出现时现读)
  const [selBarOrder, setSelBarOrder] = useState(selectionBarOrder)
  // 聊天头像是 Tangu 的偏好(核心插件化 2e-2):读写走 Tangu 交出的接缝,没装 Tangu 就不摆这一行
  const tanguPrefs = readTanguPrefs()
  const [chatAvatars, setChatAvatars] = useState<boolean>(() => tanguPrefs?.chatAvatars.get() ?? true)
  // 「呼吸感」三项(theme/calm.ts):纯本机渲染偏好;别的窗口经 storage 事件跟上。
  // 「外围淡出」靠悬停恢复(calm.css 整段关在 hover: hover 里):没有悬停的设备上那一行与它的搜索结果都不出。
  const [calm, setCalm] = useState<Record<CalmKey, boolean>>(() => ({ dim: isCalmOn('dim'), reading: isCalmOn('reading'), motion: isCalmOn('motion') }))
  const toggleCalm = (k: CalmKey, on: boolean): void => { setCalmOn(k, on); setCalm((c) => ({ ...c, [k]: on })) }
  const hoverCapable = !!window.matchMedia?.('(hover: hover)').matches
  // 界面字体三档(空 = 跟随主题;uiFont.ts 注入 <style> 即刻生效)
  const [fonts, setFonts] = useState<Record<FontSlot, string>>(() => ({ ui: readFont('ui'), body: readFont('body'), mono: readFont('mono') }))
  const setFont = (slot: FontSlot, v: string): void => { setFonts((f) => ({ ...f, [slot]: v })); writeFont(slot, v); applyUiFonts() }
  // 界面缩放与快捷键 / 命令面板共用 uiZoom 单一真源;面板开着时按 ⌘/Ctrl +/- 也能当场刷新百分比与预设选中态
  const [uiZoom, setUiZoomState] = useState<number>(getUiZoom)
  useEffect(() => {
    const sync = (): void => setUiZoomState(getUiZoom())
    window.addEventListener(UI_ZOOM_EVENT, sync)
    return () => window.removeEventListener(UI_ZOOM_EVENT, sync)
  }, [])

  const dark = p.themeMode === 'dark'
  const languages = listLanguages()
  const current = languages.find((th) => th.manifest.id === p.themeLang)

  // ── 设计语言 ──
  const language: HostSettingsGroup = {
    id: 'theme-language', anchor: 'theme-language', className: 'settings-theme-language',
    icon: <Palette size={16} />, title: t('settings.theme.langLabel'), desc: t('settings.theme.langDescription'),
    headActions: (
      <>
        <button type="button" className="btn ghost sm" onClick={() => { void window.tangu?.openThemesDir?.() }} title={t('settings.theme.openFolder')} aria-label={t('settings.theme.openFolder')}>
          <FolderOpen size={13} />
        </button>
        <button type="button" className="btn ghost sm settings-panel-btn--text" title={t('settings.theme.reload')} disabled={themesReloading}
          onClick={async () => { setThemesReloading(true); try { await p.onReloadThemes?.() } finally { setThemesReloading(false) } }}>
          <RefreshCw size={13} className={themesReloading ? 'spin' : ''} /> {t('settings.theme.reload')}
        </button>
      </>
    ),
    items: [
      {
        type: 'block', id: 'cards', node: (
          <div className="theme-grid" role="radiogroup" aria-label={t('settings.theme.langLabel')} onKeyDown={onRadioGroupKeyDown}>
            {languages.map((th, i, all) => (
              <ThemeCard key={th.manifest.id} entry={th} active={th.manifest.id === p.themeLang}
                tabIndex={radioTabIndex(th.manifest.id === p.themeLang, i, all.some((x) => x.manifest.id === p.themeLang))}
                // 传明暗**偏好**(非落地明暗):换到锁定 colorScheme 的主题时由 setTheme 解析,不先按旧 mode 应用一次(会闪)
                onSelect={() => p.onThemeChange(th.manifest.id, p.themeSkin, p.themeModePref)} />
            ))}
          </div>
        ),
      },
      // 选中主题自曝的可调参数(有才渲染);key 带 lang 使换主题时重挂。磁盘主题里写了动效 token 的,收口时已删掉(theme/motionGuard.ts),这里说一句。
      ...(current ? [{
        type: 'block' as const, id: 'opts', node: (
          <>
            <ThemeSettingsPanel key={p.themeLang} entry={current} />
            {current.cssRejected
              ? <div className="hint" data-theme-motion-rejected="" style={{ marginTop: 6 }}>{t('settings.theme.motionRejected')}</div>
              : (current.motionIgnored?.length ?? 0) > 0 && <div className="hint" data-theme-motion-ignored={current.motionIgnored!.length} style={{ marginTop: 6 }}>{t('settings.theme.motionIgnored', { n: current.motionIgnored!.length })}</div>}
          </>
        ),
      }] : []),
      { type: 'block', id: 'drop-hint', node: <div className="hint" style={{ marginTop: 6 }}>{t('settings.theme.dropHint')}</div> },
    ],
  }

  // ── 配色与明暗:明暗是第一根轴,其后主题色 / 背景色 / 强调色(三根独立的轴,见 theme/skins.css) ──
  const forced = forcedSchemeForLanguage(p.themeLang) // 主题锁了 colorScheme(如 Glass 固定 system):高亮强制值 + 禁用
  const activeMode = forced ?? p.themeModePref
  const modeAxis = (
    <div className="settings-palette-axis" data-setting-anchor="color-mode">
      <strong>{t('settings.theme.modeLabel')}</strong>
      <div className="seg" role="group" aria-label={t('settings.theme.modeLabel')}>
        {([['light', Sun, 'settings.theme.light'], ['dark', Moon, 'settings.theme.dark'], ['system', MonitorCog, 'settings.theme.system']] as const).map(([id, Ic, key]) => (
          <button key={id} type="button" aria-pressed={activeMode === id} className={activeMode === id ? 'active' : ''} disabled={!!forced}
            title={forced ? t('settings.theme.modeLocked') : undefined} onClick={() => p.onThemeChange(p.themeLang, p.themeSkin, id)}>
            <Ic size={13} />{t(key)}
          </button>
        ))}
      </div>
      {forced && <div className="hint" style={{ marginTop: 9 }}>{t('settings.theme.modeLockedHint')}</div>}
    </div>
  )
  const accentAxis = (
    <div className="settings-palette-axis">
      <strong>{t('settings.theme.accentLabel')}</strong>
      <div className="skin-row">
        {listSkins().map((sk) => (
          <button key={sk.id} type="button" className={`skin-chip${sk.id === p.themeSkin ? ' active' : ''}`} title={t(`settings.theme.skin.${sk.id}`)}
            onClick={() => p.onThemeChange(p.themeLang, sk.id, p.themeModePref)}>
            <i className="skin-dot" style={{ background: sk.id === 'custom' ? p.themeSeed : skinSwatch(sk, dark, 'accent') }} />
            <span>{t(`settings.theme.skin.${sk.id}`)}</span>
          </button>
        ))}
      </div>
      {p.themeSkin === 'custom' && (
        <div className="field-row" style={{ alignItems: 'center', gap: 10, marginTop: 11 }}>
          <input type="color" value={p.themeSeed} onChange={(e) => p.onSeedChange(e.target.value)} aria-label={t('settings.theme.customSeedLabel')} style={COLOR_INPUT} />
          <span className="hint" style={{ fontFamily: 'var(--font-mono)' }}>{p.themeSeed}</span>
        </div>
      )}
    </div>
  )
  const bgAxis = (
    <div className="settings-palette-axis">
      <strong>{t('settings.theme.bgLabel')}</strong>
      <div className="skin-row">
        {listSkins().map((sk) => (
          <button key={sk.id} type="button" className={`skin-chip${sk.id === themeBg ? ' active' : ''}`} title={t(`settings.theme.skin.${sk.id}`)} onClick={() => setBg(sk.id)}>
            <i className="skin-dot skin-dot-background" style={{ background: backgroundSwatch(sk, dark, sk.id === 'custom' ? (themeBgSeed || p.themeSeed) : sk.bgSeed) }} />
            <span>{t(`settings.theme.skin.${sk.id}`)}</span>
          </button>
        ))}
      </div>
      {themeBg === 'custom' && (
        <>
          <div className="field-row" style={{ alignItems: 'center', gap: 10, marginTop: 11 }}>
            <input type="color" value={themeBgSeed || '#f8f7f6'} onChange={(e) => setBgSeedValue(e.target.value)} aria-label={t('settings.theme.customBgLabel')} style={COLOR_INPUT} />
            <span className="hint" style={{ fontFamily: 'var(--font-mono)' }}>{themeBgSeed || t('settings.theme.customBgFollow')}</span>
            {themeBgSeed && <button className="btn ghost sm" onClick={() => setBgSeedValue('')}>{t('settings.theme.customBgClear')}</button>}
          </div>
          <div className="hint" style={{ marginTop: 6 }}>{t('settings.theme.customBgHint')}</div>
        </>
      )}
    </div>
  )
  // 强调色(--signal):指示类元素(落点线 / 开关 / 勾选 / 选中框 / 双链…)的那支色。'' = 跟随主题色,内置 id 取 SIGNALS,'#hex' 自定义。全局一份,不进 Space 外观。
  const signalAxis = (() => {
    const custom = /^#/.test(themeSignal)
    const tone = (id: string): string => { const x = SIGNALS.find((s) => s.id === id); return x ? (dark ? x.dark : x.light) : '' }
    const skinInfo = listSkins().find((sk) => sk.id === p.themeSkin)
    const accent = p.themeSkin === 'custom' || !skinInfo ? p.themeSeed : skinSwatch(skinInfo, dark, 'accent')
    // 「跟随」圆点:左上主题色、右下它带的强调色(单色配色带柔蓝;自定义取 loader 同一个 --signal-skin)
    const follows = p.themeSkin === 'custom' ? customAccentVars(p.themeSeed, dark)['--signal-skin']
      : tone(p.themeSkin === 'cream' || p.themeSkin === 'ink' ? 'blue' : p.themeSkin) || accent
    const chips = [
      { id: '', label: t('settings.theme.signalFollow'), dot: `linear-gradient(135deg, ${accent} 0 50%, ${follows} 50% 100%)` },
      ...SIGNALS.map((x) => ({ id: x.id, label: x.id === 'blue' ? t('settings.theme.signalBlue') : t(`settings.theme.skin.${x.id}`), dot: dark ? x.dark : x.light })),
    ]
    return (
      <div className="settings-palette-axis">
        <strong>{t('settings.theme.signalLabel')}</strong>
        <div className="skin-row">
          {chips.map((c) => (
            <button key={c.id || 'follow'} type="button" className={`skin-chip${c.id === themeSignal ? ' active' : ''}`} title={c.label} onClick={() => setSignal(c.id)}>
              <i className="skin-dot" style={{ background: c.dot }} />
              <span>{c.label}</span>
            </button>
          ))}
          <button type="button" className={`skin-chip${custom ? ' active' : ''}`} title={t('settings.theme.skin.custom')} onClick={() => { if (!custom) setSignal('#b4532a') }}>
            <i className="skin-dot" style={{ background: custom ? themeSignal : 'conic-gradient(#d9774a, #c9b04a, #5f9a6a, #4f7fb0, #8a6fb0, #d9774a)' }} />
            <span>{t('settings.theme.skin.custom')}</span>
          </button>
        </div>
        {custom && (
          <div className="field-row" style={{ alignItems: 'center', gap: 10, marginTop: 11 }}>
            <input type="color" value={themeSignal} onChange={(e) => setSignal(e.target.value)} aria-label={t('settings.theme.customSignalLabel')} style={COLOR_INPUT} />
            <span className="hint" style={{ fontFamily: 'var(--font-mono)' }}>{themeSignal}</span>
            <button className="btn ghost sm" onClick={() => setSignal('')}>{t('settings.theme.customBgClear')}</button>
          </div>
        )}
        <div className="hint" style={{ marginTop: 9 }}>{t('settings.theme.signalHint')}</div>
      </div>
    )
  })()
  const palette: HostSettingsGroup = {
    id: 'palette', anchor: 'palette', className: 'settings-theme-palette',
    icon: <Sparkles size={16} />, title: t('settings.theme.paletteTitle'), desc: t('settings.theme.paletteDescription'),
    items: [
      { type: 'block', id: 'mode', node: modeAxis },
      { type: 'block', id: 'accent', node: accentAxis },
      { type: 'block', id: 'background', node: bgAxis },
      { type: 'block', id: 'signal', node: signalAxis },
    ],
  }

  // ── 动效:动效主题卡 + 跟「动」有关的开关(原来散在两块) ──
  const motion: HostSettingsGroup = {
    id: 'motion', anchor: 'motion-theme', className: 'settings-motion-theme',
    icon: <Wind size={16} />, title: t('settings.theme.motionTitle'), desc: t('settings.theme.motionDescription'),
    items: [
      { type: 'block', id: 'cards', node: <MotionThemeGrid /> },
      // 「只淡入淡出」:系统开了减少动态效果时打开且灰掉,小字换成说明;不改系统设置
      { type: 'switch', id: 'motion-fade', anchor: 'motion-fade', title: t('settings.motionTheme.fadeOnly'),
        desc: systemReduce ? t('settings.motionTheme.fadeOnlyLocked') : t('settings.motionTheme.fadeOnlyHint'),
        value: fadeChosen || systemReduce, disabled: systemReduce, onChange: (on) => setFadeOnly(on) },
      { type: 'switch', id: 'calm-motion', anchor: 'calm-motion', title: t('settings.theme.calmMotion'), desc: t('settings.theme.calmMotionHint'),
        value: calm.motion, onChange: (on) => toggleCalm('motion', on) },
      { type: 'switch', id: 'home-motion', anchor: 'home-motion', title: t('settings.theme.homeMotion'), desc: t('settings.theme.homeMotionHint'),
        value: homeMotion, onChange: (on) => { setHomeMotion(on); setHomepageWallpaperMotion(on) } },
    ],
  }

  // ── 层次与质感 ──
  const textureItems: HostSettingsItem[] = [
    { type: 'segmented', id: 'flat', anchor: 'flat', title: t('settings.theme.flatLabel'), desc: t('settings.theme.flatDescription'),
      value: p.flatOn ? 'flat' : 'raised', options: [{ value: 'raised', label: t('settings.theme.flatOff') }, { value: 'flat', label: t('settings.theme.flatOn') }],
      onChange: (v) => p.onFlatChange(v === 'flat') },
    // 二态一律开关(原来是「开 / 关(低配模式)」两格分段)
    { type: 'switch', id: 'glass', anchor: 'glass', title: t('settings.theme.glassLabel'), desc: t('settings.theme.glassDescription'),
      value: p.glassOn, onChange: (on) => p.onGlassChange(on) },
    // 依赖毛玻璃:缩进挂在它下面;毛玻璃关着时灰掉不藏(设置搜索的落点不能时有时无),偏好值照旧保留
    { type: 'switch', id: 'ambient', anchor: 'ambient', child: true, title: t('settings.theme.ambient'),
      desc: p.glassOn ? t('settings.theme.ambientHint') : t('settings.theme.ambientNeedsGlass'),
      value: ambientOn, disabled: !p.glassOn, onChange: (on) => useTheme.getState().setAmbient(on) },
  ]
  if (hoverCapable) textureItems.push({ type: 'switch', id: 'calm-dim', anchor: 'calm-dim', title: t('settings.theme.calmDim'), desc: t('settings.theme.calmDimHint'),
    value: calm.dim, onChange: (on) => toggleCalm('dim', on) })
  const texture: HostSettingsGroup = {
    id: 'texture', className: 'settings-theme-texture',
    icon: <Layers3 size={16} />, title: t('settings.theme.textureTitle'), desc: t('settings.theme.textureDescription'),
    items: textureItems,
  }

  // ── 大小、阅读与输入 ──
  const zoomPreset = ZOOM_PRESETS.find(([v]) => Math.abs(uiZoom - v) < 0.001)
  const readingItems: HostSettingsItem[] = [
    { type: 'segmented', id: 'ui-zoom', anchor: 'ui-zoom', title: t('settings.theme.zoomLabel'), desc: t('settings.theme.zoomHint', { percent: Math.round(uiZoom * 100) }),
      value: zoomPreset ? String(zoomPreset[0]) : '', options: ZOOM_PRESETS.map(([v, key]) => ({ value: String(v), label: `${t(key)} ${Math.round(v * 100)}%` })),
      onChange: (v) => setUiZoom(Number(v)) },
    { type: 'switch', id: 'calm-reading', anchor: 'calm-reading', title: t('settings.theme.calmReading'), desc: t('settings.theme.calmReadingHint'),
      value: calm.reading, onChange: (on) => toggleCalm('reading', on) },
  ]
  if (tanguPrefs) readingItems.push({ type: 'switch', id: 'chat-avatars', anchor: 'chat-avatars', title: t('settings.theme.chatAvatars'), desc: t('settings.theme.chatAvatarsHint'),
    value: chatAvatars, onChange: (on) => { setChatAvatars(on); tanguPrefs.chatAvatars.set(on) } })
  readingItems.push(
    { type: 'switch', id: 'smooth-caret', anchor: 'smooth-caret', title: t('settings.theme.smoothCaret'), desc: t('settings.theme.smoothCaretHint'),
      value: smoothCaret, onChange: (on) => { setSmoothCaret(on); persistSmoothCaret(on) } },
    { type: 'select', id: 'selection-bar', anchor: 'selection-bar', title: t('settingsmodal.selectionBar'), desc: t('settingsmodal.selectionBarHint'),
      value: selBarOrder, options: [{ value: 'tools', label: t('settingsmodal.selectionBar.tools') }, { value: 'actions', label: t('settingsmodal.selectionBar.actions') }],
      onChange: (v) => { const next = v === 'actions' ? 'actions' : 'tools'; setSelBarOrder(next); setSelectionBarOrder(next) } },
    // 管理表(2026-11-21):每个动作放哪 / 排序 / 划选后自动。落点沿用上面那一格的 selection-bar(没另开设置搜索的 id)
    { type: 'block', id: 'selection-actions', node: <SelectionActionsTable /> },
  )
  const reading: HostSettingsGroup = {
    id: 'reading', className: 'settings-theme-reading',
    icon: <Scaling size={16} />, title: t('settings.theme.readingTitle'), desc: t('settings.theme.readingDescription'),
    items: readingItems,
  }

  // ── 字体:三档;空 = 跟随主题。**只能选预设**(随包内置,不依赖本机);插件注册的字体分到另一个 optgroup ──
  const fontList = (
    <div className="settings-font-list">
      {([['ui', 'settings.theme.fontUi'], ['body', 'settings.theme.fontBody'], ['mono', 'settings.theme.fontMono']] as const).map(([slot, labelKey]) => {
        const list = listFonts(slot)
        const builtin = list.filter((f) => f.source === 'builtin')
        const fromPlugins = list.filter((f) => f.source !== 'builtin')
        const nameOf = (f: (typeof list)[number]): string => (f.labelKey ? t(f.labelKey as Parameters<typeof t>[0]) : (f.label ?? f.id))
        return (
          <label className="settings-font-row" key={slot} htmlFor={`font-${slot}`}>
            <span>{t(labelKey)}</span>
            {/* 预览就用选中项的栈本身,选完立刻能看出长什么样 */}
            <select id={`font-${slot}`} value={fonts[slot]} onChange={(e) => setFont(slot, e.target.value)} style={{ fontFamily: getFont(fonts[slot])?.stack || undefined }}>
              <option value="">{t('settings.theme.fontFollow')}</option>
              <optgroup label={t('settings.theme.fontGroupBuiltin')}>
                {builtin.map((f) => <option key={f.id} value={f.id}>{nameOf(f)}</option>)}
              </optgroup>
              {fromPlugins.length > 0 && (
                <optgroup label={t('settings.theme.fontGroupPlugin')}>
                  {fromPlugins.map((f) => <option key={f.id} value={f.id}>{nameOf(f)}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        )
      })}
    </div>
  )
  const typography: HostSettingsGroup = {
    id: 'fonts', anchor: 'fonts', className: 'settings-theme-fonts',
    icon: <Type size={16} />, title: t('settings.theme.typographyTitle'), desc: t('settings.theme.fontHint'),
    items: [{ type: 'block', id: 'list', node: fontList }],
  }

  return (
    <>
      <ThemePreview tabLabel={p.tabLabel} />
      <SettingsPage host schema={{ groups: [language, palette, motion, texture, reading, typography] }} />
      <StartupAppearanceSettings />
    </>
  )
}
