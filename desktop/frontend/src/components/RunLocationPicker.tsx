/**
 * 新对话的「在哪运行」药丸(P1-K7a;规格 K7 §3.6,缺省 K7 U1 / U2)。
 *
 * 只挂在空白新对话上:会话一旦建好,位置就定死了(S9)。药丸显示新会话会建在哪(= K6 焦点)与那台的状态。
 *  - 手机:名册里至少有一台电脑才出现(哪怕离线 —— 让用户知道为什么选不了);点开 = 宿主装的选择器
 *    (K8「在哪运行」弹层,含首次确认流程)。没有选择器的宿主 → 只读。
 *  - 桌面主窗口(2026-10-14):恒出现,缺省写「这台电脑」;点开 = 自带的下拉(与项目药丸同一套 `.composer-menu.project-menu`
 *    语汇:方向键 / Home / End、Esc、视口夹取),列「这台电脑 / 我的其他电脑 / 管理设备」。选一台别的电脑走与手机同一条流程
 *    (services/runOnDevice.ts 的 runOn:问那台认不认 → 需要就请它弹确认并轮询 → 探引擎 → 生效)。
 *  - 网页版、设备页:不渲染(设备页 §4.7 b6:不得经 A 的隧道再驱动 B)。
 * 两端生效都走 setDraftLocation(loc, {explicit:true})(R-21)。
 * 视觉语汇整段派生项目药丸(.composer-chip.project-pill,同一门「无轮廓中性 pill」)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cloud, Laptop, LogIn, Monitor, Server, Settings2 } from 'lucide-react'
import { useEdgeNudge } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { engineFetch, homeKind, nameOfRef, remoteAccessFetch, targetForRef, useEngineFocus, useRemoteCapability } from '../services/engine/targets'
import { currentPlatform } from '../services/platform'
import { formatRunLocation, HOME } from '../services/runLocation'
import { beginDeviceAttempt, endDeviceAttempts, noteDeviceAttempt, useDeviceMarks } from '../services/deviceMarks'
import { capsSaysReady, isTrustReason, type DeviceStatus, type RefusalDetail, type TrustReason } from '../services/deviceStatus'
import { runOn, type PhoneIssue } from '../services/runOnDevice'
import { rosterAvailable, runLocationsAvailable } from '../features/runtime'
import { useApp } from '../stores/appStore'
import { statusOfUnit, unitById, useDeviceSessions } from '../stores/deviceSessionsStore'
import { setDraftLocation, useRunLocation } from '../stores/runLocationStore'
import { clampText, deviceStatusText, useDeviceSessionsLive } from '@tangu/ui/views/chat2/DeviceSessionSections'
import type { UnitInfo } from '../types'
import './runLocationPicker.css'

registerMessages({
  'runloc.label': { zh: '运行位置', en: 'Run on' },
  'runloc.cloud': { zh: '云端', en: 'Cloud' },
  'runloc.thisDevice': { zh: '这台电脑', en: 'This computer' },
  'runloc.external': { zh: '外部引擎', en: 'External engine' },
  'runloc.pillTitle': { zh: '新会话在哪运行：{where}', en: 'New sessions run on: {where}' },
  'runloc.others': { zh: '我的其他电脑', en: 'My other computers' },
  'runloc.none': { zh: '这个账号下还没有其他电脑。在另一台电脑上登录同一个账号后，它会出现在这里', en: 'No other computers on this account yet. Sign in on another computer with the same account and it shows up here' },
  'runloc.signIn': { zh: '登录后可选择其他电脑', en: 'Sign in to see them' }, // 一行放得下:菜单只有 --menu-select-width 宽,长了会折出一个孤字
  'runloc.manage': { zh: '管理设备…', en: 'Manage devices…' },
  'runloc.confirmPending': { zh: '请在「{name}」上点「允许」', en: 'Click Allow on "{name}"' },
  'runloc.confirmNotAsked': { zh: '「{name}」还没有允许这台电脑，再点一次会去询问', en: '"{name}" hasn\'t allowed this computer yet. Click it again to ask' },
  'runloc.reason.strict': { zh: '「{name}」只允许这类连接查看，不会再询问；请在那台电脑的「设置 › 远程会话」中允许', en: '"{name}" only lets connections like this one view sessions and won\'t ask again. Allow it in Settings › Remote sessions there' },
  'runloc.reason.neverPrompts': { zh: '「{name}」不会为这类连接弹框询问；请在那台电脑的「设置 › 远程会话」中允许', en: '"{name}" doesn\'t ask for connections like this one. Allow it in Settings › Remote sessions there' },
  'runloc.reason.notSignedIn': { zh: '「{name}」没有登录 Forsion，请先在那台电脑上登录', en: '"{name}" isn\'t signed in to Forsion. Sign in there first' },
  'runloc.reason.rosterMiss': { zh: '「{name}」的账号里找不到这台电脑，请确认两台电脑登录的是同一个账号', en: '"{name}" can\'t find this computer in its account. Make sure both computers use the same account' },
  'runloc.reason.rosterUnreachable': { zh: '「{name}」暂时无法核对这台电脑，请稍后再试', en: '"{name}" can\'t check this computer right now. Try again shortly' },
  'runloc.reason.noAnswer': { zh: '「{name}」上没有人回应确认，请稍后再试', en: 'No one answered on "{name}". Try again in a minute' },
  'runloc.reason.busy': { zh: '「{name}」上待确认的请求太多，请稍后再试', en: '"{name}" has too many requests waiting. Try again shortly' },
  'runloc.issue.callerUnavailable': { zh: '这台电脑暂时无法证明自己的身份，请稍后重试', en: "This computer couldn't verify its identity. Try again later" },
  'runloc.issue.callerUnsupported': { zh: '服务器版本过旧，暂不支持在其他电脑上运行', en: 'The server is too old to run on another computer' },
  'runloc.issue.network': { zh: '暂时连不上 Forsion，请检查网络后重试', en: "Can't reach Forsion right now. Check your connection and try again" },
  'runloc.issue.signedOut': { zh: '登录已失效，请重新登录后再试', en: 'Your sign-in has expired. Sign in again and retry' },
})

/** reason → 说明文案键。Record 键钉住 TrustReason 全集:新增 reason 不补这里就编不过。 */
const REASON_KEYS: Record<TrustReason, string> = {
  strict: 'runloc.reason.strict',
  'never-prompts': 'runloc.reason.neverPrompts',
  'not-signed-in': 'runloc.reason.notSignedIn',
  'roster-miss': 'runloc.reason.rosterMiss',
  'roster-unreachable': 'runloc.reason.rosterUnreachable',
  'no-answer': 'runloc.reason.noAnswer',
  busy: 'runloc.reason.busy',
}
/** 「这一端自己的问题」(换哪台电脑都一样)→ 说明文案键。nativeOnly 只有手机有,桌面走不到,按身份问题说。 */
const ISSUE_KEYS: Record<PhoneIssue, string> = {
  nativeOnly: 'runloc.issue.callerUnavailable',
  callerUnavailable: 'runloc.issue.callerUnavailable',
  callerUnsupported: 'runloc.issue.callerUnsupported',
  network: 'runloc.issue.network',
  signedOut: 'runloc.issue.signedOut',
}

