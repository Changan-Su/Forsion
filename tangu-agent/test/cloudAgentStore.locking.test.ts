/**
 * 云端 cloudAgentStore 的写路径并发契约(审批档重设计 09-25 遗留边 #3):
 *  - 同 user+slug 的保存 / 删除 / 头像读-改-写排进同一条进程内队 —— 头像上传期间用户收紧的审批档不被旧快照盖回;
 *  - 写前「锁内现读」且区分墓碑与虚拟预设 —— 期间被删的 agent 报错、绝不复活(mustExist 语义);
 *  - 进程外写者(桌面同步 / 别的实例,绕过进程内锁)由「上传后再现读」+ config.toml 的 CAS 票据(baseSeq)兜住。
 * 桩:内存 agentFiles,带 seq 与服务端同款 CAS 语义(tanguAgentFilesService.putFile),外加按 relPath 的闸门
 * 把「慢上传」「慢读」卡在指定位置,好让并发写者插进去。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';
import { AgentFileConflictError, type AgentFileMeta } from '../src/seams/cloudBrain.js';
import {
  cloudGetAgent, cloudSaveAgent, cloudPatchAgent, cloudDeleteAgent,
  cloudSaveAgentAvatar, cloudDeleteAgentAvatar, cloudReadAgentAvatar, CloudAgentConflictError,
} from '../src/agents/cloudAgentStore.js';
import { serializeAgentConfig, parseAgentConfig, builtinAgentDef, KEEP_APPROVAL_MODE, AgentNotFoundError, AgentExistsError, type NormalAgentDef } from '../src/agents/agentRegistry.js';

type Row = { content?: string; contentBase64?: string; isBinary: boolean; mtimeMs: number; size: number; deleted: boolean; seq: number };
type Deferred = { promise: Promise<void>; release: () => void; reached: Promise<void>; hit: () => void };

function deferred(): Deferred {
  let release!: () => void;
  let hit!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { hit = r; });
  return { promise, release, reached, hit };
}

/** 服务端 CAS 冲突的两种形状:httpBrain 抛 AgentFileConflictError;服务端进程内 seam 抛 status=409 + body 的 AgentFileCasConflict。 */
type ErrStyle = 'http' | 'server';
function casError(style: ErrStyle, code: 'CONFLICT' | 'EXISTS', row: Row | undefined): Error {
  const info = { code, seq: row && !row.deleted ? row.seq : 0, hash: null, mtimeMs: row?.mtimeMs ?? 0, deleted: !!row?.deleted };
  if (style === 'http') return new AgentFileConflictError(info);
  return Object.assign(new Error(`agent file cas conflict (${code}, seq=${info.seq})`), { status: 409, body: info });
}

/** legacy=true 模拟旧云端:不回 seq、不认 baseSeq(纯 mtime-LWW)—— CAS 兜不住,只能靠锁 + 上传后现读。 */
function memAgentFiles(style: ErrStyle = 'http', legacy = false) {
  const store = new Map<string, Row>();
  const key = (u: string, s: string, r: string): string => `${u}\u0000${s}\u0000${r}`;
  /** relPath → 一次性闸门:命中时先 hit(),再等 release()。put 闸门卡在「写入之前」,get 闸门卡在「读到之后、返回之前」。 */
  const putGates = new Map<string, Deferred>();
  const getGates = new Map<string, Deferred>();
  const casCalls: Array<{ relPath: string; baseSeq: number | undefined }> = [];
  /** SOUL.md 的每次 putFile(另记一份,别混进 casCalls —— 既有断言按 casCalls.at(-1) 取 config.toml 的票据)。 */
  const soulPuts: Array<{ baseSeq: number | undefined; content: string | undefined }> = [];
  const raw = {
    put(u: string, s: string, r: string, b: any): Row {
      const prev = store.get(key(u, s, r));
      const row: Row = { content: b.content, contentBase64: b.contentBase64, isBinary: !!b.isBinary, mtimeMs: b.mtimeMs, size: b.size, deleted: false, seq: (prev?.seq ?? 0) + 1 };
      store.set(key(u, s, r), row);
      return row;
    },
    del(u: string, s: string, r: string, m: number): void {
      const prev = store.get(key(u, s, r));
      store.set(key(u, s, r), { isBinary: false, size: 0, mtimeMs: m, deleted: true, seq: (prev?.seq ?? 0) + 1 });
    },
  };
  return {
    store, putGates, getGates, casCalls, soulPuts, raw,
    row: (u: string, s: string, r: string): Row | undefined => store.get(key(u, s, r)),
    getManifest: async (u: string) => {
      const by = new Map<string, AgentFileMeta[]>();
      for (const [k, v] of store) {
        const [ku, ks, kr] = k.split('\u0000');
        if (ku !== u) continue;
        if (!by.has(ks)) by.set(ks, []);
        by.get(ks)!.push({ relPath: kr, mtimeMs: v.mtimeMs, size: v.size, isBinary: v.isBinary, deleted: v.deleted, ...(legacy ? {} : { seq: v.seq }) });
      }
      return [...by.entries()].map(([slug, files]) => ({ slug, files }));
    },
    getFile: async (u: string, s: string, r: string) => {
      const v = store.get(key(u, s, r));
      const out = v ? { ...v, seq: legacy ? undefined : v.seq } : null;
      const g = getGates.get(r);
      if (g) { getGates.delete(r); g.hit(); await g.promise; }
      return out;
    },
    putFile: async (u: string, s: string, r: string, b: any) => {
      const g = putGates.get(r);
      if (g) { putGates.delete(r); g.hit(); await g.promise; }
      if (r === 'config.toml') casCalls.push({ relPath: r, baseSeq: b.baseSeq });
      if (r === 'SOUL.md') soulPuts.push({ baseSeq: b.baseSeq, content: b.content });
      const cur = store.get(key(u, s, r));
      // 与服务端 putFile 同款 CAS:0 = 仅创建(无行插入 / 墓碑复活 / live 行 → EXISTS);>0 = live 且 seq 相符才写。
      if (legacy) { const row = raw.put(u, s, r, b); return { mtimeMs: row.mtimeMs }; }
      if (b.baseSeq === 0 && cur && !cur.deleted) throw casError(style, 'EXISTS', cur);
      if (typeof b.baseSeq === 'number' && b.baseSeq > 0 && (!cur || cur.deleted || cur.seq !== b.baseSeq)) throw casError(style, 'CONFLICT', cur);
      const row = raw.put(u, s, r, b);
      return { mtimeMs: row.mtimeMs, seq: row.seq };
    },
    deleteFile: async (u: string, s: string, r: string, m: number) => { raw.del(u, s, r, m); },
  };
}

