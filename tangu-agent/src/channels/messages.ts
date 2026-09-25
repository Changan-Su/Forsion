/**
 * 通道(微信 / Telegram / QQ)回给用户的文案:成对的 {zh, en},按一次入站解析出的语言**只出一种**
 * (两种拼一起 /help 就爆微信 ~2000 字的单条上限)。模型读的东西(工具结果、rejectReason、落进
 * 用户消息的文件提示)不走这里,一律英文。
 *
 * 占位符 `{var}` zh/en 逐字一致;新增键两边都要写(本文件是纯表,漏写 en 由 messages.test 钉住)。
 */
import type { ChannelKind } from './types.js';

export type ChannelLocale = 'zh' | 'en';

/**
 * 语言判定:① 通道设置里手选的 locale → ② env TANGU_LANG(宿主可注入界面语言;与 TUI 的 tui/i18n.ts 同一个名字,
 * 宿主注入一次两边都生效)→ ③ LC_ALL / LC_MESSAGES / LANG → ④ Intl 说是 zh-* → ⑤ 平台缺省(微信 / QQ = zh,Telegram = en)。
 *
 * 为什么有 ⑤、以及 ④ 只信 zh:Finder 启动的桌面端没有 LANG,引擎继承空 env,Node 的 ICU 此时恒报 en-US
 * (实测 `env -u LANG node` → en-US)—— 拿它当「系统语言是英文」会把每个中文微信用户的回复翻成英文。
 * 没有任何系统信号时,平台本身就是最强信号(同 CLAUDE.md 语言链里 IP 那一档的用意)。
 */
export function resolveChannelLocale(kind: ChannelKind, override?: unknown, env: NodeJS.ProcessEnv = process.env): ChannelLocale {
  const pick = (v: unknown): ChannelLocale | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || s === 'C' || s === 'POSIX' || /^C\./.test(s)) return null;
    return /^zh/i.test(s) ? 'zh' : 'en';
  };
  const explicit = pick(override) ?? pick(env.TANGU_LANG) ?? pick(env.LC_ALL) ?? pick(env.LC_MESSAGES) ?? pick(env.LANG);
  if (explicit) return explicit;
  try {
    if (/^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale)) return 'zh';
  } catch { /* 无 Intl:落平台缺省 */ }
  return kind === 'telegram' ? 'en' : 'zh';
}

type Pair = { zh: string; en: string };

