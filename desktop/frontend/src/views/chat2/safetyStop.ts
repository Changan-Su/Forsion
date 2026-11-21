/**
 * 被模型的安全审核拦下的回答(借鉴 DeepSeek chat-demo ④;引擎侧 tangu-agent/src/contracts/safetyStop.ts)。
 * 引擎把这一轮的终稿写成「此前各轮的正文 + 一句固定文案」并标 refused(done 事件 / 落库 origin)。
 * 渲染时把末尾那句摘掉、改在回答下面画一行灰字(照「已停止」),文案跟当前界面语言走。
 * 云端那条落库路径不带 origin:那时没有 refused 标记,固定文案就照普通正文显示。
 */
import { registerMessages } from '../../i18n'
import { SAFETY_STOP_NOTICE } from '../../../../../tangu-agent/src/contracts/safetyStop'

registerMessages({
  // 与引擎落库的文案逐字一致(safetyStop.test.ts 钉住)
  'chat.refused': { zh: '这条回答被模型的安全审核拦下了。', en: "This reply was blocked by the model's safety check." },
})

/** 摘掉终稿末尾的固定文案(zh / en 哪种都认:界面语言可能已经切过)。没有 refused 标记时原样返回。 */
export function refusedBody(content: string, refused: boolean | undefined): string {
  if (!refused) return content
  for (const n of [SAFETY_STOP_NOTICE.zh, SAFETY_STOP_NOTICE.en]) {
    if (content.endsWith(n)) return content.slice(0, -n.length).trimEnd()
  }
  return content
}
