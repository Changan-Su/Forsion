// Tangu Desktop × Lovable — re-skin study data.
// Tangu Desktop is fully token-driven: every component reads one CSS-var contract.
// Re-skinning to Lovable = remapping that contract to Lovable's values. The map below
// IS the re-skin mechanism (and the "component structure" foundation). Mirrored in tangu.css.

export type TokenRow = { name: string; value: string; role: string; swatch?: boolean }

/** Lovable values mapped onto Tangu's token contract (light only — Lovable is a light paper design). */
export const tokenMap: TokenRow[] = [
  // surfaces
  { name: '--bg', value: '#f7f4ed', role: '页面奶油底（非纯白）', swatch: true },
  { name: '--bg-card', value: '#f7f4ed', role: '卡＝页同色，靠边框分隔', swatch: true },
  { name: '--bg-glass', value: 'rgba(247,244,237,0.9)', role: '浮层（Lovable 不用玻璃）' },
  { name: '--sidebar-bg', value: '#f2eee5', role: '侧栏，比页底深一档', swatch: true },
  // text — all derived from charcoal opacity
  { name: '--text', value: '#1c1c1c', role: '正文/标题（炭黑，非纯黑）', swatch: true },
  { name: '--text-light', value: 'rgba(28,28,28,0.82)', role: '次要文字' },
  { name: '--text-muted', value: '#5f5f5d', role: '描述/caption' },
  { name: '--text-faint', value: 'rgba(28,28,28,0.4)', role: '弱文字/交互边界' },
  { name: '--text-ghost', value: 'rgba(28,28,28,0.28)', role: '最淡/占位' },
  // borders & shadow (borders over shadows)
  { name: '--border', value: '#eceae4', role: '暖中性被动边框', swatch: true },
  { name: '--border-width', value: '1px', role: '边框宽度（Tangu 原 0.5px）' },
  { name: '--shadow', value: 'rgba(0,0,0,0.06)', role: '极浅，几乎不用' },
  // accent = charcoal (Lovable has no saturated accent)
  { name: '--accent', value: '#1c1c1c', role: '强调＝炭黑（单色）', swatch: true },
  { name: '--accent-hover', value: '#000000', role: '强调 hover' },
  { name: '--accent-light', value: 'rgba(28,28,28,0.05)', role: '激活底/工具染色' },
  { name: '--accent-rgb', value: '28,28,28', role: 'rgba 拼装用' },
  // status — kept warm & muted (no bright saturation)
  { name: '--green', value: '#4f6f52', role: '成功（柔哑沙绿）', swatch: true },
  { name: '--danger', value: '#a3503f', role: '危险（暖陶土，不刺）', swatch: true },
  { name: '--danger-light', value: 'rgba(163,80,63,0.08)', role: '危险底' },
  // overlays — Tangu already uses charcoal-opacity = exactly Lovable's gray model
  { name: '--overlay-subtle', value: 'rgba(28,28,28,0.03)', role: '微浮层' },
  { name: '--overlay-light', value: 'rgba(28,28,28,0.04)', role: 'hover 底' },
  { name: '--overlay-medium', value: 'rgba(28,28,28,0.07)', role: '激活底' },
  { name: '--overlay-strong', value: 'rgba(28,28,28,0.14)', role: '强浮层' },
  // radii — bumped to Lovable's comfortable scale
  { name: '--radius-sm', value: '6px', role: '按钮/输入' },
  { name: '--radius-md', value: '8px', role: '紧凑卡' },
  { name: '--radius-lg', value: '12px', role: '标准卡' },
  { name: '--radius-chat-surface', value: '12px', role: '输入合成器面板' },
  { name: '--radius-chat-card', value: '10px', role: '消息气泡' },
  // type — Camera Plain is proprietary → humanist substitute
  { name: '--font-ui', value: "'Hanken Grotesk', ui-sans-serif, system-ui", role: 'UI 字（Camera Plain 替身）' },
  { name: '--font-body', value: "'Hanken Grotesk', ui-sans-serif, system-ui", role: '正文（单一人文字体）' },
  { name: '--font-mono', value: "ui-monospace, 'SF Mono', Menlo, monospace", role: '等宽' },
  // component-semantic
  { name: '--user-bg', value: 'rgba(28,28,28,0.04)', role: '用户气泡（炭染，非蓝）' },
  { name: '--tool-bg', value: 'rgba(28,28,28,0.03)', role: '工具卡底' },
  { name: '--tool-text', value: '#5f5f5d', role: '工具卡文字' },
  { name: '--panel-blur', value: 'none', role: 'Lovable 扁平无玻璃' },
  // motion (kept from Tangu)
  { name: '--duration-instant', value: '0.1s', role: '即时' },
  { name: '--duration-fast', value: '0.15s', role: '快' },
  { name: '--duration-slow', value: '0.25s', role: '慢' },
  { name: '--ease-out', value: 'cubic-bezier(0.16,1,0.3,1)', role: '缓出' },
]

