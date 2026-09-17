/**
 * 云端 per-user Normal Agents 存储(cloudAgentStore)契约:内存桩 agentFiles 之上验证
 * 播种幂等 / per-user 隔离 / upsert 合并 / 墓碑删除 / 头像往返 / meta 缺省与写回。
 * 路由分流(routes/agents.ts)按 cloudAgentsEnabled() 走这里,server 侧真实现是 forsionSeams
 * 的 tangu_agent_files 表——两边共享同一份 buildAgentDef/parse/serialize 纯函数。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';
import type { AgentFileMeta } from '../src/seams/cloudBrain.js';
import {
  cloudAgentsEnabled, cloudListAgents, cloudGetAgent, cloudSaveAgent, cloudDeleteAgent,
  cloudSaveAgentAvatar, cloudReadAgentAvatar, cloudDeleteAgentAvatar,
  cloudReadAgentsMeta, cloudWriteAgentsMeta,
} from '../src/agents/cloudAgentStore.js';
import { DEFAULT_AGENTS } from '../src/agents/agentRegistry.js';
import { LEGACY_PERSONAS } from '../src/agents/legacyPersonas.js';

type Row = { content?: string; contentBase64?: string; isBinary: boolean; mtimeMs: number; size: number; deleted: boolean };

function memAgentFiles() {
  const store = new Map<string, Row>();
  const key = (u: string, s: string, r: string): string => `${u}\u0000${s}\u0000${r}`;
  return {
    store,
    getManifest: async (u: string) => {
      const by = new Map<string, AgentFileMeta[]>();
      for (const [k, v] of store) {
        const [ku, ks, kr] = k.split('\u0000');
        if (ku !== u) continue;
        if (!by.has(ks)) by.set(ks, []);
        by.get(ks)!.push({ relPath: kr, mtimeMs: v.mtimeMs, size: v.size, isBinary: v.isBinary, deleted: v.deleted });
      }
      return [...by.entries()].map(([slug, files]) => ({ slug, files }));
    },
    getFile: async (u: string, s: string, r: string) => store.get(key(u, s, r)) ?? null,
    putFile: async (u: string, s: string, r: string, b: any) => {
      store.set(key(u, s, r), { content: b.content, contentBase64: b.contentBase64, isBinary: !!b.isBinary, mtimeMs: b.mtimeMs, size: b.size, deleted: false });
      return { mtimeMs: b.mtimeMs };
    },
    deleteFile: async (u: string, s: string, r: string, m: number) => {
      store.set(key(u, s, r), { isBinary: false, size: 0, mtimeMs: m, deleted: true });
    },
  };
}

const fakeHost: any = { query: async () => [], authMiddleware: (_req: any, _res: any, next: any) => next(), adminMiddleware: (_req: any, _res: any, next: any) => next() };
const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };

let agentFiles: ReturnType<typeof memAgentFiles>;

function configure(withFiles = true): void {
  agentFiles = memAgentFiles();
  configureTangu({
    host: fakeHost,
    brain: { agentFiles: withFiles ? agentFiles : undefined } as any,
    billing: fakeBilling,
    profile: createAiStudioProfile(), // hostExec=false 的云端多租户基线
    state: {} as any, // cloudAgentStore 不碰 state
  });
}

beforeEach(() => configure());

describe('cloudAgentsEnabled', () => {
  it('true on cloud profile with agentFiles; false without the seam', () => {
    expect(cloudAgentsEnabled()).toBe(true);
    configure(false);
    expect(cloudAgentsEnabled()).toBe(false);
  });
});

describe('cloudListAgents — 虚拟预设(零落库)', () => {
  it('shows the five current presets and serves built-in portraits without storage writes', async () => {
    expect((await cloudListAgents('u1')).map((a) => a.slug)).toEqual(['xyra', 'aria', 'recita', 'coding', 'muse']);
    for (const slug of ['xyra', 'aria', 'recita']) {
      expect((await cloudGetAgent('u1', slug))?.avatar).toBe('avatar.jpg');
      expect((await cloudReadAgentAvatar('u1', slug))?.mimeType).toBe('image/jpeg');
    }
    expect(agentFiles.store.size).toBe(0);
    await cloudDeleteAgentAvatar('u1', 'aria');
    expect(await cloudReadAgentAvatar('u1', 'aria')).toBeNull();
    expect(await cloudReadAgentAvatar('u2', 'aria')).not.toBeNull();
  });

  it('retires stored preset identities regardless of customized fields or default selection, without deleting history', async () => {
    for (const old of LEGACY_PERSONAS.slice(1)) await cloudSaveAgent('u1', old.slug, old as any);
    const before = agentFiles.store.size;
    expect((await cloudListAgents('u1')).map((a) => a.slug)).toEqual(['xyra', 'aria', 'recita', 'coding', 'muse']);
    expect(agentFiles.store.size).toBe(before);
    expect((await cloudGetAgent('u1', 'code-reviewer'))?.systemPrompt).toBe(LEGACY_PERSONAS[2].systemPrompt);
    await cloudSaveAgent('u1', 'code-reviewer', { ...LEGACY_PERSONAS[2], name: 'My reviewer' } as any);
    await agentFiles.putFile('u1', '__meta__', '.meta.json', { content: JSON.stringify({ defaultSlug: 'code-reviewer', order: ['code-reviewer', 'aria'] }), isBinary: false, mtimeMs: 1, size: 100 });
    expect((await cloudListAgents('u1')).some((a) => a.slug === 'code-reviewer')).toBe(false);
    expect(await cloudReadAgentsMeta('u1')).toEqual({ defaultSlug: 'xyra', order: ['aria'] });
    expect(await cloudWriteAgentsMeta('u1', { defaultSlug: 'general-assistant', order: ['writing-polish', 'recita'] }))
      .toEqual({ defaultSlug: 'xyra', order: ['recita'] });
  });

  it('lists built-in presets WITHOUT writing anything to the store', async () => {
    const first = await cloudListAgents('u1');
    expect(first.length).toBe(DEFAULT_AGENTS.length);
    expect(first.some((a) => a.slug === 'xyra')).toBe(true);
    // 关键契约:看列表绝不往用户的 Forsion AI Brain(tangu_agent_files)写任何行
    expect(agentFiles.store.size).toBe(0);
    await cloudListAgents('u1');
    expect(agentFiles.store.size).toBe(0);
  });

  it('virtual presets do NOT enable cloudSync and hydrate via get fallback', async () => {
    const xyra = await cloudGetAgent('u1', 'xyra');
    expect(xyra?.slug).toBe('xyra');
    expect(xyra?.cloudSync ?? false).toBe(false);
    expect(agentFiles.store.size).toBe(0); // get 兜底同样零落库
  });

  it('real stored agent shadows the preset of the same slug', async () => {
    await cloudSaveAgent('u1', 'xyra', { slug: 'xyra', name: 'My Xyra', systemPrompt: 'custom' });
    const list = await cloudListAgents('u1');
    const xyra = list.find((a) => a.slug === 'xyra');
    expect(xyra?.name).toBe('My Xyra'); // 库里的真身盖过内置预设,且不重复出现
    expect(list.filter((a) => a.slug === 'xyra').length).toBe(1);
  });
});

describe('cloudSaveAgent — upsert 合并', () => {
  it('creates then preserves untouched fields on update', async () => {
    await cloudSaveAgent('u1', 'helper', {
      slug: 'helper', name: 'Helper', systemPrompt: 'be helpful', description: 'd1',
      toolsMode: 'allow', toolsList: ['run_bash'],
    });
    // 更新只改 name(不带 toolsMode/toolsList)→ buildAgentDef 保留已有
    const updated = await cloudSaveAgent('u1', 'helper', { slug: 'helper', name: 'Helper2', systemPrompt: 'be helpful', description: 'd1' });
    expect(updated.name).toBe('Helper2');
    expect(updated.toolsMode).toBe('allow');
    expect(updated.toolsList).toEqual(['run_bash']);
    const back = await cloudGetAgent('u1', 'helper');
    expect(back?.name).toBe('Helper2');
    expect(back?.toolsMode).toBe('allow');
  });

  it('rejects new agent without systemPrompt', async () => {
    await expect(cloudSaveAgent('u1', 'empty', { slug: 'empty', name: 'E', systemPrompt: '' })).rejects.toThrow(/systemPrompt/);
  });
});

describe('cloudDeleteAgent', () => {
  it('deleting a virtual preset tombstones it and it never comes back; default agent protected', async () => {
    expect(await cloudDeleteAgent('u1', 'xyra')).toBe(false);
    expect(await cloudDeleteAgent('u1', 'aria')).toBe(true); // 从未物化 → 落 config.toml 墓碑
    const after = await cloudListAgents('u1');
    expect(after.every((a) => a.slug !== 'aria')).toBe(true); // 墓碑过不再合成
  });

  it('tombstones all files of a stored agent', async () => {
    await cloudSaveAgent('u1', 'mine', { slug: 'mine', name: 'Mine', systemPrompt: 'x' });
    expect(await cloudDeleteAgent('u1', 'mine')).toBe(true);
    expect(await cloudGetAgent('u1', 'mine')).toBeNull(); // 非预设 slug → 无兜底,真没了
    expect((await cloudListAgents('u1')).every((a) => a.slug !== 'mine')).toBe(true);
  });

  it('editing a virtual preset materializes it (write-time only)', async () => {
    expect(agentFiles.store.size).toBe(0);
    // PATCH 路由语义:cur=cloudGetAgent(虚拟预设兜底命中),未传字段用 cur 回填
    const cur = await cloudGetAgent('u1', 'recita');
    expect(cur?.systemPrompt).toContain('You are Recita');
    const updated = await cloudSaveAgent('u1', 'recita', {
      slug: 'recita', name: '我的审查员', systemPrompt: cur!.systemPrompt,
    });
    expect(updated.name).toBe('我的审查员');
    expect(updated.systemPrompt).toBe(cur!.systemPrompt);
    expect(agentFiles.store.size).toBeGreaterThan(0); // 显式编辑才落库
    const back = await cloudGetAgent('u1', 'recita');
    expect(back?.name).toBe('我的审查员'); // 之后读到的是库里的真身
  });
});

describe('avatar 往返', () => {
  const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');

  it('save → read round-trips bytes and updates config.avatar; delete clears it', async () => {
    await cloudSaveAgent('u1', 'ava', { slug: 'ava', name: 'Ava', systemPrompt: 'x' });
    const fname = await cloudSaveAgentAvatar('u1', 'ava', PNG_B64, 'image/png');
    expect(fname).toBe('avatar.png');
    expect((await cloudGetAgent('u1', 'ava'))?.avatar).toBe('avatar.png');
    const av = await cloudReadAgentAvatar('u1', 'ava');
    expect(av?.mimeType).toBe('image/png');
    expect(av?.data.toString('base64')).toBe(PNG_B64);
    await cloudDeleteAgentAvatar('u1', 'ava');
    expect(await cloudReadAgentAvatar('u1', 'ava')).toBeNull();
    expect((await cloudGetAgent('u1', 'ava'))?.avatar).toBeUndefined();
  });

  it('rejects unsupported mime and oversized image', async () => {
    await cloudSaveAgent('u1', 'ava2', { slug: 'ava2', name: 'Ava2', systemPrompt: 'x' });
    await expect(cloudSaveAgentAvatar('u1', 'ava2', PNG_B64, 'image/tiff')).rejects.toThrow(/unsupported/);
    const big = Buffer.alloc(1_048_577).toString('base64');
    await expect(cloudSaveAgentAvatar('u1', 'ava2', big, 'image/png')).rejects.toThrow(/too large/);
  });
});

describe('agents-meta(__meta__ 哨兵)', () => {
  it('defaults to xyra; write round-trips order/defaultSlug', async () => {
    expect(await cloudReadAgentsMeta('u1')).toEqual({ order: [], defaultSlug: 'xyra' });
    const next = await cloudWriteAgentsMeta('u1', { order: ['aria', 'xyra'], defaultSlug: 'aria' });
    expect(next.defaultSlug).toBe('aria');
    expect(await cloudReadAgentsMeta('u1')).toEqual({ order: ['aria', 'xyra'], defaultSlug: 'aria' });
  });
});
