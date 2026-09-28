/**
 * 通道里回「批准」遇到受保护路径的审批(P1 · K3 §3.3 / U4,方案 §6.3):不兑现、保留待批、回双语说明;回「拒绝」照常取消。
 * 通道兑现带 by={via:'channel'}(另一端的卡据此写「经消息通道」)。团队成员的审批经团队 run 转发,payload.runId = 成员子 run:
 * 本机专属判定必须按**条目所属的 run** 查(按通道自己那条 run 查恒为 null → 批准就漏过去了)。
 * 受保护审批一上来就只请对方「拒绝」或去电脑上批,并**不退订**:电脑上批准后结果照样送回通道(评审 P2:以前在 approval_request 就退订,
 * 电脑上批了通道永远收不到结果,下一条消息还会去拒一个已兑现的 id);回「拒绝」/ 发新任务时先撤掉那次等待,结果不送两遍。
 * 负对照(实跑见红,记在 K3 交付报告):① 去掉 service.ts 批准分支里的 approvalLocalOnly 判断 → resolveApproval 收到 approve;
 *   ② localOnly 分支改回 close(false) → 「电脑上批准 → 结果送回通道」红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDriver } from './types.js';

const state = vi.hoisted(() => ({
  created: null as any,
  resolved: [] as any[],
  localOnly: new Map<string, string>(), // approvalId -> 所属 run('*' = 任意 run)
  /** 每次 subscribe 从队头取一条事件,微任务里**广播给该 run 的全部订阅者**(挂着没撤的等待也会收到 → 能测出「送两遍」)。 */
  script: [] as any[],
  listeners: new Map<string, Set<(event: any) => void>>(),
  sent: [] as string[],
}));
const emit = (runId: string, ev: any): void => { for (const l of [...(state.listeners.get(runId) ?? [])]) l(ev); };
const subscribers = (runId: string): number => state.listeners.get(runId)?.size ?? 0;

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM tangu_wechat_bindings')) {
      return [{ id: 'binding-1', user_id: 'user-1', channel: 'wechat', account_id: 'account-1', peer_id: 'peer-1', session_id: 'session-1', remote_approval_mode: 'auto-edit' }];
    }
    if (sql.includes('SELECT model_id, agent_config, project_path FROM chat_sessions')) return [{ model_id: 'model-1', agent_config: '{}', project_path: '/tmp/channel-workspace' }];
    return [];
  }),
}));
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ profile: { appId: 'tangu', defaultModelId: 'model-1' } }) }));
vi.mock('../services/runStore.js', () => ({ createRun: vi.fn(async (run: any) => { state.created = run; }) }));
vi.mock('../services/agentLoop.js', () => ({ abortRun: vi.fn(), enqueueRun: vi.fn() }));
vi.mock('../services/eventBus.js', () => ({
  subscribe: vi.fn((runId: string, listener: (event: any) => void) => {
    let set = state.listeners.get(runId);
    if (!set) state.listeners.set(runId, (set = new Set()));
    set.add(listener);
    const ev = state.script.shift();
    if (ev) queueMicrotask(() => { for (const l of [...(state.listeners.get(runId) ?? [])]) l(ev); });
    return () => { set!.delete(listener); };
  }),
}));
vi.mock('../services/approvals.js', () => ({
  resolveApproval: vi.fn((...a: any[]) => { state.resolved.push(a); return true; }),
  approvalLocalOnly: vi.fn((id: string, runId: string) => (state.localOnly.has(id) ? ['*', runId].includes(state.localOnly.get(id)!) : null)),
}));
vi.mock('../agents/agentRegistry.js', () => ({ readAgentsMeta: () => ({ defaultSlug: 'xyra' }), listAgents: vi.fn(async () => []), getAgent: vi.fn(async () => null) }));
vi.mock('../services/replySegment.js', () => ({ resolveReplySegment: () => ({ enabled: false }), splitMessage: (t: string) => [t], segmentDelayMs: () => 0 }));
vi.mock('../services/voiceMessage.js', () => ({ resolveVoiceMessage: () => ({ enabled: false, wechat: false, model: '' }), synthesizeVoiceWav: vi.fn(), VOICE_MESSAGE_PLUGIN_ID: 'voice-message' }));
vi.mock('../plugins/settingsStore.js', () => ({ setPluginEnabled: vi.fn(), setScopeSettings: vi.fn() }));
vi.mock('./config.js', () => ({
  channelSettings: () => ({ enabled: true, sessions: true, agentSlug: '', modelId: 'model-1', imageModelId: '', ttsModelId: '', ttsVoice: '', approvalMode: 'auto-edit', inboxForward: { enabled: false, senders: 'all' } }),
  channelWorkspaceDir: (kind: string) => `/tmp/${kind}`,
}));

