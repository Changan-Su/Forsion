/**
 * 「设置 › 远程会话」与设备切换器子开关的文案(P1 · K4)。模块级 registerMessages,不进 i18n.tsx 主字典;
 * 设置页、UnitSwitcher、settingsSearchIndex 共用。审批档名复用主字典的 approval.mode.*。
 * G9:开关只管 /engine(Agent 会话);主机文件与智库的远端面维持 P0 现状 —— 文案必须写明。
 */
import { registerMessages } from '../i18n'

registerMessages({
  'remoteSessions.tab': { zh: '远程会话', en: 'Remote sessions' },
  'remoteSessions.page': { zh: '允许你的手机或其他电脑在这台电脑上运行 Agent 会话。', en: 'Let your phone or other computers run Agent sessions on this computer.' },
  'remoteSessions.switch': { zh: '允许远程会话', en: 'Allow remote sessions' },
  'remoteSessions.switchHint': {
    zh: '关闭时，其他设备仍可查看会话、回答审批和停止任务，但不能新建或继续会话。关闭不会停止正在运行的任务。',
    en: "When off, other devices can still view sessions, answer approvals and stop tasks, but can't start or continue sessions. Turning it off doesn't stop tasks that are already running.",
  },
  'remoteSessions.needHost': { zh: '先在设备切换器里打开「允许其他设备连接本机」。', en: 'Turn on "Allow other devices to connect" in the device switcher first.' },
  'remoteSessions.insecure': {
    zh: '这台电脑的设备凭据还没有加密保存，暂时无法开启远程会话。',
    en: "This computer's device credentials aren't stored encrypted yet, so remote sessions can't be turned on.",
  },
  'remoteSessions.scope': {
    zh: '这个开关只管 Agent 会话，不影响其他设备浏览这台电脑上的文件和智库：只要「允许其他设备连接本机」开着，已配对的设备和登录同一账号的设备仍可以浏览工作目录里的文件、读写智库。',
    en: 'This switch only covers Agent sessions. It doesn\'t change how other devices browse files and the vault on this computer: while "Allow other devices to connect" is on, paired devices and devices signed in to the same account can still browse files in working folders and read and write the vault.',
  },
  'remoteSessions.cap': { zh: '远程会话最高审批档', en: 'Highest approval mode for remote sessions' },
  'remoteSessions.capHint': {
    zh: '所有来自其他设备的会话（包括设备页）都不会超过这一档，只能在这台电脑上修改。',
    en: 'Sessions started from other devices, including the device page, never go above this mode. It can only be changed on this computer.',
  },
  'remoteSessions.capDesc.readonly': { zh: '改文件和执行命令都要逐条批准。', en: 'Changing files and running commands both need approval.' },
  'remoteSessions.capDesc.autoEdit': { zh: '在工作区里改文件不用问，执行命令仍要批准。', en: 'Editing files in the workspace is automatic. Commands still need approval.' },
  'remoteSessions.capDesc.fullAuto': { zh: '改文件和执行命令都不再逐条询问。', en: "File changes and commands aren't checked one by one." },
  'remoteSessions.fullAutoTitle': { zh: '「全自动」下，审批不再保证来自真人', en: 'With Full auto, approvals are no longer guaranteed to come from a person' },
  'remoteSessions.fullAutoWarn': {
    zh: '「全自动」下，远程会话里的命令不再逐条询问。Agent 能以你的身份读写这台电脑上未被硬性保护的文件、调用本机接口，甚至可能替你批准它自己的请求。只在你完全信任所有已允许的设备并了解风险时使用。',
    en: "With Full auto, commands in remote sessions are no longer checked one by one. The Agent can read and write any file on this computer that isn't hard-protected, call local services as you, and could even approve its own requests. Use it only if you fully trust every allowed device and understand the risk.",
  },
  'remoteSessions.fullAutoAck': { zh: '我了解风险', en: 'I understand the risk' },
  'remoteSessions.fullAutoConfirm': { zh: '改为全自动', en: 'Switch to Full auto' },
  'remoteSessions.cancel': { zh: '取消', en: 'Cancel' },
  'remoteSessions.trusted': { zh: '已允许的设备', en: 'Allowed devices' },
  'remoteSessions.trustedHint': {
    zh: '其他设备第一次请求在这台电脑上运行会话时，这台电脑会弹框让你确认。撤销一台设备后，它下次请求时会再次询问。',
    en: "The first time another device asks to run sessions here, this computer asks you to confirm. If you revoke a device, you'll be asked again the next time it asks.",
  },
  'remoteSessions.trustedEmpty': { zh: '还没有设备。其他设备第一次请求时，这台电脑会弹框让你确认。', en: 'No devices yet. The first time another device asks, this computer shows a prompt for you to confirm.' },
  'remoteSessions.account': { zh: '本账号的浏览器与网页版', en: "This account's browsers and web app" },
  'remoteSessions.accountDesc': {
    zh: '浏览器里打开的设备页、Forsion 网页版、旧版 App 和 P2P 连接认不出具体设备，共用这一条。撤销后，它们只能查看、回答审批和停止任务，这台电脑也不会再弹框询问，直到你在这里重新允许。',
    en: "Device pages opened in a browser, the Forsion web app, older app versions and P2P connections can't be told apart, so they share this entry. After you revoke it, they can only view, answer approvals and stop tasks, and this computer stops asking until you allow them here again.",
  },
  'remoteSessions.accountStrictDesc': {
    zh: '已撤销。浏览器里打开的设备页、Forsion 网页版、旧版 App 和 P2P 连接只能查看、回答审批和停止任务，这台电脑不会再弹框询问。',
    en: "Revoked. Device pages opened in a browser, the Forsion web app, older app versions and P2P connections can only view, answer approvals and stop tasks, and this computer won't ask again.",
  },
  'remoteSessions.accountNoneDesc': {
    zh: '还没有允许。浏览器里打开的设备页、Forsion 网页版和旧版 App 第一次在这里运行会话时，这台电脑会弹框询问；P2P 连接不会弹框，只能在这里允许。',
    en: "Not allowed yet. The first time a device page opened in a browser, the Forsion web app or an older app version tries to run a session here, this computer asks you. P2P connections don't ask, so you can only allow them here.",
  },
  'remoteSessions.allow': { zh: '允许', en: 'Allow' },
  'remoteSessions.notSignedIn': { zh: '这台电脑还没有登录 Forsion 账号，暂时不能允许其他设备。', en: "This computer isn't signed in to Forsion, so it can't allow other devices yet." },
  'remoteSessions.preconfirmed': { zh: '更新时自动允许', en: 'Allowed automatically when Forsion updated' },
  'remoteSessions.confirmedAt': { zh: '允许于 {time}', en: 'Allowed {time}' },
  'remoteSessions.registeredAt': { zh: '首次登记 {date}', en: 'First registered {date}' },
  'remoteSessions.kind.phone': { zh: '手机', en: 'Phone' },
  'remoteSessions.kind.desktop': { zh: '电脑', en: 'Computer' },
  'remoteSessions.revoke': { zh: '撤销', en: 'Revoke' },
  'remoteSessions.pending': { zh: '等待确认', en: 'Waiting for confirmation' },
  'remoteSessions.pendingHint': { zh: '请在这台电脑弹出的对话框里选择。', en: 'Choose in the dialog on this computer.' },
  'remoteSessions.actionFailed': { zh: '没有保存：{error}', en: "Couldn't save: {error}" },
  'remoteSessions.loadFailed': { zh: '读取远程会话设置失败：{error}', en: "Couldn't load remote session settings: {error}" },
  'remoteSessions.retry': { zh: '重试', en: 'Retry' },
  'remoteSessions.openSettings': { zh: '设置', en: 'Settings' },
})
