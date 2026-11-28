import { publicMcpUrl } from '../../../shared/mcpConfig'
import { McpImportDialog, type McpImportDraft } from './McpImportDialog'
import { PRODUCT } from '../product'
import { ModelPickerSettings, type LibKind } from './ModelPickerSettings'
import type { CapabilityMenuItem } from './CapabilityMenu'
import { WebSearchSettings } from './WebSearchSettings'
import { AutoCompactSetting } from './AutoCompactSetting'
import { GitSettingsSection } from './GitSettingsSection'
import { GitAccountsSection } from './GitAccountsSection'
import { HostSandboxSettings } from './HostSandboxSettings'
import { ErrorBoundary } from './ErrorBoundary'
import { BrowserExtensionPanel } from './BrowserExtensionPanel'
/**
 * 设置页:连接 / 模型 / MCP / Browser / WeChat / 主题 / 高级。
 * 在 Desktop 主界面内替换 Chat/Inspector 区域，而不是覆盖式弹窗。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { X, Shapes, ArrowLeft, ChevronRight, Loader2, RefreshCw, MonitorCog, RotateCcw, LogIn, LogOut, KeyRound, Plus, Trash2, Plug, Search, Download, Sparkles, Wrench, Check, Copy, Globe2, FolderOpen, Trophy, FileDown, Settings2, NotebookPen, Puzzle, LayoutGrid, Palette, Keyboard, Bug, Info, Brain, Bot, Webhook, MessageCircle, Blocks, Bell, PanelBottom, Server, Type, Coffee, MonitorCheck, History, MonitorSmartphone, Laptop, Cloud, Wind, MousePointerClick, FolderInput, SlidersHorizontal, StepForward } from 'lucide-react'
import { PhoneEngineLicenses } from './PhoneEngineLicenses'
import { AppearanceSettings } from './AppearanceSettings'
import { RibbonSettings } from './RibbonSettings'
import { UI_MODE, useNativeChromeClaim, useNativeChromeInstalled, useWorkspace } from '@lcl/engine' // 工作区引擎:恢复默认布局 + 移动预览模式;原生顶栏(Android 可选宿主)
import { useApp, defaultModelOf } from '../stores/appStore' // Agent Desk 开关改动即时回流(desktopConfig 平时只在 boot/后端就绪时刷新)
import { testConnection } from '../services/agentRunService'
import { listClientSurfaces } from '../services/clientSurfaces'
import { ConnectorSettingsPage } from './Connectors'
import { connectorsSupported } from '../services/connectorService'
import {
  listModels, listTools, mcpLogin, mcpLogout, setModelContextWindow,
  syncNow as backendSyncNow, getSyncStatus as backendGetSyncStatus,
  listPlugins, listAgents, type PluginInfo, type SyncStatusResult,
  getLocalWebSearch, type LocalWebSearchRedacted,
} from '../services/backendService'
import { ChannelsTab } from './ChannelsTab'
import { DecisionGateField, disableDecisionGate } from './DecisionGateField'
import { buildSessionLogPayload, sessionLogFilename } from '../services/sessionLog'
import type {
  AmadeusSyncStatus, AuthStatusInfo, BackendStatusInfo, DirectProviderConfig, McpServerConfigEntry, MirrorTestResult, ModelsResponse,
  NormalAgentDef, SessionRecord, StoredDesktopConfig, TanguDesktopConfig, ToolsResponse, UpdaterStatusInfo,
} from '../types'
import { SHOW_SYSTEM_PROMPT_KEY } from '../types'
import { HeldSyncNotice } from './CloudSyncDialog'
import { ensureEntrySyncSubscribed, useEntrySync } from '../stores/entrySyncStore'
// 本组件已有同名的 useState setter,故取个别名。persist* = 写盘 + 应用 + 跨窗广播。
import { getVisualsPref, setVisualsPref, VISUALS_VALUES, type VisualsPref } from '../visualsPref'
import { registerMessages, useI18n } from '../i18n'
import { formatDateTime } from '../format/time'
import { LocaleToggle } from './LocaleToggle'
import { BrandLogo } from './BrandLogo'
import { RemoteSyncSection, openPenzorSync, penzorSyncReady } from './RemoteSyncSection'
import { SyncSettings } from './SyncSettings'
import { takePendingSyncFocus, type SyncFocus } from '../sync/v2/openSyncSettings'
import { APP_VERSION } from '../changelog'
import { Markdown } from './Markdown'
import { UpdateActions, UpdateSourceNote } from './UpdateActions'
import { ChangelogEntries, releaseNotesFor } from '../views/ChangelogView'
import { openWhatsNew } from './WhatsNewDialog'
import { DefaultModelsPage } from './DefaultModelsPage'
import { VoiceSettingsPage } from './VoiceSettingsPage'
import { catalogByKind, type CatalogItem, type ModelKind } from './modelKinds'
import { AddConnectionDialog, AddModelsDialog, SourceChips, type ConnectionDraft } from './ModelSources'
import { bareModelId, canDropLlm, changeModelKind, LIST_KINDS, listKindOf, modelsIn, mutateProvider, removeModel, setTextOnly } from './providerModels'
import { realtimeCandidates } from './RealtimeVoiceSettings'
import { AgentSettingsOverview } from './AgentSettingsOverview'
import { GlobalSkillsLibrary } from './GlobalSkillsLibrary'
import { ExternalImportSheet } from './ExternalImport'
import { openAgentProfile } from '../views/agentProfileNav'
import { SpecialAgentsTab } from './SpecialAgentsTab'
import { ShortcutsTab } from './ShortcutsTab'
import { PluginsTab } from './PluginsTab'
import { CorePluginUpdates } from './CorePluginUpdates'
import { AmadeusPluginsTab, PluginSettingsView, pluginListDetailBack } from './AmadeusPluginsTab'
import { cloudViewKey, cloudViewTitle, cloudTabTitle, resolveCloudSettingsKey, cloudSettingsParent, cloudSettingsTabs, cloudAccountSearchKey } from './settingsCloudNavigation'
import { pluginWanted, usePluginStore } from '@amadeus/plugins/pluginStore'
import { isPlacedSettingsView, pluginDisplayName, pluginsWithSettingsPanel } from '../amadeus/plugins/display'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import { EnginePluginSettingsHostPage, ForsionPluginSettingsPage, PluginSettingsDirectory, enginePluginSource, forsionPluginSource, pluginMetaLine } from './PluginSettingsHost'
import {
  forsionPluginHasSettings, isPluginSettingsTab, matchPluginSettingsEntry, pluginSettingsNavEntries, readKnownPluginSettings,
  readRecentPluginSettings, sortPluginSettingsEntries, syncKnownPluginSettings, touchRecentPluginSettings, type PluginSettingsEntry,
} from './pluginSettingsNav'
import { readTanguPrefs } from '../amadeus/plugins/tanguSeam'
import { SpacesTab } from './SpacesTab'
import { PanelNotice } from './PanelNotice'
import { NotificationsTab, StatusBarTab } from './NotificationsTab'
import { isPhoneSettings } from './SettingsPage'
import { HooksTab } from './HooksTab'
import { PluginSettingsPage } from './PluginSettingsPage'
import { AgentClisTab } from './AgentClisTab'
import { likelyMainlandChina } from './OnboardingWizard'
import { EnvProbeSection } from './EnvProbeSection'
import { DesktopPermissions, hasDesktopPermissions } from './DesktopPermissions'
import { phoneGuide } from './onboarding/phoneGuide'
import { ComputerHistorySettings, computerHistoryApi } from './ComputerHistorySettings'
import { TrashSettings } from './TrashSettings'
import { RemoteSessionsSettings, remoteSessionsApi } from './RemoteSessionsSettings' // P1-K4
import { DELEGATED_SETTINGS_TABS, isDelegatedAdmin } from '../services/delegatedAdmin'
import { UnitSettings } from './UnitSwitcher'
import { debugFireToast } from '../achievements/store'
import { setMobileUiCommand, MOBILE_UI_KEY } from '../mobileUiCommand'
import {
  FORSION_PRIVACY_URL,
  FORSION_TERMS_URL,
  MIIT_APP_FILING_URL,
  MOBILE_APP_FILING_NUMBER,
} from '../appCompliance'
import { setActivityViewCommand, ACTIVITY_VIEW_KEY } from '../activityViewCommand'
import { setActiveWindowCommand } from '../activeWindowCommand'
import { requestDevCommandsSync } from '../devCommands'
import { setWikiFilesEnabled } from '@amadeus/lib/wikiFiles'
import { setNotesSpellcheckEnabled, useNotesSpellcheck } from '@amadeus/blocks/markdown/spellcheck'
import { setBracketAutoPairEnabled, setMarkdownAutoPairEnabled, useBracketAutoPair, useMarkdownAutoPair } from '@amadeus/blocks/markdown/autoPairPrefs'
import { setUpgradeV4Enabled } from '@amadeus/lib/upgradeV4'
import { deleteAssetsPref, setDeleteAssetsPref } from '@amadeus/components/askDeleteAssets'
import { canvasDoubleClickFocusEnabled, canvasOverviewZoom, setCanvasDoubleClickFocusEnabled, setCanvasOverviewZoom } from '@amadeus/unified/canvasPrefs'
import { aiSpaceTriggerEnabled, setAiSpaceTriggerEnabled } from '@amadeus/lib/aiSpaceTrigger'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'
import { setChatWaitDetailsEnabled, useChatWaitDetailsEnabled } from '../chatWaitDetails'
import { ipcErrorText } from '../ipcError'
import { newReservedMcpNames } from '../../../shared/mcpNames'
import { modelSubAlias, resolveSettingsTarget, SETTINGS_TABS } from './settingsTarget'
import { SETTINGS_SEARCH_INDEX, matchesSettingsQuery, type SettingsSearchEntry } from './settingsSearchIndex'
import { dropCommittedEdits, hasDirtyEdits, mergeEdits, pickEdits, withoutKeys, type SettingsEdits } from './settingsDraft'
import { onRadioGroupKeyDown, radioTabIndex } from './radioGroupKeys'
import { SettingsSaveBar } from './SettingsSaveBar'
import { SecretStorageNotice } from './SecretStorageNotice' // P1-K5
import { MaskingSettingsSection } from './MaskingSettingsSection'
import './settingsModal.css'
import { LocalProviderImport } from './LocalProviderImport'
import { connectionTarget, homeTarget, HOME_REF } from '../services/engine/targets'
import { countTelemetry } from '../telemetrySend'

// 本文件自带的文案片段(命名空间 `settingsmodal.*`,不与 i18n.generated.ts 的 `settings.*` 相交)。
registerMessages({
  'settingsmodal.configRecovered': { zh: '上次的设置文件损坏，已恢复到 {time} 的版本', en: 'Your settings file was damaged. Restored the version from {time}.' },
  'settingsmodal.mcp.tokens': { zh: '每个请求约 {n} token', en: '~{n} tokens per request' },
  'settingsmodal.mcp.notConnected': { zh: '未连接', en: 'Not connected' },
  'settingsmodal.mcp.needsLogin': { zh: '需要登录', en: 'Sign-in required' },
  'settingsmodal.mcp.loggingIn': { zh: '登录中…', en: 'Signing in…' },
  'settingsmodal.mcp.login': { zh: '登录', en: 'Sign in' },
  'settingsmodal.mcp.loginHint': { zh: '在浏览器里登录这个服务，完成后自动连接', en: 'Sign in to this service in your browser. It connects when you finish.' },
  'settingsmodal.mcp.loginOpened': { zh: '已在浏览器打开「{name}」的登录页，完成后会自动连接', en: 'Opened the sign-in page for "{name}" in your browser. It connects when you finish.' },
  'settingsmodal.mcp.loginFailed': { zh: '登录没有开始：', en: 'Couldn’t start sign-in: ' },
  'settingsmodal.mcp.logout': { zh: '断开', en: 'Sign out' },
  'settingsmodal.mcp.logoutConfirm': { zh: '断开「{name}」？本机保存的登录会删掉，下次要重新登录。', en: 'Sign out of "{name}"? The sign-in saved on this computer will be removed.' },
  'settingsmodal.mcp.loggedOut': { zh: '已断开「{name}」', en: 'Signed out of "{name}"' },
  'settingsmodal.mcp.loggedIn': { zh: '已登录「{name}」，新工具从下一轮对话起可用', en: 'Signed in to "{name}". Its tools are available from your next message.' },
  'settingsmodal.mcp.loginNotDone': { zh: '「{name}」没有登录成功：', en: 'Sign-in to "{name}" didn’t finish: ' },
  'settingsmodal.mcp.total': { zh: 'MCP 工具定义合计每个请求约 {n} token，占当前默认模型窗口的 {pct}%', en: 'MCP tool definitions take ~{n} tokens per request, {pct}% of the default model’s context window' },
  'settingsmodal.mcp.totalNoWindow': { zh: 'MCP 工具定义合计每个请求约 {n} token', en: 'MCP tool definitions take ~{n} tokens per request' },
  'settingsmodal.mcp.heavyNote': { zh: '不常用的可以关掉。按约 4 个字符 = 1 token 估算。', en: 'Turn off the ones you rarely use. Estimated at about 4 characters per token.' },
  'settingsmodal.mcp.estimateNote': { zh: '按约 4 个字符 = 1 token 估算。', en: 'Estimated at about 4 characters per token.' },
  'settingsmodal.mcp.fromPlugin': { zh: '来自插件「{name}」', en: 'From plugin "{name}"' },
  'settingsmodal.mcp.fromPluginHint': { zh: '这个 server 随插件启用和停用；要关掉它，请在插件设置里停用这个插件。', en: 'This server starts and stops with its plugin. To turn it off, disable the plugin in plugin settings.' },
  'settingsmodal.selectionBar': { zh: '划线菜单', en: 'Selection menu' },
  'settingsmodal.selectionBarHint': { zh: '选中文字后浮出的那一条：先排当前视图自己的工具，还是先排「问 Tangu」「翻译」这些每个视图都有的动作。', en: 'The bar that appears over selected text: put the current view\'s own tools first, or the actions every view shares, such as Ask Tangu and Translate.' },
  'settingsmodal.selectionBar.tools': { zh: '视图工具在前', en: 'View tools first' },
  'settingsmodal.selectionBar.actions': { zh: '通用动作在前', en: 'Shared actions first' },
  // 「Forsion 云端」一级页:账号 + 云端地址 + 记忆同步 + 笔记在线同步,整页随内置插件 Forsion Extend 出现 / 消失
  'settings.tab.forsionCloud': { zh: 'Forsion 云端', en: 'Forsion Cloud' },
  'settings.page.forsionCloudDescription': {
    zh: '管理 Forsion 账号、会员、额度、安全与插件投稿，以及笔记与记忆的云端同步。由内置插件 Forsion 扩展提供，可在插件页停用。',
    en: 'Manage your Forsion account, membership, quota, security and plugin submissions, plus cloud sync for notes and memory. Provided by the built-in Forsion Extend plugin, which you can turn off on the Plugins page.',
  },
  // 不叫「同步」:下面就是一级页「同步」(远程同步),左栏会出现两个同名项
  'settingsmodal.forsionCloud.submissions': { zh: '插件投稿', en: 'Submissions' },
  'settings.forsionCloud.sync': { zh: '云端智库', en: 'Cloud vault' },
  // 「Agents 与记忆」的开关搬进蓬洲云「同步」页(云同步开启方案 2026-10-20),这里只留一条指路 + 立即同步
  'settings.forsion.syncManaged': { zh: '开关在蓬洲云 › 同步', en: 'Turn it on or off in Penzor Cloud › Sync' },
  'settings.forsion.syncManagedHint': { zh: '登录后笔记和插件默认开着，Agent 逐个选、默认不同步；都在那一页管。', en: 'Notes and plugins are on by default after you sign in; agents are chosen one by one and aren’t synced by default. All managed on that page.' },
  'settings.forsion.openPenzorSync': { zh: '打开', en: 'Open' },
  'settings.forsionCloud.connection': { zh: '连接', en: 'Connection' },
  'settingsmodal.cloudAccountDescription': { zh: 'Forsion 云端 · 管理个人主页、登录资料和账号安全。', en: 'Forsion Cloud · Your profile, sign-in details and account security.' },
  'settingsmodal.cloudMembershipDescription': { zh: 'Forsion 云端 · 查看会员、额度、积分与用量记录。', en: 'Forsion Cloud · Membership, quota, points and usage.' },
  'settingsmodal.cloudHelpDescription': { zh: 'Forsion 云端 · 提交反馈、查看回复。', en: 'Forsion Cloud · Feedback and replies.' },
  'settingsmodal.cloudPrivacyDescription': { zh: 'Forsion 云端 · 帮助改进 Forsion，管理诊断数据。', en: 'Forsion Cloud · Help improve Forsion and manage diagnostic data.' },
  'settingsmodal.cloudAdvancedConnection': { zh: '高级连接', en: 'Advanced connection' },
  'settings.forsionCloud.noteSyncOn': { zh: '与云端智库同步', en: 'Sync with the cloud vault' },
  'settings.forsionCloud.address': { zh: '地址', en: 'Address' },
  'settings.tools.title': { zh: '开发工具', en: 'Developer tools' },
  'settings.tools.description': { zh: '检测编码任务需要的本机工具，缺少时可一键安装。', en: 'Check the local tools coding tasks need, and install missing ones in one step.' },
  'settings.runtime.backendTitle': { zh: '内置后端', en: 'Built-in backend' },
  'settings.runtime.externalNote': { zh: '当前连接的是外部后端。代码沙箱、Python 与下载源请在对方机器上配置。', en: 'You are connected to an external backend. Configure its sandbox, Python and download source on that machine.' },
  // 失焦自动保存失败(Codex 第一轮 A-2):就地提示并给重试,草稿保留。
  'settingsmodal.commit.failed': { zh: '未保存：{error}', en: 'Not saved: {error}' },
  'settingsmodal.commit.retry': { zh: '重试', en: 'Retry' },
  // 持久配置读回前外部连接表单只读(Codex H1-1):此时表单里可能是托管后端的临时地址 / 令牌。
  'settingsmodal.external.cfgLoading': { zh: '正在读取已保存的连接配置…', en: 'Loading the saved connection settings…' },
  'settingsmodal.external.cfgFailed': { zh: '读不到已保存的连接配置，暂不能修改：{error}', en: 'Couldn\'t load the saved connection settings, so they can\'t be changed yet: {error}' },
  // 已登录时云端地址跟随账号(主进程 loadConfig 以账号的 cloudUrl 覆盖,token 绝不发往别的服务器),这里只读。
  'settingsmodal.cloudUrl.lockedHint': { zh: '该地址跟随已登录的账号，无法在此修改。要连接其他服务器，请先退出登录。', en: 'This address follows the signed-in account and can\'t be changed here. To connect to a different server, sign out first.' },
  'settingsmodal.keepAwake.title': { zh: '有会话运行时阻止休眠', en: 'Stay awake while sessions run' },
  'settingsmodal.keepAwake.description': {
    zh: '会话运行期间阻止电脑因闲置自动休眠，全部结束后恢复；屏幕仍会熄灭。合盖、手动睡眠照常生效；Windows 笔记本用电池时，系统仍可能按电源策略休眠。',
    en: 'Keeps your computer from sleeping when idle while sessions are running, and restores normal sleep when they finish. The display can still turn off. Closing the lid or choosing Sleep still works, and Windows laptops on battery may still sleep per power policy.',
  },
  'settingsmodal.autoResume.title': { zh: '重启后自动接着做未完成的任务', en: 'Resume unfinished tasks after a restart' },
  'settingsmodal.autoResume.description': {
    zh: '应用退出、更新或引擎重启时没做完的任务，下次打开会从停下的地方接着做。断在半截的操作会先核对，不会直接重做。',
    en: 'If the app quits, updates or restarts its engine mid-task, the task picks up where it left off next time. Steps that were cut off are checked first, not simply repeated.',
  },
  'settingsmodal.closeAction.title': { zh: '关闭窗口时', en: 'When closing the window' },
  'settingsmodal.closeAction.description': {
    zh: '点主窗口的关闭按钮后做什么。在后台运行时会话、Muse 和同步不中断，可从托盘图标重新打开。',
    en: 'What the main window\'s close button does. In the background, sessions, Muse and sync keep running; reopen Forsion from the tray icon.',
  },
  'settingsmodal.closeAction.ask': { zh: '每次询问', en: 'Ask every time' },
  'settingsmodal.closeAction.tray': { zh: '在后台运行', en: 'Keep running in background' },
  'settingsmodal.closeAction.quit': { zh: '退出 Forsion', en: 'Quit Forsion' },
  'modelsettings.title': { zh: '模型', en: 'Models' },
  'modelsettings.defaults': { zh: '默认模型', en: 'Default models' },
  'modelsettings.display': { zh: '模型与服务', en: 'Models & services' },
  'modelsettings.servicesHint': { zh: '你能用的全部模型、自带 Key 的连接和联网搜索都在这一页。', en: 'All your models, your own API connections and web search, on one page.' },
  'modelsettings.copyId': { zh: '复制模型名', en: 'Copy model name' },
  'modelsettings.setDefault': { zh: '设为默认对话模型', en: 'Set as default chat model' },
  'modelsettings.vision': { zh: '能看图', en: 'Can see images' },
  'modelsettings.kindAs': { zh: '类型：{kind}', en: 'Type: {kind}' },
  'modelsettings.removeFrom': { zh: '从 {name} 移除', en: 'Remove from {name}' },
  'modelsettings.keepOne': { zh: '至少留一个，或删除这条连接', en: 'Keep at least one, or delete the connection' },
  'modelsettings.saveFailed': { zh: '没保存上：{msg}', en: 'Couldn’t save: {msg}' },
  'modelsettings.providers': { zh: '提供方', en: 'Providers' },
  'modelsettings.defaultsHint': { zh: '每个用途调用哪个模型。不选就跟随 Forsion 云端默认；自选的随时可以恢复跟随。', en: 'Which model each purpose uses. Unset ones follow the Forsion Cloud defaults, and any custom choice can go back to the default.' },
  'modelsettings.displayHint': { zh: '你能用的全部模型，分类和后台一致。关掉的不出现在选择菜单里。', en: 'Every model you can use, sorted the same way as the admin console. Models you turn off stay out of the pickers.' },
  'modelsettings.providersHint': { zh: '模型从哪里来：Forsion 云端、订阅账号，或你自己的 API key。', en: 'Where models come from: Forsion Cloud, subscription accounts or your own API keys.' },
  'modelsettings.searchHint': { zh: '配置联网搜索的服务与凭据。', en: 'Configure web search services and credentials.' },
  'modelsettings.voiceHint': { zh: '音色、语速和本地语音识别。用哪个模型在「默认模型」里选。', en: 'Voices, speed and on-device speech recognition. Choose the models under Default models.' },
  'modelsettings.answerForm': { zh: '回答形式', en: 'Answer format' },
  'modelsettings.noModels': { zh: '暂无可用模型。可在提供方中配置连接，然后刷新模型。', en: 'No models available. Configure a provider connection, then refresh models.' },
  'prov.cloud': { zh: 'Forsion 云端', en: 'Forsion Cloud' },
  'prov.cloudIn': { zh: '已登录 · {count} 个模型由后台统一配置', en: 'Signed in · {count} models set up by your administrator' },
  'prov.cloudOut': { zh: '未登录', en: 'Not signed in' },
  'prov.cloudOutHint': { zh: '登录后可以直接用云端的模型，按额度计费。', en: 'Sign in to use cloud models, charged to your quota.' },
  'prov.manageAccount': { zh: '管理账号', en: 'Manage account' },
  'prov.subs': { zh: '订阅账号', en: 'Subscription accounts' },
  'prov.subIn': { zh: '已登录 · 用订阅额度，不计 Forsion 积分', en: 'Signed in · uses your subscription, not Forsion credits' },
  'prov.signIn': { zh: '登录', en: 'Sign in' },
  'prov.signInAgain': { zh: '重新登录', en: 'Sign in again' },
  'prov.add': { zh: '添加连接', en: 'Add connection' },
  'prov.editing': { zh: '{host} · 编辑中', en: '{host} · editing' },
  'prov.collapse': { zh: '收起', en: 'Close' },
  'prov.name': { zh: '名称', en: 'Name' },
  'prov.nameHint': { zh: '也是模型前缀，如 bailian/qwen3.8-max', en: 'Also the model prefix, e.g. bailian/qwen3.8-max' },
  'prov.baseUrlHint': { zh: 'OpenAI 兼容端点，含 /v1', en: 'OpenAI-compatible endpoint, including /v1' },
  'prov.keyHint': { zh: '只存在本机；本地端点可以留空', en: 'Stored on this device only; can be empty for local endpoints' },
  'prov.models': { zh: '模型', en: 'Models' },
  'prov.fetched': { zh: '{count} 个模型', en: '{count} models' },
  'prov.modelsHint': { zh: '类型按模型名自动识别，可改；选「不使用」的不会保存。', en: 'Types are guessed from model names; change them if needed. Models set to Not used are not saved.' },
  'prov.noRows': { zh: '还没有模型。点「拉取模型」；不拉也行，这条连接任意模型名都能按前缀调用。', en: 'No models yet. Fetch them, or skip it: any model name works on this connection through its prefix.' },
  'prov.many': { zh: '模型较多，新的对话模型先没启用，在下面选要用的。', en: 'Lots of models found. New chat models start as Not used; pick the ones you want below.' },
  'prov.changed': { zh: '已手动改过类型', en: 'Type changed by hand' },
  'prov.kindFor': { zh: '{id} 的类型', en: 'Type of {id}' },
  'prov.addModel': { zh: '添加模型', en: 'Add model' },
  'prov.addModelPlaceholder': { zh: '手动填模型名，如 qwen3-tts-flash', en: 'Model name, e.g. qwen3-tts-flash' },
  'prov.kind.llm': { zh: '对话', en: 'Chat' },
  'prov.kind.image': { zh: '图像生成', en: 'Image generation' },
  'prov.kind.tts': { zh: '朗读', en: 'Read aloud' },
  'prov.kind.asr': { zh: '语音识别', en: 'Speech recognition' },
  'prov.kind.off': { zh: '不使用', en: 'Not used' },
  'prov.textOnly': { zh: '纯文本', en: 'Text only' },
  'prov.textOnlyHint': { zh: '打开 = 这个模型看不了图，遇到图片交给「图像识别」', en: 'On = this model cannot see images; images go to Image recognition' },
  'modelsettings.apiProviders': { zh: 'API 连接', en: 'API connections' },
  'modelsettings.providerHint': { zh: '添加服务地址和 API Key，拉取并保存该连接可用的模型。', en: 'Add a service URL and API key, then fetch and save the models available through that connection.' },
  'modelsettings.loginHint': { zh: '使用提供方账号登录，完成后自动刷新可用模型。', en: 'Sign in with a provider account. Available models refresh after sign-in.' },
  'settingsmodal.model.providerSep': { zh: '、', en: ', ' },
  'settingsmodal.advanced.resetLayout': { zh: '恢复默认布局', en: 'Restore default layout' },
  'settingsmodal.advanced.resetLayoutHint': {
    zh: '把工作区面板还原为默认黄金分割布局（中间 0.618 / 左右各 0.191），并清除已保存的自定义布局。',
    en: 'Restores the workspace panels to the default golden-ratio layout (0.618 in the middle, 0.191 on each side) and clears any saved custom layout.',
  },
  'settingsmodal.advanced.experimental': { zh: '测试性功能', en: 'Experimental features' },
  'settingsmodal.advanced.experimentalNote': {
    zh: '这些功能仍在测试中，可能随版本调整或移除；所有选项默认关闭。',
    en: 'These features are still being tested and may change or be removed. All options are off by default.',
  },
  'settingsmodal.advanced.waitDetails': { zh: 'Agent 响应等待详情', en: 'Agent response wait details' },
  'settingsmodal.advanced.waitDetailsHint': {
    zh: '在 Agent 消息末尾显示发送上下文、等待模型首帧和已等待时间，用于诊断模型响应延迟。',
    en: 'Show context upload, first-frame wait and elapsed time at the end of Agent messages for diagnosing model response latency.',
  },
  // 系统音色候选的显示名。⚠️ 只有**标签**进字典,音色 id(Cherry/Dylan/alloy…)是接口标识符,永不翻译。
  'settingsmodal.tts.voice.cherry': { zh: '百炼 芊悦（女）', en: 'Bailian · Qianyue (female)' },
  'settingsmodal.tts.voice.serena': { zh: '百炼 苏瑶（女）', en: 'Bailian · Suyao (female)' },
  'settingsmodal.tts.voice.ethan': { zh: '百炼 晨煦（男）', en: 'Bailian · Chenxu (male)' },
  'settingsmodal.tts.voice.chelsie': { zh: '百炼 千雪（女）', en: 'Bailian · Qianxue (female)' },
  'settingsmodal.tts.voice.nofish': { zh: '百炼（男·不会翘舌）', en: 'Bailian (male, no retroflex)' },
  'settingsmodal.tts.voice.jennifer': { zh: '百炼（英语女）', en: 'Bailian (English, female)' },
  'settingsmodal.tts.voice.ryan': { zh: '百炼（英语男）', en: 'Bailian (English, male)' },
  'settingsmodal.tts.voice.katerina': { zh: '百炼（俄语女）', en: 'Bailian (Russian, female)' },
  'settingsmodal.tts.voice.dylan': { zh: '百炼 北京话', en: 'Bailian · Beijing dialect' },
  'settingsmodal.tts.voice.jada': { zh: '百炼 上海话', en: 'Bailian · Shanghai dialect' },
  'settingsmodal.tts.voice.sunny': { zh: '百炼 四川话', en: 'Bailian · Sichuan dialect' },
  'settingsmodal.tts.voice.rocky': { zh: '百炼 粤语', en: 'Bailian · Cantonese' },
  'settingsmodal.tts.voice.kiki': { zh: '百炼 粤语（女）', en: 'Bailian · Cantonese (female)' },
  'settingsmodal.tts.voice.marcus': { zh: '百炼 陕西话', en: 'Bailian · Shaanxi dialect' },
  'settingsmodal.tts.voice.roy': { zh: '百炼 闽南语', en: 'Bailian · Hokkien' },
  'settingsmodal.tts.voice.peter': { zh: '百炼 天津话', en: 'Bailian · Tianjin dialect' },
  'settingsmodal.tts.voice.openai': { zh: 'OpenAI', en: 'OpenAI' },
  // UIUX 评审 09-25(U-01/02/14/15/30/44)
  'settingsmodal.sub.basic': { zh: '基本', en: 'Basics' },
  'settingsmodal.tab.mcp': { zh: 'MCP 服务器', en: 'MCP servers' },
  // Hooks 与 MCP 一样是开发者术语(对标 Claude Code Hooks),刻意不译;只是走字典,不再是 JSX 字面量。
  'settingsmodal.tab.hooks': { zh: 'Hooks', en: 'Hooks' },
  // 电脑历史:放「系统」组、紧挨设备权限(它要的辅助功能授权就在那一页);页内文案见 computerHistoryMessages.ts。
  'settingsmodal.tab.computerHistory': { zh: '电脑历史', en: 'Computer history' },
  'settingsmodal.page.computerHistory': {
    zh: '在本机记录你在各个 App 里的活动，Agent 需要时可以查阅，帮你接上刚才的工作。',
    en: 'Keep a local record of your activity across apps so agents can look it up and help you pick up where you left off.',
  },
  'settingsmodal.navLabel': { zh: '设置导航', en: 'Settings navigation' },
  'settingsmodal.search.label': { zh: '搜索设置', en: 'Search settings' },
  'settingsmodal.search.results': { zh: '设置项', en: 'Settings' },
  // 「扩展 › 插件设置」折叠组与它的列表页(方案 P4,2026-11-18)
  'settings.tab.pluginSettings': { zh: '插件设置', en: 'Plugin settings' },
  'plugsettings.page.description': { zh: '装了的插件里有设置的都在这里，开着的、关着的都算。', en: 'Every installed plugin that has settings, whether it is on or off.' },
  'plugsettings.more': { zh: '另外 {n} 个…', en: '{n} more…' },
  'settingsmodal.search.empty': { zh: '没有匹配的设置', en: 'No matching settings' },
  'settingsmodal.backend.change': { zh: '更改', en: 'Change' },
  'settingsmodal.backend.current': { zh: '当前：{mode}', en: 'Current: {mode}' },
  'settingsmodal.backend.pending': {
    zh: '尚未切换：确认下方「{action}」后才会生效。',
    en: 'Not switched yet. The change takes effect after you confirm “{action}” below.',
  },
  'settingsmodal.backend.modeApplyManaged': { zh: '切换到托管并启动', en: 'Switch to managed and start' },
  'settingsmodal.backend.modeApplyExternal': { zh: '切换到外部连接并重连', en: 'Switch to external and reconnect' },
  'settingsmodal.backend.runtimeDirty': { zh: '有未保存的更改，保存后会重启后端', en: 'Unsaved changes. Saving restarts the backend.' },
  'settingsmodal.status.backend': { zh: '后端：{state}', en: 'Backend: {state}' },
  'settingsmodal.status.account': { zh: '账号：{state}', en: 'Account: {state}' },
  // 外部连接模式:状态条按「本应用 ↔ 外部后端」的连接判定,不再读内置进程(那边此时本就停着)。
  'settingsmodal.status.external': { zh: '外部连接：{state}', en: 'External connection: {state}' },
  'settingsmodal.status.connOk': { zh: '已连通', en: 'Connected' },
  'settingsmodal.status.connPending': { zh: '连接中', en: 'Connecting' },
  'settingsmodal.status.connErr': { zh: '连接失败', en: 'Connection failed' },
})

/** 更新服务回来的稳定错误代码 → 文案键;其余是原文,照样显示。 */
const UPDATE_ERROR_KEYS: Record<string, string> = {
  unreachable: 'about.update.unreachable', 'disk-full': 'about.update.diskFull', 'no-permission': 'about.update.noPermission', 'file-busy': 'about.update.fileBusy',
}