import { ChannelService } from './service.js';

function service(): ChannelService {
  const driver: ChannelDriver = { kind: 'wechat', start: async () => {}, stop: () => {}, status: () => [], send: async (_a: string, _p: string, text: string) => { state.sent.push(text); return { ok: true }; } };
  return new ChannelService({ kind: 'wechat', driver, unboundHint: 'unbound', inboxDirName: 'wechat-inbox', sessionTitle: 'wechat' });
}
const inbound = (s: ChannelService, text: string) => s.handleInbound({ accountId: 'account-1', peerId: 'peer-1', text, messageId: `m-${text}` });

beforeEach(() => {
  state.created = null;
  state.resolved = [];
  state.localOnly.clear();
  state.script = [];
  state.listeners.clear();
  state.sent = [];
});
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const protectedAsk = (approvalId: string, extra: Record<string, unknown> = {}) => (
  { type: 'approval_request', payload: { approvalId, preview: '⚠ 受保护的配置 · write ~/.forsion/config.json', localOnly: true, ...extra } }
);

describe('通道批准 × 受保护审批', () => {
  it('团队成员子 run 的受保护审批:回「批准」不兑现、保留待批、回双语说明;再回「拒绝」→ 按 channel 来源拒绝', async () => {
    const s = service();
    state.localOnly.set('apv_prot', 'child-run'); // 条目属于成员子 run,不是通道起的那条
    // 团队转发 = {...成员子 run 的载荷, runId: 子 run}:localOnly 原样带过来
    state.script = [protectedAsk('apv_prot', { runId: 'child-run' }), { type: 'done', payload: { content: '已取消。' } }];
    const first = await inbound(s, '改一下配置');
    expect(first).toContain('只能在电脑上批准');
    expect(first).not.toContain('回复「批准」'); // 一上来就别邀请一个注定被拒的「批准」
    const approve = await inbound(s, '批准');
    expect(approve).toContain('只能在电脑上批准');
    expect(approve).toContain('can only be approved on the computer');
    expect(state.resolved).toEqual([]);
    const runId = state.created.id;
    expect(subscribers(runId)).toBe(1); // 受保护审批挂着时不退订
    // 回「拒绝」:先撤挂着的那次等待再重新订阅 —— 结果只作为这句的回复送一遍,不再经 driver.send 补发
    expect(await inbound(s, '拒绝')).toBe('已取消。');
    expect(state.resolved).toEqual([['apv_prot', { action: 'reject' }, undefined, { via: 'channel' }]]);
    await flush();
    expect(state.sent).toEqual([]);
    expect(subscribers(runId)).toBe(0);
  });

  it('受保护审批:回「批准」被拒 → 用户在电脑上批准 → run 的结果照样送回通道;下一条消息不再去拒已兑现的 id', async () => {
    const s = service();
    state.localOnly.set('apv_lo', '*');
    state.script = [protectedAsk('apv_lo')];
    expect(await inbound(s, '改一下配置')).toContain('can only be approved on the computer');
    const runId = state.created.id;
    expect(await inbound(s, '批准')).toContain('只能在电脑上批准');
    expect(state.resolved).toEqual([]);

    // 电脑上批准:引擎广播 approval_result(by=本机),run 接着跑
    emit(runId, { type: 'approval_result', payload: { approvalId: 'apv_lo', action: 'approve', by: { via: 'local' } } });
    // 旧 run 还在跑时对方又发一条:这是新任务,不是「放弃旧审批」—— 不去拒那个已兑现的 id
    state.script = [{ type: 'done', payload: { content: 'ok' } }];
    expect(await inbound(s, '再看看日志')).toBe('ok');
    expect(state.resolved).toEqual([]);
    // 旧 run 跑完:结果经挂着的等待送回通道
    emit(runId, { type: 'done', payload: { content: '配置已改好。' } });
    await flush();
    expect(state.sent).toEqual(['配置已改好。']);
    expect(subscribers(runId)).toBe(0);
  });

  it('电脑上批过的旧 run 在新 run 等「批准」时才跑完:只清自己的登记,新 run 的待批还在', async () => {
    const s = service();
    state.localOnly.set('apv_a', '*');
    state.script = [protectedAsk('apv_a')];
    await inbound(s, '改一下配置');
    const runA = state.created.id;
    emit(runA, { type: 'approval_result', payload: { approvalId: 'apv_a', action: 'approve', by: { via: 'local' } } });
    state.script = [{ type: 'approval_request', payload: { approvalId: 'apv_b', preview: '$ npm test' } }, { type: 'done', payload: { content: 'B 完成' } }];
    expect(await inbound(s, '顺便跑下测试')).toContain('回复「批准」执行');
    emit(runA, { type: 'done', payload: { content: 'A 完成' } });
    await flush();
    expect(state.sent).toEqual(['A 完成']);
    expect(await inbound(s, '批准')).toBe('B 完成');
    expect(state.resolved).toEqual([['apv_b', { action: 'approve' }, undefined, { via: 'channel' }]]);
  });

  it('受保护审批挂着时发新任务:按放弃拒掉旧审批并撤掉挂着的等待(旧 run 之后的结果不再推给通道)', async () => {
    const s = service();
    state.localOnly.set('apv_old', '*');
    state.script = [protectedAsk('apv_old')];
    await inbound(s, '改一下配置');
    const oldRun = state.created.id;
    state.script = [{ type: 'done', payload: { content: '新任务完成' } }];
    expect(await inbound(s, '换个事:列一下文件')).toBe('新任务完成');
    expect(state.resolved).toEqual([['apv_old', { action: 'reject' }, undefined, { via: 'channel' }]]);
    expect(subscribers(oldRun)).toBe(0);
    emit(oldRun, { type: 'done', payload: { content: '旧任务被拒后的收尾' } });
    await flush();
    expect(state.sent).toEqual([]);
  });

  it('受保护审批挂着时回「停止」:只回一句已停止,挂着的等待不再补发「任务已停止」', async () => {
    const s = service();
    state.localOnly.set('apv_stop', '*');
    state.script = [protectedAsk('apv_stop')];
    await inbound(s, '改一下配置');
    const runId = state.created.id;
    expect(await inbound(s, '停止')).toContain('已停止');
    emit(runId, { type: 'error', payload: { aborted: true } });
    await flush();
    expect(state.sent).toEqual([]);
    expect(subscribers(runId)).toBe(0);
  });

  it('普通审批:照旧邀请「批准」并在 approval_request 处退订;回「批准」照常兑现,by={via:channel}', async () => {
    const s = service();
    state.script = [{ type: 'approval_request', payload: { approvalId: 'apv_plain', preview: '$ npm test' } }, { type: 'done', payload: { content: '测试通过' } }];
    expect(await inbound(s, '跑测试')).toContain('回复「批准」执行');
    expect(subscribers(state.created.id)).toBe(0);
    expect(await inbound(s, 'ok')).toBe('测试通过');
    expect(state.resolved).toEqual([['apv_plain', { action: 'approve' }, undefined, { via: 'channel' }]]);
  });
});
