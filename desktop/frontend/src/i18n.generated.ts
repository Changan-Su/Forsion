/**
 * 自动汇总:全量翻译批次(14 个组件)产出的 i18n 片段。
 * 由 tangu-i18n-sweep workflow 生成,在 main.tsx 顶部 import 以在渲染前注册。
 * 勿手改;新增文案请加在对应组件并补到此处(或下次重跑批次)。
 */
import { registerMessages } from "./i18n"

registerMessages({
  "app.planArchived": {
    "zh": "计划已存档:{file}",
    "en": "Plan archived: {file}"
  },
  "app.eventStreamInterrupted": {
    "zh": "事件流中断",
    "en": "Event stream interrupted"
  },
  "app.sessionListLoadFail": {
    "zh": "会话列表加载失败:{e}",
    "en": "Failed to load session list: {e}"
  },
  "app.managedBackendStarting": {
    "zh": "托管后端启动中…",
    "en": "Managed backend starting…"
  },
  "app.managedBackendExited": {
    "zh": "托管后端已退出",
    "en": "Managed backend has exited"
  },
  "app.historyLoadFail": {
    "zh": "历史加载失败:{e}",
    "en": "Failed to load history: {e}"
  },
  "app.defaultWorkspace": {
    "zh": "Tangu 默认工作区",
    "en": "Tangu Default Workspace"
  },
  "app.cloudWorkspace": {
    "zh": "Cloud 工作区",
    "en": "Cloud Workspace"
  },
  "app.workspace": {
    "zh": "工作区",
    "en": "Workspace"
  },
  "app.createSessionFail": {
    "zh": "新建失败:{e}",
    "en": "Failed to create: {e}"
  },
  "app.renameFail": {
    "zh": "重命名失败:{e}",
    "en": "Failed to rename: {e}"
  },
  "app.operationFail": {
    "zh": "操作失败:{e}",
    "en": "Operation failed: {e}"
  },
  "app.deleteFail": {
    "zh": "删除失败:{e}",
    "en": "Failed to delete: {e}"
  },
  "app.cannotCreateSession": {
    "zh": "无法创建会话",
    "en": "Unable to create session"
  },
  "app.filesUploaded": {
    "zh": "已上传 {count} 个文件到工作区",
    "en": "Uploaded {count} file(s) to the workspace"
  },
  "app.workspaceUploadFail": {
    "zh": "工作区上传失败:{e}",
    "en": "Workspace upload failed: {e}"
  },
  "app.sendFail": {
    "zh": "发送失败:{e}",
    "en": "Failed to send: {e}"
  },
  "app.modelSwitchSaveFail": {
    "zh": "模型切换保存失败:{e}",
    "en": "Failed to save model switch: {e}"
  },
  "app.skillEnabled": {
    "zh": "技能已启用:{id}",
    "en": "Skill enabled: {id}"
  },
  "app.skillDisabled": {
    "zh": "技能已停用:{id}",
    "en": "Skill disabled: {id}"
  },
  "sidebar.running": {
    "zh": "运行中",
    "en": "Running"
  },
  "sidebar.unread": {
    "zh": "有新回复",
    "en": "New reply"
  },
  "sidebar.newChatIn": {
    "zh": "在「{name}」新建会话",
    "en": "New chat in \"{name}\""
  },
  "sidebar.addLocalWorkspace": {
    "zh": "添加本地工作区",
    "en": "Add local workspace"
  },
  "sidebar.archived": {
    "zh": "已归档 ({count})",
    "en": "Archived ({count})"
  },
  "sidebar.rename": {
    "zh": "重命名",
    "en": "Rename"
  },
  "sidebar.unarchive": {
    "zh": "取消归档",
    "en": "Unarchive"
  },
  "sidebar.archive": {
    "zh": "归档",
    "en": "Archive"
  },
  "sidebar.delete": {
    "zh": "删除",
    "en": "Delete"
  },
  "input.approval.readonly": {
    "zh": "只读·全审批",
    "en": "Read-only · Approve all"
  },
  "input.approval.autoEdit": {
    "zh": "自动编辑",
    "en": "Auto-edit"
  },
  "input.approval.fullAuto": {
    "zh": "全自动",
    "en": "Full-auto"
  },
  "input.thinking.off": {
    "zh": "思考·关",
    "en": "Thinking · Off"
  },
  "input.thinking.low": {
    "zh": "思考·浅",
    "en": "Thinking · Low"
  },
  "input.thinking.medium": {
    "zh": "思考·中",
    "en": "Thinking · Medium"
  },
  "input.thinking.high": {
    "zh": "思考·深",
    "en": "Thinking · High"
  },
  "input.thinkingShort.off": {
    "zh": "标准",
    "en": "Standard"
  },
  "input.thinkingShort.low": {
    "zh": "浅",
    "en": "Low"
  },
  "input.thinkingShort.medium": {
    "zh": "中",
    "en": "Medium"
  },
  "input.thinkingShort.high": {
    "zh": "深",
    "en": "High"
  },
  "input.slash.planOff": {
    "zh": "关闭计划模式",
    "en": "Turn off plan mode"
  },
  "input.slash.planOn": {
    "zh": "开启计划模式(只读调研 → 提交计划求批准)",
    "en": "Turn on plan mode (read-only research → submit plan for approval)"
  },
  "input.slash.thinkDesc": {
    "zh": "思考深度设为 {level}",
    "en": "Set thinking depth to {level}"
  },
  "input.slash.current": {
    "zh": "(当前)",
    "en": " (current)"
  },
  "input.slash.model": {
    "zh": "选择本会话模型…",
    "en": "Choose model for this session…"
  },
  "input.slash.new": {
    "zh": "新建会话",
    "en": "New session"
  },
  "input.slash.skills": {
    "zh": "打开设置管理技能",
    "en": "Open settings to manage skills"
  },
  "input.slash.skillEnable": {
    "zh": "启用技能 {name}",
    "en": "Enable skill {name}"
  },
  "input.slash.skillDisable": {
    "zh": "停用技能 {name}",
    "en": "Disable skill {name}"
  },
  "input.directPrefix": {
    "zh": "直连·",
    "en": "Direct · "
  },
  "input.tooLong": {
    "zh": "消息过长({len} 字符,上限 {max})——大段材料请保存为文件,让 agent 用工具按需读取,整段粘贴会按轮数翻倍烧 token。",
    "en": "Message too long ({len} chars, limit {max}) — save large material as a file and let the agent read it on demand with tools; pasting it inline burns tokens multiplied by the number of turns."
  },
  "input.skip.notImage": {
    "zh": "{name}(非图片)",
    "en": "{name} (not an image)"
  },
  "input.skip.tooBig": {
    "zh": "{name}(超 {mb}MB)",
    "en": "{name} (over {mb}MB)"
  },
  "input.skip.imageHint": {
    "zh": "已跳过:{items}。图片随消息发给模型;其他文件可直接拖进输入框(发送后进工作区)。",
    "en": "Skipped: {items}. Images are sent to the model with the message; other files can be dragged into the input box (they go to the workspace after sending)."
  },
  "input.skip.simple": {
    "zh": "已跳过:{items}",
    "en": "Skipped: {items}"
  },
  "input.planMode": {
    "zh": "计划模式",
    "en": "Plan mode"
  },
  "input.normal": {
    "zh": "常规",
    "en": "Normal"
  },
  "input.selectModel": {
    "zh": "选择模型",
    "en": "Select model"
  },
  "input.remove": {
    "zh": "移除",
    "en": "Remove"
  },
  "input.wsUploadTitle": {
    "zh": "发送后上传到工作区:{name}",
    "en": "Uploaded to workspace after sending: {name}"
  },
  "input.toWorkspace": {
    "zh": "→工作区",
    "en": "→ workspace"
  },
  "input.placeholderDisabled": {
    "zh": "先在设置里连接后端…",
    "en": "Connect a backend in settings first…"
  },
  "input.placeholder": {
    "zh": "输入消息,输入 / 唤起技能(Enter 发送,Shift+Enter 换行)",
    "en": "Type a message, type / to invoke skills (Enter to send, Shift+Enter for a new line)"
  },
  "input.addContent": {
    "zh": "添加内容",
    "en": "Add content"
  },
  "input.addImage": {
    "zh": "添加图片",
    "en": "Add image"
  },
  "input.otherFilesHint": {
    "zh": "其他文件请用右栏工作区上传",
    "en": "Upload other files via the workspace panel on the right"
  },
  "input.micComingSoon": {
    "zh": "语音输入即将上线",
    "en": "Voice input coming soon"
  },
  "input.stop": {
    "zh": "停止",
    "en": "Stop"
  },
  "input.send": {
    "zh": "发送",
    "en": "Send"
  },
  "input.modeChipTitle": {
    "zh": "模式:计划模式(只读调研→提交计划)与审批档(host)",
    "en": "Mode: plan mode (read-only research → submit plan) and approval level (host)"
  },
  "input.planModeOn": {
    "zh": "计划模式·已开",
    "en": "Plan mode · On"
  },
  "input.planModeEnable": {
    "zh": "开启计划模式",
    "en": "Turn on plan mode"
  },
  "input.approvalSection": {
    "zh": "审批档",
    "en": "Approval level"
  },
  "input.modelChipTitle": {
    "zh": "本会话模型与思考深度",
    "en": "Model and thinking depth for this session"
  },
  "input.thinkingSection": {
    "zh": "思考深度",
    "en": "Thinking depth"
  },
  "chat.emptyTitle": {
    "zh": "纸上得来终觉浅,绝知此事要躬行。",
    "en": "What's learned on paper stays shallow; true knowing comes from doing."
  },
  "chat.emptyHint": {
    "zh": "输入一句话,让 Tangu 开始干活。",
    "en": "Type a message to put Tangu to work."
  },
  "chat.thinking": {
    "zh": "思考中",
    "en": "Thinking"
  },
  "chat.aborted": {
    "zh": "已停止。",
    "en": "Stopped."
  },
  "chat.jumpToBottom": {
    "zh": "跳到底部",
    "en": "Jump to bottom"
  },
  "header.sidebar": {
    "zh": "侧栏",
    "en": "Sidebar"
  },
  "header.currentModel": {
    "zh": "当前模型",
    "en": "Current model"
  },
  "header.online": {
    "zh": "在线",
    "en": "Online"
  },
  "header.offline": {
    "zh": "离线",
    "en": "Offline"
  },
  "header.notConnected": {
    "zh": "未连接",
    "en": "Not connected"
  },
  "header.workspacePanel": {
    "zh": "工作区面板",
    "en": "Workspace panel"
  },
  "header.settings": {
    "zh": "设置",
    "en": "Settings"
  },
  "panel.tab.workspace": {
    "zh": "工作区",
    "en": "Workspace"
  },
  "panel.tab.toc": {
    "zh": "目录",
    "en": "Outline"
  },
  "panel.tab.memory": {
    "zh": "记忆",
    "en": "Memory"
  },
  "panel.back": {
    "zh": "返回",
    "en": "Back"
  },
  "panel.parentDir": {
    "zh": "..(上级目录)",
    "en": ".. (parent directory)"
  },
  "panel.emptyDir": {
    "zh": "空目录。",
    "en": "Empty directory."
  },
  "panel.sessionFiles": {
    "zh": "会话文件",
    "en": "Session files"
  },
  "panel.noFilesYet": {
    "zh": "暂无文件。agent 产出与拖入的文件都会出现在这里。",
    "en": "No files yet. Agent outputs and dropped files will appear here."
  },
  "panel.activityLog": {
    "zh": "活动日志",
    "en": "Activity log"
  },
  "panel.action.newFolder": {
    "zh": "新建文件夹",
    "en": "New folder"
  },
  "panel.action.openCurDirInFileManager": {
    "zh": "在文件管理器中打开当前目录",
    "en": "Open current directory in file manager"
  },
  "panel.action.refresh": {
    "zh": "刷新",
    "en": "Refresh"
  },
  "panel.action.create": {
    "zh": "创建",
    "en": "Create"
  },
  "panel.action.cancel": {
    "zh": "取消",
    "en": "Cancel"
  },
  "panel.action.confirm": {
    "zh": "确定",
    "en": "OK"
  },
  "panel.action.rename": {
    "zh": "重命名",
    "en": "Rename"
  },
  "panel.action.revealInFileManager": {
    "zh": "在文件管理器中显示",
    "en": "Reveal in file manager"
  },
  "panel.action.moveToTrash": {
    "zh": "移入回收站",
    "en": "Move to trash"
  },
  "panel.action.uploadFile": {
    "zh": "上传文件",
    "en": "Upload file"
  },
  "panel.action.download": {
    "zh": "下载",
    "en": "Download"
  },
  "panel.action.delete": {
    "zh": "删除",
    "en": "Delete"
  },
  "panel.placeholder.newFolderName": {
    "zh": "文件夹名(回车创建)",
    "en": "Folder name (Enter to create)"
  },
  "panel.preview.tooLarge": {
    "zh": "文件较大({size}),不在面板预览;请用编辑器打开或让 agent 按需读取。",
    "en": "File is large ({size}); not previewed in the panel. Open it in an editor or have the agent read it on demand."
  },
  "panel.preview.binaryNoPreview": {
    "zh": "二进制文件,无法在面板预览。",
    "en": "Binary file; cannot be previewed in the panel."
  },
  "panel.preview.binaryDownload": {
    "zh": "二进制文件,请下载查看。",
    "en": "Binary file; please download to view."
  },
  "panel.preview.decodeFailed": {
    "zh": "(解码失败)",
    "en": "(decode failed)"
  },
  "panel.confirm.trash": {
    "zh": "将「{name}」移入系统回收站?",
    "en": "Move \"{name}\" to the system trash?"
  },
  "panel.memory.title": {
    "zh": "长期记忆",
    "en": "Long-term memory"
  },
  "panel.memory.notConnected": {
    "zh": "(未连接云端大脑)",
    "en": "(not connected to the cloud brain)"
  },
  "panel.memory.empty": {
    "zh": "还没有记忆。对话中说「记住…」或在下方手动追加。",
    "en": "No memories yet. Say \"remember…\" in chat or add one manually below."
  },
  "panel.memory.appendPlaceholder": {
    "zh": "追加一条记忆…",
    "en": "Add a memory…"
  },
  "panel.memory.append": {
    "zh": "追加",
    "en": "Add"
  },
  "panel.log.empty": {
    "zh": "({date} 暂无日志)",
    "en": "(no log for {date})"
  },
  "panel.toast.listDirFail": {
    "zh": "目录读取失败:{err}",
    "en": "Failed to read directory: {err}"
  },
  "panel.toast.readFail": {
    "zh": "读取失败:{err}",
    "en": "Failed to read: {err}"
  },
  "panel.toast.renameFail": {
    "zh": "重命名失败:{err}",
    "en": "Rename failed: {err}"
  },
  "panel.toast.mkdirFail": {
    "zh": "新建文件夹失败:{err}",
    "en": "Failed to create folder: {err}"
  },
  "panel.toast.deleteFail": {
    "zh": "删除失败:{err}",
    "en": "Delete failed: {err}"
  },
  "panel.toast.workspaceLoadFail": {
    "zh": "工作区加载失败:{err}",
    "en": "Failed to load workspace: {err}"
  },
  "panel.toast.uploaded": {
    "zh": "已上传 {saved}/{total} 个文件",
    "en": "Uploaded {saved}/{total} files"
  },
  "panel.toast.uploadFail": {
    "zh": "上传失败:{err}",
    "en": "Upload failed: {err}"
  },
  "panel.toast.memoryLoadFail": {
    "zh": "记忆加载失败:{err}",
    "en": "Failed to load memory: {err}"
  },
  "panel.toast.memorySaved": {
    "zh": "已记入长期记忆",
    "en": "Saved to long-term memory"
  },
  "panel.toast.memoryNotWritten": {
    "zh": "未写入(重复或已满)",
    "en": "Not written (duplicate or full)"
  },
  "panel.toast.appendFail": {
    "zh": "写入失败:{err}",
    "en": "Failed to write: {err}"
  },
  "toc.emptyNote": {
    "zh": "暂无可跳转的内容。对话开始后,这里会列出每轮提问与回复中的小节标题。",
    "en": "Nothing to jump to yet. Once the conversation starts, each turn's questions and the section headings in the replies will be listed here."
  },
  "settings.title": {
    "zh": "设置",
    "en": "Settings"
  },
  "settings.tab.connection": {
    "zh": "连接",
    "en": "Connection"
  },
  "settings.tab.model": {
    "zh": "模型/Provider",
    "en": "Model / Provider"
  },
  "settings.tab.skills": {
    "zh": "技能",
    "en": "Skills"
  },
  "settings.tab.theme": {
    "zh": "主题",
    "en": "Theme"
  },
  "settings.tab.advanced": {
    "zh": "高级",
    "en": "Advanced"
  },
  "settings.btn.save": {
    "zh": "保存",
    "en": "Save"
  },
  "settings.btn.cancel": {
    "zh": "取消",
    "en": "Cancel"
  },
  "settings.btn.edit": {
    "zh": "编辑",
    "en": "Edit"
  },
  "settings.btn.delete": {
    "zh": "删除",
    "en": "Delete"
  },
  "settings.btn.testConnection": {
    "zh": "测试连接",
    "en": "Test connection"
  },
  "settings.btn.saveConnect": {
    "zh": "保存并连接",
    "en": "Save & connect"
  },
  "settings.toast.saveFailed": {
    "zh": "保存失败:",
    "en": "Save failed: "
  },
  "settings.backend.modeLabel": {
    "zh": "后端模式",
    "en": "Backend mode"
  },
  "settings.backend.modeManaged": {
    "zh": "自动托管(内置)",
    "en": "Managed (built-in)"
  },
  "settings.backend.modeExternal": {
    "zh": "外部连接",
    "en": "External connection"
  },
  "settings.backend.saveRestart": {
    "zh": "保存并重启后端",
    "en": "Save & restart backend"
  },
  "settings.backend.restart": {
    "zh": "重启",
    "en": "Restart"
  },
  "settings.backend.staleDist": {
    "zh": "⚠ 服务端代码已重新构建,当前后端仍在跑旧版本 —— 点上方「重启」加载新代码。",
    "en": "⚠ Server code has been rebuilt, but the backend is still running the old version — click \"Restart\" above to load the new code."
  },
  "settings.backend.viewLogs": {
    "zh": "查看后端日志",
    "en": "View backend logs"
  },
  "settings.backend.noLogs": {
    "zh": "(暂无日志)",
    "en": "(no logs yet)"
  },
  "settings.backend.state.stopped": {
    "zh": "已停止",
    "en": "Stopped"
  },
  "settings.backend.state.starting": {
    "zh": "启动中…",
    "en": "Starting…"
  },
  "settings.backend.state.ready": {
    "zh": "运行中",
    "en": "Running"
  },
  "settings.backend.state.crashed": {
    "zh": "已崩溃",
    "en": "Crashed"
  },
  "settings.workspace.label": {
    "zh": "Tangu 默认工作区目录",
    "en": "Tangu default workspace directory"
  },
  "settings.workspace.placeholder": {
    "zh": "~/Tangu(默认,首启自动创建)",
    "en": "~/Tangu (default, created on first launch)"
  },
  "settings.workspace.pick": {
    "zh": "选择…",
    "en": "Choose…"
  },
  "settings.workspace.hint": {
    "zh": "侧栏「Tangu 默认工作区」新建会话用的本机目录;留空用 ~/Tangu。改后关闭设置即刷新侧栏工作区。",
    "en": "Local directory used by the sidebar \"Tangu default workspace\" for new sessions; leave empty to use ~/Tangu. After changing, close Settings to refresh the sidebar workspace."
  },
  "settings.token.label": {
    "zh": "手动 token(高级,可选;覆盖登录凭证)",
    "en": "Manual token (advanced, optional; overrides login credentials)"
  },
  "settings.token.placeholder": {
    "zh": "一般不需要,浏览器登录即可",
    "en": "Usually not needed — browser login is enough"
  },
  "settings.sandbox.label": {
    "zh": "代码沙箱",
    "en": "Code sandbox"
  },
  "settings.sandbox.auto": {
    "zh": "自动检测",
    "en": "Auto-detect"
  },
  "settings.sandbox.none": {
    "zh": "禁用",
    "en": "Disabled"
  },
  "settings.external.urlLabel": {
    "zh": "后端地址",
    "en": "Backend URL"
  },
  "settings.external.urlHint": {
    "zh": "tangu-server 的 HTTP 地址(本机或远程);可用环境变量 TANGU_BACKEND_URL 预设。",
    "en": "HTTP address of tangu-server (local or remote); can be preset via the TANGU_BACKEND_URL environment variable."
  },
  "settings.external.tokenLabel": {
    "zh": "访问令牌",
    "en": "Access token"
  },
  "settings.external.tokenPlaceholder": {
    "zh": "tangu-server --token 配置的值",
    "en": "Value configured by tangu-server --token"
  },
  "settings.model.defaultLabel": {
    "zh": "默认模型",
    "en": "Default model"
  },
  "settings.model.defaultPlaceholder": {
    "zh": "如 forsion 模型 id 或 ollama/llama3",
    "en": "e.g. a forsion model id or ollama/llama3"
  },
  "settings.model.defaultHintPrefix": {
    "zh": "直连 provider 支持 ",
    "en": "Direct providers support free-form "
  },
  "settings.model.defaultHintSuffix": {
    "zh": " 自由填写;其余走 Forsion 托管面。",
    "en": "; everything else goes through the Forsion managed plane."
  },
  "settings.model.availableLabel": {
    "zh": "可用模型",
    "en": "Available models"
  },
  "settings.model.loadFailed": {
    "zh": "模型列表加载失败",
    "en": "Failed to load model list"
  },
  "settings.model.cloudFetchError": {
    "zh": "⚠ 云端托管模型获取失败:",
    "en": "⚠ Failed to fetch cloud-managed models: "
  },
  "settings.model.directProviders": {
    "zh": "直连 provider:",
    "en": "Direct providers: "
  },
  "settings.provider.loginLabel": {
    "zh": "Provider 账号登录(用订阅账号当 LLM,直连不计 Forsion 额度)",
    "en": "Provider account login (use a subscription account as the LLM; direct calls don't count against Forsion quota)"
  },
  "settings.provider.loggedInSuffix": {
    "zh": " · 已登录(重新登录)",
    "en": " · Logged in (re-login)"
  },
  "settings.provider.loginHintPrefix": {
    "zh": "OAuth 浏览器登录,凭证存 ~/.tangu/provider-auth.json(与 `tangu login <provider>` 通用);托管后端会自动重启加载,之后用 ",
    "en": "OAuth browser login; credentials are stored in ~/.tangu/provider-auth.json (shared with `tangu login <provider>`). The managed backend restarts to load them automatically, after which you can use "
  },
  "settings.provider.loginHintSuffix": {
    "zh": "(如 xai/grok-3)即可。",
    "en": " (e.g. xai/grok-3)."
  },
  "settings.customProvider.sectionTitle": {
    "zh": "自定义 Provider(BYO-key 直连)",
    "en": "Custom provider (BYO-key direct connection)"
  },
  "settings.customProvider.label": {
    "zh": "自定义 Provider(BYO-key 直连;对齐 Forsion 模型添加:base_URL + api key)",
    "en": "Custom provider (BYO-key direct connection; same as adding a Forsion model: base_URL + api key)"
  },
  "settings.customProvider.introPrefix": {
    "zh": "配置存 ~/.tangu/providers.json,与 CLI ",
    "en": "Config is stored in ~/.tangu/providers.json, same format as the CLI "
  },
  "settings.customProvider.introMid": {
    "zh": " 同格式;托管模式保存后自动重启后端加载。模型用 ",
    "en": "; in managed mode the backend restarts to load it after saving. Pick a model with "
  },
  "settings.customProvider.introSuffix": {
    "zh": " 或白名单内的名字直接选。",
    "en": " or a name from the whitelist."
  },
  "settings.customProvider.modelCount": {
    "zh": "{count} 模型",
    "en": "{count} models"
  },
  "settings.customProvider.anyModel": {
    "zh": "前缀任意模型",
    "en": "any model under prefix"
  },
  "settings.customProvider.deleteConfirm": {
    "zh": "删除 provider「{id}」?",
    "en": "Delete provider \"{id}\"?"
  },
  "settings.customProvider.deletedReloading": {
    "zh": "已删除;托管后端重启加载中…",
    "en": "Deleted; managed backend is restarting to reload…"
  },
  "settings.customProvider.add": {
    "zh": "添加 Provider",
    "en": "Add provider"
  },
  "settings.customProvider.idLabel": {
    "zh": "Provider ID(也作模型前缀,如 ollama → ollama/llama3)",
    "en": "Provider ID (also the model prefix, e.g. ollama → ollama/llama3)"
  },
  "settings.customProvider.idPlaceholder": {
    "zh": "如 ollama / siliconflow / openai",
    "en": "e.g. ollama / siliconflow / openai"
  },
  "settings.customProvider.baseUrlLabel": {
    "zh": "Base URL(OpenAI 兼容端点根,含 /v1)",
    "en": "Base URL (OpenAI-compatible endpoint root, including /v1)"
  },
  "settings.customProvider.baseUrlPlaceholder": {
    "zh": "如 http://localhost:11434/v1 或 https://api.siliconflow.cn/v1",
    "en": "e.g. http://localhost:11434/v1 or https://api.siliconflow.cn/v1"
  },
  "settings.customProvider.apiKeyLabel": {
    "zh": "API Key(Ollama 等本地端点可空)",
    "en": "API Key (can be empty for local endpoints like Ollama)"
  },
  "settings.customProvider.modelsLabel": {
    "zh": "模型白名单(逗号分隔,可空)",
    "en": "Model whitelist (comma-separated, optional)"
  },
  "settings.customProvider.modelsPlaceholder": {
    "zh": "如 llama3, qwen2.5-coder",
    "en": "e.g. llama3, qwen2.5-coder"
  },
  "settings.customProvider.savedReloading": {
    "zh": "已保存;托管后端重启加载中…",
    "en": "Saved; managed backend is restarting to reload…"
  },
  "settings.customProvider.externalWarning": {
    "zh": "⚠ 当前为外部后端模式:这里编辑的是本机 ~/.tangu/providers.json,远程 tangu-server 不会读到。",
    "en": "⚠ Currently in external backend mode: this edits the local ~/.tangu/providers.json, which the remote tangu-server won't read."
  },
  "settings.mcp.label": {
    "zh": "MCP Server(配置存 ~/.tangu/mcp.json;保存后托管后端重启重连)",
    "en": "MCP Server (config stored in ~/.tangu/mcp.json; managed backend restarts and reconnects after saving)"
  },
  "settings.mcp.introPrefix": {
    "zh": "工具以 ",
    "en": "Tools appear as "
  },
  "settings.mcp.introSuffix": {
    "zh": " 出现;server 集在后端启动时冻结,变更只对重启后的新对话生效(上下文缓存会重建一次)。",
    "en": "; the server set is frozen when the backend starts, so changes only take effect for new conversations after a restart (the context cache is rebuilt once)."
  },
  "settings.mcp.statusDisabled": {
    "zh": "未启用",
    "en": "Disabled"
  },
  "settings.mcp.statusConnected": {
    "zh": "已连接 · {count} 工具",
    "en": "Connected · {count} tools"
  },
  "settings.mcp.statusError": {
    "zh": "连接失败",
    "en": "Connection failed"
  },
  "settings.mcp.statusNotLoaded": {
    "zh": "后端未加载(重启后生效)",
    "en": "Not loaded by backend (takes effect after restart)"
  },
  "settings.mcp.enable": {
    "zh": "启用",
    "en": "Enable"
  },
  "settings.mcp.disable": {
    "zh": "停用",
    "en": "Disable"
  },
  "settings.mcp.enabledMsg": {
    "zh": "已启用;重启后端后连接",
    "en": "Enabled; connects after the backend restarts"
  },
  "settings.mcp.disabledMsg": {
    "zh": "已停用;重启后端后断开",
    "en": "Disabled; disconnects after the backend restarts"
  },
  "settings.mcp.deleteConfirm": {
    "zh": "删除 MCP server「{name}」?",
    "en": "Delete MCP server \"{name}\"?"
  },
  "settings.mcp.deletedMsg": {
    "zh": "已删除",
    "en": "Deleted"
  },
  "settings.mcp.add": {
    "zh": "添加 MCP Server",
    "en": "Add MCP Server"
  },
  "settings.mcp.nameLabel": {
    "zh": "名称(工具前缀)",
    "en": "Name (tool prefix)"
  },
  "settings.mcp.namePlaceholder": {
    "zh": "如 filesystem / github",
    "en": "e.g. filesystem / github"
  },
  "settings.mcp.transportLabel": {
    "zh": "传输",
    "en": "Transport"
  },
  "settings.mcp.transportAuto": {
    "zh": "自动推断",
    "en": "Auto-detect"
  },
  "settings.mcp.commandLabel": {
    "zh": "命令(stdio;与 URL 二选一)",
    "en": "Command (stdio; choose either this or URL)"
  },
  "settings.mcp.urlLabel": {
    "zh": "URL(HTTP/SSE)",
    "en": "URL (HTTP/SSE)"
  },
  "settings.mcp.envLabel": {
    "zh": "环境变量(每行 KEY=VALUE,可空)",
    "en": "Environment variables (one KEY=VALUE per line, optional)"
  },
  "settings.mcp.savedReconnecting": {
    "zh": "已保存;托管后端重启重连中…",
    "en": "Saved; managed backend is restarting and reconnecting…"
  },
  "settings.theme.themeLabel": {
    "zh": "主题",
    "en": "Theme"
  },
  "settings.theme.modeLabel": {
    "zh": "明暗",
    "en": "Light / Dark"
  },
  "settings.theme.light": {
    "zh": "亮色",
    "en": "Light"
  },
  "settings.theme.dark": {
    "zh": "暗色",
    "en": "Dark"
  },
  "settings.theme.darkNightRead": {
    "zh": "(夜读)",
    "en": " (Night reading)"
  },
  "settings.theme.glassLabel": {
    "zh": "毛玻璃质感",
    "en": "Frosted glass"
  },
  "settings.theme.glassOn": {
    "zh": "开",
    "en": "On"
  },
  "settings.theme.glassOff": {
    "zh": "关(低配模式)",
    "en": "Off (low-power mode)"
  },
  "settings.skills.libraryLabel": {
    "zh": "技能库",
    "en": "Skill library"
  },
  "settings.skills.libraryHintPrefix": {
    "zh": "按来源渠道(agent 文件夹)分组。本地技能放 ",
    "en": "Grouped by source channel (agent folder). Put local skills in "
  },
  "settings.skills.libraryHintSuffix": {
    "zh": ";自动识别 ~/.claude/skills 与 ~/.codex/prompts(env TANGU_EXTERNAL_SKILLS=off 可关)。会话内启用在右侧面板或输入 /skill 命令;此处管理全局技能与云端同步。",
    "en": "; ~/.claude/skills and ~/.codex/prompts are auto-detected (set env TANGU_EXTERNAL_SKILLS=off to disable). Enable skills within a session from the right panel or the /skill command; this page manages global skills and cloud sync."
  },
  "settings.skills.loading": {
    "zh": "加载中…",
    "en": "Loading…"
  },
  "settings.skills.clickRefresh": {
    "zh": "点击刷新加载",
    "en": "Click refresh to load"
  },
  "settings.skills.empty": {
    "zh": "暂无技能。",
    "en": "No skills yet."
  },
  "settings.skills.loadFailed": {
    "zh": "技能列表加载失败:",
    "en": "Failed to load skill list: "
  },
  "settings.skills.uploadTitle": {
    "zh": "上传为本人云端技能(云端 Tangu 会话可用)",
    "en": "Upload as your own cloud skill (available in cloud Tangu sessions)"
  },
  "settings.skills.uploadBtn": {
    "zh": "上传云端",
    "en": "Upload to cloud"
  },
  "settings.skills.uploadOk": {
    "zh": "✓ 「{name}」已上传云端(id: {id})",
    "en": "✓ \"{name}\" uploaded to cloud (id: {id})"
  },
  "settings.skills.uploadFailed": {
    "zh": "上传失败:",
    "en": "Upload failed: "
  },
  "settings.skills.deleteTitle": {
    "zh": "删除本人云端技能",
    "en": "Delete your cloud skill"
  },
  "settings.skills.deleteConfirm": {
    "zh": "删除云端技能「{id}」?",
    "en": "Delete cloud skill \"{id}\"?"
  },
  "settings.skills.deleteOk": {
    "zh": "✓ 已删除",
    "en": "✓ Deleted"
  },
  "settings.skills.deleteFailed": {
    "zh": "删除失败:",
    "en": "Delete failed: "
  },
  "settings.skills.channel.local": {
    "zh": "本地",
    "en": "Local"
  },
  "settings.skills.channel.claude": {
    "zh": "Claude Code",
    "en": "Claude Code"
  },
  "settings.skills.channel.codex": {
    "zh": "Codex",
    "en": "Codex"
  },
  "settings.skills.channel.opencode": {
    "zh": "OpenCode",
    "en": "OpenCode"
  },
  "settings.skills.channel.user": {
    "zh": "已上云",
    "en": "Uploaded"
  },
  "settings.skills.channel.cloud": {
    "zh": "云端",
    "en": "Cloud"
  },
  "settings.skills.channel.other": {
    "zh": "其他",
    "en": "Other"
  },
  "settings.discovery.label": {
    "zh": "从其他 Agent 导入(Claude Code / Codex / Hermes)",
    "en": "Import from other agents (Claude Code / Codex / Hermes)"
  },
  "settings.discovery.hint": {
    "zh": "扫描本机 ~/.claude、~/.codex、~/.hermes 的技能与 MCP 配置,勾选后导入 ~/.tangu。导入的 MCP 一律默认停用,不会自动运行外来命令。",
    "en": "Scans local ~/.claude, ~/.codex, ~/.hermes for skills and MCP configs; selected items are imported into ~/.tangu. Imported MCP servers are always disabled by default and won't auto-run external commands."
  },
  "settings.discovery.scan": {
    "zh": "扫描本机",
    "en": "Scan local machine"
  },
  "settings.discovery.scanFailed": {
    "zh": "扫描失败:",
    "en": "Scan failed: "
  },
  "settings.discovery.importSelected": {
    "zh": "导入所选({count})",
    "en": "Import selected ({count})"
  },
  "settings.discovery.importOk": {
    "zh": "已导入技能 {skills} 个、MCP {mcp} 个。技能即时生效(后端按 mtime 重扫);MCP 默认停用,请到 MCP 页启用。",
    "en": "Imported {skills} skill(s) and {mcp} MCP server(s). Skills take effect immediately (the backend rescans by mtime); MCP servers are disabled by default — enable them on the MCP page."
  },
  "settings.discovery.importFailed": {
    "zh": "导入失败:",
    "en": "Import failed: "
  },
  "settings.discovery.nothingFound": {
    "zh": "未发现可导入的技能或 MCP 配置。",
    "en": "No importable skills or MCP configs found."
  },
  "settings.discovery.skillsCount": {
    "zh": "技能({count})",
    "en": "Skills ({count})"
  },
  "settings.discovery.mcpCount": {
    "zh": "MCP Server({count})",
    "en": "MCP Servers ({count})"
  },
  "settings.advanced.note": {
    "zh": "会话级配置(技能/工具启用、执行环境、审批档)在右侧面板与输入栏调整。快捷键:Ctrl/Cmd+N 新建会话,Ctrl/Cmd+, 打开设置。",
    "en": "Session-level settings (skill/tool enablement, execution environment, approval level) are adjusted in the right panel and input bar. Shortcuts: Ctrl/Cmd+N for a new session, Ctrl/Cmd+, to open Settings."
  },
  "onboarding.title": {
    "zh": "欢迎使用 Tangu Agent",
    "en": "Welcome to Tangu Agent"
  },
  "onboarding.connect.stepLabel": {
    "zh": "第一步:连接模型",
    "en": "Step 1: Connect a model"
  },
  "onboarding.connect.modeForsion": {
    "zh": "Forsion 账号",
    "en": "Forsion account"
  },
  "onboarding.connect.modeByok": {
    "zh": "自定义 Provider",
    "en": "Custom provider"
  },
  "onboarding.connect.cloudUrlLabel": {
    "zh": "Forsion 云端地址",
    "en": "Forsion cloud URL"
  },
  "onboarding.connect.cloudUrlHint": {
    "zh": "提供托管模型、记忆、云端技能;浏览器登录后凭证与 CLI/TUI 通用。",
    "en": "Provides hosted models, memory and cloud skills; after browser sign-in the credentials work across the CLI/TUI too."
  },
  "onboarding.connect.loginViaBrowser": {
    "zh": "通过浏览器登录",
    "en": "Sign in via browser"
  },
  "onboarding.connect.browserNotOpened": {
    "zh": "浏览器没弹出来?手动打开:",
    "en": "Browser didn't open? Open it manually:"
  },
  "onboarding.connect.verifyCode": {
    "zh": "验证码",
    "en": "Code"
  },
  "onboarding.connect.loggedIn": {
    "zh": "✓ 已登录",
    "en": "✓ Signed in"
  },
  "onboarding.connect.loginOk": {
    "zh": "✓ 登录成功,托管后端启动中…",
    "en": "✓ Signed in — starting the hosted backend…"
  },
  "onboarding.connect.providerIdLabel": {
    "zh": "Provider ID",
    "en": "Provider ID"
  },
  "onboarding.connect.providerIdPlaceholder": {
    "zh": "如 ollama / openai",
    "en": "e.g. ollama / openai"
  },
  "onboarding.connect.apiKeyLabel": {
    "zh": "API Key(本地端点可空)",
    "en": "API key (optional for local endpoints)"
  },
  "onboarding.connect.baseUrlLabel": {
    "zh": "Base URL(OpenAI 兼容,含 /v1)",
    "en": "Base URL (OpenAI-compatible, include /v1)"
  },
  "onboarding.connect.modelWhitelistLabel": {
    "zh": "模型白名单(逗号分隔,可空)",
    "en": "Model allowlist (comma-separated, optional)"
  },
  "onboarding.connect.saveAndStart": {
    "zh": "保存并启动",
    "en": "Save and start"
  },
  "onboarding.connect.providerSaved": {
    "zh": "✓ Provider 已保存,托管后端启动中…",
    "en": "✓ Provider saved — starting the hosted backend…"
  },
  "onboarding.connect.saveFail": {
    "zh": "保存失败:{e}",
    "en": "Save failed: {e}"
  },
  "onboarding.connect.testConnection": {
    "zh": "测试连接",
    "en": "Test connection"
  },
  "onboarding.connect.testFail": {
    "zh": "✗ {e}(后端未就绪时请先保存)",
    "en": "✗ {e} (save first if the backend isn't ready yet)"
  },
  "onboarding.model.stepLabel": {
    "zh": "第二步:选择默认模型",
    "en": "Step 2: Choose a default model"
  },
  "onboarding.model.loading": {
    "zh": "加载中…(托管后端可能还在启动,稍候点刷新)",
    "en": "Loading… (the hosted backend may still be starting — click refresh in a moment)"
  },
  "onboarding.model.empty": {
    "zh": "暂无可用模型 —— 后端可能还在启动。",
    "en": "No models available yet — the backend may still be starting."
  },
  "onboarding.model.refresh": {
    "zh": "刷新",
    "en": "Refresh"
  },
  "onboarding.model.directSource": {
    "zh": "直连·{provider}",
    "en": "Direct · {provider}"
  },
  "onboarding.env.stepLabel": {
    "zh": "第三步:环境检测(缺失项可一键安装,需你确认)",
    "en": "Step 3: Environment check (missing items can be installed in one click, with your confirmation)"
  },
  "onboarding.env.checking": {
    "zh": "检测中…",
    "en": "Checking…"
  },
  "onboarding.env.missing": {
    "zh": "未检测到",
    "en": "Not detected"
  },
  "onboarding.env.missingDocker": {
    "zh": "未检测到(代码沙箱将禁用,可选)",
    "en": "Not detected (code sandbox will be disabled, optional)"
  },
  "onboarding.env.missingNpm": {
    "zh": "未检测到(随 node 安装)",
    "en": "Not detected (installed together with node)"
  },
  "onboarding.env.install": {
    "zh": "安装",
    "en": "Install"
  },
  "onboarding.env.installConfirm": {
    "zh": "将在本机执行:\n\n{command}\n\n确认继续?(可能需要输入系统密码的命令请改在终端手动执行)",
    "en": "This will run on your machine:\n\n{command}\n\nContinue? (Commands that may require a system password should be run manually in a terminal.)"
  },
  "onboarding.env.hint": {
    "zh": "node/git 用于本机编码任务;docker 供 Python 代码沙箱(可选);带 sudo 的命令建议在终端手动执行。",
    "en": "node/git are used for local coding tasks; docker powers the Python code sandbox (optional); commands that use sudo are best run manually in a terminal."
  },
  "onboarding.done.label": {
    "zh": "完成 🎉",
    "en": "Done 🎉"
  },
  "onboarding.done.line1": {
    "zh": "· 输入栏可随时切换模型与思考深度;选择「本机」执行真实文件操作(带审批)",
    "en": "· Switch models and thinking depth anytime from the input bar; choose \"Local\" to run real file operations (with approval)"
  },
  "onboarding.done.line2": {
    "zh": "· 已有 Claude Code / Codex / Hermes?设置 → 高级 → 「从其他 Agent 导入」一键迁移技能与 MCP",
    "en": "· Already use Claude Code / Codex / Hermes? Settings → Advanced → \"Import from other agents\" to migrate skills and MCP in one click"
  },
  "onboarding.done.line3": {
    "zh": "· 设置 → Provider / MCP 可随时添加更多模型与工具",
    "en": "· Settings → Provider / MCP lets you add more models and tools anytime"
  },
  "onboarding.nav.prev": {
    "zh": "上一步",
    "en": "Back"
  },
  "onboarding.nav.skip": {
    "zh": "跳过引导",
    "en": "Skip onboarding"
  },
  "onboarding.nav.next": {
    "zh": "下一步",
    "en": "Next"
  },
  "onboarding.nav.start": {
    "zh": "开始使用",
    "en": "Get started"
  },
  "approval.requestExec": {
    "zh": "{name} 请求执行",
    "en": "{name} requests execution"
  },
  "approval.statusApproved": {
    "zh": "· 已批准",
    "en": "· Approved"
  },
  "approval.statusRejected": {
    "zh": "· 已拒绝",
    "en": "· Rejected"
  },
  "approval.statusExpired": {
    "zh": "· 已失效",
    "en": "· Expired"
  },
  "approval.approve": {
    "zh": "批准",
    "en": "Approve"
  },
  "approval.approveAlways": {
    "zh": "本会话总是允许",
    "en": "Always allow this session"
  },
  "approval.reject": {
    "zh": "拒绝",
    "en": "Reject"
  },
  "tool.argsLabel": {
    "zh": "参数",
    "en": "Arguments"
  },
  "tool.resultLabel": {
    "zh": "结果",
    "en": "Result"
  },
  "tool.empty": {
    "zh": "(空)",
    "en": "(empty)"
  },
  "inquiry.placeholderOrFree": {
    "zh": "或自由输入…",
    "en": "Or type freely…"
  },
  "inquiry.placeholderAnswer": {
    "zh": "输入回答…",
    "en": "Type your answer…"
  },
  "inquiry.answer": {
    "zh": "回答",
    "en": "Answer"
  },
  "inquiry.answered": {
    "zh": "已回答:{answer}",
    "en": "Answered: {answer}"
  },
  "inquiry.expired": {
    "zh": "已过期(运行已结束)",
    "en": "Expired (run has ended)"
  },
  "inquiry.planProposal": {
    "zh": "计划提案",
    "en": "Plan Proposal"
  },
  "inquiry.todoList": {
    "zh": "任务清单",
    "en": "To-do List"
  },
  "thinking.thinking": {
    "zh": "思考中…",
    "en": "Thinking…"
  },
  "thinking.process": {
    "zh": "思考过程",
    "en": "Thought process"
  },
  "thinking.charCount": {
    "zh": "({count} 字)",
    "en": "({count} chars)"
  }
})

