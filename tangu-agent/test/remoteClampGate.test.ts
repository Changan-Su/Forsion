/**
 * 设备能力 MCP 方案 P0 ④ / ⑤(引擎半边)· 远程来源的钳制 —— 审批闸、保护路径、子进程凭据环境。
 * 负对照都在修复前的代码上实跑为红(见各 it 的「负对照」注)。
 *
 *   C1 头解析:x-forsion-remote 在场即远程(盖章只记录、不放宽);值不在契约内照样按远程(fail-closed)。
 *   C3 有效档:审批闸在现读会话存档之后钳 min(档, remote.maxApprovalMode);custom 的 allow 不越过上限;
 *      会话里本机点过的「总允许」不作数、远程的「总允许」不落;远端中途 steer 进本机 run → 从此按远程钳。
 *      持久化后续执行入口(manage_automation / manage_schedule)对远程按跑命令档审批。
 *   C4 凭据读硬拒(所有 run)+ known-safe 捷径不碰凭据;写凭据 / ~/.forsion 配置:远程硬拒(与宿主沙箱无关)、
 *      本机完全通行也要问、无人值守直接拒。
 *   C2 工具子进程剥 TANGU_TOKEN / TANGU_LOCAL_TOKEN / TANGU_REMOTE_MARK_SECRET。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  publish: vi.fn(async (..._a: any[]) => 1),
  rules: undefined as any,
  remote: undefined as any,
  storedMode: undefined as string | undefined,
}));
vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: state.publish }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
vi.mock('../src/core/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/config.js')>()),
  getRawSection: (name: string) => (name === 'approval' ? state.rules : name === 'remote' ? state.remote : undefined),
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { gateToolCall, isKnownSafeBash, isAlwaysAllowed, allowAlways, resolveApproval, toolNeedsApproval } from '../src/services/approvals.js';
import {
  parseRemoteOrigin, clampApprovalMode, sanitizeRemoteAgentConfig, applyRemoteConfigWrite, taintRunRemote, remoteApprovalCap,
} from '../src/services/remoteOrigin.js';
import { checkWritePath, checkReadPath } from '../src/tools/fsPolicy.js';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { fileSearchProvider } from '../src/tools/builtin/fileSearch.js';
import { prepareHostCommand, spawnHostShell } from '../src/sandbox/hostSandbox.js';
import { toolSubprocessEnv } from '../src/sandbox/credentialEnv.js';
import { runVerifyCommand } from '../src/services/runtimeContext.js';
import { spawnEngine } from '../src/engines/acpEngine.js';
import type { ToolCall } from '../src/core/types.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
let home: string; // = 共享域(basename 不是 tangu → forsionSharedDir() 就是它)
let ws: string;
const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;
const REMOTE = { via: 'tunnel' as const, marked: true };
let seq = 0;
/** 跑一次闸:要是弹了审批卡就立刻中止(闸按拒绝收场),返回 { asked, decision, request }。 */
async function gate(c: ToolCall, ctx: Record<string, any>): Promise<{ asked: boolean; decision: any; request?: any }> {
  const runId = `R${++seq}`;
  const ac = new AbortController();
  const before = state.publish.mock.calls.length;
  const p = gateToolCall(runId, c, { sessionId: 'S', execMode: 'host', cwd: ws, profile, ...ctx } as any, ac.signal);
  let request: any;
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 150))]);
  if (!settled) {
    request = state.publish.mock.calls.slice(before).find((x: any[]) => x[0] === runId && x[1] === 'approval_request')?.[2];
    ac.abort();
  }
  const decision = await p;
  return { asked: !!request, decision, request };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-gate-'));
  process.env.TANGU_HOME = home;
  ws = join(home, 'ws');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(home, 'auth.json'), '{"token":"SECRET-FORSION-TOKEN"}');
  writeFileSync(join(home, 'notes.txt'), 'SECRET-FORSION-TOKEN appears in a normal note too');
  writeFileSync(join(ws, 'readme.md'), 'hello');
  configureTangu({
    host: {} as any, brain: {} as any, billing: {} as any, profile,
    state: { getAgentConfig: async () => (state.storedMode ? JSON.stringify({ approvalMode: state.storedMode }) : null) } as any,
  } as any);
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { state.rules = undefined; state.remote = undefined; state.storedMode = undefined; });

