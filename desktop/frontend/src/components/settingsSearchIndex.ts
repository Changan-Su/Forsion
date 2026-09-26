/**
 * 设置搜索的静态索引(U-15):搜「镜像」「字体」「休眠」这类**具体设置项**,而不只是分类名。
 *
 * 每一项指向一个真实落点:tab(+ sub)+ 可选的 `data-setting-anchor`。
 *  - 有 anchor:SettingsModal 在正文里找 `[data-setting-anchor="<anchor>"]`,滚过去并闪一下;
 *  - 没 anchor(page):整个子页就是落点(模型 / 提供方 这类整页设置)。
 * 可见性由 SettingsModal 按**与导航同一套**门控(tabItems / subItemsByTab)再加 `needs` 过滤 —— 本端没有的页,
 * 结果里就不出现,不会点进白板。完整性由 settingsSearchIndex.test.ts(静态:anchor 字面量在源码里)
 * 与 check:settingsmode(真 Electron:点每个结果,锚点真的可见)双重钉住。
 *
 * ⚠️ 模块作用域只存 **key**,标签在渲染期 t() 求值(切语言要跟着变)。`keywords` 是模糊搜索别名,
 *    中英混写属于「刻意留中文」一类,不进字典。
 */

export type SettingsSearchNeed = 'stored' | 'desktop' | 'managed' | 'external'

