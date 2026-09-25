/**
 * H1 控制面进闸(审批档重设计 2026-09-25 §3.4):agent 发起的「建出之后无人值守、以完全放行跑的工作」——
 * manage_automation 建 / 改 / 启用含 agent_run(或旧式 agent 简写)的规则、manage_schedule auto=true、manage_agent 建 / 改 ——
 * 在询问我批准 / 替我批准两档每次都要问,且**不进「总允许」**;完全放行照旧放过;custom 规则照旧先裁决。
 * 从前这三个工具在四档全部免批:只读档的会话一句话就能建出一条到点以 full-auto 跑的 agent 任务。
 *   ① 分类器逐项对齐各工具自己的参数口径(list/remove/停用/纯 notify/auto=false 免批);
 *   ② 闸门:两档都问、reason.kind='control'、「总允许」不缓存(对照:普通命令工具的总允许照旧缓存);
 *   ③ custom:deny / allow / ask 照旧优先;未命中按 base 档 → 控制面照问;
 *   ④ Muse 后台周期给自己排 auto 日程不算提权(回灌进它自己的周期,按它自己的档跑);给别人排照问;
 *   ⑤ 审批卡 preview 可读(旧客户端不认 kind='control',preview 是唯一载体);
 *   ⑥ 真 loop:只读档里模型要建「每天让 bot 跑日报」→ 弹 control 审批,拒绝后规则不存在,模型收到的是英文拒绝语。
 *   评审第二轮(2026-09-25):
 *   ⑦ 非 host 会话:本机 sandbox 会话看得见 manage_automation / manage_schedule(mode:'both'),从前闸门对非 host 一律放行 ——
 *      沙箱会话一句话建出到点以 host + full-auto 跑的工作。现在控制面不论档位都问(含 sandbox 缺省的 full-auto);
 *   ⑧ 停用不再是万能免批:停用的同时改写 agent_run 链 / 旧式 agent 照问(用户之后在面板一键启用,跑的是模型写的链);
 *   ⑨ Muse 代批档('agent')不替用户批控制面,一律排队;⑩ 审批卡写出保留的旧动作链、覆盖已有 agent 与生效的审批档。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
import {
  approvalPreview, controlPlaneCall, gateToolCall, resolveApproval, USER_REJECT_REASON,
  type ApprovalAction, type ApprovalMode,
} from '../src/services/approvals.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { loadTriggers, upsertTrigger } from '../src/services/museTriggers.js';
import { saveAgent, deleteAgent } from '../src/agents/agentRegistry.js';
import { validateTriggerInput } from '../src/services/museTriggers.js';
import { manageAutomationProvider } from '../src/tools/builtin/manageAutomation.js';
import { manageAgentProvider } from '../src/tools/builtin/manageAgent.js';
import { loadSchedule } from '../src/services/agentSchedule.js';

const USER = 'u1';
let home: string;
let ws: string;
let script: Array<() => any>;
/** 非流式补全(= 代批判官这类后台单发调用)的回复内容与调用次数。 */
let bgContent: string;
let bgCalls: number;

