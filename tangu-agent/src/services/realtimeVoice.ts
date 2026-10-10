/**
 * 实时语音通话(对标 GPT Live):渲染端 ⇄ 本引擎 ⇄ 百炼 Qwen-Omni-Realtime 的 WebSocket 中转。
 * 上游有两条路(brain.realtime.endpoint 按模型 id 分):自带百炼 key 直连;或 Forsion 云端的实时模型 —— 经云端 /api/brain/realtime
 * 中转(key 与计费在云端,帧协议不变,云端拒绝 / 挂断的原因以 `<4xx> …` 回来)。
 *
 *   ws://<engine>/agent/realtime?token=<本机 token>
 *   (令牌也可以放在子协议里:Sec-WebSocket-Protocol: forsion.bearer, <token> —— 走公网的那一段用这个,登录令牌不进 URL、不进反代日志)
 *   客户端 → 引擎:首帧 JSON {type:'start', session_id, model, voice?, title?, run:{model_id, app_id?, agent_config?}};
 *                  之后二进制帧 = 16kHz mono s16le PCM(麦克风);通话中 JSON {type:'run', run}(换委派参数,如 Effort)、
 *                  {type:'text', text}(打的字送进电话)。
 *   引擎 → 客户端:二进制帧 = 24kHz mono s16le PCM(模型语音);JSON = 上游事件原样转发(音频增量除外)
 *                  + {type:'tangu.run', status, run_id?, task} + {type:'transcript.corrected', message_id, text} + {type:'end', reason}
 *                  + {type:'reconnecting', replay}(上游服务端出错断开、正换一条重连,replay = 断在没答完的那句上、会重答;接上后再发一次 ready)。
 *
 * 分工:实时模型管听、说、轮次与打断(speech-to-speech,10-01 实测说完→出声 0.6–0.9s);要碰电脑 / 文件 / 联网 / 干活
 * 的请求经唯一工具 ask_tangu 交给本会话的 Tangu run(与输入框发出的 run 同一条路:同会话、同 agent_config、审批照常)。
 * 双方的话都写进会话(chat_messages),所以 Tangu 接活时看得到前文,聊天界面靠既有轮询(pollSession)把它们和代跑的 run 接上。
 *
 * 密钥只住引擎(brain.realtime 给地址 + 头);鉴权走 query token(浏览器 WebSocket 设不了 Authorization 头);
 * 远程来源(x-forsion-remote)一律拒 —— 通话会以本机身份起 run,远程设备另起一题。
 *
 * 两种宿主(RealtimeVoiceHost):本机引擎(attachRealtimeVoice,上面说的就是它);Forsion 服务端网关(手机 / 网页版连的那一头,
 * 自己不跑 loop)—— 它经 handleRealtimeUpgrade 接手 Upgrade,把「连哪个上游」「委派的 run 交给谁跑」换成自己的,其余(人设、
 * 转写落库、改正、重连)是同一份代码。网关上人设从云端取(cloudAgentStore / brain.memory),不读本机文件。
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { deps } from '../seams/runtime.js';
import { resolveProfile } from '../seams/appProfile.js';
import { createRun, getRunForUser } from './runStore.js';
import { enqueueRun } from './agentLoop.js';
import { subscribe } from './eventBus.js';
import { getAgent, readAgentsMeta, resolveMemorySlug } from '../agents/agentRegistry.js';
import { cloudAgentsEnabled, cloudGetAgent, cloudReadAgentsMeta } from '../agents/cloudAgentStore.js';
import { agentsDir, readUserMd } from '../core/tanguHome.js';
import { createMemoryRepository } from './memoryRepository.js';
import { runWithUserAgentScope } from '../seams/runContext.js';

export const REALTIME_PATH = '/agent/realtime';
/** 子协议鉴权:客户端 new WebSocket(url, [REALTIME_BEARER_PROTOCOL, token]);握手里必须把这个名字回给它,否则浏览器当握手失败。 */
export const REALTIME_BEARER_PROTOCOL = 'forsion.bearer';
const HISTORY_TURNS = 12;
/**
 * 没给音色时用的缺省,按模型家族分:Qwen-Audio 那一族没有 Tina 这类 Omni 音色。
 * 两族都必须显式给 —— qwen-audio-3.1 不传 voice 时 session.updated 回一个它自己并不支持的名字,到生成才报错(10-04 实测)。
 * longanqian 是 3.0 / 3.1 各型号都认的那个。
 */
