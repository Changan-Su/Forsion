/** Replay evidence, never operations. Rebuild valid call/result pairs, including tool-only
 * assistant rows. An absent outcome is unknown, not proof of success or non-execution.
 *
 * providerItems(跨 run 回放的思考延续性)三条纪律 —— 写侧 stepLlmResponse / 读侧 interleave 同源:
 * ① **模型 + 协议双绑定**:Responses 的 encrypted_content 与 Anthropic 的 thinking signature 都由
 *    **产出它们的那个模型**签出,换模型回灌要么被上游拒、要么毫无意义;换**协议**回灌更糟 ——
 *    Responses 的私有 item 挂到 /chat/completions 的 assistant 消息上就是个未知字段,严格网关直接 400。
 *    同一个 apiModelId 两轮走不同协议是**真实路径**:tuneOpenAiDirectPayload 见 cap.viaResponses 且
 *    思考开就把本轮 payload 改道 Responses,下一 run 关思考又退回 chat-completions —— 只比 apiModelId
 *    就会把上一轮的 Responses items 灌给 chat-completions。故写侧连同 apiModelId 与**本轮 payload 实际
 *    发出去的那个协议**(agentLoop 在落库点读 payload[PROTOCOL_MARK],不是模型上的静态标记)一起落库
 *    (llm_response.outputItemsModel),回放**只在 apiModelId 与 protocol 都逐字相等时**才挂 providerItems;
 *    对不上就照常重建交错、只是不带 items —— **不**因此退回扁平(交错本身与模型/协议都无关)。
 *    provider 一并存,只供事后定位,不参与判定。两侧的「没有协议」(托管面 / chat-completions 直连 /
 *    升级前的旧行)统一归一成 '',见 protocolKey。
 * ② **只落回放真用得上的类型**:reasoning / thinking / redacted_thinking + message + function_call。
 *    function_call 不是可选项 —— openaiToResponsesBody 见到 providerItems 就**整组替代**正文与
 *    tool_calls,少了它,紧随其后的 function_call_output 找不到父项,上游 400 且整个会话此后每个 run 都炸。
 *    白名单(不是黑名单):上游将来新增的 item 类型一律不落,免得未知字段哪天原样回灌上 wire。
 * ③ **message 项照落,逐字**:同样因为 ② 的「整组替代」—— 不落它,回放该轮时这轮的 preamble 正文
 *    就不上 wire,字节前缀在原 message 项的位置分叉,此后每个 run 都从那里 miss。代价是正文在
 *    llm_response.content 与 outputItems 里各存一份;message 项 ~100–500B,对着同组多 KB 的加密
 *    reasoning 可忽略,**逐字同形比不翻倍值钱**。落库的这一组因此正好是在线时挂在 assistant 轮上的
 *    那一组(assistantTurnOf 原样挂 res.outputItems),同序同字节。Anthropic 路径不受影响:块相加、
 *    且 wire 侧只认 thinking / redacted_thinking,别的 item 到不了 body。
 * ponytail: 天花板一 —— **白名单外的 item**(hosted tool 的 web_search_call 之类):流原样吐、
 *    在线 providerItems 里有,落库被 ② 滤掉,真走到这类轮次时该轮仍会分叉。要么等确有此路径再逐类
 *    放行(每类都得先确认回灌安全),要么维持现状;别为此把白名单改成黑名单。
 * ponytail: 天花板二 —— 读侧的「本 run 协议」取的是**模型上的静态标记**(agentLoop hydrate 时 payload
 *    还没造出来,动态改道要到 buildProviderPayload 才定)。于是「静态无标记 + cap.viaResponses + 思考开」
 *    这一档(自带 key 的 gpt-5 族)写侧记 'openai-responses'、读侧要 '' → 永远对不上,items 白存。
 *    **只会假不匹配,不会假匹配**(静态有标记的 Codex/Anthropic 直连两侧恒相等),所以是丢优化不是丢正确性;
 *    真要救它,得把 tuneOpenAiDirectPayload 在 hydrate 前对着空 payload 探一次,别在这里手抄一份 viaResponses 判据。 */
