/**
 * 记忆/日志工具:remember / log_event / read_log(execute 体从 registry.ts 原样搬移)。
 * 经 deps().brain.memory 落云端(或 standalone 的 httpBrain)。
 */
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { Tool } from '../../core/types.js';
import type { ToolContext } from '../toolTypes.js';
import { MemoryRepositoryError, MEMORY_CHAR_BUDGET, normalizeMemoryFact, type MemoryEntry, type MemorySnapshot } from '../../services/memoryRepository.js';
import { effectiveRemote, remoteManagementDenied } from '../../services/remoteOrigin.js';
import { coveringProjectEntry, openProjectMemory, peekProjectMemory, resolveProjectMemory, PROJECT_MEMORY_CHAR_BUDGET, type ProjectMemoryRef } from '../../services/projectMemory.js';
import { compactProjectMemory, type CompactionOutcome } from '../../services/projectMemoryCompact.js';
import { mutatePortrait, portraitEntries, PortraitFullError, PORTRAIT_LIMIT, PORTRAIT_SHORT_VERSION, readPortrait, revertPortraitWrite } from '../../agents/humanPortrait.js';
import { HumanError, type HumanChangeSource, type HumanDocument } from '../../agents/humanStore.js';
import { currentDisplayAgentSlug } from '../../seams/runContext.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';

/** 单条上限与 Historian 候选采集同口径(localHistorian `.slice(0, 300)`)。显式路径此前无闸:09-22 一份终端用户导出里
 *  41 条显式条目最长 1,477 字、21 条带日期、9 条是追加式「更正旧条目」——记忆被日志灌满,而候选路径 12 天只出 8 条一句话。 */
export const REMEMBER_FACT_MAX_CHARS = 300;
const entryView = (e: MemoryEntry) => ({ id: e.id, content: e.content });
/** 版本号抄错的判据:与现在的版本相差不超过几处编辑(10-13 那次是 4 处)。两个随机 UUID 之间通常差 25 处以上。 */
const MISCOPY_MAX_EDITS = 8;
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// ── 注入依赖的 lazy 别名(保持下方调用点不变)──
const appendMemoryEntry = (userId: string, text: string, opts?: { dedup?: boolean; cap?: number; signal?: AbortSignal }) =>
  deps().brain.memory.appendMemoryEntry(userId, text, opts);
const appendLogEntry = (userId: string, text: string, signal?: AbortSignal) => deps().brain.memory.appendLogEntry(userId, text, { signal });
const getLog = (userId: string, date?: string, signal?: AbortSignal) => deps().brain.memory.getLog(userId, date, { signal });

