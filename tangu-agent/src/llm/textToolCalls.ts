/**
 * 文本兜底工具调用解析(provider 工具模板与模型输出不匹配时的兜底)。
 *
 * 现象:经网关/聚合代理的开源模型常把工具调用当**正文**吐出(推理端没配对该模型的
 * tool-call 解析模板),导致原生 tool_calls 为空、下游 agent 误判"无工具调用"收尾停住。
 * 不同模型吐**不同的原生格式**,本文件多格式兜底,仅当原生 tool_calls 为空时启用:
 *   ① Anthropic 式:<invoke name="X"><parameter name="Y" string="true|false">Z</parameter></invoke>
 *      (前缀可能是 antml:、被网关替换成 ｜｜DSML｜｜ 等占位,或无前缀;DeepSeek-V4-Pro 走这个)
 *   ② Kimi K2 式:<|tool_call_begin|>functions.NAME:IDX<|tool_call_argument_begin|>{json}<|tool_call_end|>
 *   ③ DeepSeek 原生:<｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME ```json {json} ```<｜tool▁call▁end｜>
 *
 * 健壮性:① 采用「按起始标记切段」而非「严格配对闭合」,流被截断 / 模型漏写 </invoke> / 网关吞掉
 * 收尾标记时仍能解析出已写完的调用(否则单个缺失闭合标记会让整轮工具调用全丢、loop 静默收尾)。
 *
 * 性能/安全:前缀字符类用 [^<>](不含 '<'),否则裸 `<` 串(ASCII art / 截断的 HTML/diff / `<<<<<<<`
 * 冲突标记)会让每个 `<` 都成候选起点、惰性扫到文末 → O(n²) ReDoS。真实前缀只会是 antml:/｜｜DSML｜｜/空,
 * 都不含 '<' '>',故收窄字符类零行为损失。再加 200KB 上限与代码围栏跳过(见下)。
 * 解析出的调用与原生调用走**同一套审批闸门**;仅在原生 tool_calls 为空时启用,正常流零影响。
 */
export interface ParsedTextToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ParseResult = { toolCalls: ParsedTextToolCall[]; cleaned: string };

function call(idx: number, name: string, argsJson: string): ParsedTextToolCall {
  return { id: `call_fb_${idx}`, type: 'function', function: { name, arguments: argsJson } };
}

/** 标记型正则(前缀容错 [^<>]*? 吸收 antml:/｜｜DSML｜｜/任意非'<>'占位;不含 '<' 杜绝 ReDoS)。 */
const INVOKE_OPEN = /<[^<>]*?invoke\s+name="([^"]+)"\s*>/gi;
const INVOKE_CLOSE = /<\/[^<>]*?invoke\s*>/gi;
const PARAM_OPEN = /<[^<>]*?parameter\s+name="([^"]+)"(?:\s+string="([^"]*)")?\s*>/gi;
const PARAM_CLOSE = /<\/[^<>]*?parameter\s*>/gi;
const TOOLCALLS_TAG = /<\/?[^<>]*?tool_calls\s*>/gi;
/** 剔除工具标记后,清掉正文里游离的 invoke/parameter/tool_calls 收尾标记(值里写了字面闭合标记时的泄漏)。 */
const STRAY_TAGS = /<\/?[^<>]*?(?:invoke|parameter|tool_calls)[^<>]*?>/gi;

const MAX_LEN = 200_000;

/** 解析单个 invoke body 内的参数(容忍漏写 </parameter>:值取到下一个 parameter 起始或 body 末尾)。 */
function parseParams(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const opens: Array<{ key: string; hint?: string; openStart: number; valStart: number }> = [];
  PARAM_OPEN.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = PARAM_OPEN.exec(body)) !== null) {
    opens.push({ key: pm[1], hint: pm[2], openStart: pm.index, valStart: PARAM_OPEN.lastIndex });
  }
  for (let i = 0; i < opens.length; i++) {
    const p = opens[i];
    const nextOpenStart = i + 1 < opens.length ? opens[i + 1].openStart : body.length;
    // 只在 [valStart, nextOpenStart) 窗口找 </parameter>:窗口互不重叠,总扫描 O(n)。
    // 否则缺闭合标记时每个 param 都 exec 到 body 末尾 → O(n²)(大量未闭合 <parameter> 输入打成 DoS)。
    const seg = body.slice(p.valStart, nextOpenStart);
    PARAM_CLOSE.lastIndex = 0;
    const cm = PARAM_CLOSE.exec(seg);
    const valEnd = cm ? p.valStart + cm.index : nextOpenStart;
    const raw = body.slice(p.valStart, valEnd).trim();
    if (p.hint === 'false') {
      try {
        args[p.key] = JSON.parse(raw);
      } catch {
        args[p.key] = raw;
      }
    } else {
      args[p.key] = raw;
    }
  }
  return args;
}

/** ① Anthropic <invoke>/<parameter>(前缀容错 + 截断容错);string="false" 的参数按 JSON 解析。
 *  注:不跳过代码围栏(```)内的 <invoke> —— 本就用文本工具调用的模型,其调用常与 ```代码块narration
 *  交错,围栏跳过会因 ``` 配对错乱(未闭合/奇数个)漏掉真实调用、致 loop 静默收尾(2026-06-15 回归)。
 *  代价:文档里"举例的" <invoke> 也会被当真调用——对文本工具调用模型这是可接受取舍(无法可靠区分)。 */
