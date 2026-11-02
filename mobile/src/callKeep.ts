/**
 * 语音通话切到后台接着打:把安卓原生 CallKeep(microphone 前台服务 + 「通话中」通知)接成 realtimeCall 的保活宿主。
 * 非 Android / 插件缺席时不装,通话照旧离开前台即挂断。原生半身见 android/.../CallKeepPlugin.java。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { registerMessages, translate } from '@/i18n'
import { endCall, setCallKeepHost } from '@/services/realtimeCall'

interface CallKeepPlugin {
  start(o: { title: string; text: string; hangup: string; channelName: string }): Promise<{ ok: boolean }>
  stop(): Promise<void>
  addListener(event: 'hangup', fn: () => void): Promise<unknown>
}

registerMessages({
  'callKeep.text': { zh: '正在和 Tangu 通话', en: 'On a call with Tangu' },
  'callKeep.channel': { zh: '语音通话', en: 'Voice calls' },
})

export function installCallKeep(): void {
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('CallKeep')) return
  const Native = registerPlugin<CallKeepPlugin>('CallKeep')
  void Native.addListener('hangup', () => endCall())
  // 上一程(页面重载前)留下的服务:这个 JS 上下文里没有通话,撤掉。
  void Native.stop().catch(() => {})
  setCallKeepHost({
    start: () => Native.start({
      title: translate('livecall.title'),
      text: translate('callKeep.text'),
      hangup: translate('livecall.end'),
      channelName: translate('callKeep.channel'),
    }).then((r) => !!r?.ok, () => false),
    stop: () => { void Native.stop().catch(() => {}) },
  })
}
