/**
 * muse_space —— 卜算子填自己那份「今日简报」布局(2026-11-08,Muse Space 方案 D 第一期;契约 contracts/museSpace.ts,IO services/museSpace.ts)。
 *   read   读当前有效布局(含用户的摆放):两份 rev、那句话、备好的、格子(哪些藏着)、挂着的提议、墓碑、自己能提议的小组件。
 *   update 只交差量,带 expectedRev:那句话(≤160 字,超长拒绝不截)、备好的(≤3 份,得在 Library 里真有)、提一张新卡。
 *          每个 run 那句话最多改一次、最多新提一张(按 run id 记在内存);墓碑里的 key、已在格子里的、不是自己的小组件一律拒。
 *          时刻(hero.at / proposal.at)引擎填。rev 对不上回最新布局让它重来。
 *   widget 建一个自己的原生小组件(Agent 级,走 intelligent_ui 同一套文档校验 + saveCardWidget);只建不摆 —— 摆要再提议、用户点头。
 * 只给卜算子(周期与手聊,子代理除外);远程会话不可见,中途被远端染色的执行时拒。失败一律 `Error:` 开头、什么都不写。
 * 审批:widget 同写文件档(approvals.widgetWrite),read / update 不进审批(Space 目录三档免审)。
 */
import { MUSE_AGENT_SLUG } from '../../agents/agentRegistry.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { effectiveRemote } from '../../services/remoteOrigin.js';
import { libraryFileStat, readMuseSpaceState, updateMuseDoc, museSpaceDocFile, emptyMuseDoc, type MuseSpaceState } from '../../services/museSpace.js';
import { findWidgetByName, listWidgets, WidgetError, type WidgetPlace } from '../../services/widgetStore.js';
import { saveCardWidget } from './manageWidget.js';
import { uiDocumentTooLarge, validateUIDocument } from '../../shared/intelligentUi.js';
import { uiDocumentIssues } from '../../shared/intelligentUiExpr.js';
import {
  isMuseBuiltinCard, normalizeLibraryPath, validMuseCardKey, validWidgetId,
  MUSE_HERO_MAX, MUSE_PREPARED_MAX, MUSE_PROPOSED_MAX, MUSE_WHY_MAX, type MuseCardRef, type MuseSpaceDoc, type MuseSpaceProposal,
} from '../../contracts/museSpace.js';

const MUSE_PLACE: WidgetPlace = { agentSlug: MUSE_AGENT_SLUG, projectDir: null };
const HERO_SOURCES_MAX = 5;
const REMOTE_DENIED = 'Error: remote sessions cannot read or change your Space. It is only available on the user\'s computer.';

/** 每个 run 用掉了什么(那句话改过没有、新提了几张)。只在内存:引擎重启就忘,最坏一个 run 里多一次。封顶防长跑进程越攒越多。 */
const runUsage = new Map<string, { hero: boolean; proposals: number }>();
const RUN_USAGE_MAX = 500;
/** 没有 runId 的调用(测试 / 直接调)按会话记:Muse 每个周期本来就是一个新会话,不至于变成「不限」。 */
const usageKey = (ctx: ToolContext): string => (ctx.runId ? `r:${ctx.runId}` : `s:${ctx.sessionId}`);
function usageOf(ctx: ToolContext): { hero: boolean; proposals: number } {
  const k = usageKey(ctx);
  let u = runUsage.get(k);
  if (!u) {
    u = { hero: false, proposals: 0 };
    runUsage.set(k, u);
    while (runUsage.size > RUN_USAGE_MAX) runUsage.delete(runUsage.keys().next().value as string);
  }
  return u;
}
/** 测试用。 */
export function resetMuseSpaceRunUsageForTest(): void { runUsage.clear(); }

const isMuse = (ctx: { agentSlug?: string; subAgentDepth?: number; remote?: unknown }): boolean =>
  ctx.agentSlug === MUSE_AGENT_SLUG && !((ctx.subAgentDepth || 0) >= 1) && !ctx.remote;
const parseArg = (v: unknown): any => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const chars = (s: string): number => Array.from(s).length;

