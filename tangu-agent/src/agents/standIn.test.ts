/**
 * Agent 分身(11-09):身份解析、注册表(建 / 列 / 删)、人设白名单、只留本机。独立 TANGU_HOME,别的用例的 ensureAgentsReady 记忆化不串。
 * 权限域的判定(工具面 / 读写根 / 委派)见 services/accessDomain.test.ts。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('分身 slug 与同步规则(纯函数)', () => {
  it('形状 = <本体>-standin-<通道>[-<联系人>],合法、≤64,超长截断后仍带 -standin-', async () => {
    const { standInSlugFor, standInPeerKey, isStandInSlugShape } = await import('./standIn.js');
    const { isValidSlug } = await import('./agentRegistry.js');
    expect(standInSlugFor('aria', 'wechat')).toBe('aria-standin-wechat');
    const a = standInPeerKey('acct', 'peer-a'), b = standInPeerKey('acct', 'peer-b');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(standInSlugFor('aria', 'wecom', a)).toBe(`aria-standin-wecom-${a}`);
    const long = standInSlugFor('x'.repeat(60), 'wecom', a);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(isValidSlug(long) && isStandInSlugShape(long)).toBe(true);
    // 长本体的两个联系人也分得开
    expect(standInSlugFor('x'.repeat(60), 'wecom', b)).not.toBe(long);
    expect(isStandInSlugShape('aria')).toBe(false);
    expect(isStandInSlugShape('my-standin-helper')).toBe(true); // 形状就是身份:新建普通 Agent 不许用(见下)
  });

  it('分身文件夹只留本机:两套同步都不碰 agents/<分身>/', async () => {
    const { agentSlugLocalOnly, agentContentSyncable } = await import('../contracts/agentSyncRules.js');
    expect(agentSlugLocalOnly('nova-standin-wechat')).toBe(true);
    expect(agentSlugLocalOnly('aria')).toBe(false);
    expect(agentContentSyncable('agents/aria-standin-wechat/MEMORY.md')).toBe(false);
    expect(agentContentSyncable('agents/aria-standin-wechat', 'folder')).toBe(false);
    expect(agentContentSyncable('agents/aria/MEMORY.md')).toBe(true);
  });

  it('自动换分身的分组:微信 / 企业微信 / Telegram / QQ = im,其余插件通道 = plugin;关过的那组不换', async () => {
    const { standInGroupOf, standInEnabled } = await import('./standIn.js');
    expect(['wechat', 'wecom', 'telegram', 'qq'].map(standInGroupOf)).toEqual(['im', 'im', 'im', 'im']);
    expect(standInGroupOf('livechan')).toBe('plugin');
    expect(standInEnabled({}, 'wechat')).toBe(true); // 缺省开
    expect(standInEnabled({ standInOff: ['im'] }, 'wecom')).toBe(false);
    expect(standInEnabled({ standInOff: ['im'] }, 'livechan')).toBe(true);
    expect(standInEnabled({ standInOff: [] }, 'livechan')).toBe(true);
  });
});

describe('分身:注册表、解析器、人设白名单', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-standin-'));
    process.env.TANGU_HOME = home;
    const { saveAgent } = await import('./agentRegistry.js');
    await saveAgent({ slug: 'nova', name: 'Aria', nameEn: 'Aria', systemPrompt: 'You are Aria.', soul: 'warm', description: 'mine', model: 'm1', thinkingLevel: 'high', shareDefaultMemory: true, toolsMode: 'deny', toolsList: ['web_search'] });
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('新建普通 Agent 不许占 -standin- 的形状', async () => {
    const { saveAgent } = await import('./agentRegistry.js');
    await expect(saveAgent({ slug: 'bob-standin-wechat', name: 'Bob', systemPrompt: 'x' })).rejects.toThrow(/reserved for stand-ins/);
  });

  it('解析器:不是通道 → 自己;通道 → 本体的分身(缺省开);多联系人按联系人分开;关掉那组 → 本体', async () => {
    const { resolveRunIdentity, standInPeerKey } = await import('./standIn.js');
    expect(await resolveRunIdentity('nova', null)).toEqual({ kind: 'self', slug: 'nova' });
    expect(await resolveRunIdentity('nova', { kind: 'wechat', accountId: 'acc', peerId: 'p' })).toEqual({ kind: 'standin', slug: 'nova-standin-wechat', bodySlug: 'nova', channel: 'wechat' });
    const a = await resolveRunIdentity('nova', { kind: 'livechan', accountId: 'acc', peerId: 'peer-a', multiPeer: true });
    const b = await resolveRunIdentity('nova', { kind: 'livechan', accountId: 'acc', peerId: 'peer-b', multiPeer: true });
    expect(a.slug).toBe(`nova-standin-livechan-${standInPeerKey('acc', 'peer-a')}`);
    expect(b.slug).not.toBe(a.slug);
    const { patchAgent } = await import('./agentRegistry.js');
    await patchAgent('nova', { standInOff: ['plugin'] });
    expect(await resolveRunIdentity('nova', { kind: 'livechan', accountId: 'acc', peerId: 'peer-a', multiPeer: true })).toEqual({ kind: 'self', slug: 'nova' });
    expect((await resolveRunIdentity('nova', { kind: 'wechat' })).kind).toBe('standin'); // 另一组照旧
    await patchAgent('nova', { standInOff: [] });
  });

  it('建分身:文件夹 + stand_in_of;名字「本体名 · 通道名」;并发两次只建一个;listAgents 不列、listStandIns 列', async () => {
    const { resolveRunIdentity, ensureStandIn } = await import('./standIn.js');
    const { listAgents, listStandIns, getAgent } = await import('./agentRegistry.js');
    const id = await resolveRunIdentity('nova', { kind: 'wechat' });
    if (id.kind !== 'standin') throw new Error('expected stand-in');
    const [x, y] = await Promise.all([ensureStandIn(id, { zh: '微信', en: 'WeChat' }), ensureStandIn(id, { zh: '微信', en: 'WeChat' })]);
    expect(x.slug).toBe('nova-standin-wechat');
    expect(y.slug).toBe(x.slug);
    const def = await getAgent('nova-standin-wechat');
    expect(def?.standInOf).toBe('nova');
    expect(def?.standInChannel).toBe('wechat');
    expect(def?.nameZh).toBe('Aria · 微信');
    expect(def?.nameEn).toBe('Aria · WeChat');
    expect(existsSync(path.join(home, 'agents', 'nova-standin-wechat', 'config.toml'))).toBe(true);
    expect((await listAgents()).map((a) => a.slug)).not.toContain('nova-standin-wechat');
    expect((await listStandIns('nova')).map((a) => a.slug)).toEqual(['nova-standin-wechat']);
    expect(await listStandIns('nobody')).toEqual([]);
  });

  it('驱动钉的 / 会话存的分身 slug 先剥回本体再解析:钉 B 的分身也落回 A 自己的分身', async () => {
    const { resolveRunIdentity, ensureStandIn } = await import('./standIn.js');
    const b = await resolveRunIdentity('nova', { kind: 'livechan', accountId: 'acc', peerId: 'peer-b', multiPeer: true });
    if (b.kind !== 'standin') throw new Error('expected stand-in');
    await ensureStandIn(b, { zh: '台架', en: 'Harness' });
    const a = await resolveRunIdentity(b.slug, { kind: 'livechan', accountId: 'acc', peerId: 'peer-a', multiPeer: true });
    expect(a.kind === 'standin' && a.bodySlug === 'nova' && a.slug !== b.slug).toBe(true);
    // 不是通道的 run 选中的就是分身:仍是分身(持久身份)
    expect(await resolveRunIdentity(b.slug, null)).toEqual({ kind: 'standin', slug: b.slug, bodySlug: 'nova', channel: 'livechan' });
  });

  it('人设白名单每次从本体现读;共用默认记忆 / 云同步 / MCP / Library 顺序强制关;改了本体下一次就跟上', async () => {
    const { getAgentForRun } = await import('./standIn.js');
    const { patchAgent, resolveMemorySlug } = await import('./agentRegistry.js');
    const run = await getAgentForRun('nova-standin-wechat');
    expect(run?.soul).toBe('warm');
    expect(run?.systemPrompt).toBe('You are Aria.');
    expect(run?.model).toBe('m1');
    expect(run?.thinkingLevel).toBe('high');
    expect(run?.toolsMode).toBe('deny');
    expect(run?.name).toBe('Aria'); // 对模型自称本体的名字
    expect(run?.standInOf).toBe('nova');
    expect(run?.shareDefaultMemory).toBe(false);
    expect(resolveMemorySlug(run!)).toBe('nova-standin-wechat'); // 记忆域是它自己(本体共用默认记忆也不跟)
    expect(run?.enabledMcpServers).toEqual([]);
    await patchAgent('nova', { soul: 'calm' });
    expect((await getAgentForRun('nova-standin-wechat'))?.soul).toBe('calm');
    expect((await getAgentForRun('nova'))?.soul).toBe('calm'); // 本体原样
  });

  it('分身那一节的设置存在本体:关过的组、勾的 Library 文件(只认相对路径)、AGENT.md 开关;建好的分身身份改不了', async () => {
    const { patchAgent, getAgent } = await import('./agentRegistry.js');
    await patchAgent('nova', { standInOff: ['im', 'bogus'], standInLibrary: ['notes/a.md', '../escape.md', '/abs.md'], standInAgentMd: true });
    const body = await getAgent('nova');
    expect(body?.standInOff).toEqual(['im']);
    expect(body?.standInLibrary).toEqual(['notes/a.md']);
    expect(body?.standInAgentMd).toBe(true);
    await patchAgent('nova-standin-wechat', { name: 'Renamed' });
    expect((await getAgent('nova-standin-wechat'))?.standInOf).toBe('nova');
    await patchAgent('nova', { standInOff: [], standInLibrary: [], standInAgentMd: false });
  });

  it('isStandInSlug 按持久身份判', async () => {
    const { isStandInSlug } = await import('./standIn.js');
    expect(await isStandInSlug('nova-standin-wechat')).toBe(true);
    expect(await isStandInSlug('nova')).toBe(false);
    expect(await isStandInSlug(undefined)).toBe(false);
  });

  it('agents-meta:分身不进顺序、不能当缺省 Agent', async () => {
    const { normalizeAgentsMeta } = await import('./agentRegistry.js');
    expect(normalizeAgentsMeta({ order: ['nova', 'nova-standin-wechat'], defaultSlug: 'nova-standin-wechat' })).toEqual({ order: ['nova'], defaultSlug: 'xyra' });
  });

  it('删本体:分身一起进同一条回收站;删分身不碰本体', async () => {
    const { saveAgent, trashAgent, getAgent, listStandIns } = await import('./agentRegistry.js');
    const { resolveRunIdentity, ensureStandIn } = await import('./standIn.js');
    await saveAgent({ slug: 'kai', name: 'Kai', systemPrompt: 'k' });
    const id = await resolveRunIdentity('kai', { kind: 'qq' });
    if (id.kind !== 'standin') throw new Error('expected stand-in');
    await ensureStandIn(id);
    const s2 = await resolveRunIdentity('kai', { kind: 'telegram' });
    if (s2.kind !== 'standin') throw new Error('expected stand-in');
    await ensureStandIn(s2);
    expect(await trashAgent(s2.slug)).toMatchObject({ ok: true });
    expect(await getAgent('kai')).not.toBeNull();
    const r = await trashAgent('kai');
    expect(r.ok).toBe(true);
    expect(r.entry?.items.filter((i) => i.role === 'standin').length).toBe(1);
    expect(existsSync(path.join(home, 'agents', id.slug))).toBe(false);
    expect(await listStandIns('kai')).toEqual([]);
    writeFileSync(path.join(home, 'agents', '.keep'), ''); // 目录还在,别的用例不受影响
  });
});
