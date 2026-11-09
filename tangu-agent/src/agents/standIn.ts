/**
 * Agent 分身(Stand-in,11-09 方案「记忆分层与 Agent 分身」第三步,选 C:挂在本体下的分身)。
 *
 * 分身 = 持久的**数据身份** + 统一的**权限域**(services/accessDomain.ts)。别人也读得到的对话(微信、企业微信、插件通道)里,
 * 引擎在开始这次运行、读任何上下文之前先解析出「这次是谁」:本体自己,还是本体的某个分身;之后所有读写只认它。
 * - 身份:自己的 slug `<本体>-standin-<通道>`(多联系人通道再加 `-<联系人哈希>`,一个联系人一个分身)、自己的文件夹
 *   agents/<分身>/(记忆、日志、日程、工作笔记、会话都从零开始),config.toml 里 stand_in_of = 本体。只留本机(contracts isStandInSlugShape)。
 * - 人设:按字段白名单每次从本体现读(SOUL、工作指令、名字、模型与思考档、技能、内置工具名单),不复制;「共用默认记忆」强制关,
 *   MCP 不给,Library 只给本体勾的文件(那几份的路径进权限域,不进 libraryOrder)。
 * - 开关在本体:stand_in_off 记用户关掉的那几组通道('im' / 'plugin'),缺席 = 都开;关掉的那组照旧由本体回答(= 以前的行为)。
 * - 通道配置里存的仍是本体 slug;会话里可能存着分身 slug(引擎写穿的),解析前一律先剥回本体,所以驱动钉的、会话存的、
 *   通道设置的都当「本体」输入 —— 插件不能借钉一个分身 slug 把 A 的话送进 B 的分身。
 */
import { createHash } from 'node:crypto';
import { AgentExistsError, getAgent, isValidSlug, saveAgent, type NormalAgentDef } from './agentRegistry.js';
import { isStandInSlugShape } from '../contracts/agentSyncRules.js';

export { isStandInSlugShape };

