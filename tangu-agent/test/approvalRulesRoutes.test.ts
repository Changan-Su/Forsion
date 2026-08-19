/**
 * GET/PUT /agent/approval-rules 路由集成测试:真 express(listen 随机端口,fetch 直打)+ 真 config.json。
 * 覆盖:默认值 / 往返 / 部分更新 / 非法 base 400 / 非数组与脏元素清洗 / 条数封顶 / 保存后立刻生效。
 *
 * 规则语义本体在 src/services/approvalCustom.test.ts;本文件钉的是「经过 HTTP 这一层之后还对不对」,
 * 以及最要紧的一条:**保存后不重启引擎就生效**(customRules() 每次现读)——UI 的整个前提。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import approvalsRouter from '../src/routes/approvals.js';
import { customRules, customVerdictDetailed } from '../src/services/approvals.js';
import type { ToolCall } from '../src/core/types.js';

let srv: Server;
let base: string;
let home: string;

const get = async (): Promise<any> => {
  const r = await fetch(`${base}/agent/approval-rules`, { headers: { Authorization: 'Bearer x' } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const put = async (body: any): Promise<any> => {
  const r = await fetch(`${base}/agent/approval-rules`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const call = (name: string, args: any = {}): ToolCall =>
  ({ id: 't1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-apvrules-'));
  process.env.TANGU_HOME = home; // config.json 落临时家目录,不碰真实配置
  // authMiddleware 要认 localToken → 必须先 configureTangu(否则一路 500)
  const { host } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  const app = express();
  app.use(express.json());
  app.use(approvalsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});

afterAll(() => {
  srv?.close();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GET /agent/approval-rules', () => {
  it('没配过 → 返回默认(base=auto-edit,三个空列表)', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ base: 'auto-edit', allow: [], ask: [], deny: [] });
  });
});

describe('PUT /agent/approval-rules', () => {
  it('往返:写进去的规则读得回来', async () => {
    const w = await put({ base: 'readonly', allow: ['web_fetch'], ask: ['run_bash:npm publish'], deny: ['write_file:/etc/'] });
    expect(w.status).toBe(200);
    expect(w.body.ok).toBe(true);
    const r = await get();
    expect(r.body).toEqual({ base: 'readonly', allow: ['web_fetch'], ask: ['run_bash:npm publish'], deny: ['write_file:/etc/'] });
  });

  it('部分更新:没给的字段保持原样(不会被当成清空)', async () => {
    await put({ base: 'auto-edit', allow: ['a'], ask: ['b'], deny: ['c'] });
    const w = await put({ ask: ['b2'] });
    expect(w.status).toBe(200);
    expect(w.body.rules).toEqual({ base: 'auto-edit', allow: ['a'], ask: ['b2'], deny: ['c'] });
  });

  it('显式传空数组 = 真清空(与「不传」区分开)', async () => {
    await put({ allow: ['x'] });
    const w = await put({ allow: [] });
    expect(w.body.rules.allow).toEqual([]);
  });

  it('非法 base → 400,且不写坏已有配置', async () => {
    await put({ base: 'auto-edit', allow: ['keep'] });
    const bad = await put({ base: 'custom' }); // custom 不能当 base(会自指)
    expect(bad.status).toBe(400);
    const r = await get();
    expect(r.body.base).toBe('auto-edit');
    expect(r.body.allow).toEqual(['keep']);
  });

  it('元素清洗:trim、丢空串、非字符串转字符串', async () => {
    const w = await put({ ask: ['  run_bash:ls  ', '', '   ', 42] });
    expect(w.body.rules.ask).toEqual(['run_bash:ls', '42']);
  });

  it('⚠️非数组 → 400,**不**静默当成清空(客户端一处 null 就会把 deny 名单悄悄清掉)', async () => {
    await put({ deny: ['write_file:/etc/'] });
    for (const bad of [{ deny: null }, { deny: 'write_file:/etc/' }, { allow: 42 }]) {
      const r = await put(bad);
      expect(r.status).toBe(400);
    }
    expect((await get()).body.deny).toEqual(['write_file:/etc/']); // 原样还在
  });

  it('单条超长截断到 500(customRules 每次工具调用都全文读+解析)', async () => {
    const w = await put({ allow: ['x'.repeat(2000)] });
    expect(w.body.rules.allow[0].length).toBe(500);
  });

  it('条数封顶 200(规则是人手写的,防误贴)', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `tool_${i}`);
    const w = await put({ allow: many });
    expect(w.body.rules.allow.length).toBe(200);
  });
});

describe('⚠️host-only 守卫(云端 microserver 照单挂 userRouter)', () => {
  it('hostExec:false 的形态下 GET/PUT 一律 404 —— 否则任何已登录的云端用户都能读写一个进程级全局配置', async () => {
    const { host } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createAiStudioProfile() });
    try {
      expect((await get()).status).toBe(404);
      expect((await put({ deny: ['x'] })).status).toBe(404);
    } finally {
      // 还回 host 形态,后面的用例照旧
      configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
    }
  });
});

describe('保存即生效(UI 的整个前提)', () => {
  it('PUT 之后不重启引擎,customRules/判定立刻用新规则', async () => {
    await put({ base: 'auto-edit', allow: [], ask: [], deny: ['run_bash:rm -rf'] });
    expect(customRules().deny).toEqual(['run_bash:rm -rf']);
    const v = customVerdictDetailed(call('run_bash', { command: 'rm -rf /tmp/x' }), customRules());
    expect(v).toEqual({ verdict: 'deny', rule: 'run_bash:rm -rf' });

    // 负对照:改成 allow 之后,同一个调用的判定必须跟着变(证明不是读到了缓存)
    await put({ deny: [], allow: ['run_bash:rm -rf'] });
    expect(customVerdictDetailed(call('run_bash', { command: 'rm -rf /tmp/x' }), customRules())?.verdict).toBe('allow');
  });
});
