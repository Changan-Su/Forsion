/**
 * 「谁管落盘同步」的两位记号:agents/.cloudsync-default.json 里每个云账号一条(智库同步统一方案第 2 步,契约 §3.7 / 实现期修订 H-1 第 5 条)。
 * 引擎(services/cloudSyncAccount.ts)和桌面宿主(external 引擎模式下直接写这个文件,contentSyncHost.setOfflineContentOwner)共用这一份格式。
 *
 * - human:新同步(Forsion Extend)管「我的资料」(human/,含默认日历)。为 true 时引擎的旧通道不推不拉 human/。
 * - agents:新同步管 Agents 文件夹。为 true 时每个 Agent 的旧授权读作关(第 0 步起 Agents 同步本来就封着)。
 *
 * 落盘形状 `{enabled, revision, owner?:'content', contentOwns?:{human, agents}}`:
 * - 有 contentOwns 按它;没有但 owner:'content' = 两位都是 content(第 2 步之前的老文件,老 claim(true) 写的就是它);
 * - owner:'content' **只在 human 归 content 时写**:第 0 步的老引擎只认 owner,读到就停 human / agents,读不到就照旧同步 human
 *   (Agents 在老引擎里也封着),所以 human 归引擎时老引擎照样把「我的资料」同步下去。
 * 只增不改:别把 owner 的意思改成别的;要加第三位就在 contentOwns 里加字段。
 */
export interface ContentOwns { human: boolean; agents: boolean }
export interface AccountSyncDefault { enabled: boolean; revision: number; owner?: 'content'; contentOwns?: ContentOwns }

export function contentOwnsOf(entry: Partial<AccountSyncDefault> | null | undefined): ContentOwns {
  const owns = entry?.contentOwns;
  if (owns && typeof owns === 'object') return { human: owns.human === true, agents: owns.agents === true };
  if (entry?.owner === 'content') return { human: true, agents: true };
  return { human: false, agents: false };
}

/** 改一位或两位(没给的那位照旧),revision +1(在途的同意凭 revision 作废)。总闸 enabled 原样留着。 */
export function withContentOwns(entry: Partial<AccountSyncDefault> | null | undefined, patch: Partial<ContentOwns>): AccountSyncDefault {
  const cur = contentOwnsOf(entry);
  const owns: ContentOwns = {
    human: typeof patch.human === 'boolean' ? patch.human : cur.human,
    agents: typeof patch.agents === 'boolean' ? patch.agents : cur.agents,
  };
  return {
    enabled: entry?.enabled === true,
    revision: (typeof entry?.revision === 'number' && Number.isSafeInteger(entry.revision) ? entry.revision : 0) + 1,
    ...(owns.human ? { owner: 'content' as const } : {}),
    ...(owns.human || owns.agents ? { contentOwns: owns } : {}),
  };
}
