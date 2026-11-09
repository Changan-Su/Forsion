// 记忆分层第二步(11-09)的纯契约:行尾记号、画像拆 / 拼、每条在哪(从内容推)、按条合并。引擎和桌面宿主共用这一份。
import { describe, expect, it } from 'vitest';
import { diff3Merge } from 'node-diff3';
import { normalizeMemoryFact, splitMark, stripMark, withMark } from './entryMark.js';
import { insertPortraitEntry, lineIdentity, mergeEntryLists, mergePortrait, mergeTopicFile, parseTopicFile, portraitResidentChars, portraitResidentText, residentLine, settlePortrait, splitPortrait, topicIndexLine, validTopicAbout } from './memoryLayers.js';
import { mergeAgentSyncContent } from './agentSyncRules.js';

const merge = (path: string, ours: string, base: string | null, theirs: string) => mergeAgentSyncContent(path, ours, base, theirs, { diff3: diff3Merge })!;
const topics = (content: string) => Object.fromEntries(splitPortrait(content).topics.map((t) => [t.key, t.entries.map((e) => e.text)]));
const residentFacts = (content: string) => portraitResidentText(content).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));

const ORIGINAL = '# 林夏\n\n- 你叫林夏。\n- 你每周六上午学钢琴。\n\n## 最近认识的\n\n- 你在读博。\n- 你养了一只猫。\n';
const ORGANIZED = '# 林夏\n\n- 你叫林夏。\n\n## 最近认识的\n\n- 你在读博。\n\n## 日常与爱好 <!--tg topic=life-->\n\n兴趣、宠物与周末安排\n\n- 你每周六上午学钢琴。 <!--tg by=user-->\n- 你养了一只猫。 <!--tg by=agent-->\n';

describe('line-end marks', () => {
  it('travel with the line, never change the identity, and never reach what a model reads', () => {
    const line = withMark('你在读博。', { pin: true, by: 'import', from: '2026-11-03' });
    expect(line).toBe('你在读博。 <!--tg pin by=import from=2026-11-03-->');
    expect(splitMark(line)).toMatchObject({ body: '你在读博。', meta: { pin: true, by: 'import', from: '2026-11-03' }, marked: true });
    expect(normalizeMemoryFact(`- ${line}`)).toBe(normalizeMemoryFact('你在读博。'));
    expect(stripMark(line)).toBe('你在读博。');
    expect(withMark('x', {})).toBe('x');
  });
});

describe('portrait layers inside SOUL.md', () => {
  it('a heading with a topic mark starts a detail section; resident = everything else, marks stripped, counted alone', () => {
    const l = splitPortrait(ORGANIZED);
    expect(l.topics.map((t) => [t.key, t.title, t.about, t.entries.length])).toEqual([['life', '日常与爱好', '兴趣、宠物与周末安排', 2]]);
    expect(portraitResidentText(ORGANIZED)).toBe('# 林夏\n\n- 你叫林夏。\n\n## 最近认识的\n\n- 你在读博。');
    expect(portraitResidentChars(ORGANIZED)).toBe(portraitResidentText(ORGANIZED).length);
    expect(topicIndexLine(l.topics[0], 'human/SOUL.md')).toBe('- 日常与爱好 · 2 entries — 兴趣、宠物与周末安排 (human/SOUL.md)');
  });
  it('the resident line cuts whole entries; what is past it goes to recall', () => {
    const text = `- 一\n- ${'二'.repeat(30)}\n- 三`;
    const line = residentLine(text, 10);
    expect([...line.inside]).toEqual(['一']);
    expect(line.outside).toEqual(['二'.repeat(30), '三']);
  });
  it('settle: a detail copy wins over an unpinned resident copy, a pinned resident copy wins over every detail, the smallest topic key wins, archive loses', () => {
    const dup = '- 你叫林夏。\n- 你养了一只猫。\n\n## 日常 <!--tg topic=life-->\n\n日常与宠物的细节\n\n- 你养了一只猫。 <!--tg by=agent-->\n';
    expect(residentFacts(settlePortrait(dup))).toEqual(['你叫林夏。']);
    const pinned = '- 你养了一只猫。 <!--tg pin-->\n\n## 日常 <!--tg topic=life-->\n\n日常与宠物的细节\n\n- 你养了一只猫。\n- 你周末爬山。\n';
    expect(topics(settlePortrait(pinned))).toEqual({ life: ['你周末爬山。'] });
    expect(residentFacts(settlePortrait(pinned))).toEqual(['你养了一只猫。']);
    const twoTopics = '- 你叫林夏。\n\n## 学习 <!--tg topic=study-->\n\n课程与项目\n\n- 你在读博。\n\n## 档案 <!--tg topic=archive-->\n\n- 你在读博。\n\n## 背景 <!--tg topic=background-->\n\n过去的经历与背景\n\n- 你在读博。\n';
    expect(topics(settlePortrait(twoTopics))).toEqual({ background: ['你在读博。'] });
    // 什么都不用删:原样返回(字节不变,同步不来回推)
    expect(settlePortrait(ORGANIZED)).toBe(ORGANIZED);
  });
});

