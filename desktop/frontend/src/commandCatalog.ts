/* eslint-disable */
// ⚠️ 自动生成,勿手改。正典 = Forsion-Genesis/tangu-agent/src/core/commandCatalog.ts
// 改那边后跑 `cd ../tangu-agent && npm run sync:commands`;两侧 typecheck 都会 --check 拦漂移。
/**
 * Slash 命令目录 —— TUI 与 Desktop 输入框的**唯一真源**。
 *
 * 改造前两侧各写各的列表(TUI 34 条 / Desktop 11 条),漂移是必然的:同一个功能在两端叫法不同、
 * 或者干脆只有一端有。现在名字/描述/参数提示集中在此,两端各自绑自己的 handler:
 *   - TUI:    src/tui/commands.ts 按 surfaces 过滤后喂 /help 与 Tab 补全
 *   - Desktop: frontend/src/commandCatalog.ts(本文件的**同步拷贝**,勿手改)
 *   - Channel: src/channels/commands.ts 按 surfaces 过滤后喂通道 /help 与分发(微信 / Telegram / QQ)
 *
 * 同步:`npm run sync:commands`;`--check` 挂在两侧 typecheck 上,漂移即 CI 红。
 *
 * ⚠️ 本文件必须**零 import**(纯数据)—— 它要被 Desktop 前端逐字节拷走,带依赖就搬不动。
 *
 * 用户自定义命令(~/.tangu/commands/*.md)不在此表:那是运行时发现的,见 services/customCommands.ts。
 */

/** 命令露出的界面。几端都有的写全,单端专属的只写一个。channel = 微信 / Telegram / QQ 通道(纯文本,无按钮)。 */
export type CommandSurface = 'tui' | 'desktop' | 'channel';

export interface CommandSpec {
  /** 含前导斜杠的命令名。 */
  name: string;
  /** Desktop 的 i18n key(`input.slash.<key>`);TUI 不走 i18n,直接用 zh。 */
  key: string;
  zh: string;
  en: string;
  /** 参数提示,如 `<id>`;无参省略。 */
  arg?: string;
  surfaces: CommandSurface[];
  /** 同义词(补全命中即映射到 name)。 */
  aliases?: string[];
}