const fakeHost: any = { query: async () => [], authMiddleware: (_req: any, _res: any, next: any) => next(), adminMiddleware: (_req: any, _res: any, next: any) => next() };
const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };

let af: ReturnType<typeof memAgentFiles>;
function configure(style: ErrStyle = 'http', legacy = false): void {
  af = memAgentFiles(style, legacy);
  configureTangu({ host: fakeHost, brain: { agentFiles: af } as any, billing: fakeBilling, profile: createAiStudioProfile(), state: {} as any });
}
beforeEach(() => configure());

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]).toString('base64');
const U = 'u1';

/** 用户在设置页把审批档收紧(走公开的 cloudSaveAgent,整份字段 —— 旧实现里也有这个入口,负对照可比)。 */
const tightenViaSave = (): Promise<NormalAgentDef> =>
  cloudSaveAgent(U, 'bot', { slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', description: 'orig desc', model: 'm-1', approvalMode: 'readonly' });

async function seedFullAuto(slug = 'bot'): Promise<NormalAgentDef> {
  return cloudSaveAgent(U, slug, { slug, name: 'Bot', systemPrompt: 'be a bot', description: 'orig desc', model: 'm-1', approvalMode: 'full-auto', avatar: 'avatar.jpg' });
}

/** 模拟进程外写者(桌面 agentFileSync / 另一个服务实例):直接改库里的 config.toml,绕过进程内锁。 */
function outsideRewrite(slug: string, patch: Partial<NormalAgentDef>): void {
  const row = af.row(U, slug, 'config.toml')!;
  const base = cloudGetAgentSync(slug, row.content!);
  const content = serializeAgentConfig({ ...base, ...patch });
  af.raw.put(U, slug, 'config.toml', { content, isBinary: false, size: content.length, mtimeMs: Date.now() });
}
// 同步解析(outsideRewrite 要在闸门里同步完成,不能再 await 被门住的 getFile)
const cloudGetAgentSync = (slug: string, toml: string): NormalAgentDef => parseAgentConfig(slug, toml, '');

describe('头像上传期间收紧审批档 —— 收紧必须存活', () => {
  it('in-process tighten (public API) issued during a slow upload survives the avatar write', async () => {
    await seedFullAuto();
    const gate = deferred();
    af.putGates.set('Library/avatar.png', gate);
    const avatar = cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    await gate.reached; // 上传卡住
    const tighten = tightenViaSave();
    await new Promise((r) => setTimeout(r, 5)); // 让收紧(若没排队)先落盘
    gate.release();
    await Promise.all([avatar, tighten]);
    const back = await cloudGetAgent(U, 'bot');
    expect(back?.approvalMode).toBe('readonly');
    expect(back?.avatar).toBe('avatar.png');
    expect(back?.description).toBe('orig desc');
  });

  it.each([['CAS backend', false], ['legacy LWW backend (no seq)', true]] as const)('out-of-process tighten (bypassing the lock) during the upload survives: the write re-reads after upload — %s', async (_n, legacy) => {
    configure('http', legacy);
    await seedFullAuto();
    const gate = deferred();
    af.putGates.set('Library/avatar.png', gate);
    const avatar = cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    await gate.reached;
    outsideRewrite('bot', { approvalMode: 'readonly', description: 'desktop desc' });
    gate.release();
    await avatar;
    const back = await cloudGetAgent(U, 'bot');
    expect(back?.approvalMode).toBe('readonly');
    expect(back?.description).toBe('desktop desc');
    expect(back?.avatar).toBe('avatar.png');
    // 旧头像(不同扩展名)在 config 改指新文件之后才墓碑
    expect(af.row(U, 'bot', 'Library/avatar.jpg')?.deleted).toBe(true);
  });

  it('delete-avatar during an in-flight avatar upload keeps approval and ends consistent (config ↔ live file)', async () => {
    await seedFullAuto();
    await cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    const gate = deferred();
    af.putGates.set('Library/avatar.png', gate);
    const avatar = cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    await gate.reached;
    const tighten = tightenViaSave();
    const del = cloudDeleteAgentAvatar(U, 'bot');
    await new Promise((r) => setTimeout(r, 5));
    gate.release();
    await Promise.all([avatar, tighten, del]);
    const back = await cloudGetAgent(U, 'bot');
    expect(back?.approvalMode).toBe('readonly');
    expect(back?.avatar).toBeUndefined(); // 删除排在上传之后 → 最终无头像,且不是「config 指向墓碑文件」
    expect(await cloudReadAgentAvatar(U, 'bot')).toBeNull();
  });
});

describe('头像:config 没写成就不动旧头像', () => {
  it('a CAS conflict on the avatar config write leaves the old avatar live and referenced', async () => {
    await seedFullAuto();
    const JPG_B64 = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64');
    expect(await cloudSaveAgentAvatar(U, 'bot', JPG_B64, 'image/jpeg')).toBe('avatar.jpg');
    const put = deferred();
    af.putGates.set('Library/avatar.png', put);
    const avatar = cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    const settled = avatar.then(() => 'resolved', (e) => String(e?.message || e));
    await put.reached;
    const read = deferred();
    af.getGates.set('SOUL.md', read); // 上传完的那次现读:读完 config.toml 后卡住
    put.release();
    await read.reached;
    outsideRewrite('bot', { approvalMode: 'readonly' }); // 现读之后、落 config 之前,别的设备收紧
    read.release();
    expect(await settled).toMatch(/changed concurrently/);
    const back = await cloudGetAgent(U, 'bot');
    expect(back?.approvalMode).toBe('readonly');
    expect(back?.avatar).toBe('avatar.jpg');
    expect(af.row(U, 'bot', 'Library/avatar.jpg')?.deleted).toBe(false); // 旧头像仍在,config 不会指向死文件
    expect((await cloudReadAgentAvatar(U, 'bot'))?.mimeType).toBe('image/jpeg');
  });
});

describe('头像上传期间 agent 被删 —— 绝不复活', () => {
  it('out-of-process delete during the upload: avatar save rejects, config stays tombstoned, uploaded file is reclaimed', async () => {
    await seedFullAuto();
    const gate = deferred();
    af.putGates.set('Library/avatar.png', gate);
    const avatar = cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    const settled = avatar.then(() => 'resolved', (e) => String(e?.message || e));
    await gate.reached;
    for (const rel of ['config.toml', 'SOUL.md', 'Library/avatar.jpg']) af.raw.del(U, 'bot', rel, Date.now()); // 别的设备删掉了它
    gate.release();
    expect(await settled).toMatch(/not found/);
    expect(af.row(U, 'bot', 'config.toml')?.deleted).toBe(true);
    expect(af.row(U, 'bot', 'Library/avatar.png')?.deleted).toBe(true); // 刚传的头像被收走,不在删掉的 slug 下留活文件
    expect(await cloudGetAgent(U, 'bot')).toBeNull();
  });

  it('in-process delete issued during the upload queues behind it: final state is deleted (no resurrection)', async () => {
    await seedFullAuto();
    const gate = deferred();
    af.putGates.set('Library/avatar.png', gate);
    const avatar = cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    await gate.reached;
    const del = cloudDeleteAgent(U, 'bot');
    await new Promise((r) => setTimeout(r, 5));
    gate.release();
    await avatar;
    expect(await del).toBe(true);
    expect(af.row(U, 'bot', 'config.toml')?.deleted).toBe(true);
    expect(af.row(U, 'bot', 'Library/avatar.png')?.deleted).toBe(true);
    expect(await cloudGetAgent(U, 'bot')).toBeNull();
  });

  it('delete-avatar on an agent deleted earlier rejects and does not resurrect it', async () => {
    await seedFullAuto();
    await cloudDeleteAgent(U, 'bot');
    await expect(cloudDeleteAgentAvatar(U, 'bot')).rejects.toThrow(/not found/);
    expect(af.row(U, 'bot', 'config.toml')?.deleted).toBe(true);
  });
});

describe('mustExist:墓碑 ≠ 虚拟预设', () => {
  it('a tombstoned preset counts as gone for mustExist / patch / avatar; a plain save may re-create it', async () => {
    expect(await cloudDeleteAgent(U, 'aria')).toBe(true); // 从未物化的虚拟预设 → config.toml 墓碑
    await expect(cloudSaveAgent(U, 'aria', { slug: 'aria', name: 'Aria', systemPrompt: 'x', mustExist: true })).rejects.toThrow(/not found/);
    await expect(cloudPatchAgent(U, 'aria', { name: 'Aria 2' })).rejects.toBeInstanceOf(AgentNotFoundError); // 路由据此回 404
    await expect(cloudSaveAgentAvatar(U, 'aria', PNG_B64, 'image/png')).rejects.toThrow(/not found/);
    expect(af.row(U, 'aria', 'config.toml')?.deleted).toBe(true);
    expect(af.row(U, 'aria', 'Library/avatar.png')).toBeUndefined(); // 预检挡在上传之前
    const re = await cloudSaveAgent(U, 'aria', { slug: 'aria', name: 'New Aria', systemPrompt: 'fresh' });
    expect(re.name).toBe('New Aria');
    expect(re.approvalMode).toBe(''); // 重建 = 全新 agent,审批档跟随会话,不继承删掉的那份
  });

  it('a never-materialized preset still counts as existing (editing materializes it)', async () => {
    const p = await cloudPatchAgent(U, 'recita', { name: 'My Recita' });
    expect(p.name).toBe('My Recita');
    expect(af.row(U, 'recita', 'config.toml')?.deleted).toBe(false);
  });

  it('mustNotExist rejects with AgentExistsError when the slug exists at save time (POST route maps it to 409)', async () => {
    await seedFullAuto();
    const p = cloudSaveAgent(U, 'bot', { slug: 'bot', name: 'X', systemPrompt: 'y', mustNotExist: true });
    await expect(p).rejects.toBeInstanceOf(AgentExistsError); // 路由按 instanceof 分流;普通 Error 会落成 400
    await expect(p).rejects.toThrow(/already exists/);
    expect((await cloudGetAgent(U, 'bot'))?.name).toBe('Bot');
  });

  it.each([['CAS', false], ['legacy', true]] as const)('two concurrent creates of one slug: the second waits, sees the first and rejects with AgentExistsError; the first survives (%s)', async (_n, legacy) => {
    configure('http', legacy);
    const gate = deferred();
    af.putGates.set('config.toml', gate); // 第一个创建卡在落盘前
    const first = cloudSaveAgent(U, 'newbot', { slug: 'newbot', name: 'First', systemPrompt: 'a', approvalMode: 'readonly', mustNotExist: true });
    await gate.reached;
    const second = cloudSaveAgent(U, 'newbot', { slug: 'newbot', name: 'Second', systemPrompt: 'b', approvalMode: 'full-auto', mustNotExist: true });
    const secondSettled = second.then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 5));
    gate.release();
    expect((await first).approvalMode).toBe('readonly');
    expect(await secondSettled).toBeInstanceOf(AgentExistsError);
    expect(await cloudGetAgent(U, 'newbot')).toMatchObject({ name: 'First', approvalMode: 'readonly' });
  });
});

