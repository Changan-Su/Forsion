import { describe, it, expect } from 'vitest';
import { buildActivityDigest } from './muse.js';

describe('buildActivityDigest (Muse 跨 agent 活动摘要拼装)', () => {
  it('空清单 / 全空白 → 空串(不注入噪声)', () => {
    expect(buildActivityDigest([])).toBe('');
    expect(buildActivityDigest([{ scope: 'xyra', text: '   \n ' }])).toBe('');
  });
  it('带域标头,单域截尾 ≤1200 字', () => {
    const out = buildActivityDigest([{ scope: 'xyra', text: 'x'.repeat(3000) }]);
    expect(out).toContain("[Recent activity across the user's agents");
    expect(out).toContain('--- agent:xyra ---');
    const body = out.split('--- agent:xyra ---\n')[1];
    expect(body.length).toBeLessThanOrEqual(1200);
  });
  it('总量帽 4000:装不下的域整体丢弃(不截半个域)', () => {
    const sections = ['a', 'b', 'c', 'd'].map((s) => ({ scope: s, text: 'y'.repeat(1200) }));
    const out = buildActivityDigest(sections);
    expect(out).toContain('agent:a');
    expect(out).toContain('agent:c'); // 3×1200=3600 ≤ 4000
    expect(out).not.toContain('agent:d'); // 第 4 个会到 4800 → 丢
  });
});

import { museAgentConfig, formatJournalLine, museLibraryDir, museSpaceDir, spaceDirStamp, pollIntervalMs } from './muse.js';
import { SPECIAL_AGENTS_DEFAULTS } from './specialAgentsConfig.js';

describe('museAgentConfig (权限档 → 周期 run 的 agentConfig)', () => {
  const base = { ...SPECIAL_AGENTS_DEFAULTS.muse, allowedFolders: ['/tmp/a', '/tmp/b'] };
  it('ask:auto-edit + 排队审批;工作区=Library;可写根只有自己的 Space 目录(allowedFolders 不进)', () => {
    const c = museAgentConfig({ ...base, mode: 'ask' });
    expect(c.approvalMode).toBe('auto-edit');
    expect(c.approvalDeferral).toBe('queue');
    expect(c.planMode).toBe(false);
    expect(c.cwd).toBe(museLibraryDir());
    expect(c.extraRoots).toEqual([museSpaceDir()]); // 自建 Space 三档免审(2026-09-11)
    expect(c.muse).toBe(true);
    expect(c.agentSlug).toBe('muse');
    expect(c.automationOrigin).toBe('muse');
  });
  it('agent:同 ask 但由默认 agent 代批', () => {
    const c = museAgentConfig({ ...base, mode: 'agent' });
    expect(c.approvalMode).toBe('auto-edit');
    expect(c.approvalDeferral).toBe('agent');
  });
  it('auto:full-auto,无 deferral,allowedFolders 并入可写根(≤8)', () => {
    const c = museAgentConfig({ ...base, mode: 'auto', allowedFolders: Array.from({ length: 12 }, (_, i) => `/tmp/${i}`) });
    expect(c.approvalMode).toBe('full-auto');
    expect(c.approvalDeferral).toBeUndefined();
    expect((c.extraRoots as string[]).length).toBe(9); // Space 目录 + allowedFolders 前 8 个
    expect((c.extraRoots as string[])[0]).toBe(museSpaceDir());
  });
  it('负对照:ask 档绝不能拿到 full-auto', () => {
    expect(museAgentConfig({ ...base, mode: 'ask' }).approvalMode).not.toBe('full-auto');
  });
});

describe('formatJournalLine', () => {
  it('单行、字段序固定、note 折行截 120', () => {
    const line = formatJournalLine({ time: '09:15', mode: 'ask', trigger: 'heartbeat', tokens: 1234, files: 2, status: 'done', note: 'a\n\nb   c' + 'x'.repeat(200) });
    expect(line.startsWith('- 09:15 · ask · heartbeat · tokens 1234 · files 2 · done · a b c')).toBe(true);
    expect(line.includes('\n')).toBe(false);
    expect(line.length).toBeLessThan(200);
  });
  it('无 note 不留尾巴', () => {
    expect(formatJournalLine({ time: '09:15', mode: 'auto', trigger: 'schedule:x', tokens: 0, files: 0, status: 'failed', note: '  ' }))
      .toBe('- 09:15 · auto · schedule:x · tokens 0 · files 0 · failed');
  });
});

describe('spaceDirStamp (自建 Space 内容戳)', () => {
  it('目录不存在 → 0;有文件 → 最大 mtime(毫秒取整);点文件不算', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-space-'));
    expect(await spaceDirStamp(path.join(dir, 'missing'))).toBe(0);
    const t = 1_700_000_000_000;
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(dir, 'main.js'), '');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'x.js'), '');
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');
    fs.utimesSync(path.join(dir, 'manifest.json'), new Date(t - 1000), new Date(t - 1000));
    fs.utimesSync(path.join(dir, 'main.js'), new Date(t), new Date(t));
    fs.utimesSync(path.join(dir, 'lib', 'x.js'), new Date(t - 5000), new Date(t - 5000));
    fs.utimesSync(path.join(dir, '.DS_Store'), new Date(t + 60_000), new Date(t + 60_000));
    expect(await spaceDirStamp(dir)).toBe(t);
    // 负对照:改了 main.js 的 mtime 戳必须变
    fs.utimesSync(path.join(dir, 'main.js'), new Date(t + 2000), new Date(t + 2000));
    expect(await spaceDirStamp(dir)).toBe(t + 2000);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('pollIntervalMs (巡检跟着心跳缩)', () => {
  it('心跳粗于巡检 → 用巡检;心跳更细 → 用心跳;心跳 0(关)→ 用巡检;下限 1 分钟', () => {
    expect(pollIntervalMs(5, 120)).toBe(5 * 60_000);
    expect(pollIntervalMs(5, 3)).toBe(3 * 60_000);
    expect(pollIntervalMs(5, 0)).toBe(5 * 60_000);
    expect(pollIntervalMs(5, 1)).toBe(60_000);
    expect(pollIntervalMs(0, 0)).toBe(60_000); // 负对照:配置坏成 0 也不会变成忙轮询
  });
});
