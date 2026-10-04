/**
 * 语音合成(朗读按钮/自动朗读;handler 自带 authMiddleware)。
 *   POST /agent/tts { text, model, voice?, speed? } → audio/mpeg 字节
 * 经 deps().brain.tts(可选 seam):仅 standalone multiBrain 实现(BYO-key 直连
 * OpenAI 兼容 /audio/speech,阿里云百炼域名自动切原生协议);云端未注入 → 501,前端据此隐藏入口。
 *
 * 音色管理(百炼声音复刻/声音设计;providers/test 同款「前端传 baseUrl+key、后端代打」模式,免 CORS 且不动 seam):
 *   POST /agent/tts/voices/list   { baseUrl, apiKey } → { voices: [{ voice, kind, targetModel? }] }   kind: clone(qwen复刻)|design(qwen设计)|cosy(CosyVoice复刻)
 *   POST /agent/tts/voices/clone  { baseUrl, apiKey, name, targetModel?, audioData?, audioUrl?, engine? } → { voice, targetModel }
 *       复刻服务按 targetModel 分家(cloneService):Qwen3-TTS-VC / Qwen-Omni → qwen-voice-enrollment(收 base64);
 *       Qwen-Audio-TTS / CosyVoice → voice-enrollment/create_voice(只收 URL:本地录音先传百炼临时空间换 oss:// 地址)。
 *       engine=cosy 是旧客户端的写法(不带 targetModel 时落 cosyvoice-v2)。
 *       text / language:样本是照着文案念的时候带上,只给 qwen-voice-enrollment。对不上时百炼不报错,退回不用文案的方式,
 *       并在应答里标 fallback_mode(10-04 实测 qwen3-tts-vc:wer_too_high)→ 原样带回 fallbackReason。
 *   POST /agent/tts/voices/design { baseUrl, apiKey, name, voicePrompt, previewText?, targetModel? } → { voice, targetModel, previewAudio? }
 *   POST /agent/tts/voices/delete { baseUrl, apiKey, voice, kind } → { ok }
 * 铁律:音色只能配 enrollment/design 时的 target_model 合成(前端采用音色时联动切模型)。CosyVoice / Qwen-Audio-TTS 音色走 WS 合成。
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
async function dsCustomization(baseUrl: string, apiKey: string, body: unknown, timeoutMs = 60_000, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(`${dashScopeApiBase(baseUrl)}/services/audio/tts/customization`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`dashscope ${r.status}: ${j?.message || j?.code || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

/** 复刻服务按目标模型分家:Qwen-Audio-TTS / CosyVoice 走 voice-enrollment,其余(Qwen3-TTS-VC、Qwen-Omni)走 qwen-voice-enrollment。 */
export function cloneService(targetModel: string): 'voice-enrollment' | 'qwen-voice-enrollment' {
  return /^(cosyvoice|qwen-audio)/i.test(targetModel) ? 'voice-enrollment' : 'qwen-voice-enrollment';
}

/**
 * qwen-voice-enrollment 的 create 请求体。qwen3.8-omni 起必须带 voice_clone_mode:不带时百炼不报错,
 * 静默回退到 qwen3.5-omni 的旧复刻模式(文档 qwen-omni-voice-cloning「条件必填」)。3.5 就是那个旧模式,不带。
 * script:样本是照着这段文案念的 —— 文案和语种一起给,百炼用得上(对不上它自己退回,不会失败)。
 */
export function qwenCloneBody(targetModel: string, name: string, audioData: string, script?: { text: string; language?: string }): Record<string, unknown> {
  const needsMode = /omni/i.test(targetModel) && !/^qwen3\.5-omni/i.test(targetModel);
  return {
    model: 'qwen-voice-enrollment',
    input: {
      action: 'create', target_model: targetModel, preferred_name: name, audio: { data: audioData },
      ...(script?.text ? { text: script.text, ...(script.language ? { language: script.language } : {}) } : {}),
    },
    ...(needsMode ? { parameters: { voice_clone_mode: 'normal' } } : {}),
  };
}

// 带样本的请求给足 5 分钟:10-04 实测境外到百炼(API 网关和 OSS 都一样)的上行只有 10–30 KB/s,1 MB 的样本要一分多钟。
const CLONE_UPLOAD_MS = 300_000;

