/**
 * read_activity —— 读用户应用内活动日志(~/.tangu/activity/<date>.log,桌面 UI 埋点+引擎 agent.edit 双写)。
 *
 * 可见性:本地限定(hostExec)且 **默认仅 Muse**——周期 run(ctx.muse)与手聊 Muse(ctx.agentSlug='muse',
 * 普通会话路径不设 muse 旗标)都放行;其他 agent 需在其 config.toml 显式 `activity_access = true`
 * (经 agentActivation → agentConfig → ctx.activityAccess,agent 编辑 UI 有开关)。默认全 false →
 * tooldefs 快照零扰动。只读工具,已列入 PLAN_MODE_TOOLS(Muse 周期跑 planMode)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { readActivityLines } from '../../services/userActivity.js';

export const readActivityProvider: ToolProvider = {
  id: 'builtin:read_activity',
  tools: () => [
    {
      name: 'read_activity',
      mode: 'both',
      isEnabledFor: (profile, ctx) =>
        !!profile.capabilities.hostExec &&
        // 'muse' = MUSE_AGENT_SLUG(硬编码避免 builtin→agentRegistry import 环)
        (!!ctx.muse || !!ctx.activityAccess || ctx.agentSlug === 'muse'),
      capabilities: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 10_000 },
      definition: {
        type: 'function',
        function: {
          name: 'read_activity',
          description:
            "Read the user's in-app activity log (compact, one event per line, oldest first): new/sent chats, note edits with line ranges, " +
            'task/database rows, opened notes, installs, agent file edits, etc. Line format: `YYYYMMDDHHMM event key=value \"snippet\"` (local time). ' +
            'Use it to understand what the user has been doing recently and to detect whether a task has started or finished.',
          parameters: {
            type: 'object',
            properties: {
              hours: { type: 'number', description: 'Look-back window in hours (default 24, max 720)' },
              limit: { type: 'number', description: 'Max lines returned, newest kept (default 200, max 1000)' },
              query: { type: 'string', description: 'Optional substring filter applied to whole lines (e.g. a file name or event name like "note.edit")' },
            },
            required: [],
          },
        },
      },
      execute: async (args) => {
        const lines = await readActivityLines({
          hours: Number(args.hours) || undefined,
          limit: Number(args.limit) || undefined,
          query: typeof args.query === 'string' ? args.query : undefined,
        });
        if (!lines.length) return '(no activity recorded in this window)';
        return `${lines.length} events (oldest first):\n${lines.join('\n')}`;
      },
    },
  ],
};
