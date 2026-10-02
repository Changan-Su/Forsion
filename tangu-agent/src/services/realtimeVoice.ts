/**
 * 实时语音通话(对标 GPT Live):渲染端 ⇄ 本引擎 ⇄ 百炼 Qwen-Omni-Realtime 的 WebSocket 中转。
 *
 *   ws://<engine>/agent/realtime?token=<本机 token>
 *   客户端 → 引擎:首帧 JSON {type:'start', session_id, model, voice?, title?, run:{model_id, app_id?, agent_config?}};
 *                  之后二进制帧 = 16kHz mono s16le PCM(麦克风);通话中 JSON {type:'run', run}(换委派参数,如 Effort)、
 *                  {type:'text', text}(打的字送进电话)。
 *   引擎 → 客户端:二进制帧 = 24kHz mono s16le PCM(模型语音);JSON = 上游事件原样转发(音频增量除外)
 *                  + {type:'tangu.run', status, run_id?, task} + {type:'transcript.corrected', message_id, text} + {type:'end', reason}。
 *
 * 分工:实时模型管听、说、轮次与打断(speech-to-speech,10-01 实测说完→出声 0.6–0.9s);要碰电脑 / 文件 / 联网 / 干活
 * 的请求经唯一工具 ask_tangu 交给本会话的 Tangu run(与输入框发出的 run 同一条路:同会话、同 agent_config、审批照常)。
 * 双方的话都写进会话(chat_messages),所以 Tangu 接活时看得到前文,聊天界面靠既有轮询(pollSession)把它们和代跑的 run 接上。
 *
 * 密钥只住引擎(brain.realtime 给地址 + 头);鉴权走 query token(浏览器 WebSocket 设不了 Authorization 头);
 * 远程来源(x-forsion-remote)一律拒 —— 通话会以本机身份起 run,远程设备另起一题。
 */
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { deps } from '../seams/runtime.js';
import { resolveProfile } from '../seams/appProfile.js';
import { createRun } from './runStore.js';
import { enqueueRun } from './agentLoop.js';
import { subscribe } from './eventBus.js';
import { getAgent, readAgentsMeta, resolveMemorySlug } from '../agents/agentRegistry.js';
import { agentsDir, readUserMd } from '../core/tanguHome.js';
import { createMemoryRepository } from './memoryRepository.js';

export const REALTIME_PATH = '/agent/realtime';
const HISTORY_TURNS = 12;
const DEFAULT_VOICE = 'Tina';

const ASK_TANGU = {
  type: 'function',
  name: 'ask_tangu',
  description: "Hand a task to Tangu, the agent that can use the user's computer, files, notes, apps, the web and tools. Returns later with the result.",
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The complete, self-contained task, written in the user\'s language.' },
      heard: { type: 'string', description: 'The user\'s latest words, verbatim, exactly as you heard them, in their language. The on-screen transcript comes from a separate speech recognizer that can mishear; this corrects it.' },
    },
    required: ['task', 'heard'],
  },
};

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** 通话人设:身份 + 说话方式 + 委派规则 + 人格 / 用户画像 / 记忆 / 本会话最近几轮。每次回应都会重计上下文,各段都封顶。 */
export async function buildVoiceInstructions(sessionId: string, agentSlug: string | undefined): Promise<string> {
  const slug = agentSlug || readAgentsMeta().defaultSlug;
  const def = await getAgent(slug).catch(() => null);
  const name = def?.name || 'Tangu';
  let memory = '';
  if (def) {
    try { memory = createMemoryRepository(path.join(agentsDir(), resolveMemorySlug(def))).snapshot().content; } catch { /* 没有记忆文件 */ }
  }
  let history = '';
  try {
    const st = deps().state;
    const total = await st.countSessionMessages(sessionId);
    const rows = await st.listSessionMessagesWindow(sessionId, HISTORY_TURNS, Math.max(0, total - HISTORY_TURNS));
    history = rows
      .filter((r) => (r.role === 'user' || r.role === 'model') && r.content?.trim())
      .map((r) => `${r.role === 'user' ? 'User' : name}: ${clip(r.content!.trim(), 400)}`)
      .join('\n');
  } catch { /* 新会话 */ }
  const sections: string[] = [
    `You are ${name}, the user's assistant, now in a live voice call with them.`,
    `Talk like a person on the phone: in the user's language, one to three short sentences, no markdown, lists, code or emoji. Never say you are Qwen, Tongyi or an Alibaba model; you are ${name}.`,
    `You cannot see the user's screen, files, notes, apps or the web yourself. Whenever the user wants something that needs them (looking something up, current information, reading or changing files, running a task), call ask_tangu with a complete, self-contained task and say in a few words that you're on it. Never make up results.`,
    `When a "[Tangu result]" system message arrives, tell the user the gist conversationally. Summarize long output; never read out paths, code or long lists verbatim. If the user interrupts you, stop and listen.`,
    `The user may also type messages during the call; answer those by voice in the same way.`,
  ];
  if (def?.soul?.trim()) sections.push(`## Your persona\n${clip(def.soul.trim(), 2000)}`);
  const user = readUserMd().trim();
  if (user) sections.push(`## About the user\n${clip(user, 2000)}`);
  if (memory.trim()) sections.push(`## Your memory\n${clip(memory.trim(), 3000)}`);
  if (history) sections.push(`## Recent messages in this chat\n${history}`);
  return sections.join('\n\n');
}

