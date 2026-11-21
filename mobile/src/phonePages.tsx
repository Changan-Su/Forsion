/** 手机 Dock 五格里的「应用」「我」两整页(方向 E 第 1 步,2026-11-19;外壳那半在 lcl/engine/phoneDock.ts)。
 *  Android 原生外壳和手机浏览器的网页版是同一份(两种宿主都登记 `spaces: true`);平板 / 手机横过来时没有这两页(竖条照旧)。
 *  - 应用:第一排「常用」(最多四个,来历见 phoneDock.ts 的 frequentSpaceIds)→「全部」其余 Space → 商店和别的入口 →「选择常用」。
 *  - 我:账号(头部、额度、背包、邀请、升级;未登录是登录那一行)→ 设置、在哪运行、深色模式、命令面板 → 成就、活动、反馈 →
 *    已登录的账号与退出。账号那几节就是原来头像菜单那一份(AccountCard 经 accountChip.sections 交来),不另写一份。
 *  哪个入口进哪一页由 lcl moreSheet.ts 的 phonePageItems 定:点得了的每一项恰好在一页里出现一次。
 *  红点:Space 的点(收件箱未读…)画在格子上;入口的点画在那一行;Dock 上那一格的点由外壳合(dockBadges)。 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronRight, SlidersHorizontal, UserRound } from 'lucide-react'
import {
  FREQUENT_MAX, dispatchNativeChromeSpace, dockPicks, frequentSpaceIds, installPhonePages, label, moreRowLabel, objectContextMenuHandler,
  phoneAppsSpaceIds, phonePageItems, presentNativeChecklist, saveFrequent, storedFrequent, subscribeFrequent, useDotted, useRibbonStore, useSpaceStore,
  type RibbonItem, type SheetMenuItem, type SheetMenuSection,
} from '@lcl/engine'
import { registerMessages, useI18n } from '@/i18n'
import { accountChip, subscribeAccountChip } from '@/services/accountChip'
import { loadHomeCards } from '@/views/homeCards'
import { useApp } from '@/stores/appStore'
import { useAttention } from '@/stores/attentionStore'
import { useInbox } from '@/stores/inboxStore'
import { spaceBadges } from './nativeChrome'
import './phonePages.css'

registerMessages({
  'phonePages.frequent': { zh: '常用', en: 'Frequent' },
  'phonePages.all': { zh: '全部', en: 'All' },
  'phonePages.chooseFrequent': { zh: '选择常用', en: 'Choose frequent apps' },
  'phonePages.chooseFrequentTitle': { zh: '常用', en: 'Frequent apps' },
  'phonePages.chooseFrequentHint': { zh: '勾选的排在「应用」第一排，最多 {max} 个。', en: 'Checked ones lead the Apps page, up to {max}.' },
  'phonePages.done': { zh: '完成', en: 'Done' },
  'phonePages.marketDetail': { zh: '插件、主题、技能', en: 'Plugins, themes, skills' },
  'phonePages.accountLoading': { zh: '正在读取账号…', en: 'Loading your account…' },
  'phonePages.notSignedIn': { zh: '未登录', en: 'Not signed in' },
})

/** 两页都按「手机、有这两页」去分 ribbon 项(这两页只在那种形态下才画得出来)。 */
const PAGE_SEATS = { phone: true, allCell: false, pages: true }

const subscribeBadges = (fn: () => void): (() => void) => {
  const offs = [useApp.subscribe(fn), useAttention.subscribe(fn), useInbox.subscribe(fn)]
  return () => { offs.forEach((off) => off()) }
}
const badgeSnapshot = (): string => JSON.stringify(spaceBadges())
function useSpaceBadges(): ReturnType<typeof spaceBadges> {
  return JSON.parse(useSyncExternalStore(subscribeBadges, badgeSnapshot)) as ReturnType<typeof spaceBadges>
}

