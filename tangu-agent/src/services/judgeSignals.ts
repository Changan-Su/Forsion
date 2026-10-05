/**
 * 后台复盘(Historian 判官)的确定性触发信号(方案 E2)。
 *
 * 判官平时只在第 1 轮和每 N 轮评一次,评审说明里还写着候选「通常为空」—— 出了事的那一轮多半轮不到它,
 * 轮到了它也不知道该往哪看。出现下面这些情况时,当轮就评一次,并把发生了什么告诉它:
 *   - 用户按停了上一轮,而那一轮已经调了好几次工具、还没给出答案。记在会话上,等用户的**下一轮**跑完再评 ——
 *     按停那一刻对话里只有半截过程,用户为什么停、想要什么,要看他接下来说的那句;
 *   - 同一个工具调用连续失败到被掐断(RepeatedToolFailureGuard);
 *   - 模型一个工具没调就说「做好了 / 这就做」,被兑现兜底催过(actionDeliveryCheck);
 *   - 用户这一轮开头的话读起来是在纠正上一条回复。
 * 信号只决定「现在评一次、往哪看」。写不写、写什么,仍由判官和它后面的形状闸决定。
 * 给判官的句子是英文(模型读的),只含工具名和次数,不带工具报错原文 —— 那是不可信内容,不该进一条能写长期记忆的提示。
 */
import { MAX_REPEATED_TOOL_FAILURES } from './repeatedToolFailure.js';

/** 用户按停时,这一轮至少调过这么多次工具才算「折腾了半天没给答案」。 */
export const STOP_SIGNAL_MIN_TOOL_CALLS = 3;

/** 工具名 → "web_search ×4, run_bash ×3"(按次数降序,最多 6 种)。名字只留安全字符:MCP 工具名是外部来的。 */
export function toolTally(names: readonly string[]): string {
  const count = new Map<string, number>();
  for (const raw of names) {
    const n = String(raw || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48);
    if (n) count.set(n, (count.get(n) || 0) + 1);
  }
  const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 6).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ') + (sorted.length > 6 ? ', …' : '');
}

export const NUDGE_SIGNAL =
  'In the latest turn the agent said it had done, or was about to do, something without calling any tool, and had to be told to actually do it.';
export const CORRECTION_SIGNAL = "The user's message that starts the latest turn reads like a correction of the agent's previous reply.";
export const toolLoopSignal = (names: readonly string[]): string =>
  `In the latest turn the same tool call (${toolTally(names) || 'a tool'}) failed ${MAX_REPEATED_TOOL_FAILURES} times in a row with unchanged arguments and the same error, so the agent was cut off from tools.`;
const stopSignal = (names: readonly string[]): string =>
  `The user stopped the previous turn after the agent had made ${names.length} tool calls (${toolTally(names)}) without giving an answer; the latest turn starts with what the user said next.`;

// 用户按停留下的待评信号:会话 → 句子。下一轮 done 时取走。进程内(重启即丢:信号只是「多评一次」,丢了退回平时的节奏)。
const pendingStops = new Map<string, string>();
const PENDING_STOPS_MAX = 200; // 按停后再没回来的会话各留一条,封个顶

export function noteUserStop(sessionId: string, toolNames: readonly string[]): void {
  if (toolNames.length < STOP_SIGNAL_MIN_TOOL_CALLS) return;
  pendingStops.delete(sessionId); // 重新插入 = 挪到最新
  pendingStops.set(sessionId, stopSignal(toolNames));
  while (pendingStops.size > PENDING_STOPS_MAX) pendingStops.delete(pendingStops.keys().next().value as string);
}

export function takePendingStop(sessionId: string): string | undefined {
  const s = pendingStops.get(sessionId);
  pendingStops.delete(sessionId);
  return s;
}

// ponytail: 词面启发式(中英),不是分类器。误报的代价 = 多一次后台评审(同会话有冷却),漏报退回平时的节奏;
// 判官读得到原话,自己判断那是不是纠正。要更准再换成一次便宜的分类调用。
const CORRECTION_ZH =
  /不对|不是这|不是让你|不是叫你|不是要你|错了|搞错|弄错|理解错|说错|我说的是|我的意思是|我是说|我要的是|应该是|说过了|跟你说过|又忘|又错|又来|别再|不要再|别这样|不要这样|以后[^。.!?！？\n]{0,14}(都|别|不要|一律|只用|请|记得)|下次[^。.!?！？\n]{0,10}(别|不要|记得|先|请)|重新来|重来|谁让你/;
const CORRECTION_EN =
  /\b(that'?s (not|wrong)|that is (not|wrong)|not what i (asked|meant|said|wanted)|i (said|meant|asked for)\b|you (misunderstood|got it wrong|forgot|ignored)|wrong\b|incorrect\b|don'?t do that|stop (doing|using)|i told you|as i said|next time\b|from now on\b)/i;
const CORRECTION_LEAD_EN = /^\s*(no|nope|nah)\b[\s,.!:;-]/i;

/** 用户这句话读起来像不像在纠正上一条回复。只看开头一段:纠正通常开门见山,长消息后半截的「next time」多半是任务描述。 */
export function looksLikeCorrection(text: string): boolean {
  const t = String(text || '').replace(/[’‘]/g, "'").trim().slice(0, 240);
  if (t.length < 2) return false;
  return CORRECTION_ZH.test(t) || CORRECTION_EN.test(t) || CORRECTION_LEAD_EN.test(t);
}

/** 写给判官的那一段(放在字段说明之后)。没有要它看的候选类别就不写。 */
export function judgeTriggerBlock(signals: readonly string[], want: { memory: boolean; harness: boolean; project?: boolean }): string {
  if (!signals.length || !(want.memory || want.harness)) return '';
  return [
    '[Why this review runs now]',
    ...signals.map((s) => `- ${s}`),
    'Work out from the conversation itself what went wrong or what the user was correcting. ' +
      (want.harness ? 'What the agent should do differently next time is a harness_candidates entry. ' : '') +
      (want.memory
        ? `What the user corrected, required or stated belongs in memory_candidates${want.project ? ' (project_memory_candidates when it holds only in this project)' : ''}. `
        : '') +
      'This note only tells you where to look; it is not evidence. Every gate above still applies: if the conversation does not clearly show a durable lesson, leave the arrays empty.',
  ].join('\n');
}

/** 测试用:清空进程内状态。 */
export function resetJudgeSignals(): void {
  pendingStops.clear();
}
