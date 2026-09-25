import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react';
import { Box, Static, Text, useApp, useStdin } from 'ink';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun } from '../services/runStore.js';
import { enqueueRun, abortRun, enqueueSteer, cancelSteer } from '../services/agentLoop.js';
import { subscribe } from '../services/eventBus.js';
import { compactSession } from '../services/compaction.js';
import { resolveCompactionSettings, globalCompactionLayer } from '../services/compactionSettings.js';
import { branchSession } from '../services/sessionBranch.js';
import { effectiveContextWindowInfo } from '../services/contextBudget.js';
import { listAgents, getAgent, saveAgent, deleteAgent } from '../agents/agentRegistry.js';
import { agentsDir } from '../core/tanguHome.js';
import { discoverPlugins } from '../plugins/loader.js';
import { loadSpecialAgentsConfig, saveSpecialAgentsConfig } from '../services/specialAgentsConfig.js';
import { resolveApproval, type ApprovalDecision } from '../services/approvals.js';
import { isThinkingLevel, THINKING_LEVELS } from '../llm/modelCapabilities.js';
import { APPROVAL_MODE_META, APPROVAL_MODE_IDS, type ApprovalModeId } from '../core/commandCatalog.js';
import { listModelCatalog, chatModels, effectiveThinkingOn, type CatalogModel } from '../services/modelCatalog.js';
import { readSessionSettings, patchSessionAgentConfig, setSessionModelId, requestRunThinking } from '../services/sessionSettings.js';
import { listCustomCommands, getCustomCommand, expandCustomCommand, commandsDir } from '../services/customCommands.js';
import type { ThinkingLevel } from '../core/types.js';
import { resolveInquiry } from '../services/inquiries.js';
import { saveModel } from '../standalone/credStore.js';
import { getToolDefinitions, listDeferredTools } from '../tools/registry.js';
import { reducer, initialState } from './events.js';
import { listSessions, loadSessionItems, type SessionRow } from './sessions.js';
import { tuiCommands, copyToClipboardOSC52, hotkeyLines } from './commands.js';
import { getLastUserMessageContent, deleteLastExchange, renderSessionMarkdown } from './messageOps.js';
import { ItemView, LiveView, TodoPanel } from './components/Message.js';
import { StatusBar, approvalLabel, thinkingLabel } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import { ApprovalPrompt, pendingApprovalFromEvent } from './components/ApprovalPrompt.js';
import { InquiryPrompt } from './components/InquiryPrompt.js';
import { SelectPrompt } from './components/SelectPrompt.js';
import { dispWidth } from './components/Banner.js';
import type { PickerItem } from './picker.js';
import { L } from './i18n.js';
import { nextThinkingLevel, parseThinkingArg } from './thinking.js';
import { collectGitDiff } from './gitDiff.js';
import {
  parseSlash, buildRunAgentConfig, resumePlan, agentActivation, needsFullAutoConfirm, fullAutoConfirmPicker,
  resolveModelArg, claimInjectedSteers, rescueSteers, launchRun, isApprovalMode, TUI_APPROVAL_KEY, createSessionSettingsWriter, noModelNotice,
  type MutableConfig, type QueuedMessage,
} from './runConfig.js';
import { theme } from './theme.js';
import type { TuiConfig } from './config.js';
import type { ApprovalMode } from './types.js';

const RUN_AFFECTING = new Set(['/new', '/resume', '/retry', '/compact', '/branch', '/edit', '/delete', '/refine']);

/** 打开中的选择器(SelectPrompt 的入参 + 回调)。id 递增 → 每次打开都是全新组件状态。 */
interface PickerRequest {
  id: number;
  title: string;
  subtitle?: string;
  items: PickerItem<any>[];
  initialQuery?: string;
  initialValue?: unknown;
  tone?: 'accent' | 'warn';
  onSelect: (value: any) => void;
  onCancel?: () => void;
}

