/**
 * 两个缓存仪器脚本的归属口径:
 *  - scripts/cache-hit-report.mjs 的 analyze —— 后台 usage 自成一桶且不动首/后续链、缓存量未知不算未命中、
 *    窗口前的边界态压住假冷启动;
 *  - scripts/stall-timeline.mjs 的 attribute —— 后台 usage 不进主循环的 prompt/缓存/首帧分布。
 * 改这几条口径先过这里。SQL 那半(事件截窗 / 边界预取)由脚本对真 state.db 实跑覆盖,不进单测;
 * stall-timeline 的墙钟归属断言在 test/stallTimeline.test.ts,不在这儿。
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error 脚本是无类型的 .mjs
import { analyze, agentOf } from '../scripts/cache-hit-report.mjs';
// @ts-expect-error 同上
import { attribute } from '../scripts/stall-timeline.mjs';

const T0 = 1_700_000_000_000;
const ev = (type, t, p = {}) => ({ seq: t, type, t, p });
/** 一次主循环 usage:带 cacheReported 才算「上报过」。 */
const usage = (t, prompt, cached, extra = {}) => ev('usage', t, { prompt, cached, completion: 10, cacheReported: true, iteration: 0, ...extra });
const mkRun = (id, sessionId, events, extra = {}) => ({ id, sessionId, model: 'm1', created: events[0]?.t ?? T0, agent: 'xyra', isMuse: false, events, ...extra });
const load = (runs, extra = {}) => ({ runs, full: true, boundary: { session: new Map(), agentModel: new Map() }, boundaryKnown: true, ...extra });

describe('cache-hit-report analyze', () => {
  it('后台 usage(带 phase)自成一桶,不占 firstDone、不推进会话链', () => {
    const a = analyze(load([
      mkRun('r1', 's1', [
        // 自动压缩先发一条 phase=compaction 的 usage:它不能占掉首调,也不能把 compaction 标记吃掉
        ev('status', T0, { phase: 'compacted' }),
        ev('usage', T0 + 1, { prompt: 8000, cached: 0, completion: 5, cacheReported: true, phase: 'compaction' }),
        usage(T0 + 2, 10_000, 9000),
      ]),
    ]));
    expect(a.buckets['background:compaction'].n).toBe(1);
    expect(a.buckets['background:compaction'].uncached).toBe(8000);
    // 真正的主循环首调仍是「首调」,而不是被顶成「后续」
    expect(a.buckets['cold-start'].n).toBe(1);
    expect(a.buckets['compaction'].n).toBe(0);
    expect(a.firstGap['session-first'].n).toBe(1);
    expect(a.byModel.m1.first.n).toBe(1);
    expect(a.byModel.m1.later.n).toBe(0);
    expect(a.bucketSum).toBe(a.uncachedTotal);
  });

  it('后台 usage 不算「上次活动」:同会话下一个 run 的首调间隔照旧从主循环那条算', () => {
    const a = analyze(load([
      mkRun('r1', 's1', [usage(T0, 1000, 900)]),
      // 5 分钟后只有一条后台 usage,再过 5 分钟才是下一个 run 的首调 → 间隔应是 10min(冷启动),不是 5min
      mkRun('r2', 's1', [ev('usage', T0 + 300_000, { prompt: 500, cached: 0, cacheReported: true, phase: 'delegate' })]),
      mkRun('r3', 's1', [usage(T0 + 600_000, 1000, 500)]),
    ]));
    expect(a.firstGap['>=10min'].n).toBe(1);
    expect(a.firstGap['3-10min'].n).toBe(0);
  });

  it('缓存量未知的调用不进命中率、不进未命中划分(cacheReported=false / 老事件缺字段且 cached=0)', () => {
    const a = analyze(load([
      mkRun('r1', 's1', [
        usage(T0, 10_000, 9000),                                                       // 已上报
        ev('usage', T0 + 1000, { prompt: 20_000, cached: 0, cacheReported: false, iteration: 1 }), // 明确没报
        ev('usage', T0 + 2000, { prompt: 30_000, cached: 0, iteration: 2 }),           // 老事件缺字段且 cached=0 → 未知
        ev('usage', T0 + 3000, { prompt: 1000, cached: 400, iteration: 3 }),           // 老事件缺字段但 cached>0 → 算已报
      ]),
    ]));
    expect(a.totals.unknownCalls).toBe(2);
    expect(a.totals.unknownPrompt).toBe(50_000);
    expect(a.totals.knownPrompt).toBe(11_000);
    expect(a.totals.knownCached).toBe(9400);
    expect(a.uncachedTotal).toBe(1600);                 // 未知那 50k 一个字节都不算未命中
    expect(a.buckets['cache-unreported']).toMatchObject({ n: 2, uncached: 0, prompt: 50_000 });
    expect(a.bucketSum).toBe(a.uncachedTotal);
  });

  it('窗口前的边界态压住假冷启动;取不到边界态时首条标 window-first', () => {
    const events = [usage(T0 + 60_000, 1000, 800)];
    const withBoundary = analyze(load([mkRun('r1', 's1', events)], {
      boundary: { session: new Map([['s1', T0]]), agentModel: new Map([['xyra|m1', T0]]) },
    }));
    expect(withBoundary.buckets['cold-start'].n).toBe(0);
    expect(withBoundary.buckets['short-gap-structure'].n).toBe(1); // 距窗口前那次 60s
    expect(withBoundary.firstGap['session-first'].n).toBe(0);

    // 会话是窗口内新建的,但同 (agent,模型) 在窗口前刚活动过 → 跨会话那张表不该记成 no-prior
    const newSessionOldAgent = analyze(load([mkRun('r1', 's9', events)], {
      boundary: { session: new Map(), agentModel: new Map([['xyra|m1', T0]]) },
    }));
    expect(newSessionOldAgent.xsess['<3min'].n).toBe(1);
    expect(newSessionOldAgent.xsess['no-prior'].n).toBe(0);

    const unknownBoundary = analyze(load([mkRun('r1', 's1', events)], { boundaryKnown: false }));
    expect(unknownBoundary.buckets['window-first'].n).toBe(1);
    expect(unknownBoundary.buckets['cold-start'].n).toBe(0);
    expect(unknownBoundary.firstGap['window-first'].n).toBe(1);

    const noBoundary = analyze(load([mkRun('r1', 's1', events)]));
    expect(noBoundary.buckets['cold-start'].n).toBe(1); // 边界可知且确实没有历史 = 真冷启动
  });

  it('群聊逐发言人用量不进首/后续链,但照记「上次活动」', () => {
    const a = analyze(load([
      mkRun('g1', 's1', [ev('usage', T0, { prompt: 2000, cached: 1000, cacheReported: true, agentId: 'qinche' })], { agent: 'group-chat' }),
      mkRun('r2', 's1', [usage(T0 + 30_000, 1000, 900)]),
    ]));
    expect(a.buckets['group-chat'].n).toBe(1);
    expect(a.speakers.qinche).toBe(1);
    expect(a.byAgent['qinche (group)'].calls).toBe(1);
    expect(a.buckets['cold-start'].n).toBe(0);            // 群聊那条已把会话标成「见过」
    expect(a.buckets['short-gap-structure'].n).toBe(1);
  });
});