export const CHANNEL_MESSAGES = {
  // ── 管线 ──
  unbound: {
    zh: '这个{channel}聊天尚未绑定 Tangu Agent,请先在 Tangu Desktop 设置 → 通道 里连接。',
    en: 'This {channel} chat is not bound to Tangu Agent yet. Connect it in Tangu Desktop → Settings → Channels first.',
  },
  sessionsOff: {
    zh: '通道会话功能当前已关闭(仅收件箱转发在工作)。可在 Tangu Desktop 设置 → 通道 里开启。',
    en: 'Channel sessions are turned off (only inbox forwarding is active). Turn them on in Tangu Desktop → Settings → Channels.',
  },
  sessionMissing: {
    zh: '绑定的 Tangu 会话不存在,请在 Tangu Desktop 重新连接通道,或回复 /new 新建会话。',
    en: 'The connected Tangu session no longer exists. Reconnect the channel in Tangu Desktop, or send /new to start a session.',
  },
  noModel: {
    zh: 'Tangu Agent 还没有可用的模型。回复 /model 选一个,或在 Tangu Desktop 里设置默认模型。',
    en: 'Tangu Agent has no model yet. Send /model to pick one, or set a default model in Tangu Desktop.',
  },
  stopOne: { zh: '已停止当前任务。', en: 'Stopped the current task.' },
  stopMany: { zh: '已停止 {n} 个任务(含排队中的)。', en: 'Stopped {n} tasks (including queued ones).' },
  stopNone: { zh: '当前没有正在运行的任务。', en: 'No task is running right now.' },
  expired: { zh: '该请求已过期,或已在别处处理。', en: 'This request has expired or was already handled elsewhere.' },
  serviceStopped: { zh: '通道服务已停止。', en: 'The channel service has stopped.' },
  stillRunning: {
    zh: 'Tangu Agent 仍在执行中。完成后我会把结果发给你;如需停止,请回复「停止」。',
    en: 'Tangu Agent is still working. I will send you the result when it finishes; reply "stop" to cancel.',
  },
  done: { zh: '完成。', en: 'Done.' },
  taskStopped: { zh: '任务已停止。', en: 'The task was stopped.' },
  taskFailed: { zh: '任务失败:{error}', en: 'The task failed: {error}' },
  untitled: { zh: '未命名', en: 'Untitled' },

  // ── 审批 / 询问 ──
  approvalCard: {
    zh: '⚠️ 需要你批准这个操作:\n{preview}\n\n回复「批准」执行,「拒绝」取消,或「停止」结束任务。{minutes} 分钟内没有回复将自动拒绝。',
    en: '⚠️ This action needs your approval:\n{preview}\n\nReply "approve" to run it, "reject" to skip it, or "stop" to end the task. With no reply within {minutes} minutes it is rejected automatically.',
  },
  approvalPreviewFallback: { zh: '操作', en: 'action' },
  approvalTooLong: {
    zh: '⚠️ 有个操作需要批准,但内容太长({chars} 字),聊天里显示不全,已自动拒绝、没有执行。开头是:\n{head}\n\n如需执行,请到 Tangu Desktop 里继续这个任务,在那里看全文并批准。',
    en: '⚠️ An action needs approval, but it is too long ({chars} characters) to show in full in this chat, so it was rejected automatically and not run. It starts with:\n{head}\n\nTo run it, continue this task in Tangu Desktop, where you can review the full text and approve it.',
  },
  approvalPartsCheck: {
    zh: '(这个请求共分 {n} 条发出;没收全就回复「拒绝」。)',
    en: '(This request came in {n} parts. If you did not get all of them, reply "reject".)',
  },
  approvalDeliveryFailed: {
    zh: '⚠️ 下面这个待批操作有部分内容没能发到这里,已自动拒绝、没有执行:\n{head}\n\n如需执行,请到 Tangu Desktop 里继续这个任务,在那里看全文并批准。',
    en: '⚠️ Part of this approval request could not be delivered to this chat, so it was rejected automatically and not run:\n{head}\n\nTo run it, continue this task in Tangu Desktop, where you can review the full text and approve it.',
  },
  promptStillPending: {
    zh: '⏳ 注意:上面还有一个请求在等你答复,你接下来的回复(包括「批准」「好的」)都会作用于它:\n{head}',
    en: '⏳ Note: an earlier request above is still waiting for your answer, and your next reply (including "approve" or "ok") applies to it:\n{head}',
  },
  approvalTimedOut: {
    zh: '⌛ {minutes} 分钟内没有回复,已自动拒绝,该操作没有执行:\n{preview}',
    en: '⌛ No reply within {minutes} minutes, so the approval was rejected automatically and the action was not run:\n{preview}',
  },
  inquiryTruncated: { zh: '…(问题较长,完整内容见 Tangu Desktop)', en: '… (the question is long; see Tangu Desktop for the full text)' },
  inquiryHintOptions: {
    zh: '回复序号选择,或直接回复文字作答;回复「停止」结束任务。',
    en: 'Reply with a number to choose, or just type your answer. Reply "stop" to end the task.',
  },
  inquiryHintFree: { zh: '直接回复文字作答;回复「停止」结束任务。', en: 'Just type your answer. Reply "stop" to end the task.' },
  promptsQueued: {
    zh: '(之后还有 {n} 个待你处理,回完这个会接着发来。)',
    en: '({n} more waiting; they come one at a time after you answer this one.)',
  },
  inquiryNeedsText: {
    zh: '请用文字回答上面的问题,或回复「停止」结束任务。',
    en: 'Please answer the question above in text, or reply "stop" to end the task.',
  },
  planReady: { zh: '📋 计划已就绪,要批准吗?', en: '📋 The plan is ready. Approve it?' },
  planTruncated: { zh: '…(计划较长,完整内容见 Tangu Desktop)', en: '… (the plan is long; see Tangu Desktop for the full text)' },
  planApproveStart: { zh: '批准,马上开始执行', en: 'Approve and start now' },
  planApproveManual: { zh: '批准,等我下一条消息再开始', en: 'Approve; start on my next message' },
  planReject: { zh: '拒绝,保持计划模式', en: 'Reject and stay in plan mode' },
  planHint: {
    zh: '回复序号选择,或直接回复修改意见;回复「停止」结束任务。',
    en: 'Reply with a number, or type your feedback to request changes. Reply "stop" to end the task.',
  },
  planKickoff: { zh: '计划已批准,开始执行。', en: 'The plan is approved — proceed with it now.' },

  // ── 命令通用 ──
  unknownCommand: {
    zh: '未知命令 {cmd}。回复 /help 查看可用命令;如果不是命令,去掉开头的 / 再发一次。',
    en: 'Unknown command {cmd}. Send /help to see the commands; if this was not meant as a command, resend it without the leading /.',
  },
  commandFailed: { zh: '命令执行失败:{error}', en: 'The command failed: {error}' },
  helpTitle: { zh: '可用命令:', en: 'Commands:' },
  helpStop: { zh: '停止 — 中止当前任务(同 /stop)', en: 'stop — stop the current task (same as /stop)' },
  helpApprove: { zh: '批准 / 拒绝 — 回复待批的操作', en: 'approve / reject — answer a pending approval' },
  helpNatural: {
    zh: '切模型、调思考档也可以直接跟 Agent 说,比如「切到 opus」「想深一点」。',
    en: 'You can also just ask the agent, e.g. "switch to opus" or "think harder".',
  },

  // ── 会话 ──
  newDone: {
    zh: '✓ 已新建会话并切换连接,之后的消息都发往这个新会话。回复 /sessions 查看全部。',
    en: '✓ Started a new session and connected to it; new messages go there. Send /sessions to see all sessions.',
  },
  sessionsEmpty: { zh: '当前还没有会话。回复 /new 新建一个。', en: 'No sessions yet. Send /new to start one.' },
  sessionsList: {
    zh: '通道会话(● 为正在连接):\n{lines}\n\n回复 /resume <序号> 切换。',
    en: 'Channel sessions (● = connected):\n{lines}\n\nSend /resume <number> to switch.',
  },
  listMore: { zh: '…另有 {n} 条未列出', en: '… {n} more not shown' },
  resumeInvalid: { zh: '找不到这个会话。回复 /sessions 查看会话(共 {n} 个)。', en: 'No such session. Send /sessions to see the sessions ({n} in total).' },
  resumeDone: { zh: '✓ 已切换到会话 {n}:{title}。', en: '✓ Switched to session {n}: {title}.' },

  // ── Agent / 语音 ──
  agentsEmpty: { zh: '还没有可用的 Agent。回复 /help 查看其它命令。', en: 'No agents are available. Send /help for other commands.' },
  agentsList: { zh: '可用 Agent(● 为当前):\n{lines}\n\n回复 /agent <slug> 切换。', en: 'Agents (● = current):\n{lines}\n\nSend /agent <slug> to switch.' },
  agentUsage: { zh: '用法:/agent <slug>。回复 /agents 查看可用 Agent。', en: 'Usage: /agent <slug>. Send /agents to see the available agents.' },
  agentNotFound: { zh: '未找到 Agent:{slug}。回复 /agents 查看可用列表。', en: 'Agent not found: {slug}. Send /agents to see the list.' },
  agentDone: { zh: '✓ 已切换到 Agent:{name}({slug}),之后本会话的消息都用它。', en: '✓ Switched to agent {name} ({slug}); this session uses it from now on.' },
  agentModel: { zh: '按该 Agent 的设定,本会话模型也切到了 {model}(从下一条消息起)。', en: "Following the agent's setting, this session's model is now {model} (from your next message)." },
  voiceOn: {
    zh: '✓ 已切到语音消息:之后本会话的回复会附带一条可播放的语音文件。需配置 TTS 模型(Desktop 设置 → 模型 → 语音朗读,或通道的语音模型);未配则只发文字。回复 /text 切回文字。',
    en: '✓ Switched to voice messages: replies in this session also come as a playable audio file. This needs a TTS model (Desktop Settings → Models → Read aloud, or the channel voice model); without one only text is sent. Send /text to switch back.',
  },
  voiceOff: { zh: '✓ 已切回文字消息。回复 /voice 再切到语音。', en: '✓ Switched back to text messages. Send /voice to switch to voice again.' },
  toggleFailed: { zh: '切换失败:{error}', en: 'Could not switch: {error}' },

  // ── /model ──
  modelListHead: { zh: '可选模型(● 为当前,共 {n} 个):', en: 'Models (● = current, {n} in total):' },
  modelListMore: { zh: '…还有 {n} 个未列出,发 /model <关键词> 筛选。', en: '… {n} more not shown. Send /model <keyword> to filter.' },
  modelListHint: {
    zh: '10 分钟内回复序号,或发 /model <名称> 切换。只改本会话,从下一条消息起生效;加 --default 同时设为本通道新会话的默认模型。',
    en: 'Reply with a number within 10 minutes, or send /model <name>. Only this session changes, from your next message; add --default to also make it the default for new sessions in this channel.',
  },
  modelEmpty: { zh: '没有可用的模型(模型目录为空或无法访问)。', en: 'No models are available (the model catalog is empty or unreachable).' },
  modelNone: { zh: '没有匹配「{q}」的模型。发 /model 查看全部。', en: 'No model matches "{q}". Send /model to see them all.' },
  modelAmbiguous: { zh: '「{q}」匹配到多个模型,10 分钟内回复序号选择:\n{lines}', en: '"{q}" matches several models. Reply with a number within 10 minutes:\n{lines}' },
  modelIndexInvalid: { zh: '序号无效(1–{n})。发 /model 重新列出。', en: 'Invalid number (1–{n}). Send /model to list the models again.' },
  modelSet: {
    zh: '✓ 已把本会话的模型切到 {model}。只影响本会话,从下一条消息起生效。',
    en: "✓ Switched this session's model to {model}. Only this session changes, from your next message.",
  },
  modelSame: { zh: '本会话已经在用 {model}。', en: 'This session already uses {model}.' },
  modelBusy: { zh: '已在跑或排队的任务仍用原来的模型。', en: 'Tasks that are already running or queued keep the previous model.' },
  modelThinkClamp: { zh: '思考档 {req} 在这个模型上按 {eff} 跑。', en: 'Thinking level {req} runs as {eff} on this model.' },
  modelDefaultSaved: { zh: '同时已设为本通道新会话的默认模型。', en: 'Also saved as the default model for new sessions in this channel.' },
  modelFailed: { zh: '读取模型目录失败:{error}', en: 'Could not load the model catalog: {error}' },

  // ── /think ──
  thinkShow: {
    zh: '思考档:{req}{eff}\n本模型支持:{levels}\n发 /think <档位> 调整,可选 {all}。',
    en: 'Thinking level: {req}{eff}\nThis model supports: {levels}\nSend /think <level> to change it; levels: {all}.',
  },
  thinkEff: { zh: '(本模型按 {eff} 跑)', en: ' (runs as {eff} on this model)' },
  thinkUnknownLevels: { zh: '未知', en: 'unknown' },
  thinkSet: { zh: '✓ 思考档已设为 {level}{eff},从下一条消息起生效。', en: '✓ Thinking level set to {level}{eff}; it applies from your next message.' },
  thinkSetLive: { zh: '✓ 思考档已设为 {level}{eff};正在跑的任务从下一步起就按新档。', en: '✓ Thinking level set to {level}{eff}; the running task uses it from its next step.' },
  thinkInvalid: { zh: '不认识的思考档「{v}」。可选:{all}。', en: 'Unknown thinking level "{v}". Use one of: {all}.' },

  // ── /approval ──
  approvalShow: {
    zh: '审批档:{label} — {desc}\n\n通道里不能改审批档:通道消息不带发送者身份,群聊里任何人都能发命令。要改请在 Tangu Desktop 设置 → 通道 里调整,已连接的会话从下一条消息起按新档跑(已在跑的任务不变)。',
    en: "Approval mode: {label} — {desc}\n\nThe approval mode can't be changed from the chat: channel messages carry no sender identity, so in a group anyone could send the command. Change it in Tangu Desktop → Settings → Channels; connected sessions use the new mode from your next message (a task already running keeps its mode).",
  },

  // ── /loop ──
  loopShow: { zh: '循环上限:{n} 轮({source})。发 /loop <1-200> 调整,/loop default 恢复默认。', en: 'Loop cap: {n} iterations ({source}). Send /loop <1-200> to change it, or /loop default to reset.' },
  loopSrcSession: { zh: '本会话设置', en: 'set for this session' },
  loopSrcAgent: { zh: 'Agent「{slug}」的设定', en: 'from agent {slug}' },
  loopSrcDefault: { zh: '默认', en: 'default' },
  loopSet: { zh: '✓ 本会话循环上限已设为 {n} 轮,从下一条消息起生效。', en: '✓ Loop cap for this session set to {n} iterations, from your next message.' },
  loopReset: { zh: '✓ 已恢复默认循环上限({n} 轮)。', en: '✓ Loop cap reset to the default ({n} iterations).' },
  loopInvalid: { zh: '请给 1–200 之间的整数,例如 /loop 50。', en: 'Give a whole number from 1 to 200, e.g. /loop 50.' },

  // ── /compact ──
  compactBusy: { zh: '有任务正在运行,等它结束再压缩(或先回复「停止」)。', en: 'A task is running. Compact after it finishes (or reply "stop" first).' },
  compactDone: { zh: '✓ 已压缩上下文:{n} 条消息总结成了摘要,之后的对话从摘要续接。', en: '✓ Compacted the context: {n} messages were summarized, and the conversation continues from the summary.' },
  compactNothing: { zh: '还没有可压缩的内容。', en: 'Nothing to compact yet.' },
  compactFailed: { zh: '压缩失败:{reason}', en: 'Compaction failed: {reason}' },

  // ── /cost ──
  costShow: { zh: '本会话用量:{tokens} tokens · {runs} 次运行{cost}{cached}', en: 'Usage for this session: {tokens} tokens · {runs} runs{cost}{cached}' },
  costPart: { zh: ' · 约 {cost} 费用单位', en: ' · about {cost} cost units' },
  cachedPart: { zh: ' · 缓存命中 {cached} tokens', en: ' · {cached} cached tokens' },

  // ── /status ──
  statusTitle: { zh: '📊 本会话概况', en: '📊 Session overview' },
  statusSession: { zh: '会话:{v}', en: 'Session: {v}' },
  statusAgent: { zh: 'Agent:{v}', en: 'Agent: {v}' },
  statusModel: { zh: '模型:{v}', en: 'Model: {v}' },
  statusThink: { zh: '思考档:{v}', en: 'Thinking: {v}' },
  statusApproval: { zh: '审批档:{v}(在 Desktop 通道设置里改)', en: 'Approval: {v} (change it in the Desktop channel settings)' },
  statusLoop: { zh: '循环上限:{v}', en: 'Loop cap: {v}' },
  statusCwd: { zh: '工作目录:{v}', en: 'Working folder: {v}' },
  statusUsage: { zh: '用量:{v} tokens(/cost 看明细)', en: 'Usage: {v} tokens (/cost for details)' },
  statusState: { zh: '状态:{v}', en: 'State: {v}' },
  stateIdle: { zh: '空闲', en: 'idle' },
  stateRuns: { zh: '{n} 个任务在跑或排队', en: '{n} task(s) running or queued' },
  stateBusy: { zh: '本会话有任务在跑(不是从这个聊天发起的)', en: 'a task started elsewhere is running in this session' },
  stateApproval: { zh: '等你批准一个操作', en: 'waiting for your approval' },
  stateInquiry: { zh: '等你回答一个问题', en: 'waiting for your answer' },
  statusModelUnset: { zh: '(未设置)', en: '(not set)' },
} satisfies Record<string, Pair>;

export type ChannelMessageKey = keyof typeof CHANNEL_MESSAGES;

/** 取一条文案并代入 `{var}`。 */
export function channelMsg(locale: ChannelLocale, key: ChannelMessageKey, vars?: Record<string, string | number>): string {
  const text = CHANNEL_MESSAGES[key][locale];
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export const CHANNEL_NAME: Record<ChannelKind, Pair> = {
  wechat: { zh: '微信', en: 'WeChat' },
  telegram: { zh: ' Telegram ', en: 'Telegram' },
  qq: { zh: ' QQ ', en: 'QQ' },
};

/** 单条回复的安全上限(微信 iLink 约 2000 字切条;留余量给表情 / 换行)。 */
export const CHANNEL_REPLY_MAX = 1800;

/** 超长就截断并加省略号(命令回复用;agent 正文走 replySegment 分段,不在这里)。 */
export function clipReply(text: string, max = CHANNEL_REPLY_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
