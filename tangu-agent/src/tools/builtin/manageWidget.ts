/**
 * 小组件的工具面:HTML 卡 / 原生卡带 `widget` 参数存原件、改原件(saveCardWidget),manage_widget 列出、读、软删除、恢复、记一笔。
 * 存储口径见 services/widgetStore.ts。
 * 门禁 widgetsEnabledFor:客户端握手 widget.v1 ∧ 本机执行。⚠️桌面要等 WidgetHost 接好(开工顺序第 3 步)才上报这个能力:
 * 只发 edits 的更新没有 html,现在的 SketchCard 画不出来;云沙箱没有 agents/ 文件夹,带 widget 只会把卡写进一个即将消失的工作区。
 * 审批:这些工具本身 sideEffect none,带 widget 的调用按写文件档走(approvals.widgetWrite),否则绕过只读档。
 * 本文件不 import sketch.ts / intelligentUi.ts:那两个模块加载时就要用这里的 WIDGET_PARAMS。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { currentDisplayAgentSlug } from '../../seams/runContext.js';
import { createWidget, deleteRecord, findWidgetByName, listWidgets, readRecords, readWidget, readWidgetContent, restoreWidget, setRecord, softDeleteWidget, updateWidget, WidgetError, type WidgetEdit, type WidgetEntry, type WidgetInfo, type WidgetPlace } from '../../services/widgetStore.js';

export const WIDGET_CAPABILITY = 'widget.v1';
export function widgetsEnabledFor(ctx: Pick<ToolContext, 'execMode' | 'clientCapabilities' | 'subAgentDepth' | 'channelSession'>): boolean {
  return ctx.execMode === 'host' && !!ctx.clientCapabilities?.includes(WIDGET_CAPABILITY) && !((ctx.subAgentDepth ?? 0) >= 1) && !ctx.channelSession;
}

/** 卡回带的最新版上限:它进上下文,也落库。 */
const STALE_CONTENT_CHARS = 64 * 1024;
const RECORD_PREVIEW = 50;

const placeOf = (ctx: ToolContext): WidgetPlace => ({
  agentSlug: currentDisplayAgentSlug() || ctx.agentSlug || DEFAULT_AGENT_SLUG,
  projectDir: ctx.projectScoped ? ctx.projectPath : null,
});
const SCOPE_LABEL = { project: 'saved to this project', agent: 'saved to you', user: 'available to all agents' } as const;
const describe = (w: WidgetInfo): string => `"${w.manifest.name}" (id ${w.manifest.id}, rev ${w.manifest.rev}, ${SCOPE_LABEL[w.scope]})`;
const parseArg = (v: unknown): any => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const fail = (e: unknown): string => {
  if (e instanceof WidgetError) return `Error: ${e.message}`;
  throw e;
};

export const WIDGET_PARAMS = {
  widget: {
    type: 'object',
    description: 'Keep this card as a widget (小组件). New: { name }. Change an existing one: { id, expectedRev }.',
    properties: {
      name: { type: 'string', description: 'New widget: lowercase slug, e.g. "tokyo-ledger".' },
      id: { type: 'string', description: 'Existing widget id, e.g. "w_7f3a1c9e0b12".' },
      expectedRev: { type: 'integer', description: 'The rev you last saw. A stale rev saves nothing and returns the latest version.' },
      sizes: { type: 'array', items: { type: 'string', enum: ['sm', 'md', 'lg'] }, description: 'New widget: dashboard sizes it fits.' },
      rail: { type: 'boolean', description: 'New widget: it stays useful at 226px wide.' },
    },
  },
  summary: { type: 'string', description: 'One line: what this version changed.' },
} as const;
export const WIDGET_EDITS_PARAM = {
  type: 'array',
  description: 'Changing a widget: replacements instead of the whole HTML. Each find must match exactly once; if any fails, nothing is saved.',
  items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] },
} as const;

