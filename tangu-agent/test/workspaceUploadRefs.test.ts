/**
 * P1 · M1A:手机经隧道上传进会话工作区的附件,host 模式的模型看得到(K9 KNOWN-GAP「host 模式的模型看得到手机发来的附件」)。
 * 真 express + 真 workspace 上传路由(远程头)+ 真 agentLoop(内存 SQLite、fake brain 抓 wire):
 *   ① 上传落在会话沙箱目录 → 下一条输入区起的 host run 的**本轮** user 消息第一行 = 它的绝对路径(与桌面 fileChip 同格式),
 *      且落库的就是这一行(之后每轮回放同样看得见);
 *   ② 取走即清:同会话下一条 run 不再重复报;派生 run(无 origin)不吃;sandbox run 取走但不拼;
 *   ③ 路径不越界:报出来的路径就在会话目录里(K10a 的钳制照旧);拼接不给远程 run 加任何可写根(那一面由 fsPolicy 的用例钉)。
 * 负对照:把 agentLoop 里的 `withUploadRefs(...)` 换回 `String(input.message || '')` → ①红。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/workspaceUploadRefs.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  // sessionSandbox 的 BASE_DIR 在模块加载时定:必须早于 import。目录名带空格:钉「含空白的路径加引号」那一支。
  process.env.AGENT_SANDBOX_SESSION_DIR = `${process.env.TMPDIR || '/tmp'}/tangu m1a uploads ${process.pid}`;
});

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import workspaceRouter from '../src/routes/workspace.js';
import { getSessionDir } from '../src/sandbox/sessionSandbox.js';
import { withUploadRefs, noteWorkspaceUpload, takeWorkspaceUploads, _resetWorkspaceUploads, MAX_UPLOAD_REFS } from '../src/services/workspaceUploads.js';

const USER = 'u1';
const REMOTE = { 'x-forsion-remote': 'tunnel' };
let srv: Server;
let base: string;
let home: string;
let workspace: string;
let llmPayloads: any[];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-m1a-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'tangu-m1a-ws-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        llmPayloads.push(o.payload);
        return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' };
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json({ limit: '10mb' })); app.use(workspaceRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  for (const d of [home, workspace, process.env.AGENT_SANDBOX_SESSION_DIR!]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { llmPayloads = []; _resetWorkspaceUploads(); });

const upload = async (sid: string, files: Array<{ path: string; content: string }>) => {
  const r = await fetch(`${base}/agent/workspace/upload`, {
    method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...REMOTE }, body: JSON.stringify({ sessionId: sid, files }),
  });
  return r.json() as Promise<any>;
};
async function session(sid: string): Promise<void> {
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', 'user')`, [sid, USER]);
}
async function runToSettled(sid: string, id: string, msg: string, extra: Record<string, unknown> = {}): Promise<any> {
  await createRun({
    id, sessionId: sid, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`,
    input: { message: msg, userMessageId: `U-${id}`, attachments: [], agentConfig: { execMode: 'host', cwd: workspace }, origin: 'client', ...extra },
  });
  enqueueRun(sid, id);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(id);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}
const textOf = (m: any): string => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
const lastUser = (payload: any): string => textOf([...(payload.messages as any[])].reverse().find((m) => m.role === 'user'));
const userRow = async (id: string): Promise<string> => String((await query<any[]>(`SELECT content FROM chat_messages WHERE id = ?`, [id]))[0]?.content ?? '');

describe('withUploadRefs:与桌面 fileChip 同一格式', () => {
  it('裸路径单空格连成第一行;含空白加引号;没上传原样返回', () => {
    expect(withUploadRefs('hi', [])).toBe('hi');
    expect(withUploadRefs('hi', ['/a/b.txt', '/c d/e.txt'])).toBe('/a/b.txt "/c d/e.txt"\nhi');
    expect(withUploadRefs('', ['/a/b.txt'])).toBe('/a/b.txt\n');
  });
  it('引号 / 换行进不了 token:改在末尾单列 JSON 串,第一行不被拆坏', () => {
    const out = withUploadRefs('hi', ['/a/ok.txt', '/a/"q".txt', '/a/x\ny.txt']);
    expect(out.split('\n')[0]).toBe('/a/ok.txt');
    expect(out).toContain('Attached files: "/a/\\"q\\".txt", "/a/x\\ny.txt"');
  });
  it(`超过 ${MAX_UPLOAD_REFS} 个:留最近的,余数报个数`, () => {
    const paths = Array.from({ length: MAX_UPLOAD_REFS + 3 }, (_, i) => `/d/f${i}.txt`);
    const out = withUploadRefs('hi', paths);
    expect(out.split('\n')[0].split(' ')).toHaveLength(MAX_UPLOAD_REFS);
    expect(out.split('\n')[0]).not.toContain('/d/f0.txt');
    expect(out).toContain('(3 more attached files in the same folder)');
  });
  it('登记表:同路径重传不重复,取走即清', () => {
    noteWorkspaceUpload('s', '/x/a'); noteWorkspaceUpload('s', '/x/b'); noteWorkspaceUpload('s', '/x/a');
    expect(takeWorkspaceUploads('s')).toEqual(['/x/b', '/x/a']);
    expect(takeWorkspaceUploads('s')).toEqual([]);
  });
});

describe('真路由 × 真 loop:手机上传的附件进 host run 的本轮 user 消息', () => {
  it('① 本轮第一行 = 会话目录里那份文件的绝对路径,且落库;② 下一轮不重复报', async () => {
    const sid = 'M1A-HOST';
    await session(sid);
    const up = await upload(sid, [{ path: 'phone note.txt', content: 'from the phone' }]);
    expect(up.saved).toBe(1);
    const dir = realpathSync(await getSessionDir({ userId: USER, appId: 'tangu', sessionId: sid, wsProject: null }));
    const abs = join(dir, 'phone note.txt');
    expect(existsSync(abs)).toBe(true);

    expect((await runToSettled(sid, 'R1', 'uppercase the attachment', { remote: { via: 'tunnel', marked: false } })).status).toBe('done');
    const wire = lastUser(llmPayloads[0]);
    expect(wire.split('\n')[0], '第一行是带引号的绝对路径(含空白)').toBe(`"${abs}"`);
    expect(wire).toContain('uppercase the attachment');
    expect(await userRow('U-R1'), '落库的就是模型看到的那条').toBe(`"${abs}"\nuppercase the attachment`);

    await runToSettled(sid, 'R2', 'again');
    expect(lastUser(llmPayloads[1]), '取走即清:第二轮不再拼').toBe('again');
  });

  it('派生 run(非输入区)不吃别人的上传;sandbox run 取走但不拼', async () => {
    const sid = 'M1A-DERIVED';
    await session(sid);
    await upload(sid, [{ path: 'a.txt', content: 'x' }]);
    await runToSettled(sid, 'D1', 'derived', { origin: undefined });
    expect(lastUser(llmPayloads[0])).toBe('derived');
    await runToSettled(sid, 'D2', 'sandbox turn', { agentConfig: { execMode: 'sandbox' } });
    expect(lastUser(llmPayloads[1])).toBe('sandbox turn');
    await runToSettled(sid, 'D3', 'host turn');
    expect(lastUser(llmPayloads[2]), 'sandbox run 已取走').toBe('host turn');
  });
});
