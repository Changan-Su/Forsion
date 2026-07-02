import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react';
import { Box, Static, useApp, useStdin } from 'ink';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun } from '../services/runStore.js';
import { enqueueRun, abortRun } from '../services/agentLoop.js';
import { subscribe } from '../services/eventBus.js';
import { compactSession } from '../services/compaction.js';
import { branchSession } from '../services/sessionBranch.js';
import { modelContextWindow } from '../services/contextBudget.js';
import { listAgents, getAgent, saveAgent, deleteAgent } from '../agents/agentRegistry.js';
import { agentsDir } from '../core/tanguHome.js';
import { discoverPlugins } from '../plugins/loader.js';
import { loadSpecialAgentsConfig, saveSpecialAgentsConfig } from '../services/specialAgentsConfig.js';
import { resolveApproval, type ApprovalDecision } from '../services/approvals.js';
import { resolveInquiry } from '../services/inquiries.js';
import { saveModel } from '../standalone/credStore.js';
import { getToolDefinitions } from '../tools/registry.js';
import { reducer, initialState } from './events.js';
import { listSessions, loadSessionItems, type SessionRow } from './sessions.js';
import { COMMANDS, copyToClipboardOSC52 } from './commands.js';
import { getLastUserMessageContent, deleteLastExchange } from './messageOps.js';
import { ItemView, LiveView, TodoPanel } from './components/Message.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { InquiryPrompt } from './components/InquiryPrompt.js';
import type { TuiConfig } from './config.js';
import type { ApprovalMode } from './types.js';

const RUN_AFFECTING = new Set(['/new', '/resume', '/retry', '/compact', '/branch', '/edit', '/delete']);

/** 群聊结束原因 → 中文。 */
function groupReason(r: string): string {
  return r === 'vote' ? '投票通过' : r === 'cost_limit' ? '达到花费上限' : r === 'quota' ? '额度不足' : '达到轮数上限';
}

interface MutableConfig {
  model: string;
  cwd: string;
  execMode: 'host' | 'sandbox';
  approvalMode: ApprovalMode;
  tokenBudget?: number;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  seedSystem?: string;
  /** 最大循环轮数(/loop 调节;缺省由后端取默认 90,后端 clamp 1-200)。 */
  maxIterations?: number;
  /** 计划模式(/plan 切换):只读工具集 + exit_plan_mode,批准后自动关闭。 */
  planMode?: boolean;
  /** 本会话启用的技能 id(/skill <id> 切换;/skills 列出)。 */
  enabledSkillIds?: string[];
  /** 当前启用的 Normal Agent slug(/agent <slug>;仅用于 /agents 显示 ✓,seedSystem 已注入)。 */
  activeAgentSlug?: string;
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
  const unsubRef = useRef<null | (() => void)>(null);
  const pendingText = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionListRef = useRef<SessionRow[]>([]);
  /** 已就绪的群聊参与者 slug(/groupchat 设置;非空时每条消息走多 Agent 群聊;/groupchat off 清空)。 */
  const groupAgentsRef = useRef<string[] | null>(null);

  const { setRawMode } = useStdin();

  const notice = (text: string, tone: 'info' | 'error' | 'success' | 'warn' = 'info'): void =>
    dispatch({ type: 'ADD_NOTICE', text, tone });

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

  useEffect(() => {
    void ensureSession(sessionIdRef.current, cfgRef.current.model);
    if (!cfgRef.current.model) {
      notice('未设置模型：用 /model <id> 选择（/model 查看可用，支持 <provider>/<model>）', 'warn');
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
        dispatch({ type: 'USAGE', tokens: (p.prompt || 0) + (p.completion || 0), cost: p.cost || 0, cached: p.cached || 0, iteration: p.iteration || 0, prompt: p.prompt || 0 });
        break;
      case 'status':
        dispatch({ type: 'STATUS', state: p.state, iteration: p.iteration, phase: p.phase });
        break;
      case 'approval_request':
        flushNow();
        dispatch({ type: 'APPROVAL', approval: { approvalId: p.approvalId, name: p.name, args: p.arguments || '', preview: p.preview || '' } });
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
          dispatch({ type: 'GROUP_NOTE', text: `🗣 ${p.name || p.slug}${p.round ? `  ·  第 ${p.round} 轮` : ''}`, tone: 'info' });
        }
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
        dispatch({ type: 'GROUP_NOTE', text: `🏁 群聊结束（${p.rounds} 轮 · ${groupReason(String(p.reason || ''))}）`, tone: 'success' });
        break;
      case 'done':
        flushNow();
        teardownRun();
        dispatch({ type: 'DONE' });
        break;
      case 'error':
        flushNow();
        teardownRun();
        dispatch({ type: 'ERROR', msg: String(p.error || 'error'), aborted: !!p.aborted });
        break;
    }
  };

