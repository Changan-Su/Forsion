/**
 * 分身的权限域(11-09):工具面、文件读写根、搜索起点、委派、画像 / 项目记忆。只测判定本身(纯路径 + 工具注册表),不跑模型。
 * 身份解析与注册表见 agents/standIn.test.ts;真模型下的整条链路是 live 台架 `--only standin`。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ToolContext } from '../tools/toolTypes.js';
import type { AppProfile } from '../seams/appProfile.js';

let home: string;
let work: string;
let dom: import('./accessDomain.js').StandInDomain;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-access-'));
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-access-work-'));
  process.env.TANGU_HOME = path.join(home, 'tangu');
  process.env.FORSION_AMADEUS_VAULT = path.join(home, 'vault');
  for (const d of ['tangu/agents/aria/Library/notes', 'tangu/agents/aria-standin-wechat', 'tangu/agents/kai', 'tangu/human', 'vault']) mkdirSync(path.join(home, d), { recursive: true });
  writeFileSync(path.join(home, 'tangu/agents/aria/MEMORY.md'), '- door 0417\n');
  writeFileSync(path.join(home, 'tangu/agents/aria/Library/notes/shared.md'), 'shared');
  writeFileSync(path.join(home, 'tangu/agents/aria/Library/private.md'), 'private');
  writeFileSync(path.join(home, 'tangu/human/MEMORY.md'), 'plate');
  const { buildStandInDomain } = await import('./accessDomain.js');
  dom = buildStandInDomain({ slug: 'aria-standin-wechat', standInOf: 'aria', standInChannel: 'wechat' },
    { slug: 'aria', standInLibrary: ['notes/shared.md'] } as any, { cwd: work, channel: 'wechat', channelOwner: null });
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
  delete process.env.TANGU_HOME;
  delete process.env.FORSION_AMADEUS_VAULT;
});
const T = (rel: string): string => path.join(home, 'tangu', rel);

describe('读写根', () => {
  it('读:自己的文件夹、工作目录、勾给它的那份 Library 文件可以;本体的记忆 / 没勾的 Library / 别的 Agent / human/ / 笔记库不行', async () => {
    const { standInReadDenied } = await import('./accessDomain.js');
    expect(standInReadDenied(dom, T('agents/aria-standin-wechat/MEMORY.md'))).toBeNull();
    expect(standInReadDenied(dom, path.join(work, 'a.txt'))).toBeNull();
    expect(standInReadDenied(dom, T('agents/aria/Library/notes/shared.md'))).toBeNull();
    for (const p of ['agents/aria/MEMORY.md', 'agents/aria/Library/private.md', 'agents/aria/Library/notes', 'agents/kai/MEMORY.md', 'human/MEMORY.md', 'state.db']) {
      expect(standInReadDenied(dom, T(p)), p).toMatch(/Access denied/);
    }
    expect(standInReadDenied(dom, path.join(home, 'vault', 'Note.md'))).toMatch(/Access denied/);
    expect(standInReadDenied(dom, '/etc/hosts')).toMatch(/Access denied/); // 读根之外一律不给
    expect(standInReadDenied(undefined, T('agents/aria/MEMORY.md'))).toBeNull(); // 不是分身:不管
  });

  it('工作目录把引擎 home 包在底下时,里面那片照样不给(读、列、搜都是)', async () => {
    const { buildStandInDomain, standInReadDenied, standInSearchDenied } = await import('./accessDomain.js');
    const wide = buildStandInDomain({ slug: 'aria-standin-wechat', standInOf: 'aria' }, null, { cwd: home });
    expect(standInReadDenied(wide, T('agents/aria/MEMORY.md'))).toMatch(/Access denied/);
    expect(standInReadDenied(wide, T('human/MEMORY.md'))).toMatch(/Access denied/);
    expect(standInSearchDenied(wide, home)).toMatch(/Access denied/);
    expect(standInSearchDenied(dom, work)).toBeNull();
    expect(standInSearchDenied(dom, T('agents/aria-standin-wechat'))).toBeNull();
    expect(standInSearchDenied(dom, T('agents'))).toMatch(/Access denied/);
  });

  it('写:自己的文件夹和工作目录可以;勾给它的 Library 文件只读;本体 / human/ 不行', async () => {
    const { standInWriteDenied } = await import('./accessDomain.js');
    expect(standInWriteDenied(dom, T('agents/aria-standin-wechat/Library/x.md'))).toBeNull();
    expect(standInWriteDenied(dom, path.join(work, 'out.txt'))).toBeNull();
    expect(standInWriteDenied(dom, T('agents/aria/Library/notes/shared.md'))).toMatch(/Access denied/);
    expect(standInWriteDenied(dom, T('agents/aria/MEMORY.md'))).toMatch(/Access denied/);
    expect(standInWriteDenied(dom, T('human/MEMORY.md'))).toMatch(/Access denied/);
  });

  it('Codex 评审 #2 #5:自己文件夹里指向本体的软链不放行;工作目录包着引擎 home 时,从工作目录起搜照样拒', async () => {
    const { buildStandInDomain, standInReadDenied, standInSearchDenied } = await import('./accessDomain.js');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(T('agents/aria'), T('agents/aria-standin-wechat/escape'));
    expect(standInReadDenied(dom, T('agents/aria-standin-wechat/escape/MEMORY.md'))).toMatch(/Access denied/);
    const wide = buildStandInDomain({ slug: 'aria-standin-wechat', standInOf: 'aria' }, null, { cwd: home });
    expect(standInSearchDenied(wide, home)).toMatch(/Access denied/);
    // 工作目录是引擎 home 的上一层(不在 Forsion 家目录里,本身可读):起点是自己文件夹的祖先,不算「自己的文件夹」
    const above = buildStandInDomain({ slug: 'aria-standin-wechat', standInOf: 'aria' }, null, { cwd: path.dirname(home) });
    expect(standInSearchDenied(above, path.dirname(home))).toMatch(/Access denied/);
    expect(standInSearchDenied(wide, T('agents/aria-standin-wechat'))).toBeNull();
  });

  it('Codex 评审 #6:复制 / 挪走 / 删掉一个底下包着笔记库的目录,整次拒', async () => {
    const { buildStandInDomain } = await import('./accessDomain.js');
    const wide = buildStandInDomain({ slug: 'aria-standin-wechat', standInOf: 'aria' }, null, { cwd: home });
    const { HOST_FILE_OP_TOOLS } = await import('../tools/hostFileOps.js');
    const tool = (n: string) => HOST_FILE_OP_TOOLS[n];
    const ctx = { userId: 'u', cwd: home, execMode: 'host', standIn: wide } as unknown as ToolContext;
    expect(await tool('copy_path').execute({ from: home, to: path.join(work, 'copy') }, ctx)).toMatch(/Access denied/);
    expect(await tool('delete_path').execute({ path: path.join(home, 'vault') }, ctx)).toMatch(/Error/);
  });

  it('fsPolicy 两道闸接上了:checkReadPath 认 ctx.standIn,checkWritePath 硬拒(不进审批)', async () => {
    const { checkReadPath, checkWritePath } = await import('../tools/fsPolicy.js');
    expect(checkReadPath(T('human/MEMORY.md'), { standIn: dom }).ok).toBe(false);
    expect(checkReadPath(T('human/MEMORY.md')).ok).toBe(true); // 不是分身:读闸只挡凭据(旧行为)
    const v = checkWritePath({ userId: 'u', cwd: work, standIn: dom } as ToolContext, T('agents/aria/Library/new.md'));
    expect(v.ok === false && v.hardDeny === true).toBe(true);
  });
});

describe('工具面', () => {
  it('内置白名单:文件 / 记忆 / 会话检索留着;shell、amadeus_*、manage_human、电脑历史、活动日志、会话与讨论都不给', async () => {
    const { standInToolDenied } = await import('./accessDomain.js');
    const core = { isBuiltin: true, fromPlugin: false };
    for (const n of ['read_file', 'write_file', 'remember', 'search_sessions', 'read_session', 'delegate', 'channel_send_file', 'use_skill']) expect(standInToolDenied(dom, n, core), n).toBe(false);
    for (const n of ['run_bash', 'run_background', 'amadeus_list_events', 'amadeus_create_event', 'manage_human', 'read_computer_history', 'read_activity', 'start_session', 'send_to_session', 'start_discussion', 'manage_agent', 'open_path', 'browser_navigate', 'forsion_account', 'brand_new_tool']) {
      expect(standInToolDenied(dom, n, core), n).toBe(true);
    }
    expect(standInToolDenied(undefined, 'run_bash', core)).toBe(false);
  });

  it('插件工具只给注册这个通道的插件的;app / 自定义工具不给', async () => {
    const { standInToolDenied } = await import('./accessDomain.js');
    const owned = { ...dom, channelOwner: 'wecom-plugin' };
    expect(standInToolDenied(owned, 'wecom_send', { isBuiltin: true, fromPlugin: true, ownerPlugin: 'wecom-plugin' })).toBe(false);
    expect(standInToolDenied(owned, 'cal_read', { isBuiltin: true, fromPlugin: true, ownerPlugin: 'calendar' })).toBe(true);
    expect(standInToolDenied(dom, 'wecom_send', { isBuiltin: true, fromPlugin: true, ownerPlugin: 'wecom-plugin' })).toBe(true); // 内置通道:没有驱动插件
    expect(standInToolDenied(dom, 'app_tool', { isBuiltin: false, fromPlugin: false })).toBe(true);
  });

  it('resolveTools 最前面那道闸:defs / 目录 / 执行同一处,分身看不见 run_bash', async () => {
    const { registerToolProvider, resolveTools } = await import('../tools/toolRegistry.js');
    const mk = (name: string) => ({ name, definition: { type: 'function' as const, function: { name, description: name, parameters: {} } }, execute: () => '' });
    registerToolProvider({ id: 'test:standin-core', tools: () => [mk('read_file'), mk('run_bash'), mk('amadeus_list_events')] });
    registerToolProvider({ id: 'test:standin-plugin', origin: 'plugin', ownerPlugin: 'chan-plugin', tools: () => [mk('chan_tool')] });
    const profile = { toolLoadout: { builtins: 'all', providers: [] } } as unknown as AppProfile;
    const base = { userId: 'u', sessionId: 's', appId: 'a' } as ToolContext;
    const names = (ctx: ToolContext) => [...resolveTools(profile, ctx).keys()];
    expect(names(base)).toEqual(expect.arrayContaining(['read_file', 'run_bash', 'amadeus_list_events', 'chan_tool']));
    const seen = names({ ...base, standIn: { ...dom, channelOwner: 'chan-plugin' } });
    expect(seen).toContain('read_file');
    expect(seen).toContain('chan_tool');
    expect(seen).not.toContain('run_bash');
    expect(seen).not.toContain('amadeus_list_events');
    const { visibleMcpTools } = await import('../tools/toolRegistry.js');
    const mcp = new Map([['mcp__x__y', { name: 'mcp__x__y', serverName: 'x', definition: mk('mcp__x__y').definition } as any]]);
    expect(visibleMcpTools({ ...base, preset: undefined, mcpTools: mcp, standIn: dom } as ToolContext, new Set())).toEqual([]);
  });
});

describe('管理工具点名别人(Codex 评审 #1)', () => {
  it('日程只管自己的;工作笔记的 propose 不给', async () => {
    const { standInManageDenied } = await import('./accessDomain.js');
    expect(standInManageDenied(dom, 'manage_schedule', { action: 'list', agent: 'aria' })).toMatch(/own schedule/);
    expect(standInManageDenied(dom, 'manage_schedule', { action: 'list' })).toBeNull();
    expect(standInManageDenied(dom, 'manage_schedule', { action: 'list', agent: 'aria-standin-wechat' })).toBeNull();
    expect(standInManageDenied(dom, 'manage_harness', { action: 'propose', agent: 'kai' })).toMatch(/cannot propose/);
    expect(standInManageDenied(dom, 'manage_harness', { action: 'upsert' })).toBeNull();
    expect(standInManageDenied(undefined, 'manage_schedule', { agent: 'aria' })).toBeNull();
  });
});

describe('委派、画像、项目记忆', () => {
  it('委派:不点名或点名自己可以;点名本体 / 别的 Agent、外部引擎一律拒', async () => {
    const { standInDelegateDenied } = await import('./accessDomain.js');
    expect(standInDelegateDenied(dom, {})).toBeNull();
    expect(standInDelegateDenied(dom, { agentSlug: 'aria-standin-wechat' })).toBeNull();
    expect(standInDelegateDenied(dom, { agentSlug: 'aria' })).toMatch(/cannot delegate/);
    expect(standInDelegateDenied(dom, { agentSlug: 'kai' })).toMatch(/cannot delegate/);
    expect(standInDelegateDenied(dom, { engine: 'claude-code' })).toMatch(/external engines/);
    expect(standInDelegateDenied(undefined, { agentSlug: 'aria' })).toBeNull();
  });

  it('remember 的画像档按身份不给(不看会话此刻连没连通道)', async () => {
    const { configureTangu } = await import('../seams/runtime.js');
    const { createTanguProfile } = await import('../profiles/index.js');
    const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
    configureTangu({ host: stub, brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }) });
    const { personAllowed } = await import('../tools/builtin/memoryLog.js');
    expect(personAllowed({ userId: 'u' } as ToolContext)).toBe(true);
    expect(personAllowed({ userId: 'u', standIn: dom } as ToolContext)).toBe(false);
  });

  it('给模型的那一段:说清是分身、问到私事答不知道,勾给它的文件列出来', async () => {
    const { standInSection } = await import('./standInRun.js');
    const sec = standInSection({ ...dom, library: ['/x/Library/notes/shared.md'] }, 'Aria');
    expect(sec).toMatch(/^## You Are a Stand-in/);
    expect(sec).toContain("Aria's stand-in");
    expect(sec).toContain('/x/Library/notes/shared.md');
    expect(sec).toMatch(/do not have that information here/);
  });
});