describe('cache-hit-report agentOf', () => {
  it('缺省档回落到引擎的 DEFAULT_AGENT_SLUG,不是 (none)', () => {
    expect(agentOf(null, null, null)).toBe('xyra');        // 普通 run 不写 agentSlug = 引擎缺省 Agent
    expect(agentOf('qinche', null, null)).toBe('qinche');  // 显式 slug 优先
    expect(agentOf(null, 1, null)).toBe('group-chat');     // 群聊 run 没有单一 agent
    expect(agentOf(null, 1, 'qinche')).toBe('group-chat'); // 群聊里的 agentId 是发言人,不是 run 的身份
    expect(agentOf(null, null, 'coding')).toBe('coding');  // 事件里落了有效 agentId 就用它
  });
});

describe('stall-timeline 后台 usage 分桶', () => {
  it('带 phase 的 usage 不进 prompt/缓存/首帧分布,单列 bg 桶', () => {
    const e = (type, t, extra = {}) => ({ seq: t, type, t, ...extra });
    const r = attribute([{
      id: 'R', model: 'm', created: T0, events: [
        e('usage', T0 + 1000, { prompt: 9000, cached: 0, ttftMs: 30_000, uploadMs: 900, phase: 'compaction' }),
        e('usage', T0 + 2000, { prompt: 1000, cached: 800, ttftMs: 500, uploadMs: 10 }),
      ],
    }]);
    expect(r.perModel.m.prompt).toEqual([1000]);        // 压缩那次 9000 不该混进主循环画像
    expect(r.perModel.m.cached).toEqual([0.8]);
    expect(r.perModel.m.ttftMeasured).toEqual([500]);
    expect(r.perModel.m.upload).toEqual([10]);
    expect(r.perModel.m.bg).toEqual({ compaction: { n: 1, prompt: 9000, cached: 0 } });
  });
});
