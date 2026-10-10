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
 * ⚠️ 这份表不 import 任何东西:check:settingsmode 在纯 Node 里用 sucrase(只认 .ts)直接 require 它。
 *    标签所在的文案片段(xxxCopy.ts → i18n.tsx)由渲染那一页的组件自己 import,别挂到这里。
 */

/** cloud = Forsion 账号面在(内置包 Forsion Extend 装载了,桥键 forsionLogin 在)。 */
/** hover = 设备有悬停(「外围淡出」靠悬停恢复,没有悬停时那一行不渲染);wide = 非窄版设置页(Ribbon 那一行窄版不渲染)。 */
export type SettingsSearchNeed = 'stored' | 'desktop' | 'managed' | 'external' | 'cloud' | 'hover' | 'wide'

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
  { id: 'forsion-account', tab: 'forsion', sub: 'fx:forsion-extend:account', labelKey: 'settings.forsion.accountLabel', keywords: '账号 登录 account login sign', needs: ['desktop', 'cloud'] },
  { id: 'forsion-submissions', tab: 'forsion', sub: 'fx:forsion-extend:submission', labelKey: 'settingsmodal.forsionCloud.submissions', keywords: '投稿 插件 发布 审核 npm github submissions publish review', needs: ['desktop', 'cloud'] },
  { id: 'cloud-url', tab: 'forsion', sub: 'f-conn', anchor: 'cloud-url', labelKey: 'settings.forsion.cloudUrlLabel', keywords: '云端 服务器 cloud server', needs: ['stored', 'cloud'] },
  { id: 'memory-sync', tab: 'forsion', sub: 'f-sync', anchor: 'memory-sync', labelKey: 'settings.forsion.syncLabel', keywords: '记忆 同步 memory brain sync', needs: ['stored', 'cloud'] },
  { id: 'inbox-notify', tab: 'general', sub: 'g-inbox', anchor: 'inbox-notify', labelKey: 'settings.inbox.notifyLabel', keywords: '收件箱 inbox notification', needs: ['stored'] },
  { id: 'default-models', tab: 'model', sub: 'm-models', labelKey: 'modelsettings.defaults', keywords: '默认模型 default model' },
  { id: 'model-providers', tab: 'model', sub: 'm-providers', labelKey: 'modelsettings.providers', keywords: '提供方 服务商 apikey provider' },
  { id: 'web-search', tab: 'model', sub: 'm-websearch', labelKey: 'settings.sub.webSearch', keywords: '联网 搜索 search web' },
  { id: 'voice', tab: 'model', sub: 'm-voice', labelKey: 'settings.sub.voice', keywords: '语音 朗读 音色 通话 打电话 听写 voice tts speech call realtime dictation' },
  { id: 'theme-language', tab: 'theme', anchor: 'theme-language', labelKey: 'settings.theme.langLabel', keywords: '设计语言 主题 theme language' },
  { id: 'startup-appearance', tab: 'theme', anchor: 'startup-appearance', labelKey: 'startupAppearance.title', keywords: '开屏 启动 加载 动画 图标 splash startup loading animation icon dock taskbar' },
  { id: 'palette', tab: 'theme', anchor: 'palette', labelKey: 'settings.theme.skinLabel', keywords: '配色 颜色 color palette accent' },
  { id: 'color-mode', tab: 'theme', anchor: 'color-mode', labelKey: 'settings.theme.modeLabel', keywords: '深色 浅色 暗色 明暗 dark light' },
  { id: 'ui-zoom', tab: 'theme', anchor: 'ui-zoom', labelKey: 'settings.theme.zoomLabel', keywords: '缩放 界面大小 zoom scale' },
  { id: 'glass', tab: 'theme', anchor: 'glass', labelKey: 'settings.theme.glassLabel', keywords: '毛玻璃 透明 glass blur' },
  { id: 'ambient', tab: 'theme', anchor: 'ambient', labelKey: 'settings.theme.ambient', keywords: '取色 染色 外壳 内容 颜色 ambient tint chrome color' },
  { id: 'visuals', tab: 'theme', anchor: 'visuals', labelKey: 'settings.theme.visuals', keywords: 'Intelligent UI 智能界面 可视化 图文 图片 来源 图表 Sketch visuals interactive display' },
  { id: 'smooth-caret', tab: 'theme', anchor: 'smooth-caret', labelKey: 'settings.theme.smoothCaret', keywords: '光标 caret cursor' },
  { id: 'prompt-suggest', tab: 'theme', anchor: 'prompt-suggest', labelKey: 'settings.theme.promptSuggest', keywords: '输入建议 下一句 预测 补全 灰字 Tab suggestion autocomplete predict next prompt', needs: ['desktop', 'hover', 'wide'] },
  { id: 'chat-avatars', tab: 'theme', anchor: 'chat-avatars', labelKey: 'settings.theme.chatAvatars', keywords: '头像 聊天 avatar chat' },
  { id: 'calm-dim', tab: 'theme', anchor: 'calm-dim', labelKey: 'settings.theme.calmDim', keywords: '外围淡出 呼吸感 变淡 退后 侧栏 标签 dim fade quiet calm surroundings sidebar ribbon', needs: ['hover'] },
  { id: 'calm-reading', tab: 'theme', anchor: 'calm-reading', labelKey: 'settings.theme.calmReading', keywords: '宽松正文 呼吸感 行距 段距 行高 阅读宽度 line height spacing reading relaxed calm' },
  { id: 'calm-motion', tab: 'theme', anchor: 'calm-motion', labelKey: 'settings.theme.calmMotion', keywords: '舒缓过渡 呼吸感 动画 节奏 慢 transition animation motion gentle calm' },
  { id: 'ribbon-auto-home', tab: 'theme', anchor: 'ribbon-auto-home', labelKey: 'settings.theme.ribbonAutoHome', keywords: '归位 Ribbon 滚动 复位 滚轮 scroll reset', needs: ['wide'] },
  { id: 'fonts', tab: 'theme', anchor: 'fonts', labelKey: 'settings.theme.typographyTitle', keywords: '字体 font typography' },
  { id: 'notes-attachments', tab: 'notes', anchor: 'notes-attachments', labelKey: 'settings.notes.modeLabel', keywords: '附件 图片 attachment image', needs: ['stored'] },
  { id: 'daily-notes', tab: 'notes', anchor: 'daily-notes', labelKey: 'settings.notes.dailyLabel', keywords: '日记 每日 daily journal', needs: ['stored'] },
  { id: 'agent-browser', tab: 'browser', anchor: 'agent-browser', labelKey: 'settings.browser.agentBrowser', keywords: '浏览器 browser chrome', needs: ['stored'] },
  // P1-K4:设置 › 远程会话(只在有主进程 API 的本机列,tab 门控即可)
  { id: 'remote-sessions-switch', tab: 'remote-sessions', anchor: 'remote-sessions-switch', labelKey: 'remoteSessions.switch', keywords: '远程会话 手机 远程 允许 remote session phone allow' },
  { id: 'remote-approval-cap', tab: 'remote-sessions', anchor: 'remote-approval-cap', labelKey: 'remoteSessions.cap', keywords: '远程审批档 全自动 审批 remote approval full auto' },
  { id: 'remote-trusted-devices', tab: 'remote-sessions', anchor: 'remote-trusted-devices', labelKey: 'remoteSessions.trusted', keywords: '信任设备 已允许 撤销 浏览器 网页版 P2P trusted allowed devices revoke browser web app' },
  // P1-K2:急停与远程锁定(经 K4 扩展槽挂在远程会话页末尾)
  { id: 'remote-safety', tab: 'remote-sessions', anchor: 'remote-safety', labelKey: 'remoteSafety.title', keywords: '急停 紧急停止 锁定 解锁 快捷键 停止远程任务 emergency stop lock unlock shortcut hotkey stop remote tasks' },
  { id: 'computer-history', tab: 'computer-history', anchor: 'computer-history', labelKey: 'settingsmodal.tab.computerHistory', keywords: '电脑历史 活动记录 隐私 排除 暂停 computer history activity privacy recording exclude pause' },
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