export const defaultRealtimeVoice = (model: string): string => (/(^|\/)qwen-audio-/i.test(model) ? 'longanqian' : 'Tina');

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

/**
 * 通话人设:身份 + 说话方式 + 委派规则 + 人格 / 用户画像 / 记忆 / 本会话最近几轮。每次回应都会重计上下文,各段都封顶。
 * userId 只在云端多租户用得上(按它取这个人自己的 Agent 与记忆);那里没有「用户画像」那一段 —— 云端的 run 也没有,
 * 而本进程的 USER.md 是服务器自己的文件,不属于任何一个用户。
 */
export async function buildVoiceInstructions(sessionId: string, agentSlug: string | undefined, userId = ''): Promise<string> {
  const cloud = cloudAgentsEnabled();
  const slug = agentSlug || (cloud ? (await cloudReadAgentsMeta(userId).catch(() => null))?.defaultSlug || '' : readAgentsMeta().defaultSlug);
  const def = await (cloud ? cloudGetAgent(userId, slug) : getAgent(slug)).catch(() => null);
  const name = def?.name || 'Tangu';
  let memory = '';
  if (def && cloud) {
    try { memory = String((await runWithUserAgentScope(userId, resolveMemorySlug(def), () => deps().brain.memory.getMemory(userId)))?.content || ''); } catch { /* 没有记忆 */ }
  } else if (def) {
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
  const user = cloud ? '' : readUserMd().trim();
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

/** 委派给 Tangu 的一个 run(ask_tangu):与输入框发出的同一条路 —— 同会话、同 agent_config、审批照常。 */
export interface DelegatedRun {
  sessionId: string;
  appId: string;
  modelId: string;
  task: string;
  /** 触发这次委派的那段话在库里的行 id:run 复用它当本轮用户消息(不另写一条「模型转述的任务」)。 */
  userMessageId?: string;
  agentConfig: Record<string, unknown>;
  ephemeralHint?: string;
}
export interface RealtimeCaller { userId: string; token: string }
/** 一通电话往外的两条腿由宿主定。缺省 = 本机引擎(brain.realtime + 本进程的 run 队列)。 */
export interface RealtimeVoiceHost {
  /** 这通电话连哪个上游。 */
  endpoint(model: string, caller: RealtimeCaller): { url: string; headers: Record<string, string> };
  /** 把委派的 run 起起来,回它的 id(之后通话按这个 id 等结果)。 */
  startRun(run: DelegatedRun, caller: RealtimeCaller): Promise<string>;
}

const localHost: RealtimeVoiceHost = {
  endpoint: (model) => deps().brain.realtime!.endpoint(model),
  startRun: async (r, { userId }) => {
    const runId = uuidv4();
    await createRun({
      id: runId, sessionId: r.sessionId, userId, appId: r.appId, modelId: r.modelId, assistantMessageId: uuidv4(),
      // 等同用户在输入框发出:origin=client(审批档现读会话设置)、审批托盘握手(待批卡出在输入框上方)。
      // 复用语音那行时 insertUserMessage 是 ON CONFLICT DO NOTHING:库里留用户原话,模型按原话 + 前文接活。
      input: {
        message: r.task, userMessageId: r.userMessageId || uuidv4(), attachments: [], agentConfig: r.agentConfig, origin: 'client', approvalTray: true,
        ...(r.ephemeralHint ? { ephemeralHint: r.ephemeralHint } : {}),
      },
    });
    enqueueRun(r.sessionId, runId);
    return runId;
  },
};

/**
 * 用宿主的 authMiddleware 判 upgrade 请求:桩一个只带 authorization 头的请求。只适合「只看这个头」的宿主(引擎自带的那个);
 * 还要看方法 / 路径的宿主(Forsion 服务端:作用域令牌按路由判)得自己给 authenticate —— 那边的中间件一读 req.originalUrl 就抛。
 * 宿主的校验同步抛错 / 异步 reject 一律当没通过:悬着不答 = 握手永不结束,外加一个未处理的 rejection(Codex 10-10)。
 */
function authenticate(token: string): Promise<string | null> {
  return new Promise((resolve) => {
    const fakeReq: any = { headers: { authorization: `Bearer ${token}` } };
    const fakeRes: any = { status: () => fakeRes, json: () => resolve(null), sendStatus: () => resolve(null) };
    try {
      Promise.resolve(deps().host.authMiddleware(fakeReq, fakeRes, () => resolve(fakeReq.user?.userId ?? null))).catch(() => resolve(null));
    } catch { resolve(null); }
  });
}

const isLoopback = (addr: string | undefined): boolean => !!addr && (addr === '::1' || /^(::ffff:)?127\./.test(addr));

function reject(socket: Duplex, code: number, text: string): void {
  try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* ignore */ }
  socket.destroy();
}

let wss: WebSocketServer | null = null;
/** 子协议里的令牌(`forsion.bearer, <token>`);没带就是空串。 */
function bearerFromProtocols(req: IncomingMessage): string {
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const at = offered.indexOf(REALTIME_BEARER_PROTOCOL);
  return at >= 0 ? offered[at + 1] || '' : '';
}

/**
 * 接手一条通话的 Upgrade。不是这条路(o.path,缺省 REALTIME_PATH)就返回 false、不碰 socket —— 宿主还有别的 Upgrade 消费者时留给它们;
 * 是就返回 true(之后 socket 归这里管,包括拒绝)。谁能连(回环 / 公网)由调用方先判;这里只验令牌。
 * o.authenticate:令牌 → 用户 id(不认就 null)。缺省走宿主的 authMiddleware(见 authenticate 的说明)。
 */
export function handleRealtimeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer,
  o: { path?: string; host?: RealtimeVoiceHost; authenticate?: (token: string) => Promise<string | null> } = {}): boolean {
  const url = new URL(req.url || '/', 'http://local');
  if (url.pathname !== (o.path ?? REALTIME_PATH)) return false;
  const token = url.searchParams.get('token') || bearerFromProtocols(req);
  if (!token) { reject(socket, 401, 'Unauthorized'); return true; } // 没带令牌不必去问宿主
  wss ??= new WebSocketServer({ noServer: true, maxPayload: 1 << 20, handleProtocols: (offered) => (offered.has(REALTIME_BEARER_PROTOCOL) ? REALTIME_BEARER_PROTOCOL : false) });
  const server = wss;
  void Promise.resolve().then(() => (o.authenticate ?? authenticate)(token)).catch(() => null).then((userId) => {
    if (!userId) return reject(socket, 401, 'Unauthorized');
    server.handleUpgrade(req, socket, head, (client) => handleCall(client, { userId, token }, o.host ?? localHost));
  });
  return true;
}

