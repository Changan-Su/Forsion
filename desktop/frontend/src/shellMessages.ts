/** 外壳(Ribbon Space 钮 / 状态栏)的文案片段。模块级注册:用到这些键的文件 import 本文件即可
 *  (i18nCoverage 按 `registerMessages(` 字面量扫片段,zh/en 必须成对)。 */
import { registerMessages } from './i18n'

registerMessages({
  // Ribbon 上 Space 钮的可访问名(有未读时):唯一的文本子节点是角标数字,读屏会只念「1」。
  'ribbon.spaceUnread': { zh: '{name}，{n} 条未读', en: '{name}, {n} unread' },
  // 状态栏:可点项的悬停说明(点了会发生什么)
  'sb.switchSpace': { zh: '切换 Space', en: 'Switch Space' },
  'sb.clickToSync': { zh: '点击立即同步', en: 'Click to sync now' },
  'sb.openBacklinks': { zh: '打开反向链接', en: 'Open backlinks' },
  'sb.label': { zh: '状态栏', en: 'Status bar' },
})
