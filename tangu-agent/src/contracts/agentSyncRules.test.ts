import { describe, expect, it } from 'vitest';
import { diff3Merge } from 'node-diff3';
import { agentContentSyncable, conflictCopyName, isConflictCopyPath, isReadableSettingsDb, isSettingsPath, SETTINGS_MAX_BYTES, mergeAgentSyncContent, mergeSettingsDb, mergeTombstoneLists, neverConflictCopy, parseTombstones, sameFactoryConfig, serializeTombstones, type WireTombstone } from './agentSyncRules.js';

const deps = { diff3: diff3Merge };
const merge = (path: string, ours: string, base: string | null, theirs: string) => mergeAgentSyncContent(path, ours, base, theirs, deps);

// 这台 Mac 11-02 出的那对 config 副本,原样(06-18 中文出厂 vs 09-06 英文出厂)
const GA_ZH = 'name_zh = "通用助手"\nname = "通用助手"\ndescription = "严谨可靠的全能助手,适合日常问答与多步任务"\nmodel_reasoning_effort = "low"\ncreated_by = "user"\ncreated_at = "2026-06-18T01:32:49.641Z"\ndeveloper_instructions = "你是一个乐于助人、严谨可靠的通用助手。回答力求准确、清晰、有条理;不确定时如实说明而非编造。面对多步任务,先简述思路再动手,必要时用工具核实。中文用户默认用中文回答。"\n';
const GA_EN = 'name_zh = "通用助手"\nname = "通用助手"\nversion = "1.0.0"\ndescription = "严谨可靠的全能助手,适合日常问答与多步任务"\nmodel_reasoning_effort = "low"\ncreated_by = "user"\ncreated_at = "2026-09-06T12:54:23.240Z"\ndeveloper_instructions = "You are a helpful, rigorous, and reliable general-purpose assistant. Strive for accurate, clear, well-organized answers; state uncertainty honestly rather than making things up. For multi-step tasks, briefly outline your approach before acting, and verify with tools when needed. Reply in the user\'s language by default."\n';

describe('which agent files sync', () => {
  it('follows the server whitelist and keeps Muse, Historian scratch dirs, backups and copies local', () => {
    expect(agentContentSyncable('agents/christen/config.toml')).toBe(true);
    expect(agentContentSyncable('agents/christen/Library/notes/a.md')).toBe(true);
    expect(agentContentSyncable('agents/christen/LOG/2026-11-04.md')).toBe(true);
    expect(agentContentSyncable('agents/christen/.memory-tombstones.json')).toBe(true);
    expect(agentContentSyncable('agents/christen/WidgetData/w_1/data.db')).toBe(true);
    expect(agentContentSyncable('agents/muse/MEMORY.md')).toBe(false);
    expect(agentContentSyncable('agents/muse/Library/Journal/2026-09-25.md')).toBe(false);
    expect(agentContentSyncable('agents/muse', 'folder')).toBe(false);
    expect(agentContentSyncable('agents/historian-0b89aa950a0d/MEMORY.md')).toBe(false);
    expect(agentContentSyncable('agents/qinche.backup-20261024/config.toml')).toBe(false);
    expect(agentContentSyncable('agents/code-reviewer.md.bak')).toBe(false);
    expect(agentContentSyncable('agents/xyra/triggers.json')).toBe(false);
    expect(agentContentSyncable('agents/xyra/Space/main.js')).toBe(false);
    expect(agentContentSyncable('agents/xyra/Space', 'folder')).toBe(false);
    expect(agentContentSyncable('agents/xyra/Library/Space-preview', 'folder')).toBe(true);
    expect(agentContentSyncable('agents/general-assistant/config (conflict 2026-11-02 2050).toml')).toBe(false);
    expect(agentContentSyncable('agents/coding/scratch (conflict 28991363 1793741084626).md')).toBe(false);
    expect(agentContentSyncable('human/MEMORY.md')).toBe(true);
    expect(agentContentSyncable('human/notes.md')).toBe(false);
    expect(agentContentSyncable('human/MEMORY (conflict 2026-10-21 0104).md')).toBe(false);
    expect(agentContentSyncable('Amadeus/x.md')).toBe(null);
  });
  // ⚠️ 和 Forsion Extend test/vitest/agentContent.test.ts 同一组用例:两边的表必须逐条一致
  it('settings files that follow the account: only human/Settings/<name>.db, and the one folder that holds them', () => {
    const cases: Array<[string, 'file' | 'folder', boolean | null]> = [
      ['human/Settings/calendar.db', 'file', true], ['human/Settings/appearance-2.db', 'file', true], ['human/Settings', 'folder', true],
      ['human/Settings/Calendar.db', 'file', false], ['human/Settings/calendar.json', 'file', false], ['human/Settings/a_b.db', 'file', false],
      ['human/Settings/-x.db', 'file', false], ['human/Settings/.hidden.db', 'file', false], [`human/Settings/${'a'.repeat(65)}.db`, 'file', false],
      ['human/Settings/sub/calendar.db', 'file', false], ['human/Settings/sub', 'folder', false], ['human/Settings/calendar.db', 'folder', false],
      ['human/Settings/calendar (conflict 2026-11-10 0900).db', 'file', false], ['human/settings/calendar.db', 'file', false],
      ['agents/xyra/Settings/calendar.db', 'file', false], ['agents/xyra/Settings', 'folder', false], ['Settings/calendar.db', 'file', null],
    ];
    for (const [p, k, want] of cases) expect([p, k, agentContentSyncable(p, k)]).toEqual([p, k, want]);
    expect(isSettingsPath('Settings/calendar.db')).toBe(true);
    expect(isSettingsPath('human/Settings/calendar.db')).toBe(false); // 相对 human/ 的路径
    expect(neverConflictCopy('human/Settings/calendar.db')).toBe(true);
    for (const p of ['human/CALENDAR.db', 'human/WidgetData/w_1/data.db', 'agents/xyra/Settings/calendar.db', 'human/Settings/notes.json', 'Amadeus/Settings/calendar.db']) expect([p, neverConflictCopy(p)]).toEqual([p, false]);
  });
  it('makes one copy name and recognizes both old ones', () => {
    const at = new Date(2026, 10, 4, 1, 50);
    expect(conflictCopyName('Library/a.md', at)).toBe('Library/a (conflict 2026-11-04 0150).md');
    expect(conflictCopyName('config.toml', at, 2)).toBe('config (conflict 2026-11-04 0150 2).toml');
    for (const p of ['Library/a (conflict 2026-11-04 0150).md', 'config (conflict 2026-11-04 0150 2).toml', 'config (conflict 2026-11-04 0150).toml.2', 'x (conflict 28991363 1793741084626).md']) expect(isConflictCopyPath(p)).toBe(true);
    expect(isConflictCopyPath('Library/conflict notes.md')).toBe(false);
  });
});