export const COMMAND_CATALOG: CommandSpec[] = [
  // ── 会话 ──────────────────────────────────────────────────────────────
  { name: '/help', key: 'help', zh: '显示帮助与命令列表', en: 'Show help and the command list', surfaces: ['tui', 'desktop', 'channel'] },
  { name: '/feedback', key: 'feedback', zh: '提交问题或建议，可在命令后填写反馈内容', en: 'Report an issue or suggestion; optionally add your feedback after the command', surfaces: ['desktop'] },
  { name: '/new', key: 'new', zh: '开始新会话', en: 'Start a new session', surfaces: ['tui', 'desktop', 'channel'] },
  { name: '/clear', key: 'clear', zh: '清屏（保留会话历史）', en: 'Clear the screen (history is kept)', surfaces: ['tui'] },
  { name: '/sessions', key: 'sessions', aliases: ['/list'], zh: '列出最近会话', en: 'List recent sessions', surfaces: ['tui', 'desktop', 'channel'] },
  { name: '/resume', key: 'resume', aliases: ['/switch'], zh: '恢复会话并续聊', en: 'Resume a session and continue', arg: '<id|序号>', surfaces: ['tui', 'channel'] },
  { name: '/rename', key: 'rename', arg: '<标题>', zh: '重命名本会话', en: 'Rename this session', surfaces: ['tui'] },
  {
    name: '/branch', key: 'branch', arg: '[序号]', aliases: ['/fork'],
    zh: '从某条回复后分支新会话（继承历史），缺省最近',
    en: 'Branch a new session from a reply (inherits history); defaults to the latest',
    surfaces: ['tui', 'desktop'],
  },
  {
    name: '/btw', key: 'btw', arg: '[问题]', aliases: ['/side'],
    zh: '顺便问一句：带着本会话上下文旁聊，不进主对话、不打断正在跑的任务',
    en: 'Ask a side question with this session as context; not added to the conversation and never interrupts a running task',
    surfaces: ['desktop'],
  },
  {
    name: '/compact', key: 'compact', arg: '[关注点]',
    zh: '压缩上下文：总结后精简续接（同会话；可附本次摘要的关注点）',
    en: 'Compact context: summarize, then continue compactly (optional focus for this summary)',
    surfaces: ['tui', 'desktop', 'channel'],
  },
  {
    name: '/status', key: 'status',
    zh: '本会话概况：模型 / 思考档 / 审批档 / 工作目录 / 用量',
    en: 'Session overview: model, thinking level, approval mode, cwd, usage',
    surfaces: ['tui', 'desktop', 'channel'],
  },
  { name: '/export', key: 'export', zh: '导出本会话为 Markdown', en: 'Export this session as Markdown', surfaces: ['tui', 'desktop'] },
  { name: '/cost', key: 'cost', zh: '本会话 token 用量与费用', en: 'Token usage and cost for this session', surfaces: ['tui', 'desktop', 'channel'] },
  { name: '/diff', key: 'diff', zh: '查看工作目录的 git 改动（含未跟踪文件）', en: 'Show git changes in the working directory (including untracked files)', surfaces: ['tui'] },
  { name: '/copy', key: 'copy', zh: '复制上一条回复到剪贴板', en: 'Copy the last reply to the clipboard', surfaces: ['tui', 'desktop'] },
  { name: '/retry', key: 'retry', zh: '重跑上一条用户消息', en: 'Re-run the last user message', surfaces: ['tui', 'desktop'] },
  { name: '/edit', key: 'edit', zh: '编辑最近一条消息并重跑（$EDITOR）', en: 'Edit the last message and re-run ($EDITOR)', surfaces: ['tui'] },
  { name: '/delete', key: 'delete', zh: '删除最近一轮对话', en: 'Delete the last turn', surfaces: ['tui'] },
  { name: '/stop', key: 'stop', zh: '停止当前运行', en: 'Stop the current run', surfaces: ['desktop', 'channel'] },

  // ── 运行配置 ──────────────────────────────────────────────────────────
  { name: '/model', key: 'model', arg: '[名称|序号]', zh: '切换模型（不带参数列出可选模型）', en: 'Switch model (no argument lists the available models)', surfaces: ['tui', 'desktop', 'channel'] },
  {
    name: '/think', key: 'think', arg: '<档位>', aliases: ['/effort'],
    zh: '思考强度：off|minimal|low|medium|high|xhigh|max（模型不支持的档自动降档）',
    en: 'Thinking level: off|minimal|low|medium|high|xhigh|max (auto-clamped to what the model supports)',
    surfaces: ['tui', 'desktop', 'channel'],
  },
  { name: '/approval', key: 'approval', arg: '<档位>', aliases: ['/permissions'], zh: '查看或切换审批档：readonly|auto-edit|full-auto|custom', en: 'Show or switch the approval mode: readonly|auto-edit|full-auto|custom', surfaces: ['tui', 'desktop', 'channel'] },
  { name: '/loop', key: 'loop', arg: '<1-200>', zh: '最大循环轮数（默认 90；耗尽会提示）', en: 'Max loop iterations (default 90; you get a prompt when exhausted)', surfaces: ['tui', 'desktop', 'channel'] },
  { name: '/verify', key: 'verify', arg: '<命令|off>', zh: '本会话验证命令：收尾前自动跑，不绿不许收（off 关闭）', en: 'Session verify command — runs before the turn may end; must pass (off to clear)', surfaces: ['desktop'] },
  { name: '/plan', key: 'plan', zh: '切换计划模式：只读调研 → 提交计划求批准', en: 'Toggle plan mode: read-only research, then submit a plan for approval', surfaces: ['tui', 'desktop'] },
  { name: '/chat', key: 'chat', zh: '切到 Chat 模式（轻量：答完即停、临时工作区、不写笔记；侧栏只列聊天会话，新会话按此模式创建，已创建的会话不可切换）', en: 'Switch to Chat mode (light: answers and stops, temporary workspace, never writes your notes; the sidebar lists chat sessions only, new sessions use it, existing sessions are fixed)', surfaces: ['desktop'] },
  { name: '/work', key: 'work', zh: '切到 Work 模式（完整工具面：文件、命令、技能、子代理；侧栏列出全部项目）', en: 'Switch to Work mode (full toolset: files, commands, skills, subagents; the sidebar lists all projects)', surfaces: ['desktop'] },
  { name: '/voice', key: 'voice', zh: '切到语音消息（该 Agent 回复变语音）', en: 'Switch to voice messages (this agent replies as voice)', surfaces: ['desktop', 'channel'] },
  { name: '/text', key: 'text', zh: '切回文字消息', en: 'Switch back to text messages', surfaces: ['channel'] },
  { name: '/cwd', key: 'cwd', arg: '[path]', zh: '查看或切换工作目录', en: 'Show or change the working directory', surfaces: ['tui'] },
  { name: '/config', key: 'config', zh: '查看当前设置', en: 'Show current settings', surfaces: ['tui', 'desktop'] },
  { name: '/login', key: 'login', zh: '重新登录 Forsion', en: 'Sign in to Forsion again', surfaces: ['tui', 'desktop'] },
  { name: '/hotkeys', key: 'hotkeys', zh: '查看快捷键', en: 'Show keyboard shortcuts', surfaces: ['tui'] },
  { name: '/exit', key: 'exit', zh: '退出 Tangu', en: 'Quit Tangu', surfaces: ['tui'] },

  // ── 能力面 ────────────────────────────────────────────────────────────
  { name: '/tools', key: 'tools', zh: '列出当前模式可用工具', en: 'List tools available in the current mode', surfaces: ['tui', 'desktop'] },
  { name: '/skills', key: 'skills', zh: '列出可用技能（✓=本会话启用）', en: 'List available skills (✓ = enabled for this session)', surfaces: ['tui', 'desktop'] },
  { name: '/skill', key: 'skill', arg: '<id>', zh: '启用/停用技能', en: 'Enable or disable a skill', surfaces: ['tui'] },
  { name: '/agents', key: 'agents', zh: '列出本地 Normal Agent（自定义人格）', en: 'List local normal agents (custom personas)', surfaces: ['tui', 'desktop', 'channel'] },
  { name: '/agent', key: 'agent', arg: '<slug>', zh: '启用 Agent；管理：/agent new|edit|rm <slug>', en: 'Activate an agent; manage with /agent new|edit|rm <slug>', surfaces: ['tui', 'desktop', 'channel'] },
  { name: '/groupchat', key: 'groupchat', arg: '<slug…>', zh: '团队模式（/groupchat off 退出）', en: 'Team mode (/groupchat off to leave)', surfaces: ['tui', 'desktop'] },
  { name: '/historian', key: 'historian', zh: 'Historian 状态/活动；/historian on|off 开关', en: 'Historian status/activity; /historian on|off to toggle', surfaces: ['tui', 'desktop'] },
  { name: '/muse', key: 'muse', zh: 'Muse 状态/TODO；/muse on|off 开关', en: 'Muse status/TODOs; /muse on|off to toggle', surfaces: ['tui', 'desktop'] },
  { name: '/memory', key: 'memory', arg: '[edit]', zh: '查看/编辑长期记忆', en: 'View or edit long-term memory', surfaces: ['tui', 'desktop'] },
  { name: '/refine', key: 'refine', arg: '[focus]', zh: '复盘本会话，沉淀 Agent 的工作笔记（可回滚）', en: "Reflect on this conversation and refine the agent's working notes (reversible)", surfaces: ['tui', 'desktop'] },
  { name: '/log', key: 'log', arg: '[YYYY-MM-DD]', zh: '查看每日日志', en: 'View the daily log', surfaces: ['tui'] },
  { name: '/mcp', key: 'mcp', zh: '列出 MCP server 状态', en: 'List MCP server status', surfaces: ['tui', 'desktop'] },
  { name: '/plugins', key: 'plugins', zh: '列出已发现插件', en: 'List discovered plugins', surfaces: ['tui', 'desktop'] },
];