  const startRun = (message: string): void => {
    if (activeRunId.current) return;
    if (!cfgRef.current.model) {
      notice('未设置模型：先用 /model <id> 选择（/model 查看可用）', 'warn');
      return;
    }
    const runId = randomUUID();
    activeRunId.current = runId;
    dispatch({ type: 'START_LIVE' });
    unsubRef.current = subscribe(runId, (ev) => handleEvent(ev));
    const sid = sessionIdRef.current;
    const c = cfgRef.current;
    const agentConfig: Record<string, any> = { execMode: c.execMode, cwd: c.cwd, approvalMode: c.approvalMode };
    if (c.seedSystem) agentConfig.systemPrompt = c.seedSystem;
    if (c.tokenBudget) agentConfig.tokenBudget = c.tokenBudget;
    if (c.thinkingLevel && c.thinkingLevel !== 'off') agentConfig.thinkingLevel = c.thinkingLevel;
    if (c.maxIterations) agentConfig.maxIterations = c.maxIterations;
    if (c.planMode) agentConfig.planMode = true;
    if (c.enabledSkillIds?.length) agentConfig.enabledSkillIds = c.enabledSkillIds;
    // 群聊就绪 → 本条消息走多 Agent 群聊(agentLoop 据 groupChat+capabilities.groupChat 分流到 runGroupChat)。
    if (groupAgentsRef.current && groupAgentsRef.current.length >= 2) {
      agentConfig.groupChat = true;
      agentConfig.groupAgents = groupAgentsRef.current;
    }
    createRun({
      id: runId,
      sessionId: sid,
      userId,
      appId: 'tangu',
      modelId: c.model,
      assistantMessageId: randomUUID(),
      input: { message, userMessageId: randomUUID(), attachments: [], agentConfig },
    })
      .then(() => enqueueRun(sid, runId))
      .catch((e: any) => {
        teardownRun();
        dispatch({ type: 'ERROR', msg: e?.message || String(e) });
      });
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
    void ensureSession(nid, cfgRef.current.model);
    dispatch({ type: 'RESET_SESSION' });
  };