// ── Forsion 云连接 / Brain 同步设置(2026-06 新增;补到此处,见文件头说明)──
registerMessages({
  "settings.tab.forsion": { "zh": "Forsion", "en": "Forsion" },
  "settings.forsion.accountLabel": { "zh": "Forsion 账号", "en": "Forsion account" },
  "settings.forsion.loggedInAs": { "zh": "已登录:{name}", "en": "Signed in: {name}" },
  "settings.forsion.notLoggedIn": { "zh": "未登录 Forsion", "en": "Not signed in to Forsion" },
  "settings.forsion.login": { "zh": "登录 Forsion", "en": "Sign in to Forsion" },
  "settings.forsion.logout": { "zh": "退出登录", "en": "Sign out" },
  "settings.forsion.cloudUrlLabel": { "zh": "Forsion 云端地址", "en": "Forsion cloud URL" },
  "settings.forsion.cloudUrlHint": { "zh": "连接到哪个 Forsion 后端(登录、Brain 同步、云端模型/技能均走此地址)。", "en": "Which Forsion backend to connect to (login, Brain sync, cloud models/skills use this URL)." },
  "settings.forsion.save": { "zh": "保存", "en": "Save" },
  "settings.forsion.syncLabel": { "zh": "Brain 记忆同步", "en": "Brain memory sync" },
  "settings.forsion.syncHint": { "zh": "记忆与日志默认存在本地(离线可用、不打网络)。同步把本地与 Forsion Brain 双向合并:记忆按更新者覆盖,日志按设备追加合并(不丢条目)。", "en": "Memory & logs live locally by default (offline, no network). Sync merges local with Forsion Brain both ways: memory is last-writer-wins, logs append-merge per device (no entry loss)." },
  "settings.forsion.autoSync": { "zh": "登录后自动同步", "en": "Auto-sync when signed in" },
  "settings.forsion.autoSyncHint": { "zh": "默认关闭(隐私优先)。开启后打开应用/设置时自动同步;关闭则仅手动。", "en": "Off by default (privacy-first). When on, syncs on app/settings open; otherwise manual only." },
  "settings.forsion.syncNow": { "zh": "立即同步", "en": "Sync now" },
  "settings.forsion.syncing": { "zh": "同步中…", "en": "Syncing…" },
  "settings.forsion.syncOk": { "zh": "已同步(记忆:{memory};日志 {logs} 天)", "en": "Synced (memory: {memory}; {logs} day(s) of logs)" },
  "settings.forsion.syncFail": { "zh": "同步失败:{e}", "en": "Sync failed: {e}" },
  "settings.forsion.lastSynced": { "zh": "上次同步:{time}", "en": "Last synced: {time}" },
  "settings.forsion.never": { "zh": "从未", "en": "Never" },
  "settings.forsion.needLoginHint": { "zh": "登录 Forsion 后才能同步;未登录也能用直连 API(模型页配置)正常使用 Tangu。", "en": "Sign in to Forsion to sync; Tangu works fully without it via direct API providers (configure in Model tab)." },
  "settings.forsion.gatedTitle": { "zh": "需要登录 Forsion 的功能", "en": "Features that need Forsion" },
  "settings.forsion.gatedList": { "zh": "云端模型目录 · 技能分享 · 云工作区存储 · Brain 记忆同步", "en": "Cloud model catalog · skill sharing · cloud workspace storage · Brain memory sync" },
})

