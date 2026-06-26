/**
 * 首启引导向导:① 连接(Forsion 账号登录 / 自定义 provider)→ ② 默认模型 → ③ 环境检测(缺失项
 * 给平台安装命令,用户确认后内置日志面板执行——绝不静默自动装)→ ④ 完成(指路导入/设置)。
 * 触发条件见 App.tsx(managed 从未配置:无 cloudUrl/token/provider);「跳过」永久记 localStorage。
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  ArrowRight, ArrowLeft, Check, Cloud, KeyRound, Loader2, LogIn, ExternalLink,
  MonitorCheck, Play, SkipForward, Sparkles, Palette, FolderOpen, Sun, Moon, X,
} from 'lucide-react'
import { listModels, testProviderConnection } from '../services/backendService'
import type { EnvProbeResult, ModelsResponse } from '../types'
import { useI18n } from '../i18n'
import { listThemes } from '../theme/registry'
import { applyTheme } from '../theme/loader'
import { ThemeCard } from './ThemeCard'

export const ONBOARDING_DISMISS_KEY = 'forsion_tangu_onboarding_done'

type Step = 'connect' | 'theme' | 'model' | 'workspace' | 'env' | 'done'
const STEP_ORDER: Step[] = ['connect', 'theme', 'model', 'workspace', 'env', 'done']

export const OnboardingWizard: React.FC<{
  /** 当前主题/明暗(与 App 同步;主题步骤即时应用 + 持久化)。 */
  themePreset: string
  themeMode: 'light' | 'dark'
  themeSeed: string
  onThemeChange: (preset: string, mode: 'light' | 'dark') => void
  onSeedChange: (hex: string) => void
  /** 向导内动作改变了主配置(登录成功/保存 provider)→ App 重连。 */
  onReconnect: () => void
  onFinish: () => void
}> = ({ themePreset, themeMode, themeSeed, onThemeChange, onSeedChange, onReconnect, onFinish }) => {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('connect')
  const stepIdx = STEP_ORDER.indexOf(step)

  // ── ① 连接 ──
  const [connectMode, setConnectMode] = useState<'forsion' | 'byok'>('forsion')
  const [cloudUrl, setCloudUrl] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const [device, setDevice] = useState<{ url: string; userCode: string } | null>(null)
  const [connectMsg, setConnectMsg] = useState('')
  // byok 表单
  const [pid, setPid] = useState('')
  const [purl, setPurl] = useState('')
  const [pkey, setPkey] = useState('')
  const [pmodels, setPmodels] = useState('')
  const [byokSaved, setByokSaved] = useState(false)
  const [byokTesting, setByokTesting] = useState(false)

  useEffect(() => {
    void window.tangu?.authStatus?.().then((a) => {
      setCloudUrl((u) => u || a.cloudUrl || '')
      setLoggedIn(a.loggedIn)
    })
    const off = window.tangu?.onAuthDevice?.((info) => setDevice(info))
    return () => off?.()
  }, [])

  const doLogin = async (): Promise<void> => {
    if (!window.tangu?.forsionLogin) return
    setLoggingIn(true)
    setConnectMsg('')
    setDevice(null)
    try {
      await window.tangu.setConfig({ mode: 'managed', cloudUrl })
      await window.tangu.forsionLogin(cloudUrl)
      setLoggedIn(true)
      setConnectMsg(t('onboarding.connect.loginOk'))
      onReconnect()
    } catch (e: any) {
      setConnectMsg(String(e?.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setLoggingIn(false)
      setDevice(null)
    }
  }

  const saveByok = async (): Promise<void> => {
    if (!window.tangu?.saveProvider) return
    setByokTesting(true)
    setConnectMsg('')
    try {
      const modelIds = pmodels.split(',').map((s) => s.trim()).filter(Boolean)
      await window.tangu.setConfig({ mode: 'managed' })
      await window.tangu.saveProvider({
        providerId: pid.trim(),
        baseUrl: purl.trim().replace(/\/+$/, ''),
        apiKey: pkey || undefined,
        modelIds: modelIds.length ? modelIds : undefined,
      })
      setByokSaved(true)
      setConnectMsg(t('onboarding.connect.providerSaved'))
      onReconnect()
    } catch (e: any) {
      setConnectMsg(t('onboarding.connect.saveFail', { e: e?.message || e }))
    } finally {
      setByokTesting(false)
    }
  }

  // ── ③ 默认模型 ──
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [chosenModel, setChosenModel] = useState('')

  // ── ④ 默认本地工作区目录 ──
  const [workspaceDir, setWorkspaceDir] = useState('')
  useEffect(() => {
    void window.tangu?.getConfig?.().then((c) => setWorkspaceDir(c.defaultWorkspaceDir || '')).catch(() => {})
  }, [])

  const loadStepModels = (): void => {
    setModelsLoading(true)
    void window.tangu?.getConfig().then((c) =>
      listModels({ backendUrl: c.backendUrl, token: c.token, modelId: '' })
        .then((m) => {
          setModels(m)
          setChosenModel((cur) => cur || m.defaultModelId || m.models[0]?.id || '')
        })
        .catch(() => setModels(null))
        .finally(() => setModelsLoading(false)),
    )
  }
  useEffect(() => {
    if (step === 'model') loadStepModels()
    if (step === 'env') void doEnvCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // ── ③ 环境检测 ──
  const [probes, setProbes] = useState<EnvProbeResult[] | null>(null)
  const [envChecking, setEnvChecking] = useState(false)
  const [runningInstall, setRunningInstall] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  const doEnvCheck = async (): Promise<void> => {
    if (!window.tangu?.envCheck) return
    setEnvChecking(true)
    try {
      setProbes(await window.tangu.envCheck())
    } finally {
      setEnvChecking(false)
    }
  }

  useEffect(() => {
    const off = window.tangu?.onEnvOutput?.((ev) => {
      setInstallLog((prev) => [...prev.slice(-400), ...ev.line.split('\n').filter(Boolean)])
      requestAnimationFrame(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight))
    })
    return () => off?.()
  }, [])

  const runInstall = async (p: EnvProbeResult): Promise<void> => {
    if (!p.installId || !window.tangu?.envRun) return
    if (!window.confirm(t('onboarding.env.installConfirm', { command: p.installCommand }))) return
    setRunningInstall(p.installId)
    setInstallLog([])
    try {
      await window.tangu.envRun(p.installId)
      await doEnvCheck() // 装完重测
    } finally {
      setRunningInstall(null)
    }
  }

  const finish = (): void => {
    try { localStorage.setItem(ONBOARDING_DISMISS_KEY, '1') } catch { /* ignore */ }
    onFinish()
  }

  const connectReady = loggedIn || byokSaved

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="modal modal-md">
        <div className="modal-head">
          <Sparkles size={15} style={{ marginRight: 6 }} />
          {t('onboarding.title')}
          <span className="grow" />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{stepIdx + 1} / {STEP_ORDER.length}</span>
        </div>
        <div className="modal-body">
          {step === 'connect' && (
            <>
              <div className="field">
                <label>{t('onboarding.connect.stepLabel')}</label>
                <div className="seg">
                  <button className={connectMode === 'forsion' ? 'active' : ''} onClick={() => setConnectMode('forsion')}>
                    <Cloud size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.connect.modeForsion')}
                  </button>
                  <button className={connectMode === 'byok' ? 'active' : ''} onClick={() => setConnectMode('byok')}>
                    <KeyRound size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.connect.modeByok')}
                  </button>
                </div>
              </div>
              {connectMode === 'forsion' ? (
                <>
                  {/* 云端地址只由环境变量 TANGU_CLOUD_URL / 内置默认决定,引导界面不再展示/编辑(与设置一致)。 */}
                  <div className="hint" style={{ marginBottom: 8 }}>{t('onboarding.connect.forsionHint')}</div>
                  <button className="btn primary sm" disabled={loggingIn} onClick={() => void doLogin()}>
                    {loggingIn ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />} {t('onboarding.connect.loginViaBrowser')}
                  </button>
                  {device && (
                    <div className="hint" style={{ marginTop: 6 }}>
                      {t('onboarding.connect.browserNotOpened')}
                      <a href={device.url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                        {device.url} <ExternalLink size={10} style={{ verticalAlign: -1 }} />
                      </a>
                      {device.userCode ? <> · {t('onboarding.connect.verifyCode')} <b>{device.userCode}</b></> : null}
                    </div>
                  )}
                  {loggedIn && <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.connect.loggedIn')}</div>}
                </>
              ) : (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label>{t('onboarding.connect.providerIdLabel')}</label>
                      <input type="text" value={pid} onChange={(e) => setPid(e.target.value.trim())} placeholder={t('onboarding.connect.providerIdPlaceholder')} />
                    </div>
                    <div className="field">
                      <label>{t('onboarding.connect.apiKeyLabel')}</label>
                      <input type="password" value={pkey} onChange={(e) => setPkey(e.target.value)} placeholder="sk-…" />
                    </div>
                  </div>
                  <div className="field">
                    <label>{t('onboarding.connect.baseUrlLabel')}</label>
                    <input type="text" value={purl} onChange={(e) => setPurl(e.target.value.trim())} placeholder="http://localhost:11434/v1" />
                  </div>
                  <div className="field">
                    <label>{t('onboarding.connect.modelWhitelistLabel')}</label>
                    <input type="text" value={pmodels} onChange={(e) => setPmodels(e.target.value)} placeholder="llama3, qwen2.5-coder" />
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className="btn primary sm" disabled={byokTesting || !pid || !purl} onClick={() => void saveByok()}>
                      {byokTesting ? <Loader2 size={12} className="spin" /> : <Check size={12} />} {t('onboarding.connect.saveAndStart')}
                    </button>
                    <button
                      className="btn ghost sm"
                      disabled={!purl}
                      onClick={() => {
                        void window.tangu?.getConfig().then((c) =>
                          testProviderConnection({ backendUrl: c.backendUrl, token: c.token, modelId: '' }, {
                            baseUrl: purl, apiKey: pkey || undefined,
                            modelId: pmodels.split(',').map((s) => s.trim()).filter(Boolean)[0],
                          }).then((r) => setConnectMsg(`${r.success ? '✓' : '✗'} ${r.message}`))
                            .catch((e) => setConnectMsg(t('onboarding.connect.testFail', { e: e?.message || e }))),
                        )
                      }}
                    >
                      {t('onboarding.connect.testConnection')}
                    </button>
                  </div>
                </>
              )}
              {connectMsg && <div className="hint" style={{ marginTop: 8 }}>{connectMsg}</div>}
            </>
          )}

          {step === 'theme' && (
            <>
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Palette size={13} /> {t('onboarding.theme.stepLabel')}
                </label>
                <div className="theme-grid">
                  {listThemes().map((th) => (
                    <ThemeCard
                      key={th.manifest.id}
                      entry={th}
                      mode={themeMode}
                      active={th.manifest.id === themePreset}
                      onSelect={() => { applyTheme(th.manifest.id, themeMode, { customColor: themeSeed }); onThemeChange(th.manifest.id, themeMode) }}
                    />
                  ))}
                </div>
              </div>
              {themePreset === 'custom' && (
                <div className="field">
                  <label>{t('onboarding.theme.customSeedLabel')}</label>
                  <input
                    type="color"
                    value={themeSeed}
                    onChange={(e) => { applyTheme('custom', themeMode, { customColor: e.target.value }); onSeedChange(e.target.value) }}
                    aria-label={t('onboarding.theme.customSeedLabel')}
                    style={{ width: 48, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </div>
              )}
              <div className="field">
                <label>{t('onboarding.theme.modeLabel')}</label>
                <div className="seg">
                  <button className={themeMode === 'light' ? 'active' : ''} onClick={() => { applyTheme(themePreset, 'light', { customColor: themeSeed }); onThemeChange(themePreset, 'light') }}>
                    <Sun size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.theme.light')}
                  </button>
                  <button className={themeMode === 'dark' ? 'active' : ''} onClick={() => { applyTheme(themePreset, 'dark', { customColor: themeSeed }); onThemeChange(themePreset, 'dark') }}>
                    <Moon size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.theme.dark')}
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.theme.hint')}</div>
              </div>
            </>
          )}

          {step === 'model' && (
            <>
              <div className="field">
                <label>{t('onboarding.model.stepLabel')}</label>
                {modelsLoading && <div className="hint">{t('onboarding.model.loading')}</div>}
                {!modelsLoading && !models?.models.length && (
                  <div className="hint">
                    {t('onboarding.model.empty')}
                    <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={loadStepModels}>{t('onboarding.model.refresh')}</button>
                  </div>
                )}
                {!!models?.models.length && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {models.models.map((m) => (
                      <button key={`${m.source}-${m.id}`} className="file-row" onClick={() => setChosenModel(m.id)}>
                        <span className="file-name" style={{ color: m.id === chosenModel ? 'var(--accent)' : undefined }}>
                          {m.id === chosenModel ? '● ' : ''}{m.name}
                        </span>
                        <span className="file-size">{m.source === 'direct' ? t('onboarding.model.directSource', { provider: m.provider }) : m.provider}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {step === 'workspace' && (
            <>
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FolderOpen size={13} /> {t('onboarding.workspace.stepLabel')}
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={workspaceDir}
                    onChange={(e) => setWorkspaceDir(e.target.value)}
                    placeholder={t('onboarding.workspace.placeholder')}
                  />
                  <button
                    className="btn ghost sm"
                    onClick={() => void window.tangu?.pickDirectory?.().then((d) => { if (d) setWorkspaceDir(d) })}
                  >
                    <FolderOpen size={12} /> {t('onboarding.workspace.pick')}
                  </button>
                  {workspaceDir && (
                    <button className="btn ghost sm" onClick={() => setWorkspaceDir('')}>
                      <X size={12} /> {t('onboarding.workspace.clear')}
                    </button>
                  )}
                </div>
                <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.workspace.hint')}</div>
              </div>
            </>
          )}

          {step === 'env' && (
            <>
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <MonitorCheck size={13} /> {t('onboarding.env.stepLabel')}
                </label>
                {envChecking && <div className="hint">{t('onboarding.env.checking')}</div>}
                {probes?.map((pr) => (
                  <div key={pr.tool} className="file-row" style={{ cursor: 'default' }}>
                    <span className="file-name">
                      {pr.found ? '✅' : '⚠️'} <b>{pr.tool}</b>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                        {pr.found ? pr.version : pr.tool === 'docker' ? t('onboarding.env.missingDocker') : pr.tool === 'npm' ? t('onboarding.env.missingNpm') : t('onboarding.env.missing')}
                      </span>
                    </span>
                    {!pr.found && pr.installId && (
                      <button
                        className="btn ghost sm"
                        disabled={runningInstall !== null}
                        title={pr.installCommand || ''}
                        onClick={() => void runInstall(pr)}
                      >
                        {runningInstall === pr.installId ? <Loader2 size={12} className="spin" /> : <Play size={12} />} {t('onboarding.env.install')}
                      </button>
                    )}
                  </div>
                ))}
                {installLog.length > 0 && (
                  <pre
                    ref={logRef}
                    style={{
                      marginTop: 8, fontSize: 11, fontFamily: 'var(--font-mono)', maxHeight: 160,
                      overflowY: 'auto', background: 'var(--bg-card)', padding: 8,
                      border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    }}
                  >
                    {installLog.join('\n')}
                  </pre>
                )}
                <div className="hint" style={{ marginTop: 6 }}>
                  {t('onboarding.env.hint')}
                </div>
              </div>
            </>
          )}

          {step === 'done' && (
            <div className="field">
              <label>{t('onboarding.done.label')}</label>
              <div className="panel-note" style={{ lineHeight: 1.8 }}>
                {t('onboarding.done.line1')}<br />
                {t('onboarding.done.line2')}<br />
                {t('onboarding.done.line3')}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            {stepIdx > 0 && step !== 'done' && (
              <button className="btn ghost sm" onClick={() => setStep(STEP_ORDER[stepIdx - 1])}>
                <ArrowLeft size={12} /> {t('onboarding.nav.prev')}
              </button>
            )}
            <span className="grow" />
            <button className="btn ghost sm" onClick={finish}>
              <SkipForward size={12} /> {t('onboarding.nav.skip')}
            </button>
            {step !== 'done' ? (
              <button
                className="btn primary sm"
                disabled={step === 'connect' && !connectReady}
                onClick={() => {
                  if (step === 'model' && chosenModel) {
                    void window.tangu?.setConfig({ modelId: chosenModel })
                  }
                  if (step === 'workspace') {
                    void window.tangu?.setConfig({ defaultWorkspaceDir: workspaceDir.trim() })
                  }
                  setStep(STEP_ORDER[stepIdx + 1])
                }}
              >
                {t('onboarding.nav.next')} <ArrowRight size={12} />
              </button>
            ) : (
              <button className="btn primary sm" onClick={finish}>
                {t('onboarding.nav.start')} <Check size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