export function attachRealtimeVoice(server: Server): void {
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url || '/', 'http://local').pathname !== REALTIME_PATH) return reject(socket, 404, 'Not Found'); // 本进程没有别的 upgrade 消费者
    // 只收本机回环:通话以本机身份起 run(origin=client),远程来源另起一题。光看 x-forsion-remote 头不够 ——
    // 引擎经 TANGU_HOST 监听非回环时,远端持 token 省掉这个头就冒充本机了(Codex 10-01)。
    if (req.headers['x-forsion-remote'] || !isLoopback(req.socket.remoteAddress)) return reject(socket, 403, 'Forbidden');
    if (!deps().brain.realtime) return reject(socket, 501, 'Not Implemented');
    handleRealtimeUpgrade(req, socket, head);
  });
}

/** 上游自己出错断开、值得换一条重连的(服务端 5xxxx / 内部错误);鉴权、参数这类重连也没用,照常挂断。 */
const RETRYABLE_UPSTREAM = /^<5\d{4}>|InternalError|ModelServingError/;
/** `<400> InternalError.Algo.InvalidParameter: Voice … is not supported` 这类请求本身不对的,名字里带 InternalError 也不重连(重连一百次也是同一个错)。 */
export const retryableUpstream = (code: number, why: string): boolean => !/^<4\d\d>/.test(why) && (code === 1011 || RETRYABLE_UPSTREAM.test(why));
const MAX_RECONNECTS = 2;
/** 多久 ping 一次客户端(上一个没回就收线)。台架经 TANGU_REALTIME_PING_MS 调短。 */
const CLIENT_PING_MS = Number(process.env.TANGU_REALTIME_PING_MS) || 20_000;
/** 上游握手被拒时给客户端的原因:正文带 { detail } 就写成 `<状态码> detail`(与云端中转接通后挂断的 reason 同一个写法),否则只报状态码。 */
export function handshakeRefusal(status: number, body: string): string {
  let detail = '';
  try { const d = JSON.parse(body)?.detail; if (typeof d === 'string') detail = d.trim(); } catch { /* 不是 JSON */ }
  return detail ? `<${status}> ${clip(detail, 200)}` : `upstream HTTP ${status}`;
}

