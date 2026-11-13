/**
 * 手机首次引导第 3 屏「想让 Forsion 帮你做哪些事」,和 设置 › 设备权限 的手机版(PermissionsPanel)。
 * 能力本身(读 / 问 / 去系统设置)在 caps.ts。
 *
 * 引导这一屏只会「开」:已经开着的项开关亮着、点不动;没开的默认关,勾上 = 想开,按主按钮才逐项过系统框。
 * 没勾的开关从不关掉任何东西。开关最后只显示系统回报的结果(拒了就回到关),不认点了什么。
 */
import { useEffect, useRef, useState } from 'react'
import { Bell, Hand, Mic } from 'lucide-react'
import type { PhoneScreenProps } from '@/components/onboarding/phoneGuide'
import { SettingsRow, SettingsSwitch } from '@/components/SettingsPrimitives'
import { registerMessages, useI18n } from '@/i18n'
import { setPhoneControlEnabled, usePhoneControlStatus } from '../phoneControl'
import { onAppResume, phoneCaps, readCaps, type CapId, type CapState, type PhoneCap } from './caps'
import './perms.css'

registerMessages({
  'phonePerms.title': { zh: '想让 Forsion 帮你做哪些事？', en: 'What should Forsion help you with?' },
  'phonePerms.desc': {
    zh: '选好后逐项去系统里确认。不选也能用，以后在 设置 里开。',
    en: 'You’ll confirm each one with your phone next. Everything works without them, and you can turn them on later in Settings.',
  },
  'phonePerms.notify.name': { zh: '提醒我', en: 'Notify me' },
  'phonePerms.notify.hint': { zh: '任务做完、要你点头时发通知。', en: 'Get a notification when a task finishes or needs your OK.' },
  'phonePerms.control.name': { zh: '操作这台手机', en: 'Operate this phone' },
  'phonePerms.control.hint': {
    zh: '打开 App 和链接、设闹钟、起草短信和日程；发送和拨打始终由你按。',
    en: 'Open apps and links, set alarms, draft messages and events. Sending and calling are always up to you.',
  },
  'phonePerms.voice.name': { zh: '用语音说', en: 'Talk by voice' },
  'phonePerms.voice.hint': { zh: '按住说话、语音通话时用麦克风。', en: 'Uses the microphone for hold-to-talk and voice calls.' },
  'phonePerms.result': { zh: '已开 {n} 项，还有 {m} 项没开，可在 设置 里补开', en: '{n} turned on, {m} not yet. You can turn them on in Settings.' },
  'phonePerms.turnOn': { zh: '开启 {n} 项', en: 'Turn on {n}' },
  'phonePerms.skip': { zh: '跳过', en: 'Skip' },
  'phonePerms.openSettings': { zh: '去系统设置', en: 'Open system settings' },
  // 设置 › 设备权限(手机)那一页的说明;设置页按 hasDesktopPermissions() 在它和电脑那句之间选
  'phonePerms.pageDescription': { zh: '通知、操作这台手机和麦克风。没开的在这里补开。', en: 'Notifications, operating this phone and the microphone. Turn on anything you skipped.' },
})

const ICONS: Record<CapId, typeof Bell> = { notify: Bell, control: Hand, voice: Mic }

/** undefined = 还在读;null = 读不到(不知道:可以勾,不算「已开」)。 */
type States = Partial<Record<CapId, CapState | null>>