/** 自动换分身的两组通道(配置页两个勾):内置 IM + 企业微信 / 其他插件接进来的通道。 */
export type StandInGroup = 'im' | 'plugin';
const IM_KINDS = new Set(['wechat', 'telegram', 'qq', 'wecom']);
export function standInGroupOf(kind: string): StandInGroup {
  return IM_KINDS.has(kind) ? 'im' : 'plugin';
}
/** 这个本体在这种通道里换不换分身(缺省换;用户关过的那组不换)。 */
export function standInEnabled(body: Pick<NormalAgentDef, 'standInOff'>, kind: string): boolean {
  return !(body.standInOff ?? []).includes(standInGroupOf(kind));
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** 联系人键(账号 + 联系人):一个联系人一个分身。只取哈希,联系人 id 本身不落进 slug / 文件夹名。 */
export function standInPeerKey(accountId: string, peerId: string): string {
  return sha(`${accountId}\u0000${peerId}`).slice(0, 8);
}

/** 分身 slug:`<本体>-standin-<通道>[-<联系人哈希>]`;超过 64 字(或拼出来不合法)就截本体那段、尾巴换成整串的哈希,`-standin-` 一直在。 */
export function standInSlugFor(body: string, kind: string, peerKey?: string): string {
  const full = `${body}-standin-${kind}${peerKey ? `-${peerKey}` : ''}`;
  if (full.length <= 64 && isValidSlug(full) && isStandInSlugShape(full)) return full;
  const tail = `-standin-${sha(full).slice(0, 10)}`;
  const head = body.slice(0, 64 - tail.length).replace(/-+$/, '') || 'a';
  return `${head}${tail}`;
}

/** 人设白名单:这些字段每次从本体现读,其余是分身自己的(或强制关掉的)。 */
export function mergeStandInPersona(own: NormalAgentDef, body: NormalAgentDef | null): NormalAgentDef {
  const merged: NormalAgentDef = {
    ...own,
    // 记忆域只认自己;不共用默认记忆、不上云、不读活动日志、不带 MCP、不带本体的 Library 顺序
    shareDefaultMemory: false,
    cloudSync: false,
    activityAccess: false,
    enabledMcpServers: [],
    libraryOrder: [],
    tools: [],
  };
  if (!body) return merged;
  return {
    ...merged,
    // 对模型自称本体的名字(身份段);名册里的「本体名 · 通道名」只给人看
    name: body.name, nameZh: body.nameZh, nameEn: body.nameEn, namePref: body.namePref, description: body.description,
    soul: body.soul,
    systemPrompt: body.systemPrompt,
    model: body.model,
    thinkingLevel: body.thinkingLevel,
    enabledSkillIds: body.enabledSkillIds,
    toolsStrict: body.toolsStrict,
    toolsMode: body.toolsMode,
    toolsList: body.toolsList,
  };
}

/** 持久身份:这个 slug 是不是分身(后台的 Dream / Historian 用它,不看会话此刻绑没绑通道)。形状对上就算(新建普通 Agent 不许用这个形状),
 *  形状不对再读 config.toml —— 读不到按「不是」:调用方都在「是分身就少给」的方向上用它,老路本身对通道会话也有一层按绑定的挡。 */
export async function isStandInSlug(slug: string | undefined | null): Promise<boolean> {
  if (!slug) return false;
  if (isStandInSlugShape(slug)) return true;
  return !!(await getAgent(slug).catch(() => null))?.standInOf;
}

/** 运行时取 Agent 定义:分身拿人设合并后的那份(本体现读),别的原样。agentLoop 激活、语音人设共用这一个。 */
export async function getAgentForRun(slug: string): Promise<NormalAgentDef | null> {
  const def = await getAgent(slug);
  if (!def?.standInOf) return def;
  return mergeStandInPersona(def, await getAgent(def.standInOf).catch(() => null));
}

export type RunIdentity =
  | { kind: 'self'; slug: string }
  | { kind: 'standin'; slug: string; bodySlug: string; channel?: string; peerKey?: string };

export interface ChannelSource { kind: string; accountId?: string; peerId?: string; multiPeer?: boolean }

/** 把任何输入 slug 剥回本体(分身 → 它的 stand_in_of;别的原样)。 */
export async function bodySlugOf(slug: string): Promise<string> {
  if (!slug || !isValidSlug(slug)) return slug;
  const def = await getAgent(slug).catch(() => null);
  return def?.standInOf && isValidSlug(def.standInOf) ? def.standInOf : slug;
}

/**
 * 唯一的解析器:这次运行是谁。通道 run(channel 有值)按本体的开关决定给本体还是分身;不是通道的 run,选中的是分身就仍是分身
 * (分身身份是持久的:主人在桌面上打开分身的会话接着聊,照样是分身的权限域),否则是自己。不建文件夹(建在 ensureStandIn)。
 */
export async function resolveRunIdentity(selectedSlug: string, channel?: ChannelSource | null): Promise<RunIdentity> {
  const selected = await getAgent(selectedSlug).catch(() => null);
  if (!channel?.kind) {
    return selected?.standInOf ? { kind: 'standin', slug: selectedSlug, bodySlug: selected.standInOf, channel: selected.standInChannel } : { kind: 'self', slug: selectedSlug };
  }
  const bodySlug = selected?.standInOf || selectedSlug;
  const body = bodySlug === selectedSlug ? selected : await getAgent(bodySlug).catch(() => null);
  // 本体不在(被删了 / 坏了):不换,交给 agentLoop 照旧报「选中的 Agent 激活不了」
  if (!body || body.standInOf || !standInEnabled(body, channel.kind)) return { kind: 'self', slug: bodySlug };
  const peerKey = channel.multiPeer && channel.peerId ? standInPeerKey(String(channel.accountId || ''), String(channel.peerId)) : undefined;
  let slug = standInSlugFor(bodySlug, channel.kind, peerKey);
  const taken = await getAgent(slug).catch(() => null);
  // 撞上一个不是这位本体分身的同名 Agent(形状保留之前手建的):换一个带哈希的,不借别人的文件夹
  if (taken && taken.standInOf !== bodySlug) slug = standInSlugFor(`${bodySlug}-${sha(`${slug}\u0000alt`).slice(0, 6)}`, channel.kind, peerKey);
  return { kind: 'standin', slug, bodySlug, channel: channel.kind, ...(peerKey ? { peerKey } : {}) };
}

/** 第一次用到时建分身(文件夹 + config.toml,stand_in_of = 本体)。并发两条同时建:后到的吃 AgentExistsError,用先建好的。 */
export async function ensureStandIn(id: Extract<RunIdentity, { kind: 'standin' }>, channelName?: { zh: string; en: string }): Promise<NormalAgentDef> {
  const existing = await getAgent(id.slug);
  if (existing) {
    if (existing.standInOf !== id.bodySlug) throw new Error(`Agent "${id.slug}" exists but is not a stand-in of "${id.bodySlug}".`);
    return existing;
  }
  const body = await getAgent(id.bodySlug);
  if (!body) throw new Error(`Agent "${id.bodySlug}" was not found.`);
  const ch = channelName ?? { zh: id.channel || '', en: id.channel || '' };
  const zh = (body.nameZh || body.name).trim();
  const en = (body.nameEn || '').trim();
  const peer = id.peerKey ? ` · ${id.peerKey.slice(0, 4)}` : '';
  try {
    return await saveAgent({
      slug: id.slug,
      name: `${zh} · ${ch.zh.trim() || ch.en}${peer}`,
      nameZh: `${zh} · ${ch.zh.trim() || ch.en}${peer}`,
      // 英文名不许有汉字:本体没有英文名就不写(界面回落中文名)
      ...(en ? { nameEn: `${en} · ${ch.en.trim()}${peer}`.replace(/\p{Script=Han}/gu, '').trim() } : {}),
      description: '',
      // 分身自己的指令不用(人设每次从本体现读);新建时必须非空
      systemPrompt: `Stand-in of ${id.bodySlug}. The persona is read from ${id.bodySlug} on every run.`,
      standInOf: id.bodySlug,
      ...(id.channel ? { standInChannel: id.channel } : {}),
      ...(id.peerKey ? { standInPeer: id.peerKey } : {}),
      mustNotExist: true,
    });
  } catch (e) {
    if (e instanceof AgentExistsError) {
      const now = await getAgent(id.slug);
      if (now?.standInOf === id.bodySlug) return now;
    }
    throw e;
  }
}
