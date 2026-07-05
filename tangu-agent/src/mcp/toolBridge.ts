/**
 * MCP 工具桥:把 MCP server 的 tool 包成 loop 可执行的 LoadedMcpTool。
 *   - 命名 `mcp__<server>__<tool>`(消毒至 [a-zA-Z0-9_-],OpenAI function 名上限 64 字符,
 *     超长截断 + 序号去重)
 *   - inputSchema 透传(含 $ref 的 schema 部分 provider 不认 → 该工具跳过并告警,不连坐整个 server)
 *   - 结果 content blocks → 文本(图片/资源给占位说明)
 */
import type { Tool } from '../core/types.js';

export interface LoadedMcpTool {
  /** 喂给 LLM 的名字:mcp__<server>__<tool>。 */
  name: string;
  serverName: string;
  /** server 侧原始工具名(callTool 用)。 */
  remoteName: string;
  definition: Tool;
}

const NAME_MAX = 64;

function sanitizePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 生成消毒 + 去重后的工具名。usedNames 跨 server 共享(全局唯一)。 */
export function bridgeName(serverName: string, toolName: string, usedNames: Set<string>): string {
  let base = `mcp__${sanitizePart(serverName)}__${sanitizePart(toolName)}`;
  if (base.length > NAME_MAX) base = base.slice(0, NAME_MAX);
  let name = base;
  let n = 2;
  while (usedNames.has(name)) {
    const suffix = `_${n++}`;
    name = base.slice(0, NAME_MAX - suffix.length) + suffix;
  }
  usedNames.add(name);
  return name;
}

/** schema 含顶层 $ref / 非 object 时不可直接喂 LLM。 */
export function schemaUsable(schema: any): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref) return false;
  return (schema.type ?? 'object') === 'object';
}

export function bridgeTool(
  serverName: string,
  remote: { name: string; description?: string; inputSchema?: any },
  usedNames: Set<string>,
): LoadedMcpTool | null {
  const schema = remote.inputSchema ?? { type: 'object', properties: {} };
  if (!schemaUsable(schema)) {
    console.warn(`[mcp] ${serverName}/${remote.name}: inputSchema 含 $ref/非 object,跳过该工具`);
    return null;
  }
  const name = bridgeName(serverName, remote.name, usedNames);
  return {
    name,
    serverName,
    remoteName: remote.name,
    definition: {
      type: 'function',
      function: {
        name,
        description: `[MCP·${serverName}] ${remote.description || remote.name}`.slice(0, 1024),
        parameters: {
          type: 'object',
          properties: schema.properties ?? {},
          ...(Array.isArray(schema.required) && schema.required.length ? { required: schema.required } : {}),
        },
      },
    },
  };
}

/** MCP CallToolResult.content → 回给模型的字符串。 */
export function contentToText(result: any): { text: string; isError: boolean } {
  const isError = !!result?.isError;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b?.type === 'text') parts.push(String(b.text ?? ''));
    else if (b?.type === 'image') parts.push(`[image: ${b.mimeType || 'unknown'}, base64 ${String(b.data || '').length} chars]`);
    else if (b?.type === 'resource') {
      const r = b.resource || {};
      parts.push(r.text ? String(r.text) : `[resource: ${r.uri || 'unknown'}]`);
    } else if (b?.type === 'resource_link') parts.push(`[resource_link: ${b.uri || ''} ${b.name || ''}]`);
    else parts.push(JSON.stringify(b).slice(0, 500));
  }
  return { text: parts.join('\n') || '(empty result)', isError };
}
