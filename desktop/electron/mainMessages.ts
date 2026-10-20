/**
 * main.ts 与 amadeus/ipc.ts 自己撰写的原生界面文案(P1-K5 I2):局域网配对确认框、界面多次崩溃框、下载完成通知、
 * 系统选择框标题。取用一律 mt('main.…')(见 mainI18n.ts),调用时求值。
 * 别的包的主进程文案就近放在各自模块旁(键 `main.<模块>.*`),不往这里堆。
 */
import { defineMainMessages } from './mainI18n'

export const MAIN_MESSAGES = defineMainMessages({
  'main.pair.title': { zh: '设备连接请求', en: 'Device connection request' },
  'main.pair.message': { zh: '「{name}」（{ip}）请求连接本机 Forsion', en: '{name} ({ip}) wants to connect to Forsion on this computer' },
  'main.pair.detail': {
    zh: '对方屏幕上显示同一组配对码，核对一致再允许：\n\n配对码：{code}\n\n允许后对方可远程使用这台设备的 Forsion（含执行任务、读写本机智库）。',
    en: 'The other device shows a pairing code. Allow only if it matches:\n\nPairing code: {code}\n\nOnce allowed, it can use Forsion on this computer remotely, including running tasks and reading and writing your local vault.',
  },
  'main.pair.detailLocal': {
    zh: '来自这台电脑上的程序（比如浏览器里的 Forsion Clip），它那边显示同一组配对码，核对一致再允许：\n\n配对码：{code}\n\n允许后它可以读写本机智库，Tangu 也会通过它控制浏览器（不用再粘连接码）。',
    en: 'This comes from an app on this computer, such as Forsion Clip in your browser. It shows a pairing code. Allow only if it matches:\n\nPairing code: {code}\n\nOnce allowed, it can read and write your local vault, and Tangu can control the browser through it (no connect code to paste).',
  },
  'main.pair.allow': { zh: '允许', en: 'Allow' },
  'main.pair.doorbellTitle': { zh: 'Forsion Clip 想连接这台电脑', en: 'Forsion Clip wants to connect' },
  'main.pair.doorbellMessage': {
    zh: '允许后会打开「设置 › 设备 › 允许其他设备连接本机」并配好 Forsion Clip。同一网络里的其他设备也能来请求连接，每次都要你批准。',
    en: 'Allowing turns on Settings › Devices › Allow other devices to connect, and pairs Forsion Clip. Other devices on your network can then ask to connect too, and each one needs your approval.',
  },
  'main.pair.doorbellAllow': { zh: '允许并打开', en: 'Allow and turn on' },
  'main.pair.deny': { zh: '拒绝', en: 'Deny' },
  'main.crash.message': { zh: '界面多次崩溃', en: 'The window crashed repeatedly' },
  'main.crash.detail': { zh: '原因：{reason}\n可重新加载，或退出后重新打开 Forsion。', en: 'Reason: {reason}\nReload, or quit and reopen Forsion.' },
  'main.crash.reload': { zh: '重新加载', en: 'Reload' },
  'main.crash.quit': { zh: '退出', en: 'Quit' },
  'main.download.done': { zh: '下载完成', en: 'Download complete' },
  'main.dialog.pickWorkdir': { zh: '选择 Agent 工作目录', en: "Choose the Agent's working folder" },
  'main.dialog.pickPaths': { zh: '添加文件或文件夹', en: 'Add files or folders' },
  'main.dialog.export': { zh: '导出', en: 'Export' },
  'main.dialog.openVault': { zh: '打开智库文件夹', en: 'Open vault folder' },
})
