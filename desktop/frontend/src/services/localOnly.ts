/**
 * 「只许本机」提示(设备能力 MCP 方案 §6.6)。设备页 = 别的设备经隧道 / P2P / 局域网打开本机曝出的网页;
 * 它调到远端不许用的引擎路由(装插件、改通道配置…)或不可逆的 vault 删除时,本机 unitWeb 回
 * 403 `{ code: 'LOCAL_ONLY' }`。共享渲染层(backendService.request、设备页 vault 桥)据 code 换成这句本地化提示,
 * 而不是把 unitWeb 那句英文 detail 原样上屏。
 */
import { registerMessages, translate } from '../i18n'

registerMessages({
  'unitpage.localOnly': {
    zh: '该操作只能在那台设备本机上进行，远程连接不可用',
    en: 'This action is only available on that device itself, not over a remote connection',
  },
})

export const LOCAL_ONLY_CODE = 'LOCAL_ONLY'

export function localOnlyMessage(): string {
  return translate('unitpage.localOnly')
}
