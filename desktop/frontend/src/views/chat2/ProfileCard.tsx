/**
 * Chat 头像资料卡(方案 B,docs/ToBeImproved/聊天头像资料卡方案_2026-11-27):点消息的头像 / 名字条,卡贴着它弹出。
 * - 桌面 / 网页:portal + OverlayAt(只夹不翻,同日历事件卡)+ openPanel(液滴 / 拉伸 / 淡入随动效主题,同左下角账号面板);
 *   点别处 / Esc / 失焦 / 对话滚动 = 倒放缩回。
 * - 手机(触屏窄屏):贴底抽屉,同改动回执那张(ChangeReceipt 的 ct-sheet)。
 * 卡只是摘要 + 入口:每一行都摘自现成字段(profileCard.ts),动作都走现成命令(私聊 openSolo、资料 openAgentProfile、
 * 账号 = 现有账号面板);只有「记忆几条」「画像第一句」「额度」在打开时现取一次。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { OverlayAt, createTextAnchor, openPanel, type Droplet } from '@lcl/engine'
import { AtSign, Copy, CirclePause, CirclePlay, Ellipsis, ImageUp, MessageCircle, SlidersHorizontal, SquareUser, UserRound } from 'lucide-react'
import type { NormalAgentDef } from '../../types'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { agentName } from '../../agentName'
import { AgentAvatar } from '../../components/AgentAvatar'
import { TierBadge } from '../../components/TierBadge'
import { agentDescription } from '../../components/builtinAgentDescriptions'
import { focusTarget, homeTarget, useEngineFocus } from '../../services/engine/targets'
import { fetchAgentAvatar, getAgentMemorySnapshot, saveAgentDef, uploadAgentAvatar } from '../../services/backendService'
import { getHumanDocument } from '../../services/humanCollaboration'
import { formatRemaining, remainingPercent, type AccountQuotaView } from '../../services/accountQuota'
import { currentPlatform } from '../../services/platform'
import { openSolo } from '../../sessionNav'
import { openAgentProfile, openHumanProfile } from '../agentProfileNav'
import { useMeIdentity } from '../HumanProfile'
import { agentChip, agentRows, busyCount, canToggleDisabled, portraitLine, type ProfileSubject } from './profileCardModel'
import './profileCard.css'

registerMessages({
  'pc.row.about': { zh: '简介', en: 'About' },
  'pc.row.model': { zh: '模型', en: 'Model' },
  'pc.row.skills': { zh: '技能', en: 'Skills' },
  'pc.row.memory': { zh: '记忆', en: 'Memory' },
  'pc.row.source': { zh: '来源', en: 'Source' },
  'pc.row.quota': { zh: '额度', en: 'Quota' },
  'pc.row.portrait': { zh: '画像', en: 'Portrait' },
  'pc.model.thinking': { zh: '思考 {level}', en: 'Thinking {level}' },
  'pc.model.follow': { zh: '跟随会话', en: 'Follows the session' },
  'pc.model.engine': { zh: '由 {engine} 跑', en: 'Runs on {engine}' },
  'pc.skills.none': { zh: '没开技能', en: 'None' },
  'pc.skills.default': { zh: '跟随默认', en: 'Default set' },
  'pc.skills.more': { zh: '{names} 等 {n} 个', en: '{names} +{n} in all' },
  'pc.listSep': { zh: '、', en: ', ' },
  'pc.memory.shared': { zh: '共用默认 Agent 的', en: 'Shared with the default agent' },
  'pc.memory.own': { zh: '专属 · {n} 条', en: 'Own · {n}' },
  'pc.memory.ownPlain': { zh: '专属', en: 'Own' },
  'pc.source.local': { zh: '本机', en: 'This device' },
  'pc.source.cloud': { zh: '云端', en: 'Cloud' },
  'pc.source.sync': { zh: '云同步开', en: 'Cloud sync on' },
  'pc.source.standIn': { zh: '{name} 的分身', en: 'Stand-in for {name}' },
  'pc.source.byAgent': { zh: 'Agent 创建', en: 'Made by an agent' },
  'pc.source.temp': { zh: '本会话临时成员', en: 'Temporary member of this chat' },
  'pc.source.engine': { zh: '外部 Agent 引擎', en: 'External agent engine' },
  'pc.chip.default': { zh: '默认', en: 'Default' },
  'pc.chip.system': { zh: '后台', en: 'Background' },
  'pc.chip.standIn': { zh: '分身', en: 'Stand-in' },
  'pc.chip.disabled': { zh: '已停用', en: 'Turned off' },
  'pc.chip.temp': { zh: '临时', en: 'Temporary' },
  'pc.chip.engine': { zh: '引擎', en: 'Engine' },
  'pc.state.idle': { zh: '空闲', en: 'Idle' },
  'pc.state.busy': { zh: '在忙 · {n} 个会话', en: 'Busy · {n} chats' },
  'pc.deleted': { zh: '这个 Agent 已删除', en: 'This agent was deleted' },
  'pc.unknown': { zh: '认不出是哪个 Agent', en: 'Not a saved agent' },
  'pc.rosterUnread': { zh: '现在读不到 Agent 名册，稍后再看', en: "Can't read the agent list right now. Try again later" },
  'pc.remote': { zh: '这是另一台设备上的 Agent，到那台设备上管理', en: 'This agent lives on another device. Manage it there' },
  'pc.act.atBlocked': { zh: '输入框现在不能输入', en: "The message box can't take input right now" },
  'pc.act.dm': { zh: '私聊', en: 'Message' },
  'pc.act.dmCloud': { zh: '云端 Agent 没有本机文件夹，不能私聊', en: 'Cloud agents have no folder on this device, so no direct chat' },
  'pc.act.at': { zh: '@ 它', en: 'Mention' },
  'pc.act.profile': { zh: '资料', en: 'Profile' },
  'pc.act.aboutMe': { zh: '关于我', en: 'About me' },
  'pc.act.account': { zh: '账号', en: 'Account' },
  'pc.more': { zh: '更多', en: 'More' },
  'pc.menu.edit': { zh: '编辑设定…', en: 'Edit setup…' },
  'pc.menu.avatar': { zh: '换头像…', en: 'Change avatar…' },
  'pc.menu.copy': { zh: '复制 @{slug}', en: 'Copy @{slug}' },
  'pc.menu.disable': { zh: '停用', en: 'Turn off' },
  'pc.menu.enable': { zh: '重新启用', en: 'Turn back on' },
  'pc.copied': { zh: '已复制', en: 'Copied' },
  'pc.avatarTooLarge': { zh: '头像不能超过 1 MB', en: 'The avatar must be 1 MB or smaller' },
  'pc.me.you': { zh: '你', en: 'You' },
  'pc.me.signedIn': { zh: '你 · 已登录', en: 'You · signed in' },
  'pc.me.signedOut': { zh: '未登录', en: 'Not signed in' },
  'pc.me.noPortrait': { zh: '还没写', en: 'Not written yet' },
  'pc.quota.today': { zh: '今日 {pct}', en: 'Today {pct}' },
  'pc.quota.week': { zh: '本周 {pct}', en: 'This week {pct}' },
  'pc.quota.unlimited': { zh: '不限', en: 'Unlimited' },
  'pc.loading': { zh: '…', en: '…' },
  'pc.label': { zh: '{name} 的资料', en: "{name}'s profile" },
})

const PHONE_MQ = '(hover: none) and (pointer: coarse)'
/** 同 ChangeReceipt:手机外壳,或触屏窄屏(网页在手机浏览器里)。 */
const phoneSheet = (): boolean => currentPlatform() === 'mobile' || (typeof matchMedia !== 'undefined' && matchMedia(PHONE_MQ).matches && window.innerWidth < 600)

