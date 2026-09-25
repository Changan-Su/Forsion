/**
 * Agent 落盘的同 slug 队(Codex 09-25 二轮 #3 #4):
 *   #3 头像上传 / 删除旧口径在锁外 getAgent 读 cur,再把 cur 的每个字段(含审批档)经 saveAgent 显式写回 ——
 *      排在它前面的用户收紧(full-auto → readonly)与改模型,被这份旧快照盖回去。现在读-写整段入队、审批档传 KEEP_APPROVAL_MODE。
 *   #4 deleteAgent 旧口径不入队:mustExist 的保存在锁内读到 existing 之后被删,随后 mkdir 把目录建回来、写回旧定义(复活)。
 *      现在删除与保存共用一条队;基于已有 agent 的写不再建目录,落盘那一刻 config.toml 不在了(锁外的删除)就报错。
 *
 * 注入点(与 manageAgentApprovalRace 同法):spy node:fs 的 promises.readFile / writeFile / rm,把另一方卡在
 * 「一方已读、尚未写」的窗口里。无锁时这个窗口必然被另一方插进来;有锁时插不进来,卡点在超时后放行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getAgent, saveAgent, deleteAgent, saveAgentAvatar, deleteAgentAvatar, KEEP_APPROVAL_MODE,
} from '../src/agents/agentRegistry.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';

// 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const userSave = (approvalMode: 'readonly' | 'full-auto', model = 'm1'): Promise<unknown> =>
  saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', model, approvalMode, createdBy: 'user' });
const cfgOf = (slug: string): string => path.join(agentsDir(), slug, 'config.toml');
const soulOf = (slug: string): string => path.join(agentsDir(), slug, 'SOUL.md');

let home = '';
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'tangu-agent-lock-'));
  process.env.TANGU_HOME = home;
  mkdirSync(agentsDir(), { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/**
 * 用户那次收紧的 config.toml 写入卡住,直到「有人在它落盘前读了 config.toml」(无锁时就是头像操作的旧快照读),
 * 或 150ms 超时(有锁时头像操作排在后面,读不到)。
 */
function holdUserWriteUntilSomeoneReads(): void {
  const cfg = cfgOf('bot');
  const realRead = fsp.readFile.bind(fsp) as (...a: any[]) => Promise<any>;
  const realWrite = fsp.writeFile.bind(fsp) as (...a: any[]) => Promise<void>;
  let pending = false;
  let sawRead!: () => void;
  const readWhilePending = new Promise<void>((r) => { sawRead = r; });
  vi.spyOn(fsp, 'readFile').mockImplementation(((...a: any[]) => {
    if (a[0] === cfg && pending) sawRead();
    return realRead(...a);
  }) as any);
  vi.spyOn(fsp, 'writeFile').mockImplementation((async (...a: any[]) => {
    if (a[0] === cfg && String(a[1]).includes('approval_mode = "readonly"')) {
      pending = true;
      await Promise.race([readWhilePending, sleep(150)]);
      pending = false;
    }
    return realWrite(...a);
  }) as any);
}

/** 某次操作读完 <slug>/SOUL.md(= getAgent 读完整个 agent)之后卡住,直到 release();只卡第一次。 */
function holdAfterAgentRead(slug: string): { reached: Promise<void>; release: () => void } {
  const soul = soulOf(slug);
  const realRead = fsp.readFile.bind(fsp) as (...a: any[]) => Promise<any>;
  let armed = true;
  let reachedR!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { reachedR = r; });
  const gate = new Promise<void>((r) => { release = r; });
  vi.spyOn(fsp, 'readFile').mockImplementation((async (...a: any[]) => {
    const r = await realRead(...a);
    if (armed && a[0] === soul) {
      armed = false;
      reachedR();
      await gate;
    }
    return r;
  }) as any);
  return { reached, release };
}

describe('#3 头像操作不写回旧快照', () => {
  it('上传头像 × 用户同时把 full-auto 收紧成 readonly、改了模型 → 收紧与新模型都留下', async () => {
    await userSave('full-auto', 'm1');
    holdUserWriteUntilSomeoneReads();
    const user = userSave('readonly', 'm2');
    const avatar = saveAgentAvatar('bot', PNG, 'image/png');
    await Promise.all([user, avatar]);
    vi.restoreAllMocks();
    expect(await getAgent('bot')).toMatchObject({ approvalMode: 'readonly', model: 'm2', avatar: 'avatar.png' });
  });

  it('删除头像 × 用户同时收紧 → 收紧留下', async () => {
    await userSave('full-auto', 'm1');
    await saveAgentAvatar('bot', PNG, 'image/png');
    holdUserWriteUntilSomeoneReads();
    const user = userSave('readonly', 'm2');
    const avatar = deleteAgentAvatar('bot');
    await Promise.all([user, avatar]);
    vi.restoreAllMocks();
    const d = await getAgent('bot');
    expect(d).toMatchObject({ approvalMode: 'readonly', model: 'm2' });
    expect(d?.avatar).toBeFalsy();
  });

  it('上传头像读到 agent 之后它被删了 → 不把目录建回来、不复活', async () => {
    await userSave('readonly');
    const { reached, release } = holdAfterAgentRead('bot');
    const avatar = saveAgentAvatar('bot', PNG, 'image/png');
    await reached;
    const del = deleteAgent('bot');
    await Promise.race([del, sleep(150)]); // 无锁:删除当场做完;有锁:排在头像后面
    release();
    await Promise.allSettled([avatar, del]);
    vi.restoreAllMocks();
    expect(await del).toBe(true);
    expect(existsSync(path.join(agentsDir(), 'bot'))).toBe(false);
    expect(await getAgent('bot')).toBeNull();
  });
});