describe('cloudPatchAgent —— 省略字段取锁内现读,审批档 KEEP', () => {
  it('fills omitted fields from the current definition and keeps approvalMode unless given', async () => {
    await seedFullAuto();
    const p = await cloudPatchAgent(U, 'bot', { name: 'Bot 2' });
    expect(p).toMatchObject({ name: 'Bot 2', description: 'orig desc', model: 'm-1', approvalMode: 'full-auto', systemPrompt: 'be a bot', avatar: 'avatar.jpg' });
    const q = await cloudPatchAgent(U, 'bot', { approvalMode: '' as any }); // 显式 '' = 跟随会话,照写
    expect(q.approvalMode).toBe('');
  });

  it('function-form fields get the lock-held definition; a throwing guard writes nothing', async () => {
    await seedFullAuto();
    outsideRewrite('bot', { approvalMode: 'readonly' });
    const seen: string[] = [];
    await expect(cloudPatchAgent(U, 'bot', (cur) => { seen.push(cur.approvalMode); throw new Error('guard says no'); })).rejects.toThrow(/guard says no/);
    expect(seen).toEqual(['readonly']);
    const before = af.row(U, 'bot', 'config.toml')!.seq;
    const p = await cloudPatchAgent(U, 'bot', (cur) => ({ description: `${cur.description} +` }));
    expect(p).toMatchObject({ description: 'orig desc +', approvalMode: 'readonly' });
    expect(af.row(U, 'bot', 'config.toml')!.seq).toBe(before + 1);
  });

  it('a patch queued behind an in-flight write sees that write (read happens inside the lock)', async () => {
    await seedFullAuto();
    const gate = deferred();
    af.putGates.set('Library/avatar.png', gate);
    const avatar = cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    await gate.reached;
    const patch = cloudPatchAgent(U, 'bot', { description: 'patched' });
    await new Promise((r) => setTimeout(r, 5));
    gate.release();
    await Promise.all([avatar, patch]);
    const back = await cloudGetAgent(U, 'bot');
    expect(back).toMatchObject({ description: 'patched', avatar: 'avatar.png', approvalMode: 'full-auto' });
  });

  it('KEEP_APPROVAL_MODE on cloudSaveAgent keeps the value read inside the lock', async () => {
    await seedFullAuto();
    const d = await cloudSaveAgent(U, 'bot', { slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', approvalMode: KEEP_APPROVAL_MODE });
    expect(d.approvalMode).toBe('full-auto');
  });
});

describe.each(['http', 'server'] as const)('CAS:现读到落盘之间被进程外写者改过(%s 冲突形状)', (style) => {
  beforeEach(() => configure(style));

  it('rejects instead of writing the stale snapshot back; the outside tighten survives', async () => {
    await seedFullAuto();
    const gate = deferred();
    af.getGates.set('SOUL.md', gate); // readForWrite 读完 config.toml、读 SOUL.md 时卡住
    const patch = cloudPatchAgent(U, 'bot', { name: 'Bot 2' });
    const settled = patch.then(() => 'resolved', (e) => String(e?.message || e));
    await gate.reached;
    outsideRewrite('bot', { approvalMode: 'readonly' });
    gate.release();
    expect(await settled).toMatch(/changed concurrently/);
    const back = await cloudGetAgent(U, 'bot');
    expect(back?.approvalMode).toBe('readonly');
    expect(back?.name).toBe('Bot');
    expect(af.casCalls.at(-1)?.baseSeq).toBeGreaterThan(0);
  });

  it('reports "not found" when the agent was deleted between the read and the write', async () => {
    await seedFullAuto();
    const gate = deferred();
    af.getGates.set('SOUL.md', gate);
    const save = cloudSaveAgent(U, 'bot', { slug: 'bot', name: 'Bot 3', systemPrompt: 'be a bot', approvalMode: KEEP_APPROVAL_MODE });
    const settled = save.then(() => 'resolved', (e) => String(e?.message || e));
    await gate.reached;
    af.raw.del(U, 'bot', 'config.toml', Date.now());
    gate.release();
    expect(await settled).toMatch(/not found/);
    expect(af.row(U, 'bot', 'config.toml')?.deleted).toBe(true);
  });
});

// 保存 / patch 自己也得入队(不只删除和头像):去掉这两处的锁,上面的用例全绿,只有这里红 ——
// 旧云端(无 seq)= 收紧被 patch 的旧快照盖回 full-auto;CAS 云端 = 本该排队的进程内写者被当成并发冲突拒掉。
describe.each([['CAS', false], ['legacy', true]] as const)('save/patch serialize per user+slug (%s)', (_n, legacy) => {
  it('in-process tighten issued while a patch is between read and write survives, and both succeed', async () => {
    configure('http', legacy);
    await seedFullAuto();
    const gate = deferred();
    af.getGates.set('SOUL.md', gate); // patch 的锁内现读读完 config.toml、读 SOUL.md 时卡住
    const patch = cloudPatchAgent(U, 'bot', { description: 'patched' });
    await gate.reached;
    const tighten = tightenViaSave();
    await new Promise((r) => setTimeout(r, 5)); // 让收紧(若没排队)先落盘
    gate.release();
    await Promise.all([patch, tighten]);
    expect((await cloudGetAgent(U, 'bot'))?.approvalMode).toBe('readonly');
  });
});

describe('锁按 user 隔离', () => {
  it('a slow avatar upload for one user does not block the same slug of another user', async () => {
    await seedFullAuto();
    await cloudSaveAgent('u2', 'bot', { slug: 'bot', name: 'Other', systemPrompt: 'x' });
    const gate = deferred();
    af.putGates.set('Library/avatar.png', gate);
    const avatar = cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    await gate.reached;
    const other = await cloudPatchAgent('u2', 'bot', { name: 'Other 2' }); // 不等 u1 的上传
    expect(other.name).toBe('Other 2');
    gate.release();
    await avatar;
  });
});

// ── SOUL.md 独立票据(Codex round-4 #3):config.toml 的 CAS 管不到 SOUL.md。旧口径每次保存都拿锁内现读的人格
//    无条件、无票据地写回 SOUL.md —— 另一台设备只改了人格、网页同时只改名字,名字的 CAS 过了,人格被旧快照盖掉。──

/** 模拟另一台设备只改了人格:直接改库里的 SOUL.md,绕过进程内锁。 */
function outsideSoul(slug: string, content: string): void {
  af.raw.put(U, slug, 'SOUL.md', { content, isBinary: false, size: content.length, mtimeMs: Date.now() });
}
const seedWithSoul = (): Promise<NormalAgentDef> =>
  cloudSaveAgent(U, 'bot', { slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', description: 'orig desc', model: 'm-1', approvalMode: 'full-auto', soul: 'orig soul' });

describe.each(['http', 'server'] as const)('SOUL.md:没改人格不写,改了带自己的票据(%s 冲突形状)', (style) => {
  beforeEach(() => configure(style));

  it('a name-only patch leaves a SOUL.md edited concurrently by another device untouched', async () => {
    await seedWithSoul();
    const puts = af.soulPuts.length;
    const gate = deferred();
    af.getGates.set('SOUL.md', gate); // 锁内现读读到 SOUL.md 之后、返回之前卡住
    const patch = cloudPatchAgent(U, 'bot', { name: 'Bot 2' });
    await gate.reached;
    outsideSoul('bot', 'device soul');
    const deviceSeq = af.row(U, 'bot', 'SOUL.md')!.seq;
    gate.release();
    expect((await patch).name).toBe('Bot 2');
    expect(await cloudGetAgent(U, 'bot')).toMatchObject({ name: 'Bot 2', soul: 'device soul', approvalMode: 'full-auto' });
    expect(af.row(U, 'bot', 'SOUL.md')).toMatchObject({ content: 'device soul', seq: deviceSeq, deleted: false });
    expect(af.soulPuts.length).toBe(puts); // 这次保存根本没写 SOUL.md
  });

  it('a soul change carrying a stale SOUL.md ticket is rejected as a conflict and does not overwrite the device persona', async () => {
    await seedWithSoul();
    const gate = deferred();
    af.getGates.set('SOUL.md', gate);
    const patch = cloudPatchAgent(U, 'bot', { soul: 'mine' });
    const settled = patch.then(() => null, (e) => e);
    await gate.reached;
    outsideSoul('bot', 'device soul');
    const deviceSeq = af.row(U, 'bot', 'SOUL.md')!.seq;
    gate.release();
    const err = await settled;
    expect(err).toBeInstanceOf(CloudAgentConflictError);
    expect(err.file).toBe('SOUL.md');
    expect(String(err.message)).toMatch(/persona \(SOUL\.md\) changed concurrently/);
    expect(String(err.message)).not.toMatch(/Nothing was saved/); // config.toml 已落盘:部分保存必须如实说
    const sent = af.soulPuts.at(-1)!;
    expect(sent.content).toBe('mine');
    expect(sent.baseSeq).toBeGreaterThan(0);
    expect(sent.baseSeq).toBeLessThan(deviceSeq); // 带的是现读时的票据
    expect(af.row(U, 'bot', 'SOUL.md')).toMatchObject({ content: 'device soul', seq: deviceSeq, deleted: false });
    expect((await cloudGetAgent(U, 'bot'))?.soul).toBe('device soul');
  });

  it('an uncontended soul change is written with the ticket read inside the lock', async () => {
    await seedWithSoul();
    const seq = af.row(U, 'bot', 'SOUL.md')!.seq;
    expect((await cloudPatchAgent(U, 'bot', { soul: 'mine' })).soul).toBe('mine');
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: seq, content: 'mine' });
    expect((await cloudGetAgent(U, 'bot'))?.soul).toBe('mine');
  });

  it('avatar writes never touch SOUL.md (delete-avatar racing a device persona edit)', async () => {
    await seedWithSoul();
    const puts = af.soulPuts.length;
    const gate = deferred();
    af.getGates.set('SOUL.md', gate);
    const del = cloudDeleteAgentAvatar(U, 'bot');
    await gate.reached;
    outsideSoul('bot', 'device soul');
    gate.release();
    await del;
    expect((await cloudGetAgent(U, 'bot'))?.soul).toBe('device soul');
    expect(af.soulPuts.length).toBe(puts);
  });
});

describe('SOUL.md 比较基准:虚拟预设 / 孤儿行 / 墓碑重建', () => {
  it('materializing a virtual preset with a name-only patch still writes its persona (create ticket 0)', async () => {
    const preset = builtinAgentDef('recita')!;
    expect(preset.soul.trim()).not.toBe('');
    await cloudPatchAgent(U, 'recita', { name: 'My Recita' });
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: 0, content: preset.soul });
    expect((await cloudGetAgent(U, 'recita'))?.soul).toBe(preset.soul.trim());
  });

  // 口径反转(Codex round-4 复核 #2):上一轮这里是「新建不继承孤儿 SOUL.md —— 拿孤儿行的 seq 把它写成 ''」。
  // 但云端从不单独落 SOUL.md,config.toml 无行时的 live SOUL.md 只能是某台设备推了一半(SOUL.md 按目录序先推),
  // 那是设备上活着的人格:拿它的 seq 写 = 用 CAS「合法地」盖掉它,设备回来还会把盖上去的内容拉回本地。现在给 0 → EXISTS。
  it('creating an agent over a live SOUL.md with no config.toml (a device mid-push) never overwrites it: create ticket 0 → conflict', async () => {
    outsideSoul('fresh', 'device persona');
    const deviceSeq = af.row(U, 'fresh', 'SOUL.md')!.seq;
    const err = await cloudSaveAgent(U, 'fresh', { slug: 'fresh', name: 'Fresh', systemPrompt: 'x', mustNotExist: true }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CloudAgentConflictError);
    expect(err.file).toBe('SOUL.md');
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: 0, content: '' });
    expect(af.row(U, 'fresh', 'SOUL.md')).toMatchObject({ content: 'device persona', seq: deviceSeq, deleted: false });
    expect(af.row(U, 'fresh', 'config.toml')?.deleted).toBe(false); // config.toml 先落了 = 部分保存(报错原文如实说)
    expect((await cloudGetAgent(U, 'fresh'))?.soul).toBe('device persona');
  });

  it('re-creating a deleted agent revives its tombstoned SOUL.md with a create ticket (0)', async () => {
    await seedWithSoul();
    await cloudDeleteAgent(U, 'bot');
    expect(af.row(U, 'bot', 'SOUL.md')?.deleted).toBe(true);
    await cloudSaveAgent(U, 'bot', { slug: 'bot', name: 'Bot', systemPrompt: 'x', soul: 'again' });
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: 0, content: 'again' });
    expect((await cloudGetAgent(U, 'bot'))?.soul).toBe('again');
  });
});