// ── remember 的定义:八份预先建好(是否项目会话 × 是否有工作笔记 × 能不能写画像),按上下文取 ──
// 分开的原因是体量:云端聊天面的工具定义有字节预算(test/chatPreset.test.ts),「级别」那段只在会话属于项目时才有意义,
// 「自己总结的做法归工作笔记」那句只在有 manage_harness 的面上才成立,person 档只在本机、不连通道等条件下才给(personAllowed)。
// 不给 person 的四份逐字没变(云端、通道、子代理、远端拿到的还是原样)。执行侧对八份一视同仁(缺 scope 按 agent 级)。
// 10-29 画像写入:person = 关于这个人本身、换哪个 Agent 都成立的事,写进 human/SOUL.md(画像,所有 Agent 都读)。
// 档名不叫 human:10-20 live 两次,叫 human 时模型把写明只在本项目的事也塞进共识。分法照 manage_human 的 WHERE_IT_GOES「挂在谁身上」。
// 10-30 live:「你以后改完先自己跑一遍」两轮被当成偏好写进画像;「这几周在学…」被 next-month 那条挡掉没记。第二轮只写「对你的要求归 agent」,
// 又把「叫我阿青」也算成了对 agent 的要求(两轮留在 agent 记忆):称呼和语言要单独说死
const PERSON_IS = '"person" = about the user themself and their life, true with any agent and in any project (what to call them, language, background, what they are working on or learning now — a few weeks counts, their tastes and habits); every agent reads it, and so does the user: write it to them ("you …"), one fact per sentence, in their language. What they ask of you about the work itself (how to test, report or structure answers) is "agent", even when phrased as their preference; what to call them and their language stay "person". ';
function buildRememberDefinition(o: { project: boolean; notes: boolean; person: boolean }): Tool {
  const several = o.project || o.person; // 不止一份记忆:不再说「当前 Agent 的」
  const scopes = [...(o.project ? ['agent', 'project'] : ['agent']), ...(o.person ? ['person'] : [])];
  return {
    type: 'function',
    function: {
      name: 'remember',
      description:
        `Save one durable fact to ${several ? '' : 'the current Agent’s '}long-term memory, injected into ${several ? '' : 'every '}future session${several ? 's' : ''}. Keep it small and high-signal. ` +
        // 10-04 用户裁决:「用户纠正肯定应该进记忆」—— 不进工作笔记,也不进协作说明。有 person 档时拆开:关于这个人 → person,对你做事的纠正 → agent。
        `WHEN: ${o.person ? 'facts about the user themself, corrections of how you work' : 'user identity/preferences/corrections of how you work'}, environment (OS, paths, tools, quirks), standing conventions, ${o.notes ? 'commands and workflows proven to work here, landmines' : 'proven procedures or landmines'}. ` +
        // 10-04 live(refine):agent 自己总结的做法被它存进了这里 —— 「proven procedures」与工作笔记的触发条件说的是同一件事,两边打架。
        (o.notes ? 'A working method you worked out yourself is not a memory: it goes in your evolution record (manage_harness). ' : '') +
        // 两级(10-04 用户:「还要区分 Project 级别还是全局级别」):项目级只在本项目注入、项目里的 agent 共用;agent 级照旧。
        (o.project && !o.person ? 'SCOPE: "project" = holds only inside the current project (its commands, layout, conventions, decisions, what the user wants done in this project); it is shown to every agent working in this project and nowhere else. "agent" = holds wherever you work with this user (who they are, how they want you to work in general). When unsure, ask yourself whether it would still be true in another project. ' : '') +
        (o.project && o.person ? `SCOPE: ${PERSON_IS}"project" = holds only inside the current project (its commands, layout, conventions, decisions, what the user wants done in this project); it is shown to every agent working in this project and nowhere else. "agent" = yours, wherever you work with this user: corrections to how you work, an identity given to them inside a role-play. When unsure, ask yourself whether it would still be true in another project, or with another agent. ` : '') +
        (!o.project && o.person ? `SCOPE: ${PERSON_IS}"agent" (the default) = yours: corrections to how you work, an identity given to them inside a role-play, facts about one project. ` : '') +
        // 10-13 分层:记忆 = 现在成立的事(现在时),日志 = 发生过的事;只对这段对话有效的指示两边都不进。
        // 「answer from this file」那半句对的是真实样本:08–09 月「后续基于这份字幕回答」被记成长期记忆 3 次、被判官提名 4 次。
        'SKIP: what happened or where a task stands (progress, completed work, versions, dated status): use log_event. ' +
        'Also what holds for this conversation only (answer from this file, one-off requests). ' +
        'FORMAT: one present-tense sentence of at most 300 characters in the user’s language; longer facts are rejected. ' +
        (several
          ? `ACTIONS: add saves fact; list returns IDs and versions of ${o.project && o.person ? 'every scope' : 'both scopes'} (fact: null); update replaces a listed entry and MUST include the new fact, id, expectedVersion and the scope it was listed under; forget removes one and blocks automatic replay (fact: null). `
          : 'ACTIONS: add saves fact; list returns IDs and version (fact: null); update replaces a listed entry and MUST include the new fact, id and expectedVersion; forget removes one and blocks automatic replay (fact: null). ') +
        // 跨档取代(10-29):「取代而不是并排加」要跨档也成立 —— 旧条目在 Agent 记忆、新说法该进画像时,不能只往画像加一条、把矛盾的旧条目留着
        `Always supply action and fact. To supersede an entry: list, then update with the replacement sentence${o.person ? ' (scope = where the new sentence belongs; if the entry is listed elsewhere, e.g. an old name in your own memory, it moves)' : ''}; never add a correction beside it. ` +
        'Forget only when the user asks; if full, forget or shorten stale entries first.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'update', 'forget'], description: 'The operation to perform. List before update/forget to obtain the current entry ID and version.' },
          fact: { type: ['string', 'null'], description: 'For add/update: the non-empty durable sentence to save (max 300 characters). For list/forget: null. An update without fact fails.' },
          id: { type: 'string', description: `An entry ID returned by list${several ? '' : ' for this Agent'}; required for update/forget.` },
          expectedVersion: { type: 'string', description: `Version returned by list${several ? ' for that scope' : ''}; include when modifying an existing entry.` },
          ...(o.project && !o.person ? { scope: { type: 'string', enum: scopes, description: 'Which memory: "agent" = yours, wherever you work; "project" = this project’s, shared by the agents working in it.' } } : {}),
          ...(o.person ? { scope: { type: 'string', enum: scopes, description: `Which memory this sentence belongs in (see SCOPE)${o.project ? '' : '; default "agent"'}. On update it may differ from where the old entry is listed: a name or other fact about the user goes to "person" even if the old one was in your own memory.` } } : {}),
        },
        required: o.project ? ['action', 'fact', 'scope'] : ['action', 'fact'],
      },
    },
  };
}
const REMEMBER = {
  base: buildRememberDefinition({ project: false, notes: false, person: false }),
  notes: buildRememberDefinition({ project: false, notes: true, person: false }),
  project: buildRememberDefinition({ project: true, notes: false, person: false }),
  projectNotes: buildRememberDefinition({ project: true, notes: true, person: false }),
  person: buildRememberDefinition({ project: false, notes: false, person: true }),
  personNotes: buildRememberDefinition({ project: false, notes: true, person: true }),
  personProject: buildRememberDefinition({ project: true, notes: false, person: true }),
  personProjectNotes: buildRememberDefinition({ project: true, notes: true, person: true }),
};
/** 能不能写画像(person 档):本机引擎、不连远端、不是临时成员 / 子代理、不是连着聊天通道的会话(别人也可能在读)。
 *  定义和执行同一个判定:定义里没有 person 时,执行收到 person 明确报错,绝不降级记进 Agent 自己的记忆。 */