/** 和 sketch 段同门禁,只在 widgetsEnabledFor 时追加。 */
export const WIDGET_SECTION = `## Widgets (小组件)

A widget is a card the user keeps: one named original that the chat, dashboards and the card rail all show, with its records in a small database beside it. It is built here in the conversation. Do not search the store or write a plugin for it.

Keep a card as a widget when the user asks for a widget / 小组件, asks to keep or reuse a card, or wants something they will come back to and add to (a ledger, tracker, countdown, habit grid). One-off charts and explanations stay plain cards.

Create: add \`widget: { name }\` to \`intelligent_ui_html\` or \`intelligent_ui\`. The result gives the id and rev.

Change: never create a second widget to change one. Call the same tool with \`widget: { id, expectedRev }\` and \`summary\`. For HTML send \`edits\` rather than the whole page; for \`intelligent_ui\` send the whole document. Changing a widget keeps its records. If the name is taken, the result gives the existing id: change that one unless the user wants a separate widget. If you lost the id, \`manage_widget\` lists them.

To record an entry for the user (记一笔), call \`manage_widget\` with \`set_record\`; records stay when the card changes.`;

/** 存 / 改原件。返回给模型的回执;失败以 Error 开头,什么都没落盘。content 未给 = 只发 edits。
 *  ⚠️不给模型选层级:Luna 在项目会话里自己带上 scope:user(live 10-31),一张项目卡落到了所有 Agent 都看得到的地方。用户级要等搬家(开工顺序的管理页那步)。 */
export async function saveCardWidget(args: Record<string, any>, ctx: ToolContext, card: { entry: WidgetEntry; content?: string; title?: string; edits?: WidgetEdit[] }): Promise<string> {
  const widget = parseArg(args.widget);
  if (!widget || typeof widget !== 'object') return 'Error: widget must be { name } or { id, expectedRev }.';
  const place = placeOf(ctx);
  const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 200) : undefined;
  const title = typeof card.title === 'string' ? card.title : undefined;
  try {
    if (typeof widget.id === 'string') {
      if (!Number.isInteger(widget.expectedRev)) return 'Error: changing a widget needs expectedRev.';
      if (card.edits && card.content !== undefined) return 'Error: send edits or the whole content, not both.';
      if (!card.edits && card.content === undefined) return 'Error: send edits or the whole content.';
      const r = await updateWidget(place, { id: widget.id, expectedRev: widget.expectedRev, edits: card.edits, content: card.content, title, summary });
      if (!r.ok) {
        const clipped = r.content.length > STALE_CONTENT_CHARS ? `${r.content.slice(0, STALE_CONTENT_CHARS)}\n[truncated]` : r.content;
        return `Error: widget ${widget.id} is at rev ${r.widget.manifest.rev}, not ${widget.expectedRev}. Nothing was saved. Latest version:\n${clipped}`;
      }
      return `Updated widget ${describe(r.widget)}: rev ${r.fromRev} → ${r.widget.manifest.rev}. Its records are unchanged.`;
    }
    if (typeof widget.name !== 'string') return 'Error: widget must be { name } or { id, expectedRev }.';
    if (card.content === undefined) return 'Error: a new widget needs its full content.';
    const r = await createWidget(place, { name: widget.name, title, entry: card.entry, content: card.content, summary, sizes: Array.isArray(widget.sizes) ? widget.sizes.filter((s: unknown) => s === 'sm' || s === 'md' || s === 'lg') : undefined, rail: widget.rail === true });
    if (!r.created) return `Error: a widget named "${widget.name}" already exists: ${describe(r.widget)}${r.widget.manifest.deletedAt ? ', deleted, restore it with manage_widget' : ''}. Nothing was saved. To change it use widget { id, expectedRev }; to keep a separate one pick another name.`;
    return `Saved widget ${describe(r.widget)}.`;
  } catch (e) { return fail(e); }
}

