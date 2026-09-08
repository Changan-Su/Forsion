/**
 * 07-30 二轮子代理升级:①fork 转写过滤(借 Codex fork_turns:只留 user/assistant 正文,
 * 剥 system/tool 噪音,尾部优先预算);②delegate 并行能力登记(此前未进 DEFAULT_TOOL_CAPABILITIES
 * 落 SERIAL 兜底,一轮多 delegate 只能串行——与「可并行外包」的定位直接矛盾)。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { buildForkTranscript, exhaustedReport } from '../src/services/subAgent.js';
import { getToolCapabilities } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/registry.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
beforeAll(() => {
  configureTangu({ host: stub, brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }) });
});

describe('buildForkTranscript', () => {
  it('只留 user/assistant 正文;model 归一为 assistant;system/tool/空正文剔除;顺序保持', () => {
    const t = buildForkTranscript([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'model', content: 'a1' },
      { role: 'assistant', content: '' }, // 工具调用壳:无正文 → 剔
      { role: 'tool', content: 'tool noise' },
      { role: 'user', content: 'q2' },
    ]);
    expect(t).toBe('User: q1\n\nAssistant: a1\n\nUser: q2');
    expect(t).not.toContain('SYS');
    expect(t).not.toContain('tool noise');
  });

  it('预算尾部优先:超总量上限丢最旧、最近必在;单条超长按上限截断', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i} ` + 'x'.repeat(900) }));
    const t = buildForkTranscript(rows);
    expect(t).toContain('m29 '); // 最新必在
    expect(t).not.toContain('m0 '); // 最旧被预算挤掉
    const single = buildForkTranscript([{ role: 'user', content: 'y'.repeat(10_000) }]);
    expect(single.length).toBeLessThan(4_100); // 单条 4k 截断(+ 'User: ' 前缀)
  });
});

describe('delegate 并行能力', () => {
  it('parallel:true 且 sideEffect 不在 write/system/browser(满足 agentLoop canRunToolInParallel)', () => {
    const profile = createTanguProfile({ sandboxMode: 'none' });
    const ctx: ToolContext = { userId: 'u', sessionId: 's', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp' } as any;
    const caps = getToolCapabilities('delegate', ctx);
    expect(caps.parallel).toBe(true);
    expect(['write', 'system', 'browser']).not.toContain(caps.sideEffect);
  });
});

describe('withWriteLock — 写工具全局单链(Codex 评审 #1:并行子代理读-改-写不交叠)', () => {
  it('并发进入按提交序串行;前序失败不阻断后续', async () => {
    const { withWriteLock } = await import('../src/tools/hostExec.js');
    const order: string[] = [];
    const slow = withWriteLock(async () => { order.push('a-in'); await new Promise((r) => setTimeout(r, 30)); order.push('a-out'); return 'a'; });
    const failing = withWriteLock(async () => { order.push('b'); throw new Error('boom'); });
    const fast = withWriteLock(async () => { order.push('c'); return 'c'; });
    await expect(slow).resolves.toBe('a');
    await expect(failing).rejects.toThrow('boom');
    await expect(fast).resolves.toBe('c');
    expect(order).toEqual(['a-in', 'a-out', 'b', 'c']); // b/c 不得插进 a 的临界区
  });
});

/**
 * 09-06 青鸟事故:子代理排查了 113s、第 8 轮(触顶那轮不发 tools)只吐出一个工具调用、正文为空 →
 * 父代理收到的是一句「(no conclusion)」,ffmpeg not found 这个真报错整个丢了,于是父代理从零重来。
 */
describe('exhaustedReport', () => {
  it('触顶时把最后一次工具结果与待发调用交回父代理', () => {
    const r = exhaustedReport({ name: 'run_bash', isError: false, preview: 'ERROR: ffprobe and ffmpeg not found' }, 'run_bash', true);
    expect(r).toContain('iteration cap');
    expect(r).toContain('ffmpeg not found'); // 真报错必须带回去
    expect(r).toContain('about to call: run_bash');
  });

  it('没触顶就别谎报触顶(模型这轮直接空手而归也走这条)', () => {
    const r = exhaustedReport({ name: 'read_file', isError: true, preview: 'ENOENT' }, null);
    expect(r).not.toContain('iteration cap');
    expect(r).toContain('ENOENT');
  });

  it('什么都没发生过才回落到原来那句空话', () => {
    expect(exhaustedReport(null, null)).toBe('(the sub-agent produced no conclusion)');
  });
});