/** 自己能提议的小组件:Muse 的 Agent 级、没删的。读不了的文件夹不算「没有」,照实带出去。 */
function ownWidgets(): { widgets: { id: string; name: string; title: string }[]; unreadable: number } {
  const { widgets, unreadable } = listWidgets(MUSE_PLACE);
  return {
    widgets: widgets.filter((w) => w.scope === 'agent' && !w.manifest.deletedAt).map((w) => ({ id: w.manifest.id, name: w.manifest.name, title: w.manifest.title })),
    unreadable: unreadable.filter((u) => u.scope === 'agent').length,
  };
}

const refText = (r: MuseCardRef): Record<string, string> => ('builtin' in r ? { builtin: r.builtin } : { widgetId: r.widgetId });

/** 给模型看的有效布局(紧凑 JSON)。 */
async function layoutText(s: MuseSpaceState, ctx: ToolContext): Promise<string> {
  const doc = s.doc;
  const prepared = await Promise.all((doc?.prepared ?? []).map(async (p) => ((await libraryFileStat(p)) ? p : `${p} (missing)`)));
  let widgets: ReturnType<typeof ownWidgets> | null = null;
  try { widgets = ownWidgets(); } catch { widgets = null; }
  const used = usageOf(ctx);
  const out = {
    rev: doc?.rev ?? 0,
    message: doc?.hero ? { text: doc.hero.text, writtenAt: doc.hero.at, ...(doc.hero.sources?.length ? { sources: doc.hero.sources } : {}) } : null,
    prepared,
    cards: s.composed.cards.map((c) => c.key),
    hiddenByUser: s.composed.hidden.map((c) => c.key),
    pendingProposals: s.composed.proposed.map((p) => ({ key: p.key, ...refText(p.ref), ...(p.why ? { why: p.why } : {}) })),
    rejectedKeys: s.placement.tombstones.map((t) => t.key),
    yourWidgets: widgets ? widgets.widgets.slice(0, 20) : 'could not be listed',
    thisRun: { messageChangesLeft: used.hero ? 0 : 1, proposalsLeft: Math.max(0, 1 - used.proposals) },
    ...(s.problems.length ? { problems: s.problems.map((p) => p.message) } : {}),
    ...(s.placementUnknown ? { note: 'The user\'s arrangement cannot be read right now, so proposals are paused.' } : {}),
    // live 首跑(11-08):读到那句话是空的也不写。回执就在它眼前,点一句比只靠简报里的规矩管用
    ...(!doc?.hero && !used.hero ? { hint: `Your message is empty: write one line now with update { expectedRev: ${doc?.rev ?? 0}, hero }.` } : {}),
  };
  return JSON.stringify(out);
}

async function doRead(ctx: ToolContext): Promise<string> {
  return layoutText(await readMuseSpaceState(), ctx);
}

interface Delta { hero?: string; heroSources?: string[]; prepared?: string[]; propose?: MuseSpaceProposal }