// ── 共用的行与格 ────────────────────────────────────────────────────────────────
function Row({ id, icon, title, detail, value, dot, danger, disabled, chevron = true, onClick }: {
  id: string; icon?: ReactNode; title: string; detail?: string; value?: string; dot?: string; danger?: boolean; disabled?: boolean; chevron?: boolean; onClick?: () => void
}) {
  return (
    <button type="button" className="pp-row" data-row={id} data-danger={danger ? '' : undefined} disabled={disabled || !onClick} onClick={onClick}>
      {icon != null && <span className="pp-row-icon" aria-hidden>{icon}</span>}
      <span className="pp-row-copy">
        <span className="pp-row-title">{title}</span>
        {detail && <small>{detail}</small>}
      </span>
      {value && <span className="pp-row-value">{value}</span>}
      {dot != null && <i className="pp-dot" role="img" aria-label={dot} />}
      {chevron && onClick && !disabled && <ChevronRight className="pp-row-chevron" size={18} aria-hidden />}
    </button>
  )
}
const ribbonRow = (it: RibbonItem, dotted: Set<string>, extra: { detail?: string } = {}): ReactNode => {
  const Icon = it.icon
  return <Row key={it.id} id={it.id} icon={Icon ? <Icon size={22} /> : null} title={it.tooltip ? moreRowLabel(label(it.tooltip)) : it.id} detail={extra.detail}
    dot={dotted.has(it.id) ? String(it.dot?.label?.() ?? '') : undefined} onClick={() => it.onClick?.()} />
}
function Section({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="pp-section">{title && <div className="pp-section-title">{title}</div>}{children}</section>
}

// ── 应用 ───────────────────────────────────────────────────────────────────────
function AppsPage() {
  const { t } = useI18n()
  const spaces = useSpaceStore((s) => s.spaces)
  const items = useRibbonStore((s) => s.items)
  const dotted = useDotted(items)
  const badges = useSpaceBadges()
  const [, setRev] = useState(0)
  useEffect(() => subscribeFrequent(() => setRev((n) => n + 1)), [])
  const candidates = phoneAppsSpaceIds(spaces.map((s) => s.id))
  const frequent = frequentSpaceIds(candidates, { stored: storedFrequent(), dockPicks: dockPicks(), homeCards: loadHomeCards() })
  const rest = candidates.filter((id) => !frequent.includes(id))
  const launchers = phonePageItems(items, PAGE_SEATS).apps
  const byId = new Map(spaces.map((s) => [s.id, s]))
  // 点一格 = 和点 Dock 一样走外壳(收起这一页再进那个 Space);长按 = 那个 Space 的对象菜单,和 Dock 上长按同一份
  const tile = (id: string): ReactNode => {
    const sp = byId.get(id)
    if (!sp) return null
    const Icon = sp.icon
    const badge = badges[id]
    return (
      <button key={id} type="button" className="pp-tile" data-space={id} onClick={() => dispatchNativeChromeSpace(id)}
        onContextMenu={objectContextMenuHandler(() => ({ refs: [{ type: 'space', id }], place: { kind: 'phone-tabbar' } }))}>
        <span className="pp-tile-icon">{Icon && <Icon size={26} />}{badge && <i className="pp-dot" data-kind={badge} role="img" aria-label={useApp.getState().tr(`nativebar.badge.${badge}`)} />}</span>
        <span className="pp-tile-name">{label(sp.name)}</span>
      </button>
    )
  }
  const choose = async (): Promise<void> => {
    const out = await presentNativeChecklist({
      title: t('phonePages.chooseFrequentTitle'),
      items: candidates.map((id) => byId.get(id)).filter((sp): sp is NonNullable<typeof sp> => !!sp)
        .map((sp) => ({ id: `pick:${sp.id}`, label: label(sp.name), icon: sp.icon?.imageUrl ? sp.icon.nativeFallback : sp.icon })),
      checked: frequent.map((id) => `pick:${id}`),
      footer: t('phonePages.chooseFrequentHint', { max: String(FREQUENT_MAX) }),
      done: t('phonePages.done'),
      max: FREQUENT_MAX,
    })
    if (out.handled && out.value) saveFrequent(out.value.checked.map((x) => x.slice('pick:'.length)), frequent)
  }
  return (
    <div className="pp-page" data-page="apps">
      {frequent.length > 0 && <Section title={t('phonePages.frequent')}><div className="pp-grid">{frequent.map(tile)}</div></Section>}
      {rest.length > 0 && <Section title={t('phonePages.all')}><div className="pp-grid">{rest.map(tile)}</div></Section>}
      <Section>
        {launchers.map((it) => ribbonRow(it, dotted, it.id === 'rb-market' ? { detail: t('phonePages.marketDetail') } : {}))}
        {candidates.length > 0 && <Row id="choose-frequent" icon={<SlidersHorizontal size={22} />} title={t('phonePages.chooseFrequent')} onClick={() => { void choose() }} />}
      </Section>
    </div>
  )
}

// ── 我 ─────────────────────────────────────────────────────────────────────────
const sheetRow = (it: SheetMenuItem): ReactNode => (
  <Row key={it.id} id={it.id} icon={it.icon ?? null} title={it.label} value={it.detail} danger={it.danger} disabled={it.disabled} onClick={it.run} chevron={!it.danger} />
)
function MePage() {
  const { t, locale } = useI18n()
  const chip = useSyncExternalStore(subscribeAccountChip, accountChip)
  const items = useRibbonStore((s) => s.items)
  const dotted = useDotted(items)
  const { me } = phonePageItems(items, PAGE_SEATS)
  const [sections, setSections] = useState<SheetMenuSection[] | null>(null)
  // 账号那几节:进这一页、登录态 / 账号 / 界面语言换了时现取一次(额度要问服务端,最多等 3 秒;取不到的那一行照实写)。
  // 文案是取的那一刻按当时语言写好的:从这一页开设置切了语言、关掉回来,得重取
  const chipKey = chip ? `${chip.loggedIn ? 1 : 0}:${chip.label}:${locale}` : ''
  useEffect(() => {
    let live = true
    setSections(null)
    void accountChip()?.sections?.().then((s) => { if (live && s) setSections(s) })
    return () => { live = false }
  }, [chipKey])
  const first = sections?.[0]?.items ?? []
  const head = first.find((it) => it.id === 'account')
  const accountRows = first.filter((it) => it !== head)
  const later = (sections ?? []).slice(1).filter((s) => s.items.length)
  const avatar = chip?.avatar ? <img src={chip.avatar} alt="" /> : chip?.loggedIn ? chip.initial : <UserRound size={26} />
  const headInner = (
    <>
      <span className="pp-me-avatar" aria-hidden>{avatar}</span>
      <span className="pp-me-name">
        <strong>{head?.label ?? (chip ? (chip.loggedIn ? chip.label : t('phonePages.notSignedIn')) : t('phonePages.notSignedIn'))}</strong>
        {head?.detail && <small>{head.detail}</small>}
      </span>
      {head?.run && <ChevronRight className="pp-row-chevron" size={18} aria-hidden />}
    </>
  )
  return (
    <div className="pp-page" data-page="me">
      {chip && (head?.run
        ? <button type="button" className="pp-me-head" data-row="account" onClick={head.run}>{headInner}</button>
        : <div className="pp-me-head">{headInner}</div>)}
      {chip && (
        <Section>
          {sections ? accountRows.map(sheetRow) : <Row id="account-loading" title={t('phonePages.accountLoading')} disabled chevron={false} />}
        </Section>
      )}
      {me.settings.length > 0 && <Section>{me.settings.map((it) => ribbonRow(it, dotted))}</Section>}
      {me.launchers.length > 0 && <Section>{me.launchers.map((it) => ribbonRow(it, dotted))}</Section>}
      {later.map((s, i) => <Section key={s.title ?? `s${i}`} title={s.title}>{s.items.map(sheetRow)}{s.footer && <div className="pp-note">{s.footer}</div>}</Section>)}
    </div>
  )
}

/** mobileEntry 调一次:外壳从此画五格 Dock,「应用」「我」两页由这里画。 */
export function installPhonePageViews(): void {
  installPhonePages((page) => (page === 'apps' ? <AppsPage /> : <MePage />))
}
