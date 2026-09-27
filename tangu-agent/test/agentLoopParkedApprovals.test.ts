/**
 * 挂起审批(审批托盘,09-27):托盘客户端的 run 里,要问用户的调用不再卡住整个 loop ——
 * 审批请求照发,模型先拿到「已挂起、别重试、先干别的」的占位结果;用户拍板后在迭代边界执行,
 * 结局以 <approval_update> user 行交回模型(落库,后续 run 回放看得到)。模型没别的可干就收尾,收尾闸门等拍板再唤醒。
 * 真内存 SQLite + 真 loop + 剧本 LLM,钉六件:
 *   ① 挂起后模型接着干别的(不等),收尾时等拍板;批准 → 按原参数执行,结局回灌,续跑收尾
 *   ② 模型还在干活时用户就批了 → 下一个迭代边界兑现(不必等到收尾)
 *   ③ 拒绝 → 不执行,回灌 [rejected]
 *   ④ 用户改了参数再批 → 按改过的执行,回灌里写明
 *   ⑤ 在等拍板时停止 → run aborted、调用不执行、登记表清空(事后点批准回 false/410)
 *   ⑥ 没握手的 run(TUI / 通道 / 老客户端)照旧阻塞:没拍板前模型拿不到下一轮
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { subscribe } from '../src/services/eventBus.js';
import { resolveApproval, type ApprovalDecision } from '../src/services/approvals.js';
import { enqueueRun, abortRun, APPROVAL_UPDATE_OPEN } from '../src/services/agentLoop.js';

// ⑧⑨ 用:路径带 prectx → PreToolUse 注入上下文;参数带 boom → 执行抛错。其余一律透传原实现(①–⑦ 不受影响)。
vi.mock('../src/hooks/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/hooks/index.js')>();
  return {
    ...orig,
    runHooks: async (event: any, input: any, ctx: any) => (event === 'PreToolUse' && JSON.stringify(input?.tool_input ?? '').includes('prectx')
      ? { additionalContext: ['PRECTX-MARK: this repo indents with tabs'], systemMessages: [], runs: [] }
      : orig.runHooks(event, input, ctx)),
  };
});
vi.mock('../src/tools/registry.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tools/registry.js')>();
  return {
    ...orig,
    executeTool: async (call: any, ctx: any) => (String(call?.function?.arguments ?? '').includes('boom')
      ? Promise.reject(new Error('remote link dropped'))
      : orig.executeTool(call, ctx)),
  };
});

const USER = 'u1';
let home: string;
let ws: string;
let outside: string;
let payloads: any[];
let script: Array<(o: any) => any>;
let runSeq = 0;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-parked-'));
  process.env.TANGU_HOME = home;
  ws = join(home, 'ws');
  outside = join(home, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  payloads = [];
  script = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      // 只有主循环带 onToken;Historian 起标题等后台调用不吃剧本
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        payloads.push(o.payload);
        const step = script.shift();
        if (!step) throw new Error(`剧本耗尽:第 ${payloads.length} 次 LLM 调用没有出招`);
        return step(o);
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const usage = { prompt_tokens: 10, completion_tokens: 10 };
/** 工作区外写(auto-edit 下必须问)。 */
const outsideWrite = (id: string, file: string, content = 'approved-write') => () => ({
  content: '', reasoning: '', finishReason: 'stop', usage,
  toolCalls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(outside, file), content }) } }],
});
/** 工作区内写(auto-edit 免批):「先干别的」。 */
const sideWrite = (id: string, file: string) => () => ({
  content: '', reasoning: '', finishReason: 'stop', usage,
  toolCalls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(ws, file), content: 'side' }) } }],
});
const finalStep = (content: string) => () => ({ content, reasoning: '', toolCalls: [], usage, finishReason: 'stop' });

const toolMsgs = (p: any): string[] => (p.messages as any[]).filter((m) => m.role === 'tool').map((m) => String(m.content));
const userMsgs = (p: any): string[] => (p.messages as any[]).filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