/** Selectable skins on the preview page — each is a different palette mapped onto the same contract. */
export type Skin = { id: 'lovable' | 'echo' | 'qbird' | 'custom'; label: string; note: string; chips: string[] }
export const SKINS: Skin[] = [
  { id: 'lovable', label: 'Lovable', note: '奶油纸感 · 单色', chips: ['Parchment #f7f4ed', 'Charcoal #1c1c1c', '柔阴影代线条', 'Pill 按钮'] },
  { id: 'echo', label: 'Echo', note: '珊瑚/薰衣草 · 圆润', chips: ['珊瑚 #ff8a6b', '薰衣草 tool 染', 'Nunito 圆体', '大圆角 18–20'] },
  { id: 'qbird', label: 'Qbird', note: '石墨 · 柔青', chips: ['Apple 石墨 #f5f5f7', '柔青 #4d8794', '系统字 HIG', '低饱和软影'] },
  { id: 'custom', label: '自定义', note: '取色 · 自适应', chips: ['自定义强调色', '背景氛围微染', '中性石墨底', '明暗自适应'] },
]

/* ── custom skin: derive accent family + background ambiance from one seed color (neutrals/text come from the CSS base). ── */
/* ponytail: tiny hex-mix helpers duplicated from tanguSoftData (8 lines) rather than spinning up a shared util module. */
type RGB = [number, number, number]
function hexToRgb(hex: string): RGB {
  const m = hex.replace('#', '')
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  return [parseInt(n.slice(0, 2), 16) || 0, parseInt(n.slice(2, 4), 16) || 0, parseInt(n.slice(4, 6), 16) || 0]
}
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
/** Blend color c toward t by k (k=1 → t). Returns an rgb() string. */
function mix(c: RGB, t: RGB, k: number): string {
  return `rgb(${clamp(c[0] + (t[0] - c[0]) * k)}, ${clamp(c[1] + (t[1] - c[1]) * k)}, ${clamp(c[2] + (t[2] - c[2]) * k)})`
}

/** Accent + ambiance vars from a seed color (applied inline on the custom skin); neutrals stay from the CSS base. Pure. */
export function customSkinVars(color: string, dark: boolean, bg?: string): Record<string, string> {
  const [r, g, b] = hexToRgb(color)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const onAccent = lum < 0.62 ? '#ffffff' : '#161018'
  const c: RGB = [r, g, b]
  const rgb = `${r},${g},${b}`
  const bc: RGB = bg ? hexToRgb(bg) : c
  if (dark) {
    return {
      '--accent': color,
      // 可读强调色(与 theme/lcl/lovableData.ts 保持同步):前景场景用,过深在暗底提亮,正常色恒等。
      '--accent-ink': lum < 0.35 ? mix(c, [255, 255, 255], 0.5) : color,
      '--accent-hover': mix(c, [255, 255, 255], 0.18),
      '--accent-light': `rgba(${rgb},0.16)`,
      '--accent-rgb': rgb,
      '--on-accent': onAccent,
      '--user-bg': `rgba(${rgb},0.16)`,
      '--bg': bg ? mix(bc, [26, 26, 28], 0.88) : mix(c, [26, 26, 28], 0.93), // graphite faintly tinted by the (bg) seed
      '--sidebar-bg': bg ? mix(bc, [33, 33, 36], 0.88) : mix(c, [33, 33, 36], 0.92),
      '--bg-card': bg ? mix(bc, [41, 41, 44], 0.88) : mix(c, [41, 41, 44], 0.94),
    }
  }
  return {
    '--accent': color,
    // 同上:过浅 seed 在亮底压深(选中文字/高亮可读)。
    '--accent-ink': lum > 0.72 ? mix(c, [0, 0, 0], 0.5) : color,
    '--accent-hover': mix(c, [0, 0, 0], 0.14),
    '--accent-light': `rgba(${rgb},0.10)`,
    '--accent-rgb': rgb,
    '--on-accent': onAccent,
    '--user-bg': `rgba(${rgb},0.10)`,
    '--bg': bg || mix(c, [246, 246, 247], 0.96), // near-white with a hint of the seed; 显式背景 seed 原色直用
    '--sidebar-bg': bg ? mix(bc, [0, 0, 0], 0.03) : mix(c, [238, 238, 240], 0.94),
    '--bg-card': bg ? mix(bc, [255, 255, 255], 0.55) : mix(c, [252, 252, 253], 0.975),
  }
}