describe('旧云端(无 seq):没改人格照样不写;改了人格仍是 LWW(已知残余,不假装受保护)', () => {
  it('name-only patch skips SOUL.md; a soul change is sent without a ticket', async () => {
    configure('http', true);
    await seedWithSoul();
    const puts = af.soulPuts.length;
    const gate = deferred();
    af.getGates.set('SOUL.md', gate);
    const patch = cloudPatchAgent(U, 'bot', { name: 'Bot 2' });
    await gate.reached;
    outsideSoul('bot', 'device soul');
    gate.release();
    await patch;
    expect((await cloudGetAgent(U, 'bot'))?.soul).toBe('device soul');
    expect(af.soulPuts.length).toBe(puts);
    await cloudPatchAgent(U, 'bot', { soul: 'mine' });
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: undefined, content: 'mine' });
  });
});

// ── Codex round-4 复核 #2:内置预设还没有 config.toml、SOUL.md 却有设备推上来的 live 行(agentFileSync 一文件一请求,
//    SOUL.md 按目录序先推;推完它就断网 / config.toml 那次失败)。旧口径拿那一行自己的 seq 写预设人格 → CAS 必过 →
//    只改名字的 PATCH 把设备人格换成了预设人格(设备回来后「本地=影子、远端变了」→ 再拉回本地,两头都丢)。──
describe.each(['http', 'server'] as const)('虚拟预设 × 设备推了一半的 SOUL.md(%s 冲突形状)', (style) => {
  beforeEach(() => configure(style));

  it('a name-only patch on a config-less preset never overwrites the device SOUL.md, and the state self-heals', async () => {
    const preset = builtinAgentDef('recita')!;
    outsideSoul('recita', 'device recita soul');
    const deviceSeq = af.row(U, 'recita', 'SOUL.md')!.seq;
    const err = await cloudPatchAgent(U, 'recita', { name: 'My Recita' }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CloudAgentConflictError);
    expect(err.file).toBe('SOUL.md');
    expect(String(err.message)).toMatch(/persona \(SOUL\.md\) changed concurrently/);
    expect(String(err.message)).not.toMatch(/Nothing was saved/); // config.toml 已落盘,不许说「什么都没存」
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: 0, content: preset.soul }); // 仅创建的票据,不是设备行的 seq
    expect(af.row(U, 'recita', 'SOUL.md')).toMatchObject({ content: 'device recita soul', seq: deviceSeq, deleted: false });
    // 部分保存之后读得到设备人格(config.toml 在了,cloudGetAgent 不再按预设兜底),再改名字正常落、不碰 SOUL.md。
    expect(await cloudGetAgent(U, 'recita')).toMatchObject({ name: 'My Recita', soul: 'device recita soul' });
    const puts = af.soulPuts.length;
    expect((await cloudPatchAgent(U, 'recita', { name: 'Recita 2' })).soul).toBe('device recita soul');
    expect(af.soulPuts.length).toBe(puts);
    expect(af.row(U, 'recita', 'SOUL.md')).toMatchObject({ content: 'device recita soul', seq: deviceSeq });
  });

  it('a config-less preset whose SOUL.md was deleted (tombstone) still materializes with the create ticket', async () => {
    const preset = builtinAgentDef('recita')!;
    outsideSoul('recita', 'old');
    af.raw.del(U, 'recita', 'SOUL.md', Date.now());
    await cloudPatchAgent(U, 'recita', { name: 'My Recita' });
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: 0, content: preset.soul });
    expect((await cloudGetAgent(U, 'recita'))?.soul).toBe(preset.soul.trim());
  });
});

