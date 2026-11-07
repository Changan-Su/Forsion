/**
 * 宿主自己的上手提示清单(2026-11-07,LCL 表面规范第一期)。和插件提示同一套节奏(guideTips.ts:停手再出、有弹窗就等、
 * 同一时刻全应用一处、一天最多几条),只是写在宿主代码里、不经 manifest。由 pluginStore 引入,三端都会登记。
 *
 * 通话键首次提示(原 views/chat2/CallHint.tsx 自己画的气泡):输入框空着、发送键变成通话键时圈住它 + 一张小卡。
 *  - 锚点 = Composer2 通话键上的 `data-guide-anchor="chat-call"`(只在它真是通话键时挂);
 *    `data-call-billing="cloud|direct"` 告诉文案这通走云端额度还是用户自己的语音服务商。
 *    Tangu 界面不引这个文件(Tangu → 宿主的依赖只许减,见 check:tanguboundary),两边各写同一个字面量。
 *  - 打过一通 = 会了:Composer2 开始通话时计成就事件 `chat.voiceCall`,出着就当场收掉。
 *  - 旧版自己记的 `forsion_call_hint_seen` 认作看过,老用户不会再看到一次。
 */
import { registerMessages, translate } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { hostTipSeen, markHostTipSeen, registerHostTip } from './guideTips'

registerMessages({
  'callhint.title': { zh: '可以直接和 Tangu 通话了', en: 'You can now talk to Tangu' },
  'callhint.body': { zh: '输入框空着时，点这里开始。通话用量从额度里扣。', en: 'Click here while the input is empty to start. Calls use your quota.' },
  'callhint.bodyDirect': { zh: '输入框空着时，点这里开始。费用由你的语音服务商收取。', en: 'Click here while the input is empty to start. Your voice provider bills the calls.' },
  'callhint.voice': { zh: '换个音色', en: 'Change voice' },
})

export const CALL_TIP_ID = 'voice-call'
/** 和 Composer2 通话键上的 data-guide-anchor 同名。 */
export const CALL_TIP_ANCHOR = 'chat-call'
/** Composer2 开始通话时计的成就事件。 */
export const CALL_DONE_EVENT = 'chat.voiceCall'
const LEGACY_SEEN_KEY = 'forsion_call_hint_seen'

registerHostTip({
  id: CALL_TIP_ID,
  at: CALL_TIP_ANCHOR,
  style: 'ring',
  done: [`app:${CALL_DONE_EVENT}`],
  resolve: (el) => ({ title: translate('callhint.title'), body: translate(el?.dataset.callBilling === 'direct' ? 'callhint.bodyDirect' : 'callhint.body') }),
  extra: { label: () => translate('callhint.voice'), run: () => useApp.getState().openSettings('model/m-voice') },
})
// 迁移:旧版看过的(读得到明确的值)记成看过;新键读失败时不动(不知道就别写)
try { if (localStorage.getItem(LEGACY_SEEN_KEY) && hostTipSeen(CALL_TIP_ID) === false) markHostTipSeen(CALL_TIP_ID) } catch { /* 读不了旧键 = 不知道 */ }
