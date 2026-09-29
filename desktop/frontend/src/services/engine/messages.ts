/**
 * 引擎目标层的用户可见文案(P1-K6 S2)。叶子模块:targets / health / 服务层都要用,放在一处免得互相 import 成环。
 * 规格 K6 §4.1 的 i18n 键表;{name} 是设备名(不可信串,只进文本节点)。
 */
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'engine.target.offline': { zh: '「{name}」不在线，恢复连接后会自动继续', en: '"{name}" is offline. This will resume when it reconnects' },
  'engine.target.engineUnavailable': { zh: '「{name}」在线，但 Forsion 引擎没有运行', en: '"{name}" is online, but its Forsion engine isn\'t running' },
  'engine.target.engineAuth': { zh: '「{name}」拒绝了连接凭据，请在那台电脑上重新登录 Forsion', en: '"{name}" rejected the connection. Sign in to Forsion again on that computer' },
  'engine.target.gone': { zh: '找不到这台设备，它可能已从你的账号移除', en: 'This device can\'t be found. It may have been removed from your account' },
  'engine.target.rateLimited': { zh: '请求太频繁，稍后自动重试', en: 'Too many requests. Retrying shortly' },
  'engine.target.tooLarge': { zh: '文件太大，无法经云端中转发送（单次上限约 9MB）', en: 'This file is too large to send through the cloud relay (about 9 MB per request)' },
  'engine.target.unsupported': { zh: '这台设备上不能在其他电脑上运行', en: 'Running on another computer isn\'t available on this device' },
  'engine.target.callerUnavailable': { zh: '「{name}」没能确认这台设备的身份，请求没有发出', en: '"{name}" couldn\'t confirm this device\'s identity, so the request wasn\'t sent' },
  'engine.target.refused': { zh: '「{name}」拒绝了这次远程请求', en: '"{name}" refused this remote request' },
  'engine.target.connecting': { zh: '正在连接「{name}」…', en: 'Connecting to "{name}"…' },
  'engine.target.fallbackHome': { zh: '已切回本端', en: 'Switched back to this device' },
  'engine.target.composerWaiting': { zh: '等待「{name}」连上…', en: 'Waiting for "{name}" to connect…' },
  /** 名册里没有名字时的兜底称呼(持久化的焦点只带 id)。 */
  'engine.target.defaultName': { zh: '你的电脑', en: 'your computer' },
})

export { translate }