import type { ChatMessage, ToolCall } from '../core/types.js';
import { capToolResult, capHistoryContent } from './contextBudget.js';

/** 落库到 agent_steps.llm_response 的 outputItems 字节硬帽。超帽**整组丢弃**并留标记(而不是存半组):
 *  宁可这一轮没有思考延续性,也不让一次异常大的 encrypted_content 把 agent_steps 撑大。
 *  ponytail: 固定常量,不做每模型/每会话的动态预算 —— 正常 Codex 一轮的 items 在 1~10KB 量级,
 *  64KB 已是异常值的门,真撞上了该查上游而不是调大它。 */
export const STEP_ITEMS_MAX_BYTES = 64 * 1024;

/** 见文件头 ②③:白名单,只此五类。 */
const REPLAYABLE_ITEM_TYPES = new Set(['reasoning', 'thinking', 'redacted_thinking', 'message', 'function_call']);

/** 产出这批 items 的模型身份。**判定键 = apiModelId + protocol**(见文件头 ①);provider 只供定位。 */
export interface StepItemBinding {
  apiModelId?: string;
  provider?: string;
  /** 本轮 payload **实际**发出去的协议(openai-responses / anthropic-messages / 缺省 = chat-completions
   *  或托管面)。必须取自 payload,不是模型上的静态标记 —— 那两者会因动态改道而不一致。 */
  protocol?: string;
}

/** 协议判定键:两侧同一把尺 —— 缺省(托管面 / chat-completions 直连 / 升级前的旧行)一律归一成 ''。 */
function protocolKey(p: unknown): string {
  return typeof p === 'string' ? p : '';
}

/** 写侧与读侧共用一把筛子:读侧也筛一遍,挡住别的写者/未来版本塞进来的未知类型。
 *  收数组也收 JSON 字符串(读侧拿到的是 outputItemsJson,见 stepLlmResponse)。 */
function pickReplayItems(items: unknown): any[] {
  return array(items).filter(
    (it) => it && typeof it === 'object' && REPLAYABLE_ITEM_TYPES.has(String((it as any).type)),
  );
}

/** Responses 形态的 items 必须覆盖本轮**全部**工具调用,否则整组作废(文件头 ② 的 400 防线:
 *  写侧与流之间万一不一致,也不许把半组 items 送上 wire)。Anthropic 形态是块相加、不整组替代,
 *  天然不涉及 —— 故按**闭集**(thinking / redacted_thinking)认它,其余一律当 Responses 形态过闸:
 *  白名单将来再添 Responses 类型这道闸自动跟上,而写成「有 reasoning 或 function_call 才查」会漏掉
 *  只剩 message 项的那一轮 —— 那轮照样被整组替代,tool_calls 一并消失,正是本闸要挡的 400。 */
function itemsCoverCalls(items: any[], calls: ToolCall[]): boolean {
  if (items.every((it) => it.type === 'thinking' || it.type === 'redacted_thinking')) return true;
  const ids = new Set(items.filter((it) => it.type === 'function_call').map((it) => String(it.call_id ?? it.id ?? '')));
  return calls.every((c) => ids.has(c.id));
}

/**
 * 写侧:agentLoop 的 appendStep 用它拼 agent_steps.llm_response。
 * **无 schema 迁移** —— llm_response 本就是 JSON 列,这里只多 outputItemsJson / outputItemsModel
 * (或超帽时的 outputItemsDropped)两三个字段;没有 items / 没有模型绑定时逐字仍是旧的 { content, usage }。
 *
 * items 落的是 **JSON 字符串**(outputItemsJson)而不是数组:生产上 llm_response 是 PostgreSQL 的
 * `jsonb`,它会**重排对象键序** —— 数组存进去取回来,JSON.stringify 就不再是在线那串字节,回放该轮
 * 必然在 item 的位置分叉、此后每个 run 都 miss。JSON 字符串在 jsonb 眼里是标量,一个字节不动;
 * parse 回来键序按插入序原样复现。SQLite 的 TEXT 列天然保序,**看不出**这条(见 hydration 测试里的
 * jsonb 归一化模拟)。没有别处读这个字段,故不再同时存一份解析好的 outputItems(读侧仍兼容旧行)。
 */
