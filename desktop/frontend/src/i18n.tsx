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
  'settings.developer.cloudUrlPlaceholder': 'https://api.forsion.app',
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
  'settings.developer.cloudUrlPlaceholder': 'https://api.forsion.app',
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
