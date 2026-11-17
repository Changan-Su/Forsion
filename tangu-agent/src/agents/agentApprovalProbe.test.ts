/** probeAgentApprovalMode:分清 不在 / 读到了 / 读不出来(通道 run 按 Agent 档收紧用;读不出来不许当成「没设」)。真文件系统。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent, probeAgentApprovalMode } from './agentRegistry.js';

let home: string;
const dir = (slug: string): string => { const d = join(home, 'agents', slug); mkdirSync(d, { recursive: true }); return d; };

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tangu-probe-')); process.env.TANGU_HOME = home; });
afterEach(() => { delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true }); });

describe('probeAgentApprovalMode', () => {
  it('没有这个 Agent → absent', async () => {
    expect(await probeAgentApprovalMode('nobody')).toEqual({ state: 'absent' });
    expect(await probeAgentApprovalMode('../x')).toEqual({ state: 'absent' });
  });

  it('设了 / 没设 → ok(没设 = 空串)', async () => {
    writeFileSync(join(dir('ro'), 'config.toml'), 'name = "ro"\napproval_mode = "readonly"\n');
    writeFileSync(join(dir('plain'), 'config.toml'), 'name = "plain"\n');
    expect(await probeAgentApprovalMode('ro')).toEqual({ state: 'ok', mode: 'readonly' });
    expect(await probeAgentApprovalMode('plain')).toEqual({ state: 'ok', mode: '' });
  });

  it('解析不了的 config.toml → unreadable(注册表照旧当没设)', async () => {
    writeFileSync(join(dir('bad'), 'config.toml'), 'name = "bad\n[[[\n');
    expect(await probeAgentApprovalMode('bad')).toEqual({ state: 'unreadable' });
    expect((await getAgent('bad'))?.approvalMode).toBe(''); // 对比:注册表的返回形状不变
  });

  it('读不出来(EACCES / EISDIR)→ unreadable', async () => {
    const f = join(dir('locked'), 'config.toml');
    writeFileSync(f, 'name = "locked"\n');
    chmodSync(f, 0o000);
    try {
      if (process.getuid?.() !== 0) expect(await probeAgentApprovalMode('locked')).toEqual({ state: 'unreadable' });
    } finally { chmodSync(f, 0o600); }
    mkdirSync(join(dir('isdir'), 'config.toml')); // 读文件报 EISDIR
    expect(await probeAgentApprovalMode('isdir')).toEqual({ state: 'unreadable' });
  });

  it('只剩遗留扁平 .md(迁不动)→ unreadable', async () => {
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(join(home, 'agents', 'flat.md'), '---\nname: flat\n---\nhi\n');
    expect(await probeAgentApprovalMode('flat')).toEqual({ state: 'unreadable' });
  });
});