export interface ProfileCardOpen {
  subject: ProfileSubject
  /** 点的那个元素(头像或名字条):卡贴着它开,液滴从它里面流出。 */
  anchor: HTMLElement
  from: 'avatar' | 'name'
}

export function ProfileCard({ open, onClose, onMention }: {
  open: ProfileCardOpen
  onClose: () => void
  /** 往这个对话的输入框插 @(缺省 = 这里不能 @ 它,不出按钮)。返回输入框收没收(禁用 / 录音中会拒)。 */
  onMention?: (slug: string) => boolean
}): React.ReactElement {
  const { t } = useI18n()
  const sheet = useRef(phoneSheet()).current
  const popRef = useRef<HTMLDivElement | null>(null)
  const drop = useRef<Droplet | null>(null)
  const closing = useRef(false)
  // 关:有液滴就倒放,放完再卸;动作(私聊、去资料页)要立刻发生,先发动作再关,不等动画
  const dismiss = (): void => {
    const d = drop.current
    if (!d) { onClose(); return }
    if (closing.current) return
    closing.current = true
    void d.retract().then(() => { if (drop.current === d) onClose() })
  }
  // 动作:返回 false = 没办成(如输入框拒收 @),卡留着
  const act = (fn: () => void | boolean) => () => { if (fn() !== false) dismiss() }
  const dismissRef = useRef(dismiss); dismissRef.current = dismiss

  useLayoutEffect(() => {
    const el = popRef.current
    if (!el) return
    // 键盘能接着操作:焦点进卡(role=dialog);Esc 收卡时还给入口
    el.focus({ preventScroll: true })
    if (sheet) return
    const src = open.anchor.isConnected ? open.anchor : null
    if (src) drop.current = openPanel(src, el)
    return () => { drop.current?.cancel(); drop.current = null; closing.current = false }
  }, [open.anchor, sheet])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target instanceof Node ? e.target : null
      if (target && (popRef.current?.contains(target) || open.anchor.contains(target))) return // 再点头像:ChatView 那一下自己收
      dismissRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      const inside = !!popRef.current?.contains(document.activeElement)
      dismissRef.current()
      if (inside && open.anchor.isConnected) open.anchor.focus({ preventScroll: true })
    }
    const onBlur = (): void => dismissRef.current()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open.anchor, sheet])

  // 卡跟着头像走(LCL 表面规范 · 划线菜单方案 B:锚在东西上的浮层跟滚动,不一滚就收):对话滚动 / 流式输出自动滚到底时卡一起挪,
  // 头像滚出可见区卡就淡出(data-anchor-hidden),那条消息没了才收。头像那种:量出「头像右边(你自己:左边)8px、顶边上 4px」那条竖线,
  // gap 取负的头像高 —— useClampedMenu 的 y = 锚点底 + gap,正好落在头像顶边上 4px。
  const follow = useMemo(() => {
    if (sheet) return null
    const a = open.anchor
    // owner 取整条对话(不是那一行):整条消息被重绘 / 移除时 owner 还在,测量才走得到 'lost' 把卡收掉;
    // 拿消息行当 owner 时行一摘 read() 就早早返回 null,卡永远透明地挂着。
    const owner = a.closest<HTMLElement>('.t2-stream') || a.closest<HTMLElement>('.t2-asst, .t2-userwrap') || a
    const right = open.subject.kind === 'user'
    return createTextAnchor(owner, () => {
      if (!a.isConnected) return 'lost'
      const r = a.getBoundingClientRect()
      if (!r.width || !r.height) return null
      if (open.from === 'name') return { rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, clipEl: a }
      const x = right ? r.left - 8 : r.right + 8
      // 裁剪按消息那一行算,不按头像:makeClipper 连元素自己的 overflow 也算,.t2-avatar 是 overflow:hidden(圆图),
      // 拿它当 clipEl 时头像旁边那条竖线永远在框外 → 卡一出生就 data-anchor-hidden(透明、不吃指针)。
      return { rect: { left: right ? x - 1 : x, right: right ? x : x + 1, top: r.top - 4, bottom: r.bottom }, clipEl: a.parentElement ?? a }
    }, { onLost: () => dismissRef.current() })
  }, [open.anchor, open.from, open.subject.kind, sheet])
  useEffect(() => () => follow?.dispose(), [follow])
  const gap = useMemo(() => (open.from === 'name' ? 6 : -(open.anchor.getBoundingClientRect().height + 4)), [open.anchor, open.from])

  const body = open.subject.kind === 'user'
    ? <MeBody anchor={open.anchor} act={act} />
    : <AgentBody subject={open.subject} act={act} onMention={onMention} />

  if (sheet) {
    return createPortal(
      <div className="pc-sheet-scrim" onClick={dismiss}>
        <div className="pc-card pc-card--sheet" role="dialog" aria-modal="true" tabIndex={-1} aria-label={t('pc.label', { name: subjectName(open.subject, t) })} onClick={(e) => e.stopPropagation()} ref={popRef}>
          <div className="pc-grip" />
          {body}
        </div>
      </div>,
      document.body,
    )
  }
  // 贴着点的那个东西开:头像在左(助手)往右开、在右(你自己)往左开 —— 只夹不翻(卡在头像旁边,往上挪也盖不住头像);
  // 名字条往下开,下面放不下就翻到名字条上面(走查:只夹会把卡推上来盖住刚点的名字条)。
  // x / y 只是第一帧(锚点量不出来时)的兜底,之后都按 follow 现量。
  const r = open.anchor.getBoundingClientRect()
  const right = open.subject.kind === 'user'
  return createPortal(
    <OverlayAt className="pc-card" role="dialog" aria-label={t('pc.label', { name: subjectName(open.subject, t) })} x={right ? r.left - 8 : r.right + 8} y={r.top - 4}
      anchor={follow} gap={gap} flip={open.from === 'name'} alignEnd={right} margin={8}
      innerRef={(el) => { popRef.current = el; if (el) el.tabIndex = -1 }}>
      {body}
    </OverlayAt>,
    document.body,
  )
}

