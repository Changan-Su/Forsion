/**
 * 「设置 › 远程会话 › 急停与远程锁定」的文案(P1 · K2)。模块级 registerMessages,不进 i18n.tsx 主字典;
 * RemoteSafetyPanel 与 settingsSearchIndex 共用(同 K4 的 remoteSessionsCopy.ts)。
 */
import { registerMessages } from '../i18n'

registerMessages({
  'remoteSafety.title': { zh: '急停与远程锁定', en: 'Emergency stop and remote lock' },
  'remoteSafety.hint': {
    zh: '急停会中止这台电脑上所有不是你在键盘前发起的任务（远程会话、消息通道、Muse 与自动化）、结束它们的后台进程，并锁定远程访问，直到你在这台电脑上解锁。',
    en: "Emergency stop ends every task on this computer that you didn't start at the keyboard (remote sessions, messaging channels, Muse and automations), ends their background processes, and locks remote access until you unlock it on this computer.",
  },
  'remoteSafety.access': { zh: '远程访问', en: 'Remote access' },
  'remoteSafety.unlocked': { zh: '未锁定', en: 'Not locked' },
  'remoteSafety.lockedAt': { zh: '已锁定 · {time} · {source}', en: 'Locked · {time} · {source}' },
  'remoteSafety.source.hotkey': { zh: '快捷键', en: 'shortcut' },
  'remoteSafety.source.tray': { zh: '菜单栏', en: 'menu bar' },
  'remoteSafety.source.settings': { zh: '设置', en: 'Settings' },
  'remoteSafety.lockedDesc': { zh: '其他设备现在只能查看和停止任务，不能新建、继续、批准或修改任何东西。', en: 'Other devices can only view and stop tasks now. They can’t start, continue, approve or change anything.' },
  'remoteSafety.persistFailed': { zh: '锁定状态没能写入磁盘，退出 Forsion 前请保持它运行，或再急停一次。', en: 'The lock couldn’t be saved to disk. Keep Forsion running, or press emergency stop again.' },
  'remoteSafety.pendingEstop': { zh: '引擎暂不可达，急停会在它恢复后自动补发。', en: 'The engine is unreachable right now. The stop will be sent again once it’s back.' },
  'remoteSafety.estopNow': { zh: '立即急停', en: 'Emergency stop' },
  'remoteSafety.unlock': { zh: '解锁…', en: 'Unlock…' },
  'remoteSafety.unlockHint': { zh: '解锁需要在这台电脑上验证身份（Touch ID 或登录密码）。', en: 'Unlocking asks you to verify on this computer (Touch ID or your login password).' },
  'remoteSafety.unlock.cancelled': { zh: '已取消，远程访问仍锁定。', en: 'Cancelled. Remote access is still locked.' },
  'remoteSafety.unlock.unavailable': { zh: '这台电脑没法完成身份验证，远程访问仍锁定。', en: 'This computer couldn’t verify you. Remote access is still locked.' },
  'remoteSafety.unlock.failed': { zh: '验证没有通过或没能保存，远程访问仍锁定。', en: 'Verification failed or couldn’t be saved. Remote access is still locked.' },
  'remoteSafety.hotkey': { zh: '急停快捷键', en: 'Emergency stop shortcut' },
  'remoteSafety.hotkeyOk': { zh: '在任何 App 里按下都能急停。', en: 'Works from any app.' },
  'remoteSafety.hotkey.in_use': { zh: '快捷键被占用，急停只能从菜单栏或这里使用。', en: 'This shortcut is taken by another app. Use the menu bar or this page to stop.' },
  'remoteSafety.hotkey.invalid': { zh: '这个组合键不能用作快捷键，急停只能从菜单栏或这里使用。', en: 'This key combination can’t be used. Use the menu bar or this page to stop.' },
  'remoteSafety.hotkey.disabled': { zh: '已关闭，急停只能从菜单栏或这里使用。', en: 'Off. Use the menu bar or this page to stop.' },
  'remoteSafety.hotkeyNone': { zh: '未设置', en: 'None' },
  'remoteSafety.change': { zh: '更改', en: 'Change' },
  'remoteSafety.recording': { zh: '按下新的组合键…', en: 'Press a new shortcut…' },
  'remoteSafety.recordingHint': { zh: '至少按两个修饰键，按 Esc 取消。', en: 'Use at least two modifier keys. Press Esc to cancel.' },
  'remoteSafety.turnOff': { zh: '关闭', en: 'Turn off' },
  'remoteSafety.reset': { zh: '恢复默认', en: 'Reset' },
  'remoteSafety.running': { zh: '运行中的远程任务', en: 'Remote tasks running' },
  'remoteSafety.runningEmpty': { zh: '现在没有远程任务在运行。', en: 'No remote tasks are running.' },
  'remoteSafety.startedAt': { zh: '开始于 {time}', en: 'Started {time}' },
  'remoteSafety.waiting': { zh: '等你处理', en: 'Waiting for you' },
  'remoteSafety.stop': { zh: '停止', en: 'Stop' },
  'remoteSafety.keepAwake': {
    zh: '远程任务运行期间会阻止电脑闲置休眠（合盖仍会休眠）。锁定期间，本机的 Muse、盯任务规则和 Agent 日程也会暂停，解锁后恢复。',
    en: 'While a remote task runs, this computer won’t go to sleep when idle (closing the lid still sleeps it). While locked, Muse, watch rules and Agent schedules on this computer also pause until you unlock.',
  },
  'remoteSafety.loadFailed': { zh: '读取急停状态失败：{error}', en: 'Couldn’t load emergency stop status: {error}' },
  'remoteSafety.actionFailed': { zh: '操作失败：{error}', en: 'That didn’t work: {error}' },
})