  const runSlash = async (line: string): Promise<void> => {
    const sp = line.indexOf(' ');
    const cmd = (sp >= 0 ? line.slice(0, sp) : line).toLowerCase();
    const rest = sp >= 0 ? line.slice(sp + 1).trim() : '';

    if (busyRef.current && RUN_AFFECTING.has(cmd)) {
      notice('运行中，请先 Esc 中止', 'warn');
      return;
    }

    switch (cmd) {
      case '/help':
        notice('命令：\n' + COMMANDS.map((c) => `  ${c.name.padEnd(11)} ${c.desc}`).join('\n'));
        return;
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
      case '/model':
        if (rest) {
          setCfg((c) => ({ ...c, model: rest }));
          saveModel(rest); // 记住，下次免 --model
          notice(`模型已切到 ${rest}（已记住，下次直接 tangu 即用）`, 'success');
        } else {
          let list = '';
          try {
            const models = await deps().brain.models.listGlobalModels();
            if (Array.isArray(models) && models.length) {
              const lines = models
                .slice(0, 50)
                .map((m: any) => `  ${m.id || m.model_id || m.name}${m.name && m.name !== m.id ? ` · ${m.name}` : ''}${m.provider ? ` (${m.provider})` : ''}`)
                .join('\n');
              list = '\n可用模型（/model <id> 选择）：\n' + lines;
            } else {
              list = '\n（brain-api 未返回模型：确认 admin 已启用模型，且 Forsion server 已重启以加载 /brain/models 接口）';
            }
          } catch (e: any) {
            list = `\n（拉取模型列表失败：${e?.message || e}）`;
          }
          notice(`当前模型：${cfgRef.current.model || '(未设置)'}${list}\n用法：/model <id>（也支持 <provider>/<model>）`);
        }
        return;
      case '/approval':
        if (rest === 'readonly' || rest === 'auto-edit' || rest === 'full-auto') {
          setCfg((c) => ({ ...c, approvalMode: rest }));
          notice(`审批档已切到 ${rest}`, 'success');
        } else {
          notice(`当前审批档：${cfgRef.current.approvalMode}\n用法：/approval readonly|auto-edit|full-auto`);
        }
        return;
      case '/think':
        if (rest === 'off' || rest === 'low' || rest === 'medium' || rest === 'high') {
          setCfg((c) => ({ ...c, thinkingLevel: rest }));
          notice(`思考强度已设为 ${rest}${rest === 'off' ? '' : '（思考内容默认折叠，流式时展开）'}`, 'success');
        } else {
          notice(`当前思考强度：${cfgRef.current.thinkingLevel}\n用法：/think off|low|medium|high`);
        }
        return;
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
          setCfg((c) => ({ ...c, seedSystem: undefined, activeAgentSlug: undefined }));
          notice(sub === 'off' ? '已取消 Normal Agent。' : '用法：/agent <slug> 启用 · /agent off 取消 · /agent new|edit|rm <slug>', sub === 'off' ? 'success' : 'warn');
          return;
        }
        const def = await getAgent(rest.trim());
        if (!def) { notice(`未找到 agent：${rest}`, 'error'); return; }
        setCfg((c) => ({
          ...c,
          seedSystem: def.systemPrompt,
          activeAgentSlug: def.slug,
          model: def.model || c.model,
          thinkingLevel: (def.thinkingLevel || c.thinkingLevel) as MutableConfig['thinkingLevel'],
          maxIterations: def.maxIterations || c.maxIterations,
          approvalMode: (def.approvalMode || c.approvalMode) as ApprovalMode,
        }));
        notice(`已启用 Normal Agent：${def.name}（${def.slug}）。`, 'success');
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
          notice('用法：/resume <序号|会话 id>（先 /sessions 查看）', 'warn');
          return;
        }
        let id = rest;
        const idx = Number(rest);
        if (Number.isInteger(idx) && idx >= 1 && idx <= sessionListRef.current.length) {
          id = sessionListRef.current[idx - 1].id;
        }
        try {
          const { items } = await loadSessionItems(id, 1);
          sessionIdRef.current = id;
          setSessionId(id);
          setCfg((c) => ({ ...c, seedSystem: undefined }));
          dispatch({ type: 'RESET_SESSION', items });
          notice(`已恢复会话 ${String(id).slice(0, 8)}（${items.length} 条历史）`, 'success');
        } catch (e: any) {
          notice(`恢复失败：${e?.message || e}`, 'error');
        }
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
        if (arg === 'off') { groupAgentsRef.current = null; notice('已退出群聊模式', 'success'); return; }
        const slugs = arg.split(/\s+/).filter(Boolean);
        if (slugs.length < 2) { notice('用法：/groupchat <slug1> <slug2> […]（≥2 个 Normal Agent；/agents 查看；/groupchat off 退出）', 'warn'); return; }
        const defs = await Promise.all(slugs.map((s) => getAgent(s).catch(() => null)));
        const missing = slugs.filter((_, i) => !defs[i]);
        if (missing.length) { notice(`未找到 agent：${missing.join(', ')}（/agents 查看）`, 'error'); return; }
        groupAgentsRef.current = slugs;
        notice(`群聊已就绪：${slugs.join(' / ')}。直接发消息即开始多 Agent 讨论（/groupchat off 退出）`, 'success');
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
      case '/tools': {
        const ctx: any = { userId, sessionId: sessionIdRef.current, appId: 'tangu', execMode: cfgRef.current.execMode, enabledSkillIds: [] };
        const names = getToolDefinitions(ctx).map((d) => d.function.name);
        notice(`当前可用工具（${cfgRef.current.execMode}）：\n  ${names.join(', ')}`);
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
          notice('未设置模型：先用 /model <id> 选择', 'warn');
          return;
        }
        if (activeRunId.current) {
          notice('有运行中的任务，待其结束后再压缩。', 'warn');
          return;
        }
        notice('正在压缩上下文…');
        void compactSession(sessionIdRef.current, cfgRef.current.model)
          .then((r) =>
            r.ok
              ? notice(`已压缩：折叠 ${r.summarizedCount ?? 0} 条消息为摘要，后续对话从此精简续接。`)
              : notice(`无需压缩：${r.reason || '没有可压缩的内容'}`, 'warn'),
          )
          .catch((e: any) => notice(`压缩失败：${e?.message || e}`, 'error'));
        return;
      default:
        notice(`未知命令：${cmd}（/help 看全部）`, 'error');
        return;
    }
  };

  const submit = async (text: string): Promise<void> => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) {
      void runSlash(t);
      return;
    }
    if (busyRef.current) {
      notice('运行中…按 Esc 中止后再发送', 'warn');
      return;
    }
    if (!cfgRef.current.model) {
      notice('未设置模型：先用 /model <id> 选择（/model 查看可用，支持 <provider>/<model>）', 'warn');
      return;
    }
    dispatch({ type: 'ADD_USER', text });
    const msg = await augmentMentions(text);
    startRun(msg);
  };

  const abortActive = (): void => {
    if (activeRunId.current) abortRun(activeRunId.current);
  };

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
        ctxPct={cfg.model ? (state.usage.lastPrompt / modelContextWindow(cfg.model)) * 100 : 0}
        busy={state.busy}
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
      ) : (
        <InputBox busy={state.busy} cwd={cfg.cwd} onSubmit={(txt) => void submit(txt)} onAbort={abortActive} onExit={() => exit()} />
      )}
    </Box>
  );
}
