/**
 * 小组件的存储规矩(services/widgetStore.ts)和工具面(manageWidget.ts、sketch.ts):撞名不覆盖、版本对不上不落盘、edits 整批校验、
 * 读失败不当空、软删除 30 天、记录不进 Library;写入过审批,不绕过只读档。两台设备离线记账在 agentFileSync.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ publish: vi.fn(async (..._a: any[]) => 1) }));
vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: state.publish }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));

import { agentsDir, humanDir } from '../src/core/tanguHome.js';
import { applyEdits, createWidget, deleteRecord, findWidgetByName, listWidgets, purgeExpiredWidgets, readRecords, readWidget, readWidgetContent, restoreWidget, setRecord, softDeleteWidget, updateWidget, WIDGET_DEF_MAX_BYTES, WidgetError, type WidgetPlace } from '../src/services/widgetStore.js';
import { manageWidgetProvider, widgetsEnabledFor } from '../src/tools/builtin/manageWidget.js';
import { sketchProvider } from '../src/tools/builtin/sketch.js';
import { gateToolCall, resolveApproval, toolNeedsApproval, widgetWrite } from '../src/services/approvals.js';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import '../src/tools/registry.js';
import type { ToolCall } from '../src/core/types.js';

let home: string, project: string;
const place = (): WidgetPlace => ({ agentSlug: 'tester' });
const inProject = (): WidgetPlace => ({ agentSlug: 'tester', projectDir: project });
const html = '<h1>Ledger</h1>';
const make = (over: Partial<Parameters<typeof createWidget>[1]> = {}, p = place()) => createWidget(p, { name: 'ledger', entry: 'widget.html', content: html, ...over });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tangu-widget-')); project = mkdtempSync(join(tmpdir(), 'tangu-widget-project-')); process.env.TANGU_HOME = home; });
afterEach(() => { delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });

describe('where a widget lives', () => {
  it('goes to the project in a project, to the agent otherwise, to the user only when asked; records of the last two live with the person', async () => {
    const inP = (await make({ name: 'in-project' }, inProject())).widget;
    expect(inP.scope).toBe('project');
    expect(inP.dir).toBe(join(project, '.tangu', 'widgets', 'in-project'));
    const agent = (await make({ name: 'mine' })).widget;
    expect(agent.dir).toBe(join(agentsDir(), 'tester', 'Library', 'Widgets', 'mine'));
    const user = (await make({ name: 'everyone', scope: 'user' })).widget;
    expect(user.dir).toBe(join(humanDir(), 'Widgets', 'everyone'));
    await setRecord(inProject(), inP.manifest.id, { note: 'a' });
    await setRecord(place(), agent.manifest.id, { note: 'b' });
    await setRecord(place(), user.manifest.id, { note: 'c' });
    expect(existsSync(join(humanDir(), 'WidgetData', inP.manifest.id, 'data.db'))).toBe(true);
    expect(existsSync(join(humanDir(), 'WidgetData', user.manifest.id, 'data.db'))).toBe(true);
    expect(existsSync(join(agentsDir(), 'tester', 'WidgetData', agent.manifest.id, 'data.db'))).toBe(true);
    expect(existsSync(join(agentsDir(), 'tester', 'Library', 'Widgets', 'mine', 'data.db'))).toBe(false);
  });

  it('finds by name nearest first: project, then agent, then user', async () => {
    await make({ scope: 'user' });
    expect(findWidgetByName(inProject(), 'ledger')?.scope).toBe('user');
    mkdirSync(join(agentsDir(), 'tester', 'Library', 'Widgets'), { recursive: true });
    const { widget } = await make({ name: 'other' });
    expect(findWidgetByName(inProject(), 'other')?.manifest.id).toBe(widget.manifest.id);
    expect(findWidgetByName({ agentSlug: 'someone-else' }, 'other')).toBeNull(); // Agent 只看得到自己的
  });

  it('never overwrites on a name clash, in any level, and hands back the existing id', async () => {
    const first = (await make({ scope: 'user' })).widget;
    const again = await make({ content: '<p>other</p>' }, inProject());
    expect(again).toMatchObject({ created: false, widget: { manifest: { id: first.manifest.id } } });
    expect(readWidgetContent(first)).toBe(html);
    expect(readdirSync(join(humanDir(), 'Widgets'))).toEqual(['ledger']); // 没留下半截临时文件夹
  });

  it('refuses a project folder that is a symlink out of the repo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'tangu-widget-outside-'));
    symlinkSync(outside, join(project, '.tangu'));
    await expect(make({}, inProject())).rejects.toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a widget id shipped by a repo that points outside its record folder, or that doubles another widget', async () => {
    const { widget } = await make({ scope: 'user' });
    const dir = join(project, '.tangu', 'widgets', 'planted');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'widget.html'), 'x');
    const manifest = (id: string) => JSON.stringify({ schemaVersion: 1, id, rev: 1, title: 't', entry: 'widget.html', createdAt: 'x', updatedAt: 'x' });
    writeFileSync(join(dir, 'manifest.json'), manifest('../../secrets'));
    expect(listWidgets(inProject()).unreadable.map((u) => u.name)).toEqual(['planted']);
    writeFileSync(join(dir, 'manifest.json'), manifest(widget.manifest.id));
    await expect(setRecord(inProject(), widget.manifest.id, { note: 'x' })).rejects.toThrow(/two copies/);
    expect(() => readWidget(inProject(), widget.manifest.id)).toThrow(/two copies/);
  });
});

describe('a read failure is not empty', () => {
  it('a damaged manifest blocks the name instead of creating a duplicate, and blocks lookups that might have meant it', async () => {
    const { widget } = await make();
    writeFileSync(join(widget.dir, 'manifest.json'), '{ not json');
    await expect(make({ content: '<p>new</p>' })).rejects.toBeInstanceOf(WidgetError);
    expect(readFileSync(join(widget.dir, 'manifest.json'), 'utf8')).toBe('{ not json');
    await expect(updateWidget(place(), { id: widget.manifest.id, expectedRev: 1, content: 'x' })).rejects.toThrow(/could not be read/);
    expect(listWidgets(place()).unreadable).toHaveLength(1);
  });

  it('a damaged data.db is left alone: no read as empty, no write back', async () => {
    const { widget } = await make();
    await setRecord(place(), widget.manifest.id, { note: 'kept' });
    const file = join(agentsDir(), 'tester', 'WidgetData', widget.manifest.id, 'data.db');
    writeFileSync(file, '{"rows": [truncated');
    expect(() => readRecords(widget)).toThrow(WidgetError);
    await expect(setRecord(place(), widget.manifest.id, { note: 'new' })).rejects.toThrow(/left untouched/);
    await expect(deleteRecord(place(), widget.manifest.id, 'r_1')).rejects.toThrow(/left untouched/);
    expect(readFileSync(file, 'utf8')).toBe('{"rows": [truncated');
  });

  it('tells "no data.db on this device" apart from an empty one', async () => {
    const { widget } = await make();
    expect(readRecords(widget).status).toBe('none');
    const r = await setRecord(place(), widget.manifest.id, { note: 'x' });
    await deleteRecord(place(), widget.manifest.id, r.id);
    expect(readRecords(widget)).toEqual({ status: 'ok', rows: [] });
  });
});

describe('changing the original', () => {
  it('saves only on the expected rev and hands back the latest version otherwise', async () => {
    const { widget: { manifest: { id } } } = await make();
    expect(await updateWidget(place(), { id, expectedRev: 1, edits: [{ find: 'Ledger', replace: 'Tokyo' }], summary: 'renamed' })).toMatchObject({ ok: true, fromRev: 1, widget: { manifest: { rev: 2, summary: 'renamed' } } });
    const stale = await updateWidget(place(), { id, expectedRev: 1, edits: [{ find: 'Tokyo', replace: 'Osaka' }] });
    expect(stale).toMatchObject({ ok: false, content: '<h1>Tokyo</h1>', widget: { manifest: { rev: 2 } } });
    expect(readWidgetContent(readWidget(place(), id))).toBe('<h1>Tokyo</h1>');
  });

  it('applies a batch of edits all or nothing', async () => {
    const { widget: { manifest: { id } } } = await make({ content: '<a>one</a><b>two</b><i>two</i>' });
    await expect(updateWidget(place(), { id, expectedRev: 1, edits: [{ find: 'one', replace: '1' }, { find: 'two', replace: '2' }] })).rejects.toThrow(/more than once/);
    await expect(updateWidget(place(), { id, expectedRev: 1, edits: [{ find: 'one', replace: '1' }, { find: 'gone', replace: '2' }] })).rejects.toThrow(/not found/);
    expect(readWidget(place(), id).manifest.rev).toBe(1);
    expect(readWidgetContent(readWidget(place(), id))).toContain('one');
    expect(applyEdits('ab', [{ find: 'a', replace: 'b' }, { find: 'bb', replace: 'c' }])).toBe('c'); // 后一条看得到前一条的结果
  });

  it('refuses a definition over the cap and a rewrite of records', async () => {
    const { widget } = await make();
    await setRecord(place(), widget.manifest.id, { note: 'x' });
    await expect(updateWidget(place(), { id: widget.manifest.id, expectedRev: 1, content: 'x'.repeat(WIDGET_DEF_MAX_BYTES + 1) })).rejects.toThrow(/too large/);
    await updateWidget(place(), { id: widget.manifest.id, expectedRev: 1, content: '<p>new layout</p>' });
    expect(readRecords(widget).rows.map((r) => r.cells.note)).toEqual(['x']); // 改原件不碰记录
  });

  it('keeps the last 20 versions in .history, which neither sync walks', async () => {
    const { widget } = await make();
    for (let rev = 1; rev <= 23; rev++) await updateWidget(place(), { id: widget.manifest.id, expectedRev: rev, content: `<p>${rev + 1}</p>` });
    const kept = readdirSync(join(widget.dir, '.history')).map((f) => parseInt(f, 10)).sort((a, b) => a - b);
    expect(kept).toEqual(Array.from({ length: 20 }, (_, i) => i + 4));
    expect(readFileSync(join(widget.dir, '.history', '23.html'), 'utf8')).toBe('<p>23</p>');
  });
});

describe('records', () => {
  it('adds a line per record, changes only the given fields and grows columns from field names', async () => {
    const { widget: { manifest: { id } } } = await make();
    const a = await setRecord(place(), id, { item: 'lunch', amount: 38 });
    await setRecord(place(), id, { item: 'tea', paid: true, tags: ['food'] });
    await setRecord(place(), id, { amount: 40 }, a.id);
    const db = JSON.parse(readFileSync(join(agentsDir(), 'tester', 'WidgetData', id, 'data.db'), 'utf8'));
    expect(db.columns).toEqual([{ id: 'item', name: 'item', type: 'text' }, { id: 'amount', name: 'amount', type: 'number' }, { id: 'paid', name: 'paid', type: 'checkbox' }, { id: 'tags', name: 'tags', type: 'multiselect' }]);
    expect(db.rows[0].cells).toEqual({ item: 'lunch', amount: 40 });
    await expect(setRecord(place(), id, { x: 1 }, 'r_missing')).rejects.toThrow(/not found/);
    await expect(setRecord(place(), id, { nested: { a: 1 } })).rejects.toThrow(/must be text/);
    await expect(setRecord(place(), id, JSON.parse('{"__proto__": 1}'))).rejects.toThrow(/invalid field/);
  });
});

describe('soft delete', () => {
  const day = 24 * 3600_000;
  it('hides nothing on disk for 30 days, keeps records, and restores', async () => {
    const { widget: { manifest: { id }, dir } } = await make();
    await setRecord(place(), id, { note: 'kept' });
    const gone = await softDeleteWidget(place(), id);
    expect(gone.manifest.deletedAt).toBeTruthy();
    await expect(updateWidget(place(), { id, expectedRev: 1, content: 'x' })).rejects.toThrow(/restore it first/);
    await expect(setRecord(place(), id, { note: 'x' })).rejects.toThrow(/restore it first/);
    expect(await purgeExpiredWidgets(Date.now() + 29 * day)).toBe(0);
    expect(existsSync(dir)).toBe(true);
    const back = await restoreWidget(place(), id);
    expect(back.manifest.deletedAt).toBeUndefined();
    expect(readRecords(back).rows).toHaveLength(1);
    expect(await purgeExpiredWidgets(Date.now() + 90 * day)).toBe(0); // 恢复后不再清
  });

  it('purges definition and records after 30 days, leaves project widgets and unreadable ones alone', async () => {
    const agent = (await make()).widget;
    await setRecord(place(), agent.manifest.id, { note: 'old' });
    const user = (await make({ name: 'shared', scope: 'user' })).widget;
    const inP = (await make({ name: 'proj' }, inProject())).widget;
    const bad = (await make({ name: 'bad' })).widget;
    await softDeleteWidget(place(), agent.manifest.id);
    await softDeleteWidget(place(), user.manifest.id);
    await softDeleteWidget(inProject(), inP.manifest.id);
    writeFileSync(join(bad.dir, 'manifest.json'), 'broken');
    expect(await purgeExpiredWidgets(Date.now() + 31 * day)).toBe(2);
    expect(existsSync(agent.dir)).toBe(false);
    expect(existsSync(join(agentsDir(), 'tester', 'WidgetData', agent.manifest.id))).toBe(false);
    expect(existsSync(user.dir)).toBe(false);
    expect(existsSync(inP.dir)).toBe(true);
    expect(existsSync(bad.dir)).toBe(true);
  });
});

describe('tools', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({ userId: 'u', sessionId: 's', agentSlug: 'tester', execMode: 'host', client: 'desktop/0.0.0', clientCapabilities: ['intelligent-ui.v1', 'intelligent-ui.v2', 'widget.v1'], ...over }) as any;
  const card = sketchProvider.tools()[0];
  const manage = manageWidgetProvider.tools()[0];

  it('only exists for a local run on a client that declared widget.v1', () => {
    expect(widgetsEnabledFor(ctx())).toBe(true);
    expect(widgetsEnabledFor(ctx({ clientCapabilities: ['intelligent-ui.v2'] }))).toBe(false);
    expect(widgetsEnabledFor(ctx({ execMode: 'sandbox' }))).toBe(false);
    expect(widgetsEnabledFor(ctx({ subAgentDepth: 1 }))).toBe(false);
    const props = (c: any) => Object.keys((card as any).definitionFor(c).function.parameters.properties);
    expect(props(ctx())).toEqual(['html', 'title', 'widget', 'summary', 'edits']);
    expect(props(ctx({ clientCapabilities: ['intelligent-ui.v1', 'intelligent-ui.v2'] }))).toEqual(['html', 'title']);
    expect(props(ctx({ execMode: 'sandbox' }))).toEqual(['html', 'title']);
  });

  it('refuses widget params it did not offer, and draws plain cards as before', async () => {
    const off = ctx({ clientCapabilities: [] });
    expect(await card.execute({ html, widget: { name: 'x' } }, off)).toMatch(/^Error: widgets cannot be saved/);
    expect(await card.execute({ edits: [] }, off)).toMatch(/^Error: widgets cannot be saved/);
    expect(existsSync(join(agentsDir(), 'tester'))).toBe(false);
    expect(await card.execute({ html }, off)).toBe('HTML card rendered in the conversation.');
  });

  it('creates, refuses a clash, edits with the card API under its model name, and reports a stale rev with the latest version', async () => {
    const created = await card.execute({ html: '<script>window.forsionSketch.ask("hi")</script>', title: '账本', widget: { name: 'ledger', sizes: ['md', 'xl'], rail: true } }, ctx());
    expect(created).toMatch(/^HTML card rendered in the conversation\. Saved widget "ledger" \(id w_[0-9a-f]{12}, rev 1, saved to you\)/);
    const w = findWidgetByName(place(), 'ledger')!;
    expect(w.manifest).toMatchObject({ title: '账本', sizes: ['md'], rail: true });
    expect(readWidgetContent(w)).toContain('forsionIntelligentUi'); // 线上旧名不进原件:模型读到的历史和它写的 find 都是新名
    expect(await card.execute({ html, widget: { name: 'ledger' } }, ctx())).toMatch(new RegExp(`^Error: a widget named "ledger" already exists: .*${w.manifest.id}`));
    const id = w.manifest.id;
    expect(await card.execute({ widget: { id }, edits: [] }, ctx())).toMatch(/expectedRev/);
    expect(await card.execute({ widget: { id, expectedRev: 1 } }, ctx())).toMatch(/^Error: html is required/);
    expect(await card.execute({ html, widget: { id, expectedRev: 1 }, edits: [] }, ctx())).toMatch(/not both/);
    expect(await card.execute({ widget: { id, expectedRev: 1 }, edits: [{ find: 'window.forsionSketch', replace: 'window.forsionIntelligentUi.copy && window.forsionIntelligentUi' }], summary: 'guard' }, ctx())).toMatch(/^Updated widget .*rev 1 → 2\. Its records are unchanged\./);
    const stale = await card.execute({ widget: { id, expectedRev: 1 }, edits: [{ find: 'hi', replace: 'yo' }] }, ctx());
    expect(stale).toMatch(/^Error: widget .* is at rev 2, not 1\. Nothing was saved\. Latest version:\n<script>/);
    expect(await card.execute({ html: '<p>new</p>', widget: { id, expectedRev: 2 } }, ctx())).toMatch(/^HTML card rendered in the conversation\. Updated widget/);
    expect(await card.execute({ widget: 'nonsense', html }, ctx())).toMatch(/^Error: widget must be/);
  });

  it('manage_widget lists, reads, records, deletes and restores', async () => {
    expect(await manage.execute({ action: 'list' }, ctx())).toBe('(no widgets)');
    await card.execute({ html, widget: { name: 'ledger' } }, ctx());
    const id = findWidgetByName(place(), 'ledger')!.manifest.id;
    expect(await manage.execute({ action: 'list' }, ctx())).toContain(`${id} rev 1 ledger "ledger" [agent] no records on this device`);
    expect(await manage.execute({ action: 'set_record', id, fields: { item: 'lunch' } }, ctx())).toMatch(/^Added record r_/);
    expect(await manage.execute({ action: 'read', name: 'ledger' }, ctx())).toContain('"item":"lunch"');
    expect(await manage.execute({ action: 'read', id: 'w_missing' }, ctx())).toBe('Error: widget w_missing not found');
    expect(await manage.execute({ action: 'delete', id }, ctx())).toMatch(/restored for 30 days/);
    expect(await manage.execute({ action: 'list' }, ctx())).toMatch(/deleted 20/);
    expect(await manage.execute({ action: 'restore', id }, ctx())).toMatch(/^Restored widget/);
    expect(await manage.execute({ action: 'nope', id }, ctx())).toMatch(/^Error: action must be/);
  });
});

describe('approvals: a widget write is a file write', () => {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  const call = (name: string, args: unknown): ToolCall => ({ id: 'c', type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }) as ToolCall;
  let seq = 0;
  async function asks(c: ToolCall, approvalMode: string): Promise<{ asked: boolean; preview?: string }> {
    configureTangu({ profile } as any);
    const runId = `W${++seq}`, ac = new AbortController(), before = state.publish.mock.calls.length;
    const p = gateToolCall(runId, c, { sessionId: 'S', execMode: 'host', profile, approvalMode } as any, ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    const request = state.publish.mock.calls.slice(before).map((x: any[]) => x[2] ?? x[1]).find((e: any) => e?.approvalId);
    if (request) { resolveApproval(request.approvalId, 'reject'); ac.abort(); } 
    await p.catch(() => {});
    return { asked: !!request, preview: request?.preview };
  }
  it('classifies by arguments', () => {
    for (const name of ['intelligent_ui_html', 'sketch', 'intelligent_ui']) {
      expect(widgetWrite(call(name, { html, widget: { name: 'x' } }))).toBe(true);
      expect(widgetWrite(call(name, { html }))).toBe(false);
    }
    expect(widgetWrite(call('intelligent_ui_html', { edits: [] }))).toBe(true);
    for (const action of ['list', 'read']) expect(widgetWrite(call('manage_widget', { action }))).toBe(false);
    for (const action of ['set_record', 'delete_record', 'delete', 'restore', 'anything']) expect(widgetWrite(call('manage_widget', { action }))).toBe(true);
    expect(widgetWrite(call('manage_widget', '{broken'))).toBe(true);
    expect(toolNeedsApproval('intelligent_ui_html', 'readonly', { widgetWrite: true })).toBe(true);
    expect(toolNeedsApproval('intelligent_ui_html', 'auto-edit', { widgetWrite: true })).toBe(false);
    expect(toolNeedsApproval('intelligent_ui_html', 'full-auto', { widgetWrite: true })).toBe(false);
    expect(toolNeedsApproval('intelligent_ui_html', 'readonly')).toBe(false);
  });
  it('the gate asks in the read-only tier with a short preview, and only then', async () => {
    const save = call('sketch', { html: 'x'.repeat(5000), widget: { name: 'ledger' } });
    const asked = await asks(save, 'readonly');
    expect(asked.asked).toBe(true);
    expect(asked.preview).toBe('save widget ledger');
    expect((await asks(call('manage_widget', { action: 'delete', id: 'w_1' }), 'readonly')).asked).toBe(true);
    expect((await asks(save, 'auto-edit')).asked).toBe(false);
    expect((await asks(call('sketch', { html: 'x' }), 'readonly')).asked).toBe(false);
    expect((await asks(call('manage_widget', { action: 'list' }), 'readonly')).asked).toBe(false);
  });
});
