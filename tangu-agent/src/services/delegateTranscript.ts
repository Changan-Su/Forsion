import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { v4 as uuidv4 } from 'uuid';
import type { ToolContext } from '../tools/registry.js';

const activeDelegates = new Set<string>();
export const isDelegateActive = (sessionId: string): boolean => activeDelegates.has(sessionId);

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
  await deps().state.insertUserMessage({ id: uuidv4(), sessionId: id, modelId, content: task, attachments: null });
  const message = { messageId, sessionId: id, modelId, content: '', reasoning: '', toolCalls: [] as any[], toolResults: [] as any[], agentSlug: typeof config.agentSlug === 'string' ? config.agentSlug : undefined };
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
