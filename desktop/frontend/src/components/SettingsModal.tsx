/**
 * 设置模态:连接 / 模型 / 主题(ThemeCard 网格 + 明暗 + 毛玻璃) / 高级。
 * tabs 形态对齐 AI Studio SettingsModal;连接页的 managed/external 切换在 M6 接 backendManager。
 */
import React, { useEffect, useState } from 'react'
import { X, Loader2, RefreshCw, Sun, Moon, RotateCcw, LogIn, LogOut, ExternalLink, KeyRound, Plus, Trash2, Plug, Search, Download, Sparkles, Wrench } from 'lucide-react'
import { AnimatedModalBackdrop, AnimatedModalContent, AnimatePresence } from './AnimatedUI'
import { ThemeCard } from './ThemeCard'
import { listThemes } from '../theme/registry'
import { applyTheme } from '../theme/loader'
import { testConnection } from '../services/agentRunService'
import { deleteUserCloudSkill, listModels, listSkills, listTools, testProviderConnection, uploadSkillToCloud } from '../services/backendService'
import type {
  AuthStatusInfo, BackendStatusInfo, DirectProviderConfig, DiscoveryResult, McpServerConfigEntry, ModelsResponse,
  SkillInfo, StoredDesktopConfig, TanguDesktopConfig, ToolsResponse,
} from '../types'
import { useI18n } from '../i18n'
import { LocaleToggle } from './LocaleToggle'
import { CHANGELOG } from '../changelog'
import { ModelGroupList } from './ModelGroupList'

type Tab = 'connection' | 'model' | 'mcp' | 'skills' | 'theme' | 'advanced' | 'developer' | 'about'

const DEV_MODE_KEY = 'forsion_tangu_dev_mode'

const ECO_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
}

// 技能渠道(agent 文件夹)分组顺序;可扩展:新增渠道(如 opencode 后端扫描接上后)只加一行,
// 空渠道自动不渲染。未知 source 落入「其他」兜底组。
const SKILL_CHANNELS: Array<{ key: NonNullable<SkillInfo['source']> | 'opencode'; labelKey: string }> = [
  { key: 'local', labelKey: 'settings.skills.channel.local' },
  { key: 'claude', labelKey: 'settings.skills.channel.claude' },
  { key: 'codex', labelKey: 'settings.skills.channel.codex' },
  { key: 'opencode', labelKey: 'settings.skills.channel.opencode' },
  { key: 'user', labelKey: 'settings.skills.channel.user' },
  { key: 'cloud', labelKey: 'settings.skills.channel.cloud' },
]

const BACKEND_STATE_LABEL: Record<string, string> = {
  stopped: 'settings.backend.state.stopped',
  starting: 'settings.backend.state.starting',
  ready: 'settings.backend.state.ready',
  crashed: 'settings.backend.state.crashed',
}