type T = ReturnType<typeof useI18n>['t']
type Act = (fn: () => void | boolean) => () => void
type Mention = (slug: string) => boolean
/** 「@ 它」:输入框拒收就留着卡、说一声,不装作办成了。 */
const mentionRun = (onMention: Mention, slug: string, t: T) => (): boolean => {
  if (onMention(slug)) return true
  useApp.getState().toast(t('pc.act.atBlocked'), true)
  return false
}

function subjectName(s: ProfileSubject, t: T): string {
  if (s.kind === 'user') return t('pc.me.you')
  if (s.kind === 'agent') return agentName(useApp.getState().agentDefs.find((a) => a.slug === s.slug)) || s.slug
  if (s.kind === 'temp') return agentName(s.def) || s.def.slug
  return s.name
}

function Hero({ url, name, siblings, chip, handle, state, more, big = true }: { url?: string; name: string; siblings?: string[]; chip?: React.ReactNode; handle?: React.ReactNode; state?: React.ReactNode; more?: React.ReactNode; big?: boolean }) {
  return <div className="pc-hero">
    <span className={`pc-portrait${big ? '' : ' pc-portrait--sm'}`}><AgentAvatar name={name} url={url} siblings={siblings} fill /></span>
    <div className="pc-id">
      <div className="pc-name"><span className="pc-name-tx">{name}</span>{chip}</div>
      {handle && <div className="pc-handle">{handle}</div>}
      {state}
    </div>
    {more}
  </div>
}

