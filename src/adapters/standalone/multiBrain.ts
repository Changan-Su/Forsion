/**
 * standalone 多 provider brain —— 接缝② `brain.llm` 的 dispatcher。
 *
 * 包住一个 httpBrain(Forsion 托管面),只覆写 `llm`:本地注册表命中 → 走 openaiCompat 直连用户自有
 * provider;未命中 → 委托 httpBrain(经 brain-api 用 Forsion 托管模型,计费在云端)。
 * memory / skills / search / users / models / storage 全透传 httpBrain。
 *
 * 「Forsion 只是其中一个 provider」即在此体现:Forsion 是兜底的托管面,直连 provider 与其平级。
 */
import type { CloudBrainServices, BuildPayloadOpts, StreamOpts, ImageGenRequest, ImageGenResult, SpeechRequest, SpeechResult } from '../../seams/cloudBrain.js';
import type { ProviderRegistry } from '../../llm/providerRegistry.js';
import { buildOpenAiCompatPayload, streamOpenAiCompat, DIRECT_MARK, PROTOCOL_MARK } from '../../llm/openaiCompat.js';
import { streamAnthropicOAuth } from '../../llm/anthropicMessages.js';
import { streamOpenAiResponses } from '../../llm/openaiResponses.js';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

// 规范尺寸 → OpenAI 兼容像素(direct provider 用;Forsion /v1/images 自带换算,故仅 direct 需要)。
const DIRECT_IMG_SIZE: Record<string, string> = {
  '1:1': '1024x1024', '3:2': '1792x1024', '16:9': '1792x1024', '2:3': '1024x1792', '9:16': '1024x1792',
};

/** 直连用户自有 OpenAI 兼容端点生图(BYO-key);返回 b64。 */
async function generateDirectImage(baseUrl: string, apiKey: string | undefined, apiModelId: string, req: ImageGenRequest): Promise<ImageGenResult> {
  const raw = req.size || '1:1';
  const size = DIRECT_IMG_SIZE[raw] || (/^\d+x\d+$/.test(raw) ? raw : '1024x1024');
  const r = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey || ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: apiModelId, prompt: req.prompt, n: req.n || 1, size, response_format: 'b64_json' }),
    signal: req.signal ?? AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`image gen ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await r.json();
  const images = (j?.data || []).filter((d: any) => d?.b64_json).map((d: any) => ({ b64: d.b64_json as string, mime: 'image/png' }));
  if (!images.length) throw new Error('provider 未返回图片');
  return { images };
}

function ttsSignal(req: SpeechRequest): AbortSignal {
  return req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
}

/** 直连用户自有 OpenAI 兼容端点合成语音(BYO-key);返回音频字节。format 缺省 mp3;微信语音走 wav。 */
async function synthesizeDirectTts(baseUrl: string, apiKey: string | undefined, apiModelId: string, req: SpeechRequest): Promise<SpeechResult> {
  const format = req.format || 'mp3';
  const mime = format === 'wav' ? 'audio/wav' : format === 'pcm' ? 'audio/L16' : 'audio/mpeg';
  const r = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey || ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: apiModelId, input: req.text, ...(req.voice ? { voice: req.voice } : {}), ...(req.speed ? { speed: req.speed } : {}), response_format: format }),
    signal: ttsSignal(req),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return { audio: new Uint8Array(await r.arrayBuffer()), mime };
}

/** 阿里云百炼(DashScope)官方域名无 OpenAI /audio/speech(实测 404),按域名自动切原生协议。 */
export function isDashScopeBase(baseUrl: string): boolean {
  return /dashscope|aliyuncs\.com/i.test(baseUrl);
}

/** compatible-mode baseUrl → 原生 API 根:同一个百炼 provider 既跑 LLM(compatible-mode)又跑 TTS(原生)。 */
export function dashScopeApiBase(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  if (/\/compatible-mode\/v1$/.test(b)) return b.replace(/\/compatible-mode\/v1$/, '/api/v1');
  if (/\/api\/v1$/.test(b)) return b;
  return `${b}/api/v1`; // 裸域名(https://dashscope.aliyuncs.com)
}

/**
 * 百炼原生 TTS:POST /services/aigc/multimodal-generation/generation(qwen3-tts-flash / -vc- / -vd- 全系),
 * 非流式响应给 24h 有效的音频 URL,服务端下载后回传字节。speed 参数百炼不支持,忽略。
 */
async function synthesizeDashScopeTts(baseUrl: string, apiKey: string | undefined, apiModelId: string, req: SpeechRequest): Promise<SpeechResult> {
  const r = await fetch(`${dashScopeApiBase(baseUrl)}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey || ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: apiModelId, input: { text: req.text, ...(req.voice ? { voice: req.voice } : {}) } }),
    signal: ttsSignal(req),
  });
  if (!r.ok) throw new Error(`dashscope tts ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await r.json();
  const url = j?.output?.audio?.url;
  if (!url) throw new Error(`dashscope tts 未返回音频:${JSON.stringify(j?.output || j).slice(0, 200)}`);
  const a = await fetch(url, { signal: ttsSignal(req) });
  if (!a.ok) throw new Error(`dashscope tts 音频下载失败 ${a.status}`);
  return { audio: new Uint8Array(await a.arrayBuffer()), mime: 'audio/wav' };
}

const COSY_SAMPLE_RATE = 24000; // ponytail: cosyvoice-v2/v3 均支持;须与自建 WAV 头一致,改这一处即可

/** 16-bit 单声道 PCM → WAV(自算长度,头部正确;微信只认头部合法的 WAV,故不吃百炼流式 wav 的占位头)。 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * 百炼 CosyVoice(cosyvoice-v1/v2/v3):仅 WebSocket 实时协议(HTTP 直接 InvalidParameter),与 qwen3-tts 的一发一收不同。
 * run-task → task-started → continue-task(整段文本)+ finish-task → 收 binary 音频帧 → task-finished。
 * 我们非流式消费:拼齐所有 binary 帧作整段返回;wav 场景取 pcm 后自封 WAV 头(保证微信可播)。
 */
function synthesizeCosyVoiceWs(baseUrl: string, apiKey: string | undefined, apiModelId: string, req: SpeechRequest): Promise<SpeechResult> {
  const wantWav = (req.format || 'mp3') === 'wav';
  const wsFormat = wantWav ? 'pcm' : (req.format || 'mp3');
  const taskId = randomUUID();
  const wsUrl = `wss://${new URL(baseUrl).host}/api-ws/v1/inference`; // dashscope(-intl).aliyuncs.com 经典实时端点
  return new Promise<SpeechResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let started = false, settled = false;
    let timer: NodeJS.Timeout | undefined;
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `bearer ${apiKey || ''}` } });
    const done = (err: Error | null, res?: SpeechResult) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      try { ws.close(); } catch { /* noop */ }
      err ? reject(err) : resolve(res!);
    };
    const onAbort = () => done(new Error('cosyvoice tts aborted'));
    req.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => done(new Error('cosyvoice tts 超时(60s)')), 60_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: apiModelId,
          parameters: { text_type: 'PlainText', voice: req.voice || 'longxiaochun_v2', format: wsFormat, sample_rate: COSY_SAMPLE_RATE, ...(req.speed ? { rate: req.speed } : {}) },
          input: {},
        },
      }));
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) { chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)); return; }
      let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
      const ev = msg?.header?.event;
      if (ev === 'task-started' && !started) {
        started = true;
        ws.send(JSON.stringify({ header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' }, payload: { input: { text: req.text } } }));
        ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
      } else if (ev === 'task-finished') {
        const audio = Buffer.concat(chunks);
        if (!audio.length) return done(new Error('cosyvoice tts 未返回音频'));
        done(null, wantWav
          ? { audio: pcmToWav(audio, COSY_SAMPLE_RATE), mime: 'audio/wav' }
          : { audio, mime: wsFormat === 'mp3' ? 'audio/mpeg' : wsFormat === 'wav' ? 'audio/wav' : 'audio/L16' });
      } else if (ev === 'task-failed') {
        done(new Error(`cosyvoice tts 失败:${msg?.header?.error_code || ''} ${msg?.header?.error_message || ''}`.trim()));
      }
    });
    ws.on('error', (e: Error) => done(e));
    ws.on('close', () => done(new Error('cosyvoice tts 连接提前关闭')));
  });
}