describe('C1 远程头解析', () => {
  it('无头 = 本机;在场即远程,盖章按密钥(sha256 + timingSafeEqual)判,错章 / 无章照样是远程', () => {
    process.env.TANGU_REMOTE_MARK_SECRET = 'boot-secret';
    try {
      expect(parseRemoteOrigin({})).toBeUndefined();
      expect(parseRemoteOrigin({ 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': 'boot-secret' })).toEqual({ via: 'tunnel', marked: true });
      expect(parseRemoteOrigin({ 'x-forsion-remote': 'p2p', 'x-forsion-remote-mark': 'wrong' })).toEqual({ via: 'p2p', marked: false });
      expect(parseRemoteOrigin({ 'x-forsion-remote': 'lan' })).toEqual({ via: 'lan', marked: false });
      // 值不在契约内:只可能是本机进程自己加的头 —— 仍按远程(没有 via),绝不因此当本机放行
      expect(parseRemoteOrigin({ 'x-forsion-remote': 'bogus' })).toEqual({ marked: false });
    } finally { delete process.env.TANGU_REMOTE_MARK_SECRET; }
  });

  it('上限缺省 auto-edit、可配;钳制只降不升,custom 原样交给闸', () => {
    expect(remoteApprovalCap()).toBe('auto-edit');
    state.remote = { maxApprovalMode: 'readonly' };
    expect(remoteApprovalCap()).toBe('readonly');
    state.remote = { maxApprovalMode: 'nonsense' };
    expect(remoteApprovalCap()).toBe('auto-edit');
    expect(clampApprovalMode('full-auto', 'auto-edit')).toBe('auto-edit');
    expect(clampApprovalMode('readonly', 'auto-edit')).toBe('readonly');
    expect(clampApprovalMode(undefined, 'auto-edit')).toBe('auto-edit');
    expect(clampApprovalMode('custom', 'auto-edit')).toBe('custom');
  });

  it('请求字段钳制:verifyCommand / engineId / extraRoots / 设备能力剥掉,审批档钳到上限', () => {
    const out = sanitizeRemoteAgentConfig({ approvalMode: 'full-auto', verifyCommand: 'echo pwned', engineId: 'codex', soloEngineId: 'codex', extraRoots: ['/'], clientCapabilities: ['phone_ui'], devices: ['x'], thinkingLevel: 'low' }, 'auto-edit');
    expect(out).toEqual({ approvalMode: 'auto-edit', thinkingLevel: 'low' });
  });

  it('会话配置远程写:受保护键保留存值(设不了也删不掉);审批档抬不过上限、同值不降、custom 不收', () => {
    const stored = { approvalMode: 'full-auto', verifyCommand: 'npm test', extraRoots: ['/data'] };
    expect(applyRemoteConfigWrite(stored, { approvalMode: 'full-auto', thinkingLevel: 'high' }, 'auto-edit'))
      .toEqual({ approvalMode: 'full-auto', thinkingLevel: 'high', verifyCommand: 'npm test', extraRoots: ['/data'] }); // 回写同值:本机设的档不被远端降
    expect(applyRemoteConfigWrite({ approvalMode: 'readonly' }, { approvalMode: 'full-auto', verifyCommand: 'echo pwned', devices: ['p'] }, 'auto-edit'))
      .toEqual({ approvalMode: 'auto-edit' });
    expect(applyRemoteConfigWrite({ approvalMode: 'readonly' }, { approvalMode: 'custom' }, 'auto-edit')).toEqual({ approvalMode: 'readonly' });
    expect(applyRemoteConfigWrite(stored, { approvalMode: 'auto-edit' }, 'auto-edit')).toEqual({ approvalMode: 'auto-edit', verifyCommand: 'npm test', extraRoots: ['/data'] });
  });
});

describe('C3 审批闸有效档', () => {
  it('远程 run 带 full-auto 快照:run_bash 照样要批(负对照:本机同快照直接放行)', async () => {
    expect((await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'full-auto' })).decision.action).toBe('approve');
    const r = await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'full-auto', remote: REMOTE });
    expect(r.asked).toBe(true);
    expect(r.request.reason).toMatchObject({ kind: 'mode', mode: 'auto-edit' });
  });

  it('本机建成完全通行的会话被远程 run 继续(会话存档现读之后再钳)', async () => {
    state.storedMode = 'full-auto';
    expect((await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'auto-edit', modeSessionId: 'S' })).decision.action).toBe('approve');
    expect((await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'auto-edit', modeSessionId: 'S', remote: REMOTE })).asked).toBe(true);
  });

  it('上限调到 full-auto 时远程也放行(用户在本机显式选的);没设档的远程 run 按上限', async () => {
    state.remote = { maxApprovalMode: 'full-auto' };
    expect((await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'full-auto', remote: REMOTE })).decision.action).toBe('approve');
    state.remote = undefined;
    expect((await gate(call('run_bash', { command: 'touch x' }), { remote: REMOTE })).asked).toBe(true);
  });

  it('custom 的 allow 不越过上限(负对照:本机 custom allow 直接放行);deny 照旧生效', async () => {
    state.rules = { base: 'full-auto', allow: ['run_bash'], deny: ['run_bash:rm '] };
    expect((await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'custom' })).decision.action).toBe('approve');
    expect((await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'custom', remote: REMOTE })).asked).toBe(true);
    expect((await gate(call('run_bash', { command: 'rm -rf y' }), { approvalMode: 'custom', remote: REMOTE })).decision.action).toBe('reject');
    // 工作区内写在上限档(auto-edit)下本就不问 → allow 照放
    state.rules = { base: 'readonly', allow: ['write_file'] };
    expect((await gate(call('write_file', { path: join(ws, 'a.txt'), content: 'x' }), { approvalMode: 'custom', remote: REMOTE })).decision.action).toBe('approve');
  });

  it('会话里本机点过的「总允许」对远程 run 不作数;远程点的「总允许」不落(负对照:本机照旧吃总允许)', async () => {
    allowAlways('S', 'run_bash');
    expect((await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'auto-edit' })).decision.action).toBe('approve');
    expect((await gate(call('run_bash', { command: 'touch x' }), { approvalMode: 'auto-edit', remote: REMOTE })).asked).toBe(true);

    const runId = 'R-always';
    const p = gateToolCall(runId, call('run_bash', { command: 'touch y' }), { sessionId: 'S2', execMode: 'host', cwd: ws, approvalMode: 'auto-edit', profile, remote: REMOTE } as any);
    await vi.waitFor(() => expect(state.publish.mock.calls.some((c: any[]) => c[0] === runId && c[1] === 'approval_request')).toBe(true));
    const id = state.publish.mock.calls.find((c: any[]) => c[0] === runId && c[1] === 'approval_request')![2].approvalId;
    expect(resolveApproval(id, { action: 'approve_always' }, runId)).toBe(true);
    expect((await p).action).toBe('approve');
    expect(isAlwaysAllowed('S2', 'run_bash')).toBe(false);
  });

  it('远端 steer 进本机 run:之后的调用按远程钳(runId 染色)', async () => {
    taintRunRemote('R-steered', REMOTE);
    const ac = new AbortController();
    const p = gateToolCall('R-steered', call('run_bash', { command: 'touch x' }), { sessionId: 'S', execMode: 'host', cwd: ws, approvalMode: 'full-auto', profile } as any, ac.signal);
    await vi.waitFor(() => expect(state.publish.mock.calls.some((c: any[]) => c[0] === 'R-steered' && c[1] === 'approval_request')).toBe(true));
    ac.abort();
    expect((await p).action).toBe('reject');
  });

  it('持久化后续执行入口:远程 auto-edit 下 manage_automation / manage_schedule 要批(本机同档不问)', async () => {
    expect(toolNeedsApproval('manage_automation', 'auto-edit')).toBe(false);
    expect(toolNeedsApproval('manage_automation', 'auto-edit', { remote: true })).toBe(true);
    expect(toolNeedsApproval('manage_schedule', 'auto-edit', { remote: true })).toBe(true);
    expect((await gate(call('manage_automation', { action: 'create' }), { approvalMode: 'auto-edit', remote: REMOTE })).asked).toBe(true);
  });
});

