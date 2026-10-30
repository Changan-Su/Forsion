/**
 * propose_muse_settings —— 用户在私聊里说「晚上 11 点以后别找我」,Muse 回一张设置变更卡,点「改」才写进设置(10-30 方案 A + C)。
 * 只出卡,不写配置:写配置走用户点的那一下(services/museCards.ts decideMuseCard)。
 * 能改的只有下面四项。权限档、能读的文件夹、预算不在这里,也加不进来:放权不该由它提议、用户点一下就成。
 * 只给 Muse(周期与手聊,子代理除外);普通 run 不可见,tooldefs 快照零漂移。
 */
import { MUSE_AGENT_SLUG } from '../../agents/agentRegistry.js';
import type { ToolProvider } from '../toolRegistry.js';
import { loadSpecialAgentsConfig } from '../../services/specialAgentsConfig.js';
import { postMuseCard, pickMuseSettings } from '../../services/museCards.js';

const KNOWN = new Set(['heartbeat_minutes', 'active_hours', 'all_day', 'notify', 'max_messages_per_day']);
const int = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export const museSettingsProvider: ToolProvider = {
  id: 'builtin:propose_muse_settings',
  tools: () => [
    {
      name: 'propose_muse_settings',
      mode: 'both',
      isEnabledFor: (profile, ctx) => !!profile.capabilities.hostExec && ctx.agentSlug === MUSE_AGENT_SLUG && !((ctx.subAgentDepth || 0) >= 1),
      definition: {
        type: 'function',
        function: {
          name: 'propose_muse_settings',
          description:
            'When the user asks you to change when or how often you work, propose it: this shows them a card with the old and new value, and nothing changes until they tap it. ' +
            'Covers your heartbeat, active hours, daily digest and daily message limit. Your permission tier, folders and budget cannot be changed this way; they change those themselves in Settings › Agents › Background agents.',
          parameters: {
            type: 'object',
            properties: {
              heartbeat_minutes: { type: 'integer', minimum: 0, maximum: 10080, description: '0 = only wake for schedules and rules.' },
              active_hours: { type: 'object', properties: { start: { type: 'integer', minimum: 0, maximum: 23 }, end: { type: 'integer', minimum: 0, maximum: 23 } }, required: ['start', 'end'], description: 'Hours of the day (local) you may run; end may be smaller than start to span midnight.' },
              all_day: { type: 'boolean', description: 'true = no active-hours limit.' },
              notify: { type: 'string', enum: ['immediate', 'digest'], description: 'digest = your journal reaches them as one daily digest.' },
              max_messages_per_day: { type: 'integer', minimum: 0, maximum: 24, description: '0 = no daily limit.' },
            },
            additionalProperties: false,
          },
        },
      },
      execute: async (args, ctx) => {
        const other = Object.keys(args || {}).filter((k) => !KNOWN.has(k));
        if (other.length) return `Error: ${other.join(', ')} can't be changed from here. Your permission tier, folders and budget change only when the user does it in Settings.`;
        const h = args.active_hours;
        if ((args.heartbeat_minutes !== undefined && !int(args.heartbeat_minutes, 0, 10080))
          || (args.max_messages_per_day !== undefined && !int(args.max_messages_per_day, 0, 24))
          || (args.notify !== undefined && args.notify !== 'immediate' && args.notify !== 'digest')
          || (h !== undefined && !(int(h?.start, 0, 23) && int(h?.end, 0, 23) && h.start !== h.end))) return 'Error: a value is out of range.';
        const cur = loadSpecialAgentsConfig().muse;
        const { patch, changes } = pickMuseSettings(cur, {
          ...(args.heartbeat_minutes !== undefined ? { heartbeatMinutes: args.heartbeat_minutes } : {}),
          ...(args.all_day === true ? { activeHours: null } : args.active_hours ? { activeHours: args.active_hours } : {}),
          ...(args.notify !== undefined ? { notify: args.notify } : {}),
          ...(args.max_messages_per_day !== undefined ? { maxDmPerDay: args.max_messages_per_day } : {}),
        });
        if (!changes.length) return 'Error: nothing to change; these are already the current values.';
        const r = await postMuseCard(ctx.userId, { kind: 'settings', payload: { patch, changes }, text: '', uncapped: true });
        return r.ok ? 'The card is at the end of your direct chat. Nothing changes until they tap it; say so in one line, without repeating the values.' : r.error;
      },
    },
  ],
};
