import { describe, it, expect, beforeEach } from 'vitest';
import { modelOverrides, setModelContextWindow, resetModelOverridesForTest } from './modelOverrides.js';

describe('modelOverrides(用户本机 per-model 覆盖)', () => {
  beforeEach(() => resetModelOverridesForTest());

  it('设 / 改 / 清:清窗口 = 删条目;返回写后整段', () => {
    expect(setModelContextWindow('pr-a', 272_000)).toEqual({ 'pr-a': { contextWindow: 272_000 } });
    expect(setModelContextWindow('pr-a', 500_000.7)).toEqual({ 'pr-a': { contextWindow: 500_000 } });
    expect(setModelContextWindow('codex/gpt-5.6-sol', 1_050_000)['codex/gpt-5.6-sol']).toEqual({ contextWindow: 1_050_000 });
    expect(setModelContextWindow('pr-a', null)).toEqual({ 'codex/gpt-5.6-sol': { contextWindow: 1_050_000 } });
    expect(modelOverrides()).toEqual({ 'codex/gpt-5.6-sol': { contextWindow: 1_050_000 } });
  });

  it('拒绝把 K 当 token 填的值与空 id', () => {
    expect(() => setModelContextWindow('pr-a', 272)).toThrow(/tokens/);
    expect(() => setModelContextWindow('pr-a', Number.NaN)).toThrow();
    expect(() => setModelContextWindow('  ', 272_000)).toThrow(/modelId/);
    expect(modelOverrides()).toEqual({});
  });

  it('读取时过滤脏条目(手编 config.json 写坏了不影响其余模型)', () => {
    resetModelOverridesForTest({ ok: { contextWindow: 200_000 }, small: { contextWindow: 100 }, junk: { contextWindow: 'x' as any } });
    expect(modelOverrides()).toEqual({ ok: { contextWindow: 200_000 } });
  });
});
