/**
 * 手机引导第一屏「在哪运行」(方案 A,2026-11-13):Forsion 云端 + 账号下每台能跑会话的电脑,单选卡,即点即生效。
 * 进度点、跳过、上一步、底栏主按钮都是外壳(OnboardingWizard)的;这里只画标题、说明和选项。
 *
 * - 名册读共享的 stores/deviceSessionsStore(已去掉手机和本机;读失败保持 null = 不知道),不像弹层那样把读失败当成「没有电脑」。
 * - 行的名字 / 状态词 / 状态点和「在哪运行」弹层同一套(unitsSheetModel 的 runRows / statusKey / rowTone,unitm.* 文案登记在 UnitsSheet.tsx)。
 * - 点电脑走弹层同一段流程(UnitsSheet.runOnUnit:懒登记 → 那台电脑确认 → 探引擎 → 唯一出口生效),不直接切焦点。
 * - 选中 = 当前运行位置(整端焦点)。新账号本来就在云端,所以缺省选中云端不需要任何调用;
 *   已在云端时再点云端什么也不切 —— 切一次会把用户以前记住的那台电脑覆盖成云端。
 * - 连电脑可能要等那台上点「允许」一两分钟:不锁底栏(不报 busy),离开这一屏就中止,不留「请允许」。
 */
import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, Cloud, Laptop, Loader2, Monitor, RotateCw } from 'lucide-react'
import { registerMessages, useI18n } from '@/i18n'
import type { PhoneScreenProps } from '@/components/onboarding/phoneGuide'
import { useDeviceSessions } from '@/stores/deviceSessionsStore'
import { focusRef, onFocusChange } from '@/services/engine/targets'
import { HOME_REF } from '@/services/engine/target'
import { beginAttempt, endAttempts, noteAttempt, NO_MARKS, rowTone, runRows, statusKey, type PhoneIssue, type RowMarks, type RunRow } from '../unitsSheetModel'
import { runOnUnit, selectRunLocation, setRunRoster } from '../UnitsSheet'
import './where.css'

registerMessages({
  'phoneguide.where.title': { zh: '在哪运行？', en: 'Where should it run?' },
  'phoneguide.where.desc': { zh: '对话里的文件、命令和工具在哪跑。以后新建对话时也能换。', en: 'Where files, commands and tools in your chats run. You can switch later when you start a new chat.' },
  'phoneguide.where.recommended': { zh: '推荐', en: 'Recommended' },
  'phoneguide.where.cloudDesc': { zh: '不占手机存储，开箱即用。', en: 'Uses no space on your phone and works right away.' },
  'phoneguide.where.computer': { zh: '我的电脑', en: 'My computer' },
  'phoneguide.where.computerDesc': { zh: '用电脑上的文件和工具。电脑要开着，并登录同一个账号。', en: 'Use the files and tools on your computer. It needs to be on and signed in to the same account.' },
  'phoneguide.where.rosterUnknown': { zh: '没读到你的电脑', en: "Couldn't load your computers" },
})

/** 名册请求没有超时(cloudJson 就一次 fetch):重试的转圈最多转这么久,之后让人能再点。 */
const RETRY_LIMIT_MS = 8000

let inflight: Promise<void> | null = null

/**
 * 读一次共享名册(去重:同一时刻只有一个请求)。refreshRoster 读到才写 units,读失败保持原值 —— null 仍是「不知道」。
 * 不用 refresh():它还会逐台去拉会话列表,引导这里只要名册。
 */
export function loadRoster(): Promise<void> {
  if (!inflight) {
    const p = useDeviceSessions.getState().refreshRoster().then(() => undefined, () => undefined)
    inflight = p
    const drop = (): void => { if (inflight === p) inflight = null }
    void p.finally(drop)
    // 名册请求没有超时:一直不回来的那次到时限就放手,下一次「重试」才会真的再发一个。
    // 放手的那次晚回来不会盖掉重试读到的(store 的 refreshRoster 按发出的先后挡);重试没读到时它照样算数
    setTimeout(drop, RETRY_LIMIT_MS)
  }
  return inflight
}

