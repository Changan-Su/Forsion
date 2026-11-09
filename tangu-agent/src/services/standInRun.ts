/**
 * 分身在一次 run 里的那一段(11-09):agentLoop 在读任何上下文之前调 resolveRunStandIn,定下这次是谁、建好分身、组好权限域。
 * 身份解析本身在 agents/standIn.ts(通道层判要不要开新会话也用同一个解析器),权限域的判定在 services/accessDomain.ts。
 */
import { deps } from '../seams/runtime.js';
import { getAgent } from '../agents/agentRegistry.js';
import { ensureStandIn, resolveRunIdentity, isStandInSlugShape, type ChannelSource } from '../agents/standIn.js';
import { buildStandInDomain, type StandInDomain } from './accessDomain.js';
import { patchSessionAgentConfig } from './sessionSettings.js';
import { channelHub } from '../channels/hub.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** run.input.source(通道层写的)→ 解析器要的通道来源;不是通道 run → null。 */
export function channelSourceOf(source: Record<string, unknown>): ChannelSource | null {
  const kind = str(source.channel).trim();
  if (!kind) return null;
  return { kind, accountId: str(source.accountId), peerId: str(source.openid), multiPeer: source.multiPeer === true };
}

/**
 * 解析这次 run 的身份,必要时把 agentConfig.agentSlug 换成分身(并写穿到会话存值,会话从此归分身:search_sessions / 召回按它认)。
 * 返回分身的权限域;不是分身 → undefined。
 * 换了身份的会话不接着用旧历史:旧历史里有另一个身份的东西(本体的私事,或分身那边别人说的话)。通道层在建 run 之前已经开了新会话,
 * 这里是兜底 —— 会话里已有消息、之前存的又不是这个身份,就不跑,让通道那边重来一次。
 */
export async function resolveRunStandIn(
  sessionId: string,
  agentConfig: Record<string, any>,
  source: Record<string, unknown>,
  storedAgentSlug: string | undefined,
): Promise<StandInDomain | undefined> {
  const channel = channelSourceOf(source);
  const id = await resolveRunIdentity(String(agentConfig.agentSlug), channel);
  // 存值缺席(老会话)也算「另一个身份」:分身不接着用身份不明的旧历史
  const switching = storedAgentSlug !== id.slug && (id.kind === 'standin' || isStandInSlugShape(storedAgentSlug ?? ''));
  if (switching && (await deps().state.countSessionMessages(sessionId)) > 0) {
    throw new Error(id.kind === 'standin'
      ? 'This conversation has history from another identity, and a stand-in does not continue it. Send the message again to start a new conversation.'
      : 'This conversation belongs to a stand-in. Send the message again to start a new conversation.');
  }
  if (id.kind === 'self') {
    if (id.slug !== agentConfig.agentSlug) {
      agentConfig.agentSlug = id.slug;
      await patchSessionAgentConfig(sessionId, { agentSlug: id.slug });
    }
    return undefined;
  }
  const own = await ensureStandIn(id, id.channel ? channelHub.channelName(id.channel) : undefined);
  if (agentConfig.agentSlug !== id.slug || storedAgentSlug !== id.slug) {
    agentConfig.agentSlug = id.slug;
    await patchSessionAgentConfig(sessionId, { agentSlug: id.slug });
  }
  const body = await getAgent(id.bodySlug).catch(() => null);
  return buildStandInDomain(own, body, {
    cwd: typeof agentConfig.cwd === 'string' ? agentConfig.cwd : undefined,
    channel: id.channel,
    channelOwner: id.channel ? channelHub.channelOwner(id.channel)?.engine ?? null : null,
  });
}

/** 给模型看的一段(英文):它是分身、为什么只有这些、问到主人的私事怎么答。放在专属文件夹那段后面(随身份稳定,不碎前缀缓存)。 */
export function standInSection(dom: StandInDomain, ownerAgentName?: string): string {
  const who = ownerAgentName?.trim() || dom.bodySlug;
  const shared = dom.library.length
    ? `\n- Files the user shared with you (read-only):\n${dom.library.map((f) => `  - ${f}`).join('\n')}`
    : '';
  return '## You Are a Stand-in\n' +
    `You are answering as ${who}'s stand-in${dom.channel ? ` in a chat channel (${dom.channel})` : ''}, a conversation that people other than the user may read. ` +
    'It runs in its own, limited space:\n' +
    `- Your memory, logs, schedule and conversations are your own and started empty. Nothing from the user's private conversations with ${who}, the user's notes or profile, or ${who}'s memory is available here, and what is said here does not go back to them.\n` +
    '- You can read and write only your own folder and the working directory. Other agents\' folders and the user\'s personal folder and notes are off limits; do not try to reach them another way.' + shared + '\n' +
    '- If someone asks about the user\'s private matters, say you do not have that information here. Never guess or make it up.';
}