interface StartMsg {
  type: 'start';
  session_id: string;
  model: string;
  voice?: string;
  title?: string;
  run: { model_id: string; app_id?: string; agent_config?: Record<string, unknown> };
}

function validRun(run: any): run is StartMsg['run'] {
  if (typeof run?.model_id !== 'string' || !run.model_id) return false;
  const cfg = run.agent_config;
  return cfg == null || (typeof cfg === 'object' && !Array.isArray(cfg));
}

function parseStart(raw: string): StartMsg | null {
  let m: any;
  try { m = JSON.parse(raw); } catch { return null; }
  if (m?.type !== 'start' || typeof m.session_id !== 'string' || !m.session_id || typeof m.model !== 'string' || !m.model) return null;
  return validRun(m.run) ? m as StartMsg : null;
}

/** 用宿主的 authMiddleware 判 upgrade 请求(它只读 authorization 头,桩一个 res 就够)。 */
function authenticate(token: string): Promise<string | null> {
  return new Promise((resolve) => {
    const fakeReq: any = { headers: { authorization: `Bearer ${token}` } };
    const fakeRes: any = { status: () => fakeRes, json: () => resolve(null), sendStatus: () => resolve(null) };
    try {
      deps().host.authMiddleware(fakeReq, fakeRes, () => resolve(fakeReq.user?.userId ?? null));
    } catch { resolve(null); }
  });
}

const isLoopback = (addr: string | undefined): boolean => !!addr && (addr === '::1' || /^(::ffff:)?127\./.test(addr));

function reject(socket: Duplex, code: number, text: string): void {
  try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* ignore */ }
  socket.destroy();
}

export function attachRealtimeVoice(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== REALTIME_PATH) return reject(socket, 404, 'Not Found'); // 本进程没有别的 upgrade 消费者
    // 只收本机回环:通话以本机身份起 run(origin=client),远程来源另起一题。光看 x-forsion-remote 头不够 ——
    // 引擎经 TANGU_HOST 监听非回环时,远端持 token 省掉这个头就冒充本机了(Codex 10-01)。
    if (req.headers['x-forsion-remote'] || !isLoopback(req.socket.remoteAddress)) return reject(socket, 403, 'Forbidden');
    if (!deps().brain.realtime) return reject(socket, 501, 'Not Implemented');
    void authenticate(url.searchParams.get('token') || '').then((userId) => {
      if (!userId) return reject(socket, 401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (client) => handleCall(client, userId));
    });
  });
}

