import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react';
import { Box, Static, useApp } from 'ink';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun } from '../services/runStore.js';
import { enqueueRun, abortRun } from '../services/agentLoop.js';
import { subscribe } from '../services/eventBus.js';
import { compactSession } from '../services/compaction.js';
import { modelContextWindow } from '../services/contextBudget.js';
import { listAgents, getAgent } from '../agents/agentRegistry.js';
import { loadSpecialAgentsConfig, saveSpecialAgentsConfig } from '../services/specialAgentsConfig.js';
import { resolveApproval, type ApprovalDecision } from '../services/approvals.js';
import { resolveInquiry } from '../services/inquiries.js';
import { saveModel } from '../standalone/credStore.js';
import { getToolDefinitions } from '../tools/registry.js';
import { reducer, initialState } from './events.js';
import { listSessions, loadSessionItems, type SessionRow } from './sessions.js';
import { COMMANDS, copyToClipboardOSC52 } from './commands.js';
import { ItemView, LiveView } from './components/Message.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { InquiryPrompt } from './components/InquiryPrompt.js';
import type { TuiConfig } from './config.js';
import type { ApprovalMode } from './types.js';

const RUN_AFFECTING = new Set(['/new', '/resume', '/retry', '/compact']);

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

  const notice = (text: string, tone: 'info' | 'error' | 'success' | 'warn' = 'info'): void =>
    dispatch({ type: 'ADD_NOTICE', text, tone });

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
        if (!rest || rest.trim() === 'off') {
          setCfg((c) => ({ ...c, seedSystem: undefined, activeAgentSlug: undefined }));
          notice(rest.trim() === 'off' ? '已取消 Normal Agent。' : '用法：/agent <slug>（/agents 列出,/agent off 取消）', rest.trim() === 'off' ? 'success' : 'warn');
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
          const head = `Historian：${c.enabled ? '开启' : '关闭'}（模型 ${c.modelId || '未设'}，标题每 ${c.everyTitleRounds} 轮 / 记忆每 ${c.everyMemoryRounds} 轮）`;
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
      case '/memory': {
        try {
          const mem = await deps().brain.memory.getMemory(userId);
          notice('长期记忆：\n' + (mem.content?.trim() || '（空）'));
        } catch (e: any) {
          notice(`读取记忆失败：${e?.message || e}`, 'error');
        }
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
            notice('暂无可用技能(本地技能放 ~/.tangu/skills/<id>/SKILL.md,自动识别 ~/.claude/skills)。');
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
