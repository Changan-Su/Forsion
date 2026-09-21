/**
 * pickMainLoopUsage —— GET /agent/sessions/:id/usage 回放「当前上下文占用」时必须跳过后台调用
 * 的 usage 事件(C-5:压缩/子代理/脑暴/判官带 phase)。本轮之前流里只有主循环事件,取最后一条即可;
 * 现在 run 中途、或在 delegate/脑暴上中断的 run,最后一条会是子代理自己的小上下文。
 */
import { describe, it, expect } from 'vitest';
import { findMainLoopUsage, pickMainLoopUsage, sessionContextTokens } from './sessions.js';

describe('pickMainLoopUsage', () => {
  it('跳过带 phase 的事件,取最近一条主循环用量(SQLite:payload 是 JSON 字符串)', () => {
    const rows = [
      { payload: JSON.stringify({ phase: 'delegate', prompt: 900, iteration: 3 }) },
      { payload: JSON.stringify({ phase: 'compaction', prompt: 1200 }) },
      { payload: JSON.stringify({ prompt: 41000, completion: 80 }) },
      { payload: JSON.stringify({ prompt: 38000 }) },
    ];
    expect(pickMainLoopUsage(rows).prompt).toBe(41000); // 降序传入 → 命中更近的那条,不是更早的 38000
  });

  it('PG 的 jsonb 对象同样处理;不可解析的行跳过而不是抛', () => {
    const rows = [{ payload: '{坏掉的 JSON' }, { payload: { phase: 'brainstorm', prompt: 700 } }, { payload: { prompt: 33000 } }];
    expect(pickMainLoopUsage(rows).prompt).toBe(33000);
  });

  it('窗口内全是后台事件 / 无事件 → {},contextTokens 回落 0(与「没有事件」同义)', () => {
    expect(pickMainLoopUsage([{ payload: { phase: 'muse-judge', prompt: 500 } }])).toEqual({});
    expect(pickMainLoopUsage([])).toEqual({});
    expect(pickMainLoopUsage(undefined)).toEqual({});
  });
});

/**
 * 分页向后找主循环 usage(Codex 评审三轮 #7):固定 20 条窗口低于已知生产者上限 ——
 * 单个 delegate(SUB_MAX_ITERATIONS=24)就能连着产出 24 条 phase='delegate' 的后台 usage,
 * 窗口内全是后台事件时接口会谎报 contextTokens=0,尽管更早明明有有效的主循环记录。
 */
describe('findMainLoopUsage 向后翻页', () => {
  /** 造一串「最近 n 条后台 usage,再往前才是主循环那条」的事件流(按 e.id 降序取页)。 */
  const stream = (backgroundCount: number, mainPrompt = 41000): Array<{ id: number; payload: any }> => {
    const rows: Array<{ id: number; payload: any }> = [];
    for (let i = 0; i < backgroundCount; i++) rows.push({ id: 1000 - i, payload: { phase: 'delegate', prompt: 900, iteration: i } });
    rows.push({ id: 1000 - backgroundCount, payload: { prompt: mainPrompt, completion: 80 } });
    rows.push({ id: 1000 - backgroundCount - 1, payload: { prompt: 38000 } });
    return rows;
  };
  const pager = (rows: Array<{ id: number; payload: any }>, pageSize = 20) => {
    const calls: Array<number | null> = [];
    return {
      calls,
      fetch: async (cursor: number | null) => {
        calls.push(cursor);
        const from = cursor === null ? rows : rows.filter((r) => r.id < cursor);
        return from.slice(0, pageSize);
      },
    };
  };

  it('一个 delegate 的 24 条后台 usage 挡在前面,仍能翻到更早的主循环那条', async () => {
    const p = pager(stream(24));
    expect((await findMainLoopUsage(p.fetch)).prompt).toBe(41000);
    expect(p.calls.length).toBe(2); // 第一页全是后台 → 带游标再取一页
  });

  it('单页就命中时不多翻一页', async () => {
    const p = pager(stream(3));
    expect((await findMainLoopUsage(p.fetch)).prompt).toBe(41000);
    expect(p.calls).toEqual([null]);
  });

  it('上限内都是后台事件 → {}(contextTokens 回落 0),且翻页次数有界不失控', async () => {
    const p = pager(stream(10_000));
    expect(await findMainLoopUsage(p.fetch)).toEqual({});
    expect(p.calls.length).toBe(10); // ponytail: 10 页 × 20 条 = 200 行上限
  });

  it('事件流本身就没有 usage → {},一次查询即止', async () => {
    const p = pager([]);
    expect(await findMainLoopUsage(p.fetch)).toEqual({});
    expect(p.calls).toEqual([null]);
  });

  it('后端不给 id(无法做游标)时退回单页行为,绝不死循环', async () => {
    let n = 0;
    const fetch = async () => { n++; return Array.from({ length: 20 }, () => ({ payload: { phase: 'delegate', prompt: 1 } })); };
    expect(await findMainLoopUsage(fetch)).toEqual({});
    expect(n).toBe(1);
  });
});

/**
 * 手动 /compact 不产生 usage(09-20「压缩完进度圈不动,发新消息才更新」):检查点整行覆盖到最后一行 → 报 摘要 + 固定头,
 * 不再报压缩前那条 usage。惰性检查点 / run 内压缩之后还有要回放的行 → 仍报实测,绝不拿粗估顶替。
 */
describe('sessionContextTokens', () => {
  const usage = { prompt: 387_668, systemBytes: 20_000, toolsBytes: 28_000 };
  const cp = { id: 'c', summary: 'x'.repeat(4000), throughTimestamp: 1000, throughMessageId: 'm9' };

  it('没有检查点 / 没有行 → 最近主循环 usage 的 prompt', () => {
    expect(sessionContextTokens(usage, null, { id: 'm9', timestamp: 1000 })).toBe(387_668);
    expect(sessionContextTokens(usage, cp, undefined)).toBe(387_668);
    expect(sessionContextTokens({}, null, undefined)).toBe(0);
  });

  it('检查点整行覆盖到最后一行(手动 /compact 之后)→ 摘要 + 固定头,远小于压缩前', () => {
    const n = sessionContextTokens(usage, cp, { id: 'm9', timestamp: 1000 });
    expect(n).toBeGreaterThan(12_000); // 固定头 (20000+28000)/4
    expect(n).toBeLessThan(20_000);
  });

  it('检查点之后还有行(惰性检查点只盖窗口外 / 压缩后又聊过)→ 实测值', () => {
    expect(sessionContextTokens(usage, cp, { id: 'm10', timestamp: 2000 })).toBe(387_668);
  });

  it('行内切点(run 内压缩只盖到最后一行的半截)→ 实测值', () => {
    expect(sessionContextTokens(usage, { ...cp, throughToolCallId: 't3' }, { id: 'm9', timestamp: 1000 })).toBe(387_668);
  });
});
