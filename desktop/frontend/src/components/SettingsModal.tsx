/**
 * 设置模态:连接 / 模型 / 主题(ThemeCard 网格 + 明暗 + 毛玻璃) / 高级。
 * tabs 形态对齐 AI Studio SettingsModal;连接页的 managed/external 切换在 M6 接 backendManager。
 */
import React, { useEffect, useState } from 'react'
import { X, Loader2, RefreshCw, Sun, Moon, RotateCcw, LogIn, LogOut, ExternalLink, KeyRound, Plus, Trash2, Plug, Search, Download } from 'lucide-react'
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

type Tab = 'connection' | 'model' | 'providers' | 'mcp' | 'skills' | 'theme' | 'advanced'

const ECO_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
}

// 技能渠道(agent 文件夹)分组顺序;可扩展:新增渠道(如 opencode 后端扫描接上后)只加一行,
// 空渠道自动不渲染。未知 source 落入「其他」兜底组。
const SKILL_CHANNELS: Array<{ key: NonNullable<SkillInfo['source']> | 'opencode'; label: string }> = [
  { key: 'local', label: '本地' },
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'user', label: '已上云' },
  { key: 'cloud', label: '云端' },
]

const BACKEND_STATE_LABEL: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中…',
  ready: '运行中',
  crashed: '已崩溃',
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
}> = (p) => {
  const [tab, setTab] = useState<Tab>('connection')
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
    }).catch((e) => setMcpMsg(`保存失败:${e?.message || e}`))
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
      .catch((e) => setSkillMsg(`技能列表加载失败:${e?.message || e}`))
      .finally(() => setAllSkillsLoading(false))
  }

  const doUploadSkill = async (id: string): Promise<void> => {
    setSkillBusy(id)
    setSkillMsg('')
    try {
      const r = await uploadSkillToCloud(p.cfg, id)
      setSkillMsg(`✓ 「${r.name}」已上传云端(id: ${r.id})`)
      loadAllSkills()
    } catch (e: any) {
      setSkillMsg(`上传失败:${e?.message || e}`)
    } finally {
      setSkillBusy(null)
    }
  }

  const doDeleteUserSkill = async (id: string): Promise<void> => {
    if (!window.confirm(`删除云端技能「${id}」?`)) return
    setSkillBusy(id)
    setSkillMsg('')
    try {
      await deleteUserCloudSkill(p.cfg, id)
      setSkillMsg('✓ 已删除')
      loadAllSkills()
    } catch (e: any) {
      setSkillMsg(`删除失败:${e?.message || e}`)
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
      setDiscMsg(`扫描失败:${e?.message || e}`)
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
      setDiscMsg(
        `已导入技能 ${r1.imported.length} 个、MCP ${r2.imported.length} 个。`
        + `技能即时生效(后端按 mtime 重扫);MCP 默认停用,请到 MCP 页启用。`,
      )
    } catch (e: any) {
      setDiscMsg(`导入失败:${e?.message || e}`)
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
      setTestResult(e?.message || '模型列表加载失败')
    } finally {
      setModelsLoading(false)
    }
  }

  useEffect(() => {
    if (p.open && tab === 'model' && !models && !modelsLoading) void loadModels()
    if (p.open && tab === 'mcp') refreshMcp()
    if (p.open && tab === 'skills' && !allSkills && !allSkillsLoading) loadAllSkills()
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
                设置
                <span className="grow" />
                <button className="icon-btn" onClick={p.onClose}>
                  <X size={16} />
                </button>
              </div>
              <div className="modal-tabs">
                {(
                  [
                    ['connection', '连接'],
                    ['model', '模型'],
                    ...(isDesktop ? ([['providers', 'Provider'], ['mcp', 'MCP'], ['skills', '技能']] as Array<[Tab, string]>) : []),
                    ['theme', '主题'],
                    ['advanced', '高级'],
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
                        <label>后端模式</label>
                        <div className="seg">
                          <button className={mode === 'managed' ? 'active' : ''} onClick={() => setMode('managed')}>
                            自动托管(内置)
                          </button>
                          <button className={mode === 'external' ? 'active' : ''} onClick={() => setMode('external')}>
                            外部连接
                          </button>
                        </div>
                      </div>
                    )}

                    {isDesktop && mode === 'managed' && stored && (
                      <>
                        <div className="field">
                          <label>Forsion 云端地址(大脑:记忆/技能/托管模型)</label>
                          <input
                            type="text"
                            value={stored.cloudUrl}
                            onChange={(e) => setStored({ ...stored, cloudUrl: e.target.value })}
                            placeholder="https://api.forsion.app"
                          />
                          <div className="hint">可用环境变量 TANGU_CLOUD_URL 预设;登录成功后自动记住。</div>
                        </div>

                        <div className="field">
                          <label>Forsion 账号</label>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            {authSt?.loggedIn ? (
                              <>
                                <span className="conn-pill ok">
                                  <span className="dot" />
                                  已登录{authSt.username ? ` · ${authSt.username}` : ''}
                                  {authSt.tokenSource === 'config' ? '(手动 token)' : ''}
                                </span>
                                <button className="btn ghost sm" onClick={() => {
                                  void window.tangu!.forsionLogout?.().then(() => refreshAuth())
                                }}>
                                  <LogOut size={12} /> 登出
                                </button>
                              </>
                            ) : (
                              <span className="conn-pill"><span className="dot" />未登录</span>
                            )}
                            <button className="btn primary sm" onClick={() => void doForsionLogin()} disabled={loggingIn || !stored.cloudUrl}>
                              {loggingIn ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />}
                              通过浏览器登录
                            </button>
                          </div>
                          {device && (
                            <div className="hint" style={{ marginTop: 6 }}>
                              浏览器没弹出来?手动打开:
                              <a href={device.url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                                {device.url} <ExternalLink size={10} style={{ verticalAlign: -1 }} />
                              </a>
                              {device.userCode ? <> · 验证码 <b>{device.userCode}</b></> : null}
                            </div>
                          )}
                          {!authSt?.loggedIn && (
                            <div className="hint">与 `tangu login` 同一份凭证(~/.tangu/auth.json),CLI/TUI/桌面通用。</div>
                          )}
                        </div>

                        <div className="field-row">
                          <div className="field">
                            <label><KeyRound size={11} style={{ verticalAlign: -1 }} /> 手动 token(高级,可选;覆盖登录凭证)</label>
                            <input
                              type="password"
                              value={stored.cloudToken}
                              onChange={(e) => setStored({ ...stored, cloudToken: e.target.value })}
                              placeholder="一般不需要,浏览器登录即可"
                            />
                          </div>
                          <div className="field" style={{ maxWidth: 160 }}>
                            <label>代码沙箱</label>
                            <select
                              value={stored.sandbox}
                              onChange={(e) => setStored({ ...stored, sandbox: e.target.value as any })}
                            >
                              <option value="auto">自动检测</option>
                              <option value="docker">Docker</option>
                              <option value="none">禁用</option>
                            </select>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                          <button className="btn primary sm" onClick={saveManaged}>保存并重启后端</button>
                          <button
                            className="btn ghost sm"
                            onClick={() => void window.tangu!.backendRestart!().then(setBackendSt)}
                          >
                            <RotateCcw size={12} /> 重启
                          </button>
                          <span className={`conn-pill ${backendSt?.state === 'ready' ? 'ok' : backendSt?.state === 'crashed' ? 'err' : ''}`}>
                            <span className="dot" />
                            {BACKEND_STATE_LABEL[backendSt?.state || 'stopped']}
                            {backendSt?.url ? ` · ${backendSt.url}` : ''}
                          </span>
                        </div>
                        {backendSt?.lastError && (
                          <div className="hint" style={{ color: 'var(--danger)' }}>{backendSt.lastError}</div>
                        )}
                        {backendSt?.staleDist && (
                          <div className="hint" style={{ color: 'var(--danger)' }}>
                            ⚠ 服务端代码已重新构建,当前后端仍在跑旧版本 —— 点上方「重启」加载新代码。
                          </div>
                        )}
                        <div className="field">
                          <button
                            className="btn ghost sm"
                            onClick={() => void window.tangu!.backendLogs!().then(setLogs)}
                          >
                            查看后端日志
                          </button>
                          {logs && (
                            <pre style={{
                              marginTop: 8, fontSize: 11, fontFamily: 'var(--font-mono)', maxHeight: 220,
                              overflowY: 'auto', background: 'var(--bg-card)', padding: 8,
                              border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                            }}>
                              {logs.length ? logs.join('\n') : '(暂无日志)'}
                            </pre>
                          )}
                        </div>
                      </>
                    )}

                    {(!isDesktop || mode === 'external') && (
                      <>
                        <div className="field">
                          <label>后端地址</label>
                          <input
                            type="text"
                            value={draft.backendUrl}
                            onChange={(e) => setDraft({ ...draft, backendUrl: e.target.value })}
                            placeholder="http://localhost:8787"
                          />
                          <div className="hint">tangu-server 的 HTTP 地址(本机或远程);可用环境变量 TANGU_BACKEND_URL 预设。</div>
                        </div>
                        <div className="field">
                          <label>访问令牌</label>
                          <input
                            type="password"
                            value={draft.token}
                            onChange={(e) => setDraft({ ...draft, token: e.target.value })}
                            placeholder="tangu-server --token 配置的值"
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button className="btn ghost sm" onClick={test} disabled={testing}>
                            {testing ? <Loader2 size={13} className="spin" /> : null} 测试连接
                          </button>
                          <button className="btn primary sm" onClick={saveConnection}>
                            保存并连接
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
                      <label>默认模型</label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          type="text"
                          value={draft.modelId}
                          onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                          placeholder="如 forsion 模型 id 或 ollama/llama3"
                        />
                        <button className="btn ghost sm" onClick={() => p.onConfigChange({ modelId: draft.modelId })}>
                          保存
                        </button>
                      </div>
                      <div className="hint">
                        直连 provider 支持 <code>&lt;providerId&gt;/&lt;model&gt;</code> 自由填写;其余走 Forsion 托管面。
                      </div>
                    </div>
                    <div className="field">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        可用模型
                        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={loadModels}>
                          <RefreshCw size={12} className={modelsLoading ? 'spin' : ''} />
                        </button>
                      </label>
                      {models?.models.length ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {models.models.map((m) => (
                            <button
                              key={`${m.source}-${m.id}`}
                              className="file-row"
                              onClick={() => {
                                setDraft({ ...draft, modelId: m.id })
                                p.onConfigChange({ modelId: m.id })
                              }}
                            >
                              <span className="file-name" style={{ color: m.id === draft.modelId ? 'var(--accent)' : undefined }}>
                                {m.name}
                              </span>
                              <span className="file-size">{m.source === 'direct' ? `直连·${m.provider}` : m.provider}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="hint">{modelsLoading ? '加载中…' : '暂无模型'}</div>
                      )}
                      {models?.forsion && models.forsion.status !== 'ok' && (
                        <div className="hint" style={{ color: models.forsion.status === 'error' ? 'var(--danger)' : undefined, marginTop: 6 }}>
                          {models.forsion.status === 'error' ? '⚠ 云端托管模型获取失败:' : 'ℹ '}
                          {models.forsion.detail}
                        </div>
                      )}
                      {models?.directProviders.length ? (
                        <div className="hint">
                          直连 provider:{models.directProviders.map((d) => d.providerId).join('、')}
                        </div>
                      ) : null}
                    </div>

                    {isDesktop && providers && providers.length > 0 && (
                      <div className="field">
                        <label>Provider 账号登录(用订阅账号当 LLM,直连不计 Forsion 额度)</label>
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
                              {pr.loggedIn ? ' · 已登录(重新登录)' : ''}
                            </button>
                          ))}
                        </div>
                        <div className="hint">
                          OAuth 浏览器登录,凭证存 ~/.tangu/provider-auth.json(与 `tangu login {'<provider>'}` 通用);
                          托管后端会自动重启加载,之后用 <code>provider/模型名</code>(如 xai/grok-3)即可。
                        </div>
                      </div>
                    )}
                  </>
                )}

                {tab === 'providers' && (
                  <>
                    <div className="field">
                      <label>自定义 Provider(BYO-key 直连;对齐 Forsion 模型添加:base_URL + api key)</label>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        配置存 ~/.tangu/providers.json,与 CLI <code>--providers-file</code> 同格式;
                        托管模式保存后自动重启后端加载。模型用 <code>providerId/模型名</code> 或白名单内的名字直接选。
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
                                {cp.modelIds?.length ? `${cp.modelIds.length} 模型` : '前缀任意模型'}
                                {cp.apiKey ? ' · key✓' : ''}
                              </span>
                              <button
                                className="icon-btn"
                                title="编辑"
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
                                title="删除"
                                onClick={() => {
                                  if (!window.confirm(`删除 provider「${cp.providerId}」?`)) return
                                  void window.tangu!.deleteProvider!(cp.providerId).then((list) => {
                                    setCustomProviders(list)
                                    setProviderSaveMsg('已删除;托管后端重启加载中…')
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
                          <Plus size={13} /> 添加 Provider
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
                            <label>Provider ID(也作模型前缀,如 ollama → ollama/llama3)</label>
                            <input
                              type="text"
                              value={editProvider.providerId}
                              onChange={(e) => setEditProvider({ ...editProvider, providerId: e.target.value.trim() })}
                              placeholder="如 ollama / siliconflow / openai"
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label>Base URL(OpenAI 兼容端点根,含 /v1)</label>
                          <input
                            type="text"
                            value={editProvider.baseUrl}
                            onChange={(e) => setEditProvider({ ...editProvider, baseUrl: e.target.value.trim() })}
                            placeholder="如 http://localhost:11434/v1 或 https://api.siliconflow.cn/v1"
                          />
                        </div>
                        <div className="field-row">
                          <div className="field">
                            <label>API Key(Ollama 等本地端点可空)</label>
                            <input
                              type="password"
                              value={editProvider.apiKey || ''}
                              onChange={(e) => setEditProvider({ ...editProvider, apiKey: e.target.value })}
                              placeholder="sk-…"
                            />
                          </div>
                          <div className="field">
                            <label>模型白名单(逗号分隔,可空)</label>
                            <input
                              type="text"
                              value={editProvider.modelsCsv}
                              onChange={(e) => setEditProvider({ ...editProvider, modelsCsv: e.target.value })}
                              placeholder="如 llama3, qwen2.5-coder"
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
                            {providerTesting ? <Loader2 size={12} className="spin" /> : <Plug size={12} />} 测试连接
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
                                setProviderSaveMsg('已保存;托管后端重启加载中…')
                              }).catch((e) => setProviderTestMsg(`保存失败:${e?.message || e}`))
                            }}
                          >
                            保存
                          </button>
                          <button className="btn ghost sm" onClick={() => setEditProvider(null)}>取消</button>
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{providerTestMsg}</span>
                        </div>
                      </>
                    )}

                    {stored?.mode === 'external' && !(stored?.backendUrl || '').includes('localhost') && !(stored?.backendUrl || '').includes('127.0.0.1') && (
                      <div className="hint" style={{ marginTop: 10 }}>
                        ⚠ 当前为外部后端模式:这里编辑的是本机 ~/.tangu/providers.json,远程 tangu-server 不会读到。
                      </div>
                    )}
                  </>
                )}

                {tab === 'mcp' && (
                  <>
                    <div className="field">
                      <label>MCP Server(配置存 ~/.tangu/mcp.json;保存后托管后端重启重连)</label>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        工具以 <code>mcp__服务名__工具名</code> 出现;server 集在后端启动时冻结,
                        变更只对重启后的新对话生效(上下文缓存会重建一次)。
                      </div>
                      {Object.keys(mcpServers).length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                          {Object.entries(mcpServers).map(([name, sc]) => {
                            const st = mcpStatus?.find((s) => s.server === name)
                            const stLabel = sc.enabled === false
                              ? '未启用'
                              : st
                                ? st.status === 'connected' ? `已连接 · ${st.tools.length} 工具` : st.status === 'error' ? `连接失败` : st.status
                                : '后端未加载(重启后生效)'
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
                                  title={sc.enabled === false ? '启用' : '停用'}
                                  onClick={() => writeMcp(
                                    { ...mcpServers, [name]: { ...sc, enabled: sc.enabled === false } },
                                    sc.enabled === false ? '已启用;重启后端后连接' : '已停用;重启后端后断开',
                                  )}
                                >
                                  <Plug size={13} style={{ opacity: sc.enabled === false ? 0.35 : 1 }} />
                                </button>
                                <button
                                  className="icon-btn"
                                  title="编辑"
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
                                  title="删除"
                                  onClick={() => {
                                    if (!window.confirm(`删除 MCP server「${name}」?`)) return
                                    const next = { ...mcpServers }
                                    delete next[name]
                                    writeMcp(next, '已删除')
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
                          <Plus size={13} /> 添加 MCP Server
                        </button>
                      )}
                      {mcpMsg && !editMcp && <div className="hint" style={{ marginTop: 6 }}>{mcpMsg}</div>}
                    </div>

                    {editMcp && (
                      <>
                        <div className="field-row">
                          <div className="field">
                            <label>名称(工具前缀)</label>
                            <input
                              type="text"
                              value={editMcp.name}
                              disabled={!editMcp.isNew}
                              onChange={(e) => setEditMcp({ ...editMcp, name: e.target.value.trim() })}
                              placeholder="如 filesystem / github"
                            />
                          </div>
                          <div className="field" style={{ maxWidth: 140 }}>
                            <label>传输</label>
                            <select
                              value={editMcp.transport}
                              onChange={(e) => setEditMcp({ ...editMcp, transport: e.target.value as any })}
                            >
                              <option value="auto">自动推断</option>
                              <option value="stdio">stdio</option>
                              <option value="http">HTTP</option>
                              <option value="sse">SSE</option>
                            </select>
                          </div>
                        </div>
                        <div className="field">
                          <label>命令(stdio;与 URL 二选一)</label>
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
                          <label>URL(HTTP/SSE)</label>
                          <input
                            type="text"
                            value={editMcp.url}
                            onChange={(e) => setEditMcp({ ...editMcp, url: e.target.value.trim() })}
                            placeholder="https://example.com/mcp"
                          />
                        </div>
                        <div className="field">
                          <label>环境变量(每行 KEY=VALUE,可空)</label>
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
                              writeMcp({ ...mcpServers, [editMcp.name]: entry }, '已保存;托管后端重启重连中…')
                              setEditMcp(null)
                            }}
                          >
                            保存
                          </button>
                          <button className="btn ghost sm" onClick={() => setEditMcp(null)}>取消</button>
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{mcpMsg}</span>
                        </div>
                      </>
                    )}
                  </>
                )}

                {tab === 'theme' && (
                  <>
                    <div className="field">
                      <label>主题</label>
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
                      <label>明暗</label>
                      <div className="seg">
                        <button
                          className={p.themeMode === 'light' ? 'active' : ''}
                          onClick={() => {
                            applyTheme(p.themePreset, 'light')
                            p.onThemeChange(p.themePreset, 'light')
                          }}
                        >
                          <Sun size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          亮色
                        </button>
                        <button
                          className={p.themeMode === 'dark' ? 'active' : ''}
                          onClick={() => {
                            applyTheme(p.themePreset, 'dark')
                            p.onThemeChange(p.themePreset, 'dark')
                          }}
                        >
                          <Moon size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          暗色{p.themePreset === 'sozhi' ? '(夜读)' : ''}
                        </button>
                      </div>
                    </div>
                    <div className="field">
                      <label>毛玻璃质感</label>
                      <div className="seg">
                        <button className={p.glassOn ? 'active' : ''} onClick={() => p.onGlassChange(true)}>开</button>
                        <button className={!p.glassOn ? 'active' : ''} onClick={() => p.onGlassChange(false)}>关(低配模式)</button>
                      </div>
                    </div>
                  </>
                )}

                {tab === 'skills' && (
                  <>
                    <div className="field">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        技能库
                        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={loadAllSkills}>
                          <RefreshCw size={12} className={allSkillsLoading ? 'spin' : ''} />
                        </button>
                      </label>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        按来源渠道(agent 文件夹)分组。本地技能放 ~/.tangu/skills/&lt;id&gt;/SKILL.md;自动识别
                        ~/.claude/skills 与 ~/.codex/prompts(env TANGU_EXTERNAL_SKILLS=off 可关)。会话内启用在
                        右侧面板或输入 /skill 命令;此处管理全局技能与云端同步。
                      </div>
                      {allSkills === null && <div className="hint">{allSkillsLoading ? '加载中…' : '点击刷新加载'}</div>}
                      {allSkills?.length === 0 && <div className="hint">暂无技能。</div>}
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
                        const sections = [...SKILL_CHANNELS, { key: 'other' as const, label: '其他' }]
                          .filter((c) => (groups.get(c.key)?.length || 0) > 0)
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {sections.map((c) => (
                              <div key={c.key}>
                                <div className="panel-section-title" style={{ padding: '8px 8px 4px' }}>
                                  {c.label} · {groups.get(c.key)!.length}
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
                                        title="上传为本人云端技能(云端 Tangu 会话可用)"
                                        onClick={() => void doUploadSkill(s.id)}
                                      >
                                        {skillBusy === s.id ? <Loader2 size={11} className="spin" /> : '上传云端'}
                                      </button>
                                    )}
                                    {s.source === 'user' && (
                                      <button
                                        className="icon-btn"
                                        title="删除本人云端技能"
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
                        <label>从其他 Agent 导入(Claude Code / Codex / Hermes)</label>
                        <div className="hint" style={{ marginBottom: 8 }}>
                          扫描本机 ~/.claude、~/.codex、~/.hermes 的技能与 MCP 配置,勾选后导入
                          ~/.tangu。导入的 MCP 一律默认停用,不会自动运行外来命令。
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                          <button className="btn ghost sm" disabled={discScanning} onClick={() => void doDiscScan()}>
                            {discScanning ? <Loader2 size={12} className="spin" /> : <Search size={12} />} 扫描本机
                          </button>
                          {disc && (
                            <button
                              className="btn primary sm"
                              disabled={discImporting || (discSelSkills.size === 0 && discSelMcp.size === 0)}
                              onClick={() => void doDiscImport()}
                            >
                              {discImporting ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                              导入所选({discSelSkills.size + discSelMcp.size})
                            </button>
                          )}
                        </div>

                        {disc && disc.skills.length === 0 && disc.mcpServers.length === 0 && (
                          <div className="hint">未发现可导入的技能或 MCP 配置。</div>
                        )}

                        {disc && disc.skills.length > 0 && (
                          <div className="field">
                            <label>技能({disc.skills.length})</label>
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
                            <label>MCP Server({disc.mcpServers.length})</label>
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
                      会话级配置(技能/工具启用、执行环境、审批档)在右侧面板与输入栏调整。
                      快捷键:Ctrl/Cmd+N 新建会话,Ctrl/Cmd+, 打开设置。
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
