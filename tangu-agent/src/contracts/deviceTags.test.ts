import { describe, expect, it } from 'vitest';
import {
  appliesToOf, classifyTag, filterTaggedEntries, filterTaggedText, foldNote, isReservedDeviceName, labelFor, lineTag,
  renameDeviceTag, sameDeviceName, tagLegend, withTag, type DeviceTagContext,
} from './deviceTags.js';

const mac: DeviceTagContext = { self: 'MacBook Pro', os: 'macOS', others: ['Windows desktop'] };
const win: DeviceTagContext = { self: 'Windows desktop', os: 'Windows', others: ['MacBook Pro'] };
const cloud: DeviceTagContext = { self: null, os: null, others: [] };

describe('device tags: what counts as a tag', () => {
  it('system names, this device and other known devices; case and spacing do not matter', () => {
    expect(classifyTag('macOS', mac)).toEqual({ kind: 'os', label: 'macOS', os: 'macOS' });
    expect(classifyTag('windows', mac)).toMatchObject({ kind: 'os', os: 'Windows' });
    expect(classifyTag(' macbook   PRO ', mac)).toMatchObject({ kind: 'device', self: true });
    expect(classifyTag('Windows desktop', mac)).toMatchObject({ kind: 'device', self: false });
    expect(classifyTag('Note', mac)).toBeNull(); // 认不得的方括号是正文
  });
  it('only at the start of a line (after indent, a list marker or a heading marker), followed by text', () => {
    expect(lineTag('- [Windows] Fluent cuts paths at spaces', mac)).toMatchObject({ lead: '- ', body: 'Fluent cuts paths at spaces' });
    expect(lineTag('## [MacBook Pro] TeX', mac)).toMatchObject({ lead: '## ', body: 'TeX' });
    expect(lineTag('  1. [Linux] x', mac)?.tag.kind).toBe('os');
    expect(lineTag('Uses [Windows] sometimes', mac)).toBeNull();
    expect(lineTag('[Windows](https://example.com) link', mac)).toBeNull();
    expect(lineTag('[Windows]: https://example.com', mac)).toBeNull();
    expect(lineTag('- [ ] todo', mac)).toBeNull();
    expect(lineTag('[Windows]', mac)).toBeNull();
  });
  it('reserved names and name equality', () => {
    expect(isReservedDeviceName(' Linux ')).toBe(true);
    expect(isReservedDeviceName('Linux box')).toBe(false);
    expect(sameDeviceName('MacBook  Pro', 'macbook pro')).toBe(true);
    expect(sameDeviceName('', '')).toBe(false);
  });
});

describe('device tags: writing', () => {
  it('the engine adds the label; an existing recognised label is replaced, never stacked; the lead is kept', () => {
    expect(withTag('TeX Live 2026 with latexmk', 'MacBook Pro', mac)).toBe('[MacBook Pro] TeX Live 2026 with latexmk');
    expect(withTag('- [Windows] x', 'macOS', mac)).toBe('- [macOS] x');
    expect(withTag('- [Windows] x', null, mac)).toBe('- x');
    expect(withTag('- [Note] x', 'macOS', mac)).toBe('- [macOS] [Note] x');
    expect(labelFor('this-computer', mac)).toBe('MacBook Pro');
    expect(labelFor('this-os', win)).toBe('Windows');
    expect(labelFor('this-computer', cloud)).toBeNull();
    expect(labelFor('all', mac)).toBeNull();
  });
  it('appliesToOf reads a line back for the UI', () => {
    expect(appliesToOf('[MacBook Pro] x', mac).appliesTo).toBe('this-computer');
    expect(appliesToOf('[macOS] x', mac).appliesTo).toBe('this-os');
    expect(appliesToOf('[Windows] x', mac).appliesTo).toBe('other');
    expect(appliesToOf('x', mac)).toEqual({ appliesTo: 'all', tag: null });
  });
});

describe('device tags: reading (only what applies here; the rest folds into one line)', () => {
  const memory = ['写论文用 LaTeX', '[MacBook Pro] 本机装的是 TeX Live 2026', '[Windows] Fluent 会在空格处截断路径', '[Windows desktop] 求解器在 D 盘', '每周五整理参考文献'];
  it('entries: untagged + this device + this system', () => {
    const m = filterTaggedEntries(memory, (x) => x, mac);
    expect(m.kept).toEqual(['写论文用 LaTeX', '[MacBook Pro] 本机装的是 TeX Live 2026', '每周五整理参考文献']);
    expect(foldNote(m.skipped)).toBe('(2 more entries apply only to other computers: 1 on Windows, 1 on "Windows desktop")');
    const w = filterTaggedEntries(memory, (x) => x, win);
    expect(w.kept).toEqual(['写论文用 LaTeX', '[Windows] Fluent 会在空格处截断路径', '[Windows desktop] 求解器在 D 盘', '每周五整理参考文献']);
    expect(foldNote(w.skipped)).toBe('(1 more entry applies only to other computers: 1 on "MacBook Pro")');
    // 云端 run:不在任何一台电脑上,认得的标签全折起来;认不得的(云端不知道设备名)照常当正文
    const c = filterTaggedEntries(memory, (x) => x, cloud);
    expect(c.kept).toEqual(['写论文用 LaTeX', '[MacBook Pro] 本机装的是 TeX Live 2026', '[Windows desktop] 求解器在 D 盘', '每周五整理参考文献']);
    expect(foldNote([])).toBe('');
  });
  it('free text: a tagged heading drops its whole section, a tagged item drops its sub-items, code blocks are left alone', () => {
    const soul = [
      'Be concise.',
      '## [Windows] Solver',
      'Use the copy in D:\\solve.',
      '### Details',
      'nested under the Windows section',
      '## Writing',
      '- [Windows] Fluent paths',
      '  - no spaces',
      '- [macOS] use latexmk',
      '```',
      '[Windows] inside code',
      '```',
      'end',
    ].join('\n');
    const f = filterTaggedText(soul, mac);
    expect(f.text).toBe(['Be concise.', '## Writing', '- [macOS] use latexmk', '```', '[Windows] inside code', '```', 'end'].join('\n'));
    expect(f.skipped).toEqual([{ label: 'Windows', kind: 'os' }, { label: 'Windows', kind: 'os' }]);
    expect(foldNote(f.skipped, 'part')).toBe('(2 more parts apply only to other computers: 2 on Windows)');
    expect(filterTaggedText(soul, win).text).toContain('Use the copy in D:\\solve.');
  });
  it('legend names this computer, or says the run is on none of them', () => {
    expect(tagLegend(mac)).toContain('this computer is "MacBook Pro" (macOS)');
    expect(tagLegend(cloud)).toContain('not on any of the user');
  });
});

describe('device tags: rename', () => {
  it('only this device’s tags at line start change; prose, other devices and code-like mentions stay', () => {
    const text = ['- [MacBook Pro] TeX', '- [macbook pro] lower', 'The MacBook Pro is old', '- [Windows desktop] x', '## [h-1] [MacBook Pro] note title (note)'].join('\n');
    expect(renameDeviceTag(text, 'MacBook Pro', 'Studio Mac')).toBe(['- [Studio Mac] TeX', '- [Studio Mac] lower', 'The MacBook Pro is old', '- [Windows desktop] x', '## [h-1] [Studio Mac] note title (note)'].join('\n'));
    expect(renameDeviceTag('nothing here', 'A', 'B')).toBe('nothing here');
    expect(renameDeviceTag('- [A] x', 'A', '[bad]')).toBe('- [A] x');
  });
});