export interface SettingsSearchEntry {
  /** 结果行的稳定 id(台架按它点)。 */
  id: string
  tab: string
  sub?: string
  /** 正文里的 `data-setting-anchor` 值;缺省 = 落到子页即可。 */
  anchor?: string
  /** 结果行标签的 i18n key。 */
  labelKey: string
  /** 模糊搜索别名(空格分隔,中英都写);首个词给台架当检索词。 */
  keywords: string
  /** 额外门控:stored = 桌面配置已读到;desktop = 仅桌面宿主;managed / external = 后端运行方式(按草稿)。 */
  needs?: SettingsSearchNeed[]
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  { id: 'workspace-dir', tab: 'general', sub: 'g-basic', anchor: 'workspace-dir', labelKey: 'settings.workspace.label', keywords: '工作目录 工作区 目录 workspace folder directory', needs: ['stored'] },
  { id: 'keep-awake', tab: 'general', sub: 'g-basic', anchor: 'keep-awake', labelKey: 'settingsmodal.keepAwake.title', keywords: '休眠 睡眠 唤醒 sleep awake', needs: ['stored'] },
  { id: 'backend-mode', tab: 'general', sub: 'g-conn', anchor: 'backend-mode', labelKey: 'settings.backend.modeLabel', keywords: '后端 托管 外部 backend managed external', needs: ['desktop'] },
  { id: 'sandbox', tab: 'general', sub: 'g-runtime', anchor: 'sandbox', labelKey: 'settings.sandbox.label', keywords: '沙箱 docker sandbox', needs: ['stored', 'managed'] },
  { id: 'python', tab: 'general', sub: 'g-runtime', anchor: 'python', labelKey: 'settings.python.label', keywords: 'python 解释器 interpreter', needs: ['stored', 'managed'] },
  { id: 'mirror', tab: 'general', sub: 'g-runtime', anchor: 'mirror', labelKey: 'settings.mirror.label', keywords: '镜像 国内 加速 mirror china', needs: ['stored', 'managed'] },
  { id: 'external-backend', tab: 'general', sub: 'g-conn', anchor: 'external-backend', labelKey: 'settings.external.title', keywords: '外部地址 令牌 url token', needs: ['external'] },
  { id: 'forsion-account', tab: 'general', sub: 'g-forsion', anchor: 'forsion-account', labelKey: 'settings.forsion.accountLabel', keywords: '账号 登录 account login sign', needs: ['desktop'] },
  { id: 'cloud-url', tab: 'general', sub: 'g-forsion', anchor: 'cloud-url', labelKey: 'settings.forsion.cloudUrlLabel', keywords: '云端 服务器 cloud server', needs: ['stored'] },
  { id: 'memory-sync', tab: 'general', sub: 'g-forsion', anchor: 'memory-sync', labelKey: 'settings.forsion.syncLabel', keywords: '记忆 同步 memory brain sync', needs: ['stored'] },
  { id: 'inbox-notify', tab: 'general', sub: 'g-inbox', anchor: 'inbox-notify', labelKey: 'settings.inbox.notifyLabel', keywords: '收件箱 inbox notification', needs: ['stored'] },
  { id: 'default-models', tab: 'model', sub: 'm-models', labelKey: 'modelsettings.defaults', keywords: '默认模型 default model' },
  { id: 'model-providers', tab: 'model', sub: 'm-providers', labelKey: 'modelsettings.providers', keywords: '提供方 服务商 apikey provider' },
  { id: 'web-search', tab: 'model', sub: 'm-websearch', labelKey: 'settings.sub.webSearch', keywords: '联网 搜索 search web' },
  { id: 'voice', tab: 'model', sub: 'm-voice', labelKey: 'settings.sub.voice', keywords: '语音 朗读 音色 voice tts speech' },
  { id: 'theme-language', tab: 'theme', anchor: 'theme-language', labelKey: 'settings.theme.langLabel', keywords: '设计语言 主题 theme language' },
  { id: 'palette', tab: 'theme', anchor: 'palette', labelKey: 'settings.theme.skinLabel', keywords: '配色 颜色 color palette accent' },
  { id: 'color-mode', tab: 'theme', anchor: 'color-mode', labelKey: 'settings.theme.modeLabel', keywords: '深色 浅色 暗色 明暗 dark light' },
  { id: 'ui-zoom', tab: 'theme', anchor: 'ui-zoom', labelKey: 'settings.theme.zoomLabel', keywords: '缩放 界面大小 zoom scale' },
  { id: 'glass', tab: 'theme', anchor: 'glass', labelKey: 'settings.theme.glassLabel', keywords: '毛玻璃 透明 glass blur' },
  { id: 'smooth-caret', tab: 'theme', anchor: 'smooth-caret', labelKey: 'settings.theme.smoothCaret', keywords: '光标 caret cursor' },
  { id: 'fonts', tab: 'theme', anchor: 'fonts', labelKey: 'settings.theme.typographyTitle', keywords: '字体 font typography' },
  { id: 'notes-attachments', tab: 'notes', anchor: 'notes-attachments', labelKey: 'settings.notes.modeLabel', keywords: '附件 图片 attachment image', needs: ['stored'] },
  { id: 'daily-notes', tab: 'notes', anchor: 'daily-notes', labelKey: 'settings.notes.dailyLabel', keywords: '日记 每日 daily journal', needs: ['stored'] },
  { id: 'agent-browser', tab: 'browser', anchor: 'agent-browser', labelKey: 'settings.browser.agentBrowser', keywords: '浏览器 browser chrome', needs: ['stored'] },
  { id: 'mcp-server', tab: 'advanced', sub: 'a-mcp', labelKey: 'settings.sub.mcpServer', keywords: '对外 端点 endpoint mcp' },
  { id: 'reset-layout', tab: 'advanced', sub: 'a-ui', anchor: 'reset-layout', labelKey: 'settingsmodal.advanced.resetLayout', keywords: '布局 恢复 layout reset' },
  { id: 'clear-data', tab: 'advanced', sub: 'a-data', labelKey: 'settings.sub.data', keywords: '清空 卸载 重置 clear reset data' },
  { id: 'language', tab: 'about', anchor: 'language', labelKey: 'common.language', keywords: '语言 中文 英文 language english chinese' },
]

/** 纯匹配:标签(已 t() 求值)或别名包含查询串(不分大小写)。 */
export function matchesSettingsQuery(entry: SettingsSearchEntry, label: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return label.toLowerCase().includes(q) || entry.keywords.toLowerCase().includes(q)
}
