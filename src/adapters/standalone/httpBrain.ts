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
import { streamIdleGuard, mapStreamAbort } from '../../llm/streamIdle.js';

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

  // 所有 brain 请求加超时:thin worker 的 fetch 此前无超时,上游(模型/网关/网络)一挂死,整条 run
  // 无限 await;且 worker 按 session 串行 → 该 session 后续 run 全被堵死。默认 60s,env 可调。
  const REQ_TIMEOUT_MS = Number(process.env.TANGU_BRAIN_HTTP_TIMEOUT_MS) || 60_000;
  const reqSignal = (s?: AbortSignal): AbortSignal => s ?? AbortSignal.timeout(REQ_TIMEOUT_MS);
  const toB64 = (c: Buffer | string): string =>
    (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf-8')).toString('base64');

  async function postJson<T>(path: string, body: any, signal?: AbortSignal): Promise<T> {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: reqSignal(signal),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(r.status, detail || `brain ${path} ${r.status}`);
    }
    return (await r.json()) as T;
  }

  async function getJson<T>(path: string): Promise<T> {
    const r = await fetch(`${base}${path}`, { headers: authHeaders(), signal: reqSignal() });
    if (r.status === 404) return null as unknown as T;
    if (!r.ok) throw new Error(`brain ${path} ${r.status}`);
    return (await r.json()) as T;
  }

  async function deleteJson<T>(path: string): Promise<T> {
    const r = await fetch(`${base}${path}`, { method: 'DELETE', headers: authHeaders(), signal: reqSignal() });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(r.status, detail || `brain ${path} ${r.status}`);
    }
    return (await r.json()) as T;
  }

  async function putJson<T>(path: string, body: any): Promise<T> {
    const r = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: reqSignal(),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(r.status, detail || `brain ${path} ${r.status}`);
    }
    return (await r.json()) as T;
  }

  // ── LLM 流式:读 SSE,逐条转回 onToken/onReasoning/onToolCallDelta,done 时返回累积结果 ──
  async function streamProviderCompletion(opts: StreamOpts): Promise<StreamResult> {
    const modelId = String((opts.payload as any)?.__forsion_model_id ?? '');
    // 流式空闲看门狗(复用 streamIdleGuard):上游若 idle 窗口内无新帧(模型/网关挂死、连接半开)则主动
    // abort,使 reader.read() 抛出而非无限 await(否则 run 卡死,且 worker 按 session 串行 → 整个 session
    // 后续 run 全堵)。同时合并外部 run abort。详见 ../../llm/streamIdle.ts。
    const guard = streamIdleGuard(opts.signal);
    try {
      const r = await fetch(`${base}/api/brain/llm/stream`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ modelId, payload: opts.payload }),
        signal: guard.signal,
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
      guard.arm();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        guard.arm(); // 收到帧即重置空闲计时
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
    } catch (err) {
      throw mapStreamAbort(err, guard.signal, opts.signal);
    } finally {
      guard.dispose();
    }
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
      setMemory: async (_userId: string, content: string) =>
        putJson<{ content: string; updatedAt: any }>('/api/brain/memory', { content }),
      appendLogEntry: async (_userId: string, text: string, opts) =>
        postJson('/api/brain/log', { text, date: opts?.date, time: opts?.time }),
      getLog: async (_userId: string, date?: string) =>
        getJson(`/api/brain/log${date ? `?date=${encodeURIComponent(date)}` : ''}`),
    },
    assets: {
      getSkill: async (id: string) => getJson<any>(`/api/brain/skills/${encodeURIComponent(id)}`),
      listCustomTools: async (filter) =>
        getJson<any[]>(`/api/brain/custom-tools?appId=${encodeURIComponent(filter?.appId || '')}&visibleOnly=${filter?.visibleOnly ? 'true' : 'false'}`),
      listForcedCustomTools: async (appId?: string) =>
        getJson<any[]>(`/api/brain/custom-tools/forced?appId=${encodeURIComponent(appId || '')}`),
      // 技能目录(桌面技能面板)。旧版云端无此端点 → getJson 对 404 返 null / 其余错误降级空列表。
      // forUser 由 token 隐含(brain-api 按请求者过滤),filter.forUser 在 http 面忽略。
      listSkills: async (filter) => {
        try {
          const r = await getJson<any[]>(`/api/brain/skills?visibleOnly=${filter?.visibleOnly ? 'true' : 'false'}`);
          return Array.isArray(r) ? r : [];
        } catch {
          return [];
        }
      },
      // 本地技能上云(POST /brain/skills;owner=token 用户)。旧版云端无端点 → 明确报错。
      upsertUserSkill: async (_userId, skill) => {
        try {
          return await postJson<{ id: string }>('/api/brain/skills', skill);
        } catch (e: any) {
          if (e?.status === 404) throw new Error('云端版本过旧,不支持用户技能上传(需更新 Forsion server)');
          throw e;
        }
      },
      deleteUserSkill: async (_userId, id) => {
        try {
          await deleteJson(`/api/brain/skills/${encodeURIComponent(id)}`);
          return true;
        } catch {
          return false;
        }
      },
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
      // 按应用过滤(project_model_configs)。旧版云端忽略 ?projectId 返回数组 → 视作无过滤;
      // 网络错误降级空列表(同 listGlobalModels,空/错的区分交给调用方探针)。
      listModelsForProject: async (projectId: string) => {
        try {
          const r = await getJson<any>(`/api/brain/models?projectId=${encodeURIComponent(projectId)}`);
          if (Array.isArray(r)) return { models: r, defaultModelId: null };
          return {
            models: Array.isArray(r?.models) ? r.models : [],
            defaultModelId: r?.defaultModelId ?? null,
          };
        } catch {
          return { models: [], defaultModelId: null };
        }
      },
    },
    storage: {
      // 分离式 worker:经云端 /api/brain/storage/*(对端 routes.ts)把 agent 工作区文件回写 Penzor。
      // 否则 run 结束的 snapshot(snapshotDirToWorkspace → uploadFile)抛错被吞,文件全丢(这是
      // 「云端不再往 workspace 放文件」的根因)。userId 由 token 隐含(服务端取鉴权用户),入参 userId
      // 忽略;appId 由调用方(run 所属 app)给;二进制走 base64。standalone 单机走本地沙箱不会调到这。
      listDirectory: async (parentId, _userId, appId, filters) =>
        postJson<any[]>('/api/brain/storage/list', { parentId, appId, filters }),
      createDirectory: async (_userId, appId, parentId, name) =>
        postJson<any>('/api/brain/storage/mkdir', { parentId, appId, name }),
      getFileContent: async (fileId, _userId) => {
        const r = await postJson<{ contentBase64: string; mimeType: string }>('/api/brain/storage/get', { fileId });
        return { content: Buffer.from(r.contentBase64 || '', 'base64'), mimeType: r.mimeType };
      },
      updateFileContent: async (fileId, _userId, content) => {
        await postJson('/api/brain/storage/update', { fileId, contentBase64: toB64(content) });
      },
      uploadFile: async (_userId, appId, parentId, name, content, mimeType, autoRename) =>
        postJson<any>('/api/brain/storage/upload', { parentId, appId, name, contentBase64: toB64(content), mimeType, autoRename: !!autoRename }),
      deleteItem: async (...args: any[]) => postJson<any>('/api/brain/storage/delete', { fileId: args[0] }),
    },
  };
}
