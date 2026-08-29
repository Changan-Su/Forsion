/** 商店 UI 专项台架:只提供 MarketModal 用到的桌面桥,不读真实账号、网络或用户目录。 */
import type { MarketCard, MarketDetail } from './types'

// 卡片图标:两枚内联 PNG(投稿包 icon.png 的替身)+ 一个必然 404 的地址,
// 台架里同时覆盖「有图 / 无图 / 图挂了要回落字形」三态。
const ICON_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAFBElEQVR42u2dL3IiQRSHUzUiAhHBJXKEKRSGI3AFBDIiAoFYDhCJicwBcgWqNhIbkQNgEAhkxG531aOKZYfAMD3T3e994mdSAWbe+7qn+/3puRv8+n2H7AojAID6m+w5PToNncZOE6cnp5nTXDSTv03kf4bymR4A5KPCqXSaOi2dVk4bpz8NtZHvWsp3l/JbAJCA/EhdiIO+Azj7Wn3Lby7kGgCgw1Hup+g3p12HDr+knVzTOLfZIaeR/uq0T8jp57SXax0CQPPR7p+56wycfk5ruYcCAK7Xg6zMtxk7/lRbuacHADivezHSXpHjqx4Pc7lXADjSNNCWLRdt5J7NA+AXSh+GHH+qj9iLxZgLvBfDjj/VS6yFYgznj5w+cfp/+hTbqAZgjqMvaq4RgL7TO869Wu9iMxUA+OTJF06trS+xXdYAjDtO0mjTt9gwSwCmODCYprkB8IzTgus5FwBmOKs1zVIHgJGf2UzAM9/4miDkah/HdKtxKgCUbPWibRHL2AD0CfJEDxb1YwJAeDeNsHEUAEjsKEggNUnpYvi0NOoKgIJ8frL1BEUXAFDJk3ZlUasADDFy8hq2CcAHBs6i0LQVAAj1KgwV12na2GDYrPoO7kMCwJ5faWzg2l69PQbNsg3tIQQAjH7Fs8A1QZ8thsy6K7loAgArf+U7gksArDFg9lrfCgBRPwPRwZ8AeMVwavRaF4CCrZ+6LWFRBwCKPI0UkZ4D4A2DqdNbHQB2GEyddtcCwOrf0G6gCoAFhlKrxTUArDCUWq0uAVDQ5aO+m6j4CYASI6lX+RMAJH+MJYdOAVhiIPVa/gQAC0BjC8FTACj8tFEwWglAD+OYUa8KgEcMY0aPVQAQAjYYEiYFbDw1fAzABMOY0aQKgCcMY0ZPVQBwwqcdzaoAoAPIYMcQAAAAjwAeASwCWQSyDWQbSCDIeCCIULDxUDDJIOPJINLBxtPBFIQYLwihJIySMIpCrReFUhZuvCycxhDjjSG0hhlvDWMhaLw5lPZw2sMJCVsIAQ84Isacrj4ihkOidKrWIVGkhhWngAccFGlOtQ+K5KhYXap9VCy7AeWr/wHHxZvRzcfFkxxSmPwZ8MoYU2r8yhg6hpR0AA14bZzJrV+Q18YxCygd/QNeHau68DPoq2PZESha+Q94fbxqtfb6eKKDmUf9QgDg9YKRk9VLXX/eAoAPLHxi7OT0eSnoEwoArxEGT06jW3x5KwDEBjLc84cGwOsd40fXexMfNgWg7/SFE6LpS3wQDYBDOxndRHG6fMqm/gsBAEWkCRV5xgKAUHGiod4uAfB6xjmt6zmkz0IDwImj7WoW2l9tAMBMkMHIbxsA1gSJPvO7BOCwO2CL2GyrN27TR20DcIgTECy6LchTtu2fLgA4RAwJG9cL7/a78E1XAJBA6iCxkwMAh1Qy9QTV+fxR1/6IAcChqITKon8reYoYvogFwHGNoeVC04+6NXzaADiOGVjqO9i0ubfPEYBD88lceRvaXu7xPhW7pwTAcS/iXFlX8lbu6SE1e6cIwPFC0U+TOR9SsZZ7KFK1c8oAnC4WXzN5POzlWoc52DYXAI5nBR8b92fepXSY5U6uaZzyaNcAQNXM4M+/XXWcdPqW31zkMtK1AnA6O5TyzF2KgzaBtmwr+c6p/EahxW6aADgn/4asRxmpfor2b818kuqauWgmf5vI/wzlMz3t9rEAAAIAdE5/AQxzQ6+9vRvaAAAAAElFTkSuQmCC'
const ICON_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAFAUlEQVR42u2dL3IiQRSHt2pEBCKCS+QIU6swHIErIJAREQgMB0BiInOAXAERiR2RA2AiEMiI3e6qRxXLDoFheqa73/vEz6QCzLz3dU/3+9Pzq1r9/oXsCiMAgPqbHDg9OY2cJk5Tp2enudNCNJe/TeV/RvKZAQDko8KpdJo5rZ02TjunPy21k+9ay3eX8lsAkID8SF2Kg74DOPtWfctvLuUaAKDHUe6n6DenfY8Ov6a9XNMkt9khp5H+6nRIyOmXdJBrHQFA+9Hun7nbDJx+SVu5hwIAbtejrMy/Mnb8ub7knh4B4LIexEgHRY6vezws5F4B4ESzQFu2XLSTezYPgF8ofRhy/Lk+Yi8WYy7wVoYdf65VrIViDOePnSqc/p8qsY1qABY4+qoWGgEYOr3j3Jv1LjZTAYBPnnzi1Mb6FNtlDcCk5ySNNn2LDbMEYIYDg2mWGwAvOC24XnIBYI6zOtM8dQAY+ZnNBDzzja8JQq72cUy/mqQCQMlWL9oWsYwNwJAgT/Rg0TAmAIR30wgbRwGAxI6CBFKblC6GT0vjvgAoyOcnW09Q9AEAlTxpVxZ1CsAIIyevUZcAfGDgLApNOwGAUK/CUHGTpo0dhs2q7+AhJADs+ZXGBm7t1Ttg0Czb0B5DAMDoVzwL3BL0+cKQWXclF20AYOWvfEdwDYAtBsxe23sBIOpnIDr4EwCvGE6NXpsCULD1U7clLJoAQJGnkSLSSwC8YTB1emsCwB6DqdP+VgBY/RvaDdQBsMRQarW8BYANhlKrzTUACrp81HcTFT8BUGIk9Sp/AoDkj7Hk0DkAawykXuufAGABaGwheA4AhZ82CkZrARhgHDMa1AHwhGHM6KkOAELABkPCpICNp4ZPAZhiGDOa1gHwjGHM6LkOAE74tKN5HQB0ABnsGAIAAOARwCOARSCLQLaBbAMJBBkPBBEKNh4KJhlkPBlEOth4OpiCEOMFIZSEURJGUaj1olDKwo2XhdMYYrwxhNYw461hLASNN4fSHk57OCFhCyHgiiNizOnmI2I4JEqnGh0SRWpYcQq44qBIc2p8UCRHxepS46Ni2Q0oX/1XHBdvRncfF09ySGHyp+KVMabU+pUxdAwp6QCqeG2cya1fkNfGMQsoHf0Vr45VXfgZ9NWx7AgUrfwrXh+vWp29Pp7oYOZRvxAAeK0wcrJaNfXnPQD4wEKFsZNTdS3oEwoArzEGT07je3x5LwDEBjLc84cGwOsd40fXexsftgVg6PSJE6LpU3wQDYBjOxndRHG6fMq2/gsBAEWkCRV5xgKAUHGiod4+AfB6wTmd6yWkz0IDwImj3Woe2l9dAMBMkMHI7xoA1gSJPvP7BOC4O2CL2G6rN+nSR10DcIwTECy6L8hTdu2fPgA4RgwJGzcL7w778E1fAJBA6iGxkwMAx1Qy9QT1+fxx3/6IAcCxqITKon8reYoYvogFwGmNoeVC04+mNXzaADiNGVjqO9h1ubfPEYBj88lCeRvaQe7xIRW7pwTAaS/iQllX8pfc02Nq9k4RgNOFop8mcz6kYiv3UKRq55QBOF8svmbyeDjItY5ysG0uAJzOCj427s+8S+kwy71c0yTl0a4BgLqZwZ9/u+k56fQtv7nMZaRrBeB8dijlmbsWB+0Cbdk28p0z+Y1Ci900AXBJ/g1ZTzJS/RTt35r5LNU1C9Fc/jaV/xnJZwba7WMBAAQA6JL+ArFsBCcScFCwAAAAAElFTkSuQmCC'
// 解码不了的 data URI(不是网络 404):同样触发 <img onError>,但不产生网络层 console 报错,免得污染台架的 error 断言。
const ICON_BROKEN = 'data:image/png;base64,QUJD'

