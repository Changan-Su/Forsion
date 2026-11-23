/**
 * 给外部引擎这一轮用的短命 MCP 桥:只开放宿主核准过的那组工具,每次调用先过 Forsion 的审批闸。
 *
 * 两类调用方:
 *  - 插件发起的任务(pluginToolNames / 只读白名单):照旧,不画卡、不限时。
 *  - 跑在外部引擎上的 Agent 的普通对话(底层第 3 步「交接」):`cards` + `budgetMs`。
 *
 * 为什么要限时(11-15 实测,方案目录 instrument/acp-bridge-timeout-probe.cjs):DSH 调一次外部工具最多等 60 秒,
 * 到点告诉模型 `Request timed out`、另发一条 notifications/cancelled 并断开连接 —— 但这座桥是无状态的(每个 HTTP
 * 请求一个 Server),取消通知落在另一个请求上,**正在跑的那次照样跑完**(实测 70 秒的调用在第 88 秒执行完)。
 * 审批卡挂着时更糟:用户 60 秒后点「允许」,工具才执行,模型却早以为失败了,重试一次就做两遍。
 * 所以每次调用在 budgetMs 内必回:没等到审批 / 没跑完就先回一个编号,模型再用 WAIT_TOOL 取结果
 * (每次取同样限时)。一轮结束(close)时撤掉还挂着的审批、中止还在跑的工具。
 *
 * DSH 对同名同参的连续调用在第 3、5、8 次提醒模型「换个办法或收尾」(dsh-repeat-tool-reminder),
 * 所以取结果的参数里带一个递增的 attempt,每次回话直接给出下一次的确切参数。
 *
 * 截图类工具(融合方案第 2 档,`images`):工具经 ctx.collectImage 交回的图,随这次调用的结果一起回成 MCP 的 image 内容
 * (标准协议,不靠 DSH 的插件接口)。DSH 收不收看它此刻选的模型:声明了能看图的(0.2.2 自带目录里的 deepseek-flash)
 * 存成附件、放进工具结果交给模型;看不了图的换成一行「image unavailable」—— 都是 DSH 自己做的
 * (DSH2Forsion tests/check-images.mjs 实测)。别的 App 的屏幕这类不可信图,前言贴在图前面一起回(同 services/toolImages.ts)。
 * 图只回给模型,不进卡片、不落库(落库的仍是文字)。
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isComputerUseTool, resolveTools, visibleMcpTools } from '../tools/toolRegistry.js';
import { executeTool, getToolCapabilities, toolPluginOwnerOf, toolSourceOf } from '../tools/registry.js';
import { gateToolCall, type ApprovalDecision } from '../services/approvals.js';
import type { ToolContext } from '../tools/toolTypes.js';
import { deps } from '../seams/runtime.js';
import { enterRunContext, setRunCwd } from '../seams/runContext.js';
import { isHtmlCardTool, LEGACY_HTML_CARD_TOOL } from '../tools/builtin/sketch.js';
import { computerUseUnavailableText } from '../contracts/agentEngine.js';
import { fitImageForModel } from '../services/imageShrink.js';

/** 取结果的那个工具(只在带 budgetMs 的桥上有)。 */
/** 工具卡片事件的来源字段(registry.toolOriginOf 的形状):builtin / mcp 只有 source,插件工具可带主人。 */
type ToolEventOrigin = { source: 'builtin' | 'mcp' | 'plugin'; pluginId?: string; pluginOfficial?: boolean };

export const WAIT_TOOL = 'forsion_wait';
/** 读这个 Agent 的一个技能(只在带 skills 的桥上有:交给常驻引擎时技能没有按会话的目录可放,见 residentAcp.ts)。 */
export const SKILL_TOOL = 'forsion_skill';
/** 技能正文交给模型的上限。 */
const MAX_SKILL_CHARS = 60_000;
/** DSH 等一次外部工具的上限是 60 秒(dsh-mcp-client 的 toolCallTimeoutMs,ACP 入口改不了);留出网络和排队的余量。 */
export const BRIDGE_CALL_BUDGET_MS = 45_000;
/** 交给模型的文本上限:超长的工具输出照 runLoop 落盘那样太重,这里截断并说明。 */
const MAX_TEXT_CHARS = 60_000;