/** 不看当前状态就能判的:长度、路径在不在、小组件是不是自己的。返回差量或 Error 串。 */
async function staticDelta(args: Record<string, any>): Promise<Delta | string> {
  const d: Delta = {};
  if (args.hero !== undefined && args.hero !== null && typeof args.hero !== 'string') return 'Error: hero must be text (an empty string clears it).';
  if (typeof args.hero === 'string' || args.hero === null) {
    const text = (args.hero ?? '').trim();
    if (chars(text) > MUSE_HERO_MAX) return `Error: the message is ${chars(text)} characters; the limit is ${MUSE_HERO_MAX}. Nothing was saved. Shorten it and try again.`;
    if (/\n/.test(text)) return 'Error: the message must be one line. Nothing was saved.';
    d.hero = text;
  }
  const sources = parseArg(args.heroSources);
  if (sources !== undefined && sources !== null) {
    if (!d.hero) return 'Error: heroSources go with a new message (hero). Nothing was saved.';
    if (!Array.isArray(sources) || sources.length > HERO_SOURCES_MAX) return `Error: heroSources must be a list of up to ${HERO_SOURCES_MAX} Library paths. Nothing was saved.`;
    d.heroSources = [];
    for (const p of sources) {
      const f = await libraryFileStat(String(p));
      if (!f) return `Error: heroSources: "${String(p)}" is not a file in your Library. Nothing was saved.`;
      if (!d.heroSources.includes(f.path)) d.heroSources.push(f.path);
    }
  }
  const prepared = parseArg(args.prepared);
  if (prepared !== undefined && prepared !== null) {
    if (!Array.isArray(prepared)) return 'Error: prepared must be a list of Library paths. Nothing was saved.';
    if (prepared.length > MUSE_PREPARED_MAX) return `Error: prepared lists at most ${MUSE_PREPARED_MAX} files (got ${prepared.length}). Nothing was saved.`;
    d.prepared = [];
    for (const p of prepared) {
      if (!normalizeLibraryPath(p)) return `Error: prepared: "${String(p)}" is not a relative path inside your Library. Nothing was saved.`;
      const f = await libraryFileStat(String(p));
      if (!f) return `Error: prepared: "${String(p)}" does not exist in your Library. Write the file first. Nothing was saved.`;
      if (!d.prepared.includes(f.path)) d.prepared.push(f.path);
    }
  }
  const propose = parseArg(args.propose);
  if (propose !== undefined && propose !== null) {
    if (typeof propose !== 'object' || Array.isArray(propose)) return 'Error: propose must be { key, widgetId or builtin, why }. Nothing was saved.';
    const key = String(propose.key ?? '');
    if (!validMuseCardKey(key)) return 'Error: propose.key must be a lowercase slug such as "focus-week". Nothing was saved.';
    const why = typeof propose.why === 'string' ? propose.why.trim() : '';
    if (!why) return 'Error: propose.why is required: one line telling the user why this card helps. Nothing was saved.';
    if (chars(why) > MUSE_WHY_MAX) return `Error: propose.why is ${chars(why)} characters; the limit is ${MUSE_WHY_MAX}. Nothing was saved.`;
    const hasW = propose.widgetId != null, hasB = propose.builtin != null;
    if (hasW === hasB) return 'Error: propose needs exactly one of widgetId (one of your widgets) or builtin. Nothing was saved.';
    let ref: MuseCardRef;
    if (hasB) {
      if (!isMuseBuiltinCard(propose.builtin)) return 'Error: builtin must be one of todos, tracking, today, status. Nothing was saved.';
      if (key !== propose.builtin) return `Error: a built-in card's key is its own name: use key "${propose.builtin}". Nothing was saved.`;
      ref = { builtin: propose.builtin };
    } else {
      if (!validWidgetId(propose.widgetId)) return 'Error: widgetId must look like "w_7f3a1c9e0b12". Nothing was saved.';
      if (isMuseBuiltinCard(key)) return `Error: "${key}" is the name of a built-in card; pick another key for your widget. Nothing was saved.`;
      let own: ReturnType<typeof ownWidgets>;
      try { own = ownWidgets(); } catch (e) { return `Error: your widgets cannot be listed (${(e as Error).message}). Nothing was saved.`; }
      if (!own.widgets.some((w) => w.id === propose.widgetId)) {
        return `Error: ${String(propose.widgetId)} is not one of your widgets${own.unreadable ? ` (and ${own.unreadable} of your widget folders could not be read)` : ''}. Create one with muse_space widget, or use an id from muse_space read. Nothing was saved.`;
      }
      ref = { widgetId: propose.widgetId };
    }
    d.propose = { key, ref, why };
  }
  return d;
}