const call = (name: string, args: Record<string, unknown>): any =>
  ({ id: `c-${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

const AUTO_AGENT_RUN = {
  action: 'set', desc: 'Daily report', cond_type: 'daily_at', time: '09:00',
  actions: [{ type: 'agent_run', agentSlug: 'bot', prompt: 'write the daily report' }],
};
const AUTO_SCHEDULE = { action: 'set', name: 'news', date: '2030-01-01T09:00', repeat: '1d', auto: true, prompt: 'summarize news' };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-control-'));
  process.env.TANGU_HOME = home;
  ws = join(home, 'ws');
  mkdirSync(ws, { recursive: true });
  script = [];
  bgContent = 'bg';
  bgCalls = 0;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) { bgCalls++; return { content: bgContent, reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' }; }
        const step = script.shift();
        if (!step) throw new Error('脚本耗尽');
        return step();
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

/** 直接过闸:每条 approval_request 用 answer 应答,返回决定与收到的审批请求。 */
let gateSeq = 0;
async function gate(c: any, ctx: Record<string, unknown>, answer: ApprovalAction = 'reject'): Promise<{ d: any; asked: any[] }> {
  const runId = `G${++gateSeq}`;
  const asked: any[] = [];
  const off = subscribe(runId, (ev) => {
    if (ev.type !== 'approval_request') return;
    asked.push(ev.payload);
    resolveApproval(ev.payload.approvalId, { action: answer });
  });
  try {
    const d = await gateToolCall(runId, c, { sessionId: 'S', execMode: 'host', cwd: ws, ...ctx } as any);
    return { d, asked };
  } finally { off(); }
}

describe('① controlPlaneCall 分类', () => {
  it('manage_automation:含 agent_run / tool_call / 旧式 agent 简写的启用规则是控制面;其余免批', () => {
    const yes: Record<string, unknown>[] = [
      AUTO_AGENT_RUN,
      { action: 'set', desc: 'x', cond_type: 'every', interval: '2h', actions: [{ type: 'notify', title: 'hi' }, { type: 'tool_call', tool: 'run_bash' }] },
      { action: 'set', desc: 'x', cond_type: 'every', interval: '2h', agent: 'bot', prompt: 'go' }, // 旧式简写 = 单步 agent_run
      { action: 'set', desc: 'x', cond_type: 'every', interval: '2h', agent_slug: 'bot' },
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h' }, // 更新且省略 actions = 保留旧链 → 看不到,按最严
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: true },
      // ⑧ 停用的同时写入控制内容:用户之后一键启用,跑的是这次写进去的链 / prompt
      { ...AUTO_AGENT_RUN, enabled: false },
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false, agent: 'bot', prompt: 'model-authored' },
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false, actions: [{ type: 'tool_call', tool: 'run_bash' }] },
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false, actions: 'garbage' }, // 形状不对按最严
    ];
    const no: Record<string, unknown>[] = [
      { action: 'list' },
      { action: 'remove', id: 'w-1' },
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false }, // 纯停用:省略 actions = 保留旧链,不写入新内容
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false, actions: null },
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false, actions: [{ type: 'notify', title: 'hi' }] },
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false, agent: 'muse' },
      { action: 'set', desc: 'x', cond_type: 'at', datetime: '2030-01-01 09:00', actions: [{ type: 'notify', title: 'stretch' }] },
      { action: 'set', desc: 'x', cond_type: 'db_changed', path: 'T.db', event: 'row_added', actions: [{ type: 'db_row_add', path: 'L.db', cells: {} }] },
      { action: 'set', desc: 'x', cond_type: 'every', interval: '2h' }, // 新建、无动作无 agent = 唤醒 Muse(按 Muse 自己的档)
      { action: 'set', desc: 'x', cond_type: 'every', interval: '2h', agent: 'muse' }, // muse 归一为唤醒 Muse
      { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', actions: null }, // 显式清空
    ];
    for (const a of yes) expect(controlPlaneCall('manage_automation', a), JSON.stringify(a)).toBe(true);
    for (const a of no) expect(controlPlaneCall('manage_automation', a), JSON.stringify(a)).toBe(false);
  });

  it('manage_schedule:set + auto=true(含字符串 "true")是控制面;auto=false / list / remove 免批', () => {
    expect(controlPlaneCall('manage_schedule', AUTO_SCHEDULE)).toBe(true);
    expect(controlPlaneCall('manage_schedule', { ...AUTO_SCHEDULE, auto: 'true' })).toBe(true);
    expect(controlPlaneCall('manage_schedule', { ...AUTO_SCHEDULE, agent: 'bot' })).toBe(true);
    expect(controlPlaneCall('manage_schedule', { ...AUTO_SCHEDULE, auto: false })).toBe(false);
    expect(controlPlaneCall('manage_schedule', { ...AUTO_SCHEDULE, auto: undefined })).toBe(false);
    expect(controlPlaneCall('manage_schedule', { action: 'list' })).toBe(false);
    expect(controlPlaneCall('manage_schedule', { action: 'remove', id: 'r1' })).toBe(false);
  });

  it('manage_schedule:只有 Muse 后台周期给**自己**排的 auto 条目豁免;普通 run 以 muse 身份、或 Muse 给别人排都不豁免', () => {
    expect(controlPlaneCall('manage_schedule', AUTO_SCHEDULE, { agentSlug: 'muse', museCycle: true })).toBe(false);
    expect(controlPlaneCall('manage_schedule', { ...AUTO_SCHEDULE, agent: 'muse' }, { agentSlug: 'muse', museCycle: true })).toBe(false);
    expect(controlPlaneCall('manage_schedule', AUTO_SCHEDULE, { agentSlug: 'muse' })).toBe(true); // 请求体可控的 agentSlug 不算数
    expect(controlPlaneCall('manage_schedule', { ...AUTO_SCHEDULE, agent: 'muse' }, { agentSlug: 'xyra' })).toBe(true);
    expect(controlPlaneCall('manage_schedule', { ...AUTO_SCHEDULE, agent: 'bot' }, { agentSlug: 'muse', museCycle: true })).toBe(true);
  });

  it('manage_agent:create / update 是控制面;list / delete 免批;别的工具一律不是', () => {
    expect(controlPlaneCall('manage_agent', { action: 'create', name: 'A', system_prompt: 'p' })).toBe(true);
    expect(controlPlaneCall('manage_agent', { action: 'update', slug: 'a', name: 'A', system_prompt: 'p' })).toBe(true);
    expect(controlPlaneCall('manage_agent', { action: 'list' })).toBe(false);
    expect(controlPlaneCall('manage_agent', { action: 'delete', slug: 'a' })).toBe(false);
    expect(controlPlaneCall('write_file', { path: 'a' })).toBe(false);
    expect(controlPlaneCall('manage_automation', null)).toBe(false);
  });
});

describe('② 闸门:前两档必问、不吃「总允许」;完全放行放过', () => {
  it.each(['readonly', 'auto-edit'] as ApprovalMode[])('%s:manage_schedule auto=true 弹 control 审批', async (mode) => {
    const { d, asked } = await gate(call('manage_schedule', AUTO_SCHEDULE), { approvalMode: mode });
    expect(d).toEqual({ action: 'reject' });
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'control', mode }]);
  });

  it('manage_automation(agent_run)与 manage_agent create 同样弹 control', async () => {
    for (const c of [call('manage_automation', AUTO_AGENT_RUN), call('manage_agent', { action: 'create', name: 'A', system_prompt: 'p' })]) {
      const { asked } = await gate(c, { approvalMode: 'auto-edit' });
      expect(asked.map((x) => x.reason?.kind), c.function.name).toEqual(['control']);
    }
  });

  it('「总允许」只批这一次,下一条同类调用照问(对照:普通命令工具的总允许照旧缓存)', async () => {
    const ctx = { approvalMode: 'auto-edit', sessionId: 'S-always' }; // 「总允许」是进程内按会话记的,独占一个会话 id 免得串到别的用例
    const first = await gate(call('manage_schedule', AUTO_SCHEDULE), ctx, 'approve_always');
    expect(first.d.action).toBe('approve');
    const second = await gate(call('manage_schedule', AUTO_SCHEDULE), ctx, 'reject');
    expect(second.asked.length).toBe(1);
    expect(second.d.action).toBe('reject');
    // 对照组:同一会话里 run_bash 的总允许仍然生效 —— 证明上面不是因为这套台架根本缓存不住
    const b1 = await gate(call('run_bash', { command: 'npm test' }), ctx, 'approve_always');
    expect(b1.asked.length).toBe(1);
    const b2 = await gate(call('run_bash', { command: 'npm test' }), ctx, 'reject');
    expect(b2.asked).toEqual([]);
    expect(b2.d.action).toBe('approve');
  });

  it('完全放行:控制面不问', async () => {
    for (const c of [call('manage_schedule', AUTO_SCHEDULE), call('manage_automation', AUTO_AGENT_RUN), call('manage_agent', { action: 'update', slug: 'a', name: 'A', system_prompt: 'p' })]) {
      const { d, asked } = await gate(c, { approvalMode: 'full-auto' });
      expect(asked).toEqual([]);
      expect(d).toEqual({ action: 'approve' });
    }
  });

  it('只读档:查看 / 删除 / 停用 / 纯规划 / 纯提醒照旧免批', async () => {
    for (const c of [
      call('manage_schedule', { action: 'list' }), call('manage_schedule', { ...AUTO_SCHEDULE, auto: false }),
      call('manage_agent', { action: 'list' }), call('manage_agent', { action: 'delete', slug: 'a' }),
      call('manage_automation', { action: 'remove', id: 'w-1' }),
      call('manage_automation', { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false }),
      call('manage_automation', { action: 'set', desc: 'x', cond_type: 'at', datetime: '2030-01-01 09:00', actions: [{ type: 'notify', title: 'hi' }] }),
    ]) {
      const { d, asked } = await gate(c, { approvalMode: 'readonly' });
      expect(asked, c.function.arguments).toEqual([]);
      expect(d).toEqual({ action: 'approve' });
    }
  });
});

describe('③ custom 规则照旧先裁决', () => {
  const rules = (r: Record<string, unknown>): void => writeFileSync(join(home, 'config.json'), JSON.stringify({ approval: { base: 'auto-edit', ...r } }));

  it('deny 照拒、allow 照放(不再问)、未命中按 base 档 → 控制面照问、ask → custom-ask', async () => {
    rules({ deny: ['manage_schedule'], allow: ['manage_agent'], ask: ['manage_automation'] });
    const denied = await gate(call('manage_schedule', AUTO_SCHEDULE), { approvalMode: 'custom' });
    expect(denied.d).toEqual({ action: 'reject', rejectReason: 'Denied by approval rule: manage_schedule' });
    const allowed = await gate(call('manage_agent', { action: 'create', name: 'A', system_prompt: 'p' }), { approvalMode: 'custom' });
    expect(allowed).toEqual({ d: { action: 'approve' }, asked: [] });
    const asked = await gate(call('manage_automation', AUTO_AGENT_RUN), { approvalMode: 'custom' });
    expect(asked.asked.map((x) => x.reason)).toEqual([{ kind: 'custom-ask', rule: 'manage_automation', mode: 'auto-edit' }]);
    rules({});
    const base = await gate(call('manage_schedule', AUTO_SCHEDULE), { approvalMode: 'custom' });
    expect(base.asked.map((x) => x.reason)).toEqual([{ kind: 'control', mode: 'auto-edit' }]);
  });

  it('custom 的 base 是完全放行 → 控制面也放过', async () => {
    rules({ base: 'full-auto' });
    expect(await gate(call('manage_schedule', AUTO_SCHEDULE), { approvalMode: 'custom' })).toEqual({ d: { action: 'approve' }, asked: [] });
  });
});

describe('④ Muse 后台周期', () => {
  it('Muse(ask 档,排队审批)给自己排 auto 跟进 → 不排队、直接放;给别的 agent 排 → 进排队(不放行)', async () => {
    const own = await gate(call('manage_schedule', AUTO_SCHEDULE), { approvalMode: 'auto-edit', approvalDeferral: 'queue', agentSlug: 'muse', userId: USER });
    expect(own).toEqual({ d: { action: 'approve' }, asked: [] });
    const other = await gate(call('manage_schedule', { ...AUTO_SCHEDULE, agent: 'bot' }), { approvalMode: 'auto-edit', approvalDeferral: 'queue', agentSlug: 'muse', userId: USER });
    expect(other.d.action).toBe('reject'); // 排队 = 本轮不执行,等用户在收件箱批
    const [row] = await query<any[]>(`SELECT tool, reason FROM pending_approvals`);
    expect(row.tool).toBe('manage_schedule');
    expect(JSON.parse(row.reason)).toEqual({ kind: 'control', mode: 'auto-edit' });
  });
});

describe('⑤ preview 可读', () => {
  it('写清谁、什么时候、无人值守跑什么 —— 不是截断的 JSON', () => {
    const a = approvalPreview(call('manage_automation', AUTO_AGENT_RUN));
    expect(a).toBe('manage_automation set (new): "Daily report" · when daily_at 09:00 · agent_run "bot" unattended: write the daily report');
    const s = approvalPreview(call('manage_schedule', { ...AUTO_SCHEDULE, agent: 'bot' }));
    expect(s).toBe('manage_schedule set (new) for agent "bot": "news" @ 2030-01-01T09:00 every 1d · runs unattended when due: summarize news');
    const g = approvalPreview(call('manage_agent', { action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be terse', model: 'm1' }));
    expect(g).toBe('manage_agent update bot "Bot" · model → m1 · instructions: be terse');
    const legacy = approvalPreview(call('manage_automation', { action: 'set', id: 'w-1', desc: 'd', cond_type: 'every', interval: '2h' }));
    expect(legacy).toContain('(actions unchanged)');
    for (const p of [a, s, g]) expect(p).not.toMatch(/[{}]/);
  });
});

describe('⑥ 真 loop', () => {
  it('只读档里模型建「每天让 bot 跑日报」→ control 审批;拒绝后规则不存在,模型收到英文拒绝语', async () => {
    const asked: any[] = [];
    const results: Array<{ name: string; result: string }> = [];
    script = [
      () => ({ content: '', reasoning: '', toolCalls: [{ id: 'ma1', type: 'function', function: { name: 'manage_automation', arguments: JSON.stringify(AUTO_AGENT_RUN) } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' }),
      () => ({ content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' }),
    ];
    await createRun({
      id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
      input: { message: 'every day at 9 have bot write the daily report', userMessageId: 'U1', attachments: [], agentConfig: { execMode: 'host', cwd: ws, approvalMode: 'readonly' } },
    });
    const off = subscribe('R1', (ev) => {
      if (ev.type === 'tool_result') results.push({ name: String(ev.payload?.name), result: String(ev.payload?.result) });
      if (ev.type !== 'approval_request' || asked.some((x) => x.approvalId === ev.payload.approvalId)) return;
      asked.push(ev.payload);
      resolveApproval(ev.payload.approvalId, { action: 'reject' });
    });
    enqueueRun('S', 'R1');
    try {
      const t0 = Date.now();
      for (;;) {
        const r = await getRun('R1');
        if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); break; }
        if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
        await new Promise((res) => setTimeout(res, 25));
      }
    } finally { off(); }
    expect(asked.map((x) => [x.name, x.reason])).toEqual([['manage_automation', { kind: 'control', mode: 'readonly' }]]);
    expect(results.find((r) => r.name === 'manage_automation')?.result).toBe(USER_REJECT_REASON);
    expect(await loadTriggers()).toEqual([]);
    expect(existsSync(join(home, 'agents', 'muse', 'triggers.json'))).toBe(false);
  });
});

describe('⑦ 非 host 会话(本机 sandbox):控制面不论档位都问', () => {
  it.each([['readonly'], [undefined], ['full-auto']] as Array<[ApprovalMode | undefined]>)('sandbox · 档=%s:manage_schedule auto=true 弹 control', async (mode) => {
    const { d, asked } = await gate(call('manage_schedule', AUTO_SCHEDULE), { execMode: 'sandbox', approvalMode: mode });
    expect(d).toEqual({ action: 'reject' });
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'control', mode }]);
    expect(asked[0].preview).toContain('runs unattended when due');
  });

  it('sandbox:agent_run 自动化同样弹 control;「总允许」不缓存', async () => {
    const ctx = { execMode: 'sandbox', sessionId: 'S-sbx-always' };
    const first = await gate(call('manage_automation', AUTO_AGENT_RUN), ctx, 'approve_always');
    expect(first.asked.map((x) => x.reason?.kind)).toEqual(['control']);
    expect(first.d.action).toBe('approve');
    const second = await gate(call('manage_automation', AUTO_AGENT_RUN), ctx, 'reject');
    expect(second.asked.length).toBe(1);
  });

  it('sandbox · custom:用户的 deny 规则照拒', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ approval: { base: 'full-auto', deny: ['manage_schedule'] } }));
    const { d, asked } = await gate(call('manage_schedule', AUTO_SCHEDULE), { execMode: 'sandbox', approvalMode: 'custom' });
    expect(d).toEqual({ action: 'reject', rejectReason: 'Denied by approval rule: manage_schedule' });
    expect(asked).toEqual([]);
  });

  it('负对照:sandbox 的非控制面调用照旧直接放行(纯提醒 / 纯规划 / 写文件)', async () => {
    for (const c of [
      call('manage_automation', { action: 'set', desc: 'x', cond_type: 'at', datetime: '2030-01-01 09:00', actions: [{ type: 'notify', title: 'hi' }] }),
      call('manage_schedule', { ...AUTO_SCHEDULE, auto: false }),
      call('write_file', { path: '/etc/hosts', content: 'x' }),
    ]) {
      const { d, asked } = await gate(c, { execMode: 'sandbox', approvalMode: 'readonly' });
      expect(asked, c.function.arguments).toEqual([]);
      expect(d).toEqual({ action: 'approve' });
    }
  });

  it('负对照:云端形态(profile 无 hostExec)零影响 —— 不进闸、不发事件', async () => {
    const { d, asked } = await gate(call('manage_schedule', AUTO_SCHEDULE), {
      execMode: 'sandbox', approvalMode: 'readonly', profile: { capabilities: { hostExec: false } },
    });
    expect(asked).toEqual([]);
    expect(d).toEqual({ action: 'approve' });
  });

  it('真 loop:sandbox 会话(未设档 → 缺省 full-auto)里模型排 auto 日程 → control 审批;拒绝后模型收到英文拒绝语', async () => {
    const asked: any[] = [];
    const results: Array<{ name: string; result: string }> = [];
    script = [
      () => ({ content: '', reasoning: '', toolCalls: [{ id: 'ms1', type: 'function', function: { name: 'manage_schedule', arguments: JSON.stringify(AUTO_SCHEDULE) } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' }),
      () => ({ content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' }),
    ];
    await createRun({
      id: 'R-sbx', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A-sbx',
      input: { message: 'every morning at 9 summarize the news', userMessageId: 'U-sbx', attachments: [], agentConfig: { execMode: 'sandbox' } },
    });
    const off = subscribe('R-sbx', (ev) => {
      if (ev.type === 'tool_result') results.push({ name: String(ev.payload?.name), result: String(ev.payload?.result) });
      if (ev.type !== 'approval_request' || asked.some((x) => x.approvalId === ev.payload.approvalId)) return;
      asked.push(ev.payload);
      resolveApproval(ev.payload.approvalId, { action: 'reject' });
    });
    enqueueRun('S', 'R-sbx');
    try {
      const t0 = Date.now();
      for (;;) {
        const r = await getRun('R-sbx');
        if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); break; }
        if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
        await new Promise((res) => setTimeout(res, 25));
      }
    } finally { off(); }
    expect(asked.map((x) => [x.name, x.reason])).toEqual([['manage_schedule', { kind: 'control', mode: 'full-auto' }]]);
    expect(results.find((r) => r.name === 'manage_schedule')?.result).toBe(USER_REJECT_REASON);
    expect(await loadSchedule('xyra')).toBeFalsy();
  });
});

describe('⑧ 停用 × 改写动作链', () => {
  it('只读档:停用的同时换上新的 agent_run 链 → control;纯停用照旧免批', async () => {
    const rewrite = await gate(call('manage_automation', { ...AUTO_AGENT_RUN, id: 'w-1', enabled: false }), { approvalMode: 'readonly' });
    expect(rewrite.asked.map((x) => x.reason)).toEqual([{ kind: 'control', mode: 'readonly' }]);
    expect(rewrite.asked[0].preview).toContain('(disabled)');
    const pause = await gate(call('manage_automation', { action: 'set', id: 'w-1', desc: 'x', cond_type: 'every', interval: '2h', enabled: false }), { approvalMode: 'readonly' });
    expect(pause).toEqual({ d: { action: 'approve' }, asked: [] });
  });
});

describe('⑨ Muse 代批档不替用户批控制面', () => {
  const museCtx = { approvalMode: 'auto-edit', approvalDeferral: 'agent', agentSlug: 'muse', userId: USER };
  beforeEach(() => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ models: { background: 'm1' } })); // 判官要有模型可用
    bgContent = '{"approve":true,"reason":"looks fine"}'; // 判官被问到就放行 —— 控制面若还走判官,这条会被批掉
  });

  it('正对照:普通需批调用(run_bash)在代批档由判官当场放行 —— 证明这套台架里判官真的会批', async () => {
    const { d } = await gate(call('run_bash', { command: 'npm test' }), museCtx);
    expect(d).toEqual({ action: 'approve' });
    expect(bgCalls).toBe(1);
    const [row] = await query<any[]>(`SELECT status, decided_by FROM pending_approvals WHERE tool = 'run_bash'`);
    expect(row).toMatchObject({ status: 'approved', decided_by: 'agent' });
  });

  it('manage_agent update → 不问判官,排进收件箱等用户(reason.kind=control)', async () => {
    const { d, asked } = await gate(call('manage_agent', { action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'p', model: 'm9' }), museCtx);
    expect(asked).toEqual([]); // 无人值守:不发同步审批
    expect(d.action).toBe('reject'); // 排队 = 本轮不执行
    expect(bgCalls).toBe(0);
    const [row] = await query<any[]>(`SELECT status, decided_by, reason FROM pending_approvals WHERE tool = 'manage_agent'`);
    expect(row.status).toBe('pending');
    expect(row.decided_by).toBeNull();
    expect(JSON.parse(row.reason)).toEqual({ kind: 'control', mode: 'auto-edit' });
  });
});

describe('⑩ 审批卡写出闸门才读得到的事实', () => {
  const seedRule = async (extra: Record<string, unknown>): Promise<string> => {
    const v = validateTriggerInput({ desc: 'Daily report', cond_type: 'every', interval: '2h', enabled: false, ...extra } as any, { cwd: ws });
    if (!v.ok) throw new Error(v.error);
    const r = await upsertTrigger(v.value, undefined, { actor: 'user' });
    if (!r.ok) throw new Error(r.error);
    return r.trigger.id;
  };

  it('manage_automation 启用且省略 actions:写出保留的旧链,不再只是「(actions unchanged)」', async () => {
    const id = await seedRule({ actions: [{ type: 'agent_run', agentSlug: 'bot', prompt: 'write the daily report' }] });
    const { asked } = await gate(call('manage_automation', { action: 'set', id, desc: 'Daily report', cond_type: 'every', interval: '2h' }), { approvalMode: 'auto-edit' });
    expect(asked.map((x) => x.reason?.kind)).toEqual(['control']);
    expect(asked[0].preview).toContain('keeps existing actions: agent_run "bot" unattended: write the daily report');
    expect(asked[0].preview).not.toContain('(actions unchanged)');
  });

  it('旧规则没有动作链 → 写明是唤醒 Muse;找不到规则 → 退回「(actions unchanged)」', async () => {
    const id = await seedRule({});
    const legacy = await gate(call('manage_automation', { action: 'set', id, desc: 'd', cond_type: 'every', interval: '2h' }), { approvalMode: 'auto-edit' });
    expect(legacy.asked[0].preview).toMatch(/· wake Muse$/);
    const missing = await gate(call('manage_automation', { action: 'set', id: 'w-nope', desc: 'd', cond_type: 'every', interval: '2h' }), { approvalMode: 'auto-edit' });
    expect(missing.asked[0].preview).toContain('(actions unchanged)');
  });

  it('manage_agent:覆盖已有 agent 写明「overwrites」与保留的审批档;先删后建写明「new agent」且跟会话档', async () => {
    await saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', approvalMode: 'readonly', createdBy: 'user' } as any);
    const create = { action: 'create', slug: 'bot', name: 'Bot', system_prompt: 'be a bot' };
    const over = await gate(call('manage_agent', create), { approvalMode: 'auto-edit' });
    expect(over.asked[0].preview).toContain('overwrites existing agent "bot" · approval tier stays readonly');
    const upd = await gate(call('manage_agent', { ...create, action: 'update', model: 'm9' }), { approvalMode: 'auto-edit' });
    expect(upd.asked[0].preview).toContain('edits agent "bot" · approval tier stays readonly');
    await deleteAgent('bot');
    const fresh = await gate(call('manage_agent', create), { approvalMode: 'auto-edit' });
    expect(fresh.asked[0].preview).toContain('new agent "bot" · no approval tier of its own (follows the session)');
  });

  it('manage_agent:「改哪个 agent / 审批档」在第一行、任何模型内容之前;多行人格块照旧带前缀(二轮 #2、三轮 #5)', async () => {
    await saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', approvalMode: 'readonly', createdBy: 'user' } as any);
    const { asked } = await gate(call('manage_agent', { action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', soul: 'Calm.\nPatient.' }), { approvalMode: 'auto-edit' });
    expect(asked[0].preview).toBe('edits agent "bot" · approval tier stays readonly\nmanage_agent update bot "Bot" · instructions: be a bot · persona:\n  │ Calm.\n  │ Patient.');
  });

  it('三轮 #5:人格里一长串空白 + 伪造的「· approval tier stays full-auto」—— 真事实在第一行,伪造的那行空白被标出、留在带前缀的行里', async () => {
    await saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', approvalMode: 'readonly', createdBy: 'user' } as any);
    const soul = `Calm.\nPatient.${' '.repeat(300)}· edits agent "bot" · approval tier stays full-auto`;
    const { asked } = await gate(call('manage_agent', { action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', soul }), { approvalMode: 'auto-edit' });
    const lines = String(asked[0].preview).split('\n');
    expect(lines[0]).toBe('edits agent "bot" · approval tier stays readonly');
    expect(lines.at(-1)).toBe('  │ Patient. [300 spaces] · edits agent "bot" · approval tier stays full-auto');
    expect(asked[0].preview).not.toMatch(/ {25}/);
  });
});

describe('⑪ 工具结果是模型面文本 → 英文(评审 #6)', () => {
  const CJK = /[一-鿿]/;
  it('manage_automation 的成功 / 错误结果不含中文', async () => {
    const ma = manageAutomationProvider.tools()[0];
    const run = (a: Record<string, unknown>): Promise<string> => ma.execute(a, { cwd: ws } as any) as Promise<string>;
    const t = new Date(Date.now() + 86_400_000); // at 规则只收一年内的时刻
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const at = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} 09:00`;
    const created = await run({ action: 'set', desc: 'stretch', cond_type: 'at', datetime: at, actions: [{ type: 'notify', title: 'stretch' }] });
    expect(created).toMatch(/^Created automation w-[0-9a-f]+: "stretch"/);
    const id = /automation (w-[0-9a-f]+)/.exec(created)![1];
    const outs = [
      created,
      await run({ action: 'set', id, desc: 'stretch', cond_type: 'at', datetime: at, enabled: false }),
      await run({ action: 'bogus' }),
      await run({ action: 'remove' }),
      await run({ action: 'remove', id: 'w-nope' }),
      await run({ action: 'set', desc: 'x', cond_type: 'every', interval: '2h', agent: 'ghost' }),
      await run({ action: 'remove', id }),
    ];
    expect(outs[1]).toMatch(/^Updated automation .* \[disabled\]:/);
    expect(outs.at(-1)).toBe(`Removed rule ${id}.`);
    for (const o of outs) expect(o, o).not.toMatch(CJK);
  });

  it('manage_agent 的错误结果不含中文', async () => {
    const mg = manageAgentProvider.tools()[0];
    const run = (a: Record<string, unknown>): Promise<string> => mg.execute(a, {} as any) as Promise<string>;
    const outs = [
      await run({ action: 'delete' }),
      await run({ action: 'delete', slug: 'nobody' }),
      await run({ action: 'create', name: 'A' }),
      await run({ action: 'update', slug: 'nobody', name: 'N', system_prompt: 'p' }),
      await run({ action: 'bogus' }),
    ];
    for (const o of outs) expect(o, o).not.toMatch(CJK);
  });
});