/** 桌面配置里「重启后自动接着做」那一键(主进程 TanguStoredConfig.autoResumeInterrupted,缺省开)。共享契约 StoredDesktopConfig
 *  在 tangu-agent/contracts 里、这一轮不动它,先在这里补上类型。 */
type StoredWithAutoResume = StoredDesktopConfig & { autoResumeInterrupted?: boolean }
type StaticTab = typeof SETTINGS_TABS[number]
// 动态插件设置页用 `plugin:<id>`(Tangu 引擎插件)/ `fplugin:<id>`(Forsion 插件),都是 Obsidian 式一级入口。
// ⚠️ 两套 id 空间会重名(deutschland-reiseglueck 引擎侧与 Forsion 侧各有一份),前缀必须分开。
export type Tab = StaticTab | 'plugin-settings' | `plugin:${string}` | `fplugin:${string}`
/**
 * openSettings 的深链目标:一级页、旧别名(见 settingsTarget.ts)或 `${tab}/${sub}` 二级落点
 * (如 'model/m-providers')。解析只在 resolveSettingsTarget 一处。
 */
export type SettingsTarget = Tab | 'wechat' | `${StaticTab}/${string}`

const DEV_MODE_KEY = 'forsion_tangu_dev_mode'
/** 摘要栏卡片立体感(开发者选项)。读的一方是 Tangu 的 views/chat2/summaryPrefs,宿主不 import 它(Tangu 边界):
 *  写同一个 key,再在本窗口派一次 storage 事件 —— 设置开在独立窗口时浏览器自己给主窗派,和主窗同窗时靠这一次。 */
const SUMMARY_ELEVATION_KEY = 'forsion.summaryElevation'
/** 「Forsion 云端 → 账号」:Extend 渲染半身自绘的子页(registerSettingsView category 'forsion',id 'account')。 */
const ACCOUNT_SUB = 'fx:forsion-extend:account'
/** 引擎插件「电脑操作」的 id:它的设置页是固定的一级页 'computer-use'。 */
const COMPUTER_USE_PLUGIN = 'computer-use'


// 侧栏项图标(固定 tab 全配;外置 agent 插件的动态 plugin:<id> 项刻意无图标)。
const TAB_ICONS: Partial<Record<Tab, React.ReactNode>> = {
  forsion: <Cloud size={14} />,
  general: <Settings2 size={14} />,
  spaces: <LayoutGrid size={14} />,
  theme: <Palette size={14} />,
  shortcuts: <Keyboard size={14} />,
  notifications: <Bell size={14} />,
  statusbar: <PanelBottom size={14} />,
  notes: <NotebookPen size={14} />,
  sync: <RefreshCw size={14} />,
  'amadeus-plugins': <Puzzle size={14} />,
  'plugin-settings': <SlidersHorizontal size={14} />,
  advanced: <Wrench size={14} />,
  trash: <Trash2 size={14} />,
  permissions: <MonitorCog size={14} />,
  units: <Laptop size={14} />,
  'remote-sessions': <MonitorSmartphone size={14} />, // P1-K4
  'computer-history': <History size={14} />,
  developer: <Bug size={14} />,
  about: <Info size={14} />,
  model: <Brain size={14} />,
  agents: <Bot size={14} />,
  skills: <Sparkles size={14} />,
  connectors: <Plug size={14} />,
  mcp: <Server size={14} />,
  hooks: <Webhook size={14} />,
  channels: <MessageCircle size={14} />,
  browser: <Globe2 size={14} />,
  'computer-use': <MousePointerClick size={14} />,
  plugins: <Blocks size={14} />,
}

const BACKEND_STATE_LABEL: Record<string, string> = {
  stopped: 'settings.backend.state.stopped',
  starting: 'settings.backend.state.starting',
  ready: 'settings.backend.state.ready',
  crashed: 'settings.backend.state.crashed',
}


/** 先放着的文件引擎也以 reason 'HELD' 列进 skipped(给旧界面看);这里另画 HeldSyncNotice,跳过那行滤掉。 */
const noteSkipped = (st: AmadeusSyncStatus): AmadeusSyncStatus['skipped'] => st.skipped.filter((x) => x.reason !== 'HELD')

