/**
 * 「主模型能不能看图」的判定契约(mainModelSupportsVision)——agentLoop 的自动降级闸就挂在它上面,
 * 判错的代价是静默劣化(白跑一次辅助模型 + 丢原图细节),所以三层判定源各自锁一条断言:
 *   ① admin 在托管模型上标 supportsVision=false
 *   ② 直连 provider 声明 noVisionModelIds(前缀 id 与裸名都得认)
 *   ③ 硬编码黑名单(modelSupportsVision,另见 src/llm/modelCapabilities.test.ts)
 * 缺省 = 有视觉(黑名单制)。云端不可达时也必须缺省放行,不能因为拉不到目录就把图全拦下来。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';
import { describeImages, mainModelSupportsVision, __resetVisionSlotCacheForTests } from '../src/services/visionService.js';

const fakeHost: any = { query: async () => [], authMiddleware: (_q: any, _r: any, n: any) => n(), adminMiddleware: (_q: any, _r: any, n: any) => n() };
const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };

function configure(models: any): void {
  configureTangu({
    host: fakeHost,
    brain: { models } as any,
    billing: fakeBilling,
    profile: createAiStudioProfile(),
    state: {} as any,
  });
  __resetVisionSlotCacheForTests();
}

beforeEach(() => configure({}));

describe('mainModelSupportsVision', () => {
  it('目录里没说话 → 默认有视觉', async () => {
    await expect(mainModelSupportsVision('gpt-5')).resolves.toBe(true);
    await expect(mainModelSupportsVision('')).resolves.toBe(true);
  });

  it('admin 标注 supportsVision=false 的托管模型判为无视觉', async () => {
    configure({
      listModelsForProject: async () => ({
        models: [{ id: 'my-text-llm', supportsVision: false }, { id: 'my-vl', supportsVision: true }],
        defaultModelId: null,
        visionModelId: 'my-vl',
      }),
    });
    await expect(mainModelSupportsVision('my-text-llm')).resolves.toBe(false);
    await expect(mainModelSupportsVision('my-vl')).resolves.toBe(true);
  });

  it('直连 provider 的 noVisionModelIds:前缀 id 与裸名都算命中', async () => {
    configure({
      listDirectProviders: () => [{ providerId: 'ollama', modelIds: ['llama4', 'gemma3'], noVisionModelIds: ['gemma3'] }],
    });
    await expect(mainModelSupportsVision('ollama/gemma3')).resolves.toBe(false);
    await expect(mainModelSupportsVision('gemma3')).resolves.toBe(false);
    await expect(mainModelSupportsVision('ollama/llama4')).resolves.toBe(true);
  });

  it('云端不可达也必须缺省放行(拉不到目录 ≠ 没视觉)', async () => {
    configure({ listModelsForProject: async () => { throw new Error('network down'); } });
    await expect(mainModelSupportsVision('gpt-5')).resolves.toBe(true);
  });

  it('硬编码黑名单仍然生效(没有任何标注时)', async () => {
    await expect(mainModelSupportsVision('deepseek-reasoner')).resolves.toBe(false);
  });

  it('⚠️直连黑名单按 provider 归属判:A 的名单不误伤 B 的同名模型', async () => {
    configure({
      listDirectProviders: () => [
        { providerId: 'a', modelIds: ['gemma3'], noVisionModelIds: ['gemma3'] },
        { providerId: 'b', modelIds: ['gemma3'] },
      ],
    });
    await expect(mainModelSupportsVision('a/gemma3')).resolves.toBe(false);
    await expect(mainModelSupportsVision('b/gemma3')).resolves.toBe(true);
  });

  it('⚠️槽快照按 appId 分桶(云端一进程多 app,基线 profile 不是本 run 的 app)', async () => {
    const seen: string[] = [];
    configure({
      listModelsForProject: async (appId: string) => {
        seen.push(appId);
        return { models: [{ id: 'm', supportsVision: appId === 'app-a' ? false : true }], defaultModelId: null };
      },
    });
    await expect(mainModelSupportsVision('m', 'app-a')).resolves.toBe(false);
    await expect(mainModelSupportsVision('m', 'app-b')).resolves.toBe(true);
    expect(seen).toEqual(['app-a', 'app-b']); // 两个桶各拉各的,没互相顶掉
  });
});

describe('describeImages — 超量抛错而非静默截断', () => {
  it('超过单次上限直接抛(调用方据此退回直接送图,一张不丢)', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ url: `data:image/png;base64,x${i}` }));
    await expect(describeImages(many, { modelId: 'vl', userId: 'u1' })).rejects.toThrow(/最多识别 8 张/);
  });

  it('没配槽也抛(不拿主模型顶上)', async () => {
    await expect(describeImages([{ url: 'data:image/png;base64,x' }], { modelId: '', userId: 'u1' }))
      .rejects.toThrow(/未配置图像识别模型/);
  });
});
