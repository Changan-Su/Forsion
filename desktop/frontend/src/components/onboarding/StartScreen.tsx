/**
 * ① 开始:Forsion 账号 + 其他模型渠道,两边可以同时接(11-05 用户定:不是二选一)。
 * - 账号卡只在装了 Forsion Extend(桥键 forsionLogin)时出现:权益六样、浏览器登录、登录后的同步勾(10-20:勾着的开、没勾的关、
 *   没看到不替你开;11-06 拿掉「Agents 与记忆」,新同步里它不起作用,换成一行指向 蓬洲云 › 同步 的说明),
 *   卡底「帮助改进 Forsion」开关 + ⓘ。没登录时开关灰着(只在登录后能开);登录那一刻详情自动弹一次 = 看过告知。
 * - 渠道卡:API Key(原来的「更多 Provider」点进去是同一张表,11-06 并进来)、订阅登录(authProviders 列出几家就几块)、本机模型;
 *   接上的那块打 ✓。凭证只在本机。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Cloud, Cpu, ExternalLink, Image, Info, KeyRound, Languages, Loader2, LogIn, MessageCircle, Phone, Scale, ShieldCheck, Bug, Bot, Gauge, MousePointerClick, WifiOff } from 'lucide-react'
import { useI18n } from '../../i18n'
import { testProviderConnection } from '../../services/backendService'
import type { EngineTarget } from '../../services/engine/targets'
import { track } from '../../achievements/store'
import { FORSION_PRIVACY_URL } from '../../appCompliance'
import { SettingsSwitch } from '../SettingsPrimitives'
import { PROVIDER_PRESETS, presetProviderId } from '../providerPresets'
import { asTelemetryView, improveOnThisHost, readTelemetry, type TelemetryView } from '../OnboardingImprove'
import type { SyncKind } from '../../services/syncSetup'
import type { AuthStatusInfo, DirectProviderConfig } from '../../types'

export const SUB_LABELS: Record<string, string> = { codex: 'Codex', xai: 'xAI' }
const SUB_HINTS: Record<string, string> = { codex: 'ob3.channels.sub.codex', xai: 'ob3.channels.sub.xai' }
const errText = (e: unknown): string => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')

export interface StartProps {
  /** 现读主机连接(外壳给;登录 / 加渠道后 token 可能刚换过)。 */
  resolveTarget: () => Promise<EngineTarget>
  returning: boolean
  syncPick: Record<SyncKind, boolean>
  onSyncPick: (next: Record<SyncKind, boolean>) => void
  /** 同步那三个勾真露出来过(没看到就不替用户开)。 */
  onSyncSeen: () => void
  onConnected: (connected: boolean) => void
  onSignedIn: (signedIn: boolean) => void
  onReconnect: () => void
  onBusyChange: (busy: boolean) => void
}

