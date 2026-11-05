/** 卜算子第一次见面那几问的选项文案:私聊里那张卡(MuseCards)和首启引导「认识你的 Agents 团队」共用,单独成模块免得引导拖进聊天 chunk。 */
import { registerMessages } from '../../i18n'

registerMessages({
  'museCard.q.when': { zh: '什么时候能找你', en: 'When can I reach you?' },
  'museCard.when.anytime': { zh: '随时', en: 'Anytime' },
  'museCard.when.daytime': { zh: '白天 9–21 点', en: 'Daytime, 9:00–21:00' },
  'museCard.when.open': { zh: '只在我开着 Forsion 时', en: 'Only while Forsion is open' },
  'museCard.focus.schedule': { zh: '日程', en: 'Schedule' },
  'museCard.focus.study': { zh: '学习', en: 'Study' },
  'museCard.focus.projects': { zh: '项目', en: 'Projects' },
  'museCard.focus.inbox': { zh: '收件箱', en: 'Inbox' },
})
