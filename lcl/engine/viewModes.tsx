/**
 * 视图模式:同一份东西换一种看法(对话 / 画布、文档 / 画布、转写 / 笔记 / 纪要、日 / 周 / 3 日 / 月)。
 * 标准见 docs/ToBeImproved/视图模式切换标准方案_2026-10-19(用户选 A:视图头行左端)。
 *
 *  - 视图用 `useViewModes(leaf.id, spec)` 登记,再在自己的头行最左放 `<ViewModeSwitch leafId>`(或整行用 `<ViewHead>`)。
 *    2–4 种、一个视图一颗;超过 4 种照旧用标签(数据库视图是唯一例外)。筛选 / 换来源的胶囊外观一样,但不进这个位置。
 *  - 手机单列壳:视图自己不画(组件在那里返回 null),顶栏两颗胶囊中间由 SingleColumnHost 画活动视图登记的那份,随 chrome 一起藏。
 *  - ⌥⌘V(Windows / Linux:Ctrl+Alt+V)= 活动视图切到下一种;命令面板里每种一条「看法：画布」(开面板那一刻按活动视图生成)。
 *  - 窄:按头行自己的宽度(container `lcl-viewhead`):< 480 只留图标(每种都给了图标时),< 320 换成「当前看法 ▾」下拉。
 *  - 记忆归视图自己(按对象记:笔记按篇、对话按树根、谛听按记录、日历全局);这里只管摆和切。
 *
 * ⚠️ 住在引擎而不是 lcl/components:SingleColumnHost(引擎)要画它,components 反过来依赖引擎会成环。
 *    components/index.ts 只是转出口。也别放进 WorkspaceHost.tsx —— 手机构建把那个文件整个换成 emptyHost。
 */
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { addCommand, commandHotkeyText, removeCommand, useCommandStore } from './commandRegistry'
import { activeMainPanel, useWorkspace } from './workspaceStore'
import { IS_MINI_PANEL, UI_MODE } from './uiMode'
import { engineTr, useEngineI18n } from './i18nSeam'
import { OverlayAt } from './menuAnchor'
import { nativeChromeInstalled } from './nativeChrome'
import './viewModes.css'

export interface ViewModeOption {
  value: string
  /** 已按当前语言求值的名字(zh/en 由视图自己的字典给)。 */
  label: string
  /** 窄时只留图标;有一种没给就一直显示文字。 */
  icon?: ComponentType<{ size?: number; className?: string }>
  /** 这一种自己的快捷键(已格式化,如日历的「D」),写进悬停提示;没有就在「下一种」那格提示 ⌥⌘V。 */
  hotkey?: string
  /** 使用指南现场圈注的锚点名(宿主 guideSpotlight.ts 的 GUIDE_ANCHORS 登记过的),挂到这一格的按钮上。 */
  guideAnchor?: string
}
export interface ViewModesSpec {
  modes: ViewModeOption[]
  value: string
  onChange(value: string): void
  /** 读屏名;缺省「看法」。 */
  ariaLabel?: string
}

/** 单列壳(手机 Web、Android App):视图自己不画胶囊,由 SingleColumnHost 的顶栏画。
 *  ⚠️ 不能只看 UI_MODE:Android App 不经 uiMode 选壳(MobileRoot 直接渲染 SingleColumnHost),那里 UI_MODE 恒为 'desktop';
 *  按 store 认 —— 只有单列 store 有 activeMainId。mini 卡片不算(见下)。 */
export function inSingleColumnShell(): boolean {
  if (IS_MINI_PANEL) return false // mini 卡片也用单列 store,但它没有手机顶栏:视图照旧自己画
  return UI_MODE === 'mobile' || 'activeMainId' in useWorkspace.getState()
}

// ── 登记表(leafId → 当前那份) ──
const specs = new Map<string, ViewModesSpec>()
const subs = new Set<() => void>()
const changed = (): void => { for (const f of subs) f() }
const subscribe = (cb: () => void): (() => void) => { subs.add(cb); return () => { subs.delete(cb) } }
const sigOf = (s: ViewModesSpec): string => `${s.value}\u0001${s.ariaLabel ?? ''}\u0001${s.modes.map((m) => `${m.value}\u0002${m.label}`).join('\u0001')}`

/** 视图登记自己的看法(spec = null 或 leafId 为空 = 这会儿没有,比如源码模式 / 不在面板里)。
 *  onChange 的身份每次渲染都变也没关系:登记的是一层转发,只有值 / 名字变了才通知订阅方。 */
export function useViewModes(leafId: string | null | undefined, spec: ViewModesSpec | null): void {
  const ref = useRef(spec)
  ref.current = spec
  const sig = spec ? sigOf(spec) : ''
  useLayoutEffect(() => {
    const s = ref.current
    if (!leafId || !s) return
    const entry: ViewModesSpec = { modes: s.modes, value: s.value, ariaLabel: s.ariaLabel, onChange: (v) => ref.current?.onChange(v) }
    specs.set(leafId, entry)
    changed()
    return () => { if (specs.get(leafId) === entry) { specs.delete(leafId); changed() } }
  }, [leafId, sig])
}

