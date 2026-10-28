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
import { archiveSoloSessions, deleteSessionCascade, setSessionsArchived, soloSessionIds } from './sessionCleanup.js';
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
interface AgentExtra { chats?: string[]; triggers?: string[]; teams?: TeamSeat[] }

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

export async function uninstallAgent(userId: string, appId: string, slug: string, opts: { deleteChats?: boolean } = {}): Promise<{ ok: boolean; entry?: TrashEntry }> {
  const teams = isValidSlug(slug) ? await teamsOf(slug) : [];
  const seats: TeamSeat[] = [];
  for (const t of teams) {
    if (t.dissolve) continue;
    const team = await getTeam(t.slug);
    const index = team?.members.findIndex((m) => m.slug === slug) ?? -1;
    if (team && index >= 0) seats.push({ slug: t.slug, member: team.members[index], index, lead: team.lead === slug });
  }
  const r = await trashAgent(slug, { alsoTrash: teams.filter((t) => t.dissolve).map((t) => ({ path: teamDirOf(t.slug), role: `team:${t.slug}` })) });
  if (!r.ok) return r;
  const extra: AgentExtra = {};
  for (const seat of seats) {
    const team = await getTeam(seat.slug);
    if (!team) continue;
    await saveTeam({ slug: team.slug, name: team.name, members: team.members.filter((m) => m.slug !== slug) }).then(() => { (extra.teams ??= []).push(seat); }, () => { /* 没移成就留着:运行时跳过不存在的成员 */ });
  }
  extra.triggers = await pauseAgentTriggers(slug);
  if (opts.deleteChats) for (const sid of await soloSessionIds(userId, appId, 'agent', slug)) await deleteSessionCascade(sid);
  else extra.chats = await archiveSoloSessions(userId, appId, 'agent', slug);
  if (r.entry) await setTrashExtra(r.entry.id, { ...extra });
  scheduleAgentFilesSync(userId, slug); // 云端那份现在就删,不等下一轮
  return r;
}

export async function restoreAgent(userId: string, entry: TrashEntry): Promise<{ slug: string; renamed: boolean }> {
  const placed = await restoreTrashItems(entry);
  const dirItem = entry.items.find((i) => i.role === 'dir');
  const at = dirItem && placed.get(dirItem.from);
  const slug = at ? path.basename(at) : entry.ref;
  const renamed = slug !== entry.ref;
  forgetAgentRemoval(slug); // 改名落位时原名的删除记录不动:那是原名在云端那份的事
  invalidateAgentCache();
  const extra = (entry.extra ?? {}) as AgentExtra;
  if (!renamed) {
    if (extra.chats?.length) await setSessionsArchived(userId, extra.chats, false);
    if (extra.triggers?.length) await resumeAgentTriggers(extra.triggers);
    for (const seat of extra.teams ?? []) {
      const team = await getTeam(seat.slug);
      if (!team || team.members.some((m) => m.slug === slug)) continue;
      const members = [...team.members];
      members.splice(Math.min(seat.index, members.length), 0, seat.member);
      await saveTeam({ slug: team.slug, name: team.name, members, ...(seat.lead ? { lead: slug } : {}) }).catch(() => { /* 团队改过就不硬塞回去 */ });
    }
  }
  scheduleAgentFilesSync(userId, slug); // 整份重新上传(影子已丢)
  return { slug, renamed };
}