function handleCall(client: WebSocket, caller: RealtimeCaller, host: RealtimeVoiceHost): void {
  const { userId } = caller;
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
  // 上游断线重连用:在途 response 回的是哪句、最近答完的是哪句、哪句已经委派出去(那句不重喂,免得同一件事办两遍)。
  let respondingTo: string | null = null;
  let answered: string | null = null;
  let delegatedItem: string | null = null;
  let reconnects = 0;
  const heldReports: object[] = [];
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
    const item = { type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `[Tangu result] ${clip(text, 4000)}` }] } };
    // 正在换上游(重连中):先攒着,接上再送 —— 直接发会丢,而且 requestResponse 会把 responding 置真、没人来清,之后谁也要不到回复(Codex 10-02)。
    if (upstream?.readyState !== WebSocket.OPEN) { heldReports.push(item); return; }
    toUpstream(item);
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
    const runId = await host.startRun({
      sessionId: s.session_id, appId: profile.appId, modelId: s.run.model_id, task, userMessageId: reuse || undefined, agentConfig: s.run.agent_config || {},
      // 只进本 run 的模型上下文、不进聊天记录(agent_runs.input 里随 run 留一份):改正没成(没交原话 / 存储不支持)时,Tangu 也拿得到实时模型的理解。
      ...(voiced ? { ephemeralHint: `This request came from a voice call. The user's message above is a speech-recognition transcript and may contain mishearings. The voice assistant understood the request as: "${clip(task, 1000)}". If they differ, follow the voice assistant's understanding.` } : {}),
    }, caller);
    if (closed) return;
    // 等它的结果:听事件,同时看库里的终态 —— run 可能在我们订阅之前就结束了(网关上 run 由 worker 建,id 回来才订阅得上;
    // 网关多实例时事件还可能落在别的实例),只听事件会一直等下去。
    // ponytail: 5 秒查一次库;要更快就给 stateStore 加终态通知。
    const done = new Promise<string>((resolve, rejectRun) => {
      let settled = false;
      const stop = (): void => { settled = true; off(); clearInterval(poll); unsubs.delete(stop); };
      const off = subscribe(runId, (ev) => {
        if (ev.type === 'done') { stop(); resolve(String(ev.payload?.content ?? '')); }
        else if (ev.type === 'error') { stop(); rejectRun(new Error(String(ev.payload?.message || ev.payload?.error || 'run failed'))); }
      });
      const look = async (): Promise<void> => {
        const run = await getRunForUser(runId, userId).catch(() => null);
        if (settled || !run) return;
        if (run.status === 'done') {
          let result = run.result;
          if (typeof result === 'string') try { result = JSON.parse(result); } catch { result = null; }
          stop(); resolve(String(result?.content ?? ''));
        } else if (run.status === 'failed' || run.status === 'aborted') { stop(); rejectRun(new Error(String(run.error || run.status))); }
      };
      const poll = setInterval(() => void look(), 5000);
      unsubs.add(stop);
      void look();
    });
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
        respondingTo = lastUserItem;
        pendingReply = '';
        break;
      case 'response.done': {
        responding = false;
        if (m.response?.status === 'completed') answered = respondingTo;
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
        delegatedItem = lastUserItem;
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
    if (!owner) {
      await st.autoCreateSession({ id: s.session_id, userId, appId: profile.appId, title: s.title || 'Voice call', modelId: s.run.model_id });
      // 建会话是「已存在就不动」:两个账号同时拿同一个还不存在的 id 来拨,输的那个不复核就进了赢家的会话(读历史、写转写都只按会话 id)。Codex 10-10
      if ((await st.getSessionOwner(s.session_id)) !== userId) return end('session not found');
    }
    let ep: { url: string; headers: Record<string, string> };
    try { ep = host.endpoint(s.model, caller); } catch (e: any) { return end(e?.message || String(e)); }
    await connect(s, ep);
  };

  // 百炼偶发服务端错误(10-02 实报 `<50002> InternalError.Algo.ModelServingError`)会直接关掉上游:通话不挂,换一条上游接着打。
  // 新上游的指令按库里最近的对话现拼,上下文接得上;断在一句还没答完(也没委派出去)的话上,把那句重新喂进去。
  // ponytail: 断在结果播报中途的那条 [Tangu result] 不重放;真有人报「办完了没念」再补。
  const connect = async (s: StartMsg, ep: { url: string; headers: Record<string, string> }, replay?: string): Promise<void> => {
    const agentSlug = typeof s.run.agent_config?.agentSlug === 'string' ? s.run.agent_config.agentSlug : undefined;
    const instructions = await buildVoiceInstructions(s.session_id, agentSlug, userId);
    if (closed) return;
    const up = new WebSocket(ep.url, { headers: ep.headers });
    upstream = up;
    up.on('open', () => {
      toUpstream({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          voice: s.voice || defaultRealtimeVoice(s.model),
          instructions,
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
          turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 600 },
          tools: [ASK_TANGU],
        },
      });
      toClient({ type: 'ready' });
      const held = heldReports.splice(0);
      held.forEach(toUpstream);
      if (replay) toUpstream({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: replay }] } });
      if (replay || held.length) requestResponse();
    });
    // 新上游在旧的 close 之后才建,旧的不会再来事件,不用区分新旧。
    up.on('message', onUpstream);
    // 握手被拒:Forsion 云端中转会在正文里给 { detail }(额度用尽 / 没登录 / 模型没开),带上它界面才说得清为什么打不通。
    up.on('unexpected-response', (q, r) => {
      let body = '';
      // 正文只等 3 秒:挂了这个监听,ws 就不再替我们中止握手,对端给了状态行却不收尾的话通话会一直停在「接通中」。
      const done = (): void => { clearTimeout(wait); q.destroy(); end(handshakeRefusal(r.statusCode || 0, body)); };
      const wait = setTimeout(done, 3000);
      r.on('data', (d) => { if (body.length < 4096) body += d; });
      r.on('end', done);
      r.on('error', done);
    });
    up.on('error', (e) => end(e.message));
    up.on('close', (code, reason) => {
      const why = reason.toString() || `upstream closed (${code})`;
      if (closed || reconnects >= MAX_RECONNECTS || !retryableUpstream(code, why)) return end(why);
      reconnects++;
      console.warn(`[realtime] upstream dropped (${why}); reconnecting ${reconnects}/${MAX_RECONNECTS}`);
      const unanswered = lastUserItem && lastUserItem !== answered && lastUserItem !== delegatedItem ? userRows.get(lastUserItem)?.text : undefined;
      responding = false; wantResponse = false; pendingReply = ''; skipNextReply = false; respondingTo = null;
      toClient({ type: 'reconnecting', replay: !!unanswered }); // replay = 那句会重答,客户端把半句音频掐掉;否则让已生成完的回答放完
      void connect(s, ep, unanswered).catch((e) => end(e?.message || String(e)));
    });
  };

  // 客户端这一段可能走公网、过反代(手机 → 网关):只听不说的那一阵两头都没有帧,反代的读超时(约 60s)会把通话掐掉;
  // 对端断网、连关闭帧都发不出来时,这边也得自己发现 —— 上游按通话时长计费,没人听的电话不能一直挂着。
  let alive = true;
  const ping = setInterval(() => {
    if (!alive) return end('client timed out');
    alive = false;
    try { client.ping(); } catch { /* 正在关 */ }
  }, CLIENT_PING_MS);
  unsubs.add(() => clearInterval(ping));
  client.on('pong', () => { alive = true; });

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
