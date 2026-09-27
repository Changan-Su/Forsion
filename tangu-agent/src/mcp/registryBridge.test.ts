/**
 * registry 的 MCP 分支(方案 2026-09-26 §3.3 M6):server 返回的图片经 run 的 collectImage 回灌并带不可信前言,
 * 不再退化成 `[image: …]` 占位;没有回灌通道时如实说明。另钉:第三方 annotations 不放宽任何东西。
 */
import { describe, it, expect, vi } from 'vitest';
import '../tools/registry.js'; // 副作用:注册全部内置 provider
import { executeTool, getToolCapabilities } from '../tools/registry.js';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { bridgeTool, MCP_IMAGE_PREFACE, type LoadedMcpTool } from './toolBridge.js';
import type { McpManager } from './manager.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
const profile = createTanguProfile({ sandboxMode: 'none' });
const callTool = vi.fn<McpManager['callTool']>();
const mcp: McpManager = {
  toolsForRun: () => new Map(), callTool, listStatus: () => [], start: async () => {}, dispose: async () => {},
};
configureTangu({ host: stub, brain: stub, billing: stub, profile, mcp });

// 第三方自报「只读、无破坏」—— 引擎不得据此放宽
const tool: LoadedMcpTool = bridgeTool('shots', {
  name: 'snap', description: 'take a screenshot', inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
} as any, new Set())!;
const baseCtx = {
  userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp',
  hostSandbox: { mode: 'off', network: 'deny' }, mcpTools: new Map([[tool.name, tool]]),
} as any;
const call = { id: 'c1', type: 'function', function: { name: tool.name, arguments: '{}' } } as any;

describe('registry × MCP 结果', () => {
  it('图片经 collectImage 回灌,带不可信前言;结果文本说明图片随后到、同样不可信', async () => {
    callTool.mockResolvedValueOnce({ text: '<fenced text>', isError: false, images: [{ mimeType: 'image/png', data: PNG }] });
    const collectImage = vi.fn();
    const r = await executeTool(call, { ...baseCtx, collectImage });
    expect(collectImage).toHaveBeenCalledTimes(1);
    expect(collectImage).toHaveBeenCalledWith({ url: `data:image/png;base64,${PNG}`, name: `${tool.name}-1.png`, untrusted: MCP_IMAGE_PREFACE });
    expect(r.isError).toBe(false);
    expect(r.result).toContain('<fenced text>');
    expect(r.result).toContain('Up to 1 image(s) returned by MCP server "shots" may be attached after these tool results as a separate message');
    expect(r.result).toContain('untrusted');
    expect(r.result).not.toContain('[image:');
  });

  it('没有回灌通道 → 如实说明图片没给到模型,不调用任何东西', async () => {
    callTool.mockResolvedValueOnce({ text: 'caption', isError: false, images: [{ mimeType: 'image/png', data: PNG }] });
    const r = await executeTool(call, baseCtx);
    expect(r.result).toContain('caption');
    expect(r.result).toContain('omitted: this runtime cannot show images');
  });

  it('无图无字 → (empty result);错误照样标 isError', async () => {
    callTool.mockResolvedValueOnce({ text: '', isError: false });
    expect((await executeTool(call, baseCtx)).result).toBe('(empty result)');
    callTool.mockResolvedValueOnce({ text: 'Error: MCP 调用失败: boom', isError: true });
    const r = await executeTool(call, baseCtx);
    expect(r.isError).toBe(true);
    expect(r.result).toContain('boom');
  });

  it('annotations(readOnlyHint 等)不放宽:仍是串行 / 副作用未知', () => {
    expect(getToolCapabilities(tool.name, baseCtx)).toEqual({ sideEffect: 'unknown', parallel: false });
    expect(JSON.stringify(tool.definition)).not.toContain('readOnlyHint');
  });
});