async function doUpdate(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  if (!Number.isInteger(args.expectedRev) || args.expectedRev < 0) return 'Error: expectedRev is required: the rev from muse_space read (0 before your first update).';
  const d = await staticDelta(args);
  if (typeof d === 'string') return d;
  if (d.hero === undefined && d.prepared === undefined && !d.propose) return 'Error: nothing to change. Send hero, prepared or propose.';
  const used = usageOf(ctx);
  const nowIso = new Date().toISOString();
  let heroChanged = false;
  const r = await updateMuseDoc(args.expectedRev, (s) => {
    const cur: MuseSpaceDoc = s.doc ?? emptyMuseDoc();
    const next: MuseSpaceDoc = { ...cur, prepared: [...cur.prepared], proposed: [...cur.proposed] };
    if (d.hero !== undefined) {
      const same = (cur.hero?.text ?? '') === d.hero && JSON.stringify(cur.hero?.sources ?? []) === JSON.stringify(d.heroSources ?? cur.hero?.sources ?? []);
      if (!same) {
        if (used.hero) return { ok: false, error: 'you already changed the message in this run; it changes at most once per cycle. Nothing was saved.' };
        next.hero = d.hero ? { text: d.hero, at: nowIso, ...(d.heroSources?.length ? { sources: d.heroSources } : {}) } : null;
        heroChanged = true;
      }
    }
    if (d.prepared) next.prepared = d.prepared;
    if (d.propose) {
      const p = d.propose;
      if (s.placementUnknown) return { ok: false, error: 'the user\'s arrangement cannot be read right now, so you cannot propose cards. Nothing was saved.' };
      if (s.placement.tombstones.some((t) => t.key === p.key)) return { ok: false, error: `the user rejected "${p.key}"; never propose that key again. Nothing was saved.` };
      const members = [...s.composed.cards, ...s.composed.hidden];
      if (members.some((c) => c.key === p.key)) return { ok: false, error: `"${p.key}" is already on the user's page. Nothing was saved.` };
      if ('widgetId' in p.ref) {
        const wid = p.ref.widgetId;
        if (members.some((c) => 'widgetId' in c.ref && c.ref.widgetId === wid)) return { ok: false, error: `${wid} is already on the user's page. Nothing was saved.` };
        if (s.composed.proposed.some((c) => c.key !== p.key && 'widgetId' in c.ref && c.ref.widgetId === wid)) return { ok: false, error: `${wid} is already proposed under another key. Nothing was saved.` };
      }
      if (s.composed.proposed.some((c) => c.key === p.key)) return { ok: false, error: `"${p.key}" is already waiting for the user. Nothing was saved.` };
      if (used.proposals >= 1) return { ok: false, error: 'you already proposed a card in this run; at most one new proposal per cycle. Nothing was saved.' };
      if (s.composed.proposed.length >= MUSE_PROPOSED_MAX) return { ok: false, error: `${s.composed.proposed.length} proposals are already waiting for the user; wait until they place or reject one. Nothing was saved.` };
      next.proposed = [...s.composed.proposed, { key: p.key, ref: p.ref, why: p.why, at: nowIso }];
    }
    return { ok: true, doc: next };
  });
  if (!r.ok) {
    if (r.reason === 'invalid') return `Error: ${r.error}`;
    if (r.reason === 'unreadable') {
      return `Error: your ${r.error}. Nothing was saved, and it is not repaired automatically. ` +
        (r.lastGood ? `Restore the last valid version below with write_file at ${museSpaceDocFile()}, then call muse_space read again:\n${JSON.stringify(r.lastGood, null, 2)}` : `There is no earlier valid version; delete ${museSpaceDocFile()} or write a valid one, then call muse_space read again.`);
    }
    return `Error: your layout is at rev ${r.state.doc?.rev ?? 0}, not ${args.expectedRev}. Nothing was saved. Latest layout:\n${await layoutText(r.state, ctx)}`;
  }
  if (!r.changed) return `No change: your layout already says that (rev ${r.doc.rev}).`;
  if (heroChanged) used.hero = true;
  if (d.propose) used.proposals += 1;
  const parts = [
    heroChanged ? (r.doc.hero ? 'message updated' : 'message cleared') : '',
    d.prepared ? `prepared: ${d.prepared.length ? d.prepared.join(', ') : 'none'}` : '',
    d.propose ? `proposed "${d.propose.key}"; the user decides whether to place it` : '',
  ].filter(Boolean);
  return `Saved your layout (rev ${r.doc.rev})${parts.length ? `: ${parts.join('; ')}` : ''}.`;
}

