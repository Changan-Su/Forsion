/**
 * 改 Agent 的 slug(= 文件夹名 = 主键)。只对本地、用户自建的 agent 开放,三类拒绝:
 *   内置(xyra/aria/recita/coding/muse)—— 常量与播种按 slug 认,改了下次启动就长回来;
 *   云同步过的 —— 云端还留着旧 slug 的 config(cloud_sync=true),agentFileSync 的发现逻辑会把旧文件夹再拉回来;
 *   插件播种的(.bundle-origin)—— seedBundleAgents 只看目录存不存在,改了就再播一份。
 * 顺序:所有校验(含在飞 run)先做完,fs.rename 是第一个写动作;之后各处引用尽力改、失败收进 warnings ——
 * 改到一半失败只是旧消息 / 旧会话按「已删 agent」渲染,不会毁文件、也不会留下半个文件夹。
 */
import { promises as fs, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { agentsDir } from '../core/tanguHome.js';
import { query } from '../core/db.js';
import { getAgent, isValidSlug, builtinAgentDef, readAgentsMeta, writeAgentsMeta, type NormalAgentDef } from './agentRegistry.js';
import { listTeams, saveTeam } from './teamRegistry.js';
import { loadTriggers, saveTriggers } from '../services/museTriggers.js';
import { channelSettings, saveChannelSettings } from '../channels/config.js';
import { BUNDLE_ORIGIN_FILE } from '../plugins/bundles.js';
import { sessionHasActiveRun } from '../services/agentLoop.js';

export type AgentRenameCode = 'invalid_slug' | 'unchanged' | 'builtin' | 'not_found' | 'exists' | 'cloud_synced' | 'plugin_seeded' | 'busy' | 'unreadable';

export class AgentRenameError extends Error {
  constructor(public code: AgentRenameCode, public status: number) {
    super(`rename agent failed: ${code}`);
  }
}

/** 纯函数:把会话 agent_config 里指向 old 的引用改成 next;没引用返回 null。 */
export function renameInAgentConfig(cfg: unknown, old: string, next: string): Record<string, unknown> | null {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const out: Record<string, unknown> = { ...(cfg as Record<string, unknown>) };
  let hit = false;
  for (const k of ['agentSlug', 'soloAgentSlug'] as const) if (out[k] === old) { out[k] = next; hit = true; }
  if (Array.isArray(out.groupAgents) && out.groupAgents.includes(old)) { out.groupAgents = out.groupAgents.map((s) => (s === old ? next : s)); hit = true; }
  return hit ? out : null;
}

export async function renameAgent(oldSlug: string, newSlug: string): Promise<{ agent: NormalAgentDef; warnings: string[] }> {
  if (!isValidSlug(oldSlug) || !isValidSlug(newSlug)) throw new AgentRenameError('invalid_slug', 400);
  if (oldSlug === newSlug) throw new AgentRenameError('unchanged', 400);
  if (builtinAgentDef(oldSlug) || builtinAgentDef(newSlug)) throw new AgentRenameError('builtin', 400);
  const cur = await getAgent(oldSlug);
  if (!cur) throw new AgentRenameError('not_found', 404);
  const from = path.join(agentsDir(), oldSlug);
  const to = path.join(agentsDir(), newSlug);
  if (existsSync(to)) throw new AgentRenameError('exists', 409);
  const entries = readdirSync(from);
  // `.cloudsync-<scope>.json` 是跑过一次同步才落的 prev-state;只开过开关没同步过的不算(云端没有它)。
  if (cur.cloudSync || entries.some((f) => /^\.cloudsync-.+\.json$/.test(f) && f !== '.cloudsync-accounts.json')) throw new AgentRenameError('cloud_synced', 409);
  if (entries.includes(BUNDLE_ORIGIN_FILE)) throw new AgentRenameError('plugin_seeded', 409);

  const rows = await query<Array<{ id: string; agent_config: unknown }>>('SELECT id, agent_config FROM chat_sessions WHERE agent_config IS NOT NULL');
  const sessions: Array<{ id: string; cfg: Record<string, unknown> }> = [];
  for (const r of rows || []) {
    let cfg: unknown;
    try { cfg = typeof r.agent_config === 'string' ? JSON.parse(r.agent_config) : r.agent_config; } catch { continue; }
    const next = renameInAgentConfig(cfg, oldSlug, newSlug);
    if (next) sessions.push({ id: r.id, cfg: next });
  }
  // ponytail: 只挡「会话里选了它」的在飞 run(run 的 ALS 钉着旧 slug,remember 会写回旧路径);
  // delegate 子 run 不在任何会话配置里,漏网的代价是那一次记忆落回旧文件夹。
  if (sessions.some((s) => sessionHasActiveRun(s.id))) throw new AgentRenameError('busy', 409);

  await fs.rename(from, to);
  const warnings: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try { await fn(); } catch (e: any) { warnings.push(`${label}: ${e?.message || e}`); }
  };
  const meta = readAgentsMeta();
  // 无条件写:除了改顺序 / 默认,也顺手作废 agentRegistry 的列表缓存。
  await step('agents-meta', () => writeAgentsMeta({ order: meta.order.map((s) => (s === oldSlug ? newSlug : s)), defaultSlug: meta.defaultSlug === oldSlug ? newSlug : meta.defaultSlug }));
  for (const s of sessions) await step(`session ${s.id}`, () => query('UPDATE chat_sessions SET agent_config = ? WHERE id = ?', [JSON.stringify(s.cfg), s.id]));
  await step('chat_messages', () => query('UPDATE chat_messages SET agent_slug = ? WHERE agent_slug = ?', [newSlug, oldSlug]));
  await step('pending_approvals', () => query('UPDATE pending_approvals SET agent_slug = ? WHERE agent_slug = ?', [newSlug, oldSlug]));
  await step('inbox_messages', () => query(`UPDATE inbox_messages SET sender_id = ? WHERE sender_kind = 'agent' AND sender_id = ?`, [newSlug, oldSlug]));
  // agent_runs.input 是历史 run 的入参快照,只读证据,不改。
  await step('teams', async () => {
    for (const team of await listTeams()) {
      if (!team.members.some((m) => m.slug === oldSlug)) continue;
      const members = team.members.map((m) => (m.slug === oldSlug ? { ...m, slug: newSlug } : m));
      await saveTeam({ slug: team.slug, name: team.name, members, lead: team.lead === oldSlug ? newSlug : team.lead });
    }
  });
  await step('automation', async () => {
    const triggers = await loadTriggers();
    let touched = false;
    for (const t of triggers) {
      if (t.agentSlug === oldSlug) { t.agentSlug = newSlug; touched = true; }
      for (const a of t.actions || []) if (a.type === 'agent_run' && a.agentSlug === oldSlug) { a.agentSlug = newSlug; touched = true; }
    }
    if (touched) await saveTriggers(triggers);
  });
  await step('channels', async () => {
    for (const kind of ['wechat', 'telegram', 'qq'] as const) if (channelSettings(kind).agentSlug === oldSlug) saveChannelSettings(kind, { agentSlug: newSlug });
  });
  const agent = await getAgent(newSlug);
  if (!agent) throw new AgentRenameError('unreadable', 500);
  return { agent, warnings };
}