export function personAllowed(ctx: ToolContext): boolean {
  const profile = ctx.profile ?? deps().profile;
  return !!profile?.capabilities?.hostExec && !effectiveRemote(ctx) && !ctx.ephemeral && !ctx.subAgentDepth && !ctx.channelSession && !ctx.channelUnknown;
}
/** 有没有工作笔记这个工具:本机引擎的 profile、本机直连(host)、不是 chat 面,且 profile 的内置工具名单里有它
 *  (manageHarness.isEnabledFor + preset 的 host 族整族拒 + toolLoadout.builtins)。
 *  ponytail: 照这几条近似,没去问注册表(定义求值期间再解析一遍工具表会绕回来);计划模式 / 子代理里它其实不在,那句多说了也只是多说。 */
function rememberDefinitionFor(ctx: ToolContext): Tool {
  const profile = ctx.profile ?? deps().profile;
  const builtins = profile?.toolLoadout?.builtins;
  const notes = ctx.execMode === 'host' && ctx.preset !== 'chat' && !!profile?.capabilities?.hostExec
    && (builtins === 'all' || (Array.isArray(builtins) && builtins.includes('manage_harness')));
  if (personAllowed(ctx)) return ctx.projectScoped ? (notes ? REMEMBER.personProjectNotes : REMEMBER.personProject) : (notes ? REMEMBER.personNotes : REMEMBER.person);
  return ctx.projectScoped ? (notes ? REMEMBER.projectNotes : REMEMBER.project) : (notes ? REMEMBER.notes : REMEMBER.base);
}

