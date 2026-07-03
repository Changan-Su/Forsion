/**
 * 语音合成(朗读按钮/自动朗读;handler 自带 authMiddleware)。
 *   POST /agent/tts { text, model, voice?, speed? } → audio/mpeg 字节
 * 经 deps().brain.tts(可选 seam):仅 standalone multiBrain 实现(BYO-key 直连
 * OpenAI 兼容 /audio/speech,阿里云百炼域名自动切原生协议);云端未注入 → 501,前端据此隐藏入口。
 *
 * 音色管理(百炼声音复刻/声音设计;providers/test 同款「前端传 baseUrl+key、后端代打」模式,免 CORS 且不动 seam):
 *   POST /agent/tts/voices/list   { baseUrl, apiKey } → { voices: [{ voice, kind, targetModel? }] }   kind: clone(qwen复刻)|design(qwen设计)|cosy(CosyVoice复刻)
 *   POST /agent/tts/voices/clone  { baseUrl, apiKey, name, engine?, audioData?, audioUrl?, targetModel? } → { voice, targetModel }
 *       engine 缺省 qwen:audioData=base64/URL、qwen-voice-enrollment;engine=cosy:audioUrl=公网URL(百炼铁律,不收base64)、voice-enrollment/create_voice
 *   POST /agent/tts/voices/design { baseUrl, apiKey, name, voicePrompt, previewText?, targetModel? } → { voice, targetModel, previewAudio? }
 *   POST /agent/tts/voices/delete { baseUrl, apiKey, voice, kind } → { ok }
 * 铁律:音色只能配 enrollment/design 时的 target_model 合成(前端采用音色时联动切模型)。CosyVoice 复刻音色配 cosyvoice-* 走 WS 合成。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { dashScopeApiBase } from '../adapters/standalone/multiBrain.js';

const MAX_TEXT = 8000; // provider 普遍 4k-10k 字符上限;超长静默截断(朗读场景够用)

// 百炼音色定制的默认合成模型快照(可被请求覆盖;百炼铁律=复刻/设计与合成必须同模型)。
export const DASHSCOPE_VC_MODEL = 'qwen3-tts-vc-2026-01-22';
export const DASHSCOPE_VD_MODEL = 'qwen3-tts-vd-2026-01-26';
export const DASHSCOPE_COSY_MODEL = 'cosyvoice-v2'; // CosyVoice 复刻默认合成模型(音色绑定于此,合成走 WS)

type VoiceKind = 'clone' | 'design' | 'cosy';

const router = Router();

router.post('/agent/tts', authMiddleware, async (req: AuthRequest, res) => {
  const tts = deps().brain.tts;
  if (!tts) {
    res.status(501).json({ detail: '当前环境不支持语音合成' });
    return;
  }
  const { text, model, voice, speed } = (req.body || {}) as { text?: string; model?: string; voice?: string; speed?: number };
  if (!text?.trim() || !model) {
    res.status(400).json({ detail: 'text 与 model 必填' });
    return;
  }
  // 客户端停止/换消息会 abort 请求 → 连锁中止对 provider 的合成调用(别让被弃请求在用户的 key 上跑满)。
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const out = await tts.synthesize({
      model,
      text: text.slice(0, MAX_TEXT),
      voice: voice || undefined,
      speed: typeof speed === 'number' && speed > 0 ? Math.min(Math.max(speed, 0.5), 2) : undefined,
      signal: ac.signal,
    });
    if (res.writableEnded || ac.signal.aborted) return;
    res.setHeader('Content-Type', out.mime || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(Buffer.from(out.audio));
  } catch (e: any) {
    if (ac.signal.aborted || res.writableEnded) return; // 客户端已断开,无处可回
    res.status(502).json({ detail: e?.message || 'tts synthesize failed' });
  }
});

// ── 百炼音色管理代理 ──────────────────────────────────────────────────────────

/** DashScope 音色定制统一调用(customization 端点;错误原文透传给前端排障)。 */
async function dsCustomization(baseUrl: string, apiKey: string, body: unknown, timeoutMs = 60_000): Promise<any> {
  const r = await fetch(`${dashScopeApiBase(baseUrl)}/services/audio/tts/customization`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`dashscope ${r.status}: ${j?.message || j?.code || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

/** preferred_name 约束:数字/字母/下划线 ≤16;清洗到合法而非报错。 */
function cleanName(s: unknown): string {
  return (String(s ?? '').replace(/[^0-9A-Za-z_]/g, '').slice(0, 16)) || 'voice';
}

function voiceParams(req: AuthRequest): { baseUrl: string; apiKey: string } | null {
  const baseUrl = String(req.body?.baseUrl ?? '').trim();
  const apiKey = String(req.body?.apiKey ?? '').trim();
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

/** list 响应形态未有官方逐字文档,防御解析:元素可能是字符串或对象,字段名 voice/voice_id(cosy 用 voice_id)。 */
export function parseVoiceList(j: any, kind: VoiceKind): Array<{ voice: string; kind: VoiceKind; targetModel?: string }> {
  const arr = j?.output?.voices ?? j?.output?.voice_list ?? j?.output ?? [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((v: any) => (typeof v === 'string'
      ? { voice: v, kind }
      : { voice: v?.voice || v?.voice_id || '', kind, targetModel: v?.target_model || undefined }))
    .filter((v) => v.voice);
}

/** 翻页拉全量(账号上限 1000 个音色 = 最多 10 页;返回不足 page_size 即止)。qwen 用 action=list,cosy 用 list_voices。 */
async function dsListAll(baseUrl: string, apiKey: string, model: string, kind: VoiceKind, action = 'list'): Promise<Array<{ voice: string; kind: VoiceKind; targetModel?: string }>> {
  const out: Array<{ voice: string; kind: VoiceKind; targetModel?: string }> = [];
  for (let page = 0; page < 10; page++) {
    const j = await dsCustomization(baseUrl, apiKey, { model, input: { action, page_size: 100, page_index: page } }, 20_000);
    const batch = parseVoiceList(j, kind);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

router.post('/agent/tts/voices/list', authMiddleware, async (req: AuthRequest, res) => {
  const p = voiceParams(req);
  if (!p) { res.status(400).json({ detail: 'baseUrl 与 apiKey 必填' }); return; }
  try {
    const [clone, design, cosy] = await Promise.allSettled([
      dsListAll(p.baseUrl, p.apiKey, 'qwen-voice-enrollment', 'clone'),
      dsListAll(p.baseUrl, p.apiKey, 'qwen-voice-design', 'design'),
      dsListAll(p.baseUrl, p.apiKey, 'voice-enrollment', 'cosy', 'list_voices'),
    ]);
    const voices = [
      ...(clone.status === 'fulfilled' ? clone.value : []),
      ...(design.status === 'fulfilled' ? design.value : []),
      ...(cosy.status === 'fulfilled' ? cosy.value : []),
    ];
    // 全部失败才算错(单路失败可能是该账号未开通对应服务)。
    if (!voices.length && clone.status === 'rejected' && design.status === 'rejected' && cosy.status === 'rejected') {
      res.status(502).json({ detail: (clone.reason as any)?.message || 'list voices failed' });
      return;
    }
    res.json({ voices });
  } catch (e: any) {
    res.status(502).json({ detail: e?.message || 'list voices failed' });
  }
});

router.post('/agent/tts/voices/clone', authMiddleware, async (req: AuthRequest, res) => {
  const p = voiceParams(req);
  if (!p) { res.status(400).json({ detail: 'baseUrl/apiKey 必填' }); return; }

  // CosyVoice 复刻:百炼铁律=音频只能给公网可访问 URL(不收 base64),音色前缀 ≤10。
  if (req.body?.engine === 'cosy') {
    const url = String(req.body?.audioUrl ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(url)) { res.status(400).json({ detail: 'CosyVoice 复刻需公网可访问的音频 URL(https),百炼不收文件上传' }); return; }
    const targetModel = String(req.body?.targetModel ?? '').trim() || DASHSCOPE_COSY_MODEL;
    try {
      const j = await dsCustomization(p.baseUrl, p.apiKey, {
        model: 'voice-enrollment',
        input: { action: 'create_voice', target_model: targetModel, prefix: cleanName(req.body?.name).slice(0, 10), url },
      }, 120_000);
      const voice = j?.output?.voice_id || j?.output?.voice;
      if (!voice) throw new Error(`未返回音色 id:${JSON.stringify(j?.output || j).slice(0, 200)}`);
      res.json({ voice, targetModel });
    } catch (e: any) {
      res.status(502).json({ detail: e?.message || 'clone cosy voice failed' });
    }
    return;
  }

  const audioData = String(req.body?.audioData ?? '').trim(); // data:audio/...;base64,xxx 或公网 URL
  if (!audioData) { res.status(400).json({ detail: 'audioData 必填' }); return; }
  const targetModel = String(req.body?.targetModel ?? '').trim() || DASHSCOPE_VC_MODEL;
  try {
    const j = await dsCustomization(p.baseUrl, p.apiKey, {
      model: 'qwen-voice-enrollment',
      input: { action: 'create', target_model: targetModel, preferred_name: cleanName(req.body?.name), audio: { data: audioData } },
    }, 120_000); // 复刻处理较慢,给足超时
    const voice = j?.output?.voice || j?.output?.voice_id;
    if (!voice) throw new Error(`未返回音色 id:${JSON.stringify(j?.output || j).slice(0, 200)}`);
    res.json({ voice, targetModel });
  } catch (e: any) {
    res.status(502).json({ detail: e?.message || 'clone voice failed' });
  }
});

router.post('/agent/tts/voices/design', authMiddleware, async (req: AuthRequest, res) => {
  const p = voiceParams(req);
  const voicePrompt = String(req.body?.voicePrompt ?? '').trim();
  if (!p || !voicePrompt) { res.status(400).json({ detail: 'baseUrl/apiKey/voicePrompt 必填' }); return; }
  const targetModel = String(req.body?.targetModel ?? '').trim() || DASHSCOPE_VD_MODEL;
  const previewText = String(req.body?.previewText ?? '').trim();
  try {
    const j = await dsCustomization(p.baseUrl, p.apiKey, {
      model: 'qwen-voice-design',
      input: {
        action: 'create', target_model: targetModel, preferred_name: cleanName(req.body?.name),
        voice_prompt: voicePrompt.slice(0, 2048), ...(previewText ? { preview_text: previewText.slice(0, 1024) } : {}), language: 'zh',
      },
      parameters: { sample_rate: 24000, response_format: 'wav' },
    }, 120_000);
    const voice = j?.output?.voice || j?.output?.voice_id;
    if (!voice) throw new Error(`未返回音色 id:${JSON.stringify(j?.output || j).slice(0, 200)}`);
    const pa = j?.output?.preview_audio;
    res.json({
      voice, targetModel,
      ...(pa?.data ? { previewAudio: { data: pa.data, sampleRate: pa.sample_rate || 24000, format: pa.response_format || 'wav' } } : {}),
    });
  } catch (e: any) {
    res.status(502).json({ detail: e?.message || 'design voice failed' });
  }
});

router.post('/agent/tts/voices/delete', authMiddleware, async (req: AuthRequest, res) => {
  const p = voiceParams(req);
  const voice = String(req.body?.voice ?? '').trim();
  const kind: VoiceKind = req.body?.kind === 'design' ? 'design' : req.body?.kind === 'cosy' ? 'cosy' : 'clone';
  if (!p || !voice) { res.status(400).json({ detail: 'baseUrl/apiKey/voice 必填' }); return; }
  try {
    const body = kind === 'cosy'
      ? { model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: voice } }
      : { model: kind === 'design' ? 'qwen-voice-design' : 'qwen-voice-enrollment', input: { action: 'delete', voice } };
    await dsCustomization(p.baseUrl, p.apiKey, body, 20_000);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ detail: e?.message || 'delete voice failed' });
  }
});

export default router;
