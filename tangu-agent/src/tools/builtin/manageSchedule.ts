/**
 * manage_schedule —— agent 管理自己的日程(agents/<slug>/SCHEDULE.db;见 services/agentSchedule.ts)。
 *
 * 条目两类:auto=true 到点走 automation 管道无人值守执行 prompt;auto=false 纯规划(只是日历
 * 记录——agent 对自己的日程规划)。日程会显示在桌面 Calendar Space(按 agent 标色,只读)。
 * 缺省操作 ctx.agentSlug 自己的日程;显式传 agent 可管他人(与 manage_agent 权限面一致)。
 * 可见性:本地限定(hostExec,照 muse_watch);不进 PLAN_MODE_TOOLS(写操作)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import {
  loadSchedule,
  entriesOf,
  validateEntryInput,
  upsertEntry,
  removeEntry,
  type ScheduleEntry,
} from '../../services/agentSchedule.js';
import { getAgent } from '../../agents/agentRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';

function fmt(e: ScheduleEntry): string {
  const tags = [
    e.repeat ? `every ${e.repeat}` : 'once',
    e.auto ? 'auto' : 'planning-only',
    e.todo ? 'todo' : '',
  ].filter(Boolean).join(', ');
  return `${e.id} — ${e.name} [${e.date || 'no date'}] (${tags})` +
    `${e.prompt ? ` prompt: ${e.prompt.slice(0, 80)}` : ''}${e.lastRun ? ` last run ${e.lastRun}` : ''}`;
}

export const manageScheduleProvider: ToolProvider = {
  id: 'builtin:manage_schedule',
  tools: () => [
    {
      name: 'manage_schedule',
      mode: 'both',
      isEnabledFor: (profile) => !!profile.capabilities.hostExec, // 本地限定;云端 no-op
      definition: {
        type: 'function',
        function: {
          name: 'manage_schedule',
          description:
            'Manage your own schedule (per-agent calendar, shown in the user\'s Calendar). Entries are either plain planning items (auto=false, just a calendar record) ' +
            'or automated tasks (auto=true: when due, you are woken up unattended to run the prompt). ' +
            'Use when the user says e.g. "every morning at 9 summarize the news" → set an entry with date=next 9:00, repeat="1d", auto=true, prompt=the task; ' +
            'or to plan your own upcoming work as auto=false entries. ' +
            'date format: YYYY-MM-DD (all-day, due at local 00:00) or YYYY-MM-DDTHH:mm, optionally "/end" for a range. ' +
            'repeat: empty=one-off, or "<n>h"/"<n>d" (e.g. 1h, 1d, 3d; min 1h) rolling from the date anchor. ' +
            'Your upcoming schedule is injected into your prompt at activation. Entries are evaluated every few minutes at zero cost.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['set', 'list', 'remove'], description: 'set=add/update an entry, list=show entries, remove=delete by id' },
              agent: { type: 'string', description: 'agent slug whose schedule to manage (default: yourself)' },
              id: { type: 'string', description: 'set: entry id to update (omit = create new); remove: entry id' },
              name: { type: 'string', description: 'set: entry name (required; shown on the calendar)' },
              date: { type: 'string', description: 'set: anchor date "YYYY-MM-DD[THH:mm][/end]" (local time)' },
              repeat: { type: 'string', description: 'set: repeat interval "<n>h"/"<n>d" rolling from date; omit for one-off' },
              auto: { type: 'boolean', description: 'set: true = run the prompt unattended when due (requires date + prompt); false/omit = planning-only' },
              prompt: { type: 'string', description: 'set: what to do when the entry is due (required when auto=true)' },
              description: { type: 'string', description: 'set: optional context/notes' },
              todo: { type: 'boolean', description: 'set: mark as a todo item' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args, ctx) => {
        const action = String(args.action || '');
        const slug = String(args.agent || ctx.agentSlug || DEFAULT_AGENT_SLUG).trim();
        const def = await getAgent(slug);
        if (!def) return `Error: agent "${slug}" not found`;
        if (action === 'list') {
          const db = await loadSchedule(slug);
          const entries = db ? entriesOf(db) : [];
          return entries.length
            ? `${entries.length} schedule entr${entries.length > 1 ? 'ies' : 'y'} of "${slug}":\n${entries.map(fmt).join('\n')}`
            : `(no schedule entries for "${slug}")`;
        }
        if (action === 'remove') {
          const id = String(args.id || '').trim();
          if (!id) return 'Error: id is required (use list to see ids)';
          return (await removeEntry(slug, id)) ? `Removed entry ${id}.` : `Error: entry ${id} not found`;
        }
        if (action !== 'set') return 'Error: action must be set/list/remove';
        const v = validateEntryInput(args as any, { slug });
        if (!v.ok) return `Error: ${v.error}`;
        const id = args.id ? String(args.id).trim() : undefined;
        const r = await upsertEntry(slug, v.value, id, def.name);
        if (!r.ok) return `Error: ${r.error}`;
        const note = v.value.auto
          ? ' (will run unattended when due; evaluated every ~5 minutes)'
          : ' (planning-only; shows on the calendar, never runs by itself)';
        return `${r.created ? 'Created' : 'Updated'} schedule entry ${r.entry.id}: ${fmt(r.entry)}${note}`;
      },
    },
  ],
};
