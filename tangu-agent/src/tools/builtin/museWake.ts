/**
 * set_next_wake —— Muse 自己决定跳过接下来的心跳(2026-09-24)。
 *
 * 心跳每 2 小时无条件起一个周期(09-10 M8),用户睡着 / 走开时也照烧额度。现在由 Muse 按作息判断:没事可做就睡到
 * 用户大概回来的时刻。引擎保底三条(muse.ts tick):用户一有动作(聊天 / 应用内操作)立刻醒、盯任务规则与自己的到期
 * 日程照常叫醒、单次最多 24h(museState.validSleep 读回再校验一次)。只挡心跳,不挡任何别的触发。
 *
 * 可见性:仅 Muse 周期(ctx.muse);delegate 出去的子代理会 spread 继承 muse:true,显式排除 —— 子代理不该替 Muse 关灯。
 * 普通 run 不可见 → tooldefs 快照零漂移。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { MUSE_SLEEP_MAX_MS, setMuseSleep } from '../../services/museState.js';
import { activityTs, readUserActivityStamps } from '../../services/userActivity.js';

const pad = (x: number): string => String(x).padStart(2, '0');

/** until / hours → 醒来时刻(纯函数,单测钉)。hours=0 → 0(= 取消休眠)。非法 → 错误串。 */
export function resolveWakeAt(args: { until?: unknown; hours?: unknown }, now = Date.now()): number | string {
  const until = typeof args.until === 'string' ? args.until.trim() : '';
  if (until) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(until);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return 'Error: until must be HH:MM (24h, device local time)';
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1); // 已过 → 明天这个时刻
    return Math.min(d.getTime(), now + MUSE_SLEEP_MAX_MS);
  }
  if (args.hours !== undefined && args.hours !== null && args.hours !== '') {
    const h = Number(args.hours);
    if (!Number.isFinite(h) || h < 0) return 'Error: hours must be a number >= 0';
    if (h === 0) return 0;
    return Math.min(now + h * 3600_000, now + MUSE_SLEEP_MAX_MS);
  }
  return 'Error: give either until (HH:MM) or hours';
}

export const museWakeProvider: ToolProvider = {
  id: 'builtin:set_next_wake',
  tools: () => [
    {
      name: 'set_next_wake',
      mode: 'both',
      isEnabledFor: (_profile, ctx) => !!(ctx as any).muse && !((ctx.subAgentDepth || 0) >= 1),
      definition: {
        type: 'function',
        function: {
          name: 'set_next_wake',
          description:
            'Skip your regular heartbeat wake-ups until a given time, to save the user\'s background budget when nothing needs you soon — ' +
            'e.g. the user is away, or it is outside their usual active hours (see the user rhythm in your kickoff). ' +
            'You are still woken early when the user becomes active again (a chat message or an in-app action), when an automation rule fires, ' +
            'or when one of your own schedule entries comes due. At most 24h. Calling it again replaces the previous sleep; hours=0 resumes the normal heartbeat. ' +
            'If a task needs you at a specific time, schedule it with manage_schedule instead of relying on the heartbeat.',
          parameters: {
            type: 'object',
            properties: {
              until: { type: 'string', description: 'Wake time as HH:MM in 24h device-local time (the next occurrence of that time). Preferred over hours.' },
              hours: { type: 'number', description: 'Alternatively, sleep this many hours from now (0 = cancel the sleep and resume the heartbeat).' },
              reason: { type: 'string', description: 'One short sentence on why, shown to the user (e.g. "User is usually offline until ~9:00; nothing pending").' },
            },
            required: ['reason'],
          },
        },
      },
      execute: async (args) => {
        const reason = String(args.reason || '').trim().slice(0, 200);
        if (!reason) return 'Error: reason is required';
        const now = Date.now();
        const at = resolveWakeAt(args, now);
        if (typeof at === 'string') return at;
        if (at === 0) {
          await setMuseSleep(null);
          return 'OK — sleep cancelled; the normal heartbeat applies again.';
        }
        // 同一分钟基线:此刻这一分钟里已有的用户行数;之后同一分钟再多出来的行 = 用户回来了(日志只有分钟精度)
        const minute = activityTs(new Date(now));
        const minuteLines = (await readUserActivityStamps(1, new Date(now)).catch(() => [] as string[])).filter((t) => t === minute).length;
        await setMuseSleep({ until: at, setAt: now, reason, minuteLines });
        const d = new Date(at);
        const mins = Math.round((at - now) / 60_000);
        return `OK — heartbeat paused until ${pad(d.getHours())}:${pad(d.getMinutes())} (in ${Math.floor(mins / 60)}h ${mins % 60}m). ` +
          'You will be woken earlier if the user becomes active, a rule fires, or one of your schedule entries comes due.';
      },
    },
  ],
};
