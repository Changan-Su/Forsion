import { describe, expect, it } from 'vitest';
import { diff3Merge } from 'node-diff3';
import { agentContentSyncable, conflictCopyName, isConflictCopyPath, mergeAgentSyncContent, mergeTombstoneLists, parseTombstones, sameFactoryConfig, serializeTombstones, type WireTombstone } from './agentSyncRules.js';

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