export function stepLlmResponse(
  res: { content?: string; usage?: any; outputItems?: any[] },
  binding?: StepItemBinding,
): Record<string, any> {
  const base: Record<string, any> = { content: res.content, usage: res.usage };
  const apiModelId = typeof binding?.apiModelId === 'string' ? binding.apiModelId : '';
  const items = pickReplayItems(res.outputItems);
  // 没有模型绑定就不落:回放判不了「是不是同一个模型签的」,落了也永远用不上,只是白占体积。
  if (!items.length || !apiModelId) return base;
  const json = JSON.stringify(items);
  const bytes = Buffer.byteLength(json, 'utf-8');
  console.debug(`[agent-core] step outputItems model=${apiModelId} n=${items.length} bytes=${bytes}`);
  if (bytes > STEP_ITEMS_MAX_BYTES) return { ...base, outputItemsDropped: { reason: 'size', bytes } };
  return {
    ...base,
    outputItemsJson: json,
    outputItemsModel: {
      apiModelId,
      ...(binding?.provider ? { provider: binding.provider } : {}),
      ...(binding?.protocol ? { protocol: binding.protocol } : {}),
    },
  };
}

function array(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { /* legacy malformed data */ } }
  return [];
}

/** agent_steps 的一行,只取重建交错所需的三列。列名两套都收:DB 原始行是 snake_case,
 *  经 StateStore 读出来的是 camelCase。tool_results **不在此列** —— 结果一律取自
 *  chat_messages 行(allToolResults 是每条执行路径的汇聚点,有 steps 时它必然是全的)。 */
export interface ReplayStep {
  step_no?: number;
  stepNo?: number;
  /** { content, usage, outputItemsJson?, outputItemsModel? }。后两个由写侧 stepLlmResponse 落库,
   *  回放时按 outputItemsModel 的 apiModelId + protocol 与当前 run 比对(见文件头 ①)。 */
  llm_response?: any;
  llmResponse?: any;
  tool_calls?: unknown;
  toolCalls?: unknown;
}

function sanitizeCalls(value: unknown): ToolCall[] {
  const calls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const c of array(value)) {
    if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id) || !c.function
      || typeof c.function.name !== 'string' || !c.function.name || typeof c.function.arguments !== 'string') continue;
    ids.add(c.id);
    calls.push({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } });
  }
  return calls;
}

/** tool 结果消息的正文 = **落库的 model-visible 正文原样**,`isError` 不加任何前缀。
 *  在线时 executeOneToolCall 送给模型的就是 capped 正文本身(失败与否只进 tool_result 事件与
 *  toolResult.isError,从不进 tool 消息)—— 回放再拼一个 `[Tool failed]\n` 就是模型当时没见过的
 *  字节,那一轮的前缀必然分叉,而且失败越早分叉越靠前。
 *  ponytail: 仍不同形的只剩 hook 追加的上下文(preCtx / PostToolUse 反馈)—— 它在线时拼进 tool
 *  消息但**没落库**,回放拿不到。要补得先把它落进 tool_results,不在本次范围内。 */
