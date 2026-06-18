/**
 * 轻量 i18n:中/英双语,默认中文,localStorage 持久化。
 * 用法:`const { t, locale, setLocale } = useI18n()`;`t('ns.key')` 或 `t('ns.key', { x })`(占位 {x})。
 * 字典是扁平 `key -> 文案`(对齐 AI Studio i18n)。缺失键回退:en 缺 → zh → key 本身。
 *
 * 各组件按命名空间拥有自己的键前缀(sidebar.* / input.* / chat.* / panel.* / settings.* /
 * about.* / onboarding.* / approval.* / tool.* / inquiry.* / thinking.* / toc.* / common.*)。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type Locale = 'zh' | 'en'

const LS_KEY = 'tangu_locale'

export function resolveInitialLocale(): Locale {
  try {
    const v = localStorage.getItem(LS_KEY)
    if (v === 'en' || v === 'zh') return v
  } catch {
    /* ignore */
  }
  return 'zh' // 默认中文
}

type Dict = Record<string, string>

// ── 字典 ────────────────────────────────────────────────────────────────────
// 注:这里先放基础设施会用到的键 + 任务新增键;其余界面文案由全量翻译批次补入。
const zh: Dict = {
  'common.save': '保存',
  'common.cancel': '取消',
  'common.confirm': '确定',
  'common.close': '关闭',
  'common.back': '返回',
  'common.refresh': '刷新',
  'common.loading': '加载中…',
  'common.delete': '删除',
  'common.edit': '编辑',
  'common.open': '打开',
  'common.language': '语言',
  'common.copyCode': '复制代码',

  'locale.zh': '中文',
  'locale.en': 'English',
  'locale.toggleTitle': '切换语言',

  // 侧栏账号卡
  'sidebar.account.login': '登录 Forsion',
  'sidebar.account.loginHint': '登录后可用云端记忆 / 技能 / 托管模型(不登录也能正常使用)',
  'sidebar.account.loggingIn': '登录中…',
  'sidebar.account.center': '个人中心',
  'sidebar.account.logout': '登出',
  'sidebar.account.guest': '未登录',
  'sidebar.account.loginFail': '登录失败:{e}',
  'sidebar.account.loginSub': '点击登录',
  'sidebar.settings': '设置 (Ctrl+,)',
  'header.theme': '深浅模式',

  // 设置 - 关于
  'settings.tab.about': '关于',
  'about.version': '版本',
  'about.checkUpdates': '前往官网',
  'about.changelogTitle': '最新更新',
  'about.builtWith': 'Tangu Agent · Forsion 扶桑',

  // 设置 - 连接(云端地址改为只读/环境变量)
  'settings.cloud.envOnly': 'Forsion 云端地址由环境变量 TANGU_CLOUD_URL 设置(此处只读)。',
  'settings.cloud.label': 'Forsion 云端地址(大脑:记忆/技能/托管模型)',
  'settings.cloud.unset': '(未设置,用内置默认)',

  // 模型 / Provider 分组
  'model.group.forsion': 'Forsion 托管',
  'model.group.direct': '直连',
  'model.collapseAll': '全部折叠',
  'model.expandAll': '全部展开',
  'model.empty': '暂无模型',
  'model.searchPlaceholder': '搜索模型…',

  // 设置 - 开发者选项(关于页连点版本号 10 次解锁)
  'settings.tab.developer': '开发者选项',
  'about.versionClickHint': '再点 {n} 次开启开发者模式',
  'about.devUnlocked': '开发者模式已开启',
  'settings.developer.note': '以下选项面向高级用户/调试,一般无需修改。',
  'settings.developer.cloudUrlLabel': 'Forsion 云端地址',
  'settings.developer.cloudUrlHint': '大脑服务(记忆/技能/托管模型)的地址。留空则用环境变量 TANGU_CLOUD_URL 或内置默认。托管模式下保存会重启后端使其生效。',
  'settings.developer.cloudUrlPlaceholder': 'https://api.forsion.net',
  'settings.developer.saveCloudUrl': '保存',
  'settings.developer.savedRestarting': '已保存,正在重启后端…',
  'settings.developer.saved': '已保存',
  'settings.developer.relaunchLabel': '引导界面',
  'settings.developer.relaunchHint': '重新进入首次安装的引导流程(主题 / 连接 / 模型 / 工作区)。',
  'settings.developer.relaunch': '重新进入引导',
  'settings.developer.disable': '关闭开发者模式',

  // 引导 - 主题 / 工作区(新增步骤)
  'onboarding.connect.forsionHint': '用 Forsion 账号登录(云端地址由环境变量配置,无需填写);也可在上方切换为自带 API Key。',
  'onboarding.theme.stepLabel': '选择主题外观',
  'onboarding.theme.modeLabel': '明暗模式',
  'onboarding.theme.light': '浅色',
  'onboarding.theme.dark': '深色',
  'onboarding.theme.hint': '随时可在 设置 → 主题 中更改。',
  'onboarding.workspace.stepLabel': '选择默认本地文件夹',
  'onboarding.workspace.hint': 'Agent 新建本机会话时的默认工作目录;留空则使用 ~/Tangu。',
  'onboarding.workspace.placeholder': '~/Tangu(默认)',
  'onboarding.workspace.pick': '浏览文件夹',
  'onboarding.workspace.clear': '清除',
  'settings.advanced.exportLogs': '导出会话日志',
  'settings.advanced.exportLogsHint': '将当前会话的全部对话内容与后端运行日志打包成一个 JSON 文件,便于开发者排查问题。',
  'settings.advanced.exportBtn': '导出为 JSON',
  'settings.advanced.exportNoSession': '当前没有打开的会话,请先选择一个会话再导出。',
  'settings.advanced.exportOk': '已导出到 {path}',
  'settings.advanced.exportCanceled': '已取消导出',
  'settings.advanced.exportFailed': '导出失败:{err}',
  'input.slash.loop': '最大循环轮数:/loop <轮数>(当前 {current},范围 1-200)',
  'input.slash.loopSet': '最大循环轮数已设为 {n} 轮',

  // 上下文占比 + 会话消耗 + 压缩
  'input.ctxLabel': '上下文',
  'input.sessionTokens': '本会话 {n} tokens',
  'input.compact': '压缩上下文',
  'input.compacting': '正在压缩上下文…',
  'input.compactDone': '已压缩上下文（折叠 {n} 条消息为摘要，后续从此精简续接）',
  'input.compactSkip': '无需压缩：{reason}',
  'input.compactFail': '压缩失败：{e}',
  'input.slash.compact': '压缩上下文：总结后精简续接',
  'input.slash.agent': '选用 Normal Agent（自定义人格）',
  'input.agentActive': '当前 Agent：{name}',
  'input.agentCleared': '已取消 Normal Agent',

  // 设置 - Normal Agents
  'settings.tab.agents': '智能体',
  'settings.agents.title': 'Normal Agent（自定义人格）',
  'settings.agents.hint': '为不同任务定义可复用的对话人格（system prompt + 模型 + 设置）。也可让 agent 用 manage_agent 工具自创建。',
  'settings.agents.new': '新建 Agent',
  'settings.agents.empty': '暂无 Agent，点「新建 Agent」创建一个。',
  'settings.agents.name': '名称',
  'settings.agents.namePlaceholder': '如：代码审查员',
  'settings.agents.desc': '简介',
  'settings.agents.model': '模型（留空=用会话模型）',
  'settings.agents.modelDefault': '（用会话模型）',
  'settings.agents.systemPrompt': 'System Prompt / 人格',
  'settings.agents.systemPromptPlaceholder': '你是一位严谨的代码审查员……',
  'settings.agents.thinking': '思考强度',
  'settings.agents.maxIter': '最大循环轮数',
  'settings.agents.approval': '审批档',
  'settings.agents.inherit': '（继承）',
  'settings.agents.byAgent': 'agent 创建',
  'settings.agents.deleteConfirm': '删除 Agent「{name}」？',
  'settings.agents.saveFail': '保存失败：{e}',
  'settings.agents.cloudOnly': 'Normal Agent 仅在本地（桌面/TUI）可用。',

  // 设置 - Special Agents（Historian / Muse）
  'settings.tab.special': '后台智能体',
  'settings.special.title': 'Special Agents（后台特殊智能体）',
  'settings.special.hint': '默认关闭。开启后需选模型；其记录隔离存于本地，不进会话列表。',
  'settings.special.pickModelFirst': '请先选模型再开启',
  'settings.special.model': '模型',
  'settings.special.enable': '启用',
  'settings.special.historian': 'Historian（历史员）',
  'settings.special.historianDesc': '每 X 轮总结会话标题；每 Y 轮判断并更新你的 LOG 与记忆。',
  'settings.special.muse': 'Muse（缪斯）',
  'settings.special.museDesc': '后台常驻思考「能为你做点什么」，产出 TODO（唯一写权限）。',
  'settings.special.h.titleRounds': '每几轮总结标题',
  'settings.special.h.memoryRounds': '每几轮维护记忆',
  'settings.special.h.firstRound': '首轮必触发',
  'settings.special.h.prompt': '记忆判断提示词（留空=默认）',
  'settings.special.m.restartWindow': '重启窗口（小时）',
  'settings.special.m.maxRestarts': '每窗口最多重启',
  'settings.special.m.maxIter': '每周期最多轮数',
  'settings.special.m.maxTodos': '每窗口最多 TODO',
  'settings.special.m.poll': '巡检间隔（分钟）',
  'settings.special.m.activeHours': '运行时段（基于本机时间）',
  'settings.special.m.activeAllDay': '全天',
  'settings.special.m.prompt': '思考提示词（留空=默认）',
  'settings.special.m.folders': '授权可读本地文件夹（每行一个绝对路径）',
  'settings.special.saved': '已保存',
  'settings.special.saveFail': '保存失败：{e}',

  // 侧栏 Special Agents 入口 + 工作视图
  'sidebar.special.title': '后台智能体',
  'special.historian.title': 'Historian 工作区',
  'special.historian.empty': '暂无活动。开启 Historian 后，它会在对话推进时总结标题、维护记忆。',
  'special.action.title_updated': '更新标题',
  'special.action.log_appended': '写入日志',
  'special.action.memory_appended': '写入记忆',
  'special.muse.title': 'Muse 工作区',
  'special.muse.thinking': '当前思考',
  'special.muse.idle': 'Muse 空闲中',
  'special.muse.running': 'Muse 思考中…',
  'special.muse.disabled': 'Muse 未开启（在设置 → 后台智能体 中开启并选模型）。',
  'special.muse.todos': 'Muse TODO 清单',
  'special.muse.todosEmpty': '暂无 TODO。Muse 会在后台思考后提交高价值待办。',
  'special.muse.selectAll': '全选',
  'special.muse.inject': '注入所选到会话并运行',
  'special.muse.pickSession': '选择目标会话…',
  'special.muse.injected': '已注入 {n} 条到会话并开始运行',
  'special.muse.dismiss': '忽略',
  'special.muse.markDone': '标记完成',
  'special.muse.injectFail': '注入失败：{e}',
}

