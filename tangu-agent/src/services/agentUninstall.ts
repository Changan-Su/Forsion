/**
 * 卸载 Agent(10-28 手动卸载规范 A + D):确认框逐项写去向,东西进回收站,30 天内能原样恢复。
 * 名册、侧栏、manage_agent 工具三个入口都走这里:
 *   定义 / 记忆 / Library → 回收站;私聊 → 归档(勾了才删);云端副本 → 删(同步那半在 agentFileSync);
 *   团队 → 移出(只剩一人的团队一起进回收站);用到它的自动化 → 暂停;默认 Agent / 启用中的 Muse → 不给删。
 * 恢复按条目 extra 里记的逐项接回去;原名被占落到 `<slug>-2` 时只恢复文件(私聊、自动化、团队记的是旧名,接回去会接到别人身上)。
 */
import path from 'node:path';
import { agentsDir } from '../core/tanguHome.js';
import { getAgent, trashAgent, agentUndeletableReason, invalidateAgentCache, isValidSlug } from '../agents/agentRegistry.js';
import { listTeams, getTeam, saveTeam, teamDirOf, type TeamMember } from '../agents/teamRegistry.js';
import { loadTriggers, triggerUsesAgent, pauseAgentTriggers, resumeAgentTriggers } from './museTriggers.js';
import { agentSyncedScopes, forgetAgentRemoval } from './cloudSyncAccount.js';
import { archiveSoloSessions, archiveTeamSessions, deleteSessionCascade, setSessionsArchived, soloSessionIds, teamRunActive } from './sessionCleanup.js';
import { pathSize, restoreTrashItems, setTrashExtra, type TrashEntry } from './trash.js';
import { scheduleAgentFilesSync } from './agentFileSync.js';

export interface AgentUninstallPreview {
  slug: string;
  name: string;
  /** 删不了的原因;有值时确认框只给关闭。 */
  blocked: 'invalid' | 'default' | 'muse' | null;
  size: number;
  chats: number;
  cloud: boolean;
  teams: Array<{ slug: string; name: string; dissolve: boolean }>;
  automations: Array<{ id: string; desc: string }>;
}

interface TeamSeat { slug: string; member: TeamMember; index: number; lead: boolean }
interface AgentExtra { chats?: string[]; triggers?: string[]; teams?: TeamSeat[]; teamChats?: Record<string, string[]> }

async function teamsOf(slug: string): Promise<Array<{ slug: string; name: string; dissolve: boolean }>> {
  return (await listTeams()).filter((t) => t.members.some((m) => m.slug === slug))
    .map((t) => ({ slug: t.slug, name: t.name, dissolve: t.members.length - 1 < 2 })); // 团队至少两人:只剩一人的一起进回收站
}

export async function agentUninstallPreview(userId: string, appId: string, slug: string): Promise<AgentUninstallPreview | null> {
  const def = await getAgent(slug);
  if (!def) return null;
  return {
    slug,
    name: def.name || slug,
    blocked: agentUndeletableReason(slug),
    size: await pathSize(path.join(agentsDir(), slug)),
    chats: (await soloSessionIds(userId, appId, 'agent', slug)).length,
    cloud: agentSyncedScopes(slug).length > 0,
    teams: await teamsOf(slug),
    automations: (await loadTriggers()).filter((t) => t.enabled && triggerUsesAgent(t, slug)).map((t) => ({ id: t.id, desc: t.desc })),
  };
}

