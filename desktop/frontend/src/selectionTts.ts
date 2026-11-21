/**
 * 探针的朗读那一截(TanguProbe.tts,2026-11-21):划线条「朗读」、结果卡的小喇叭、插件 ctx.tts 共用。
 * 合成与播放是 services/ttsService(全应用一个播放器,和聊天朗读同一个);这里只管「配没配模型」和打开设置。
 * 不回落系统声音(用户定):没配就 reject tts_no_model,由画按钮的那一方出提示卡。
 */
import { effectiveTtsConfig, speakKey, stopSpeaking, subscribeTts, ttsState } from './services/ttsService'
import { homeTarget } from './services/engine/targets'
import { useApp } from './stores/appStore'
import type { TanguTts } from './amadeus/plugins/tanguSeam'

const signedIn = (): boolean => { const a = useApp.getState().authInfo; return !!a?.loggedIn && a.tokenValid !== false }

/** 这个宿主能不能配朗读模型:和设置里「模型 → 语音」那一页同一个条件(桌面 Electron、手机壳;网页端没有)。 */
export function ttsHostAvailable(): boolean {
  return typeof window !== 'undefined' && (!!window.tangu?.backendStatus || !!window.tangu?.mobile)
}

export function createSelectionTts(): TanguTts {
  return {
    available: () => {
      const s = useApp.getState()
      return !!effectiveTtsConfig(s.desktopConfig, s.modelsResp, signedIn())?.ttsModelId?.trim()
    },
    // 现读配置:store 里那份只在设置关掉时刷新,用户刚在设置浮窗里选好的模型要认(同自动朗读那条)。
    // 读配置交给 speakKey 去等:它先在播放器上登记这一段,等的时候别处点了朗读 / stop,这一段作废(不回头掐掉后来那段)。
    speak: (key, text, o) => speakKey(homeTarget(), async () => {
      const raw = (await window.tangu?.getConfig?.().catch(() => null)) ?? useApp.getState().desktopConfig
      return effectiveTtsConfig(raw, useApp.getState().modelsResp, signedIn())
    }, key, text, o),
    stop: (key) => stopSpeaking(key),
    state: () => { const s = ttsState(); return s ? { key: s.key, phase: s.phase } : null },
    subscribe: (cb) => subscribeTts(() => cb()),
    openSettings: () => useApp.getState().openSettings('model/m-voice' as Parameters<ReturnType<typeof useApp.getState>['openSettings']>[0]),
  }
}
