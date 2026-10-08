/**
 * 语音通话实际用哪个模型、哪个音色 —— 输入框的通话键(Composer2)和设置页「语音通话」(RealtimeVoiceSettings)共用这一处,
 * 两边说法才对得上。
 *
 * 通话模型有两种来源:
 *   - `<providerId>/<model>`:用户自己的阿里云百炼提供方,引擎带他的 key 直连;
 *   - Forsion 云端的实时模型(引擎目录里的 realtimeModel,id 不带提供方前缀):经 Forsion 服务端中转,按通话时长从额度里扣。
 *
 * 缺省:用户从没动过这个开关(realtimeModelUnset)、装了 Forsion Extend 且已登录、云端有通话模型 → 默认开、用云端那个。
 * 动过(选过模型,或关掉 = 存了 '')就听他的 —— 关掉之后不会因为登录又自己开回来。
 */
import type { ModelsResponse, StoredDesktopConfig } from '../types'

export type CloudCallModel = NonNullable<ModelsResponse['realtimeModel']>

export interface RealtimeCloud {
  /** 引擎目录给的云端通话模型;没有 = 云端没开 / 老引擎。 */
  model?: CloudCallModel | null
  /** 装了 Forsion Extend(有登录入口)且当前登录有效。 */
  signedIn: boolean
}

// 两个家族:Qwen-Omni 与 Qwen-Audio。会话协议通用,差在音色 —— 系统音色各一套、互不相认。
const isAudioFamilyName = (name: string): boolean => /(^|\/)qwen-audio-/i.test(name)

/** 按音色家族分时该看的名字:云端模型看上游模型名(它的 id 可能是导入出来的 pr-<hash>,看不出家族),自带的看 id。 */
export function realtimeFamilyName(model: string, cloud?: CloudCallModel | null): string {
  return cloud && model === cloud.id ? cloud.apiModelId || cloud.id : model
}
export const isAudioFamily = (model: string, cloud?: CloudCallModel | null): boolean => isAudioFamilyName(realtimeFamilyName(model, cloud))
/** 没选音色时用的那个(与引擎 realtimeVoice.ts 的 defaultRealtimeVoice 同表)。 */
export const defaultVoiceFor = (model: string, cloud?: CloudCallModel | null): string => (isAudioFamily(model, cloud) ? 'longanqian' : 'Tina')

/** 通话实际用的模型;'' = 通话没开(输入框不出通话键)。 */
export function effectiveRealtimeModel(cfg: Pick<StoredDesktopConfig, 'realtimeModelId' | 'realtimeModelUnset'>, cloud: RealtimeCloud): string {
  const chosen = cfg.realtimeModelId?.trim() || ''
  if (chosen || !cfg.realtimeModelUnset) return chosen
  return cloud.signedIn && cloud.model?.id ? cloud.model.id : ''
}

/** 拨出去时交给引擎的 { model, voice }。云端模型没选音色时把缺省音色明说出来:引擎只看得到模型 id,看不出它是哪个家族。 */
export function resolveRealtimeCall(cfg: Pick<StoredDesktopConfig, 'realtimeModelId' | 'realtimeModelUnset' | 'realtimeVoice'>, cloud: RealtimeCloud): { model: string; voice: string } {
  const model = effectiveRealtimeModel(cfg, cloud)
  const voice = cfg.realtimeVoice?.trim() || ''
  return { model, voice: voice || (model && cloud.model && model === cloud.model.id ? defaultVoiceFor(model, cloud.model) : '') }
}
