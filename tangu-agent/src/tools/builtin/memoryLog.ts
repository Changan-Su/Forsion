/**
 * 记忆/日志工具:remember / log_event / read_log(execute 体从 registry.ts 原样搬移)。
 * 经 deps().brain.memory 落云端(或 standalone 的 httpBrain)。
 */
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';
import { MemoryRepositoryError, MEMORY_CHAR_BUDGET, normalizeMemoryFact, type MemoryEntry, type MemorySnapshot } from '../../services/memoryRepository.js';
import { effectiveRemote, remoteManagementDenied } from '../../services/remoteOrigin.js';
import { openProjectMemory, peekProjectMemory, resolveProjectMemory, PROJECT_MEMORY_CHAR_BUDGET } from '../../services/projectMemory.js';

/** 单条上限与 Historian 候选采集同口径(localHistorian `.slice(0, 300)`)。显式路径此前无闸:09-22 一份终端用户导出里
 *  41 条显式条目最长 1,477 字、21 条带日期、9 条是追加式「更正旧条目」——记忆被日志灌满,而候选路径 12 天只出 8 条一句话。 */
export const REMEMBER_FACT_MAX_CHARS = 300;
const entryView = (e: MemoryEntry) => ({ id: e.id, content: e.content });

// ── 注入依赖的 lazy 别名(保持下方调用点不变)──
const appendMemoryEntry = (userId: string, text: string, opts?: { dedup?: boolean; cap?: number; signal?: AbortSignal }) =>
  deps().brain.memory.appendMemoryEntry(userId, text, opts);
const appendLogEntry = (userId: string, text: string, signal?: AbortSignal) => deps().brain.memory.appendLogEntry(userId, text, { signal });
const getLog = (userId: string, date?: string, signal?: AbortSignal) => deps().brain.memory.getLog(userId, date, { signal });