/** 起一个 run,返回收审批请求的句柄与「等终态」。tray=true 即 POST /agent/runs 带 approval_tray 的形状。 */
async function start(tray: boolean): Promise<{ runId: string; asked: any[]; nextApproval: () => Promise<any>; settled: () => Promise<any> }> {
  const runId = `R${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A${runSeq}`,
    input: {
      message: '干活', userMessageId: `U${runSeq}`, attachments: [], origin: 'client', client: 'desktop/2.12.0',
      agentConfig: { execMode: 'host', cwd: ws, approvalMode: 'auto-edit' },
      ...(tray ? { approvalTray: true } : {}),
    },
  });
  const asked: any[] = [];
  const waiters: Array<(p: any) => void> = [];
  const off = subscribe(runId, (ev) => {
    if (ev.type !== 'approval_request') return;
    asked.push(ev.payload);
    waiters.shift()?.(ev.payload);
  });
  let seen = 0;
  const nextApproval = (): Promise<any> => {
    const i = seen++;
    return asked[i] ? Promise.resolve(asked[i]) : new Promise((r) => waiters.push(r));
  };
  enqueueRun('S', runId);
  const settled = async (): Promise<any> => {
    const t0 = Date.now();
    try {
      for (;;) {
        const r = await getRun(runId);
        if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
        if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
        await new Promise((res) => setTimeout(res, 20));
      }
    } finally { off(); }
  };
  return { runId, asked, nextApproval, settled };
}
const decide = (payload: any, d: ApprovalDecision): boolean => resolveApproval(payload.approvalId, d);
/** 某个工具调用在 chat_messages 里落库的结果(重载 / 后续 run 回放读的就是它)。 */
const persistedResult = async (callId: string): Promise<any> => {
  const rows = await query<any[]>(`SELECT tool_results FROM chat_messages WHERE session_id = 'S' AND tool_results IS NOT NULL`);
  for (const row of rows) {
    const list = typeof row.tool_results === 'string' ? JSON.parse(row.tool_results) : row.tool_results;
    const hit = (list || []).find((t: any) => t?.tool_call_id === callId);
    if (hit) return hit;
  }
  return null;
};
const until = async (cond: () => boolean, what: string): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 10_000) throw new Error(`等不到:${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('挂起审批(托盘 run)', () => {
  it('① 挂起后先干别的、收尾时等拍板;批准 → 按原参数执行、结局回灌、续跑收尾', async () => {
    script = [
      outsideWrite('c-park', 'parked.txt'),
      sideWrite('c-side', 'side.txt'),
      finalStep('Side work done; waiting for your approval to write parked.txt.'),
      finalStep('All done.'),
    ];
    const r = await start(true);
    const req = await r.nextApproval();
    expect(req.toolCallId).toBe('c-park');
    // 没等拍板:模型第 2、3 轮照常拿到(占位结果在上下文里),工作区内的「别的活」已经写完
    await until(() => payloads.length >= 3, '第 3 轮 LLM(收尾)');
    expect(toolMsgs(payloads[1]).some((t) => t.includes("Waiting for the user's approval"))).toBe(true);
    expect(existsSync(join(ws, 'side.txt'))).toBe(true);
    expect(existsSync(join(outside, 'parked.txt'))).toBe(false);
    // 模型已收尾,run 仍在等(没被当作结束)
    await new Promise((res) => setTimeout(res, 150));
    expect(payloads.length).toBe(3);
    expect((await getRun(r.runId))?.status).toBe('running');

    expect(decide(req, { action: 'approve' })).toBe(true);
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(readFileSync(join(outside, 'parked.txt'), 'utf8')).toBe('approved-write');
    expect(payloads.length).toBe(4);
    const update = userMsgs(payloads[3]).find((t) => t.startsWith(APPROVAL_UPDATE_OPEN));
    expect(update).toBeTruthy();
    expect(update).toContain('[approved] write_file (call c-park)');
    // 真结果回到 c-park 的**工具消息原位**(模型面仍是工具数据),占位不再在上下文里
    const parkMsg = (payloads[3].messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === 'c-park')
    expect(String(parkMsg?.content)).not.toContain("Waiting for the user's approval");
    // ⚠️ 回灌(user 消息)里绝不带工具输出:输出是不可信数据,拼进 user 消息 = 给它用户的身份(Codex 09-27 P1)
    expect(update).not.toContain(String(parkMsg?.content).trim().slice(0, 40));
    // 结局落库(后续 run 回放要看得到),且只落一条;挂起调用所在段的落库结果也是真结果
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'user'`);
    expect(rows.filter((x) => String(x.content).startsWith(APPROVAL_UPDATE_OPEN))).toHaveLength(1);
    const saved = await persistedResult('c-park');
    expect(saved?.parked).toBeFalsy();
    expect(saved?.content).toBe(parkMsg?.content);
  }, 20_000);

  it('⑦ 同一段挂起两张、先后拍板:第二张兑现时那一段已落库 → 按同一 id 重写,两张都落成真结果', async () => {
    script = [
      () => ({
        content: '', reasoning: '', finishReason: 'stop', usage,
        toolCalls: [
          { id: 'c-a', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(outside, 'a.txt'), content: 'A' }) } },
          { id: 'c-b', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(outside, 'b.txt'), content: 'B' }) } },
        ],
      }),
      finalStep('Waiting for both.'),
      finalStep('A is done, still waiting for B.'),
      finalStep('Both done.'),
    ];
    const r = await start(true);
    const ra = await r.nextApproval();
    const rb = await r.nextApproval();
    await until(() => payloads.length >= 2, '收尾轮');
    decide(ra, { action: 'approve' });
    await until(() => payloads.length >= 3, '批完 A 之后的一轮');
    expect((await persistedResult('c-a'))?.parked).toBeFalsy();
    expect((await persistedResult('c-b'))?.parked).toBe(true);
    decide(rb, { action: 'approve' });
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(outside, 'b.txt'), 'utf8')).toBe('B');
    expect((await persistedResult('c-a'))?.parked).toBeFalsy();
    expect((await persistedResult('c-b'))?.parked).toBeFalsy();
    expect(String((await persistedResult('c-b'))?.content)).not.toContain("Waiting for the user's approval");
  }, 20_000);

  it('② 模型还在干活时就批了 → 下一个迭代边界兑现,不等收尾', async () => {
    let req: any;
    script = [
      outsideWrite('c-park', 'mid.txt'),
      // 第 2 轮出招的同时用户点了批准:这一轮的工具跑完,下一轮之前就该兑现
      () => { decide(req, { action: 'approve' }); return sideWrite('c-side', 'side.txt')(); },
      finalStep('Done.'),
    ];
    const r = await start(true);
    req = await r.nextApproval();
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(payloads.length).toBe(3);
    expect(userMsgs(payloads[2]).some((t) => t.startsWith(APPROVAL_UPDATE_OPEN) && t.includes('[approved] write_file (call c-park)'))).toBe(true);
    expect(existsSync(join(outside, 'mid.txt'))).toBe(true);
  }, 20_000);

  it('③ 拒绝 → 不执行,回灌 [rejected]', async () => {
    script = [outsideWrite('c-park', 'nope.txt'), finalStep('Waiting.'), finalStep('Understood.')];
    const r = await start(true);
    const req = await r.nextApproval();
    await until(() => payloads.length >= 2, '收尾轮');
    decide(req, { action: 'reject' });
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(existsSync(join(outside, 'nope.txt'))).toBe(false);
    expect(userMsgs(payloads[2]).some((t) => t.includes('[rejected] write_file (call c-park)') && t.includes('NOT run'))).toBe(true);
    expect(toolMsgs(payloads[2]).some((t) => t.includes("Waiting for the user's approval"))).toBe(false);
    expect(await persistedResult('c-park')).toMatchObject({ isError: true });
  }, 20_000);

  it('④ 用户改了参数再批 → 按改过的执行,回灌写明', async () => {
    script = [outsideWrite('c-park', 'edit.txt', 'original'), finalStep('Waiting.'), finalStep('Ok.')];
    const r = await start(true);
    const req = await r.nextApproval();
    await until(() => payloads.length >= 2, '收尾轮');
    decide(req, { action: 'approve', argsOverride: { path: join(outside, 'edit.txt'), content: 'edited-by-user' } });
    // 改参后按新参数重闸(fix/approval-run-binding):越界写照新参数再问一次 —— 挂起路径上这张要**当场**弹出来,
    // 重闸若也挂起,凭条就没人兑现,run 永远停在收尾闸门(合并 main 时栽过)。
    const again = await r.nextApproval();
    expect(again.approvalId).not.toBe(req.approvalId);
    await new Promise((res) => setTimeout(res, 150));
    expect(existsSync(join(outside, 'edit.txt'))).toBe(false); // 重闸若挂起,凭条会不等这张就放行 —— 这里就先写了
    decide(again, { action: 'approve' });
    await r.settled();
    expect(readFileSync(join(outside, 'edit.txt'), 'utf8')).toBe('edited-by-user');
    expect(userMsgs(payloads[2]).some((t) => t.includes('edited the arguments') && t.includes('edited-by-user'))).toBe(true);
  }, 20_000);

  it('⑤ 等拍板时停止 → aborted、不执行、登记表清空', async () => {
    script = [outsideWrite('c-park', 'aborted.txt'), finalStep('Waiting.')];
    const r = await start(true);
    const req = await r.nextApproval();
    await until(() => payloads.length >= 2, '收尾轮');
    abortRun(r.runId);
    const run = await r.settled();
    expect(run.status).toBe('aborted');
    expect(decide(req, { action: 'approve' })).toBe(false);
    await new Promise((res) => setTimeout(res, 100));
    expect(existsSync(join(outside, 'aborted.txt'))).toBe(false);
  }, 20_000);

  it('⑥ 没握手的 run 照旧阻塞:没拍板前拿不到下一轮,批了之后拿到的是真结果', async () => {
    script = [outsideWrite('c-block', 'block.txt'), finalStep('Done.')];
    const r = await start(false);
    const req = await r.nextApproval();
    await new Promise((res) => setTimeout(res, 150));
    expect(payloads.length).toBe(1);
    decide(req, { action: 'approve' });
    await r.settled();
    expect(payloads.length).toBe(2);
    expect(toolMsgs(payloads[1]).some((t) => t.includes("Waiting for the user's approval"))).toBe(false);
    expect(existsSync(join(outside, 'block.txt'))).toBe(true);
  }, 20_000);

  it('⑧ PreToolUse 注入的上下文:占位里有,兑现后写回的真结果里也还在(不随原位替换丢掉)', async () => {
    script = [outsideWrite('c-ctx', 'prectx.txt'), finalStep('Waiting for approval.'), finalStep('Done.')];
    const r = await start(true);
    const req = await r.nextApproval();
    await until(() => payloads.length >= 2, '收尾轮');
    expect(toolMsgs(payloads[1]).find((t) => t.includes("Waiting for the user's approval"))).toContain('PRECTX-MARK');
    decide(req, { action: 'approve' });
    expect((await r.settled()).status).toBe('done');
    const msg = (payloads[2].messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === 'c-ctx');
    expect(String(msg?.content)).not.toContain("Waiting for the user's approval");
    expect(String(msg?.content)).toContain('PRECTX-MARK');
  }, 20_000);

  it('⑨ 批准后执行中途抛错 → 不说「执行失败」,而说「可能已生效、先核查再重试」(防模型重试把副作用做两遍)', async () => {
    script = [outsideWrite('c-boom', 'boom.txt'), finalStep('Waiting for approval.'), finalStep('Will verify first.')];
    const r = await start(true);
    const req = await r.nextApproval();
    await until(() => payloads.length >= 2, '收尾轮');
    decide(req, { action: 'approve' });
    expect((await r.settled()).status).toBe('done');
    const update = userMsgs(payloads[2]).find((t) => t.startsWith(APPROVAL_UPDATE_OPEN));
    expect(update).toContain('[failed] write_file (call c-boom)');
    expect(update).toContain('may already have taken effect');
    expect(update).not.toContain('It ran and failed');
    const msg = (payloads[2].messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === 'c-boom');
    expect(String(msg?.content)).toContain('remote link dropped');
    expect(String(msg?.content)).toContain('Check the current state before retrying');
  }, 20_000);
});