/** 读某个视图登记的那份(没有 = null)。 */
export function useViewModesOf(leafId: string | null | undefined): ViewModesSpec | null {
  return useSyncExternalStore(subscribe, () => (leafId ? specs.get(leafId) ?? null : null))
}
export function viewModesOf(leafId: string | null | undefined): ViewModesSpec | null {
  return leafId ? specs.get(leafId) ?? null : null
}

/** 快捷键 / 命令作用的那个视图:活动面板;焦点在侧栏(桌面)时退回主区当前那张。 */
export function viewModeTarget(): string | null {
  const ws = useWorkspace.getState()
  const a = ws.getActiveLeaf()?.id
  if (a && specs.has(a)) return a
  const api = (ws as { api?: unknown }).api
  const m = api ? activeMainPanel(api as Parameters<typeof activeMainPanel>[0])?.id : undefined
  return m && specs.has(m) ? m : null
}

/** 下一种(到头回第一种)。 */
export function nextViewMode(spec: Pick<ViewModesSpec, 'modes' | 'value'>): string | null {
  const n = spec.modes.length
  if (n < 2) return null
  const i = spec.modes.findIndex((m) => m.value === spec.value)
  return spec.modes[(i + 1) % n].value
}

export const VIEW_MODE_NEXT = 'view-mode-next'
const PICK_PREFIX = 'view-mode:'
let pickIds: string[] = []
let pickSig = ''

/** 命令面板每种一条「看法：X」,按活动视图生成:桌面在面板打开那一刻(面板没有「当前不可用」一说,不按那一刻生成就会列出别的视图的看法);
 *  手机在原生顶栏下(Web 顶栏没画,胶囊没地方放)跟着活动视图常驻,并进「⋯」的「看法」一节。
 *  ponytail: 钉进 Ribbon 的「看法：X」重启后要等第一次开面板才有真身;真有人钉再改成常驻。 */
function syncPickCommands(): void {
  const id = viewModeTarget()
  const spec = viewModesOf(id)
  const modes = spec && spec.modes.length > 1 ? spec.modes : []
  const inMore = inSingleColumnShell() && nativeChromeInstalled()
  const sig = `${id}\u0003${inMore}\u0003${spec ? sigOf(spec) : ''}`
  if (sig === pickSig) return // 同一份不重注册:原生「⋯」按呈现时的命令对象认点击(presentedCommand)
  pickSig = sig
  for (const old of pickIds) removeCommand(old)
  pickIds = modes.map((m) => PICK_PREFIX + m.value)
  for (const m of modes) {
    addCommand({
      id: PICK_PREFIX + m.value,
      title: engineTr('lcl.viewMode.pick', { label: m.label }),
      keywords: `view mode switch ${m.value} 看法 视图 切换`,
      ...(inMore ? { moreGroup: { id: 'lcl-view-mode', title: () => engineTr('lcl.viewMode.aria') }, checked: () => viewModesOf(viewModeTarget())?.value === m.value } : {}),
      run: () => { const t = viewModesOf(viewModeTarget()); if (t && t.value !== m.value && t.modes.some((x) => x.value === m.value)) t.onChange(m.value) },
    })
  }
}

/** 宿主装配期调一次(与其它内置命令一起)。 */
export function installViewModeCommands(): () => void {
  addCommand({
    id: VIEW_MODE_NEXT,
    title: () => engineTr('lcl.viewMode.next'),
    keywords: 'view mode next switch canvas 看法 视图 切换 画布',
    hotkey: 'mod+alt+v',
    run: () => {
      const spec = viewModesOf(viewModeTarget())
      const v = spec && nextViewMode(spec)
      if (spec && v) spec.onChange(v)
    },
  })
  const offs = [useCommandStore.subscribe((s, p) => { if (s.paletteOpen && !p.paletteOpen) syncPickCommands() })]
  if (inSingleColumnShell()) offs.push(subscribe(syncPickCommands), useWorkspace.subscribe(syncPickCommands))
  return () => { for (const f of offs) f(); removeCommand(VIEW_MODE_NEXT) }
}

// ── 胶囊 ──
/** compact:恒只留图标(每种都给了图标时),给本来就窄的地方(Agent Desk 胶囊)用。 */
type SwitchProps = { className?: string; testId?: string; compact?: boolean } & (
  | { leafId: string | null | undefined; spec?: undefined; inTopbar?: boolean }
  | { spec: ViewModesSpec; leafId?: undefined; inTopbar?: undefined }
)

