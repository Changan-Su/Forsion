/** 计划审阅答案解析:修订全文只在头部逐字等于已知批准选项时才认。 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 工具 execute 走 requestInquiry → publish → deps().state.appendEvent;计划批准走 get/setAgentConfig。
const state = vi.hoisted(() => ({
  events: [] as Array<{ runId: string; type: string; payload: any }>,
  agentConfig: '{"planMode":true}' as string,
  setConfigCalls: [] as string[],
}));
vi.mock('../../seams/runtime.js', () => ({
  deps: () => ({
    state: {
      appendEvent: async (runId: string, type: string, payload: any) => { state.events.push({ runId, type, payload }); return state.events.length; },
      getAgentConfig: async () => state.agentConfig,
      setAgentConfig: async (_sid: string, cfg: string) => { state.setConfigCalls.push(cfg); state.agentConfig = cfg; },
    },
  }),
}));

import {
  parsePlanAnswer,
  PLAN_REVISION_MARK,
  interactionProvider,
  formatInquiryResult,
  SYSTEM_ANSWER_PREFIX,
  INQUIRY_RUN_STOPPED_NOTE,
  INQUIRY_CHANNEL_STOPPED_ANSWER,
  isSystemAnswer,
} from './interaction.js';
import { resolveInquiry } from '../../services/inquiries.js';
// 先经 hub 进入 channels 模块环(生产里也是 hub 先载入):直接从 service.js 进会在环里撞上未定义的 ChannelService。
import '../../channels/hub.js';
import { INQUIRY_CHANNEL_STOPPED_ANSWER as SERVICE_CHANNEL_STOPPED_ANSWER } from '../../channels/service.js';

const APPROVE_AUTO = '批准,自动开始执行';
const APPROVE_MANUAL = '批准,退出计划模式(手动开始)';

describe('parsePlanAnswer', () => {
  it('批准(自动/手动)与打回', () => {
    expect(parsePlanAnswer(APPROVE_AUTO)).toMatchObject({ approved: true, autoStart: true, revised: undefined });
    expect(parsePlanAnswer(APPROVE_MANUAL)).toMatchObject({ approved: true, autoStart: false });
    const back = parsePlanAnswer('第 3 步换成先写测试');
    expect(back.approved).toBe(false);
    expect(back.raw).toBe('第 3 步换成先写测试'); // 反馈原文要完整回给模型
  });

  it('编辑后批准:取修订全文,头部仍是原样的批准选项', () => {
    const r = parsePlanAnswer(`${APPROVE_AUTO}${PLAN_REVISION_MARK}# 计划\n1. 先写测试`);
    expect(r).toMatchObject({ approved: true, autoStart: true, revised: '# 计划\n1. 先写测试' });
  });

  it('自由文本里恰好含标记 → 不当修订,整串回给模型', () => {
    const r = parsePlanAnswer(`别按这个来${PLAN_REVISION_MARK}随便写的`);
    expect(r.approved).toBe(false);
    expect(r.revised).toBeUndefined();
    expect(r.raw).toContain('随便写的');
  });

  it('自由文本批准只认「就这一个词」(兼容 TUI 打字)', () => {
    expect(parsePlanAnswer('批准').approved).toBe(true);
    expect(parsePlanAnswer('同意').approved).toBe(true);
    expect(parsePlanAnswer('ok').approved).toBe(true);
  });

  it('⚠️否定式反馈绝不能被当成批准(前缀/子串判会栽在这)', () => {
    for (const s of ['批准前先补上回滚方案', '批准不了,先说清楚迁移', '不批准', '批准这个之前请自动开始跑测试?不行']) {
      const r = parsePlanAnswer(s);
      expect(r.approved, s).toBe(false);
      expect(r.autoStart, s).toBe(false);
      expect(r.raw).toBe(s); // 反馈原文完整回给模型
    }
  });

  it('自动开始只认那一串逐字命中', () => {
    expect(parsePlanAnswer(APPROVE_AUTO).autoStart).toBe(true);
    expect(parsePlanAnswer(APPROVE_MANUAL).autoStart).toBe(false);
    expect(parsePlanAnswer('批准').autoStart).toBe(false);
  });

  it('非批准头部带标记 → 不当修订,整串(含标记后的正文)回给模型', () => {
    const s = `需要修改(在输入框写反馈)${PLAN_REVISION_MARK}第三步换成先写测试`;
    const r = parsePlanAnswer(s);
    expect(r.approved).toBe(false);
    expect(r.revised).toBeUndefined();
    expect(r.raw).toContain('第三步换成先写测试');
  });

  it('标记后为空 → 按无修订处理', () => {
    const r = parsePlanAnswer(`${APPROVE_MANUAL}${PLAN_REVISION_MARK}   `);
    expect(r.approved).toBe(true);
    expect(r.revised).toBeUndefined();
  });

  it('系统代答(通道停止 / run 中止)一律不算批准', () => {
    expect(parsePlanAnswer(SERVICE_CHANNEL_STOPPED_ANSWER).approved).toBe(false);
    expect(parsePlanAnswer(INQUIRY_RUN_STOPPED_NOTE).approved).toBe(false);
  });
});

// ── 回给模型的询问结果:英文;系统代答不冒充「用户回答」 ──

const CJK = /[㐀-鿿＀-￯　-〿]/;
/** 去掉回显的用户答复 / 计划正文后,剩下的是工具自己写给模型的文字:必须没有中文。 */
function ownText(result: string, ...echoed: string[]): string {
  let s = result;
  for (const e of echoed) s = s.split(e).join('');
  return s;
}