export const memoryLogProvider: ToolProvider = {
  id: 'builtin:memory-log',
  tools: () => [
    {
      name: 'remember',
      isEnabledFor: (profile) => profile.capabilities.memory,
      definition: {
        type: 'function',
        function: {
          name: 'remember',
          description:
            'Save one durable fact to long-term memory, injected into future sessions. Keep it small and high-signal. ' +
            // 10-04 用户裁决:「用户纠正肯定应该进记忆」—— 不进工作笔记,也不进协作说明。
            'WHEN: what the user tells you about themselves or requires of you (identity, preferences, corrections of how you should work), environment (OS, paths, tools, quirks), standing conventions, proven procedures or landmines. ' +
            // 两级(10-04 用户:「还要区分 Project 级别还是全局级别」):项目级只在本项目注入、项目里的 agent 共用;agent 级照旧。
            'SCOPE: "project" = holds only inside the current project (its commands, layout, conventions, decisions, what the user wants done in this project); it is shown to every agent working in this project and nowhere else. "agent" = holds wherever you work with this user (who they are, how they want you to work in general). When unsure whether it would still be true in another project, ask yourself that and pick. ' +
            'SKIP: task progress, completed work, deliverables, versions, dated status and one-off requests; use log_event instead. ' +
            'FORMAT: one sentence of at most 300 characters in the user’s language; longer facts are rejected. ' +
            'ACTIONS: add saves fact; list returns IDs and versions of both scopes (fact: null); update replaces a listed entry and MUST include the new fact, id, expectedVersion and the scope it was listed under; forget removes one and blocks automatic replay (fact: null). ' +
            'Always supply action and fact. To supersede an entry: list, then update with the replacement sentence; never add a correction beside it. Forget only when the user asks; if full, forget or shorten stale entries first.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'list', 'update', 'forget'], description: 'The operation to perform. List before update/forget to obtain the current entry ID and version.' },
              fact: { type: ['string', 'null'], description: 'For add/update: the non-empty durable sentence to save (max 300 characters). For list/forget: null. An update without fact fails.' },
              id: { type: 'string', description: 'An entry ID returned by list for this Agent; required for update/forget.' },
              expectedVersion: { type: 'string', description: 'Version returned by list; include when modifying an existing entry.' },
              scope: { type: 'string', enum: ['agent', 'project'], description: 'Which memory to write: "project" for facts that hold only in the current project, "agent" for facts that hold everywhere. Ignored by list.' },
            },
            required: ['action', 'fact', 'scope'],
          },
        },
      },
      execute: async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        const action = String(args.action ?? 'add');
        const brain = deps().brain.memory;
        if (!['add', 'list', 'update', 'forget'].includes(action)) return 'Error: unknown memory action';
        const remoteDenied = effectiveRemote(ctx) ? remoteManagementDenied('remember', action) : null;
        if (remoteDenied) return `Error: ${remoteDenied}`;
        // 项目级记忆只在本机有(存用户目录、按会话存档的项目路径索引);无项目会话 / 云端 → 没有这一级。
        const projectRef = deps().profile.capabilities.hostExec ? await resolveProjectMemory(ctx.userId, ctx.sessionId) : null;
        if (action === 'list') {
          if (!brain.getMemorySnapshot) return 'Error: this memory backend does not support entry management.';
          const snapshot = await brain.getMemorySnapshot(ctx.userId);
          const project = projectRef ? await peekProjectMemory(projectRef) : null;
          return JSON.stringify({ version: snapshot.version, entries: snapshot.entries, chars: snapshot.content.length, limit: MEMORY_CHAR_BUDGET,
            ...(projectRef ? { project: { name: projectRef.name, version: project?.version ?? null, entries: project?.entries ?? [], chars: project?.content.length ?? 0, limit: PROJECT_MEMORY_CHAR_BUDGET } } : {}) });
        }
        const scope = args.scope === 'project' ? 'project' : 'agent';
        if (scope === 'project' && !projectRef) {
          return 'Error: this session has no project, so there is no project memory. Use scope "agent", and name the project in the sentence if the fact is about one. Nothing was written.';
        }
        const fact = typeof args.fact === 'string' ? args.fact.trim() : '';
        if (action !== 'forget' && !fact) {
          const example = action === 'update'
            ? { action, fact: '<replacement durable sentence>', id: args.id, expectedVersion: args.expectedVersion }
            : { action, fact: '<durable sentence>' };
          return `Error: fact is required for ${action} and must be a non-empty string. Include the actual sentence to save in the fact field, then retry with corrected arguments: ${JSON.stringify(example)}. Do not repeat the same incomplete call. Nothing was written.`;
        }
        // 形状闸(借 Hermes memory 工具):超长直接拒、让模型提炼——静默截断只会留下半句话。
        if (action !== 'forget' && fact.length > REMEMBER_FACT_MAX_CHARS) {
          return `Error: fact is ${fact.length} characters; long-term memory takes one durable sentence of at most ${REMEMBER_FACT_MAX_CHARS}. Keep only what will still be true next month, or record progress with log_event instead.`;
        }
        if (action !== 'add' && !String(args.id ?? '').trim()) return 'Error: id is required; use action list first';
        if (action !== 'add' && !String(args.expectedVersion ?? '').trim()) return 'Error: expectedVersion is required; use action list first';
        if (brain.mutateMemory || scope === 'project') {
          // 两级共用下面的回执逻辑:只是读写落在哪个库不同。
          const projectRepo = scope === 'project' ? await openProjectMemory(projectRef!) : null;
          const limit = projectRepo ? PROJECT_MEMORY_CHAR_BUDGET : MEMORY_CHAR_BUDGET;
          const read = async (): Promise<MemorySnapshot | undefined> => projectRepo ? projectRepo.snapshot() : brain.getMemorySnapshot ? brain.getMemorySnapshot(ctx.userId) : undefined;
          const before = action === 'add' ? await read() : undefined;
          let snapshot: MemorySnapshot;
          try {
            const mutation = {
              action: action as 'add' | 'update' | 'forget', fact, id: args.id ? String(args.id) : undefined,
              expectedVersion: args.expectedVersion ? String(args.expectedVersion) : undefined,
              source: { kind: 'explicit' as const, sessionId: ctx.sessionId, runId: ctx.runId }, signal: ctx.signal,
            };
            snapshot = projectRepo ? projectRepo.mutate({ ...mutation, cap: PROJECT_MEMORY_CHAR_BUDGET }) : await brain.mutateMemory!(ctx.userId, mutation);
          } catch (e) {
            // 满了就回显现有条目,让模型一次删旧加新(Hermes 的 IF FULL),而不是只丢一句「超预算」。
            const full = e instanceof MemoryRepositoryError && e.code === 'MEMORY_FULL' ? await read() : undefined;
            if (full) {
              return `Error: ${projectRepo ? 'project' : 'long-term'} memory is full (${full.content.length}/${limit} characters). Forget or shorten stale entries with update/forget (scope "${scope}", expectedVersion ${full.version}), then add. Current entries: ${JSON.stringify(full.entries.map(entryView))}`;
            }
            throw e;
          }
          // 回执只回受影响的条目:整份 entries 回灌一次就是几万字进上下文(09-22 导出实测 31k)。
          const id = args.id ? String(args.id) : undefined;
          const entry = action === 'forget' ? undefined : snapshot.entries.find((e) => (id ? e.id === id : normalizeMemoryFact(e.content) === normalizeMemoryFact(fact)));
          // 没写进去的两种样子:版本没动(同 run 重复),或落库条目的来源不是本 run(别的 run 先写了——并发时版本会动,单看版本会漏判)。
          const duplicate = action === 'add' && !!entry && ((!!before && before.version === snapshot.version) || entry.source?.runId !== ctx.runId);
          return JSON.stringify({
            ok: true, action, scope, ...(projectRepo ? { project: projectRef!.name } : {}), version: snapshot.version,
            ...(duplicate ? { duplicate: true, note: 'An identical fact already exists; nothing was written.' } : {}),
            ...(entry ? { entry: entryView(entry) } : id ? { id } : {}),
            count: snapshot.entries.length, chars: snapshot.content.length, limit,
          });
        }
        if (action !== 'add') return 'Error: this memory backend does not support entry management.';
        const r = await appendMemoryEntry(ctx.userId, fact, { dedup: true, signal: ctx.signal });
        if (r.appended) return '已记入长期记忆。';
        if (r.reason === 'duplicate') return '已存在相同记忆，无需重复记录。';
        if (r.reason === 'full') return '长期记忆已接近上限，本条未写入。';
        return 'Error: fact is required';
      },
    },
    {
      name: 'log_event',
      isEnabledFor: (profile) => profile.capabilities.log,
      definition: {
        type: 'function',
        function: {
          name: 'log_event',
          description:
            'Append a noteworthy event/progress from this interaction to the user\'s "today" activity log (archived by date, viewable by the user in the account center). ' +
            'Use to record completed work, conclusions reached, files produced, etc.; do not record trivial chit-chat.',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: 'A one-sentence event/progress to record in today\'s log' } },
            required: ['text'],
          },
        },
      },
      execute: async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        // 远程污点 run 不写每日日志(审批闸已硬拒;这里是同一判定的兜底,P1 · M1A)
        const remoteDenied = effectiveRemote(ctx) ? remoteManagementDenied('log_event', undefined) : null;
        if (remoteDenied) return `Error: ${remoteDenied}`;
        const text = String(args.text ?? '').trim();
        if (!text) return 'Error: text is required';
        const r = await appendLogEntry(ctx.userId, text, ctx.signal);
        if (ctx.signal?.aborted) return `已记入 ${r.date} 日志（${r.time}）；取消在写入确认后到达，本条不会回滚。`;
        return `已记入 ${r.date} 日志（${r.time}）。`;
      },
    },
    {
      name: 'read_log',
      isEnabledFor: (profile) => profile.capabilities.log,
      definition: {
        type: 'function',
        function: {
          name: 'read_log',
          description: 'Read the user\'s activity log for a given day (markdown). Date format YYYY-MM-DD; defaults to today.',
          parameters: {
            type: 'object',
            properties: { date: { type: 'string', description: 'Date YYYY-MM-DD; defaults to today' } },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        const date = String(args.date ?? '').trim() || undefined;
        const r = await getLog(ctx.userId, date, ctx.signal);
        ctx.signal?.throwIfAborted();
        // 空结果给出路:日志记「做了什么」,不含对话原文——找当时说了什么该走 search_sessions
        // (真实失败样本里模型正是从 read_log 空手而归后宣布「无历史可查」)。
        return r.content?.trim()
          ? r.content
          : `（${r.date} 暂无日志）\nNote: the log records what was DONE, not what was said. For past conversation content, use \`search_sessions\`.`;
      },
    },
  ],
};