export interface RunToolServerOptions {
  /** MCP 服务名。引擎把工具叫作 `mcp__<name>__<工具>`(DSH 的 publicToolName),界面据此认出哪些调用是桥里的。 */
  name?: string;
  /** 跑这一轮的 Agent(记忆域 / 展示身份)。HTTP 回调不在 run 的异步链上,不带的话 remember 之类会落到缺省 Agent。 */
  memorySlug?: string;
  agentSlug?: string;
  /** 卡片由 Forsion 自己画:桥里执行的工具按 Tangu 的原名发 tool_call / tool_result,并收进 calls / results 落库。
   *  contentOffset = 这一刻回答正文的长度(卡片在正文里的位置,重开对话时据此排回去)。 */
  cards?: { publish: (type: string, payload: any) => void; contentOffset: () => number };
  /** 每次调用最多占用多久(毫秒);超了先回编号。不给 = 一直等(插件任务,照旧)。 */
  budgetMs?: number;
  /** 这个 Agent 的技能(交给常驻引擎时):桥上多一个 SKILL_TOOL,按名字读 SKILL.md 和它旁边的文件清单。只读,不过审批。 */
  skills?: ReadonlyArray<{ name: string; dir: string }>;
  /** 收工具交回的图(ctx.collectImage),随结果回成 MCP image 内容。交接的桥开;插件任务那条照旧只回文字。 */
  images?: boolean;
  /**
   * 引擎此刻用的模型收不收图(开了 images 才问)。Computer Use 的调用先问它:不是 true(看不见 / 不知道)就不跑,
   * 回一句为什么 —— 看不见屏幕的模型只能照文字猜坐标去点(同 Tangu 循环的 computerUseUnavailable,那边是整组不给)。
   */
  seesImages?: () => Promise<boolean | undefined>;
}

/** 交过去的 Computer Use 不能跑时回给模型的话(句式照 toolRegistry.computerUseUnavailableReason:不是插件没开、要把原因和出路告诉用户)。 */
export const bridgeComputerUseUnavailable = computerUseUnavailableText;

/** 一次调用最多带回几张图(同 Tangu 循环每轮的上限 MAX_TOOL_IMAGES_PER_ROUND)。 */
export const MAX_BRIDGE_IMAGES_PER_CALL = 8;
type BridgeImage = { url: string; untrusted?: string };
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;
/**
 * 一张图的 base64 最多多长。DSH 0.2.2 收 MCP 图时用一条正则核 base64,约 4.9M 字符(原图约 3.5MB)起爆栈,
 * 而且同一个结果里一张不合格整批都换成「image unavailable」(DSH2Forsion tests/check-images.mjs 实测)。
 */
export const MAX_BRIDGE_IMAGE_BASE64 = 3_000_000;

/**
 * 一张图怎么交:在线以内原样交(同 Tangu 循环:要缩的工具自己缩,Computer Use 的截图按自己的像素给坐标,缩了就点偏)。
 * 超线的先只换编码(PNG → 同尺寸 JPEG,坐标不变);还超才缩小,并附一句原尺寸和倍数;仍超就不交。
 */
