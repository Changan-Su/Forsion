/**
 * 文本兜底工具调用解析(provider 工具模板与模型输出不匹配时的兜底)。
 *
 * 现象:个别模型(如某些经网关代理的 DeepSeek/开源模型)把工具调用当**正文**吐出,形如
 * Anthropic 的 <invoke name="run_bash"><parameter name="command" string="true">…</parameter></invoke>
 * (前缀可能是 antml:、被网关替换成 ｜｜DSML｜｜ 等占位,或没有前缀)。此时原生 tool_calls
 * 为空,agent 误判"无工具调用"而收尾停住。本函数在原生 tool_calls 为空时把这类标记解析成
 * 结构化调用,并从正文剔除标记。string="false" 的参数按 JSON 解析(数字/布尔/对象),其余按字符串。
 *
 * 安全:解析出的调用与原生调用走同一套审批闸门;仅在原生 tool_calls 为空时启用,正常流零影响。
 */
export interface ParsedTextToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export function parseTextToolCalls(content: string): {
  toolCalls: ParsedTextToolCall[];
  cleaned: string;
} {
  // 便宜的前置判断:没有 `invoke name=` 直接返回(正常回复零开销);超大正文不扫(避免病态回溯)。
  if (!content || content.length > 200_000 || !/invoke\s+name=/i.test(content)) {
    return { toolCalls: [], cleaned: content };
  }
  const invokeRe = /<[^>]*?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[^>]*?invoke\s*>/gi;
  const calls: ParsedTextToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(content)) !== null) {
    const name = m[1].trim();
    if (!name) continue;
    const body = m[2];
    const args: Record<string, unknown> = {};
    // 每个 invoke 用新正则实例,避免跨块 lastIndex 干扰。
    const paramRe =
      /<[^>]*?parameter\s+name="([^"]+)"(?:\s+string="([^"]*)")?\s*>([\s\S]*?)<\/[^>]*?parameter\s*>/gi;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(body)) !== null) {
      const key = pm[1];
      const typeHint = pm[2]; // 'true' | 'false' | undefined
      const raw = pm[3].trim();
      if (typeHint === 'false') {
        try {
          args[key] = JSON.parse(raw);
        } catch {
          args[key] = raw;
        }
      } else {
        args[key] = raw;
      }
    }
    calls.push({
      id: `call_fb_${calls.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  if (!calls.length) return { toolCalls: [], cleaned: content };
  const cleaned = content
    .replace(invokeRe, '')
    .replace(/<\/?[^>]*?tool_calls\s*>/gi, '')
    .trim();
  return { toolCalls: calls, cleaned };
}