function listing(place: WidgetPlace): string {
  const { widgets, unreadable } = listWidgets(place);
  const line = (w: WidgetInfo): string => {
    let records = '';
    try { const r = readRecords(w); records = r.status === 'none' ? 'no records on this device' : `${r.rows.length} records`; } catch (e) { records = (e as Error).message; }
    return `${w.manifest.id} rev ${w.manifest.rev} ${w.manifest.name} "${w.manifest.title}" [${w.scope}] ${records}${w.manifest.deletedAt ? ` deleted ${w.manifest.deletedAt}` : ''}`;
  };
  const lines = [...widgets.map(line), ...unreadable.map((u) => `unreadable: ${u.name} [${u.scope}] ${u.error}`)];
  return lines.length ? lines.join('\n') : '(no widgets)';
}

export const manageWidgetProvider: ToolProvider = {
  id: 'builtin:manage_widget',
  tools: () => [
    {
      name: 'manage_widget',
      mode: 'both',
      isEnabledFor: (_profile, ctx) => widgetsEnabledFor(ctx),
      deferred: true,
      deferHint: 'Your widgets (小组件): list them, read one, record an entry, delete or restore.',
      capabilities: { sideEffect: 'write', parallel: false, defaultTimeoutMs: 5_000 },
      definition: {
        type: 'function',
        function: {
          name: 'manage_widget',
          description: 'Widgets (小组件) you can see in this session, nearest first: this project, then yours, then the user\'s. ' +
            'list = all of them; read = one widget\'s definition and records; set_record = add a record, or change one with record_id (only the given fields); delete_record; ' +
            'delete = soft delete, restorable for 30 days; restore. Creating and changing a widget happens on intelligent_ui_html / intelligent_ui.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['list', 'read', 'set_record', 'delete_record', 'delete', 'restore'] },
              id: { type: 'string', description: 'Widget id (all actions except list).' },
              name: { type: 'string', description: 'read: widget name instead of id.' },
              record_id: { type: 'string', description: 'set_record: the record to change (omit to add one). delete_record: required.' },
              fields: { type: 'object', description: 'set_record: field → text, number, true/false, list of text, or null.' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args, ctx) => {
        const place = placeOf(ctx);
        const action = String(args.action || '');
        const id = String(args.id || '').trim();
        try {
          if (action === 'list') return listing(place);
          if (action === 'read') {
            const w = args.name ? findWidgetByName(place, String(args.name)) : readWidget(place, id);
            if (!w) return `Error: widget "${String(args.name)}" not found`;
            const r = readRecords(w);
            const rows = r.status === 'none' ? 'No records on this device.' : `${r.rows.length} records${r.rows.length > RECORD_PREVIEW ? `, last ${RECORD_PREVIEW}` : ''}:\n${JSON.stringify(r.rows.slice(-RECORD_PREVIEW))}`;
            return `Widget ${describe(w)}${w.manifest.deletedAt ? `, deleted ${w.manifest.deletedAt}` : ''}\n${rows}\n${w.manifest.entry}:\n${readWidgetContent(w)}`;
          }
          if (!id) return 'Error: id is required (use list to see ids)';
          if (action === 'set_record') {
            const r = await setRecord(place, id, parseArg(args.fields), args.record_id === undefined ? undefined : String(args.record_id));
            return `${r.created ? 'Added' : 'Changed'} record ${r.id}.`;
          }
          if (action === 'delete_record') return (await deleteRecord(place, id, String(args.record_id ?? ''))) ? 'Deleted the record.' : `Error: record ${String(args.record_id ?? '')} not found`;
          if (action === 'delete') return `Deleted widget ${describe(await softDeleteWidget(place, id))}. It can be restored for 30 days.`;
          if (action === 'restore') return `Restored widget ${describe(await restoreWidget(place, id))}.`;
          return 'Error: action must be list/read/set_record/delete_record/delete/restore';
        } catch (e) { return fail(e); }
      },
    },
  ],
};