const Chip = ({ children }: { children: React.ReactNode }) => <span className="pc-chip">{children}</span>

function Rows({ rows }: { rows: Array<{ label: string; value: React.ReactNode; key: string }> }) {
  if (!rows.length) return null
  return <dl className="pc-rows">{rows.map((r) => <div className="pc-row" key={r.key} data-row={r.key}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
}

function Acts({ items }: { items: Array<{ id: string; icon: React.ReactNode; label: string; run?: () => void; disabled?: boolean; title?: string }> }) {
  if (!items.length) return null
  return <div className="pc-acts" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
    {items.map((it) => <button key={it.id} type="button" data-act={it.id} disabled={it.disabled} title={it.title} onClick={it.run}>{it.icon}<span>{it.label}</span></button>)}
  </div>
}

function AgentBody({ subject, act, onMention }: { subject: Exclude<ProfileSubject, { kind: 'user' }>; act: Act; onMention?: Mention }) {
  const { t } = useI18n()
  const defs = useApp((s) => s.agentDefs)
  const avatars = useApp((s) => s.agentAvatars)
  const names = defs.map((a) => agentName(a))
  if (subject.kind === 'agent') {
    const def = defs.find((a) => a.slug === subject.slug)
    // 名册整份是空的 = 没读到(至少有个默认 Agent),不能说成「已删除」(读失败 ≠ 没有)
    if (!def) return <><Hero name={subject.slug} siblings={names} handle={`@${subject.slug}`} /><p className="pc-note">{t(defs.length ? 'pc.deleted' : 'pc.rosterUnread')}</p></>
    return <SavedAgent def={def} url={avatars[def.slug]} siblings={names} act={act} onMention={onMention} />
  }
  if (subject.kind === 'temp') {
    const def = subject.def
    const name = agentName(def) || def.slug
    const about = agentDescription({ slug: def.slug, description: def.description || '' }, t).trim()
    return <>
      <Hero name={name} siblings={names} chip={<Chip>{t('pc.chip.temp')}</Chip>} handle={`@${def.slug}`} />
      <Rows rows={[...(about ? [{ key: 'about', label: t('pc.row.about'), value: about }] : []), { key: 'source', label: t('pc.row.source'), value: t('pc.source.temp') }]} />
      <Acts items={onMention ? [{ id: 'at', icon: <AtSign size={18} />, label: t('pc.act.at'), run: act(mentionRun(onMention, def.slug, t)) }] : []} />
    </>
  }
  if (subject.kind === 'engine') {
    return <>
      <Hero name={subject.name} siblings={names} chip={<Chip>{t('pc.chip.engine')}</Chip>} />
      <Rows rows={[{ key: 'source', label: t('pc.row.source'), value: t('pc.source.engine') }]} />
      <Acts items={[{ id: 'dm', icon: <MessageCircle size={18} />, label: t('pc.act.dm'), run: act(() => openSolo('engine', subject.id)) }]} />
    </>
  }
  return <><Hero name={subject.name} siblings={names} /><p className="pc-note">{t('pc.unknown')}</p></>
}

function SavedAgent({ def, url, siblings, act, onMention }: { def: NormalAgentDef; url?: string; siblings: string[]; act: Act; onMention?: Mention }) {
  const { t } = useI18n()
  // 焦点在别的 Unit 上时名册是那台的(refreshAgents 随焦点),而停用 / 换头像 / 资料页 / 私聊都落本机 ——
  // 同名 Agent 会被改错台:这时卡只读,只留 @ 它和复制
  const remote = useEngineFocus((s) => s.ref.kind !== 'home')
  const defaultSlug = useApp((s) => s.defaultAgentSlug)
  const busy = useApp((s) => busyCount(def.slug, s.sessions, s.runningBySession))
  const models = useApp((s) => s.modelsResp?.models)
  const skills = useApp((s) => s.skillsList)
  const owner = useApp((s) => (def.standInOf ? s.agentDefs.find((a) => a.slug === def.standInOf) : undefined))
  // 记忆条数:打开时现取一次;取不到就只写「专属」(不写 0,读失败 ≠ 没有)
  const [memory, setMemory] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    if (def.shareDefaultMemory && def.slug !== defaultSlug) return
    let alive = true
    getAgentMemorySnapshot(focusTarget(), def.slug).then((m) => { if (alive) setMemory(Array.isArray(m?.entries) ? m.entries.length : null) }, () => { if (alive) setMemory(null) })
    return () => { alive = false }
  }, [def.slug, def.shareDefaultMemory, defaultSlug, remote])
  const [menu, setMenu] = useState(false)
  const name = agentName(def) || def.slug
  const chip = agentChip(def, defaultSlug)
  const rows = agentRows(def, {
    defaultSlug,
    memory,
    ownerName: owner ? agentName(owner) : undefined,
    modelName: (id) => models?.find((m) => m.id === id)?.name,
    skillName: (id) => skills?.find((s: { id?: string; name?: string }) => s.id === id)?.name,
  }, t)
  // 停用时卡头已有「已停用」标签,状态行不再重复一遍
  const state = def.disabled ? null : <span className={`pc-state${busy ? ' working' : ''}`}><i />{busy ? t('pc.state.busy', { n: busy }) : t('pc.state.idle')}</span>
  const toast = (msg: string, err = false): void => useApp.getState().toast(msg, err)
  const toggleOff = async (): Promise<void> => {
    try {
      const saved = await saveAgentDef(homeTarget(), { disabled: !def.disabled }, def.slug)
      if (!homeFocused()) return // 等回包时焦点切去了别的 Unit:那份名册不是这台的,别往里写
      useApp.setState((s) => ({ agentDefs: s.agentDefs.map((a) => (a.slug === def.slug ? { ...a, disabled: !!saved.disabled } : a)) }))
      window.dispatchEvent(new Event('forsion:agents-changed')); window.tangu?.requestMainAction?.('agents-changed') // 同 Agents 页的停用开关
    } catch (e: any) { toast(String(e?.message || e), true) }
  }
  const more = <span className="pc-more-wrap">
    <button type="button" className={`pc-more${menu ? ' on' : ''}`} title={t('pc.more')} aria-label={t('pc.more')} aria-expanded={menu} onClick={() => setMenu((v) => !v)}><Ellipsis size={16} /></button>
    {menu && <div className="pc-menu" role="menu">
      {!remote && <button type="button" role="menuitem" onClick={act(() => openAgentProfile(def.slug))}><SlidersHorizontal size={15} /><span>{t('pc.menu.edit')}</span></button>}
      {!remote && def.libraryDir && <button type="button" role="menuitem" onClick={act(() => chooseAvatar(def.slug, t))}><ImageUp size={15} /><span>{t('pc.menu.avatar')}</span></button>}
      <button type="button" role="menuitem" onClick={() => { setMenu(false); void navigator.clipboard?.writeText(`@${def.slug}`).then(() => toast(t('pc.copied')), () => {}) }}><Copy size={15} /><span>{t('pc.menu.copy', { slug: def.slug })}</span></button>
      {!remote && canToggleDisabled(def, defaultSlug) && <button type="button" role="menuitem" onClick={() => { setMenu(false); void toggleOff() }}>{def.disabled ? <CirclePlay size={15} /> : <CirclePause size={15} />}<span>{t(def.disabled ? 'pc.menu.enable' : 'pc.menu.disable')}</span></button>}
    </div>}
  </span>
  const canDm = !!def.libraryDir && !def.disabled
  const items = [
    ...(def.disabled || remote ? [] : [{ id: 'dm', icon: <MessageCircle size={18} />, label: t('pc.act.dm'), disabled: !canDm, title: canDm ? undefined : t('pc.act.dmCloud'), run: act(() => openSolo('agent', def.slug)) }]),
    ...(onMention && !def.disabled ? [{ id: 'at', icon: <AtSign size={18} />, label: t('pc.act.at'), run: act(mentionRun(onMention, def.slug, t)) }] : []),
    ...(remote ? [] : [{ id: 'profile', icon: <SquareUser size={18} />, label: t('pc.act.profile'), run: act(() => openAgentProfile(def.slug)) }]),
  ]
  return <>
    <Hero url={url} name={name} siblings={siblings} chip={chip ? <Chip>{t(`pc.chip.${chip}`)}</Chip> : null} handle={`@${def.slug}`} state={state} more={more} />
    <Rows rows={rows.map((r) => ({ key: r.key, label: t(`pc.row.${r.key}`), value: r.value }))} />
    {remote && <p className="pc-note">{t('pc.remote')}</p>}
    <Acts items={items} />
  </>
}

