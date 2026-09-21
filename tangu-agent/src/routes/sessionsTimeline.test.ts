/**
 * 导出时间线(GET /agent/sessions/:id/timeline,「设置→高级→导出日志」与 scripts/stall-timeline.mjs 的另一个数据源)
 * 的字段裁剪:usage 必须带 phase(否则后台调用与主循环调用在导出里混成一团),cache_probe 必须有自己的 case
 * (此前落进 default 返回 {},headHash/changedSegments/probeSeq 一个都到不了导出)。
 */
import { describe, it, expect } from 'vitest';
import { timelineFields } from './sessions.js';

describe('timelineFields', () => {
  it('usage 带 phase:后台调用可与主循环调用分开', () => {
    const bg = timelineFields('usage', { prompt: 100, completion: 20, cached: 80, phase: 'compaction', ttftMs: 12, iteration: 0 });
    expect(bg.phase).toBe('compaction');
    expect(bg.prompt).toBe(100);
    // 主循环调用不带 phase:undefined,res.json 会直接丢掉这个键,不占导出体积。
    const loop = timelineFields('usage', { prompt: 100, completion: 20, cached: 80, iteration: 1 });
    expect(loop.phase).toBeUndefined();
    expect(JSON.parse(JSON.stringify(loop))).not.toHaveProperty('phase');
  });

  it('A4/C-2 仪器字段透传:cacheReported:false 与 reasoningTokens:0 都不能被当成「没这回事」', () => {
    const f = timelineFields('usage', {
      prompt: 100, completion: 20, cached: 0,
      cacheReported: false, systemBytes: 4096, toolsBytes: 0,
      headHash: 'abc123def4567890', reasoningTokens: 0,
    });
    // 「上游没报缓存」必须原样到导出:落成 undefined 就与老格式/真 0 命中混作一谈。
    expect(f.cacheReported).toBe(false);
    expect(f.reasoningTokens).toBe(0);
    expect(f.toolsBytes).toBe(0); // 末轮不发 tools 就是 0 字节,别被 `||` 吞成 undefined
    expect(f.systemBytes).toBe(4096);
    expect(f.headHash).toBe('abc123def4567890');
    // 这几个键在 JSON 里要真的在(false/0 不是「缺省」)。
    const round = JSON.parse(JSON.stringify(f));
    expect(round).toHaveProperty('cacheReported', false);
    expect(round).toHaveProperty('reasoningTokens', 0);
  });

  it('后台调用没报这些字段时,键仍是 undefined(res.json 丢掉,不占导出体积)', () => {
    const f = timelineFields('usage', { prompt: 100, completion: 20, cached: 80, phase: 'compaction' });
    expect(JSON.parse(JSON.stringify(f))).not.toHaveProperty('reasoningTokens');
    expect(JSON.parse(JSON.stringify(f))).not.toHaveProperty('cacheReported');
  });

  it('cache_probe 有自己的 case:头指纹与变化段进得了导出', () => {
    const f = timelineFields('cache_probe', {
      sessionId: 's1', runId: 'r1', iteration: 2, probeSeq: 3,
      headHash: 'abc123def4567890',
      segments: [{ name: 'tools', hash: 'ff00', bytes: 42 }],
      changedSegments: ['tail:runtime'],
      headHashSameAsAgentModel: false,
    });
    expect(f.probeSeq).toBe(3);
    expect(f.headHash).toBe('abc123def4567890');
    expect(f.changedSegments).toEqual(['tail:runtime']);
    expect(f.headHashSameAsAgentModel).toBe(false);
    // ponytail: 逐段明细不进导出(一次迭代九条),要逐段对比走 scripts/cache-hit-report.mjs。
    expect(f).not.toHaveProperty('segments');
  });

  it('approval_request 带「为什么问 / 生效档 / 哪位成员」,不带路径与参数', () => {
    const f = timelineFields('approval_request', {
      approvalId: 'a1', name: 'write_file', arguments: '{"path":"C:\\\\x"}', preview: 'write C:\\x',
      reason: { kind: 'escalate', mode: 'auto-edit' }, agentSlug: 'xie', agentName: 'Xie', messageId: 'm1', runId: 'r1',
    });
    expect(f).toEqual({ name: 'write_file', reason: 'escalate', mode: 'auto-edit', agent: 'xie' });
  });
});
