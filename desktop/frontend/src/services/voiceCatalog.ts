/**
 * 系统音色表与试听。音色名不翻译,显示名和气质走 i18n(voice.<kind>.<id>.name / .desc);样音随包带,试听不走网络、不扣费。
 * 样音由 desktop/scripts/gen-voice-samples.mjs 生成:通话音色只能走实时模型出声,朗读音色走 qwen3-tts,两边不互通。
 * Qwen-Audio 通话音色文档没给说明,暂时只显示 ID、没有样音。
 */
import { useSyncExternalStore } from 'react'
import { registerMessages } from '../i18n'

export type VoiceKind = 'call' | 'read'

// 百炼「Qwen-Omni-Realtime 音色列表」里的一部分(全表 36+ 种)
export const OMNI_VOICES = ['Tina', 'Cindy', 'Raymond', 'Katerina', 'Ryan', 'Mia', 'Jennifer', 'Aiden']
// qwen-audio-3.1-realtime-plus 认的系统音色(10-04 从接口的报错里抄的全表)
export const AUDIO_VOICES = ['longanqian', 'longanlingxin', 'longanlufeng', 'longanlingxi', 'longanxiaoxin', 'longanfengyue', 'longanyuanfei', 'longanhuan_v3.6', 'longjielidou_v3.6',
  'longpaopao_v3.6', 'longhuohuo_v3.6', 'longchuanshu_v3.6', 'loongmary', 'loongeva_v3.6', 'loongjohn', 'daniel', 'echo', 'hannah', 'sherry',
  'longanqian_v3.1', 'longanhuan_v3.1', 'longanlingxin_v3.1', 'longanfengyue_v3.1', 'xunanchuan_v3.1', 'beth_v3.1', 'betty_v3.1', 'cally_v3.1']
// 百炼无音色列表 API,静态维护常用项;全量见「Qwen-TTS 音色列表」文档
export const BAILIAN_READ_VOICES = ['Cherry', 'Serena', 'Ethan', 'Chelsie', 'Nofish', 'Jennifer', 'Ryan', 'Katerina', 'Dylan', 'Jada', 'Sunny', 'Rocky', 'Kiki', 'Marcus', 'Roy', 'Peter']
export const OPENAI_READ_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']

const m = (zh: string, en: string) => ({ zh, en })
registerMessages({
  'voice.call.Tina.name': m('甜甜', 'Tina'), 'voice.call.Tina.desc': m('温暖女声', 'Warm female'),
  'voice.call.Cindy.name': m('林欣宜', 'Cindy'), 'voice.call.Cindy.desc': m('台湾腔女声', 'Taiwanese-accent female'),
  'voice.call.Raymond.name': m('林川野', 'Raymond'), 'voice.call.Raymond.desc': m('清亮男声', 'Clear male'),
  'voice.call.Katerina.name': m('卡捷琳娜', 'Katerina'), 'voice.call.Katerina.desc': m('御姐音', 'Mature female'),
  'voice.call.Ryan.name': m('甜茶', 'Ryan'), 'voice.call.Ryan.desc': m('戏感男声', 'Dramatic male'),
  'voice.call.Mia.name': m('舒然', 'Mia'), 'voice.call.Mia.desc': m('温柔女声', 'Gentle female'),
  'voice.call.Jennifer.name': m('詹妮弗', 'Jennifer'), 'voice.call.Jennifer.desc': m('美语女声', 'American female'),
  'voice.call.Aiden.name': m('艾登', 'Aiden'), 'voice.call.Aiden.desc': m('美语男声', 'American male'),
  'voice.read.Cherry.name': m('芊悦', 'Cherry'), 'voice.read.Cherry.desc': m('普通话女声', 'Mandarin female'),
  'voice.read.Serena.name': m('苏瑶', 'Serena'), 'voice.read.Serena.desc': m('普通话女声', 'Mandarin female'),
  'voice.read.Ethan.name': m('晨煦', 'Ethan'), 'voice.read.Ethan.desc': m('普通话男声', 'Mandarin male'),
  'voice.read.Chelsie.name': m('千雪', 'Chelsie'), 'voice.read.Chelsie.desc': m('普通话女声', 'Mandarin female'),
  'voice.read.Nofish.name': m('不吃鱼', 'Nofish'), 'voice.read.Nofish.desc': m('不翘舌的男声', 'Male, flat-tongue accent'),
  'voice.read.Jennifer.name': m('詹妮弗', 'Jennifer'), 'voice.read.Jennifer.desc': m('英语女声', 'English female'),
  'voice.read.Ryan.name': m('甜茶', 'Ryan'), 'voice.read.Ryan.desc': m('英语男声', 'English male'),
  'voice.read.Katerina.name': m('卡捷琳娜', 'Katerina'), 'voice.read.Katerina.desc': m('俄语女声', 'Russian female'),
  'voice.read.Dylan.name': m('北京话', 'Dylan'), 'voice.read.Dylan.desc': m('方言', 'Beijing dialect'),
  'voice.read.Jada.name': m('上海话', 'Jada'), 'voice.read.Jada.desc': m('方言', 'Shanghai dialect'),
  'voice.read.Sunny.name': m('四川话', 'Sunny'), 'voice.read.Sunny.desc': m('方言', 'Sichuan dialect'),
  'voice.read.Rocky.name': m('粤语', 'Rocky'), 'voice.read.Rocky.desc': m('方言男声', 'Cantonese male'),
  'voice.read.Kiki.name': m('粤语', 'Kiki'), 'voice.read.Kiki.desc': m('方言女声', 'Cantonese female'),
  'voice.read.Marcus.name': m('陕西话', 'Marcus'), 'voice.read.Marcus.desc': m('方言', 'Shaanxi dialect'),
  'voice.read.Roy.name': m('闽南语', 'Roy'), 'voice.read.Roy.desc': m('方言', 'Hokkien dialect'),
  'voice.read.Peter.name': m('天津话', 'Peter'), 'voice.read.Peter.desc': m('方言', 'Tianjin dialect'),
})

const SAMPLES = import.meta.glob<string>('../assets/voice-samples/*.m4a', { eager: true, query: '?url', import: 'default' })
/** 随包样音的地址;没有 = 这个音色没录过。 */
export function voiceSampleUrl(kind: VoiceKind, voice: string, locale: 'zh' | 'en'): string | undefined {
  return SAMPLES[`../assets/voice-samples/${kind}-${voice}-${locale}.m4a`]
}

// 同时只放一个:再点别的音色就换,再点同一个就停。
let audio: HTMLAudioElement | null = null
let playingKey = ''
let token = 0
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

export function stopVoicePreview(): void {
  token++
  audio?.pause(); audio = null
  if (playingKey) { playingKey = ''; notify() }
}

/** load 返回可播放的地址(随包样音,或现合成的 blob);同一个 key 再按一次 = 停。 */
export async function toggleVoicePreview(key: string, load: () => string | Promise<string>): Promise<void> {
  const again = playingKey === key
  stopVoicePreview()
  if (again) return
  const mine = token
  playingKey = key; notify()
  try {
    const url = await load()
    if (mine !== token) return
    const a = (audio = new Audio(url))
    a.onended = () => { if (mine === token) stopVoicePreview() }
    await a.play()
  } catch (e) {
    if (mine === token) stopVoicePreview()
    throw e
  }
}

export const useVoicePreview = (): string => useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => playingKey)
