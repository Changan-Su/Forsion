/**
 * PUT /agent/models/overrides 的核心:云端 worker 一律拒(config.json 是该进程所有用户共用的);
 * 本地按 token 校验后落 modelOverrides 段。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { applyModelOverride } from './models.js';
import { modelOverrides, resetModelOverridesForTest } from '../services/modelOverrides.js';

describe('applyModelOverride', () => {
  beforeEach(() => resetModelOverridesForTest());

  it('云端(hostExec=false)→ 404 且什么都不写', () => {
    const r = applyModelOverride({ modelId: 'pr-a', contextWindow: 500_000 }, false);
    expect(r.code).toBe(404);
    expect(modelOverrides()).toEqual({});
  });

  it('本地:设 → 200 返回整段;272(把 K 当 token)→ 400;null → 清除', () => {
    expect(applyModelOverride({ modelId: 'pr-a', contextWindow: '500000' }, true)).toEqual({ code: 200, body: { overrides: { 'pr-a': { contextWindow: 500_000 } } } });
    expect(applyModelOverride({ modelId: 'pr-a', contextWindow: 272 }, true).code).toBe(400);
    expect(modelOverrides()).toEqual({ 'pr-a': { contextWindow: 500_000 } });
    expect(applyModelOverride({ modelId: 'pr-a', contextWindow: null }, true)).toEqual({ code: 200, body: { overrides: {} } });
    expect(applyModelOverride({ modelId: '', contextWindow: 500_000 }, true).code).toBe(400);
  });
});
