/**
 * 设置页:连接 / 模型 / MCP / Browser / WeChat / 主题 / 高级。
 * 在 Desktop 主界面内替换 Chat/Inspector 区域，而不是覆盖式弹窗。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { X, ArrowLeft, Loader2, RefreshCw, Sun, Moon, RotateCcw, LogIn, LogOut, ExternalLink, KeyRound, Plus, Trash2, Plug, Search, Download, Sparkles, Wrench, Check, Globe2, QrCode, Smartphone, FolderOpen, Play } from 'lucide-react'
import { ThemeCard } from './ThemeCard'
import { listLanguages, listSkins } from '../theme/registry'
import { applyTheme } from '../theme/loader'
import { useWorkspace } from '@lcl/engine' // 工作区引擎:恢复默认布局
import { testConnection } from '../services/agentRunService'
import {
  deleteUserCloudSkill, disconnectWechat as disconnectWechatAccount, fetchProviderModels,
  getWechatStatus, listModels, listSkills, listTools, pollWechatLogin, startWechatLogin,
  testProviderConnection, uploadSkillToCloud, syncNow as backendSyncNow, getSyncStatus as backendGetSyncStatus,
  listPlugins, listAgents, type PluginInfo, type SyncStatusResult,
} from '../services/backendService'
import type { WechatStatusResponse } from '../services/backendService'
import { buildSessionLogPayload, sessionLogFilename } from '../services/sessionLog'
import type {
  AuthStatusInfo, BackendStatusInfo, DirectProviderConfig, DiscoveryResult, McpServerConfigEntry, ModelsResponse,
  NormalAgentDef, SessionRecord, SkillInfo, StoredDesktopConfig, TanguDesktopConfig, ToolsResponse, UpdaterStatusInfo,
} from '../types'
import { SHOW_SYSTEM_PROMPT_KEY } from '../types'
import { useI18n } from '../i18n'
import { LocaleToggle } from './LocaleToggle'
import { CHANGELOG } from '../changelog'
import { Markdown } from './Markdown'
import { UpdateActions } from './UpdateActions'
import { openChangelogTab } from '../views/ChangelogView'
import { ModelGroupList } from './ModelGroupList'
import { AgentsSettings } from './AgentsSettings'
import { TtsVoiceStudio } from './TtsVoiceStudio'
import { previewTts } from '../services/ttsService'
import { ShortcutsTab } from './ShortcutsTab'
import { PluginsTab } from './PluginsTab'
import { AmadeusPluginsTab } from './AmadeusPluginsTab'
import { SpacesTab } from './SpacesTab'
import { HooksTab } from './HooksTab'
import { PluginSettingsPage } from './PluginSettingsPage'
import { AgentClisTab } from './AgentClisTab'
import { QrImage } from './QrImage'

type StaticTab = 'general' | 'connection' | 'forsion' | 'model' | 'mcp' | 'hooks' | 'skills' | 'agents' | 'plugins' | 'amadeus-plugins' | 'agent-clis' | 'browser' | 'wechat' | 'notes' | 'spaces' | 'theme' | 'shortcuts' | 'advanced' | 'developer' | 'about'
// 动态插件设置页用 `plugin:<id>`(Obsidian 式一级入口)。
export type Tab = StaticTab | `plugin:${string}`

const DEV_MODE_KEY = 'forsion_tangu_dev_mode'

// 系统音色候选(datalist 可输可选;百炼无音色列表 API,静态维护常用项;全量见百炼「Qwen-TTS 音色列表」文档)。
const TTS_VOICE_SUGGESTIONS: Array<[string, string]> = [
  ['Cherry', '百炼 芊悦(女)'], ['Serena', '百炼 苏瑶(女)'], ['Ethan', '百炼 晨煦(男)'], ['Chelsie', '百炼 千雪(女)'],
  ['Nofish', '百炼(男·不会翘舌)'], ['Jennifer', '百炼(英语女)'], ['Ryan', '百炼(英语男)'], ['Katerina', '百炼(俄语女)'],
  ['Dylan', '百炼 北京话'], ['Jada', '百炼 上海话'], ['Sunny', '百炼 四川话'], ['Rocky', '百炼 粤语'],
  ['Kiki', '百炼 粤语(女)'], ['Marcus', '百炼 陕西话'], ['Roy', '百炼 闽南语'], ['Peter', '百炼 天津话'],
  ['alloy', 'OpenAI'], ['echo', 'OpenAI'], ['fable', 'OpenAI'], ['onyx', 'OpenAI'], ['nova', 'OpenAI'], ['shimmer', 'OpenAI'],
]

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
  themeLang: string
  themeSkin: string
  themeMode: 'light' | 'dark'
  glassOn: boolean
  flatOn: boolean
  themeSeed: string
  onClose: () => void
  onConfigChange: (patch: Partial<TanguDesktopConfig>) => void
  onThemeChange: (lang: string, skin: string, mode: 'light' | 'dark') => void
  onGlassChange: (on: boolean) => void
  onFlatChange: (on: boolean) => void
  onSeedChange: (hex: string) => void
  /** 重扫 ~/.tangu/themes 并重应用(拖入/编辑主题后);完成后父层 themesVersion 自增触发重渲染。 */
  onReloadThemes?: () => void | Promise<void>
  /** patch 随调用传入:避免「setState 未刷新就重连」的旧值竞态。 */
  onReconnect: (patch?: Partial<TanguDesktopConfig>) => void
  /** 开发者选项里「重新进入引导」回调(由 App 控制 onboarding 显隐)。 */
  onRelaunchOnboarding?: () => void
  /** 当前活跃会话(高级→导出日志用;无活跃会话时禁用导出)。 */
  activeSession?: SessionRecord | null
  /** 打开时直接定位到的 tab(如微信卡片→'wechat'、/skills→'skills');缺省落 connection。 */
  initialTab?: Tab
}> = (p) => {
  const { t, locale } = useI18n()
  // 合并后:连接/Forsion → 常规设置(general);Agent CLI → 智能体(agents)。旧入口 tab 归一。
  const normalizeTab = (x: Tab | undefined): Tab =>
    x === 'connection' || x === 'forsion' ? 'general' : x === 'agent-clis' ? 'agents' : (x ?? 'general')
  const [tab, setTab] = useState<Tab>(normalizeTab(p.initialTab))
  const [navQuery, setNavQuery] = useState('')
  const [appVersion, setAppVersion] = useState<string>('')
  // 应用内自动更新状态(经 window.tangu.onUpdaterStatus 广播驱动;mac 仅检测引导手动下载)。
  const [upd, setUpd] = useState<UpdaterStatusInfo>({ phase: 'idle' })
  // 开发者模式:关于页连点版本号 10 次解锁(持久化);解锁后多出「开发者选项」tab。
  const [devMode, setDevMode] = useState<boolean>(() => {
    try { return localStorage.getItem(DEV_MODE_KEY) === '1' } catch { return false }
  })
  const [devClicks, setDevClicks] = useState(0)
  // 开发者「回复前显示 system prompt」(localStorage;App.send 读同一 key 决定是否请求后端回传)。
  const [showSysPrompt, setShowSysPrompt] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_SYSTEM_PROMPT_KEY) === '1' } catch { return false }
  })
  const [draft, setDraft] = useState(p.cfg)
  const [themesReloading, setThemesReloading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  // Electron 托管后端(window.tangu 缺省=浏览器调试,隐藏 managed UI)
  const isDesktop = !!window.tangu?.backendStatus
  // Tangu Web(浏览器云端客户端):解闸云端可用特性(技能);其余 host tab 仍随 isDesktop 隐藏。
  const cloudWeb = !!window.tangu?.cloudWeb
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
  const [editProvider, setEditProvider] = useState<(DirectProviderConfig & { modelsCsv: string; imageModelsCsv: string; ttsModelsCsv: string }) | null>(null)
  // 语速输入的编辑态缓冲(null=未在编辑,显示已存值):清空/打半截时不反弹,blur 时非法则恢复旧值。
  const [ttsSpeedText, setTtsSpeedText] = useState<string | null>(null)
  const [ttsTesting, setTtsTesting] = useState(false)
  const [ttsTestMsg, setTtsTestMsg] = useState('')
  const [providerTestMsg, setProviderTestMsg] = useState('')
  const [providerTesting, setProviderTesting] = useState(false)
  const [providerSaveMsg, setProviderSaveMsg] = useState('')
  // 「拉取模型」:后端代拉 baseUrl/models → 可搜索多选 → 勾选写回 modelsCsv。
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null)
  const [modelSearch, setModelSearch] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchModelsMsg, setFetchModelsMsg] = useState('')
  // 高级→导出日志:把当前会话的全部对话 + 后端运行日志打包成一个 JSON,便于开发者排障。
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState('')
  // 清空数据(应用内卸载/重置):默认勾 Tangu 数据,不默认勾桌面设置。
  const [clearTangu, setClearTangu] = useState(true)
  const [clearDesktop, setClearDesktop] = useState(false)
  const [wechatStatus, setWechatStatus] = useState<WechatStatusResponse | null>(null)
  const [wechatBusy, setWechatBusy] = useState(false)
  const [wechatMsg, setWechatMsg] = useState('')
  const [wechatLogin, setWechatLogin] = useState<{ loginId: string; qrcodeImg: string; expiresAt: number; status?: string } | null>(null)

  const exportSessionLogs = async (): Promise<void> => {
    const session = p.activeSession
    if (!session) { setExportMsg(t('settings.advanced.exportNoSession')); return }
    setExporting(true)
    setExportMsg('')
    try {
      const payload = await buildSessionLogPayload(p.cfg, session)
      const json = JSON.stringify(payload, null, 2)
      const filename = sessionLogFilename(session)
      if (window.tangu?.saveTextFile) {
        const r = await window.tangu.saveTextFile(filename, json)
        setExportMsg(r.ok && r.path ? t('settings.advanced.exportOk', { path: r.path }) : t('settings.advanced.exportCanceled'))
      } else {
        // 浏览器调试兜底:走 Blob 下载(无系统保存框)。
        const blob = new Blob([json], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = filename
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 5000)
        setExportMsg(t('settings.advanced.exportOk', { path: filename }))
      }
    } catch (e: any) {
      setExportMsg(t('settings.advanced.exportFailed', { err: e?.message || String(e) }))
    } finally {
      setExporting(false)
    }
  }

  const refreshCustomProviders = (): void => {
    void window.tangu?.listProviders?.().then(setCustomProviders).catch(() => setCustomProviders([]))
  }
  // MCP 配置(~/.tangu/mcp.json)+ 后端实际连接状态(GET /agent/tools 的 mcp 分区)
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerConfigEntry>>({})
  const [mcpStatus, setMcpStatus] = useState<ToolsResponse['mcp']>(undefined)
  const [editMcp, setEditMcp] = useState<{ name: string; isNew: boolean; command: string; argsText: string; url: string; transport: 'auto' | 'stdio' | 'http' | 'sse'; envText: string } | null>(null)
  const [mcpMsg, setMcpMsg] = useState('')

  // Obsidian 式插件:清单 + 每插件设置页(已启用且有 settings 的插件在「扩展」组下成一级 nav 项)。
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [pluginAgents, setPluginAgents] = useState<NormalAgentDef[]>([])
  const reloadPlugins = useCallback(() => {
    if (!isDesktop) return
    void listPlugins(p.cfg).then(setPlugins).catch(() => setPlugins([]))
  }, [isDesktop, p.cfg])
  useEffect(() => {
    if (!p.open || !isDesktop) return
    reloadPlugins()
    void listAgents(p.cfg).then(setPluginAgents).catch(() => { /* ignore */ })
  }, [p.open, isDesktop, reloadPlugins, p.cfg])
  const pluginNm = (pl: PluginInfo): string => (locale === 'en' && pl.nameEn ? pl.nameEn : pl.name)
  const pluginNavItems = (plugins || [])
    .filter((pl) => pl.enabled && pl.settings)
    .map((pl) => [`plugin:${pl.id}`, pluginNm(pl)] as [Tab, string])

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

  // ── Forsion 账号退出 + Brain 记忆同步 ──
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [syncSt, setSyncSt] = useState<SyncStatusResult | null>(null)

  const doForsionLogout = async (): Promise<void> => {
    if (!window.tangu?.forsionLogout) return
    setLoggingIn(true)
    try {
      await window.tangu.forsionLogout()
      refreshAuth()
      p.onReconnect()
    } finally {
      setLoggingIn(false)
    }
  }

  const refreshSyncStatus = (): void => {
    backendGetSyncStatus(p.cfg).then(setSyncSt).catch(() => setSyncSt(null))
  }

  const doSyncNow = async (): Promise<void> => {
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await backendSyncNow(p.cfg)
      if (r.ok) {
        setSyncMsg(t('settings.forsion.syncOk', { memory: r.memory, logs: r.logs.length }) + (r.agents ? ` · ${r.agents} agent ↑${r.pushed ?? 0} ↓${r.pulled ?? 0}` : ''))
        if (window.tangu?.setConfig) void window.tangu.setConfig({ forsionLastSyncedAt: Date.now() }).then(setStored)
      } else {
        setSyncMsg(t('settings.forsion.syncFail', { e: r.error || '?' }))
      }
      refreshSyncStatus()
    } catch (e: any) {
      setSyncMsg(t('settings.forsion.syncFail', { e: e?.message || e }))
    } finally {
      setSyncing(false)
    }
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
        void window.tangu!.getConfig().then((s) => {
          setStored(s)
          // 自动同步(默认关):开启则打开设置时拉一次;未登录时后端 no-op,不报错。
          if (s.forsionSyncEnabled) void doSyncNow()
        })
        void window.tangu!.backendStatus!().then(setBackendSt)
        refreshAuth()
        refreshCustomProviders()
        refreshSyncStatus()
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
      pythonMode: stored.pythonMode || 'bundled',
      mirror: stored.mirror || 'default',
    }).then(setStored)
  }

  const refreshWechat = (): void => {
    if (!isDesktop) return
    void getWechatStatus(p.cfg)
      .then((r) => {
        setWechatStatus(r)
        setWechatMsg('')
      })
      .catch((e) => {
        setWechatStatus(null)
        setWechatMsg(t('settings.wechat.statusUnavailable', { e: e?.message || e }))
      })
  }

  const saveRemoteSettings = async (): Promise<void> => {
    if (!stored || !window.tangu?.setConfig) return
    setWechatBusy(true)
    setWechatMsg('')
    try {
      const next = await window.tangu.setConfig({
        browserEnabled: stored.browserEnabled !== false,
        browserEngine: stored.browserEngine || 'auto',
        browserSearchEngine: stored.browserSearchEngine || 'duckduckgo',
        browserAllowPrivateUrls: !!stored.browserAllowPrivateUrls,
        browserCommandTimeoutMs: Number(stored.browserCommandTimeoutMs || 30000),
        wechatEnabled: stored.wechatEnabled !== false,
        wechatDefaultSessionId: stored.wechatDefaultSessionId || p.activeSession?.id || '',
        wechatRemoteApprovalMode: stored.wechatRemoteApprovalMode || 'readonly',
        wechatAllowedPeers: stored.wechatAllowedPeers || [],
      })
      setStored(next)
      setWechatMsg(t('settings.remote.saved'))
    } catch (e: any) {
      setWechatMsg(`${t('settings.toast.saveFailed')}${e?.message || e}`)
    } finally {
      setWechatBusy(false)
    }
  }

  const startWechatBind = async (): Promise<void> => {
    setWechatBusy(true)
    setWechatMsg('')
    try {
      const r = await startWechatLogin(p.cfg, {
        session_id: stored?.wechatDefaultSessionId || undefined,
        model_id: p.activeSession?.model_id || draft.modelId || p.cfg.modelId,
        approval_mode: stored?.wechatRemoteApprovalMode || 'readonly',
      })
      setWechatLogin({ loginId: r.loginId, qrcodeImg: r.qrcodeImg, expiresAt: r.expiresAt, status: 'pending' })
    } catch (e: any) {
      setWechatMsg(t('settings.wechat.startFailed', { e: e?.message || e }))
    } finally {
      setWechatBusy(false)
    }
  }

  const disconnectWechat = async (accountId: string): Promise<void> => {
    setWechatBusy(true)
    setWechatMsg('')
    try {
      await disconnectWechatAccount(p.cfg, accountId)
      setWechatMsg(t('settings.wechat.disconnected'))
      refreshWechat()
    } catch (e: any) {
      setWechatMsg(t('settings.wechat.disconnectFailed', { e: e?.message || e }))
    } finally {
      setWechatBusy(false)
    }
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
    if (p.open && tab === 'wechat') refreshWechat()
    // appVersion 一打开就取(不只 about tab):高级→导出日志也要带版本号,否则导出里恒为 null。
    if (p.open && !appVersion) void window.tangu?.appVersion?.().then((v) => setAppVersion(v || '')).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, tab])

  // 订阅更新状态(主进程经 App 启动检查或本页「检查更新」触发,事件流回这里驱动按钮态)。
  useEffect(() => {
    const off = window.tangu?.onUpdaterStatus?.((st) => setUpd(st))
    return () => off?.()
  }, [])

  useEffect(() => {
    if (!p.open || tab !== 'wechat' || !wechatLogin) return
    let canceled = false
    let timer = 0
    const tick = async (): Promise<void> => {
      try {
        const r = await pollWechatLogin(p.cfg, wechatLogin.loginId)
        if (canceled) return
        setWechatLogin((cur) => (cur && cur.loginId === wechatLogin.loginId ? { ...cur, status: r.status } : cur))
        if (r.status === 'confirmed') {
          setWechatMsg(t('settings.wechat.connectedMsg'))
          setWechatLogin(null)
          if (r.sessionId && window.tangu?.setConfig) {
            void window.tangu.setConfig({ wechatDefaultSessionId: r.sessionId }).then(setStored).catch(() => {})
          }
          refreshWechat()
          window.clearInterval(timer)
        } else if (r.status === 'expired' || r.status === 'failed') {
          setWechatMsg(r.detail || t('settings.wechat.loginStatus', { status: r.status }))
          setWechatLogin(null)
          window.clearInterval(timer)
        }
      } catch (e: any) {
        if (canceled) return
        setWechatMsg(t('settings.wechat.pollFailed', { e: e?.message || e }))
        window.clearInterval(timer)
      }
    }
    timer = window.setInterval(() => void tick(), 2000)
    void tick()
    return () => {
      canceled = true
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, tab, wechatLogin?.loginId])

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

  const tabItems = [
    ['general', t('settings.tab.general')], // = 连接 + Forsion 合并
    ['model', t('settings.tab.model')],
    ...(isDesktop ? ([['agents', t('settings.tab.agents')]] as Array<[Tab, string]>) : []),
    // 技能云端可用:desktop 或 Tangu Web 都显示(保持 desktop 原有顺序:agents→skills→mcp…)。
    ...((isDesktop || cloudWeb) ? ([['skills', t('settings.tab.skills')]] as Array<[Tab, string]>) : []),
    ...(isDesktop ? ([['mcp', 'MCP'], ['hooks', 'Hooks'], ['wechat', t('settings.tab.wechat')], ['browser', t('settings.tab.browser')], ['plugins', t('settings.tab.plugins')]] as Array<[Tab, string]>) : []),
    ...(isDesktop && !!window.amadeus ? ([['notes', t('settings.tab.notes')], ['amadeus-plugins', t('settings.tab.amadeusPlugins')]] as Array<[Tab, string]>) : []),
    ...(isDesktop ? ([['spaces', t('settings.tab.spaces')]] as Array<[Tab, string]>) : []),
    ['theme', t('settings.tab.theme')],
    ['shortcuts', t('settings.tab.shortcuts')],
    ['advanced', t('settings.tab.advanced')],
    ...(isDesktop && devMode ? ([['developer', t('settings.tab.developer')]] as Array<[Tab, string]>) : []),
    ['about', t('settings.tab.about')],
  ] as Array<[Tab, string]>
  const activeTabLabel = tab.startsWith('plugin:')
    ? (pluginNavItems.find(([id]) => id === tab)?.[1] || t('settings.tab.plugins'))
    : (tabItems.find(([id]) => id === tab)?.[1] || t('settings.title'))

  // 分类导航(4 大类):选项 / AI / 核心插件 / 社区插件。每类只渲染 tabItems 里实际存在的项(沿用 desktop/devMode 过滤)。
  const navGroups: Array<{ key: string; label: string; tabs: Tab[] }> = [
    { key: 'options', label: t('settings.group.options'), tabs: ['general', 'spaces', 'theme', 'shortcuts', 'advanced', 'developer', 'about'] },
    { key: 'ai', label: t('settings.group.ai'), tabs: ['model', 'agents', 'skills', 'mcp', 'hooks'] },
    { key: 'core', label: t('settings.group.corePlugins'), tabs: ['wechat', 'browser', 'notes'] },
    { key: 'community', label: t('settings.group.communityPlugins'), tabs: ['plugins', 'amadeus-plugins'] },
  ]

  if (!p.open) return null

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label="Settings navigation">
        {/* 左上角返回 + 设置搜索(codex 风):常驻顶部,不随分类列表滚动。 */}
        <div className="settings-nav-top">
          <button className="settings-back" onClick={p.onClose}>
            <ArrowLeft size={15} /> {t('settings.backToApp')}
          </button>
          <div className="settings-nav-search">
            <Search size={14} className="settings-nav-search-ic" />
            <input
              value={navQuery}
              placeholder={t('settings.searchPlaceholder')}
              onChange={(e) => setNavQuery(e.target.value)}
            />
            {navQuery && <button className="settings-nav-search-x" onClick={() => setNavQuery('')} title={t('common.cancel')}><X size={13} /></button>}
          </div>
        </div>
        <div className="settings-nav-list">
          {navGroups.map((grp) => {
            const base = grp.tabs
              .map((id) => tabItems.find(([tid]) => tid === id))
              .filter((x): x is [Tab, string] => !!x)
            // 「社区插件」组末尾追加已启用且有设置的外置插件,各成一级项。
            const all = grp.key === 'community' ? [...base, ...pluginNavItems] : base
            // 搜索:按项名 / 分组名过滤(命中分组名则保留整组)。
            const ql = navQuery.trim().toLowerCase()
            const items = !ql || grp.label.toLowerCase().includes(ql)
              ? all
              : all.filter(([, label]) => label.toLowerCase().includes(ql))
            if (items.length === 0) return null
            return (
              <div key={grp.key} className="settings-nav-group">
                <div className="settings-nav-grouphead">{grp.label}</div>
                {items.map(([id, label]) => (
                  <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                    {label}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </aside>
      <section className="settings-main">
        <div className="settings-main-head">
          <div className="settings-main-title">{activeTabLabel}</div>
        </div>
        <div className="settings-body">
                {tab === 'general' && (
                  <>
                    <div className="settings-sec">{t('settings.tab.connection')}</div>
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
                        <div className="settings-inline-row">
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
                        <div className="field-row">
                          <div className="field" style={{ maxWidth: 200 }}>
                            <label>{t('settings.python.label')}</label>
                            <select
                              value={stored.pythonMode || 'bundled'}
                              onChange={(e) => setStored({ ...stored, pythonMode: e.target.value as StoredDesktopConfig['pythonMode'] })}
                            >
                              <option value="bundled">{t('settings.python.bundled')}</option>
                              <option value="system">{t('settings.python.system')}</option>
                            </select>
                          </div>
                          <div className="field" style={{ maxWidth: 200 }}>
                            <label>{t('settings.mirror.label')}</label>
                            <select
                              value={stored.mirror || 'default'}
                              onChange={(e) => setStored({ ...stored, mirror: e.target.value as StoredDesktopConfig['mirror'] })}
                            >
                              <option value="default">{t('settings.mirror.default')}</option>
                              <option value="china">{t('settings.mirror.china')}</option>
                            </select>
                          </div>
                        </div>
                        <div className="hint" style={{ marginBottom: 10 }}>{t('settings.python.hint')}</div>
                        <div className="hint" style={{ marginBottom: 10 }}>{t('settings.mirror.hint')}</div>
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

                    {(!isDesktop || mode === 'external') && !cloudWeb && (
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

                {tab === 'general' && isDesktop && (
                  <>
                    <div className="settings-sec settings-sec--gap">{t('settings.tab.forsion')}</div>
                    {/* 账号 */}
                    <div className="field">
                      <label>{t('settings.forsion.accountLabel')}</label>
                      {authSt?.loggedIn && authSt?.tokenValid !== false ? (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span className="conn-pill ok"><span className="dot" />
                            {t('settings.forsion.loggedInAs', { name: authSt.nickname || authSt.username || '' })}
                          </span>
                          <button className="btn ghost sm" onClick={() => void doForsionLogout()} disabled={loggingIn}>
                            {loggingIn ? <Loader2 size={12} className="spin" /> : <LogOut size={12} />} {t('settings.forsion.logout')}
                          </button>
                        </div>
                      ) : (
                        <div>
                          {/* token 仍在但失效 → 不当「已登录」,显式提示过期 + 重新登录(forsionLogin 会 ensureBackend 重连)。 */}
                          {authSt?.loggedIn && authSt?.tokenValid === false && (
                            <div className="hint" style={{ color: 'var(--danger)', marginBottom: 8 }}>{t('settings.forsion.expired')}</div>
                          )}
                          <button className="btn primary sm" onClick={() => void doForsionLogin()} disabled={loggingIn}>
                            {loggingIn ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />} {authSt?.loggedIn && authSt?.tokenValid === false ? t('settings.forsion.relogin') : t('settings.forsion.login')}
                          </button>
                          {device && (
                            <div style={{ marginTop: 10 }}>
                              <QrImage value={device.url} />
                              <div className="hint">{device.url} · {device.userCode}</div>
                            </div>
                          )}
                          <div className="hint" style={{ marginTop: 6 }}>{t('settings.forsion.needLoginHint')}</div>
                        </div>
                      )}
                    </div>

                    {/* 云端地址(一等设置;原仅在开发者选项) */}
                    {stored && (
                      <div className="field">
                        <label><Globe2 size={11} style={{ verticalAlign: -1 }} /> {t('settings.forsion.cloudUrlLabel')}</label>
                        <div className="settings-inline-row">
                          <input
                            type="text"
                            value={stored.cloudUrl}
                            onChange={(e) => setStored({ ...stored, cloudUrl: e.target.value.trim() })}
                            placeholder="https://api.forsion.net"
                          />
                          <button
                            className="btn primary sm"
                            onClick={() => void window.tangu!.setConfig({ cloudUrl: (stored.cloudUrl || '').trim() }).then(setStored)}
                          >
                            {t('settings.forsion.save')}
                          </button>
                        </div>
                        <div className="hint">{t('settings.forsion.cloudUrlHint')}</div>
                      </div>
                    )}

                    {/* Brain 记忆同步 */}
                    {stored && (
                      <div className="field">
                        <label>{t('settings.forsion.syncLabel')}</label>
                        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.forsion.syncHint')}</div>
                        <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                          <input
                            type="checkbox"
                            checked={!!stored.forsionSyncEnabled}
                            onChange={(e) => void window.tangu!.setConfig({ forsionSyncEnabled: e.target.checked }).then(setStored)}
                          />
                          {t('settings.forsion.autoSync')}
                        </label>
                        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.forsion.autoSyncHint')}</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button className="btn primary sm" onClick={() => void doSyncNow()} disabled={syncing}>
                            {syncing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} {syncing ? t('settings.forsion.syncing') : t('settings.forsion.syncNow')}
                          </button>
                          <span className="hint">
                            {t('settings.forsion.lastSynced', {
                              time: stored.forsionLastSyncedAt
                                ? new Date(stored.forsionLastSyncedAt).toLocaleString()
                                : (syncSt?.lastAt ? new Date(syncSt.lastAt).toLocaleString() : t('settings.forsion.never')),
                            })}
                          </span>
                        </div>
                        {syncMsg && <div className="hint" style={{ marginTop: 6 }}>{syncMsg}</div>}
                      </div>
                    )}

                    {/* 哪些功能需要登录 */}
                    <div className="field">
                      <label>{t('settings.forsion.gatedTitle')}</label>
                      <div className="hint">{t('settings.forsion.gatedList')}</div>
                    </div>
                  </>
                )}

                {/* 收件箱(Inbox Space):系统通知开关。非 managedKeys,保存即生效不重启后端。 */}
                {tab === 'general' && isDesktop && stored && (
                  <>
                    <div className="settings-sec settings-sec--gap">{t('settings.inbox.title')}</div>
                    <div className="field">
                      <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={stored.inboxNotifyEnabled !== false}
                          onChange={(e) => void window.tangu!.setConfig({ inboxNotifyEnabled: e.target.checked }).then(setStored)}
                        />
                        {t('settings.inbox.notifyLabel')}
                      </label>
                      <div className="hint">{t('settings.inbox.notifyHint')}</div>
                    </div>
                  </>
                )}

                {tab === 'notes' && stored && (
                  <>
                    <div className="field">
                      <label>{t('settings.notes.modeLabel')}</label>
                      <select
                        value={stored.notesAttachmentMode || 'attachments'}
                        onChange={(e) => void window.tangu!.setConfig({ notesAttachmentMode: e.target.value as StoredDesktopConfig['notesAttachmentMode'] }).then(setStored)}
                      >
                        <option value="attachments">{t('settings.notes.modeAttachments')}</option>
                        <option value="same">{t('settings.notes.modeSame')}</option>
                        <option value="vault">{t('settings.notes.modeVault')}</option>
                      </select>
                      <div className="hint">{t('settings.notes.modeHint')}</div>
                    </div>
                    {(stored.notesAttachmentMode || 'attachments') === 'vault' && (
                      <div className="field">
                        <label>{t('settings.notes.folderLabel')}</label>
                        <div className="settings-inline-row">
                          <input
                            type="text"
                            value={stored.notesAttachmentFolder ?? 'assets'}
                            onChange={(e) => setStored({ ...stored, notesAttachmentFolder: e.target.value })}
                            placeholder="assets"
                          />
                          <button
                            className="btn primary sm"
                            onClick={() => void window.tangu!.setConfig({ notesAttachmentFolder: (stored.notesAttachmentFolder || 'assets').trim().replace(/^\/+|\/+$/g, '') }).then(setStored)}
                          >
                            {t('settings.btn.save')}
                          </button>
                        </div>
                        <div className="hint">{t('settings.notes.folderHint')}</div>
                      </div>
                    )}
                    <div className="field">
                      <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={stored.notesImportPreview !== false}
                          onChange={(e) => void window.tangu!.setConfig({ notesImportPreview: e.target.checked }).then(setStored)}
                        />
                        {t('settings.notes.previewLabel')}
                      </label>
                      <div className="hint">{t('settings.notes.previewHint')}</div>
                    </div>
                    <div className="field">
                      <label>{t('settings.notes.dailyLabel')}</label>
                      <div className="settings-inline-row">
                        <input
                          type="text"
                          value={stored.notesDailyFolder ?? ''}
                          onChange={(e) => setStored({ ...stored, notesDailyFolder: e.target.value })}
                          placeholder={t('settings.notes.dailyPlaceholder')}
                        />
                        <button
                          className="btn primary sm"
                          onClick={() => void window.tangu!.setConfig({ notesDailyFolder: (stored.notesDailyFolder || '').trim().replace(/^\/+|\/+$/g, '') }).then(setStored)}
                        >
                          {t('settings.btn.save')}
                        </button>
                      </div>
                      <div className="hint">{t('settings.notes.dailyHint')}</div>
                    </div>
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
                          models={models.models.filter((m) => (m.modelType || 'llm') === 'llm')}
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

                    {/* 生图模型(generate_image 用):始终可见,选中即设为默认;无则给配置指引。 */}
                    <div className="field">
                      <label>{t('settings.model.imageModelsLabel')}</label>
                      {(() => {
                        const imgs = (models?.models || []).filter((m) => m.modelType === 'image_gen')
                        if (!imgs.length) return <div className="hint">{modelsLoading ? t('common.loading') : t('settings.model.imageEmpty')}</div>
                        return (
                          <div className="model-group-body">
                            {imgs.map((m) => (
                              <button
                                key={`${m.source}-${m.id}`}
                                className={`file-row${(draft.imageModelId || '') === m.id ? ' active' : ''}`}
                                onClick={() => { setDraft({ ...draft, imageModelId: m.id }); p.onConfigChange({ imageModelId: m.id }) }}
                              >
                                <span className="file-name" style={{ color: (draft.imageModelId || '') === m.id ? 'var(--accent)' : undefined }}>{m.name}</span>
                                {m.source === 'direct' && <span className="model-group-tag">{t('model.group.direct')}</span>}
                                {(draft.imageModelId || '') === m.id && <Check size={12} style={{ color: 'var(--accent)' }} />}
                              </button>
                            ))}
                          </div>
                        )
                      })()}
                      <div className="hint" style={{ marginTop: 4 }}>{t('settings.model.imageHelp')}</div>
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
                                  setEditProvider({ ...cp, modelsCsv: (cp.modelIds || []).join(', '), imageModelsCsv: (cp.imageModelIds || []).join(', '), ttsModelsCsv: (cp.ttsModelIds || []).join(', ') })
                                  setProviderTestMsg('')
                                  setProviderSaveMsg('')
                                  setFetchedModels(null); setModelSearch(''); setFetchModelsMsg('')
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
                            setEditProvider({ providerId: '', baseUrl: '', apiKey: '', modelIds: [], modelsCsv: '', imageModelsCsv: '', ttsModelsCsv: '' })
                            setProviderTestMsg('')
                            setProviderSaveMsg('')
                            setFetchedModels(null); setModelSearch(''); setFetchModelsMsg('')
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
                          <div className="field">
                            <label>{t('settings.customProvider.imageModelsLabel')}</label>
                            <input
                              type="text"
                              value={editProvider.imageModelsCsv}
                              onChange={(e) => setEditProvider({ ...editProvider, imageModelsCsv: e.target.value })}
                              placeholder={t('settings.customProvider.imageModelsPlaceholder')}
                            />
                          </div>
                          <div className="field">
                            <label>{t('settings.customProvider.ttsModelsLabel')}</label>
                            <input
                              type="text"
                              value={editProvider.ttsModelsCsv}
                              onChange={(e) => setEditProvider({ ...editProvider, ttsModelsCsv: e.target.value })}
                              placeholder={t('settings.customProvider.ttsModelsPlaceholder')}
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
                            className="btn ghost sm"
                            disabled={fetchingModels || !editProvider.baseUrl}
                            onClick={() => {
                              setFetchingModels(true)
                              setFetchModelsMsg('')
                              void fetchProviderModels(p.cfg, {
                                baseUrl: editProvider.baseUrl,
                                apiKey: editProvider.apiKey || undefined,
                              })
                                .then((ms) => {
                                  setFetchedModels(ms.map((m) => m.id))
                                  setModelSearch('')
                                  if (!ms.length) setFetchModelsMsg(t('settings.customProvider.fetchEmpty'))
                                })
                                .catch((e) => { setFetchedModels([]); setFetchModelsMsg(`✗ ${e?.message || e}`) })
                                .finally(() => setFetchingModels(false))
                            }}
                          >
                            {fetchingModels ? <Loader2 size={12} className="spin" /> : <Download size={12} />} {t('settings.customProvider.fetchModels')}
                          </button>
                          <button
                            className="btn primary sm"
                            disabled={!editProvider.providerId || !editProvider.baseUrl}
                            onClick={() => {
                              const modelIds = editProvider.modelsCsv.split(',').map((s) => s.trim()).filter(Boolean)
                              const imageModelIds = editProvider.imageModelsCsv.split(',').map((s) => s.trim()).filter(Boolean)
                              const ttsModelIds = editProvider.ttsModelsCsv.split(',').map((s) => s.trim()).filter(Boolean)
                              void window.tangu!.saveProvider!({
                                providerId: editProvider.providerId,
                                baseUrl: editProvider.baseUrl.replace(/\/+$/, ''),
                                apiKey: editProvider.apiKey || undefined,
                                modelIds: modelIds.length ? modelIds : undefined,
                                imageModelIds: imageModelIds.length ? imageModelIds : undefined,
                                ttsModelIds: ttsModelIds.length ? ttsModelIds : undefined,
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
                          <button className="btn ghost sm" onClick={() => { setEditProvider(null); setFetchedModels(null); setModelSearch(''); setFetchModelsMsg('') }}>{t('settings.btn.cancel')}</button>
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{providerTestMsg}</span>
                        </div>

                        {/* 「拉取模型」结果:可搜索多选,勾选写回 modelsCsv(让用户无需手记模型名)。 */}
                        {fetchedModels && (() => {
                          const selected = new Set(editProvider.modelsCsv.split(',').map((s) => s.trim()).filter(Boolean))
                          const mq = modelSearch.trim().toLowerCase()
                          const shown = mq ? fetchedModels.filter((id) => id.toLowerCase().includes(mq)) : fetchedModels
                          const toggle = (id: string) => {
                            const next = new Set(selected)
                            next.has(id) ? next.delete(id) : next.add(id)
                            setEditProvider({ ...editProvider, modelsCsv: [...next].join(', ') })
                          }
                          return (
                            <div className="field" style={{ marginTop: 8 }}>
                              {fetchedModels.length > 0 ? (
                                <>
                                  <span className="model-search" style={{ marginBottom: 6 }}>
                                    <Search size={12} />
                                    <input value={modelSearch} placeholder={t('model.searchPlaceholder')} onChange={(e) => setModelSearch(e.target.value)} />
                                  </span>
                                  <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    {shown.map((id) => (
                                      <button
                                        key={id}
                                        className={`file-row${selected.has(id) ? ' active' : ''}`}
                                        onClick={() => toggle(id)}
                                      >
                                        <span className="file-name" style={{ color: selected.has(id) ? 'var(--accent)' : undefined }}>{id}</span>
                                        {selected.has(id) && <Check size={12} style={{ color: 'var(--accent)' }} />}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              ) : (
                                <div className="hint">{fetchModelsMsg || t('settings.customProvider.fetchEmpty')}</div>
                              )}
                            </div>
                          )
                        })()}
                        {fetchModelsMsg && fetchedModels && fetchedModels.length > 0 && (
                          <div className="hint" style={{ marginTop: 4 }}>{fetchModelsMsg}</div>
                        )}
                      </>
                    )}

                    {stored?.mode === 'external' && !(stored?.backendUrl || '').includes('localhost') && !(stored?.backendUrl || '').includes('127.0.0.1') && (
                      <div className="hint" style={{ marginTop: 10 }}>
                        {t('settings.customProvider.externalWarning')}
                      </div>
                    )}

                    {/* 语音朗读(TTS):OpenAI 兼容 /audio/speech;模型 id 命中直连 provider 的 ttsModelIds 或 <providerId>/<model>。 */}
                    {stored && (
                      <>
                        <div className="panel-section-title" style={{ marginTop: 8, padding: '12px 0 6px', borderTop: 'var(--border-width) solid var(--border)' }}>
                          {t('settings.tts.sectionTitle')}
                        </div>
                        <div className="field">
                          <label>{t('settings.tts.model')}</label>
                          <div className="hint" style={{ marginBottom: 8 }}>{t('settings.tts.intro')}</div>
                          <input
                            type="text"
                            value={stored.ttsModelId ?? ''}
                            onChange={(e) => setStored({ ...stored, ttsModelId: e.target.value })}
                            onBlur={() => void window.tangu!.setConfig({ ttsModelId: (stored.ttsModelId || '').trim() }).then(setStored)}
                            placeholder={t('settings.tts.modelPlaceholder')}
                          />
                        </div>
                        <div className="field">
                          <label>{t('settings.tts.voice')}</label>
                          <input
                            type="text"
                            list="tts-voice-options"
                            value={stored.ttsVoice ?? ''}
                            onChange={(e) => setStored({ ...stored, ttsVoice: e.target.value })}
                            onBlur={() => void window.tangu!.setConfig({ ttsVoice: (stored.ttsVoice || '').trim() }).then(setStored)}
                            placeholder={t('settings.tts.voicePlaceholder')}
                          />
                          {/* 系统音色候选(可输可选;百炼无音色列表 API,静态表);复刻/设计音色经下方工作室「使用」自动填入 */}
                          <datalist id="tts-voice-options">
                            {TTS_VOICE_SUGGESTIONS.map(([v, label]) => <option key={v} value={v} label={label} />)}
                          </datalist>
                        </div>
                        <div className="field">
                          <label>{t('settings.tts.speed')}</label>
                          <input
                            type="number"
                            min={0.5}
                            max={2}
                            step={0.1}
                            style={{ width: 90 }}
                            value={ttsSpeedText ?? String(stored.ttsSpeed ?? 1)}
                            onChange={(e) => setTtsSpeedText(e.target.value)}
                            onBlur={() => {
                              const n = Number(ttsSpeedText)
                              const v = ttsSpeedText !== null && Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 0.5), 2) : (stored.ttsSpeed ?? 1)
                              setTtsSpeedText(null)
                              void window.tangu!.setConfig({ ttsSpeed: v }).then(setStored)
                            }}
                          />
                        </div>
                        <div className="field">
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button
                              className="btn ghost sm"
                              disabled={ttsTesting || !(stored.ttsModelId || '').trim()}
                              onClick={() => {
                                setTtsTesting(true); setTtsTestMsg('')
                                previewTts(p.cfg, { model: (stored.ttsModelId || '').trim(), voice: (stored.ttsVoice || '').trim() || undefined, speed: stored.ttsSpeed }, t('settings.tts.testText'))
                                  .then(() => setTtsTestMsg(`✓ ${t('settings.tts.testOk')}`))
                                  .catch((e: any) => setTtsTestMsg(`✗ ${e?.message || e}`))
                                  .finally(() => setTtsTesting(false))
                              }}
                            >
                              {ttsTesting ? <Loader2 size={12} className="spin" /> : <Play size={12} />} {t('settings.tts.testBtn')}
                            </button>
                            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{ttsTestMsg}</span>
                          </div>
                        </div>
                        <div className="field">
                          <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              type="checkbox"
                              checked={stored.ttsAutoSpeak === true}
                              onChange={(e) => void window.tangu!.setConfig({ ttsAutoSpeak: e.target.checked }).then(setStored)}
                            />
                            {t('settings.tts.autoSpeak')}
                          </label>
                          <div className="hint">{t('settings.tts.autoSpeakHint')}</div>
                        </div>
                        {(() => {
                          // 百炼音色工作室:有指向阿里云百炼的 provider 才可用(域名判定与后端 isDashScopeBase 一致)。
                          // 非本地 external 后端不渲染:本地 providers 文件到不了远端 registry,采用的音色无法合成(判定同上方 externalWarning)。
                          const remoteExternal = stored?.mode === 'external' && !(stored?.backendUrl || '').includes('localhost') && !(stored?.backendUrl || '').includes('127.0.0.1')
                          if (remoteExternal) return null
                          const ds = customProviders.find((cp) => /dashscope|aliyuncs\.com/i.test(cp.baseUrl))
                          return ds
                            ? <TtsVoiceStudio cfg={p.cfg} provider={ds} onApplied={() => void window.tangu!.getConfig().then(setStored)} />
                            : <div className="hint">{t('settings.tts.studio.needProvider')}</div>
                        })()}
                      </>
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

                {tab === 'agents' && <><div className="settings-sec">{t('settings.tab.agents')}</div><AgentsSettings cfg={p.cfg} /></>}
                {tab === 'hooks' && <><div className="settings-sec">Hooks</div><HooksTab cfg={p.cfg} /></>}
                {tab === 'plugins' && (
                  <PluginsTab
                    cfg={p.cfg}
                    plugins={plugins}
                    onReload={reloadPlugins}
                    onOpenSettings={(id) => setTab(`plugin:${id}` as Tab)}
                  />
                )}
                {tab === 'amadeus-plugins' && <AmadeusPluginsTab />}
                {tab === 'spaces' && <><div className="settings-sec">{t('settings.tab.spaces')}</div><SpacesTab /></>}
                {tab.startsWith('plugin:') && (() => {
                  const pid = tab.slice('plugin:'.length)
                  const pl = (plugins || []).find((x) => x.id === pid)
                  return pl
                    ? <PluginSettingsPage cfg={p.cfg} plugin={pl} agents={pluginAgents} />
                    : <div className="hint">{t('settings.plugins.empty')}</div>
                })()}
                {tab === 'agents' && <><div className="settings-sec settings-sec--gap">{t('settings.tab.agentClis')}</div><AgentClisTab cfg={p.cfg} /></>}

                {tab === 'browser' && stored && (
                  <>
                    <div className="settings-section-title">
                      <Globe2 size={14} /> {t('settings.browser.title')}
                    </div>
                    <div className="field">
                      <label>{t('settings.browser.agentBrowser')}</label>
                      <div className="seg">
                        <button
                          className={stored.browserEnabled !== false ? 'active' : ''}
                          onClick={() => setStored({ ...stored, browserEnabled: true })}
                        >
                          {t('common.enabled')}
                        </button>
                        <button
                          className={stored.browserEnabled === false ? 'active' : ''}
                          onClick={() => setStored({ ...stored, browserEnabled: false })}
                        >
                          {t('common.disabled')}
                        </button>
                      </div>
                      <div className="hint">
                        {t('settings.browser.hint')}
                      </div>
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label>{t('settings.browser.engine')}</label>
                        <select
                          value={stored.browserEngine || 'auto'}
                          onChange={(e) => setStored({ ...stored, browserEngine: e.target.value as StoredDesktopConfig['browserEngine'] })}
                        >
                          <option value="auto">Auto</option>
                          <option value="chrome">Chrome</option>
                          <option value="lightpanda">Lightpanda</option>
                        </select>
                      </div>
                      <div className="field">
                        <label>{t('settings.browser.searchEngine')}</label>
                        <select
                          value={stored.browserSearchEngine || 'duckduckgo'}
                          onChange={(e) => setStored({ ...stored, browserSearchEngine: e.target.value as StoredDesktopConfig['browserSearchEngine'] })}
                        >
                          <option value="duckduckgo">DuckDuckGo</option>
                          <option value="bing">Bing</option>
                          <option value="google">Google</option>
                          <option value="baidu">Baidu</option>
                        </select>
                      </div>
                      <div className="field" style={{ maxWidth: 160 }}>
                        <label>{t('settings.browser.timeout')}</label>
                        <input
                          type="text"
                          value={String(stored.browserCommandTimeoutMs || 30000)}
                          onChange={(e) => setStored({ ...stored, browserCommandTimeoutMs: Number(e.target.value.replace(/[^\d]/g, '')) || 30000 })}
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={!!stored.browserAllowPrivateUrls}
                          onChange={(e) => setStored({ ...stored, browserAllowPrivateUrls: e.target.checked })}
                        />
                        {t('settings.browser.allowPrivate')}
                      </label>
                      <div className="hint">{t('settings.browser.allowPrivateHint')}</div>
                    </div>
                    <button className="btn primary sm" disabled={wechatBusy} onClick={() => void saveRemoteSettings()}>
                      {wechatBusy ? <Loader2 size={12} className="spin" /> : null}
                      {t('settings.btn.save')}
                    </button>
                    {wechatMsg && <div className="hint" style={{ marginTop: 8 }}>{wechatMsg}</div>}
                  </>
                )}

                {tab === 'wechat' && stored && (
                  <>
                    <div className="settings-section-title">
                      <Smartphone size={14} /> {t('settings.wechat.title')}
                    </div>
                    <div className="field">
                      <label>{t('settings.wechat.channel')}</label>
                      <div className="seg">
                        <button
                          className={stored.wechatEnabled !== false ? 'active' : ''}
                          onClick={() => setStored({ ...stored, wechatEnabled: true })}
                        >
                          {t('common.enabled')}
                        </button>
                        <button
                          className={stored.wechatEnabled === false ? 'active' : ''}
                          onClick={() => setStored({ ...stored, wechatEnabled: false })}
                        >
                          {t('common.disabled')}
                        </button>
                      </div>
                      <div className="hint">
                        {t('settings.wechat.hint')}
                      </div>
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label>{t('settings.wechat.defaultSession')}</label>
                        <input
                          type="text"
                          value={stored.wechatDefaultSessionId || p.activeSession?.id || ''}
                          onChange={(e) => setStored({ ...stored, wechatDefaultSessionId: e.target.value.trim() })}
                          placeholder={p.activeSession?.id || t('settings.wechat.defaultSessionPlaceholder')}
                        />
                      </div>
                      <div className="field" style={{ maxWidth: 220 }}>
                        <label>{t('settings.wechat.approvalMode')}</label>
                        <select
                          value={stored.wechatRemoteApprovalMode || 'readonly'}
                          onChange={(e) => setStored({ ...stored, wechatRemoteApprovalMode: e.target.value as StoredDesktopConfig['wechatRemoteApprovalMode'] })}
                        >
                          <option value="readonly">{t('approval.mode.readonly')}</option>
                          <option value="auto-edit">{t('approval.mode.autoEdit')}</option>
                          <option value="full-auto">{t('approval.mode.fullAuto')}</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                      <button className="btn primary sm" disabled={wechatBusy} onClick={() => void saveRemoteSettings()}>
                        {wechatBusy ? <Loader2 size={12} className="spin" /> : null}
                        {t('settings.btn.save')}
                      </button>
                      <button className="btn ghost sm" disabled={wechatBusy || stored.wechatEnabled === false} onClick={() => void startWechatBind()}>
                        {wechatBusy ? <Loader2 size={12} className="spin" /> : <QrCode size={12} />}
                        {t('settings.wechat.startQr')}
                      </button>
                      <button className="btn ghost sm" onClick={refreshWechat}>
                        <RefreshCw size={12} /> {t('common.refresh')}
                      </button>
                      {wechatStatus && (
                        <span className={`conn-pill ${wechatStatus.enabled ? 'ok' : ''}`}>
                          <span className="dot" />
                          {wechatStatus.enabled ? t('settings.wechat.runtimeOn') : t('settings.wechat.runtimeOff')}
                        </span>
                      )}
                    </div>
                    {wechatLogin && (
                      <div className="wechat-login-box">
                        <QrImage className="wechat-qr" value={wechatLogin.qrcodeImg} size={132} alt={t('settings.wechat.qrAlt')} />
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.wechat.scanTitle')}</div>
                          <div className="hint">{t('settings.wechat.statusLine', { status: wechatLogin.status || 'pending', time: new Date(wechatLogin.expiresAt).toLocaleTimeString() })}</div>
                        </div>
                      </div>
                    )}
                    {wechatStatus?.bindings.length ? (
                      <div className="field">
                        <label>{t('settings.wechat.bindings')}</label>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {wechatStatus.bindings.map((b) => (
                            <div key={b.id} className="file-row" style={{ cursor: 'default' }}>
                              <span className="file-name">
                                <b>{b.wx_user_id || b.account_id}</b>
                                <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                                  {b.peer_id ? t('settings.wechat.peer', { peer: b.peer_id }) : t('settings.wechat.waitingPeer')}
                                </span>
                              </span>
                              <span className="file-size">{b.session_title || b.session_id} · {b.remote_approval_mode}</span>
                              <button
                                className="icon-btn"
                                disabled={wechatBusy}
                                title={t('settings.wechat.disconnect')}
                                onClick={() => void disconnectWechat(b.account_id)}
                              >
                                <LogOut size={13} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="hint">{t('settings.wechat.noBinding')}</div>
                    )}
                    {wechatMsg && <div className="hint" style={{ marginTop: 8 }}>{wechatMsg}</div>}
                  </>
                )}

                {tab === 'theme' && (
                  <>
                    <div className="field">
                      <label>{t('settings.theme.langLabel')}</label>
                      <div className="theme-grid">
                        {listLanguages().map((th) => (
                          <ThemeCard
                            key={th.manifest.id}
                            entry={th}
                            mode={p.themeMode}
                            active={th.manifest.id === p.themeLang}
                            onSelect={() => {
                              applyTheme(th.manifest.id, p.themeSkin, p.themeMode, { customColor: p.themeSeed })
                              p.onThemeChange(th.manifest.id, p.themeSkin, p.themeMode)
                            }}
                          />
                        ))}
                      </div>
                      <div className="field-row" style={{ gap: 8, marginTop: 8 }}>
                        <button type="button" className="btn sm" onClick={() => { void window.tangu?.openThemesDir?.() }}>
                          <FolderOpen size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          {t('settings.theme.openFolder')}
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={themesReloading}
                          onClick={async () => {
                            setThemesReloading(true)
                            try { await p.onReloadThemes?.() } finally { setThemesReloading(false) }
                          }}
                        >
                          <RefreshCw size={13} className={themesReloading ? 'spin' : ''} style={{ verticalAlign: -2, marginRight: 4 }} />
                          {t('settings.theme.reload')}
                        </button>
                      </div>
                      <div className="hint" style={{ marginTop: 6 }}>{t('settings.theme.dropHint')}</div>
                    </div>
                    <div className="field">
                      <label>{t('settings.theme.skinLabel')}</label>
                      <div className="skin-row">
                        {listSkins().map((sk) => (
                          <button
                            key={sk.id}
                            type="button"
                            className={`skin-chip${sk.id === p.themeSkin ? ' active' : ''}`}
                            title={t(`settings.theme.skin.${sk.id}`)}
                            onClick={() => {
                              applyTheme(p.themeLang, sk.id, p.themeMode, { customColor: p.themeSeed })
                              p.onThemeChange(p.themeLang, sk.id, p.themeMode)
                            }}
                          >
                            <i className="skin-dot" style={{ background: sk.id === 'custom' ? p.themeSeed : sk.accent }} />
                            <span>{t(`settings.theme.skin.${sk.id}`)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {p.themeSkin === 'custom' && (
                      <div className="field">
                        <label>{t('settings.theme.customSeedLabel')}</label>
                        <div className="field-row" style={{ alignItems: 'center', gap: 10 }}>
                          <input
                            type="color"
                            value={p.themeSeed}
                            onChange={(e) => {
                              applyTheme(p.themeLang, 'custom', p.themeMode, { customColor: e.target.value })
                              p.onSeedChange(e.target.value)
                            }}
                            aria-label={t('settings.theme.customSeedLabel')}
                            style={{ width: 48, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                          />
                          <span className="hint" style={{ fontFamily: 'var(--font-mono)' }}>{p.themeSeed}</span>
                        </div>
                      </div>
                    )}
                    <div className="field">
                      <label>{t('settings.theme.modeLabel')}</label>
                      <div className="seg">
                        <button
                          className={p.themeMode === 'light' ? 'active' : ''}
                          onClick={() => {
                            applyTheme(p.themeLang, p.themeSkin, 'light', { customColor: p.themeSeed })
                            p.onThemeChange(p.themeLang, p.themeSkin, 'light')
                          }}
                        >
                          <Sun size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          {t('settings.theme.light')}
                        </button>
                        <button
                          className={p.themeMode === 'dark' ? 'active' : ''}
                          onClick={() => {
                            applyTheme(p.themeLang, p.themeSkin, 'dark', { customColor: p.themeSeed })
                            p.onThemeChange(p.themeLang, p.themeSkin, 'dark')
                          }}
                        >
                          <Moon size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          {t('settings.theme.dark')}
                        </button>
                      </div>
                    </div>
                    <div className="field">
                      <label>{t('settings.theme.flatLabel')}</label>
                      <div className="seg">
                        <button className={!p.flatOn ? 'active' : ''} onClick={() => p.onFlatChange(false)}>{t('settings.theme.flatOff')}</button>
                        <button className={p.flatOn ? 'active' : ''} onClick={() => p.onFlatChange(true)}>{t('settings.theme.flatOn')}</button>
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

                {tab === 'shortcuts' && <ShortcutsTab />}

                {tab === 'skills' && (
                  <>
                    <div className="field">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {t('settings.skills.libraryLabel')}
                        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={loadAllSkills} title={t('common.refresh')}>
                          <RefreshCw size={12} className={allSkillsLoading ? 'spin' : ''} />
                        </button>
                        {window.tangu?.openSkillsDir && (
                          <button className="icon-btn" style={{ width: 22, height: 22 }} title={t('settings.skills.openFolder')} onClick={() => void window.tangu?.openSkillsDir?.()}>
                            <FolderOpen size={12} />
                          </button>
                        )}
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

                    <div className="field" style={{ marginTop: 14 }}>
                      <label>恢复默认布局</label>
                      <div className="hint" style={{ marginBottom: 8 }}>把工作区面板还原为默认黄金分割布局(中间 0.618 / 左右各 0.191),并清除已保存的自定义布局。</div>
                      <button
                        className="btn ghost sm"
                        onClick={() => { useWorkspace.getState().resetLayout(); p.onClose() }}
                      >
                        <RotateCcw size={13} />
                        恢复默认布局
                      </button>
                    </div>

                    <div className="field" style={{ marginTop: 14 }}>
                      <label>{t('settings.advanced.sessionLimit')}</label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        defaultValue={(() => { try { return Math.max(1, Number(localStorage.getItem('tangu_ws_session_limit')) || 5) } catch { return 5 } })()}
                        onChange={(e) => {
                          const n = Math.max(1, Math.min(50, Math.floor(Number(e.target.value) || 5)))
                          try { localStorage.setItem('tangu_ws_session_limit', String(n)) } catch { /* ignore */ }
                          window.dispatchEvent(new Event('tangu:wslimit'))
                        }}
                        style={{ width: 110 }}
                      />
                    </div>

                    <div className="field" style={{ marginTop: 14 }}>
                      <label>{t('settings.advanced.exportLogs')}</label>
                      <div className="hint" style={{ marginBottom: 8 }}>{t('settings.advanced.exportLogsHint')}</div>
                      <button
                        className="btn ghost sm"
                        onClick={() => void exportSessionLogs()}
                        disabled={exporting || !p.activeSession}
                      >
                        {exporting ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
                        {t('settings.advanced.exportBtn')}
                      </button>
                      {!p.activeSession && <div className="hint" style={{ marginTop: 6 }}>{t('settings.advanced.exportNoSession')}</div>}
                      {exportMsg && <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>{exportMsg}</div>}
                    </div>

                    {window.tangu?.clearAppData && (
                      <div className="field" style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                        <label style={{ color: 'var(--danger)' }}>{t('settings.clearData.label')}</label>
                        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.clearData.hint')}</div>
                        <label className="inline-check">
                          <input type="checkbox" checked={clearTangu} onChange={(e) => setClearTangu(e.target.checked)} />
                          {t('settings.clearData.tangu')}
                        </label>
                        <label className="inline-check" style={{ marginTop: 4 }}>
                          <input type="checkbox" checked={clearDesktop} onChange={(e) => setClearDesktop(e.target.checked)} />
                          {t('settings.clearData.desktop')}
                        </label>
                        <div style={{ marginTop: 10 }}>
                          <button
                            className="btn danger sm"
                            disabled={!clearTangu && !clearDesktop}
                            onClick={() => {
                              if (!clearTangu && !clearDesktop) return
                              if (!window.confirm(t('settings.clearData.confirm'))) return
                              void window.tangu?.clearAppData?.({ tangu: clearTangu, desktop: clearDesktop })
                            }}
                          >
                            <Trash2 size={13} /> {t('settings.clearData.btn')}
                          </button>
                        </div>
                        {window.tangu?.platform === 'darwin' && (
                          <div className="hint" style={{ marginTop: 6 }}>{t('settings.clearData.macNote')}</div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {tab === 'developer' && (
                  <>
                    <div className="panel-note">{t('settings.developer.note')}</div>
                    {/* cloudURL 去重:统一在「账户」组(Forsion 页)管理,开发者页不再重复 */}
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
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={showSysPrompt}
                          onChange={(e) => {
                            const on = e.target.checked
                            setShowSysPrompt(on)
                            try { localStorage.setItem(SHOW_SYSTEM_PROMPT_KEY, on ? '1' : '0') } catch { /* ignore */ }
                          }}
                        />
                        {t('settings.developer.showSystemPrompt')}
                      </label>
                      <div className="hint">{t('settings.developer.showSystemPromptHint')}</div>
                    </div>
                    <div className="field">
                      <label>{t('settings.developer.testUpdateLabel')}</label>
                      <div>
                        <button className="btn ghost sm" onClick={() => { openChangelogTab(); p.onClose() }}>
                          <RefreshCw size={12} /> {t('settings.developer.testUpdate')}
                        </button>
                      </div>
                      <div className="hint">{t('settings.developer.testUpdateHint')}</div>
                    </div>
                    <div className="field">
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          try { localStorage.removeItem(DEV_MODE_KEY) } catch { /* ignore */ }
                          // 关开发者模式顺手清掉「显示 system prompt」,免得关了 tab 还在聊天里冒调试块。
                          try { localStorage.removeItem(SHOW_SYSTEM_PROMPT_KEY) } catch { /* ignore */ }
                          setShowSysPrompt(false)
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
                      <UpdateActions upd={upd} />
                    </div>
                    {(upd.phase === 'available' || upd.phase === 'downloaded') && (
                      <div className="field">
                        <div style={{ fontWeight: 600 }}>{t('about.update.available', { version: upd.version || '' })}</div>
                        {upd.releaseNotes ? (
                          <div className="hint" style={{ marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{upd.releaseNotes}</div>
                        ) : null}
                      </div>
                    )}
                    {upd.phase === 'error' && upd.error ? (
                      <div className="field"><div className="hint" style={{ color: 'var(--danger)' }}>{t('about.update.error', { error: upd.error })}</div></div>
                    ) : null}
                    <div className="field">
                      <label>{t('about.changelogTitle')}</label>
                      <div className="changelog">
                        {CHANGELOG.map((c) => (
                          <div key={c.version} className="changelog-entry md-body">
                            <div className="changelog-ver">
                              {c.version} <span className="changelog-date">{c.date}</span>
                            </div>
                            <Markdown content={c.lines.map((l) => `- ${l}`).join('\n')} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
        </div>
      </section>
    </div>
  )
}