describe('#4 删除与保存同队', () => {
  it('mustExist 的保存读到 existing 之后,并发的 deleteAgent 不会被它撤销(不复活)', async () => {
    await userSave('readonly');
    const { reached, release } = holdAfterAgentRead('bot');
    const save = saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', model: 'm9', approvalMode: KEEP_APPROVAL_MODE, mustExist: true });
    await reached;
    const del = deleteAgent('bot');
    await Promise.race([del, sleep(150)]);
    release();
    const [s, d] = await Promise.allSettled([save, del]);
    vi.restoreAllMocks();
    expect(d).toMatchObject({ status: 'fulfilled', value: true });
    expect(s.status).toBe('fulfilled'); // 保存排在删除前面:先落盘,再被删 —— 线性化,不是复活
    expect(existsSync(cfgOf('bot'))).toBe(false);
    expect(await getAgent('bot')).toBeNull();
  });

  it('删除先入队、mustExist 的保存后到 → 保存报 agent not found,不新建', async () => {
    await userSave('readonly');
    const realRm = fsp.rm.bind(fsp) as (...a: any[]) => Promise<void>;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(fsp, 'rm').mockImplementation((async (...a: any[]) => {
      if (a[0] === path.join(agentsDir(), 'bot')) await gate;
      return realRm(...a);
    }) as any);
    const del = deleteAgent('bot');
    await sleep(20);
    const save = saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be evil', model: 'm9', approvalMode: KEEP_APPROVAL_MODE, mustExist: true });
    await sleep(50);
    release();
    await expect(save).rejects.toThrow(/agent not found: bot/);
    expect(await del).toBe(true);
    vi.restoreAllMocks();
    expect(existsSync(path.join(agentsDir(), 'bot'))).toBe(false);
  });

  it('基于已有 agent 的保存:落盘那一刻 config.toml 已被锁外删掉(别的进程 / 手动)→ 报错,不把目录建回来', async () => {
    await userSave('readonly');
    const { reached, release } = holdAfterAgentRead('bot');
    const save = saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', model: 'm9' }); // 连 mustExist 都没带
    await reached;
    rmSync(path.join(agentsDir(), 'bot'), { recursive: true, force: true }); // 不经 deleteAgent,锁看不见
    release();
    await expect(save).rejects.toThrow(/agent not found: bot/);
    vi.restoreAllMocks();
    expect(existsSync(path.join(agentsDir(), 'bot'))).toBe(false);
  });

  it('三轮 #8:上传头像读到 agent 之后它被锁外删掉(别的进程 / 手动)→ 报 agent not found,不留只有 Library/ 的孤儿目录', async () => {
    await userSave('readonly');
    const { reached, release } = holdAfterAgentRead('bot');
    // 连写都不该写:不是「建回来再收走」,而是 <slug>/ 不在就不建(收尾清理是另一道,下一条单测)
    const realWrite = fsp.writeFile.bind(fsp) as (...a: any[]) => Promise<void>;
    const wrote: string[] = [];
    vi.spyOn(fsp, 'writeFile').mockImplementation(((...a: any[]) => { wrote.push(String(a[0])); return realWrite(...a); }) as any);
    const avatar = saveAgentAvatar('bot', PNG, 'image/png');
    await reached;
    rmSync(path.join(agentsDir(), 'bot'), { recursive: true, force: true }); // 不经 deleteAgent,锁看不见
    release();
    await expect(avatar).rejects.toThrow(/agent not found/);
    vi.restoreAllMocks();
    expect(wrote.filter((f) => f.startsWith(path.join(agentsDir(), 'bot')))).toEqual([]);
    expect(existsSync(path.join(agentsDir(), 'bot'))).toBe(false);
    expect(await getAgent('bot')).toBeNull();
  });

  it('三轮 #8:删到一半时写进了头像(锁外的 rm -rf 已过了 Library、还没删 config.toml)→ 收走头像与空目录', async () => {
    await userSave('readonly');
    const adir = path.join(agentsDir(), 'bot');
    const avatarFile = path.join(adir, 'Library', 'avatar.png');
    const realWrite = fsp.writeFile.bind(fsp) as (...a: any[]) => Promise<void>;
    vi.spyOn(fsp, 'writeFile').mockImplementation((async (...a: any[]) => {
      if (a[0] === avatarFile) {
        // 模拟另一个进程的 rm -rf 与我们交错:Library 以外的都删了(含 config.toml),我们随后把头像写进 Library
        for (const f of readdirSync(adir)) if (f !== 'Library') rmSync(path.join(adir, f), { recursive: true, force: true });
      }
      return realWrite(...a);
    }) as any);
    await expect(saveAgentAvatar('bot', PNG, 'image/png')).rejects.toThrow(/agent not found/);
    vi.restoreAllMocks();
    expect(existsSync(adir)).toBe(false);
  });

  it('删除的前置拒绝照旧(默认 agent / 非法 slug 不入队、立即 false);一次失败不卡住同 slug 的后续操作', async () => {
    expect(await deleteAgent(DEFAULT_AGENT_SLUG)).toBe(false);
    expect(await deleteAgent('Bad Slug!')).toBe(false);
    await expect(saveAgentAvatar('ghost', PNG, 'image/png')).rejects.toThrow(/agent not found/);
    await expect(deleteAgentAvatar('ghost')).rejects.toThrow(/agent not found/);
    await expect(saveAgent({ slug: 'ghost', name: 'Ghost', systemPrompt: 'p' })).resolves.toMatchObject({ slug: 'ghost' });
    expect(await saveAgentAvatar('ghost', PNG, 'image/png')).toBe('avatar.png');
    expect(await deleteAgent('ghost')).toBe(true);
    expect(await getAgent('ghost')).toBeNull();
  });
});