export function StartScreen(p: StartProps): React.ReactNode {
  const { t } = useI18n()
  const canForsion = !!window.tangu?.forsionLogin
  const [auth, setAuth] = useState<AuthStatusInfo | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [device, setDevice] = useState<{ url: string; userCode: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [providers, setProviders] = useState<Array<{ id: string; loggedIn: boolean }>>([])
  const [providerBusy, setProviderBusy] = useState<string | null>(null)
  const [keyCount, setKeyCount] = useState(0)
  const [panel, setPanel] = useState<null | 'key' | 'local'>(null)
  const signedIn = !!auth?.loggedIn
  const subConnected = providers.some((x) => x.loggedIn)
  const connected = signedIn || subConnected || keyCount > 0

  const refresh = (): void => {
    void window.tangu?.authStatus?.().then((a: AuthStatusInfo) => setAuth(a)).catch(() => {})
    void window.tangu?.authProviders?.().then((list: Array<{ id: string; loggedIn: boolean }>) => setProviders(list || [])).catch(() => setProviders([]))
    void window.tangu?.listProviders?.().then((items: unknown[]) => setKeyCount(Array.isArray(items) ? items.length : 0)).catch(() => {})
  }
  useEffect(() => {
    refresh()
    const off = window.tangu?.onAuthDevice?.((info) => setDevice(info))
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const { onConnected, onSignedIn, onBusyChange } = p
  useEffect(() => { onConnected(connected) }, [connected, onConnected])
  useEffect(() => { onSignedIn(signedIn) }, [signedIn, onSignedIn])
  const busy = loggingIn || !!providerBusy
  useEffect(() => { onBusyChange(busy) }, [busy, onBusyChange])

  const login = async (): Promise<void> => {
    if (!window.tangu?.forsionLogin) return
    setLoggingIn(true); setMsg(''); setDevice(null)
    try {
      const cloudUrl = auth?.cloudUrl || ''
      await window.tangu.setConfig({ mode: 'managed', cloudUrl })
      await window.tangu.forsionLogin(cloudUrl)
      track('account.login')
      refresh()
      p.onReconnect()
    } catch (e) { setMsg(errText(e)) } finally { setLoggingIn(false); setDevice(null) }
  }
  const subLogin = async (id: string): Promise<void> => {
    if (!window.tangu?.providerLogin) return
    setProviderBusy(id); setMsg('')
    try {
      await window.tangu.setConfig({ mode: 'managed' })
      await window.tangu.providerLogin(id)
      refresh()
      p.onReconnect()
    } catch (e) { setMsg(errText(e)) } finally { setProviderBusy(null) }
  }
  const name = auth?.nickname || auth?.username || ''

  const accountCard = canForsion && <section className={`ob3-card ob3-choice${signedIn ? ' pick' : ''}`} data-ob-account="">
    <div className="ob3-choice-h"><Cloud size={20} aria-hidden="true" /><strong>{t('ob3.account.title')}</strong>
      {signedIn ? <em className="ob3-chip"><Check size={12} aria-hidden="true" />{t('ob3.account.signedIn')}</em> : <em>{t('ob3.account.recommended')}</em>}</div>
    {signedIn ? <>
      {name && <div className="ob3-muse-h" style={{ alignItems: 'center', gap: 10 }}><span className="ob3-ava" style={{ width: 28, height: 28, fontWeight: 600 }}>{name.slice(0, 1).toUpperCase()}</span><div><strong style={{ fontSize: 'inherit', fontWeight: 500 }}>{name}</strong></div></div>}
      <div className="ob3-sync" ref={() => p.onSyncSeen()}><span className="ob3-note">{t('onboarding.connect.syncTitle')}</span>
        {([['notes', 'onboarding.connect.sync.notes'], ['plugins', 'onboarding.connect.sync.plugins']] as const)
          .filter(([k]) => k !== 'notes' || !!window.remoteSync).map(([k, label]) => (
            <label key={k}><input type="checkbox" checked={p.syncPick[k]} onChange={(e) => p.onSyncPick({ ...p.syncPick, [k]: e.target.checked })} />{t(label)}</label>
          ))}
        {/* 引导盖在最上面,这里只说去哪儿选,不做成点了没反应的链接 */}
        <span className="ob3-note" data-ob-sync-agents="">{t('ob3.sync.agentsWhere')}</span></div>
    </> : <>
      <span className="ob3-sub">{t('ob3.account.lead')}</span>
      <ul className="ob3-perks">
        {([[MessageCircle, 'ob3.perk.chat'], [Image, 'ob3.perk.image'], [Languages, 'ob3.perk.translate'], [Phone, 'ob3.perk.voice'], [Scale, 'ob3.perk.decision'], [Cloud, 'ob3.perk.drive', 'ob3.perk.driveHint']] as const).map(([Icon, label, hint]) => (
          <li key={label}><Icon size={15} aria-hidden="true" /><span>{t(label)}{hint && <small>{t(hint)}</small>}</span></li>
        ))}
      </ul>
      <div className="ob3-fill" />
      <div className="ob3-actions"><button type="button" className="btn primary" disabled={loggingIn} onClick={() => void login()}>
        {loggingIn ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <LogIn size={14} aria-hidden="true" />}{t('onboarding.connect.loginViaBrowser')}</button></div>
      {device && <div className="ob3-feedback">{t('onboarding.connect.browserNotOpened')} <a href={device.url} target="_blank" rel="noreferrer">{device.url} <ExternalLink size={10} aria-hidden="true" /></a>
        {device.userCode ? <> · {t('onboarding.connect.verifyCode')} <b>{device.userCode}</b></> : null}</div>}
    </>}
    {signedIn && <div className="ob3-fill" />}
    <ImproveRow signedIn={signedIn} />
  </section>

  const channelsCard = <section className={`ob3-card ob3-choice${(subConnected || keyCount > 0) ? ' pick' : ''}`} data-ob-channels="">
    <div className="ob3-choice-h"><KeyRound size={20} aria-hidden="true" /><strong>{t('ob3.channels.title')}</strong><em>{t('ob3.channels.many')}</em></div>
    {panel ? <KeyForm local={panel === 'local'} resolveTarget={p.resolveTarget} onDone={(saved) => { setPanel(null); if (saved) { refresh(); p.onReconnect() } }} /> : <>
      <span className="ob3-sub">{t('ob3.channels.lead')}</span>
      <div className="ob3-provs">
        <button type="button" className={`ob3-prov${keyCount > 0 ? ' on' : ''}`} data-channel="key" onClick={() => setPanel('key')}>
          <KeyRound size={15} aria-hidden="true" /><span><strong>{t('ob3.channels.apiKey')}</strong><small>{keyCount > 0 ? t('ob3.channels.added', { n: keyCount }) : t('ob3.channels.apiKeyHint')}</small></span>
          {keyCount > 0 ? <Check size={14} className="ob3-mark" aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button>
        {providers.map((pr) => <button key={pr.id} type="button" className={`ob3-prov${pr.loggedIn ? ' on' : ''}`} data-channel={pr.id} disabled={!!providerBusy || pr.loggedIn} onClick={() => void subLogin(pr.id)}>
          {providerBusy === pr.id ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}
          <span><strong>{t('ob3.channels.login', { name: SUB_LABELS[pr.id] || pr.id })}</strong><small>{pr.loggedIn ? t('ob3.channels.connected') : t(SUB_HINTS[pr.id] || 'ob3.channels.subHint')}</small></span>
          {pr.loggedIn && <Check size={14} className="ob3-mark" aria-hidden="true" />}</button>)}
        <button type="button" className="ob3-prov" data-channel="local" onClick={() => setPanel('local')}><Cpu size={15} aria-hidden="true" /><span><strong>{t('ob3.channels.local')}</strong><small>{t('ob3.channels.localHint')}</small></span><ChevronRight size={14} aria-hidden="true" /></button>
      </div>
      <div className="ob3-fill" />
      <span className="ob3-note">{t('ob3.channels.none')}</span>
    </>}
  </section>

  return <div className={`ob3-col ${canForsion ? 'mid' : 'narrow'}`}>
    <div className="ob3-head"><div className="ob3-brand" aria-hidden="true">Forsion is All You Need</div>
      <h1 tabIndex={-1} data-ob-title="">{t(p.returning ? 'ob3.start.titleBack' : 'ob3.start.title')}</h1>
      <p>{t(p.returning ? 'ob3.start.descBack' : canForsion ? 'ob3.start.desc' : 'ob3.start.descNoExt')}</p></div>
    {canForsion ? <div className="ob3-two">{accountCard}{channelsCard}</div> : channelsCard}
    {msg && <div className="ob3-feedback" role="status">{msg}</div>}
    {!canForsion && <div className="ob3-where"><WifiOff size={12} aria-hidden="true" />{t('ob3.channels.noExt')}</div>}
  </div>
}

/**
 * 填 API Key / 本机模型共用的一张表,存的就是设置 › 模型里那一份。
 * API Key(11-06 第四轮):先选一家(设置里那份预设,胶囊一排),选中后只剩 Key 一格和「去哪拿 Key」;连接名、地址、白名单收进「高级」,
 * 选了哪家已经填好(连接名占用时顺延成 id-2,不悄悄盖掉已有的那条)。「自己填…」/ 本机模型展开全部字段。
 */
function KeyForm({ local, resolveTarget, onDone }: { local: boolean; resolveTarget: () => Promise<EngineTarget>; onDone: (saved: boolean) => void }): React.ReactNode {
  const { t } = useI18n()
  const [preset, setPreset] = useState(local ? '' : 'openai')
  const chosen = PROVIDER_PRESETS.find((x) => x.id === preset)
  const custom = local || !chosen
  const [existing, setExisting] = useState<DirectProviderConfig[]>([])
  // null = 跟着预设走;在「高级」里改过才用手填的
  const [pidInput, setPidInput] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [models, setModels] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    void window.tangu?.listProviders?.().then((items: unknown) => { if (Array.isArray(items)) setExisting(items as DirectProviderConfig[]) }).catch(() => {})
  }, [])
  const pid = pidInput ?? (chosen ? presetProviderId(chosen.id, existing) : local ? 'ollama' : '')
  const url = urlInput ?? (chosen?.baseUrl || (local ? 'http://localhost:11434/v1' : ''))
  const name = chosen ? chosen.name || t(`prov.preset.${chosen.id}`) : ''
  const choose = (id: string): void => { setPreset(id); setPidInput(null); setUrlInput(null); setMsg('') }
  const save = async (): Promise<void> => {
    if (!window.tangu?.saveProvider) return
    setBusy(true); setMsg('')
    try {
      const ids = models.split(',').map((s) => s.trim()).filter(Boolean)
      await window.tangu.setConfig({ mode: 'managed' })
      await window.tangu.saveProvider({ providerId: pid.trim(), baseUrl: url.trim().replace(/\/+$/, ''), apiKey: key || undefined, modelIds: ids.length ? ids : undefined,
        ...(chosen?.protocol === 'anthropic-messages' ? { protocol: 'anthropic-messages' } : {}) })
      onDone(true)
    } catch (e) { setMsg(t('onboarding.connect.saveFail', { e: errText(e) })); setBusy(false) }
  }
  const test = (): void => {
    void resolveTarget().then((target) => testProviderConnection(target, {
      baseUrl: url, apiKey: key || undefined, modelId: models.split(',').map((s) => s.trim()).filter(Boolean)[0],
    })).then((r) => setMsg(`${r.success ? '✓' : '✗'} ${r.message}`)).catch((e) => setMsg(t('onboarding.connect.testFail', { e: errText(e) })))
  }
  const openKeyPage = (href: string): void => {
    if (window.tangu?.openExternal) void window.tangu.openExternal(href)
    else window.open(href, '_blank', 'noopener')
  }
  const pidField = <label>{t('onboarding.connect.providerIdLabel')}<input value={pid} onChange={(e) => setPidInput(e.target.value.trim())} placeholder={t('onboarding.connect.providerIdPlaceholder')} /></label>
  const keyField = (label: string) => <label>{label}<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={local ? '' : 'sk-…'} /></label>
  const urlField = <label>{t('onboarding.connect.baseUrlLabel')}<input value={url} onChange={(e) => setUrlInput(e.target.value.trim())} placeholder="http://localhost:11434/v1" /></label>
  const listField = <label>{t('onboarding.connect.modelWhitelistLabel')}<input value={models} onChange={(e) => setModels(e.target.value)} placeholder="llama3, qwen2.5-coder" /></label>
  return <div className="ob3-form" data-ob-keyform="" data-preset={preset || 'custom'}>
    {!local && <>
      <span className="ob3-sub">{t('ob3.key.pick')}</span>
      <div className="ob3-pick" role="group" aria-label={t('prov.preset')}>
        {PROVIDER_PRESETS.map((x) => <button key={x.id} type="button" className="ob3-pill" data-preset={x.id} aria-pressed={preset === x.id} onClick={() => choose(x.id)}>{x.name || t(`prov.preset.${x.id}`)}</button>)}
        <button type="button" className="ob3-pill" data-preset="" aria-pressed={!chosen} onClick={() => choose('')}>{t('ob3.key.custom')}</button>
      </div>
    </>}
    {custom ? <>
      <div className="ob3-form-row">{pidField}{keyField(t('onboarding.connect.apiKeyLabel'))}</div>
      {urlField}{listField}
    </> : <>
      {keyField(t('ob3.key.keyFor', { name }))}
      {chosen?.keyUrl && <button type="button" className="ob3-link ob3-keyurl" onClick={() => openKeyPage(chosen.keyUrl!)}>{t('ob3.key.getKey', { name })}<ExternalLink size={11} aria-hidden="true" /></button>}
      <button type="button" className="ob3-adv" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}><ChevronRight size={13} aria-hidden="true" />{t('ob3.key.advanced')}</button>
      {advanced && <>{pidField}{urlField}{listField}</>}
    </>}
    <div className="ob3-actions">
      <button type="button" className="btn primary sm" disabled={busy || !pid || !url || (!custom && !key)} onClick={() => void save()}>{busy ? <Loader2 size={12} className="spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}{t('onboarding.connect.saveAndStart')}</button>
      <button type="button" className="btn quiet sm" disabled={!url} onClick={test}>{t('onboarding.connect.testConnection')}</button>
      <button type="button" className="ob3-link" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => onDone(false)}>{t('ob3.channels.back')}</button>
    </div>
    {msg && <div className="ob3-feedback" role="status">{msg}</div>}
  </div>
}

const IMPROVE_ROWS: Array<[typeof Bug, string]> = [[Bug, 'onboarding.improve.crash'], [Bot, 'onboarding.improve.agent'], [Gauge, 'onboarding.improve.perf'], [MousePointerClick, 'onboarding.improve.usage']]

/**
 * 「帮助改进 Forsion」:开关 + 很小的 ⓘ。只在登录后能开(Extend 视图带 signedIn 时以它为准,老 Extend 用登录状态顶)。
 * 登录后、还没看过告知:详情自动弹一次,弹出来就记 noticeSeen(契约 §5:露出才算看过;不列「不会发送」)。
 * 本机的 Extend 没有遥测通道 → 整行不出现。
 */
export function ImproveRow({ signedIn }: { signedIn: boolean }): React.ReactNode {
  const { t } = useI18n()
  const [view, setView] = useState<TelemetryView | null | false>(() => (improveOnThisHost() ? null : false))
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (view === false) return
    let live = true
    void readTelemetry().then((v) => { if (live) setView(v ?? false) })
    return () => { live = false }
    // 登录前后各读一次:Extend 的 signedIn 跟着变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])
  const set = (patch: { enabled?: boolean; noticeSeen?: true }): Promise<void> => {
    const run = chain.current.then(async () => {
      const next = asTelemetryView(await window.tangu?.cloudInvoke?.('telemetry:set', patch))
      if (next) setView(next)
    })
    chain.current = run.catch(() => {})
    return run
  }
  const can = !!view && (view.signedIn ?? signedIn)
  // 登录了、还没看过告知:自动弹一次
  useEffect(() => { if (can && view && !view.noticeSeen) setOpen(true) }, [can, view])
  useEffect(() => { if (open && view && !view.noticeSeen) void set({ noticeSeen: true }).catch(() => {}) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!rowRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  if (!view) return null
  const toggle = (enabled: boolean): void => {
    setBusy(true); setError('')
    void set({ enabled }).catch((e) => setError(t('ob3.saveFail', { error: errText(e) }))).finally(() => setBusy(false))
  }
  const openPrivacy = (): void => {
    if (window.tangu?.openExternal) void window.tangu.openExternal(FORSION_PRIVACY_URL)
    else window.open(FORSION_PRIVACY_URL, '_blank', 'noopener')
  }
  return <div className="ob3-tele" ref={rowRef} data-ob-improve="">
    <ShieldCheck size={16} aria-hidden="true" />
    <div><strong>{t('onboarding.improve.title')}</strong>
      <button type="button" className="ob3-info" aria-label={t('ob3.improve.details')} aria-expanded={open} onClick={() => setOpen((o) => !o)}><Info size={13} aria-hidden="true" /></button>
      <small>{error || t(can ? 'ob3.improve.on' : 'ob3.improve.signedOut')}</small></div>
    <SettingsSwitch checked={can && view.enabled} disabled={!can || busy} onChange={toggle} label={t('onboarding.improve.title')} />
    {open && <div className="ob3-pop" role="dialog" aria-label={t('onboarding.improve.title')}>
      <b>{t('onboarding.improve.title')}</b><span>{t('onboarding.improve.summary')}</span>
      <ul>{IMPROVE_ROWS.map(([Icon, k]) => <li key={k}><Icon size={12} aria-hidden="true" />{t(k)}</li>)}</ul>
      <button type="button" className="ob3-link" onClick={openPrivacy}>{t('onboarding.improve.privacy')}<ChevronRight size={12} aria-hidden="true" /></button>
    </div>}
  </div>
}
