/** 计划审阅答案解析:修订全文只在头部逐字等于已知批准选项时才认。 */
import { describe, it, expect } from 'vitest';
import { parsePlanAnswer, PLAN_REVISION_MARK } from './interaction.js';

const APPROVE_AUTO = '批准,自动开始执行';
const APPROVE_MANUAL = '批准,退出计划模式(手动开始)';

describe('parsePlanAnswer', () => {
  it('批准(自动/手动)与打回', () => {
    expect(parsePlanAnswer(APPROVE_AUTO)).toMatchObject({ approved: true, autoStart: true, revised: undefined });
    expect(parsePlanAnswer(APPROVE_MANUAL)).toMatchObject({ approved: true, autoStart: false });
    const back = parsePlanAnswer('第 3 步换成先写测试');
    expect(back.approved).toBe(false);
    expect(back.raw).toBe('第 3 步换成先写测试'); // 反馈原文要完整回给模型
  });

  it('编辑后批准:取修订全文,头部仍是原样的批准选项', () => {
    const r = parsePlanAnswer(`${APPROVE_AUTO}${PLAN_REVISION_MARK}# 计划\n1. 先写测试`);
    expect(r).toMatchObject({ approved: true, autoStart: true, revised: '# 计划\n1. 先写测试' });
  });

  it('自由文本里恰好含标记 → 不当修订,整串回给模型', () => {
    const r = parsePlanAnswer(`别按这个来${PLAN_REVISION_MARK}随便写的`);
    expect(r.approved).toBe(false);
    expect(r.revised).toBeUndefined();
    expect(r.raw).toContain('随便写的');
  });

  it('自由文本批准只认「就这一个词」(兼容 TUI 打字)', () => {
    expect(parsePlanAnswer('批准').approved).toBe(true);
    expect(parsePlanAnswer('同意').approved).toBe(true);
    expect(parsePlanAnswer('ok').approved).toBe(true);
  });

  it('⚠️否定式反馈绝不能被当成批准(前缀/子串判会栽在这)', () => {
    for (const s of ['批准前先补上回滚方案', '批准不了,先说清楚迁移', '不批准', '批准这个之前请自动开始跑测试?不行']) {
      const r = parsePlanAnswer(s);
      expect(r.approved, s).toBe(false);
      expect(r.autoStart, s).toBe(false);
      expect(r.raw).toBe(s); // 反馈原文完整回给模型
    }
  });

  it('自动开始只认那一串逐字命中', () => {
    expect(parsePlanAnswer(APPROVE_AUTO).autoStart).toBe(true);
    expect(parsePlanAnswer(APPROVE_MANUAL).autoStart).toBe(false);
    expect(parsePlanAnswer('批准').autoStart).toBe(false);
  });

  it('非批准头部带标记 → 不当修订,整串(含标记后的正文)回给模型', () => {
    const s = `需要修改(在输入框写反馈)${PLAN_REVISION_MARK}第三步换成先写测试`;
    const r = parsePlanAnswer(s);
    expect(r.approved).toBe(false);
    expect(r.revised).toBeUndefined();
    expect(r.raw).toContain('第三步换成先写测试');
  });

  it('标记后为空 → 按无修订处理', () => {
    const r = parsePlanAnswer(`${APPROVE_MANUAL}${PLAN_REVISION_MARK}   `);
    expect(r.approved).toBe(true);
    expect(r.revised).toBeUndefined();
  });
});
