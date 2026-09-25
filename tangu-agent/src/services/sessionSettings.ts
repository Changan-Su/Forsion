/**
 * 会话运行设置的引擎侧写口(模型 / 思考档 / 循环上限)。通道命令、session_settings 工具共用。
 *
 * 口径:
 *   - 模型存 `chat_sessions.model_id`,思考档 / 循环上限存 `agent_config`(与桌面 PATCH /agent/sessions/:id/config
 *     同一把锁 `session:config:<id>`,读 → 按键合并 → 写,不整对象覆写 —— 别的窗口刚切的审批档不能被盖回去)。
 *   - 模型按 run 定格(agentLoop 在 run 开头 resolve 一次)→ 改模型从**下一个 run** 生效。
 *   - 思考档另有 run 内生效口:工具在跑的 run 里调了,loop 在下一次请求前取走覆盖值(见 takeRunThinking)。
 *   - 桌面 / TUI 起 run 用的是自己缓存的配置,引擎写了库它们下一轮会原样盖回去 —— 所以 run 内的改动必须
 *     publish `session_config_changed`,两端订阅后刷本地缓存(照 exit_plan_mode → plan_approved 的先例)。
 */
import { query } from '../core/db.js';
import { withKeyLock } from '../core/keyLock.js';
import { deps } from '../seams/runtime.js';
import type { ThinkingLevel } from '../llm/modelCapabilities.js';

const parse = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/** 读会话当前存着的模型与 agent_config。会话不存在 / 不属于该用户 → null。 */
export async function readSessionSettings(sessionId: string, userId: string): Promise<{ modelId: string; title: string; agentConfig: Record<string, unknown> } | null> {
  const rows = await query<any[]>(`SELECT model_id, title, agent_config FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, userId]);
  const r = rows?.[0];
  if (!r) return null;
  return { modelId: String(r.model_id || ''), title: String(r.title || ''), agentConfig: parse(r.agent_config) };
}

/** 按键合并写 agent_config(null = 删键)。与路由 PATCH 同锁,返回合并后的值。 */
export function patchSessionAgentConfig(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withKeyLock(`session:config:${sessionId}`, async () => {
    const cfg = parse(await deps().state.getAgentConfig(sessionId));
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete cfg[k];
      else if (v !== undefined) cfg[k] = v;
    }
    await deps().state.setAgentConfig(sessionId, JSON.stringify(cfg));
    return cfg;
  });
}

/** 改会话模型(下一个 run 生效)。按 user_id 限定,写不到别人的会话。 */
export async function setSessionModelId(sessionId: string, userId: string, modelId: string): Promise<void> {
  await query(`UPDATE chat_sessions SET model_id = ? WHERE id = ? AND user_id = ?`, [modelId, sessionId, userId]);
}

// run 内思考档覆盖:工具写、loop 在迭代边界取走。ponytail: 进程内 Map,run 结束由 loop 的 take 清掉;
// 进程重启丢了也无妨(会话存值已写,下一个 run 照样按新档)。
const runThinking = new Map<string, ThinkingLevel>();
export function requestRunThinking(runId: string, level: ThinkingLevel): void {
  runThinking.set(runId, level);
}
export function takeRunThinking(runId: string): ThinkingLevel | undefined {
  const v = runThinking.get(runId);
  if (v !== undefined) runThinking.delete(runId);
  return v;
}