function toolResultText(call: ToolCall, results: Map<string, any>): string {
  const r = results.get(call.id);
  const text = typeof r?.content === 'string' ? r.content : null;
  return text !== null
    ? capToolResult(text)
    : 'Tool outcome unknown: no result was saved. The call may have partially executed. Verify current state before retrying; do not assume success or repeat side effects blindly.';
}
/** 扁平形态的 tool 消息。键序**保持 B3 之前那样**(role, tool_call_id, content):直连
 *  chat-completions 时 compatWireMessages 可能原样透传本对象,键序会上 wire —— 退回扁平的行
 *  (旧行 / steer 拆段 / 毒化行 / thin worker)本就拿不到交错,别再顺手动它们的字节。
 *  ⚠️ 正文那侧有一次性例外:`isError` 的结果不再带 `[Tool failed]\n` 前缀(见 toolResultText),
 *  含失败工具结果的旧行因此有**一次** cache miss,之后稳定 —— 换来的是与在线逐字同形。 */
function flatToolMessage(call: ToolCall, results: Map<string, any>): ChatMessage {
  return { role: 'tool', tool_call_id: call.id, content: toolResultText(call, results) } as ChatMessage;
}

/**
 * B3(Token/缓存评审 §五):有 agent_steps 时按**每轮**重建
 * `assistant(第 k 轮的调用) → 第 k 轮的 tool 结果 → assistant(k+1) → …`,与在线时
 * workingMessages 的字节同形(assistantTurnOf + executeOneToolCall 的 tool 消息);
 * 没有 steps(升级前的旧行 / thin worker)退回扁平形态,即 2026-09 之前的行为。
 *
 * ⚠️ 升级后,**换成交错形态的那些行**会有一次性前缀失配:它们此前按扁平形态进过上游缓存,
 * 换形后那一次 run 必然 cache miss,之后稳定命中。一次性,不要当成回归。退回扁平的行
 * (旧行 / steer 拆段 / 毒化行 / thin worker)字节与升级前逐字相同,连这一次都没有。
 *
 * 三道闸,任一不过就退回扁平(宁可维持旧行为,绝不丢证据):
 *  ⓪ 整行正文超过历史单条硬帽的,不拆(见下方注释)。
 *  ① 各步 tool_calls 按步序拼起来必须**逐个等于**本行的 tool_calls(同样 sanitize 后比 id)。
 *     挡住运行时转向(steer)把一个 run 拆成多条 assistant 消息 —— 那时 agent_runs.assistant_message_id
 *     只指向第一段,却能查出整个 run 的步骤 —— 以及步骤写了一半的 run。
 *  ② 各**工具轮**正文按 appendFinal 的口径拼起来,必须是本行 content 的前缀。剩下的尾巴
 *     (末轮正文 + 循环耗尽/额度不足等提示)原样挂成最后一条 assistant 消息,一个字节不丢。
 */
export function replayAssistantHistory(
  row: { content?: string | null; tool_calls?: unknown; tool_results?: unknown },
  steps?: ReplayStep[],
  /** 本次 run 的上游模型 + **下一次请求要走的协议**。缺省 / 对不上 → 重建交错但不挂 providerItems
   *  (见文件头 ①)。protocol 取模型上的静态标记(hydrate 时 payload 还没造),故只会假不匹配。 */
  replayFor?: { apiModelId?: string; protocol?: string },
): ChatMessage[] {
  const calls = sanitizeCalls(row.tool_calls);
  const content = capHistoryContent(row.content || '');
  if (!calls.length) return content.trim() ? [{ role: 'assistant', content }] : [];
  const results = new Map(array(row.tool_results).filter((r) => r && typeof r.tool_call_id === 'string').map((r) => [r.tool_call_id, r]));
  // Array.isArray:调用方可能是 rows.flatMap(replayAssistantHistory),第二个实参会是**下标**
  // (第三个则会是整个数组)—— 故 replayFor 也按 apiModelId 的类型认,不按「有没有传」认。
  const wantModel = typeof (replayFor as any)?.apiModelId === 'string' && (replayFor as any).apiModelId
    ? String((replayFor as any).apiModelId) : null;
  const wantProtocol = protocolKey((replayFor as any)?.protocol);
  const interleaved = Array.isArray(steps)
    ? interleave(row.content || '', calls, results, steps, wantModel, wantProtocol) : null;
  return interleaved ?? [
    { role: 'assistant', content, tool_calls: calls },
    ...calls.map((c) => flatToolMessage(c, results)),
  ];
}

