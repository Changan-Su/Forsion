/**
 * 直连 provider 注册表 —— 接缝② `brain.llm` 的本地路由表。
 *
 * standalone 从 config/env 构建一组直连 provider(OpenAI / Ollama / 任意 OpenAI 兼容端点)。
 * `resolve(modelId)` 命中本地 provider → 返回带 DIRECT_MARK 的 ResolvedModel(走 openaiCompat);
 * 未命中 → 返回 null(交回 Forsion 托管面 httpBrain)。
 *
 * modelId 约定(二选一即命中):
 *   1. `<providerId>/<apiModelId>`  例:`ollama/llama3`、`openai/gpt-4o`
 *   2. 精确等于某 provider 的 modelIds 之一(provider 显式声明的模型白名单)
 */
import type { ResolvedModel } from '../core/types.js';
import { makeDirectModel } from './openaiCompat.js';

/** 直连推理协议。'openai' = OpenAI 兼容 /chat/completions(默认);其余为订阅登录的原生端点。 */
export type DirectProviderProtocol = 'openai' | 'anthropic-messages' | 'openai-responses';

export interface DirectProvider {
  providerId: string; // 'openai' / 'ollama' / 'anthropic-compat' …(也用作 modelId 前缀)
  baseUrl: string; // OpenAI 兼容端点根(含 /v1,如 http://localhost:11434/v1);openaiCompat 会拼 /chat/completions
  apiKey?: string; // 直连厂商的用户自有 key;Ollama 等本地端点可省
  modelIds?: string[]; // 可选:该 provider 的 LLM 模型白名单(支持不带前缀直接用)
  imageModelIds?: string[]; // 可选:该 provider 的生图模型白名单(generate_image 用;OpenAI 兼容 /images/generations)
  ttsModelIds?: string[]; // 可选:该 provider 的语音合成模型白名单(朗读用;OpenAI 兼容 /audio/speech)
  protocol?: DirectProviderProtocol; // 缺省 'openai';订阅登录据此切到原生端点
  accountId?: string; // Codex 订阅:chatgpt-account-id 头取值
}

export interface ProviderRegistry {
  resolve(modelId: string): ResolvedModel | null;
  list(): DirectProvider[];
  has(modelId: string): boolean;
}

export function createProviderRegistry(providers: DirectProvider[]): ProviderRegistry {
  const byId = new Map<string, DirectProvider>();
  for (const p of providers) {
    if (!p?.providerId || !p?.baseUrl) continue;
    byId.set(p.providerId, { ...p, baseUrl: p.baseUrl.replace(/\/+$/, '') });
  }

  function resolve(modelId: string): ResolvedModel | null {
    if (!modelId) return null;
    // 形式 1:<providerId>/<apiModelId>
    const slash = modelId.indexOf('/');
    if (slash > 0) {
      const prefix = modelId.slice(0, slash);
      const rest = modelId.slice(slash + 1);
      const p = byId.get(prefix);
      if (p && rest) {
        return { model: makeDirectModel(modelId, p.providerId, { protocol: p.protocol, accountId: p.accountId }), apiKey: p.apiKey || '', baseUrl: p.baseUrl, apiModelId: rest };
      }
    }
    // 形式 2:精确命中某 provider 的 modelIds
    for (const p of byId.values()) {
      if (p.modelIds?.includes(modelId)) {
        return { model: makeDirectModel(modelId, p.providerId, { protocol: p.protocol, accountId: p.accountId }), apiKey: p.apiKey || '', baseUrl: p.baseUrl, apiModelId: modelId };
      }
    }
    return null;
  }

  return {
    resolve,
    list: () => Array.from(byId.values()),
    has: (modelId: string) => resolve(modelId) !== null,
  };
}
