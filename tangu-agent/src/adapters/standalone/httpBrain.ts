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
import { imageMimeOf } from '../../seams/cloudBrain.js';
import {
  AMADEUS_MAX_FILE_BYTES,
  AgentFileConflictError,
  AmadeusConflictError,
  AmadeusNotFoundError,
  AmadeusTooLargeError,
} from '../../seams/cloudBrain.js';
import { LlmError } from '../../core/types.js';
import { streamIdleGuard, mapStreamAbort } from '../../llm/streamIdle.js';
import { friendlyUpstreamError } from './upstreamError.js';
import { parseAgentConfig } from '../../agents/agentRegistry.js';
import { currentAgentSlug } from '../../seams/runContext.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { registerAgentSyncIdentity } from '../../services/cloudSyncAccount.js';

export interface HttpBrainConfig {
  cloudUrl: string; // 形如 https://host(无尾斜杠)
  /**
   * forsion_token。standalone 传固定字符串(单用户);分离式 worker 传函数 —— 每次按当前 run 的
   * 用户(runContext)铸一枚 per-user JWT,实现一个进程多用户(见 worker/main.ts)。
   */
  token: string | (() => string);
}

/**
 * F2/C-2:托管链路的 usage 极性还原。server 为计费把 cached_tokens 恒归一成数字(没命中记 0),
 * 于是「上游根本没报缓存」在线上被压成了 0,与「上游报了 0 次命中」再也分不开;直连三家解析器
 * (openaiCompat / openaiResponses / anthropicMessages)在没报时留 undefined。不在这里还原极性,
 * agentLoop 的 `cached_tokens !== undefined` 在托管链路恒为真,两条链路的数据就进不了同一张表
 * (scripts/cache-hit-report.mjs 按 cacheReported === false 分桶)。
 *   cacheReported === true → 照抄;=== false → undefined;
 *   字段缺席(2.10.x 老服务端还没有这个标志)→ 只有 > 0 能反证上游确实报过,0 一律记「不知道」。
 * ponytail: reasoning_tokens 没有对应的 reported 标志(server 恒初始化 0,只在上游报了才覆盖),
 *   同样只能按 > 0 反证。上限:上游「报了 0 个推理 token」会被当成没报 —— 这对 A3 的结论等价
 *   (输出没花在推理上),真要分开得等 server 侧补一枚 reasoningReported。
 */
function normalizeHostedUsage(u: any): StreamResult['usage'] {
  const { cacheReported, cached_tokens: cached, reasoning_tokens: reasoning, ...rest } = u;
  const cacheKnown = cacheReported === true || (cacheReported === undefined && cached > 0);
  return {
    ...rest,
    ...(cacheKnown ? { cached_tokens: cached } : {}),
    ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
  };
}

/**
 * F1 合并端点的**负**能力缓存,按归一化 base URL 记「这个服务端没有 /build-and-stream」。
 * 必须模块级而非实例级:同进程重新装配 createHttpBrain(worker 换 token、断线重连、多 brain 并存)
 * 会让每个新实例再白传一次整份上下文去探测 —— 正是 F1 要省掉的那一腿(评审 #7)。
 * ponytail:只记否定、按 base URL 分桶、进程生命周期无 TTL。**比原实例内语义更长寿**:旧写法在
 * 重新装配 brain 时会重探,服务端中途升级能在重连后自动认出合并端点;现在要重启引擎才重新探测。
 * 这是 F1 省掉那一腿的代价,真要两头兼顾得加 TTL 或让服务端在 /health 里报能力位。
 */
const combinedUnsupported = new Set<string>();

