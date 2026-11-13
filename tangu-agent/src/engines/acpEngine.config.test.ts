/** DSH 官方对话入口(`dsh --profile acp`)和别的 ACP 适配器不一样的那几处:模型在 configOptions 里、审批请求只带
 *  toolCallId、续接失败的两种说法、以及「命令不在就是未安装」。线上的原样取自 2026-11-13 对 DSH 0.2.2-rc.3 的实测。 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acpErrorText, classifyResumeFailure, createAcpClient, mapAcpConfigOptions } from './acpEngine.js';
import { engineStatus, loadEngines } from './config.js';
import { dshEngineDef } from './dsh.js';

// session/new 回包里的 configOptions,DSH 原样(模型值是一段 JSON 文本,按供应商分组)
const DSH_OPTIONS = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: '["deepseek-official","deepseek-v4-flash"]', options: [
    { group: 'deepseek-official', name: 'DeepSeek', options: [
      { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
      { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding.' },
    ] },
  ] },
  { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [
    { value: 'off', name: 'Off', description: 'Use for simple tasks.' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' },
  ] },
];

describe('mapAcpConfigOptions', () => {
  it('DSH 的分组模型清单摊平,值原样当 id(不解析那段 JSON 文本),组名补进没有说明的选项', () => {
    const sel = mapAcpConfigOptions(DSH_OPTIONS);
    expect(sel.modelConfigId).toBe('model');
    expect(sel.currentModelId).toBe('["deepseek-official","deepseek-v4-flash"]');
    expect(sel.models).toEqual([
      { id: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash', description: 'DeepSeek' },
      { id: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding.' },
    ]);
  });

  it('思考档读出来:四档 + 当前值', () => {
    const sel = mapAcpConfigOptions(DSH_OPTIONS);
    expect(sel.thoughtConfigId).toBe('reasoning_effort');
    expect(sel.thoughtLevels.map((l) => l.id)).toEqual(['off', 'low', 'high', 'max']);
    expect(sel.currentThoughtLevel).toBe('high');
  });

  it('没写 category 的按 id 兜底;写了别的 category 的同名项不认', () => {
    const flat = [{ id: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b' }] }];
    expect(mapAcpConfigOptions(flat).models).toEqual([{ id: 'a', name: 'A', description: undefined }, { id: 'b', name: 'b', description: undefined }]);
    expect(mapAcpConfigOptions([{ id: 'model', type: 'select', category: 'mode', currentValue: 'x', options: [{ value: 'x', name: 'X' }] }]).models).toEqual([]);
  });

  it('不是数组 / 没有这类选项 → 空,不抛', () => {
    for (const bad of [undefined, null, 'x', {}, [{ id: 'model', type: 'boolean' }], [null]]) {
      const sel = mapAcpConfigOptions(bad);
      expect(sel.models).toEqual([]);
      expect(sel.thoughtLevels).toEqual([]);
      expect(sel.modelConfigId).toBeUndefined();
    }
  });
});

describe('classifyResumeFailure', () => {
  it('DSH 说那个会话续不了(不存在)→ gone', () => {
    expect(classifyResumeFailure({ code: -32602, message: 'Invalid params: session is not resumable: 00000000-0000-4000-8000-000000000000' })).toBe('gone');
    expect(classifyResumeFailure({ code: -32002, message: 'Resource not found' })).toBe('gone');
  });

  it('DSH 说会话被另一个进程占着 → busy(真话在 data.details 里,message 只有 Internal error)', () => {
    const e = { code: -32603, message: 'Internal error', data: { details: 'session "d8216a14" is already owned by an active write handle' } };
    expect(classifyResumeFailure(e)).toBe('busy');
    expect(acpErrorText(e)).toBe('Internal error: session "d8216a14" is already owned by an active write handle');
    expect(classifyResumeFailure({ code: -32602, message: 'Invalid params: session is already active: 0b89fa2c' })).toBe('busy');
  });

  it('认不出的(超时、别的参数错)→ other,不当成「没有了」', () => {
    expect(classifyResumeFailure(new Error('engine resumeSession timed out after 30000ms'))).toBe('other');
    expect(classifyResumeFailure({ code: -32602, message: 'Invalid params: workspace mismatch' })).toBe('other');
    expect(classifyResumeFailure(undefined)).toBe('other');
  });
});

describe('审批请求只带 toolCallId(DSH)', () => {
  const setup = () => {
    const asked: Array<{ preview: string; name: string; args: string }> = [];
    const { client } = createAcpClient('DeepSeek Harness', {
      signal: new AbortController().signal,
      publish: () => {},
      requestApproval: async (preview, call) => { asked.push({ preview, name: call.function.name, args: call.function.arguments }); return { action: 'approve' }; },
    });
    return { client, asked };
  };
  const OPTIONS = [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' as const }];

  it('标题和参数从它前面那条 tool_call 更新里补,卡上不再是一个笼统的 tool', async () => {
    const { client, asked } = setup();
    const rawInput = { file_path: '/w/outside/a.txt', content: 'x\n', sandbox_permissions: 'danger-full-access', justification: 'retry' };
    await client.sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_2', title: 'write', kind: 'other', status: 'in_progress', rawInput } } as any);
    const res = await client.requestPermission({ sessionId: 's', toolCall: { toolCallId: 'toolu_2' }, options: OPTIONS } as any);
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(asked).toHaveLength(1);
    expect(asked[0].name).toBe('write');
    expect(JSON.parse(asked[0].args)).toEqual(rawInput);
    expect(asked[0].preview).toContain('[DeepSeek Harness] write');
    expect(asked[0].preview).toContain('/w/outside/a.txt');
  });

  it('请求自己带了标题和参数的(Claude Code / Codex)以它为准', async () => {
    const { client, asked } = setup();
    await client.sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'earlier title', rawInput: { a: 1 } } } as any);
    await client.requestPermission({ sessionId: 's', toolCall: { toolCallId: 't1', title: 'Edit file', rawInput: { b: 2 } }, options: OPTIONS } as any);
    expect(asked[0].name).toBe('Edit file');
    expect(JSON.parse(asked[0].args)).toEqual({ b: 2 });
  });

  it('前面没有那条 tool_call 时照旧兜底成 tool,不抛', async () => {
    const { client, asked } = setup();
    await client.requestPermission({ sessionId: 's', toolCall: { toolCallId: 'never-seen' }, options: OPTIONS } as any);
    expect(asked[0].name).toBe('tool');
    expect(asked[0].args).toBe('{}');
  });
});

describe('DSH 引擎定义与检测', () => {
  const saved = { PATH: process.env.PATH, DSH_HOME: process.env.DSH_HOME, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'tangu-dsh-detect-')); dirs.push(d); return d; };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('走官方对话入口,不静态声明模型(要靠探测读 configOptions)', () => {
    const def = dshEngineDef();
    expect([def.command, ...(def.args || [])]).toEqual(['dsh', '--profile', 'acp']);
    expect(def.models).toBeUndefined();
    expect(def.commands).toBeUndefined();
    expect(loadEngines(path.join(tmp(), 'no-such-engines.json')).find((e) => e.id === 'dsh')?.command).toBe('dsh');
  });

  // 用例只对「dsh 不在 PATH / 常见安装目录上」的机器有判别力;开发机装了 dsh 时第一条会跳过
  const fakeBin = (): string => {
    const bin = path.join(tmp(), 'bin'); mkdirSync(bin);
    const name = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    writeFileSync(path.join(bin, name), ''); if (process.platform !== 'win32') chmodSync(path.join(bin, name), 0o755);
    return bin;
  };

  it('DSH 的目录还在、命令不在 → 未安装(不报成可用再在启动时失败)', () => {
    const home = tmp(); // 目录存在 = 「跑过 DSH」的信号
    process.env.DSH_HOME = home; process.env.DEEPSEEK_API_KEY = 'k'; process.env.PATH = tmp();
    const def = dshEngineDef();
    if (engineStatus({ ...def, detect: { bin: 'dsh' } }) !== 'not-installed') return; // 这台机器的常见安装目录里真有 dsh
    expect(engineStatus(def)).toBe('not-installed');
    // 对照:同样的信号,不要求命令的引擎(经 npx 拉适配器的那几家)算可用
    expect(engineStatus({ ...def, detect: { ...def.detect, requireBin: false } })).toBe('available');
  });

  it('命令在、目录也在 → 可用;命令在、没有任何登录信号 → 需登录', () => {
    const bin = fakeBin();
    process.env.PATH = bin; process.env.DSH_HOME = tmp(); delete process.env.DEEPSEEK_API_KEY;
    expect(engineStatus(dshEngineDef())).toBe('available');
    process.env.DSH_HOME = path.join(tmp(), 'not-created');
    expect(engineStatus(dshEngineDef())).toBe('needs-signin');
  });
});