const homeFocused = (): boolean => useEngineFocus.getState().ref.kind === 'home'

/** 换头像:系统选文件框会让窗口失焦、卡随之收起,所以选择框挂在卡外(临时 input),选完照 Agents 页同一条上传路径换掉。 */
function chooseAvatar(slug: string, t: T): void {
  const toast = (msg: string, err = false): void => useApp.getState().toast(msg, err)
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/gif,image/webp'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    if (file.size > 1_048_576) { toast(t('pc.avatarTooLarge'), true); return }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file) })
      const saved = await uploadAgentAvatar(homeTarget(), slug, dataUrl, file.type)
      // 回读失败(超时 / 非 2xx 都折成 null)不等于没头像:上传已经成了,就拿刚选的文件当预览,不把头像清回首字母
      const next = (await fetchAgentAvatar(homeTarget(), slug).catch(() => null)) || URL.createObjectURL(file)
      if (!homeFocused()) { URL.revokeObjectURL(next); return } // 焦点已切去别的 Unit:那份名册不是这台的
      useApp.setState((s) => {
        const prev = s.agentAvatars[slug]
        if (prev && prev !== next) { try { URL.revokeObjectURL(prev) } catch { /* ignore */ } }
        return { agentAvatars: { ...s.agentAvatars, [slug]: next }, agentDefs: s.agentDefs.map((a) => (a.slug === slug ? { ...a, avatar: saved.avatar } : a)) }
      })
    } catch (e: any) { toast(String(e?.message || e), true) }
  }
  input.click()
}