describe('C4 凭据 / 本机配置', () => {
  it('read_file / view_image(软链改名)/ read_document 读 auth.json 一律拒(负对照:普通文件照读)', async () => {
    const ctx = { userId: 'u', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd: home } as ToolContext;
    expect(await HOST_TOOLS.read_file.execute({ path: 'notes.txt' }, ctx)).toContain('appears in a normal note');
    const denied = await HOST_TOOLS.read_file.execute({ path: join(home, 'auth.json') }, ctx);
    expect(denied).toMatch(/^Error: Access denied/);
    expect(denied).not.toContain('SECRET-FORSION-TOKEN');
    symlinkSync(join(home, 'auth.json'), join(ws, 'pic.png'));
    expect(await HOST_TOOLS.view_image.execute({ path: 'pic.png' }, { ...ctx, cwd: ws, collectImage: () => {} })).toMatch(/^Error: Access denied/);
    expect(await HOST_TOOLS.read_document.execute({ path: 'auth.json' }, ctx)).toMatch(/^Error: Access denied/);
    expect(checkReadPath(join(home, 'secrets', 'x.pem')).ok).toBe(false); // 共享域下的 secrets/** 整目录保护
    expect(checkReadPath(join(process.env.HOME || '/', '.forsion-dev', 'secrets', 'x.pem')).ok).toBe(false); // ~/.forsion-dev 那套同样保护
    expect(checkReadPath(join(home, 'notes.txt')).ok).toBe(true);
  });

  it('search_files 不吐凭据文件的命中行(同一个词在普通文件里照样搜得到)', async () => {
    const tool = fileSearchProvider.tools().find((t) => t.name === 'search_files')!;
    const out = await tool.execute({ pattern: 'SECRET-FORSION-TOKEN' }, { userId: 'u', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd: home } as ToolContext);
    expect(out).toContain('notes.txt');
    expect(out).not.toContain('auth.json');
  });

  it('known-safe 捷径不碰凭据:cat 凭据 / 在含凭据的目录里递归 rg 都要走审批(负对照:普通文件照旧免批)', async () => {
    expect(isKnownSafeBash(`cat ${join(home, 'notes.txt')}`, ws)).toBe(true);
    expect(isKnownSafeBash(`cat ${join(home, 'auth.json')}`, ws)).toBe(false);
    expect(isKnownSafeBash('tail -n 5 ../auth.json', ws)).toBe(false);
    expect(isKnownSafeBash('rg token', ws)).toBe(true);
    expect(isKnownSafeBash('rg token', home)).toBe(false);
    expect(isKnownSafeBash('grep token readme.md', home)).toBe(true);
    // 另一个会话:上面的用例在 'S' 里点过 run_bash 的「总允许」
    expect((await gate(call('run_bash', { command: `cat ${join(home, 'auth.json')}` }), { approvalMode: 'auto-edit', sessionId: 'S-cat' })).asked).toBe(true);
    expect((await gate(call('run_bash', { command: `cat ${join(home, 'notes.txt')}` }), { approvalMode: 'auto-edit', sessionId: 'S-cat' })).decision.action).toBe('approve');
  });

  it('远程写 ~/.forsion 配置:宿主沙箱关着也硬拒(负对照:本机同路径不是硬拒)', async () => {
    const cfg = join(home, 'config.json');
    const local = { userId: 'u', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd: home } as ToolContext;
    expect(checkWritePath(local, cfg).hardDeny).toBe(false);
    expect(checkWritePath({ ...local, remote: REMOTE }, cfg)).toMatchObject({ ok: false, hardDeny: true });
    expect(checkWritePath({ ...local, remote: REMOTE }, join(home, 'auth.json')).hardDeny).toBe(true);
    const r = await gate(call('write_file', { path: cfg, content: '{}' }), { approvalMode: 'full-auto', remote: REMOTE });
    expect(r.decision).toMatchObject({ action: 'reject' });
    expect(r.decision.rejectReason).toMatch(/Remote sessions cannot write protected/);
    // 写工具本身也拒(闸被绕过时的第二道)
    expect(await HOST_TOOLS.write_file.execute({ path: cfg, content: '{}' }, { ...local, remote: REMOTE })).toMatch(/Remote sessions cannot write protected/);
    expect(existsSync(cfg)).toBe(false);
  });

  it('本机写凭据 / 配置:完全通行也要问,custom allow / 总允许都不放;无人值守直接拒', async () => {
    const cfg = join(home, 'config.json');
    const r = await gate(call('write_file', { path: cfg, content: '{}' }), { approvalMode: 'full-auto' });
    expect(r.asked).toBe(true);
    expect(r.request.preview).toContain('Protected config');
    state.rules = { base: 'full-auto', allow: ['write_file'] };
    allowAlways('S', 'write_file');
    expect((await gate(call('edit_file', { path: join(home, 'auth.json'), old_string: 'a', new_string: 'b' }), { approvalMode: 'custom' })).asked).toBe(true);
    expect((await gate(call('write_file', { path: cfg, content: '{}' }), { approvalMode: 'full-auto', unattended: true })).decision.action).toBe('reject');
    // 负对照:工作区里的普通文件在完全通行下不问
    expect((await gate(call('write_file', { path: join(ws, 'b.txt'), content: 'x' }), { approvalMode: 'full-auto' })).decision.action).toBe('approve');
  });
});