function fitBridgeImage(mime: string, b64: string): { mime: string; b64: string; note?: string } | null {
  if (b64.length <= MAX_BRIDGE_IMAGE_BASE64) return { mime, b64 };
  const buf = Buffer.from(b64, 'base64');
  const same = fitImageForModel(buf, { keepSize: true });
  if (same) { const out = same.buf.toString('base64'); if (out.length <= MAX_BRIDGE_IMAGE_BASE64) return { mime: same.mime, b64: out }; }
  const small = fitImageForModel(buf);
  if (!small) return null;
  const out = small.buf.toString('base64');
  if (out.length > MAX_BRIDGE_IMAGE_BASE64) return null;
  if (small.width === small.fromWidth && small.height === small.fromHeight) return { mime: small.mime, b64: out };
  const k = Math.round((small.fromWidth / small.width) * 1000) / 1000;
  return {
    mime: small.mime, b64: out,
    note: `[The next image was scaled down from ${small.fromWidth}x${small.fromHeight} to ${small.width}x${small.height} px so it could be passed on. `
      + `Where the tool's text gives pixel positions or sizes for it, they refer to the ${small.fromWidth}x${small.fromHeight} original: `
      + `multiply any position you read off this image by ${k} before using it.]`,
  };
}

/** 一次调用的结果 → MCP 的 content:先是文字;每张图前面,不可信来源的前言换了才再写一次。不是内联 PNG / JPEG / WebP / GIF、太大交不了的图说一句、不回。 */
export function bridgeContent(out: { text: string; images?: readonly BridgeImage[] }): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: out.text }];
  let preface: string | undefined;
  for (const img of out.images ?? []) {
    const m = IMAGE_DATA_URL.exec(String(img?.url ?? ''));
    if (!m) { content.push({ type: 'text', text: '[An image from this tool could not be passed on: it is not an inline PNG, JPEG, WebP or GIF.]' }); continue; }
    let fit: ReturnType<typeof fitBridgeImage> = null;
    try { fit = fitBridgeImage(m[1].toLowerCase().replace('image/jpg', 'image/jpeg'), m[2]); } catch { fit = null; }
    if (!fit) { content.push({ type: 'text', text: '[An image from this tool could not be passed on: it is too large even after shrinking.]' }); continue; }
    const p = typeof img.untrusted === 'string' && img.untrusted.trim() ? img.untrusted.trim() : undefined;
    if (p && p !== preface) content.push({ type: 'text', text: p });
    preface = p;
    if (fit.note) content.push({ type: 'text', text: fit.note });
    content.push({ type: 'image', data: fit.b64, mimeType: fit.mime });
  }
  return content;
}