// ── person 档(画像)与跨档挪 ──
type MemoryScope = 'agent' | 'project' | 'person';
/** 写画像时盖的「哪个 Agent 写的」:显示身份(共用默认记忆的 Agent 也写自己的名字),同 manage_human。 */
const writerSlug = (ctx: ToolContext): string => currentDisplayAgentSlug() || ctx.agentSlug || DEFAULT_AGENT_SLUG;
const portraitTotals = (doc: HumanDocument) => ({ count: portraitEntries(doc.content).length, chars: doc.content.length, limit: PORTRAIT_LIMIT });
const shortVersion = (doc: HumanDocument): string => doc.version.slice(0, PORTRAIT_SHORT_VERSION);
/** 画像那边的失败说成模型能接着做的话;认不得的照旧抛(同记忆那条路)。 */
function portraitError(e: unknown): string {
  if (e instanceof PortraitFullError) {
    return e.section.length
      ? `Error: the portrait is full (${e.chars}/${PORTRAIT_LIMIT} characters, the part every agent reads). Nothing was written. Merge or shorten the entries agents added, with update/forget (scope "person", expectedVersion ${e.version.slice(0, PORTRAIT_SHORT_VERSION)}), then add. Those entries: ${JSON.stringify(e.section)}`
      : `Error: the portrait is full (${e.chars}/${PORTRAIT_LIMIT} characters, the part every agent reads) with text the human wrote, which you must not shorten. Nothing was written; tell them it did not fit.`;
  }
  if (e instanceof HumanError) {
    if (e.code === 'HUMAN_CONFLICT') return 'Error: the portrait changed since it was listed. Nothing was written; list again and use the new version (scope "person").';
    return `Error: ${e.message}${/Nothing was written/.test(e.message) ? '' : ' Nothing was written.'}`;
  }
  throw e;
}
async function rememberPerson(action: 'add' | 'update' | 'forget', fact: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  try {
    const r = await mutatePortrait({ action, fact, id: args.id ? String(args.id) : undefined, expectedVersion: args.expectedVersion ? String(args.expectedVersion) : undefined,
      actor: 'agent', source: { kind: 'remember', agent: writerSlug(ctx) } });
    // 10-30 live:模型直接 add,自己记忆里矛盾的旧说法留着。写成的这一刻提醒它,比工具说明里多一句管用;读不到记忆就不提醒
    const own = action === 'add' && !r.duplicate ? (await deps().brain.memory.getMemorySnapshot?.(ctx.userId).catch(() => null))?.entries.length : 0;
    return JSON.stringify({ ok: true, action, scope: 'person', version: shortVersion(r.document),
      ...(r.duplicate ? { duplicate: true, note: 'An identical fact already exists; nothing was written.' } : {}),
      ...(own ? { note: 'If an entry in your own memory says what this replaces (an old name, say), forget it now: do not leave both.' } : {}),
      ...(r.entry ? { entry: r.entry } : action === 'forget' ? { id: String(args.id) } : {}), ...portraitTotals(r.document) });
  } catch (e) { return portraitError(e); }
}

