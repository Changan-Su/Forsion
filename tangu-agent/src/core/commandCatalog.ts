/**
 * Slash 命令目录 —— TUI 与 Desktop 输入框的**唯一真源**。
 *
 * 改造前两侧各写各的列表(TUI 34 条 / Desktop 11 条),漂移是必然的:同一个功能在两端叫法不同、
 * 或者干脆只有一端有。现在名字/描述/参数提示集中在此,两端各自绑自己的 handler:
 *   - TUI:    src/tui/commands.ts 按 surfaces 过滤后喂 /help 与 Tab 补全
 *   - Desktop: frontend/src/commandCatalog.ts(本文件的**同步拷贝**,勿手改)
 *
 * 同步:`npm run sync:commands`;`--check` 挂在两侧 typecheck 上,漂移即 CI 红。
 *
 * ⚠️ 本文件必须**零 import**(纯数据)—— 它要被 Desktop 前端逐字节拷走,带依赖就搬不动。
 *
 * 用户自定义命令(~/.tangu/commands/*.md)不在此表:那是运行时发现的,见 services/customCommands.ts。
 */

/** 命令露出的界面。两端都有的写全,单端专属的只写一个。 */
export type CommandSurface = 'tui' | 'desktop';

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
  { name: '/help', key: 'help', zh: '显示帮助与命令列表', en: 'Show help and the command list', surfaces: ['tui', 'desktop'] },
  { name: '/new', key: 'new', zh: '开始新会话', en: 'Start a new session', surfaces: ['tui', 'desktop'] },
  { name: '/clear', key: 'clear', zh: '清屏（保留会话历史）', en: 'Clear the screen (history is kept)', surfaces: ['tui'] },
  { name: '/sessions', key: 'sessions', zh: '列出最近会话', en: 'List recent sessions', surfaces: ['tui', 'desktop'] },
  { name: '/resume', key: 'resume', zh: '恢复会话并续聊', en: 'Resume a session and continue', arg: '<id|序号>', surfaces: ['tui'] },
  {
    name: '/branch', key: 'branch', arg: '[序号]', aliases: ['/fork'],
    zh: '从某条回复后分支新会话（继承历史），缺省最近',
    en: 'Branch a new session from a reply (inherits history); defaults to the latest',
    surfaces: ['tui', 'desktop'],
  },
  { name: '/compact', key: 'compact', zh: '压缩上下文：总结后精简续接（同会话）', en: 'Compact context: summarize, then continue compactly', surfaces: ['tui', 'desktop'] },
  {
    name: '/status', key: 'status',
    zh: '本会话概况：模型 / 思考档 / 审批档 / 工作目录 / 用量',
    en: 'Session overview: model, thinking level, approval mode, cwd, usage',
    surfaces: ['tui', 'desktop'],
  },
  { name: '/export', key: 'export', zh: '导出本会话为 Markdown', en: 'Export this session as Markdown', surfaces: ['tui', 'desktop'] },
  { name: '/cost', key: 'cost', zh: '本会话 token 用量与费用', en: 'Token usage and cost for this session', surfaces: ['tui', 'desktop'] },
  { name: '/copy', key: 'copy', zh: '复制上一条回复到剪贴板', en: 'Copy the last reply to the clipboard', surfaces: ['tui', 'desktop'] },
  { name: '/retry', key: 'retry', zh: '重跑上一条用户消息', en: 'Re-run the last user message', surfaces: ['tui', 'desktop'] },
  { name: '/edit', key: 'edit', zh: '编辑最近一条消息并重跑（$EDITOR）', en: 'Edit the last message and re-run ($EDITOR)', surfaces: ['tui'] },
  { name: '/delete', key: 'delete', zh: '删除最近一轮对话', en: 'Delete the last turn', surfaces: ['tui'] },
  { name: '/stop', key: 'stop', zh: '停止当前运行', en: 'Stop the current run', surfaces: ['desktop'] },

  // ── 运行配置 ──────────────────────────────────────────────────────────
  { name: '/model', key: 'model', arg: '<id>', zh: '切换模型', en: 'Switch model', surfaces: ['tui', 'desktop'] },
  {
    name: '/think', key: 'think', arg: '<档位>', aliases: ['/effort'],
    zh: '思考强度：off|minimal|low|medium|high|xhigh|max（模型不支持的档自动降档）',
    en: 'Thinking level: off|minimal|low|medium|high|xhigh|max (auto-clamped to what the model supports)',
    surfaces: ['tui', 'desktop'],
  },
  { name: '/approval', key: 'approval', arg: '<档位>', zh: '切换审批档：readonly|auto-edit|full-auto', en: 'Switch approval mode: readonly|auto-edit|full-auto', surfaces: ['tui', 'desktop'] },
  { name: '/loop', key: 'loop', arg: '<1-200>', zh: '最大循环轮数（默认 90；耗尽会提示）', en: 'Max loop iterations (default 90; you get a prompt when exhausted)', surfaces: ['tui', 'desktop'] },
  { name: '/verify', key: 'verify', arg: '<命令|off>', zh: '本会话验证命令：收尾前自动跑，不绿不许收（off 关闭）', en: 'Session verify command — runs before the turn may end; must pass (off to clear)', surfaces: ['desktop'] },
  { name: '/plan', key: 'plan', zh: '切换计划模式：只读调研 → 提交计划求批准', en: 'Toggle plan mode: read-only research, then submit a plan for approval', surfaces: ['tui', 'desktop'] },
  { name: '/voice', key: 'voice', zh: '切到语音消息（该 Agent 回复变语音）', en: 'Switch to voice messages (this agent replies as voice)', surfaces: ['desktop'] },
  { name: '/cwd', key: 'cwd', arg: '[path]', zh: '查看或切换工作目录', en: 'Show or change the working directory', surfaces: ['tui'] },
  { name: '/config', key: 'config', zh: '查看当前设置', en: 'Show current settings', surfaces: ['tui', 'desktop'] },
  { name: '/login', key: 'login', zh: '重新登录 Forsion', en: 'Sign in to Forsion again', surfaces: ['tui', 'desktop'] },
  { name: '/exit', key: 'exit', zh: '退出 Tangu', en: 'Quit Tangu', surfaces: ['tui'] },

  // ── 能力面 ────────────────────────────────────────────────────────────
  { name: '/tools', key: 'tools', zh: '列出当前模式可用工具', en: 'List tools available in the current mode', surfaces: ['tui', 'desktop'] },
  { name: '/skills', key: 'skills', zh: '列出可用技能（✓=本会话启用）', en: 'List available skills (✓ = enabled for this session)', surfaces: ['tui', 'desktop'] },
  { name: '/skill', key: 'skill', arg: '<id>', zh: '启用/停用技能', en: 'Enable or disable a skill', surfaces: ['tui'] },
  { name: '/agents', key: 'agents', zh: '列出本地 Normal Agent（自定义人格）', en: 'List local normal agents (custom personas)', surfaces: ['tui', 'desktop'] },
  { name: '/agent', key: 'agent', arg: '<slug>', zh: '启用 Agent；管理：/agent new|edit|rm <slug>', en: 'Activate an agent; manage with /agent new|edit|rm <slug>', surfaces: ['tui', 'desktop'] },
  { name: '/groupchat', key: 'groupchat', arg: '<slug…>', zh: '群聊模式（/groupchat off 退出）', en: 'Group chat mode (/groupchat off to leave)', surfaces: ['tui', 'desktop'] },
  { name: '/historian', key: 'historian', zh: 'Historian 状态/活动；/historian on|off 开关', en: 'Historian status/activity; /historian on|off to toggle', surfaces: ['tui', 'desktop'] },
  { name: '/muse', key: 'muse', zh: 'Muse 状态/TODO；/muse on|off 开关', en: 'Muse status/TODOs; /muse on|off to toggle', surfaces: ['tui', 'desktop'] },
  { name: '/memory', key: 'memory', arg: '[edit]', zh: '查看/编辑长期记忆', en: 'View or edit long-term memory', surfaces: ['tui', 'desktop'] },
  { name: '/log', key: 'log', arg: '[YYYY-MM-DD]', zh: '查看每日日志', en: 'View the daily log', surfaces: ['tui'] },
  { name: '/mcp', key: 'mcp', zh: '列出 MCP server 状态', en: 'List MCP server status', surfaces: ['tui', 'desktop'] },
  { name: '/plugins', key: 'plugins', zh: '列出已发现插件', en: 'List discovered plugins', surfaces: ['tui', 'desktop'] },
];

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