const tool = (name: string) => interactionProvider.tools().find((t) => t.name === name)!;
let seq = 0;

/** 起一次工具调用,等它登记询问后用 answer 兑现,返回工具结果。 */
async function runWithAnswer(name: string, args: Record<string, any>, answer: string, extra: Record<string, any> = {}): Promise<string> {
  const runId = `run-${++seq}`;
  const p = Promise.resolve(tool(name).execute(args, { runId, sessionId: `s-${seq}`, ...extra } as any));
  let inq: any;
  for (let i = 0; i < 50 && !inq; i++) {
    await new Promise((r) => setTimeout(r, 0));
    inq = state.events.find((e) => e.runId === runId && e.type === 'inquiry_request');
  }
  expect(inq, 'inquiry_request 应已登记').toBeTruthy();
  expect(resolveInquiry(inq.payload.inquiryId, answer)).toBe(true);
  return p;
}

const tmpDirs: string[] = [];
async function tmpDir(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

beforeEach(() => {
  state.events.length = 0;
  state.setConfigCalls.length = 0;
  state.agentConfig = '{"planMode":true}';
});

describe('ask_user 的工具结果(给模型,英文)', () => {
  it('用户答复:英文标签 + 原文照录', async () => {
    const answer = '用方案 A,先别动数据库';
    const r = await runWithAnswer('ask_user', { question: 'Which approach?', options: ['A', 'B'] }, answer);
    expect(r).toBe(`User answered: ${answer}`);
    expect(ownText(r, answer)).not.toMatch(CJK);
  });

  it('通道停止的兜底答复([No answer] 开头)原样交回,不贴「User answered」', async () => {
    expect(SERVICE_CHANNEL_STOPPED_ANSWER.startsWith(SYSTEM_ANSWER_PREFIX)).toBe(true); // 与 channels/service.ts 的约定绑死
    const r = await runWithAnswer('ask_user', { question: 'Continue?' }, SERVICE_CHANNEL_STOPPED_ANSWER);
    expect(r).toBe(SERVICE_CHANNEL_STOPPED_ANSWER);
    expect(r).not.toMatch(/^User answered|用户回答/);
  });

  it('钉子:channels/service.ts 真正兑现的通道兜底答复被认作系统代答(两份字面量漂移即红)', () => {
    expect(SERVICE_CHANNEL_STOPPED_ANSWER).toBe(INQUIRY_CHANNEL_STOPPED_ANSWER);
    expect(isSystemAnswer(SERVICE_CHANNEL_STOPPED_ANSWER)).toBe(true);
    expect(formatInquiryResult(SERVICE_CHANNEL_STOPPED_ANSWER)).toBe(SERVICE_CHANNEL_STOPPED_ANSWER);
    expect(isSystemAnswer(INQUIRY_RUN_STOPPED_NOTE)).toBe(true);
  });

  it('只认逐字的系统说明:用户自己打出 [No answer] 开头 → 仍是用户答复,照样贴标签', () => {
    const typed = `${SYSTEM_ANSWER_PREFIX} whatever`;
    expect(isSystemAnswer(typed)).toBe(false);
    expect(formatInquiryResult(typed)).toBe(`User answered: ${typed}`);
    expect(isSystemAnswer(`${INQUIRY_RUN_STOPPED_NOTE} `)).toBe(false); // 多一个空格也不算
    expect(formatInquiryResult('yes')).toBe('User answered: yes');
  });

  it('ask_user:用户打出 [No answer] 开头的答复 → 贴「User answered」', async () => {
    const typed = `${SYSTEM_ANSWER_PREFIX} I don't know yet`;
    const r = await runWithAnswer('ask_user', { question: 'Q?' }, typed);
    expect(r).toBe(`User answered: ${typed}`);
  });

  it('run 中止:真 requestInquiry 的中止答复换成英文系统说明,不说成用户回答了', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await tool('ask_user').execute({ question: 'Proceed?' }, { runId: 'run-abort', sessionId: 's', signal: ac.signal } as any);
    expect(r).toBe(INQUIRY_RUN_STOPPED_NOTE);
    expect(r.startsWith(SYSTEM_ANSWER_PREFIX)).toBe(true);
    expect(r).not.toMatch(CJK);
  });

  it('等待中被中止同理', async () => {
    const ac = new AbortController();
    const p = Promise.resolve(tool('ask_user').execute({ question: 'Proceed?' }, { runId: 'run-abort2', sessionId: 's', signal: ac.signal } as any));
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    const r = await p;
    expect(r).toBe(INQUIRY_RUN_STOPPED_NOTE);
    expect(r).not.toMatch(CJK);
  });

  it('用户恰好打出与中止字面量相同的字(run 没中止)→ 仍按用户答复', async () => {
    const r = await runWithAnswer('ask_user', { question: 'Q?' }, '(用户中止了运行)');
    expect(r).toBe('User answered: (用户中止了运行)');
  });

  it('没有 run 上下文的报错是英文', async () => {
    const r = await tool('ask_user').execute({ question: 'Q?' }, { sessionId: 's' } as any);
    expect(r).toMatch(/^Error:/);
    expect(r).not.toMatch(CJK);
  });
});