function handleCall(client: WebSocket, userId: string): void {
  let upstream: WebSocket | null = null;
  let start: StartMsg | null = null;
  let closed = false;
  let responding = false; // 上游有在途 response(期间再 response.create 会撞车)
  let wantResponse = false; // 等在途 response 结束后补一个
  let persist: Promise<void> = Promise.resolve(); // 通话记录按到达顺序落库;代跑 run 起之前先等它排空
  const unsubs = new Set<() => void>();
  // 每段用户语音(上游 item_id)→ 它落库那行的 id。委派 run 复用这一行当本轮用户消息(Codex 10-01):
  // 不另写一条「模型转述的任务」冒充用户说的话,也不会因转写晚到而顺序颠倒。
  const userRows = new Map<string, { row: Promise<string | null>; done: (id: string | null) => void; text?: string; typed?: boolean }>();
  let lastUserItem: string | null = null;
  const userRow = (itemId: string) => {
    let e = userRows.get(itemId);
    if (!e) { let done!: (id: string | null) => void; const row = new Promise<string | null>((r) => { done = r; }); e = { row, done }; userRows.set(itemId, e); }
    return e;
  };
  let pendingReply = ''; // 本次 response 的语音转写,等 response.done 再决定落不落库
  let skipNextReply = false; // 我们补要的那句「我去处理」不落库

  const toClient = (o: unknown): void => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(o)); };
  const toUpstream = (o: unknown): void => { if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(o)); };
  const end = (reason: string): void => {
    if (closed) return;
    closed = true;
    toClient({ type: 'end', reason });
    unsubs.forEach((u) => u());
    try { upstream?.close(); } catch { /* ignore */ }
    try { client.close(); } catch { /* ignore */ }
  };
  const requestResponse = (): void => {
    if (responding) wantResponse = true;
    else { responding = true; toUpstream({ type: 'response.create' }); }
  };
  const save = (fn: () => Promise<void>): void => {
    persist = persist.then(fn).catch((e) => console.warn('[realtime] persist failed:', e?.message || e));
  };
  // 通话中打的字(主窗输入框 → Mini → 这里):照语音那句一样落库、送进上游;模型正说着就掐掉(同插话),然后答这句。
  const sendText = (text: string): void => {
    const s = start!;
    const key = `typed:${uuidv4()}`;
    lastUserItem = key;
    const entry = userRow(key);
    entry.text = text;
    entry.typed = true;
    const id = uuidv4();
    save(async () => {
      try { await deps().state.insertUserMessage({ id, sessionId: s.session_id, content: text, modelId: s.model, attachments: null }); entry.done(id); }
      catch (e) { entry.done(null); throw e; }
    });
    toUpstream({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    if (responding) { wantResponse = true; toUpstream({ type: 'response.cancel' }); }
    else requestResponse();
  };

  const report = (text: string): void => {
    if (closed) return;
    toUpstream({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `[Tangu result] ${clip(text, 4000)}` }] } });
    requestResponse();
  };

  const delegate = async (task: string, heard: string): Promise<void> => {
    const s = start!;
    const item = lastUserItem;
    const entry = item ? userRow(item) : null;
    // 等触发这次委派的那段话落库(转写可能比工具调用晚到);等不到就退回「任务原文当本轮用户消息」。
    const reuse = entry ? await Promise.race([entry.row, new Promise<null>((r) => setTimeout(() => r(null), 3000))]) : null;
    await persist;
    if (closed) return;
    // 屏上那行来自旁路语音识别(qwen3-asr),会听错(10-02 实报:「贪吃蛇」落成「看知识」),而实时模型自己听对了。
    // 用它交来的原话改正那一行 —— 委派 run 的输入按这行从库里拼,不改正 Tangu 就照错字办事。打字那行本来就准,不动。
    const voiced = !!entry && !entry.typed;
    // 只差标点 / 空白不算听错(实测实时模型常把句末句号省掉),不改,省得把原话的标点抹掉。
    const bare = (x = ''): string => x.replace(/[\s\p{P}]/gu, '');
    if (reuse && voiced && bare(heard) && bare(heard) !== bare(entry!.text) && deps().state.correctUserMessage) {
      try {
        if (await deps().state.correctUserMessage!({ id: reuse, sessionId: s.session_id, content: heard })) {
          entry!.text = heard;
          toClient({ type: 'transcript.corrected', message_id: reuse, text: heard });
        }
      } catch (e: any) { console.warn('[realtime] correct transcript failed:', e?.message || e); }
    }
    const profile = resolveProfile(s.run.app_id);
    if (!profile) throw new Error(`unknown app_id: ${s.run.app_id}`);
    const runId = uuidv4();
    let off: () => void = () => {};
    const done = new Promise<string>((resolve, rejectRun) => {
      off = subscribe(runId, (ev) => {
        if (ev.type === 'done') { off(); unsubs.delete(off); resolve(String(ev.payload?.content ?? '')); }
        else if (ev.type === 'error') { off(); unsubs.delete(off); rejectRun(new Error(String(ev.payload?.message || ev.payload?.error || 'run failed'))); }
      });
      unsubs.add(off);
    });
    try {
      await createRun({
        id: runId, sessionId: s.session_id, userId, appId: profile.appId, modelId: s.run.model_id, assistantMessageId: uuidv4(),
        // 等同用户在输入框发出:origin=client(审批档现读会话设置)、审批托盘握手(待批卡出在输入框上方)。
        // 复用语音那行时 insertUserMessage 是 ON CONFLICT DO NOTHING:库里留用户原话,模型按原话 + 前文接活。
        input: {
          message: task, userMessageId: reuse || uuidv4(), attachments: [], agentConfig: s.run.agent_config || {}, origin: 'client', approvalTray: true,
          // 只进本 run 的模型上下文、不进聊天记录(agent_runs.input 里随 run 留一份):改正没成(没交原话 / 存储不支持)时,Tangu 也拿得到实时模型的理解。
          ...(voiced ? { ephemeralHint: `This request came from a voice call. The user's message above is a speech-recognition transcript and may contain mishearings. The voice assistant understood the request as: "${clip(task, 1000)}". If they differ, follow the voice assistant's understanding.` } : {}),
        },
      });
      enqueueRun(s.session_id, runId);
    } catch (e) {
      off(); unsubs.delete(off);
      throw e;
    }
    toClient({ type: 'tangu.run', status: 'started', run_id: runId, task });
    try {
      const result = (await done).trim() || '(no output)';
      toClient({ type: 'tangu.run', status: 'done', run_id: runId, task });
      // 结果常以 run 动手前那句「我先看看」开头(低思考档尤甚);不点明「已经办完」,实时模型会照着那句再说一遍「正在查看」(10-02 live 实测)。
      report(`Task complete. Tangu's final answer follows; tell the user now (any opening "let me check" line was said before the work, ignore it):\n${result}`);
    } catch (e: any) {
      toClient({ type: 'tangu.run', status: 'error', run_id: runId, task });
      report(`The task failed: ${e?.message || e}`);
    }
  };

  const onUpstream = (raw: WebSocket.RawData): void => {
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const s = start!;
    switch (m.type) {
      case 'response.audio.delta':
        if (client.readyState === WebSocket.OPEN && typeof m.delta === 'string') client.send(Buffer.from(m.delta, 'base64'));
        return;
      case 'input_audio_buffer.speech_started':
        // 用户开口:模型还在生成就掐掉(客户端那边同时清空播放队列)。
        if (responding) toUpstream({ type: 'response.cancel' });
        break;
      case 'response.created':
        responding = true;
        pendingReply = '';
        break;
      case 'response.done': {
        responding = false;
        const out: any[] = m.response?.output || [];
        const calledTool = out.some((o) => o?.type === 'function_call');
        // 带工具调用的那轮只是「我去看看」:不落库 —— 落了就夹在本轮用户消息与代跑 run 之间,run 的输入会以 assistant 收尾。
        const text = pendingReply.trim();
        pendingReply = '';
        if (text && !calledTool && !skipNextReply) {
          const agentSlug = typeof s.run.agent_config?.agentSlug === 'string' ? s.run.agent_config.agentSlug : undefined;
          save(() => deps().state.finalizeAssistantMessage({ messageId: uuidv4(), sessionId: s.session_id, modelId: s.model, content: text, reasoning: '', toolCalls: [], toolResults: [], agentSlug }));
        }
        skipNextReply = false;
        // 模型只发了工具调用、没开口 → 补一轮让它说「我去处理」(那句同样不落库);以及排队等着的结果播报。
        if (calledTool && !out.some((o) => o?.type === 'message')) { wantResponse = true; skipNextReply = true; }
        if (wantResponse) { wantResponse = false; requestResponse(); }
        break;
      }
      case 'input_audio_buffer.committed':
        if (typeof m.item_id === 'string') { lastUserItem = m.item_id; userRow(m.item_id); }
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(m.transcript || '').trim();
        const entry = typeof m.item_id === 'string' ? userRow(m.item_id) : null;
        if (!text) { entry?.done(null); break; }
        const id = uuidv4();
        if (entry) entry.text = text;
        save(async () => {
          try { await deps().state.insertUserMessage({ id, sessionId: s.session_id, content: text, modelId: s.model, attachments: null }); entry?.done(id); }
          catch (e) { entry?.done(null); throw e; }
        });
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        if (typeof m.item_id === 'string') userRow(m.item_id).done(null);
        break;
      case 'response.audio_transcript.done':
        pendingReply += String(m.transcript || '');
        break;
      case 'response.function_call_arguments.done': {
        if (m.name !== 'ask_tangu') break;
        let task = '', heard = '';
        try { const a = JSON.parse(m.arguments || '{}'); task = String(a.task || '').trim(); heard = clip(String(a.heard || '').trim(), 4000); } catch { /* 坏参数 */ }
        // 立刻答复这次调用(别让 call_id 悬一整个 run):结果稍后以 system 消息送回。
        toUpstream({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: m.call_id, output: JSON.stringify(task ? { status: 'started', note: 'Tangu is working on it; the result will arrive as a [Tangu result] message.' } : { status: 'error', note: 'Empty task.' }) } });
        // 起不来(建 run 失败等)也要告诉模型,别让它以为还在办(Codex 10-01)。
        if (task) void delegate(task, heard).catch((e) => { toClient({ type: 'tangu.run', status: 'error', task, error: e?.message || String(e) }); report(`The task could not be started: ${e?.message || e}`); });
        break;
      }
      case 'error':
        console.warn('[realtime] upstream error:', m.error?.message || JSON.stringify(m.error));
        break;
    }
    toClient(m);
  };

  const open = async (s: StartMsg): Promise<void> => {
    const st = deps().state;
    const owner = await st.getSessionOwner(s.session_id);
    if (owner && owner !== userId) return end('session not found');
    const profile = resolveProfile(s.run.app_id);
    if (!profile) return end(`unknown app_id: ${s.run.app_id}`);
    if (!owner) await st.autoCreateSession({ id: s.session_id, userId, appId: profile.appId, title: s.title || 'Voice call', modelId: s.run.model_id });
    let ep: { url: string; headers: Record<string, string> };
    try { ep = deps().brain.realtime!.endpoint(s.model); } catch (e: any) { return end(e?.message || String(e)); }
    const agentSlug = typeof s.run.agent_config?.agentSlug === 'string' ? s.run.agent_config.agentSlug : undefined;
    const instructions = await buildVoiceInstructions(s.session_id, agentSlug);
    if (closed) return;
    const up = new WebSocket(ep.url, { headers: ep.headers });
    upstream = up;
    up.on('open', () => {
      toUpstream({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          voice: s.voice || DEFAULT_VOICE,
          instructions,
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
          turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 600 },
          tools: [ASK_TANGU],
        },
      });
      toClient({ type: 'ready' });
    });
    up.on('message', onUpstream);
    up.on('unexpected-response', (_q, r) => end(`upstream HTTP ${r.statusCode}`));
    up.on('error', (e) => end(e.message));
    up.on('close', (code, reason) => end(reason.toString() || `upstream closed (${code})`));
  };

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      if (upstream?.readyState === WebSocket.OPEN) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        toUpstream({ type: 'input_audio_buffer.append', audio: buf.toString('base64') });
      }
      return;
    }
    if (start) {
      // 通话中换档(Mini 里选 Effort):之后委派的 run 按新参数跑;app_id 随通话定死,不换 profile。
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m?.type === 'run' && validRun(m.run)) start.run = { ...m.run, app_id: start.run.app_id };
      else if (m?.type === 'text' && typeof m.text === 'string' && m.text.trim() && upstream?.readyState === WebSocket.OPEN) sendText(clip(m.text.trim(), 4000));
      return;
    }
    start = parseStart(data.toString());
    if (!start) return end('bad start message');
    void open(start).catch((e) => end(e?.message || String(e)));
  });
  client.on('close', () => end('client closed'));
  client.on('error', () => end('client error'));
}