/**
 * 审批档展示文案(单源)。TUI 横幅 / 状态栏、通道回复、审批说明都从这里取;Desktop 药丸仍走 i18n 键,
 * 与这里逐字一致(改一处要连带改 desktop 的 approval.* 词条,文案重设计见 docs/ToBeImproved 审批档方案)。
 * id 是落盘值(会话 agent_config / agent config.toml / 通道绑定),**永不改名**。
 */
export type ApprovalModeId = 'readonly' | 'auto-edit' | 'full-auto' | 'custom';
export const APPROVAL_MODE_META: Record<ApprovalModeId, { zh: string; en: string; descZh: string; descEn: string }> = {
  readonly: { zh: '询问我批准', en: 'Ask for approval', descZh: '改文件、跑命令前都先问我', descEn: 'Asks before editing files or running commands' },
  'auto-edit': { zh: '替我批准', en: 'Approve for me', descZh: '工作区内直接改文件；跑命令、写工作区外才问我', descEn: 'Edits files in the workspace directly; asks before running commands or writing outside it' },
  'full-auto': { zh: '完全放行', en: 'Full access', descZh: '不再询问（受保护路径仍然拒绝）', descEn: 'Never asks (protected paths are still refused)' },
  custom: { zh: '自定义', en: 'Custom', descZh: '按 ~/.tangu/config.json 的 approval 规则判定', descEn: 'Decided by the approval rules in ~/.tangu/config.json' },
};
export const APPROVAL_MODE_IDS = Object.keys(APPROVAL_MODE_META) as ApprovalModeId[];

/** 某个界面该露出的命令(声明式过滤,两端不再各自维护清单)。 */
export function commandsFor(surface: CommandSurface): CommandSpec[] {
  return COMMAND_CATALOG.filter((c) => c.surfaces.includes(surface));
}

/** 把别名归一到正名(`/effort` → `/think`);不认识的原样返回。 */
export function canonicalCommandName(name: string): string {
  const n = name.toLowerCase();
  for (const c of COMMAND_CATALOG) {
    if (c.name === n) return c.name;
    if (c.aliases?.includes(n)) return c.name;
  }
  return name;
}