/** 看法胶囊。给 `leafId` = 画那个视图登记的那份(手机上由顶栏画,视图里这颗返回 null);给 `spec` = 当普通零件用(插件零件、表单里)。 */
export function ViewModeSwitch(props: SwitchProps): React.ReactElement | null {
  const reg = useViewModesOf(props.leafId)
  const spec = props.spec ?? reg
  const { t } = useEngineI18n()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const dropRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: Event): void => { if (!menuRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node)) setMenu(null) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setMenu(null); dropRef.current?.focus() } }
    // 打开即把焦点放到当前那一项(键盘打开时方向键能直接选;菜单挂在 body 尾部,不这样 Tab 要先穿过整个视图)
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc) }
  }, [menu])
  if (!spec || spec.modes.length < 2) return null
  if (props.leafId !== undefined && !props.inTopbar && inSingleColumnShell()) return null
  const n = spec.modes.length
  const i = Math.max(0, spec.modes.findIndex((m) => m.value === spec.value))
  const cur = spec.modes[i]
  const nextI = (i + 1) % n
  const hk = props.leafId !== undefined ? commandHotkeyText(VIEW_MODE_NEXT) : ''
  const tip = (k: number): string => {
    const m = spec.modes[k]
    const key = m.hotkey || (k === nextI ? hk : '')
    return key ? t('lcl.withHotkey', { label: m.label, key }) : m.label
  }
  const pick = (v: string): void => {
    if (v === spec.value) return
    // 点了哪个视图的胶囊,哪个视图就是 ⌥⌘V / 命令面板的落点(按钮不抢焦点,不显式激活的话落点还停在上一个视图)
    if (props.leafId && useWorkspace.getState().getActiveLeaf()?.id !== props.leafId) useWorkspace.getState().activateLeaf(props.leafId)
    spec.onChange(v)
  }
  /** 下拉里的方向键 / Home / End 在几项之间走;Tab 关掉菜单、焦点回触发钮。 */
  const menuKeys = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (n: number): void => { e.preventDefault(); items[(n + items.length) % items.length]?.focus() }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Tab') { e.preventDefault(); setMenu(null); dropRef.current?.focus() }
  }
  const aria = spec.ariaLabel || t('lcl.viewMode.aria')
  return (
    <div
      className={`lcl-vmode${props.className ? ` ${props.className}` : ''}`}
      data-n={n}
      data-icons={spec.modes.every((m) => m.icon) ? '' : undefined}
      data-compact={props.compact ? '' : undefined}
      data-testid={props.testId}
      style={{ ['--seg-n' as string]: n, ['--seg-i' as string]: i }}
    >
      <div className="lcl-vmode-pill" role="tablist" aria-label={aria}>
        <div className="lcl-vmode-thumb" data-value={cur.value} />
        {spec.modes.map((m, k) => {
          const Icon = m.icon
          return (
            <button key={m.value} type="button" role="tab" aria-selected={k === i} aria-label={m.label} title={tip(k)} className={k === i ? 'on' : ''} data-guide-anchor={m.guideAnchor}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m.value)}>
              {Icon ? <Icon size={14} className="lcl-vmode-ic" /> : null}
              <span className="lcl-vmode-tx">{m.label}</span>
            </button>
          )
        })}
      </div>
      <button ref={dropRef} type="button" className="lcl-vmode-drop" aria-haspopup="menu" aria-expanded={!!menu} aria-label={aria}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { const r = dropRef.current?.getBoundingClientRect(); setMenu(menu || !r ? null : { x: r.left, y: r.bottom + 4 }) }}>
        <span className="lcl-vmode-tx">{cur.label}</span>
        <ChevronDown size={12} />
      </button>
      {menu && createPortal(
        <OverlayAt className="ctx-menu lcl-vmode-menu" x={menu.x} y={menu.y} innerRef={(el) => { menuRef.current = el }} role="menu" onKeyDown={menuKeys}>
          {spec.modes.map((m, k) => {
            const Icon = m.icon
            return (
              <button key={m.value} type="button" role="menuitemradio" aria-checked={k === i} onClick={() => { setMenu(null); dropRef.current?.focus(); pick(m.value) }}>
                {Icon ? <Icon size={13} /> : null}
                <span>{m.label}</span>
                {k === i ? <Check size={13} className="lcl-vmode-check" /> : null}
              </button>
            )
          })}
        </OverlayAt>,
        document.body,
      )}
    </div>
  )
}

/** 视图头行(32px,在纸里、不随正文滚):左端是登记的看法胶囊,右边放视图自己的按钮。两样都没有就不占位。
 *  已经有自己顶栏的视图(Amadeus `.amx-toolbar`、日历 `.amx-cal-bar`)不用它,直接在顶栏最左放 `<ViewModeSwitch leafId>`,
 *  并给顶栏加 `container: lcl-viewhead / inline-size`,窄时的退化才认得那一行的宽度。 */
export function ViewHead({ leafId, children, className, testId }: { leafId: string | null | undefined; children?: ReactNode; className?: string; testId?: string }): React.ReactElement | null {
  const spec = useViewModesOf(leafId)
  const showSwitch = !!spec && spec.modes.length > 1 && !inSingleColumnShell()
  if (!showSwitch && !children) return null
  return (
    <div className={`lcl-viewhead${className ? ` ${className}` : ''}`}>
      {showSwitch ? <ViewModeSwitch leafId={leafId} testId={testId} /> : null}
      <div className="lcl-viewhead-actions">{children}</div>
    </div>
  )
}