describe('exit_plan_mode 的工具结果(给模型,英文;批准判定口径不变)', () => {
  const PLAN = '# 计划\n1. 先写测试\n2. 再改代码';

  it('批准(自动开始):关计划模式、英文结果、询问选项逐字不变', async () => {
    const cwd = await tmpDir('plan-approve-');
    const r = await runWithAnswer('exit_plan_mode', { plan: PLAN }, APPROVE_AUTO, { cwd });
    expect(JSON.parse(state.setConfigCalls.at(-1)!)).toMatchObject({ planMode: false });
    expect(r).toMatch(/approved the plan/i);
    expect(r).toMatch(/automatically/i);
    const approved = state.events.find((e) => e.type === 'plan_approved');
    expect(approved?.payload).toMatchObject({ auto: true });
    expect(approved?.payload.file.startsWith(cwd)).toBe(true);
    expect(ownText(r, approved!.payload.file)).not.toMatch(CJK);
    // wire 约定:计划卡的选项字面量不许动(客户端按逐字批)
    const inq = state.events.find((e) => e.type === 'inquiry_request');
    expect(inq?.payload.options.slice(0, 2)).toEqual([APPROVE_AUTO, APPROVE_MANUAL]);
  });

  it('编辑后批准:回给模型的是用户那份,且工具自己的文字是英文', async () => {
    const cwd = await tmpDir('plan-revise-');
    const revised = '# 计划\n1. 只改文档';
    const r = await runWithAnswer('exit_plan_mode', { plan: PLAN }, `${APPROVE_MANUAL}${PLAN_REVISION_MARK}${revised}`, { cwd });
    expect(r).toContain(revised);
    expect(r).not.toContain('2. 再改代码');
    const file = state.events.find((e) => e.type === 'plan_approved')!.payload.file;
    expect(ownText(r, revised, file)).not.toMatch(CJK);
  });

  it('打回:反馈原文回给模型 + 英文的「按反馈改了再提交」', async () => {
    const feedback = '批准前先补上回滚方案';
    const r = await runWithAnswer('exit_plan_mode', { plan: PLAN }, feedback);
    expect(state.setConfigCalls).toHaveLength(0); // 计划模式没被关
    expect(r).toContain(feedback);
    expect(r).toMatch(/did not approve/i);
    expect(r).toMatch(/exit_plan_mode again/);
    expect(ownText(r, feedback)).not.toMatch(CJK);
  });

  it('系统代答(通道停止):不算批准,也不让模型「按反馈改计划」', async () => {
    const r = await runWithAnswer('exit_plan_mode', { plan: PLAN }, SERVICE_CHANNEL_STOPPED_ANSWER);
    expect(state.setConfigCalls).toHaveLength(0);
    expect(r).toContain(SERVICE_CHANNEL_STOPPED_ANSWER);
    expect(r).toMatch(/no answer from the user/i);
    expect(r).not.toMatch(/did not approve|their reply|revise/i);
    expect(r).not.toMatch(CJK);
  });

  it('打回:用户自己打出 [No answer] 开头 → 按用户反馈处理(不说成没人答)', async () => {
    const typed = `${SYSTEM_ANSWER_PREFIX} 先别急,第 2 步拆细`;
    const r = await runWithAnswer('exit_plan_mode', { plan: PLAN }, typed);
    expect(state.setConfigCalls).toHaveLength(0);
    expect(r).toMatch(/did not approve/i);
    expect(r).toContain(typed);
    expect(r).not.toMatch(/no answer from the user/i);
  });

  it('run 中止:英文系统说明,计划模式不关', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await tool('exit_plan_mode').execute({ plan: PLAN }, { runId: 'run-plan-abort', sessionId: 's', signal: ac.signal } as any);
    expect(state.setConfigCalls).toHaveLength(0);
    expect(r).toContain(INQUIRY_RUN_STOPPED_NOTE);
    expect(r).not.toMatch(CJK);
  });
});
