/**
 * PUT /agent/compaction 的核心:云端 worker 一律拒(config.json 是该进程所有用户共用的);本地经 normalize 落 compaction 段。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { applyCompactionUpdate } from './sessions.js';
import { globalCompactionLayer, resetGlobalCompactionForTest } from '../services/compactionSettings.js';

describe('applyCompactionUpdate', () => {
  beforeEach(() => resetGlobalCompactionForTest());

  it('云端(hostExec=false)→ 404 且什么都不写', () => {
    expect(applyCompactionUpdate({ thresholdPercent: 30 }, false).code).toBe(404);
    expect(globalCompactionLayer()).toEqual({});
  });

  it('本地:设 → 200 返回全局层;空 body / 坏值 → 400;null → 交还缺省', () => {
    expect(applyCompactionUpdate({ thresholdPercent: '30' }, true)).toEqual({ code: 200, body: { settings: { thresholdPercent: 30 } } });
    expect(applyCompactionUpdate({}, true).code).toBe(400);
    expect(applyCompactionUpdate({ thresholdPercent: 'half' }, true).code).toBe(400);
    expect(globalCompactionLayer()).toEqual({ thresholdPercent: 30 });
    expect(applyCompactionUpdate({ thresholdPercent: null }, true)).toEqual({ code: 200, body: { settings: {} } });
  });
});
