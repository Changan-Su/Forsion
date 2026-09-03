/**
 * 设置页:连接 / 模型 / MCP / Browser / WeChat / 主题 / 高级。
 * 在 Desktop 主界面内替换 Chat/Inspector 区域，而不是覆盖式弹窗。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { X, ArrowLeft, ChevronRight, Loader2, RefreshCw, Sun, Moon, MonitorCog, RotateCcw, LogIn, LogOut, KeyRound, Plus, Trash2, Plug, Search, Download, Sparkles, Wrench, Check, Copy, Globe2, FolderOpen, Play, Trophy, FileDown, Settings2, NotebookPen, Puzzle, LayoutGrid, Palette, Keyboard, Bug, Info, Brain, Bot, Webhook, MessageCircle, Blocks, Bell, PanelBottom, Image as ImageIcon, Server, Type, Layers3, MousePointer2 } from 'lucide-react'
import { ThemeCard } from './ThemeCard'
import { ThemeSettingsPanel } from './ThemeSettingsPanel'
import { backgroundSwatch, listLanguages, listSkins, skinSwatch, forcedSchemeForLanguage } from '../theme/registry'
import { UI_MODE, useWorkspace } from '@lcl/engine' // 工作区引擎:恢复默认布局 + 移动预览模式
import { useApp } from '../stores/appStore' // Agent Desk 开关改动即时回流(desktopConfig 平时只在 boot/后端就绪时刷新)
import { testConnection } from '../services/agentRunService'
import {
  deleteUserCloudSkill, fetchProviderModels,
  listModels, listSkills, listTools,
  testProviderConnection, uploadSkillToCloud, syncNow as backendSyncNow, getSyncStatus as backendGetSyncStatus,
  listPlugins, listAgents, type PluginInfo, type SyncStatusResult,
  getLocalWebSearch, saveLocalWebSearch, testLocalWebSearch, type LocalWebSearchRedacted,
} from '../services/backendService'
import { ChannelsTab } from './ChannelsTab'
import { buildSessionLogPayload, sessionLogFilename } from '../services/sessionLog'
import type {
  AmadeusSyncStatus, AuthStatusInfo, BackendStatusInfo, DirectProviderConfig, DiscoveryResult, McpServerConfigEntry, MirrorTestResult, ModelsResponse,
  NormalAgentDef, SessionRecord, SkillInfo, StoredDesktopConfig, TanguDesktopConfig, ToolsResponse, UpdaterStatusInfo,
} from '../types'
import { SHOW_SYSTEM_PROMPT_KEY, SMOOTH_CARET_KEY } from '../types'
import { isSmoothCaretOn, setSmoothCaretEnabled } from '../smoothCaret'
import { applyUiFonts, readFont, writeFont, type FontSlot } from '../uiFont'
import { listFonts, getFont } from '../fontPresets'
import { registerMessages, useI18n } from '../i18n'
import { LocaleToggle } from './LocaleToggle'
import { BrandLogo } from './BrandLogo'
import { ThemePreview } from './ThemePreview'
import { RemoteSyncSection } from './RemoteSyncSection'
import { CHANGELOG } from '../changelog'
import { Markdown } from './Markdown'
import { UpdateActions } from './UpdateActions'
import { openChangelogTab } from '../views/ChangelogView'
import { ModelGroupList } from './ModelGroupList'
import { ModelSelect } from './ModelSelect'
import { AsrModelChoice } from './AsrModelChoice'
import { AuxModelChoice } from './AuxModelChoice'
import { AgentsTab } from './AgentsTab'
import { SpecialAgentsTab } from './SpecialAgentsTab'
import { TtsVoiceStudio } from './TtsVoiceStudio'
import { previewTts } from '../services/ttsService'
import { ShortcutsTab } from './ShortcutsTab'
import { PluginsTab } from './PluginsTab'
import { AmadeusPluginsTab } from './AmadeusPluginsTab'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { pluginDisplayName, pluginsWithSettingsPanel } from '../amadeus/plugins/display'
import { SpacesTab } from './SpacesTab'
import { NotificationsTab, StatusBarTab } from './NotificationsTab'
import { HooksTab } from './HooksTab'
import { PluginSettingsPage } from './PluginSettingsPage'
import { AgentClisTab } from './AgentClisTab'
import { QrImage } from './QrImage'
import { likelyMainlandChina } from './OnboardingWizard'
import { EnvProbeSection } from './EnvProbeSection'
import { debugFireToast } from '../achievements/store'
import { useTheme } from '../stores/themeStore'
import { setMobileUiCommand, MOBILE_UI_KEY } from '../mobileUiCommand'
import { setActivityViewCommand, ACTIVITY_VIEW_KEY } from '../activityViewCommand'
import { setActiveWindowCommand } from '../activeWindowCommand'
import { setWikiFilesEnabled } from '@amadeus/lib/wikiFiles'
import { setUpgradeV4Enabled } from '@amadeus/lib/upgradeV4'
import { deleteAssetsPref, setDeleteAssetsPref } from '@amadeus/components/askDeleteAssets'
import { canvasDoubleClickFocusEnabled, canvasOverviewZoom, setCanvasDoubleClickFocusEnabled, setCanvasOverviewZoom } from '@amadeus/unified/canvasPrefs'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'

// 本文件自带的文案片段(命名空间 `settingsmodal.*`,不与 i18n.generated.ts 的 `settings.*` 相交)。
registerMessages({
  'settingsmodal.model.providerSep': { zh: '、', en: ', ' },
  'settingsmodal.advanced.resetLayout': { zh: '恢复默认布局', en: 'Restore default layout' },
  'settingsmodal.advanced.resetLayoutHint': {
    zh: '把工作区面板还原为默认黄金分割布局(中间 0.618 / 左右各 0.191),并清除已保存的自定义布局。',
    en: 'Restores the workspace panels to the default golden-ratio layout (0.618 in the middle, 0.191 on each side) and clears any saved custom layout.',
  },
  // 系统音色候选的显示名。⚠️ 只有**标签**进字典,音色 id(Cherry/Dylan/alloy…)是接口标识符,永不翻译。
  'settingsmodal.tts.voice.cherry': { zh: '百炼 芊悦(女)', en: 'Bailian · Qianyue (female)' },
  'settingsmodal.tts.voice.serena': { zh: '百炼 苏瑶(女)', en: 'Bailian · Suyao (female)' },
  'settingsmodal.tts.voice.ethan': { zh: '百炼 晨煦(男)', en: 'Bailian · Chenxu (male)' },
  'settingsmodal.tts.voice.chelsie': { zh: '百炼 千雪(女)', en: 'Bailian · Qianxue (female)' },
  'settingsmodal.tts.voice.nofish': { zh: '百炼(男·不会翘舌)', en: 'Bailian (male, no retroflex)' },
  'settingsmodal.tts.voice.jennifer': { zh: '百炼(英语女)', en: 'Bailian (English, female)' },
  'settingsmodal.tts.voice.ryan': { zh: '百炼(英语男)', en: 'Bailian (English, male)' },
  'settingsmodal.tts.voice.katerina': { zh: '百炼(俄语女)', en: 'Bailian (Russian, female)' },
  'settingsmodal.tts.voice.dylan': { zh: '百炼 北京话', en: 'Bailian · Beijing dialect' },
  'settingsmodal.tts.voice.jada': { zh: '百炼 上海话', en: 'Bailian · Shanghai dialect' },
  'settingsmodal.tts.voice.sunny': { zh: '百炼 四川话', en: 'Bailian · Sichuan dialect' },
  'settingsmodal.tts.voice.rocky': { zh: '百炼 粤语', en: 'Bailian · Cantonese' },
  'settingsmodal.tts.voice.kiki': { zh: '百炼 粤语(女)', en: 'Bailian · Cantonese (female)' },
  'settingsmodal.tts.voice.marcus': { zh: '百炼 陕西话', en: 'Bailian · Shaanxi dialect' },
  'settingsmodal.tts.voice.roy': { zh: '百炼 闽南语', en: 'Bailian · Hokkien' },
  'settingsmodal.tts.voice.peter': { zh: '百炼 天津话', en: 'Bailian · Tianjin dialect' },
  'settingsmodal.tts.voice.openai': { zh: 'OpenAI', en: 'OpenAI' },
})

type StaticTab = 'general' | 'connection' | 'forsion' | 'model' | 'mcp' | 'hooks' | 'skills' | 'agents' | 'plugins' | 'amadeus-plugins' | 'agent-clis' | 'browser' | 'channels' | 'notes' | 'sync' | 'spaces' | 'theme' | 'shortcuts' | 'notifications' | 'statusbar' | 'advanced' | 'developer' | 'about'
// 动态插件设置页用 `plugin:<id>`(Tangu 引擎插件)/ `fplugin:<id>`(Forsion 插件),都是 Obsidian 式一级入口。
// ⚠️ 两套 id 空间会重名(deutschland-reiseglueck 引擎侧与 Forsion 侧各有一份),前缀必须分开。
export type Tab = StaticTab | `plugin:${string}` | `fplugin:${string}`

const DEV_MODE_KEY = 'forsion_tangu_dev_mode'


// 侧栏项图标(固定 tab 全配;外置 agent 插件的动态 plugin:<id> 项刻意无图标)。
const TAB_ICONS: Partial<Record<Tab, React.ReactNode>> = {
  general: <Settings2 size={14} />,
  spaces: <LayoutGrid size={14} />,
  theme: <Palette size={14} />,
  shortcuts: <Keyboard size={14} />,
  notifications: <Bell size={14} />,
  statusbar: <PanelBottom size={14} />,
  notes: <NotebookPen size={14} />,
  sync: <RefreshCw size={14} />,
  'amadeus-plugins': <Puzzle size={14} />,
  advanced: <Wrench size={14} />,
  developer: <Bug size={14} />,
  about: <Info size={14} />,
  model: <Brain size={14} />,
  agents: <Bot size={14} />,
  skills: <Sparkles size={14} />,
  mcp: <Plug size={14} />,
  hooks: <Webhook size={14} />,
  channels: <MessageCircle size={14} />,
  browser: <Globe2 size={14} />,
  plugins: <Blocks size={14} />,
}

// 系统音色候选(datalist 可输可选;百炼无音色列表 API,静态维护常用项;全量见百炼「Qwen-TTS 音色列表」文档)。
// ⚠️ 表在模块作用域,只能存**文案 key**:写死字面量会在模块加载时冻结,切语言不会更新。
// 第一列是音色 id(发给接口的标识符,永不翻译),第二列是显示名的 key,渲染时 t() 解析。
const TTS_VOICE_SUGGESTIONS: Array<[string, string]> = [
  ['Cherry', 'settingsmodal.tts.voice.cherry'], ['Serena', 'settingsmodal.tts.voice.serena'],
  ['Ethan', 'settingsmodal.tts.voice.ethan'], ['Chelsie', 'settingsmodal.tts.voice.chelsie'],
  ['Nofish', 'settingsmodal.tts.voice.nofish'], ['Jennifer', 'settingsmodal.tts.voice.jennifer'],
  ['Ryan', 'settingsmodal.tts.voice.ryan'], ['Katerina', 'settingsmodal.tts.voice.katerina'],
  ['Dylan', 'settingsmodal.tts.voice.dylan'], ['Jada', 'settingsmodal.tts.voice.jada'],
  ['Sunny', 'settingsmodal.tts.voice.sunny'], ['Rocky', 'settingsmodal.tts.voice.rocky'],
  ['Kiki', 'settingsmodal.tts.voice.kiki'], ['Marcus', 'settingsmodal.tts.voice.marcus'],
  ['Roy', 'settingsmodal.tts.voice.roy'], ['Peter', 'settingsmodal.tts.voice.peter'],
  ['alloy', 'settingsmodal.tts.voice.openai'], ['echo', 'settingsmodal.tts.voice.openai'],
  ['fable', 'settingsmodal.tts.voice.openai'], ['onyx', 'settingsmodal.tts.voice.openai'],
  ['nova', 'settingsmodal.tts.voice.openai'], ['shimmer', 'settingsmodal.tts.voice.openai'],
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
  /** 落地明暗(system 偏好已解析),用于主题卡明暗预览。 */
  themeMode: 'light' | 'dark'
  /** 用户明暗偏好(可 system);明暗切换据此高亮。 */
  themeModePref: 'light' | 'dark' | 'system'
  glassOn: boolean
  flatOn: boolean
  themeSeed: string
  onClose: () => void
  onConfigChange: (patch: Partial<TanguDesktopConfig>) => void
  /** 第三参是明暗**偏好**(可 system);父层 setTheme 会按语言 colorScheme 解析。 */
  onThemeChange: (lang: string, skin: string, pref: 'light' | 'dark' | 'system') => void
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
  /** 打开时直接定位到的 tab(如 /skills→'skills';旧深链 'wechat' 归一到 'channels');缺省落 connection。 */
  initialTab?: Tab
}> = (p) => {
  const { t, locale } = useI18n()
  // 真机、开发者移动预览、手机浏览器统一走两层设置 IA。不能只靠窄屏 media query:
  // 桌面里的手机框宽 390px,但物理 viewport 仍是宽屏,而真机又不经过 Root 的预览框。
  const mobileSettings = !!window.tangu?.mobile || UI_MODE === 'mobile' || (() => {
    try { return window.matchMedia('(pointer: coarse) and (max-width: 820px)').matches } catch { return false }
  })()
  // 合并后:连接/Forsion → 常规设置(general);Agent CLI → 智能体(agents);微信 → 通道。旧入口 tab 归一。
  const normalizeTab = (x: Tab | undefined): Tab =>
    x === 'connection' || x === 'forsion' ? 'general' : x === 'agent-clis' ? 'agents' : (x as string) === 'wechat' ? 'channels' : (x ?? 'general')
  const [rawTab, setTab] = useState<Tab>(normalizeTab(p.initialTab))
  // 中分类(标题下那排横向栏目)。只存 key,**有效值在渲染时推导**(见下方 activeSub):
  // 这样换一级页 / 某个中分类因条件消失时自动落回第一项,不需要 effect 复位,也就没有复位竞态。
  const [sub, setSub] = useState('')
  // 滑入方向:+1 点了右边的栏目,-1 左边,0 换了一级页(纯淡入)。喂给 .settings-sub[data-dir]。
  const [subDir, setSubDir] = useState(0)
  /** 换一级页统一入口:方向清零(换页无左右语义,纯淡入)。裸 setTab 会让上次点分类的方向漏过来。 */
  const goTab = (x: Tab): void => { setSubDir(0); setTab(x) }
  const [navQuery, setNavQuery] = useState('')
  // 普通入口先落一级列表;显式 deep link(initialTab)直达对应二级页。
  const [mobileMenuOpen, setMobileMenuOpen] = useState(() => mobileSettings && !p.initialTab)
  const [appVersion, setAppVersion] = useState<string>('')
  // 背景色轴 + 它的自定义 seed(走 themeStore,不经 props 链;主题色轴仍走 props 的 onThemeChange)。
  const themeBg = useTheme((s) => s.bg)
  const setBg = useTheme((s) => s.setBg)
  const themeBgSeed = useTheme((s) => s.bgSeed)
  const setBgSeedValue = useTheme((s) => s.setBgSeedValue)
  // 应用内自动更新状态(经 window.tangu.onUpdaterStatus 广播驱动;mac 仅检测引导手动下载)。
  const [upd, setUpd] = useState<UpdaterStatusInfo>({ phase: 'idle' })
  // 测试版通道(真源在主进程 config.json 的 updater.beta,这里只是它的镜像;开面板时拉一次)。
  const [betaChannel, setBetaChannel] = useState(false)
  useEffect(() => { void window.tangu?.getUpdateBeta?.().then((v) => setBetaChannel(!!v)) }, [])
  // 开发者模式:关于页连点版本号 10 次解锁(持久化);解锁后多出「开发者选项」tab。
  const [devMode, setDevMode] = useState<boolean>(() => {
    try { return localStorage.getItem(DEV_MODE_KEY) === '1' } catch { return false }
  })
  const [devClicks, setDevClicks] = useState(0)
  // 开发者「回复前显示 system prompt」(localStorage;App.send 读同一 key 决定是否请求后端回传)。
  const [showSysPrompt, setShowSysPrompt] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_SYSTEM_PROMPT_KEY) === '1' } catch { return false }
  })
  // 丝滑光标(默认关;localStorage,smoothCaret.ts 全局模块即时生效)。
  const [smoothCaret, setSmoothCaret] = useState<boolean>(isSmoothCaretOn)
  // 画布双击聚焦(默认开;纯本机视口偏好，不进笔记/桌面后端配置)。
  const [canvasDoubleClickFocus, setCanvasDoubleClickFocus] = useState<boolean>(canvasDoubleClickFocusEnabled)
  const [canvasOverviewZ, setCanvasOverviewZ] = useState<number>(canvasOverviewZoom)
  // 界面字体三档(空 = 跟随主题;uiFont.ts 注入 <style> 即刻生效)。
  const [fonts, setFonts] = useState<Record<FontSlot, string>>(() => ({
    ui: readFont('ui'), body: readFont('body'), mono: readFont('mono'),
  }))
  const setFont = (slot: FontSlot, v: string): void => {
    setFonts((f) => ({ ...f, [slot]: v }))
    writeFont(slot, v)
    applyUiFonts()
  }
  // 开发者「移动端 UI 预览命令」开关(localStorage;bootstrapEngine 启动时据此注册 switch-ui-mode 命令)。
  const [mobileUiCmd, setMobileUiCmd] = useState<boolean>(() => {
    try { return localStorage.getItem(MOBILE_UI_KEY) === '1' } catch { return false }
  })
  // 开发者「活动日志实时视图命令」开关(同款模式;bootstrapEngine 据此注册 open-activity-log 命令)。
  const [activityViewCmd, setActivityViewCmd] = useState<boolean>(() => {
    try { return localStorage.getItem(ACTIVITY_VIEW_KEY) === '1' } catch { return false }
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
  // Unit 设备页(B 端渲染):插件真的在装(unit/plugins),插件页必须给 —— 只藏 shell 类操作;
  // 其余 host tab(MCP/Hooks/托管后端等)仍随 isDesktop 隐藏(shim 没有那些桥,列出来就是白板)。
  const unitPage = !!window.tangu?.unitPage
  const tabItems = [
    // = 连接 + Forsion 合并。⚠️ 云端 Web / 移动端(webShim、mobileShim 都是 cloudWeb:true 且不给
    // backendStatus)下这一页**每个块都是 false**——连接项全是桌面/自建后端专属——列出来点进去是白板,
    // 而它还是默认落点。整页无正文就别列。
    ...(!isDesktop && cloudWeb ? [] : ([['general', t('settings.tab.general')]] as Array<[Tab, string]>)),
    ['model', t('settings.tab.model')],
    ...(isDesktop ? ([['agents', t('settings.tab.agents')]] as Array<[Tab, string]>) : []),
    // 技能云端可用:desktop 或 Tangu Web 都显示(保持 desktop 原有顺序:agents→skills→mcp…)。
    ...((isDesktop || cloudWeb) ? ([['skills', t('settings.tab.skills')]] as Array<[Tab, string]>) : []),
    // 统一插件页(amadeus-plugins):Forsion 插件(含捆绑包)+ Tangu 引擎插件两区一页;旧 'plugins' 入口已并入(effect 重定向)。
    ...(isDesktop ? ([['mcp', 'MCP'], ['hooks', 'Hooks'], ['channels', t('settings.tab.channels')], ['browser', t('settings.tab.browser')]] as Array<[Tab, string]>) : []),
    // 插件页设备页也给(插件在 B 端真的装载运行,列表/启停是本页 runtime 行为,不碰对方设备)。
    ...(isDesktop || unitPage ? ([['amadeus-plugins', t('settings.tab.amadeusPlugins')]] as Array<[Tab, string]>) : []),
    ...(isDesktop && !!window.amadeus ? ([['notes', t('settings.tab.notes')], ['sync', t('settings.tab.sync')]] as Array<[Tab, string]>) : []),
    ...(isDesktop ? ([['spaces', t('settings.tab.spaces')]] as Array<[Tab, string]>) : []),
    ['theme', t('settings.tab.theme')],
    ['shortcuts', t('settings.tab.shortcuts')],
    ['notifications', t('settings.tab.notifications')],
    ['statusbar', t('settings.tab.statusbar')],
    ['advanced', t('settings.tab.advanced')],
    ...((isDesktop || cloudWeb) && devMode ? ([['developer', t('settings.tab.developer')]] as Array<[Tab, string]>) : []),
    ['about', t('settings.tab.about')],
  ] as Array<[Tab, string]>

  // 一级页也做 activeSub 同款推导:请求的页在本端不存在时(深链带来的旧 tab、或上面被摘掉的 general)
  // 落到第一个可用页,免得停在白板上。plugin:<id> 动态页不在 tabItems 里,单独放行。
  const tab: Tab = tabItems.some(([id]) => id === rawTab) || rawTab.startsWith('plugin:')
    || (rawTab.startsWith('fplugin:') && (isDesktop || unitPage) && !!window.amadeus)
    ? rawTab
    : (tabItems[0]?.[0] ?? rawTab)
  const isPluginTab = tab.startsWith('plugin:') || tab.startsWith('fplugin:')
  // 有天然子页面的设置项改成折叠导航。桌面初次打开时展开当前项；移动端首页从总项开始。
  const [expandedTabs, setExpandedTabs] = useState<Set<Tab>>(() => (
    mobileSettings ? new Set() : new Set([tab])
  ))

  // 桌面正文里的直达入口也要把对应总项带开；移动端返回首页时保留用户刚才的折叠状态。
  useEffect(() => {
    if (mobileSettings) return
    setExpandedTabs((previous) => {
      if (previous.has(tab)) return previous
      const next = new Set(previous)
      next.add(tab)
      return next
    })
  }, [mobileSettings, tab])

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
  const [editProvider, setEditProvider] = useState<(DirectProviderConfig & { modelsCsv: string; imageModelsCsv: string; ttsModelsCsv: string; asrModelsCsv: string; noVisionCsv: string }) | null>(null)
  // 语速输入的编辑态缓冲(null=未在编辑,显示已存值):清空/打半截时不反弹,blur 时非法则恢复旧值。
  const [ttsSpeedText, setTtsSpeedText] = useState<string | null>(null)
  const [ttsTesting, setTtsTesting] = useState(false)
  const [ttsTestMsg, setTtsTestMsg] = useState('')
  const [providerTestMsg, setProviderTestMsg] = useState('')
  const [providerTesting, setProviderTesting] = useState(false)
  const providerTestAbort = useRef<AbortController | null>(null) // 供「测试连接」取消用
  const [providerSaveMsg, setProviderSaveMsg] = useState('')
  // 本地联网搜索(BYO-key;engine /agent/websearch)。wsRed=null 表示端点不可用(云端/旧后端)→ 整段隐藏。
  const [wsRed, setWsRed] = useState<LocalWebSearchRedacted | null>(null)
  const [wsProvider, setWsProvider] = useState('auto')
  const [wsZhipuEngine, setWsZhipuEngine] = useState('search_pro_quark')
  const [wsKeys, setWsKeys] = useState({ bocha: '', tavily: '', zhipu: '' }) // 输入草稿:'' 且未点清除 = 不变
  const [wsClear, setWsClear] = useState({ bocha: false, tavily: false, zhipu: false })
  const [wsMsg, setWsMsg] = useState('')
  const [wsBusy, setWsBusy] = useState(false)
  // 镜像连通性测试(设置页管理后端)
  const [mirrorTesting, setMirrorTesting] = useState(false)
  const [mirrorTest, setMirrorTest] = useState<MirrorTestResult | null>(null)
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
  // 「高级」→ 对外 MCP:复制端点/命令的短暂「已复制」反馈(记住是哪一项)+ 当前选中的 agent 接入预设。
  const [mcpCopied, setMcpCopied] = useState<string | null>(null)
  const [mcpPreset, setMcpPreset] = useState('claude')
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteMsg, setRemoteMsg] = useState('')

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

  // 本地联网搜索配置:进模型 tab 拉取;云端/旧后端 404 → wsRed=null 整段隐藏。
  useEffect(() => {
    if (!p.open || tab !== 'model' || !isDesktop) return
    void getLocalWebSearch(p.cfg)
      .then((r) => {
        setWsRed(r)
        setWsProvider(r.provider)
        setWsZhipuEngine(r.zhipuEngine || 'search_pro_quark')
        setWsKeys({ bocha: '', tavily: '', zhipu: '' })
        setWsClear({ bocha: false, tavily: false, zhipu: false })
        setWsMsg('')
      })
      .catch(() => setWsRed(null))
  }, [p.open, tab, isDesktop, p.cfg])
  const pluginNm = (pl: PluginInfo): string => (locale === 'en' && pl.nameEn ? pl.nameEn : pl.name)
  const pluginNavItems = (plugins || [])
    .filter((pl) => pl.enabled && pl.settings)
    .map((pl) => [`plugin:${pl.id}`, pluginNm(pl)] as [Tab, string])

  // Forsion 插件同款待遇:有真设置的各成左栏一级项,免得几十个插件全靠进插件页逐张卡点开找。
  // ⚠️ pluginStore.enable() 给每个启用插件自动塞一行 `workFolder`,那行人人都有,不算「有设置」。
  const amxPlugins = usePluginStore((s) => s.plugins)
  const amxActiveIds = usePluginStore((s) => s.activeIds)
  const amxSettings = usePluginStore((s) => s.settings)
  const amxSettingsViews = usePluginStore((s) => s.settingsViews)
  // ⚠️ 闸必须与「插件」页(amadeus-plugins,isDesktop/unitPage 限定)一致:移动端 window.amadeus 在、那一页却不在,
  // 只按 amadeus 放行会列出一批点「返回」就被推导弹回首页的条目。
  const forsionNavItems: Array<[Tab, string]> = !((isDesktop || unitPage) && window.amadeus) ? []
    : pluginsWithSettingsPanel(amxPlugins, amxActiveIds, amxSettings, amxSettingsViews)
      .map((pl) => [`fplugin:${pl.id}`, pluginDisplayName(pl, locale)] as [Tab, string])

  // 旧「Tangu → 插件」独立入口已并入统一插件页:旧深链/持久化 tab 一律重定向。
  useEffect(() => { if (tab === 'plugins') setTab('amadeus-plugins') }, [tab])

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

  // ── Amadeus 云 vault 同步(桌面专属;window.amadeusSync 缺省时整段隐藏)──
  const [noteSync, setNoteSync] = useState<AmadeusSyncStatus | null>(null)
  const [noteSyncBusy, setNoteSyncBusy] = useState(false)
  useEffect(() => {
    const api = window.amadeusSync
    if (!api) return
    void api.get().then(setNoteSync).catch(() => {})
    return api.onStatus(setNoteSync)
  }, [])

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
      // 后端已带新 provider 重启完(IPC 已 await),按新端口重拉模型目录 —— 否则本页停在
      // 登录前的旧目录,用户「登录了却看不到该 provider 的模型」。
      await loadModels(await window.tangu.getConfig?.())
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
      sandbox: stored.sandbox,
      pythonMode: stored.pythonMode || 'bundled',
      mirror: stored.mirror || 'default',
    }).then(setStored)
  }

  // 浏览器工具设置保存(原与微信共用;微信设置已迁「通道」tab,走引擎 /agent/channels)。
  const saveRemoteSettings = async (): Promise<void> => {
    if (!stored || !window.tangu?.setConfig) return
    setRemoteBusy(true)
    setRemoteMsg('')
    try {
      const next = await window.tangu.setConfig({
        browserEnabled: stored.browserEnabled !== false,
        browserEngine: stored.browserEngine || 'auto',
        browserSearchEngine: stored.browserSearchEngine || 'duckduckgo',
        browserAllowPrivateUrls: !!stored.browserAllowPrivateUrls,
        browserCommandTimeoutMs: Number(stored.browserCommandTimeoutMs || 30000),
      })
      setStored(next)
      setRemoteMsg(t('settings.remote.saved'))
    } catch (e: any) {
      setRemoteMsg(`${t('settings.toast.saveFailed')}${e?.message || e}`)
    } finally {
      setRemoteBusy(false)
    }
  }

  // cfg 缺省取实时 store 值而非 draft:draft 是挂载时快照,后端一重启(换端口)就成死地址。
  const loadModels = async (cfg?: TanguDesktopConfig) => {
    setModelsLoading(true)
    try {
      setModels(await listModels(cfg ?? useApp.getState().cfg))
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
    // appVersion 一打开就取(不只 about tab):高级→导出日志也要带版本号,否则导出里恒为 null。
    if (p.open && !appVersion) void window.tangu?.appVersion?.().then((v) => setAppVersion(v || '')).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, tab])

  // 订阅更新状态(主进程经 App 启动检查或本页「检查更新」触发,事件流回这里驱动按钮态)。
  useEffect(() => {
    const off = window.tangu?.onUpdaterStatus?.((st) => setUpd(st))
    return () => off?.()
  }, [])

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

  const activeTabLabel = isPluginTab
    ? ([...forsionNavItems, ...pluginNavItems].find(([id]) => id === tab)?.[1] || t('settings.tab.plugins'))
    : (tabItems.find(([id]) => id === tab)?.[1] || t('settings.title'))
  const pageDescriptionKey: Partial<Record<StaticTab, string>> = {
    general: 'settings.page.generalDescription',
    spaces: 'settings.page.spacesDescription',
    notes: 'settings.page.notesDescription',
    sync: 'settings.page.syncDescription',
    theme: 'settings.page.themeDescription',
    shortcuts: 'settings.page.shortcutsDescription',
    notifications: 'settings.page.notificationsDescription',
    statusbar: 'settings.page.statusbarDescription',
    model: 'settings.page.modelDescription',
    agents: 'settings.page.agentsDescription',
    skills: 'settings.page.skillsDescription',
    mcp: 'settings.page.mcpDescription',
    hooks: 'settings.page.hooksDescription',
    channels: 'settings.page.channelsDescription',
    browser: 'settings.page.browserDescription',
    'amadeus-plugins': 'settings.page.pluginsDescription',
    advanced: 'settings.page.advancedDescription',
    developer: 'settings.page.developerDescription',
    about: 'settings.page.aboutDescription',
  }
  const activeStaticTab = isPluginTab ? null : tab as StaticTab
  const activeDescriptionKey = activeStaticTab ? pageDescriptionKey[activeStaticTab] : undefined
  const activeTabDescription = isPluginTab
    ? t('settings.page.pluginDescription')
    : activeDescriptionKey ? t(activeDescriptionKey) : ''
  const descriptionForTab = (id: Tab): string => {
    if (id.startsWith('plugin:') || id.startsWith('fplugin:')) return t('settings.page.pluginDescription')
    const key = pageDescriptionKey[id as StaticTab]
    return key ? t(key) : ''
  }

  // 天然子页面:现在渲染在对应总项下面的折叠导航里，不再占用正文标题下的横向栏目条。
  // 显隐条件必须与下方正文块一一对应，否则会出现「点得到子项却空白」。key 全局唯一 →
  // 换页时旧 key 落不进新列表，activeSub 自动落回第一项。
  const subItemsByTab = ({
    general: [
      ['g-conn', t('settings.sub.connection')],
      ...(isDesktop ? [['g-forsion', 'Forsion'] as [string, string]] : []),
      ...(isDesktop && stored ? [['g-inbox', t('settings.inbox.title')] as [string, string]] : []),
    ],
    model: [
      ['m-models', t('settings.sub.models')],
      ...(isDesktop ? ([
        ['m-providers', t('settings.sub.providers')],
        ...(wsRed ? [['m-websearch', t('settings.sub.webSearch')] as [string, string]] : []),
        ...(stored ? [['m-voice', t('settings.sub.voice')] as [string, string]] : []),
      ] as Array<[string, string]>) : []),
    ],
    // 主题**刻意不设中分类**(用户拍板):设计语言/配色/明暗/阴影/玻璃/光标 各自一张小卡就够,
    // 硬分成三栏反而把「换个主题顺手调下明暗」拆成两次点击。别再加回来。
    agents: [
      ['ag-roster', t('settings.tab.agents')],
      ['ag-special', t('settings.sub.specialAgents')],
      ['ag-clis', t('settings.tab.agentClis')],
    ],
    'amadeus-plugins': [
      // Forsion 插件区整块在 window.amadeus 后面 —— 没有就只剩引擎插件一项,栏目条自动隐藏。
      ...(window.amadeus ? [['pl-forsion', t('settings.plugins.secForsion')] as [string, string]] : []),
      // 引擎插件管理桌面专属:设备页的 cfg.backendUrl=对方引擎,rescan/npm 装/启停会真打到对方机器(Codex P1)。
      ...(isDesktop ? [['pl-engine', t('settings.plugins.secEngine')] as [string, string]] : []),
    ],
    advanced: [
      ...(isDesktop ? [['a-mcp', t('settings.sub.mcpServer')] as [string, string]] : []),
      ['a-ui', t('settings.sub.uiSession')],
      ...(window.tangu?.clearAppData ? [['a-data', t('settings.sub.data')] as [string, string]] : []),
    ],
    skills: [
      ['k-library', t('settings.sub.skillLibrary')],
      ...(isDesktop && !!window.tangu?.discoveryScan ? [['k-discovery', t('settings.discovery.label')] as [string, string]] : []),
    ],
    sync: [
      // 「在线同步」整块都在 window.amadeusSync 后面:没这个能力就别挂栏目,否则点进去是白板。
      ...(window.amadeusSync ? [['s-cloud', t('settings.sync.cloudSec')] as [string, string]] : []),
      // RemoteSyncSection 在 window.remoteSync 缺位时直接 return null → 同样是白板,栏目得跟着走。
      ...(window.remoteSync ? [['s-remote', t('settings.sync.remoteSec')] as [string, string]] : []),
    ],
  } as Record<string, Array<[string, string]>>)
  const subItemsForTab = (id: Tab): Array<[string, string]> => subItemsByTab[id] ?? []
  const subItems = subItemsForTab(tab)
  const activeSub = subItems.some(([k]) => k === sub) ? sub : (subItems[0]?.[0] ?? '')
  const activeSubLabel = subItems.find(([k]) => k === activeSub)?.[1] ?? ''
  // 换页/换子页面后:①选中项滚到可见；②正文回到顶部 —— ⚠️ 滚动容器是**外层**
  // .settings-body,内层 `key` 重挂不会重置父容器的
  // scrollTop:在技能库往下滚过再切到另一个长分类,会直接落在新页中段(短分类则落到底)。
  useEffect(() => {
    // 一级列表打开时不再偷偷滚隐藏的旧导航;进入详情(含重新打开同一项)才复位正文。
    if (!mobileSettings || !mobileMenuOpen) {
      document.querySelector('.settings-nav-list button.active')?.scrollIntoView({ block: 'nearest', inline: 'center' })
      const body = document.querySelector('.settings-body')
      if (body) body.scrollTop = 0
    }
  }, [tab, activeSub, mobileMenuOpen, mobileSettings])
  const pickSub = (k: string): void => {
    setSubDir(subItems.findIndex(([x]) => x === k) > subItems.findIndex(([x]) => x === activeSub) ? 1 : -1)
    setSub(k)
  }
  const openSubPage = (id: Tab, key: string): void => {
    if (id === tab) pickSub(key)
    else {
      goTab(id)
      setSub(key)
    }
  }

  // 一级入口一个不少,但按用户目标而不是技术归属分组:先找工作区与外观,再找 AI 能力和扩展。
  // Forsion 品牌独立放在导航顶部,不再用一个额外的大类标题重复占据滚动区。
  const navSections: Array<{ key: string; label: string; groups: Array<{ key: string; label: string; tabs: Tab[] }> }> = [
    { key: 'settings', label: '', groups: [
      { key: 'workspace', label: t('settings.group.workspace'), tabs: ['general', 'spaces', 'notes', 'sync'] },
      { key: 'appearance', label: t('settings.group.appearance'), tabs: ['theme', 'shortcuts', 'notifications', 'statusbar'] },
      { key: 'ai', label: t('settings.group.ai'), tabs: ['model', 'agents', 'skills', 'mcp', 'hooks', 'channels', 'browser'] },
      { key: 'extensions', label: t('settings.group.extensions'), tabs: ['amadeus-plugins'] },
      { key: 'system', label: t('settings.group.system'), tabs: ['advanced', 'developer', 'about'] },
    ] },
  ]
  const navItemsForGroup = (grp: { key: string; tabs: Tab[] }): Array<[Tab, string]> => {
    const base = grp.tabs
      .map((id) => tabItems.find(([tid]) => tid === id))
      .filter((x): x is [Tab, string] => !!x)
    // 「社区插件」组末尾追加已启用且有设置的外置插件,动态项同样进入移动端一级列表。
    return grp.key === 'extensions' ? [...base, ...forsionNavItems, ...pluginNavItems] : base
  }
  const toggleTab = (id: Tab): void => {
    setExpandedTabs((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleDesktopTab = (id: Tab, items: Array<[string, string]>): void => {
    const opening = !expandedTabs.has(id)
    toggleTab(id)
    // 桌面端总项与右侧内容区联动：展开时默认展示它的第一个具体子页面。
    if (opening && items[0]) openSubPage(id, items[0][0])
  }
  const toggleMobileTab = (id: Tab): void => {
    // 移动端仍停留在设置首页；只有点下面的具体子项才进入二级界面。
    toggleTab(id)
  }

  // Android 实体返回 / 系统侧滑:二级页先回设置首页;已在首页时再交给 MobileRoot 退出设置。
  useEffect(() => {
    if (!p.open || !mobileSettings || mobileMenuOpen) return
    const backToMenu = (event: Event): void => {
      event.preventDefault()
      setMobileMenuOpen(true)
    }
    window.addEventListener('forsion:mobile-back', backToMenu)
    return () => window.removeEventListener('forsion:mobile-back', backToMenu)
  }, [mobileMenuOpen, mobileSettings, p.open])

  if (!p.open) return null

  return (
    <div className={`settings-page settings-page--control-center${mobileSettings ? ' settings-page--mobile' : ''}${mobileSettings && mobileMenuOpen ? ' settings-page--mobile-menu' : ''}`}>
      <section className="settings-mobile-home" aria-label={t('settings.title')}>
        <header className="settings-mobile-home-head">
          <button type="button" onClick={p.onClose} aria-label={t('settings.backToApp')} title={t('settings.backToApp')}>
            <ArrowLeft size={20} />
          </button>
          <strong>{t('settings.title')}</strong>
          <span className="settings-mobile-head-logo" aria-hidden="true"><BrandLogo size={24} /></span>
        </header>
        <div className="settings-mobile-home-scroll">
          <div className="settings-mobile-hero">
            <BrandLogo size={38} />
            <span>
              <strong>Forsion Genesis</strong>
              <small>{t('settings.title')}</small>
            </span>
          </div>
          {navSections.flatMap((section) => section.groups).map((grp) => {
            const items = navItemsForGroup(grp)
            if (items.length === 0) return null
            return (
              <section className="settings-mobile-group" key={grp.key}>
                <h2>{grp.label}</h2>
                <div className="settings-mobile-group-card">
                  {items.map(([id, label]) => {
                    const children = subItemsForTab(id)
                    const expandable = children.length > 0
                    const expanded = expandable && expandedTabs.has(id)
                    const childrenId = `settings-mobile-subitems-${id.replace(':', '-')}`
                    const description = descriptionForTab(id)
                    return (
                      <div className="settings-mobile-entry" key={id}>
                        <button
                          type="button"
                          className="settings-mobile-row"
                          aria-expanded={expandable ? expanded : undefined}
                          aria-controls={expandable ? childrenId : undefined}
                          onClick={() => {
                            if (expandable) toggleMobileTab(id)
                            else { goTab(id); setMobileMenuOpen(false) }
                          }}
                        >
                          <span className="settings-mobile-row-icon" aria-hidden="true">{TAB_ICONS[id] ?? <Puzzle size={14} />}</span>
                          <span className="settings-mobile-row-copy">
                            <strong>{label}</strong>
                            {description && <small>{description}</small>}
                          </span>
                          <ChevronRight className={`settings-mobile-row-chevron${expanded ? ' expanded' : ''}`} size={18} aria-hidden="true" />
                        </button>
                        {expanded && (
                          <div className="settings-mobile-subitems" id={childrenId}>
                            {children.map(([key, childLabel]) => (
                              <button
                                type="button"
                                className="settings-mobile-subrow"
                                key={key}
                                onClick={() => { openSubPage(id, key); setMobileMenuOpen(false) }}
                              >
                                <span className="settings-mobile-subrow-mark" aria-hidden="true" />
                                <span>{childLabel}</span>
                                <ChevronRight size={16} aria-hidden="true" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      </section>
      <aside className="settings-nav" aria-label="Settings navigation">
        {/* 左上角返回 + 设置搜索(codex 风):常驻顶部,不随分类列表滚动。 */}
        <div className="settings-nav-top">
          <button className="settings-back" onClick={p.onClose}>
            <ArrowLeft size={15} /> {t('settings.backToApp')}
          </button>
          <div className="settings-nav-brand">
            <BrandLogo size={30} />
            <div>
              <strong>Forsion</strong>
              <span>{t('settings.title')}</span>
            </div>
          </div>
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
          {navSections.map((sec) => {
            // 搜索:命中大类名保留整大类,命中小类名保留整组,否则按项名过滤。
            const ql = navQuery.trim().toLowerCase()
            const secHit = !ql || sec.label.toLowerCase().includes(ql)
            const groups = sec.groups
              .map((grp) => {
                const all = navItemsForGroup(grp)
                const items = secHit || grp.label.toLowerCase().includes(ql)
                  ? all
                  : all.filter(([id, label]) => label.toLowerCase().includes(ql)
                    || subItemsForTab(id).some(([, childLabel]) => childLabel.toLowerCase().includes(ql)))
                return { key: grp.key, label: grp.label, items }
              })
              .filter((g) => g.items.length > 0)
            if (groups.length === 0) return null
            return (
              <div key={sec.key} className="settings-nav-section">
                {sec.label && <div className="settings-nav-sectionhead">{sec.label}</div>}
                {groups.map((grp) => (
                  <div key={grp.key} className="settings-nav-group">
                    <div className="settings-nav-grouphead">{grp.label}</div>
                    {grp.items.map(([id, label]) => {
                      const children = subItemsForTab(id)
                      const expandable = children.length > 0
                      // 搜索临时展开命中总项，但不篡改用户原本的折叠选择。
                      const expanded = expandable && (!!ql || expandedTabs.has(id))
                      const childrenId = `settings-nav-subitems-${id.replace(':', '-')}`
                      return (
                        <div className="settings-nav-parent" key={id}>
                          <button
                            type="button"
                            className={tab === id ? (expandable ? 'has-active' : 'active') : ''}
                            aria-current={tab === id ? 'page' : undefined}
                            aria-expanded={expandable ? expanded : undefined}
                            aria-controls={expandable ? childrenId : undefined}
                            onClick={() => expandable ? toggleDesktopTab(id, children) : goTab(id)}
                          >
                            {TAB_ICONS[id]}<span>{label}</span>
                            {expandable && <ChevronRight className="settings-nav-parent-chevron" size={14} aria-hidden="true" />}
                          </button>
                          {expanded && (
                            <div className="settings-nav-subitems" id={childrenId}>
                              {children.map(([key, childLabel]) => (
                                <button
                                  type="button"
                                  className={`settings-nav-subitem${tab === id && activeSub === key ? ' active' : ''}`}
                                  aria-current={tab === id && activeSub === key ? 'page' : undefined}
                                  key={key}
                                  onClick={() => openSubPage(id, key)}
                                >
                                  <span className="settings-nav-subitem-mark" aria-hidden="true" />
                                  <span>{childLabel}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </aside>
      <section className="settings-main">
        <div className="settings-mobile-detail-head">
          <button type="button" onClick={() => setMobileMenuOpen(true)} aria-label={t('settings.title')} title={t('settings.title')}>
            <ArrowLeft size={20} />
          </button>
          <strong>{activeSubLabel || activeTabLabel}</strong>
          <button type="button" onClick={p.onClose} aria-label={t('settings.backToApp')} title={t('settings.backToApp')}>
            <X size={19} />
          </button>
        </div>
        <div className="settings-main-head">
          <div className="settings-main-copy">
            <div className="settings-main-title">{activeTabLabel}</div>
            {activeTabDescription && <p>{activeTabDescription}</p>}
          </div>
        </div>
        <div className="settings-body">
          {/* key 变 → 重挂 → CSS 入场动画重跑(方向由 data-dir 给);正文块自己按 activeSub 取舍。 */}
          <div key={`${tab}:${activeSub}`} className={`settings-sub settings-sub--${tab}`} data-dir={subDir}>
                {/* 小节标题不在正文重复；当前子页面由左侧/移动首页的折叠子项标明。 */}
                {tab === 'general' && activeSub === 'g-conn' && (
                  <>
                    <section className="settings-overview" aria-label={t('settings.overview.label')}>
                      <div className="settings-overview-copy">
                        <span>{t('settings.overview.label')}</span>
                        <strong>{backendSt?.state === 'ready' ? t('settings.overview.readyTitle') : t('settings.overview.attentionTitle')}</strong>
                        <p>{backendSt?.state === 'ready' ? t('settings.overview.readyDescription') : t('settings.overview.attentionDescription')}</p>
                      </div>
                      <div className="settings-overview-list">
                        <div className="settings-overview-row">
                          <span className="settings-overview-icon"><Settings2 size={15} /></span>
                          <span><small>{t('settings.overview.mode')}</small><strong>{mode === 'managed' ? t('settings.backend.modeManaged') : t('settings.backend.modeExternal')}</strong></span>
                        </div>
                        <div className="settings-overview-row">
                          <span className="settings-overview-icon"><Server size={15} /></span>
                          <span><small>{t('settings.overview.backend')}</small><strong>{backendSt ? t(BACKEND_STATE_LABEL[backendSt.state] || 'settings.backend.state.stopped') : t('common.loading')}</strong></span>
                          <i className={`settings-status-dot${backendSt?.state === 'ready' ? ' ok' : backendSt?.state === 'crashed' ? ' err' : ''}`} />
                        </div>
                        <div className="settings-overview-row">
                          <span className="settings-overview-icon"><LogIn size={15} /></span>
                          <span><small>{t('settings.overview.account')}</small><strong>{authSt?.loggedIn && authSt.tokenValid !== false ? t('settings.overview.signedIn') : t('settings.overview.signedOut')}</strong></span>
                        </div>
                      </div>
                    </section>
                    {isDesktop && (
                      <section className="settings-panel settings-mode-panel">
                        <div className="settings-panel-head">
                          <span className="settings-panel-icon"><Server size={16} /></span>
                          <div><strong>{t('settings.backend.modeLabel')}</strong><p>{t('settings.backend.modeDescription')}</p></div>
                        </div>
                        <div className="settings-choice-grid">
                          <button className={`settings-choice-card${mode === 'managed' ? ' active' : ''}`} onClick={() => setMode('managed')}>
                            <span className="settings-choice-icon"><Settings2 size={17} /></span>
                            <span><strong>{t('settings.backend.modeManaged')}</strong><small>{t('settings.backend.modeManagedDescription')}</small></span>
                            {mode === 'managed' && <Check size={15} className="settings-choice-check" />}
                          </button>
                          <button className={`settings-choice-card${mode === 'external' ? ' active' : ''}`} onClick={() => setMode('external')}>
                            <span className="settings-choice-icon"><Globe2 size={17} /></span>
                            <span><strong>{t('settings.backend.modeExternal')}</strong><small>{t('settings.backend.modeExternalDescription')}</small></span>
                            {mode === 'external' && <Check size={15} className="settings-choice-check" />}
                          </button>
                        </div>
                      </section>
                    )}

                    {isDesktop && stored && (
                      <section className="settings-panel settings-workspace-panel">
                        <div className="settings-panel-head">
                          <span className="settings-panel-icon"><FolderOpen size={16} /></span>
                          <div><strong>{t('settings.workspace.label')}</strong><p>{t('settings.workspace.summary')}</p></div>
                        </div>
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
                      </section>
                    )}

                    {isDesktop && mode === 'managed' && stored && (
                      <section className="settings-panel settings-runtime-panel">
                        <div className="settings-panel-head">
                          <span className="settings-panel-icon"><Wrench size={16} /></span>
                          <div><strong>{t('settings.runtime.title')}</strong><p>{t('settings.runtime.description')}</p></div>
                        </div>
                        <div className="field-row">
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
                          <div className="field">
                            <label>{t('settings.mirror.label')}</label>
                            <div className="switch-row" style={{ minHeight: 30 }}>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={(stored.mirror || 'default') === 'china'}
                                className={`switch${(stored.mirror || 'default') === 'china' ? ' on' : ''}`}
                                onClick={() => setStored({ ...stored, mirror: (stored.mirror || 'default') === 'china' ? 'default' : 'china' })}
                              />
                              <span>{t('settings.mirror.toggle')}</span>
                            </div>
                          </div>
                        </div>
                        {likelyMainlandChina() && (stored.mirror || 'default') !== 'china' && (
                          <div className="settings-runtime-callout">{t('settings.mirror.recommend')}</div>
                        )}
                        <details className="settings-runtime-details">
                          <summary><Info size={13} /> {t('settings.runtime.details')}</summary>
                          <p>{t('settings.python.hint')}</p>
                          <p>{t('settings.mirror.hint')}</p>
                        </details>
                        <div className="settings-runtime-test">
                          <button
                            className="btn ghost sm"
                            disabled={mirrorTesting || !window.tangu?.envTestMirror}
                            onClick={() => {
                              if (!window.tangu?.envTestMirror) return
                              setMirrorTesting(true); setMirrorTest(null)
                              void window.tangu.envTestMirror(stored.mirror || 'default')
                                .then((r) => setMirrorTest(r))
                                .catch(() => setMirrorTest(null))
                                .finally(() => setMirrorTesting(false))
                            }}
                          >
                            {mirrorTesting ? <Loader2 size={12} className="spin" /> : <Plug size={12} />} {t('settings.mirror.test')}
                          </button>
                          {mirrorTest?.targets.map((tg) => (
                            <span key={tg.name} style={{ fontSize: 12.5, color: tg.ok ? 'var(--text-muted)' : 'var(--danger, #e5484d)' }}>
                              {tg.ok ? '✓' : '✗'} {tg.name} · {tg.ok ? `${tg.latencyMs}ms` : (tg.error || t('settings.mirror.unreachable'))}
                            </span>
                          ))}
                        </div>
                        <div className="settings-runtime-actions">
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
                        {/* 环境检测(与首启向导第③步同一个组件):事后回来补装 node/git 的地方。 */}
                        <div className="settings-runtime-probe"><EnvProbeSection onLeave={() => useApp.getState().closeSettings()} /></div>
                        <div className="field settings-runtime-logs">
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
                      </section>
                    )}

                    {(!isDesktop || mode === 'external') && !cloudWeb && (
                      <section className="settings-panel settings-external-panel">
                        <div className="settings-panel-head">
                          <span className="settings-panel-icon"><Plug size={16} /></span>
                          <div><strong>{t('settings.external.title')}</strong><p>{t('settings.external.description')}</p></div>
                        </div>
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
                      </section>
                    )}
                  </>
                )}

                {tab === 'general' && isDesktop && activeSub === 'g-forsion' && (
                  <>
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
                {tab === 'general' && isDesktop && stored && activeSub === 'g-inbox' && (
                  <>
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
                    <SettingsPanel icon={<FolderOpen size={16} />} title={t('settings.notes.storageTitle')} description={t('settings.notes.storageDescription')}>
                      <div className="settings-control-list">
                        <SettingsRow
                          label={t('settings.notes.modeLabel')}
                          description={t('settings.notes.modeHint')}
                          control={(
                            <select value={stored.notesAttachmentMode || 'attachments'} onChange={(e) => void window.tangu!.setConfig({ notesAttachmentMode: e.target.value as StoredDesktopConfig['notesAttachmentMode'] }).then(setStored)}>
                              <option value="attachments">{t('settings.notes.modeAttachments')}</option>
                              <option value="same">{t('settings.notes.modeSame')}</option>
                              <option value="vault">{t('settings.notes.modeVault')}</option>
                            </select>
                          )}
                        />
                        {(stored.notesAttachmentMode || 'attachments') === 'vault' && (
                          <SettingsRow label={t('settings.notes.folderLabel')} description={t('settings.notes.folderHint')}>
                            <div className="settings-inline-row settings-row-wide-control">
                              <input type="text" value={stored.notesAttachmentFolder ?? 'assets'} onChange={(e) => setStored({ ...stored, notesAttachmentFolder: e.target.value })} placeholder="assets" />
                              <button className="btn primary sm" onClick={() => void window.tangu!.setConfig({ notesAttachmentFolder: (stored.notesAttachmentFolder || 'assets').trim().replace(/^\/+|\/+$/g, '') }).then(setStored)}>{t('settings.btn.save')}</button>
                            </div>
                          </SettingsRow>
                        )}
                        <SettingsRow label={t('settings.notes.dailyLabel')} description={t('settings.notes.dailyHint')}>
                          <div className="settings-inline-row settings-row-wide-control">
                            <input type="text" value={stored.notesDailyFolder ?? ''} onChange={(e) => setStored({ ...stored, notesDailyFolder: e.target.value })} placeholder={t('settings.notes.dailyPlaceholder')} />
                            <button className="btn primary sm" onClick={() => void window.tangu!.setConfig({ notesDailyFolder: (stored.notesDailyFolder || '').trim().replace(/^\/+|\/+$/g, '') }).then(setStored)}>{t('settings.btn.save')}</button>
                          </div>
                        </SettingsRow>
                      </div>
                    </SettingsPanel>

                    <SettingsPanel icon={<NotebookPen size={16} />} title={t('settings.notes.behaviorTitle')} description={t('settings.notes.behaviorDescription')}>
                      <div className="settings-control-list">
                        <SettingsRow label={t('settings.notes.previewLabel')} description={t('settings.notes.previewHint')} control={<SettingsSwitch checked={stored.notesImportPreview !== false} onChange={(on) => void window.tangu!.setConfig({ notesImportPreview: on }).then(setStored)} label={t('settings.notes.previewLabel')} />} />
                        <SettingsRow label={t('settings.notes.upgradeV4Label')} description={t('settings.notes.upgradeV4Hint')} control={<SettingsSwitch checked={stored.notesUpgradeV4 !== false} onChange={(on) => { setUpgradeV4Enabled(on); void window.tangu!.setConfig({ notesUpgradeV4: on }).then(setStored) }} label={t('settings.notes.upgradeV4Label')} />} />
                        <SettingsRow label={t('settings.notes.wikiFilesLabel')} description={t('settings.notes.wikiFilesHint')} control={<SettingsSwitch checked={stored.notesWikiIncludeFiles !== false} onChange={(on) => { setWikiFilesEnabled(on); void window.tangu!.setConfig({ notesWikiIncludeFiles: on }).then(setStored) }} label={t('settings.notes.wikiFilesLabel')} />} />
                        <SettingsRow
                          label={t('settings.notes.canvasDoubleClickFocusLabel')}
                          description={t('settings.notes.canvasDoubleClickFocusHint')}
                          control={<SettingsSwitch checked={canvasDoubleClickFocus} onChange={(on) => { setCanvasDoubleClickFocus(on); setCanvasDoubleClickFocusEnabled(on) }} label={t('settings.notes.canvasDoubleClickFocusLabel')} />}
                        />
                        <SettingsRow
                          label={t('settings.notes.canvasOverviewZLabel')}
                          description={t('settings.notes.canvasOverviewZHint')}
                          control={(
                            <select
                              value={String(canvasOverviewZ)}
                              onChange={(e) => { const z = Number(e.target.value); setCanvasOverviewZ(z); setCanvasOverviewZoom(z) }}
                            >
                              {[0.25, 0.4, 0.55, 0.7, 1].map((z) => (
                                <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>
                              ))}
                            </select>
                          )}
                        />
                        <SettingsRow
                          label={t('settings.notes.deleteAssetsLabel')}
                          description={t('settings.notes.deleteAssetsHint')}
                          control={(
                            <select value={deleteAssetsPref() === null ? 'ask' : deleteAssetsPref() ? 'yes' : 'no'} onChange={(e) => { setDeleteAssetsPref(e.target.value === 'ask' ? null : e.target.value === 'yes'); setStored({ ...stored }) }}>
                              <option value="ask">{t('settings.notes.deleteAssetsAsk')}</option>
                              <option value="yes">{t('settings.notes.deleteAssetsYes')}</option>
                              <option value="no">{t('settings.notes.deleteAssetsNo')}</option>
                            </select>
                          )}
                        />
                      </div>
                    </SettingsPanel>

                  </>
                )}

                {tab === 'sync' && activeSub === 's-cloud' && (
                  <>
                    {window.amadeusSync && noteSync && (
                      <div className="field">
                        <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input
                            type="checkbox"
                            checked={noteSync.enabled}
                            disabled={noteSyncBusy}
                            onChange={(e) => {
                              setNoteSyncBusy(true)
                              void window.amadeusSync!.setEnabled(e.target.checked)
                                .then(setNoteSync)
                                .finally(() => setNoteSyncBusy(false))
                            }}
                          />
                          {t('settings.notes.cloudSyncLabel')}
                        </label>
                        <div className="hint">{t('settings.notes.cloudSyncHint')}</div>
                        {noteSync.enabled && (
                          <>
                            <div className="settings-inline-row" style={{ marginTop: 6 }}>
                              <button
                                className="btn sm"
                                disabled={noteSyncBusy || noteSync.state === 'syncing'}
                                onClick={() => {
                                  setNoteSyncBusy(true)
                                  void window.amadeusSync!.syncNow().then(setNoteSync).finally(() => setNoteSyncBusy(false))
                                }}
                              >
                                {noteSync.state === 'syncing' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}{' '}
                                {noteSync.state === 'syncing' ? t('settings.notes.cloudSyncSyncing') : t('settings.notes.cloudSyncNow')}
                              </button>
                              <span className="hint">
                                {t(`settings.notes.cloudSyncState.${noteSync.state}`)}
                                {noteSync.pending > 0 ? ` · ${t('settings.notes.cloudSyncPending', { n: String(noteSync.pending) })}` : ''}
                                {' · '}
                                {t('settings.forsion.lastSynced', {
                                  time: noteSync.lastSyncAt ? new Date(noteSync.lastSyncAt).toLocaleString() : t('settings.forsion.never'),
                                })}
                              </span>
                            </div>
                            {noteSync.error && <div className="hint" style={{ color: 'var(--danger, #c00)' }}>{noteSync.error}</div>}
                            {(noteSync.pendingDeletions ?? 0) > 0 && (
                              <div className="hint" style={{ color: 'var(--danger, #c00)' }}>
                                {t('settings.notes.cloudSyncPendingDel', { n: String(noteSync.pendingDeletions) })}{' '}
                                <button
                                  className="btn sm"
                                  disabled={noteSyncBusy || !window.amadeusSync?.confirmDeletions}
                                  onClick={() => {
                                    setNoteSyncBusy(true)
                                    void window.amadeusSync!.confirmDeletions!()
                                      .then(setNoteSync)
                                      .finally(() => setNoteSyncBusy(false))
                                  }}
                                >
                                  {t('settings.notes.cloudSyncConfirmDel')}
                                </button>
                              </div>
                            )}
                            {noteSync.skipped.length > 0 && (
                              <div className="hint">
                                {t('settings.notes.cloudSyncSkipped', { n: String(noteSync.skipped.length) })}:{' '}
                                {noteSync.skipped.slice(0, 3).map((s) => s.path).join(', ')}
                                {noteSync.skipped.length > 3 ? '…' : ''}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}

                  </>
                )}

                {tab === 'sync' && activeSub === 's-remote' && <RemoteSyncSection />}

                {tab === 'model' && activeSub === 'm-models' && (
                  <>
                    {/* 「默认模型」= 这个分组列表本身(点一下即写 modelId)。原先它上面还有一个手填
                        `<providerId>/<model>` 的输入框,和列表写同一个值 —— 用户当然会问「怎么是手填的」。
                        删掉输入框、把列表的标题从「可用模型」改成「默认模型」,一个入口。 */}
                    <div className="field">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {t('settings.model.defaultLabel')}
                        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => void loadModels()}>
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
                          {t('settings.model.directProviders')}{models.directProviders.map((d) => d.providerId).join(t('settingsmodal.model.providerSep'))}
                        </div>
                      ) : null}
                    </div>

                    {/* 生图模型(generate_image 用):留空=跟随云端生图默认;无可用模型则给配置指引。 */}
                    <div className="field">
                      <label>{t('settings.model.imageModelsLabel')}</label>
                      {(() => {
                        const imgs = (models?.models || []).filter((m) => m.modelType === 'image_gen')
                        if (!imgs.length) return <div className="hint">{modelsLoading ? t('common.loading') : t('settings.model.imageEmpty')}</div>
                        return (
                          <ModelSelect
                            models={imgs}
                            value={draft.imageModelId || ''}
                            cloudDefaultId={models?.imageModelId}
                            icon={<ImageIcon size={13} />}
                            onChange={(v: string) => { setDraft({ ...draft, imageModelId: v }); p.onConfigChange({ imageModelId: v }) }}
                          />
                        )
                      })()}
                      <div className="hint" style={{ marginTop: 4 }}>{t('settings.model.imageHelp')}</div>
                    </div>

                    {isDesktop && <AuxModelChoice models={models} />}

                    {isDesktop && <AsrModelChoice models={models} />}

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
                        {providerBusy && <div className="hint" style={{ marginTop: 6 }}>{t('settings.provider.loginBusy')}</div>}
                        <div className="hint">
                          {t('settings.provider.loginHintPrefix')}<code>provider/model</code>{t('settings.provider.loginHintSuffix')}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {tab === 'model' && isDesktop && activeSub === 'm-providers' && (
                  <>
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
                                  setEditProvider({ ...cp, modelsCsv: (cp.modelIds || []).join(', '), imageModelsCsv: (cp.imageModelIds || []).join(', '), ttsModelsCsv: (cp.ttsModelIds || []).join(', '), asrModelsCsv: (cp.asrModelIds || []).join(', '), noVisionCsv: (cp.noVisionModelIds || []).join(', ') })
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
                            setEditProvider({ providerId: '', baseUrl: '', apiKey: '', modelIds: [], modelsCsv: '', imageModelsCsv: '', ttsModelsCsv: '', asrModelsCsv: '', noVisionCsv: '' })
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
                          <div className="field">
                            <label>{t('settings.customProvider.asrModelsLabel')}</label>
                            <input
                              type="text"
                              value={editProvider.asrModelsCsv}
                              onChange={(e) => setEditProvider({ ...editProvider, asrModelsCsv: e.target.value })}
                              placeholder={t('settings.customProvider.asrModelsPlaceholder')}
                            />
                          </div>
                          {/* 无多模态黑名单:默认认为都能看图,只需登记已知的纯文本模型。 */}
                          <div className="field">
                            <label>{t('settings.customProvider.noVisionLabel')}</label>
                            <input
                              type="text"
                              value={editProvider.noVisionCsv}
                              onChange={(e) => setEditProvider({ ...editProvider, noVisionCsv: e.target.value })}
                              placeholder="deepseek-chat, qwq-32b"
                            />
                            <div className="hint">{t('settings.customProvider.noVisionHint')}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <button
                            className="btn ghost sm"
                            disabled={!editProvider.baseUrl}
                            onClick={() => {
                              // 已在测试中 → 这个按钮变成「取消」:abort 掉挂起的请求(错误 URL/密钥时不再无限转圈)。
                              if (providerTesting) { providerTestAbort.current?.abort(); return }
                              const ac = new AbortController()
                              providerTestAbort.current = ac
                              setProviderTesting(true)
                              setProviderTestMsg('')
                              const firstModel = editProvider.modelsCsv.split(',').map((s) => s.trim()).filter(Boolean)[0]
                              void testProviderConnection(p.cfg, {
                                baseUrl: editProvider.baseUrl,
                                apiKey: editProvider.apiKey || undefined,
                                modelId: firstModel,
                              }, ac.signal)
                                .then((r) => setProviderTestMsg(`${r.success ? '✓' : '✗'} ${r.message}`))
                                .catch((e) => setProviderTestMsg(
                                  e?.name === 'AbortError' ? t('settings.test.canceled')
                                    : e?.name === 'TimeoutError' ? t('settings.test.timeout')
                                    : `✗ ${e?.message || e}`))
                                .finally(() => { setProviderTesting(false); providerTestAbort.current = null })
                            }}
                          >
                            {providerTesting ? <Loader2 size={12} className="spin" /> : <Plug size={12} />} {providerTesting ? t('settings.btn.cancel') : t('settings.btn.testConnection')}
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
                              const asrModelIds = editProvider.asrModelsCsv.split(',').map((s) => s.trim()).filter(Boolean)
                              const noVisionModelIds = editProvider.noVisionCsv.split(',').map((s) => s.trim()).filter(Boolean)
                              void window.tangu!.saveProvider!({
                                providerId: editProvider.providerId,
                                baseUrl: editProvider.baseUrl.replace(/\/+$/, ''),
                                apiKey: editProvider.apiKey || undefined,
                                modelIds: modelIds.length ? modelIds : undefined,
                                imageModelIds: imageModelIds.length ? imageModelIds : undefined,
                                ttsModelIds: ttsModelIds.length ? ttsModelIds : undefined,
                                asrModelIds: asrModelIds.length ? asrModelIds : undefined,
                                noVisionModelIds: noVisionModelIds.length ? noVisionModelIds : undefined,
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
                                        <span className="file-name" style={{ color: selected.has(id) ? 'var(--accent-ink)' : undefined }}>{id}</span>
                                        {selected.has(id) && <Check size={12} style={{ color: 'var(--accent-ink)' }} />}
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

                  </>
                )}

                {/* 本地联网搜索(BYO-key):engine /agent/websearch,写 config.json webSearch 段,搜索时即时生效。 */}
                {tab === 'model' && isDesktop && activeSub === 'm-websearch' && (
                  <>
                    {wsRed && (
                      <>
                        <div className="field">
                          <div className="hint" style={{ marginBottom: 8 }}>{t('settings.websearch.intro')}</div>
                          <div className="field-row">
                            <div className="field">
                              <label>{t('settings.websearch.providerLabel')}</label>
                              <select value={wsProvider} onChange={(e) => setWsProvider(e.target.value)}>
                                <option value="auto">{t('settings.websearch.provider.auto')}</option>
                                <option value="bocha">{t('settings.websearch.provider.bocha')}</option>
                                <option value="tavily">{t('settings.websearch.provider.tavily')}</option>
                                <option value="zhipu">{t('settings.websearch.provider.zhipu')}</option>
                                <option value="duckduckgo">{t('settings.websearch.provider.duckduckgo')}</option>
                              </select>
                            </div>
                            <div className="field">
                              <label>{t('settings.websearch.zhipuEngineLabel')}</label>
                              <select value={wsZhipuEngine} onChange={(e) => setWsZhipuEngine(e.target.value)} title={t('settings.websearch.zhipuEngineHint')}>
                                <option value="search_pro_quark">{t('settings.websearch.zhipuEngine.quark')}</option>
                                <option value="search_pro_sogou">{t('settings.websearch.zhipuEngine.sogou')}</option>
                                <option value="search_pro">{t('settings.websearch.zhipuEngine.pro')}</option>
                                <option value="search_std">{t('settings.websearch.zhipuEngine.std')}</option>
                              </select>
                            </div>
                            <div className="field">
                              <label>{t('settings.websearch.effectiveLabel')}</label>
                              <div className="hint" style={{ paddingTop: 8 }}>
                                {wsRed.configured
                                  ? t('settings.websearch.effectiveLocal', { provider: wsRed.effectiveProvider })
                                  : t('settings.websearch.effectiveCloud')}
                              </div>
                            </div>
                          </div>
                          {([['bocha', 'Bocha API Key', wsRed.bochaHasKey], ['tavily', 'Tavily API Key', wsRed.tavilyHasKey], ['zhipu', 'Zhipu API Key', wsRed.zhipuHasKey]] as const).map(([k, label, hasKey]) => (
                            <div className="field" key={k} style={{ marginTop: 6 }}>
                              <label>
                                {label}
                                {hasKey && !wsClear[k] && (
                                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {t('settings.websearch.keyStored')}</span>
                                )}
                                {wsClear[k] && (
                                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {t('settings.websearch.keyCleared')}</span>
                                )}
                              </label>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                  type="password"
                                  autoComplete="off"
                                  style={{ flex: 1 }}
                                  value={wsKeys[k]}
                                  placeholder={hasKey && !wsClear[k] ? t('settings.websearch.keyKeepPlaceholder') : t('settings.websearch.keyEmptyPlaceholder')}
                                  onChange={(e) => {
                                    setWsKeys({ ...wsKeys, [k]: e.target.value })
                                    if (e.target.value) setWsClear({ ...wsClear, [k]: false })
                                  }}
                                />
                                {hasKey && !wsClear[k] && (
                                  <button className="btn ghost sm" onClick={() => { setWsClear({ ...wsClear, [k]: true }); setWsKeys({ ...wsKeys, [k]: '' }) }}>
                                    {t('settings.websearch.clearKey')}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                            <button
                              className="btn primary sm"
                              disabled={wsBusy}
                              onClick={() => {
                                const keyOut = (k: 'bocha' | 'tavily' | 'zhipu'): string => (wsClear[k] ? '' : (wsKeys[k] || '__keep__'))
                                setWsBusy(true); setWsMsg('')
                                void saveLocalWebSearch(p.cfg, {
                                  provider: wsProvider,
                                  bochaApiKey: keyOut('bocha'),
                                  tavilyApiKey: keyOut('tavily'),
                                  zhipuApiKey: keyOut('zhipu'),
                                  zhipuEngine: wsZhipuEngine,
                                }).then((r) => {
                                  setWsRed(r.config)
                                  setWsKeys({ bocha: '', tavily: '', zhipu: '' })
                                  setWsClear({ bocha: false, tavily: false, zhipu: false })
                                  setWsMsg(t('settings.websearch.saved'))
                                }).catch((e) => setWsMsg(`✗ ${e?.message || e}`))
                                  .finally(() => setWsBusy(false))
                              }}
                            >
                              {t('settings.btn.save')}
                            </button>
                            <button
                              className="btn ghost sm"
                              disabled={wsBusy}
                              onClick={() => {
                                const k = wsProvider as 'bocha' | 'tavily' | 'zhipu'
                                const draft = (wsProvider === 'bocha' || wsProvider === 'tavily' || wsProvider === 'zhipu') ? wsKeys[k] : ''
                                setWsBusy(true); setWsMsg(t('settings.websearch.testing'))
                                void testLocalWebSearch(p.cfg, { provider: wsProvider, apiKey: draft || '__keep__', zhipuEngine: wsZhipuEngine })
                                  .then((r) => setWsMsg(r.ok
                                    ? `✓ ${r.provider} · ${r.latencyMs}ms · ${r.resultCount ?? 0}${r.sampleTitle ? ` · ${String(r.sampleTitle).slice(0, 30)}` : ''}`
                                    : `✗ ${r.provider}: ${r.error || 'failed'}`))
                                  .catch((e) => setWsMsg(`✗ ${e?.message || e}`))
                                  .finally(() => setWsBusy(false))
                              }}
                            >
                              {wsBusy ? <Loader2 size={12} className="spin" /> : null} {t('settings.websearch.test')}
                            </button>
                            {wsMsg && <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{wsMsg}</span>}
                          </div>
                        </div>
                      </>
                    )}

                  </>
                )}

                {/* 语音朗读(TTS):OpenAI 兼容 /audio/speech;模型 id 命中直连 provider 的 ttsModelIds 或 <providerId>/<model>。 */}
                {tab === 'model' && isDesktop && activeSub === 'm-voice' && (
                  <>
                    {stored && (
                      <>
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
                            {TTS_VOICE_SUGGESTIONS.map(([v, labelKey]) => <option key={v} value={v} label={t(labelKey)} />)}
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

                {/* 三段各成中分类:名册 / 后台智能体 / Agent CLI。原 <AgentsSettings> 只是把前两段
                    叠起来加条分割线,分栏后没意义,已就地化掉(它「编辑时隐藏后台区」的专注模式同理:
                    两者不在同一页了)。 */}
                {tab === 'agents' && activeSub === 'ag-roster' && <AgentsTab cfg={p.cfg} />}
                {tab === 'agents' && activeSub === 'ag-special' && <SpecialAgentsTab cfg={p.cfg} />}
                {tab === 'hooks' && <HooksTab cfg={p.cfg} />}
                {/* 统一插件页:Forsion 插件(含捆绑包,带 Amadeus 时)/ Tangu 引擎插件 两个中分类。
                    设备页(unitPage)不传级联三件套:cfg 缺省=cascadeAfterToggle 不级联 —— 否则捆绑包
                    启停会经代理持久改对方引擎插件(Codex P1);引擎插件区同因整块桌面专属。 */}
                {tab === 'amadeus-plugins' && activeSub === 'pl-forsion' && !!window.amadeus && (
                  unitPage
                    ? <AmadeusPluginsTab />
                    : <AmadeusPluginsTab cfg={p.cfg} onEngineReload={reloadPlugins} enginePlugins={plugins} />
                )}
                {tab === 'amadeus-plugins' && activeSub === 'pl-engine' && isDesktop && (
                  <>
                    <PluginsTab
                      cfg={p.cfg}
                      plugins={plugins}
                      onReload={reloadPlugins}
                      onOpenSettings={(id) => goTab(`plugin:${id}` as Tab)}
                    />
                  </>
                )}
                {tab === 'spaces' && <SpacesTab />}
                {tab === 'notifications' && <NotificationsTab />}
                {tab === 'statusbar' && <StatusBarTab />}
                {/* 左栏点进来的 Forsion 插件设置页 = 插件页的详情面,受控于 tab(不再是卡片列表的内部 state)。 */}
                {tab.startsWith('fplugin:') && (
                  <AmadeusPluginsTab
                    {...(unitPage ? {} : { cfg: p.cfg, onEngineReload: reloadPlugins, enginePlugins: plugins })}
                    controlledDetail={{ id: tab.slice('fplugin:'.length), onBack: () => goTab('amadeus-plugins') }}
                  />
                )}
                {tab.startsWith('plugin:') && (() => {
                  const pid = tab.slice('plugin:'.length)
                  const pl = (plugins || []).find((x) => x.id === pid)
                  return pl
                    ? <PluginSettingsPage cfg={p.cfg} plugin={pl} agents={pluginAgents} />
                    : <div className="hint">{t('settings.plugins.empty')}</div>
                })()}
                {tab === 'agents' && activeSub === 'ag-clis' && <AgentClisTab cfg={p.cfg} />}

                {tab === 'browser' && stored && (
                  <>
                    <SettingsPanel
                      className="settings-browser-panel"
                      icon={<Globe2 size={16} />}
                      title={t('settings.browser.agentBrowser')}
                      description={t('settings.browser.hint')}
                      actions={<SettingsSwitch checked={stored.browserEnabled !== false} onChange={(on) => setStored({ ...stored, browserEnabled: on })} label={t('settings.browser.agentBrowser')} />}
                    >
                      <div className={`settings-control-list${stored.browserEnabled === false ? ' is-disabled' : ''}`}>
                        <SettingsRow
                          label={t('settings.browser.engine')}
                          description={t('settings.browser.engineHint')}
                          control={(
                            <select value={stored.browserEngine || 'auto'} onChange={(e) => setStored({ ...stored, browserEngine: e.target.value as StoredDesktopConfig['browserEngine'] })}>
                              <option value="auto">Auto</option>
                              <option value="chrome">Chrome</option>
                              <option value="lightpanda">Lightpanda</option>
                            </select>
                          )}
                        />
                        <SettingsRow
                          label={t('settings.browser.searchEngine')}
                          control={(
                            <select value={stored.browserSearchEngine || 'duckduckgo'} onChange={(e) => setStored({ ...stored, browserSearchEngine: e.target.value as StoredDesktopConfig['browserSearchEngine'] })}>
                              <option value="duckduckgo">DuckDuckGo</option>
                              <option value="bing">Bing</option>
                              <option value="google">Google</option>
                              <option value="baidu">Baidu</option>
                            </select>
                          )}
                        />
                        <SettingsRow label={t('settings.browser.timeout')} description={t('settings.browser.timeoutHint')} control={<input className="settings-number-input" type="text" value={String(stored.browserCommandTimeoutMs || 30000)} onChange={(e) => setStored({ ...stored, browserCommandTimeoutMs: Number(e.target.value.replace(/[^\d]/g, '')) || 30000 })} />} />
                        <SettingsRow label={t('settings.browser.allowPrivate')} description={t('settings.browser.allowPrivateHint')} control={<SettingsSwitch checked={!!stored.browserAllowPrivateUrls} onChange={(on) => setStored({ ...stored, browserAllowPrivateUrls: on })} label={t('settings.browser.allowPrivate')} />} />
                      </div>
                      <div className="settings-panel-footer">
                        <button className="btn primary sm" disabled={remoteBusy} onClick={() => void saveRemoteSettings()}>
                          {remoteBusy ? <Loader2 size={12} className="spin" /> : null}{t('settings.btn.save')}
                        </button>
                        {remoteMsg && <span className="hint">{remoteMsg}</span>}
                      </div>
                    </SettingsPanel>
                  </>
                )}

                {tab === 'channels' && (
                  <>
                    <ChannelsTab cfg={p.cfg} />
                  </>
                )}

                {tab === 'theme' && (
                  <>
                    <ThemePreview tabLabel={activeTabLabel} />
                    <section className="settings-panel settings-theme-language">
                      <div className="settings-panel-head settings-panel-head--actions">
                        <span className="settings-panel-icon"><Palette size={16} /></span>
                        <div><strong>{t('settings.theme.langLabel')}</strong><p>{t('settings.theme.langDescription')}</p></div>
                        <div className="settings-panel-actions">
                          <button type="button" className="btn ghost sm" onClick={() => { void window.tangu?.openThemesDir?.() }} title={t('settings.theme.openFolder')}>
                            <FolderOpen size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            title={t('settings.theme.reload')}
                            disabled={themesReloading}
                            onClick={async () => {
                              setThemesReloading(true)
                              try { await p.onReloadThemes?.() } finally { setThemesReloading(false) }
                            }}
                          >
                            <RefreshCw size={13} className={themesReloading ? 'spin' : ''} />
                          </button>
                        </div>
                      </div>
                      <div className="theme-grid">
                        {listLanguages().map((th) => (
                          <ThemeCard
                            key={th.manifest.id}
                            entry={th}
                            active={th.manifest.id === p.themeLang}
                            onSelect={() => {
                              // 传明暗**偏好**(非落地明暗):换到锁定 colorScheme 的主题时由 setTheme 解析,
                              // 不在此处先按旧 mode 应用一次(会闪),交给 setTheme 一步到位。
                              p.onThemeChange(th.manifest.id, p.themeSkin, p.themeModePref)
                            }}
                          />
                        ))}
                      </div>
                      {/* 选中主题自曝的可调参数(有才渲染);key 带 lang 使换主题时重挂,存值副本跟着重取。 */}
                      {(() => {
                        const cur = listLanguages().find((th) => th.manifest.id === p.themeLang)
                        return cur ? <ThemeSettingsPanel key={p.themeLang} entry={cur} /> : null
                      })()}
                      <div className="hint" style={{ marginTop: 6 }}>{t('settings.theme.dropHint')}</div>
                    </section>
                    <section className="settings-panel settings-theme-palette">
                      <div className="settings-panel-head">
                        <span className="settings-panel-icon"><Sparkles size={16} /></span>
                        <div><strong>{t('settings.theme.skinLabel')}</strong><p>{t('settings.theme.skinDescription')}</p></div>
                      </div>
                      {/* 两根**独立**的轴:主题色只换 accent 家族,背景色只换底/文字/边线族(见 theme/skins.css)。
                          两边选同一个 id = 拆轴前的整套配色。背景轴不走 props 链,直接读写 themeStore(同 bgSeed)。 */}
                      <div className="settings-palette-axis">
                        <strong>{t('settings.theme.accentLabel')}</strong>
                        <div className="skin-row">
                          {listSkins().map((sk) => (
                            <button
                              key={sk.id}
                              type="button"
                              className={`skin-chip${sk.id === p.themeSkin ? ' active' : ''}`}
                              title={t(`settings.theme.skin.${sk.id}`)}
                              onClick={() => p.onThemeChange(p.themeLang, sk.id, p.themeModePref)}
                            >
                              <i className="skin-dot" style={{ background: sk.id === 'custom' ? p.themeSeed : skinSwatch(sk, p.themeMode === 'dark', 'accent') }} />
                              <span>{t(`settings.theme.skin.${sk.id}`)}</span>
                            </button>
                          ))}
                        </div>
                        {p.themeSkin === 'custom' && (
                          <div className="field-row" style={{ alignItems: 'center', gap: 10, marginTop: 11 }}>
                            <input
                              type="color"
                              value={p.themeSeed}
                              onChange={(e) => p.onSeedChange(e.target.value)}
                              aria-label={t('settings.theme.customSeedLabel')}
                              style={{ width: 48, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                            />
                            <span className="hint" style={{ fontFamily: 'var(--font-mono)' }}>{p.themeSeed}</span>
                          </div>
                        )}
                      </div>
                      <div className="settings-palette-axis">
                        <strong>{t('settings.theme.bgLabel')}</strong>
                        <div className="skin-row">
                          {listSkins().map((sk) => (
                            <button
                              key={sk.id}
                              type="button"
                              className={`skin-chip${sk.id === themeBg ? ' active' : ''}`}
                              title={t(`settings.theme.skin.${sk.id}`)}
                              onClick={() => setBg(sk.id)}
                            >
                              <i
                                className="skin-dot skin-dot-background"
                                style={{ background: backgroundSwatch(sk, p.themeMode === 'dark', sk.id === 'custom' ? (themeBgSeed || p.themeSeed) : sk.bgSeed) }}
                              />
                              <span>{t(`settings.theme.skin.${sk.id}`)}</span>
                            </button>
                          ))}
                        </div>
                        {themeBg === 'custom' && (
                          <>
                            <div className="field-row" style={{ alignItems: 'center', gap: 10, marginTop: 11 }}>
                              <input
                                type="color"
                                value={themeBgSeed || '#f8f7f6'}
                                onChange={(e) => setBgSeedValue(e.target.value)}
                                aria-label={t('settings.theme.customBgLabel')}
                                style={{ width: 48, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                              />
                              <span className="hint" style={{ fontFamily: 'var(--font-mono)' }}>
                                {themeBgSeed || t('settings.theme.customBgFollow')}
                              </span>
                              {themeBgSeed && (
                                <button className="btn ghost sm" onClick={() => setBgSeedValue('')}>{t('settings.theme.customBgClear')}</button>
                              )}
                            </div>
                            <div className="hint" style={{ marginTop: 6 }}>{t('settings.theme.customBgHint')}</div>
                          </>
                        )}
                      </div>
                    </section>
                    <section className="settings-panel settings-theme-behavior">
                      <div className="settings-panel-head">
                        <span className="settings-panel-icon"><Layers3 size={16} /></span>
                        <div><strong>{t('settings.theme.behaviorTitle')}</strong><p>{t('settings.theme.behaviorDescription')}</p></div>
                      </div>
                      <div className="settings-control-list">
                        {(() => {
                          // 主题若锁定 colorScheme(如 Glass 固定 system),明暗不可手动改:高亮强制值 + 禁用按钮。
                          // 用校验版(与 store 同一判定):脏 manifest 值(如 "auto")不会让按钮禁用而 store 却没锁。
                          const forced = forcedSchemeForLanguage(p.themeLang)
                          const active = forced ?? p.themeModePref
                          const opts: Array<{ id: 'light' | 'dark' | 'system'; icon: typeof Sun; label: string }> = [
                            { id: 'light', icon: Sun, label: t('settings.theme.light') },
                            { id: 'dark', icon: Moon, label: t('settings.theme.dark') },
                            { id: 'system', icon: MonitorCog, label: t('settings.theme.system') },
                          ]
                          return (
                            <div className="settings-control-row">
                              <div className="settings-control-copy"><MonitorCog size={14} /><span><strong>{t('settings.theme.modeLabel')}</strong>{forced && <small>{t('settings.theme.modeLockedHint')}</small>}</span></div>
                              <div className="seg">
                                {opts.map(({ id, icon: Ic, label }) => (
                                  <button
                                    key={id}
                                    className={active === id ? 'active' : ''}
                                    disabled={!!forced}
                                    title={forced ? t('settings.theme.modeLocked') : undefined}
                                    onClick={() => p.onThemeChange(p.themeLang, p.themeSkin, id)}
                                  >
                                    <Ic size={13} />{label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )
                        })()}
                        <div className="settings-control-row">
                          <div className="settings-control-copy"><Sparkles size={14} /><span><strong>{t('settings.theme.flatLabel')}</strong><small>{t('settings.theme.flatDescription')}</small></span></div>
                          <div className="seg">
                            <button className={!p.flatOn ? 'active' : ''} onClick={() => p.onFlatChange(false)}>{t('settings.theme.flatOff')}</button>
                            <button className={p.flatOn ? 'active' : ''} onClick={() => p.onFlatChange(true)}>{t('settings.theme.flatOn')}</button>
                          </div>
                        </div>
                        <div className="settings-control-row">
                          <div className="settings-control-copy"><Layers3 size={14} /><span><strong>{t('settings.theme.glassLabel')}</strong><small>{t('settings.theme.glassDescription')}</small></span></div>
                          <div className="seg">
                            <button className={p.glassOn ? 'active' : ''} onClick={() => p.onGlassChange(true)}>{t('settings.theme.glassOn')}</button>
                            <button className={!p.glassOn ? 'active' : ''} onClick={() => p.onGlassChange(false)}>{t('settings.theme.glassOff')}</button>
                          </div>
                        </div>
                        <div className="settings-control-row">
                          <div className="settings-control-copy"><MousePointer2 size={14} /><span><strong>{t('settings.theme.smoothCaret')}</strong><small>{t('settings.theme.smoothCaretHint')}</small></span></div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={smoothCaret}
                            className={`switch${smoothCaret ? ' on' : ''}`}
                            onClick={() => {
                              const on = !smoothCaret
                              setSmoothCaret(on)
                              try { localStorage.setItem(SMOOTH_CARET_KEY, on ? '1' : '0') } catch { /* ignore */ }
                              setSmoothCaretEnabled(on)
                            }}
                          />
                        </div>
                      </div>
                    </section>
                    <section className="settings-panel settings-theme-fonts">
                      <div className="settings-panel-head">
                        <span className="settings-panel-icon"><Type size={16} /></span>
                        <div><strong>{t('settings.theme.typographyTitle')}</strong><p>{t('settings.theme.fontHint')}</p></div>
                      </div>
                      <div className="settings-font-list">
                        {/* 字体三档:空 = 跟随主题(uiFont 一条声明都不出)。**只能选预设** ——
                            预设字体随包内置(build/gen-fonts.cjs),不再依赖本机装没装;插件注册的字体
                            与内置项同形,只是分到另一个 optgroup。 */}
                        {([
                          ['ui', 'settings.theme.fontUi'],
                          ['body', 'settings.theme.fontBody'],
                          ['mono', 'settings.theme.fontMono'],
                        ] as const).map(([slot, labelKey]) => {
                          const list = listFonts(slot)
                          const builtin = list.filter((f) => f.source === 'builtin')
                          const fromPlugins = list.filter((f) => f.source !== 'builtin')
                          const nameOf = (f: (typeof list)[number]): string =>
                            f.labelKey ? t(f.labelKey as Parameters<typeof t>[0]) : (f.label ?? f.id)
                          return (
                            <label className="settings-font-row" key={slot} htmlFor={`font-${slot}`}>
                              <span>{t(labelKey)}</span>
                              {/* 预览就用选中项的栈本身,选完立刻能看出长什么样 */}
                              <select
                                id={`font-${slot}`}
                                value={fonts[slot]}
                                onChange={(e) => setFont(slot, e.target.value)}
                                style={{ fontFamily: getFont(fonts[slot])?.stack || undefined }}>
                                <option value="">{t('settings.theme.fontFollow')}</option>
                                <optgroup label={t('settings.theme.fontGroupBuiltin')}>
                                  {builtin.map((f) => <option key={f.id} value={f.id}>{nameOf(f)}</option>)}
                                </optgroup>
                                {fromPlugins.length > 0 && (
                                  <optgroup label={t('settings.theme.fontGroupPlugin')}>
                                    {fromPlugins.map((f) => <option key={f.id} value={f.id}>{nameOf(f)}</option>)}
                                  </optgroup>
                                )}
                              </select>
                            </label>
                          )
                        })}
                      </div>
                    </section>
                  </>
                )}

                {tab === 'shortcuts' && <ShortcutsTab />}

                {tab === 'skills' && activeSub === 'k-library' && (
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
                  </>
                )}

                {tab === 'skills' && activeSub === 'k-discovery' && (
                  <>
                    {isDesktop && !!window.tangu?.discoveryScan && (
                      <div className="field">
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

                {tab === 'advanced' && activeSub === 'a-mcp' && (
                  <>
                    {isDesktop && (
                      <div className="field">
                        <label>{t('settings.mcpServer.label')}</label>
                        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.mcpServer.hint')}</div>
                        <label className="inline-check">
                          <input
                            type="checkbox"
                            checked={!!stored?.mcpEnabled}
                            onChange={(e) => void window.tangu!.setConfig({ mcpEnabled: e.target.checked }).then(setStored)}
                          />
                          {t('settings.mcpServer.enable')}
                        </label>

                        {stored?.mcpEnabled && stored.forsionMcp?.running && stored.forsionMcp.url && (() => {
                          const url = stored.forsionMcp.url
                          const token = stored.forsionMcp.token
                          // 各家 agent 的接入配置(都走 Streamable HTTP + Authorization: Bearer)。任意支持 HTTP MCP 的客户端照「通用」即可。
                          const presets: { id: string; label: string; snippet: string }[] = [
                            { id: 'claude', label: 'Claude Code', snippet: `claude mcp add --transport http forsion ${url} --header "Authorization: Bearer ${token}"` },
                            { id: 'codex', label: 'Codex', snippet: `# ~/.codex/config.toml\n[mcp_servers.forsion]\nurl = "${url}"\nbearer_token = "${token}"` },
                            { id: 'opencode', label: 'OpenCode', snippet: `// opencode.json\n{\n  "mcp": {\n    "forsion": {\n      "type": "remote",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${token}" },\n      "oauth": false\n    }\n  }\n}` },
                            { id: 'generic', label: t('settings.mcpServer.generic'), snippet: `{\n  "mcpServers": {\n    "forsion": {\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${token}" }\n    }\n  }\n}` },
                          ]
                          const active = presets.find((x) => x.id === mcpPreset) ?? presets[0]
                          const copy = (key: string, text: string) => {
                            void navigator.clipboard?.writeText(text)
                            setMcpCopied(key)
                            setTimeout(() => setMcpCopied(null), 1500)
                          }
                          return (
                            <div style={{ marginTop: 12 }}>
                              <div className="hint" style={{ marginBottom: 8 }}>{t('settings.mcpServer.connectHint')}</div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
                                <span style={{ fontSize: 12, opacity: 0.7, flexShrink: 0 }}>{t('settings.mcpServer.endpoint')}</span>
                                <input
                                  readOnly
                                  value={url}
                                  onFocus={(e) => e.currentTarget.select()}
                                  style={{ flex: 1, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 }}
                                />
                                <button className="btn ghost sm" onClick={() => copy('url', url)} title={t('settings.mcpServer.copy')}>
                                  {mcpCopied === 'url' ? <Check size={13} /> : <Copy size={13} />}
                                </button>
                              </div>
                              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                                {presets.map((pr) => (
                                  <button
                                    key={pr.id}
                                    className={mcpPreset === pr.id ? 'btn sm' : 'btn ghost sm'}
                                    onClick={() => setMcpPreset(pr.id)}
                                  >
                                    {pr.label}
                                  </button>
                                ))}
                              </div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                <pre style={{ flex: 1, margin: 0, padding: '8px 10px', background: 'var(--surface-2, rgba(127,127,127,0.1))', borderRadius: 6, fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{active.snippet}</pre>
                                <button className="btn ghost sm" onClick={() => copy(`snip-${active.id}`, active.snippet)} title={t('settings.mcpServer.copy')}>
                                  {mcpCopied === `snip-${active.id}` ? <Check size={13} /> : <Copy size={13} />}
                                </button>
                              </div>
                              <div className="hint" style={{ marginTop: 8 }}>{t('settings.mcpServer.genericNote')}</div>
                            </div>
                          )
                        })()}

                        {stored?.mcpEnabled && !stored.forsionMcp?.running && (
                          <div className="hint" style={{ marginTop: 8, color: 'var(--danger)' }}>{t('settings.mcpServer.notRunning')}</div>
                        )}
                      </div>
                    )}

                  </>
                )}

                {tab === 'advanced' && activeSub === 'a-ui' && (
                  <>
                    <div className="panel-note">
                      {t('settings.advanced.note')}
                    </div>

                    {isDesktop && (
                      <div className="field" style={{ marginTop: 14 }}>
                        <label>{t('settings.advanced.agentDesk')}</label>
                        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.advanced.agentDeskHint')}</div>
                        <label className="inline-check">
                          <input
                            type="checkbox"
                            checked={!!stored?.agentDeskEnabled}
                            onChange={(e) => void window.tangu!.setConfig({ agentDeskEnabled: e.target.checked }).then((c) => {
                              setStored(c)
                              useApp.setState({ desktopConfig: c })
                            })}
                          />
                          {t('settings.advanced.agentDeskEnable')}
                        </label>
                        {/* 「开在 Agent Desk」只有 Desk 开着才成立;关着时新标签页是唯一去处,不必露这个选择。 */}
                        {stored?.agentDeskEnabled && (
                          <div style={{ marginTop: 10 }}>
                            <label>{t('settings.advanced.summaryOpenIn')}</label>
                            <div className="hint" style={{ marginBottom: 6 }}>{t('settings.advanced.summaryOpenInHint')}</div>
                            <select
                              value={stored?.summaryOpenIn || 'tab'}
                              onChange={(e) => void window.tangu!.setConfig({ summaryOpenIn: e.target.value as 'tab' | 'desk' }).then((c) => {
                                setStored(c)
                                useApp.setState({ desktopConfig: c })
                              })}
                            >
                              <option value="tab">{t('settings.advanced.summaryOpenIn.tab')}</option>
                              <option value="desk">{t('settings.advanced.summaryOpenIn.desk')}</option>
                            </select>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="field" style={{ marginTop: 14 }}>
                      <label>{t('settingsmodal.advanced.resetLayout')}</label>
                      <div className="hint" style={{ marginBottom: 8 }}>{t('settingsmodal.advanced.resetLayoutHint')}</div>
                      <button
                        className="btn ghost sm"
                        onClick={() => { useWorkspace.getState().resetLayout(); p.onClose() }}
                      >
                        <RotateCcw size={13} />
                        {t('settingsmodal.advanced.resetLayout')}
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

                  </>
                )}

                {tab === 'advanced' && activeSub === 'a-data' && (
                  <>
                    {window.tangu?.clearAppData && (
                      <div className="field">
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
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={mobileUiCmd}
                          onChange={(e) => {
                            const on = e.target.checked
                            setMobileUiCmd(on)
                            try { localStorage.setItem(MOBILE_UI_KEY, on ? '1' : '0') } catch { /* ignore */ }
                            setMobileUiCommand(on)
                          }}
                        />
                        {t('settings.developer.mobileUiPreview')}
                      </label>
                      <div className="hint">{t('settings.developer.mobileUiPreviewHint')}</div>
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
                      <label>{t('settings.developer.achToastLabel')}</label>
                      <div>
                        <button className="btn ghost sm" onClick={() => debugFireToast()}>
                          <Trophy size={12} /> {t('settings.developer.achToast')}
                        </button>
                      </div>
                      <div className="hint">{t('settings.developer.achToastHint')}</div>
                    </div>
                    <div className="field">
                      <label>{t('settings.developer.activityLabel')}</label>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button
                          className="btn ghost sm"
                          onClick={() => {
                            void (async () => {
                              const text = (await window.tangu?.exportActivity?.(7).catch(() => '')) || ''
                              await window.tangu?.saveTextFile?.(`forsion-activity-${new Date().toISOString().slice(0, 10)}.log`, text || '(empty)')
                            })()
                          }}
                        >
                          <FileDown size={12} /> {t('settings.developer.activityExport')}
                        </button>
                        <label className="inline-check" style={{ margin: 0 }}>
                          <input
                            type="checkbox"
                            checked={stored?.activityLogEnabled !== false}
                            onChange={(e) => void window.tangu!.setConfig({ activityLogEnabled: e.target.checked }).then(setStored)}
                          />
                          {t('settings.developer.activityEnable')}
                        </label>
                      </div>
                      <div className="hint">{t('settings.developer.activityHint')}</div>
                    </div>
                    <div className="field">
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={activityViewCmd}
                          onChange={(e) => {
                            const on = e.target.checked
                            setActivityViewCmd(on)
                            try { localStorage.setItem(ACTIVITY_VIEW_KEY, on ? '1' : '0') } catch { /* ignore */ }
                            setActivityViewCommand(on)
                          }}
                        />
                        {t('settings.developer.activityViewCmd')}
                      </label>
                      <div className="hint">{t('settings.developer.activityViewCmdHint')}</div>
                    </div>
                    <div className="field">
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={!!stored?.activeWindowEnabled}
                          onChange={(e) => {
                            const on = e.target.checked
                            // 真源在主进程配置(默认拒的实现点就在那儿);⌘K 入口同步增删,免 reload。
                            void window.tangu!.setConfig({ activeWindowEnabled: on }).then(setStored)
                            setActiveWindowCommand(on)
                          }}
                        />
                        {t('settings.developer.activeWindow')}
                      </label>
                      <div className="hint">{t('settings.developer.activeWindowHint')}</div>
                    </div>
                    <div className="field">
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          try { localStorage.removeItem(DEV_MODE_KEY) } catch { /* ignore */ }
                          // 关开发者模式顺手清掉「显示 system prompt」,免得关了 tab 还在聊天里冒调试块。
                          try { localStorage.removeItem(SHOW_SYSTEM_PROMPT_KEY) } catch { /* ignore */ }
                          setShowSysPrompt(false)
                          // 一并关掉移动端 UI 预览命令(若正处于移动模式,命令自身保留切回入口)。
                          try { localStorage.removeItem(MOBILE_UI_KEY) } catch { /* ignore */ }
                          setMobileUiCmd(false)
                          setMobileUiCommand(false)
                          // 一并撤掉活动日志实时视图命令。
                          try { localStorage.removeItem(ACTIVITY_VIEW_KEY) } catch { /* ignore */ }
                          setActivityViewCmd(false)
                          setActivityViewCommand(false)
                          // 前台窗口采样必须跟着关:它是主进程配置,唯一能关掉它的 UI 就是这个 tab,
                          // 留着开 = 用户看不见的地方一直在采样,默认拒的信任故事当场破。
                          void window.tangu?.setConfig?.({ activeWindowEnabled: false }).then(setStored)
                          setActiveWindowCommand(false)
                          setDevMode(false)
                          setDevClicks(0)
                          goTab('about')
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
                          <div className="hint" style={{ marginTop: 2, color: 'var(--accent-ink)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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
                        {/* 更新说明来自仓库 CHANGELOG.md 那一节(见 electron/updater.ts),是 markdown ——
                            按 .md-body 正典渲染,别再当纯文本 pre-wrap 摊开。 */}
                        {upd.releaseNotes ? (
                          <div className="md-body" style={{ marginTop: 4, maxHeight: 260, overflow: 'auto' }}>
                            <Markdown content={upd.releaseNotes} />
                          </div>
                        ) : null}
                      </div>
                    )}
                    {upd.phase === 'error' && upd.error ? (
                      <div className="field"><div className="hint" style={{ color: 'var(--danger)' }}>{t('about.update.error', { error: upd.error })}</div></div>
                    ) : null}
                    {window.tangu?.setUpdateBeta ? (
                      <div className="field">
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={betaChannel}
                            onChange={(e) => {
                              const on = e.target.checked
                              setBetaChannel(on) // 先动 UI:落盘是异步的,等它回来勾选框会慢一拍
                              void window.tangu?.setUpdateBeta?.(on).then(() => window.tangu?.checkForUpdates?.())
                            }}
                          />
                          {t('about.update.beta')}
                        </label>
                        <div className="hint" style={{ marginTop: 4 }}>{t('about.update.betaHint')}</div>
                      </div>
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
        </div>
      </section>
    </div>
  )
}