const clip = (s: string, n = 60): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const fmtTime = (v: string | number | null): string => {
  if (v == null || v === '') return '';
  const d = new Date(typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : String(v));
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** 群聊结束原因 → 中文。 */
function groupReason(r: string): string {
  // 'vote' 只剩历史事件回放会遇到(09-16 起没有投票)。
  return r === 'done' ? '全员表示已完成' : r === 'settled' ? '没有新的发言了' : r === 'vote' ? '投票通过' : r === 'cost_limit' ? '达到花费上限' : r === 'quota' ? '额度不足' : '达到轮数上限';
}

export function App({ boot, storage }: { boot: TuiConfig; storage: string }): ReactElement {
  const userId = boot.userId;
  const { exit } = useApp();

  const [cfg, setCfg] = useState<MutableConfig>({
    model: boot.defaultModelId,
    cwd: boot.cwd,
    execMode: boot.execMode,
    approvalMode: boot.approvalMode,
    tokenBudget: boot.tokenBudget,
    thinkingLevel: boot.thinkingLevel,
    seedSystem: undefined,
  });
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const [sessionId, setSessionId] = useState<string>(() => randomUUID());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const busyRef = useRef(state.busy);
  busyRef.current = state.busy;

  const activeRunId = useRef<string | null>(null);
  /** Esc 落在「已起 run、引擎里还没注册」那段(写会话设置 / 建 run 行)时记下 runId,起跑链据此收手(见 launchRun)。 */
  const preStartAbort = useRef<string | null>(null);
  const unsubRef = useRef<null | (() => void)>(null);
  const pendingText = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionListRef = useRef<SessionRow[]>([]);
  /** 已就绪的群聊参与者 slug(/groupchat 设置;非空时每条消息走多 Agent 群聊;/groupchat off 清空)。 */
  const groupAgentsRef = useRef<string[] | null>(null);

  // 选择器(/model /think /approval /resume、Ctrl+P、完全放行确认):开着时键盘归它,输入框让出焦点但保持挂载。
  const [picker, setPicker] = useState<PickerRequest | null>(null);
  const pickerSeq = useRef(0);
  // 模型目录缓存(Shift+Tab 要知道当前模型支持哪些思考档;/model 每次现拉)。
  const catalogRef = useRef<CatalogModel[] | null>(null);
  const [, setCatalogVersion] = useState(0); // 目录到货 → 重渲染,状态栏的生效档随之更新
  // 引擎 context_info 报的「请求档 → 实际生效档」;按模型 / 请求档对不上就当过期。
  const [ctxInfo, setCtxInfo] = useState<{ requested: string; effective: string; modelId: string } | null>(null);
  // 运行中输入:steers = 已交引擎等注入(turn_boundary 时上屏);followUps = 引擎暂不收,运行结束后逐条自动发。
  const steersRef = useRef<QueuedMessage[]>([]);
  const followUpsRef = useRef<QueuedMessage[]>([]);
  const [queues, setQueues] = useState<{ steers: QueuedMessage[]; followUps: QueuedMessage[] }>({ steers: [], followUps: [] });
  const syncQueues = (): void => setQueues({ steers: [...steersRef.current], followUps: [...followUpsRef.current] });

  const { setRawMode } = useStdin();

  const notice = (text: string, tone: 'info' | 'error' | 'success' | 'warn' = 'info'): void =>
    dispatch({ type: 'ADD_NOTICE', text, tone });

  /** 同步改 cfgRef 再 setState:同一 tick 里紧接着的 startRun(如 follow-up)读到的就是新值。 */
  const patchCfg = (patch: Partial<MutableConfig>): void => {
    cfgRef.current = { ...cfgRef.current, ...patch };
    setCfg((c) => ({ ...c, ...patch })); // 函数式合并:别吞掉同一 tick 里别处排队的 setCfg(fn)
  };

  const openPicker = (req: Omit<PickerRequest, 'id'>): void => {
    pickerSeq.current += 1;
    setPicker({ ...req, id: pickerSeq.current });
  };

  const loadCatalog = async (): Promise<{ models: CatalogModel[]; error: string | null }> => {
    const cat = await listModelCatalog(deps().profile);
    const models = chatModels(cat.models);
    catalogRef.current = models;
    setCatalogVersion((v) => v + 1);
    return { models, error: cat.forsion.status === 'error' ? cat.forsion.detail || 'error' : null };
  };
  const modelInfo = (id: string): CatalogModel | undefined => catalogRef.current?.find((m) => m.id === id);
  /** 当前思考档实际按哪档跑:引擎 context_info 报的(同模型同请求档才算数)优先,否则按目录能力表估。 */
  const effectiveThinking = (): string | undefined => {
    const c = cfgRef.current;
    if (ctxInfo && ctxInfo.modelId === c.model && ctxInfo.requested === c.thinkingLevel) return ctxInfo.effective;
    const levels = modelInfo(c.model)?.thinkingLevels;
    return levels?.length ? effectiveThinkingOn(c.thinkingLevel, levels) : undefined;
  };

  // 多行编辑统一走 $EDITOR(git/crontab 同款)。spawnSync 阻塞整个事件循环 → ink 渲染天然冻结,
  // 退出后下一次 dispatch 触发重绘。退 raw 模式让编辑器独占终端,finally 必恢复。
  const pickEditor = (): string =>
    process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');

  /** 在 $EDITOR 里编辑一段文本(经临时文件),返回保存后的内容;取消/失败返回 null。 */
  const editText = async (initial: string, ext = '.md'): Promise<string | null> => {
    const tmp = path.join(os.tmpdir(), `tangu-edit-${randomUUID()}${ext}`);
    try {
      await fs.writeFile(tmp, initial ?? '');
      setRawMode?.(false);
      const r = spawnSync(pickEditor(), [tmp], { stdio: 'inherit' });
      setRawMode?.(true);
      if (r.error) { notice(`无法打开编辑器(${pickEditor()}):${r.error.message}`, 'error'); return null; }
      return await fs.readFile(tmp, 'utf8');
    } catch (e: any) {
      setRawMode?.(true);
      notice(`编辑失败:${e?.message || e}`, 'error');
      return null;
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  };

  /** 直接在 $EDITOR 里打开磁盘文件(agent 文件即真源,改完即时热加载),返回是否成功。 */
  const editFile = async (absPath: string): Promise<boolean> => {
    try {
      setRawMode?.(false);
      const r = spawnSync(pickEditor(), [absPath], { stdio: 'inherit' });
      setRawMode?.(true);
      if (r.error) { notice(`无法打开编辑器(${pickEditor()}):${r.error.message}`, 'error'); return false; }
      return true;
    } catch (e: any) {
      setRawMode?.(true);
      notice(`编辑失败:${e?.message || e}`, 'error');
      return false;
    }
  };


  const ensureSession = async (sid: string, model: string): Promise<void> => {
    await query(
      `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id) VALUES (?, ?, 'tangu', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [sid, userId, 'TUI chat', model],
    ).catch(() => {});
  };

  // 会话设置(模型 / 思考档 / TUI 审批档 / 循环上限 / 计划模式)的所有写都走这一条队列:按会话、按发出顺序落库。
  // 别在下面直接调 patchSessionAgentConfig / setSessionModelId —— 起 run 那次写要先等建行,直调会被它后发先至地盖回旧档
  // (见 runConfig.createSessionSettingsWriter)。
  const settingsWriterRef = useRef<ReturnType<typeof createSessionSettingsWriter> | null>(null);
  const settingsWriter = (settingsWriterRef.current ??= createSessionSettingsWriter({
    ensure: (sid, model) => ensureSession(sid, model),
    patch: patchSessionAgentConfig,
    setModel: (sid, model) => setSessionModelId(sid, userId, model),
  }));

  useEffect(() => {
    void settingsWriter.ensure(sessionIdRef.current, cfgRef.current.model);
    void loadCatalog().catch(() => {}); // 预热:状态栏的生效档 / Shift+Tab 的可选档都靠它
    if (!cfgRef.current.model) {
      notice(noModelNotice(), 'warn');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── token 批量刷新：高频 token 合批 ~40ms 派发一次，避免每 token 重渲染 ──
  const flushNow = (): void => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (pendingText.current) {
      const d = pendingText.current;
      pendingText.current = '';
      dispatch({ type: 'APPEND_TEXT', delta: d });
    }
  };
  const bufferToken = (delta: string): void => {
    pendingText.current += delta;
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        flushNow();
      }, 40);
    }
  };

  const teardownRun = (): void => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
    activeRunId.current = null;
  };

  const handleEvent = (ev: { type: string; payload: any }): void => {
    const p = ev.payload || {};
    switch (ev.type) {
      case 'token':
        if (p.publicSpeech) break; // Complete team remarks are rendered once by group_speaker end.
        bufferToken(p.delta || '');
        break;
      case 'reasoning':
        flushNow();
        dispatch({ type: 'APPEND_REASONING', delta: p.delta || '' });
        break;
      case 'tool_call':
        flushNow();
        dispatch({ type: 'TOOL_CALL', id: p.id, name: p.name, args: p.arguments || '' });
        break;
      case 'tool_result':
        flushNow();
        dispatch({ type: 'TOOL_RESULT', id: p.id, name: p.name, result: String(p.result ?? ''), isError: !!p.isError });
        break;
      case 'usage':
        // C-5:带 phase 的是后台调用的用量,lastPrompt/iteration 会被刷成子代理的值。
        // 与下方 context_info 同理跳过(等同本轮之前的行为:那时后台调用根本不发 usage)。
        if (p.phase) break;
        dispatch({ type: 'USAGE', tokens: (p.prompt || 0) + (p.completion || 0), cost: p.cost || 0, cached: p.cached || 0, iteration: p.iteration || 0, prompt: p.prompt || 0 });
        break;
      case 'status':
        // context_info 是一次性数据事件,不是活动阶段——STATUS reducer 的 phase 是粘性的,放进去会让状态栏
        // 整个 run 显示「running context_info」。只取思考档「请求 → 实际生效」给状态栏;按别的模型算的(切模型后
        // 重放的旧事件)丢掉。steering_applied 同理是一次性标记(插话上屏走 turn_boundary)。
        if (p.phase === 'context_info') {
          const mid = typeof p.modelId === 'string' && p.modelId ? p.modelId : cfgRef.current.model;
          if (mid === cfgRef.current.model && typeof p.thinkingEffective === 'string') {
            setCtxInfo({ requested: String(p.thinkingRequested || ''), effective: p.thinkingEffective, modelId: mid });
          }
          break;
        }
        if (p.phase === 'steering_applied') break;
        dispatch({ type: 'STATUS', state: p.state, iteration: p.iteration, phase: p.phase });
        break;
      case 'turn_boundary': {
        // 插话已被引擎注入(此前的助手内容已定稿落库):封存 live 气泡,把插话作为用户气泡接在后面。
        flushNow();
        const { texts, remaining } = claimInjectedSteers(steersRef.current, Array.isArray(p.userMessages) ? p.userMessages : []);
        steersRef.current = remaining;
        syncQueues();
        dispatch({ type: 'TURN_BOUNDARY', userTexts: texts });
        break;
      }
      case 'session_config_changed': {
        // agent 用 update_session_settings 改了本会话设置(引擎已落库):同步本地缓存,否则下一轮用旧值原样盖回去。
        // 只改本会话,不写「下次启动的默认模型」(那是用户自己 /model 才动的)。
        if (p.sessionId && p.sessionId !== sessionIdRef.current) break;
        if (typeof p.modelId === 'string' && p.modelId && p.modelId !== cfgRef.current.model) {
          patchCfg({ model: p.modelId });
          setCtxInfo(null);
          notice(L(`Agent 已把模型切换为 ${p.modelId}——从你的下一条消息起生效`, `Agent switched the model to ${p.modelId} — takes effect from your next message`), 'info');
        }
        if (isThinkingLevel(p.thinkingLevel)) {
          patchCfg({ thinkingLevel: p.thinkingLevel });
          notice(L(`Agent 已把思考档调为 ${p.thinkingLevel}——从它的下一次请求起立即生效`, `Agent set the thinking level to ${p.thinkingLevel} — applies immediately from its next request`), 'info');
        }
        break;
      }
      case 'approval_request':
        flushNow();
        dispatch({ type: 'APPROVAL', approval: pendingApprovalFromEvent(p) });
        break;
      case 'inquiry_request':
        flushNow();
        dispatch({ type: 'INQUIRY', inquiry: { inquiryId: p.inquiryId, question: p.question || '', options: Array.isArray(p.options) ? p.options : [] } });
        break;
      case 'plan':
        flushNow();
        dispatch({ type: 'ADD_NOTICE', text: '📋 计划提案:\n' + String(p.plan || ''), tone: 'info' });
        break;
      case 'plan_approved':
        setCfg((c) => ({ ...c, planMode: false })); // 工具侧已落库,本地配置同步关
        dispatch({ type: 'ADD_NOTICE', text: '✓ 计划已批准,计划模式关闭——下一条消息开始执行', tone: 'success' });
        break;
      case 'todo':
        dispatch({ type: 'TODO', todos: Array.isArray(p.todos) ? p.todos : [] });
        break;
      case 'subchat':
        flushNow();
        dispatch({ type: 'ADD_NOTICE', text: `↳ 子聊天「${p.title || ''}」已开始（${p.kind || 'sub'}）`, tone: 'info' });
        break;
      // ── 群聊:发言人轮转 / 投票 / 结束 → 线性转录(切发言人时 GROUP_NOTE 封存上一气泡)。──
      case 'group_speaker':
        if (p.phase === 'start') {
          flushNow();
          dispatch({ type: 'GROUP_NOTE', text: `🗣 ${p.name || p.slug}${p.round ? `  ·  第 ${p.round} 周期` : ''}`, tone: 'info' });
        } else if (p.phase === 'end' && typeof p.text === 'string' && p.text) {
          // 并行团队(09-16 第四轮):成员的发言不再逐 token 流进团队 run,end 带正文 → 这里整段打出来。
          flushNow();
          dispatch({ type: 'GROUP_NOTE', text: p.text, tone: 'info' });
        }
        break;
      case 'team_member':
        flushNow();
        dispatch({ type: 'GROUP_NOTE', text: p.phase === 'start' ? `⏳ ${p.name || p.slug} 开始工作…` : `${p.reason === 'failed' ? '⚠️' : '✔'} ${p.name || p.slug} 本次工作结束(${p.reason || 'done'})`, tone: p.reason === 'failed' ? 'error' : 'info' });
        break;
      case 'group_summary':
        flushNow();
        dispatch({ type: 'GROUP_NOTE', text: `📋 Historian\n${p.text || ''}`, tone: 'info' });
        break;
      case 'group_voting':
        flushNow();
        dispatch({ type: 'GROUP_NOTE', text: `🗳 第 ${p.round} 轮投票中…`, tone: 'info' });
        break;
      case 'group_vote': {
        flushNow();
        const detail = Array.isArray(p.votes)
          ? p.votes.map((v: any) => `  ${v.end ? '✓' : '·'} ${v.name}${v.reason ? `：${v.reason}` : ''}`).join('\n')
          : '';
        dispatch({ type: 'GROUP_NOTE', text: `🗳 第 ${p.round} 轮投票：${p.endCount}/${p.total} 赞成结束${detail ? '\n' + detail : ''}`, tone: 'info' });
        break;
      }
      case 'group_ended':
        flushNow();
        dispatch({ type: 'GROUP_NOTE', text: `🏁 团队工作结束（${p.rounds} 轮 · ${groupReason(String(p.reason || ''))}）`, tone: 'success' });
        break;
      case 'done': {
        flushNow();
        const rid = activeRunId.current;
        teardownRun();
        dispatch({ type: 'DONE' });
        // 引擎最后一次 drain 在模型收尾那一刻;之后(Stop hook / 落库 / done)到 AbortController 注销之间
        // enqueueSteer 仍返回 true,但已没人消费 —— 这些插话没进对话。cancelSteer 取回仍在队列里的,改作新消息发。
        const { followUps, rescued } = rescueSteers(steersRef.current, followUpsRef.current, (id) => !!rid && cancelSteer(rid, id));
        steersRef.current = [];
        followUpsRef.current = followUps;
        if (rescued) {
          notice(L(`${rescued} 条插话没赶上本次运行，改作新消息发送`, `${rescued} steer message(s) missed the run; sending them as new messages`), 'info');
        }
        drainFollowUp();
        break;
      }
      case 'error': {
        flushNow();
        const rid = activeRunId.current;
        teardownRun();
        dispatch({ type: 'ERROR', msg: String(p.error || 'error'), aborted: !!p.aborted });
        if (rid) for (const q of steersRef.current) cancelSteer(rid, q.id); // 别在引擎里留孤儿队列
        dropQueued(p.aborted ? 'aborted' : 'failed');
        break;
      }
    }
  };

  /** 起一个 run;已有在跑的 / 没选模型 → false(调用方决定排队还是放弃)。 */
  const startRun = (message: string): boolean => {
    if (activeRunId.current) return false;
    if (!cfgRef.current.model) {
      notice(noModelNotice(), 'warn');
      return false;
    }
    const runId = randomUUID();
    activeRunId.current = runId;
    dispatch({ type: 'START_LIVE' });
    unsubRef.current = subscribe(runId, (ev) => handleEvent(ev));
    const sid = sessionIdRef.current;
    const c = cfgRef.current;
    const agentConfig = buildRunAgentConfig(c, groupAgentsRef.current);
    // 本端设置写进会话(按键合并,与桌面 PATCH 同锁):/resume 与桌面打开同一会话时才恢复得出来。
    // 审批档只写 TUI 专属键 —— 共享的 approvalMode 桌面审批时现读,写了就是跨端改档(见 runConfig TUI_APPROVAL_KEY)。
    // 先写完再起 run —— 引擎起跑时也会读改写同一份 agent_config(补 agentSlug / preset)。
    // 先确保会话行存在(/new 后秒发时建行的 INSERT 可能还没落):否则下面两个 UPDATE 落空,/resume 恢复不出来。
    // 走 settingsWriter 排队:建行期间用户 /think、/approval 改的档排在这次写之后,不会被这里截的旧档盖回去。
    launchRun({
      persist: () => settingsWriter.runStart(sid, c),
      create: () =>
        createRun({
          id: runId,
          sessionId: sid,
          userId,
          appId: 'tangu',
          modelId: c.model,
          assistantMessageId: randomUUID(),
          input: { message, userMessageId: randomUUID(), attachments: [], agentConfig },
        }),
      enqueue: () => enqueueRun(sid, runId),
      abort: () => abortRun(runId),
      abortRequested: () => preStartAbort.current === runId,
    })
      .then((r) => {
        if (r !== 'aborted' || activeRunId.current !== runId) return;
        // 还没建 run 就按了 Esc:引擎里什么都没有,也不会有 error 事件 —— 本地收尾(同引擎中止的 error 分支)。
        teardownRun();
        dispatch({ type: 'ERROR', msg: 'aborted', aborted: true });
        dropQueued('aborted');
      })
      .catch((e: any) => {
        teardownRun();
        dispatch({ type: 'ERROR', msg: e?.message || String(e) });
        dropQueued('failed');
      });
    return true;
  };

  /** 运行结束 → 排队的下一条自动发出(一次一条;后面的等这一条跑完)。 */
  const drainFollowUp = (): void => {
    const q = followUpsRef.current.shift();
    syncQueues();
    if (!q) return;
    if (activeRunId.current) {
      followUpsRef.current.unshift(q); // 被别的 run 抢先:放回队首,等它结束
      syncQueues();
      return;
    }
    if (startRun(q.message)) {
      dispatch({ type: 'ADD_USER', text: q.display }); // 用户气泡进 Static,live 区在它下面照常流
    } else {
      followUpsRef.current.unshift(q);
      dropQueued('blocked'); // 没选模型之类:剩下的也发不出去
    }
  };

  /** 运行中止 / 出错:排队的消息不再自动发(用户多半要重新考虑),告诉他们能从历史找回。 */
  const dropQueued = (reason: 'aborted' | 'failed' | 'blocked'): void => {
    const n = steersRef.current.length + followUpsRef.current.length;
    steersRef.current = [];
    followUpsRef.current = [];
    syncQueues();
    if (!n) return;
    const why = {
      aborted: L('运行已中止', 'Run aborted'),
      failed: L('运行出错', 'Run failed'),
      blocked: L('无法开始新的运行', 'Cannot start a new run'),
    }[reason];
    notice(L(`${why}，${n} 条排队消息未发送（按 ↑ 可从输入历史找回）`, `${why}; ${n} queued message(s) were not sent (press ↑ to recall them from history)`), 'warn');
  };

  /** 把消息里的 @path 提及替换成附带文件内容的上下文（仅追加给模型，不改用户气泡显示）。 */
  const augmentMentions = async (text: string): Promise<string> => {
    const matches = text.match(/@([^\s]+)/g) || [];
    let extra = '';
    for (const tok of matches.slice(0, 6)) {
      const rel = tok.slice(1);
      try {
        const abs = path.resolve(cfgRef.current.cwd, rel);
        const content = await fs.readFile(abs, 'utf-8');
        extra += `\n\n[file: ${rel}]\n\`\`\`\n${content.slice(0, 16000)}\n\`\`\``;
      } catch {
        /* 非文件提及，跳过 */
      }
    }
    return extra ? text + extra : text;
  };

  const newSession = (): void => {
    const nid = randomUUID();
    sessionIdRef.current = nid;
    setSessionId(nid);
    setCfg((c) => ({ ...c, seedSystem: undefined }));
    void settingsWriter.ensure(nid, cfgRef.current.model);
    setCtxInfo(null);
    dispatch({ type: 'RESET_SESSION' });
  };

  // ── 运行配置:模型 / 思考档 / 审批档(命令、快捷键、选择器共用)──────────────────────────

  const modelHint = (m: CatalogModel): string =>
    [
      m.provider,
      m.name && m.name !== m.id ? m.name : '',
      m.thinkingLevels?.length ? L(`思考 ${m.thinkingLevels.join('/')}`, `thinking ${m.thinkingLevels.join('/')}`) : '',
    ]
      .filter(Boolean)
      .join(' · ');

  /** 切模型:本进程配置 + 记住为下次启动默认(原行为)+ 写进本会话(/resume 能恢复);思考档不被支持就说清按哪档跑。 */
  const applyModel = async (id: string, entry?: CatalogModel, unverified = false): Promise<void> => {
    patchCfg({ model: id });
    setCtxInfo(null);
    saveModel(id);
    await settingsWriter.model(sessionIdRef.current, id);
    const lv = cfgRef.current.thinkingLevel;
    const eff = effectiveThinkingOn(lv, (entry ?? modelInfo(id))?.thinkingLevels);
    const lines = [L(`模型已切到 ${id}（已记住，下次直接 tangu 即用）`, `Model switched to ${id} (remembered for the next launch)`)];
    if (unverified) lines.push(L('注意：该 id 不在模型目录里，未做校验', 'Note: this id is not in the model catalog and was not validated'));
    if (eff !== lv) lines.push(L(`该模型不支持思考档 ${lv}，将按 ${eff} 运行`, `This model doesn't support thinking level ${lv}; it will run as ${eff}`));
    if (activeRunId.current) lines.push(L('当前运行仍用原模型，从你的下一条消息起生效', 'The current run keeps its model; the switch takes effect from your next message'));
    notice(lines.join('\n'), unverified ? 'warn' : 'success');
  };

  const openModelPicker = async (query = ''): Promise<void> => {
    let models: CatalogModel[] = [];
    let error: string | null = null;
    try {
      ({ models, error } = await loadCatalog());
    } catch (e: any) {
      error = e?.message || String(e);
    }
    if (!models.length) {
      notice(
        L(
          `没有可选的模型${error ? `（拉取目录失败：${error}）` : ''}。确认已登录 / 已配置 provider；也可直接 /model =<id> 指定。`,
          `No models available${error ? ` (catalog fetch failed: ${error})` : ''}. Check that you are signed in or have a provider configured; you can also set one directly with /model =<id>.`,
        ),
        'warn',
      );
      return;
    }
    const cur = cfgRef.current.model;
    openPicker({
      title: L('选择模型', 'Select a model'),
      subtitle: L(`当前：${cur || '(未设置)'} · 选中即切换，并记住为下次启动的默认`, `Current: ${cur || '(not set)'} · selecting switches and remembers it for the next launch`),
      items: models.map((m) => ({ label: m.id, keywords: `${m.name} ${m.provider}`, hint: modelHint(m), value: m.id, current: m.id === cur })),
      initialQuery: query,
      onSelect: (id: string) => void applyModel(id, models.find((m) => m.id === id)),
    });
  };

  /** 改思考档:本地配置 + 会话存值;有在跑的 run → 从它下一次请求起就按新档(与 agent 工具同一条 run 内通道)。 */
  const applyThinking = (lv: ThinkingLevel, announce: boolean): void => {
    patchCfg({ thinkingLevel: lv });
    void settingsWriter.patch(sessionIdRef.current, { thinkingLevel: lv });
    const runId = activeRunId.current;
    if (runId) requestRunThinking(runId, lv);
    if (!announce) return;
    const eff = effectiveThinkingOn(lv, modelInfo(cfgRef.current.model)?.thinkingLevels);
    const lines = [L(`思考强度已设为 ${lv}${lv === 'off' ? '' : '（思考内容默认折叠，流式时展开）'}`, `Thinking level set to ${lv}${lv === 'off' ? '' : ' (reasoning is folded once done, shown while streaming)'}`)];
    if (eff !== lv) lines.push(L(`当前模型不支持该档，将按 ${eff} 运行`, `The current model doesn't support it; it will run as ${eff}`));
    if (runId) lines.push(L('正在进行的运行从下一次请求起按新档', 'The running task uses it from its next request'));
    notice(lines.join('\n'), 'success');
  };

  /** Shift+Tab:在当前模型支持的档里循环(目录没有该模型 → 7 档全转)。只刷状态栏,不刷屏。 */
  const cycleThinking = (): void => {
    applyThinking(nextThinkingLevel(cfgRef.current.thinkingLevel, modelInfo(cfgRef.current.model)?.thinkingLevels), false);
  };

  const openThinkingPicker = (): void => {
    const supported = modelInfo(cfgRef.current.model)?.thinkingLevels;
    const cur = cfgRef.current.thinkingLevel;
    openPicker({
      title: L('思考强度', 'Thinking level'),
      subtitle: supported?.length
        ? L(`${cfgRef.current.model} 支持：${supported.join(' / ')}`, `${cfgRef.current.model} supports: ${supported.join(' / ')}`)
        : L('未知该模型支持哪些档：不支持的档会自动降到最近可用档', "This model's supported levels are unknown; unsupported levels are clamped automatically"),
      items: THINKING_LEVELS.map((lv) => {
        const eff = effectiveThinkingOn(lv, supported);
        return { label: lv, value: lv, current: lv === cur, hint: eff !== lv ? L(`不支持 · 按 ${eff} 运行`, `unsupported · runs as ${eff}`) : undefined };
      }),
      onSelect: (lv: ThinkingLevel) => applyThinking(lv, true),
    });
  };

  const applyApprovalMode = (mode: ApprovalMode): void => {
    patchCfg({ approvalMode: mode });
    void settingsWriter.patch(sessionIdRef.current, { [TUI_APPROVAL_KEY]: mode }); // 只供 TUI 自己 /resume,不改桌面的共享档
    const meta = APPROVAL_MODE_META[mode as ApprovalModeId];
    const lines = [L(`审批档已切到「${meta.zh}」（${mode}）：${meta.descZh}`, `Approval mode set to "${meta.en}" (${mode}): ${meta.descEn}`)];
    if (activeRunId.current) lines.push(L('当前运行仍按原档审批，从你的下一条消息起生效', 'The current run keeps its approval mode; the change applies from your next message'));
    notice(lines.join('\n'), mode === 'full-auto' ? 'warn' : 'success');
  };

  /** 完全放行多一道确认(Codex 的摩擦):光标默认停在「取消」。其余档直接切。/approval、选择器、/agent 都走这里。 */
  const requestApprovalMode = (mode: ApprovalMode): void => {
    if (!needsFullAutoConfirm(cfgRef.current.approvalMode, mode)) {
      applyApprovalMode(mode);
      return;
    }
    openPicker({
      ...fullAutoConfirmPicker(),
      onSelect: (v: string) => (v === 'yes' ? applyApprovalMode('full-auto') : notice(L('已取消，审批档未变', 'Cancelled; approval mode unchanged'))),
      onCancel: () => notice(L('已取消，审批档未变', 'Cancelled; approval mode unchanged')),
    });
  };

  const openApprovalPicker = (): void => {
    const cur = cfgRef.current.approvalMode;
    openPicker({
      title: L('审批档', 'Approval mode'),
      items: APPROVAL_MODE_IDS.map((id) => {
        const meta = APPROVAL_MODE_META[id];
        return { label: L(meta.zh, meta.en), keywords: id, hint: `${id} · ${L(meta.descZh, meta.descEn)}`, value: id, current: id === cur };
      }),
      onSelect: (id: ApprovalMode) => requestApprovalMode(id),
    });
  };

  /**
   * 恢复会话:回放历史 + 从会话存值恢复模型 / 思考档 / 审批档 / 循环上限 / 计划模式 / 当前 Agent(口径见 runConfig.resumePlan)。
   * 存值里的 full-auto **不会**静默带回来(会话可能是别处开的完全放行):保留当前档并提示用户自己 /approval。
   */
  const resumeSession = async (sessionIdOrPrefix: string): Promise<void> => {
    let id = sessionIdOrPrefix.trim();
    try {
      let saved = await readSessionSettings(id, userId).catch(() => null);
      if (!saved && id.length >= 4) {
        // /sessions 列表显示的是 8 位短 id:按前缀在自己的会话里找,唯一命中才认
        const hits = (await listSessions(userId, 200).catch(() => [] as SessionRow[])).filter((r) => String(r.id).startsWith(id));
        if (hits.length === 1) {
          id = hits[0].id;
          saved = await readSessionSettings(id, userId).catch(() => null);
        }
      }
      if (!saved) {
        notice(L(`找不到会话：${id}（/resume 不带参数可从列表里选）`, `Session not found: ${id} (run /resume without an argument to pick from a list)`), 'error');
        return;
      }
      const { items } = await loadSessionItems(id, 1);
      const { patch, agentSlug, heldBackFullAuto } = resumePlan(saved, cfgRef.current);
      if (agentSlug) {
        const def = await getAgent(agentSlug).catch(() => null);
        if (def) {
          patch.activeAgentSlug = def.slug;
          patch.seedSystem = def.systemPrompt;
        }
      }
      sessionIdRef.current = id;
      setSessionId(id);
      patchCfg(patch);
      setCtxInfo(null);
      dispatch({ type: 'RESET_SESSION', items });
      const c = cfgRef.current;
      notice(
        L(
          `已恢复会话 ${String(id).slice(0, 8)}（${items.length} 条历史）\n  模型 ${c.model || '(未设置)'} · 思考 ${c.thinkingLevel} · ${approvalLabel(c.approvalMode)}${c.planMode ? ' · 计划模式' : ''}${c.activeAgentSlug ? ` · @${c.activeAgentSlug}` : ''}${c.maxIterations ? ` · 循环上限 ${c.maxIterations}` : ''}`,
          `Resumed session ${String(id).slice(0, 8)} (${items.length} messages)\n  model ${c.model || '(not set)'} · thinking ${c.thinkingLevel} · ${approvalLabel(c.approvalMode)}${c.planMode ? ' · plan mode' : ''}${c.activeAgentSlug ? ` · @${c.activeAgentSlug}` : ''}${c.maxIterations ? ` · max ${c.maxIterations} steps` : ''}`,
        ),
        'success',
      );
      if (heldBackFullAuto) {
        notice(
          L(
            `该会话上次是「完全放行」，为安全起见未自动恢复（当前：${approvalLabel(c.approvalMode)}）。需要的话用 /approval full-auto 重新开启。`,
            `This session was last in "Full access"; it was not restored automatically for safety (current: ${approvalLabel(c.approvalMode)}). Use /approval full-auto to enable it again.`,
          ),
          'warn',
        );
      }
    } catch (e: any) {
      notice(L(`恢复失败：${e?.message || e}`, `Resume failed: ${e?.message || e}`), 'error');
    }
  };

  const openSessionPicker = async (): Promise<void> => {
    let rows: SessionRow[] = [];
    try {
      rows = await listSessions(userId, 50);
    } catch (e: any) {
      notice(L(`列会话失败：${e?.message || e}`, `Failed to list sessions: ${e?.message || e}`), 'error');
      return;
    }
    sessionListRef.current = rows;
    if (!rows.length) {
      notice(L('（暂无历史会话）', '(no past sessions)'));
      return;
    }
    openPicker({
      title: L('恢复会话', 'Resume a session'),
      items: rows.map((r) => ({
        label: r.title,
        keywords: r.id,
        hint: [String(r.id).slice(0, 8), fmtTime(r.updatedAt), r.modelId || ''].filter(Boolean).join(' · '),
        value: r.id,
        current: r.id === sessionIdRef.current,
      })),
      onSelect: (id: string) => void resumeSession(id),
    });
  };

  const runSlash = async (line: string): Promise<void> => {
    const { cmd, rest } = parseSlash(line); // /effort → /think 之类的别名在这里归一

    if (busyRef.current && RUN_AFFECTING.has(cmd)) {
      notice('运行中，请先 Esc 中止', 'warn');
      return;
    }

    switch (cmd) {
      case '/help': {
        const custom = listCustomCommands();
        notice(
          L('命令：', 'Commands:') + '\n' +
            tuiCommands().map((c) => `  ${c.name.padEnd(11)} ${c.desc}`).join('\n') +
            (custom.length
              ? L(`\n\n自定义命令（${commandsDir()}）：\n`, `\n\nCustom commands (${commandsDir()}):\n`) +
                custom.map((c) => `  ${`/${c.name}`.padEnd(11)} ${c.description}`).join('\n')
              : L(`\n\n提示：把提示词存成 ${commandsDir()}/<名字>.md 就能当 /<名字> 用。`, `\n\nTip: save a prompt as ${commandsDir()}/<name>.md to use it as /<name>.`)) +
            L('\n\n快捷键见 /hotkeys。', '\n\nKeyboard shortcuts: /hotkeys.'),
        );
        return;
      }
      case '/exit':
        exit();
        return;
      case '/new':
        newSession();
        notice('已开新会话', 'success');
        return;
      case '/clear':
        dispatch({ type: 'CLEAR_ITEMS' });
        return;
      case '/model': {
        // 目录单源(listModelCatalog):云端托管 + 本机直连 / 订阅(codex/* 等);旧版只看 listGlobalModels。
        if (!rest) {
          await openModelPicker();
          return;
        }
        let models: CatalogModel[] = [];
        let catalogError: string | null = null;
        if (!rest.startsWith('=') && !/^\d+$/.test(rest)) {
          try {
            ({ models, error: catalogError } = await loadCatalog());
          } catch (e: any) {
            catalogError = e?.message || String(e); // 下面按目录为空处理
          }
        }
        const r = resolveModelArg(rest, models, catalogError);
        switch (r.kind) {
          case 'usage':
            notice(L('用法：/model =<模型 id>', 'Usage: /model =<model id>'), 'warn');
            return;
          case 'numeric':
            notice(L(`这里不支持按序号选模型。/model 打开选择器（直接打字过滤），或 /model <名称>；确实叫「${rest}」的 id 请写 /model =${rest}`, `Picking a model by number isn't supported here. Run /model to open the picker (type to filter) or /model <name>; for an id that really is "${rest}", use /model =${rest}`), 'warn');
            return;
          case 'unverified':
            // 逃生口 `=<id>`、目录外的 `provider/model` 完整 id,或目录拉不到:原样接受
            // (只配了 base URL、没列模型的 provider 照旧能用),不做校验 —— applyModel 会提示「未经目录校验」。
            await applyModel(r.id, undefined, true);
            return;
          case 'hit':
            await applyModel(r.model.id, r.model);
            return;
          case 'ambiguous':
            // 完整 id 只有近似的:开已过滤的选择器让人挑,并说清怎么原样用这个 id(绝不替用户换成近似的那个)。
            if (r.asTyped) {
              notice(
                L(
                  `目录里没有「${r.asTyped}」，已列出相近的模型；要原样使用这个 id 请写 /model =${r.asTyped}`,
                  `"${r.asTyped}" isn't in the model catalog; showing close matches. To use this id as typed, run /model =${r.asTyped}`,
                ),
                'warn',
              );
            }
            await openModelPicker(rest);
            return;
          case 'none':
            notice(
              r.catalogError
                ? L(
                    `没有匹配「${rest}」的模型——但云端模型目录拉取失败（${r.catalogError}），列表里只有本机模型。确定 id 无误可写 /model =${rest}`,
                    `No model matches "${rest}" — but the cloud model catalog failed to load (${r.catalogError}), so only local models are listed. If the id is right, use /model =${rest}`,
                  )
                : L(
                    `没有匹配「${rest}」的模型。/model 打开选择器；确定要用目录外的 id 可写 /model =${rest}`,
                    `No model matches "${rest}". Use /model to open the picker, or /model =${rest} to use an id that isn't in the catalog.`,
                  ),
              'error',
            );
            return;
        }
        return;
      }
      case '/approval': {
        // /permissions 已在上面 canonicalCommandName 归一到这里。
        const arg = rest.trim().toLowerCase();
        if (!arg) {
          openApprovalPicker();
          return;
        }
        if (!isApprovalMode(arg)) {
          notice(L(`未知审批档：${rest}（可选 ${APPROVAL_MODE_IDS.join('|')}；不带参数打开选择器）`, `Unknown approval mode: ${rest} (one of ${APPROVAL_MODE_IDS.join('|')}; run it without an argument to open the picker)`), 'error');
          return;
        }
        requestApprovalMode(arg);
        return;
      }
      case '/think': {
        // /effort(codex/PI 的叫法)已在上面归一到 /think。
        if (!rest) {
          openThinkingPicker();
          return;
        }
        const lv = parseThinkingArg(rest);
        if (!lv) {
          notice(L(`无效的思考档：${rest}（可选 ${THINKING_LEVELS.join('|')}）`, `Unknown thinking level: ${rest} (one of ${THINKING_LEVELS.join('|')})`), 'error');
          return;
        }
        applyThinking(lv, true);
        return;
      }
      case '/loop': {
        if (/^\d+$/.test(rest)) {
          const n = Math.min(Math.max(1, parseInt(rest, 10)), 200);
          setCfg((c) => ({ ...c, maxIterations: n }));
          notice(`最大循环轮数已设为 ${n} 轮`, 'success');
        } else {
          notice(`当前最大循环轮数：${cfgRef.current.maxIterations || 90}\n用法：/loop <1-200>`);
        }
        return;
      }
      case '/cwd':
        if (rest) {
          const abs = path.resolve(cfgRef.current.cwd, rest);
          try {
            const st = await fs.stat(abs);
            if (!st.isDirectory()) throw new Error('not a directory');
            setCfg((c) => ({ ...c, cwd: abs }));
            notice(`工作目录已切到 ${abs}`, 'success');
          } catch {
            notice(`目录不存在：${abs}`, 'error');
          }
        } else {
          notice(`当前工作目录：${cfgRef.current.cwd}`);
        }
        return;
      case '/agents': {
        try {
          const all = await listAgents();
          if (!all.length) { notice('（暂无本地 Normal Agent;用设置或 manage_agent 工具创建）'); return; }
          const active = cfgRef.current.activeAgentSlug;
          const lines = all.map((a) => `  ${a.slug === active ? '✓' : ' '} ${a.slug}  ${a.name}${a.description ? ' — ' + a.description : ''}`).join('\n');
          notice('本地 Normal Agent（/agent <slug> 启用,/agent off 取消）：\n' + lines);
        } catch (e: any) { notice(`列 agent 失败：${e?.message || e}`, 'error'); }
        return;
      }
      case '/agent': {
        const parts = rest.split(/\s+/).filter(Boolean);
        const sub = parts[0] || '';
        const arg = parts.slice(1).join(' ').trim();
        // CRUD 子命令:agent 定义即 ~/.tangu/agents/<slug>/config.toml 文件,编辑=直接开文件(mtime 缓存即时热加载)。
        if (sub === 'new') {
          if (!arg) { notice('用法：/agent new <slug>（随后用 $EDITOR 编辑 config.toml）', 'warn'); return; }
          try {
            const def = await saveAgent({ slug: arg, name: arg, systemPrompt: 'You are a helpful assistant.' });
            notice(`已创建 agent「${def.slug}」,打开 config.toml 编辑…`);
            await editFile(path.join(agentsDir(), def.slug, 'config.toml'));
            notice(`agent「${def.slug}」已保存(改动即时生效);/agent ${def.slug} 启用。`, 'success');
          } catch (e: any) { notice(`创建失败：${e?.message || e}`, 'error'); }
          return;
        }
        if (sub === 'edit') {
          if (!arg) { notice('用法：/agent edit <slug>', 'warn'); return; }
          const def = await getAgent(arg);
          if (!def) { notice(`未找到 agent：${arg}`, 'error'); return; }
          await editFile(path.join(agentsDir(), def.slug, 'config.toml'));
          notice(`agent「${def.slug}」已保存(改动即时生效)。`, 'success');
          return;
        }
        if (sub === 'rm') {
          if (!arg) { notice('用法：/agent rm <slug>', 'warn'); return; }
          const ok = await deleteAgent(arg);
          if (ok && cfgRef.current.activeAgentSlug === arg) setCfg((c) => ({ ...c, seedSystem: undefined, activeAgentSlug: undefined }));
          notice(ok ? `已删除 agent：${arg}` : `删除失败（默认 agent 不可删,或不存在）：${arg}`, ok ? 'success' : 'error');
          return;
        }
        // 默认:激活 / 取消(原行为)
        if (!rest || sub === 'off') {
          if (sub === 'off') patchCfg({ seedSystem: undefined, activeAgentSlug: undefined });
          notice(
            sub === 'off'
              ? L('已取消 Normal Agent。', 'Normal agent turned off.')
              : L('用法：/agent <slug> 启用 · /agent off 取消 · /agent new|edit|rm <slug>', 'Usage: /agent <slug> to activate · /agent off to turn off · /agent new|edit|rm <slug>'),
            sub === 'off' ? 'success' : 'warn',
          );
          return;
        }
        const def = await getAgent(rest.trim());
        if (!def) { notice(L(`未找到 agent：${rest}`, `Agent not found: ${rest}`), 'error'); return; }
        // 审批档不随 patch 直接套:定义里的 approval_mode 模型能自己写(manage_agent),full-auto 必须走确认框。
        const { patch, approvalRequest } = agentActivation(def, cfgRef.current);
        if (patch.model !== cfgRef.current.model) setCtxInfo(null);
        patchCfg(patch);
        const lines = [L(`已启用 Normal Agent：${def.name}（${def.slug}）。`, `Normal agent enabled: ${def.name} (${def.slug}).`)];
        if (approvalRequest && needsFullAutoConfirm(cfgRef.current.approvalMode, approvalRequest)) {
          const meta = APPROVAL_MODE_META['full-auto'];
          lines.push(L(`该 Agent 要求审批档「${meta.zh}」（full-auto），需要你确认；取消则保持当前档。`, `This agent asks for the "${meta.en}" approval mode (full-auto); confirm it, or cancel to keep the current mode.`));
        }
        notice(lines.join('\n'), 'success');
        // full-auto → 确认框;其余档由 applyApprovalMode 直接切并单独提示「审批档已切到…」。
        if (approvalRequest) requestApprovalMode(approvalRequest);
        return;
      }
      case '/historian': {
        const c = loadSpecialAgentsConfig().historian;
        const arg = rest.trim();
        if (arg === 'on' || arg === 'off') {
          if (arg === 'on' && !c.modelId && !cfgRef.current.model) { notice('先 /model 选模型再开启', 'warn'); return; }
          saveSpecialAgentsConfig({ historian: { ...c, enabled: arg === 'on', modelId: c.modelId || cfgRef.current.model } });
          notice(`Historian 已${arg === 'on' ? '开启' : '关闭'}`, 'success');
          return;
        }
        try {
          const rows = await query<any[]>(
            `SELECT action, detail, created_at FROM special_agent_log WHERE user_id = ? AND agent = 'historian' ORDER BY created_at DESC LIMIT 15`,
            [userId],
          );
          const head = `Historian：${c.enabled ? '开启' : '关闭'}（模型 ${c.modelId || '未设'}，每 ${c.everyRounds} 轮维护标题+记忆）`;
          const body = rows.length ? rows.map((r) => `  · [${r.action}] ${String(r.detail).slice(0, 60)}`).join('\n') : '  （暂无活动）';
          notice(`${head}\n${body}\n切换：/historian on|off`);
        } catch (e: any) { notice(`读取失败：${e?.message || e}`, 'error'); }
        return;
      }
      case '/muse': {
        const c = loadSpecialAgentsConfig().muse;
        const arg = rest.trim();
        if (arg === 'on' || arg === 'off') {
          if (arg === 'on' && !c.modelId && !cfgRef.current.model) { notice('先 /model 选模型再开启', 'warn'); return; }
          saveSpecialAgentsConfig({ muse: { ...c, enabled: arg === 'on', modelId: c.modelId || cfgRef.current.model } });
          notice(`Muse 已${arg === 'on' ? '开启' : '关闭'}（重启或下个巡检周期生效）`, 'success');
          return;
        }
        try {
          const rows = await query<any[]>(
            `SELECT title, status FROM muse_todos WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 15`,
            [userId],
          );
          const head = `Muse：${c.enabled ? '开启' : '关闭'}（模型 ${c.modelId || '未设'}，每 ${c.restartWindowHours}h 最多重启 ${c.maxRestartsPerWindow} 次 / TODO ${c.maxTodosPerWindow} 条）`;
          const body = rows.length ? rows.map((r) => `  · ${r.title}`).join('\n') : '  （暂无 TODO）';
          notice(`${head}\nTODO：\n${body}\n切换：/muse on|off`);
        } catch (e: any) { notice(`读取失败：${e?.message || e}`, 'error'); }
        return;
      }
      case '/sessions': {
        try {
          const rows = await listSessions(userId);
          sessionListRef.current = rows;
          if (!rows.length) {
            notice('（暂无历史会话）');
            return;
          }
          const lines = rows.map((r, i) => `  ${i + 1}. ${r.title}  ${String(r.id).slice(0, 8)}`).join('\n');
          notice('最近会话（/resume <序号|id>）：\n' + lines);
        } catch (e: any) {
          notice(`列会话失败：${e?.message || e}`, 'error');
        }
        return;
      }
      case '/resume': {
        if (!rest) {
          await openSessionPicker();
          return;
        }
        let id = rest;
        const idx = Number(rest);
        if (Number.isInteger(idx) && idx >= 1 && idx <= sessionListRef.current.length) {
          id = sessionListRef.current[idx - 1].id;
        }
        await resumeSession(id);
        return;
      }
      case '/rename': {
        const title = rest.trim().slice(0, 200);
        if (!title) {
          notice(L('用法：/rename <标题>', 'Usage: /rename <title>'), 'warn');
          return;
        }
        try {
          await ensureSession(sessionIdRef.current, cfgRef.current.model);
          // 与 PATCH /agent/sessions/:id 同口径:只改 title,不动 updated_at(那是消息活动时间)。
          await query(`UPDATE chat_sessions SET title = ? WHERE id = ? AND user_id = ?`, [title, sessionIdRef.current, userId]);
          notice(L(`会话已重命名为「${title}」`, `Session renamed to "${title}"`), 'success');
        } catch (e: any) {
          notice(L(`重命名失败：${e?.message || e}`, `Rename failed: ${e?.message || e}`), 'error');
        }
        return;
      }
      case '/diff': {
        const cwd = cfgRef.current.cwd;
        const r = await collectGitDiff(cwd);
        if (r.kind === 'no_git') notice(L(`找不到 git 命令${r.detail ? `（${r.detail}）` : ''}`, `git was not found${r.detail ? ` (${r.detail})` : ''}`), 'error');
        else if (r.kind === 'no_cwd') notice(L(`工作目录已不存在：${cwd}（/cwd 可切换）`, `The working directory no longer exists: ${cwd} (use /cwd to change it)`), 'error');
        else if (r.kind === 'error') notice(L(`读取 git 改动失败：${r.detail}`, `Failed to read git changes: ${r.detail}`), 'error');
        else if (r.kind === 'not_repo') notice(L(`${cwd} 不在 git 仓库里（/cwd 可切换工作目录）`, `${cwd} is not inside a git repository (use /cwd to change the working directory)`), 'warn');
        else if (r.kind === 'clean') notice(L(`工作区干净：${r.root} 没有改动`, `Working tree clean: no changes in ${r.root}`), 'success');
        else dispatch({ type: 'ADD_NOTICE', text: r.text, tone: 'info', variant: 'diff' });
        return;
      }
      case '/hotkeys': {
        const rows = hotkeyLines();
        const w = Math.max(...rows.map(([k]) => dispWidth(k)));
        notice(L('快捷键：', 'Keyboard shortcuts:') + '\n' + rows.map(([k, d]) => `  ${k}${' '.repeat(w - dispWidth(k))}  ${d}`).join('\n'));
        return;
      }
      case '/branch': {
        // 从当前会话某条 AI 回复(含)处分支出新会话,继承到该点为止的历史,并切入新会话续聊。
        try {
          const replies = await query<any[]>(
            `SELECT id FROM chat_messages WHERE session_id = ? AND role IN ('model', 'assistant')
             ORDER BY timestamp ASC`,
            [sessionIdRef.current],
          );
          if (!replies.length) { notice('当前会话还没有可分支的 AI 回复', 'warn'); return; }
          let pick = replies.length - 1; // 缺省:最近一条回复
          if (rest) {
            const n = Number(rest);
            if (!Number.isInteger(n) || n < 1 || n > replies.length) {
              notice(`用法：/branch [序号]（1-${replies.length}，缺省=最近回复）`, 'warn');
              return;
            }
            pick = n - 1;
          }
          const r = await branchSession({
            sourceSessionId: sessionIdRef.current,
            userId,
            appId: 'tangu',
            messageId: replies[pick].id,
          });
          if (!r) { notice('分支失败：源会话或消息不存在', 'error'); return; }
          const { items } = await loadSessionItems(r.id, 1);
          sessionIdRef.current = r.id;
          setSessionId(r.id);
          setCfg((c) => ({ ...c, seedSystem: undefined }));
          dispatch({ type: 'RESET_SESSION', items });
          notice(`已分支到新会话 ${String(r.id).slice(0, 8)}（继承 ${r.copied} 条消息），继续聊将走新分支`, 'success');
        } catch (e: any) {
          notice(`分支失败：${e?.message || e}`, 'error');
        }
        return;
      }
      case '/memory': {
        try {
          if (rest.trim() === 'edit') {
            if (!deps().brain.memory.setMemory) { notice('当前后端不支持整体覆盖记忆（可用 remember 工具追加）', 'warn'); return; }
            const cur = await deps().brain.memory.getMemory(userId);
            const edited = await editText(cur.content || '', '.md');
            if (edited == null) { notice('已取消编辑', 'warn'); return; }
            await deps().brain.memory.setMemory!(userId, edited);
            notice('长期记忆已更新', 'success');
            return;
          }
          const mem = await deps().brain.memory.getMemory(userId);
          notice('长期记忆（/memory edit 编辑）：\n' + (mem.content?.trim() || '（空）'));
        } catch (e: any) {
          notice(`记忆操作失败：${e?.message || e}`, 'error');
        }
        return;
      }
      case '/log': {
        try {
          const date = /^\d{4}-\d{2}-\d{2}$/.test(rest.trim()) ? rest.trim() : undefined;
          const log = await deps().brain.memory.getLog(userId, date);
          notice(`📒 ${log.date} 日志：\n${log.content?.trim() || '（空）'}`);
        } catch (e: any) {
          notice(`读取日志失败：${e?.message || e}`, 'error');
        }
        return;
      }
      case '/mcp': {
        const mgr = deps().mcp;
        if (!mgr) { notice('未启用 MCP（在 ~/.tangu/mcp.json 配置后重启 tangu）', 'warn'); return; }
        const st = mgr.listStatus();
        if (!st.length) { notice('未配置 MCP server（编辑 ~/.tangu/mcp.json 后重启 tangu）'); return; }
        const dot = (s: string): string => (s === 'connected' ? '●' : s === 'error' ? '✗' : s === 'disabled' ? '○' : '◌');
        const lines = st.map((s) => `  ${dot(s.status)} ${s.name} (${s.transport}) · ${s.toolCount} 工具${s.error ? ` · ${s.error}` : ''}`).join('\n');
        notice(`MCP server（改 ~/.tangu/mcp.json 后重启生效）：\n${lines}`);
        return;
      }
      case '/plugins': {
        try {
          const plugins = discoverPlugins();
          if (!plugins.length) { notice('未发现插件（放入 plugins/ 或设 TANGU_PLUGINS_DIR；TANGU_PLUGINS=off 全关）'); return; }
          const lines = plugins.map((d) => `  · ${d.manifest.id}${d.manifest.name ? ` — ${d.manifest.name}` : ''}`).join('\n');
          notice(`已发现插件（改动需重启 tangu）：\n${lines}`);
        } catch (e: any) { notice(`列插件失败：${e?.message || e}`, 'error'); }
        return;
      }
      case '/groupchat': {
        const arg = rest.trim();
        if (arg === 'off') { groupAgentsRef.current = null; notice('已退出团队模式', 'success'); return; }
        const slugs = arg.split(/\s+/).filter(Boolean);
        if (slugs.length < 2) { notice('用法：/groupchat <slug1> <slug2> […]（≥2 个 Normal Agent；/agents 查看；/groupchat off 退出）', 'warn'); return; }
        const defs = await Promise.all(slugs.map((s) => getAgent(s).catch(() => null)));
        const missing = slugs.filter((_, i) => !defs[i]);
        if (missing.length) { notice(`未找到 agent：${missing.join(', ')}（/agents 查看）`, 'error'); return; }
        groupAgentsRef.current = slugs;
        notice(`团队模式已就绪：${slugs.join(' / ')}。直接发消息即开始多 Agent 协作（/groupchat off 退出）`, 'success');
        return;
      }
      case '/edit': {
        const last = await getLastUserMessageContent(sessionIdRef.current);
        if (last == null) { notice('没有可编辑的消息', 'warn'); return; }
        const edited = await editText(last, '.md');
        if (edited == null) { notice('已取消编辑', 'warn'); return; }
        if (!edited.trim()) { notice('内容为空，未改动', 'warn'); return; }
        await deleteLastExchange(sessionIdRef.current);
        const { items } = await loadSessionItems(sessionIdRef.current, 1);
        dispatch({ type: 'RESET_SESSION', items });
        void submit(edited.trim());
        return;
      }
      case '/delete': {
        const c = await deleteLastExchange(sessionIdRef.current);
        if (c == null) { notice('没有可删除的消息', 'warn'); return; }
        const { items } = await loadSessionItems(sessionIdRef.current, 1);
        dispatch({ type: 'RESET_SESSION', items });
        notice('已删除最近一轮对话', 'success');
        return;
      }
      case '/plan': {
        const next = !cfgRef.current.planMode;
        setCfg((c) => ({ ...c, planMode: next }));
        notice(
          next
            ? '📋 计划模式已开:agent 只有只读工具,调研后用 exit_plan_mode 提交计划求批准(/plan 再次输入可关闭)'
            : '计划模式已关',
          'success',
        );
        return;
      }
      case '/skills': {
        try {
          const skills = (await deps().brain.assets.listSkills?.({ visibleOnly: true, forUser: userId })) || [];
          if (!skills.length) {
            notice('暂无可用技能(把技能放进 ~/.tangu/skills/<id>/SKILL.md;外部引擎技能在桌面端「设置 → Agent CLIs」导入)。');
            return;
          }
          const enabled = new Set(cfgRef.current.enabledSkillIds || []);
          const lines = skills
            .slice(0, 60)
            .map((s: any) => `  ${enabled.has(s.id) ? '✓' : ' '} ${s.id}${s.name && s.name !== s.id ? ` · ${s.name}` : ''}`)
            .join('\n');
          notice(`技能(/skill <id> 启用/停用;✓=本会话已启用):\n${lines}`);
        } catch (e: any) {
          notice(`列技能失败:${e?.message || e}`, 'error');
        }
        return;
      }
      case '/skill': {
        if (!rest) {
          notice('用法:/skill <id>(先 /skills 查看;再次执行同 id 即停用)', 'warn');
          return;
        }
        const cur = new Set(cfgRef.current.enabledSkillIds || []);
        if (cur.has(rest)) {
          cur.delete(rest);
          notice(`技能已停用:${rest}`, 'success');
        } else {
          cur.add(rest);
          notice(`技能已启用:${rest}(本会话生效)`, 'success');
        }
        setCfg((c) => ({ ...c, enabledSkillIds: [...cur] }));
        return;
      }
      case '/refine': {
        // 复盘轮:当普通消息发出,引擎检测 /refine 前缀注入单源复盘指令(agentLoop;与 /skill 同尾部通道)。
        // 发归一化文本而非原 line:引擎检测大小写敏感,用户敲 /REFINE 会静默不触发(Codex 评审 #10)。
        if (cfgRef.current.execMode !== 'host') {
          notice('/refine 仅本机(host)会话可用(工作笔记写在本机 agent 目录)', 'warn');
          return;
        }
        const outgoing = '/refine' + (rest ? ` ${rest}` : '');
        dispatch({ type: 'ADD_USER', text: outgoing });
        startRun(outgoing);
        return;
      }
      case '/tools': {
        // 口径对齐 agentLoop 真实 toolCtx:planMode / per-agent allow-deny / profile 都参与筛选,
        // deferred 工具单列(目录态,经 load_tools 解锁)。旧版手拼 ctx 报的不是这一局的真实工具面。
        const c = cfgRef.current;
        const agentDef = c.activeAgentSlug ? await getAgent(c.activeAgentSlug) : null;
        const ctx: any = {
          userId, sessionId: sessionIdRef.current, appId: 'tangu', profile: deps().profile,
          execMode: c.execMode, cwd: c.cwd, planMode: !!c.planMode,
          enabledSkillIds: c.enabledSkillIds || [], // /skill 开过的技能会解锁 use_skill,别写死空数组
          toolsMode: agentDef?.toolsMode, toolsList: agentDef?.toolsList,
          unlockedTools: new Set<string>(), unlockTools: () => {}, // load_tools 真实在场(registry 按 unlockTools 有无判定)
        };
        const names = getToolDefinitions(ctx).map((d) => d.function.name);
        const deferred = listDeferredTools(ctx).map((d) => d.name);
        notice(
          `当前可用工具（${c.execMode}${c.planMode ? ' · 计划模式' : ''}${c.activeAgentSlug ? ` · agent:${c.activeAgentSlug}` : ''}）：\n  ${names.join(', ')}` +
            (deferred.length ? `\n按需加载（load_tools 解锁后可用）：\n  ${deferred.join(', ')}` : ''),
        );
        return;
      }
      case '/status': {
        // PI/Codex 借鉴:一条命令看全「这局在什么条件下跑」——排「怎么和我想的不一样」先看它。
        const c = cfgRef.current;
        const u = stateRef.current.usage;
        const agent = c.activeAgentSlug || L('(默认)', '(default)');
        const group = groupAgentsRef.current?.length ? groupAgentsRef.current.join(', ') : L('关', 'off');
        // 标签列按显示宽度对齐(中文一字两列)。
        const rows: Array<[string, string]> = [
          [L('模型', 'Model'), c.model || L('(未设置)', '(not set)')],
          [L('思考', 'Thinking'), `${thinkingLabel(c.thinkingLevel, effectiveThinking())}${c.planMode ? L(' · 计划模式开', ' · plan mode on') : ''}`],
          [L('审批', 'Approval'), `${approvalLabel(c.approvalMode)} (${c.approvalMode}) · ${L('执行', 'exec')} ${c.execMode}`],
          [L('工作目录', 'Cwd'), c.cwd],
          ['Agent', `${agent} · ${L('团队', 'team')} ${group}`],
          [L('循环上限', 'Max steps'), `${c.maxIterations ?? 90} · ${L('预算', 'budget')} ${c.tokenBudget ?? L('无', 'none')}`],
          [L('用量', 'Usage'), L(`${u.total.toLocaleString()} tokens · 约 ${u.cost.toFixed(4)} 费用单位`, `${u.total.toLocaleString()} tokens · ~${u.cost.toFixed(4)} cost units`)],
        ];
        const w = Math.max(...rows.map(([k]) => dispWidth(k)));
        notice(
          [
            L(`会话 ${String(sessionIdRef.current).slice(0, 8)} · ${stateRef.current.items.length} 条消息`, `Session ${String(sessionIdRef.current).slice(0, 8)} · ${stateRef.current.items.length} messages`),
            ...rows.map(([k, v]) => `  ${k}${' '.repeat(w - dispWidth(k))}  ${v}`),
          ].join('\n'),
        );
        return;
      }
      case '/export': {
        const items = stateRef.current.items;
        if (!items.length) {
          notice('本会话还没有内容可导出', 'warn');
          return;
        }
        const target = rest
          ? path.resolve(cfgRef.current.cwd, rest)
          : path.resolve(cfgRef.current.cwd, `tangu-${String(sessionIdRef.current).slice(0, 8)}.md`);
        void fs
          .writeFile(target, renderSessionMarkdown(items, cfgRef.current.model))
          .then(() => notice(`已导出：${target}`, 'success'))
          .catch((e: any) => notice(`导出失败：${e?.message || e}`, 'error'));
        return;
      }
      case '/cost': {
        const u = stateRef.current.usage;
        notice(`本会话用量：${u.total.toLocaleString()} tokens · 约 ${u.cost.toFixed(4)} 费用单位${u.cached > 0 ? ` · 缓存命中 ${u.cached.toLocaleString()} tokens` : ''}`);
        return;
      }
      case '/copy': {
        const items = stateRef.current.items;
        const lastA = [...items].reverse().find((it) => it.kind === 'assistant');
        const text =
          lastA && lastA.kind === 'assistant'
            ? lastA.blocks.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n\n')
            : '';
        if (text.trim()) {
          copyToClipboardOSC52(text);
          notice('已复制上一条回复到剪贴板', 'success');
        } else {
          notice('没有可复制的回复', 'warn');
        }
        return;
      }
      case '/retry': {
        const items = stateRef.current.items;
        const lastU = [...items].reverse().find((it) => it.kind === 'user');
        if (lastU && lastU.kind === 'user') void submit(lastU.text);
        else notice('没有可重试的消息', 'warn');
        return;
      }
      case '/config':
        notice(
          `设置：\n  model=${cfgRef.current.model}\n  cwd=${cfgRef.current.cwd}\n  执行=${cfgRef.current.execMode}\n  审批=${cfgRef.current.approvalMode}\n  思考=${cfgRef.current.thinkingLevel}\n  预算=${cfgRef.current.tokenBudget ?? '无'}\n  session=${String(sessionIdRef.current).slice(0, 8)}`,
        );
        return;
      case '/login':
        notice('请退出后运行 `tangu login` 重新登录（会话内热切换暂不支持）。', 'warn');
        return;
      case '/compact':
        if (!cfgRef.current.model) {
          notice(noModelNotice(), 'warn');
          return;
        }
        if (activeRunId.current) {
          notice('有运行中的任务，待其结束后再压缩。', 'warn');
          return;
        }
        notice(rest ? `正在压缩上下文(关注:${rest})…` : '正在压缩上下文…');
        // 旋钮与自动压缩同一契约:当前 Agent 的 [compaction] 表 > config.json > 缺省
        void (async () => {
          const def = cfgRef.current.activeAgentSlug ? await getAgent(cfgRef.current.activeAgentSlug).catch(() => null) : null;
          return compactSession(sessionIdRef.current, cfgRef.current.model, 'tangu', undefined, {
            focus: rest || undefined, settings: resolveCompactionSettings(def?.compaction, globalCompactionLayer()),
          });
        })()
          .then((r) =>
            r.ok
              ? notice(`已压缩：折叠 ${r.summarizedCount ?? 0} 条消息为摘要，后续对话从此精简续接。`)
              : notice(`无需压缩：${r.reason || '没有可压缩的内容'}`, 'warn'),
          )
          .catch((e: any) => notice(`压缩失败：${e?.message || e}`, 'error'));
        return;
      default: {
        // 内置没命中 → 查用户自定义命令（~/.tangu/commands/*.md）：展开成普通消息发出去。
        const custom = getCustomCommand(cmd);
        if (custom) {
          void submit(expandCustomCommand(custom, rest));
          return;
        }
        notice(`未知命令：${cmd}（/help 看全部）`, 'error');
        return;
      }
    }
  };

  const submit = async (text: string): Promise<void> => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) {
      void runSlash(t);
      return;
    }
    if (!busyRef.current && !cfgRef.current.model) {
      notice(noModelNotice(), 'warn');
      return;
    }
    const q: QueuedMessage = { id: randomUUID(), display: text, message: await augmentMentions(text) };
    // 空闲(augment 之后再看一次:期间可能已有别的 run 起跑)→ 直接起 run。
    const runId = activeRunId.current;
    if (!runId) {
      if (startRun(q.message)) dispatch({ type: 'ADD_USER', text }); // 用户气泡进 Static,live 区在它下面照常流
      return;
    }
    // 运行中的普通消息 = 插话(PI 的 steer):交给引擎,在当前运行的下一步(下一次模型请求前)注入,
    // 注入时(turn_boundary)才作为用户气泡上屏;引擎暂不收(run 还在排队 / 正在收尾)→ 排队,运行结束后自动发。
    // slash 命令不走这里(见 runSlash 的 RUN_AFFECTING)。
    if (enqueueSteer(runId, { id: q.id, content: q.message })) {
      steersRef.current.push(q);
      syncQueues();
      notice(L('↪ 已插话：将在当前运行的下一步注入', "↪ Steering: your message will be injected at the run's next step"));
    } else {
      followUpsRef.current.push(q);
      syncQueues();
      notice(L('⏭ 当前运行暂时无法插话：已排队，运行结束后自动发送', '⏭ The run cannot take a message right now: queued, it will be sent automatically when the run finishes'));
    }
  };

  const abortActive = (): void => {
    const rid = activeRunId.current;
    if (!rid) return;
    preStartAbort.current = rid; // 引擎里还没注册时 abortRun 是空操作:起跑链看到这个标记会自己收手
    abortRun(rid);
  };

  // 前台浮层(审批 > 询问 > 选择器)开着时,输入框让出键盘但不卸载 —— 草稿与光标都留着。
  const overlay = !!(state.approval || state.inquiry || picker);

  return (
    <Box flexDirection="column">
      <Static items={state.items}>{(item) => <ItemView key={item.id} item={item} />}</Static>
      {state.live ? <LiveView blocks={state.live} /> : null}
      <TodoPanel todos={state.todos} />
      <StatusBar
        model={cfg.model}
        cwd={cfg.cwd}
        execMode={cfg.execMode}
        approvalMode={cfg.approvalMode}
        status={state.status}
        tokens={state.usage.total}
        ctxPct={cfg.model ? (state.usage.lastPrompt / effectiveContextWindowInfo(cfg.model).tokens) * 100 : 0}
        busy={state.busy}
        thinking={thinkingLabel(cfg.thinkingLevel, effectiveThinking())}
        planMode={cfg.planMode}
        agentSlug={cfg.activeAgentSlug}
        queued={queues.steers.length + queues.followUps.length}
      />
      {state.approval ? (
        <ApprovalPrompt
          approval={state.approval}
          onDecision={(d: ApprovalDecision) => {
            resolveApproval(state.approval!.approvalId, d);
            dispatch({ type: 'APPROVAL_CLEAR' });
          }}
          onAbort={abortActive}
        />
      ) : state.inquiry ? (
        <InquiryPrompt
          inquiry={state.inquiry}
          onAnswer={(answer) => {
            resolveInquiry(state.inquiry!.inquiryId, answer);
            dispatch({ type: 'INQUIRY_CLEAR' });
          }}
          onAbort={abortActive}
        />
      ) : picker ? (
        <SelectPrompt
          key={picker.id}
          title={picker.title}
          subtitle={picker.subtitle}
          items={picker.items}
          initialQuery={picker.initialQuery}
          initialValue={picker.initialValue}
          tone={picker.tone}
          onSelect={(v) => {
            setPicker(null); // 先关再回调:回调里可能紧接着开下一个(完全放行确认)
            picker.onSelect(v);
          }}
          onCancel={() => {
            setPicker(null);
            picker.onCancel?.();
          }}
        />
      ) : null}
      <Box flexDirection="column" display={overlay ? 'none' : 'flex'}>
        {queues.steers.map((q) => (
          <Text key={q.id} color={theme.dim} wrap="truncate-end">
            {`  ↪ ${L('待注入', 'steer pending')}: ${clip(q.display)}`}
          </Text>
        ))}
        {queues.followUps.map((q) => (
          <Text key={q.id} color={theme.dim} wrap="truncate-end">
            {`  ⏭ ${L('运行结束后发送', 'sends after this run')}: ${clip(q.display)}`}
          </Text>
        ))}
        <InputBox
          busy={state.busy}
          cwd={cfg.cwd}
          active={!overlay}
          onSubmit={(txt) => void submit(txt)}
          onAbort={abortActive}
          onExit={() => exit()}
          onCycleThinking={cycleThinking}
          onOpenModelPicker={() => void openModelPicker()}
        />
      </Box>
    </Box>
  );
}