/** 建卜算子自己的原生小组件:文档校验同 intelligent_ui(同一组校验函数),落盘同 saveCardWidget,层级钉死 Muse 的 Agent 级。 */
async function doWidget(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return 'Error: name is required: a lowercase slug such as "focus-week".';
  const document = typeof args.document === 'string' ? args.document : args.document && typeof args.document === 'object' ? JSON.stringify(args.document) : '';
  if (!document || uiDocumentTooLarge(document)) return 'Error: document must be an intelligent_ui document (JSON) up to 64 KiB. Nothing was saved.';
  let title: string;
  let issues: string[];
  try {
    const doc = validateUIDocument(JSON.parse(document), { maxVersion: 2 });
    // 卜算子的卡画在宿主页上,宿主那边没有这次 run 的应用卡目录(ctx.uiCards),引用不了
    if (doc.blocks.some((b) => b.kind === 'app-card')) return 'Error: app-card blocks cannot be used in your widgets. Nothing was saved.';
    title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : doc.title;
    issues = uiDocumentIssues(doc); // 同 intelligent_ui:只提示,不挡
  } catch (e) { return `Error: invalid intelligent_ui document. ${e instanceof Error ? e.message : String(e)}. Nothing was saved.`; }
  const saved = await saveCardWidget({ widget: { name } }, { ...ctx, agentSlug: MUSE_AGENT_SLUG }, { entry: 'widget.json', title, content: document }, { place: MUSE_PLACE });
  if (saved.startsWith('Error')) return saved;
  let id = '';
  try { id = findWidgetByName(MUSE_PLACE, name)?.manifest.id ?? ''; } catch (e) { if (!(e instanceof WidgetError)) throw e; }
  const warn = issues.length ? `\nThese values show "—" at the initial values; fix them unless that is intended:\n- ${issues.join('\n- ')}` : '';
  return `Created your widget "${name}"${id ? ` (id ${id})` : ''}. It is not on the user's page: propose it with muse_space update propose { key, widgetId${id ? `: "${id}"` : ''}, why }.${warn}`;
}

export const museSpaceToolProvider: ToolProvider = {
  id: 'builtin:muse_space',
  tools: () => [
    {
      name: 'muse_space',
      mode: 'both',
      isEnabledFor: (profile, ctx) => !!profile.capabilities.hostExec && isMuse(ctx),
      capabilities: { sideEffect: 'write', parallel: false, defaultTimeoutMs: 10_000 },
      definition: {
        type: 'function',
        function: {
          name: 'muse_space',
          description:
            'Your Space ("Today\'s brief"), the page the desktop draws for the user. ' +
            'read: the effective layout (your message, prepared files, the user\'s cards, pending and rejected proposals, your widgets, rev). ' +
            'update: change only what you send, with expectedRev from read. ' +
            'widget: create one of your own native widgets (an intelligent_ui document); it is not shown until you propose it and the user places it. ' +
            'The user arranges the cards; you cannot move or remove them.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['read', 'update', 'widget'] },
              expectedRev: { type: 'integer', description: 'update: the rev from read (0 before your first update). A stale rev saves nothing and returns the latest layout.' },
              hero: { type: 'string', description: `update: the one-line message at the top, at most ${MUSE_HERO_MAX} characters; [[path]] links to Library files are allowed. An empty string clears it. At most one change per cycle.` },
              heroSources: { type: 'array', items: { type: 'string' }, description: 'update, with hero: Library paths the message is based on.' },
              prepared: { type: 'array', items: { type: 'string' }, description: `update: up to ${MUSE_PREPARED_MAX} Library paths of files you prepared for the user (replaces the list; the files must exist).` },
              propose: {
                type: 'object',
                description: 'update: suggest one new card; the user places or rejects it. At most one per cycle; never a rejected key.',
                properties: {
                  key: { type: 'string', description: 'Lowercase slug naming what the card is about, e.g. "focus-week".' },
                  widgetId: { type: 'string', description: 'One of your widgets (from read or widget).' },
                  builtin: { type: 'string', enum: ['todos', 'tracking', 'today', 'status'], description: 'Or a built-in card; its key is its own name.' },
                  why: { type: 'string', description: `One line for the user, at most ${MUSE_WHY_MAX} characters.` },
                },
                required: ['key', 'why'],
              },
              name: { type: 'string', description: 'widget: lowercase slug, e.g. "focus-week".' },
              title: { type: 'string', description: 'widget: the card title (defaults to the document title).' },
              document: { type: 'string', description: 'widget: JSON-encoded intelligent_ui document (version 1 or 2, no app-card blocks).' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args, ctx) => {
        if (effectiveRemote(ctx)) return REMOTE_DENIED;
        if (ctx.agentSlug !== MUSE_AGENT_SLUG) return 'Error: muse_space is only for Muse.';
        const action = String(args.action || '');
        try {
          if (action === 'read') return await doRead(ctx);
          if (action === 'update') return await doUpdate(args, ctx);
          if (action === 'widget') return await doWidget(args, ctx);
          return 'Error: action must be read, update or widget.';
        } catch (e) {
          if (e instanceof WidgetError) return `Error: ${e.message}`;
          return `Error: ${e instanceof Error ? e.message : String(e)}. Nothing was saved.`;
        }
      },
    },
  ],
};