interface ScopeStore {
  /** version = 列给模型的那个(画像是前 12 位),full = 落盘比对用的完整版本 */
  read(): Promise<{ version: string; full: string; entries: Array<{ id: string; content: string }> }>;
  add(fact: string): Promise<{ version: string; entry?: { id: string; content: string }; duplicate: boolean; count: number; chars: number; limit: number; undo(): Promise<boolean> }>;
  forget(id: string, fullVersion: string): Promise<void>;
}
function storeFor(scope: MemoryScope, ctx: ToolContext, projectRef: ProjectMemoryRef | null): ScopeStore | string {
  if (scope === 'person') {
    const source: HumanChangeSource = { kind: 'move', agent: writerSlug(ctx) };
    return {
      read: async () => { const v = await readPortrait(); return { version: v.version, full: v.version, entries: v.entries }; },
      add: async (fact) => {
        const r = await mutatePortrait({ action: 'add', fact, actor: 'agent', source });
        return { version: shortVersion(r.document), entry: r.entry, duplicate: !!r.duplicate, ...portraitTotals(r.document), undo: () => revertPortraitWrite(r, source) };
      },
      forget: async (id, version) => { await mutatePortrait({ action: 'forget', id, expectedVersion: version, actor: 'agent', source }); },
    };
  }
  const brain = deps().brain.memory;
  if (scope === 'agent' && (!brain.mutateMemory || !brain.getMemorySnapshot)) return 'Error: this memory backend does not support entry management.';
  const source = { kind: 'explicit' as const, sessionId: ctx.sessionId, runId: ctx.runId };
  let opened: ReturnType<typeof openProjectMemory> | undefined;
  const repo = scope === 'project' ? () => (opened ??= openProjectMemory(projectRef!)) : null;
  const limit = scope === 'project' ? PROJECT_MEMORY_CHAR_BUDGET : MEMORY_CHAR_BUDGET;
  const read = async (): Promise<MemorySnapshot> => repo ? (await repo()).snapshot() : brain.getMemorySnapshot!(ctx.userId);
  const mutate = async (m: { action: 'add' | 'forget'; fact?: string; id?: string; expectedVersion?: string }): Promise<MemorySnapshot> =>
    repo ? (await repo()).mutate({ ...m, source, cap: PROJECT_MEMORY_CHAR_BUDGET, signal: ctx.signal }) : brain.mutateMemory!(ctx.userId, { ...m, source, signal: ctx.signal });
  return {
    read: async () => { const s = await read(); return { version: s.version, full: s.version, entries: s.entries.map(entryView) }; },
    add: async (fact) => {
      const before = await read();
      const same = before.entries.find((e) => normalizeMemoryFact(e.content) === normalizeMemoryFact(fact));
      if (same) return { version: before.version, entry: entryView(same), duplicate: true, count: before.entries.length, chars: before.content.length, limit, undo: async () => true };
      const after = await mutate({ action: 'add', fact, expectedVersion: before.version }); // 带版本:刚好别处加了同一句时不当成自己写的,撤回才不会删到别人的
      const entry = after.entries.find((e) => normalizeMemoryFact(e.content) === normalizeMemoryFact(fact));
      return { version: after.version, entry: entry && entryView(entry), duplicate: false, count: after.entries.length, chars: after.content.length, limit,
        // 带写入后的版本:这期间别处改过这一条(同一个 id)就不撤,留着比删掉别人的新说法强
        undo: async () => { if (!entry) return false; try { await mutate({ action: 'forget', id: entry.id, expectedVersion: after.version }); return true; } catch { return false; } } };
    },
    forget: async (id, version) => { await mutate({ action: 'forget', id, expectedVersion: version }); },
  };
}
/** 这个 id 在哪一档:目标档自己有就是它,否则按 agent → project → person 找这次会话能写的那几档;都没有 → 目标档(照原路报「找不到」)。
 *  读不了的档跳过:只决定往哪找,不据此写任何东西。 */
async function scopeHolding(id: string, scope: MemoryScope, ctx: ToolContext, projectRef: ProjectMemoryRef | null): Promise<MemoryScope> {
  const order: MemoryScope[] = [scope, ...(['agent', 'project', 'person'] as const).filter((s) => s !== scope && (s !== 'project' || projectRef) && (s !== 'person' || personAllowed(ctx)))];
  for (const s of order) {
    const store = storeFor(s, ctx, projectRef);
    if (typeof store === 'string') continue;
    const listed = await store.read().catch(() => null);
    if (listed?.entries.some((e) => e.id === id)) return s;
  }
  return scope;
}
/** 跨档取代 = 挪:新句子写进目标档,写成了再忘掉源档里的旧条目(带源档版本);忘不掉就撤回刚写的那一句,回冲突。
 *  先写后删:中途断了最多两边都有(下次 list 看得到),不会两边都没有。 */