export function createHttpBrain(cfg: HttpBrainConfig): CloudBrainServices {
  const base = cfg.cloudUrl.trim().replace(/\/+$/, '');
  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${typeof cfg.token === 'function' ? cfg.token() : cfg.token}`,
    'Content-Type': 'application/json',
  });

  // 所有 brain 请求加超时:thin worker 的 fetch 此前无超时,上游(模型/网关/网络)一挂死,整条 run
  // 无限 await;且 worker 按 session 串行 → 该 session 后续 run 全被堵死。默认 60s,env 可调。
  const REQ_TIMEOUT_MS = Number(process.env.TANGU_BRAIN_HTTP_TIMEOUT_MS) || 60_000;
  const IMG_TIMEOUT_MS = Number(process.env.TANGU_IMAGE_HTTP_TIMEOUT_MS) || 180_000; // 生图比 LLM 慢,单独放宽
  // 托管流的传输与语义兜底窗口。服务端 upstreamIdleGuard 默认 300s,
  // 这里多留 60s 余量让服务端先响,否则用户看到的是本地 504 而非上游真实错因。
  const BRAIN_STREAM_IDLE_MS = Number(process.env.TANGU_BRAIN_STREAM_IDLE_MS) || 360_000;
  // 超时随 body 放大:固定 60s 对 200 字节的 /llm/resolve 和带整页截图(view_image 的图按 base64
  // 进 messages,1.7MB PNG ≈ 2.3MB 文本)的 /llm/build-payload 是同一把尺子,后者在慢上行上必然
  // 先撞墙 —— 2026-08-27 桌面端 2.8.1 实证:两个 run 都恰好死在 view_image 之后那一 leg。
  // 基准 60s + 每 MB 追加 30s(≈270kbps 的保底上行假设),两个数都可经 env 调。
  const TIMEOUT_PER_MB_MS = Number(process.env.TANGU_BRAIN_HTTP_TIMEOUT_PER_MB_MS) || 30_000;
  const sizedTimeoutMs = (bytes: number): number =>
    REQ_TIMEOUT_MS + Math.floor((bytes / (1024 * 1024)) * TIMEOUT_PER_MB_MS);
  // ⚠️ 必须 any 合并而非 `s ?? timeout`:调用方一旦传了 run 的 abort signal,`??` 会把超时整个抹掉,
  // 请求变成无限等(上游半开连接时 run 永久挂死)。两个来源都要能中止。
  // floorMs = 端点自己的超时下限(生图 180s 等),与「用户取消信号」正交:早期把两者挤在同一个参数里
  // (`req.signal ?? AbortSignal.timeout(IMG)`),合并超时后通用 60s 会先杀掉慢生图 —— Codex 评审逮到。
  const reqSignal = (s?: AbortSignal, bytes = 0, floorMs = 0): AbortSignal => {
    const t = AbortSignal.timeout(Math.max(sizedTimeoutMs(bytes), floorMs));
    return s ? AbortSignal.any([s, t]) : t;
  };
  /**
   * 把 undici 的裸传输错换成能定位的 LlmError。原文("The operation was aborted due to timeout" /
   * "fetch failed")既不说是哪个端点、也不说是本机不通还是云端慢,用户只看到「请求超时」四个字,
   * 连"该查自己的网还是等厂商恢复"都判断不了。用户主动 abort 原样透传(agentLoop 据此标 aborted)。
   */
  const netError = (e: any, path: string, bytes: number, floorMs = 0): unknown => {
    if (e?.name === 'AbortError') return e;
    const body = bytes > 512 * 1024 ? `,body ${(bytes / 1024 / 1024).toFixed(1)}MB` : '';
    if (e?.name === 'TimeoutError') {
      const secs = Math.round(Math.max(sizedTimeoutMs(bytes), floorMs) / 1000);
      return new LlmError(504, `云端 ${path} 超时(${secs}s${body}):本机到 ${base} 的上行过慢或不通`);
    }
    if (e instanceof LlmError) return e;
    return new LlmError(0, `云端 ${path} 连接失败(${e?.message || e}${body}):检查本机网络与 ${base} 的连通性`);
  };
  const toB64 = (c: Buffer | string): string =>
    (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf-8')).toString('base64');
  // 运行中 agent 的记忆作用域 slug(非默认才带;无 run 上下文 → ''=全局)。
  const scopedSlug = (): string => { const s = currentAgentSlug(); return s && s !== DEFAULT_AGENT_SLUG ? s : ''; };

  async function postJson<T>(path: string, body: any, signal?: AbortSignal, floorMs = 0): Promise<T> {
    const raw = JSON.stringify(body);
    const bytes = Buffer.byteLength(raw, 'utf-8'); // 不是 raw.length:JSON 不转义非 ASCII,中文按 UTF-16 数会低估 3 倍
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: raw,
      signal: reqSignal(signal, bytes, floorMs),
    }).catch((e) => { throw netError(e, path, bytes, floorMs); });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(r.status, detail || `brain ${path} ${r.status}`);
    }
    return (await r.json()) as T;
  }

  async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const r = await fetch(`${base}${path}`, { headers: authHeaders(), signal: reqSignal(signal) })
      .catch((e) => { throw netError(e, path, 0); });
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

  async function putJson<T>(path: string, body: any, signal?: AbortSignal): Promise<T> {
    const raw = JSON.stringify(body);
    const bytes = Buffer.byteLength(raw, 'utf-8');
    const r = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: raw,
      signal: reqSignal(signal, bytes),
    }).catch((e) => { throw netError(e, path, bytes); });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(r.status, detail || `brain ${path} ${r.status}`);
    }
    return (await r.json()) as T;
  }

  // ── F1 三次传输合一 ────────────────────────────────────────────────────────
  // 旧链路每轮迭代要传三次整份上下文:build-payload 上传 → 下载装配好的 payload → stream 再上传。
  // 现在 buildProviderPayload 只返回**惰性描述符**(零网络),stream 时一次 POST 到合并端点
  // /api/brain/llm/build-and-stream(服务端装配后直接流)。收益是首帧,不是 token。
  // 老服务端(2.10.x 在装机上仍在跑)没有该路由 → 404,本进程之后一律回落旧两步;两个老端点原样保留。
  const LAZY_MARK = '__forsion_lazy_build';
  type LazyBuild = { [LAZY_MARK]: true; modelId: string } & Record<string, unknown>;
  const UNSUPPORTED = Symbol('brain.combined.unsupported');

  /** 合并端点的探测判据必须**两面**:404(路由不存在)固然是,2xx 而非 SSE(反代/兜底页把未知路径
   *  吞成 HTML 200)也是 —— 否则 SSE 解析器一帧不见,静默返回空正文。真端点必走 stream 处理器,
   *  头里恒是 text/event-stream,所以这道闸不会误判真实响应。 */
  const notCombined = (r: Response): boolean =>
    r.status === 404 || (r.ok && !(r.headers.get('content-type') || '').includes('text/event-stream'));

  // ── LLM 流式:读 SSE,逐条转回 onToken/onReasoning/onToolCallDelta,done 时返回累积结果 ──
  async function streamProviderCompletion(opts: StreamOpts): Promise<StreamResult> {
    const lazy = (opts.payload as any)?.[LAZY_MARK] ? (opts.payload as LazyBuild) : null;
    if (lazy && !combinedUnsupported.has(base)) {
      const { [LAZY_MARK]: _mark, ...body } = lazy;
      const r = await brainStream('/api/brain/llm/build-and-stream', body, opts, true);
      if (r !== UNSUPPORTED) return r;
      combinedUnsupported.add(base);
    }
    // 回落:老两步。描述符在这里才真正物化(build-payload 的请求体与老链路逐字段相同)。
    let payload = opts.payload;
    if (lazy) {
      const { [LAZY_MARK]: _mark, ...body } = lazy;
      payload = (await postJson<{ payload: any }>('/api/brain/llm/build-payload', body, opts.signal)).payload;
    }
    const modelId = String((payload as any)?.__forsion_model_id ?? lazy?.modelId ?? '');
    return await brainStream('/api/brain/llm/stream', { modelId, payload }, opts, false) as StreamResult;
  }

  async function brainStream(
    path: string, body: unknown, opts: StreamOpts, detect: boolean,
  ): Promise<StreamResult | typeof UNSUPPORTED> {
    // 传输与语义各自计时:server 的 : ping / alive 只续传输;有效正文、思考或工具增量才续语义。
    // 这样持续心跳仍无法掩盖上游无进展,同时保留托管流原有 300s 预算。
    const guard = streamIdleGuard(opts.signal, BRAIN_STREAM_IDLE_MS);
    // 上传腿(首帧前)沿用 postJson 那把随体积放大的尺子。F1 之后整份上下文的真实上传发生在这里、
    // 不再是 build-payload,那道闸必须跟着搬过来 —— 否则带图的慢上行要一路吊到 360s 的流看门狗
    // 才收场(2026-08-27 实证:两个 run 都死在 view_image 之后那一 leg)。响应头一到即作废,
    // 绝不能让它在长流中途开火。
    const raw = JSON.stringify(body);
    const bytes = Buffer.byteLength(raw, 'utf-8');
    const upload = new AbortController();
    const uploadTimer = setTimeout(
      () => upload.abort(Object.assign(new Error('upload timeout'), { name: 'TimeoutError' })),
      sizedTimeoutMs(bytes),
    );
    try {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: authHeaders(),
        body: raw,
        signal: AbortSignal.any([guard.signal, upload.signal]),
      }).catch((e) => { throw netError(e, path, bytes); });
      clearTimeout(uploadTimer);
      // 探测失败不能算「已受理」:onResponseStart 会把 uploadMs 定格在这次白跑的上传上。
      if (detect && notCombined(r)) { await r.text().catch(() => ''); return UNSUPPORTED; }
      opts.onResponseStart?.(); // 服务端设完 SSE 头即 flush:头到达 = 整份上下文已送达服务端
      if (!r.ok || !r.body) {
        const detail = await r.text().catch(() => '');
        throw new LlmError(r.status || 502, friendlyUpstreamError(r.status, detail));
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
      const toolProgress = new Map<string, { name: string; argsLen: number }>();
      guard.arm();
      while (true) {
        const { done, value } = await guard.read(reader);
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
          if (ev.t === 'token' && typeof ev.d === 'string' && ev.d) {
            guard.progress();
            result.content += ev.d;
            opts.onToken?.(ev.d);
          } else if (ev.t === 'reasoning' && typeof ev.d === 'string' && ev.d) {
            guard.progress();
            result.reasoning += ev.d;
            opts.onReasoning?.(ev.d);
          } else if (ev.t === 'tool') {
            const id = typeof ev.id === 'string' ? ev.id : '';
            const name = typeof ev.name === 'string' ? ev.name : '';
            const previous = toolProgress.get(id);
            const argsLen = typeof ev.args === 'string' ? ev.args.length
              : Number.isFinite(ev.argsLen) ? Math.max(0, ev.argsLen) : 0;
            if ((typeof ev.argsDelta === 'string' && ev.argsDelta)
              || argsLen > (previous?.argsLen ?? 0) || (id && name && !previous?.name)) guard.progress();
            toolProgress.set(id, { name: name || previous?.name || '', argsLen: Math.max(argsLen, previous?.argsLen ?? 0) });
            opts.onToolCallDelta?.({ id: ev.id, name: ev.name, argsLen: ev.argsLen, args: ev.args, argsDelta: ev.argsDelta });
          } else if (ev.t === 'done') {
            result.content = ev.content ?? result.content;
            result.reasoning = ev.reasoning ?? result.reasoning;
            result.toolCalls = ev.toolCalls ?? [];
            result.usage = ev.usage ? normalizeHostedUsage(ev.usage) : result.usage;
            result.finishReason = ev.finishReason;
            // 回放原料:直连 provider 自己填 outputItems,托管面只能靠 done 帧转运。漏抄这一行
            // 不会红 —— 只是 historyReplay 写侧在整条托管链路上恒空,跨 run 思考延续性永远为零。
            // 老服务端不发这个字段(与「空组」同义):保持 undefined,绝不造一个空数组。
            if (Array.isArray(ev.outputItems) && ev.outputItems.length) result.outputItems = ev.outputItems;
          } else if (ev.t === 'error') {
            throw new LlmError(ev.status || 502, ev.message || 'brain stream error');
          }
        }
      }
      return result;
    } catch (err) {
      throw mapStreamAbort(err, guard.signal, opts.signal);
    } finally {
      clearTimeout(uploadTimer);
      guard.dispose();
    }
  }

  const brain: CloudBrainServices = {
    llm: {
      resolveModelAndKey: async (modelId: string) => {
        const r = await postJson<{ model: any; apiModelId: string }>('/api/brain/llm/resolve', { modelId });
        // apiKey/baseUrl 是占位(stream 一律走云端代理,不真用它们);model 透传给 build。
        return { model: r.model, apiKey: '__cloud_proxy__', baseUrl: base, apiModelId: r.apiModelId };
      },
      // F1:只造惰性描述符,不发网络请求 —— 真正的上传在 streamProviderCompletion 里发生一次。
      // ⚠️ `...rest` 整体展开是契约(见 httpBrain.client.test.ts):改成逐字段挑选,client/cacheKey 等
      // 会静默消失且没有任何东西变红。signal 摘掉:AbortSignal 进 JSON.stringify 会变成 {} 白送上云。
      buildProviderPayload: async (opts: BuildPayloadOpts) => {
        const { signal: _signal, ...rest } = opts as BuildPayloadOpts & { signal?: AbortSignal };
        return { [LAZY_MARK]: true, modelId: String((opts.model as any)?.id ?? ''), ...rest };
      },
      streamProviderCompletion,
    },
    users: {
      getUserById: async (_id: string) => getJson<any>('/api/brain/users/me'),
    },
    // 记忆/日志按运行中 agent slug 作用域(B):非默认 agent 带 slug → server 路由到 per-agent 行;
    // 默认 xyra / 无 run 上下文 → 不带 slug → 旧全局(AI Studio 网页行为不变)。
    memory: {
      getMemory: async (_userId: string, opts) => {
        const s = scopedSlug();
        return getJson<{ content: string; updatedAt: any }>(`/api/brain/memory${s ? `?slug=${encodeURIComponent(s)}` : ''}`, opts?.signal);
      },
      appendMemoryEntry: async (_userId: string, text: string, opts) =>
        postJson('/api/brain/memory', { text, dedup: opts?.dedup, cap: opts?.cap, slug: scopedSlug() || undefined }, opts?.signal),
      setMemory: async (_userId: string, content: string, opts) =>
        putJson<{ content: string; updatedAt: any }>('/api/brain/memory', { content, slug: scopedSlug() || undefined }, opts?.signal),
      appendLogEntry: async (_userId: string, text: string, opts) =>
        postJson('/api/brain/log', { text, date: opts?.date, time: opts?.time, slug: scopedSlug() || undefined }, opts?.signal),
      getLog: async (_userId: string, date: string | undefined, opts) => {
        const q = new URLSearchParams();
        if (date) q.set('date', date);
        const s = scopedSlug();
        if (s) q.set('slug', s);
        const qs = q.toString();
        return getJson(`/api/brain/log${qs ? `?${qs}` : ''}`, opts?.signal);
      },
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
          if (Array.isArray(r)) return { models: r, defaultModelId: null, backgroundModelId: null, imageModelId: null, visionModelId: null, reachable: true };
          return {
            models: Array.isArray(r?.models) ? r.models : [],
            defaultModelId: r?.defaultModelId ?? null,
            backgroundModelId: r?.backgroundModelId ?? null,
            imageModelId: r?.imageModelId ?? null,
            visionModelId: r?.visionModelId ?? null,
            reachable: true,
          };
        } catch {
          // 降级成空列表是为了不让 TUI 抛;reachable:false 让调用方知道「空 ≠ 没配」(401/断网也长这样)。
          return { models: [], defaultModelId: null, backgroundModelId: null, imageModelId: null, visionModelId: null, reachable: false };
        }
      },
    },
    images: {
      edit: async (req) => {
        const r = await postJson<{ data?: Array<{ b64_json?: string }> }>(
          '/v1/images/edits',
          { model: req.model, prompt: req.prompt, image: req.images.map(i => `data:${i.mime};base64,${i.b64}`),
            size: req.size || '1:1', n: req.n || 1, transparent_background: !!req.transparentBackground, output_format: 'png',
            ...(req.quality ? { quality: req.quality } : {}) },
          req.signal, IMG_TIMEOUT_MS,
        );
        const images = (r.data || []).filter(d => d.b64_json).map(d => ({ b64: d.b64_json!, mime: imageMimeOf(d.b64_json!) }));
        if (!images.length) throw new Error('Image edit returned no images');
        return { images };
      },
      // 托管生图:复用云端现成 /v1/images/generations(optionalAuth 接受 bearer;配额/计费在云端)。
      // 尺寸传规范值('1:1' 等),云端自行换算成像素;返回 b64_json。
      generate: async (req) => {
        const r = await postJson<{ data?: Array<{ b64_json?: string }> }>(
          '/v1/images/generations',
          { model: req.model, prompt: req.prompt, size: req.size || '1:1', n: req.n || 1, transparent_background: !!req.transparentBackground, output_format: 'png',
            ...(req.quality ? { quality: req.quality } : {}) },
          req.signal,
          IMG_TIMEOUT_MS, // 生图比 LLM 慢:窗口下限单独放宽,不受通用 60s 基准截断
        );
        const images = (r.data || []).filter((d) => d.b64_json).map((d) => ({ b64: d.b64_json as string, mime: imageMimeOf(d.b64_json as string) }));
        if (!images.length) throw new Error('云端未返回图片');
        return { images };
      },
    },
    // 收件箱广播拉取:旧云端无此路由 → getJson 404 回 null → [](inboxPull 静默降级)。
    // created_at 是服务端 to_char 微秒原文,原样返回给调用方做游标,不做任何时区换算。
    inbox: {
      listBroadcasts: async (since?: string) => {
        const r = await getJson<{ broadcasts: Array<{
          id: string; title: string; body: string | null; created_at: string;
          attachments?: string | null; expires_at?: string | null; claimed?: boolean; claim_requirements?: string | null;
        }> }>(
          `/api/brain/inbox/broadcasts${since ? `?since=${encodeURIComponent(since)}` : ''}`,
        );
        return r?.broadcasts ?? [];
      },
      // 领取附件:postJson 失败抛 LlmError(status, detail),claim 路由按 status 透传(410=过期等)。
      claimBroadcast: (broadcastId: string, client?: string) =>
        postJson<{ claimed: boolean; alreadyClaimed?: boolean }>(
          `/api/brain/inbox/broadcasts/${encodeURIComponent(broadcastId)}/claim`, client ? { client } : {},
        ),
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
    // Tangu 每-agent 云文件镜像(Phase 2):跨设备同步 + 云端运行水合。userId 由 token 隐含(忽略入参)。
    // put/delete 自带 fetch:CAS 409 需要结构化 body(postJson 只留 detail)→ 抛 AgentFileConflictError。
    agentFiles: {
      getManifest: async (_userId: string, opts?: { signal?: AbortSignal }) => {
        const r = await getJson<{ agents: any[] }>('/api/brain/agents/manifest', opts?.signal);
        return r?.agents ?? [];
      },
      getFile: async (_userId: string, slug: string, relPath: string, opts?: { signal?: AbortSignal }) => {
        const r = await postJson<any>('/api/brain/agents/file/get', { slug, relPath }, opts?.signal);
        return !r || r.notFound ? null : r;
      },
      putFile: async (_userId: string, slug: string, relPath: string, body: any, opts?: { signal?: AbortSignal }) => {
        const r = await fetch(`${base}/api/brain/agents/file/put`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ slug, relPath, ...body }),
          signal: reqSignal(opts?.signal),
        });
        if (r.status === 409) {
          const j: any = await r.json().catch(() => ({}));
          throw new AgentFileConflictError({
            code: String(j?.code || 'CONFLICT'), seq: Number(j?.seq) || 0, hash: j?.hash ?? null,
            mtimeMs: Number(j?.mtimeMs) || 0, deleted: !!j?.deleted, content: j?.content,
          });
        }
        if (!r.ok) throw new Error(`brain agents/file/put ${r.status}: ${await r.text().catch(() => '')}`);
        return (await r.json()) as { mtimeMs: number; seq?: number; hash?: string | null };
      },
      deleteFile: async (_userId: string, slug: string, relPath: string, mtimeMs: number, deviceId?: string, baseSeq?: number, opts?: { signal?: AbortSignal }) => {
        const r = await fetch(`${base}/api/brain/agents/file/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ slug, relPath, mtimeMs, deviceId, ...(baseSeq !== undefined ? { baseSeq } : {}) }),
          signal: reqSignal(opts?.signal),
        });
        if (r.status === 409) {
          const j: any = await r.json().catch(() => ({}));
          throw new AgentFileConflictError({
            code: String(j?.code || 'CONFLICT'), seq: Number(j?.seq) || 0, hash: j?.hash ?? null,
            mtimeMs: Number(j?.mtimeMs) || 0, deleted: !!j?.deleted, content: j?.content,
          });
        }
        if (!r.ok) throw new Error(`brain agents/file/delete ${r.status}: ${await r.text().catch(() => '')}`);
      },
    },
    // ── Amadeus 云笔记库(v1):对端 /api/amadeus/vaults/default/*(契约冻结)。userId 由 token
    //    隐含(thin worker 的 per-dispatch token 经 cfg.token() 每请求现取)。错误映射:
    //    404→AmadeusNotFoundError;409→AmadeusConflictError(带最新 seq+content 供调用方重放);
    //    413/客户端预检→AmadeusTooLargeError;其余透传状态码。──
    amadeus: {
      list: async () => {
        const r = await fetch(`${base}/api/amadeus/vaults/default/tree`, {
          headers: { ...authHeaders(), 'X-Amadeus-Client': 'agent' },
          signal: reqSignal(),
        });
        if (r.status === 404) return []; // 旧云端无 Amadeus API → 空 vault 降级(工具报「无笔记」)
        if (!r.ok) throw new Error(`amadeus tree ${r.status}: ${await r.text().catch(() => '')}`);
        const j: any = await r.json();
        // pages=笔记(markdown 页面)路径;个别实现若省略扩展名则补 .md(页面即 .md 文件,file 端点按路径取)。
        const pages: Array<{ path: string; size: number }> = Array.isArray(j?.pages)
          ? j.pages.map((p: any) => ({ path: /\.md$/i.test(String(p)) ? String(p) : `${String(p)}.md`, size: 0 }))
          : [];
        const files: Array<{ path: string; size: number }> = Array.isArray(j?.files)
          ? j.files.map((f: any) => ({ path: String(f?.path ?? ''), size: Number(f?.size) || 0 })).filter((f: any) => f.path)
          : [];
        const seen = new Set(pages.map((p) => p.path));
        return [...pages, ...files.filter((f) => !seen.has(f.path))];
      },
      read: async (relPath: string) => {
        const r = await fetch(
          `${base}/api/amadeus/vaults/default/file?path=${encodeURIComponent(relPath)}`,
          { headers: { ...authHeaders(), 'X-Amadeus-Client': 'agent' }, signal: reqSignal() },
        );
        if (r.status === 404) throw new AmadeusNotFoundError(relPath);
        if (!r.ok) throw new Error(`amadeus read ${r.status}: ${await r.text().catch(() => '')}`);
        const j: any = await r.json();
        return { content: String(j?.content ?? ''), seq: Number(j?.seq) || 0 };
      },
      write: async (relPath: string, content: string, opts?: { baseSeq?: number; force?: boolean }) => {
        if (Buffer.byteLength(content, 'utf-8') > AMADEUS_MAX_FILE_BYTES) throw new AmadeusTooLargeError(relPath);
        const r = await fetch(`${base}/api/amadeus/vaults/default/file`, {
          method: 'PUT',
          headers: { ...authHeaders(), 'X-Amadeus-Client': 'agent' },
          // force=无条件覆盖时不带 baseSeq(避免陈旧票据反而触发 409);否则带乐观锁票据。
          body: JSON.stringify({ path: relPath, content, ...(opts?.force ? { force: true } : { baseSeq: opts?.baseSeq }) }),
          signal: reqSignal(),
        });
        if (r.status === 409) {
          const j: any = await r.json().catch(() => ({}));
          throw new AmadeusConflictError(Number(j?.seq) || 0, String(j?.content ?? ''));
        }
        if (r.status === 413) throw new AmadeusTooLargeError(relPath);
        if (r.status === 404) throw new AmadeusNotFoundError(relPath);
        if (!r.ok) throw new Error(`amadeus write ${r.status}: ${await r.text().catch(() => '')}`);
        const j: any = await r.json().catch(() => ({}));
        return { seq: Number(j?.seq) || 0 };
      },
    },
    // 云端运行水合(B):worker 本地 FS 无 agents → 从云读 config.toml+SOUL.md 组装人格。软失败 → null。
    agents: {
      getAgent: async (_userId: string, slug: string) => {
        const cfg = await postJson<any>('/api/brain/agents/file/get', { slug, relPath: 'config.toml' }).catch(() => null);
        if (!cfg || cfg.notFound || cfg.deleted || !cfg.content) return null;
        const soul = await postJson<any>('/api/brain/agents/file/get', { slug, relPath: 'SOUL.md' }).catch(() => null);
        return parseAgentConfig(slug, cfg.content, soul && !soul.notFound && !soul.deleted ? (soul.content || '') : '');
      },
    },
  };
  // Optional capabilities describe configured services. Local Inbox storage uses
  // the host database independently; advertising this cloud-only seam starts the
  // broadcast poller even on an offline Unit with no Server or cloud credential.
  if (!base || (typeof cfg.token === 'string' && !cfg.token.trim())) delete brain.inbox;
  if (brain.agentFiles) registerAgentSyncIdentity(brain.agentFiles, base, cfg.token);
  return brain;
}