function parseAnthropic(content: string): ParseResult | null {
  if (!/invoke\s+name=/i.test(content)) return null;
  // 先收集所有 invoke 起始(含位置);body 边界 = 最近的 </invoke> 或下一个 <invoke 或 文末。
  INVOKE_OPEN.lastIndex = 0;
  const opens: Array<{ name: string; openStart: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = INVOKE_OPEN.exec(content)) !== null) {
    opens.push({ name: m[1].trim(), openStart: m.index, bodyStart: INVOKE_OPEN.lastIndex });
  }
  if (!opens.length) return null;

  const calls: ParsedTextToolCall[] = [];
  const spans: Array<[number, number]> = []; // 需从正文剔除的 [start,end) 区间
  for (let i = 0; i < opens.length; i++) {
    const o = opens[i];
    const nextOpenStart = i + 1 < opens.length ? opens[i + 1].openStart : content.length;
    // 只在 [bodyStart, nextOpenStart) 窗口找 </invoke>:窗口互不重叠,N 个 open 总扫描 = O(n)。
    // 否则缺闭合标记时每个 open 都 exec 到 EOF → N×O(n) = O(n²)(大量未闭合 <invoke> 输入打成 DoS)。
    const seg = content.slice(o.bodyStart, nextOpenStart);
    INVOKE_CLOSE.lastIndex = 0;
    const cm = INVOKE_CLOSE.exec(seg);
    let bodyEnd = nextOpenStart;
    let spanEnd = nextOpenStart;
    if (cm) {
      bodyEnd = o.bodyStart + cm.index;
      spanEnd = bodyEnd + cm[0].length; // 连闭合标记一起剔除
    }
    if (!o.name) continue;
    const args = parseParams(seg.slice(0, cm ? cm.index : seg.length));
    calls.push(call(calls.length, o.name, JSON.stringify(args)));
    spans.push([o.openStart, spanEnd]);
  }
  if (!calls.length) return null;

  // 拼出剔除工具调用区间后的正文 + 清理游离的 invoke/parameter/tool_calls 标记(值里写了字面闭合标记时的泄漏)。
  let cleaned = '';
  let cur = 0;
  for (const [s, e] of spans) {
    if (s > cur) cleaned += content.slice(cur, s);
    cur = Math.max(cur, e);
  }
  cleaned += content.slice(cur);
  cleaned = cleaned.replace(STRAY_TAGS, '').trim();
  return { toolCalls: calls, cleaned };
}

/** ② Kimi K2 <|tool_call_begin|>functions.NAME:IDX<|tool_call_argument_begin|>{json}<|tool_call_end|> */
function parseKimi(content: string): ParseResult | null {
  if (!content.includes('<|tool_call_begin|>')) return null;
  // 收尾容错:<|tool_call_end|> 缺失时,argument 取到下一个 <|tool_call_begin|> 或文末。
  const re = /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_argument_begin\|>([\s\S]*?)(?:<\|tool_call_end\|>|(?=<\|tool_call_begin\|>)|$)/g;
  const calls: ParsedTextToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1].trim().replace(/^functions\./, '').replace(/:\d+\s*$/, '').trim();
    if (!name) continue;
    const args = m[2].trim();
    calls.push(call(calls.length, name, args.startsWith('{') ? args : '{}'));
  }
  if (!calls.length) return null;
  const cleaned = content.replace(re, '').replace(/<\|tool_calls_section_(?:begin|end)\|>/g, '').trim();
  return { toolCalls: calls, cleaned };
}

/** ③ DeepSeek 原生 <｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME ```json {json} ```<｜tool▁call▁end｜>。
 *     ｜=U+FF5C ▁=U+2581,用转义避免源码编码歧义。收尾容错同上。 */
function parseDeepSeek(content: string): ParseResult | null {
  if (!content.includes('｜tool▁call▁begin｜')) return null;
  const re = /<｜tool▁call▁begin｜>[\s\S]*?<｜tool▁sep｜>([\s\S]*?)(?:<｜tool▁call▁end｜>|(?=<｜tool▁call▁begin｜>)|$)/g;
  const calls: ParsedTextToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const seg = m[1].trim();
    const nm = seg.match(/^([A-Za-z0-9_.\-]+)/);
    if (!nm) continue;
    const name = nm[1].replace(/^functions\./, '');
    const jm = seg.match(/```(?:json)?\s*([\s\S]*?)```/);
    let args = jm ? jm[1].trim() : seg.slice(nm[0].length).trim();
    if (!args.startsWith('{')) args = '{}';
    calls.push(call(calls.length, name, args));
  }
  if (!calls.length) return null;
  const cleaned = content
    .replace(re, '')
    .replace(/<｜tool▁calls▁(?:begin|end)｜>/g, '')
    .trim();
  return { toolCalls: calls, cleaned };
}

export function parseTextToolCalls(content: string): ParseResult {
  if (!content || content.length > MAX_LEN) return { toolCalls: [], cleaned: content };
  return (
    parseAnthropic(content) ||
    parseKimi(content) ||
    parseDeepSeek(content) || { toolCalls: [], cleaned: content }
  );
}

/**
 * 正文是否「看起来含工具调用意图」但没被解析成结构化调用。
 * agent loop 的安全网:原生 tool_calls 为空、文本兜底也没解出来,但正文带工具调用标记时,
 * 别静默收尾——而是回灌一条纠正提示让模型用原生函数调用重试(见 agentLoop 的 recovery)。
 * 严格匹配「带 name= 的 invoke / 带起始 token 的 Kimi·DeepSeek」,避免把单纯讨论这些语法的散文误判。
 * 字符类 [^<>] + 长度上限:这函数跑在 recovery 路径的原始模型正文上,裸 `<` 串否则会 O(n²) 卡死。
 */
export function looksLikeToolCallText(content: string): boolean {
  if (!content || content.length > MAX_LEN) return false;
  return (
    /<[^<>]*?invoke\s+name="/i.test(content) ||
    content.includes('<|tool_call_begin|>') ||
    content.includes('｜tool▁call▁begin｜')
  );
}
