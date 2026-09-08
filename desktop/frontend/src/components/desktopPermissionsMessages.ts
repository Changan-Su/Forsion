import { registerMessages } from '../i18n'

registerMessages({
  'desktopPermissions.title': { zh: '设备权限', en: 'Device permissions' },
  'desktopPermissions.description': {
    zh: '按需开启电脑操作或媒体权限，也可以稍后到设置 → 系统 → 设备权限中处理。',
    en: 'Enable computer control or media access as needed. You can return later in Settings → System → Device permissions.',
  },
  'desktopPermissions.later': { zh: '稍后设置', en: 'Set up later' },
  'desktopPermissions.optional': {
    zh: '所有权限都可稍后设置；只需开启你要使用的功能。',
    en: 'Every permission can wait. Enable only the features you want to use.',
  },
  'desktopPermissions.loading': { zh: '正在读取权限状态…', en: 'Reading permission status…' },
  'desktopPermissions.refresh': { zh: '刷新状态', en: 'Refresh status' },
  'desktopPermissions.readFailed': {
    zh: '无法读取最新权限状态。已有结果可能已过期；这不代表权限被拒绝。',
    en: 'Could not read the latest permissions. Any shown status may be out of date; this does not mean access was denied.',
  },
  'desktopPermissions.actionFailed': { zh: '操作未完成，请重试。', en: 'The action could not be completed. Please retry.' },
  'desktopPermissions.retryRead': { zh: '重试读取', en: 'Retry status check' },
  'desktopPermissions.retryAction': { zh: '重试操作', en: 'Retry action' },
  'desktopPermissions.requesting': { zh: '正在打开授权引导…', en: 'Opening permission setup…' },
  'desktopPermissions.installing': { zh: '正在准备 Computer Use 并打开引导…', en: 'Preparing Computer Use and opening setup…' },
  'desktopPermissions.verifying': { zh: '正在验证 Computer Use 权限…', en: 'Verifying Computer Use permissions…' },
  'desktopPermissions.openSettings': { zh: '打开系统设置', en: 'Open system settings' },
  'desktopPermissions.request': { zh: '设置权限', en: 'Set up permission' },
  'desktopPermissions.install': { zh: '安装并设置权限', en: 'Install and set up access' },
  'desktopPermissions.start': { zh: '启动并设置权限', en: 'Start and set up access' },
  'desktopPermissions.verify': { zh: '验证 Computer Use 权限', en: 'Verify Computer Use permissions' },
  'desktopPermissions.verifySetupFirst': {
    zh: '请先点击上方的设置权限按钮，完成 Computer Use 安装、启动或修复，再验证权限。',
    en: 'First use a setup button above to install, start or repair Computer Use, then verify access.',
  },
  'desktopPermissions.verifyHint': {
    zh: '在系统设置中开启后，请点击验证。验证可能访问屏幕；刷新状态不会触发授权。',
    en: 'After enabling access in system settings, click Verify. Verification may access the screen; refreshing status will not request access.',
  },
  'desktopPermissions.computerTitle': { zh: 'Tangu Computer Use', en: 'Tangu Computer Use' },
  'desktopPermissions.computerMac': {
    zh: '让智能体查看屏幕并操作鼠标、键盘。请在 macOS「隐私与安全性」中为 tangu-computer-use 授权。',
    en: 'Let agents view the screen and control the mouse and keyboard. In macOS Privacy & Security, grant access to tangu-computer-use.',
  },
  'desktopPermissions.computerWindows': {
    zh: '通过 tangu-computer-use 让智能体查看屏幕并操作鼠标、键盘。Windows 无需额外的 macOS 辅助功能或屏幕录制授权。',
    en: 'Let agents view the screen and control the mouse and keyboard through tangu-computer-use. Windows needs no extra macOS Accessibility or Screen Recording permissions.',
  },
  'desktopPermissions.windowsLimit': {
    zh: 'Windows 的安全桌面、UAC 提示和权限更高的应用可能无法被操作；系统策略也可能限制屏幕访问。',
    en: 'Windows may prevent control of the secure desktop, UAC prompts and apps running with higher privileges. System policies may also restrict screen access.',
  },
  'desktopPermissions.helperMissing': {
    zh: 'Computer Use 尚未安装。点击设置权限时会安装、启动，并打开授权指导窗。',
    en: 'Computer Use is not installed. Setting up access will install and start it, then open a permission guide.',
  },
  'desktopPermissions.helperStopped': {
    zh: 'Computer Use 尚未运行。点击设置权限可启动并打开授权指导窗。',
    en: 'Computer Use is not running. Setting up access will start it and open a permission guide.',
  },
  'desktopPermissions.helper.outdated': {
    zh: 'Computer Use 需要更新。请重新设置权限以更新并启动它；当前状态不代表权限被拒绝。',
    en: 'Computer Use needs an update. Set up access again to update and start it; this is not a permission denial.',
  },
  'desktopPermissions.helper.wrong-identity': {
    zh: '无法确认 Computer Use 的授权主体。请重新设置权限；不要将当前状态视为已授权或已拒绝。',
    en: 'The Computer Use permission identity could not be confirmed. Set up access again; the current status does not confirm a grant or a denial.',
  },
  'desktopPermissions.helper.unreachable': {
    zh: '暂时无法连接 Computer Use。可以刷新状态或重新设置权限；这不代表权限被拒绝。',
    en: 'Computer Use could not be reached. Refresh the status or set up access again; this does not mean access was denied.',
  },
  'desktopPermissions.mediaTitle': { zh: '{app} · 可选权限', en: '{app} · Optional permissions' },
  'desktopPermissions.mediaDescription': {
    zh: '这些权限授予 {app}，与 tangu-computer-use 的电脑操作权限相互独立。',
    en: 'These permissions belong to {app}, separately from computer control access for tangu-computer-use.',
  },
  'desktopPermissions.mediaMac': {
    zh: '在 macOS「隐私与安全性」中选择对应权限，为 {app} 开启。',
    en: 'In macOS Privacy & Security, choose the relevant permission and enable it for {app}.',
  },
  'desktopPermissions.mediaWindows': {
    zh: '在 Windows 隐私设置中按用途允许桌面应用访问。部分权限会在实际使用时确认。',
    en: 'Allow desktop app access as needed in Windows privacy settings. Some permissions are confirmed when you use the feature.',
  },
  'desktopPermissions.mediaOther': {
    zh: '可用权限由当前系统和桌面环境决定，部分权限会在实际使用时确认。',
    en: 'Available permissions depend on your operating system and desktop environment. Some are confirmed when you use the feature.',
  },
  'desktopPermissions.computerAccessibility.title': { zh: '辅助功能', en: 'Accessibility' },
  'desktopPermissions.computerAccessibility.hint': { zh: '允许 tangu-computer-use 点击、输入和操作其他应用。', en: 'Allow tangu-computer-use to click, type and control other apps.' },
  'desktopPermissions.computerScreen.title': { zh: '屏幕访问', en: 'Screen access' },
  'desktopPermissions.computerScreen.hint': { zh: '允许 tangu-computer-use 查看屏幕，理解当前界面。', en: 'Allow tangu-computer-use to view the screen and understand the current interface.' },
  'desktopPermissions.microphone.title': { zh: '麦克风', en: 'Microphone' },
  'desktopPermissions.microphone.hint': { zh: '用于语音输入、录音和通话，仅在你使用这些功能时需要。', en: 'For voice input, recording and calls, only when you use those features.' },
  'desktopPermissions.camera.title': { zh: '摄像头', en: 'Camera' },
  'desktopPermissions.camera.hint': { zh: '用于拍照和视频通话，普通文字对话不需要。', en: 'For taking photos and video calls. Text conversations do not need it.' },
  'desktopPermissions.screen.title': { zh: '屏幕录制与共享', en: 'Screen recording and sharing' },
  'desktopPermissions.screen.hint': { zh: '用于 Forsion 内的屏幕共享或录屏，不会替代 Computer Use 的屏幕权限。', en: 'For screen sharing or recording in Forsion. This does not grant screen access to Computer Use.' },
  'desktopPermissions.unverifiedHint': {
    zh: '系统预检已开启，尚未验证实际屏幕访问。请点击「验证 Computer Use 权限」。',
    en: 'System preflight reports access enabled, but actual screen access has not been verified. Click Verify Computer Use permissions.',
  },
  'desktopPermissions.mediaUnverifiedHint': {
    zh: '系统预检已开启，实际访问仍需在使用此功能时确认。',
    en: 'System preflight reports access enabled. Actual access still needs confirmation when you use this feature.',
  },
  'desktopPermissions.state.granted': { zh: '已允许', en: 'Allowed' },
  'desktopPermissions.state.denied': { zh: '未允许', en: 'Not allowed' },
  'desktopPermissions.state.not-determined': { zh: '尚未设置', en: 'Not set up' },
  'desktopPermissions.state.restricted': { zh: '受系统限制', en: 'Restricted by system' },
  'desktopPermissions.state.unknown': { zh: '状态未知', en: 'Unknown' },
  'desktopPermissions.state.unverified': { zh: '待验证', en: 'Needs verification' },
  'desktopPermissions.state.unavailable': { zh: '当前不可用', en: 'Unavailable' },
  'desktopPermissions.state.not-required': { zh: '无需授权', en: 'Not required' },
})