export function PermsScreen(props: PhoneScreenProps) {
  const { t } = useI18n()
  const { commitRef, setPrimaryLabel, onBusyChange } = props
  const caps = phoneCaps()
  const [states, setStates] = useState<States>({})
  const [wanted, setWanted] = useState<ReadonlySet<CapId>>(() => new Set())
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ n: number; m: number } | null>(null)
  const alive = useRef(true)
  const busyRef = useRef(false)

  useEffect(() => {
    alive.current = true
    void readCaps(caps).then((s) => { if (alive.current) setStates(s) })
    return () => {
      alive.current = false
      commitRef.current = null
      setPrimaryLabel(null)
      // 系统框还开着时离开(App 被切走重建之类):锁是这一屏上的,自己收掉
      if (busyRef.current) { busyRef.current = false; onBusyChange(false) }
    }
    // 挂载时读一次;caps 是同一批对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const anyOn = caps.some((c) => states[c.id] === 'on')
  const loaded = caps.every((c) => states[c.id] !== undefined)
  const n = wanted.size

  // 主按钮的字:勾了 n 项 → 开启 n 项;什么都没勾、没问过、也没有已开的 → 跳过;其余(含还没读完,不知道有没有已开的)用外壳自己的
  useEffect(() => {
    setPrimaryLabel(n > 0 ? t('phonePerms.turnOn', { n }) : loaded && !asked && !anyOn ? t('phonePerms.skip') : null)
  }, [n, loaded, asked, anyOn, t, setPrimaryLabel])

  // 只有勾了东西时才挂 commit;没勾 = 主按钮直接往下走
  useEffect(() => {
    if (n === 0) { commitRef.current = null; return }
    commitRef.current = async () => {
      busyRef.current = true
      setBusy(true)
      onBusyChange(true)
      try {
        const todo = caps.filter((c) => wanted.has(c.id))
        // 按 notify → control → voice 的顺序一项一项来:每项等它的系统框 / 原生确认框答完再问下一项
        for (const c of todo) {
          // 这一屏已经不在了(引导被别处收掉):不再接着弹下一个框;回 false,外壳不把它当成「走完了」去记完成
          if (!alive.current) return false
          try { await c.ask() } catch (e) { console.warn(`[phone-guide] ask ${c.id} failed:`, e) }
        }
        const next = await readCaps(caps)
        if (!alive.current) return false
        setStates(next)
        setWanted(new Set())
        setAsked(true)
        if (todo.every((c) => next[c.id] === 'on')) { setResult(null); return }
        const on = caps.filter((c) => next[c.id] === 'on').length
        setResult({ n: on, m: caps.length - on })
        return false // 留在这一屏,让人看到结果
      } finally {
        if (busyRef.current) { busyRef.current = false; onBusyChange(false) }
        if (alive.current) setBusy(false)
      }
    }
  }, [wanted, n, caps, commitRef, onBusyChange])

  const toggle = (id: CapId, next: boolean): void => {
    setResult(null) // 上一轮的结果行和新的「开启 n 项」不并排
    setWanted((prev) => {
      const s = new Set(prev)
      if (next) s.add(id)
      else s.delete(id)
      return s
    })
  }

  return <div className="ob3-col narrow">
    <div className="ob3-head"><h1 tabIndex={-1} data-ob-title="">{t('phonePerms.title')}</h1><p>{t('phonePerms.desc')}</p></div>
    <section className="ob3-card ob3-perms">
      {caps.map((c) => {
        const Icon = ICONS[c.id]
        const st = states[c.id]
        const on = st === 'on'
        const name = t(`phonePerms.${c.id}.name`)
        return <div key={c.id} className="ob3-muse-h ob3-perm" data-cap={c.id} data-state={st ?? (st === null ? 'unknown' : 'loading')}>
          <span className="ob3-ava plain" aria-hidden="true"><Icon size={18} /></span>
          <div><strong>{name}</strong><small>{t(`phonePerms.${c.id}.hint`)}</small></div>
          <SettingsSwitch checked={on || wanted.has(c.id)} disabled={on || busy || st === undefined} label={name}
            onChange={(next) => { if (!on) toggle(c.id, next) }} />
        </div>
      })}
    </section>
    {result && <p className="ob3-note ob3-perms-result" role="status">{t('phonePerms.result', result)}</p>}
  </div>
}

/** 设置 › 设备权限(手机):同样三项。没开的点一下过系统框;被系统拦住的给「去系统设置」;回到前台重读。 */
export function PermissionsPanel() {
  const caps = phoneCaps()
  const [states, setStates] = useState<States>({})
  const alive = useRef(true)
  const reload = useRef<() => void>(() => {})
  reload.current = () => { void readCaps(caps).then((s) => { if (alive.current) setStates(s) }) }

  useEffect(() => {
    alive.current = true
    reload.current()
    const off = onAppResume(() => reload.current())
    return () => { alive.current = false; off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <section className="settings-panel">
    {caps.map((c) => c.id === 'control'
      ? <ControlCapRow key={c.id} />
      : <SystemCapRow key={c.id} cap={c} state={states[c.id]} onChanged={() => reload.current()} />)}
  </section>
}

/**
 * 「操作这台手机」:App 自己的开关,能开也能关(同 设置 › 高级 那一行,读的是同一份原生状态,开启照样过原生确认框)。
 * 这一页里和另外两项排成同一种行(名字 + 一句说明 + 右侧开关);「内容经过云端」那句照留 —— 开关在哪,这句就得在哪。
 */
function ControlCapRow() {
  const { t } = useI18n()
  const status = usePhoneControlStatus()
  const [busy, setBusy] = useState(false)
  const name = t('phonePerms.control.name')
  return <SettingsRow fit="inline" label={name}
    description={<>{t('phonePerms.control.hint')}<br />{t('phone.row.privacy')}</>}
    control={<SettingsSwitch checked={!!status?.enabled} disabled={busy || !status} label={name}
      onChange={(next) => { setBusy(true); void setPhoneControlEnabled(next).finally(() => setBusy(false)) }} />} />
}

function SystemCapRow({ cap, state, onChanged }: { cap: PhoneCap; state: CapState | null | undefined; onChanged: () => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const name = t(`phonePerms.${cap.id}.name`)
  const run = (f: () => Promise<unknown>): void => {
    setBusy(true)
    void f().catch((e) => console.warn(`[phone-perms] ${cap.id} failed:`, e)).finally(() => { setBusy(false); onChanged() })
  }
  const control = state === 'blocked' && cap.openSettings
    ? <button type="button" className="btn ghost sm" disabled={busy} data-cap-open={cap.id} onClick={() => run(() => cap.openSettings!())}>{t('phonePerms.openSettings')}</button>
    // 开着的只显示「开」:关通知 / 麦克风只能在系统里做,这里点了也关不掉,所以不给点
    : <SettingsSwitch checked={state === 'on'} disabled={busy || state === 'on' || state === undefined} label={name}
      onChange={(next) => { if (next) run(() => cap.ask()) }} />
  return <SettingsRow fit="inline" label={name} description={t(`phonePerms.${cap.id}.hint`)} control={control} />
}