export function createMultiBrain(httpBrain: CloudBrainServices, registry: ProviderRegistry): CloudBrainServices {
  return {
    ...httpBrain,
    models: {
      ...httpBrain.models,
      // 直连 provider 目录(模型选择器/Providers 页用;剥掉 apiKey,baseUrl 仅供 UI 展示)。
      listDirectProviders: () =>
        registry.list().map((p) => ({ providerId: p.providerId, baseUrl: p.baseUrl, modelIds: p.modelIds, imageModelIds: p.imageModelIds, ttsModelIds: p.ttsModelIds })),
    },
    images: {
      // 生图分发:命中直连 provider 的图像模型(imageModelIds 或 <providerId>/<model>)→ 直连用户端点;
      // 否则委托 httpBrain(Forsion 托管 /v1/images)。
      generate: async (req: ImageGenRequest) => {
        for (const p of registry.list()) {
          const slash = req.model.startsWith(p.providerId + '/');
          const apiModelId = slash ? req.model.slice(p.providerId.length + 1) : ((p.imageModelIds || []).includes(req.model) ? req.model : null);
          if (apiModelId) return generateDirectImage(p.baseUrl, p.apiKey, apiModelId, req);
        }
        if (!httpBrain.images) throw new Error('当前未配置云端生图');
        return httpBrain.images.generate(req);
      },
    },
    tts: {
      // 语音合成分发:命中直连 provider 的 TTS 模型(ttsModelIds 或 <providerId>/<model>)→ 直连用户端点;
      // 无云端托管 TTS,未命中直接报错(不委托 httpBrain)。
      synthesize: async (req: SpeechRequest) => {
        for (const p of registry.list()) {
          const slash = req.model.startsWith(p.providerId + '/');
          const apiModelId = slash ? req.model.slice(p.providerId.length + 1) : ((p.ttsModelIds || []).includes(req.model) ? req.model : null);
          if (apiModelId) {
            const fn = !isDashScopeBase(p.baseUrl)
              ? synthesizeDirectTts
              : /^cosyvoice/i.test(apiModelId) ? synthesizeCosyVoiceWs : synthesizeDashScopeTts; // CosyVoice 独占 WS,余走 HTTP
            return fn(p.baseUrl, p.apiKey, apiModelId, req);
          }
        }
        throw new Error(`未找到 TTS 模型 ${req.model} 对应的直连 provider(需在 provider 的 ttsModelIds 声明或用 <providerId>/<model> 形式)`);
      },
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