type T = ReturnType<typeof useI18n>['t']

/** 点过的那一行为什么没成:拒绝类**先看 reason、再看 state**(P1-KF);其余按状态的完整说明。 */
export function runRowNotice(t: T, name: string, d: { status: DeviceStatus; refusal?: RefusalDetail }): string {
  const reason = d.refusal?.reason
  if (isTrustReason(reason) && (d.status === 'callerBlocked' || d.status === 'denied' || d.status === 'awaitingConfirm')) return t(REASON_KEYS[reason], { name })
  if (d.status === 'awaitingConfirm') return t(d.refusal?.state === 'unconfirmed' ? 'runloc.confirmNotAsked' : 'runloc.confirmPending', { name })
  return deviceStatusText(t, d.status, true)
}

/** 这一端要不要因为「在哪运行」多画一栏:闸开着且名册里有电脑 = 有得选。ChatView 用它决定 Chat 模式的新对话(没有项目药丸)
 *  要不要出现那一栏;Work 模式那一栏本来就在,药丸自己判要不要画(桌面恒画)。 */
export function useRunPickerVisible(): boolean {
  const units = useDeviceSessions((s) => s.units)
  useRemoteCapability((s) => s.epoch)
  return runLocationsAvailable() && !!units?.length
}

const isDesktop = (): boolean => currentPlatform() === 'desktop'

