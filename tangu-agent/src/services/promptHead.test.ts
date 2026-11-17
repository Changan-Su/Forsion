import { describe, expect, it } from 'vitest';
import { buildProbe, currentDateSection, formatCwdListing, hashOf } from './promptHead.js';

const head = (extra = '') => [
  { name: 'system:instructions', text: 'You are Tangu.' },
  { name: 'system:memoryStable', text: `stored evidence${extra}` },
  { name: 'system:cwd', text: '[dir]  src/' },
  { name: 'tools', text: '[{"name":"read_file"}]' },
  { name: 'messages:head', text: '{"role":"user"}' },
];

describe('prompt head probe', () => {
  it('段指纹只随该段字节变化,headHash 只覆盖系统侧与工具头', () => {
    const base = buildProbe(head());
    expect(buildProbe(head()).segments).toEqual(base.segments); // 同输入同指纹(纯函数)
    expect(base.segments.every((s) => /^[0-9a-f]{16}$/.test(s.hash))).toBe(true);
    expect(base.segments.find((s) => s.name === 'system:instructions')!.bytes).toBe(14);
    // CJK 按 UTF-8 字节计,不是 UTF-16 码元数
    expect(buildProbe([{ name: 'tools', text: '中文' }]).segments[0].bytes).toBe(6);
    // 会话历史变化不该动 headHash——否则跨会话根本没法比
    const withOtherHistory = head().map((s) => (s.name === 'messages:head' ? { ...s, text: '{"role":"user","c":"x"}' } : s));
    expect(buildProbe(withOtherHistory).headHash).toBe(base.headHash);
    expect(buildProbe(head('!')).headHash).not.toBe(base.headHash);
  });

  it('headHash 认段边界:跨段挪一个字符必须换指纹(无分隔符拼接会哈成同一值)', () => {
    const seg = (a: string, b: string) => [
      { name: 'system:instructions', text: a },
      { name: 'system:memoryStable', text: b },
    ];
    // 评审 #8 的反例:两份结构不同的 prompt 在旧编码下同哈 → headHashSameAsAgentModel 假阳性。
    expect(buildProbe(seg('ab', 'c')).headHash).not.toBe(buildProbe(seg('a', 'bc')).headHash);
    // 负对照:同一份输入原样再算一次仍是同一指纹(不是「随便什么都不一样」)。
    expect(buildProbe(seg('ab', 'c')).headHash).toBe(buildProbe(seg('ab', 'c')).headHash);
    // 段名也进编码:正文一样、段名不同 = 不同的头(段换了落点也是前缀变更)。
    expect(buildProbe([{ name: 'system:a', text: 'x' }]).headHash)
      .not.toBe(buildProbe([{ name: 'system:b', text: 'x' }]).headHash);
  });

  it('changedSegments 只点名真正变了的段;第一帧无基线恒空;整段消失也算变', () => {
    const base = buildProbe(head());
    expect(base.changedSegments).toEqual([]); // probeSeq=0 是基线,不是「什么都没变」
    expect(buildProbe(head(), base.segments).changedSegments).toEqual([]);
    expect(buildProbe(head('!'), base.segments).changedSegments).toEqual(['system:memoryStable']);
    const unlocked = head().map((s) => (s.name === 'tools' ? { ...s, text: '[{"name":"read_file"},{"name":"run_bash"}]' } : s));
    expect(buildProbe(unlocked, base.segments).changedSegments).toEqual(['tools']);
    const moved = head().filter((s) => s.name !== 'system:memoryStable');
    expect(buildProbe(moved, base.segments).changedSegments).toEqual(['system:memoryStable']);
    expect(hashOf('a')).not.toBe(hashOf('b'));
  });
});

describe('cwd listing (B2)', () => {
  const listing = [
    '[file] zebra.md (1234 bytes)',
    '[dir]  src/',
    '[file] apple.txt (7 bytes)',
  ].join('\n');

  it('去字节数、按名排序、readdir 顺序不再泄进前缀', () => {
    expect(formatCwdListing(listing)).toBe('[file] apple.txt\n[dir]  src/\n[file] zebra.md');
    // 同一目录换个 readdir 顺序 / 改个文件大小 → 渲染结果逐字节相同
    const shuffled = ['[dir]  src/', '[file] apple.txt (9999 bytes)', '[file] zebra.md (0 bytes)'].join('\n');
    expect(formatCwdListing(shuffled)).toBe(formatCwdListing(listing));
  });

  it('封顶 20 行并标出还有多少', () => {
    const many = Array.from({ length: 25 }, (_, i) => `[file] f${String(i).padStart(2, '0')}.txt (${i} bytes)`).join('\n');
    const out = formatCwdListing(many);
    expect(out.split('\n')).toHaveLength(21);
    expect(out.split('\n').at(-1)).toBe('… (+5 more)');
    expect(out).toContain('[file] f19.txt');
    expect(out).not.toContain('f20.txt');
    expect(out).not.toMatch(/bytes/);
    expect(formatCwdListing(many, 60).split('\n')).toHaveLength(25); // 未超上限时不加尾行
  });
});

describe('currentDateSection(借鉴 chat-demo ③)', () => {
  const sat = new Date(2026, 10, 15, 9, 30); // 本地时钟 2026-11-15 周日

  it('日期按天、带时区名与 UTC 偏移;同一天不同时刻字节一致(护前缀缓存)', () => {
    const a = currentDateSection(sat, { timeZone: 'Asia/Shanghai' });
    expect(a).toMatch(/^## Current Date\nToday is Sunday, 2026-11-15 \(time zone Asia\/Shanghai, UTC[+-]\d{2}:\d{2}\)\. For the precise current time, call get_datetime\.$/);
    expect(currentDateSection(new Date(2026, 10, 15, 22, 5), { timeZone: 'Asia/Shanghai' })).toBe(a);
    expect(a).not.toMatch(/09:30|9:30/);
  });

  it('没给时区名(非 host run / 取不到)时与旧措辞逐字一致', () => {
    expect(currentDateSection(sat)).toBe('## Current Date\nToday is Sunday, 2026-11-15 (local timezone). For the precise current time, call get_datetime.');
  });

  it('界面语言只认 zh / en,没有快照或其它值不写这段', () => {
    expect(currentDateSection(sat, { uiLocale: 'zh' })).toContain("## Interface Language\nThe user's app interface is set to Chinese.");
    expect(currentDateSection(sat, { uiLocale: 'en' })).toContain('reply in English.');
    expect(currentDateSection(sat, { uiLocale: 'fr' })).not.toContain('Interface Language');
    expect(currentDateSection(sat, {})).not.toContain('Interface Language');
  });

  it('给模型看的这段是英文', () => {
    expect(currentDateSection(sat, { timeZone: 'Asia/Shanghai', uiLocale: 'zh' })).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