async function moveMemoryEntry(i: { from: MemoryScope; scope: MemoryScope; id: string; expectedVersion: string; fact: string; ctx: ToolContext; projectRef: ProjectMemoryRef | null }): Promise<string> {
  const source = storeFor(i.from, i.ctx, i.projectRef), target = storeFor(i.scope, i.ctx, i.projectRef);
  if (typeof source === 'string') return source;
  if (typeof target === 'string') return target;
  const failed = (e: unknown): string => {
    if (e instanceof HumanError) return portraitError(e);
    if (e instanceof MemoryRepositoryError && e.code === 'MEMORY_VERSION_CONFLICT') return `Error: scope "${i.scope}" changed during the move. Nothing was written; list again before retrying.`;
    if (e instanceof MemoryRepositoryError && e.code === 'MEMORY_FULL') return `Error: ${i.scope === 'project' ? 'project' : 'long-term'} memory is full. Nothing was written; forget or shorten stale entries there first (list, scope "${i.scope}").`;
    throw e;
  };
  let listed: Awaited<ReturnType<ScopeStore['read']>>;
  try { listed = await source.read(); } catch (e) { return failed(e); }
  const old = listed.entries.find((e) => e.id === i.id);
  // 10-30 live:36 位版本号 15 轮里抄错 3 次(前 8 位都对),报错之后模型两次退回原档就地改。比前 8 位(同 manage_human 只认前 12 位):
  // 版本是随机 UUID,真被别处改过前 8 位就不一样,比对交换照样拦得住;对不上时才报错,报错里给当前版本和原文,让它重发同一次挪动
  if (i.expectedVersion.slice(0, 8) !== listed.version.slice(0, 8) && i.expectedVersion !== listed.full) {
    return `Error: expectedVersion is not current. Nothing was written.${old ? ` The entry now reads ${JSON.stringify(old.content)}; if that is still what you meant to replace, send this same update again, keeping scope "${i.scope}", with expectedVersion ${listed.version}.` : ' List again and use the new version and IDs.'}`;
  }
  if (!old) return `Error: there is no entry with id ${JSON.stringify(i.id)} in scope "${i.from}". Nothing was written; list again and use an ID from it.`;
  let added: Awaited<ReturnType<ScopeStore['add']>>;
  try { added = await target.add(i.fact); } catch (e) { return failed(e); }
  const done = (): string => {
    const project = i.projectRef?.name;
    return JSON.stringify({ ok: true, action: 'update', scope: i.scope, ...(i.scope === 'project' ? { project } : {}), version: added.version,
      ...(added.duplicate ? { duplicate: true, note: 'The new sentence was already there; only the old entry was removed.' } : {}),
      ...(added.entry ? { entry: added.entry } : {}),
      moved: { from: i.from, id: old.id, content: old.content, ...(i.from === 'project' ? { project } : {}) },
      count: added.count, chars: added.chars, limit: added.limit });
  };
  try { await source.forget(i.id, listed.full); } catch {
    // 落盘后才抛的(状态文件写不上之类):旧条目其实已经拿掉了,这时再撤回新句子就两边都没了 —— 先看源档里它还在不在;看不了就留着新句子
    const still = await source.read().then((s) => s.entries.some((e) => e.id === i.id)).catch(() => null);
    if (still === false) return done();
    const undone = added.duplicate || (still === true && await added.undo());
    return `Error: scope "${i.from}" changed while the entry was being moved, so the move did not finish. ${undone ? 'Nothing was changed' : `The new sentence stayed in scope "${i.scope}"; forget it there if it should not stay`}. List again before retrying.`;
  }
  return done();
}

