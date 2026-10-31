/**
 * 后台模型(Historian / Muse / 项目记忆)选过的托管模型被 admin 停用后,resolveBackgroundModelId 要回落,
 * 不能原样返回 —— 2026-10-25 用户反馈:Historian 钉着已停用的 deepseek-v4-flash,每轮「is disabled」静默失败。
 * 直连模型不受云端目录约束;拉不到目录时放行旧选择(负对照)。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';
import { resolveBackgroundModelId, __resetBackgroundSlotCacheForTests } from '../src/services/specialAgentsConfig.js';

// models.background 读 config.json —— 指向空临时目录,免得开发机上的真实配置染色。
process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-bg-model-test-'));

function configure(models: any): void {
  configureTangu({
    host: { query: async () => [] } as any,
    brain: { models } as any,
    billing: {} as any,
    profile: createAiStudioProfile(),
    state: {} as any,
  });
  __resetBackgroundSlotCacheForTests();
}

/** enabled = 全局启用的模型(listGlobalModels);槽位来自 app 级配置(listModelsForProject)。 */
const brain = (enabled: Array<string | { id: string; apiModelId?: string }>, extra: any = {}) => ({
  listModelsForProject: async () => ({ models: [], backgroundModelId: 'bg-slot', defaultModelId: 'chat-default' }),
  listGlobalModels: async () => enabled.map((m) => (typeof m === 'string' ? { id: m } : m)),
  ...extra,
});

describe('resolveBackgroundModelId — 停用模型回落', () => {
  beforeEach(() => configure({}));

  it('选过的模型仍启用 → 照用', async () => {
    configure(brain(['deepseek-v4-flash', 'bg-slot']));
    await expect(resolveBackgroundModelId('deepseek-v4-flash')).resolves.toBe('deepseek-v4-flash');
  });

  it('选过的模型被停用 → 回落 admin 辅助模型槽;槽也停用 → 对话默认', async () => {
    configure(brain(['bg-slot', 'chat-default']));
    await expect(resolveBackgroundModelId('deepseek-v4-flash')).resolves.toBe('bg-slot');
    configure(brain(['chat-default']));
    await expect(resolveBackgroundModelId('deepseek-v4-flash')).resolves.toBe('chat-default');
  });

  it('存的是上游名(apiModelId)也算启用 —— 云端两种都认(Codex 评审)', async () => {
    configure(brain([{ id: 'pr-123', apiModelId: 'deepseek-v4-flash' }]));
    await expect(resolveBackgroundModelId('deepseek-v4-flash')).resolves.toBe('deepseek-v4-flash');
  });

  it('直连模型照用,而且不等云端目录(云端卡住也不拖)', async () => {
    let calls = 0;
    const hang = () => { calls++; return new Promise<never>(() => {}); };
    configure({ listModelsForProject: hang, listGlobalModels: hang, hasDirectModel: (id: string) => id === 'codex/gpt-6-luna' });
    await expect(resolveBackgroundModelId('codex/gpt-6-luna')).resolves.toBe('codex/gpt-6-luna');
    expect(calls).toBe(0);
  });

  it('负对照:拉不到目录 → 不误判,沿用旧选择', async () => {
    configure(brain([], { listGlobalModels: async () => { throw new Error('offline'); } }));
    await expect(resolveBackgroundModelId('deepseek-v4-flash')).resolves.toBe('deepseek-v4-flash');
  });
});