const now = Date.now()
const day = 86_400_000
const rows: MarketDetail[] = [
  { id: 'latex-suite', type: 'amadeus-plugin', source: 'github', name: 'LaTeX Suite', iconUrl: ICON_A, summary: '在笔记中补全公式、跳转占位符，并提供结构化数学编辑工具。', author: 'Forsion Labs', installSlug: 'latex-suite', downloads: 1847, latestVersion: '1.4.2', tags: ['数学', '写作', 'Amadeus'], createdAt: new Date(now - 42 * day).toISOString(), updatedAt: new Date(now - day).toISOString(), githubRepoUrl: 'https://github.com/example/latex-suite', readme: '# LaTeX Suite\n\n为数学、研究与技术写作准备的编辑增强。\n\n## 主要能力\n\n- 公式环境补全\n- 占位符导航\n- 行内与块级数学输入\n\n## 使用方式\n\n安装后在任意 Amadeus 页面输入数学内容即可。' },
  { id: 'research-agent', type: 'agent', source: 'zip', name: 'Research Companion', summary: '整理资料、对照来源并把研究过程沉淀为可继续工作的笔记。', author: 'Lin Chen', installSlug: 'research-companion', downloads: 963, latestVersion: '2.1.0', tags: ['研究', '资料整理'], createdAt: new Date(now - 18 * day).toISOString(), updatedAt: new Date(now - 2 * day).toISOString(), readme: '# Research Companion\n\n适合长周期研究任务的 Agent。' },
  { id: 'mindmap', type: 'amadeus-plugin', source: 'github', name: 'Mindmap', iconUrl: ICON_B, summary: '把页面块组织成可编辑的思维导图，并保留与原文的双向联系。', author: 'Forsion Community', installSlug: 'mindmap', downloads: 742, latestVersion: '1.8.3', tags: ['可视化', '知识管理'], createdAt: new Date(now - 30 * day).toISOString(), updatedAt: new Date(now - 3 * day).toISOString(), githubRepoUrl: 'https://github.com/example/mindmap', readme: '# Mindmap\n\n从现有笔记创建可继续编辑的思维导图。' },
  { id: 'writing-space', type: 'space', source: 'zip', name: 'Longform Writing', summary: '为长文写作准备的三栏空间，组合资料、正文与对话助手。', author: 'Mori Studio', installSlug: 'longform-writing', downloads: 516, latestVersion: '1.2.0', tags: ['写作', 'Space'], createdAt: new Date(now - 8 * day).toISOString(), updatedAt: new Date(now - 4 * day).toISOString(), readme: '# Longform Writing\n\n安装后会在功能栏中增加一个写作空间。' },
  { id: 'source-check', type: 'skill', source: 'github', name: 'Source Check', iconUrl: ICON_BROKEN, summary: '检查文稿中的事实陈述、来源完整性和相互矛盾的引用。', author: 'Aster Lab', installSlug: 'source-check', downloads: 408, latestVersion: '0.9.4', tags: ['事实核查', '引用'], createdAt: new Date(now - 6 * day).toISOString(), updatedAt: new Date(now - 5 * day).toISOString(), githubRepoUrl: 'https://github.com/example/source-check', readme: '# Source Check\n\n选中文稿后运行该 Skill。' },
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
  marketUninstall: async (type: string, slug: string) => {
    const pool = installed[type] ||= []
    const i = pool.findIndex((item) => item.slug === slug)
    if (i < 0) throw new Error('该项不在已安装目录中') // 与主进程同口径:找不到即报错,不静默成功
    pool.splice(i, 1)
    return { ok: true, path: `/harness/${slug}`, type }
  },
  openAccountCenter: async () => ({ ok: true }),
}

;(window as unknown as { tangu: typeof bridge }).tangu = bridge
document.documentElement.dataset.platform = 'mac'