// ── 群聊模式(Group Chat;2026-06 新增;补到此处,见文件头说明)──
registerMessages({
  "group.modeLabel": { "zh": "群聊 · {n} 人", "en": "Group · {n}" },
  "group.menu.section": { "zh": "群聊模式", "en": "Group chat" },
  "group.menu.enable": { "zh": "开启群聊模式…", "en": "Enable group chat…" },
  "group.menu.configured": { "zh": "群聊已开 · {n} 个 Agent", "en": "Group on · {n} agents" },
  "group.ended.vote": { "zh": "投票过半,讨论结束", "en": "Majority voted to end" },
  "group.ended.maxRounds": { "zh": "达到轮数上限", "en": "Reached round limit" },
  "group.ended.costLimit": { "zh": "达到成本上限", "en": "Reached cost limit" },
  "group.ended.quota": { "zh": "额度不足", "en": "Out of quota" },
  "group.ended.default": { "zh": "讨论结束", "en": "Discussion ended" },
  "group.ended.line": { "zh": "群聊结束 · 共 {rounds} 轮 · {reason}", "en": "Group chat ended · {rounds} round(s) · {reason}" },
  "group.vote.round": { "zh": "第 {round} 轮投票", "en": "Round {round} vote" },
  "group.vote.tally": { "zh": "{end}/{total} 赞成结束", "en": "{end}/{total} to end" },
  "group.setup.title": { "zh": "群聊模式", "en": "Group chat" },
  "group.setup.close": { "zh": "关闭", "en": "Close" },
  "group.setup.hint": { "zh": "选择至少 2 个 Agent,它们会轮流发言、相互回应,每轮可投票结束。", "en": "Pick at least 2 agents — they take turns speaking, respond to each other, and can vote to end each round." },
  "group.setup.participants": { "zh": "参与者({n} 已选)", "en": "Participants ({n} selected)" },
  "group.setup.noAgents": { "zh": "还没有 Agent。先到设置 → Agents 创建几个不同人格的 Agent。", "en": "No agents yet. Create a few in Settings → Agents first." },
  "group.setup.intensity": { "zh": "讨论强度", "en": "Discussion intensity" },
  "group.setup.roundsUnit": { "zh": "轮", "en": "r" },
  "group.setup.customRounds": { "zh": "自定义轮数", "en": "Custom rounds" },
  "group.setup.roundsRange": { "zh": "(1–30)", "en": "(1–30)" },
  "group.setup.scaleHint": { "zh": "最多 {rounds} 轮 × {agents} 个 Agent,每轮末投票决定是否提前结束。", "en": "Up to {rounds} rounds × {agents} agents; a vote at each round can end early." },
  "group.setup.disable": { "zh": "关闭群聊", "en": "Turn off" },
  "group.setup.update": { "zh": "更新", "en": "Update" },
  "group.setup.start": { "zh": "开始群聊", "en": "Start group chat" },
  "group.setup.needTwo": { "zh": "至少选择 2 个参与者", "en": "Select at least 2 participants" },
  "group.setup.savedAgents": { "zh": "已有 Agent", "en": "Saved agents" },
  "group.setup.tempAgents": { "zh": "临时 Agent(仅本次群聊)", "en": "Temporary agents (this chat only)" },
  "group.setup.addTemp": { "zh": "新建临时 Agent", "en": "New temporary agent" },
  "group.setup.tempBadge": { "zh": "· 临时", "en": "· temp" },
  "group.setup.tempSave": { "zh": "添加", "en": "Add" },
  "group.setup.tempFormHint": { "zh": "临时 Agent 字段与普通 Agent 一样,但只用于本次群聊、不会保存到设置 → Agents。", "en": "A temporary agent has the same fields as a normal one, but is used only for this group chat — not saved to Settings → Agents." },
  "group.intensity.relaxed": { "zh": "轻松", "en": "Relaxed" },
  "group.intensity.medium": { "zh": "中等", "en": "Medium" },
  "group.intensity.intense": { "zh": "激烈", "en": "Intense" },
  "group.intensity.custom": { "zh": "自定义", "en": "Custom" },
})
