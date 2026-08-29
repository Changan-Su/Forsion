/** transcribe_audio 引擎侧客户端路径的端到端:真 MCP server 当假桥(Streamable HTTP + Bearer),
 *  证引擎 execute 的 发现文件读取 → 连接 → callTool → 结果解析 全链(桌面侧测试只证 server 半边)。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

describe('transcribe_audio 引擎→桥 端到端', () => {
  let home: string;
  let srv: Server;
  let port: number;
  let gotAuth: string | undefined;
  let gotArgs: any;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-e2e-'));
    process.env.TANGU_HOME = home;
    srv = createServer(async (req, res) => {
      gotAuth = req.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const server = new McpServer({ name: 'fake-desktop', version: '0.0.1' });
      server.registerTool(
        'transcribe_audio',
        { description: 'fake', inputSchema: { path: z.string(), timestamps: z.boolean().optional(), language: z.string().optional() } },
        async (args) => {
          gotArgs = args;
          return { content: [{ type: 'text', text: JSON.stringify({ text: 'FAKE-TRANSCRIPT', segments: [{ start: 0, end: 1, text: 'FAKE-TRANSCRIPT' }] }) }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port)));
    writeFileSync(path.join(home, 'desktop-bridge.json'), JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, token: 'BRTOK' }));
  });
  afterAll(async () => {
    srv.close();
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('execute:读发现文件→带 Bearer 连接→调用→回转写 JSON', async () => {
    const { transcribeAudioProvider } = await import('./transcribeAudio.js');
    const tool = transcribeAudioProvider.tools()[0];
    const out = await tool.execute({ path: '/tmp/a.wav', timestamps: true }, { userId: 'u' } as any);
    expect(gotAuth).toBe('Bearer BRTOK');
    expect(gotArgs).toMatchObject({ path: '/tmp/a.wav', timestamps: true });
    const j = JSON.parse(String(out));
    expect(j.text).toBe('FAKE-TRANSCRIPT');
    expect(j.segments).toHaveLength(1);
    // 时刻引用锚点:必须是**可原样复制的具体形态**(光在 description 里教格式,模型会缩写路径),
    // 且只教秒 —— `t=1:35` 这种钟表形态在渲染端判非法(Logseq #9920 的血)。
    // ⚠️ 必须住在 JSON **里面**:本工具的输出契约是一份 JSON,尾部追加会把它变成非法 JSON。
    expect(j.cite).toContain('[[/tmp/a.wav#t=95|01:35]]');
    expect(j.cite).toMatch(/Seconds only/);
  });

  it('没要时间戳就不教时刻锚点(没有 segments = 没有秒数,教了只会诱发编造)', async () => {
    const { transcribeAudioProvider } = await import('./transcribeAudio.js');
    const tool = transcribeAudioProvider.tools()[0];
    const out = await tool.execute({ path: '/tmp/a.wav' }, { userId: 'u' } as any);
    const j = JSON.parse(String(out));
    expect(j.text).toBe('FAKE-TRANSCRIPT');
    expect(j.cite).toBeUndefined();
  });

  it('相对路径直接拒绝(不发请求)', async () => {
    const { transcribeAudioProvider } = await import('./transcribeAudio.js');
    const tool = transcribeAudioProvider.tools()[0];
    const out = await tool.execute({ path: 'a.wav' }, { userId: 'u' } as any);
    expect(String(out)).toMatch(/^Error: path must be an absolute/);
  });
});
