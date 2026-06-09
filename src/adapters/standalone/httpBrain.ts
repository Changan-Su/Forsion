/**
 * standalone 接缝②实现:CloudBrainServices over HTTP。
 * 持 forsion_token 调云端 /api/brain/*(契约对端见 server/microserver/brain-api/routes.ts)。
 * LLM 走云端代理(resolve/build-payload/stream),provider key 不下发;payload 对 core 不透明。
 */
import type {
  CloudBrainServices,
  BuildPayloadOpts,
  StreamOpts,
  StreamResult,
} from '../../seams/cloudBrain.js';
import { LlmError } from '../../core/types.js';

export interface HttpBrainConfig {
  cloudUrl: string; // 形如 https://host(无尾斜杠)
  /**
   * forsion_token。standalone 传固定字符串(单用户);分离式 worker 传函数 —— 每次按当前 run 的
   * 用户(runContext)铸一枚 per-user JWT,实现一个进程多用户(见 worker/main.ts)。
   */
  token: string | (() => string);
}

export function createHttpBrain(cfg: HttpBrainConfig): CloudBrainServices {
  const base = cfg.cloudUrl.replace(/\/+$/, '');
  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${typeof cfg.token === 'function' ? cfg.token() : cfg.token}`,
    'Content-Type': 'application/json',
  });

  async function postJson<T>(path: string, body: any, signal?: AbortSignal): Promise<T> {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(r.status, detail || `brain ${path} ${r.status}`);
    }
    return (await r.json()) as T;
  }

  async function getJson<T>(path: string): Promise<T> {
    const r = await fetch(`${base}${path}`, { headers: authHeaders() });
    if (r.status === 404) return null as unknown as T;
    if (!r.ok) throw new Error(`brain ${path} ${r.status}`);
    return (await r.json()) as T;
  }

  // ── LLM 流式:读 SSE,逐条转回 onToken/onReasoning/onToolCallDelta,done 时返回累积结果 ──
  async function streamProviderCompletion(opts: StreamOpts): Promise<StreamResult> {
    const modelId = String((opts.payload as any)?.__forsion_model_id ?? '');
    const r = await fetch(`${base}/api/brain/llm/stream`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ modelId, payload: opts.payload }),
      signal: opts.signal,
    });
    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(r.status || 502, detail || `brain stream ${r.status}`);
    }

    const result: StreamResult = {
      content: '',
      reasoning: '',
      toolCalls: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.t === 'token') { result.content += ev.d; opts.onToken?.(ev.d); }
        else if (ev.t === 'reasoning') { result.reasoning += ev.d; opts.onReasoning?.(ev.d); }
        else if (ev.t === 'tool') {
          opts.onToolCallDelta?.({ id: ev.id, name: ev.name, argsLen: ev.argsLen, args: ev.args, argsDelta: ev.argsDelta });
        } else if (ev.t === 'done') {
          result.content = ev.content ?? result.content;
          result.reasoning = ev.reasoning ?? result.reasoning;
          result.toolCalls = ev.toolCalls ?? [];
          result.usage = ev.usage ?? result.usage;
          result.finishReason = ev.finishReason;
        } else if (ev.t === 'error') {
          throw new LlmError(ev.status || 502, ev.message || 'brain stream error');
        }
      }
    }
    return result;
  }

  return {
    llm: {
      resolveModelAndKey: async (modelId: string) => {
        const r = await postJson<{ model: any; apiModelId: string }>('/api/brain/llm/resolve', { modelId });
        // apiKey/baseUrl 是占位(stream 一律走云端代理,不真用它们);model 透传给 build。
        return { model: r.model, apiKey: '__cloud_proxy__', baseUrl: base, apiModelId: r.apiModelId };
      },
      buildProviderPayload: async (opts: BuildPayloadOpts) => {
        const r = await postJson<{ payload: any }>('/api/brain/llm/build-payload', {
          modelId: (opts.model as any)?.id,
          ...opts,
        });
        return r.payload;
      },
      streamProviderCompletion,
    },
    users: {
      getUserById: async (_id: string) => getJson<any>('/api/brain/users/me'),
    },
    memory: {
      getMemory: async (_userId: string) => getJson<{ content: string; updatedAt: any }>('/api/brain/memory'),
      appendMemoryEntry: async (_userId: string, text: string, opts) =>
        postJson('/api/brain/memory', { text, dedup: opts?.dedup, cap: opts?.cap }),
      appendLogEntry: async (_userId: string, text: string) =>
        postJson('/api/brain/log', { text }),
      getLog: async (_userId: string, date?: string) =>
        getJson(`/api/brain/log${date ? `?date=${encodeURIComponent(date)}` : ''}`),
    },
    assets: {
      getSkill: async (id: string) => getJson<any>(`/api/brain/skills/${encodeURIComponent(id)}`),
      listCustomTools: async (filter) =>
        getJson<any[]>(`/api/brain/custom-tools?appId=${encodeURIComponent(filter?.appId || '')}&visibleOnly=${filter?.visibleOnly ? 'true' : 'false'}`),
      listForcedCustomTools: async (appId?: string) =>
        getJson<any[]>(`/api/brain/custom-tools/forced?appId=${encodeURIComponent(appId || '')}`),
    },
    search: {
      runSearch: async (query: string, maxResults: number) =>
        postJson('/api/brain/search', { query, maxResults }),
    },
    models: {
      // 列出云端 admin 配的可用模型(供 TUI 的 /model 浏览);失败降级空列表(不阻断)。
      listGlobalModels: async () => {
        try {
          return await getJson<any[]>('/api/brain/models');
        } catch {
          return [];
        }
      },
    },
    storage: {
      // standalone 用本地沙箱工作区(getSessionDir 命中本地分支);云端 Penzor snapshot 不可用 → 抛(flush 已 try/catch,非致命)。
      listDirectory: async () => { throw new Error('cloud storage unavailable in standalone'); },
      createDirectory: async () => { throw new Error('cloud storage unavailable in standalone'); },
      getFileContent: async () => { throw new Error('cloud storage unavailable in standalone'); },
      updateFileContent: async () => { throw new Error('cloud storage unavailable in standalone'); },
      uploadFile: async () => { throw new Error('cloud storage unavailable in standalone'); },
      deleteItem: async () => { throw new Error('cloud storage unavailable in standalone'); },
    },
  };
}
