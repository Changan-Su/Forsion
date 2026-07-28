/**
 * 自动汇总:全量翻译批次(14 个组件)产出的 i18n 片段。
 * 由 tangu-i18n-sweep workflow 生成,在 main.tsx 顶部 import 以在渲染前注册。
 * 勿手改;新增文案请加在对应组件并补到此处(或下次重跑批次)。
 */
import { registerMessages } from "./i18n"

registerMessages({
  "input.cloudModelHint": {
    "zh": "云端会话在云端执行,仅可用 Forsion 托管模型;直连 provider 的模型只在本地会话可选。",
    "en": "Cloud sessions run in the cloud and can only use Forsion-hosted models; direct-provider models are available in local sessions only."
  },
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
    "zh": "询问我批准",
    "en": "Ask for approval"
  },
  "input.approval.autoEdit": {
    "zh": "替我批准",
    "en": "Approve for me"
  },
  "input.approval.fullAuto": {
    "zh": "完全放行",
    "en": "Full access"
  },
  "input.thinking.off": {
    "zh": "思考·关",
    "en": "Thinking · Off"
  },
  "input.thinking.minimal": {
    "zh": "思考·极简",
    "en": "Thinking · Minimal"
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
  "input.thinking.xhigh": {
    "zh": "思考·极深",
    "en": "Thinking · Extra high"
  },
  "input.thinking.max": {
    "zh": "思考·拉满",
    "en": "Thinking · Max"
  },
  "input.thinkingShort.off": {
    "zh": "标准",
    "en": "Standard"
  },
  "input.thinkingShort.minimal": {
    "zh": "极简",
    "en": "Minimal"
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
  "input.thinkingShort.xhigh": {
    "zh": "极深",
    "en": "X-high"
  },
  "input.thinkingShort.max": {
    "zh": "拉满",
    "en": "Max"
  },
  "input.slash.thinkSet": {
    "zh": "思考强度已设为 {level}（模型不支持时自动降档）",
    "en": "Thinking level set to {level} (auto-clamped if the model can't do it)"
  },
  "input.slash.thinkUsage": {
    "zh": "用法：/think {levels}",
    "en": "Usage: /think {levels}"
  },
  "input.slash.status": {
    "zh": "本会话",
    "en": "This session"
  },
  "input.slash.copied": {
    "zh": "已复制上一条回复",
    "en": "Copied the last reply"
  },
  "input.slash.nothingToCopy": {
    "zh": "没有可复制的回复",
    "en": "No reply to copy"
  },
  "input.slash.nothingToRetry": {
    "zh": "没有可重试的消息",
    "en": "No message to retry"
  },
  "input.slash.nothingToExport": {
    "zh": "本会话还没有内容可导出",
    "en": "Nothing to export in this session yet"
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
  "input.micStart": {
    "zh": "语音输入(点击开始录音)",
    "en": "Voice input (click to record)"
  },
  "input.micStop": {
    "zh": "停止并转写",
    "en": "Stop & transcribe"
  },
  "input.micBusy": {
    "zh": "转写中…",
    "en": "Transcribing…"
  },
  "input.micListening": {
    "zh": "聆听中",
    "en": "Listening"
  },
  "input.stop": {
    "zh": "停止",
    "en": "Stop"
  },
  "input.slash.verifyUsage": {
    "zh": "用法:/verify <命令>(收尾前自动跑,不绿不许收)· /verify off 关闭 · 当前:{current}",
    "en": "Usage: /verify <command> (runs before the turn may end; must pass) · /verify off to clear · current: {current}"
  },
  "input.slash.verifyNone": {
    "zh": "未配置",
    "en": "not set"
  },
  "input.slash.verifySet": {
    "zh": "验证命令已设:{cmd}(收尾前自动跑)",
    "en": "Verify command set: {cmd} (runs before each turn ends)"
  },
  "input.slash.verifyCleared": {
    "zh": "验证命令已关闭",
    "en": "Verify command cleared"
  },
  "input.steer.waiting": {
    "zh": "插话等待区",
    "en": "Queued messages"
  },
  "input.steer.hint": {
    "zh": "等 agent 到达可读取点后插入 · ↑ 取回编辑",
    "en": "Delivered at the next boundary · ↑ to recall"
  },
  "input.steer.now": {
    "zh": "立即插话",
    "en": "Interrupt & send"
  },
  "input.steer.remove": {
    "zh": "撤回(仍可在 ↑ 历史里找到)",
    "en": "Remove (still in ↑ history)"
  },
  "plan.autoKickoff": {
    "zh": "计划已批准,开始执行。",
    "en": "The plan is approved — proceed with it now."
  },
  "msg.interrupted": {
    "zh": "已在此处打断",
    "en": "Interrupted here"
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
    "zh": "Tangu 的操作如何批准?",
    "en": "How should Tangu actions be approved?"
  },
  "input.approval.readonlyDesc": {
    "zh": "改文件、跑命令、联网,每次都先问我",
    "en": "Always ask before editing files, running commands or using the internet"
  },
  "input.approval.autoEditDesc": {
    "zh": "工作区内可直接改文件,跑命令才问我",
    "en": "Edits files in the workspace freely, asks before running commands"
  },
  "input.approval.fullAutoDesc": {
    "zh": "不受限地访问网络和你电脑上的任何文件",
    "en": "Unrestricted access to the internet and any file on your computer"
  },
  "input.approval.custom": {
    "zh": "自定义(config.json)",
    "en": "Custom (config.json)"
  },
  "input.approval.customDesc": {
    "zh": "按 config.json 的 approval 段(allow / ask / deny)判定",
    "en": "Uses permissions defined in config.json"
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
  "header.closeTab": {
    "zh": "关闭标签",
    "en": "Close tab"
  },
  "header.newTab": {
    "zh": "新对话",
    "en": "New chat"
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
  "panel.files.noLocalWs": {
    "zh": "暂无本地工作区。添加本地工作区后,其文件夹内容会显示在这里。",
    "en": "No local workspaces yet. Add one and its folder contents appear here."
  },
  "panel.files.refresh": {
    "zh": "刷新",
    "en": "Refresh"
  },
  "panel.files.empty": {
    "zh": "(空文件夹)",
    "en": "(empty)"
  },
  "panel.tab.toc": {
    "zh": "目录",
    "en": "Outline"
  },
  "panel.tab.memory": {
    "zh": "记忆",
    "en": "Memory"
  },
  "panel.tab.subchats": {
    "zh": "子聊天",
    "en": "Sub-chats"
  },
  "panel.subchats.empty": {
    "zh": "暂无子聊天（agent 发起讨论或子代理任务时会出现在这里）",
    "en": "No sub-chats yet (discussions or subagent tasks the agent starts appear here)"
  },
  "panel.subchats.live": {
    "zh": "实时进行中…",
    "en": "Live…"
  },
  "panel.subchats.connecting": {
    "zh": "连接讨论中…",
    "en": "Connecting…"
  },
  "panel.subchats.starting": {
    "zh": "子代理启动中…",
    "en": "Subagent starting…"
  },
  "panel.subchats.voteEnd": {
    "zh": "票同意结束",
    "en": "voted to end"
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
  "settings.backToApp": {
    "zh": "返回应用",
    "en": "Back to app"
  },
  "settings.searchPlaceholder": {
    "zh": "搜索设置…",
    "en": "Search settings…"
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
    // 页名 2026-07-27 由「主题」改为「外观」(key 保持 theme:tab id / 深链 / 已存 sub 都按它走)。
    "zh": "外观",
    "en": "Appearance"
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
    "zh": "~/Forsion(默认,首启自动创建)",
    "en": "~/Forsion (default, created on first launch)"
  },
  "settings.workspace.pick": {
    "zh": "选择…",
    "en": "Choose…"
  },
  "settings.workspace.hint": {
    "zh": "侧栏「Tangu 默认工作区」新建会话用的本机目录;留空用 ~/Forsion。改后关闭设置即刷新侧栏工作区。",
    "en": "Local directory used by the sidebar \"Tangu default workspace\" for new sessions; leave empty to use ~/Forsion. After changing, close Settings to refresh the sidebar workspace."
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
  "settings.model.imageModelsLabel": {
    "zh": "生图模型(generate_image 用)",
    "en": "Image models (for generate_image)"
  },
  "settings.model.imageEmpty": {
    "zh": "未检测到生图模型。请在 Forsion 后台启用生图模型,或在下方「自定义 provider」填写「生图模型 id」。",
    "en": "No image models found. Enable image models in the Forsion admin, or fill in \"Image models\" under Custom Provider below."
  },
  "settings.model.imageHelp": {
    "zh": "选中即设为默认生图模型;agent 调 generate_image 时自动使用(也可在调用里指定 model)。",
    "en": "Selecting one sets it as the default; the agent uses it automatically when calling generate_image (it can also specify a model)."
  },
  "settings.model.asrModelsLabel": {
    "zh": "语音识别模型(语音输入用)",
    "en": "Speech models (for voice input)"
  },
  "settings.model.asrEmpty": {
    "zh": "未检测到语音识别模型。请在 Forsion 后台启用语音识别模型,或在下方「自定义 provider」填写「语音识别模型 id」。",
    "en": "No speech-recognition models found. Enable speech models in the Forsion admin, or fill in \"Speech models\" under Custom Provider below."
  },
  "settings.model.asrHelp": {
    "zh": "选中即设为默认语音识别模型;chatbox 语音输入按此转写(空=跟随 app 级默认或本地模型)。",
    "en": "Selecting one sets the default speech-recognition model; the chatbox voice input transcribes with it (empty = follow the app default or local model)."
  },
  "settings.model.asrFollowingDefault": {
    "zh": "未手动选择,当前跟随云端语音识别默认:{model}。点击任一模型可改为手动指定,再点一次取消。",
    "en": "No manual pick — following the cloud speech default: {model}. Click a model to pin your own choice; click again to unpin."
  },
  "settings.asr.localTitle": {
    "zh": "本地语音模型(离线,SenseVoice Small)",
    "en": "Local speech model (offline, SenseVoice Small)"
  },
  "settings.asr.localHint": {
    "zh": "下载后语音输入完全在本机转写、不联网、不计额度;支持中英日韩粤。约 230 MB。",
    "en": "Once downloaded, voice input transcribes fully on-device — offline, no quota. Supports zh/en/ja/ko/yue. ~230 MB."
  },
  "settings.asr.download": {
    "zh": "下载本地模型(~230 MB)",
    "en": "Download local model (~230 MB)"
  },
  "settings.asr.downloading": {
    "zh": "下载中…",
    "en": "Downloading…"
  },
  "settings.asr.localReady": {
    "zh": "本地模型已就绪",
    "en": "Local model ready"
  },
  "settings.asr.preferLocal": {
    "zh": "语音输入优先用本地",
    "en": "Prefer local for voice input"
  },
  "settings.asr.localRemove": {
    "zh": "删除",
    "en": "Remove"
  },
  "settings.aux.llmLabel": {
    "zh": "辅助模型 · LLM",
    "en": "Auxiliary model · LLM"
  },
  "settings.aux.llmHint": {
    "zh": "后台/特殊 agent(Muse、Historian)用的模型,与主模型分开挑,便宜档就够。不选=跟随 Forsion 后台的默认。",
    "en": "Model used by background agents (Muse, Historian). Picked separately from your main model — a cheap tier is plenty. Unset = follow the Forsion admin default."
  },
  "settings.aux.visionLabel": {
    "zh": "辅助模型 · 图像识别",
    "en": "Auxiliary model · Image recognition"
  },
  "settings.aux.visionHint": {
    "zh": "主模型没有原生多模态时,图片先经它转成文字再交给主模型;非聊天场景(插件、自动化)要识图也直接调它。",
    "en": "When your main model has no native image input, pictures are transcribed by this model first. Non-chat callers (plugins, automations) use it directly too."
  },
  "settings.aux.following": {
    "zh": "当前跟随云端默认:{model}",
    "en": "Currently following the cloud default: {model}"
  },
  "onboarding.aux.stepLabel": {
    "zh": "辅助模型",
    "en": "Auxiliary models"
  },
  "onboarding.aux.intro": {
    "zh": "可选。留空即跟随 Forsion 后台的默认,之后在「设置 → 模型」随时可改。",
    "en": "Optional. Leave unset to follow the Forsion admin defaults; you can change these any time in Settings → Models."
  },
  "settings.customProvider.noVisionLabel": {
    "zh": "无多模态的模型(逗号分隔,可留空)",
    "en": "Models without vision (comma-separated, optional)"
  },
  "settings.customProvider.noVisionHint": {
    "zh": "默认认为该 provider 的模型都能看图。把已知纯文本的模型名填在这里,它们遇到图片会自动改走辅助的图像识别模型。",
    "en": "Models here are assumed to accept images. List the known text-only ones — they will route pictures through the image-recognition auxiliary model instead."
  },
  "settings.asr.chooseLabel": {
    "zh": "语音输入用哪个模型",
    "en": "Which model powers voice input"
  },
  "settings.asr.chooseHint": {
    "zh": "选中即用。本地=离线、不计额度;云端=Forsion 按时长计费,或你自带 provider 走自己的 key。",
    "en": "Click to use. Local = offline, no quota; Cloud = Forsion billed by duration, or your own provider with your key."
  },
  "settings.asr.localName": {
    "zh": "本地 SenseVoice",
    "en": "Local SenseVoice"
  },
  "settings.asr.offlineTag": {
    "zh": "离线",
    "en": "Offline"
  },
  "settings.asr.noCloudHint": {
    "zh": "暂无云端语音识别模型(Forsion 后台配置后出现,或在下方加自带 provider)。",
    "en": "No cloud speech models yet (appear after Forsion admin config, or add your own provider below)."
  },
  "onboarding.speech.stepLabel": {
    "zh": "语音输入",
    "en": "Voice input"
  },
  "onboarding.speech.intro": {
    "zh": "给聊天框(以后还有笔记等)加语音输入。推荐下载本地模型:离线、私密、不计额度。",
    "en": "Add voice input to the chatbox (and later notes, etc). Recommended: download the local model — offline, private, no quota."
  },
  "onboarding.speech.cloudLabel": {
    "zh": "或用云端语音识别模型",
    "en": "Or use a cloud speech model"
  },
  "onboarding.speech.cloudEmpty": {
    "zh": "暂无云端语音识别模型;下载本地模型,或稍后在设置里加自带 provider。",
    "en": "No cloud speech models yet; download the local model, or add your own provider later in Settings."
  },
  "onboarding.speech.cloudHint": {
    "zh": "选中即设为默认并切到云端(Forsion 云端计入额度;自带 provider 走你自己的 key)。",
    "en": "Selecting one sets it as the default and switches to cloud (Forsion cloud counts against quota; your own provider uses your key)."
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
    "zh": "OAuth 浏览器登录,凭证存 ~/.forsion/provider-auth.json(与 `tangu login <provider>` 通用);托管后端会自动重启加载,之后用 ",
    "en": "OAuth browser login; credentials are stored in ~/.forsion/provider-auth.json (shared with `tangu login <provider>`). The managed backend restarts to load them automatically, after which you can use "
  },
  "settings.provider.loginHintSuffix": {
    "zh": "(如 xai/grok-3)即可。",
    "en": " (e.g. xai/grok-3)."
  },
  "settings.customProvider.sectionTitle": {
    "zh": "自定义 Provider(BYO-key 直连)",
    "en": "Custom provider (BYO-key direct connection)"
  },
  "settings.websearch.sectionTitle": {
    "zh": "联网搜索(web_search)",
    "en": "Web search (web_search)"
  },
  "settings.websearch.intro": {
    "zh": "web_search 工具的本地搜索源(BYO-key)。配置后本机直搜、不依赖云端;不配置则登录用户走云端,未登录回落免费 DuckDuckGo。失败自动按「其余已配 Key → DuckDuckGo」降级。大陆网络 DuckDuckGo 不可达,建议配博查或智谱。",
    "en": "Local search source for the web_search tool (BYO-key). When configured, searches run from this machine without the cloud; otherwise signed-in users go through the cloud and others fall back to free DuckDuckGo. On failure it degrades through your other configured keys, then DuckDuckGo. DuckDuckGo is unreachable from mainland China — use Bocha or Zhipu there."
  },
  "settings.websearch.providerLabel": {
    "zh": "搜索源",
    "en": "Provider"
  },
  "settings.websearch.provider.auto": {
    "zh": "auto(按已配 Key 自动选)",
    "en": "auto (pick by configured key)"
  },
  "settings.websearch.provider.bocha": {
    "zh": "博查 Bocha(国内直连)",
    "en": "Bocha (CN-friendly)"
  },
  "settings.websearch.provider.tavily": {
    "zh": "Tavily(海外,免费 1k 次/月)",
    "en": "Tavily (intl, free 1k/mo)"
  },
  "settings.websearch.provider.zhipu": {
    "zh": "智谱 Web Search(国内直连)",
    "en": "Zhipu Web Search (CN-friendly)"
  },
  "settings.websearch.provider.duckduckgo": {
    "zh": "DuckDuckGo(免 Key)",
    "en": "DuckDuckGo (no key)"
  },
  "settings.websearch.effectiveLabel": {
    "zh": "当前生效",
    "en": "Effective"
  },
  "settings.websearch.effectiveLocal": {
    "zh": "本地直搜:{provider}",
    "en": "Local: {provider}"
  },
  "settings.websearch.effectiveCloud": {
    "zh": "未配置:登录走云端,否则免费 DuckDuckGo 兜底",
    "en": "Not configured: cloud when signed in, else free DuckDuckGo"
  },
  "settings.websearch.keyStored": {
    "zh": "已保存",
    "en": "stored"
  },
  "settings.websearch.keyCleared": {
    "zh": "将清除(保存后生效)",
    "en": "will clear on save"
  },
  "settings.websearch.keyKeepPlaceholder": {
    "zh": "已保存,留空则不变",
    "en": "Stored — leave blank to keep"
  },
  "settings.websearch.keyEmptyPlaceholder": {
    "zh": "未配置",
    "en": "Not set"
  },
  "settings.websearch.clearKey": {
    "zh": "清除",
    "en": "Clear"
  },
  "settings.websearch.saved": {
    "zh": "✓ 已保存,搜索时即时生效",
    "en": "✓ Saved — takes effect on next search"
  },
  "settings.websearch.testing": {
    "zh": "测试中…",
    "en": "Testing…"
  },
  "settings.websearch.test": {
    "zh": "连通性测试",
    "en": "Test connection"
  },
  "settings.customProvider.label": {
    "zh": "自定义 Provider(BYO-key 直连;对齐 Forsion 模型添加:base_URL + api key)",
    "en": "Custom provider (BYO-key direct connection; same as adding a Forsion model: base_URL + api key)"
  },
  "settings.customProvider.introPrefix": {
    "zh": "配置存 ~/.forsion/providers.json,与 CLI ",
    "en": "Config is stored in ~/.forsion/providers.json, same format as the CLI "
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
  "settings.customProvider.imageModelsLabel": {
    "zh": "生图模型(逗号分隔,可空)",
    "en": "Image models (comma-separated, optional)"
  },
  "settings.customProvider.imageModelsPlaceholder": {
    "zh": "如 gpt-image-1, dall-e-3",
    "en": "e.g. gpt-image-1, dall-e-3"
  },
  "settings.customProvider.asrModelsLabel": {
    "zh": "语音识别模型(逗号分隔,可空)",
    "en": "Speech models (comma-separated, optional)"
  },
  "settings.customProvider.asrModelsPlaceholder": {
    "zh": "如 FunAudioLLM/SenseVoiceSmall, whisper-1",
    "en": "e.g. FunAudioLLM/SenseVoiceSmall, whisper-1"
  },
  "settings.customProvider.savedReloading": {
    "zh": "已保存;托管后端重启加载中…",
    "en": "Saved; managed backend is restarting to reload…"
  },
  "settings.customProvider.externalWarning": {
    "zh": "⚠ 当前为外部后端模式:这里编辑的是本机 ~/.forsion/providers.json,远程 tangu-server 不会读到。",
    "en": "⚠ Currently in external backend mode: this edits the local ~/.forsion/providers.json, which the remote tangu-server won't read."
  },
  "settings.mcp.label": {
    "zh": "MCP Server(配置存 ~/.forsion/mcp.json;保存后托管后端重启重连)",
    "en": "MCP Server (config stored in ~/.forsion/mcp.json; managed backend restarts and reconnects after saving)"
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
  "settings.skills.openFolder": { "zh": "打开技能文件夹", "en": "Open skills folder" },
  "settings.agents.openFolder": { "zh": "打开文件夹", "en": "Open folder" },
  "sidebar.account.expired": { "zh": "登录已过期 · 点击重新登录", "en": "Session expired · click to re-login" },
  "settings.forsion.expired": { "zh": "登录已过期,请重新登录(否则后端无法连接)。", "en": "Session expired — please re-login (the backend can't connect otherwise)." },
  "settings.forsion.relogin": { "zh": "重新登录", "en": "Re-login" },
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
    "zh": "扫描本机 ~/.claude、~/.codex、~/.hermes 的技能与 MCP 配置,勾选后导入 ~/.forsion。导入的 MCP 一律默认停用,不会自动运行外来命令。",
    "en": "Scans local ~/.claude, ~/.codex, ~/.hermes for skills and MCP configs; selected items are imported into ~/.forsion. Imported MCP servers are always disabled by default and won't auto-run external commands."
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
    "zh": "欢迎使用 {name}",
    "en": "Welcome to {name}"
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
  "group.voting.inProgress": { "zh": "正在投票…", "en": "Voting…" },
  "input.mention.groupNote": { "zh": "群内 Agent · 优先发言", "en": "Agents in group · speaks first" },
  "input.mention.delegateNote": { "zh": "委派给 Agent · 作为 subagent 处理", "en": "Delegate to agent · runs as subagent" },
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

// ── 当前 Agent 记忆 + 新建标签页启动器(2026-06-28 UI 优化;见文件头说明)──
registerMessages({
  "panel.memory.currentAgent": { "zh": "当前 Agent 记忆", "en": "Current Agent Memory" },
  "panel.memory.recentLogs": { "zh": "最近日志", "en": "Recent Logs" },
  "panel.log.none": { "zh": "暂无日志", "en": "No logs yet" },
  "newtab.title": { "zh": "新建标签页", "en": "New Tab" },
  "newtab.mainSection": { "zh": "主区视图", "en": "Main Area" },
  "newtab.sideSection": { "zh": "侧栏视图", "en": "Side Panel" },
  "newtab.recentSection": { "zh": "最近使用", "en": "Recent" },
  "newtab.newNote": { "zh": "新建笔记", "en": "New Note" },
  "newtab.today": { "zh": "今天", "en": "Today" },
})

// ── 引导欢迎页 + 更新日志抽屉 + Forsion 登录权益(2026-06-28)──
registerMessages({
  "onboarding.welcome.title": { "zh": "欢迎使用 {name}", "en": "Welcome to {name}" },
  "onboarding.welcome.version": { "zh": "版本 {v}", "en": "Version {v}" },
  "onboarding.welcome.continue": { "zh": "继续", "en": "Continue" },
  "onboarding.welcome.viewChangelog": { "zh": "查看更新内容", "en": "What's New" },
  "onboarding.welcome.changelogTitle": { "zh": "更新内容", "en": "What's New" },
  "onboarding.welcome.noChangelog": { "zh": "暂无更新记录", "en": "No release notes yet" },
  "onboarding.connect.benefitsTitle": { "zh": "登录 Forsion 账号即可", "en": "With a Forsion account" },
  "onboarding.connect.benefitSync": { "zh": "云端同步:记忆、会话、设置多端一致", "en": "Cloud sync — memory, sessions and settings stay consistent across devices" },
  "onboarding.connect.benefitModels": { "zh": "各种 AI 模型任意使用,无需自备 API Key", "en": "Use any AI model freely — no API key of your own needed" },
  "onboarding.connect.benefitFreeQuota": { "zh": "每日免费 AI 额度 —— 注册即送,无需付费即可开始", "en": "Free daily AI quota — included on sign-up, start without paying" },
  "onboarding.connect.modeSub": { "zh": "订阅登录", "en": "Subscription" },
  "onboarding.connect.subDesc": { "zh": "用你的 Claude / ChatGPT / xAI 订阅账号直连,跑各自的订阅额度(不计 Forsion 额度)。", "en": "Connect with your Claude / ChatGPT / xAI subscription account and run on its own quota (doesn't count against Forsion quota)." },
  "onboarding.connect.subHint": { "zh": "OAuth 浏览器登录,凭证只存本机 ~/.forsion/provider-auth.json;登录后用 provider/model(如 claude/claude-opus-4-8)选模型。", "en": "OAuth browser login; credentials stay on your machine in ~/.forsion/provider-auth.json. After login, pick a model with provider/model (e.g. claude/claude-opus-4-8)." },
  "onboarding.connect.subUnavailable": { "zh": "当前环境不支持订阅登录(仅桌面端)。", "en": "Subscription login isn't available here (desktop only)." },
  "onboarding.connect.subLoginOk": { "zh": "订阅账号已连接", "en": "Subscription account connected" },
})

// ── 空侧栏占位 + per-tab 导航 + [[ 文件引用(2026-07-03)──
registerMessages({
  "sidebar.emptyTitle": { "zh": "空侧栏", "en": "Empty sidebar" },
  "sidebar.empty": { "zh": "这个侧栏是空的,把标签页拖进来试试。", "en": "This sidebar is empty, try dragging a tab here." },
  "input.fileref.note": { "zh": "引用笔记 / 工作区文件", "en": "Reference a note / workspace file" },
  "command.navBack": { "zh": "后退(本标签页)", "en": "Back (this tab)" },
  "command.navForward": { "zh": "前进(本标签页)", "en": "Forward (this tab)" },
  "view.workspace": { "zh": "工作区", "en": "Workspace" },
  "market.tab.spaces": { "zh": "空间", "en": "Spaces" },
  "market.spaceInstalled": { "zh": "已安装「{name}」,Space 已出现在左侧功能条顶部", "en": "Installed \"{name}\" — the space is now on the ribbon" },
  "command.saveAsSpace": { "zh": "将当前布局另存为 Space", "en": "Save current layout as a Space" },
  "spaces.namePrompt": { "zh": "新 Space 名称", "en": "New space name" },
  "spaces.saved": { "zh": "已另存为 Space「{name}」(见左侧功能条顶部)", "en": "Saved as space \"{name}\" (see the ribbon top)" },
  "spaces.deleteConfirm": { "zh": "删除 Space「{name}」?其布局配方将从磁盘移除。", "en": "Delete space \"{name}\"? Its recipe will be removed from disk." },
  "view.outline": { "zh": "大纲", "en": "Outline" },
  "workspace.mode.auto": { "zh": "自动", "en": "Auto" },
  "workspace.mode.autoTip": { "zh": "跟随主视图自动切换(对话→会话/文件,笔记→笔记/文件)", "en": "Follows the focused main view (chat → sessions/files, note → notes/files)" },
  "workspace.mode.sessions": { "zh": "会话", "en": "Sessions" },
  "workspace.mode.files": { "zh": "文件", "en": "Files" },
  "workspace.mode.notes": { "zh": "笔记", "en": "Notes" },
  "workspace.notesUnavailable": { "zh": "笔记功能在当前环境不可用。", "en": "Notes are unavailable in this environment." },
  "outline.empty": { "zh": "当前视图没有大纲。", "en": "No outline for the current view." },
})

// ── 语音朗读 TTS(2026-07-03)──
registerMessages({
  "chat.action.speak": { "zh": "朗读", "en": "Read aloud" },
  "chat.action.stopSpeak": { "zh": "停止朗读", "en": "Stop reading" },
  "settings.tts.sectionTitle": { "zh": "语音朗读(TTS)", "en": "Read aloud (TTS)" },
  "settings.tts.intro": { "zh": "OpenAI 兼容 /audio/speech 端点。填 <providerId>/<模型> 或在上方 provider 里声明「语音模型」后直接填模型 id;留空关闭朗读。", "en": "OpenAI-compatible /audio/speech endpoint. Use <providerId>/<model>, or declare TTS models on a provider above and use the model id directly; leave empty to disable." },
  "settings.tts.model": { "zh": "TTS 模型", "en": "TTS model" },
  "settings.tts.modelPlaceholder": { "zh": "如 siliconflow/FunAudioLLM/CosyVoice2-0.5B 或 openai/tts-1", "en": "e.g. siliconflow/FunAudioLLM/CosyVoice2-0.5B or openai/tts-1" },
  "settings.tts.voice": { "zh": "音色", "en": "Voice" },
  "settings.tts.voicePlaceholder": { "zh": "provider 特定音色 id,如 alloy;OpenAI 等部分服务必填,留空则不传该参数", "en": "Provider-specific voice id, e.g. alloy; required by some providers (OpenAI), omitted when empty" },
  "settings.tts.speed": { "zh": "语速(0.5–2)", "en": "Speed (0.5–2)" },
  "settings.tts.autoSpeak": { "zh": "新回复完成后自动朗读", "en": "Auto-read new replies" },
  "settings.tts.autoSpeakHint": { "zh": "仅当前打开的会话;后台会话完成不会出声。", "en": "Only the currently open session; background sessions stay silent." },
  "settings.customProvider.ttsModelsLabel": { "zh": "语音模型(逗号分隔,可空)", "en": "TTS models (comma-separated, optional)" },
  "settings.customProvider.ttsModelsPlaceholder": { "zh": "如 tts-1, FunAudioLLM/CosyVoice2-0.5B", "en": "e.g. tts-1, FunAudioLLM/CosyVoice2-0.5B" },
  "tts.failed": { "zh": "朗读失败:{e}", "en": "Read aloud failed: {e}" },
  "tts.noText": { "zh": "这条消息没有可朗读的文字", "en": "No speakable text in this message" },
})

// ── 百炼音色工作室:声音复刻 + 声音设计(2026-07-03)──
registerMessages({
  "settings.tts.studio.title": { "zh": "百炼音色工作室", "en": "Bailian voice studio" },
  "settings.tts.studio.hint": { "zh": "用阿里云百炼复刻你的声音或用文字描述设计音色。音色与合成模型绑定,「使用」时会自动切换到对应模型。复刻 ¥0.01/个,设计 ¥0.2/个。", "en": "Clone your voice or design one from a text description via Alibaba Bailian. Voices are bound to their synthesis model — applying a voice switches the model automatically. Cloning ¥0.01/voice, design ¥0.2/voice." },
  "settings.tts.studio.needProvider": { "zh": "配置一个 baseUrl 指向阿里云百炼(dashscope.aliyuncs.com/compatible-mode/v1)的 provider 后,可在此复刻/设计音色。", "en": "Add a provider whose baseUrl points to Alibaba Bailian (dashscope.aliyuncs.com/compatible-mode/v1) to clone/design voices here." },
  "settings.tts.studio.cloneTitle": { "zh": "声音复刻", "en": "Voice cloning" },
  "settings.tts.studio.cloneHint": { "zh": "上传 10–20 秒清晰人声(WAV/MP3/M4A,≤10MB,单声道 ≥24kHz,无背景音乐/他人声,不能是歌声);创建成功自动采用。需对该声音拥有合法使用权。", "en": "Upload 10–20s of clean speech (WAV/MP3/M4A, ≤10MB, mono ≥24kHz, no background music/other voices, no singing); applied automatically on success. You must hold rights to the voice." },
  "settings.tts.studio.designTitle": { "zh": "声音设计", "en": "Voice design" },
  "settings.tts.studio.designPromptPlaceholder": { "zh": "描述想要的声音,如:年轻活泼的女性声音,语速较快,语调上扬,温柔亲切(请原创,勿模仿特定真人)", "en": "Describe the voice, e.g.: a young, lively female voice, fast-paced with rising intonation, warm and friendly (original, not imitating a real person)" },
  "settings.tts.studio.previewTextPlaceholder": { "zh": "试听文本(可选)", "en": "Preview text (optional)" },
  "settings.tts.studio.namePlaceholder": { "zh": "名称(字母/数字/_)", "en": "Name (letters/digits/_)" },
  "settings.tts.studio.cloneBtn": { "zh": "开始复刻", "en": "Clone" },
  "settings.tts.studio.designBtn": { "zh": "生成音色", "en": "Design" },
  "settings.tts.studio.playPreview": { "zh": "试听", "en": "Preview" },
  "settings.tts.studio.adopt": { "zh": "采用此音色", "en": "Adopt this voice" },
  "settings.tts.studio.voices": { "zh": "我的音色", "en": "My voices" },
  "settings.tts.studio.refresh": { "zh": "刷新列表", "en": "Refresh" },
  "settings.tts.studio.use": { "zh": "使用", "en": "Use" },
  "settings.tts.studio.delete": { "zh": "删除", "en": "Delete" },
  "settings.tts.studio.empty": { "zh": "还没有自定义音色", "en": "No custom voices yet" },
  "settings.tts.studio.kindClone": { "zh": "复刻", "en": "cloned" },
  "settings.tts.studio.kindDesign": { "zh": "设计", "en": "designed" },
  "settings.tts.studio.kindCosy": { "zh": "CosyVoice", "en": "CosyVoice" },
  "settings.tts.studio.cosyTitle": { "zh": "CosyVoice 声音复刻", "en": "CosyVoice cloning" },
  "settings.tts.studio.cosyHint": { "zh": "CosyVoice 复刻音质更细腻,但百炼规定音频样本必须是公网可访问的 URL(不收文件上传):把 10–20 秒清晰人声(WAV/MP3/M4A,≤10MB,≥16kHz)传到 OSS/图床后粘贴链接。创建成功自动采用(合成走 cosyvoice-v2)。", "en": "CosyVoice cloning sounds finer-grained, but Bailian requires the sample as a public URL (no file upload): upload 10–20s of clean speech (WAV/MP3/M4A, ≤10MB, ≥16kHz) to OSS/an image host and paste the link. Applied automatically on success (synthesis via cosyvoice-v2)." },
  "settings.tts.studio.cosyUrlPlaceholder": { "zh": "公网音频 URL(https://…)", "en": "Public audio URL (https://…)" },
  "settings.tts.studio.cosyBtn": { "zh": "CosyVoice 复刻", "en": "Clone (CosyVoice)" },
  "settings.tts.studio.applied": { "zh": "已采用音色 {voice}(模型已联动切换)", "en": "Voice {voice} applied (model switched accordingly)" },
  "settings.tts.studio.fileTooLarge": { "zh": "音频超过 {mb}MB 上限", "en": "Audio exceeds the {mb}MB limit" },
  "settings.tts.testBtn": { "zh": "试听", "en": "Test voice" },
  "settings.tts.testOk": { "zh": "合成成功,正在播放", "en": "Synthesized, playing" },
  "settings.tts.testText": { "zh": "你好呀,我是 Tangu。今天过得怎么样?", "en": "Hi, I'm Tangu. How is your day going?" },
  "settings.notes.cloudSyncLabel": { "zh": "在线同步(Cloud Vault)", "en": "Online sync (Cloud Vault)" },
  "settings.notes.cloudSyncHint": { "zh": "工作区顶部「本地 | 云端」滑块的云端侧即云端库:与你的云端 vault 双向持续同步(需登录 Forsion 账号),网页端与云端 agent 实时可见。本地侧的笔记永不上云。单文件上限 5MB。", "en": "The Cloud side of the Local | Cloud switch at the top of the workspace is your cloud vault — continuously two-way synced (Forsion login required) and live-visible to the web app and cloud agents. Notes on the Local side never leave this device. 5MB per-file limit." },
  "notes.cloud.loginHint": { "zh": "登录 Forsion 账号后,这里会与你的云端 vault 自动双向同步。", "en": "Sign in to Forsion and this vault will two-way sync with your cloud vault automatically." },
  "notes.cloud.loginBtn": { "zh": "登录", "en": "Sign in" },
  "notes.cloud.local": { "zh": "本地", "en": "Local" },
  "notes.cloud.cloud": { "zh": "云端", "en": "Cloud" },
  "settings.notes.cloudSyncNow": { "zh": "立即同步", "en": "Sync now" },
  "settings.notes.cloudSyncSyncing": { "zh": "同步中…", "en": "Syncing…" },
  "settings.notes.cloudSyncPending": { "zh": "{n} 项待处理", "en": "{n} pending" },
  "settings.notes.cloudSyncSkipped": { "zh": "已跳过 {n} 项(超限或路径非法)", "en": "Skipped {n} item(s) (too large or invalid path)" },
  "settings.notes.cloudSyncPendingDel": { "zh": "删除保护:{n} 项批量删除已被拦下,确认后才会执行", "en": "Deletion guard: {n} bulk deletion(s) held, confirm to proceed" },
  "settings.notes.cloudSyncConfirmDel": { "zh": "确认删除", "en": "Confirm deletions" },
  "settings.remotesync.label": { "zh": "本地库远程同步", "en": "Vault remote sync" },
  "settings.remotesync.hint": { "zh": "把本地库同步到你自己的存储(Dropbox / S3 / WebDAV / 文件夹),手动或定时,非实时;与上方的在线同步(Cloud Vault)互不相干。删除有防误删闸,冲突两版都保留。", "en": "Sync your local vault to your own storage (Dropbox / S3 / WebDAV / folder), manually or on a schedule. Independent from Online sync (Cloud Vault) above. Mass-delete guard and conflict copies keep data safe." },
  "settings.remotesync.service": { "zh": "远程服务", "en": "Remote service" },
  "settings.remotesync.schedule": { "zh": "同步计划", "en": "Sync schedule" },
  "settings.remotesync.scheduleHint": { "zh": "按固定间隔在后台自动同步;任何时候都可以手动「立即同步」。", "en": "Runs automatically in the background at the chosen interval; you can always sync manually." },
  "settings.remotesync.advanced": { "zh": "高级", "en": "Advanced" },
  "settings.remotesync.maxFile": { "zh": "单文件上限(MB,0 = 不限)", "en": "Max file size (MB, 0 = unlimited)" },
  "settings.remotesync.preparing": { "zh": "正在对账…(扫描本地与远端)", "en": "Preparing… (scanning local & remote)" },
  "settings.remotesync.scope": { "zh": "同步范围:整个本地库的全部文件(含附件/画板/多维表;系统垃圾与 .git、.trash 除外)—— {root}", "en": "Scope: every file in the local vault (attachments, drawings, databases included; system junk, .git and .trash excluded) — {root}" },
  "settings.remotesync.dirBoth": { "zh": "双向同步(默认)", "en": "Bidirectional (default)" },
  "settings.remotesync.dirPush": { "zh": "仅上传(增量备份,不删远端)", "en": "Upload only (incremental backup)" },
  "settings.remotesync.dirPull": { "zh": "仅下载(增量还原,不删本地)", "en": "Download only (incremental restore)" },
  "settings.remotesync.syncOnStart": { "zh": "启动后自动同步一次(15 秒后)", "en": "Sync once after startup (after 15s)" },
  "settings.remotesync.concurrency": { "zh": "传输并发(1-16)", "en": "Transfer concurrency (1-16)" },
  "settings.remotesync.dryRun": { "zh": "预演", "en": "Dry run" },
  "settings.remotesync.dryResult": { "zh": "预演(未执行):推 {push} · 拉 {pull} · 删 {del} · 冲突 {conf}", "en": "Dry run (nothing executed): push {push} · pull {pull} · delete {del} · conflict {conf}" },
  "settings.remotesync.dbxAppKey": { "zh": "App Key(在 Dropbox App Console 创建应用获取)", "en": "App Key (create an app in Dropbox App Console)" },
  "settings.remotesync.dbxBaseDir": { "zh": "远端目录(默认根目录,如 /Forsion-Vault)", "en": "Remote folder (default root, e.g. /Forsion-Vault)" },
  "settings.remotesync.dbxConnect": { "zh": "连接 Dropbox", "en": "Connect Dropbox" },
  "settings.remotesync.dbxReconnect": { "zh": "重新连接", "en": "Reconnect" },
  "settings.remotesync.dbxConnected": { "zh": "已连接:{who}", "en": "Connected: {who}" },
  "settings.remotesync.dbxOpened": { "zh": "已打开浏览器授权页;同意后把页面上的授权码粘贴到下方。", "en": "Browser opened; approve and paste the code shown back below." },
  "settings.remotesync.dbxHintBuiltin": { "zh": "点「连接 Dropbox」在浏览器登录授权即可,授权完自动返回;文件同步到 Dropbox 的 应用/Forsion 目录下,凭据只存本机。", "en": "Click Connect Dropbox, sign in and approve in your browser — it returns automatically. Files live under Apps/Forsion in your Dropbox; credentials stay on this device." },
  "settings.remotesync.dbxUseOwnApp": { "zh": "改用自建 Dropbox 应用", "en": "Use my own Dropbox app" },
  "settings.remotesync.dbxOpenedAuto": { "zh": "已打开浏览器授权页;在浏览器里同意后会自动返回,无需手动复制。", "en": "Browser opened; approve there and the app picks it up automatically — no copy/paste." },
  "settings.remotesync.dbxWaiting": { "zh": "等待浏览器完成授权…", "en": "Waiting for browser authorization…" },
  "settings.remotesync.dbxCodePlaceholder": { "zh": "粘贴授权码", "en": "Paste authorization code" },
  "settings.remotesync.dbxFinish": { "zh": "完成连接", "en": "Finish" },
  "settings.remotesync.dbxNeedKey": { "zh": "先填 App Key", "en": "Enter App Key first" },
  "settings.remotesync.dbxHint": { "zh": "在 dropbox.com/developers 创建应用(Scoped access,权限勾 files.content.read/write),把 Redirect URI 登记为 http://localhost:53682/ ,App Key 填这里;点连接后在浏览器同意即自动完成,凭据只存本机。", "en": "Create an app at dropbox.com/developers (Scoped access with files.content.read/write), register http://localhost:53682/ as a Redirect URI, then paste its App Key here. Approving in the browser completes the connection automatically; credentials stay on this device." },
  "settings.remotesync.backendOff": { "zh": "关闭", "en": "Off" },
  "settings.remotesync.backendPenzor": { "zh": "Forsion 云端(条件写,推荐)", "en": "Forsion Cloud (conditional writes, recommended)" },
  "settings.remotesync.penzorVault": { "zh": "同步库名(默认 default)", "en": "Sync vault name (default: default)" },
  "settings.remotesync.penzorHint": { "zh": "使用 Forsion 账号登录态;每台设备同步到同一个库名即可互通。与「云端库」是两套机制,互不相干。", "en": "Uses your Forsion login. Point every device at the same vault name to sync. Independent from the Cloud vault." },
  "settings.remotesync.backendFolder": { "zh": "文件夹(U 盘 / NAS)", "en": "Folder (USB / NAS)" },
  "settings.remotesync.backendS3": { "zh": "S3 兼容(OSS / COS / MinIO / R2)", "en": "S3-compatible (OSS / COS / MinIO / R2)" },
  "settings.remotesync.backendWebdav": { "zh": "WebDAV(坚果云 / Nextcloud)", "en": "WebDAV (Nextcloud etc.)" },
  "settings.remotesync.folderPath": { "zh": "目标文件夹路径", "en": "Target folder path" },
  "settings.remotesync.pick": { "zh": "选择…", "en": "Choose…" },
  "settings.remotesync.s3Prefix": { "zh": "远端前缀(可选,如 vault/)", "en": "Remote prefix (optional, e.g. vault/)" },
  "settings.remotesync.wdUser": { "zh": "用户名", "en": "Username" },
  "settings.remotesync.wdPassword": { "zh": "密码 / 应用密码", "en": "Password / app password" },
  "settings.remotesync.wdBaseDir": { "zh": "远端目录(默认 forsion-vault)", "en": "Remote folder (default forsion-vault)" },
  "settings.remotesync.manualOnly": { "zh": "仅手动", "en": "Manual only" },
  "settings.remotesync.everyMin": { "zh": "每 {n} 分钟", "en": "Every {n} min" },
  "settings.remotesync.ignoreHint": { "zh": "忽略规则,一行一条:不含 / 匹配文件名;含 / 匹配完整路径;以 / 结尾匹配整个目录", "en": "Ignore rules, one per line: no \"/\" matches names; with \"/\" matches full path; trailing \"/\" matches a folder" },
  "settings.remotesync.test": { "zh": "测试连接", "en": "Test connection" },
  "settings.remotesync.testOk": { "zh": "连接正常", "en": "Connection OK" },
  "settings.remotesync.saved": { "zh": "已保存", "en": "Saved" },
  "settings.remotesync.syncNow": { "zh": "立即同步", "en": "Sync now" },
  "settings.remotesync.syncing": { "zh": "同步中…", "en": "Syncing…" },
  "settings.remotesync.lastResult": { "zh": "上次 {time}:推 {push} · 拉 {pull} · 删 {del} · 冲突 {conf}", "en": "Last {time}: up {push} · down {pull} · del {del} · conflicts {conf}" },
  "settings.remotesync.pendingDel": { "zh": "防误删闸:{n} 项删除已拦下,确认后才会执行", "en": "Mass-delete guard: {n} deletion(s) held, confirm to proceed" },
  "settings.remotesync.confirmDel": { "zh": "确认删除并同步", "en": "Confirm deletions & sync" },
  "settings.remotesync.errors": { "zh": "错误", "en": "Errors" },
  "settings.remotesync.rootErr.no-local-vault": { "zh": "未找到本地库(先在 Amadeus 打开一个本地 vault)", "en": "No local vault (open one in Amadeus first)" },
  "settings.remotesync.rootErr.cloud-vault-forbidden": { "zh": "当前活动库是云端库;此功能只同步本地库(云端库自带同步)", "en": "Active vault is the Cloud vault; this feature syncs the local vault only" },
  "settings.remotesync.rootErr.vault-missing": { "zh": "本地库路径不存在", "en": "Local vault path missing" },
  "settings.notes.cloudSyncState.disabled": { "zh": "未启用", "en": "Off" },
  "settings.notes.cloudSyncState.starting": { "zh": "启动中", "en": "Starting" },
  "settings.notes.cloudSyncState.idle": { "zh": "已同步", "en": "Up to date" },
  "settings.notes.cloudSyncState.syncing": { "zh": "同步中", "en": "Syncing" },
  "settings.notes.cloudSyncState.offline": { "zh": "离线(将自动重试)", "en": "Offline (will retry)" },
  "settings.notes.cloudSyncState.auth-required": { "zh": "未登录 Forsion 账号", "en": "Forsion login required" },
  "settings.notes.cloudSyncState.error": { "zh": "出错", "en": "Error" },
})
