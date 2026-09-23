/**
 * 系统提示的「其他 Agent」名册(09-22):没有它,模型只能靠用户 @ 才知道别的 agent 存在——
 * delegate / start_discussion 有工具没目标。一行一个:名字、slug、描述、借出的技能;顺序按 .meta.json,
 * 内容不随会话变 → 前缀缓存照常。只在 delegate / start_discussion 可见的 run 里注入(agentLoop 门控)。
 */
import { listAgents } from '../agents/agentRegistry.js';
import { listSharedAgentSkills, SHARED_SKILL_ID_RE } from '../skills/localSkills.js';

export const AGENT_ROSTER_HEADER = '## Other Agents';

/** 空串 = 没有别的 agent,不注入。 */
export async function buildAgentRoster(selfSlug: string): Promise<string> {
  const others = (await listAgents()).filter((a) => a.slug !== selfSlug && a.createdBy !== 'system');
  if (!others.length) return '';
  const shared = await listSharedAgentSkills(selfSlug).catch(() => []);
  const lines = others.map((a) => {
    const lends = shared.filter((s) => s.ownerSlug === a.slug).map((s) => s.id.match(SHARED_SKILL_ID_RE)?.[2] || s.name);
    return `- ${a.name} (slug: \`${a.slug}\`)${a.description ? ` — ${a.description}` : ''}${lends.length ? ` · shares skills: ${lends.join(', ')}` : ''}`;
  });
  return (
    `${AGENT_ROSTER_HEADER}\n` +
    'Named agents on this machine. For a self-contained subtask that fits one of them, call `delegate` with its slug as agentSlug (it runs in that agent\'s persona with its own tools and skills). ' +
    'To think something through with one, call `start_discussion` with its slug as peer. ' +
    'Skills they share can be borrowed directly with `use_skill` (listed under "Skills shared by other agents").\n' +
    lines.join('\n')
  );
}