/** 重建交错;三道闸任一不过返回 null(调用方退回扁平)。 */
function interleave(
  raw: string, calls: ToolCall[], results: Map<string, any>, steps: ReplayStep[],
  wantModel: string | null, wantProtocol: string,
): ChatMessage[] | null {
  // 闸⓪(毒化硬帽):整行超过 capHistoryContent 的阈值就不拆 —— 拆开后每段各自不超帽、总量却能是
  // 原来的 N 倍,等于把「单条巨型消息永久毒化会话」那道防线捅开。这类行维持原来的确定性截断。
  // 未超帽时 capHistoryContent 原样返回同一个引用,这里只是一次引用比较。
  if (capHistoryContent(raw) !== raw) return null;
  const ordered = [...steps].sort((a, b) => (Number(a?.step_no ?? a?.stepNo) || 0) - (Number(b?.step_no ?? b?.stepNo) || 0));
  const turns: Array<{ content: string; calls: ToolCall[]; items: any[] }> = [];
  const ids: string[] = [];
  for (const s of ordered) {
    if (!s || typeof s !== 'object') return null;
    const res = s.llm_response ?? s.llmResponse;
    const stepCalls = sanitizeCalls(s.tool_calls ?? s.toolCalls);
    // 不带工具调用的步骤不成一轮:末轮正文只进 finalContent、从不进在线消息数组(故无字节可对),
    // 纠错轮的正文压根没进 finalContent。两者都交给下面的尾巴逻辑,不参与拼接。
    if (!stepCalls.length) continue;
    ids.push(...stepCalls.map((c) => c.id));
    // 模型 + 协议绑定闸(文件头 ①):对不上就这一轮不带 items,**交错照常重建** —— 不是第四道退回扁平的闸。
    // outputItemsJson 是本版的落库形态(字符串,jsonb 保序);outputItems 是升级前那批行,一并认。
    const stepItems = pickReplayItems(res?.outputItemsJson ?? res?.outputItems);
    const boundTo = typeof res?.outputItemsModel?.apiModelId === 'string' ? res.outputItemsModel.apiModelId : '';
    const usable = !!wantModel && boundTo === wantModel
      && protocolKey(res?.outputItemsModel?.protocol) === wantProtocol
      && itemsCoverCalls(stepItems, stepCalls);
    turns.push({
      content: typeof res?.content === 'string' ? res.content : '',
      calls: stepCalls,
      items: usable ? stepItems : [],
    });
  }
  // 闸①:步骤记录的调用必须**正好**是本行的调用(顺序一致)。
  if (ids.length !== calls.length || ids.some((id, i) => id !== calls[i].id)) return null;
  // 闸②:appendFinal 的口径 —— 每段 trim、空段跳过、'\n\n' 连接。
  const joined = turns.map((t) => t.content.trim()).filter(Boolean).join('\n\n');
  if (!raw.startsWith(joined)) return null;
  const out: ChatMessage[] = [];
  for (const t of turns) {
    out.push({
      role: 'assistant',
      content: capHistoryContent(t.content), // 在线时是原始 res.content;这里只多一层毒化硬帽
      tool_calls: t.calls,
      ...(t.items.length ? { providerItems: t.items } : {}),
    } as ChatMessage);
    // 键序对齐在线时的 executeOneToolCall(role, content, tool_call_id),扁平那支另有键序(见上)。
    for (const c of t.calls) out.push({ role: 'tool', content: toolResultText(c, results), tool_call_id: c.id } as ChatMessage);
  }
  const tail = raw.slice(joined.length).replace(/^\n\n/, '');
  if (tail.trim()) out.push({ role: 'assistant', content: capHistoryContent(tail) });
  return out;
}
