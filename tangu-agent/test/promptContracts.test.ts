/**
 * 提示词契约(借 Codex/PI):①输出契约段按通道分裁;②失败恢复段进默认 guidance;
 * ③executeTool 的「不可用」文案自带下一步(plan 模式被拦 vs 真不存在,分开说)。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { defaultPromptSections, responseStyleSection, TOOL_FAILURE_SECTION } from '../src/profiles/promptSections.js';
import { executeTool } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/registry.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

beforeAll(() => {
  configureTangu({ host: stub, brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }) });
});

describe('responseStyleSection', () => {
  it('默认=markdown 气泡变体;通道会话=纯文本变体', () => {
    const md = responseStyleSection(false);
    expect(md).toContain('GitHub-flavored');
    expect(md).not.toContain('PLAIN TEXT');
    const plain = responseStyleSection(true);
    expect(plain).toContain('PLAIN TEXT');
    expect(plain).not.toContain('GitHub-flavored');
    // 共同骨架:答案先行 + 跟随用户语言 + 如实汇报
    for (const s of [md, plain]) {
      expect(s).toContain('Lead with the answer');
      expect(s).toContain('language the user writes in');
    }
  });

  it('契约段不进可覆盖的 guidance(per-app 整段替换不得丢契约,由 agentLoop 直接注入)', () => {
    const sec = defaultPromptSections({ execMode: 'host', cwd: '/tmp' });
    const joined = sec.guidance.join('\n');
    expect(joined).toContain('## Memory & Logs');
    expect(joined).not.toContain('## When a Tool Call Fails');
    expect(joined).not.toContain('## Response Style');
    expect(TOOL_FAILURE_SECTION).toContain('unattended'); // 无人值守 run 以失败报告收尾,不问用户
  });
});

describe('executeTool 不可用文案自带出路', () => {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  const base: ToolContext = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp' } as any;
  const call = (name: string) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: '{}' } });

  it('plan 模式拦下的写工具:点名 plan mode + 指向 exit_plan_mode', async () => {
    const r = await executeTool(call('write_file'), { ...base, planMode: true });
    expect(r.isError).toBe(true);
    expect(String(r.result)).toContain('plan mode');
    expect(String(r.result)).toContain('exit_plan_mode');
  });

  it('真不存在的工具(无 unlockTools 的 ctx,如 delegate):不指 load_tools——那里没有这工具', async () => {
    const r = await executeTool(call('no_such_tool_xyz'), base);
    expect(r.isError).toBe(true);
    expect(String(r.result)).toContain('do not retry');
    expect(String(r.result)).not.toContain('load_tools');
  });

  it('真不存在的工具(有解锁回调+有 deferred 目录):指向 load_tools', async () => {
    const r = await executeTool(call('no_such_tool_xyz'), { ...base, unlockedTools: new Set<string>(), unlockTools: () => {} });
    expect(r.isError).toBe(true);
    expect(String(r.result)).toContain('load_tools');
  });

  it('plan 模式下的未知名(custom/MCP 无法逐名识别):附模式级说明兜底', async () => {
    const r = await executeTool(call('mcp__foo__bar'), { ...base, planMode: true });
    expect(r.isError).toBe(true);
    expect(String(r.result)).toContain('plan mode is active');
  });
});

describe('额外工作文件夹(工作范围)', () => {
  const env = (extra?: string[]) =>
    defaultPromptSections({ execMode: 'host', cwd: '/w/proj', extraRoots: extra }).environment.join('\n');

  it('没加时环境段里不出现「additional working folders」块', () => {
    expect(env()).not.toMatch(/additional working folders/i);
    expect(env([])).not.toMatch(/additional working folders/i);
  });

  it('加了就按绝对路径逐条列出,并声明免额外审批 + 相对路径仍相对 cwd', () => {
    const s = env(['/other/docs', '/other/assets']);
    expect(s).toMatch(/additional working folders/i);
    expect(s).toContain('`/other/docs`');
    expect(s).toContain('`/other/assets`');
    expect(s).toMatch(/no extra approval/i);
    expect(s).toMatch(/relative paths still resolve against the current working directory/i);
  });

  it('与 cwd 相同的条目不重复列(默认目录已在上一行)', () => {
    expect(env(['/w/proj'])).not.toMatch(/additional working folders/i);
  });

  it('sandbox 会话不受影响(压根没有本机目录段)', () => {
    const s = defaultPromptSections({ execMode: 'sandbox', extraRoots: ['/other/docs'] }).environment.join('\n');
    expect(s).not.toMatch(/additional working folders/i);
  });
});
