/** 「收件箱是空的」这份文案:主区阅读面板(InboxReaderView)和手机整屏列表(inboxListSource → hostListEmpty)共用一份。 */
import { registerMessages } from '../../i18n'

registerMessages({
  'inbox.reader.emptyTitle': { zh: '收件箱是空的', en: 'Your inbox is empty' },
  // 两端都一样、不单点 Muse(Muse 也是 Agent;手机上没有 Muse)。
  'inbox.reader.emptyLine': { zh: 'Agent 的汇报和等你批准的请求会送到这里。', en: 'Reports from your agents and requests waiting for your approval land here.' },
})
