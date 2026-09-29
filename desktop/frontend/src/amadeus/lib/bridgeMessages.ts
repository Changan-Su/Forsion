/**
 * Web / 移动端 Amadeus 写通道(cloudBridge / cloudHttp / unitBridge / mobileAmadeusBridge)的提示与报错文案。
 *
 * 这些串出现在最可能丢数据的时刻(冲突、别处改名 / 删除、写失败),以前一律写死中文,英文用户看不懂(评审 G2-14)。
 * 报错在**抛出那一刻**用 translate() 按当前界面语言取词;toast 同理。web 与移动端都经 `@/amadeus/lib/bridgeMessages`
 * 引入本表(`@` 在 web / mobile 构建与 desktop vitest 里都解析到 desktop/frontend/src;`@webamadeus` 只有移动端认),
 * 同名同义的报错只登记一份。仪器:desktop 的 i18nCoverage(A/B/C/D 收片段,I 断言禁汉字字面量)。
 */
import { registerMessages } from '@/i18n'

registerMessages({
  // ── 名称与路径校验(web / 移动端共用)──────────────────────────────────────
  'amxbridge.pageNameEmpty': { zh: '页面名不能为空', en: "Page name can't be empty" },
  'amxbridge.pageExists': { zh: '目标页面已存在', en: 'A page with that name already exists' },
  'amxbridge.fileExistsAtTarget': { zh: '目标位置已存在同名文件', en: 'A file with the same name already exists there' },
  'amxbridge.folderNameEmpty': { zh: '文件夹名不能为空', en: "Folder name can't be empty" },
  'amxbridge.folderExists': { zh: '同名文件夹已存在', en: 'A folder with the same name already exists' },
  'amxbridge.folderPathEmpty': { zh: '文件夹路径不能为空', en: "Folder path can't be empty" },
  'amxbridge.moveIntoSelf': { zh: '不能移动到自身内部', en: "Can't move a folder into itself" },
  'amxbridge.folderExistsAtTarget': { zh: '目标位置已存在同名文件夹', en: 'A folder with the same name already exists there' },
  'amxbridge.noteNameEmpty': { zh: '笔记名不能为空', en: "Note name can't be empty" },
  'amxbridge.noteExists': { zh: '目标笔记已存在', en: 'A note with that name already exists' },
  'amxbridge.nameEmpty': { zh: '名称不能为空', en: "Name can't be empty" },
  'amxbridge.fileExists': { zh: '目标文件已存在', en: 'A file with that name already exists' },
  // ── 云端桥(web)────────────────────────────────────────────────────────────
  'amxbridge.desktopOnly': { zh: '此操作仅桌面端可用', en: 'This action is only available in the desktop app' },
  'amxbridge.conflictReloaded': { zh: '云端已有更新，已加载最新版本（本次未保存的修改被覆盖）', en: 'A newer version was in the cloud, so it was loaded (your unsaved edits were overwritten)' },
  'amxbridge.renamedElsewhere': { zh: '这篇笔记已在别处改名为「{name}」，本次修改已保存到新名字', en: 'This note was renamed to “{name}” elsewhere; your edits were saved under the new name' },
  'amxbridge.deletedElsewhere': { zh: '这篇笔记已在别处被删除或移走，本次修改没有写到云端（请另存为新笔记）', en: "This note was deleted or moved elsewhere, so your edits weren't saved to the cloud (save them as a new note)" },
  'amxbridge.deletedElsewhereSaved': { zh: '这篇笔记已在别处被删除或移走，本端未保存的修改已另存为「{name}」', en: 'This note was deleted or moved elsewhere; your unsaved edits were saved as “{name}”' },
  'amxbridge.connectFailed': { zh: '云端连接失败，内容可能不是最新 —— 请刷新页面', en: 'Lost the connection to the cloud, so content may be out of date — please refresh the page' },
  'amxbridge.tooLarge': { zh: '笔记过大，云端拒绝保存', en: 'The note is too large for the cloud to save' },
  'amxbridge.imageNameFailed': { zh: '无法为图片分配文件名', en: "Couldn't pick a file name for the image" },
  'amxbridge.attachmentNameFailed': { zh: '无法为附件分配文件名', en: "Couldn't pick a file name for the attachment" },
  'amxbridge.invalidPath': { zh: '无效路径', en: 'Invalid path' },
  'amxbridge.trashMissing': { zh: '回收站条目不存在', en: 'This item is no longer in the trash' },
  'amxbridge.pathOutsideVault': { zh: '路径越出智库', en: 'The path is outside the vault' },
  'amxbridge.readFailed': { zh: '读取文件失败（HTTP {status}）', en: "Couldn't read the file (HTTP {status})" },
  'amxbridge.notText': { zh: '不是文本文件', en: 'Not a text file' },
  'amxbridge.timeout': { zh: '请求超时（{s}s），请检查网络后重试', en: 'The request timed out ({s}s). Check your network and try again' },
  'amxbridge.network': { zh: '网络错误：{msg}', en: 'Network error: {msg}' },
  // ── 设备桥(web 打开另一台设备的智库)──────────────────────────────────────────
  'amxbridge.deviceTimeout': { zh: '设备请求超时，请检查与对方设备的连接', en: "The device didn't respond in time. Check the connection to it" },
  'amxbridge.deviceUnreachable': { zh: '设备不可达：{msg}', en: "Can't reach the device: {msg}" },
  'amxbridge.deviceRevoked': { zh: '连接权限已被对方移除', en: 'The other device removed your access' },
  'amxbridge.deviceTooLarge': { zh: '内容过大：服务器中转通道上限 10MB，同一局域网内直连不受限', en: 'Too large: the server relay is limited to 10 MB (a direct connection on the same local network has no limit)' },
  'amxbridge.deviceHttpError': { zh: '设备端错误（HTTP {status}）', en: 'Device error (HTTP {status})' },
  'amxbridge.deviceCallFailed': { zh: '设备端调用失败', en: 'The call on the device failed' },
  'amxbridge.remoteOnly': { zh: '{what}：请在对方设备上操作', en: '{what}: do this on the other device' },
  'amxbridge.op.openPluginsFolder': { zh: '打开插件文件夹', en: 'Open plugins folder' },
  'amxbridge.op.scaffoldSamplePlugin': { zh: '创建示例插件', en: 'Create sample plugin' },
  'amxbridge.op.uninstallPlugin': { zh: '卸载插件', en: 'Uninstall plugin' },
  'amxbridge.op.reveal': { zh: '在文件管理器中显示', en: 'Show in file manager' },
})