describe('merging (R1, R2, R9)', () => {
  it('first contact (no base): the union does not bring a moved entry back to resident', () => {
    for (const [ours, theirs] of [[ORGANIZED, ORIGINAL], [ORIGINAL, ORGANIZED]]) {
      const m = merge('human/SOUL.md', ours, null, theirs);
      expect(residentFacts(m.content)).toEqual(['你叫林夏。', '你在读博。']);
      expect(topics(m.content)).toEqual({ life: ['你每周六上午学钢琴。', '你养了一只猫。'] });
    }
  });
  it('two devices moved the same entry into different topics: both end in the same place (smallest key), either direction', () => {
    const a = '- 你叫林夏。\n\n## 背景 <!--tg topic=background-->\n\n过去的经历与背景\n\n- 你养了一只猫。 <!--tg by=agent-->\n';
    const b = '- 你叫林夏。\n\n## 日常 <!--tg topic=life-->\n\n日常与宠物的细节\n\n- 你养了一只猫。 <!--tg by=agent-->\n';
    const base = '- 你叫林夏。\n- 你养了一只猫。\n';
    const ab = merge('human/SOUL.md', a, base, b).content, ba = merge('human/SOUL.md', b, base, a).content;
    expect(topics(ab)).toEqual({ background: ['你养了一只猫。'] });
    expect(topics(ba)).toEqual(topics(ab));
    expect(residentFacts(ab)).toEqual(['你叫林夏。']);
  });
  it('who wrote it rides along through a move and a merge; a pin set on one side survives', () => {
    const base = '# 学习\n\n课程与项目\n\n- 你在读博。 <!--tg by=import from=2026-11-03-->\n- 你每周跑步。 <!--tg by=user-->\n';
    const ours = '# 学习\n\n课程与项目\n\n- 你在读博。 <!--tg by=import from=2026-11-03-->\n- 你每周跑步。 <!--tg by=user-->\n- 你在学日语。 <!--tg by=agent-->\n';
    const theirs = '# 学习\n\n课程与项目\n\n- 你在读博。 <!--tg pin by=import from=2026-11-03-->\n- 你每周跑步。 <!--tg by=user-->\n';
    const m = merge('agents/aria/Library/memory/study.md', ours, base, theirs);
    const t = parseTopicFile('study', m.content);
    expect(t.entries.map((e) => [e.text, e.meta])).toEqual([
      ['你在读博。', { pin: true, by: 'import', from: '2026-11-03' }], ['你每周跑步。', { by: 'user' }], ['你在学日语。', { by: 'agent' }]]);
    // 记忆详情文件:只认 Library/memory/*.md,别的 Library 文件不按条合
    expect(mergeTopicFile('study', ours, null, theirs).content).toContain('你在学日语。');
  });
  it('an entry deleted on one side stays deleted; first contact keeps both sides', () => {
    const e = (raw: string) => parseTopicFile('k', `# K\n\n${raw}\n`).entries;
    expect(mergeEntryLists(e('- 甲\n- 乙'), e('- 甲\n- 乙'), e('- 甲')).map((x) => x.text)).toEqual(['甲']);
    expect(mergeEntryLists(e('- 甲'), null, e('- 乙')).map((x) => x.text)).toEqual(['甲', '乙']);
  });
  it('mergePortrait (resident): a mark changed only here is kept (pinning on this device is not undone by the cloud copy)', () => {
    const base = '- 你叫林夏。\n- 你在读博。\n';
    const ours = '- 你叫林夏。\n- 你在读博。 <!--tg pin-->\n';
    const theirs = '- 你叫林夏。\n- 你在读博。\n- 你喜欢喝茶。\n';
    const m = mergePortrait(ours, base, theirs);
    expect(m.content).toContain('你在读博。 <!--tg pin-->');
    expect(m.content).toContain('你喜欢喝茶。');
    expect(m.content.match(/你在读博/g)).toHaveLength(1);
  });
  it('the desktop merge route covers both portrait details and Agent memory details', () => {
    expect(merge('agents/aria/Library/memory/life.md', '# 日常\n\n- 甲\n', null, '# 日常\n\n- 乙\n').content).toBe('# 日常\n\n- 甲\n- 乙\n');
    expect(merge('agents/aria/Library/notes/a.md', 'x\n', 'y\n', 'z\n')).not.toEqual({ content: 'x\nz\n', conflict: false });
  });
});

describe('topic index gate', () => {
  it('an index line must say what is in the topic, not repeat its name', () => {
    expect(validTopicAbout('课程细节、项目进展、申请计划', '学习', 'study')).toBe(true);
    expect(validTopicAbout('学习', '学习', 'study')).toBe(false);
    expect(validTopicAbout('study.md', 'Study', 'study')).toBe(false);
    expect(validTopicAbout('two\nlines here', 'x', 'x')).toBe(false);
  });
});

describe('Codex review 11-09', () => {
  it('one side moved an entry into a topic while the other forgot it: the forget wins', () => {
    const base = '- 你叫林夏。\n- 你养了一只猫。\n';
    const moved = '- 你叫林夏。\n\n## 日常 <!--tg topic=life-->\n\n日常与宠物的细节\n\n- 你养了一只猫。 <!--tg by=agent-->\n';
    const forgot = '- 你叫林夏。\n';
    for (const [o, t] of [[moved, forgot], [forgot, moved]]) {
      const m = merge('human/SOUL.md', o, base, t).content;
      expect(m).not.toContain('猫');
      expect(residentFacts(m)).toEqual(['你叫林夏。']);
    }
  });
  it('a numbered entry and a bulleted one are the same entry', () => {
    expect(lineIdentity('1. You have a cat.')).toBe(lineIdentity('- You have a cat. <!--tg pin-->'));
    expect(residentLine('1. You have a cat.', 100).inside.has(lineIdentity('- You have a cat.'))).toBe(true);
  });
  it('a heading inside a detail topic is not a resident section: new entries never land in a topic', () => {
    const doc = '- 你叫林夏。\n\n## 日常 <!--tg topic=life-->\n\n日常细节\n\n### 最近认识的\n\n- 你养了一只猫。\n';
    const out = insertPortraitEntry(doc, '你在读博。');
    expect(topics(out)).toEqual({ life: ['你养了一只猫。'] });
    expect(residentFacts(out)).toEqual(['你叫林夏。', '你在读博。']);
  });
});
