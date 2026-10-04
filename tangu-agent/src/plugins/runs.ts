/** Local, plugin-owned task sessions. Never borrow an Agent's private-session identity. */
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { query, getDbType } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { currentRunId } from '../seams/runContext.js';
import { createRun, getRun, listEventsFrom } from '../services/runStore.js';
import { subscribe } from '../services/eventBus.js';
import { listPrompts } from '../services/pendingPromptIndex.js';
import { readProjectSettings } from '../services/projectContext.js';
import { storedApprovalMode } from '../services/approvals.js';
import { getAgent } from '../agents/agentRegistry.js';
import { isHostSandboxRestricted } from '../sandbox/hostSandboxPolicy.js';
import { effectiveRemote } from '../services/remoteOrigin.js';
import { isForbiddenProjectRoot } from '../tools/builtin/startProjectSession.js';

export interface PluginRunStart {
  userId: string; prompt: string; cwd: string; modelId?: string; thinkingLevel?: string;
  agentSlug?: string; engineId?: string; engineModelId?: string; planMode?: boolean;
  parentSessionId?: string; sessionId?: string; requestId?: string; title?: string;
}
const decode = (x: any): any => typeof x === 'string' ? JSON.parse(x) : x || {};
const uuid = /^[a-f0-9]{8}-[a-f0-9-]{27,40}$/i;
const locks = new Map<string, Promise<unknown>>();
export function createPluginRuns(owner: string, alive: () => boolean, own: (off: () => void) => void = () => {}) {
  const check = (): void => {
    if (!alive()) throw new Error('Plugin is disabled');
    if (!deps().profile.capabilities.hostExec) throw new Error('Task runs require a local engine');
    const runId = currentRunId();
    if (runId && effectiveRemote({ runId })) throw new Error('Task dispatch requires local authorization');
  };
  const ownedSession = async (sessionId: string, userId: string) => {
    check();
    const rows = await query<any[]>('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
    const session = rows[0];
    if (!session || session.kind !== 'task' || decode(session.agent_config).pluginOwner !== owner) throw new Error('Task session not owned by this plugin');
    return session;
  };
  const owned = async (runId: string, userId: string) => {
    check();
    const run = await getRun(runId);
    if (!run) throw Object.assign(new Error('Run not found'), { code: 'RUN_NOT_FOUND' });
    if (run.user_id !== userId) throw new Error('Run not owned by this plugin');
    if (decode(run.input).pluginOwner !== owner) await ownedSession(run.session_id, userId);
    return run;
  };
  return {
    async start(p: PluginRunStart): Promise<{ sessionId: string; runId: string }> {
      check();
      if (!p.userId || !p.prompt?.trim() || p.prompt.length > 100_000 || !path.isAbsolute(p.cwd)) throw new Error('User, prompt and absolute project directory are required');
      if (p.agentSlug && p.engineId) throw new Error('Choose an Agent or an external engine');
      if (p.engineId && p.planMode) throw new Error('External engines do not support plan mode');
      if (p.engineId && (isHostSandboxRestricted() || !deps().engines?.list().some(e => e.id === p.engineId && e.available))) throw new Error('External engine is unavailable');
      if (p.agentSlug && !(await getAgent(p.agentSlug))) throw new Error('Agent not found');
      const cwd = await realpath(p.cwd);
      if (!(await stat(cwd)).isDirectory() || isForbiddenProjectRoot(cwd)) throw new Error('Invalid project directory');
      const sessionId = p.sessionId || randomUUID(), runId = p.requestId || randomUUID();
      if (!uuid.test(sessionId) || !uuid.test(runId)) throw new Error('Invalid task session or request ID');
      const key = `${owner}:${sessionId}`;
      const before = locks.get(key) || Promise.resolve();
      const work = before.catch(() => {}).then(async () => {
        check();
        const existing = await getRun(runId);
        if (existing) { const r = await owned(runId, p.userId); if (r.session_id !== sessionId) throw new Error('Request ID already used'); return { sessionId, runId }; }
        const defaults = await readProjectSettings(cwd);
        const rows = await query<any[]>('SELECT user_id, kind, agent_config, project_path FROM chat_sessions WHERE id = ?', [sessionId]);
        const session = rows[0];
        if (session && (session.user_id !== p.userId || session.kind !== 'task' || decode(session.agent_config).pluginOwner !== owner || session.project_path !== cwd)) throw new Error('Session is not owned by this plugin');
        if (p.parentSessionId) {
          const parents = await query<any[]>('SELECT user_id FROM chat_sessions WHERE id = ?', [p.parentSessionId]);
          if (parents[0]?.user_id !== p.userId) throw new Error('Parent session not found');
        }
        const modelId = p.modelId || defaults?.model || deps().profile.defaultModelId || '';
        if (!modelId && !p.engineId) throw new Error('Select a model');
        const approvalMode = session ? await storedApprovalMode(sessionId) : defaults?.approvalMode;
        const config = { ...(session ? decode(session.agent_config) : {}), pluginOwner: owner, execMode: 'host', cwd, preset: null,
          agentSlug: p.agentSlug || null, engineId: p.engineId || null, engineModelId: p.engineModelId || null,
          planMode: !!p.planMode, thinkingLevel: p.thinkingLevel || defaults?.thinkingLevel,
          approvalMode: approvalMode || 'auto-edit' };
        check();
        if (!session) await query(
          `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, project_path, project_name, projectless, agent_config) VALUES (?, ?, ?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
          [sessionId, p.userId, deps().profile.appId, (p.title || p.prompt).slice(0, 200), modelId || null, p.parentSessionId || null, cwd, path.basename(cwd), false, JSON.stringify(config)],
        );
        else await query('UPDATE chat_sessions SET agent_config = ?, model_id = ? WHERE id = ? AND user_id = ?', [JSON.stringify(config), modelId || null, sessionId, p.userId]);
        await createRun({ id: runId, sessionId, userId: p.userId, appId: deps().profile.appId,
          modelId, assistantMessageId: randomUUID(), input: { pluginOwner: owner, origin: 'client', approvalTray: true,
            message: p.prompt, userMessageId: randomUUID(), attachments: [], agentConfig: config } });
        const { enqueueRun } = await import('../services/agentLoop.js');
        // Persisted runs survive a UI plugin toggle. Existing approvals remain native.
        enqueueRun(sessionId, runId);
        return { sessionId, runId };
      });
      locks.set(key, work);
      try { return await work; } finally { if (locks.get(key) === work) locks.delete(key); }
    },
    async sessionRuns(sessionId: string, userId: string) {
      await ownedSession(sessionId, userId);
      return await query<Array<{runId:string; status:string; createdAt:string}>>(
        `SELECT id AS "runId", status, created_at AS "createdAt" FROM agent_runs WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC${getDbType() === 'sqlite' ? ', rowid ASC' : ''}`,
        [sessionId, userId]);
    },
    async status(runId: string, userId: string) {
      const run = await owned(runId, userId);
      return { runId, sessionId: run.session_id, status: run.status, error: run.error,
        tokens: run.tokens_total, summary: String(decode(run.result).content || '').slice(-16000), waiting: listPrompts().filter(p => p.runId === runId).map(p => p.kind) };
    },
    async events(runId: string, userId: string, cursor = 0) {
      await owned(runId, userId);
      return (await listEventsFrom(runId, Math.max(0, cursor))).slice(0, 200);
    },
    async subscribe(runId: string, userId: string, cb: () => void): Promise<() => void> {
      await owned(runId, userId);
      const off = subscribe(runId, () => { if (alive()) cb(); });
      if (!alive()) { off(); throw new Error('Plugin is disabled'); }
      own(off);
      cb(); // Re-read after subscription so a terminal event racing the ownership lookup is not lost.
      return off;
    },
    async stop(runId: string, userId: string) {
      await owned(runId, userId);
      const { abortRun } = await import('../services/agentLoop.js'); abortRun(runId);
    },
  };
}

export const pluginEngines = { list: () => (deps().engines?.list() || []).map(e => ({ ...e,
  available: e.available && !isHostSandboxRestricted(), ...(isHostSandboxRestricted() ? { reason: 'Local sandbox is enabled' } : {}),
})) };
