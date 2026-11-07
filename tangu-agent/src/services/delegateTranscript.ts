import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { v4 as uuidv4 } from 'uuid';
import type { ToolContext } from '../tools/registry.js';

const activeDelegates = new Set<string>();
export const isDelegateActive = (sessionId: string): boolean => activeDelegates.has(sessionId);
/** Read-only shutdown inventory; delegates have no independent agent_run row. */
export const activeDelegateCount = (): number => activeDelegates.size;
/** 续用占位:判断与登记之间没有 await,同一子代理被并行续用时只有一个拿得到。 */
export function claimDelegate(id: string): boolean {
  if (activeDelegates.has(id)) return false;
  activeDelegates.add(id);
  return true;
}
export const releaseDelegate = (id: string): void => { activeDelegates.delete(id); };

export interface ResumableDelegate { id: string; title: string; agentSlug?: string; instructions?: string; grants: string[]; engineId?: string }

/** 回报里给模型的 subagent id = 子会话 id 的前 8 位。36 位 UUID 模型真会抄错(live 10-30:中段串了一位,续用落空)。 */
export const delegateHandle = (id: string): string => id.slice(0, 8);

/** 续用只认**本会话**自己派出的 delegate 子会话(kind + 父会话 + 用户三项全中),别的后台会话一律查无此人。
 *  短 id 按前缀匹配,范围只有本会话的子代理;多于一条就当查不到,绝不猜。全长 id 同样认。
 *  配置解析不了就抛:授予读不出来不等于没有授予,不能当空往下跑。 */
export async function findDelegate(handle: string, parent: Pick<ToolContext, 'sessionId' | 'userId'>): Promise<ResumableDelegate | null> {
  if (!parent.sessionId || !/^[0-9a-f-]{8,36}$/.test(handle)) return null; // 同时挡住 LIKE 的通配符
  const rows = await query<any[]>(
    `SELECT id, title, agent_config FROM chat_sessions WHERE id LIKE ? AND kind = 'delegate' AND parent_session_id = ? AND user_id = ?`,
    [`${handle}%`, parent.sessionId, parent.userId],
  );
  if (rows.length !== 1) return null;
  const [row] = rows;
  const cfg = typeof row.agent_config === 'string' ? JSON.parse(row.agent_config) : row.agent_config;
  return {
    id: String(row.id), title: String(row.title || ''), agentSlug: cfg?.delegateAgentSlug, instructions: cfg?.delegateInstructions,
    grants: Array.isArray(cfg?.subAgentGrants) ? cfg.subAgentGrants : [], engineId: cfg?.engineId,
  };
}

/** Persist the existing delegate loop without changing its tools, approvals or execution ownership. */
export async function createDelegateTranscript(id: string, parent: ToolContext, title: string, modelId: string, task: string, config: Record<string, unknown>) {
  const messageId = `delegate:${id}`;
  const agentConfig = {
    execMode: parent.execMode, cwd: parent.cwd, extraRoots: parent.extraRoots,
    approvalMode: parent.approvalMode, preset: parent.preset, thinkingLevel: parent.thinkingLevel,
    ...config,
    delegatedFrom: parent.sessionId,
    delegatedBy: parent.agentSlug,
  };
  await query('INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, agent_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, parent.userId, parent.appId, title, modelId, 'delegate', parent.sessionId, JSON.stringify(agentConfig)]);
  return openDelegateTurn(id, messageId, modelId, task, typeof config.agentSlug === 'string' ? config.agentSlug : undefined);
}

/** 在子会话里记一轮(用户行 + assistant 行)。续用时子会话已在,只走这里;messageId 每轮一枚。 */
export async function openDelegateTurn(id: string, messageId: string, modelId: string, task: string, agentSlug?: string) {
  const userMessageId = uuidv4();
  await deps().state.insertUserMessage({ id: userMessageId, sessionId: id, modelId, content: task, attachments: null });
  const message = { messageId, sessionId: id, modelId, content: '', reasoning: '', toolCalls: [] as any[], toolResults: [] as any[], agentSlug };
  let chain = Promise.resolve();
  const save = () => {
    const snapshot = { ...message, toolCalls: [...message.toolCalls], toolResults: [...message.toolResults] };
    chain = chain.then(() => deps().state.finalizeAssistantMessage(snapshot));
    return chain;
  };
  await save();
  activeDelegates.add(id);
  return {
    messageId,
    userMessageId,
    token(delta: string) { message.content += delta; },
    reasoning(delta: string) { message.reasoning += delta; },
    tool(id: string, name: string, args: string, result: string, isError: boolean) {
      message.toolCalls.push({ id, type: 'function', function: { name, arguments: args }, ui_content_offset: message.content.length });
      message.toolResults.push({ tool_call_id: id, name, content: result, isError });
    },
    save,
    async finish(content?: string) {
      if (!message.content && content) message.content = content;
      try { await save(); } finally { activeDelegates.delete(id); }
    },
  };
}
