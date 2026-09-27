/**
 * 设备能力 MCP 方案 P0 ④ 评审跟进(B#0–#7,契约 C6–C8)· 审批闸 / 路径策略 / 工具可见性这一层。
 * 只引修复前就存在的出口(gateToolCall / checkWritePath / isKnownSafeBash / resolveTools / userBrowserEndpoint / sanitize…),
 * 所以整份文件能原样拷到修复前的提交(9c0f7f79)上跑:每条负对照在那里都是**断言**失败,不是 import 失败。
 *
 *   #0 C8   远程 cwd = 家目录:家目录点文件 / ~/.config / LaunchAgents / shell rc 硬拒;家目录不再是免批可写根。
 *           Library 例外(私聊 cwd 在 ~/.forsion(-dev)/tangu/agents/<x>/Library)不被点目录规则误伤。
 *   #1      known-safe 的 rg / grep:递归根按 realpath 比(软链到 Forsion 家目录);rg -L / grep -R 不再免批。
 *   #2 C7   起 run 的剥离名单补上 muse / systemPrompt / toolsMode …;会话配置远程写走白名单。
 *   #4      .agents / .codex 在大小写不敏感的平台按折叠比。
 *   #5      远程污点 run:不接管用户浏览器、看不见 Computer Use 工具(含起跑后被 steer 染上的)。
 *   #6      本机写引擎 home 的 plugins/ 不再「每次都问」;远程照旧硬拒。
 *   #7 C6   保护路径写入的审批理由 kind = 'protected'。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  publish: vi.fn(async (..._a: any[]) => 1),
  hook: {} as any,
}));
vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: state.publish }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => state.hook) }));
vi.mock('../src/core/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/config.js')>()),
  getRawSection: () => undefined,
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { gateToolCall, isKnownSafeBash } from '../src/services/approvals.js';
import { sanitizeRemoteAgentConfig, applyRemoteConfigWrite, taintRunRemote } from '../src/services/remoteOrigin.js';
import { checkWritePath } from '../src/tools/fsPolicy.js';
import { registerToolProvider, resolveTools } from '../src/tools/toolRegistry.js';
import { userBrowserEndpoint } from '../src/tools/builtin/browserTools.js';
import { browserUseProvider } from '../src/tools/builtin/browserUse.js';
import type { ToolCall } from '../src/core/types.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const HOME = homedir();
let home: string; // TANGU_HOME(= 共享域)
let ws: string;
const REMOTE = { via: 'tunnel' as const, marked: true };
const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;
let seq = 0;
async function gate(c: ToolCall, ctx: Record<string, any>): Promise<{ asked: boolean; decision: any; request?: any }> {
  const runId = `F${++seq}`;
  const ac = new AbortController();
  const before = state.publish.mock.calls.length;
  const p = gateToolCall(runId, c, { sessionId: `SF${seq}`, execMode: 'host', cwd: ws, profile, ...ctx } as any, ac.signal);
  let request: any;
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 150))]);
  if (!settled) {
    request = state.publish.mock.calls.slice(before).find((x: any[]) => x[0] === runId && x[1] === 'approval_request')?.[2];
    ac.abort();
  }
  const decision = await p;
  return { asked: !!request, decision, request };
}
const toolCtx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ userId: 'u', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd: ws, ...over }) as ToolContext;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-fu-'));
  process.env.TANGU_HOME = home;
  ws = mkdtempSync(join(tmpdir(), 'tangu-remote-fu-ws-'));
  writeFileSync(join(home, 'auth.json'), '{"token":"SECRET-FORSION-TOKEN"}');
  writeFileSync(join(ws, 'readme.md'), 'hello');
  symlinkSync(home, join(ws, 'link')); // 工作区里一条指向 Forsion 家目录的软链
  configureTangu({
    host: {} as any, brain: {} as any, billing: {} as any, profile,
    state: { getAgentConfig: async () => null } as any,
  } as any);
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { state.hook = {}; });

describe('#0 C8 远程 cwd = 家目录', () => {
  it('家目录点文件 / ~/.config / LaunchAgents 对远程 run 硬拒(负对照:本机同路径不是硬拒)', async () => {
    const targets = [join(HOME, '.gitconfig'), join(HOME, '.zshrc'), join(HOME, 'Library', 'LaunchAgents', 'x.plist'), join(HOME, '.config', 'fish', 'conf.d', 'x.fish'), join(HOME, '.local', 'bin', 'git')];
    for (const t of targets) {
      expect(checkWritePath(toolCtx({ cwd: HOME, remote: REMOTE }), t)).toMatchObject({ ok: false, hardDeny: true });
      expect(checkWritePath(toolCtx({ cwd: HOME }), t).hardDeny).toBe(false);
    }
    for (const t of [join(HOME, '.gitconfig'), join(HOME, '.zshrc'), join(HOME, 'Library', 'LaunchAgents', 'x.plist')]) {
      const r = await gate(call('write_file', { path: t, content: 'x' }), { cwd: HOME, approvalMode: 'auto-edit', remote: REMOTE });
      expect(r.decision.action).toBe('reject');
      expect(r.asked).toBe(false);
    }
    // 本机同一 cwd:家目录点文件在 cwd 里,auto-edit 不问(行为不变)
    expect((await gate(call('write_file', { path: join(HOME, '.gitconfig'), content: 'x' }), { cwd: HOME, approvalMode: 'auto-edit' })).decision.action).toBe('approve');
  });

  it('shell rc 按文件名、任何位置都拒(dotfiles 仓软链进家目录);普通文件照写', () => {
    expect(checkWritePath(toolCtx({ remote: REMOTE }), join(ws, 'dotfiles', '.zshrc')).hardDeny).toBe(true);
    expect(checkWritePath(toolCtx({ remote: REMOTE }), join(ws, 'dotfiles', '.bash_profile')).hardDeny).toBe(true);
    expect(checkWritePath(toolCtx({ remote: REMOTE }), join(ws, 'src', 'a.ts'))).toMatchObject({ ok: true, hardDeny: false });
  });

  it('远程 run 的 cwd 是家目录:家目录不再是免批可写根,普通文件也按越界写要批(负对照:本机不问)', async () => {
    const t = join(HOME, `tangu-c8-probe-${Date.now()}.txt`); // 只判不写
    expect((await gate(call('write_file', { path: t, content: 'x' }), { cwd: HOME, approvalMode: 'auto-edit' })).decision.action).toBe('approve');
    const r = await gate(call('write_file', { path: t, content: 'x' }), { cwd: HOME, approvalMode: 'auto-edit', remote: REMOTE });
    expect(r.asked).toBe(true);
    expect(r.request.reason.kind).toBe('escalate');
    // 起跑后被远端 steer 染上的本机 run 同样(按 runId 现取)
    taintRunRemote('F-steer-home', REMOTE);
    expect(checkWritePath(toolCtx({ cwd: HOME, runId: 'F-steer-home' }), t)).toMatchObject({ ok: false, hardDeny: false });
    // 正常项目目录作 cwd:照旧免批
    expect((await gate(call('write_file', { path: join(ws, 'b.txt'), content: 'x' }), { approvalMode: 'auto-edit', remote: REMOTE })).decision.action).toBe('approve');
  });

  it('Library 例外不被点目录规则误伤:~/.forsion-dev/tangu/agents/<x>/Library 远程照写(私聊 cwd)', () => {
    const lib = join(HOME, '.forsion-dev', 'tangu', 'agents', 'zz-c8-probe', 'Library');
    expect(checkWritePath(toolCtx({ cwd: lib, remote: REMOTE }), join(lib, 'notes', 'a.md'))).toMatchObject({ ok: true, hardDeny: false });
    // Library 外的同一家目录照旧整片禁
    expect(checkWritePath(toolCtx({ cwd: lib, remote: REMOTE }), join(HOME, '.forsion-dev', 'tangu', 'skills', 'x', 'SKILL.md')).hardDeny).toBe(true);
  });
});

describe('#1 known-safe 的递归根按真实路径比', () => {
  it('rg / grep -r 的根是指向 Forsion 家目录的软链 → 不免批(负对照:普通工作区照旧免批)', async () => {
    expect(isKnownSafeBash('rg SECRET', ws)).toBe(true);
    expect(isKnownSafeBash('rg SECRET readme.md', ws)).toBe(true);
    expect(isKnownSafeBash('rg SECRET link', ws)).toBe(false);
    expect(isKnownSafeBash('grep -r SECRET link', ws)).toBe(false);
    expect(isKnownSafeBash('rg SECRET', join(ws, 'link'))).toBe(false); // cwd 本身是软链
    expect((await gate(call('run_bash', { command: 'rg SECRET link' }), { approvalMode: 'auto-edit' })).asked).toBe(true);
  });

  it('跟随树内软链的选项不再免批:rg -L / --follow、grep -R;grep -L(files-without-match)照旧', () => {
    expect(isKnownSafeBash('rg -L SECRET .', ws)).toBe(false);
    expect(isKnownSafeBash('rg --follow SECRET .', ws)).toBe(false);
    expect(isKnownSafeBash('grep -R SECRET .', ws)).toBe(false);
    expect(isKnownSafeBash('grep -r SECRET src', ws)).toBe(true);
    expect(isKnownSafeBash('grep -L SECRET readme.md', ws)).toBe(true);
  });
});

describe('#2 C7 远程字段', () => {
  it('起 run:引擎内部角色键 / 人格 / 工具名单一并剥掉,cwd 等本轮参数照留', () => {
    const out = sanitizeRemoteAgentConfig({
      muse: true, activityAccess: true, automationOrigin: 'rule-1', approvalDeferral: 'queue', delegatedFrom: 's1', delegatedBy: 'bo',
      subAgentGrants: ['manage_agent'], systemPrompt: 'evil', soul: 'evil', toolsMode: 'allow', toolsList: ['run_bash'],
      thinkingLevel: 'low', cwd: '/tmp/proj', execMode: 'host', approvalMode: 'full-auto',
    }, 'auto-edit');
    expect(out).toEqual({ thinkingLevel: 'low', cwd: '/tmp/proj', execMode: 'host', approvalMode: 'auto-edit' });
  });

  it('会话配置远程写 = 白名单:角色键 / cwd / systemPrompt 设不上也删不掉,agentSlug / 思考档照写', () => {
    const stored = { systemPrompt: 'mine', cwd: '/p', execMode: 'host', approvalMode: 'readonly' };
    expect(applyRemoteConfigWrite(stored, { ...stored, systemPrompt: 'evil', muse: true, cwd: '/', activityAccess: true, agentSlug: 'bo', thinkingLevel: 'high' }, 'auto-edit'))
      .toEqual({ systemPrompt: 'mine', cwd: '/p', execMode: 'host', approvalMode: 'readonly', agentSlug: 'bo', thinkingLevel: 'high' });
    // PUT 整对象漏传非白名单键 = 想删:保留存值
    expect(applyRemoteConfigWrite(stored, { thinkingLevel: 'low' }, 'auto-edit')).toEqual({ systemPrompt: 'mine', cwd: '/p', execMode: 'host', thinkingLevel: 'low' });
  });
});

describe('#4 .agents / .codex 大小写折叠', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('远程写 .Agents / .CODEX(同一个目录)照样硬拒', () => {
    expect(checkWritePath(toolCtx({ remote: REMOTE }), join(ws, '.Agents', 'skills', 'x', 'SKILL.md')).hardDeny).toBe(true);
    expect(checkWritePath(toolCtx({ remote: REMOTE }), join(ws, '.CODEX', 'config.toml')).hardDeny).toBe(true);
    expect(checkWritePath(toolCtx({ hostSandbox: { mode: 'workspace-write' } as any }), join(ws, '.Codex', 'config.toml')).hardDeny).toBe(true);
    expect(checkWritePath(toolCtx({ remote: REMOTE }), join(ws, 'agents', 'x.md')).hardDeny).toBe(false);
  });
});

describe('#5 远程 = 不接管用户浏览器、没有 Computer Use', () => {
  it('userBrowserEndpoint:远程(含被 steer 染上的)一律用 Tangu 自己的浏览器(负对照:本机按配置接管)', async () => {
    const prev = process.env.TANGU_BROWSER_CDP;
    process.env.TANGU_BROWSER_CDP = 'ws://127.0.0.1:9/devtools/browser/probe';
    try {
      expect(await userBrowserEndpoint({} as any)).toBe('ws://127.0.0.1:9/devtools/browser/probe');
      expect(await userBrowserEndpoint({ remote: REMOTE } as any)).toBeNull();
      taintRunRemote('F-steer-browser', REMOTE);
      expect(await userBrowserEndpoint({ runId: 'F-steer-browser' } as any)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.TANGU_BROWSER_CDP; else process.env.TANGU_BROWSER_CDP = prev;
    }
  });

  it('browser_task:远程 run 不借用户已登录的 Chrome profile,改用独立 profile(负对照:本机按配置用 system)', async () => {
    // 假 runner:回显它收到的 job.profile(runner 经 stdin 收 job,stdout 在结果定界符后回 JSON)
    const bin = join(ws, 'fake-runner.cjs');
    writeFileSync(bin, `#!/usr/bin/env node\nlet d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write('<<<TANGU_BROWSER_USE_RESULT>>>'+JSON.stringify({success:true,result:j.profile}))});\n`);
    chmodSync(bin, 0o755);
    const env = { TANGU_BROWSER_USE_RUNNER_BIN: bin, TANGU_BROWSER_USE_MODEL: 'm', TANGU_BROWSER_USE_API_KEY: 'k' };
    const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const tool = browserUseProvider.tools().find((t) => t.name === 'browser_task')!;
      const profileOf = async (ctx: ToolContext): Promise<string> => JSON.parse(await tool.execute({ task: 'open example.com' }, ctx) as string).result;
      expect(await profileOf(toolCtx())).toBe('system');
      expect(await profileOf(toolCtx({ remote: REMOTE }))).toBe('dedicated');
      taintRunRemote('F-steer-bu', REMOTE);
      expect(await profileOf(toolCtx({ runId: 'F-steer-bu' }))).toBe('dedicated');
    } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('声明 concurrencyKey:computer-use 的插件工具对远程 run 不可见(负对照:本机可见;同 provider 的别的工具不受影响)', () => {
    registerToolProvider({
      id: 'test:fake-computer-use',
      origin: 'plugin',
      tools: () => [
        { name: 'fake_observe_ui', mode: 'host', capabilities: { sideEffect: 'read', concurrencyKey: 'computer-use' }, definition: { type: 'function', function: { name: 'fake_observe_ui', description: 'x', parameters: { type: 'object', properties: {} } } }, execute: () => 'ok' },
        { name: 'fake_plain_tool', mode: 'host', capabilities: { sideEffect: 'read' }, definition: { type: 'function', function: { name: 'fake_plain_tool', description: 'x', parameters: { type: 'object', properties: {} } } }, execute: () => 'ok' },
      ],
    } as any);
    const base = toolCtx({ hostSandbox: { mode: 'off' } as any });
    expect(resolveTools(profile, base).has('fake_observe_ui')).toBe(true);
    expect(resolveTools(profile, { ...base, remote: REMOTE }).has('fake_observe_ui')).toBe(false);
    expect(resolveTools(profile, { ...base, remote: REMOTE }).has('fake_plain_tool')).toBe(true);
    taintRunRemote('F-steer-cu', REMOTE);
    expect(resolveTools(profile, { ...base, runId: 'F-steer-cu' }).has('fake_observe_ui')).toBe(false);
  });
});

describe('#6 / #7 保护路径', () => {
  it('本机完全通行写引擎 home 的 plugins/:不再每次都问(负对照:config.json 照旧问);远程照旧硬拒', async () => {
    const plug = join(home, 'plugins', 'myplugin', 'data', 'state.json');
    expect((await gate(call('write_file', { path: plug, content: '{}' }), { approvalMode: 'full-auto' })).decision.action).toBe('approve');
    expect((await gate(call('write_file', { path: join(home, 'config.json'), content: '{}' }), { approvalMode: 'full-auto' })).asked).toBe(true);
    expect((await gate(call('write_file', { path: plug, content: '{}' }), { approvalMode: 'full-auto', remote: REMOTE })).decision.action).toBe('reject');
    expect(checkWritePath(toolCtx({ remote: REMOTE }), plug).hardDeny).toBe(true);
  });

  it('保护路径写入的审批理由 kind = protected(契约 C6;负对照:工作区外普通写仍是 escalate)', async () => {
    mkdirSync(join(home, 'sub'), { recursive: true });
    const r = await gate(call('write_file', { path: join(home, 'config.json'), content: '{}' }), { approvalMode: 'auto-edit' });
    expect(r.asked).toBe(true);
    expect(r.request.reason.kind).toBe('protected');
    const outside = mkdtempSync(join(tmpdir(), 'tangu-remote-fu-out-'));
    const e = await gate(call('write_file', { path: join(outside, 'x.txt'), content: 'x' }), { approvalMode: 'auto-edit' });
    expect(e.request.reason.kind).toBe('escalate');
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('Codex 评审(09-27 跟进轮)', () => {
  it('悬空软链:目标还不存在时照样按目标判(远程写家目录点文件 / 本机写凭据)', async () => {
    const probe = join(HOME, `.tangu-dangle-probe-${Date.now()}`); // 不存在;只建工作区里的链接,不写目标
    symlinkSync(probe, join(ws, 'dangle'));
    expect(checkWritePath(toolCtx({ remote: REMOTE }), join(ws, 'dangle')).hardDeny).toBe(true);
    symlinkSync(join(home, 'provider-auth.json'), join(ws, 'dangle-cred')); // 凭据文件尚不存在
    expect((await gate(call('write_file', { path: join(ws, 'dangle-cred'), content: '{}' }), { approvalMode: 'full-auto' })).asked).toBe(true);
    // 悬空链接指向工作区外的普通位置:本机 auto-edit 也按越界写问(以前按「在工作区里」直接放)
    const out = mkdtempSync(join(tmpdir(), 'tangu-remote-fu-dangle-'));
    symlinkSync(join(out, 'new.txt'), join(ws, 'dangle-out'));
    expect((await gate(call('write_file', { path: join(ws, 'dangle-out'), content: 'x' }), { approvalMode: 'auto-edit' })).asked).toBe(true);
    rmSync(out, { recursive: true, force: true });
  });

  it('Forsion 家目录里指向 Library 的软链:字面路径不在 Library 就不吃例外(skills-link → Library)', () => {
    const lib = join(home, 'agents', 'cx', 'Library');
    mkdirSync(join(lib, 'sk'), { recursive: true });
    symlinkSync(join(lib, 'sk'), join(home, 'skills-link'));
    expect(checkWritePath(toolCtx({ remote: REMOTE }), join(home, 'skills-link', 'SKILL.md')).hardDeny).toBe(true);
    expect(checkWritePath(toolCtx({ cwd: lib, remote: REMOTE }), join(lib, 'sk', 'SKILL.md'))).toMatchObject({ ok: true, hardDeny: false });
  });

  it('`--` 之后的参数一律是操作数:名叫 -n 的软链指向凭据 → 不免批', () => {
    symlinkSync(join(home, 'auth.json'), join(ws, '-n'));
    expect(isKnownSafeBash('rg SECRET -- -n', ws)).toBe(false);
    expect(isKnownSafeBash('grep SECRET -- -n', ws)).toBe(false);
    expect(isKnownSafeBash('cat -- -n', ws)).toBe(false);
    expect(isKnownSafeBash('rg SECRET -- readme.md', ws)).toBe(true);
  });

  it('带参数的 rg 旗标(-r 即 --replace、-E 即 --encoding)会吃掉后面的 `--`,不许出现在免批集里(Codex 二轮复核)', () => {
    expect(isKnownSafeBash('rg -r -- --pre=sh needle readme.md', ws)).toBe(false);
    expect(isKnownSafeBash('rg -E -- --pre=sh needle readme.md', ws)).toBe(false);
    expect(isKnownSafeBash('rg -r X needle readme.md', ws)).toBe(false);
    // grep 的 -r / -E 不带参数,照旧免批
    expect(isKnownSafeBash('grep -r -E needle src', ws)).toBe(true);
    expect(isKnownSafeBash('rg -n -i needle readme.md', ws)).toBe(true);
  });

  it('rg --files 没有模式参数,首个操作数就是路径:列凭据目录 / 经软链列 Forsion 家目录都不免批(Codex 三轮复核)', () => {
    mkdirSync(join(home, 'secrets'), { recursive: true });
    expect(isKnownSafeBash(`rg --files ${join(home, 'secrets')}`, ws)).toBe(false);
    expect(isKnownSafeBash('rg --files link', ws)).toBe(false);
    expect(isKnownSafeBash('rg --files', ws)).toBe(true);
    expect(isKnownSafeBash('rg --files .', ws)).toBe(true);
  });
});
