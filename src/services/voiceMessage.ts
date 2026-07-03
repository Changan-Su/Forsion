/**
 * 语音消息(通道无关 + 按 agent)。启用后把某 agent 的回复合成语音:
 *  - 桌面端:前端把回复渲染成语音条(复用 /agent/tts,见 desktop);
 *  - 微信端:文字之外,再把回复合成 WAV、当**文件**发一份(见 services/wechatRemote.ts)。
 *    (微信 iLink bot 平台不渲染 bot 发的原生语音气泡——实测 sendmessage 返回成功也不显示——故退而发音频文件。)
 *
 * 面板由 plugins/voice-message(文件夹插件,scopes: global + agent)声明;行为留在核心(与 replySegment 同构)。
 * TTS 配置**沿用「模型设置 → 语音朗读」**(config.json 的 tts 段:modelId/voice/speed)——与朗读按钮同一套,
 * 不在插件里另配。未配语音朗读模型 → 微信端只发文字(deliverReply 会 warn)。
 */
import { isPluginEnabledSync, getPluginSettingsSync } from '../plugins/settingsStore.js';
import { getRawSection } from '../core/config.js';
import { deps } from '../seams/runtime.js';

export const VOICE_MESSAGE_PLUGIN_ID = 'voice-message';

export interface VoiceMessageConfig {
  /** 插件启用 + 该 agent apply。 */
  enabled: boolean;
  /** 微信端也发语音气泡。 */
  wechat: boolean;
  /** TTS 模型(沿用语音朗读设置 tts.modelId)。空 = 未配置语音朗读。 */
  model: string;
  voice?: string;
  speed?: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * 解析某 agent 的语音配置。插件未启用 → 全关。apply/wechat 默认开、可 per-agent 覆盖;
 * TTS 模型/音色/语速沿用「语音朗读」(config.json tts 段),与朗读按钮同源。
 */
export function resolveVoiceMessage(agentSlug?: string): VoiceMessageConfig {
  if (!isPluginEnabledSync(VOICE_MESSAGE_PLUGIN_ID)) return { enabled: false, wechat: false, model: '' };
  const s = getPluginSettingsSync(VOICE_MESSAGE_PLUGIN_ID, agentSlug ? { agentSlug } : undefined);
  const tts = getRawSection('tts') || {}; // 「模型设置 → 语音朗读」:{ modelId, voice, speed }
  return {
    enabled: s.apply !== false,
    wechat: s.wechat !== false,
    model: str(tts.modelId),
    voice: str(tts.voice) || undefined,
    speed: (typeof tts.speed === 'number' && tts.speed > 0) ? tts.speed : undefined,
  };
}

/** 合成一段语音为 WAV(供转 SILK)。失败抛错,调用方兜底改发文字。 */
export async function synthesizeVoiceWav(text: string, cfg: VoiceMessageConfig, signal?: AbortSignal): Promise<Uint8Array> {
  const tts = deps().brain.tts;
  if (!tts) throw new Error('voice: 当前 profile 未提供 TTS');
  if (!cfg.model) throw new Error('voice: 未配置 TTS 模型');
  const { audio } = await tts.synthesize({
    model: cfg.model,
    text,
    voice: cfg.voice,
    speed: cfg.speed,
    format: 'wav', // SILK 转码只吃 WAV/PCM
    signal,
  });
  return audio;
}
