import { describe, expect, it } from 'vitest';
import { createTanguProfile } from '../profiles/index.js';
import { deps, configureTangu } from './runtime.js';
import { currentRunClientTag, enterRunContext, runWithAgentSlug, runWithUserAgentScope, setRunClientTag } from './runContext.js';
import { createRun } from '../services/runStore.js';

describe('run client tag propagation', () => {
  it('辅助模型 payload 与用量日志自动继承当前 run 的 client', async () => {
    let payloadOpts: any = null;
    let usageArgs: any[] = [];
    const brain = {
      llm: {
        buildProviderPayload: async (opts: any) => { payloadOpts = opts; return {}; },
      },
    } as any;
    const billing = {
      logApiUsage: async (...args: any[]) => { usageArgs = args; },
    } as any;
    configureTangu({
      host: {} as any,
      brain,
      billing,
      profile: createTanguProfile({ sandboxMode: 'none' }),
    });

    // 第五参是本次新增契约；修复前 JS 会静默忽略它，测试因此先红。
    (enterRunContext as any)('u', 'r', 'xyra', 'xyra', 'desktop/2.7.9');
    await runWithAgentSlug('helper', async () => {
      await deps().brain.llm.buildProviderPayload({ model: {}, apiModelId: 'm', messages: [] } as any);
      await deps().billing.logApiUsage('user', 'm');
    });

    expect(payloadOpts.client).toBe('desktop/2.7.9');
    expect(usageArgs[11]).toBe('desktop/2.7.9');
  });

  it('客户端标签只在同一个 run 内沿用:换了 runId 的新 run 不继承(排队接力在上一个 run 的收尾上下文里起跑)', async () => {
    await runWithUserAgentScope('u', 'a', async () => {
      enterRunContext('u', 'A');
      setRunClientTag('desktop/x');
      enterRunContext('u', 'A', 'slug');
      expect(currentRunClientTag(), '同一 run 再 enter(解析出 agentSlug)').toBe('desktop/x');
      enterRunContext('u', undefined, 'slug');
      expect(currentRunClientTag(), '不指定 runId 的作用域细化(Historian)').toBe('desktop/x');
      enterRunContext('u', 'B');
      expect(currentRunClientTag(), '新 run').toBeUndefined();
    });
  });

  it('调用方显式 client 优先于 run 上下文', async () => {
    let payloadOpts: any = null;
    const brain = {
      llm: {
        buildProviderPayload: async (opts: any) => { payloadOpts = opts; return {}; },
      },
    } as any;
    configureTangu({
      host: {} as any,
      brain,
      billing: {} as any,
      profile: createTanguProfile({ sandboxMode: 'none' }),
    });

    (enterRunContext as any)('u', 'r', undefined, undefined, 'desktop/2.7.9');
    await deps().brain.llm.buildProviderPayload({
      model: {}, apiModelId: 'm', messages: [], client: 'web/9.9.9',
    } as any);

    expect(payloadOpts.client).toBe('web/9.9.9');
  });

  it('由当前 run 派生的新 run 继承 client', async () => {
    let created: any = null;
    configureTangu({
      host: {} as any,
      brain: {} as any,
      billing: {} as any,
      profile: createTanguProfile({ sandboxMode: 'none' }),
      state: { createRun: async (run: any) => { created = run; } } as any,
    });

    (enterRunContext as any)('u', 'parent', undefined, undefined, 'mobile/2.7.9');
    await createRun({
      id: 'child', sessionId: 's', userId: 'u', appId: 'tangu', modelId: 'm',
      assistantMessageId: 'a', input: { message: 'derived auxiliary run' },
    });

    expect(created.input.client).toBe('mobile/2.7.9');
  });
});