/** 本地录音(data URI)→ 百炼临时空间(48 小时后自动清),换回 oss:// 地址。voice-enrollment 只收 URL,这样用户不用自己找地方挂文件。 */
async function dsTempUpload(baseUrl: string, apiKey: string, dataUri: string): Promise<string> {
  const m = /^data:([^;,]+)[^,]*;base64,(.+)$/s.exec(dataUri);
  if (!m) throw new Error('audioData must be a data:audio/...;base64 URI or an https URL');
  const ext = /mpeg|mp3/i.test(m[1]) ? 'mp3' : /mp4|m4a|aac/i.test(m[1]) ? 'm4a' : 'wav';
  const r = await fetch(`${dashScopeApiBase(baseUrl)}/uploads?action=getPolicy&model=voice-enrollment`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000),
  });
  const d = ((await r.json().catch(() => ({}))) as any)?.data;
  if (!r.ok || !d?.upload_host || !d?.upload_dir) throw new Error(`dashscope upload policy ${r.status}`);
  const key = `${d.upload_dir}/clone-${Date.now()}.${ext}`;
  const fd = new FormData();
  const fields: Record<string, unknown> = {
    OSSAccessKeyId: d.oss_access_key_id, Signature: d.signature, policy: d.policy,
    'x-oss-object-acl': d.x_oss_object_acl, 'x-oss-forbid-overwrite': d.x_oss_forbid_overwrite, key, success_action_status: '200',
  };
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  fd.append('file', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), `clone.${ext}`); // OSS 表单上传:file 必须排最后
  const u = await fetch(d.upload_host, { method: 'POST', body: fd, signal: AbortSignal.timeout(CLONE_UPLOAD_MS) });
  if (!u.ok) throw new Error(`dashscope upload ${u.status}: ${(await u.text().catch(() => '')).slice(0, 200)}`);
  return `oss://${key}`;
}

/**
 * voice-enrollment 新建的音色要部署几秒(实测约 6 秒),没好就拿去合成会报错 → 等到 OK 再交还。
 * 只有 OK 算成功:没过审(UNDEPLOYED)、到点还没好都报错(带音色 id,它已经建在账号里,好了以后能在列表里采用);查询偶发失败接着等。
 */
export async function dsAwaitVoice(baseUrl: string, apiKey: string, voice: string, tries = 30, gapMs = 2000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const j = await dsCustomization(baseUrl, apiKey, { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: voice } }, 20_000).catch(() => null);
    const status = j?.output?.status;
    if (status === 'OK') return;
    if (status === 'UNDEPLOYED') throw new Error(`voice ${voice} was rejected by Bailian review (UNDEPLOYED)`);
    await new Promise((r) => setTimeout(r, gapMs));
  }
  throw new Error(`voice ${voice} was created but is still deploying on Bailian; refresh the voice list in a minute and apply it from there`);
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

/** 翻页拉全量(账号上限 1000 个音色 = 最多 10 页;返回不足 page_size 即止)。qwen 用 action=list,voice-enrollment 用 list_voice。 */
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
      dsListAll(p.baseUrl, p.apiKey, 'voice-enrollment', 'cosy', 'list_voice'), // 实测:list_voices 报 invalid action
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
  const legacyCosy = req.body?.engine === 'cosy'; // 旧客户端:只传 engine,不传 targetModel
  const targetModel = String(req.body?.targetModel ?? '').trim() || (legacyCosy ? DASHSCOPE_COSY_MODEL : DASHSCOPE_VC_MODEL);
  const audio = String(req.body?.audioUrl ?? '').trim() || String(req.body?.audioData ?? '').trim(); // 公网 URL 或 data:audio/...;base64
  if (!audio) { res.status(400).json({ detail: 'audioData or audioUrl is required' }); return; }

  // Qwen-Audio-TTS / CosyVoice:音频只能给 URL,前缀只收小写字母和数字、≤10。
  if (legacyCosy || cloneService(targetModel) === 'voice-enrollment') {
    try {
      const isUrl = /^https?:\/\/\S+/i.test(audio);
      const url = isUrl ? audio : await dsTempUpload(p.baseUrl, p.apiKey, audio);
      const j = await dsCustomization(p.baseUrl, p.apiKey, {
        model: 'voice-enrollment',
        input: { action: 'create_voice', target_model: targetModel, prefix: cleanName(req.body?.name).toLowerCase().replace(/_/g, '').slice(0, 10) || 'voice', url },
      }, CLONE_UPLOAD_MS, isUrl ? {} : { 'X-DashScope-OssResourceResolve': 'enable' }); // oss:// 临时地址要这个头才解析
      const voice = j?.output?.voice_id || j?.output?.voice;
      if (!voice) throw new Error(`未返回音色 id:${JSON.stringify(j?.output || j).slice(0, 200)}`);
      await dsAwaitVoice(p.baseUrl, p.apiKey, voice);
      res.json({ voice, targetModel });
    } catch (e: any) {
      res.status(502).json({ detail: e?.message || 'clone voice failed' });
    }
    return;
  }

  try {
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    const language = String(req.body?.language ?? '').trim();
    const script = text ? { text, language: /^[A-Za-z]{2,12}$/.test(language) ? language : undefined } : undefined;
    const j = await dsCustomization(p.baseUrl, p.apiKey, qwenCloneBody(targetModel, cleanName(req.body?.name), audio, script), CLONE_UPLOAD_MS); // 样本就在请求体里,慢的是上传
    const voice = j?.output?.voice || j?.output?.voice_id;
    if (!voice) throw new Error(`未返回音色 id:${JSON.stringify(j?.output || j).slice(0, 200)}`);
    res.json({ voice, targetModel, ...(j.output.fallback_mode ? { fallbackReason: String(j.output.fallback_reason || 'fallback') } : {}) });
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