export async function uninstallAgent(userId: string, appId: string, slug: string, opts: { deleteChats?: boolean } = {}): Promise<{ ok: boolean; entry?: TrashEntry; busy?: boolean }> {
  const teams = isValidSlug(slug) ? await teamsOf(slug) : [];
  const dissolve = teams.filter((t) => t.dissolve);
  // 要一起进回收站的团队还在跑:它的 Library 是 run 的 cwd(同删团队的 409)
  for (const t of dissolve) if (await teamRunActive(userId, appId, t.slug)) return { ok: false, busy: true };
  const seats: TeamSeat[] = [];
  for (const t of teams) {
    if (t.dissolve) continue;
    const team = await getTeam(t.slug);
    const index = team?.members.findIndex((m) => m.slug === slug) ?? -1;
    if (team && index >= 0) seats.push({ slug: t.slug, member: team.members[index], index, lead: team.lead === slug });
  }
  const r = await trashAgent(slug, { alsoTrash: dissolve.map((t) => ({ path: teamDirOf(t.slug), role: `team:${t.slug}` })) });
  if (!r.ok) return r;
  // 文件已经进回收站 = 删成了;后面几步尽力做,哪步失败记一笔接着做(不能让界面报「删除失败」而 Agent 其实已经没了)。
  // 做成了的都记进条目,恢复时才接得回去。
  const step = <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => fn().catch((e) => { console.warn(`[uninstall] ${slug}: ${what} failed: ${e?.message || e}`); return undefined; });
  const extra: AgentExtra = {};
  for (const seat of seats) {
    const team = await step('read team', () => getTeam(seat.slug));
    if (!team) continue;
    if (await step('leave team', () => saveTeam({ slug: team.slug, name: team.name, members: team.members.filter((m) => m.slug !== slug) }))) (extra.teams ??= []).push(seat);
  }
  for (const t of dissolve) { const ids = await step('archive team chats', () => archiveTeamSessions(userId, appId, t.slug)); if (ids) (extra.teamChats ??= {})[t.slug] = ids; } // cwd 没了,同删团队
  extra.triggers = await step('pause automations', () => pauseAgentTriggers(slug));
  if (opts.deleteChats) await step('delete chats', async () => { for (const sid of await soloSessionIds(userId, appId, 'agent', slug)) await deleteSessionCascade(sid); });
  else extra.chats = await step('archive chats', () => archiveSoloSessions(userId, appId, 'agent', slug));
  if (r.entry) await step('record undo', () => setTrashExtra(r.entry!.id, { ...extra }));
  scheduleAgentFilesSync(userId, slug); // 云端那份现在就删,不等下一轮
  return r;
}

export async function restoreAgent(userId: string, entry: TrashEntry): Promise<{ slug: string; renamed: boolean }> {
  const out = { slug: entry.ref, renamed: false };
  await restoreTrashItems(entry, async (placed) => {
    const dirItem = entry.items.find((i) => i.role === 'dir');
    const at = dirItem && placed.get(dirItem.from);
    const slug = at ? path.basename(at) : entry.ref;
    Object.assign(out, { slug, renamed: slug !== entry.ref });
    forgetAgentRemoval(slug); // 改名落位时原名的删除记录不动:那是原名在云端那份的事
    invalidateAgentCache();
    const extra = (entry.extra ?? {}) as AgentExtra;
    for (const it of entry.items) {
      const teamSlug = it.role?.startsWith('team:') && path.basename(placed.get(it.from) ?? it.from);
      if (!teamSlug) continue;
      // 一起进回收站的团队:Agent 改名落位就把成员表里的旧名换成新名(旧名现在是别人)
      const team = out.renamed ? await getTeam(teamSlug) : null;
      if (team) await saveTeam({ slug: team.slug, name: team.name, members: team.members.map((m) => (m.slug === entry.ref ? { ...m, slug } : m)), ...(team.lead === entry.ref ? { lead: slug } : {}) });
      const chats = teamSlug === it.role!.slice(5) ? extra.teamChats?.[teamSlug] : undefined; // 团队也改名落位了,会话记的是旧名,不接
      if (chats?.length) await setSessionsArchived(userId, chats, false);
    }
    if (out.renamed) return;
    if (extra.chats?.length) await setSessionsArchived(userId, extra.chats, false);
    if (extra.triggers?.length) await resumeAgentTriggers(extra.triggers);
    for (const seat of extra.teams ?? []) {
      const team = await getTeam(seat.slug);
      if (!team || team.members.some((m) => m.slug === slug)) continue;
      const members = [...team.members];
      members.splice(Math.min(seat.index, members.length), 0, seat.member);
      await saveTeam({ slug: team.slug, name: team.name, members, ...(seat.lead ? { lead: slug } : {}) }).catch(() => { /* 团队改过就不硬塞回去 */ });
    }
  });
  scheduleAgentFilesSync(userId, out.slug); // 整份重新上传(影子已丢)
  return out;
}
