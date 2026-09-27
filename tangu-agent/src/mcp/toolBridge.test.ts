import { describe, it, expect } from 'vitest';
import { schemaUsable, bridgeName, bridgeTool, contentToText, contentToResult, fenceMcpText, MCP_IMAGES_PER_CALL, MCP_IMAGE_MAX_BYTES } from './toolBridge.js';

describe('schemaUsable', () => {
  it('rejects null / non-object / $ref / non-object type', () => {
    expect(schemaUsable(null)).toBe(false);
    expect(schemaUsable('str' as any)).toBe(false);
    expect(schemaUsable({ $ref: '#/defs/X' })).toBe(false);
    expect(schemaUsable({ type: 'array' })).toBe(false);
  });
  it('accepts object schemas (explicit or default)', () => {
    expect(schemaUsable({ type: 'object' })).toBe(true);
    expect(schemaUsable({})).toBe(true); // type ?? 'object'
  });
});

describe('bridgeName', () => {
  it('produces mcp__server__tool and sanitizes illegal chars', () => {
    const used = new Set<string>();
    expect(bridgeName('s v', 't.o', used)).toBe('mcp__s_v__t_o');
  });
  it('dedupes collisions with numeric suffix', () => {
    const used = new Set<string>();
    expect(bridgeName('srv', 'tool', used)).toBe('mcp__srv__tool');
    expect(bridgeName('srv', 'tool', used)).toBe('mcp__srv__tool_2');
  });
  it('caps name length at 64', () => {
    const used = new Set<string>();
    const name = bridgeName('s'.repeat(60), 't'.repeat(60), used);
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe('bridgeTool', () => {
  it('builds a LoadedMcpTool for a usable schema', () => {
    const used = new Set<string>();
    const t = bridgeTool('srv', { name: 'do', description: 'does', inputSchema: { type: 'object', properties: { a: {} }, required: ['a'] } }, used);
    expect(t).not.toBeNull();
    expect(t!.serverName).toBe('srv');
    expect(t!.remoteName).toBe('do');
    expect(t!.definition.function.name).toBe(t!.name);
    expect((t!.definition.function.parameters as any).required).toEqual(['a']);
    expect(t!.definition.function.description).toContain('[MCP·srv]');
  });
  it('returns null for $ref-bearing schema', () => {
    const used = new Set<string>();
    expect(bridgeTool('srv', { name: 'bad', inputSchema: { $ref: '#/x' } }, used)).toBeNull();
  });
  it('defaults a missing inputSchema to an empty object schema', () => {
    const used = new Set<string>();
    const t = bridgeTool('srv', { name: 'noschema' }, used);
    expect(t).not.toBeNull();
    expect((t!.definition.function.parameters as any).type).toBe('object');
  });
});

describe('contentToText', () => {
  it('joins text blocks', () => {
    expect(contentToText({ content: [{ type: 'text', text: 'hi' }] })).toEqual({ text: 'hi', isError: false });
  });
  it('reports isError and empty placeholder', () => {
    expect(contentToText({ isError: true, content: [] })).toEqual({ text: '(empty result)', isError: true });
  });
  it('summarizes image blocks', () => {
    const r = contentToText({ content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }); // PNG 魔数
    expect(r.text).toContain('[image: image/png');
  });
});

describe('contentToResult(M6)', () => {
  const png = 'iVBORw0KGgo=';
  it('jpeg / gif / webp 按魔数认', () => {
    const r = contentToResult({ content: [
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' },
      { type: 'image', mimeType: 'image/gif', data: Buffer.from('GIF89a..').toString('base64') },
      { type: 'image', mimeType: 'image/webp', data: Buffer.from('RIFF\0\0\0\0WEBPVP8 ').toString('base64') },
    ] });
    expect(r.images.map((i) => i.mimeType)).toEqual(['image/jpeg', 'image/gif', 'image/webp']);
  });
  it('位图块取出为图片,不留占位', () => {
    const r = contentToResult({ content: [{ type: 'text', text: 'cap' }, { type: 'image', mimeType: 'IMAGE/PNG', data: png }] });
    expect(r).toEqual({ text: 'cap', isError: false, images: [{ mimeType: 'image/png', data: png }] });
  });
  it('矢量 / 非 base64 / 超 5MB / 魔数与 MIME 不符 → 不回灌,文本里给占位', () => {
    const r = contentToResult({ content: [
      { type: 'image', mimeType: 'image/svg+xml', data: png },
      { type: 'image', mimeType: 'image/png', data: 'not base64!' },
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(Math.ceil((MCP_IMAGE_MAX_BYTES + 10) * 4 / 3)) },
      { type: 'image', mimeType: 'image/png', data: '/9j/4AAQSkZJRg==' }, // 声明 png、实为 jpeg 头
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAAAAAAAAAA' }, // 合法 base64,不是图
    ] });
    expect(r.images).toEqual([]);
    expect(r.text.match(/\[image omitted/g)?.length).toBe(5);
  });
  it(`单次最多回灌 ${MCP_IMAGES_PER_CALL} 张`, () => {
    const r = contentToResult({ content: Array.from({ length: MCP_IMAGES_PER_CALL + 2 }, () => ({ type: 'image', mimeType: 'image/png', data: png })) });
    expect(r.images.length).toBe(MCP_IMAGES_PER_CALL);
    expect(r.text).toContain('too many images');
  });
});

describe('fenceMcpText(M6)', () => {
  it('截断发生在围栏内,收尾标签完整;server 名消毒', () => {
    const f = fenceMcpText('we"ird<srv>', 'x'.repeat(100), 10);
    expect(f).toContain('<mcp_data server="we_ird_srv_">');
    expect(f).toContain('…[truncated]');
    expect(f.endsWith('</mcp_data>')).toBe(true);
  });
  it('空文本 → 空串', () => {
    expect(fenceMcpText('s', '', 10)).toBe('');
  });
});