/** 读一个技能:SKILL.md 正文 + 同一文件夹里其余文件的绝对路径(模型用自己的读文件工具去读)。 */
export function readSkillForBridge(dir: string, name: string): string {
  const body = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const files: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 3 || files.length >= 200) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || files.length >= 200) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (!(d === dir && e.name === 'SKILL.md')) files.push(p);
    }
  };
  walk(dir, 0);
  const text = body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS)}\n\n[Truncated: ${body.length} characters in total.]` : body;
  return `Skill "${name}" (folder: ${dir})\n\n${text}`
    + (files.length ? `\n\nOther files in this skill (read them with your own file tools when the skill tells you to):\n${files.map((f) => `- ${f}`).join('\n')}` : '');
}

type Outcome = { text: string; isError: boolean; images?: BridgeImage[] };
interface Ticket { id: string; tool: string; phase: 'approval' | 'running'; job: Promise<Outcome>; settled?: Outcome; attempt: number }

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const onAbort = () => { clearTimeout(t); resolve(); };
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms); t.unref?.();
  signal.addEventListener('abort', onAbort, { once: true });
});
const STOPPED_TEXT = 'Stopped: this turn ended before the tool call finished.';

/** 对外发、落库都按线上的名字(HTML 卡叫 sketch,同 runLoop 的 wireToolName)。 */
const wireName = (name: string): string => (isHtmlCardTool(name) ? LEGACY_HTML_CARD_TOOL : name);

export async function createRunToolServer(ctx: ToolContext & { runId: string }, names: string[], opts: RunToolServerOptions = {}) {
  const token = randomBytes(32).toString('hex');
  const serverName = opts.name || 'forsion_task';
  // 这座桥自己的中止:跟着 run 的信号走,close 时也中止 —— 撤掉挂着的审批、停下还在跑的工具。
  const life = new AbortController();
  const onRunAbort = () => life.abort();
  if (ctx.signal?.aborted) life.abort(); else ctx.signal?.addEventListener('abort', onRunAbort, { once: true });
  const live = () => !life.signal.aborted;
  const toolCtx: ToolContext & { runId: string } = { ...ctx, signal: life.signal };
  // 交出去的工具:内置 / 插件工具(resolveTools)+ 这一轮看得见的 MCP 工具(不在 resolveTools 里,单独一类,executeTool 兜底去调)
  type Listed = { name: string; definition: { function: { description?: string; parameters?: any } } };
  const allowed = (): Map<string, Listed> => {
    const builtin = resolveTools(deps().profile, toolCtx);
    const out = new Map<string, Listed>([...builtin].filter(([n]) => names.includes(n)));
    for (const t of visibleMcpTools(toolCtx, new Set(builtin.keys()))) if (names.includes(t.name) && !out.has(t.name)) out.set(t.name, t);
    return out;
  };
  const open = new Set<Server>();
  const tickets = new Map<string, Ticket>();
  const active = new Set<Promise<Outcome>>();
  let ticketSeq = 0;
  const calls: any[] = [];
  const results: any[] = [];
  /** 已经有终态卡片的调用(id → 开始时刻的表里删掉):每次调用恰好一条结果,收尾补的和迟到的不会重复。 */
  const unsettled = new Map<string, { name: string; startedAt: number; origin: ToolEventOrigin }>();
  const settleCard = (id: string, name: string, startedAt: number, origin: ToolEventOrigin, text: string, isError: boolean, extra: { metadata?: any; artifactPath?: string } = {}): void => {
    if (!opts.cards || !unsettled.delete(id)) return;
    const elapsedMs = Date.now() - startedAt;
    results.push({ tool_call_id: id, name, content: text, isError, startedAt, elapsedMs, outputChars: text.length, ...(extra.artifactPath ? { artifactPath: extra.artifactPath } : {}) });
    opts.cards.publish('tool_result', { id, name, result: text, isError, startedAt, elapsedMs, outputChars: text.length, ...origin, ...extra });
  };
  const budget = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : undefined;
  // 同一个并发键(一次只驱动一个浏览器 / 一台电脑)的执行排队:引擎可能一次发几个调用,Tangu 循环里它们本来就一个接一个跑
  // 排队的调用跟着桥的中止走:前一个不理中止、一直不结束,后面排着的也照样停(不然它们永远挂着)
  const lifeEnded = new Promise<never>((_, reject) => {
    const stop = () => reject(life.signal.reason ?? new Error('Stopped'));
    if (life.signal.aborted) stop(); else life.signal.addEventListener('abort', stop, { once: true });
  });
  lifeEnded.catch(() => {});
  const lanes = new Map<string, Promise<void>>();
  const inLane = <T>(key: string | undefined, fn: () => Promise<T>): Promise<T> => {
    if (!key) return fn();
    const run = Promise.race([lanes.get(key) ?? Promise.resolve(), lifeEnded]).then(fn);
    const tail = run.then(() => {}, () => {});
    lanes.set(key, tail);
    void tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key); });
    return run;
  };

  const enter = () => {
    enterRunContext(ctx.userId, ctx.runId, opts.memorySlug, opts.agentSlug);
    if (ctx.cwd) setRunCwd(ctx.cwd);
  };

  /** 审批 + 执行一次。卡片事件在这里发,结果在这里收(不管模型等没等到)。 */
  const runCall = (name: string, args: Record<string, unknown>, onPhase: (p: Ticket['phase']) => void): Promise<Outcome> => {
    const id = randomUUID();
    const call = { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args || {}) } };
    const startedAt = Date.now();
    // source 同 agentLoop(遥测 v2);插件工具另带 pluginId + pluginOfficial(遥测 v3)
    const origin = ((): ToolEventOrigin => {
      try {
        const source = toolSourceOf(name, toolCtx);
        if (source !== 'plugin') return { source };
        try { return { source, ...toolPluginOwnerOf(name, toolCtx) }; } catch { return { source }; }
      } catch { return { source: 'plugin' }; }
    })();
    if (opts.cards) {
      calls.push({ ...call, function: { ...call.function, name: wireName(name) }, ui_content_offset: opts.cards.contentOffset() });
      unsettled.set(id, { name: wireName(name), startedAt, origin });
      opts.cards.publish('tool_call', { id, name: wireName(name), arguments: call.function.arguments, startedAt, ...origin });
    }
    // 这次调用交回的图(截图类工具;只在开了 images 的桥上收)
    const images: BridgeImage[] = [];
    const collectImage = opts.images
      ? (img: { url: string; name?: string; untrusted?: string }) => {
          if (img && typeof img.url === 'string' && img.url && images.length < MAX_BRIDGE_IMAGES_PER_CALL) {
            images.push({ url: img.url, ...(typeof img.untrusted === 'string' && img.untrusted ? { untrusted: img.untrusted } : {}) });
          }
        }
      : undefined;
    const finish = (text: string, isError: boolean, extra: { metadata?: any; artifactPath?: string } = {}): Outcome => {
      // 截断只给交接的桥(卡片 + 落库);插件任务那条路原样回,别把它原来能拿到的长输出截掉
      const capped = opts.cards && text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Output truncated: ${text.length} characters in total.]` : text;
      settleCard(id, wireName(name), startedAt, origin, capped, isError, extra);
      return { text: capped, isError, ...(images.length ? { images: [...images] } : {}) };
    };
    const caps = (() => { try { return getToolCapabilities(name, toolCtx); } catch { return undefined; } })();
    const lane = caps?.concurrencyKey || (caps?.sideEffect === 'browser' ? 'browser' : undefined);
    // Computer Use 只在这一刻的模型看得见时跑:问不到 / 看不见 → 不跑,回一句给模型
    const cuBlocked = async (): Promise<string | undefined> => {
      if (!opts.images || !caps || !isComputerUseTool({ capabilities: caps })) return undefined;
      const sees = await (opts.seesImages?.() ?? Promise.resolve(undefined)).catch(() => undefined);
      return sees === true ? undefined : bridgeComputerUseUnavailable(sees === false ? 'no-image-input' : 'unknown');
    };
    const job = (async (): Promise<Outcome> => {
      enter();
      try {
        // 先问一次(不让用户批一个跑不了的调用);排完队、真要跑之前再问一次(等审批 / 排队期间可能换了模型)
        const early = await cuBlocked();
        if (early) return finish(early, true);
        const decision: ApprovalDecision = await gateToolCall(ctx.runId, call, {
          sessionId: ctx.sessionId, userId: ctx.userId, execMode: 'host', cwd: ctx.cwd, approvalMode: ctx.approvalMode,
          // 交接的桥照 Tangu 循环:只有输入框发的轮才按会话现档读(approvalModeSessionId);插件任务那条路照旧跟会话
          modeSessionId: opts.cards ? ctx.approvalModeSessionId : ctx.sessionId, profile: ctx.profile, agentSlug: opts.agentSlug, projectPath: ctx.projectPath,
        }, life.signal);
        if (decision.action === 'reject') return finish(decision.rejectReason || 'The user denied this tool call.', true);
        life.signal.throwIfAborted();
        if (!allowed().has(name)) return finish('Tool is no longer available.', true);
        onPhase('running');
        const approved = decision.argsOverride ? { ...call, function: { ...call.function, arguments: JSON.stringify(decision.argsOverride) } } : call;
        const ran = await inLane(lane, async (): Promise<{ blocked: string } | { result: Awaited<ReturnType<typeof executeTool>> }> => {
          life.signal.throwIfAborted();
          const late = await cuBlocked();
          if (late) return { blocked: late };
          life.signal.throwIfAborted();
          return { result: await executeTool(approved, { ...toolCtx, toolCallId: id, ...(collectImage ? { collectImage } : {}) }) };
        });
        if ('blocked' in ran) return finish(ran.blocked, true);
        const result = ran.result;
        return finish(String(result.result), !!result.isError, { metadata: result.metadata, artifactPath: result.artifactPath });
      } catch (e: any) {
        const stopped = life.signal.aborted;
        return finish(stopped ? STOPPED_TEXT : `Error: ${e?.message || e}`, true);
      }
    })();
    // 每个在跑的调用都记着(不管领没领编号):收尾要等它们发完终态
    active.add(job); void job.finally(() => active.delete(job));
    return job;
  };

  /** 限时等一个结果;没等到就把它挂成编号(或更新编号),回一段告诉模型怎么取的话。 */
  const awaitOrTicket = async (job: Promise<Outcome>, ticket: Ticket | null, make: () => Ticket): Promise<Outcome> => {
    if (!budget) return job;
    // 这次等待自己的计时:任一边先到就撤掉另一边的计时器和监听,别一轮攒一堆
    const wait = new AbortController();
    const onLife = () => wait.abort();
    life.signal.addEventListener('abort', onLife, { once: true });
    let done: { o: Outcome } | null;
    try { done = await Promise.race([job.then((o) => ({ o })), sleep(budget, wait.signal).then(() => null)]); }
    finally { wait.abort(); life.signal.removeEventListener('abort', onLife); }
    if (done) {
      // 领编号要原子:同一编号并发 wait 时只有先删掉它的那次拿结果(图不重复交)
      if (ticket && !tickets.delete(ticket.id)) return { isError: true, text: `Ticket ${ticket.id} was already collected by another ${WAIT_TOOL} call.` };
      return done.o;
    }
    if (!live()) return { text: STOPPED_TEXT, isError: true };
    const t = ticket ?? make();
    t.attempt += 1;
    const waiting = t.phase === 'approval' ? 'is waiting for the user to approve it in Forsion' : 'is still running';
    return {
      isError: false,
      text: `Pending: ${t.tool} ${waiting} (ticket ${t.id}). It was not lost and must not be called again. `
        + `Call ${WAIT_TOOL} with {"ticket":"${t.id}","attempt":${t.attempt}} to wait for its result. `
        + 'Do not end your turn while a ticket is pending.',
    };
  };

  const http = createServer(async (req, res) => {
    const got = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from(`Bearer ${token}`);
    if (!live() || req.method !== 'POST' || req.url !== '/mcp' || got.length !== expected.length || !timingSafeEqual(got, expected)) { res.writeHead(403).end(); return; }
    const server = new Server({ name: 'forsion-task', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    open.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      enter();
      const tools = [...allowed().values()].map(t => ({ name: t.name, description: t.definition.function.description, inputSchema: t.definition.function.parameters }));
      if (opts.skills?.length) tools.push({
        name: SKILL_TOOL,
        description: 'Load one of your Forsion skills by name (they are listed in your instructions under "Your skills"). Returns its SKILL.md and the paths of its other files.',
        inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The skill name exactly as listed.' } }, required: ['name'] } as any,
      });
      if (budget) tools.push({
        name: WAIT_TOOL,
        description: 'Wait for the result of a Forsion tool call that answered with a pending ticket (it is waiting for the user\'s approval or still running). '
          + `Waits up to about ${Math.round(budget / 1000)} seconds. If it is still pending, the answer gives the exact arguments for the next call.`,
        inputSchema: { type: 'object', properties: { ticket: { type: 'string', description: 'The ticket from the pending answer, e.g. "T1".' }, attempt: { type: 'number', description: 'The attempt number given in the pending answer.' } }, required: ['ticket'] } as any,
      });
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if (!live()) throw new Error('Tool is unavailable');
      const name = request.params.name;
      const args = (request.params.arguments || {}) as Record<string, unknown>;
      if (budget && name === WAIT_TOOL) {
        const t = tickets.get(String(args.ticket ?? ''));
        if (!t) return { isError: true, content: [{ type: 'text', text: `Unknown or already collected ticket: ${String(args.ticket ?? '')}.` }] };
        const out = await awaitOrTicket(t.job, t, () => t);
        return { isError: out.isError, content: bridgeContent(out) };
      }
      if (opts.skills?.length && name === SKILL_TOOL) {
        const want = String(args.name ?? '').trim();
        const skill = opts.skills.find((k) => k.name === want) ?? opts.skills.find((k) => k.name.toLowerCase() === want.toLowerCase());
        if (!skill) return { isError: true, content: [{ type: 'text', text: `No skill named "${want}". Available: ${opts.skills.map((k) => k.name).join(', ')}.` }] };
        try { return { isError: false, content: [{ type: 'text', text: readSkillForBridge(skill.dir, skill.name) }] }; }
        catch (e: any) { return { isError: true, content: [{ type: 'text', text: `Could not read skill "${skill.name}": ${e?.message || e}` }] }; }
      }
      if (!allowed().has(name)) throw new Error('Tool is unavailable');
      let phase: Ticket['phase'] = 'approval';
      let ticketRef: Ticket | null = null;
      const job = runCall(name, args, (p) => { phase = p; if (ticketRef) ticketRef.phase = p; });
      const out = await awaitOrTicket(job, null, () => {
        const t: Ticket = { id: `T${++ticketSeq}`, tool: name, phase, job, attempt: 0 };
        void job.then((o) => { t.settled = o; });
        tickets.set(t.id, t); ticketRef = t; return t;
      });
      return { isError: out.isError, content: bridgeContent(out) };
    });
    try {
      let raw = ''; for await (const b of req) { raw += b; if (raw.length > 1024 * 1024) throw new Error('Request too large'); }
      await server.connect(transport); await transport.handleRequest(req, res, JSON.parse(raw));
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
    finally { await server.close(); open.delete(server); }
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const port = (http.address() as { port: number }).port;
  return {
    server: { type: 'http' as const, name: serverName, url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
    /** 引擎那边这座桥的工具名前缀(`mcp__<服务名>__`):引擎自己的工具卡据此认出桥里的调用、不再画第二张。 */
    toolPrefix: `mcp__${serverName}__`,
    /** 桥里执行过的调用(runLoop 的落库形状:tool_calls 带 ui_content_offset,tool_results 按 tool_call_id 配)。 */
    calls: () => [...calls],
    results: () => [...results],
    /** 还没取走结果的编号数(收尾时说明用)。 */
    pendingTickets: () => [...tickets.values()].filter((t) => !t.settled).length,
    async close() {
      life.abort();
      ctx.signal?.removeEventListener('abort', onRunAbort);
      // 挂着的审批随 life 撤回、在跑的工具随 life 中止;等它们把终态卡片发完再关(最多 3 秒,别吊住收尾)。
      await Promise.race([Promise.allSettled([...active]), new Promise((r) => { const x = setTimeout(r, 3000); x.unref?.(); })]);
      // 不听中止、3 秒内还没停下的:当场记成「这一轮结束了」,落库的消息里每个调用都配得上结果(换回 Tangu 读这段历史时
      // 调用没有结果会被模型方拒);它迟到的结果不再记、不再发。
      for (const [id, u] of [...unsettled]) settleCard(id, u.name, u.startedAt, u.origin, STOPPED_TEXT, true);
      await Promise.allSettled([...open].map(s => s.close())); http.closeAllConnections(); await new Promise<void>(r => http.close(() => r()));
    },
  };
}
