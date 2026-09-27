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
          // 09-27:删掉旧描述里对 activitywatch 外部应用焦点行的承诺 —— 那份数据从来不存在,等于诱导模型编造;
          // Forsion 之外的电脑活动归 read_computer_history(开着才在场,故只说「可用时」)。
          description:
            "Read the user's in-app activity log for Forsion (compact, one event per line, oldest first): new/sent chats, note edits with line ranges, " +
            'task/database rows, opened notes, installs, agent file edits, and lines written by Forsion plugins. ' +
            'Line format: `YYYYMMDDHHMM event key=value "snippet"` (local time). ' +
            'Use it to understand what the user has been doing in Forsion recently and to detect whether a task has started or finished. ' +
            'It does not record activity outside Forsion (other apps, browser, editors); if read_computer_history is available, use that for it. ' +
            'If a small window comes back (nearly) empty, retry with a larger `hours` before concluding there was no activity.',
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
        // 与 readActivityLines 内部同款 clamp,仅用于提示文案(实测坑:Muse 用 hours:2 扑空后
        // 不再扩窗重查,反而向用户断言「日志不记录外部应用」——尾注把「扩窗重试」推给模型)。
        const hours = Math.min(Math.max(1, Number(args.hours) || 24), 720);
        const widen = hours < 720 ? ` Older entries may exist outside this window — retry with a larger hours (e.g. ${Math.min(hours * 12, 720)}).` : '';
        if (!lines.length) {
          return `(no activity recorded in the last ${hours}h.${widen})`;
        }
        const fewNote = lines.length <= 2 && widen ? `\n(only ${lines.length} event(s) in the last ${hours}h.${widen})` : '';
        return `${lines.length} events (oldest first):\n${lines.join('\n')}${fewNote}`;
      },
    },
  ],
};