export const memoryLogProvider: ToolProvider = {
  id: 'builtin:memory-log',
  tools: () => [
    {
      name: 'remember',
      // 临时成员(团队 / 讨论里现写的一次性人设)不给:它没有自己的身份,不该留下记忆,更不该往项目记忆里写。
      // 以前照给,agent 级的一写就落在 agents/<临时名>/ 里。(读的那几条路仍会建出这个空目录,那是原有行为,这里没动。)
      isEnabledFor: (profile, ctx) => profile.capabilities.memory && !ctx.ephemeral,
      definition: REMEMBER.base,
      definitionFor: rememberDefinitionFor,
      execute: async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        if (ctx.ephemeral) return 'Error: Memory is unavailable to a temporary team member.';
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
            ...(projectRef ? { project: { name: projectRef.name, version: project?.version ?? null, entries: project?.entries ?? [], chars: project?.content.length ?? 0, limit: PROJECT_MEMORY_CHAR_BUDGET } } : {}),
            ...(personAllowed(ctx) ? { person: await readPortrait().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })) } : {}) });
        }
        // person 不在这里就明确拒:旧写法把认不得的 scope 一律当 agent,这一档要是也这样,不给画像的会话会把关于这个人的事悄悄记进自己的记忆
        if (args.scope === 'person' && !personAllowed(ctx)) {
          return `Error: scope "person" (the portrait every agent reads) is not available in this session${ctx.channelSession ? ': it is connected to a chat channel, where other people may read along' : ''}. Nothing was written.`;
        }
        const scope: MemoryScope = args.scope === 'project' ? 'project' : args.scope === 'person' ? 'person' : 'agent';
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
        // 画像和跨档挪必须在下面那个分支之前接住:没有 mutateMemory 的后端会走到最后的 append,把它悄悄记进 Agent 自己的记忆
        // 跨档取代:模型只说新句子归哪一档,旧条目在哪一档由 id 查(10-30 live:单独的 from 参数被写反,报错又把它引回原档改)
        const from = action === 'update' ? await scopeHolding(String(args.id), scope, ctx, projectRef) : scope;
        if (from !== scope) return moveMemoryEntry({ from, scope, id: String(args.id), expectedVersion: String(args.expectedVersion), fact, ctx, projectRef });
        if (scope === 'person') return rememberPerson(action as 'add' | 'update' | 'forget', fact, args, ctx);
        if (brain.mutateMemory || scope === 'project') {
          // 两级共用下面的回执逻辑:只是读写落在哪个库不同。
          const projectRepo = scope === 'project' ? await openProjectMemory(projectRef!) : null;
          const limit = projectRepo ? PROJECT_MEMORY_CHAR_BUDGET : MEMORY_CHAR_BUDGET;
          const read = async (): Promise<MemorySnapshot | undefined> => projectRepo ? projectRepo.snapshot() : brain.getMemorySnapshot ? brain.getMemorySnapshot(ctx.userId) : undefined;
          const before = action === 'add' ? await read() : undefined;
          // 项目记忆没有整理步骤:这句话是已有某一条里的一段原话(少说了几个字 / 只差标点)→ 不另记一条,把那一条回给模型。
          // 一字不差的重复不归这里管(下面 mutate 自己去重,回执一样)。agent 级不走这道:那边有 Dream 归并。
          const covering = projectRepo && before ? coveringProjectEntry(before.entries, fact) : null;
          if (covering) {
            return JSON.stringify({
              ok: true, action, scope, project: projectRef!.name, version: before!.version,
              duplicate: true, note: 'An existing entry already contains this sentence; nothing was written. To reword that entry, call update with its id and this version.',
              entry: entryView(covering), count: before!.entries.length, chars: before!.content.length, limit,
            });
          }
          const mutation = {
            action: action as 'add' | 'update' | 'forget', fact, id: args.id ? String(args.id) : undefined,
            expectedVersion: args.expectedVersion ? String(args.expectedVersion) : undefined,
            source: { kind: 'explicit' as const, sessionId: ctx.sessionId, runId: ctx.runId }, signal: ctx.signal,
          };
          const write = async (m = mutation): Promise<MemorySnapshot> => projectRepo ? projectRepo.mutate({ ...m, cap: PROJECT_MEMORY_CHAR_BUDGET }) : brain.mutateMemory!(ctx.userId, m);
          const isFull = (e: unknown): boolean => e instanceof MemoryRepositoryError && e.code === 'MEMORY_FULL';
          // 版本冲突里分出「抄错了」:10-13 live 里模型把 list 回执的 36 位版本号抄串两位,两次都被回「记忆已变」,最后告诉用户没改成。
          // 带来的号和现在的版本只差几个字符 → 是照着现在这份抄错了,不是读的时候还是别的版本(随机 UUID 之间差三十来位):
          // 回现在的版本和这一条现在的原文,让模型看过再重试。差得远 → 真冲突或读得太早,照旧抛出去(重新 list、重新看)。
          // CAS 不放松:不替模型改号,重试照样要带对的版本。
          const miscopiedVersion = async (): Promise<string | null> => {
            const given = mutation.expectedVersion;
            if (action === 'add' || !given || given.length > 64) return null;
            const now = await read();
            if (!now || given === now.version || editDistance(given, now.version) > MISCOPY_MAX_EDITS) return null;
            const target = now.entries.find((e) => e.id === mutation.id);
            const scoped = projectRepo ? `, scope "project"` : '';
            return `Error: expectedVersion ${JSON.stringify(given)} is not a version of this memory; it differs from the current version by a few characters, so it was probably copied wrong. Nothing was written. ` +
              `The current version is ${JSON.stringify(now.version)}. ` +
              (target
                ? `Entry ${JSON.stringify(target.id)} currently reads ${JSON.stringify(target.content)}. If that is still the entry you meant to ${action}, retry with exactly this expectedVersion${scoped}; otherwise list again.`
                : `There is no entry with id ${JSON.stringify(mutation.id)}; list again${scoped} and use an ID from it.`);
          };
          let snapshot: MemorySnapshot | undefined;
          let compacted: Extract<CompactionOutcome, { status: 'compacted' }> | undefined;
          let fullError: unknown;
          try { snapshot = await write(); } catch (e) {
            const misread = e instanceof MemoryRepositoryError && e.code === 'MEMORY_VERSION_CONFLICT' ? await miscopiedVersion() : null;
            if (misread) return misread;
            if (!isFull(e)) throw e;
            fullError = e;
            // 项目记忆写满(10-05 用户:「记忆满了就让 agent 压缩一下」):先让模型把整份压一遍,再记这一句。agent 级不走这条(那边有 Dream)。
            // 只管 add:update 带着旧版本号和旧条目 id,压完都对不上了,那种照旧回现有条目。压不成(没模型 / 压不动 / 刚试过)同样照旧。
            const made = projectRepo && action === 'add' ? await compactProjectMemory(ctx.userId, projectRef!, { fallbackModelId: ctx.modelId, sessionId: ctx.sessionId, signal: ctx.signal }) : undefined;
            if (made?.status === 'compacted') {
              // 不带模型给的 expectedVersion:压缩自己把版本改了,带着它这一句必然冲突
              try { snapshot = await write({ ...mutation, expectedVersion: undefined }); compacted = made; } catch (again) { if (!isFull(again)) throw again; }
            }
          }
          if (!snapshot) {
            // 满了就回显现有条目,让模型一次删旧加新(Hermes 的 IF FULL),而不是只丢一句「超预算」。
            const full = await read();
            if (!full) throw fullError;
            return `Error: ${projectRepo ? 'project' : 'long-term'} memory is full (${full.content.length}/${limit} characters). Forget or shorten stale entries with update/forget (scope "${scope}", expectedVersion ${full.version}), then add. Current entries: ${JSON.stringify(full.entries.map(entryView))}`;
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
            // 压过一遍:条目 id 和版本都换过了,模型手里旧的那份 list 不能再用
            ...(compacted ? { compacted: `Project memory was full, so it was compacted before this was saved: ${compacted.before.count} entries (${compacted.before.chars} characters) became ${compacted.after.count} (${compacted.after.chars}). Entry IDs and versions from earlier list calls are stale; list again before update or forget.` } : {}),
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
      isEnabledFor: (profile, ctx) => profile.capabilities.log && !ctx.ephemeral, // 临时成员:同 remember
      definition: {
        type: 'function',
        function: {
          name: 'log_event',
          description:
            'Append one thing that happened in this interaction to today\'s log (kept by date; the user can read it). ' +
            'Use it for completed work, conclusions reached, files produced, where a task stands; not for trivial chit-chat, and not for lasting facts (those go to remember).',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: 'A one-sentence event/progress to record in today\'s log' } },
            required: ['text'],
          },
        },
      },
      execute: async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        if (ctx.ephemeral) return 'Error: The activity log is unavailable to a temporary team member.';
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
