/** 商店 UI 专项台架:只提供 MarketModal 用到的桌面桥,不读真实账号、网络或用户目录。 */
import type { MarketCard, MarketDetail } from './types'

const now = Date.now()
const day = 86_400_000
const rows: MarketDetail[] = [
  { id: 'latex-suite', type: 'amadeus-plugin', source: 'github', name: 'LaTeX Suite', summary: '在笔记中补全公式、跳转占位符，并提供结构化数学编辑工具。', author: 'Forsion Labs', installSlug: 'latex-suite', downloads: 1847, latestVersion: '1.4.2', tags: ['数学', '写作', 'Amadeus'], createdAt: new Date(now - 42 * day).toISOString(), updatedAt: new Date(now - day).toISOString(), githubRepoUrl: 'https://github.com/example/latex-suite', readme: '# LaTeX Suite\n\n为数学、研究与技术写作准备的编辑增强。\n\n## 主要能力\n\n- 公式环境补全\n- 占位符导航\n- 行内与块级数学输入\n\n## 使用方式\n\n安装后在任意 Amadeus 页面输入数学内容即可。' },
  { id: 'research-agent', type: 'agent', source: 'zip', name: 'Research Companion', summary: '整理资料、对照来源并把研究过程沉淀为可继续工作的笔记。', author: 'Lin Chen', installSlug: 'research-companion', downloads: 963, latestVersion: '2.1.0', tags: ['研究', '资料整理'], createdAt: new Date(now - 18 * day).toISOString(), updatedAt: new Date(now - 2 * day).toISOString(), readme: '# Research Companion\n\n适合长周期研究任务的 Agent。' },
  { id: 'mindmap', type: 'amadeus-plugin', source: 'github', name: 'Mindmap', summary: '把页面块组织成可编辑的思维导图，并保留与原文的双向联系。', author: 'Forsion Community', installSlug: 'mindmap', downloads: 742, latestVersion: '1.8.3', tags: ['可视化', '知识管理'], createdAt: new Date(now - 30 * day).toISOString(), updatedAt: new Date(now - 3 * day).toISOString(), githubRepoUrl: 'https://github.com/example/mindmap', readme: '# Mindmap\n\n从现有笔记创建可继续编辑的思维导图。' },
  { id: 'writing-space', type: 'space', source: 'zip', name: 'Longform Writing', summary: '为长文写作准备的三栏空间，组合资料、正文与对话助手。', author: 'Mori Studio', installSlug: 'longform-writing', downloads: 516, latestVersion: '1.2.0', tags: ['写作', 'Space'], createdAt: new Date(now - 8 * day).toISOString(), updatedAt: new Date(now - 4 * day).toISOString(), readme: '# Longform Writing\n\n安装后会在功能栏中增加一个写作空间。' },
  { id: 'source-check', type: 'skill', source: 'github', name: 'Source Check', summary: '检查文稿中的事实陈述、来源完整性和相互矛盾的引用。', author: 'Aster Lab', installSlug: 'source-check', downloads: 408, latestVersion: '0.9.4', tags: ['事实核查', '引用'], createdAt: new Date(now - 6 * day).toISOString(), updatedAt: new Date(now - 5 * day).toISOString(), githubRepoUrl: 'https://github.com/example/source-check', readme: '# Source Check\n\n选中文稿后运行该 Skill。' },
  { id: 'glass-theme', type: 'theme', source: 'zip', name: 'Slate Paper', summary: '克制的冷灰纸面主题，适合高密度阅读和长时间写作。', author: 'Noon Design', installSlug: 'slate-paper', downloads: 377, latestVersion: '1.0.5', tags: ['冷灰', '阅读'], createdAt: new Date(now - 12 * day).toISOString(), updatedAt: new Date(now - 6 * day).toISOString(), readme: '# Slate Paper\n\n一套遵循 Genesis 双轴主题契约的设计语言。' },
  { id: 'calendar-tools', type: 'plugin', source: 'github', name: 'Calendar Tools', summary: '为 Agent 提供日程读取、空闲时间查询与事件草拟工具。', author: 'Northbound', installSlug: 'calendar-tools', downloads: 291, latestVersion: '1.3.1', tags: ['日历', '自动化'], createdAt: new Date(now - 10 * day).toISOString(), updatedAt: new Date(now - 7 * day).toISOString(), githubRepoUrl: 'https://github.com/example/calendar-tools', readme: '# Calendar Tools\n\n为自动化流程提供日历工具。' },
  { id: 'daily-review', type: 'skill', source: 'zip', name: 'Daily Review', summary: '回顾当天的会话、任务和笔记，生成一份可继续编辑的日总结。', author: 'Yue Zhou', installSlug: 'daily-review', downloads: 184, latestVersion: '1.1.0', tags: ['复盘', '效率'], createdAt: new Date(now - 4 * day).toISOString(), updatedAt: new Date(now - 4 * day).toISOString(), readme: '# Daily Review\n\n每天结束时运行，整理当天的工作。' },
]

const installed: Record<string, Array<{ slug: string; version: string | null }>> = {
  'amadeus-plugin': [{ slug: 'latex-suite', version: '1.3.0' }],
  skill: [{ slug: 'daily-review', version: '1.1.0' }],
}

const bridge = {
  platform: 'darwin',
  marketList: async (type?: string): Promise<{ items: MarketCard[] }> => ({ items: rows.filter((row) => !type || row.type === type).map(({ readme: _readme, githubRepoUrl: _repo, ...card }) => card) }),
  marketDetail: async (id: string): Promise<MarketDetail> => rows.find((row) => row.id === id)!,
  marketInstalled: async () => installed,
  marketInstall: async (id: string) => {
    const row = rows.find((item) => item.id === id)!
    const pool = installed[row.type] ||= []
    const hit = pool.find((item) => item.slug === row.installSlug)
    if (hit) hit.version = row.latestVersion || null
    else pool.push({ slug: row.installSlug, version: row.latestVersion || null })
    return { ok: true, path: `/harness/${row.installSlug}`, files: 3, type: row.type, slug: row.installSlug }
  },
  openAccountCenter: async () => ({ ok: true }),
}

;(window as unknown as { tangu: typeof bridge }).tangu = bridge
document.documentElement.dataset.platform = 'mac'