const en: Dict = {
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.confirm': 'OK',
  'common.close': 'Close',
  'common.back': 'Back',
  'common.refresh': 'Refresh',
  'common.loading': 'Loading…',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.open': 'Open',
  'common.language': 'Language',
  'common.copyCode': 'Copy code',

  'locale.zh': '中文',
  'locale.en': 'English',
  'locale.toggleTitle': 'Switch language',

  'sidebar.account.login': 'Sign in to Forsion',
  'sidebar.account.loginHint': 'Sign in for cloud memory / skills / hosted models (works fine without signing in too)',
  'sidebar.account.loggingIn': 'Signing in…',
  'sidebar.account.center': 'Account Center',
  'sidebar.account.logout': 'Log out',
  'sidebar.account.guest': 'Not signed in',
  'sidebar.account.loginFail': 'Sign-in failed: {e}',
  'sidebar.account.loginSub': 'Click to sign in',
  'sidebar.settings': 'Settings (Ctrl+,)',
  'header.theme': 'Light / Dark',

  'settings.tab.about': 'About',
  'about.version': 'Version',
  'about.checkUpdates': 'Visit website',
  'about.changelogTitle': "What's New",
  'about.builtWith': 'Tangu Agent · Forsion',

  'settings.cloud.envOnly': 'The Forsion cloud URL is set via the TANGU_CLOUD_URL environment variable (read-only here).',
  'settings.cloud.label': 'Forsion cloud URL (brain: memory/skills/hosted models)',
  'settings.cloud.unset': '(unset — using built-in default)',

  'model.group.forsion': 'Forsion Hosted',
  'model.group.direct': 'Direct',
  'model.collapseAll': 'Collapse all',
  'model.expandAll': 'Expand all',
  'model.empty': 'No models',
  'model.searchPlaceholder': 'Search models…',

  // Settings - Developer Options (unlocked by tapping the version 10×)
  'settings.tab.developer': 'Developer',
  'about.versionClickHint': '{n} more taps to enable developer mode',
  'about.devUnlocked': 'Developer mode enabled',
  'settings.developer.note': 'These options are for advanced users / debugging — normally no need to change them.',
  'settings.developer.cloudUrlLabel': 'Forsion cloud URL',
  'settings.developer.cloudUrlHint': 'Address of the brain service (memory/skills/hosted models). Leave empty to use the TANGU_CLOUD_URL env var or the built-in default. In managed mode, saving restarts the backend to take effect.',
  'settings.developer.cloudUrlPlaceholder': 'https://api.forsion.net',
  'settings.developer.saveCloudUrl': 'Save',
  'settings.developer.savedRestarting': 'Saved, restarting backend…',
  'settings.developer.saved': 'Saved',
  'settings.developer.relaunchLabel': 'Onboarding',
  'settings.developer.relaunchHint': 'Re-run the first-install setup flow (theme / connection / model / workspace).',
  'settings.developer.relaunch': 'Re-run onboarding',
  'settings.developer.disable': 'Disable developer mode',

  // Onboarding - theme / workspace (new steps)
  'onboarding.connect.forsionHint': 'Sign in with your Forsion account (the cloud URL is set via an environment variable — nothing to enter here). Or switch to your own API key above.',
  'onboarding.theme.stepLabel': 'Choose a theme',
  'onboarding.theme.modeLabel': 'Light / Dark',
  'onboarding.theme.light': 'Light',
  'onboarding.theme.dark': 'Dark',
  'onboarding.theme.hint': 'You can change this anytime in Settings → Theme.',
  'onboarding.workspace.stepLabel': 'Choose a default local folder',
  'onboarding.workspace.hint': 'Default working directory for new local sessions; leave empty to use ~/Tangu.',
  'onboarding.workspace.placeholder': '~/Tangu (default)',
  'onboarding.workspace.pick': 'Browse folder',
  'onboarding.workspace.clear': 'Clear',
  'settings.advanced.exportLogs': 'Export session logs',
  'settings.advanced.exportLogsHint': 'Bundle this session’s full conversation and the backend runtime logs into one JSON file for developer debugging.',
  'settings.advanced.exportBtn': 'Export as JSON',
  'settings.advanced.exportNoSession': 'No active session — open a session first, then export.',
  'settings.advanced.exportOk': 'Exported to {path}',
  'settings.advanced.exportCanceled': 'Export canceled',
  'settings.advanced.exportFailed': 'Export failed: {err}',
  'input.slash.loop': 'Max loop iterations: /loop <n> (currently {current}, range 1-200)',
  'input.slash.loopSet': 'Max loop iterations set to {n}',

  'input.ctxLabel': 'Context',
  'input.sessionTokens': 'Session {n} tokens',
  'input.compact': 'Compact context',
  'input.compacting': 'Compacting context…',
  'input.compactDone': 'Context compacted ({n} messages folded into a summary; continues compactly)',
  'input.compactSkip': 'Nothing to compact: {reason}',
  'input.compactFail': 'Compaction failed: {e}',
  'input.slash.compact': 'Compact context: summarize then continue compactly',
  'input.slash.agent': 'Use a Normal Agent (custom persona)',
  'input.agentActive': 'Active agent: {name}',
  'input.agentCleared': 'Normal Agent cleared',

  'settings.tab.agents': 'Agents',
  'settings.agents.title': 'Normal Agents (custom personas)',
  'settings.agents.hint': 'Define reusable conversational personas (system prompt + model + settings) for different tasks. Agents can also self-author via the manage_agent tool.',
  'settings.agents.new': 'New agent',
  'settings.agents.empty': 'No agents yet — click "New agent" to create one.',
  'settings.agents.name': 'Name',
  'settings.agents.namePlaceholder': 'e.g. Code Reviewer',
  'settings.agents.desc': 'Description',
  'settings.agents.model': 'Model (empty = use session model)',
  'settings.agents.modelDefault': '(use session model)',
  'settings.agents.systemPrompt': 'System Prompt / Persona',
  'settings.agents.systemPromptPlaceholder': 'You are a meticulous code reviewer…',
  'settings.agents.thinking': 'Thinking',
  'settings.agents.maxIter': 'Max iterations',
  'settings.agents.approval': 'Approval',
  'settings.agents.inherit': '(inherit)',
  'settings.agents.byAgent': 'agent-authored',
  'settings.agents.deleteConfirm': 'Delete agent "{name}"?',
  'settings.agents.saveFail': 'Save failed: {e}',
  'settings.agents.cloudOnly': 'Normal Agents are only available locally (desktop/TUI).',

  'settings.tab.special': 'Background Agents',
  'settings.special.title': 'Special Agents (background)',
  'settings.special.hint': 'Off by default. Pick a model to enable; records are isolated locally and never appear in the session list.',
  'settings.special.pickModelFirst': 'Pick a model before enabling',
  'settings.special.model': 'Model',
  'settings.special.enable': 'Enable',
  'settings.special.historian': 'Historian',
  'settings.special.historianDesc': 'Summarizes the session title every X rounds; reviews & updates your LOG and memory every Y rounds.',
  'settings.special.muse': 'Muse',
  'settings.special.museDesc': 'Resident background thinker for "what can I do for you", producing TODOs (its only write).',
  'settings.special.h.titleRounds': 'Title every N rounds',
  'settings.special.h.memoryRounds': 'Memory every N rounds',
  'settings.special.h.firstRound': 'Always trigger on first round',
  'settings.special.h.prompt': 'Memory-judgment prompt (empty = default)',
  'settings.special.m.restartWindow': 'Restart window (hours)',
  'settings.special.m.maxRestarts': 'Max restarts / window',
  'settings.special.m.maxIter': 'Max iterations / cycle',
  'settings.special.m.maxTodos': 'Max TODOs / window',
  'settings.special.m.poll': 'Supervisor poll (min)',
  'settings.special.m.activeHours': 'Active hours (device local time)',
  'settings.special.m.activeAllDay': 'All day',
  'settings.special.m.prompt': 'Thinking prompt (empty = default)',
  'settings.special.m.folders': 'Authorized readable folders (one absolute path per line)',
  'settings.special.saved': 'Saved',
  'settings.special.saveFail': 'Save failed: {e}',

  'sidebar.special.title': 'Background Agents',
  'special.historian.title': 'Historian workspace',
  'special.historian.empty': 'No activity yet. Once enabled, Historian summarizes titles and maintains memory as conversations progress.',
  'special.action.title_updated': 'title updated',
  'special.action.log_appended': 'log appended',
  'special.action.memory_appended': 'memory appended',
  'special.muse.title': 'Muse workspace',
  'special.muse.thinking': 'Current thinking',
  'special.muse.idle': 'Muse is idle',
  'special.muse.running': 'Muse is thinking…',
  'special.muse.disabled': 'Muse is off (enable it and pick a model in Settings → Background Agents).',
  'special.muse.todos': 'Muse TODO list',
  'special.muse.todosEmpty': 'No TODOs yet. Muse proposes high-value tasks after thinking in the background.',
  'special.muse.selectAll': 'Select all',
  'special.muse.inject': 'Inject selected into a session & run',
  'special.muse.pickSession': 'Pick target session…',
  'special.muse.injected': 'Injected {n} into a session and started running',
  'special.muse.dismiss': 'Dismiss',
  'special.muse.markDone': 'Mark done',
  'special.muse.injectFail': 'Inject failed: {e}',
}

const DICTS: Record<Locale, Dict> = { zh, en }

/** 合并全量翻译批次产出的字典片段(键 -> {zh,en})。在模块加载时调用。 */
export function registerMessages(fragment: Record<string, { zh: string; en: string }>): void {
  for (const [key, val] of Object.entries(fragment)) {
    if (val.zh != null) zh[key] = val.zh
    if (val.en != null) en[key] = val.en
  }
}

function interpolate(s: string, vars?: Record<string, unknown>): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`))
}

interface I18nValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, vars?: Record<string, unknown>) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export const LocaleProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale)

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try { localStorage.setItem(LS_KEY, l) } catch { /* ignore */ }
    try { document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en' } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    try { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en' } catch { /* ignore */ }
  }, [locale])

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: (key, vars) => {
      const d = DICTS[locale]
      const s = d[key] ?? DICTS.zh[key] ?? key
      return interpolate(s, vars)
    },
  }), [locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (ctx) return ctx
  // Provider 缺失时的降级(不应发生):始终返回中文。
  return {
    locale: 'zh',
    setLocale: () => {},
    t: (key, vars) => interpolate(zh[key] ?? key, vars),
  }
}
