/**
 * 通话键的一次性提示:默认开启后,用户第一次看到发送键变成通话键时说明它和扣费。
 *
 * 2026-11-07(LCL 表面规范第一期)起不再自己画一张绝对定位的气泡,改成宿主的上手提示(guideTips 的宿主提示):
 * 圈住通话键 + 一张小卡,和插件提示同一套节奏 —— 停手再出、有弹窗就等、同一时刻全应用一处、一天最多几条。
 * 锚点 = 通话键上的 `data-guide-anchor="chat-call"`(Composer2 只在它真是通话键时挂);打过一通 = 看过。
 * 旧版自己记的 `forsion_call_hint_seen` 认作看过,老用户不会再看到一次。
 */
import { useEffect } from 'react'
import { useApp } from '../../stores/appStore'
import { registerMessages, translate } from '../../i18n'
import { hostTipSeen, markHostTipSeen, registerHostTip } from '../../amadeus/plugins/guideTips'

registerMessages({
  'callhint.title': { zh: '可以直接和 Tangu 通话了', en: 'You can now talk to Tangu' },
  'callhint.body': { zh: '输入框空着时，点这里开始。通话用量从额度里扣。', en: 'Click here while the input is empty to start. Calls use your quota.' },
  'callhint.bodyDirect': { zh: '输入框空着时，点这里开始。费用由你的语音服务商收取。', en: 'Click here while the input is empty to start. Your voice provider bills the calls.' },
  'callhint.voice': { zh: '换个音色', en: 'Change voice' },
})

export const CALL_HINT_ID = 'voice-call'
export const CALL_HINT_ANCHOR = 'chat-call'
const LEGACY_SEEN_KEY = 'forsion_call_hint_seen'

let cloud = true
registerHostTip({
  id: CALL_HINT_ID,
  at: CALL_HINT_ANCHOR,
  style: 'ring',
  resolve: () => ({ title: translate('callhint.title'), body: translate(cloud ? 'callhint.body' : 'callhint.bodyDirect') }),
  extra: { label: () => translate('callhint.voice'), run: () => useApp.getState().openSettings('model/m-voice') },
})
// 迁移:旧版看过的(读得到明确的值)记成看过;新键读失败时不动(不知道就别写)
try { if (localStorage.getItem(LEGACY_SEEN_KEY) && hostTipSeen(CALL_HINT_ID) === false) markHostTipSeen(CALL_HINT_ID) } catch { /* 读不了旧键 = 不知道 */ }

/** 打过一通 = 看过(正出着就收掉)。 */
export const markCallHintSeen = (): void => markHostTipSeen(CALL_HINT_ID)

/** 只把「这次通话走云端还是用户自己的语音服务商」告诉提示文案;提示本身由宿主上手提示画。 */
export function CallHint({ cloud: isCloud }: { cloud: boolean }): null {
  useEffect(() => { cloud = isCloud }, [isCloud])
  return null
}
