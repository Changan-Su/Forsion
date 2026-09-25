/**
 * 通道管线(service.ts)的行为回归 —— 事件总线可控,逐条钉住 09-25 修的四个缺陷:
 *   a. 审批档随设置同步到已有绑定(syncApprovalMode),run 按同步后的档跑
 *   b. 「停止」停掉该 peer 的在跑 + 排队 run(旧版只停排队那个)
 *   c. ask_user / exit_plan_mode 的 inquiry_request 转发到通道,下一条消息作答(序号 → 选项原文)
 *   d. 审批 10 分钟无人应答 → 按拒绝兑现(rejectReason 与用户拒绝区分)+ 通知 + 接着推结果
 * 外加:/stop 与裸「停止」同路、未知 /x 不转给模型、会话 thinkingLevel 带进 run、数字选模型。
 * 末尾「评审二轮」一组:卡片 FIFO(不丢、不覆盖)、代答 / 超时后的「已过期」口径、receive 不占轮询、
 * 通道停止时兑现审批、启动对齐只收紧、扫码带档同步全部绑定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDriver } from './types.js';

const state = vi.hoisted(() => {
  const listeners = new Map<string, Set<(ev: any) => void>>();
  return {
    listeners,
    emit(runId: string, type: string, payload: any = {}): void {
      for (const l of [...(listeners.get(runId) ?? [])]) l({ seq: 0, type, payload });
    },
    binding: null as any,
    session: null as any,
    settings: null as any,
    created: [] as any[],
    enqueued: [] as string[],
    aborted: [] as string[],
    approvals: [] as Array<[string, any]>,
    inquiries: [] as Array<[string, string]>,
    sql: [] as Array<[string, any[]]>,
    models: [] as any[],
  };
});

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    state.sql.push([sql, params]);
    if (sql.includes('UPDATE tangu_wechat_bindings SET remote_approval_mode')) {
      const hit = sql.includes('WHERE id = ?') ? state.binding.id === params[1] : state.binding.channel === params[1];
      if (hit) state.binding.remote_approval_mode = params[0];
      return [];
    }
    if (sql.includes('UPDATE tangu_wechat_bindings SET peer_id')) { state.binding.peer_id = params[0]; return []; }
    if (sql.includes('FROM tangu_wechat_bindings')) {
      if (sql.includes('AND peer_id = ?') && state.binding.peer_id !== params[2]) return [];
      return [{ ...state.binding }];
    }
    if (sql.includes('FROM chat_sessions')) return [{ ...state.session }];
    if (sql.startsWith('UPDATE chat_sessions SET model_id')) { state.session.model_id = params[0]; return []; }
    return [];
  }),
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({
    profile: { appId: 'tangu', defaultModelId: 'model-1', capabilities: { hostExec: true } },
    state: {
      autoCreateSession: async () => {},
      getAgentConfig: async () => state.session.agent_config,
      setAgentConfig: async (_id: string, json: string) => { state.session.agent_config = json; },
    },
  }),
}));
vi.mock('../services/runStore.js', () => ({ createRun: vi.fn(async (run: any) => { state.created.push(run); }) }));
vi.mock('../services/agentLoop.js', () => ({
  abortRun: vi.fn((runId: string) => { state.aborted.push(runId); }),
  enqueueRun: vi.fn((_sid: string, runId: string) => { state.enqueued.push(runId); }),
  sessionHasActiveRun: vi.fn(() => false),
}));
vi.mock('../services/eventBus.js', () => ({
  subscribe: vi.fn((runId: string, l: (ev: any) => void) => {
    let set = state.listeners.get(runId);
    if (!set) state.listeners.set(runId, (set = new Set()));
    set.add(l);
    return () => { set!.delete(l); };
  }),
}));
vi.mock('../services/approvals.js', () => ({ resolveApproval: vi.fn((id: string, d: any) => { state.approvals.push([id, d]); return true; }) }));
vi.mock('../services/inquiries.js', () => ({ resolveInquiry: vi.fn((id: string, a: string) => { state.inquiries.push([id, a]); return true; }) }));
vi.mock('../agents/agentRegistry.js', () => ({
  readAgentsMeta: () => ({ defaultSlug: 'xyra' }),
  listAgents: vi.fn(async () => []),
  getAgent: vi.fn(async () => null),
  agentCapOf: () => null,
  DEFAULT_MAX_ITERATIONS: 90,
}));
vi.mock('../services/modelCatalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelCatalog.js')>()),
  listModelCatalog: vi.fn(async () => ({ models: state.models })),
}));
vi.mock('../services/replySegment.js', () => ({ resolveReplySegment: () => ({ enabled: false }), splitMessage: (t: string) => [t], segmentDelayMs: () => 0 }));
vi.mock('../services/voiceMessage.js', () => ({ resolveVoiceMessage: () => ({ enabled: false, wechat: false, model: '' }), synthesizeVoiceWav: vi.fn(), VOICE_MESSAGE_PLUGIN_ID: 'voice-message' }));
vi.mock('../plugins/settingsStore.js', () => ({ setPluginEnabled: vi.fn(), setScopeSettings: vi.fn() }));
vi.mock('./config.js', () => ({
  channelSettings: () => state.settings,
  saveChannelSettings: vi.fn((_k: string, patch: any) => { Object.assign(state.settings, patch); return state.settings; }),
  channelWorkspaceDir: (kind: string) => `/tmp/${kind}`,
}));

import {
  APPROVAL_CHANNEL_STOPPED_REASON, APPROVAL_SUPERSEDED_REASON, APPROVAL_TIMEOUT_REASON, CHANNEL_APPROVAL_TIMEOUT_MS, ChannelService,
} from './service.js';

// receive() 的串行分派链比直接 handleInbound 多几跳微任务:多冲几轮。
const flush = async (): Promise<void> => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

let sent: string[];
function makeService(): ChannelService {
  const driver: ChannelDriver = {
    kind: 'wechat',
    start: async () => {},
    stop: () => {},
    status: () => [],
    send: vi.fn(async (_a: string, _p: string, text: string) => { sent.push(text); return { ok: true }; }),
  };
  return new ChannelService({ kind: 'wechat', driver, inboxDirName: 'wechat-inbox', sessionTitle: 'WeChat Remote' });
}
const inbound = (svc: ChannelService, text: string) => svc.handleInbound({ accountId: 'acc', peerId: 'peer', text, messageId: `m-${text}` });
const lastRunId = (): string => state.created[state.created.length - 1].id;

beforeEach(() => {
  state.listeners.clear();
  state.binding = { id: 'b1', user_id: 'u1', channel: 'wechat', account_id: 'acc', peer_id: 'peer', session_id: 's1', remote_approval_mode: 'auto-edit' };
  state.session = { model_id: 'model-1', title: 'WeChat Remote', agent_config: JSON.stringify({ agentSlug: 'xyra', thinkingLevel: 'high', maxIterations: 40 }), project_path: '/tmp/wechat' };
  state.settings = { enabled: true, sessions: true, agentSlug: '', modelId: 'model-1', imageModelId: '', ttsModelId: '', ttsVoice: '', approvalMode: 'auto-edit', inboxForward: { enabled: false, senders: 'all' }, locale: 'zh' };
  state.created = [];
  state.enqueued = [];
  state.aborted = [];
  state.approvals = [];
  state.inquiries = [];
  state.sql = [];
  state.models = [];
  sent = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('run 输入', () => {
  it('会话存的 thinkingLevel / maxIterations 原样进 run,审批档用绑定上的值', async () => {
    const svc = makeService();
    const p = inbound(svc, 'hello');
    await flush();
    state.emit(lastRunId(), 'done', { content: 'hi' });
    await expect(p).resolves.toBe('hi');
    expect(state.created[0].input.agentConfig).toMatchObject({ thinkingLevel: 'high', maxIterations: 40, approvalMode: 'auto-edit', execMode: 'host' });
  });
});

describe('a. 审批档同步', () => {
  it('syncApprovalMode 改本通道全部绑定(不动 updated_at),下一条消息按新档跑', async () => {
    const svc = makeService();
    await svc.syncApprovalMode('readonly');
    const upd = state.sql.find(([sql]) => sql.includes('SET remote_approval_mode'))!;
    expect(upd[0]).toMatch(/WHERE channel = \?$/);
    expect(upd[0]).not.toContain('updated_at');
    expect(upd[1]).toEqual(['readonly', 'wechat']);
    const p = inbound(svc, 'go');
    await flush();
    state.emit(lastRunId(), 'done', { content: 'ok' });
    await p;
    expect(state.created[0].input.agentConfig.approvalMode).toBe('readonly');
  });

  it('/approval 只读:显示绑定上的档,带参也不改', async () => {
    const svc = makeService();
    state.binding.remote_approval_mode = 'readonly';
    const out = await inbound(svc, '/approval full-auto');
    expect(out).toContain('询问我批准');
    expect(state.sql.some(([sql]) => sql.includes('SET remote_approval_mode'))).toBe(false);
  });
});

describe('b. 停止', () => {
  it('在跑 + 排队的 run 一起停,回复如实报数;停掉的 run 不再各回一句「任务已停止」', async () => {
    const svc = makeService();
    const p1 = inbound(svc, 'task one');
    await flush();
    const r1 = lastRunId();
    const p2 = inbound(svc, 'task two'); // 排在 r1 后面
    await flush();
    const r2 = lastRunId();
    expect(await inbound(svc, '停止')).toBe('已停止 2 个任务(含排队中的)。');
    expect(state.aborted.sort()).toEqual([r1, r2].sort());
    state.emit(r1, 'error', { aborted: true });
    state.emit(r2, 'error', { aborted: true });
    await expect(p1).resolves.toBe('');
    await expect(p2).resolves.toBe('');
    expect(await inbound(svc, '/stop')).toBe('当前没有正在运行的任务。');
  });

  it('/stop 与裸关键词同路(旧版落进未知命令)', async () => {
    const svc = makeService();
    void inbound(svc, 'long task');
    await flush();
    expect(await inbound(svc, '/stop')).toBe('已停止当前任务。');
    expect(state.aborted).toEqual([lastRunId()]);
  });
});

describe('c. 询问转发', () => {
  it('ask_user:问题 + 编号选项;回序号 → 选项原文兑现,接着等 run 结果', async () => {
    const svc = makeService();
    const p = inbound(svc, 'deploy it');
    await flush();
    const r = lastRunId();
    state.emit(r, 'inquiry_request', { inquiryId: 'inq-1', question: 'Which env?', options: ['staging', 'production'], allowFreeText: true });
    const card = await p;
    expect(card).toContain('Which env?');
    expect(card).toContain('2. production');
    const p2 = inbound(svc, '2');
    await flush();
    expect(state.inquiries).toEqual([['inq-1', 'production']]);
    state.emit(r, 'done', { content: 'deployed to production' });
    await expect(p2).resolves.toBe('deployed to production');
    expect(state.created).toHaveLength(1); // 答复没被当成新任务
  });

  it('自由文本照原样作答;命令在待答时照常执行、不消耗询问', async () => {
    const svc = makeService();
    const p = inbound(svc, 'x');
    await flush();
    state.emit(lastRunId(), 'inquiry_request', { inquiryId: 'inq-2', question: 'Name?', options: [], allowFreeText: true });
    await p;
    expect(await inbound(svc, '/status')).toContain('等你回答');
    void inbound(svc, 'call it Nova');
    await flush();
    expect(state.inquiries).toEqual([['inq-2', 'call it Nova']]);
  });

  it('计划审阅:附计划正文;序号映射回 wire 约定的原串(「需要修改」那项不列)', async () => {
    const svc = makeService();
    const p = inbound(svc, 'plan it');
    await flush();
    const r = lastRunId();
    const PLAN_OPTIONS = ['批准,自动开始执行', '批准,退出计划模式(手动开始)', '需要修改(在输入框写反馈)', '拒绝,保持计划模式'];
    state.emit(r, 'plan', { plan: '# Plan\n1. write tests' });
    state.emit(r, 'inquiry_request', { inquiryId: 'inq-3', question: 'ok?', options: PLAN_OPTIONS, allowFreeText: true, kind: 'plan' });
    const card = await p;
    expect(card).toContain('1. write tests');
    expect(card).toContain('3. 拒绝,保持计划模式');
    expect(card).not.toContain('需要修改');
    void inbound(svc, '3');
    await flush();
    expect(state.inquiries).toEqual([['inq-3', PLAN_OPTIONS[3]]]);
  });

  it('计划「批准,马上开始」:run 结束后代发执行消息(通道没有客户端替它发)', async () => {
    const svc = makeService();
    const p = inbound(svc, 'plan it');
    await flush();
    const r = lastRunId();
    state.emit(r, 'inquiry_request', { inquiryId: 'inq-4', question: 'ok?', options: ['a', 'b', 'c', 'd'], kind: 'plan' });
    await p;
    const p2 = inbound(svc, '1');
    await flush();
    expect(state.inquiries).toEqual([['inq-4', 'a']]);
    state.emit(r, 'plan_approved', { auto: true });
    state.emit(r, 'done', { content: 'plan saved' });
    await expect(p2).resolves.toBe('plan saved');
    await flush();
    expect(state.created).toHaveLength(2);
    expect(state.created[1].input.message).toBe('计划已批准,开始执行。');
  });
});

describe('d. 审批超时', () => {
  it('10 分钟无人应答 → 按超时原因拒绝 + 通知 + 结果接着推回来', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const p = inbound(svc, 'rm stuff');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-1', preview: 'run_bash rm -rf build' });
    const card = await p;
    expect(card).toContain('run_bash rm -rf build');
    expect(card).toContain('10 分钟');
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS - 1000);
    expect(state.approvals).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.approvals).toEqual([['apv-1', { action: 'reject', rejectReason: APPROVAL_TIMEOUT_REASON }]]);
    expect(sent.some((t) => t.includes('自动拒绝') && t.includes('rm -rf build'))).toBe(true);
    state.emit(r, 'done', { content: 'skipped the delete' });
    await flush();
    expect(sent).toContain('skipped the delete');
    // 已处理掉:迟到的「批准」答「已过期」,不兑现、也不当成内容是「批准」的新任务
    expect(await inbound(svc, '批准')).toBe('该请求已过期,或已在别处处理。');
    expect(state.approvals).toHaveLength(1);
    expect(state.created).toHaveLength(1);
  });

  it('用户在超时前回复 → 计时器作废(普通拒绝,不带超时原因)', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const p = inbound(svc, 'x');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-2', preview: 'write file' });
    await p;
    const p2 = inbound(svc, '拒绝');
    await flush();
    expect(state.approvals).toEqual([['apv-2', { action: 'reject' }]]);
    state.emit(r, 'done', { content: 'ok, not writing' });
    await expect(p2).resolves.toBe('ok, not writing');
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS * 2);
    expect(state.approvals).toHaveLength(1);
  });

  it('待批时发来新任务 → 旧审批按「被新消息取代」拒绝,计时器作废,旧 run 结果照样推回', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const p = inbound(svc, 'first');
    await flush();
    const r1 = lastRunId();
    state.emit(r1, 'approval_request', { approvalId: 'apv-3', preview: 'x' });
    await p;
    void inbound(svc, 'second thing');
    await flush();
    expect(state.approvals).toEqual([['apv-3', { action: 'reject', rejectReason: APPROVAL_SUPERSEDED_REASON }]]);
    state.emit(r1, 'done', { content: 'first finished' });
    await flush();
    expect(sent).toContain('first finished');
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS * 2);
    expect(state.approvals).toHaveLength(1);
  });

  it('桌面端代答了 → 通道收尾,不再超时拒绝,结果推回通道', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const p = inbound(svc, 'x');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-4', preview: 'x' });
    await p;
    state.emit(r, 'approval_result', { approvalId: 'apv-4', action: 'approve' });
    state.emit(r, 'done', { content: 'done via desktop' });
    await flush();
    expect(sent).toContain('done via desktop');
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS * 2);
    expect(state.approvals).toEqual([]);
  });
});

describe('run 在别处结束', () => {
  it('审批卡还挂着时 run 被桌面停掉 → 通道收到「任务已停止」;之后回「批准」答已过期', async () => {
    const svc = makeService();
    const p = inbound(svc, 'x');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-9', preview: 'x' });
    await p;
    state.emit(r, 'error', { aborted: true });
    await flush();
    expect(sent).toContain('任务已停止。');
    expect(await inbound(svc, '批准')).toBe('该请求已过期,或已在别处处理。');
    expect(state.approvals).toEqual([]);
    expect(state.created).toHaveLength(1);
    expect(await inbound(svc, '/status')).toContain('空闲');
  });

  it('计划在桌面端批准(马上开始)→ 通道不代发执行消息(桌面自己会发,两边都发就跑两遍)', async () => {
    const svc = makeService();
    const p = inbound(svc, 'plan it');
    await flush();
    const r = lastRunId();
    state.emit(r, 'inquiry_request', { inquiryId: 'inq-9', question: 'ok?', options: ['a', 'b', 'c', 'd'], kind: 'plan' });
    await p;
    state.emit(r, 'inquiry_result', { inquiryId: 'inq-9', answer: 'a' });
    state.emit(r, 'plan_approved', { auto: true });
    state.emit(r, 'done', { content: 'plan saved' });
    await flush();
    expect(sent).toContain('plan saved');
    expect(state.created).toHaveLength(1);
  });
});

describe('命令分发', () => {
  it('未知 /x 不创建 run', async () => {
    const svc = makeService();
    expect(await inbound(svc, '/frobnicate now')).toContain('/frobnicate');
    expect(state.created).toHaveLength(0);
  });

  it('/model 列出 → 纯数字选中写 chat_sessions.model_id;有待批时数字当新消息', async () => {
    state.models = [
      { id: 'model-1', name: 'Model One', provider: 'forsion', source: 'forsion', modelType: 'llm', contextWindow: 1, contextWindowSource: 'default', supportsVision: false, thinkingLevels: ['off', 'high'] },
      { id: 'model-2', name: 'Model Two', provider: 'forsion', source: 'forsion', modelType: 'llm', contextWindow: 1, contextWindowSource: 'default', supportsVision: false, thinkingLevels: ['off', 'high'] },
    ];
    const svc = makeService();
    expect(await inbound(svc, '/model')).toContain('2. Model Two');
    expect(await inbound(svc, '2')).toContain('Model Two');
    expect(state.session.model_id).toBe('model-2');
    expect(state.created).toHaveLength(0);
  });

  it('/think 写 agent_config.thinkingLevel(按键合并,不丢别的键)', async () => {
    const svc = makeService();
    await inbound(svc, '/think low');
    expect(JSON.parse(state.session.agent_config)).toMatchObject({ agentSlug: 'xyra', thinkingLevel: 'low', maxIterations: 40 });
  });

  it('英文 locale:管线文案整条英文', async () => {
    state.settings.locale = 'en';
    const svc = makeService();
    expect(await inbound(svc, '/stop')).toBe('No task is running right now.');
    state.settings.sessions = false;
    expect(await inbound(svc, 'hi')).toMatch(/^Channel sessions are turned off/);
  });
});

describe('评审二轮:卡片队列(每 peer 一条 FIFO,队首显示,答完 / 作废再出下一张)', () => {
  it('同一 run 上审批 + 询问同时到(并行子代理共用父 runId)→ 先显示审批;批准的回复就是下一张卡;都能答到', async () => {
    const svc = makeService();
    const p = inbound(svc, 'do both');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-1', preview: 'sub1: rm a' });
    state.emit(r, 'inquiry_request', { inquiryId: 'inq-1', question: 'Which dir?', options: ['a', 'b'] });
    const card = await p;
    expect(card).toContain('sub1: rm a');
    expect(card).not.toContain('Which dir?');
    const p2 = inbound(svc, '批准');
    await expect(p2).resolves.toContain('Which dir?');
    expect(state.approvals).toEqual([['apv-1', { action: 'approve' }]]);
    const p3 = inbound(svc, '2');
    await flush();
    expect(state.inquiries).toEqual([['inq-1', 'b']]);
    state.emit(r, 'done', { content: 'all done' });
    await expect(p3).resolves.toBe('all done');
    expect(state.created).toHaveLength(1);
  });

  it('没有回复出口时到的第二张审批卡照样登记;轮到它才显示、才起 10 分钟计时,超时照样兑现', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const p = inbound(svc, 'do both');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-1', preview: 'sub1: rm a' });
    state.emit(r, 'approval_request', { approvalId: 'apv-2', preview: 'sub2: rm b' });
    expect(await p).toContain('sub1: rm a');
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS - 60_000); // 第一张快到点才答
    const p2 = inbound(svc, '批准');
    const card2 = await p2;
    expect(card2).toContain('sub2: rm b');
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS - 1000); // 第二张从显示时起算,还没到
    expect(state.approvals).toEqual([['apv-1', { action: 'approve' }]]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.approvals).toEqual([['apv-1', { action: 'approve' }], ['apv-2', { action: 'reject', rejectReason: APPROVAL_TIMEOUT_REASON }]]);
    expect(sent.some((t) => t.includes('自动拒绝') && t.includes('sub2: rm b'))).toBe(true);
  });

  it('同一 peer 两个会话各有 run 在等审批(/new 后):后到的不覆盖先到的,逐张显示、各自兑现,两边结果都推回', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const pA = inbound(svc, 'task A');
    await flush();
    const rA = lastRunId();
    state.binding.session_id = 's2'; // 等价于 /new 之后连接到新会话
    const pB = inbound(svc, 'task B');
    await flush();
    const rB = lastRunId();
    state.emit(rA, 'approval_request', { approvalId: 'apv-A', preview: 'A: deploy' });
    state.emit(rB, 'approval_request', { approvalId: 'apv-B', preview: 'B: rm -rf' });
    expect(await pA).toContain('A: deploy');
    await expect(pB).resolves.toBe(''); // B 的卡排在后面:B 的出口摘下(不转 typing、不推「仍在执行」)
    expect(sent.some((t) => t.includes('B: rm -rf'))).toBe(false);
    const pv = inbound(svc, '批准');
    await flush();
    expect(state.approvals).toEqual([['apv-A', { action: 'approve' }]]);
    expect(sent.some((t) => t.includes('B: rm -rf'))).toBe(true); // A 的卡答掉后才显示 B 的
    const pr = inbound(svc, '拒绝');
    await flush();
    expect(state.approvals).toEqual([['apv-A', { action: 'approve' }], ['apv-B', { action: 'reject' }]]);
    state.emit(rA, 'done', { content: 'A finished' });
    state.emit(rB, 'done', { content: 'B skipped' });
    await expect(pv).resolves.toBe('A finished');
    await expect(pr).resolves.toBe('B skipped');
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS * 3);
    expect(state.approvals).toHaveLength(2); // 没有哪张被覆盖后留着超时
  });

  it('桌面端答掉审批后,迟到的「批准」答已过期,不落成一条内容是「批准」的新任务', async () => {
    const svc = makeService();
    const p = inbound(svc, 'x');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-d', preview: 'x' });
    await p;
    state.emit(r, 'approval_result', { approvalId: 'apv-d', action: 'approve' });
    expect(await inbound(svc, '批准')).toBe('该请求已过期,或已在别处处理。');
    expect(state.created).toHaveLength(1);
    expect(state.approvals).toEqual([]);
  });

  it('审批超时后模型接着问问题:回「yes」是答复,不被「已过期」标记截走', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const p = inbound(svc, 'rm stuff');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-t', preview: 'x' });
    await p;
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS + 1000);
    state.emit(r, 'inquiry_request', { inquiryId: 'inq-t', question: 'Retry with sudo?', options: ['yes', 'no'] });
    await flush();
    expect(sent.some((t) => t.includes('Retry with sudo?'))).toBe(true);
    void inbound(svc, 'yes');
    await flush();
    expect(state.inquiries).toEqual([['inq-t', 'yes']]);
  });
});

describe('评审二轮:receive 不占住驱动的轮询循环', () => {
  const msgOf = (text: string) => ({ accountId: 'acc', peerId: 'peer', text, messageId: `m-${text}` });

  it('立即回 \'\';结果经 send 推送', async () => {
    const svc = makeService();
    expect(await svc.receive(msgOf('hello'))).toBe('');
    await flush();
    state.emit(lastRunId(), 'done', { content: 'hi there' });
    await flush();
    expect(sent).toEqual(['hi there']);
  });

  it('任务在跑时的「停止」即刻生效,且串行链保证它排在建 run 之后', async () => {
    const svc = makeService();
    await svc.receive(msgOf('long task'));
    await svc.receive(msgOf('停止')); // 不等上一条分派完就发
    await flush();
    expect(state.created).toHaveLength(1);
    expect(state.aborted).toEqual([state.created[0].id]);
    expect(sent).toEqual(['已停止当前任务。']);
    state.emit(state.created[0].id, 'error', { aborted: true });
    await flush();
    expect(sent).toEqual(['已停止当前任务。']); // 停掉的 run 不再补一句「任务已停止」
  });

  it('两个不同 peer 同时给还没认主的绑定发消息:只认第一个(按账号串行认领,不因并行分派漏过 peer 隔离)', async () => {
    const svc = makeService();
    state.binding.peer_id = null;
    // 同一轮里先后到(驱动不再等上一条处理完):两条分派并行跑
    void svc.receive({ accountId: 'acc', peerId: 'peer-1', text: 'hi' });
    void svc.receive({ accountId: 'acc', peerId: 'peer-2', text: 'rm -rf ~' });
    await flush();
    expect(state.sql.filter(([sql]) => sql.includes('SET peer_id')).length).toBe(1);
    expect(state.binding.peer_id).toBe('peer-1');
    expect(state.created).toHaveLength(1);
    expect(state.created[0].input.source.openid).toBe('peer-1');
    expect(sent.some((t) => t.includes('尚未绑定'))).toBe(true);
  });
});

describe('评审二轮:通道停止 / 启动对齐 / 扫码带档', () => {
  it('releasePending:显示中与排队中的审批都按「通道已停止」拒绝,不留一个无人应答、也不再超时的审批', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const p = inbound(svc, 'x');
    await flush();
    const r = lastRunId();
    state.emit(r, 'approval_request', { approvalId: 'apv-s1', preview: 'x' });
    state.emit(r, 'approval_request', { approvalId: 'apv-s2', preview: 'y' });
    await p;
    svc.releasePending();
    const reason = { action: 'reject', rejectReason: APPROVAL_CHANNEL_STOPPED_REASON };
    expect(state.approvals).toEqual([['apv-s1', reason], ['apv-s2', reason]]);
    await vi.advanceTimersByTimeAsync(CHANNEL_APPROVAL_TIMEOUT_MS * 3);
    expect(state.approvals).toHaveLength(2);
  });

  it('syncApprovalMode(narrowOnly):比设置宽的绑定收紧,比设置严的不放宽', async () => {
    const svc = makeService();
    state.binding.remote_approval_mode = 'readonly';
    await svc.syncApprovalMode('auto-edit', { narrowOnly: true });
    expect(state.binding.remote_approval_mode).toBe('readonly');
    state.binding.remote_approval_mode = 'full-auto';
    await svc.syncApprovalMode('auto-edit', { narrowOnly: true });
    expect(state.binding.remote_approval_mode).toBe('auto-edit');
    await svc.syncApprovalMode('full-auto', { narrowOnly: true });
    expect(state.binding.remote_approval_mode).toBe('auto-edit');
  });

  it('bindAccount 带的审批档与设置不同 → 写回设置并同步本通道全部绑定', async () => {
    const svc = makeService();
    vi.spyOn(svc, 'createChannelSession').mockResolvedValue('s-new');
    await svc.bindAccount({ userId: 'u1', accountId: 'acc', approvalMode: 'readonly' });
    expect(state.settings.approvalMode).toBe('readonly');
    expect(state.binding.remote_approval_mode).toBe('readonly');
    expect(state.sql.some(([sql, params]) => /SET remote_approval_mode = \? WHERE channel = \?$/.test(sql) && params[0] === 'readonly')).toBe(true);
  });
});