/** Authoritative list of the token-contract keys Tangu components consume (must all be mapped). */
export const TANGU_CONTRACT: string[] = [
  '--bg', '--bg-card', '--bg-glass', '--sidebar-bg',
  '--text', '--text-light', '--text-muted', '--text-faint', '--text-ghost',
  '--border', '--border-width', '--shadow',
  '--accent', '--accent-hover', '--accent-light', '--accent-rgb',
  '--green', '--danger', '--danger-light',
  '--overlay-subtle', '--overlay-light', '--overlay-medium', '--overlay-strong',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-chat-surface', '--radius-chat-card',
  '--font-ui', '--font-body', '--font-mono',
  '--user-bg', '--tool-bg', '--tool-text', '--panel-blur',
  '--duration-instant', '--duration-fast', '--duration-slow', '--ease-out',
]

/** Contract keys with no Lovable mapping — must be empty (else a component renders unstyled). Pure. */
export function missingTokens(): string[] {
  const mapped = new Set(tokenMap.map((t) => t.name))
  return TANGU_CONTRACT.filter((k) => !mapped.has(k))
}

/** Component tree of Tangu Desktop's main screen (for the "组件结构" section). */
export type TreeNode = { d: number; name: string; role: string }
export const componentTree: TreeNode[] = [
  { d: 0, name: 'App', role: '主窗壳 · 状态/事件路由' },
  { d: 1, name: 'Sidebar', role: '会话列表 · 工作区分组 · 账户' },
  { d: 1, name: 'main', role: '右侧主区' },
  { d: 2, name: 'ChatHeader', role: '拖拽条 · 标题 · 连接态 · 明暗/语言' },
  { d: 2, name: 'ChatArea', role: '消息流（max-width 760）' },
  { d: 3, name: 'msg-row.user', role: '用户气泡（右，max 80%）' },
  { d: 3, name: 'msg-row.assistant', role: 'TANGU 角色徽章 + 内容列' },
  { d: 4, name: 'ThinkingBlock', role: '可折叠思考（左线 + Sparkles）' },
  { d: 4, name: 'ToolCallCard', role: '工具调用（名/参数/结果/状态）' },
  { d: 4, name: 'ApprovalCard', role: '执行审批（批准/总是/拒绝）' },
  { d: 4, name: 'PlanCard / TodoList', role: '计划提案 / 待办清单' },
  { d: 4, name: 'InquiryCard', role: '反问（选项 + 输入）' },
  { d: 4, name: 'Markdown', role: '正文（msg-content）' },
  { d: 3, name: 'msg-row.system', role: 'GroupVoteChip / 居中分隔' },
  { d: 2, name: 'MessageInput', role: '合成器' },
  { d: 3, name: 'composer-box', role: '引用卡 · 附件 chip · textarea · +/mic/发送' },
  { d: 3, name: 'composer-actions', role: 'mode chip · ctx 进度 · ModelPill' },
  { d: 2, name: 'RightPanel', role: 'Workspace / 目录 / 记忆 三标签' },
]