describe('C2 工具子进程剥凭据环境变量', () => {
  const SECRETS = { TANGU_TOKEN: 'forsion-token-XYZ', TANGU_LOCAL_TOKEN: 'local-XYZ', TANGU_REMOTE_MARK_SECRET: 'mark-XYZ' };
  beforeEach(() => { Object.assign(process.env, SECRETS); });
  const clear = (): void => { for (const k of Object.keys(SECRETS)) delete process.env[k]; };

  it('toolSubprocessEnv:剥凭据(大小写不敏感),PATH 等照留', () => {
    try {
      const env = toolSubprocessEnv({ ...process.env, tangu_token: 'lower' });
      for (const k of [...Object.keys(SECRETS), 'tangu_token']) expect(env[k]).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(prepareHostCommand({ cwd: ws }, ['true']).options.env?.TANGU_TOKEN).toBeUndefined();
    } finally { clear(); }
  });

  it('run_bash / 后台 shell / verifyCommand / 外部引擎子进程都拿不到(负对照:引擎进程自己仍有)', async () => {
    try {
      expect(process.env.TANGU_TOKEN).toBe(SECRETS.TANGU_TOKEN);
      const ctx = { userId: 'u', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd: ws } as ToolContext;
      const out = await HOST_TOOLS.run_bash.execute({ command: 'echo "[$TANGU_TOKEN][$TANGU_LOCAL_TOKEN][$TANGU_REMOTE_MARK_SECRET]"' }, ctx);
      expect(out).toContain('[][][]');
      const bg = spawnHostShell({ cwd: ws }, 'printf "%s" "$TANGU_TOKEN" > bg.txt');
      await new Promise((r) => bg.once('close', r));
      expect(readFileSync(join(ws, 'bg.txt'), 'utf8')).toBe('');
      await runVerifyCommand('printf "%s" "$TANGU_LOCAL_TOKEN$TANGU_TOKEN" > verify.txt', ws);
      expect(readFileSync(join(ws, 'verify.txt'), 'utf8')).toBe('');
      const child = spawnEngine({ id: 'probe', name: 'probe', command: process.execPath, args: ['-e', 'process.stdout.write(String(process.env.TANGU_TOKEN || "none"))'] } as any);
      let got = '';
      child.stdout.on('data', (d) => { got += d.toString(); });
      await new Promise((r) => child.once('close', r));
      expect(got).toBe('none');
    } finally { clear(); }
  });
});