export function RunLocationPicker(): React.ReactElement | null {
  const { t } = useI18n()
  useDeviceSessionsLive()
  const hasChoice = useRunPickerVisible()
  const focus = useEngineFocus((s) => s.ref)
  useEngineFocus((s) => s.name)
  const units = useDeviceSessions((s) => s.units)
  useDeviceMarks((s) => s.probes)
  useDeviceMarks((s) => s.sticky)
  const chooser = useRunLocation((s) => s.chooser)
  useApp((s) => s.desktopMode) // homeKind 读它

  const desktop = isDesktop()
  const [open, setOpen] = useState(false)
  /** 正在走流程的那一行。 */
  const [busy, setBusy] = useState<string | null>(null)
  /** 最近点过的那一行(菜单底下说明它为什么没成)与这一端自己的问题。 */
  const [attempted, setAttempted] = useState<string | null>(null)
  const [issue, setIssue] = useState<PhoneIssue | null>(null)
  /** 离线的电脑缺省折起(10-14 用户定,同设备互联切换器);不持久化。 */
  const [offlineOpen, setOfflineOpen] = useState(false)
  const flight = useRef<AbortController | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuFix = useEdgeNudge(open)

  const closeMenu = (): void => {
    flight.current?.abort()
    flight.current = null
    setOpen(false); setBusy(null); setAttempted(null); setIssue(null)
    endDeviceAttempts() // 没人在轮询了:不留「请允许」
  }
  const closeRef = useRef(closeMenu)
  closeRef.current = closeMenu
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current() }
    const escape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      closeRef.current()
      ref.current?.querySelector<HTMLButtonElement>('.project-pill')?.focus()
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape)
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('.project-menu-item.active')?.focus())
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape)
      cancelAnimationFrame(frame)
    }
  }, [open])
  useEffect(() => () => { flight.current?.abort() }, [])

  const isFolded = (u: UnitInfo): boolean => statusOfUnit(u).status === 'offline' && !(focus.kind === 'unit' && focus.unitId === u.id.toLowerCase())
  const shown = (units || []).filter((u) => !isFolded(u))
  const folded = (units || []).filter(isFolded)
  // 焦点停在折叠开关上时最后一台离线电脑上线 → 开关卸载、焦点掉到 body,菜单的方向键随之失灵:交还给勾选的那一行(Codex 评审)
  useEffect(() => {
    if (open && !folded.length && document.activeElement === document.body) menuRef.current?.querySelector<HTMLButtonElement>('.project-menu-item.active')?.focus()
  }, [open, folded.length])

  // 手机:有得选才画;桌面主窗口:恒画(至少标出「这台电脑」)。网页版 / 设备页没有名册 → 不画。
  if (desktop ? !rosterAvailable() : !hasChoice) return null

  const kind = homeKind()
  const homeLabel = t(kind === 'local' ? 'runloc.thisDevice' : kind === 'cloud' ? 'runloc.cloud' : 'runloc.external')
  const HomeIcon = kind === 'local' ? Laptop : kind === 'cloud' ? Cloud : Server
  const iconOf = (u: Pick<UnitInfo, 'platform'> | null): typeof Laptop => (u?.platform === 'win32' || u?.platform === 'linux' ? Monitor : Laptop)
  const nameOf = (u: UnitInfo): string => clampText(u.name, 60) || t('engine.target.defaultName')

  const unit = focus.kind === 'unit' ? unitById(focus.unitId) : null
  const status: DeviceStatus | null = unit ? statusOfUnit(unit).status : null
  const where = focus.kind === 'unit' ? clampText(nameOfRef(focus) || unit?.name, 60) || t('engine.target.defaultName') : homeLabel
  const Icon = focus.kind === 'home' ? HomeIcon : iconOf(unit)
  const canOpen = desktop || !!chooser

  const pick = (u: UnitInfo): void => {
    const id = u.id.toLowerCase()
    flight.current?.abort()
    const ac = new AbortController()
    flight.current = ac
    setBusy(id); setAttempted(id); setIssue(null)
    beginDeviceAttempt(id) // 上一轮的「连不上」不许盖住这一轮的回答
    const target = targetForRef({ kind: 'unit', unitId: id })
    if (!target) { flight.current = null; setBusy(null); setIssue('signedOut'); return }
    const reply = async (r: Response): Promise<{ status: number; json: unknown }> => ({ status: r.status, json: await r.json().catch(() => null) })
    void runOn('', id, {
      // 桌面不在这里登记自己:这台电脑若已是登记过的设备,主进程的中转口会带上它的调用方票,否则按账号级连接(那台照样会弹确认)。
      ensureSelf: async () => ({ ok: true, unitId: '', name: '' }),
      // runOn 给的是 `…/proxy` 之后的三条固定路径;这里按目标发(基址、口令、路径闸都在目标解析层)。
      fetchJson: async (url, init) => {
        const path = url.slice(url.indexOf('/proxy') + '/proxy'.length)
        const signal = init?.signal ?? undefined
        return reply(path.startsWith('/engine/')
          ? await engineFetch(target, path.slice('/engine'.length), signal ? { signal } : {}, { timeoutMs: 15_000 })
          : await remoteAccessFetch(target, path.endsWith('/request'), { ...(signal ? { signal } : {}), timeoutMs: 15_000 }))
      },
      select: (loc) => {
        flight.current = null
        setOpen(false); setBusy(null); setAttempted(null)
        return setDraftLocation(loc, { explicit: true, name: u.name })
      },
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      now: () => Date.now(),
      progress: (p) => { if (!ac.signal.aborted) noteDeviceAttempt(id, p) },
    }, ac.signal).then((out) => {
      if (ac.signal.aborted || out.kind === 'cancelled') return
      if (out.kind === 'selected') noteDeviceAttempt(id, { probe: { ok: true } })
      else if (out.kind === 'device') noteDeviceAttempt(id, out)
      else setIssue(out.issue)
    }).catch((e: unknown) => {
      if (ac.signal.aborted) return
      noteDeviceAttempt(id, { probe: { ok: false, status: 0 } })
      useApp.getState().toast((e as Error)?.message || String(e), true)
    }).finally(() => {
      if (flight.current === ac) { flight.current = null; setBusy(null) }
    })
  }
  const pickHome = (): void => {
    closeMenu()
    // 已经在这台电脑上也照样记一次「亲手选的」:记着的那台此刻离线 / 还没对账时点「这台电脑」,不记的话下一份草稿又会自动跳回那台
    void setDraftLocation(HOME, { explicit: true }).catch(() => {})
  }
  const goSettings = (tab: 'forsion' | 'remote-sessions'): void => { closeMenu(); useApp.getState().openSettings(tab) }

  const moveMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('.project-menu-item:not(:disabled)') || [])]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
      : event.key === 'ArrowDown' ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const canPickOthers = runLocationsAvailable()
  const rowEl = (u: UnitInfo): React.ReactElement => {
    const id = u.id.toLowerCase()
    const d = statusOfUnit(u)
    const probing = busy === id
    const selected = focus.kind === 'unit' && focus.unitId === id
    // 离线 / 那台没有引擎:点了也没有可问的对象
    const dead = d.status === 'offline' || d.status === 'noEngine'
    const caption = probing ? (d.status === 'awaitingConfirm' ? deviceStatusText(t, d.status) : t('devstatus.checking'))
      : d.status === 'checking' ? (capsSaysReady(u) ? t('devstatus.ready') : '')
      : deviceStatusText(t, d.status)
    const RowIcon = iconOf(u)
    return (
      <button
        key={id}
        type="button"
        className={`menu-item project-menu-item runloc-row${selected ? ' active' : ''}`}
        role="menuitemradio"
        aria-checked={selected}
        aria-busy={probing || undefined}
        disabled={dead}
        title={deviceStatusText(t, d.status, true)}
        data-run-row={id}
        data-status={d.status}
        data-reason={d.refusal?.reason}
        onClick={() => pick(u)}
      >
        <RowIcon size={14} />
        <span className="grow project-menu-name">{nameOf(u)}</span>
        {caption && <span className="runloc-row-status" data-tone={d.status === 'ready' || (d.status === 'checking' && !probing) ? 'ok' : probing || d.status === 'checking' ? 'wait' : 'warn'}>{caption}</span>}
        <span className="project-menu-check">{selected ? <Check size={13} /> : null}</span>
      </button>
    )
  }
  const attemptedUnit = attempted ? unitById(attempted) : null
  const attemptedStatus = attemptedUnit && busy !== attempted ? statusOfUnit(attemptedUnit) : null
  const notice = issue ? t(ISSUE_KEYS[issue])
    : attemptedUnit && attemptedStatus && attemptedStatus.status !== 'ready' && attemptedStatus.status !== 'checking' ? runRowNotice(t, nameOf(attemptedUnit), attemptedStatus)
    // 轮询「请允许」期间这一行还是 busy:那句提示照样要出(人得走到那台电脑前去点)
    : attemptedUnit && busy === attempted && statusOfUnit(attemptedUnit).status === 'awaitingConfirm' ? runRowNotice(t, nameOf(attemptedUnit), statusOfUnit(attemptedUnit))
    : null

  return (
    <div
      className={`project-selector runloc${open ? ' is-open' : ''}`}
      ref={ref}
      data-run-location-picker
      data-run-location={formatRunLocation(focus) || 'home'}
      data-device-status={status ?? undefined}
    >
      <button
        type="button"
        className={`composer-chip project-pill runloc-pill${open ? ' is-open' : ''}`}
        title={t('runloc.pillTitle', { where })}
        aria-label={t('runloc.pillTitle', { where })}
        aria-haspopup={desktop ? 'menu' : 'dialog'}
        aria-expanded={desktop ? open : undefined}
        disabled={!canOpen}
        onClick={() => {
          if (!desktop) { chooser?.(); return }
          if (open) { closeMenu(); return }
          setOpen(true)
          if (canPickOthers) void useDeviceSessions.getState().refresh().catch(() => {}) // 点开 = 用户动作:终局态的那台也再试一次(R-32)
        }}
      >
        <Icon size={13} />
        <span className="project-pill-name">{where}</span>
        {status && status !== 'ready' && <span className="runloc-status" data-tone={status === 'checking' ? 'wait' : 'warn'}>{deviceStatusText(t, status)}</span>}
        {canOpen && <ChevronDown size={12} />}
      </button>
      {open && (
        <div
          ref={(el) => { menuRef.current = el; menuFix.ref.current = el }}
          className="composer-menu project-menu runloc-menu"
          style={menuFix.style}
          role="menu"
          aria-label={t('runloc.label')}
          onKeyDown={moveMenuFocus}
        >
          <div className="project-menu-list">
            <button
              type="button"
              className={`menu-item project-menu-item${focus.kind === 'home' ? ' active' : ''}`}
              role="menuitemradio"
              aria-checked={focus.kind === 'home'}
              data-run-row="home"
              onClick={pickHome}
            >
              <HomeIcon size={14} />
              <span className="grow project-menu-name">{homeLabel}</span>
              <span className="project-menu-check">{focus.kind === 'home' ? <Check size={13} /> : null}</span>
            </button>
          </div>
          <div className="project-menu-section" role="group" aria-label={t('runloc.others')}>
            <div className="menu-section">{t('runloc.others')}</div>
            {/* 离线的电脑缺省折起,只列在线的(10-14 用户定);选中的那台掉线了也不折。三段拼成一个扁平 keyed 数组:
                名册实时刷新时设备跨组只挪节点、不重挂(键盘焦点不丢)。 */}
            {canPickOthers && [
              ...shown.map(rowEl),
              ...(folded.length ? [
                <button key="offline-fold" type="button" className="menu-item project-menu-item runloc-fold" role="menuitem" aria-expanded={offlineOpen} data-run-offline-fold onClick={() => setOfflineOpen((v) => !v)}>
                  <span className="grow project-menu-name">{t('unit.offlineGroup')}</span>
                  <span className="runloc-row-status">{folded.length}</span>
                  <ChevronDown size={12} className="runloc-fold-chev" />
                </button>,
              ] : []),
              ...(offlineOpen ? folded.map(rowEl) : []),
            ]}
            {canPickOthers && units !== null && !units.length && <div className="project-menu-empty">{t('runloc.none')}</div>}
            {!canPickOthers && (
              <button type="button" className="menu-item project-menu-item project-menu-add" role="menuitem" data-run-signin onClick={() => goSettings('forsion')}>
                <LogIn size={14} /><span className="grow">{t('runloc.signIn')}</span>
              </button>
            )}
            {notice && <div className="project-menu-empty runloc-notice" role="status" data-run-notice>{notice}</div>}
          </div>
          <div className="project-menu-section project-menu-actions" role="group">
            <button type="button" className="menu-item project-menu-item project-menu-add" role="menuitem" data-run-manage onClick={() => goSettings('remote-sessions')}>
              <Settings2 size={14} /><span className="grow">{t('runloc.manage')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
