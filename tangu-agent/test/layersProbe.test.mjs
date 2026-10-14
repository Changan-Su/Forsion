/**
 * scripts/lib/layers-live.mjs 的判定(judgeLayers)。探针在基线和改后都是绿的,所以它「该红的时候会不会红」得单独钉住:
 * 换个说法躲过关键词、判官失败被当成正常完成、条目对不上会话 —— 都必须红(Codex 评审 10-13 用桩复现过前两种)。
 * 真模型那半(三句话到底落在哪)由 `npm run live:harness -- --only layers` 和 `--layers-neg` 覆盖,不进单测。
 */
import { describe, it, expect } from 'vitest';
import { judgeLayers } from '../scripts/lib/layers-live.mjs';

const JUDGED = '判断: title="" log="…" 候选=0 条';
const leg = (over = {}) => ({ sid: 's', error: null, judge: JUDGED, memory: [], inbox: [], rememberCalls: [], logEventCalls: [], judgeLog: [], ...over });
const PREF = '用户偏好回答先给结论，再展开细节，不要铺垫。';
/** 一轮干净的读数:A、C 什么都没存,B 只存了那条偏好;`over` 改其中一格。 */
const round = (over = {}) => ({
  round: 1, log: '提交了北辰项目季度复盘报告。\n出了三道注册测绘师考试练习题。', stray: [],
  legs: { A: leg(over.A), B: leg({ memory: [PREF], ...over.B }), C: leg(over.C) },
  ...(over.round || {}),
});

describe('layers 探针的判定', () => {
  it('干净的一轮是绿的;近况进了记忆只记数、不判红', () => {
    expect(judgeLayers([round()]).ok).toBe(true);
    const c = judgeLayers([round({ C: { memory: ['用户这几天在准备注册测绘师资格考试。'] } })]);
    expect(c.ok).toBe(true);
    expect(c.layers.c.model).toBe(1);
  });

  it('只对这段对话有效的指示:换了说法、一个关键词都不带,进记忆或候选箱照样红', () => {
    const reworded = '用户要求后续回答只依据当前材料，缺失内容直接说明。';
    expect(judgeLayers([round({ A: { memory: [reworded] } })]).ok).toBe(false);
    expect(judgeLayers([round({ A: { inbox: [reworded] } })]).ok).toBe(false);
  });

  it('今天做完的事:换了说法照样红;和偏好写在同一句里也红', () => {
    expect(judgeLayers([round({ B: { memory: [PREF, '用户递交了一份季度回顾文档。'] } })]).ok).toBe(false);
    expect(judgeLayers([round({ B: { inbox: ['用户今天交了报告，并希望回答先说结论。'] } })]).ok).toBe(false);
  });

  it('长期偏好一轮都没记下是红的(什么都拦住的边界不算边界);有一轮记下就行', () => {
    expect(judgeLayers([round({ B: { memory: [] } })]).ok).toBe(false);
    expect(judgeLayers([round({ B: { memory: [] } }), round({ B: { memory: [], inbox: [PREF] } })]).ok).toBe(true);
  });

  it('判官没正常出结果(解析失败 / 异常 / 超时)= 那条路没量到,不算绿', () => {
    for (const judge of ['判断输出无法解析为 JSON: "…"', 'onUserRunDone 异常: boom', null]) {
      const v = judgeLayers([round({ C: { judge } })]);
      expect(v.ok, String(judge)).toBe(false);
      expect(v.detail).toContain('判官没正常出结果');
    }
  });

  it('同一个会话里模型 log_event 和判官各写一行 = 同一件事写了两遍,红;只有一边写是绿的', () => {
    expect(judgeLayers([round({ B: { memory: [PREF], logEventCalls: ['交了季度复盘报告'], judgeLog: ['用户提交了季度报告'] } })]).ok).toBe(false);
    expect(judgeLayers([round({ B: { memory: [PREF], logEventCalls: ['交了季度复盘报告'] } })]).ok).toBe(true);
    expect(judgeLayers([round({ B: { memory: [PREF], judgeLog: ['用户提交了季度报告'] } })]).ok).toBe(true);
  });

  it('run 出错、或有条目对不上任何一个会话,都是红的', () => {
    expect(judgeLayers([round({ A: { error: 'events 500' } })]).ok).toBe(false);
    expect(judgeLayers([round({ round: { stray: ['来源不明的一条'] } })]).ok).toBe(false);
  });
});
