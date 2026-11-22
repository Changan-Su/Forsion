/**
 * Muse 给自动化首页的任务建议(方案 docs/ToBeImproved/自动化任务建议方案_2026-11-22)。
 * 钉:规则草稿走 manage_automation 同一个校验、整组替换时没变的那条留原 id、用户 × 过的 30 天内不许再提、× / 用过只认 active、周期简报那一段。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 照着 museAutomationSuggestions.ts 的几条 SQL 做的小内存表(只认这几种写法,别处改了 SQL 这里会直接漏数据 → 测试红)
const db = vi.hoisted(() => ({ rows: [] as any[], clock: 0 }));
vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    const T = 'muse_automation_suggestions';
    if (s.startsWith(`SELECT id, title, why`)) return db.rows.filter((r) => r.user_id === p[0] && r.status === 'active').sort((a, b) => a.seq - b.seq);
    if (s.startsWith(`SELECT title FROM ${T} WHERE user_id = ? AND status = 'dismissed'`)) return db.rows.filter((r) => r.user_id === p[0] && r.status === 'dismissed' && r.updated_at >= p[1]);
    if (s.startsWith(`SELECT title, status FROM ${T} WHERE id = ?`)) { if (!s.includes("status IN ('active', 'replaced')")) throw new Error('mark reads active or replaced'); return db.rows.filter((r) => r.id === p[0] && r.user_id === p[1] && (r.status === 'active' || r.status === 'replaced')); }
    if (s.startsWith(`SELECT status FROM ${T} WHERE id = ?`)) return db.rows.filter((r) => r.id === p[0] && r.user_id === p[1]);
    if (s.startsWith(`UPDATE ${T} SET status = 'replaced'`)) { if (!s.includes("AND status = 'active'")) throw new Error('replace must be CAS on active'); db.rows.filter((r) => r.id === p[0] && r.user_id === p[1] && r.status === 'active').forEach((r) => { r.status = 'replaced'; }); return []; }
    if (s.startsWith(`UPDATE ${T} SET status = ?`)) { db.rows.filter((r) => r.id === p[1] && r.user_id === p[2] && r.status === p[3]).forEach((r) => { r.status = p[0]; r.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' '); }); return []; }
    if (s.startsWith(`INSERT INTO ${T}`)) { db.rows.push({ id: p[0], user_id: p[1], title: p[2], why: p[3], source_kind: p[4], source_label: p[5], source_ref: p[6], rule_json: p[7], status: 'active', seq: db.clock++, updated_at: '' }); return []; }
    throw new Error(`unexpected SQL in test: ${s}`);
  }),
}));

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSuggestions, setSuggestions, markSuggestion, listActiveSuggestions, buildSuggestionHint, MAX_SUGGESTIONS } from './museAutomationSuggestions.js';

const vault = mkdtempSync(path.join(os.tmpdir(), 'auto-sugg-'));
mkdirSync(path.join(vault, 'Log'), { recursive: true });
writeFileSync(path.join(vault, 'Log', 'week.md'), '# log');
writeFileSync(path.join(vault, 'feedback.db'), '');

const weekly = {
  title: '每周一整理上周开发日志',
  why: '过去 4 个周一你都在上午手动翻了日志',
  source: { kind: 'note', label: 'week', ref: 'Log/week.md' },
  rule: { cond_type: 'daily_at', time: '09:00', actions: [{ type: 'notify', title: '整理上周开发日志' }] },
};
const away = {
  title: 'Xcode 连着用两小时提醒起身',
  why: '你最近几天在 Xcode 里一坐就是三四个小时',
  source: { kind: 'computer', label: 'Xcode' },
  rule: { cond_type: 'computer.app_used', params: { app: 'Xcode', minutes: 120 }, actions: [{ type: 'remind', title: '起来走走' }] },
};
const V = (raw: unknown) => validateSuggestions(raw, { vaultPath: vault });

beforeEach(() => { db.rows = []; db.clock = 0; });

describe('validateSuggestions', () => {
  it('收下合法的一组:规则经同一个校验,desc 缺省取标题,笔记来源换成绝对路径', () => {
    const v = V([weekly, away]);
    if (!('suggestions' in v)) throw new Error(v.error);
    expect(v.suggestions[0].rule.desc).toBe(weekly.title);
    expect(v.suggestions[0].rule.cond).toEqual({ type: 'daily_at', time: '09:00' });
    expect(v.suggestions[0].source.ref).toBe(path.join(vault, 'Log', 'week.md'));
    expect(v.suggestions[1].rule.cond.type).toBe('computer.app_used');
  });
  it('空数组 = 清空;超过上限整组不收', () => {
    expect(V([])).toEqual({ suggestions: [] });
    expect(V(Array.from({ length: MAX_SUGGESTIONS + 1 }, (_, i) => ({ ...away, title: `t${i}` })))).toHaveProperty('error');
  });
  it('规则校验不过、不带规则、带 tool_call 步骤 → 报出是哪一条', () => {
    expect(V([weekly, { ...away, rule: { cond_type: 'nope' } }])).toEqual({ error: expect.stringMatching(/^suggestion 2: rule:/) });
    expect(V([{ ...away, rule: undefined }])).toEqual({ error: expect.stringMatching(/rule is required/) });
    expect(V([{ ...away, rule: { cond_type: 'daily_at', time: '09:00', actions: [{ type: 'tool_call', tool: 'run_bash', args: {} }] } }])).toHaveProperty('error');
  });
  it('旧式 agent_slug 不收(画布会把它画成「叫醒 Muse」),要用 actions 里的 agent_run', () => {
    expect(V([{ ...away, rule: { cond_type: 'daily_at', time: '09:00', agent_slug: 'xyra' } }])).toEqual({ error: expect.stringMatching(/agent_run step/) });
  });
  it('笔记 / 表来源必须是真实存在的文件', () => {
    expect(V([{ ...weekly, source: { kind: 'note', label: 'x', ref: 'Log/missing.md' } }])).toEqual({ error: expect.stringMatching(/does not exist/) });
    const ok = V([{ ...away, source: { kind: 'database', label: '用户反馈', ref: 'feedback.db' } }]);
    expect('suggestions' in ok && ok.suggestions[0].source.ref).toBe(path.join(vault, 'feedback.db'));
  });
  it('标题重复(只差大小写 / 句末标点)整组不收;缺 why / 来源种类不对也不收', () => {
    expect(V([away, { ...weekly, title: `${away.title}。` }])).toEqual({ error: expect.stringMatching(/duplicate/) });
    expect(V([{ ...away, why: ' ' }])).toEqual({ error: expect.stringMatching(/why is required/) });
    expect(V([{ ...away, source: { kind: 'email', label: 'x' } }])).toEqual({ error: expect.stringMatching(/source.kind/) });
  });
});

describe('setSuggestions / markSuggestion', () => {
  const ok = (raw: unknown) => { const v = V(raw); if (!('suggestions' in v)) throw new Error(v.error); return v.suggestions; };

  it('整组替换:没变的那条留原 id,换掉的记 replaced', async () => {
    const first = await setSuggestions('u', ok([weekly, away]));
    const keepId = first.shown.find((s) => s.title === away.title)!.id;
    const second = await setSuggestions('u', ok([away]));
    expect(second.shown.map((s) => s.id)).toEqual([keepId]);
    expect(db.rows.find((r) => r.title === weekly.title).status).toBe('replaced');
  });
  it('× 过的 30 天内不收;存成规则的不算拒收', async () => {
    const { shown } = await setSuggestions('u', ok([weekly, away]));
    expect(await markSuggestion('u', shown[0].id, 'dismissed')).toBe(weekly.title);
    expect(await markSuggestion('u', shown[1].id, 'used')).toBe(away.title);
    const again = await setSuggestions('u', ok([weekly, away]));
    expect(again.refused).toEqual([weekly.title]);
    expect(again.shown.map((s) => s.title)).toEqual([away.title]);
  });
  it('只认 active:点两下只算一次,别的用户的不算', async () => {
    const { shown } = await setSuggestions('u', ok([away]));
    expect(await markSuggestion('other', shown[0].id, 'dismissed')).toBeNull();
    expect(await markSuggestion('u', shown[0].id, 'used')).toBe(away.title);
    expect(await markSuggestion('u', shown[0].id, 'dismissed')).toBeNull();
    expect(await listActiveSuggestions('u')).toEqual([]);
  });
  it('打开草稿后 Muse 换了一组:那条(replaced)照样能记 used / dismissed', async () => {
    const { shown } = await setSuggestions('u', ok([weekly, away]));
    await setSuggestions('u', ok([away]));
    const old = shown.find((s) => s.title === weekly.title)!;
    expect(await markSuggestion('u', old.id, 'dismissed')).toBe(weekly.title);
    expect((await setSuggestions('u', ok([weekly, away]))).refused).toEqual([weekly.title]);
  });
  it('存进去的规则原样读回来(桌面按它填画布);读不出的那条当不存在', async () => {
    await setSuggestions('u', ok([away]));
    const [s] = await listActiveSuggestions('u');
    expect(s.rule.actions).toEqual([{ type: 'remind', title: '起来走走' }]);
    db.rows[0].rule_json = '{broken';
    expect(await listActiveSuggestions('u')).toEqual([]);
  });
});

describe('buildSuggestionHint', () => {
  it('列出正在显示的和最近被 × 掉的', () => {
    const h = buildSuggestionHint([{ title: 'A', source: { kind: 'muse', label: 'x' } }], ['B']);
    expect(h).toContain('- A (source: muse "x")');
    expect(h).toContain('do not suggest these or anything similar): B');
  });
  it('一条没有时提示怎么给', () => {
    expect(buildSuggestionHint([], [])).toContain('set_automation_suggestions');
  });
});