describe('both syncs merge agent files the same way', () => {
  it('two devices remembering one fact each never makes a memory copy', () => {
    const base = '- 喜欢简短回复\n';
    expect(merge('agents/xyra/MEMORY.md', `${base}- [MacBook Pro] 编译用 latexmk\n`, base, `${base}- [Windows] Fluent 要无空格路径\n`))
      .toEqual({ content: `${base}- [MacBook Pro] 编译用 latexmk\n- [Windows] Fluent 要无空格路径\n`, conflict: false });
    // 第一次见面(换引擎、没有基线):取并集,不出副本
    expect(merge('agents/xyra/MEMORY.md', '- a\n- b\n', null, '- a\n- c\n')!.content.split('\n').filter(Boolean).sort()).toEqual(['- a', '- b', '- c']);
  });
  it('factory agents seeded on two devices take the cloud copy instead of a conflict copy', () => {
    expect(sameFactoryConfig('general-assistant', GA_ZH, GA_EN)).toBe(true);
    expect(merge('agents/general-assistant/config.toml', GA_ZH, null, GA_EN)).toEqual({ content: GA_EN, conflict: false });
    const edited = GA_ZH.replace('中文用户默认用中文回答。', '中文用户默认用中文回答。回答尽量短。');
    expect(merge('agents/general-assistant/config.toml', edited, null, GA_EN)).toBe(null);
    const timeOnly = GA_EN.replace('2026-09-06T12:54:23.240Z', '2026-11-01T09:31:00.000Z').replace('version = "1.0.0"\n', '');
    expect(merge('agents/aria/config.toml', timeOnly, null, GA_EN)).toEqual({ content: GA_EN, conflict: false });
  });
  it('first contact: human files are joined, agent prose and Library notes still need a copy', () => {
    expect(merge('human/MEMORY.md', '- 住在伦敦\n', null, '- 养了一只猫\n')!.content).toContain('住在伦敦');
    expect(merge('agents/christen/SOUL.md', 'a\n', null, 'b\n')).toBe(null);
    expect(merge('agents/christen/Library/a.md', 'a\nx\n', 'a\n', 'a\n')).toEqual({ content: 'a\nx\n', conflict: false });
  });
  describe('settings files (human/Settings/<name>.db) always have a winner and never ask for a copy', () => {
    const P = 'human/Settings/calendar.db';
    const db = (items: Record<string, string>, extra: Record<string, unknown> = {}) => `${JSON.stringify({ version: 2, name: 'calendar-settings', columns: [{ id: 'k', name: 'key', type: 'text' }, { id: 'v', name: 'value', type: 'text' }], rows: Object.entries(items).map(([k, v]) => ({ id: `s-${k}`, cells: { k, v } })), ...extra }, null, 2)}\n`;
    const items = (text: string) => Object.fromEntries((JSON.parse(text).rows as Array<{ cells: { k: string; v: string } }>).map((r) => [r.cells.k, r.cells.v]));
    it('first contact: union of rows, the cloud copy wins a row both have', () => {
      const out = merge(P, db({ shared: 'local', mine: '1' }), null, db({ shared: 'cloud', theirs: '1' }))!;
      expect(out.conflict).toBe(false);
      expect(items(out.content)).toEqual({ shared: 'cloud', theirs: '1', mine: '1' });
    });
    it('with a baseline: three-way by rows — delete holds, both changed goes to the cloud copy, an edit beats a delete', () => {
      const base = db({ same: '0', gone: 'x', goneThere: 'y', mine: '0', theirs: '0', editedHere: '0', editedThere: '0' });
      const ours = db({ same: 'local', goneThere: 'y', mine: 'local', theirs: '0', editedHere: 'local', newHere: '1' }); // 删了 gone、editedThere
      const cloud = db({ same: 'cloud', gone: 'x', mine: '0', theirs: 'cloud', editedThere: 'cloud', newThere: '1' }); // 删了 goneThere、editedHere
      const out = merge(P, ours, base, cloud)!;
      expect(out.conflict).toBe(false);
      expect(items(out.content)).toEqual({ same: 'cloud', mine: 'local', theirs: 'cloud', editedHere: 'local', editedThere: 'cloud', newHere: '1', newThere: '1' });
    });
    it('differing column definitions or file name take the cloud copy', () => {
      const out = merge(P, db({ a: '1' }, { name: 'local-name', columns: [{ id: 'k', name: 'K', type: 'text' }, { id: 'v', name: 'V', type: 'text' }] }), null, db({ b: '2' }))!;
      expect(out.conflict).toBe(false);
      expect(JSON.parse(out.content)).toMatchObject({ name: 'calendar-settings', columns: [{ id: 'k', name: 'key' }, { id: 'v', name: 'value' }] });
      expect(items(out.content)).toEqual({ a: '1', b: '2' });
    });
    it('column ids are field names: a renamed column is not matched up, and values that look like ids are not rewritten', () => {
      // 日历那种「同类型的列对到一起」会把 ours 的列 id "val" 按文本换成 "v",连带改掉值里的 "val"
      const ours = `${JSON.stringify({ version: 2, name: 'calendar-settings', columns: [{ id: 'k', name: 'key', type: 'text' }, { id: 'val', name: 'value2', type: 'text' }], rows: [{ id: 'r1', cells: { k: 'x', val: 'val' } }] })}\n`;
      const out = JSON.parse(merge(P, ours, null, db({ b: '2' }))!.content);
      expect(out.rows.find((r: any) => r.id === 'r1').cells).toEqual({ k: 'x', val: 'val' });
    });
    it('an unreadable side loses to the readable one; both unreadable = the cloud copy; a bad baseline counts as none', () => {
      const good = db({ a: '1' });
      const dup = JSON.stringify({ ...JSON.parse(db({ a: 'dup' })), rows: [{ id: 'x', cells: {} }, { id: 'x', cells: {} }] });
      for (const bad of ['{ not json', '[]', '', dup]) {
        expect([bad, merge(P, bad, null, good)]).toEqual([bad, { content: good, conflict: false }]);
        expect([bad, merge(P, good, null, bad)]).toEqual([bad, { content: good, conflict: false }]);
        expect([bad, merge(P, good, good, bad)]).toEqual([bad, { content: good, conflict: false }]);
        expect([bad, merge(P, 'local junk', null, bad)]).toEqual([bad, { content: bad, conflict: false }]);
        const out = merge(P, db({ shared: 'local', mine: '1' }), bad, db({ shared: 'cloud' }))!;
        expect([bad, out.conflict, items(out.content)]).toEqual([bad, false, { shared: 'cloud', mine: '1' }]);
      }
    });
    // ⚠️ 和 Forsion Extend test/vitest/agentContent.test.ts 的 readableSettingsDb 同一组用例
    it('a settings file is readable only as a well-formed database file; a wrongly shaped side loses whole, it is not merged in', () => {
      const good = { version: 2, name: 'calendar-settings', columns: [{ id: 'k', name: 'key', type: 'text' }, { id: 'v', name: 'value', type: 'text' }], rows: [{ id: 's1', cells: { k: 'a', v: '1' } }] };
      for (const ok of [good, { ...good, rows: [] }, { ...good, views: [{ id: 'v1' }] }, { ...good, extra: 1 }]) expect([JSON.stringify(ok), isReadableSettingsDb(JSON.stringify(ok))]).toEqual([JSON.stringify(ok), true]);
      const bad: unknown[] = [null, [], 'x', { rows: [] }, { ...good, version: '2' }, { ...good, name: 1 }, { ...good, source: { folder: 'x' } }, { ...good, columns: undefined }, { ...good, columns: [{ name: 'no id' }] },
        { ...good, rows: 'x' }, { ...good, rows: [{ id: 1, cells: {} }] }, { ...good, rows: [{ id: 'a' }] }, { ...good, rows: [{ id: 'a', cells: [] }] }, { ...good, rows: [good.rows[0], good.rows[0]] },
        { ...good, columns: [good.columns[0], good.columns[0]] }, { ...good, views: {} }];
      for (const b of bad) expect([JSON.stringify(b), isReadableSettingsDb(JSON.stringify(b))]).toEqual([JSON.stringify(b), false]);
      for (const text of ['', '{ half', 'not json']) expect([text, isReadableSettingsDb(text)]).toEqual([text, false]);
      expect(SETTINGS_MAX_BYTES).toBe(262144);
      // 能解析、带行、但形状不对的那份(按行合并本来合得进去):整份输给读得懂的那份
      const stray = JSON.stringify({ rows: [{ id: 'stray', cells: { k: 'x', v: 'y' } }] });
      expect(merge(P, stray, null, db({ a: '1' }))).toEqual({ content: db({ a: '1' }), conflict: false });
      expect(merge(P, db({ a: '1' }), null, stray)).toEqual({ content: db({ a: '1' }), conflict: false });
    });
    it('never returns null or a conflict for any pairing, unlike the default calendar next to it', () => {
      const sides = [db({ a: '1' }), db({ a: '2', b: '1' }), db({}), '{ not json', ''];
      for (const o of sides) for (const t of sides) for (const b of [null, ...sides]) {
        const out = mergeSettingsDb(o, b, t);
        expect(out.conflict).toBe(false);
        expect(typeof out.content).toBe('string');
        expect(merge(P, o, b, t)).toEqual(out);
      }
      expect(merge('human/CALENDAR.db', db({ a: '1' }), null, db({ a: '2' }))!.conflict).toBe(true); // 同一行不一样:别的 .db 照旧报冲突、出副本
      expect(merge('human/CALENDAR.db', '{ not json', null, db({ a: '2' }))).toBe(null);
    });
    it('merging is stable: merging the result again with either side changes nothing', () => {
      const ours = db({ shared: 'local', mine: '1' }), cloud = db({ shared: 'cloud', theirs: '1' });
      const once = merge(P, ours, null, cloud)!.content;
      expect(merge(P, once, null, once)!.content).toBe(once);
      expect(merge(P, cloud, cloud, once)!.content).toBe(once); // 另一台拿自己的基线拉这份:就是这份
    });
  });
  it('calendars keep the latest run, logs are block unions, tombstones are unions in the old wire format', () => {
    const db = (run: string, desc: string) => JSON.stringify({ version: 2, name: 'Calendar', columns: [{ id: 'd', name: 'D', type: 'text' }], rows: [{ id: 'r1', cells: { d: desc, lastRun: run } }] });
    const out = merge('agents/xyra/CALENDAR.db', db('2026-11-05T09:00:00.000Z', 'old'), db('', 'old'), db('', 'new'))!;
    expect(JSON.parse(out.content).rows[0].cells.lastRun).toBe('2026-11-05T09:00:00.000Z');
    const log = merge('agents/xyra/LOG/2026-11-05.md', '# 2026-11-05\n\n### 09:00 @a\nmac\n', null, '# 2026-11-05\n\n### 10:00 @b\nwin\n')!.content;
    expect(log).toBe('# 2026-11-05\n\n### 09:00 @a\nmac\n\n### 10:00 @b\nwin\n');
    const t = (id: string, fp: string, at: number): WireTombstone => ({ id, fingerprint: fp, content: fp, forgottenAt: at, evidenceIds: ['e2', 'e1'] });
    const ours = serializeTombstones([t('1', 'aa', 1)]), theirs = serializeTombstones([t('2', 'bb', 2), t('3', 'aa', 5)]);
    const merged = merge('agents/xyra/.memory-tombstones.json', ours, null, theirs)!.content;
    expect(merged).toBe(serializeTombstones(mergeTombstoneLists(parseTombstones(ours)!, parseTombstones(theirs)!)));
    expect(parseTombstones(merged)!.map((x) => [x.fingerprint, x.id])).toEqual([['aa', '3'], ['bb', '2']]);
    // 旧同步一直写的字节:证据排好序、按指纹排
    expect(ours).toBe('{"schemaVersion":1,"tombstones":[{"id":"1","fingerprint":"aa","content":"aa","forgottenAt":1,"evidenceIds":["e1","e2"]}]}');
  });
});
