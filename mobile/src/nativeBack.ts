/** 系统返回手势「走到哪了」与「再返回一次退出」的提示(原生侧 NativeBackPlugin.kt)。
 *
 *  一下返回做什么仍由 MobileRoot 那条链决定(Capacitor 的 backButton)。这里只补那个事件带不了的东西:
 *  · 手指还按着的时候手势走到哪 —— Android 14 起系统才告诉 App;更早的系统和返回键从不报,那里一下返回就是松手时的
 *    一个事件,和以前一样。所以这是在同一个结果上加的跟手,不是另一套行为。
 *  · 一条系统 Toast。所有 Android 版本都有,所以「主页上再返回一次才退出」在哪台手机上都一样。
 *  浏览器 / 没有这个插件的旧原生壳:两样都没有,`exitHint` 返回 false,调用方照旧直接退。 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { registerMessages, translate } from '@/i18n'

registerMessages({
  'mobile.back.exitHint': { zh: '再返回一次退出', en: 'Go back again to exit' },
})

export interface BackGesture { phase: 'start' | 'progress' | 'cancel'; edge?: 'left' | 'right'; x?: number }
interface NativeBackPlugin {
  hint(o: { text: string }): Promise<void>
  addListener(event: 'gesture', cb: (e: BackGesture) => void): Promise<PluginListenerHandle>
}

const plugin = Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NativeBack') ? registerPlugin<NativeBackPlugin>('NativeBack') : null

/** 订阅手势过程;没有原生宿主时是空操作。返回值取消订阅。 */
export function onBackGesture(cb: (e: BackGesture) => void): () => void {
  if (!plugin) return () => {}
  const sub = plugin.addListener('gesture', cb)
  return () => { void sub.then((h) => h.remove()).catch(() => {}) }
}

/** 弹「再返回一次退出」。弹不了(没有原生宿主)→ false。 */
export function exitHint(): boolean {
  if (!plugin) return false
  void plugin.hint({ text: translate('mobile.back.exitHint') }).catch(() => {})
  return true
}
