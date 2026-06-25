/**
 * standalone 多 provider brain —— 接缝② `brain.llm` 的 dispatcher。
 *
 * 包住一个 httpBrain(Forsion 托管面),只覆写 `llm`:本地注册表命中 → 走 openaiCompat 直连用户自有
 * provider;未命中 → 委托 httpBrain(经 brain-api 用 Forsion 托管模型,计费在云端)。
 * memory / skills / search / users / models / storage 全透传 httpBrain。
 *
 * 「Forsion 只是其中一个 provider」即在此体现:Forsion 是兜底的托管面,直连 provider 与其平级。
 */
import type { CloudBrainServices, BuildPayloadOpts, StreamOpts } from '../../seams/cloudBrain.js';
import type { ProviderRegistry } from '../../llm/providerRegistry.js';
import { buildOpenAiCompatPayload, streamOpenAiCompat, DIRECT_MARK, PROTOCOL_MARK } from '../../llm/openaiCompat.js';
import { streamAnthropicOAuth } from '../../llm/anthropicMessages.js';
import { streamOpenAiResponses } from '../../llm/openaiResponses.js';

export function createMultiBrain(httpBrain: CloudBrainServices, registry: ProviderRegistry): CloudBrainServices {
  return {
    ...httpBrain,
    models: {
      ...httpBrain.models,
      // 直连 provider 目录(模型选择器/Providers 页用;剥掉 apiKey,baseUrl 仅供 UI 展示)。
      listDirectProviders: () =>
        registry.list().map((p) => ({ providerId: p.providerId, baseUrl: p.baseUrl, modelIds: p.modelIds })),
    },
    llm: {
      resolveModelAndKey: async (modelId: string) => {
        const local = registry.resolve(modelId);
        if (local) return local; // local.model 带 DIRECT_MARK
        return httpBrain.llm.resolveModelAndKey(modelId);
      },
      buildProviderPayload: async (opts: BuildPayloadOpts) => {
        if ((opts.model as any)?.[DIRECT_MARK]) return buildOpenAiCompatPayload(opts);
        return httpBrain.llm.buildProviderPayload(opts);
      },
      streamProviderCompletion: async (opts: StreamOpts) => {
        const p = opts.payload as any;
        if (p?.[DIRECT_MARK]) {
          // 订阅登录的原生端点据协议再分发;缺省 OpenAI 兼容。
          if (p[PROTOCOL_MARK] === 'anthropic-messages') return streamAnthropicOAuth(opts);
          if (p[PROTOCOL_MARK] === 'openai-responses') return streamOpenAiResponses(opts);
          return streamOpenAiCompat(opts);
        }
        return httpBrain.llm.streamProviderCompletion(opts);
      },
    },
  };
}