export const SettingsModal: React.FC<{
  open: boolean
  cfg: TanguDesktopConfig
  themePreset: string
  themeMode: 'light' | 'dark'
  glassOn: boolean
  onClose: () => void
  onConfigChange: (patch: Partial<TanguDesktopConfig>) => void
  onThemeChange: (preset: string, mode: 'light' | 'dark') => void
  onGlassChange: (on: boolean) => void
  /** patch 随调用传入:避免「setState 未刷新就重连」的旧值竞态。 */
  onReconnect: (patch?: Partial<TanguDesktopConfig>) => void
  /** 开发者选项里「重新进入引导」回调(由 App 控制 onboarding 显隐)。 */
  onRelaunchOnboarding?: () => void
}> = (p) => {
  const { t, locale } = useI18n()
  const [tab, setTab] = useState<Tab>('connection')
  const [appVersion, setAppVersion] = useState<string>('')
  // 开发者模式:关于页连点版本号 10 次解锁(持久化);解锁后多出「开发者选项」tab。
  const [devMode, setDevMode] = useState<boolean>(() => {
    try { return localStorage.getItem(DEV_MODE_KEY) === '1' } catch { return false }
  })
  const [devClicks, setDevClicks] = useState(0)
  const [devMsg, setDevMsg] = useState('')
  const [draft, setDraft] = useState(p.cfg)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  // Electron 托管后端(window.tangu 缺省=浏览器调试,隐藏 managed UI)
  const isDesktop = !!window.tangu?.backendStatus
  const [stored, setStored] = useState<StoredDesktopConfig | null>(null)
  const [backendSt, setBackendSt] = useState<BackendStatusInfo | null>(null)
  const [logs, setLogs] = useState<string[] | null>(null)
  // Forsion 账号 / provider OAuth 登录态
  const [authSt, setAuthSt] = useState<AuthStatusInfo | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [device, setDevice] = useState<{ url: string; userCode: string } | null>(null)
  const [providers, setProviders] = useState<Array<{ id: string; loggedIn: boolean }> | null>(null)
  const [providerBusy, setProviderBusy] = useState<string | null>(null)
  // 直连 provider 配置(~/.tangu/providers.json)
  const [customProviders, setCustomProviders] = useState<DirectProviderConfig[]>([])
  const [editProvider, setEditProvider] = useState<(DirectProviderConfig & { modelsCsv: string }) | null>(null)
  const [providerTestMsg, setProviderTestMsg] = useState('')
  const [providerTesting, setProviderTesting] = useState(false)
  const [providerSaveMsg, setProviderSaveMsg] = useState('')

  const refreshCustomProviders = (): void => {
    void window.tangu?.listProviders?.().then(setCustomProviders).catch(() => setCustomProviders([]))
  }
  // MCP 配置(~/.tangu/mcp.json)+ 后端实际连接状态(GET /agent/tools 的 mcp 分区)
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerConfigEntry>>({})
  const [mcpStatus, setMcpStatus] = useState<ToolsResponse['mcp']>(undefined)
  const [editMcp, setEditMcp] = useState<{ name: string; isNew: boolean; command: string; argsText: string; url: string; transport: 'auto' | 'stdio' | 'http' | 'sse'; envText: string } | null>(null)
  const [mcpMsg, setMcpMsg] = useState('')

  const refreshMcp = (): void => {
    void window.tangu?.readMcpConfig?.().then((c) => setMcpServers(c.mcpServers)).catch(() => setMcpServers({}))
    void listTools(p.cfg).then((t) => setMcpStatus(t.mcp ?? [])).catch(() => setMcpStatus([]))
  }

  const writeMcp = (next: Record<string, McpServerConfigEntry>, msg: string): void => {
    void window.tangu!.writeMcpConfig!({ mcpServers: next }).then((c) => {
      setMcpServers(c.mcpServers)
      setMcpMsg(msg)
    }).catch((e) => setMcpMsg(`${t('settings.toast.saveFailed')}${e?.message || e}`))
  }

  // 技能库(设置→技能 tab):列表 + 本地→云端上传 + 删除本人云端技能
  const [allSkills, setAllSkills] = useState<SkillInfo[] | null>(null)
  const [allSkillsLoading, setAllSkillsLoading] = useState(false)
  const [skillBusy, setSkillBusy] = useState<string | null>(null)
  const [skillMsg, setSkillMsg] = useState('')

  const loadAllSkills = (): void => {
    setAllSkillsLoading(true)
    void listSkills(p.cfg)
      .then(setAllSkills)
      .catch((e) => setSkillMsg(`${t('settings.skills.loadFailed')}${e?.message || e}`))
      .finally(() => setAllSkillsLoading(false))
  }

  const doUploadSkill = async (id: string): Promise<void> => {
    setSkillBusy(id)
    setSkillMsg('')
    try {
      const r = await uploadSkillToCloud(p.cfg, id)
      setSkillMsg(t('settings.skills.uploadOk', { name: r.name, id: r.id }))
      loadAllSkills()
    } catch (e: any) {
      setSkillMsg(`${t('settings.skills.uploadFailed')}${e?.message || e}`)
    } finally {
      setSkillBusy(null)
    }
  }

  const doDeleteUserSkill = async (id: string): Promise<void> => {
    if (!window.confirm(t('settings.skills.deleteConfirm', { id }))) return
    setSkillBusy(id)
    setSkillMsg('')
    try {
      await deleteUserCloudSkill(p.cfg, id)
      setSkillMsg(t('settings.skills.deleteOk'))
      loadAllSkills()
    } catch (e: any) {
      setSkillMsg(`${t('settings.skills.deleteFailed')}${e?.message || e}`)
    } finally {
      setSkillBusy(null)
    }
  }

  const refreshAuth = (): void => {
    if (!window.tangu?.authStatus) return
    void window.tangu.authStatus().then(setAuthSt).catch(() => setAuthSt(null))
    void window.tangu.authProviders?.().then(setProviders).catch(() => setProviders([]))
  }

  // 跨生态资产发现/导入(高级页;扫 ~/.claude、~/.codex、~/.hermes)
  const [disc, setDisc] = useState<DiscoveryResult | null>(null)
  const [discScanning, setDiscScanning] = useState(false)
  const [discImporting, setDiscImporting] = useState(false)
  const [discSelSkills, setDiscSelSkills] = useState<Set<string>>(new Set())
  const [discSelMcp, setDiscSelMcp] = useState<Set<string>>(new Set())
  const [discMsg, setDiscMsg] = useState('')

  const toggleSel = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string): void => {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const doDiscScan = async (): Promise<void> => {
    if (!window.tangu?.discoveryScan) return
    setDiscScanning(true)
    setDiscMsg('')
    setDiscSelSkills(new Set())
    setDiscSelMcp(new Set())
    try {
      setDisc(await window.tangu.discoveryScan())
    } catch (e: any) {
      setDisc(null)
      setDiscMsg(`${t('settings.discovery.scanFailed')}${e?.message || e}`)
    } finally {
      setDiscScanning(false)
    }
  }

  const doDiscImport = async (): Promise<void> => {
    setDiscImporting(true)
    setDiscMsg('')
    try {
      const skillIds = [...discSelSkills]
      // MCP 勾选 key 为 `生态:名称`,导入按名称(去重)
      const mcpNames = [...new Set([...discSelMcp].map((k) => k.slice(k.indexOf(':') + 1)))]
      const r1 = skillIds.length ? await window.tangu!.discoveryImportSkills!(skillIds) : { imported: [] }
      const r2 = mcpNames.length ? await window.tangu!.discoveryImportMcp!(mcpNames) : { imported: [] }
      setDiscSelSkills(new Set())
      setDiscSelMcp(new Set())
      if (r2.imported.length) refreshMcp() // MCP 页同步看到导入项(未启用)
      setDiscMsg(t('settings.discovery.importOk', { skills: r1.imported.length, mcp: r2.imported.length }))
    } catch (e: any) {
      setDiscMsg(`${t('settings.discovery.importFailed')}${e?.message || e}`)
    } finally {
      setDiscImporting(false)
    }
  }

  useEffect(() => {
    if (p.open) {
      setDraft(p.cfg)
      setTestResult('')
      setLogs(null)
      setDevice(null)
      if (isDesktop) {
        void window.tangu!.getConfig().then(setStored)
        void window.tangu!.backendStatus!().then(setBackendSt)
        refreshAuth()
        refreshCustomProviders()
      }
    }
  }, [p.open, p.cfg, isDesktop])

  useEffect(() => {
    if (!p.open || !isDesktop) return
    const off1 = window.tangu!.onBackendStatus?.((st) => setBackendSt(st))
    const off2 = window.tangu!.onAuthDevice?.((info) => setDevice(info))
    return () => {
      off1?.()
      off2?.()
    }
  }, [p.open, isDesktop])

  const doForsionLogin = async (): Promise<void> => {
    if (!window.tangu?.forsionLogin) return
    setLoggingIn(true)
    setDevice(null)
    try {
      const r = await window.tangu.forsionLogin(stored?.cloudUrl || undefined)
      setStored((s) => (s ? { ...s, cloudUrl: r.cloudUrl } : s))
      refreshAuth()
      p.onReconnect()
    } catch (e: any) {
      setTestResult(String(e?.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setLoggingIn(false)
      setDevice(null)
    }
  }

  const doProviderLogin = async (id: string): Promise<void> => {
    if (!window.tangu?.providerLogin) return
    setProviderBusy(id)
    try {
      await window.tangu.providerLogin(id)
      refreshAuth()
    } catch (e: any) {
      setTestResult(String(e?.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setProviderBusy(null)
    }
  }

  const mode = stored?.mode || 'external'
  const setMode = (m: 'managed' | 'external') => {
    void window.tangu!.setConfig({ mode: m }).then(setStored)
  }
  const saveManaged = () => {
    if (!stored) return
    void window.tangu!.setConfig({
      mode: 'managed',
      cloudUrl: stored.cloudUrl,
      cloudToken: stored.cloudToken,
      sandbox: stored.sandbox,
    }).then(setStored)
  }

  const loadModels = async () => {
    setModelsLoading(true)
    try {
      setModels(await listModels(draft))
    } catch (e: any) {
      setModels(null)
      setTestResult(e?.message || t('settings.model.loadFailed'))
    } finally {
      setModelsLoading(false)
    }
  }

  useEffect(() => {
    if (p.open && tab === 'model' && !models && !modelsLoading) void loadModels()
    if (p.open && tab === 'mcp') refreshMcp()
    if (p.open && tab === 'skills' && !allSkills && !allSkillsLoading) loadAllSkills()
    if (p.open && tab === 'about' && !appVersion) void window.tangu?.appVersion?.().then((v) => setAppVersion(v || '')).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, tab])

  const test = async () => {
    setTesting(true)
    const r = await testConnection(draft)
    setTestResult(r.message)
    setTesting(false)
  }

  const saveConnection = () => {
    const patch = { backendUrl: draft.backendUrl.replace(/\/+$/, ''), token: draft.token }
    p.onConfigChange(patch)
    p.onReconnect(patch)
  }

  return (
    <AnimatePresence>
      {p.open && (
        <AnimatedModalBackdrop onClose={p.onClose}>
          <AnimatedModalContent>
            <div className="modal">
              <div className="modal-head">
                {t('settings.title')}
                <span className="grow" />
                <button className="icon-btn" onClick={p.onClose}>
                  <X size={16} />
                </button>
              </div>
              <div className="modal-tabs">
                {(
                  [
                    ['connection', t('settings.tab.connection')],
                    ['model', t('settings.tab.model')],
                    ...(isDesktop ? ([['mcp', 'MCP'], ['skills', t('settings.tab.skills')]] as Array<[Tab, string]>) : []),
                    ['theme', t('settings.tab.theme')],
                    ['advanced', t('settings.tab.advanced')],
                    ...(isDesktop && devMode ? ([['developer', t('settings.tab.developer')]] as Array<[Tab, string]>) : []),
                    ['about', t('settings.tab.about')],
                  ] as Array<[Tab, string]>
                ).map(([id, label]) => (
                  <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="modal-body">
                {tab === 'connection' && (
                  <>
                    {isDesktop && (
                      <div className="field">
                        <label>{t('settings.backend.modeLabel')}</label>
                        <div className="seg">
                          <button className={mode === 'managed' ? 'active' : ''} onClick={() => setMode('managed')}>
                            {t('settings.backend.modeManaged')}
                          </button>
                          <button className={mode === 'external' ? 'active' : ''} onClick={() => setMode('external')}>
                            {t('settings.backend.modeExternal')}
                          </button>
                        </div>
                      </div>
                    )}

                    {isDesktop && stored && (
                      <div className="field">
                        <label>{t('settings.workspace.label')}</label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            type="text"
                            value={stored.defaultWorkspaceDir || ''}
                            onChange={(e) => setStored({ ...stored, defaultWorkspaceDir: e.target.value })}
                            placeholder={t('settings.workspace.placeholder')}
                          />
                          <button
                            className="btn ghost sm"
                            onClick={() => void window.tangu?.pickDirectory?.().then((d) => {
                              if (d) void window.tangu!.setConfig({ defaultWorkspaceDir: d }).then(setStored)
                            })}
                          >
                            {t('settings.workspace.pick')}
                          </button>
                          <button
                            className="btn primary sm"
                            onClick={() => void window.tangu!.setConfig({ defaultWorkspaceDir: (stored.defaultWorkspaceDir || '').trim() }).then(setStored)}
                          >
                            {t('settings.btn.save')}
                          </button>
                        </div>
                        <div className="hint">
                          {t('settings.workspace.hint')}
                        </div>
                      </div>
                    )}

                    {isDesktop && mode === 'managed' && stored && (
                      <>
                        <div className="field-row">
                          <div className="field">
                            <label><KeyRound size={11} style={{ verticalAlign: -1 }} /> {t('settings.token.label')}</label>
                            <input
                              type="password"
                              value={stored.cloudToken}
                              onChange={(e) => setStored({ ...stored, cloudToken: e.target.value })}
                              placeholder={t('settings.token.placeholder')}
                            />
                          </div>
                          <div className="field" style={{ maxWidth: 160 }}>
                            <label>{t('settings.sandbox.label')}</label>
                            <select
                              value={stored.sandbox}
                              onChange={(e) => setStored({ ...stored, sandbox: e.target.value as any })}
                            >
                              <option value="auto">{t('settings.sandbox.auto')}</option>
                              <option value="docker">Docker</option>
                              <option value="none">{t('settings.sandbox.none')}</option>
                            </select>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                          <button className="btn primary sm" onClick={saveManaged}>{t('settings.backend.saveRestart')}</button>
                          <button
                            className="btn ghost sm"
                            onClick={() => void window.tangu!.backendRestart!().then(setBackendSt)}
                          >
                            <RotateCcw size={12} /> {t('settings.backend.restart')}
                          </button>
                          <span className={`conn-pill ${backendSt?.state === 'ready' ? 'ok' : backendSt?.state === 'crashed' ? 'err' : ''}`}>
                            <span className="dot" />
                            {t(BACKEND_STATE_LABEL[backendSt?.state || 'stopped'])}
                            {backendSt?.url ? ` · ${backendSt.url}` : ''}
                          </span>
                        </div>
                        {backendSt?.lastError && (
                          <div className="hint" style={{ color: 'var(--danger)' }}>{backendSt.lastError}</div>
                        )}
                        {backendSt?.staleDist && (
                          <div className="hint" style={{ color: 'var(--danger)' }}>
                            {t('settings.backend.staleDist')}
                          </div>
                        )}
                        <div className="field">
                          <button
                            className="btn ghost sm"
                            onClick={() => void window.tangu!.backendLogs!().then(setLogs)}
                          >
                            {t('settings.backend.viewLogs')}
                          </button>
                          {logs && (
                            <pre style={{
                              marginTop: 8, fontSize: 11, fontFamily: 'var(--font-mono)', maxHeight: 220,
                              overflowY: 'auto', background: 'var(--bg-card)', padding: 8,
                              border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                            }}>
                              {logs.length ? logs.join('\n') : t('settings.backend.noLogs')}
                            </pre>
                          )}
                        </div>
                      </>
                    )}

                    {(!isDesktop || mode === 'external') && (
                      <>
                        <div className="field">
                          <label>{t('settings.external.urlLabel')}</label>
                          <input
                            type="text"
                            value={draft.backendUrl}
                            onChange={(e) => setDraft({ ...draft, backendUrl: e.target.value })}
                            placeholder="http://localhost:8787"
                          />
                          <div className="hint">{t('settings.external.urlHint')}</div>
                        </div>
                        <div className="field">
                          <label>{t('settings.external.tokenLabel')}</label>
                          <input
                            type="password"
                            value={draft.token}
                            onChange={(e) => setDraft({ ...draft, token: e.target.value })}
                            placeholder={t('settings.external.tokenPlaceholder')}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button className="btn ghost sm" onClick={test} disabled={testing}>
                            {testing ? <Loader2 size={13} className="spin" /> : null} {t('settings.btn.testConnection')}
                          </button>
                          <button className="btn primary sm" onClick={saveConnection}>
                            {t('settings.btn.saveConnect')}
                          </button>
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{testResult}</span>
                        </div>
                      </>
                    )}
                  </>
                )}

                {tab === 'model' && (
                  <>
                    <div className="field">
                      <label>{t('settings.model.defaultLabel')}</label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          type="text"
                          value={draft.modelId}
                          onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                          placeholder={t('settings.model.defaultPlaceholder')}
                        />
                        <button className="btn ghost sm" onClick={() => p.onConfigChange({ modelId: draft.modelId })}>
                          {t('settings.btn.save')}
                        </button>
                      </div>
                      <div className="hint">
                        {t('settings.model.defaultHintPrefix')}<code>&lt;providerId&gt;/&lt;model&gt;</code>{t('settings.model.defaultHintSuffix')}
                      </div>
                    </div>
                    <div className="field">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {t('settings.model.availableLabel')}
                        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={loadModels}>
                          <RefreshCw size={12} className={modelsLoading ? 'spin' : ''} />
                        </button>
                      </label>
                      {models?.models.length ? (
                        <ModelGroupList
                          models={models.models}
                          selectedId={draft.modelId}
                          onSelect={(id) => {
                            setDraft({ ...draft, modelId: id })
                            p.onConfigChange({ modelId: id })
                          }}
                        />
                      ) : (
                        <div className="hint">{modelsLoading ? t('common.loading') : t('model.empty')}</div>
                      )}
                      {models?.forsion && models.forsion.status !== 'ok' && (
                        <div className="hint" style={{ color: models.forsion.status === 'error' ? 'var(--danger)' : undefined, marginTop: 6 }}>
                          {models.forsion.status === 'error' ? t('settings.model.cloudFetchError') : 'ℹ '}
                          {models.forsion.detail}
                        </div>
                      )}
                      {models?.directProviders.length ? (
                        <div className="hint">
                          {t('settings.model.directProviders')}{models.directProviders.map((d) => d.providerId).join('、')}
                        </div>
                      ) : null}
                    </div>

                    {isDesktop && providers && providers.length > 0 && (
                      <div className="field">
                        <label>{t('settings.provider.loginLabel')}</label>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {providers.map((pr) => (
                            <button
                              key={pr.id}
                              className="btn ghost sm"
                              disabled={providerBusy === pr.id}
                              onClick={() => void doProviderLogin(pr.id)}
                            >
                              {providerBusy === pr.id ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />}
                              {pr.id}
                              {pr.loggedIn ? t('settings.provider.loggedInSuffix') : ''}
                            </button>
                          ))}
                        </div>
                        <div className="hint">
                          {t('settings.provider.loginHintPrefix')}<code>provider/model</code>{t('settings.provider.loginHintSuffix')}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {tab === 'model' && isDesktop && (
                  <>
                    <div className="panel-section-title" style={{ marginTop: 8, padding: '12px 0 6px', borderTop: 'var(--border-width) solid var(--border)' }}>
                      {t('settings.customProvider.sectionTitle')}
                    </div>
                    <div className="field">
                      <label>{t('settings.customProvider.label')}</label>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        {t('settings.customProvider.introPrefix')}<code>--providers-file</code>{t('settings.customProvider.introMid')}<code>providerId/model</code>{t('settings.customProvider.introSuffix')}
                      </div>
                      {customProviders.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                          {customProviders.map((cp) => (
                            <div key={cp.providerId} className="file-row" style={{ cursor: 'default' }}>
                              <span className="file-name">
                                <b>{cp.providerId}</b>
                                <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{cp.baseUrl}</span>
                              </span>
                              <span className="file-size">
                                {cp.modelIds?.length ? t('settings.customProvider.modelCount', { count: cp.modelIds.length }) : t('settings.customProvider.anyModel')}
                                {cp.apiKey ? ' · key✓' : ''}
                              </span>
                              <button
                                className="icon-btn"
                                title={t('settings.btn.edit')}
                                onClick={() => {
                                  setEditProvider({ ...cp, modelsCsv: (cp.modelIds || []).join(', ') })
                                  setProviderTestMsg('')
                                  setProviderSaveMsg('')
                                }}
                              >
                                <KeyRound size={13} />
                              </button>
                              <button
                                className="icon-btn"
                                title={t('settings.btn.delete')}
                                onClick={() => {
                                  if (!window.confirm(t('settings.customProvider.deleteConfirm', { id: cp.providerId }))) return
                                  void window.tangu!.deleteProvider!(cp.providerId).then((list) => {
                                    setCustomProviders(list)
                                    setProviderSaveMsg(t('settings.customProvider.deletedReloading'))
                                  })
                                }}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {!editProvider && (
                        <button
                          className="btn ghost sm"
                          onClick={() => {
                            setEditProvider({ providerId: '', baseUrl: '', apiKey: '', modelIds: [], modelsCsv: '' })
                            setProviderTestMsg('')
                            setProviderSaveMsg('')
                          }}
                        >
                          <Plus size={13} /> {t('settings.customProvider.add')}
                        </button>
                      )}
                      {providerSaveMsg && !editProvider && (
                        <div className="hint" style={{ marginTop: 6 }}>{providerSaveMsg}</div>
                      )}
                    </div>

                    {editProvider && (
                      <>
                        <div className="field-row">
                          <div className="field">
                            <label>{t('settings.customProvider.idLabel')}</label>
                            <input
                              type="text"
                              value={editProvider.providerId}
                              onChange={(e) => setEditProvider({ ...editProvider, providerId: e.target.value.trim() })}
                              placeholder={t('settings.customProvider.idPlaceholder')}
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label>{t('settings.customProvider.baseUrlLabel')}</label>
                          <input
                            type="text"
                            value={editProvider.baseUrl}
                            onChange={(e) => setEditProvider({ ...editProvider, baseUrl: e.target.value.trim() })}
                            placeholder={t('settings.customProvider.baseUrlPlaceholder')}
                          />
                        </div>
                        <div className="field-row">
                          <div className="field">
                            <label>{t('settings.customProvider.apiKeyLabel')}</label>
                            <input
                              type="password"
                              value={editProvider.apiKey || ''}
                              onChange={(e) => setEditProvider({ ...editProvider, apiKey: e.target.value })}
                              placeholder="sk-…"
                            />
                          </div>
                          <div className="field">
                            <label>{t('settings.customProvider.modelsLabel')}</label>
                            <input
                              type="text"
                              value={editProvider.modelsCsv}
                              onChange={(e) => setEditProvider({ ...editProvider, modelsCsv: e.target.value })}
                              placeholder={t('settings.customProvider.modelsPlaceholder')}
                            />
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <button
                            className="btn ghost sm"
                            disabled={providerTesting || !editProvider.baseUrl}
                            onClick={() => {
                              setProviderTesting(true)
                              setProviderTestMsg('')
                              const firstModel = editProvider.modelsCsv.split(',').map((s) => s.trim()).filter(Boolean)[0]
                              void testProviderConnection(p.cfg, {
                                baseUrl: editProvider.baseUrl,
                                apiKey: editProvider.apiKey || undefined,
                                modelId: firstModel,
                              })
                                .then((r) => setProviderTestMsg(`${r.success ? '✓' : '✗'} ${r.message}`))
                                .catch((e) => setProviderTestMsg(`✗ ${e?.message || e}`))
                                .finally(() => setProviderTesting(false))
                            }}
                          >
                            {providerTesting ? <Loader2 size={12} className="spin" /> : <Plug size={12} />} {t('settings.btn.testConnection')}
                          </button>
                          <button
                            className="btn primary sm"
                            disabled={!editProvider.providerId || !editProvider.baseUrl}
                            onClick={() => {
                              const modelIds = editProvider.modelsCsv.split(',').map((s) => s.trim()).filter(Boolean)
                              void window.tangu!.saveProvider!({
                                providerId: editProvider.providerId,
                                baseUrl: editProvider.baseUrl.replace(/\/+$/, ''),
                                apiKey: editProvider.apiKey || undefined,
                                modelIds: modelIds.length ? modelIds : undefined,
                              }).then((list) => {
                                setCustomProviders(list)
                                setEditProvider(null)
                                setModels(null) // 强制下次进模型页重新拉列表
                                setProviderSaveMsg(t('settings.customProvider.savedReloading'))
                              }).catch((e) => setProviderTestMsg(`${t('settings.toast.saveFailed')}${e?.message || e}`))
                            }}
                          >
                            {t('settings.btn.save')}
                          </button>
                          <button className="btn ghost sm" onClick={() => setEditProvider(null)}>{t('settings.btn.cancel')}</button>
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{providerTestMsg}</span>
                        </div>
                      </>
                    )}

                    {stored?.mode === 'external' && !(stored?.backendUrl || '').includes('localhost') && !(stored?.backendUrl || '').includes('127.0.0.1') && (
                      <div className="hint" style={{ marginTop: 10 }}>
                        {t('settings.customProvider.externalWarning')}
                      </div>
                    )}
                  </>
                )}

                {tab === 'mcp' && (
                  <>
                    <div className="field">
                      <label>{t('settings.mcp.label')}</label>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        {t('settings.mcp.introPrefix')}<code>mcp__server__tool</code>{t('settings.mcp.introSuffix')}
                      </div>
                      {Object.keys(mcpServers).length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                          {Object.entries(mcpServers).map(([name, sc]) => {
                            const st = mcpStatus?.find((s) => s.server === name)
                            const stLabel = sc.enabled === false
                              ? t('settings.mcp.statusDisabled')
                              : st
                                ? st.status === 'connected' ? t('settings.mcp.statusConnected', { count: st.tools.length }) : st.status === 'error' ? t('settings.mcp.statusError') : st.status
                                : t('settings.mcp.statusNotLoaded')
                            return (
                              <div key={name} className="file-row" style={{ cursor: 'default' }}>
                                <span className="file-name">
                                  <b>{name}</b>
                                  <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                                    {sc.command ? `${sc.command} ${(sc.args || []).join(' ')}` : sc.url}
                                  </span>
                                </span>
                                <span className="file-size" title={st?.error || undefined}>{stLabel}</span>
                                <button
                                  className="icon-btn"
                                  title={sc.enabled === false ? t('settings.mcp.enable') : t('settings.mcp.disable')}
                                  onClick={() => writeMcp(
                                    { ...mcpServers, [name]: { ...sc, enabled: sc.enabled === false } },
                                    sc.enabled === false ? t('settings.mcp.enabledMsg') : t('settings.mcp.disabledMsg'),
                                  )}
                                >
                                  <Plug size={13} style={{ opacity: sc.enabled === false ? 0.35 : 1 }} />
                                </button>
                                <button
                                  className="icon-btn"
                                  title={t('settings.btn.edit')}
                                  onClick={() => setEditMcp({
                                    name,
                                    isNew: false,
                                    command: sc.command || '',
                                    argsText: (sc.args || []).join(' '),
                                    url: sc.url || '',
                                    transport: sc.transport || 'auto',
                                    envText: Object.entries(sc.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
                                  })}
                                >
                                  <KeyRound size={13} />
                                </button>
                                <button
                                  className="icon-btn"
                                  title={t('settings.btn.delete')}
                                  onClick={() => {
                                    if (!window.confirm(t('settings.mcp.deleteConfirm', { name }))) return
                                    const next = { ...mcpServers }
                                    delete next[name]
                                    writeMcp(next, t('settings.mcp.deletedMsg'))
                                  }}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {!editMcp && (
                        <button
                          className="btn ghost sm"
                          onClick={() => setEditMcp({ name: '', isNew: true, command: '', argsText: '', url: '', transport: 'auto', envText: '' })}
                        >
                          <Plus size={13} /> {t('settings.mcp.add')}
                        </button>
                      )}
                      {mcpMsg && !editMcp && <div className="hint" style={{ marginTop: 6 }}>{mcpMsg}</div>}
                    </div>

                    {editMcp && (
                      <>
                        <div className="field-row">
                          <div className="field">
                            <label>{t('settings.mcp.nameLabel')}</label>
                            <input
                              type="text"
                              value={editMcp.name}
                              disabled={!editMcp.isNew}
                              onChange={(e) => setEditMcp({ ...editMcp, name: e.target.value.trim() })}
                              placeholder={t('settings.mcp.namePlaceholder')}
                            />
                          </div>
                          <div className="field" style={{ maxWidth: 140 }}>
                            <label>{t('settings.mcp.transportLabel')}</label>
                            <select
                              value={editMcp.transport}
                              onChange={(e) => setEditMcp({ ...editMcp, transport: e.target.value as any })}
                            >
                              <option value="auto">{t('settings.mcp.transportAuto')}</option>
                              <option value="stdio">stdio</option>
                              <option value="http">HTTP</option>
                              <option value="sse">SSE</option>
                            </select>
                          </div>
                        </div>
                        <div className="field">
                          <label>{t('settings.mcp.commandLabel')}</label>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <input
                              type="text"
                              style={{ maxWidth: 160 }}
                              value={editMcp.command}
                              onChange={(e) => setEditMcp({ ...editMcp, command: e.target.value })}
                              placeholder="npx"
                            />
                            <input
                              type="text"
                              value={editMcp.argsText}
                              onChange={(e) => setEditMcp({ ...editMcp, argsText: e.target.value })}
                              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label>{t('settings.mcp.urlLabel')}</label>
                          <input
                            type="text"
                            value={editMcp.url}
                            onChange={(e) => setEditMcp({ ...editMcp, url: e.target.value.trim() })}
                            placeholder="https://example.com/mcp"
                          />
                        </div>
                        <div className="field">
                          <label>{t('settings.mcp.envLabel')}</label>
                          <textarea
                            rows={2}
                            value={editMcp.envText}
                            onChange={(e) => setEditMcp({ ...editMcp, envText: e.target.value })}
                            placeholder="GITHUB_TOKEN=ghp_xxx"
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            className="btn primary sm"
                            disabled={!editMcp.name || (!editMcp.command && !editMcp.url)}
                            onClick={() => {
                              const env: Record<string, string> = {}
                              for (const line of editMcp.envText.split('\n')) {
                                const i = line.indexOf('=')
                                if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
                              }
                              const entry: McpServerConfigEntry = {
                                ...(editMcp.command ? { command: editMcp.command.trim(), args: editMcp.argsText.split(/\s+/).filter(Boolean) } : {}),
                                ...(editMcp.url ? { url: editMcp.url } : {}),
                                ...(editMcp.transport !== 'auto' ? { transport: editMcp.transport } : {}),
                                ...(Object.keys(env).length ? { env } : {}),
                                enabled: mcpServers[editMcp.name]?.enabled !== false,
                              }
                              writeMcp({ ...mcpServers, [editMcp.name]: entry }, t('settings.mcp.savedReconnecting'))
                              setEditMcp(null)
                            }}
                          >
                            {t('settings.btn.save')}
                          </button>
                          <button className="btn ghost sm" onClick={() => setEditMcp(null)}>{t('settings.btn.cancel')}</button>
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{mcpMsg}</span>
                        </div>
                      </>
                    )}
                  </>
                )}

                {tab === 'theme' && (
                  <>
                    <div className="field">
                      <label>{t('settings.theme.themeLabel')}</label>
                      <div className="theme-grid">
                        {listThemes().map((t) => (
                          <ThemeCard
                            key={t.manifest.id}
                            entry={t}
                            mode={p.themeMode}
                            active={t.manifest.id === p.themePreset}
                            onSelect={() => {
                              applyTheme(t.manifest.id, p.themeMode)
                              p.onThemeChange(t.manifest.id, p.themeMode)
                            }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="field">
                      <label>{t('settings.theme.modeLabel')}</label>
                      <div className="seg">
                        <button
                          className={p.themeMode === 'light' ? 'active' : ''}
                          onClick={() => {
                            applyTheme(p.themePreset, 'light')
                            p.onThemeChange(p.themePreset, 'light')
                          }}
                        >
                          <Sun size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          {t('settings.theme.light')}
                        </button>
                        <button
                          className={p.themeMode === 'dark' ? 'active' : ''}
                          onClick={() => {
                            applyTheme(p.themePreset, 'dark')
                            p.onThemeChange(p.themePreset, 'dark')
                          }}
                        >
                          <Moon size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          {t('settings.theme.dark')}{p.themePreset === 'sozhi' ? t('settings.theme.darkNightRead') : ''}
                        </button>
                      </div>
                    </div>
                    <div className="field">
                      <label>{t('settings.theme.glassLabel')}</label>
                      <div className="seg">
                        <button className={p.glassOn ? 'active' : ''} onClick={() => p.onGlassChange(true)}>{t('settings.theme.glassOn')}</button>
                        <button className={!p.glassOn ? 'active' : ''} onClick={() => p.onGlassChange(false)}>{t('settings.theme.glassOff')}</button>
                      </div>
                    </div>
                  </>
                )}

                {tab === 'skills' && (
                  <>
                    <div className="field">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {t('settings.skills.libraryLabel')}
                        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={loadAllSkills}>
                          <RefreshCw size={12} className={allSkillsLoading ? 'spin' : ''} />
                        </button>
                      </label>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        {t('settings.skills.libraryHintPrefix')}~/.tangu/skills/&lt;id&gt;/SKILL.md{t('settings.skills.libraryHintSuffix')}
                      </div>
                      {allSkills === null && <div className="hint">{allSkillsLoading ? t('settings.skills.loading') : t('settings.skills.clickRefresh')}</div>}
                      {allSkills?.length === 0 && <div className="hint">{t('settings.skills.empty')}</div>}
                      {!!allSkills?.length && (() => {
                        // 按来源渠道(agent 文件夹)分组,空渠道不渲染;未知 source → 「其他」。
                        const known = new Set<string>(SKILL_CHANNELS.map((c) => c.key))
                        const groups = new Map<string, SkillInfo[]>()
                        for (const s of allSkills) {
                          const k = known.has(s.source || 'cloud') ? (s.source || 'cloud') : 'other'
                          const arr = groups.get(k) || []
                          arr.push(s)
                          groups.set(k, arr)
                        }
                        const sections = [...SKILL_CHANNELS, { key: 'other' as const, labelKey: 'settings.skills.channel.other' }]
                          .filter((c) => (groups.get(c.key)?.length || 0) > 0)
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {sections.map((c) => (
                              <div key={c.key}>
                                <div className="panel-section-title" style={{ padding: '8px 8px 4px' }}>
                                  {t(c.labelKey)} · {groups.get(c.key)!.length}
                                </div>
                                {groups.get(c.key)!.map((s) => (
                                  <div key={s.id} className="file-row" style={{ cursor: 'default' }}>
                                    <span className="file-name" style={{ flex: 1 }}>
                                      <b>{s.name}</b>
                                      {s.description && (
                                        <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                                          {s.description.length > 70 ? `${s.description.slice(0, 70)}…` : s.description}
                                        </span>
                                      )}
                                    </span>
                                    {(s.source === 'local' || s.source === 'claude' || s.source === 'codex') && (
                                      <button
                                        className="btn ghost sm"
                                        disabled={skillBusy === s.id}
                                        title={t('settings.skills.uploadTitle')}
                                        onClick={() => void doUploadSkill(s.id)}
                                      >
                                        {skillBusy === s.id ? <Loader2 size={11} className="spin" /> : t('settings.skills.uploadBtn')}
                                      </button>
                                    )}
                                    {s.source === 'user' && (
                                      <button
                                        className="icon-btn"
                                        title={t('settings.skills.deleteTitle')}
                                        disabled={skillBusy === s.id}
                                        onClick={() => void doDeleteUserSkill(s.id)}
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                      {skillMsg && <div className="hint" style={{ marginTop: 6 }}>{skillMsg}</div>}
                    </div>

                    {isDesktop && !!window.tangu?.discoveryScan && (
                      <div className="field" style={{ marginTop: 14 }}>
                        <label>{t('settings.discovery.label')}</label>
                        <div className="hint" style={{ marginBottom: 8 }}>
                          {t('settings.discovery.hint')}
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                          <button className="btn ghost sm" disabled={discScanning} onClick={() => void doDiscScan()}>
                            {discScanning ? <Loader2 size={12} className="spin" /> : <Search size={12} />} {t('settings.discovery.scan')}
                          </button>
                          {disc && (
                            <button
                              className="btn primary sm"
                              disabled={discImporting || (discSelSkills.size === 0 && discSelMcp.size === 0)}
                              onClick={() => void doDiscImport()}
                            >
                              {discImporting ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                              {t('settings.discovery.importSelected', { count: discSelSkills.size + discSelMcp.size })}
                            </button>
                          )}
                        </div>

                        {disc && disc.skills.length === 0 && disc.mcpServers.length === 0 && (
                          <div className="hint">{t('settings.discovery.nothingFound')}</div>
                        )}

                        {disc && disc.skills.length > 0 && (
                          <div className="field">
                            <label>{t('settings.discovery.skillsCount', { count: disc.skills.length })}</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {disc.skills.map((s) => (
                                <label key={`${s.ecosystem}:${s.id}`} className="file-row" style={{ cursor: 'pointer' }}>
                                  <input
                                    type="checkbox"
                                    checked={discSelSkills.has(s.id)}
                                    onChange={() => toggleSel(setDiscSelSkills, s.id)}
                                  />
                                  <span className="file-name">
                                    <b>{s.name}</b>
                                    <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                                      {s.description.length > 80 ? `${s.description.slice(0, 80)}…` : s.description}
                                    </span>
                                  </span>
                                  <span className="file-size">{ECO_LABEL[s.ecosystem] || s.ecosystem}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}

                        {disc && disc.mcpServers.length > 0 && (
                          <div className="field">
                            <label>{t('settings.discovery.mcpCount', { count: disc.mcpServers.length })}</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {disc.mcpServers.map((m) => {
                                const key = `${m.ecosystem}:${m.name}`
                                return (
                                  <label key={key} className="file-row" style={{ cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={discSelMcp.has(key)}
                                      onChange={() => toggleSel(setDiscSelMcp, key)}
                                    />
                                    <span className="file-name">
                                      <b>{m.name}</b>
                                      <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                                        {m.config.command ? `${m.config.command} ${(m.config.args || []).join(' ')}` : m.config.url}
                                      </span>
                                    </span>
                                    <span className="file-size">{ECO_LABEL[m.ecosystem] || m.ecosystem}</span>
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {discMsg && <div className="hint" style={{ marginTop: 6 }}>{discMsg}</div>}
                      </div>
                    )}
                  </>
                )}

                {tab === 'advanced' && (
                  <>
                    <div className="panel-note">
                      {t('settings.advanced.note')}
                    </div>

                  </>
                )}

                {tab === 'developer' && (
                  <>
                    <div className="panel-note">{t('settings.developer.note')}</div>
                    {isDesktop && stored && (
                      <div className="field">
                        <label>{t('settings.developer.cloudUrlLabel')}</label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            type="text"
                            value={stored.cloudUrl}
                            onChange={(e) => setStored({ ...stored, cloudUrl: e.target.value.trim() })}
                            placeholder={t('settings.developer.cloudUrlPlaceholder')}
                          />
                          <button
                            className="btn primary sm"
                            onClick={() => {
                              setDevMsg('')
                              // setConfig({cloudUrl}) 在 managed 模式下会自动重启托管后端使其生效(main.ts config:set)。
                              void window.tangu!.setConfig({ cloudUrl: (stored.cloudUrl || '').trim() }).then((s) => {
                                setStored(s)
                                setDevMsg(s.mode === 'managed' ? t('settings.developer.savedRestarting') : t('settings.developer.saved'))
                              })
                            }}
                          >
                            {t('settings.developer.saveCloudUrl')}
                          </button>
                        </div>
                        <div className="hint">{t('settings.developer.cloudUrlHint')}</div>
                        {devMsg && <div className="hint" style={{ marginTop: 6 }}>{devMsg}</div>}
                      </div>
                    )}
                    <div className="field">
                      <label>{t('settings.developer.relaunchLabel')}</label>
                      <div>
                        <button className="btn ghost sm" onClick={() => p.onRelaunchOnboarding?.()}>
                          <Sparkles size={12} /> {t('settings.developer.relaunch')}
                        </button>
                      </div>
                      <div className="hint">{t('settings.developer.relaunchHint')}</div>
                    </div>
                    <div className="field">
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          try { localStorage.removeItem(DEV_MODE_KEY) } catch { /* ignore */ }
                          setDevMode(false)
                          setDevClicks(0)
                          setTab('about')
                        }}
                      >
                        {t('settings.developer.disable')}
                      </button>
                    </div>
                  </>
                )}

                {tab === 'about' && (
                  <>
                    <div className="field">
                      <label>{t('common.language')}</label>
                      <LocaleToggle />
                    </div>
                    <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{t('about.builtWith')}</div>
                        <div
                          className="hint"
                          style={{ marginTop: 2, cursor: 'pointer', userSelect: 'none' }}
                          title={devMode ? t('about.devUnlocked') : undefined}
                          onClick={() => {
                            if (devMode) return
                            const n = devClicks + 1
                            setDevClicks(n)
                            if (n >= 10) {
                              setDevMode(true)
                              try { localStorage.setItem(DEV_MODE_KEY, '1') } catch { /* ignore */ }
                            }
                          }}
                        >
                          {t('about.version')} {appVersion || CHANGELOG[0]?.version || '—'}
                        </div>
                        {devMode ? (
                          <div className="hint" style={{ marginTop: 2, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Wrench size={11} /> {t('about.devUnlocked')}
                          </div>
                        ) : devClicks >= 5 ? (
                          <div className="hint" style={{ marginTop: 2 }}>{t('about.versionClickHint', { n: 10 - devClicks })}</div>
                        ) : null}
                      </div>
                      <span className="grow" />
                      <button
                        className="btn ghost sm"
                        onClick={() => window.open('https://forsion.net', '_blank')}
                      >
                        <ExternalLink size={12} /> {t('about.checkUpdates')}
                      </button>
                    </div>
                    <div className="field">
                      <label>{t('about.changelogTitle')}</label>
                      <div className="changelog">
                        {CHANGELOG.map((c) => (
                          <div key={c.version} className="changelog-entry">
                            <div className="changelog-ver">
                              v{c.version} <span className="changelog-date">{c.date}</span>
                            </div>
                            <ul>
                              {(locale === 'en' ? c.en : c.zh).map((line, i) => (
                                <li key={i}>{line}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </AnimatedModalContent>
        </AnimatedModalBackdrop>
      )}
    </AnimatePresence>
  )
}