/** 设置页同步那段:云端镜像 + 每个开了条目同步的库,有先放着的文件就各挂一块「N 篇和云端不一样,等你定」。 */
function HeldSyncAll({ mirror }: { mirror: AmadeusSyncStatus }) {
  useEffect(() => { ensureEntrySyncSubscribed() }, [])
  const entry = useEntrySync((s) => s.status)
  const groups = [
    ...(!mirror.binding && mirror.held?.length ? [{ binding: null as string | null, shareKey: mirror.shareKey ?? null, held: mirror.held }] : []),
    ...Object.entries(entry).filter(([, st]) => st.enabled && st.held?.length).map(([binding, st]) => ({ binding: binding as string | null, shareKey: null, held: st.held! })),
  ]
  if (!groups.length) return null
  return (
    <div className="settings-row-notes">
      {groups.map((g) => <HeldSyncNotice key={g.binding ?? g.shareKey ?? ''} binding={g.binding} shareKey={g.shareKey} held={g.held} />)}
    </div>
  )
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
  /** 打开时直接定位到的页(如 /skills→'skills'、'model/m-providers' 直达二级页;旧别名见 settingsTarget.ts);缺省落 general。 */
  initialTab?: SettingsTarget
  /** Open a physical global skill copy when navigating here from an Agent profile. */
  initialSkillKey?: string
  /** 设置 › 同步的落点(智库同步第 2 步:右键「同步这个文件夹…」、首登卡片),浮窗经 params.syncFocus 带来。 */
  initialSyncFocus?: SyncFocus
}> = (p) => {
  const { t, locale } = useI18n()
  const showWaitDetails = useChatWaitDetailsEnabled()
  // 真机、开发者移动预览、手机浏览器统一走两层设置 IA。不能只靠窄屏 media query:
  // 桌面里的手机框宽 390px,但物理 viewport 仍是宽屏,而真机又不经过 Root 的预览框。
  const mobileSettings = isPhoneSettings()
  // 深链解析(一级页 + 子页)只在 resolveSettingsTarget 一处:连接/Forsion → 常规(general)的对应子页;
  // Agent CLI → agents/ag-clis;微信 → 通道;`${tab}/${sub}` 直达二级页。旧 normalizeTab 丢 sub = 登录入口全落错页(U-02)。
  const [initialTarget] = useState(() => resolveSettingsTarget(p.initialTab))
  // 窗内设置(没有浮窗的宿主)走 openSyncSettings 的一次性交接;浮窗由 FloatingRoot 经 props 传
  const [syncFocus] = useState<SyncFocus | undefined>(() => p.initialSyncFocus ?? (initialTarget.tab === 'sync' ? takePendingSyncFocus() ?? undefined : undefined))
  const [requestedTab, setTab] = useState<Tab>(initialTarget.tab as Tab)
  // 「电脑操作」引擎插件有固定的一级页(AI 组,挨着浏览器):旧的 plugin:computer-use 深链 / 插件列表里的「打开设置」都落到它。
  const rawTab: Tab = requestedTab === `plugin:${COMPUTER_USE_PLUGIN}` ? 'computer-use' : requestedTab
  // 中分类(标题下那排横向栏目)。只存 key,**有效值在渲染时推导**(见下方 activeSub):
  // 这样换一级页 / 某个中分类因条件消失时自动落回第一项,不需要 effect 复位,也就没有复位竞态。
  const [sub, setSub] = useState(initialTarget.sub ?? '')
  // 商店「已连接 · 管理」深链到 connectors/conn:<server 名>:只在首次挂载时用一次,之后在导航里点「连接器」落列表
  const [initialConnector, setInitialConnector] = useState(() => (initialTarget.tab === 'connectors' && initialTarget.sub?.startsWith('conn:') ? initialTarget.sub.slice(5) : undefined))
  useEffect(() => { if (rawTab !== 'connectors') setInitialConnector(undefined) }, [rawTab])
  /** 模型库当前的类型标签(默认模型页的「在模型库里管理」带着类型跳过来)。旧深链 model/m-websearch 落到「联网搜索」标签。 */
  const [libKind, setLibKind] = useState<LibKind>(() => (initialTarget.tab === 'model' && initialTarget.sub === 'm-websearch' ? 'websearch' : 'llm'))
  // 滑入方向:+1 点了右边的栏目,-1 左边,0 换了一级页(纯淡入)。喂给 .settings-sub[data-dir]。
  const [subDir, setSubDir] = useState(0)
  const [cloudAdvancedOpen, setCloudAdvancedOpen] = useState(false)
  /** 换一级页统一入口:方向清零(换页无左右语义,纯淡入)。裸 setTab 会让上次点分类的方向漏过来。 */
  const goTab = (x: Tab): void => { setSubDir(0); setTab(x) }
  const [navQuery, setNavQuery] = useState('')
  // 普通入口先落一级列表;显式 deep link(initialTab)直达对应二级页。
  const [mobileMenuOpen, setMobileMenuOpen] = useState(() => mobileSettings && !p.initialTab)
  const [appVersion, setAppVersion] = useState<string>('')
  // 应用内自动更新状态(经 window.tangu.onUpdaterStatus 广播驱动;mac 仅检测引导手动下载)。
  const [upd, setUpd] = useState<UpdaterStatusInfo>({ phase: 'idle' })
  // 测试版通道(真源在主进程 config.json 的 updater.beta,这里只是它的镜像;开面板时拉一次)。
  const [betaChannel, setBetaChannel] = useState(false)
  useEffect(() => { void window.tangu?.getUpdateBeta?.().then((v) => setBetaChannel(!!v)) }, [])
  // 下载来源(updater.source 的镜像)+ 这台电脑探出来的地区(只用来在说明里告诉用户「自动」会走哪边)。
  const [updateSource, setUpdateSource] = useState<'auto' | 'website' | 'github'>('auto')
  const [updateRegion, setUpdateRegion] = useState<boolean | null>(null)
  useEffect(() => {
    void window.tangu?.getUpdateSource?.().then((v) => setUpdateSource(v || 'auto'))
    void window.tangu?.getUpdateRegion?.().then((v) => setUpdateRegion(v ?? null)).catch(() => {})
  }, [])
  // 开发者模式:关于页连点版本号 10 次解锁(持久化);解锁后多出「开发者选项」tab。
  const [devMode, setDevMode] = useState<boolean>(() => {
    try { return localStorage.getItem(DEV_MODE_KEY) === '1' } catch { return false }
  })
  const [devClicks, setDevClicks] = useState(0)
  // 开发者「回复前显示 system prompt」(localStorage;App.send 读同一 key 决定是否请求后端回传)。
  const [showSysPrompt, setShowSysPrompt] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_SYSTEM_PROMPT_KEY) === '1' } catch { return false }
  })
  // 聊天头像 / 输入建议是 Tangu 的偏好(核心插件化 2e-2):读写走 Tangu 交出的接缝,没装 Tangu 就不摆这两个开关。
  const tanguPrefs = readTanguPrefs()
  // 输入建议(缺省开;localStorage,promptSuggest.ts 每次现读)。
  const [promptSuggest, setPromptSuggest] = useState<boolean>(() => tanguPrefs?.promptSuggest.get() ?? false)
  // 对话里的可视化卡多少(auto / less / off;localStorage,随下一次 run 的 ui_settings 快照进引擎)。
  const [visualsPref, setVisualsPrefState] = useState<VisualsPref>(getVisualsPref)
  // 「外围淡出」靠悬停恢复(calm.css 整段关在 hover: hover 里):没有悬停的设备上那一行与它的搜索结果都不出。
  const hoverCapable = !!window.matchMedia?.('(hover: hover)').matches
  // 画布双击聚焦(默认开;纯本机视口偏好，不进笔记/桌面后端配置)。
  const [canvasDoubleClickFocus, setCanvasDoubleClickFocus] = useState<boolean>(canvasDoubleClickFocusEnabled)
  const [aiSpaceTrigger, setAiSpaceTrigger] = useState<boolean>(aiSpaceTriggerEnabled) // 正文 AI 空行空格唤起(G3-07,缺省关,本机)
  const notesSpellcheck = useNotesSpellcheck() // 笔记拼写检查(本机偏好,G4-07)
  const bracketAutoPair = useBracketAutoPair() // 正文 + 代码块括号 / 引号自动成对(本机偏好,R-27 的 key)
  const markdownAutoPair = useMarkdownAutoPair() // 选中文字后敲 * _ ~ = $ % 包裹(本机偏好)
  const [canvasOverviewZ, setCanvasOverviewZ] = useState<number>(canvasOverviewZoom)
  // 开发者「摘要栏卡片立体感」(见 SUMMARY_ELEVATION_KEY)。
  const [summaryElevation, setSummaryElevationState] = useState<string>(() => {
    try { const v = localStorage.getItem(SUMMARY_ELEVATION_KEY); return v === 'float' || v === 'flat' ? v : 'half' } catch { return 'half' }
  })
  const setSummaryElevation = (v: string) => {
    setSummaryElevationState(v)
    try { localStorage.setItem(SUMMARY_ELEVATION_KEY, v) } catch { /* 存不进就不同步 */ }
    window.dispatchEvent(new StorageEvent('storage', { key: SUMMARY_ELEVATION_KEY }))
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
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  // Electron 托管后端(window.tangu 缺省=浏览器调试,隐藏 managed UI)
  const isDesktop = !!window.tangu?.backendStatus
  // Forsion 账号面(登录 / 登出 / 切号)住在内置包 Forsion Extend 里:forsionLogin 是它的桥键,没装 Extend 就没有 Forsion 子页与登录入口
  const cloudAccount = !!window.tangu?.forsionLogin
  // Tangu Web(浏览器云端客户端):解闸云端可用特性(技能);其余 host tab 仍随 isDesktop 隐藏。
  const cloudWeb = !!window.tangu?.cloudWeb
  // Unit 设备页(B 端渲染):插件真的在装(unit/plugins),插件页必须给 —— 只藏 shell 类操作;
  // 其余 host tab(MCP/Hooks/托管后端等)仍随 isDesktop 隐藏(shim 没有那些桥,列出来就是白板)。
  const unitPage = !!window.tangu?.unitPage
  // 服务器 Unit 的网页主入口(/web/):页面账号就是来访者本人 →「Forsion 云端」一级页给 Extend 的账号子页;
  // 宿主自己的「同步 / 连接」两页仍只在桌面(网页版不跑同步引擎,云端地址也不归它改)。
  const publicEntry = unitPage && !!window.tangu?.unitPublicEntry
  // 网页主入口上这一页的正文全是 Extend 的子页:它真注册了才列(服务器的 /admin/ 没装 Extend,列出来就是空页)
  const mobileExtend = !!window.tangu?.mobile && !!window.tangu?.extendMobile
  const extendPages = usePluginStore((s) => (publicEntry || mobileExtend) && s.settingsViews.some((o) => o.pluginId === 'forsion-extend' && s.activeIds.includes(o.pluginId)))
  // 插件页(amadeus-plugins)与左栏 fplugin:<id> 直达项的**同一道闸**:桌面 / 设备页 / Android App(2026-10-02 起
  // 市场能装 Forsion 插件,插件宿主在 mobile/src/plugins)。三处(tabItems、tab 推导、「插件设置」的 Forsion 条目)必须一致,
  // 否则 fplugin: 深链在手机上被推导弹回首页。web 云壳没有插件宿主(listPlugins 恒空),照旧不列。
  const pluginsPage = isDesktop || unitPage || (!!window.tangu?.mobile && !!window.amadeus)
  // 捆绑包级联(内嵌引擎插件随父插件启停)只给本机桌面:设备页的 cfg 指向对方引擎,手机的 cfg 指向云端网关 —— 都不能 PUT。
  const pluginCascade = isDesktop && !unitPage
  // 单列壳(真机 / 开发者移动预览):没有键盘快捷键可录,也没有底部状态栏、ribbon。判据与 bootstrapEngine 的 singleColumn 同一条。
  const phoneShell = !!window.tangu?.mobile || UI_MODE === 'mobile'
  // 引擎插件清单(异步到);「电脑操作」的一级页跟着它在不在。
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const computerUse = (plugins || []).find((pl) => pl.id === COMPUTER_USE_PLUGIN && pl.enabled && pl.settings)
  const pluginNm = (pl: PluginInfo): string => (locale === 'en' && pl.nameEn ? pl.nameEn : pl.name)

  // ── 「扩展 › 插件设置」折叠组(方案 P4,2026-11-18 用户定)。原来每个有设置的插件各占一个一级项,几十个插件会把左栏冲垮;
  // 现在收进一个父项:引擎插件 `plugin:<id>` + Forsion 插件 `fplugin:<id>`,开着关着都列(关着的灰),按显示名排;
  // 超过 8 个只列最近打开的 5 个 + 「另外 N 个…」(列表页 `plugin-settings`)。条目与排序在 pluginSettingsNav.ts。
  // ⚠️ Forsion 插件那半的闸必须与「插件」页(amadeus-plugins,pluginsPage)一致:window.amadeus 在、那一页却不在(web 云壳),
  // 只按 amadeus 放行会列出一批点「返回」就被推导弹回首页的条目。
  // ⚠️ pluginStore.enable() 给每个启用插件自动塞一行 `workFolder`,那行人人都有,不算「有设置」(pluginsWithSettingsPanel)。
  const asList = <T,>(x: unknown): T[] => (Array.isArray(x) ? x as T[] : [])
  const amxPlugins = asList<AmadeusPlugin>(usePluginStore((s) => s.plugins))
  const amxActiveIds = asList<string>(usePluginStore((s) => s.activeIds))
  const amxDisabledIds = asList<string>(usePluginStore((s) => s.disabledIds))
  const amxSettings = asList<{ pluginId: string; item: { key: string } }>(usePluginStore((s) => s.settings))
  const amxSettingsViews = usePluginStore((s) => s.settingsViews)
  const amxSettingsPages = asList<{ pluginId: string; item: { title: string | (() => string); keywords?: string } }>(usePluginStore((s) => s.settingsPages))
  const forsionPluginHost = pluginsPage && !!window.amadeus
  const forsionLive = new Set(forsionPluginHost
    ? pluginsWithSettingsPanel(amxPlugins, amxActiveIds, amxSettings, asList(amxSettingsViews), amxSettingsPages).map((pl) => pl.id) : [])
  const forsionLiveSig = [...forsionLive].sort().join('\n')
  const [knownPluginSettings, setKnownPluginSettings] = useState(readKnownPluginSettings)
  // 在跑的插件有没有设置记一笔:关掉以后照样列在「插件设置」里(灰的)。读不出原来那份就不写(syncKnown 自己判)。
  useEffect(() => {
    if (!forsionPluginHost) return
    const next = syncKnownPluginSettings(amxActiveIds, forsionLive)
    if (next) setKnownPluginSettings((prev) => (prev === next ? prev : next))
  }, [forsionPluginHost, forsionLiveSig, amxActiveIds.join('\n')])
  const pageTitleOf = (title: string | (() => string)): string => { try { return typeof title === 'function' ? String(title() ?? '') : String(title ?? '') } catch { return '' } }
  const pluginSettingsEntries: PluginSettingsEntry[] = sortPluginSettingsEntries([
    ...(isDesktop ? (plugins || []).filter((pl) => pl.settings && pl.id !== COMPUTER_USE_PLUGIN).map((pl): PluginSettingsEntry => ({
      tab: `plugin:${pl.id}`, kind: 'engine', id: pl.id, name: pluginNm(pl), enabled: !!pl.enabled,
      keywords: `${pl.id} ${pl.name} ${pl.nameEn ?? ''}`, meta: pluginMetaLine(t, pl.version, enginePluginSource(pl)),
    })) : []),
    ...(forsionPluginHost ? amxPlugins.filter((pl) => forsionPluginHasSettings(pl.id, amxActiveIds.includes(pl.id), forsionLive, knownPluginSettings)).map((pl): PluginSettingsEntry => ({
      tab: `fplugin:${pl.id}`, kind: 'forsion', id: pl.id, name: pluginDisplayName(pl, locale), enabled: pluginWanted(pl, amxDisabledIds),
      keywords: [pl.id, pl.name, pl.nameEn ?? '', ...amxSettingsPages.filter((o) => o.pluginId === pl.id).map((o) => `${pageTitleOf(o.item.title)} ${o.item.keywords ?? ''}`)].join(' '),
      meta: pluginMetaLine(t, pl.version, forsionPluginSource(pl)),
    })) : []),
  ], locale === 'en' ? 'en' : 'zh')
  const [recentPluginSettings, setRecentPluginSettings] = useState(readRecentPluginSettings)
  // 委托管理员只管 Agent:设置里只留 Agent 与技能两页(别的页的数据面全在那台设备的白名单外;见 services/delegatedAdmin.ts)。
  const delegatedTabs = DELEGATED_SETTINGS_TABS.map((id) => [id, t(`settings.tab.${id}`)] as [Tab, string])
  const tabItems = isDelegatedAdmin() ? delegatedTabs : [
    // = 连接 + Forsion 合并。⚠️ 云端 Web / 移动端(webShim、mobileShim 都是 cloudWeb:true 且不给
    // backendStatus)下这一页**每个块都是 false**——连接项全是桌面/自建后端专属——列出来点进去是白板,
    // 而它还是默认落点。整页无正文就别列。
    ...(!isDesktop && cloudWeb ? [] : ([['general', t('settings.tab.general')]] as Array<[Tab, string]>)),
    ['model', t('modelsettings.title')],
    ...(isDesktop ? ([['agents', t('settings.tab.agents')]] as Array<[Tab, string]>) : []),
    // 技能云端可用:desktop 或 Tangu Web 都显示(保持 desktop 原有顺序:agents→skills→mcp…)。
    ...((isDesktop || cloudWeb) ? ([['skills', t('settings.tab.skills')]] as Array<[Tab, string]>) : []),
    // 统一插件页(amadeus-plugins):Forsion 插件(含捆绑包)+ Tangu 引擎插件两区一页;旧 'plugins' 入口已并入(settingsTarget 的别名表)。
    ...(isDesktop && connectorsSupported() ? ([['connectors', t('settings.tab.connectors')]] as Array<[Tab, string]>) : []),
    ...(isDesktop ? ([['mcp', t('settingsmodal.tab.mcp')], ['hooks', t('settingsmodal.tab.hooks')], ['channels', t('settings.tab.channels')], ['browser', t('settings.tab.browser')]] as Array<[Tab, string]>) : []),
    // 电脑操作(引擎插件 computer-use)启用且有设置时才有这一页;原先只排在「扩展」组最末尾、和几十个插件混在一起(反馈 0c0cd24f)。
    ...(isDesktop && computerUse ? ([['computer-use', t('settings.tab.computerUse')]] as Array<[Tab, string]>) : []),
    // 插件页设备页也给(插件在 B 端真的装载运行,列表/启停是本页 runtime 行为,不碰对方设备)。
    ...(pluginsPage ? ([['amadeus-plugins', t('settings.tab.amadeusPlugins')]] as Array<[Tab, string]>) : []),
    // 插件设置(折叠父项 + 列表页):有一个带设置的插件才列
    ...(pluginSettingsEntries.length ? ([['plugin-settings', t('settings.tab.pluginSettings')]] as Array<[Tab, string]>) : []),
    // Forsion 云端(账号 / 云端地址 / 记忆同步 / 笔记在线同步)整页住在 Extend 的桥键后面:停用或没装 Extend 就没有这一页
    ...(cloudAccount && (isDesktop || extendPages) ? ([['forsion', t('settings.tab.forsionCloud')]] as Array<[Tab, string]>) : []),
    ...(isDesktop && !!window.amadeus ? ([['notes', t('settings.tab.notes')]] as Array<[Tab, string]>) : []),
    ...(isDesktop && !!window.amadeus && !!window.remoteSync ? ([['sync', t('settings.tab.sync')]] as Array<[Tab, string]>) : []),
    ['spaces', t('settings.tab.spaces')],
    ['theme', t('settings.tab.theme')],
    ...(phoneShell ? [] : ([['shortcuts', t('settings.tab.shortcuts')]] as Array<[Tab, string]>)),
    ['notifications', t('settings.tab.notifications')],
    ...(phoneShell ? [] : ([['statusbar', t('settings.tab.statusbar')]] as Array<[Tab, string]>)),
    ['advanced', t('settings.tab.advanced')],
    // 回收站(卸载的 Agent / 技能 / 插件放 30 天):只在本机引擎有,手机原生外壳同一页;放「系统」组、设备权限上面。
    ...(isDesktop || window.tangu?.mobile ? ([['trash', t('trash.tab')]] as Array<[Tab, string]>) : []),
    // 手机 App 的同名页(通知 / 操作这台手机 / 麦克风)由手机入口登记(phoneGuide().PermissionsPanel);两者不会同时成立(桌面那份排除了 mobile)。
    ...(hasDesktopPermissions() || phoneGuide()?.PermissionsPanel ? ([['permissions', t('desktopPermissions.title')]] as Array<[Tab, string]>) : []),
    // 设置 › 设备(原 Ribbon 胶囊菜单,10-17 搬进来):只在有 Unit 主进程桥的真桌面列。
    ...(window.tangu?.unitHostStatus || window.tangu?.unitsList ? ([['units', t('unit.tab')]] as Array<[Tab, string]>) : []),
    // P1-K4:只在执行设备本机(有主进程 API)列;设备页 / web / 手机没有 —— 开关只能在本机改。
    ...(remoteSessionsApi() ? ([['remote-sessions', t('remoteSessions.tab')]] as Array<[Tab, string]>) : []),
    // 不按 darwin 门控:非 mac 也列出来,页内说明「目前仅支持 macOS」,免得用户找不到入口。
    ...(computerHistoryApi() ? ([['computer-history', t('settingsmodal.tab.computerHistory')]] as Array<[Tab, string]>) : []),
    ...((isDesktop || cloudWeb) && devMode ? ([['developer', t('settings.tab.developer')]] as Array<[Tab, string]>) : []),
    ['about', t('settings.tab.about')],
  ] as Array<[Tab, string]>

  // 一级页也做 activeSub 同款推导:请求的页在本端不存在时(深链带来的旧 tab、或上面被摘掉的 general)
  // 落到第一个可用页,免得停在白板上。plugin:<id> 动态页不在 tabItems 里,单独放行。
  const tab: Tab = tabItems.some(([id]) => id === rawTab) || rawTab.startsWith('plugin:')
    || (rawTab.startsWith('fplugin:') && pluginsPage && !!window.amadeus)
    || (rawTab === 'computer-use' && isDesktop && plugins === null)
    ? rawTab
    : (tabItems[0]?.[0] ?? rawTab)
  const isPluginTab = tab.startsWith('plugin:') || tab.startsWith('fplugin:')
  // 记最近打开的插件设置页(折叠时列哪 5 个)
  useEffect(() => { if (isPluginSettingsTab(tab)) setRecentPluginSettings(touchRecentPluginSettings(tab)) }, [tab])
  // 有天然子页面的设置项改成折叠导航。桌面初次打开时展开当前项；移动端首页从总项开始。
  // 「插件设置」父项缺省展开(P4)。
  const [expandedTabs, setExpandedTabs] = useState<Set<Tab>>(() => (
    mobileSettings ? new Set<Tab>(['plugin-settings']) : new Set<Tab>([tab, 'plugin-settings'])
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

  // 落盘快照(主进程 effectiveConfig)与未保存草稿**分开存**(U-05):即时控件 `.then(setStored)` 只刷新快照,
  // 草稿(`edits`)浮在上面不被冲掉。下文读 `stored` 拿到的是合并视图;写草稿一律 `edit({...})`,不要 setStored({...stored})。
  const [savedCfg, setStored] = useState<StoredDesktopConfig | null>(null)
  /** 打开设置时 getConfig() 失败的原因(Codex H1-1):读不回持久配置时外部连接表单保持只读并说明原因。 */
  const [cfgLoadError, setCfgLoadError] = useState('')
  const [edits, setEdits] = useState<SettingsEdits>({})
  const stored = mergeEdits(savedCfg, edits)
  const edit = (patch: SettingsEdits): void => setEdits((prev) => ({ ...prev, ...patch }))
  /** 失焦自动保存失败的键 → 错误与重试(就地显示在该输入旁,Codex 第一轮 A-2)。草稿不动,可改完再失焦或点重试。 */
  const [commitErrors, setCommitErrors] = useState<Partial<Record<keyof StoredDesktopConfig, { message: string; retry: () => void; picked?: true }>>>({})
  /** 提交草稿里的若干键:norm 可规整(trim 等);成功后只摘掉提交时那一份值。失败记进 commitErrors(由 commitErrorHint 就地显示)。 */
  const commitEdits = (keys: Array<keyof StoredDesktopConfig>, norm?: (v: SettingsEdits) => SettingsEdits): Promise<void> => {
    const snapshot = pickEdits(edits, keys)
    if (!Object.keys(snapshot).length || !window.tangu?.setConfig) return Promise.resolve()
    return window.tangu.setConfig(norm ? norm(snapshot) : snapshot).then((next) => {
      setStored(next)
      setEdits((prev) => dropCommittedEdits(prev, snapshot))
      setCommitErrors((prev) => withoutKeys(prev, keys))
    }).catch((e: any) => {
      const message = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      // 重试走 ref 取**最新一次渲染**的 commitEdits:直接闭包这一次的,读到的是失败那一刻的 edits —— 用户改了新值
      // 再点「重试」时,失焦先提交新值、重试又把旧快照写回去,盘上落旧值、新草稿被回执抹掉(复核补漏)。
      setCommitErrors((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [k, { message, retry: () => void commitEditsRef.current(keys, norm) }])) }))
    })
  }
  const commitEditsRef = useRef(commitEdits)
  commitEditsRef.current = commitEdits
  /** 「选择目录」直接落盘(不经草稿);失败同样就地提示并可重试。 */
  const savePickedWorkspace = (d: string): void => {
    const typed = edits.defaultWorkspaceDir
    void window.tangu!.setConfig({ defaultWorkspaceDir: d }).then((next) => {
      setStored(next)
      // 请求在路上时又手输了新路径 → 那份新草稿留着,不被选目录的回执抹掉。
      setEdits((prev) => {
        if (prev.defaultWorkspaceDir !== typed) return prev
        const rest = { ...prev }
        delete rest.defaultWorkspaceDir
        return rest
      })
      setCommitErrors((prev) => withoutKeys(prev, ['defaultWorkspaceDir']))
    }).catch((e: any) => {
      const message = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      // picked:这条错误的「重试」提交的是当时选中的目录 d。用户随后改填了路径 → 由 onChange 收回它(Codex H1-2),
      // 否则点重试时输入框先失焦提交新路径、重试又把旧目录写回,旧目录最终落盘。
      setCommitErrors((prev) => ({ ...prev, defaultWorkspaceDir: { message, retry: () => savePickedWorkspace(d), picked: true } }))
    })
  }
  const commitErrorHint = (key: keyof StoredDesktopConfig): React.ReactNode => {
    const err = commitErrors[key]
    if (!err) return null
    return (
      <div className="hint settings-commit-error" role="alert" data-commit-error={key}>
        <span>{t('settingsmodal.commit.failed', { error: err.message })}</span>
        <button type="button" className="btn ghost sm" onClick={err.retry}>{t('settingsmodal.commit.retry')}</button>
      </div>
    )
  }
  // 后端运行方式的草稿(U-01):点卡片只改这里,真正切换走下方显式按钮。null = 跟随落盘值。
  const [modeDraft, setModeDraft] = useState<'managed' | 'external' | null>(null)
  const modeDraftRef = useRef(modeDraft)
  modeDraftRef.current = modeDraft
  const [modeExpanded, setModeExpanded] = useState(false)
  const [runtimeSaving, setRuntimeSaving] = useState(false)
  // Backend restarts refresh p.cfg/getConfig while this page stays open. Keep the
  // user's policy draft separate so those responses cannot silently weaken it.
  const [hostSandboxDraft, setHostSandboxDraft] = useState<StoredDesktopConfig['hostSandbox'] | null>(null)
  useEffect(() => {
    if (p.open) return
    setHostSandboxDraft(null)
    setEdits({})
    setCommitErrors({})
    setExtDraft(null)
    setModeDraft(null)
  }, [p.open])
  const [backendSt, setBackendSt] = useState<BackendStatusInfo | null>(null)
  // 外部连接(或 web,无内置后端)时状态条看的是 appStore 的连接态;backendStatus() 只描述内置进程。
  const connState = useApp((s) => s.connState)
  const [logs, setLogs] = useState<string[] | null>(null)
  // Forsion 账号 / provider OAuth 登录态
  const [authSt, setAuthSt] = useState<AuthStatusInfo | null>(null)
  const authRequest = useRef(0)
  const syncRequest = useRef(0)
  const [providers, setProviders] = useState<Array<{ id: string; loggedIn: boolean }> | null>(null)
  const [providerBusy, setProviderBusy] = useState<string | null>(null)
  // 直连 provider 配置(~/.tangu/providers.json)
  const [customProviders, setCustomProviders] = useState<DirectProviderConfig[]>([])
  /** 装了 Extend 且登录有效:语音通话的云端模型此时才可选(默认模型页、模型库、语音页三处同一口径)。 */
  const realtimeSignedIn = cloudAccount && !!authSt?.loggedIn && authSt.tokenValid !== false
  /** 模型与服务(11-26 C2):添加连接 / 添加模型两个弹窗,和模型清单「只看某条连接」。 */
  const [addConnOpen, setAddConnOpen] = useState(false)
  const [addModels, setAddModels] = useState<{ draft?: ConnectionDraft; providerId?: string } | null>(null)
  const [libProvider, setLibProvider] = useState<string | null>(null)
  const [libMsg, setLibMsg] = useState('')
  // 本地联网搜索(BYO-key;engine /agent/websearch)。wsRed=null 表示端点不可用(云端/旧后端)→ 整段隐藏。
  const [wsRed, setWsRed] = useState<LocalWebSearchRedacted | null>(null)
  // 镜像连通性测试(设置页管理后端)
  const [mirrorTesting, setMirrorTesting] = useState(false)
  const [mirrorTest, setMirrorTest] = useState<MirrorTestResult | null>(null)
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
  // MCP 页页头合计的分母:本机新对话会用的那个模型(MCP 状态与 models 都来自本机引擎;焦点在别的电脑时也按本机算),
  // 没选过就落到本机目录的 defaultModelId(渲染处)
  const defaultChatModelId = useApp((s) => defaultModelOf(s, HOME_REF) || '')
  const [editMcp, setEditMcp] = useState<{ name: string; isNew: boolean; command: string; argsText: string; url: string; transport: 'auto' | 'stdio' | 'http' | 'sse'; envText: string; original?: McpServerConfigEntry } | null>(null)
  const [mcpMsg, setMcpMsg] = useState('')
  const [showMcpImport, setShowMcpImport] = useState(false)
  const [mcpImportDraft, setMcpImportDraft] = useState<McpImportDraft>({ json: '', name: '' })

  // Obsidian 式插件:清单 + 每插件设置页(已启用且有 settings 的插件在「扩展」组下成一级 nav 项)。
  const [pluginAgents, setPluginAgents] = useState<NormalAgentDef[]>([])
  const reloadPlugins = useCallback(() => {
    if (!isDesktop) return
    void listPlugins(homeTarget()).then(setPlugins).catch(() => setPlugins([]))
  }, [isDesktop, p.cfg])
  useEffect(() => {
    if (!p.open || !isDesktop) return
    reloadPlugins()
    void listAgents(homeTarget()).then(setPluginAgents).catch(() => { /* ignore */ })
  }, [p.open, isDesktop, reloadPlugins, p.cfg])
  // `plugin:<id>` 只有「声明了设置项」的引擎插件才有页(P4 起关着的也有,页上是「已停用 · 启用」);「电脑操作」一级页仍要开着。
  // 商店的「打开设置」、agent 的 open-settings 都可能带来别的 id:清单到了再判,落到引擎插件列表(那一行上有它的开关)。
  useEffect(() => {
    if (!(rawTab.startsWith('plugin:') || rawTab === 'computer-use') || !plugins) return
    const pl = plugins.find((x) => x.id === (rawTab === 'computer-use' ? COMPUTER_USE_PLUGIN : rawTab.slice('plugin:'.length)))
    if (!(pl?.settings && (pl.enabled || rawTab !== 'computer-use'))) { goTab('amadeus-plugins'); setSub('pl-engine') }
  }, [rawTab, plugins])

  // 本地联网搜索配置:进模型 tab 拉取;云端/旧后端 404 → wsRed=null 整段隐藏。
  useEffect(() => {
    if (!p.open || tab !== 'model' || !isDesktop) return
    void getLocalWebSearch(homeTarget())
      .then(setWsRed)
      .catch(() => setWsRed(null))
  }, [p.open, tab, isDesktop, p.cfg])
  /** 详情页 / 插件列表里的「设置」直达:落到它在「插件设置」里的那一页。 */
  const openForsionSettings = (id: string): void => goTab(`fplugin:${id}` as Tab)
  // 首方内置包(Forsion Extend)挂进「Forsion 云端」的自绘子页:插件启用、面板声明了 category。设备页不挂(那边不是本机账号)。
  const cloudViews = cloudAccount && ((isDesktop && !unitPage) || publicEntry || mobileExtend)
    ? amxSettingsViews.filter((o) => amxActiveIds.includes(o.pluginId) && isPlacedSettingsView(amxPlugins.find((pl) => pl.id === o.pluginId), o.item))
    : []
  const groupedCloud = cloudViews.some((view) => cloudSettingsParent(cloudViews, cloudViewKey(view)) !== cloudViewKey(view))

  // 旧「Tangu → 插件」独立入口已并入统一插件页:旧深链/持久化 tab 一律重定向。

  // MCP 页:每个已连接的 server 每个请求约占多少 token(引擎按工具定义 JSON / 4 估),页头合计占默认模型窗口的比例。
  // 不出金额、不按会话算 —— 只说体量,让人决定关哪个。没连上的不给数字。
  type McpStatusRow = NonNullable<ToolsResponse['mcp']>[number]
  const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const mcpStatusLabel = (st: McpStatusRow): string =>
    st.status === 'connected' ? t('settings.mcp.statusConnected', { count: st.tools.length })
      : st.status === 'needs-login' ? t('settingsmodal.mcp.needsLogin')
      : st.status === 'logging-in' ? t('settingsmodal.mcp.loggingIn')
      : st.status === 'error' ? t('settings.mcp.statusError')
        : st.status === 'disabled' ? t('settings.mcp.statusDisabled')
          : t('settingsmodal.mcp.notConnected')
  const mcpTokensLabel = (st: McpStatusRow | undefined): React.ReactNode =>
    st?.status === 'connected' && typeof st.approxTokens === 'number'
      ? <span className="mcp-tokens">{t('settingsmodal.mcp.tokens', { n: fmtTok(st.approxTokens) })}</span>
      : null
  const mcpTotalSummary = (): React.ReactNode => {
    // 插件自带的照算;mcp.json 里的要还在、且没停用(刚删 / 刚停的,状态快照在页面刷新前还是 connected)
    const live = (mcpStatus || []).filter((s) => s.status === 'connected' && typeof s.approxTokens === 'number' && (s.origin || (mcpServers[s.server] && mcpServers[s.server].enabled !== false)))
    if (!live.length) return null
    const total = live.reduce((n, s) => n + s.approxTokens!, 0)
    const win = models?.models.find((m) => m.id === (defaultChatModelId || models.defaultModelId))?.contextWindow
    const pct = win ? (total / win) * 100 : undefined
    return (
      <div className="mcp-token-summary" data-mcp-token-summary>
        <Info size={14} />
        <div>
          {pct === undefined ? t('settingsmodal.mcp.totalNoWindow', { n: fmtTok(total) }) : t('settingsmodal.mcp.total', { n: fmtTok(total), pct: pct.toFixed(1) })}
          <small>{t(pct !== undefined && pct > 5 ? 'settingsmodal.mcp.heavyNote' : 'settingsmodal.mcp.estimateNote')}</small>
        </div>
      </div>
    )
  }

  const refreshMcp = (): void => {
    void window.tangu?.readMcpConfig?.().then((c) => setMcpServers(c.mcpServers)).catch(() => setMcpServers({}))
    void listTools(homeTarget()).then((t) => setMcpStatus(t.mcp ?? [])).catch(() => setMcpStatus([]))
  }

  // 正在等浏览器那头的 server:状态轮询看到它连上 / 退回待登录时,把「已打开登录页」那句换成结果
  // started:见过「登录中 / 连接中」之后的待登录才算失败(点之前发出的那次轮询可能还带着上一次的待登录)
  const mcpLoginPending = useRef<{ name: string; started: boolean } | null>(null)
  useEffect(() => {
    const pending = mcpLoginPending.current
    const st = pending ? mcpStatus?.find((s) => s.server === pending.name) : undefined
    if (!pending || !st) return
    if (st.status === 'logging-in' || st.status === 'connecting') { pending.started = true; return }
    if (st.status !== 'connected' && !pending.started) return
    mcpLoginPending.current = null
    if (st.status === 'connected') setMcpMsg(t('settingsmodal.mcp.loggedIn', { name: pending.name }))
    else if (st.error) setMcpMsg(`${t('settingsmodal.mcp.loginNotDone', { name: pending.name })}${st.error}`)
  }, [mcpStatus]) // eslint-disable-line react-hooks/exhaustive-deps
  const loginMcp = (name: string): void => {
    void mcpLogin(homeTarget(), name).then(async (r) => {
      mcpLoginPending.current = { name, started: false }
      if (r.url) {
        await window.tangu?.openExternal?.(r.url)
        setMcpMsg(t('settingsmodal.mcp.loginOpened', { name }))
      }
      refreshMcp()
    }).catch((e) => setMcpMsg(`${t('settingsmodal.mcp.loginFailed')}${e instanceof Error ? e.message : String(e)}`))
  }
  const logoutMcp = (name: string): void => {
    if (!window.confirm(t('settingsmodal.mcp.logoutConfirm', { name }))) return
    void mcpLogout(homeTarget(), name).then(() => { setMcpMsg(t('settingsmodal.mcp.loggedOut', { name })); refreshMcp() })
      .catch((e) => setMcpMsg(`${t('settings.toast.saveFailed')}${e instanceof Error ? e.message : String(e)}`))
  }

  const writeMcp = async (next: Record<string, McpServerConfigEntry>, msg: string, base = mcpServers): Promise<boolean> => {
    return window.tangu!.writeMcpConfig!({ mcpServers: next, base }).then((c) => {
      setMcpServers(c.mcpServers)
      setMcpMsg(msg)
      return true
    }).catch((e) => { setMcpMsg(`${t('settings.toast.saveFailed')}${ipcErrorText(e)}`); return false }) // 原因码(如 mcp-name-reserved)译成当前语言
  }

  useEffect(() => {
    if (!p.open || tab !== 'mcp' || !window.tangu?.readMcpConfig) return
    let alive = true
    const poll = () => {
      void window.tangu!.readMcpConfig!().then(c => { if (alive) setMcpServers(c.mcpServers) }).catch(() => {})
      void listTools(homeTarget()).then(r => { if (alive) setMcpStatus(r.mcp ?? []) }).catch(() => {})
    }
    const timer = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [p.open, tab])

  const refreshAuth = (): void => {
    if (!window.tangu?.authStatus) return
    const request = ++authRequest.current
    void window.tangu.authStatus().then((value) => {
      if (request === authRequest.current) setAuthSt(value)
    }).catch(() => { if (request === authRequest.current) setAuthSt(null) })
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
    let pending = true
    void api.get().then((value) => { if (pending) setNoteSync(value) }).catch(() => {})
    const off = api.onStatus((value) => { pending = false; setNoteSync(value) })
    return () => { pending = false; off() }
  }, [])

  const refreshSyncStatus = (): void => {
    const request = ++syncRequest.current
    backendGetSyncStatus(homeTarget()).then((value) => {
      if (request === syncRequest.current) setSyncSt(value)
    }).catch(() => { if (request === syncRequest.current) setSyncSt(null) })
  }

  const doSyncNow = async (): Promise<void> => {
    const request = ++syncRequest.current
    const accountId = stored?.forsionSyncAccountId
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await backendSyncNow(homeTarget())
      if (request !== syncRequest.current) return
      if (r.ok) {
        setSyncMsg(t('settings.forsion.syncOk', { memory: r.memory, logs: r.logs.length }) + (r.agents ? ` · ${r.agents} agent ↑${r.pushed ?? 0} ↓${r.pulled ?? 0}` : ''))
        if (window.tangu?.setConfig) void window.tangu.setConfig({ forsionLastSyncedAt: Date.now(), forsionSyncAccountId: accountId }).then((value) => {
          if (request === syncRequest.current) setStored(value)
        })
      } else {
        setSyncMsg(t('settings.forsion.syncFail', { e: r.error || '?' }))
      }
      refreshSyncStatus()
    } catch (e: any) {
      if (request === syncRequest.current) setSyncMsg(t('settings.forsion.syncFail', { e: e?.message || e }))
    } finally {
      setSyncing(false)
    }
  }

  // 跨生态资产发现/导入(高级页;扫 ~/.claude、~/.codex、~/.hermes)
  const [aiImportOpen, setAiImportOpen] = useState(false)

  useEffect(() => {
    if (p.open) {
      setDraft(p.cfg)
      setTestResult('')
      setLogs(null)
      if (isDesktop) {
        setCfgLoadError('')
        void window.tangu!.getConfig().then((s) => {
          setStored(s)
          // 自动同步(默认关):开启则打开设置时拉一次;未登录时后端 no-op,不报错。
          if (s.forsionSyncEnabled) void doSyncNow()
        }).catch((e: any) => setCfgLoadError(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
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
    const off3 = window.tangu!.onAuthChanged?.(() => {
      ++authRequest.current
      ++syncRequest.current
      setAuthSt(null)
      setSyncSt(null)
      setSyncMsg('')
      setSyncing(false)
      refreshAuth()
      const request = authRequest.current
      void window.tangu!.getConfig().then((value) => {
        // 登录 / 登出时引擎已带新凭据重启完(主进程重启完才广播):模型目录跟着重拉 —— 云端的通话模型、
        // 云端模型列表都随账号变,不拉的话「语音通话」这节还停在登录前的说法,和输入框的通话键对不上。
        // 不受下面那道序号闸管:登录态一变 p.cfg 跟着变,上面的 effect 会再调 refreshAuth 把序号顶掉。
        void loadModels(value)
        if (request === authRequest.current) setStored(value)
      }).catch(() => {})
    })
    return () => {
      ++authRequest.current
      ++syncRequest.current
      off1?.()
      off3?.()
    }
  }, [p.open, isDesktop])

  // An expired account token still binds the saved cloud address.
  const cloudUrlLocked = !!authSt?.loggedIn
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

  // mode = **已落盘**的运行方式(概览、localHost 判定都读它);viewMode = 草稿优先,决定下方展示哪组参数。
  // 以前点卡片即 setConfig({mode}) —— mode 是 managedKeys,一点就重启/停掉内置后端(U-01)。
  const mode = savedCfg?.mode || 'external'
  const viewMode = modeDraft ?? mode
  // 状态条判定源:已落盘为外部连接(或 web 端没有内置后端)→ 看连接态;托管 → 看内置进程。
  // desktop 上 savedCfg 未读回前按托管处理(显示「加载中」),免得先闪一下外部连接的状态。
  const externalConn = !isDesktop || savedCfg?.mode === 'external'
  const stripHealth: 'ok' | 'err' | 'pending' = externalConn
    ? (connState === 'ok' ? 'ok' : connState === 'err' ? 'err' : 'pending')
    : (backendSt?.state === 'ready' ? 'ok' : backendSt?.state === 'crashed' ? 'err' : 'pending')
  const modePending = viewMode !== mode
  const pickModeDraft = (m: 'managed' | 'external'): void => setModeDraft(m === mode ? null : m)
  // 外部连接表单的值(Codex 第一轮 A-1):已落盘为外部 → 就是 draft(p.cfg 即外部连接);**托管切外部**时 p.cfg 是
  // 托管后端的临时地址 / 令牌,绝不能拿来填表(点「切换并重连」会把它写成外部配置)—— 改从落盘的外部连接取,
  // 用户在此期间的编辑记在 extDraft。
  const [extDraft, setExtDraft] = useState<{ backendUrl: string; token: string } | null>(null)
  const switchingToExternal = isDesktop && mode !== 'external'
  // 桌面端持久配置还没读回(或读失败):mode 会被当成 external、表单回退到 draft(p.cfg)—— 托管时那是内置后端的
  // 临时地址 / 令牌,此刻点保存就会把它写成外部配置、盖掉原有的外部连接(Codex H1-1)。读回前表单与按钮一律只读。
  const connCfgPending = isDesktop && !savedCfg
  const connForm = switchingToExternal
    ? (extDraft ?? { backendUrl: savedCfg?.externalConnection?.backendUrl ?? '', token: savedCfg?.externalConnection?.token ?? '' })
    : { backendUrl: draft.backendUrl, token: draft.token }
  const editConnForm = (patch: Partial<{ backendUrl: string; token: string }>): void => {
    if (switchingToExternal) setExtDraft({ ...connForm, ...patch })
    else setDraft({ ...draft, ...patch })
  }
  // 托管运行组(改了要重启后端的键)。cloudUrl 也是 managedKey,但它住在 Forsion 页、有自己的显式保存,
  // 这里**不再**顺带落盘(以前会把 Forsion 页没保存的云端地址草稿一起写掉并触发 unit host 重建)。
  const RUNTIME_KEYS: Array<keyof StoredDesktopConfig> = ['sandbox', 'pythonMode', 'mirror']
  const RUNTIME_DEFAULTS: SettingsEdits = { pythonMode: 'bundled', mirror: 'default' }
  const hostSandboxDirty = !!(hostSandboxDraft && savedCfg && JSON.stringify(hostSandboxDraft) !== JSON.stringify(savedCfg.hostSandbox))
  const runtimeParamsDirty = hostSandboxDirty || hasDirtyEdits(savedCfg, edits, RUNTIME_KEYS, RUNTIME_DEFAULTS)
  const discardRuntime = (): void => {
    setEdits((prev) => {
      const next = { ...prev }
      for (const key of RUNTIME_KEYS) delete next[key]
      return next
    })
    setHostSandboxDraft(null)
    setModeDraft(null)
  }
  const [probeKey, setProbeKey] = useState(0)
  const saveManaged = () => {
    if (!stored) return
    const snapshot = pickEdits(edits, RUNTIME_KEYS)
    const submittedMode = modeDraft
    setRuntimeSaving(true)
    void window.tangu!.setConfig({
      mode: 'managed',
      sandbox: stored.sandbox,
      hostSandbox: hostSandboxDraft ?? stored.hostSandbox,
      pythonMode: stored.pythonMode || 'bundled',
      mirror: stored.mirror || 'default',
    }).then((next) => {
      setStored(next)
      setProbeKey((k) => k + 1) // 按新下载源重测本机工具(origin g-runtime)
      setEdits((prev) => dropCommittedEdits(prev, snapshot))
      // 请求在路上时用户又改了运行方式:只收回本次提交的那个草稿,新选择留着。
      setModeDraft((d) => (d === submittedMode ? null : d))
      if (submittedMode === modeDraftRef.current || !modeDraftRef.current) setModeExpanded(false)
    }).catch((e: any) => setTestResult(`${t('settings.toast.saveFailed')}${e?.message || e}`))
      .finally(() => setRuntimeSaving(false))
  }

  // 浏览器工具设置保存(原与微信共用;微信设置已迁「通道」tab,走引擎 /agent/channels)。
  // 这组键也是 managedKeys(写 = 重启后端),所以保持「改草稿 → 吸底栏显式保存」。
  const BROWSER_KEYS: Array<keyof StoredDesktopConfig> = ['browserEnabled', 'browserEngine', 'browserSearchEngine', 'browserAllowPrivateUrls', 'browserCommandTimeoutMs']
  const browserDirty = hasDirtyEdits(savedCfg, edits, BROWSER_KEYS, {
    browserEnabled: true, browserEngine: 'auto', browserSearchEngine: 'duckduckgo', browserAllowPrivateUrls: false, browserCommandTimeoutMs: 30000,
  })
  const discardBrowser = (): void => setEdits((prev) => {
    const next = { ...prev }
    for (const key of BROWSER_KEYS) delete next[key]
    return next
  })
  const saveRemoteSettings = async (): Promise<void> => {
    if (!stored || !window.tangu?.setConfig) return
    setRemoteBusy(true)
    setRemoteMsg('')
    const snapshot = pickEdits(edits, BROWSER_KEYS)
    try {
      const next = await window.tangu.setConfig({
        browserEnabled: stored.browserEnabled !== false,
        browserEngine: stored.browserEngine || 'auto',
        browserSearchEngine: stored.browserSearchEngine || 'duckduckgo',
        browserAllowPrivateUrls: !!stored.browserAllowPrivateUrls,
        browserCommandTimeoutMs: Number(stored.browserCommandTimeoutMs || 30000),
      })
      setStored(next)
      setEdits((prev) => dropCommittedEdits(prev, snapshot))
      setRemoteMsg(t('settings.remote.saved'))
    } catch (e: any) {
      setRemoteMsg(`${t('settings.toast.saveFailed')}${e?.message || e}`)
    } finally {
      setRemoteBusy(false)
    }
  }

  // cfg 缺省取实时 store 值(homeTarget 活目标)而非 draft:draft 是挂载时快照,后端一重启(换端口)就成死地址。
  const loadModels = async (cfg?: TanguDesktopConfig) => {
    setModelsLoading(true)
    try {
      setModels(await listModels(cfg ? connectionTarget(cfg) : homeTarget())) // 重启后刚从主进程读到的配置 = 显式连接;缺省 = 本端当前那份
    } catch (e: any) {
      setModels(null)
      setTestResult(e?.message || t('settings.model.loadFailed'))
    } finally {
      setModelsLoading(false)
    }
  }

  useEffect(() => {
    if (p.open && (tab === 'model' || tab === 'mcp') && !models && !modelsLoading) void loadModels() // mcp:页头合计要默认模型的窗口
    if (p.open && tab === 'mcp') refreshMcp()
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
    if (connCfgPending) return
    setTesting(true)
    const r = await testConnection(connectionTarget({ ...draft, ...connForm }))
    countTelemetry(r.ok ? 'connTestOk' : r.authRejected ? 'connTestAuthRejected' : 'connTestFail') // 匿名遥测只数结果,文字与地址不报
    setTestResult(r.message)
    setTesting(false)
  }

  const saveConnection = async (): Promise<void> => {
    if (connCfgPending) return // 按钮已禁用;这里再守一道(回车 / 程序触发)
    // 只提交表单里的外部地址与令牌(托管切外部时它来自落盘的外部连接 + 用户编辑,见 connForm)。
    const patch = { backendUrl: connForm.backendUrl.trim().replace(/\/+$/, ''), token: connForm.token }
    // 从托管切到外部是用户在这里**显式确认**的(U-01):先落 mode(主进程随之停掉内置后端),
    // 再走原有的 onConfigChange → onReconnect 顺序。
    if (isDesktop && mode !== 'external' && window.tangu?.setConfig) {
      try {
        setStored(await window.tangu.setConfig({ mode: 'external' }))
        setModeDraft(null)
        setModeExpanded(false)
        setExtDraft(null)
        setDraft((d) => ({ ...d, ...patch }))
      } catch (e: any) {
        setTestResult(`${t('settings.toast.saveFailed')}${e?.message || e}`)
        return
      }
    }
    p.onConfigChange(patch)
    p.onReconnect(patch)
  }

  /** 插件设置页的标题 = 插件名(不在「插件设置」里的,比如深链到一个没有设置的插件,也按名字)。 */
  const pluginTabName = (id: Tab): string | undefined => {
    const hit = pluginSettingsEntries.find((e) => e.tab === id)?.name
    if (hit) return hit
    if (id.startsWith('fplugin:')) { const pl = amxPlugins.find((x) => x.id === id.slice('fplugin:'.length)); return pl ? pluginDisplayName(pl, locale) : undefined }
    if (id.startsWith('plugin:')) { const pl = (plugins || []).find((x) => x.id === id.slice('plugin:'.length)); return pl ? pluginNm(pl) : undefined }
    return undefined
  }
  const activeTabLabel = isPluginTab
    ? (pluginTabName(tab) || t('settings.tab.plugins'))
    : (tabItems.find(([id]) => id === tab)?.[1] || (tab === 'computer-use' ? t('settings.tab.computerUse') : t('settings.title')))
  const pageDescriptionKey: Partial<Record<StaticTab | 'plugin-settings', string>> = {
    forsion: 'settings.page.forsionCloudDescription',
    general: 'settings.page.generalDescription',
    spaces: 'settings.page.spacesDescription',
    notes: 'settings.page.notesDescription',
    sync: 'settings.page.syncDescription',
    theme: 'settings.page.themeDescription',
    shortcuts: 'settings.page.shortcutsDescription',
    notifications: 'settings.page.notificationsDescription',
    statusbar: 'settings.page.statusbarDescription',
    model: 'settings.page.modelDescription',
    agents: isDelegatedAdmin() ? 'delegatedAdmin.agentsDescription' : 'settings.page.agentsDescription',
    skills: 'globalSkills.intro',
    connectors: 'connectors.pageHint',
    mcp: 'settings.page.mcpDescription',
    hooks: 'settings.page.hooksDescription',
    channels: 'settings.page.channelsDescription',
    browser: 'settings.page.browserDescription',
    'computer-use': 'settings.page.computerUseDescription',
    'amadeus-plugins': PRODUCT.nativeFeatures !== undefined ? 'settings.amadeusPlugins.unitIntro' : 'settings.page.pluginsDescription',
    'plugin-settings': 'plugsettings.page.description',
    advanced: 'settings.page.advancedDescription',
    trash: 'trash.page',
    // 手机 App 的同名页是通知 / 操作这台手机 / 麦克风三项,不是电脑的那几项权限
    permissions: hasDesktopPermissions() ? 'desktopPermissions.description' : 'phonePerms.pageDescription',
    units: 'unit.page',
    'remote-sessions': 'remoteSessions.page', // P1-K4
    'computer-history': 'settingsmodal.page.computerHistory',
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
      // 「基本」放第一(U-14):默认落点不再是后端技术项。条目只按 isDesktop 门控、正文按 stored 门控 ——
      // 若连条目也等 stored,getConfig 回来前 activeSub 先落 g-conn、回来后跳到 g-basic,正文会闪一下重挂。
      ...(isDesktop ? [['g-basic', t('settingsmodal.sub.basic')] as [string, string]] : []),
      ['g-conn', t('settings.sub.connection')],
      // 本机运行环境单列(原先埋在「连接」页最底部,2.11.4 用户找不到);条件与下方正文块一致。
      ...(isDesktop && stored ? [['g-runtime', t('settings.runtime.title')] as [string, string]] : []),
      // Git 设置写的是引擎 config.json;连着云端 / 别人的引擎时组件自己显示只读说明,不会是白板。
      ...(isDesktop && stored ? [['g-git', 'Git'] as [string, string]] : []),
      ...(isDesktop && stored ? [['g-inbox', t('settings.inbox.title')] as [string, string]] : []),
    ],
    model: [
      ['m-models', t('modelsettings.defaults')],
      ['m-display', t('modelsettings.display')],
      ...((isDesktop || window.tangu?.mobile) && stored ? [['m-voice', t('settings.sub.voice')] as [string, string]] : []),
    ],
    // 主题**刻意不设中分类**(用户拍板):设计语言/配色/明暗/界面大小/阴影/玻璃/光标 各自一张小卡就够,
    // 硬分成三栏反而把「换个主题顺手调下明暗」拆成两次点击。别再加回来。
    // 委托管理员:后台 Agent(special/config)与本机 Agent CLI(engines)都在那台设备的白名单外,只留名册
    agents: isDelegatedAdmin() ? [['ag-roster', t('agentSettings.rosterTitle')]] : [
      ['ag-roster', t('agentSettings.rosterTitle')],
      ['ag-special', t('settings.sub.specialAgents')],
      ['ag-clis', t('settings.tab.agentClis')],
    ],
    'amadeus-plugins': [
      // Forsion 插件区整块在 window.amadeus 后面 —— 没有就只剩引擎插件一项,栏目条自动隐藏。
      ...(window.amadeus ? [['pl-core', t('plugins.core.title')], ['pl-forsion', t('plugins.installed.title')]] as Array<[string, string]> : []),
      // 引擎插件管理桌面专属:设备页的 cfg.backendUrl=对方引擎,rescan/npm 装/启停会真打到对方机器(Codex P1)。
      ...(isDesktop ? [['pl-engine', t('settings.plugins.secEngine')] as [string, string]] : []),
    ],
    advanced: [
      ...(isDesktop ? [['a-mcp', t('settings.sub.mcpServer')] as [string, string]] : []),
      ['a-ui', t('settings.sub.uiSession')],
      ['a-experimental', t('settingsmodal.advanced.experimental')],
      ...(window.tangu?.clearAppData ? [['a-data', t('settings.sub.data')] as [string, string]] : []),
    ],
    skills: [
      ['k-library', t('globalSkills.title')],
      ...(isDesktop ? [['k-discovery', t('settings.discovery.label')] as [string, string]] : []),
    ],
    forsion: [
      // Extend 渲染半身自绘的子页(账号 / 额度与积分 / 安全 / 用量记录 / 反馈),随 Extend 的 npm 版本更新
      ...cloudViews.filter((o) => !groupedCloud || o.item.id !== 'feedback').map((o) => [cloudViewKey(o), cloudViewTitle(o)] as [string, string]),
      // 宿主自己的两页:同步(笔记在线同步 + Brain 记忆同步)、连接(云端地址)。条目条件与正文块一致,免得点进去是白板。
      ...(isDesktop && (window.amadeusSync || stored) ? [['f-sync', t('settings.forsionCloud.sync')] as [string, string]] : []),
      ...(isDesktop && stored ? [['f-conn', t('settings.forsionCloud.connection')] as [string, string]] : []),
      ...cloudViews.filter((o) => groupedCloud && o.item.id === 'feedback').map((o) => [cloudViewKey(o), cloudViewTitle(o)] as [string, string]),
    ],
    sync: [
      // RemoteSyncSection 在 window.remoteSync 缺位时直接 return null → 同样是白板,栏目得跟着走(一级页也按它门控)。
      ...(window.remoteSync ? [['s-remote', t('settings.sync.remoteSec')] as [string, string]] : []),
    ],
  } as Record<string, Array<[string, string]>>)
  const subItemsForTab = (id: Tab): Array<[string, string]> => subItemsByTab[id] ?? []
  const subItems = subItemsForTab(tab)
  // 提供方、联网搜索 11-26 并进「模型与服务」(m-display):旧的子页 id(深链、插件、设置搜索、Agent 的 open-settings)照样认
  const resolvedSub = tab === 'forsion' ? resolveCloudSettingsKey(cloudViews, sub) : tab === 'model' ? modelSubAlias(sub) : sub
  const activeSub = subItems.some(([k]) => k === resolvedSub) ? resolvedSub : (subItems[0]?.[0] ?? '')
  const cloudParentKey = cloudSettingsParent(cloudViews, activeSub)
  const cloudNavKey = groupedCloud && activeSub === 'f-conn' ? 'f-sync' : cloudParentKey
  const cloudTabs = tab === 'forsion' ? cloudSettingsTabs(cloudViews, activeSub) : []
  const cloudPageLabel = subItems.find(([key]) => key === cloudNavKey)?.[1] ?? ''
  const navSubItemsForTab = (id: Tab): Array<[string, string]> => id !== 'forsion' ? subItemsForTab(id)
    : subItemsForTab(id).filter(([key]) => cloudSettingsParent(cloudViews, key) === key && (!groupedCloud || key !== 'f-conn'))
  const cloudDescription = cloudNavKey === ACCOUNT_SUB ? 'settingsmodal.cloudAccountDescription'
    : cloudNavKey === 'fx:forsion-extend:quota' ? 'settingsmodal.cloudMembershipDescription'
      : cloudNavKey === 'fx:forsion-extend:feedback' ? 'settingsmodal.cloudHelpDescription'
        : cloudNavKey === 'fx:forsion-extend:privacy' ? 'settingsmodal.cloudPrivacyDescription' : ''
  const activeSubLabel = subItems.find(([k]) => k === activeSub)?.[1] ?? ''
  const modelSubDescriptions: Record<string, string> = { 'm-models': 'modelsettings.defaultsHint', 'm-display': isDesktop ? 'modelsettings.servicesHint' : 'modelsettings.displayHint', 'm-voice': 'modelsettings.voiceHint' }
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
    if (id === 'forsion' && key === 'f-sync') setCloudAdvancedOpen(false)
    if (id === 'model' && key === 'm-websearch') setLibKind('websearch')
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
      { key: 'workspace', label: t('settings.group.workspace'), tabs: ['forsion', 'general', 'spaces', 'notes', 'sync'] },
      { key: 'appearance', label: t('settings.group.appearance'), tabs: ['theme', 'shortcuts', 'notifications', 'statusbar'] },
      { key: 'ai', label: t('settings.group.ai'), tabs: ['model', 'agents', 'skills', 'connectors', 'mcp', 'hooks', 'channels', 'browser', 'computer-use'] },
      { key: 'extensions', label: t('settings.group.extensions'), tabs: ['amadeus-plugins', 'plugin-settings'] },
      { key: 'system', label: t('settings.group.system'), tabs: ['trash', 'permissions', 'units', 'remote-sessions', 'computer-history', 'advanced', 'developer', 'about'] },
    ] },
  ]
  const navItemsForGroup = (grp: { key: string; tabs: Tab[] }): Array<[Tab, string]> => {
    // 插件不再各占一级项:都收在「插件设置」父项下面(navChildrenFor),手机一级列表同一份。
    return grp.tabs
      .map((id) => tabItems.find(([tid]) => tid === id))
      .filter((x): x is [Tab, string] => !!x)
  }
  /** 左栏 / 手机一级列表里一个父项下面的子项。普通父项 = 它的子页;「插件设置」= 各插件的设置页(各是一个一级 tab)。 */
  type NavChild = { key: string; label: string; active: boolean; open(): void; off?: boolean; more?: boolean }
  const pluginNavChildren = (ql: string): NavChild[] => {
    const child = (e: PluginSettingsEntry): NavChild => ({ key: e.tab, label: e.name, active: tab === e.tab, open: () => goTab(e.tab), off: !e.enabled })
    // 搜索时:父项名本身命中 → 全列;否则只列命中的插件(名字或别名),不折叠
    if (ql) return t('settings.tab.pluginSettings').toLowerCase().includes(ql) ? pluginSettingsEntries.map(child) : pluginSettingsEntries.filter((e) => matchPluginSettingsEntry(e, ql)).map(child)
    const { shown, more } = pluginSettingsNavEntries(pluginSettingsEntries, recentPluginSettings, isPluginSettingsTab(tab) ? tab : undefined)
    return [
      ...shown.map(child),
      ...(more ? [{ key: 'plugin-settings', label: t('plugsettings.more', { n: more }), active: tab === 'plugin-settings', open: () => goTab('plugin-settings'), more: true }] : []),
    ]
  }
  const navChildrenFor = (id: Tab, ql = ''): NavChild[] => id === 'plugin-settings'
    ? pluginNavChildren(ql)
    : navSubItemsForTab(id).map(([key, label]) => ({ key, label, active: tab === id && (id === 'forsion' ? cloudNavKey : activeSub) === key, open: () => openSubPage(id, key) }))
  /** 父项「在这一支上」:插件设置父项在任一插件设置页或列表页时都算。 */
  const navOwns = (id: Tab): boolean => (id === 'plugin-settings' ? isPluginTab || tab === 'plugin-settings' : tab === id)
  const toggleTab = (id: Tab): void => {
    setExpandedTabs((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleDesktopTab = (id: Tab, items: NavChild[]): void => {
    const opening = !expandedTabs.has(id)
    toggleTab(id)
    // 桌面端总项与右侧内容区联动：展开时默认展示它的第一个具体子页面(「插件设置」只开合:第一个插件不比别的特殊)。
    if (opening && items[0] && id !== 'plugin-settings') items[0].open()
  }
  const toggleMobileTab = (id: Tab): void => {
    // 移动端仍停留在设置首页；只有点下面的具体子项才进入二级界面。
    toggleTab(id)
  }

  // 二级页的「返回」:页里还开着一层(从插件列表点进去的详情)→ 先退那一层,与它的 Web「返回列表」钮同一个动作;否则回设置首页。
  const backOneLevel = (): void => {
    const inner = pluginListDetailBack.current
    if (inner) inner()
    else setMobileMenuOpen(true)
  }

  // Android 实体返回 / 系统侧滑:二级页先退一层(见 backOneLevel);已在首页时再交给 MobileRoot 退出设置。
  useEffect(() => {
    if (!p.open || !mobileSettings || mobileMenuOpen) return
    const backToMenu = (event: Event): void => {
      event.preventDefault()
      if ((event as CustomEvent<{ probe?: boolean } | null>).detail?.probe) return // 宿主只是问接不接(手势刚开始):不动手
      backOneLevel()
    }
    window.addEventListener('forsion:mobile-back', backToMenu)
    return () => window.removeEventListener('forsion:mobile-back', backToMenu)
  }, [mobileMenuOpen, mobileSettings, p.open])

  // ── 设置搜索(U-15):分类名命中照旧过滤左栏;另按静态索引列出具体设置项,点击直达并闪一下锚点。──
  const navQl = navQuery.trim().toLowerCase()
  const searchEntryVisible = (e: SettingsSearchEntry): boolean => {
    // 与导航同一套门控:一级页在本端存在、子页在 subItemsByTab 里,再加面板自身的显示条件。
    if (!tabItems.some(([id]) => id === e.tab)) return false
    const subKey = e.tab === 'model' && e.sub ? modelSubAlias(e.sub) : e.sub // 11-26:提供方 / 联网搜索并进「模型与服务」,旧子页 id 照旧可搜
    // 并页后这几块只在桌面画(联网搜索还要引擎报了端点),和旧子页的门控一致
    if (e.id === 'web-search' && !(isDesktop && wsRed)) return false
    if ((e.id === 'model-providers' || e.id === 'masking') && !isDesktop) return false
    if (subKey && !subItemsForTab(e.tab as Tab).some(([k]) => k === subKey)) return false
    return (e.needs ?? []).every((need) => need === 'stored' ? !!stored
      : need === 'desktop' ? isDesktop
      : need === 'host' ? isDesktop && !unitPage
      : need === 'hover' ? hoverCapable
      : need === 'tangu' ? !!tanguPrefs
      : need === 'wide' ? !mobileSettings
      : need === 'cloud' ? isDesktop && cloudAccount // Forsion 账号面随 Extend 出现(forsion 一级页)
      : need === 'managed' ? isDesktop && mode === 'managed' // 托管参数只在已落盘为托管时渲染(g-runtime)
        : (!isDesktop || viewMode === 'external') && !cloudWeb)
  }
  const searchResults = navQl
    ? [
      ...SETTINGS_SEARCH_INDEX.map((e) => ({ ...e, ...(e.id === 'forsion-account' && e.sub ? { sub: cloudAccountSearchKey(cloudViews, e.sub) } : {}), label: t(e.labelKey) })),
      ...cloudViews.map((view) => ({ id: `cloud-${view.pluginId}-${view.item.id}`, tab: 'forsion', sub: cloudViewKey(view), labelKey: '', label: cloudTabTitle(view), keywords: view.item.keywords || cloudViewTitle(view) })),
    ].filter((e) => searchEntryVisible(e) && matchesSettingsQuery(e, e.label, navQl))
    : []
  const navFiltered = navSections.map((sec) => {
    // 搜索:命中大类名保留整大类,命中小类名保留整组,否则按项名过滤。
    const secHit = !navQl || sec.label.toLowerCase().includes(navQl)
    const groups = sec.groups
      .map((grp) => {
        const all = navItemsForGroup(grp)
        const items = secHit || grp.label.toLowerCase().includes(navQl)
          ? all
          : all.filter(([id, label]) => label.toLowerCase().includes(navQl)
            || (id === 'plugin-settings'
              ? pluginSettingsEntries.some((e) => matchPluginSettingsEntry(e, navQl))
              : subItemsForTab(id).some(([, childLabel]) => childLabel.toLowerCase().includes(navQl))))
        return { key: grp.key, label: grp.label, items }
      })
      .filter((g) => g.items.length > 0)
    return { key: sec.key, label: sec.label, groups }
  }).filter((sec) => sec.groups.length > 0)
  const searchPathLabel = (e: SettingsSearchEntry): string => {
    const tabLabel = tabItems.find(([id]) => id === e.tab)?.[1] ?? ''
    const subKey = e.tab === 'model' && e.sub ? modelSubAlias(e.sub) : e.sub
    const subLabel = subKey ? subItemsForTab(e.tab as Tab).find(([k]) => k === subKey)?.[1] : ''
    const parent = e.tab === 'forsion' && e.sub ? cloudSettingsParent(cloudViews, e.sub) : ''
    const parentLabel = parent !== e.sub ? subItemsForTab('forsion').find(([key]) => key === parent)?.[1] : ''
    return subLabel ? `${tabLabel} › ${parentLabel ? `${parentLabel} › ` : ''}${subLabel}` : tabLabel
  }
  const [flashAnchor, setFlashAnchor] = useState<{ id: string; seq: number } | null>(null)
  const jumpToSearchEntry = (e: SettingsSearchEntry): void => {
    if (e.sub) openSubPage(e.tab as Tab, e.sub)
    else goTab(e.tab as Tab)
    if (e.anchor) setFlashAnchor({ id: e.anchor, seq: Date.now() })
  }
  // 锚点滚动必须晚于上面「换页正文回顶」那条 effect,且要等条件渲染的正文(stored / wsRed 异步到位)挂出来:rAF 轮询 ~1s。
  // 不用 scrollIntoView:它会连带滚动 overflow:hidden 的外层(浮窗根 / .settings-page),整页错位。
  useEffect(() => {
    if (!flashAnchor) return
    let raf = 0, timer = 0, tries = 0
    const seek = (): void => {
      const body = document.querySelector<HTMLElement>('.settings-body')
      const el = body?.querySelector<HTMLElement>(`[data-setting-anchor="${flashAnchor.id}"]`)
      if (body && el && el.getBoundingClientRect().height > 0) {
        const offset = el.getBoundingClientRect().top - body.getBoundingClientRect().top
        body.scrollTop += offset - Math.max(12, (body.clientHeight - el.offsetHeight) / 3)
        el.classList.remove('is-anchor-flash')
        void el.offsetWidth
        el.classList.add('is-anchor-flash')
        timer = window.setTimeout(() => el.classList.remove('is-anchor-flash'), 1600)
        return
      }
      if (++tries < 60) raf = requestAnimationFrame(seek)
    }
    raf = requestAnimationFrame(seek)
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer) }
  }, [flashAnchor])

  // 左栏溢出提示(U-14):还能往下滚时底部渐隐,滚到底撤掉(CSS 挂在 [data-overflow='bottom'])。
  const navListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = navListRef.current
    if (!el) return
    const sync = (): void => {
      if (el.scrollHeight - el.clientHeight - el.scrollTop > 2) el.dataset.overflow = 'bottom'
      else delete el.dataset.overflow
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => { el.removeEventListener('scroll', sync); ro?.disconnect() }
  })

  // Android 原生顶栏(lcl nativeChrome 的可选宿主)在场时由它画标题 + 返回(page 模式),Web 页头让位(data-native-chrome)。
  // 返回 / × 与 Web 页头的按钮做的是同一件事:首页「返回」= 退出设置;二级页「返回」= 回设置首页(插件详情开着时先回插件列表),「×」= 退出设置。
  // 没有原生宿主(手机浏览器、桌面手机框)时这个声明是空操作,Web 页头照旧。
  const nativeChrome = useNativeChromeInstalled() && mobileSettings
  useNativeChromeClaim(!p.open || !mobileSettings ? null : mobileMenuOpen
    ? { mode: 'page', title: t('settings.title'), back: t('settings.backToApp'), onBack: p.onClose }
    : { mode: 'page', title: activeSubLabel || activeTabLabel, back: t('settings.title'), onBack: backOneLevel, close: t('settings.backToApp'), onClose: p.onClose })

  if (!p.open) return null

  return (
    <div
      className={`settings-page settings-page--control-center${mobileSettings ? ' settings-page--mobile' : ''}${mobileSettings && mobileMenuOpen ? ' settings-page--mobile-menu' : ''}`}
      data-native-chrome={nativeChrome ? '' : undefined}
    >
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
                    const children = navChildrenFor(id)
                    const expandable = children.length > 0
                    const expanded = expandable && expandedTabs.has(id)
                    const childrenId = `settings-mobile-subitems-${id.replace(':', '-')}`
                    const description = descriptionForTab(id)
                    return (
                      <div className="settings-mobile-entry" key={id}>
                        <button
                          type="button"
                          className="settings-mobile-row"
                          data-settings-tab={id}
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
                            {children.map((c) => (
                              <button
                                type="button"
                                className={`settings-mobile-subrow${c.off ? ' settings-nav-subitem--off' : ''}${c.more ? ' settings-nav-subitem--more' : ''}`}
                                data-settings-sub={c.key}
                                key={c.key}
                                onClick={() => { c.open(); setMobileMenuOpen(false) }}
                              >
                                <span className="settings-mobile-subrow-mark" aria-hidden="true" />
                                <span>{c.label}</span>
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
      <aside className="settings-nav" aria-label={t('settingsmodal.navLabel')}>
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
              aria-label={t('settingsmodal.search.label')}
              placeholder={t('settings.searchPlaceholder')}
              onChange={(e) => setNavQuery(e.target.value)}
            />
            {navQuery && <button className="settings-nav-search-x" onClick={() => setNavQuery('')} title={t('common.cancel')}><X size={13} /></button>}
          </div>
        </div>
        <div className="settings-nav-list" ref={navListRef}>
          {searchResults.length > 0 && (
            <div className="settings-nav-group settings-nav-results">
              <div className="settings-nav-grouphead">{t('settingsmodal.search.results')}</div>
              {searchResults.map((e) => (
                <button
                  type="button"
                  key={e.id}
                  className="settings-nav-subitem settings-nav-result"
                  data-setting-result={e.id}
                  onClick={() => jumpToSearchEntry(e)}
                >
                  <span className="settings-nav-subitem-mark" aria-hidden="true" />
                  <span className="settings-nav-result-copy">
                    <span>{e.label}</span>
                    <small>{searchPathLabel(e)}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {navQl && searchResults.length === 0 && navFiltered.length === 0 && (
            <div className="settings-nav-empty" role="status">{t('settingsmodal.search.empty')}</div>
          )}
          {navFiltered.map((sec) => {
            const ql = navQl
            const groups = sec.groups
            return (
              <div key={sec.key} className="settings-nav-section">
                {sec.label && <div className="settings-nav-sectionhead">{sec.label}</div>}
                {groups.map((grp) => (
                  <div key={grp.key} className="settings-nav-group">
                    <div className="settings-nav-grouphead">{grp.label}</div>
                    {grp.items.map(([id, label]) => {
                      const children = navChildrenFor(id, ql)
                      const expandable = children.length > 0
                      // 搜索临时展开命中总项，但不篡改用户原本的折叠选择。
                      const expanded = expandable && (!!ql || expandedTabs.has(id))
                      const childrenId = `settings-nav-subitems-${id.replace(':', '-')}`
                      return (
                        <div className="settings-nav-parent" key={id}>
                          <button
                            type="button"
                            className={navOwns(id) ? (expandable ? 'has-active' : 'active') : ''}
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
                              {children.map((c) => (
                                <button
                                  type="button"
                                  className={`settings-nav-subitem${c.active ? ' active' : ''}${c.off ? ' settings-nav-subitem--off' : ''}${c.more ? ' settings-nav-subitem--more' : ''}`}
                                  aria-current={c.active ? 'page' : undefined}
                                  data-settings-nav-child={c.key}
                                  key={c.key}
                                  onClick={c.open}
                                >
                                  <span className="settings-nav-subitem-mark" aria-hidden="true" />
                                  <span>{c.label}</span>
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
            <div className="settings-main-title">{tab === 'forsion' ? cloudPageLabel || activeTabLabel : tab === 'model' || (tab === 'skills' && (activeSub === 'k-library' || activeSub === 'k-discovery')) ? activeSubLabel || activeTabLabel : activeTabLabel}</div>
            {tab === 'forsion' ? <p>{cloudDescription ? t(cloudDescription) : t('settings.tab.forsionCloud')}</p> : tab === 'model' ? <p>{t(modelSubDescriptions[activeSub] || 'settings.page.modelDescription')}</p> : tab === 'skills' && activeSub === 'k-discovery' ? <p>{t('settings.discovery.pageDescription')}</p> : activeTabDescription && <p>{activeTabDescription}</p>}
          </div>
        </div>
        {/* 设置住在独立浮窗(桌面)/ 覆盖层(web)里,全局通知两处都看不见 —— 插件装卸、重扫、Space 卸载等结果画在这条上。 */}
        <PanelNotice />
        <ConfigRecoveryNotice />
        <div className="settings-body">
          {cloudTabs.length > 0 && <div className="settings-cloud-tabs" role="tablist" aria-label={cloudPageLabel}>
            {cloudTabs.map((view, index) => {
              const key = cloudViewKey(view)
              return <button type="button" key={key} id={`settings-cloud-tab-${key}`} role="tab" aria-selected={activeSub === key}
                aria-controls="settings-cloud-panel" tabIndex={activeSub === key ? 0 : -1}
                onClick={() => pickSub(key)} onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                  e.preventDefault()
                  const next = e.key === 'Home' ? 0 : e.key === 'End' ? cloudTabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + cloudTabs.length) % cloudTabs.length
                  const target = cloudViewKey(cloudTabs[next])
                  pickSub(target)
                  document.getElementById(`settings-cloud-tab-${target}`)?.focus()
                }}>{cloudTabTitle(view)}</button>
            })}
          </div>}
          {/* key 变 → 重挂 → CSS 入场动画重跑(方向由 data-dir 给);正文块自己按 activeSub 取舍。 */}
          {/* 每个子页一个崩溃兜底:一页渲染抛错只占正文区,左侧导航照常能切走(原先只有整窗那一层,一页崩了整个设置窗就废了)。 */}
          <ErrorBoundary key={`${tab}:${activeSub}`}>
          <div key={`${tab}:${activeSub}`} className={`settings-sub settings-sub--${tab}`} id={cloudTabs.length ? 'settings-cloud-panel' : undefined} role={cloudTabs.length ? 'tabpanel' : undefined} aria-labelledby={cloudTabs.length ? `settings-cloud-tab-${activeSub}` : undefined} data-dir={subDir} data-settings-sub={activeSub || undefined}>
                {tab === 'trash' && <TrashSettings />}
                {tab === 'permissions' && (hasDesktopPermissions()
                  ? <DesktopPermissions mode={p.themeMode} />
                  : (() => { const Panel = phoneGuide()?.PermissionsPanel; return Panel ? <Panel /> : null })())}
                {tab === 'computer-history' && <ComputerHistorySettings mode={p.themeMode} anchor="computer-history" />}
                {tab === 'units' && <UnitSettings />}
                {tab === 'remote-sessions' && <RemoteSessionsSettings />}
                {/* 小节标题不在正文重复；当前子页面由左侧/移动首页的折叠子项标明。 */}
                {/* 基本(U-14):用户常改的两项放第一屏;后端技术项挪到「连接」。 */}
                {tab === 'general' && activeSub === 'g-basic' && isDesktop && stored && (
                  <>
                    <section className="settings-panel settings-workspace-panel" data-setting-anchor="workspace-dir">
                      <div className="settings-panel-head">
                        <span className="settings-panel-icon"><FolderOpen size={16} /></span>
                        <div><strong>{t('settings.workspace.label')}</strong><p>{t('settings.workspace.summary')}</p></div>
                      </div>
                      <div className="settings-inline-row">
                        {/* 不重启后端的文本项:失焦 / 回车提交,不再单放「保存」(U-05)。 */}
                        <input
                          type="text"
                          value={stored.defaultWorkspaceDir || ''}
                          onChange={(e) => {
                            edit({ defaultWorkspaceDir: e.target.value })
                            // 选目录失败的提示绑着旧目录:改了路径就收回(失焦提交失败的那种不收,它的重试读最新草稿)。
                            if (commitErrors.defaultWorkspaceDir?.picked) setCommitErrors((prev) => withoutKeys(prev, ['defaultWorkspaceDir']))
                          }}
                          onBlur={() => void commitEdits(['defaultWorkspaceDir'], (v) => ({ defaultWorkspaceDir: (v.defaultWorkspaceDir || '').trim() }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                          placeholder={t('settings.workspace.placeholder')}
                          aria-label={t('settings.workspace.label')}
                        />
                        <button
                          className="btn ghost sm"
                          onClick={() => void window.tangu?.pickDirectory?.().then((d) => { if (d) savePickedWorkspace(d) })}
                        >
                          {t('settings.workspace.pick')}
                        </button>
                      </div>
                      <div className="hint">
                        {t('settings.workspace.hint')}
                      </div>
                      {commitErrorHint('defaultWorkspaceDir')}
                    </section>
                    <div data-setting-anchor="keep-awake">
                      <SettingsPanel
                        icon={<Coffee size={16} />}
                        title={t('settingsmodal.keepAwake.title')}
                        description={t('settingsmodal.keepAwake.description')}
                        actions={<SettingsSwitch checked={!!stored.keepAwakeWhileRunning} onChange={(on) => void window.tangu!.setConfig({ keepAwakeWhileRunning: on }).then(setStored)} label={t('settingsmodal.keepAwake.title')} />}
                      />
                    </div>
                    <SettingsPanel
                      anchor="close-action"
                      icon={<LogOut size={16} />}
                      title={t('settingsmodal.closeAction.title')}
                      description={t('settingsmodal.closeAction.description')}
                      actions={
                        <select
                          aria-label={t('settingsmodal.closeAction.title')}
                          value={stored.closeAction || 'ask'}
                          onChange={(e) => void window.tangu!.setConfig({ closeAction: e.target.value as 'ask' | 'tray' | 'quit' }).then(setStored)}
                        >
                          <option value="ask">{t('settingsmodal.closeAction.ask')}</option>
                          <option value="tray">{t('settingsmodal.closeAction.tray')}</option>
                          <option value="quit">{t('settingsmodal.closeAction.quit')}</option>
                        </select>
                      }
                    />
                  </>
                )}
                {tab === 'general' && activeSub === 'g-conn' && (
                  <>
                    {/* 状态条(U-14):原「当前状态」大卡 + 三行 压成一行;「运行模式」不再单列(下面那张卡就是它)。 */}
                    <section className={`settings-status-strip${stripHealth === 'ok' ? ' is-ready' : ''}`} aria-label={t('settings.overview.label')} data-status-source={externalConn ? 'external' : 'managed'}>
                      <i className={`settings-status-dot${stripHealth === 'ok' ? ' ok' : stripHealth === 'err' ? ' err' : ''}`} aria-hidden="true" />
                      <strong>{stripHealth === 'ok' ? t('settings.overview.readyTitle') : t('settings.overview.attentionTitle')}</strong>
                      <span className="settings-status-strip-meta">
                        {externalConn
                          ? <span>{t('settingsmodal.status.external', { state: t(connState === 'ok' ? 'settingsmodal.status.connOk' : connState === 'err' ? 'settingsmodal.status.connErr' : 'settingsmodal.status.connPending') })}</span>
                          : <span>{t('settingsmodal.status.backend', { state: backendSt ? t(BACKEND_STATE_LABEL[backendSt.state] || 'settings.backend.state.stopped') : t('common.loading') })}</span>}
                        {cloudAccount && <span>{t('settingsmodal.status.account', { state: authSt?.loggedIn && authSt.tokenValid !== false ? t('settings.overview.signedIn') : t('settings.overview.signedOut') })}</span>}
                      </span>
                      {isDesktop && cloudAccount && !(authSt?.loggedIn && authSt.tokenValid !== false) && (
                        <button type="button" className="btn ghost sm" onClick={() => openSubPage('forsion', ACCOUNT_SUB)}>
                          <LogIn size={12} /> {t('settings.forsion.login')}
                        </button>
                      )}
                    </section>
                    {isDesktop && (
                      <section className="settings-panel settings-mode-panel" data-setting-anchor="backend-mode">
                        <div className="settings-panel-head settings-panel-head--actions">
                          <span className="settings-panel-icon"><Server size={16} /></span>
                          <div>
                            <strong>{t('settings.backend.modeLabel')}</strong>
                            <p>{t('settingsmodal.backend.current', { mode: mode === 'managed' ? t('settings.backend.modeManaged') : t('settings.backend.modeExternal') })}</p>
                          </div>
                          {/* 卡片默认收起(U-14):后端是低频技术项;展开后点卡片也只改草稿(U-01)。 */}
                          <div className="settings-panel-actions settings-panel-actions--wide">
                            <button
                              type="button"
                              className="btn ghost sm"
                              data-action="mode-change"
                              aria-expanded={modeExpanded || modePending}
                              onClick={() => { if (modeExpanded && modePending) setModeDraft(null); setModeExpanded((v) => !v) }}
                            >
                              {t('settingsmodal.backend.change')}
                            </button>
                          </div>
                        </div>
                        {(modeExpanded || modePending) && (
                          <>
                            <p className="settings-mode-desc" data-motion="enter">{t('settings.backend.modeDescription')}</p>
                            <div className="settings-choice-grid" data-motion="enter" role="radiogroup" aria-label={t('settings.backend.modeLabel')} onKeyDown={onRadioGroupKeyDown}>
                              <button type="button" role="radio" aria-checked={viewMode === 'managed'} tabIndex={radioTabIndex(viewMode === 'managed', 0, true)} className={`settings-choice-card${viewMode === 'managed' ? ' active' : ''}`} disabled={runtimeSaving} onClick={() => pickModeDraft('managed')}>
                                <span className="settings-choice-icon"><Settings2 size={17} /></span>
                                <span><strong>{t('settings.backend.modeManaged')}</strong><small>{t('settings.backend.modeManagedDescription')}</small></span>
                                {viewMode === 'managed' && <Check size={15} className="settings-choice-check" />}
                              </button>
                              <button type="button" role="radio" aria-checked={viewMode === 'external'} tabIndex={radioTabIndex(viewMode === 'external', 1, true)} className={`settings-choice-card${viewMode === 'external' ? ' active' : ''}`} disabled={runtimeSaving} onClick={() => pickModeDraft('external')}>
                                <span className="settings-choice-icon"><Globe2 size={17} /></span>
                                <span><strong>{t('settings.backend.modeExternal')}</strong><small>{t('settings.backend.modeExternalDescription')}</small></span>
                                {viewMode === 'external' && <Check size={15} className="settings-choice-check" />}
                              </button>
                            </div>
                            {modePending && (
                              <div className="settings-mode-pending" role="status">
                                {t('settingsmodal.backend.pending', { action: viewMode === 'managed' ? t('settingsmodal.backend.modeApplyManaged') : t('settingsmodal.backend.modeApplyExternal') })}
                              </div>
                            )}
                          </>
                        )}
                      </section>
                    )}

                    {/* 托管参数在「本机运行环境」子页(origin 拆出);在这里把运行方式草稿切到托管时,就地给显式切换(U-01)。 */}
                    {isDesktop && modePending && viewMode === 'managed' && stored && (
                      <SettingsSaveBar
                        saveLabel={t('settingsmodal.backend.modeApplyManaged')}
                        message={t('settingsmodal.backend.runtimeDirty')}
                        busy={runtimeSaving}
                        onSave={saveManaged}
                        onDiscard={() => setModeDraft(null)}
                      />
                    )}

                    {(!isDesktop || viewMode === 'external') && !cloudWeb && (
                      <section className="settings-panel settings-external-panel" data-setting-anchor="external-backend">
                        <div className="settings-panel-head">
                          <span className="settings-panel-icon"><Plug size={16} /></span>
                          <div><strong>{t('settings.external.title')}</strong><p>{t('settings.external.description')}</p></div>
                        </div>
                        {connCfgPending && (
                          <div className="hint" role={cfgLoadError ? 'alert' : 'status'} data-conn-cfg-pending>
                            {cfgLoadError ? t('settingsmodal.external.cfgFailed', { error: cfgLoadError }) : t('settingsmodal.external.cfgLoading')}
                          </div>
                        )}
                        <div className="field">
                          <label>{t('settings.external.urlLabel')}</label>
                          <input
                            type="text"
                            value={connForm.backendUrl}
                            disabled={connCfgPending}
                            onChange={(e) => editConnForm({ backendUrl: e.target.value })}
                            placeholder="http://localhost:8787"
                          />
                          <div className="hint">{t('settings.external.urlHint')}</div>
                        </div>
                        <div className="field">
                          <label>{t('settings.external.tokenLabel')}</label>
                          <input
                            type="password"
                            value={connForm.token}
                            disabled={connCfgPending}
                            onChange={(e) => editConnForm({ token: e.target.value })}
                            placeholder={t('settings.external.tokenPlaceholder')}
                          />
                        </div>
                        {/* P1-K5:已落盘为外部连接时,保存的 token 读不出来(钥匙串拒绝 / 被重置)/ 系统加密不可用 → 这里说清楚并给重试 / 重启 */}
                        {isDesktop && mode === 'external' && <SecretStorageNotice slot="externalToken" className="secnotice-inpanel" />}
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button className="btn ghost sm" onClick={test} disabled={testing || connCfgPending}>
                            {testing ? <Loader2 size={13} className="spin" /> : null} {t('settings.btn.testConnection')}
                          </button>
                          <button className="btn primary sm" data-conn-save onClick={() => void saveConnection()} disabled={connCfgPending}>
                            {isDesktop && mode !== 'external' ? t('settingsmodal.backend.modeApplyExternal') : t('settings.btn.saveConnect')}
                          </button>
                          {isDesktop && modePending && (
                            <button className="btn ghost sm" onClick={() => setModeDraft(null)}>{t('settingsmodal.saveBar.discard')}</button>
                          )}
                          <span style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-muted)' }}>{testResult}</span>
                        </div>
                      </section>
                    )}
                  </>
                )}

                {tab === 'general' && activeSub === 'g-runtime' && isDesktop && stored && (
                  <>
                    {window.tangu?.envCheck && (
                      <SettingsPanel className="settings-tools-panel" icon={<MonitorCheck size={16} />} title={t('settings.tools.title')} description={t('settings.tools.description')}>
                        {/* 与首启向导「本机环境」步同一个组件;key 在保存后端设置后递增 → 按新下载源重测。 */}
                        <div className="settings-tools-body"><EnvProbeSection key={probeKey} onLeave={() => useApp.getState().closeSettings()} /></div>
                      </SettingsPanel>
                    )}
                    {mode === 'managed' ? (
                      <section className="settings-panel settings-runtime-panel">
                        <div className="settings-panel-head">
                          <span className="settings-panel-icon"><Server size={16} /></span>
                          <div><strong>{t('settings.runtime.backendTitle')}</strong><p>{t('settings.runtime.description')}</p></div>
                        </div>
                        <div className="field-row">
                          <div className="field" style={{ maxWidth: 260 }} data-setting-anchor="sandbox">
                            <label htmlFor="settings-runtime-sandbox">{t('settings.sandbox.label')}</label>
                            <select
                              id="settings-runtime-sandbox"
                              value={stored.sandbox}
                              onChange={(e) => edit({ sandbox: e.target.value as StoredDesktopConfig['sandbox'] })}
                            >
                              <option value="auto">{t('settings.sandbox.auto')}</option>
                              <option value="docker">Docker</option>
                              <option value="none">{t('settings.sandbox.none')}</option>
                            </select>
                          </div>
                        </div>
                        <HostSandboxSettings value={hostSandboxDraft ?? stored.hostSandbox} onChange={setHostSandboxDraft} />
                        <div className="field-row">
                          <div className="field" style={{ maxWidth: 200 }} data-setting-anchor="python">
                            <label htmlFor="settings-runtime-python">{t('settings.python.label')}</label>
                            <select
                              id="settings-runtime-python"
                              value={stored.pythonMode || 'bundled'}
                              onChange={(e) => edit({ pythonMode: e.target.value as StoredDesktopConfig['pythonMode'] })}
                            >
                              <option value="bundled">{t('settings.python.bundled')}</option>
                              <option value="system">{t('settings.python.system')}</option>
                            </select>
                          </div>
                          <div className="field" data-setting-anchor="mirror">
                            <label>{t('settings.mirror.label')}</label>
                            <div className="switch-row" style={{ minHeight: 30 }}>
                              <SettingsSwitch checked={(stored.mirror || 'default') === 'china'} label={t('settings.mirror.toggle')} onChange={(on) => edit({ mirror: on ? 'china' : 'default' })} />
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
                            <span key={tg.name} style={{ fontSize: 'var(--ui-font-meta, 12px)', color: tg.ok ? 'var(--text-muted)' : 'var(--danger, #e5484d)' }}>
                              {tg.ok ? '✓' : '✗'} {tg.name} · {tg.ok ? `${tg.latencyMs}ms` : (tg.error || t('settings.mirror.unreachable'))}
                            </span>
                          ))}
                        </div>
                        {mode === 'managed' && (<>
                        <div className="settings-runtime-actions">
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
                        <div className="field settings-runtime-logs">
                          <button
                            className="btn ghost sm"
                            onClick={() => void window.tangu!.backendLogs!().then(setLogs)}
                          >
                            {t('settings.backend.viewLogs')}
                          </button>
                          {logs && (
                            <pre style={{
                              marginTop: 8, fontSize: 'var(--ui-font-caption, 11px)', fontFamily: 'var(--font-mono)', maxHeight: 220,
                              overflowY: 'auto', background: 'var(--bg-card)', padding: 8,
                              border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                            }}>
                              {logs.length ? logs.join('\n') : t('settings.backend.noLogs')}
                            </pre>
                          )}
                        </div>
                        </>)}
                        {/* 需重启的运行组统一走吸底栏(U-05 二期 + U-01):有草稿才出现;草稿是「切到托管」时主按钮换成显式切换。 */}
                        {runtimeParamsDirty && (
                          <SettingsSaveBar
                            saveLabel={t('settings.backend.saveRestart')}
                            message={t('settingsmodal.backend.runtimeDirty')}
                            busy={runtimeSaving}
                            onSave={saveManaged}
                            onDiscard={discardRuntime}
                          />
                        )}
                      </section>
                    ) : (
                      <SettingsPanel icon={<Server size={16} />} title={t('settings.runtime.backendTitle')} description={t('settings.runtime.externalNote')} />
                    )}
                  </>
                )}

                {tab === 'general' && activeSub === 'g-git' && isDesktop && stored && <><GitAccountsSection /><GitSettingsSection /></>}
                {/* 收件箱(Inbox Space):系统通知开关。非 managedKeys,保存即生效不重启后端。 */}
                {tab === 'general' && isDesktop && stored && activeSub === 'g-inbox' && (
                  <>
                    <section className="settings-panel">
                      <div className="settings-control-list">
                        <SettingsRow anchor="inbox-notify" fit="inline" label={t('settings.inbox.notifyLabel')} description={t('settings.inbox.notifyHint')}
                          control={<SettingsSwitch checked={stored.inboxNotifyEnabled !== false} label={t('settings.inbox.notifyLabel')} onChange={(on) => void window.tangu!.setConfig({ inboxNotifyEnabled: on }).then(setStored)} />} />
                      </div>
                      {/* 所有通知的总开关在另一页(走查续五 W-76);路径跟着左栏分组名走 */}
                      <div className="hint">{t('settings.inbox.notifyXref').split('{path}').map((part, i) => i === 0 ? part : (
                        <span key={i}><button type="button" className="settings-xref-link" onClick={() => goTab('notifications')}>{t('settings.group.appearance')} › {t('settings.tab.notifications')}</button>{part}</span>
                      ))}</div>
                    </section>
                  </>
                )}

                {tab === 'notes' && stored && (
                  <>
                    <SettingsPanel icon={<FolderOpen size={16} />} title={t('settings.notes.storageTitle')} description={t('settings.notes.storageDescription')}>
                      <div className="settings-control-list">
                        <SettingsRow
                          anchor="notes-attachments"
                          label={t('settings.notes.modeLabel')}
                          description={t('settings.notes.modeHint')}
                        >
                          {/* 和下面「日记文件夹」输入框同一列宽(走查续五 5.7),220px 放不下整句 */}
                          <div className="settings-inline-row settings-row-wide-control">
                            <select value={stored.notesAttachmentMode || 'attachments'} onChange={(e) => void window.tangu!.setConfig({ notesAttachmentMode: e.target.value as StoredDesktopConfig['notesAttachmentMode'] }).then(setStored)} aria-label={t('settings.notes.modeLabel')}>
                              <option value="attachments">{t('settings.notes.modeAttachments')}</option>
                              <option value="same">{t('settings.notes.modeSame')}</option>
                              <option value="vault">{t('settings.notes.modeVault')}</option>
                            </select>
                          </div>
                        </SettingsRow>
                        {(stored.notesAttachmentMode || 'attachments') === 'vault' && (
                          <SettingsRow label={t('settings.notes.folderLabel')} description={t('settings.notes.folderHint')}>
                            <div className="settings-inline-row settings-row-wide-control">
                              <input
                                type="text"
                                value={stored.notesAttachmentFolder ?? 'assets'}
                                onChange={(e) => edit({ notesAttachmentFolder: e.target.value })}
                                onBlur={() => void commitEdits(['notesAttachmentFolder'], (v) => ({ notesAttachmentFolder: (v.notesAttachmentFolder || 'assets').trim().replace(/^\/+|\/+$/g, '') }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                                placeholder="assets"
                                aria-label={t('settings.notes.folderLabel')}
                              />
                            </div>
                            {commitErrorHint('notesAttachmentFolder')}
                          </SettingsRow>
                        )}
                        <SettingsRow anchor="daily-notes" label={t('settings.notes.dailyLabel')} description={t('settings.notes.dailyHint')}>
                          <div className="settings-inline-row settings-row-wide-control">
                            <input
                              type="text"
                              value={stored.notesDailyFolder ?? ''}
                              onChange={(e) => edit({ notesDailyFolder: e.target.value })}
                              onBlur={() => void commitEdits(['notesDailyFolder'], (v) => ({ notesDailyFolder: (v.notesDailyFolder || '').trim().replace(/^\/+|\/+$/g, '') }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                              placeholder={t('settings.notes.dailyPlaceholder')}
                              aria-label={t('settings.notes.dailyLabel')}
                            />
                          </div>
                          {commitErrorHint('notesDailyFolder')}
                        </SettingsRow>
                      </div>
                    </SettingsPanel>

                    <SettingsPanel icon={<NotebookPen size={16} />} title={t('settings.notes.behaviorTitle')} description={t('settings.notes.behaviorDescription')}>
                      <div className="settings-control-list">
                        <SettingsRow label={t('settings.notes.previewLabel')} description={t('settings.notes.previewHint')} control={<SettingsSwitch checked={stored.notesImportPreview !== false} onChange={(on) => void window.tangu!.setConfig({ notesImportPreview: on }).then(setStored)} label={t('settings.notes.previewLabel')} />} />
                        <SettingsRow label={t('settings.notes.upgradeV4Label')} description={t('settings.notes.upgradeV4Hint')} control={<SettingsSwitch checked={stored.notesUpgradeV4 !== false} onChange={(on) => { setUpgradeV4Enabled(on); void window.tangu!.setConfig({ notesUpgradeV4: on }).then(setStored) }} label={t('settings.notes.upgradeV4Label')} />} />
                        <SettingsRow label={t('settings.notes.wikiFilesLabel')} description={t('settings.notes.wikiFilesHint')} control={<SettingsSwitch checked={stored.notesWikiIncludeFiles !== false} onChange={(on) => { setWikiFilesEnabled(on); void window.tangu!.setConfig({ notesWikiIncludeFiles: on }).then(setStored) }} label={t('settings.notes.wikiFilesLabel')} />} />
                        <SettingsRow label={t('settings.notes.aiSpaceLabel')} description={t('settings.notes.aiSpaceHint')} control={<SettingsSwitch checked={aiSpaceTrigger} onChange={(on) => { setAiSpaceTrigger(on); setAiSpaceTriggerEnabled(on) }} label={t('settings.notes.aiSpaceLabel')} />} />
                        <SettingsRow label={t('settings.notes.spellcheckLabel')} description={t('settings.notes.spellcheckHint')} control={<SettingsSwitch checked={notesSpellcheck} onChange={setNotesSpellcheckEnabled} label={t('settings.notes.spellcheckLabel')} />} />
                        <SettingsRow label={t('settings.notes.autoPairBracketsLabel')} description={t('settings.notes.autoPairBracketsHint')} control={<SettingsSwitch checked={bracketAutoPair} onChange={setBracketAutoPairEnabled} label={t('settings.notes.autoPairBracketsLabel')} />} />
                        <SettingsRow label={t('settings.notes.autoPairMarkdownLabel')} description={t('settings.notes.autoPairMarkdownHint')} control={<SettingsSwitch checked={markdownAutoPair} onChange={setMarkdownAutoPairEnabled} label={t('settings.notes.autoPairMarkdownLabel')} />} />
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
                            <select value={deleteAssetsPref() === null ? 'ask' : deleteAssetsPref() ? 'yes' : 'no'} onChange={(e) => { setDeleteAssetsPref(e.target.value === 'ask' ? null : e.target.value === 'yes'); setStored((s) => (s ? { ...s } : s)) }}>
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

                {/* Forsion 云端 → 同步:与 Extend 画的五页同一套卡片(SettingsPanel / SettingsRow),同一分类里别一半新一半旧 */}
                {tab === 'forsion' && (activeSub === 'f-sync' || (groupedCloud && activeSub === 'f-conn')) && (
                  <>
                    {window.amadeusSync && noteSync && (
                      <SettingsPanel icon={<NotebookPen size={16} />} title={t('settings.notes.cloudSyncLabel')} description={t('settings.notes.cloudSyncHint')}>
                        <div className="settings-control-list">
                          <SettingsRow
                            label={t('settings.forsionCloud.noteSyncOn')}
                            control={(
                              <SettingsSwitch
                                checked={noteSync.enabled}
                                disabled={noteSyncBusy}
                                label={t('settings.forsionCloud.noteSyncOn')}
                                onChange={(on) => {
                                  setNoteSyncBusy(true)
                                  void window.amadeusSync!.setEnabled(on).then(setNoteSync).finally(() => setNoteSyncBusy(false))
                                }}
                              />
                            )}
                          />
                          {noteSync.enabled && (
                            <SettingsRow
                              label={t(`settings.notes.cloudSyncState.${noteSync.state}`)}
                              description={`${noteSync.pending > 0 ? `${t('settings.notes.cloudSyncPending', { n: String(noteSync.pending) })} · ` : ''}${t('settings.forsion.lastSynced', {
                                time: noteSync.lastSyncAt ? formatDateTime(noteSync.lastSyncAt) : t('settings.forsion.never'),
                              })}`}
                              control={(
                                <div className="settings-inline-row">
                                  {/* 未登录:给登录入口(带到账号页)、禁掉「立即同步」,下面的红字错误行也不再重复同一句话(W-02) */}
                                  {noteSync.state === 'auth-required' && (
                                    <button className="btn primary sm" onClick={() => openSubPage('forsion', ACCOUNT_SUB)}>
                                      <LogIn size={12} /> {t('settings.forsion.login')}
                                    </button>
                                  )}
                                  <button
                                    className="btn sm"
                                    disabled={noteSyncBusy || noteSync.state === 'syncing' || noteSync.state === 'auth-required'}
                                    onClick={() => {
                                      setNoteSyncBusy(true)
                                      void window.amadeusSync!.syncNow().then(setNoteSync).finally(() => setNoteSyncBusy(false))
                                    }}
                                  >
                                    {noteSync.state === 'syncing' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}{' '}
                                    {noteSync.state === 'syncing' ? t('settings.notes.cloudSyncSyncing') : t('settings.notes.cloudSyncNow')}
                                  </button>
                                </div>
                              )}
                            />
                          )}
                          {/* 行是不换行的 flex:错误 / 待确认删除 / 跳过的文件另起一块放在行下面,别挤到按钮右边 */}
                          {noteSync.enabled && ((noteSync.error && noteSync.state !== 'auth-required') || (noteSync.pendingDeletions ?? 0) > 0 || noteSkipped(noteSync).length > 0) && (
                            <div className="settings-row-notes">
                              {noteSync.error && noteSync.state !== 'auth-required' && <div className="hint" style={{ color: 'var(--danger, #c00)' }}>{ipcErrorText(noteSync.error)}</div>}
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
                              {noteSkipped(noteSync).length > 0 && (
                                <div className="hint">
                                  {t('settings.notes.cloudSyncSkipped', { n: String(noteSkipped(noteSync).length) })}:{' '}
                                  {noteSkipped(noteSync).slice(0, 3).map((s) => s.path).join(', ')}
                                  {noteSkipped(noteSync).length > 3 ? '…' : ''}
                                </div>
                              )}
                            </div>
                          )}
                          {noteSync.enabled && <HeldSyncAll mirror={noteSync} />}
                        </div>
                      </SettingsPanel>
                    )}

                    {/* Brain 记忆同步 */}
                    {stored && (
                      <SettingsPanel anchor="memory-sync" icon={<Brain size={16} />} title={t('settings.forsion.syncLabel')} description={t('settings.forsion.syncHint')}>
                        <div className="settings-control-list">
                          <SettingsRow
                            label={t('settings.forsion.syncManaged')}
                            description={t('settings.forsion.syncManagedHint')}
                            control={penzorSyncReady() ? (
                              <button className="btn sm" onClick={openPenzorSync}>{t('settings.forsion.openPenzorSync')}</button>
                            ) : undefined}
                          />
                          <SettingsRow
                            label={t('settings.forsion.lastSynced', {
                              time: stored.forsionLastSyncedAt
                                ? formatDateTime(stored.forsionLastSyncedAt)
                                : (syncSt?.lastAt ? formatDateTime(syncSt.lastAt) : t('settings.forsion.never')),
                            })}
                            control={(
                              /* 没登录点了必失败;整页主按钮只留「登录 Forsion」一个(W-02) */
                              <button className="btn sm" onClick={() => void doSyncNow()} disabled={syncing || !(authSt?.loggedIn && authSt?.tokenValid !== false)}>
                                {syncing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} {syncing ? t('settings.forsion.syncing') : t('settings.forsion.syncNow')}
                              </button>
                            )}
                          />
                          {syncMsg && <div className="settings-row-notes"><div className="hint">{syncMsg}</div></div>}
                        </div>
                      </SettingsPanel>
                    )}
                  </>
                )}

                {/* Forsion 云端 → 连接:云端地址(自建服务才用;cloudUrl 是 managedKey —— 写 = 重启后端 + 重建 unit host,保留显式保存,不做失焦提交) */}
                {tab === 'forsion' && stored && (activeSub === 'f-conn' || (groupedCloud && activeSub === 'f-sync')) && (
                  <>
                  {groupedCloud && <button type="button" className="settings-cloud-advanced-toggle" aria-expanded={activeSub === 'f-conn' || cloudAdvancedOpen} aria-controls="settings-cloud-connection"
                    onClick={() => { setCloudAdvancedOpen(!(activeSub === 'f-conn' || cloudAdvancedOpen)); if (activeSub === 'f-conn') pickSub('f-sync') }}>
                    <ChevronRight size={14} aria-hidden="true" />{t('settingsmodal.cloudAdvancedConnection')}
                  </button>}
                  {(!groupedCloud || activeSub === 'f-conn' || cloudAdvancedOpen) && <div id="settings-cloud-connection" data-motion={cloudAdvancedOpen ? 'enter' : undefined}><SettingsPanel anchor="cloud-url" icon={<Globe2 size={16} />} title={t('settings.forsion.cloudUrlLabel')} description={t(cloudUrlLocked ? 'settingsmodal.cloudUrl.lockedHint' : 'settings.forsion.cloudUrlHint')}>
                    <div className="settings-control-list">
                      <SettingsRow label={t('settings.forsionCloud.address')}>
                        <div className="settings-inline-row settings-row-wide-control">
                          <input
                            type="text"
                            value={cloudUrlLocked ? savedCfg?.cloudUrl ?? '' : stored.cloudUrl}
                            readOnly={cloudUrlLocked}
                            onChange={(e) => edit({ cloudUrl: e.target.value })}
                            placeholder="https://api.forsion.net"
                            aria-label={t('settings.forsion.cloudUrlLabel')}
                          />
                          {!cloudUrlLocked && (
                          <button
                            className="btn primary sm"
                            onClick={() => void commitEdits(['cloudUrl'], (v) => ({ cloudUrl: (v.cloudUrl || '').trim() }))}
                          >
                            {t('settings.forsion.save')}
                          </button>
                          )}
                        </div>
                        {commitErrorHint('cloudUrl')}
                      </SettingsRow>
                    </div>
                  </SettingsPanel></div>}
                  </>
                )}

                {tab === 'forsion' && activeSub.startsWith('fx:') && cloudViews.filter((o) => cloudViewKey(o) === activeSub).map((o) => (
                  <PluginSettingsView key={activeSub} pluginId={o.pluginId} def={o.item} bare anchor={activeSub === initialTarget.sub ? initialTarget.anchor : undefined} />
                ))}

                {/* 完整模式画新的同步页;compat / 老 Extend / Extend 停用时照旧画今天的 RemoteSyncSection(门控在 SyncSettings) */}
                {tab === 'sync' && activeSub === 's-remote' && <SyncSettings focus={syncFocus} legacy={<RemoteSyncSection />} drive={<RemoteSyncSection embedded />} />}

                {tab === 'model' && activeSub === 'm-models' && (
                  <DefaultModelsPage
                    models={models} loading={modelsLoading} onRefresh={() => void loadModels()}
                    chatModelId={draft.modelId || ''} imageModelId={draft.imageModelId || ''}
                    onChat={(modelId) => { setDraft((d) => ({ ...d, modelId })); p.onConfigChange({ modelId }) }}
                    onImage={(imageModelId) => { setDraft((d) => ({ ...d, imageModelId })); p.onConfigChange({ imageModelId }) }}
                    stored={isDesktop ? stored : null} onStored={setStored} providers={customProviders}
                    subscriptionIds={(providers || []).map((pr) => pr.id)}
                    realtimeSignedIn={realtimeSignedIn}
                    onOpen={(target, kind) => { if (kind) setLibKind(kind); setSub(target) }}
                  >
                    {/* Intelligent UI 的档位是模型怎么作答的事,不是外观:和默认模型放一页(2026-10-14 用户定)。 */}
                    <SettingsPanel icon={<Shapes size={14} />} title={t('modelsettings.answerForm')}>
                      <SettingsRow anchor="visuals" label={t('settings.theme.visuals')} description={t(`settings.theme.visuals.${visualsPref}`)} control={
                        <select
                          aria-label={t('settings.theme.visuals')}
                          value={visualsPref}
                          onChange={(e) => { const v = e.target.value as VisualsPref; setVisualsPrefState(v); setVisualsPref(v) }}
                        >
                          {VISUALS_VALUES.map((v) => <option key={v} value={v}>{t(`settings.theme.visualsOpt.${v}`)}</option>)}
                        </select>
                      } />
                    </SettingsPanel>
                    {models?.forsion && models.forsion.status !== 'ok' && (
                      <div className="hint" role="status" style={{ color: models.forsion.status === 'error' ? 'var(--danger)' : undefined }}>
                        {models.forsion.status === 'error' ? t('settings.model.cloudFetchError') : ''}{models.forsion.detail}
                      </div>
                    )}
                    {!modelsLoading && !models?.models.length && <div className="hint">{t('modelsettings.noModels')}</div>}
                  </DefaultModelsPage>
                )}

                {/* 模型与服务(11-26 方案 C2,docs/ToBeImproved/自定义模型添加与管理方案_2026-11-26/r2.html):原「模型库」+「提供方」+「联网搜索」三页并成一页。
                    类型标签与后台同名同序(10-17),桌面末尾多一个「联网搜索」;页顶来源胶囊管连接,⋯ 管单个模型,「添加模型」弹窗挑模型。
                    自动压缩阈值挨着每个模型的窗口输入框(同一套「窗口」心智),写的是本机引擎的 config.json,与 onContextWindow 同门。 */}
                {tab === 'model' && activeSub === 'm-display' && (() => {
                  const cloudCount = (models?.models || []).filter((m) => m.source === 'forsion').length
                  const subscriptionIds = (providers || []).map((pr) => pr.id)
                  const providersChanged = (list: DirectProviderConfig[]) => { setCustomProviders(list); void loadModels() }
                  // 改的是盘上最新那份、排队写(mutateProvider):连点两下不会互相盖掉
                  const saveCp = (id: string, fn: (cur: DirectProviderConfig) => DirectProviderConfig) => {
                    setLibMsg('')
                    void mutateProvider(id, fn).then(providersChanged).catch((e) => {
                      if (e?.message === 'stale') { refreshCustomProviders(); void loadModels(); return } // 盘上已经变了(连点两次):照盘上重画,不报错
                      setLibMsg(e?.message === 'last-llm' ? t('modelsettings.keepOne') : t('modelsettings.saveFailed', { msg: e?.message || String(e) }))
                    })
                  }
                  // 每行 ⋯:云端模型只有设默认 / 复制;自带 Key 的(桌面)还能改类型、看图、从连接里移除
                  const rowActions = (c: CatalogItem, kind: ModelKind): CapabilityMenuItem[] => {
                    const items: CapabilityMenuItem[] = []
                    if (kind === 'llm' && c.model) items.push({ id: 'default', label: t('modelsettings.setDefault'), selected: draft.modelId === c.id, onSelect: () => { setDraft((d) => ({ ...d, modelId: c.id })); p.onConfigChange({ modelId: c.id }) } })
                    items.push({ id: 'copy', label: t('modelsettings.copyId'), onSelect: () => { void navigator.clipboard?.writeText(c.id) } })
                    const cp = isDesktop && c.source === 'direct' ? customProviders.find((x) => x.providerId === c.provider) : undefined
                    const lk = listKindOf(kind)
                    if (!cp || !lk) return items
                    const bare = bareModelId(cp.providerId, c.id)
                    if (!modelsIn(cp, lk).includes(bare)) return items
                    const locked = lk === 'llm' && !canDropLlm(cp, bare)
                    const pid = cp.providerId
                    if (lk === 'llm') {
                      const textOnly = (cp.noVisionModelIds || []).includes(bare)
                      items.push({ id: 'vision', label: t('modelsettings.vision'), selected: !textOnly, onSelect: () => saveCp(pid, (cur) => setTextOnly(cur, bare, !textOnly)) })
                    }
                    for (const k of LIST_KINDS) items.push({ id: `kind:${k}`, label: t('modelsettings.kindAs', { kind: t(`msvc.kind.${k}`) }), selected: k === lk,
                      onSelect: () => { if (k !== lk) saveCp(pid, (cur) => changeModelKind(cur, bare, lk, k)) } })
                    items.push({ id: 'remove', danger: true, label: t('modelsettings.removeFrom', { name: pid }), hint: locked ? t('modelsettings.keepOne') : undefined, disabled: locked, onSelect: () => saveCp(pid, (cur) => removeModel(cur, lk, bare)) })
                    return items
                  }
                  return <>
                    <ModelPickerSettings
                      catalog={catalogByKind(models, isDesktop && stored ? realtimeCandidates(stored, customProviders, models?.realtimeModel, realtimeSignedIn).filter((c) => c.source === 'direct') : [], isDesktop ? customProviders : [])}
                      kind={libKind} onKind={setLibKind} subscriptionIds={subscriptionIds}
                      onRefresh={() => void loadModels()} loading={modelsLoading}
                      autoCompact={isDesktop ? <AutoCompactSetting cfg={p.cfg} /> : undefined}
                      defaultChatId={draft.modelId || models?.defaultModelId || undefined}
                      rowActions={rowActions}
                      providerFilter={libProvider} onProviderFilter={setLibProvider}
                      onAddModels={isDesktop ? () => setAddModels({}) : undefined}
                      sources={isDesktop ? <SourceChips target={homeTarget()} providers={customProviders} onProviders={providersChanged}
                        cloud={cloudAccount ? { signedIn: !!authSt?.loggedIn, count: cloudCount } : null} onManageCloud={() => goTab('forsion')}
                        subs={providers || []} subBusy={providerBusy} onSubLogin={(id) => void doProviderLogin(id)}
                        onAddConnection={() => setAddConnOpen(true)}
                        onShowModels={(id) => { setLibKind('llm'); setLibProvider(id) }} /> : undefined}
                      webSearch={isDesktop && wsRed ? <WebSearchSettings target={homeTarget()} cfg={wsRed} setCfg={setWsRed} /> : undefined}
                      footer={isDesktop ? <>
                        {libMsg && <div className="hint model-catalog-error" role="alert">{libMsg}</div>}
                        <LocalProviderImport foundOnly providers={customProviders} onImported={providersChanged} />
                        <MaskingSettingsSection />
                        {stored?.mode === 'external' && !(stored?.backendUrl || '').includes('localhost') && !(stored?.backendUrl || '').includes('127.0.0.1') && (
                          <div className="hint" style={{ marginTop: 10 }}>{t('settings.customProvider.externalWarning')}</div>
                        )}
                      </> : undefined}
                      onContextWindow={isDesktop ? async (modelId, tokens) => {
                        // 只在本机引擎下露出:写的是引擎进程的 config.json,云端 worker 是多用户共用的,引擎侧也 404。
                        await setModelContextWindow(homeTarget(), modelId, tokens)
                        const next = await listModels(homeTarget())
                        setModels(next)
                        // 进度环读的是 store 里启动时装的 modelsResp,且优先上一轮 run 的 context_info(只在切模型时清):
                        // 两处都刷,否则改完窗口它还显示旧数直到下一条消息。
                        useApp.setState((s) => ({ modelsResp: next, ctxInfoBySession: Object.fromEntries(Object.entries(s.ctxInfoBySession).filter(([, v]) => v.modelId !== modelId)) }))
                      } : undefined} />
                    {addConnOpen && <AddConnectionDialog target={homeTarget()} providers={customProviders} onClose={() => setAddConnOpen(false)}
                      onNext={(d) => { setAddConnOpen(false); setAddModels({ draft: d }) }} />}
                    {addModels && <AddModelsDialog target={homeTarget()} providers={customProviders} draft={addModels.draft} initialProviderId={addModels.providerId ?? libProvider}
                      onClose={() => setAddModels(null)} onSaved={providersChanged}
                      onAddConnection={() => { setAddModels(null); setAddConnOpen(true) }} />}
                  </>
                })()}

                {/* 语音页三张卡(10-25 走查续 4.5),各管输入框上的一个键(10-02 用户报「通话音色和朗读混在一起、很误导」):
                    语音通话 = 空输入框的发送键 / 本地语音识别 = 麦克风键 / 朗读 = 回复的朗读(TTS:OpenAI 兼容 /audio/speech)。 */}
                {tab === 'model' && activeSub === 'm-voice' && (
                  <VoiceSettingsPage cfg={p.cfg} stored={stored} setStored={setStored} providers={customProviders}
                    remoteExternal={stored?.mode === 'external' && !(stored?.backendUrl || '').includes('localhost') && !(stored?.backendUrl || '').includes('127.0.0.1')}
                    cloudModel={models?.realtimeModel} ttsDefault={models} cloudAccount={cloudAccount} signedIn={realtimeSignedIn}
                    edit={edit} commitEdits={commitEdits} commitErrorHint={commitErrorHint}
                    onOpen={(target) => {
                      if (target === 'providers') { openSubPage('model', 'm-display'); setAddConnOpen(true); return }
                      openSubPage('model', 'm-models')
                      setFlashAnchor({ id: target === 'tts-model' ? 'default-tts' : 'default-call', seq: Date.now() })
                    }} />
                )}

                {tab === 'connectors' && <ConnectorSettingsPage initialServer={initialConnector} onOpenMcp={() => goTab('mcp')} />}
                {tab === 'mcp' && (
                  <>
                    {showMcpImport && <McpImportDialog draft={mcpImportDraft} onDraft={setMcpImportDraft} pluginNames={(mcpStatus || []).filter(s => s.origin).map(s => s.server)} onClose={() => setShowMcpImport(false)} onSaved={r => { setMcpServers(r.mcpServers); setMcpMsg(t('mcpImport.saved', { added: r.added.length, replaced: r.replaced.length })); setShowMcpImport(false); setMcpImportDraft({ json: '', name: '' }); refreshMcp() }} />}
                    {connectorsSupported() && (() => {
                      const n = Object.values(mcpServers).filter((sc) => typeof sc.connector === 'string').length
                      return (
                        <button type="button" className="file-row conn-mcp-entry" data-connector-entry onClick={() => goTab('connectors')}>
                          <span className="file-name"><Plug size={14} /><b>{t('connectors.mcpEntry', { n })}</b><small>{t('connectors.mcpEntryHint')}</small></span>
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      )
                    })()}
                    <div className="field">
                      <div className="mcp-settings-heading"><label>{t('settings.mcp.label')}</label>
                      {!editMcp && (
                        <div className="mcp-settings-actions"><button
                          className="btn ghost sm"
                          onClick={() => setEditMcp({ name: '', isNew: true, command: '', argsText: '', url: '', transport: 'auto', envText: '' })}
                        >
                          <Plus size={13} /> {t('settings.mcp.add')}
                        </button>{window.tangu?.importMcpConfig && <button className="btn primary sm" onClick={() => setShowMcpImport(true)}>{t('mcpImport.open')}</button>}</div>
                      )}
                      </div>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        {t('settings.mcp.intro').split(/(\{path\}|\{tool\})/).map((part, i) => part === '{path}' ? <code key={i}>~/.forsion/mcp.json</code> : part === '{tool}' ? <code key={i}>{t('settings.mcp.toolPattern')}</code> : part)}
                      </div>
                      <div className="hint" style={{ marginBottom: 8 }}>{t('mcpImport.agentHint')}</div>
                      {mcpTotalSummary()}
                      {Object.keys(mcpServers).length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                          {Object.entries(mcpServers).filter(([, sc]) => !sc.connector).map(([name, sc]) => { // 连接器在上面那一块
                            const st = mcpStatus?.find((s) => s.server === name)
                            const stLabel = sc.enabled === false
                              ? t('settings.mcp.statusDisabled')
                              : st ? mcpStatusLabel(st) : t('settings.mcp.statusNotLoaded')
                            return (
                              <div key={name} className="file-row" style={{ cursor: 'default' }}>
                                <span className="file-name">
                                  <b>{name}</b>
                                  <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 'var(--ui-font-meta, 12px)' }}>
                                    {sc.command ? `${sc.command} ${(sc.args || []).join(' ')}` : publicMcpUrl(sc.url)}
                                  </span>
                                </span>
                                {sc.enabled !== false && mcpTokensLabel(st)}
                                <span className="file-size" title={st?.error || undefined}>{stLabel}</span>
                                {sc.enabled !== false && (st?.status === 'needs-login' || st?.status === 'logging-in') && (
                                  <button className="btn ghost sm" title={t('settingsmodal.mcp.loginHint')} onClick={() => loginMcp(name)}>
                                    <LogIn size={13} /> {t('settingsmodal.mcp.login')}
                                  </button>
                                )}
                                {st?.signedIn && (
                                  <button className="icon-btn" title={t('settingsmodal.mcp.logout')} onClick={() => logoutMcp(name)}>
                                    <LogOut size={13} />
                                  </button>
                                )}
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
                                    original: sc,
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
                      {(() => {
                        // 插件自带的 server:不在 mcp.json 里(编辑 / 删除会改写用户文件),只读列出,开关在插件设置里
                        const fromPlugins = (mcpStatus || []).filter((s) => s.origin && !(s.server in mcpServers))
                        if (!fromPlugins.length) return null
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                            {fromPlugins.map((st) => (
                              <div key={`${st.origin!.pluginId}:${st.server}`} className="file-row" style={{ cursor: 'default' }} title={t('settingsmodal.mcp.fromPluginHint')}>
                                <span className="file-name">
                                  <b>{st.server}</b>
                                  <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 'var(--ui-font-meta, 12px)' }}>
                                    {t('settingsmodal.mcp.fromPlugin', { name: st.origin!.pluginName })}
                                  </span>
                                </span>
                                {mcpTokensLabel(st)}
                                <span className="file-size" title={st.error || undefined}>{mcpStatusLabel(st)}</span>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
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
                            onClick={async () => {
                              // 设备 MCP 保留命名空间(dev / dev_*):新名字当场拦下,盘上存量的放行(同主进程口径)
                              if (newReservedMcpNames({ [editMcp.name]: true }, mcpServers).length) {
                                setMcpMsg(t('ipcerr.mcpNameReserved', { detail: editMcp.name }))
                                return
                              }
                              const env: Record<string, string> = {}
                              for (const line of editMcp.envText.split('\n')) {
                                const i = line.indexOf('=')
                                if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
                              }
                              const entry: McpServerConfigEntry = {
                                ...editMcp.original,
                                ...(editMcp.command ? { command: editMcp.command.trim(), args: editMcp.original && editMcp.argsText === (editMcp.original.args || []).join(' ') ? (editMcp.original.args || []) : editMcp.argsText.split(/\s+/).filter(Boolean) } : {}),
                                ...(editMcp.url ? { url: editMcp.url } : {}),
                                ...(editMcp.transport !== 'auto' ? { transport: editMcp.transport } : {}),
                                ...(Object.keys(env).length ? { env: editMcp.original && editMcp.envText === Object.entries(editMcp.original.env || {}).map(([k, v]) => `${k}=${v}`).join('\n') ? editMcp.original.env : env } : {}),
                                enabled: mcpServers[editMcp.name]?.enabled !== false,
                              }
                              if (!editMcp.command) { delete entry.command; delete entry.args }
                              if (!editMcp.url) delete entry.url
                              if (editMcp.transport === 'auto') delete entry.transport
                              if (!Object.keys(env).length) delete entry.env
                              const base = editMcp.original ? { ...mcpServers, [editMcp.name]: editMcp.original } : { ...mcpServers }
                              if (editMcp.isNew) delete base[editMcp.name]
                              if (await writeMcp({ ...mcpServers, [editMcp.name]: entry }, t('settings.mcp.savedReconnecting'), base)) setEditMcp(null)
                            }}
                          >
                            {t('settings.btn.save')}
                          </button>
                          <button className="btn ghost sm" onClick={() => setEditMcp(null)}>{t('settings.btn.cancel')}</button>
                          <span style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-muted)' }}>{mcpMsg}</span>
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* 普通 Agent 的主档案在 Agent Space；设置保留跨 Agent 的用户画像与入口。 */}
                {tab === 'agents' && activeSub === 'ag-roster' && <AgentSettingsOverview cfg={p.cfg} onOpenAgent={(slug) => {
                  if (window.tangu?.requestMainAction) window.tangu.requestMainAction('open-agent', slug)
                  else openAgentProfile(slug)
                  p.onClose()
                }} />}
                {/* 中断任务续跑(方案 B):本机托管引擎的行为,跨 Agent 生效 —— 放在名册页「适用于所有 Agent 的设置」里。缺省开。 */}
                {tab === 'agents' && activeSub === 'ag-roster' && isDesktop && stored && (
                  <div data-setting-anchor="auto-resume">
                    <SettingsPanel
                      icon={<StepForward size={16} />}
                      title={t('settingsmodal.autoResume.title')}
                      description={t('settingsmodal.autoResume.description')}
                      actions={<SettingsSwitch checked={(stored as StoredWithAutoResume).autoResumeInterrupted !== false} onChange={(on) => void window.tangu!.setConfig({ autoResumeInterrupted: on } as Partial<StoredWithAutoResume>).then(setStored)} label={t('settingsmodal.autoResume.title')} />}
                    />
                  </div>
                )}
                {tab === 'agents' && activeSub === 'ag-special' && <SpecialAgentsTab cfg={p.cfg} localHost={!!(isDesktop && stored?.mode === 'managed')} initialRole={initialTarget.pane === 'muse' ? 'muse' : undefined} />}
                {tab === 'hooks' && <HooksTab cfg={p.cfg} />}
                {/* 统一插件页:Forsion 插件(含捆绑包,带 Amadeus 时)/ Tangu 引擎插件 两个中分类。
                    设备页(unitPage)与 Android App 不传级联三件套:cfg 缺省=cascadeAfterToggle 不级联 —— 否则捆绑包
                    启停会经代理持久改对方引擎插件(Codex P1)/ 打到云端网关;引擎插件区同因整块桌面专属。 */}
                {tab === 'amadeus-plugins' && activeSub === 'pl-core' && !!window.amadeus && (
                  <AmadeusPluginsTab key="core" section="core" onOpenSettings={openForsionSettings} {...(pluginCascade ? { cfg: p.cfg, onEngineReload: reloadPlugins, enginePlugins: plugins } : {})} />
                )}
                {tab === 'amadeus-plugins' && activeSub === 'pl-forsion' && !!window.amadeus && (
                  <AmadeusPluginsTab key="installed" section="installed" onOpenSettings={openForsionSettings} {...(pluginCascade ? { cfg: p.cfg, onEngineReload: reloadPlugins, enginePlugins: plugins } : {})} />
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
                {tab === 'spaces' && <SpacesTab phone={phoneShell} />}
                {/* Ribbon 两项从外观搬来(设置页规范 v1):改的是左边那条 Space 图标。手机上没有 Ribbon 滚动,不出 */}
                {tab === 'spaces' && !mobileSettings && <RibbonSettings />}
                {tab === 'notifications' && <NotificationsTab onOpenInbox={isDesktop && stored ? () => openSubPage('general', 'g-inbox') : undefined} />}
                {tab === 'statusbar' && <StatusBarTab />}
                {/* Forsion 插件的设置页(P4):身份卡 + 宿主零件画的设置。深链到一个没有设置的插件(商店「打开」、沙箱)= 照旧落它的详情面。 */}
                {tab.startsWith('fplugin:') && (() => {
                  const id = tab.slice('fplugin:'.length)
                  const pl = amxPlugins.find((x) => x.id === id)
                  return pl && pluginSettingsEntries.some((e) => e.tab === tab)
                    ? <ForsionPluginSettingsPage plugin={pl} onClose={p.onClose} {...(pluginCascade ? { onEngineReload: reloadPlugins } : {})} />
                    : <AmadeusPluginsTab
                      {...(pluginCascade ? { cfg: p.cfg, onEngineReload: reloadPlugins, enginePlugins: plugins } : {})}
                      controlledDetail={{ id, onBack: () => goTab('amadeus-plugins') }}
                      onOpenSettings={openForsionSettings}
                    />
                })()}
                {tab === 'plugin-settings' && <PluginSettingsDirectory entries={pluginSettingsEntries} onOpen={(x) => goTab(x)} />}
                {tab === 'computer-use' && (
                  <div data-setting-anchor="computer-use">
                    {computerUse
                      ? <PluginSettingsPage cfg={p.cfg} plugin={computerUse} agents={pluginAgents} />
                      : <div className="hint">{t('common.loading')}</div>}
                  </div>
                )}
                {tab.startsWith('plugin:') && (() => {
                  const pid = tab.slice('plugin:'.length)
                  const pl = (plugins || []).find((x) => x.id === pid)
                  // 桌面上落不到的 id 由上面那个 effect 转去引擎插件列表:清单没到 / 转之前的那一帧都只显示「加载中」。
                  return pl?.settings
                    ? <EnginePluginSettingsHostPage plugin={pl} plugins={plugins || []} agents={pluginAgents} cfg={p.cfg} onReload={reloadPlugins} />
                    : <div className="hint">{t(isDesktop ? 'common.loading' : 'settings.plugins.empty')}</div>
                })()}
                {tab === 'agents' && activeSub === 'ag-clis' && <AgentClisTab cfg={p.cfg} />}

                {tab === 'browser' && stored && (
                  <>
                    <SettingsPanel
                      anchor="agent-browser"
                      className="settings-browser-panel"
                      icon={<Globe2 size={16} />}
                      title={t('settings.browser.agentBrowser')}
                      description={t('settings.browser.hint')}
                      actions={<SettingsSwitch checked={stored.browserEnabled !== false} onChange={(on) => edit({ browserEnabled: on })} label={t('settings.browser.agentBrowser')} />}
                    >
                      <div className={`settings-control-list${stored.browserEnabled === false ? ' is-disabled' : ''}`}>
                        <SettingsRow
                          label={t('settings.browser.engine')}
                          description={t('settings.browser.engineHint')}
                          control={(
                            <select value={stored.browserEngine || 'auto'} onChange={(e) => edit({ browserEngine: e.target.value as StoredDesktopConfig['browserEngine'] })}>
                              <option value="auto">Auto</option>
                              <option value="chrome">Chrome</option>
                              <option value="lightpanda">Lightpanda</option>
                            </select>
                          )}
                        />
                        <SettingsRow
                          label={t('settings.browser.searchEngine')}
                          control={(
                            <select value={stored.browserSearchEngine || 'duckduckgo'} onChange={(e) => edit({ browserSearchEngine: e.target.value as StoredDesktopConfig['browserSearchEngine'] })}>
                              <option value="duckduckgo">DuckDuckGo</option>
                              <option value="bing">Bing</option>
                              <option value="google">Google</option>
                              <option value="baidu">Baidu</option>
                            </select>
                          )}
                        />
                        <SettingsRow label={t('settings.browser.timeout')} description={t('settings.browser.timeoutHint')} control={(
                          // 界面按秒(5–600:引擎 commandTimeout 低于 5000ms 会回落默认 30s),存盘仍是毫秒
                          <span className="settings-inline-row">
                            <input className="settings-number-input" type="number" min={5} max={600} step={1} aria-label={t('settings.browser.timeout')} value={Math.round((stored.browserCommandTimeoutMs || 30000) / 1000)} onChange={(e) => edit({ browserCommandTimeoutMs: Math.min(600, Math.max(5, Math.round(Number(e.target.value) || 30))) * 1000 })} />
                            <span className="hint">{t('settings.browser.timeoutUnit')}</span>
                          </span>
                        )} />
                        <SettingsRow label={t('settings.browser.allowPrivate')} description={t('settings.browser.allowPrivateHint')} control={<SettingsSwitch checked={!!stored.browserAllowPrivateUrls} onChange={(on) => edit({ browserAllowPrivateUrls: on })} label={t('settings.browser.allowPrivate')} />} />
                      </div>
                      {/* 同为 managedKeys:改动先是草稿,吸底栏显式「保存」(保存会重启后端)。 */}
                      {browserDirty ? (
                        <SettingsSaveBar
                          saveLabel={t('settings.btn.save')}
                          message={t('settingsmodal.backend.runtimeDirty')}
                          busy={remoteBusy}
                          error={remoteMsg && remoteMsg !== t('settings.remote.saved') ? remoteMsg : undefined}
                          onSave={() => void saveRemoteSettings()}
                          onDiscard={discardBrowser}
                        />
                      ) : remoteMsg ? (
                        <div className="settings-panel-footer"><span className="hint" role="status">{remoteMsg}</span></div>
                      ) : null}
                    </SettingsPanel>
                    {isDesktop && !unitPage && <BrowserExtensionPanel cfg={p.cfg} managed={stored.mode !== 'external'} />}
                  </>
                )}

                {tab === 'channels' && (
                  <>
                    <ChannelsTab cfg={p.cfg} />
                  </>
                )}

                {/* 外观页:整页是一份设置零件描述(AppearanceSettings.tsx;设置页规范 v1 · 方案 B,2026-11-17) */}
                {tab === 'theme' && (
                  <AppearanceSettings
                    tabLabel={activeTabLabel} themeLang={p.themeLang} themeSkin={p.themeSkin} themeMode={p.themeMode} themeModePref={p.themeModePref}
                    glassOn={p.glassOn} flatOn={p.flatOn} themeSeed={p.themeSeed} onThemeChange={p.onThemeChange} onGlassChange={p.onGlassChange}
                    onFlatChange={p.onFlatChange} onSeedChange={p.onSeedChange} onReloadThemes={p.onReloadThemes}
                  />
                )}

                {aiImportOpen && <ExternalImportSheet engine={homeTarget()} onClose={() => setAiImportOpen(false)} />}
                {tab === 'shortcuts' && <ShortcutsTab />}

                {tab === 'skills' && activeSub === 'k-library' && (
                  <GlobalSkillsLibrary
                    cfg={p.cfg}
                    localHost={!!(isDesktop && stored?.mode === 'managed')}
                    initialSkillKey={p.initialSkillKey}
                    onImportCli={isDesktop ? () => setAiImportOpen(true) : undefined}
                    onBrowseMarket={() => useApp.getState().openMarket()}
                  />
                )}

                {tab === 'skills' && activeSub === 'k-discovery' && isDesktop && (
                  <div className="field">
                    <button type="button" className="btn primary sm" onClick={() => setAiImportOpen(true)}><FolderInput size={13} /> {t('settings.discovery.open')}</button>
                  </div>
                )}

                {tab === 'advanced' && activeSub === 'a-mcp' && (
                  <>
                    {isDesktop && (
                      <div className="field">
                        <SettingsRow fit="inline" label={t('settings.mcpServer.label')} description={t('settings.mcpServer.hint')}
                          control={<SettingsSwitch checked={!!stored?.mcpEnabled} label={t('settings.mcpServer.enable')} onChange={(on) => void window.tangu!.setConfig({ mcpEnabled: on }).then(setStored)} />} />

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
                                <span style={{ fontSize: 'var(--ui-font-meta, 12px)', opacity: 0.7, flexShrink: 0 }}>{t('settings.mcpServer.endpoint')}</span>
                                <input
                                  readOnly
                                  value={url}
                                  onFocus={(e) => e.currentTarget.select()}
                                  style={{ flex: 1, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 'var(--ui-font-meta, 12px)' }}
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
                                <pre style={{ flex: 1, margin: 0, padding: '8px 10px', background: 'var(--surface-2, rgba(127,127,127,0.1))', borderRadius: 'var(--radius-sm)', fontSize: 'var(--ui-font-caption, 11px)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{active.snippet}</pre>
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
                        <SettingsRow fit="inline" label={t('settings.advanced.agentDesk')} description={t('settings.advanced.agentDeskHint')}
                          control={<SettingsSwitch checked={!!stored?.agentDeskEnabled} label={t('settings.advanced.agentDeskEnable')} onChange={(on) => void window.tangu!.setConfig({ agentDeskEnabled: on }).then((c) => {
                            setStored(c)
                            useApp.setState({ desktopConfig: c })
                          })} />} />
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

                    {/* 输入建议(缺省开):要 Tab 键采用,也要本机引擎(云端执行节点没有这条路由)→ 只在桌面宿主(不含设备页)、
                        有悬停的设备上摆出来;与 promptSuggest.ts 的 supported() 同一道闸。 */}
                    {tanguPrefs && isDesktop && !unitPage && hoverCapable && !mobileSettings && (
                      <div className="field" style={{ marginTop: 14 }} data-setting-anchor="prompt-suggest">
                        <SettingsRow fit="inline" label={t('settings.promptSuggest')} description={t('settings.promptSuggestHint')}
                          control={<SettingsSwitch checked={promptSuggest} label={t('settings.promptSuggestEnable')} onChange={(on) => { setPromptSuggest(on); tanguPrefs.promptSuggest.set(on) }} />} />
                      </div>
                    )}

                    <div className="field" style={{ marginTop: 14 }} data-setting-anchor="reset-layout">
                      <label>{t('settingsmodal.advanced.resetLayout')}</label>
                      <div className="hint" style={{ marginBottom: 8 }}>{t('settingsmodal.advanced.resetLayoutHint')}</div>
                      <button
                        className="btn ghost sm"
                        // 设置是独立浮窗(自己没有 Dockview,resetLayout 在这边第一句就退了):请主窗恢复。web 仍在同一渲染进程。
                        onClick={() => { if (window.tangu?.requestMainAction) window.tangu.requestMainAction('reset-layout'); else useWorkspace.getState().resetLayout({ undoable: true }); p.onClose() }}
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

                {tab === 'advanced' && activeSub === 'a-experimental' && (
                  <>
                    <div className="panel-note">{t('settingsmodal.advanced.experimentalNote')}</div>
                    <SettingsRow
                      label={t('settingsmodal.advanced.waitDetails')}
                      description={t('settingsmodal.advanced.waitDetailsHint')}
                      control={(
                        <SettingsSwitch
                          checked={showWaitDetails}
                          onChange={setChatWaitDetailsEnabled}
                          label={t('settingsmodal.advanced.waitDetails')}
                        />
                      )}
                    />
                    {/* 客户端能力面自带的设置行(手机操控等,见 services/clientSurfaces.ts):数据驱动,
                        desktop/web 没注册就什么都不出,这里不写任何平台判断。 */}
                    {listClientSurfaces().map(({ ns, surface: { SettingsRow: Row } }) => Row && <Row key={ns} />)}
                  </>
                )}

                {tab === 'advanced' && activeSub === 'a-data' && (
                  <>
                    {window.tangu?.clearAppData && (
                      <div className="field">
                        <label style={{ color: 'var(--danger)' }}>{t('settings.clearData.label')}</label>
                        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.clearData.hint')}</div>
                        {/* 两项各占一行(W-06):inline-check 是行内元素,中文串短时两个勾选框会挤进同一行、归属不清 */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <label className="inline-check">
                            <input type="checkbox" checked={clearTangu} onChange={(e) => setClearTangu(e.target.checked)} />
                            {t('settings.clearData.tangu')}
                          </label>
                          <label className="inline-check">
                            <input type="checkbox" checked={clearDesktop} onChange={(e) => setClearDesktop(e.target.checked)} />
                            {t('settings.clearData.desktop')}
                          </label>
                        </div>
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
                      <SettingsRow fit="inline" label={t('settings.developer.showSystemPrompt')} description={t('settings.developer.showSystemPromptHint')} control={<SettingsSwitch checked={showSysPrompt} label={t('settings.developer.showSystemPrompt')} onChange={(on) => {
                            setShowSysPrompt(on)
                            try { localStorage.setItem(SHOW_SYSTEM_PROMPT_KEY, on ? '1' : '0') } catch { /* ignore */ }
                      }} />} />
                    </div>
                    <div className="field">
                      <SettingsRow fit="inline" label={t('settings.developer.mobileUiPreview')} description={t('settings.developer.mobileUiPreviewHint')} control={<SettingsSwitch checked={mobileUiCmd} label={t('settings.developer.mobileUiPreview')} onChange={(on) => {
                            setMobileUiCmd(on)
                            try { localStorage.setItem(MOBILE_UI_KEY, on ? '1' : '0') } catch { /* ignore */ }
                            setMobileUiCommand(on)   // 设置画在主窗里的形态(web/mobile)
                            requestDevCommandsSync() // 设置在浮窗里的形态:命令表各窗一份,得让主窗重算
                      }} />} />
                    </div>
                    <DecisionGateField />
                    <div className="field">
                      <SettingsRow fit="wrap" label={t('settings.developer.summaryElevation')} description={t('settings.developer.summaryElevationHint')} control={
                        <div className="seg" role="group" aria-label={t('settings.developer.summaryElevation')}>
                          {([['float', t('settings.developer.summaryElevationFloat')], ['half', t('settings.developer.summaryElevationHalf')], ['flat', t('settings.developer.summaryElevationFlat')]] as const).map(([v, label]) => (
                            <button key={v} type="button" aria-pressed={summaryElevation === v} className={summaryElevation === v ? 'active' : ''} onClick={() => setSummaryElevation(v)}>{label}</button>
                          ))}
                        </div>} />
                    </div>
                    <div className="field">
                      <label>{t('settings.developer.testUpdateLabel')}</label>
                      <div>
                        <button className="btn ghost sm" onClick={() => { openWhatsNew(); p.onClose() }}>
                          <RefreshCw size={12} /> {t('settings.developer.testUpdate')}
                        </button>
                      </div>
                      <div className="hint">{t('settings.developer.testUpdateHint')}</div>
                    </div>
                    <div className="field">
                      <label>{t('settings.developer.achToastLabel')}</label>
                      <div>
                        {/* 成就弹窗只挂在主窗:设置浮窗里触发要请主窗来播(同「发送测试通知」)。 */}
                        <button className="btn ghost sm" onClick={() => window.tangu?.requestMainAction ? window.tangu.requestMainAction('achievement-toast') : debugFireToast()}>
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
                      </div>
                      <SettingsRow fit="inline" label={t('settings.developer.activityEnable')} description={t('settings.developer.activityHint')}
                        control={<SettingsSwitch checked={stored?.activityLogEnabled !== false} label={t('settings.developer.activityEnable')} onChange={(on) => void window.tangu!.setConfig({ activityLogEnabled: on }).then(setStored)} />} />
                    </div>
                    <div className="field">
                      <SettingsRow fit="inline" label={t('settings.developer.activityViewCmd')} description={t('settings.developer.activityViewCmdHint')} control={<SettingsSwitch checked={activityViewCmd} label={t('settings.developer.activityViewCmd')} onChange={(on) => {
                            setActivityViewCmd(on)
                            try { localStorage.setItem(ACTIVITY_VIEW_KEY, on ? '1' : '0') } catch { /* ignore */ }
                            setActivityViewCommand(on)
                            requestDevCommandsSync()
                      }} />} />
                    </div>
                    <div className="field">
                      <SettingsRow fit="inline" label={t('settings.developer.activeWindow')} description={t('settings.developer.activeWindowHint')} control={<SettingsSwitch checked={!!stored?.activeWindowEnabled} label={t('settings.developer.activeWindow')} onChange={(on) => {
                            // 真源在主进程配置(默认拒的实现点就在那儿);⌘K 入口同步增删,免 reload。
                            // 主窗那份由**主进程**在 config:set 落盘后推(见 main.ts):这里 .then 里通知的话,
                            // 「拨完立刻关掉设置窗」会连同这个渲染进程一起没掉,主窗就永远不知道。
                            void window.tangu!.setConfig({ activeWindowEnabled: on }).then(setStored)
                            setActiveWindowCommand(on)
                      }} />} />
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
                          disableDecisionGate() // 同理:开关在这一页,藏起来还开着就一直把原话发云端
                          requestDevCommandsSync() // 两个 localStorage 开关已同步清掉;config 那条由主进程自己推
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
                    <div className="field" data-setting-anchor="language">
                      <label>{t('common.language')}</label>
                      <LocaleToggle />
                    </div>
                    <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{window.tangu?.mobile ? t('about.builtWithMobile') : t('about.builtWith')}</div>
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
                          {t('about.version')} {appVersion || APP_VERSION || '—'}
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
                      <button className="btn ghost sm" data-testid="about-whats-new" onClick={() => openWhatsNew()}>
                        <Sparkles size={12} /> {t('whatsNew.open')}
                      </button>
                      <UpdateSourceNote upd={upd} />
                      <UpdateActions upd={upd} />
                    </div>
                    <CorePluginUpdates />
                    {(upd.phase === 'available' || upd.phase === 'downloaded') && (
                      <div className="field">
                        <div style={{ fontWeight: 600 }}>{t('about.update.available', { version: upd.version || '' })}</div>
                        {/* 更新说明来自仓库 CHANGELOG.md 那一节(见 electron/updater.ts),是 markdown ——
                            按 .md-body 正典渲染,别再当纯文本 pre-wrap 摊开。 */}
                        {releaseNotesFor(upd, locale) ? (
                          <div className="md-body" style={{ marginTop: 4, maxHeight: 260, overflow: 'auto' }}>
                            <Markdown content={releaseNotesFor(upd, locale)!} />
                          </div>
                        ) : null}
                      </div>
                    )}
                    {upd.phase === 'error' && upd.error ? (
                      <div className="field"><div className="hint" style={{ color: 'var(--danger)' }}>{t('about.update.error', { error: UPDATE_ERROR_KEYS[upd.error] ? t(UPDATE_ERROR_KEYS[upd.error]) : upd.error })}</div></div>
                    ) : null}
                    {window.tangu?.setUpdateBeta ? (
                      <div className="field">
                        <SettingsRow fit="inline" label={t('about.update.beta')} description={t('about.update.betaHint')}
                          control={<SettingsSwitch checked={betaChannel} label={t('about.update.beta')} onChange={(on) => {
                            setBetaChannel(on) // 先动 UI:落盘是异步的,等它回来开关会慢一拍
                            void window.tangu?.setUpdateBeta?.(on).then(() => window.tangu?.checkForUpdates?.())
                          }} />} />
                      </div>
                    ) : null}
                    {window.tangu?.setUpdateSource ? (
                      <div className="field" data-testid="about-update-source">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ fontWeight: 600 }}>{t('about.update.source')}</div>
                          <span style={{ flex: 1 }} />
                          <div className="seg" role="group" aria-label={t('about.update.source')}>
                            {(['auto', 'website', 'github'] as const).map((v) => (
                              <button
                                key={v}
                                type="button"
                                aria-pressed={updateSource === v}
                                className={updateSource === v ? 'active' : ''}
                                onClick={() => {
                                  setUpdateSource(v) // 先动 UI:落盘是异步的
                                  void window.tangu?.setUpdateSource?.(v)
                                }}
                              >
                                {t(v === 'auto' ? 'about.update.sourceAuto' : v === 'website' ? 'about.update.sourceWebsite' : 'about.update.sourceGithub')}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="hint" style={{ marginTop: 4 }}>{t('about.update.sourceHint')}</div>
                        {updateRegion !== null && <div className="hint" style={{ marginTop: 2 }}>{t(updateRegion ? 'about.update.regionMainland' : 'about.update.regionAbroad')}</div>}
                      </div>
                    ) : null}
                    {window.tangu?.mobile ? (
                      <div className="field" data-testid="mobile-compliance">
                        <label>{t('about.complianceTitle')}</label>
                        <div className="settings-control-list about-compliance-list">
                          <button
                            type="button"
                            className="settings-control-row about-compliance-row"
                            data-testid="mobile-filing-link"
                            onClick={() => void window.tangu?.openExternal?.(MIIT_APP_FILING_URL)}
                          >
                            <div className="settings-control-copy">
                              <Globe2 size={14} />
                              <span><strong>{t('about.appFiling')}</strong><small>{MOBILE_APP_FILING_NUMBER}</small></span>
                            </div>
                            <ChevronRight size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="settings-control-row about-compliance-row"
                            data-testid="mobile-privacy-link"
                            onClick={() => void window.tangu?.openExternal?.(FORSION_PRIVACY_URL)}
                          >
                            <div className="settings-control-copy">
                              <KeyRound size={14} />
                              <span><strong>{t('about.privacy')}</strong><small>forsion.net/legal/privacy</small></span>
                            </div>
                            <ChevronRight size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="settings-control-row about-compliance-row"
                            data-testid="mobile-terms-link"
                            onClick={() => void window.tangu?.openExternal?.(FORSION_TERMS_URL)}
                          >
                            <div className="settings-control-copy">
                              <NotebookPen size={14} />
                              <span><strong>{t('about.terms')}</strong><small>forsion.net/legal/terms</small></span>
                            </div>
                            <ChevronRight size={16} aria-hidden="true" />
                          </button>
                          <PhoneEngineLicenses />
                        </div>
                      </div>
                    ) : null}
                    <div className="field">
                      <label>{t('about.changelogTitle')}</label>
                      <div className="changelog">
                        <ChangelogEntries />
                      </div>
                    </div>
                  </>
                )}
          </div>
          </ErrorBoundary>
        </div>
      </section>
    </div>
  )
}

/** config.json / provider-auth.json 读坏后从 .bak 恢复过(引擎或主进程写的恢复标记):提示一次,点掉删标记(坏文件与备份都留着)。 */
function ConfigRecoveryNotice() {
  const { t } = useI18n()
  const [notice, setNotice] = useState<{ at: number; version: number } | null>(null)
  useEffect(() => { void window.tangu?.configRecoveryNotice?.().then(setNotice).catch(() => {}) }, [])
  if (!notice) return null
  const time = formatDateTime(notice.version)
  return (
    <div className="mk-notice" role="status" data-config-recovered>
      <Info size={15} />
      <div className="mk-notice-body"><span>{t('settingsmodal.configRecovered', { time })}</span></div>
      <button className="mk-notice-close" onClick={() => { setNotice(null); void window.tangu?.clearConfigRecoveryNotice?.().catch(() => {}) }} aria-label={t('common.close')}><X size={13} /></button>
    </div>
  )
}