function MeBody({ anchor, act }: { anchor: HTMLElement; act: Act }) {
  const { t } = useI18n()
  const me = useMeIdentity()
  const auth = useApp((s) => s.authInfo)
  const loggedIn = !!auth?.loggedIn
  // 名字跟消息里那枚头像同一个来源(ChatView 的 userName):没登录时消息写「你」,卡头也写「你」,不写「关于我」页的「我」
  const shownName = auth?.nickname || auth?.username || t('pc.me.you')
  // 画像第一句(human/SOUL.md 常驻段)与额度:打开时各取一次;取不到就不出那一行
  const [portrait, setPortrait] = useState<string | null | undefined>(undefined)
  const [quota, setQuota] = useState<AccountQuotaView | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    getHumanDocument(homeTarget(), { kind: 'human', file: 'SOUL.md' }).then((d) => { if (alive) setPortrait(d?.exists ? portraitLine(d.content || '') : '') }, () => { if (alive) setPortrait(null) })
    if (loggedIn && window.tangu?.accountQuota) {
      void window.tangu.accountQuota().then((r) => { if (alive) setQuota(r?.status === 200 && r.json ? r.json as AccountQuotaView : null) }, () => { if (alive) setQuota(null) })
    } else setQuota(null)
    return () => { alive = false }
  }, [loggedIn])
  const quotaText = (q: AccountQuotaView): string => {
    const parts = ([['pc.quota.today', remainingPercent(q.dailyLimit, q.dailyRemaining, q.dailyPercent)], ['pc.quota.week', remainingPercent(q.weeklyLimit, q.weeklyRemaining, q.weeklyPercent)]] as const)
      .filter(([, pct]) => pct !== null).map(([key, pct]) => t(key, { pct: formatRemaining(pct, '') }))
    return parts.length ? parts.join(' · ') : t('pc.quota.unlimited')
  }
  const rows: Array<{ key: string; label: string; value: React.ReactNode }> = []
  if (quota) rows.push({ key: 'quota', label: t('pc.row.quota'), value: quotaText(quota) })
  else if (quota === undefined && loggedIn) rows.push({ key: 'quota', label: t('pc.row.quota'), value: <span className="pc-faint">{t('pc.loading')}</span> })
  if (portrait !== null) rows.push({ key: 'portrait', label: t('pc.row.portrait'), value: portrait === undefined ? <span className="pc-faint">{t('pc.loading')}</span> : portrait || <span className="pc-faint">{t('pc.me.noPortrait')}</span> })
  const items = [
    { id: 'about-me', icon: <UserRound size={18} />, label: t('pc.act.aboutMe'), run: act(() => openHumanProfile()) },
    // 账号 = 现有账号面板(额度详情、背包、升级、切号都在那),从这枚头像里开出来。Tangu 不直引宿主的 accountChip
    // (tangu-boundary),发 window 事件给 AccountCard(同名事件在 components/AccountCard.tsx 接);没人接 = 开账号中心
    { id: 'account', icon: <SquareUser size={18} />, label: t('pc.act.account'), run: act(() => {
      const el = anchor
      requestAnimationFrame(() => {
        const ev = new CustomEvent('forsion:account-activate', { cancelable: true, detail: { anchor: el.isConnected ? el : undefined } })
        if (window.dispatchEvent(ev)) void window.tangu?.openAccountCenter?.()
      })
    }) },
  ]
  return <>
    <Hero url={me.avatar} name={shownName} chip={loggedIn ? <TierBadge tier={auth?.membershipTier} /> : null} handle={t(loggedIn ? 'pc.me.signedIn' : 'pc.me.signedOut')} />
    <Rows rows={rows} />
    <Acts items={items} />
  </>
}