// ── Codex round-4 复核 #1:buildAgentDef 把 soul 截到 100_000 字,而比较基准是没截过的全文 → 超长人格永远算「改了」,
//    改名字 / 换头像 / 删头像都会把 SOUL.md 重写一遍并悄悄截短。三个入口都得原样不动。──
describe('超长人格(> 100_000 字):没改就不写、不截短', () => {
  const LONG = 'p'.repeat(100_050);
  const seedLong = async (): Promise<number> => {
    await seedWithSoul();
    outsideSoul('bot', LONG); // 公开的 cloudSaveAgent 会截,只能直接落库(桌面写的超长 SOUL.md)
    return af.row(U, 'bot', 'SOUL.md')!.seq;
  };
  const expectUntouched = async (seq: number, puts: number): Promise<void> => {
    expect(af.soulPuts.length).toBe(puts);
    expect(af.row(U, 'bot', 'SOUL.md')).toMatchObject({ seq, deleted: false });
    expect(af.row(U, 'bot', 'SOUL.md')!.content!.length).toBe(100_050);
    expect((await cloudGetAgent(U, 'bot'))?.soul.length).toBe(100_050);
  };

  it('a name-only patch leaves it untouched and answers with the stored persona, not the truncated one', async () => {
    const seq = await seedLong();
    const puts = af.soulPuts.length;
    const d = await cloudPatchAgent(U, 'bot', { name: 'Bot 2' });
    expect(d.name).toBe('Bot 2');
    expect(d.soul.length).toBe(100_050); // 回包 = 存着的那份,不比下一次 GET 短
    await expectUntouched(seq, puts);
  });

  it('saving an avatar leaves it untouched', async () => {
    const seq = await seedLong();
    const puts = af.soulPuts.length;
    expect(await cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png')).toBe('avatar.png');
    await expectUntouched(seq, puts);
  });

  it('deleting the avatar leaves it untouched', async () => {
    await seedWithSoul();
    await cloudSaveAgentAvatar(U, 'bot', PNG_B64, 'image/png');
    outsideSoul('bot', LONG); // 头像先传好再落超长人格:只考删头像这一条入口
    const seq = af.row(U, 'bot', 'SOUL.md')!.seq;
    const puts = af.soulPuts.length;
    expect(await cloudDeleteAgentAvatar(U, 'bot')).toBe(true);
    await expectUntouched(seq, puts);
  });

  it('a real edit inside the first 100_000 chars is still written (capped, with the ticket)', async () => {
    const seq = await seedLong();
    const edited = 'q' + LONG.slice(1);
    const d = await cloudPatchAgent(U, 'bot', { soul: edited });
    expect(d.soul).toBe(edited.slice(0, 100_000));
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: seq, content: edited.slice(0, 100_000) });
    expect((await cloudGetAgent(U, 'bot'))?.soul).toBe(edited.slice(0, 100_000));
  });
});

describe('旧云端(无 seq)× 设备推了一半的 SOUL.md:不假装受保护,照旧 LWW(不发它不认的 0)', () => {
  it('a config-less preset over a live seq-less SOUL.md is written without a ticket', async () => {
    configure('http', true);
    const preset = builtinAgentDef('recita')!;
    outsideSoul('recita', 'device recita soul');
    await cloudPatchAgent(U, 'recita', { name: 'My Recita' });
    expect(af.soulPuts.at(-1)).toEqual({ baseSeq: undefined, content: preset.soul });
  });
});