function within(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([p, new Promise<void>((res) => setTimeout(res, ms))])
}

// 同弹层的 ISSUE_KEY:这台手机自己连不出去时的说明(文案键登记在 UnitsSheet.tsx)
const ISSUE_KEY: Record<PhoneIssue, string> = {
  nativeOnly: 'unitm.nativeOnly',
  callerUnavailable: 'unitm.callerUnavailable',
  callerUnsupported: 'unitm.callerUnsupported',
  network: 'unitm.network',
  signedOut: 'unitm.signedOut',
}

const rowIcon = (row: Pick<RunRow, 'icon' | 'platform'>): React.ReactNode => {
  if (row.icon) return <span className="pg-where-emoji" aria-hidden>{row.icon}</span>
  if (row.platform === 'win32' || row.platform === 'linux') return <Monitor size={20} />
  return <Laptop size={20} />
}

export function WhereScreen(_props: PhoneScreenProps): React.ReactElement {
  const { t } = useI18n()
  const units = useDeviceSessions((s) => s.units)
  const [marks, setMarks] = useState<RowMarks>(NO_MARKS)
  const [busy, setBusy] = useState<string | null>(null)
  const [issue, setIssue] = useState<PhoneIssue | null>(null)
  const [offlineOpen, setOfflineOpen] = useState(false)
  const [loading, setLoading] = useState(() => inflight !== null)
  const flight = useRef<AbortController | null>(null)
  const alive = useRef(true)

  // 整端焦点变了(这里切的、切换失败回落云端)→ 重画选中
  const [, bumpFocus] = useState(0)
  useEffect(() => onFocusChange(() => bumpFocus((n) => n + 1)), [])

  // 切到电脑时焦点要带名字:把读到的名册交给弹层模块(读不到不交,不清掉它手里那份)
  useEffect(() => { if (units) setRunRoster(units) }, [units])

  useEffect(() => {
    alive.current = true
    // prepare 的那次请求过了时限还没回来:这里接着等它,回来了卡片自己出现
    if (inflight) void within(inflight, RETRY_LIMIT_MS).then(() => { if (alive.current) setLoading(false) })
    return () => {
      alive.current = false
      flight.current?.abort() // 没人看了:不再轮询那台电脑,也不会在背后切过去
      flight.current = null
    }
  }, [])

  const retry = (): void => {
    if (loading) return
    setLoading(true)
    void within(loadRoster(), RETRY_LIMIT_MS).then(() => { if (alive.current) setLoading(false) })
  }

  const current = focusRef()
  const rows = runRows(units ?? [], null, current, marks.probes, marks.sticky)
  const homeSelected = current.kind === 'home'

  const pick = (row: RunRow): void => {
    flight.current?.abort()
    const ac = new AbortController()
    flight.current = ac
    setBusy(row.id)
    setIssue(null)
    setMarks((m) => beginAttempt(m, row.id))
    const note = (p: Parameters<typeof noteAttempt>[2]): void => {
      if (ac.signal.aborted) return
      setMarks((m) => noteAttempt(m, row.id, p))
    }
    void runOnUnit(row.id, ac.signal, { progress: note }).then((out) => {
      if (ac.signal.aborted || out.kind === 'cancelled') return
      // 手机自己连不出去:那台电脑不会再被问了,前面进度里记下的「请在 X 上允许」一并收掉
      if (out.kind === 'phone') { setIssue(out.issue); setMarks(endAttempts) }
      else if (out.kind === 'device') note(out)
    }).catch(() => { if (!ac.signal.aborted && alive.current) setMarks(endAttempts) }).finally(() => {
      if (flight.current === ac) { flight.current = null; if (alive.current) setBusy(null) }
    })
  }

  const pickCloud = (): void => {
    // 在途的「连电脑」一律收掉:点云端就是改主意了,不能等那台电脑点了允许又在背后切过去
    flight.current?.abort()
    flight.current = null
    setBusy(null)
    setIssue(null)
    setMarks(endAttempts)
    if (focusRef().kind === 'home') return // 已在云端:不切,切一次会把记住的那台电脑覆盖掉
    void selectRunLocation(HOME_REF).catch(() => { /* 切换失败由整端焦点自己回落 */ })
  }

  // 离线的电脑缺省折起(同弹层);当前运行位置那台掉线了也不折
  const isFolded = (r: RunRow): boolean => r.status === 'offline' && !r.selected
  const shown = rows.filter((r) => !isFolded(r))
  const folded = rows.filter(isFolded)
  const listed = offlineOpen ? [...shown, ...folded] : shown
  const firstId = listed[0]?.id

  const card = (row: RunRow): React.ReactElement => {
    const probing = busy === row.id
    return (
      <button
        key={row.id}
        type="button"
        role="radio"
        aria-checked={row.selected}
        aria-busy={probing || undefined}
        className={`ob3-card ob3-choice pg-where-card${row.selected ? ' pick' : ''}`}
        data-run-row={row.id}
        data-status={row.status}
        onClick={() => pick(row)}
      >
        <span className="ob3-choice-h pg-where-h">
          {rowIcon(row)}
          <strong>{t('phoneguide.where.computer')}</strong>
          <em className="pg-where-em" role="status">
            <span className="pg-where-name">{row.name}</span>
            <span aria-hidden> · </span>
            <i className={`settings-status-dot ${rowTone(row, probing)}`} aria-hidden />
            <span>{t(statusKey(row, probing), { name: row.name })}</span>
          </em>
        </span>
        {row.id === firstId && <span className="ob3-sub">{t('phoneguide.where.computerDesc')}</span>}
      </button>
    )
  }

  return (
    <div className="ob3-col narrow pg-where">
      <div className="ob3-head">
        <h1 tabIndex={-1} data-ob-title="">{t('phoneguide.where.title')}</h1>
        <p>{t('phoneguide.where.desc')}</p>
      </div>
      <div className="pg-where-list" role="radiogroup" aria-label={t('phoneguide.where.title')}>
        <button
          type="button"
          role="radio"
          aria-checked={homeSelected}
          className={`ob3-card ob3-choice pg-where-card${homeSelected ? ' pick' : ''}`}
          data-run-row="home"
          onClick={pickCloud}
        >
          <span className="ob3-choice-h pg-where-h">
            <Cloud size={20} />
            <strong>{t('unitm.cloud')}</strong>
            <em className="pg-where-em">{t('phoneguide.where.recommended')}</em>
          </span>
          <span className="ob3-sub">{t('phoneguide.where.cloudDesc')}</span>
        </button>
        {listed.map(card)}
      </div>
      {folded.length > 0 && (
        <button type="button" className="ob3-link pg-where-fold" aria-expanded={offlineOpen} data-offline-fold onClick={() => setOfflineOpen((v) => !v)}>
          <span>{t('unit.offlineGroup')} · {folded.length}</span>
          <ChevronDown size={14} className="pg-where-chev" />
        </button>
      )}
      {issue && <div className="ob3-note pg-where-line" role="status" data-phone-issue={issue}>{t(ISSUE_KEY[issue])}</div>}
      {/* 名册不知道(还在读 / 读失败):只说没读到,给重试;绝不说成「你没有电脑」 */}
      {units === null && (
        <div className="ob3-note pg-where-line" data-roster-unknown="">
          <span>{t('phoneguide.where.rosterUnknown')}</span>
          <button type="button" className="ob3-link" disabled={loading} aria-busy={loading || undefined} onClick={retry}>
            {loading ? <Loader2 size={12} className="spin" /> : <RotateCw size={12} />}
            {t('common.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
