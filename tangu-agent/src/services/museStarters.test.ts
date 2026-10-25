/**
 * Muse 开场建议(新对话页 Chat Box 下三行;方案 docs/ToBeImproved/Muse预制提示词方案_2026-10-25)。
 * 钉:模型给的一组怎么校验、整组替换时没变的那条留原 id、用户 × 过的 30 天内不许再提、× / 用过只认 active、周期简报那一段。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 照着 museStarters.ts 的几条 SQL 做的小内存表(只认这几种写法,别处改了 SQL 这里会直接漏数据 → 测试红)
const db = vi.hoisted(() => ({ rows: [] as any[], clock: 0 }))
vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, text, source_kind')) return db.rows.filter((r) => r.user_id === p[0] && r.status === 'active').sort((a, b) => a.seq - b.seq);
    if (s.startsWith("SELECT text FROM muse_starters WHERE user_id = ? AND status = 'dismissed'")) return db.rows.filter((r) => r.user_id === p[0] && r.status === 'dismissed' && r.updated_at >= p[1]);
    if (s.startsWith("SELECT text FROM muse_starters WHERE id = ?")) return db.rows.filter((r) => r.id === p[0] && r.user_id === p[1] && r.status === 'active');
    if (s.startsWith('SELECT status FROM muse_starters WHERE id = ?')) return db.rows.filter((r) => r.id === p[0] && r.user_id === p[1]);
    if (s.startsWith("UPDATE muse_starters SET status = 'replaced'")) { if (!s.includes("AND status = 'active'")) throw new Error('replace must be CAS on active'); db.rows.filter((r) => r.id === p[0] && r.user_id === p[1] && r.status === 'active').forEach((r) => { r.status = 'replaced' }); return [] }
    if (s.startsWith('UPDATE muse_starters SET status = ?')) { db.rows.filter((r) => r.id === p[1] && r.user_id === p[2] && r.status === 'active').forEach((r) => { r.status = p[0]; r.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ') }); return [] }
    if (s.startsWith('INSERT INTO muse_starters')) { db.rows.push({ id: p[0], user_id: p[1], text: p[2], source_kind: p[3], source_label: p[4], source_ref: p[5], status: 'active', seq: db.clock++, updated_at: '' }); return [] }
    throw new Error(`unexpected SQL in test: ${s}`);
  }),
}));

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateStarters, setStarters, markStarter, listActiveStarters, buildStarterHint, starterKey, resolveNoteRefs, MAX_STARTERS } from './museStarters.js';

const cal = { text: '明天 10:00 的「产品周会」还没有议程。按本周开发日志起一份议程。', source: { kind: 'calendar', label: '产品周会', ref: '2026-10-26' } };
const note = { text: '「蓬洲云同步简化方案」三天没动了。把剩下的待定项列成清单。', source: { kind: 'note', label: '蓬洲云同步简化方案', ref: 'Projects/蓬洲云同步简化方案.md' } };
const muse = { text: 'Every Monday, plan one milestone for the AI learning dashboard.', source: { kind: 'muse', label: 'AI learning dashboard' } };

beforeEach(() => { db.rows = []; db.clock = 0 });

describe('validateStarters', () => {
  it('收下合法的一组,去掉多余空白', () => {
    const v = validateStarters([{ ...cal, text: `  ${cal.text}\n` }, note, muse]);
    expect('starters' in v && v.starters.map((s) => s.text)).toEqual([cal.text, note.text, muse.text]);
  });
  it('空数组 = 清空', () => {
    expect(validateStarters([])).toEqual({ starters: [] });
  });
  it.each([
    ['不是数组', { text: 'x' }, /array/],
    ['超过三条', [cal, note, muse, { ...muse, text: `${muse.text} Again.` }], new RegExp(`at most ${MAX_STARTERS}`)],
    ['label 不在句子里', [{ ...cal, source: { ...cal.source, label: '周会纪要' } }], /verbatim/],
    ['来源种类不认识', [{ ...cal, source: { ...cal.source, kind: 'email' } }], /source\.kind/],
    ['网页没给 URL', [{ text: 'Read the RFC draft', source: { kind: 'web', label: 'RFC draft', ref: 'RFC draft' } }], /http/],
    ['笔记没给路径', [{ ...note, source: { kind: 'note', label: note.source.label } }], /note path/],
    ['同一句两遍(只差句末标点)', [cal, { ...cal, text: cal.text.replace(/。$/, '') }], /duplicate/],
    ['太长', [{ text: `${'很长'.repeat(120)}产品周会`, source: { kind: 'calendar', label: '产品周会' } }], /longer than/],
  ])('拒:%s', (_name, raw, msg) => {
    const v = validateStarters(raw);
    expect('error' in v && v.error).toMatch(msg);
  });
});

describe('resolveNoteRefs:笔记来源必须是真有的文件(10-25 live:模型拼出过不存在的库内路径)', () => {
  const vault = mkdtempSync(path.join(os.tmpdir(), 'starters-vault-'));
  mkdirSync(path.join(vault, 'Projects'));
  writeFileSync(path.join(vault, 'Projects', 'plan.md'), '# plan');
  const outside = path.join(mkdtempSync(path.join(os.tmpdir(), 'starters-ws-')), '产品周会.md');
  writeFileSync(outside, '# 产品周会');
  const n = (ref: string) => ({ text: 'Review plan', source: { kind: 'note' as const, label: 'plan', ref } });

  it('库内相对路径 → 绝对路径;库外的绝对路径照用', () => {
    const r = resolveNoteRefs([n('Projects/plan.md'), { ...n(outside), text: 'Review 产品周会', source: { kind: 'note', label: '产品周会', ref: outside } }], vault);
    expect('starters' in r && r.starters.map((s) => s.source.ref)).toEqual([path.join(vault, 'Projects', 'plan.md'), outside]);
  });
  it('不存在的(含目录)整组不收,报哪一条', () => {
    for (const ref of [path.join(vault, '产品周会.md'), 'Projects']) {
      const r = resolveNoteRefs([cal as any, n(ref)], vault);
      expect('error' in r && r.error).toMatch(/starter 2: note .* does not exist/);
    }
  });
  it('别的来源不碰', () => {
    expect(resolveNoteRefs([cal as any], vault)).toEqual({ starters: [cal] });
  });
});

describe('setStarters / markStarter', () => {
  const put = async (list: any[]) => {
    const v = validateStarters(list);
    if ('error' in v) throw new Error(v.error);
    return setStarters('u1', v.starters);
  };

  it('整组替换:没变的那条留原 id,换下来的记 replaced', async () => {
    const first = await put([cal, note]);
    const keepId = first.shown.find((s) => s.text === note.text)!.id;
    const second = await put([note, muse]);
    expect(second.shown.map((s) => s.text)).toEqual([note.text, muse.text]);
    expect(second.shown[0].id).toBe(keepId);
    expect(db.rows.find((r) => r.text === cal.text).status).toBe('replaced');
  });

  it('句子一样但来源换了 = 新的一条(链接指向别处了)', async () => {
    const a = await put([note]);
    const b = await put([{ ...note, source: { ...note.source, ref: 'Archive/蓬洲云同步简化方案.md' } }]);
    expect(b.shown[0].id).not.toBe(a.shown[0].id);
  });

  it('用户 × 过的:30 天内再提会被拒,其余照放', async () => {
    const { shown } = await put([cal, note]);
    expect(await markStarter('u1', shown[0].id, 'dismissed')).toBe(cal.text);
    const again = await put([{ ...cal, text: `${cal.text.replace(/。$/, '')}!` }, note]);
    expect(again.refused).toHaveLength(1);
    expect(again.shown.map((s) => s.text)).toEqual([note.text]);
  });

  it('替换时用户恰好 × 掉了一条:不被改回 replaced(30 天拒收照旧)', async () => {
    const { shown } = await put([cal, note]);
    // 模拟「读快照之后、写之前」用户点了 ×
    const orig = db.rows.find((r) => r.id === shown[0].id);
    const v = validateStarters([note]);
    const pending = setStarters('u1', (v as any).starters);
    orig.status = 'dismissed';
    await pending;
    expect(orig.status).toBe('dismissed');
  });

  it('31 条 × 过的也全拦(拒收不截断)', async () => {
    for (let i = 0; i < 31; i++) db.rows.push({ id: `d${i}`, user_id: 'u1', text: `Old idea ${i} about 产品周会`, source_kind: 'calendar', source_label: '产品周会', source_ref: null, status: 'dismissed', seq: -1, updated_at: '9999' });
    const r = await put([{ text: 'Old idea 0 about 产品周会', source: { kind: 'calendar', label: '产品周会' } }]);
    expect(r.refused).toHaveLength(1);
  });

  it('× / 用过只认 active 的那条:点两下只算一次,别人的不算', async () => {
    const { shown } = await put([cal]);
    expect(await markStarter('u2', shown[0].id, 'used')).toBeNull();
    expect(await markStarter('u1', shown[0].id, 'used')).toBe(cal.text);
    expect(await markStarter('u1', shown[0].id, 'dismissed')).toBeNull();
    expect(await listActiveStarters('u1')).toEqual([]);
  });
});

describe('周期简报', () => {
  it('列出正在显示的(带来源),和最近被 × 掉的', () => {
    const hint = buildStarterHint([cal as any], ['Draft the Q4 plan']);
    expect(hint).toContain('[Chat starters currently shown on the new-chat page]');
    expect(hint).toContain(`- ${cal.text} (source: calendar "产品周会")`);
    expect(hint).toContain('Dismissed by the user recently (do not suggest these or anything similar): Draft the Q4 plan');
  });
  it('一条都没有也要说一声(Muse 才知道该放了)', () => {
    expect(buildStarterHint([], [])).toContain('- (none yet)');
  });
  it('去重键不计大小写与句末标点', () => {
    expect(starterKey('Draft one.')).toBe(starterKey(' draft ONE '));
  });
});
