import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isKnownSafeBash, writeEscalationNeeded } from '../src/services/approvals.js';

const call = (name: string, args: any) =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } } as any);

describe('isKnownSafeBash', () => {
  it('allows simple read-only commands', () => {
    for (const c of ['ls -la', 'git status', 'git diff HEAD', 'cat package.json', 'rg foo src', 'pwd']) {
      expect(isKnownSafeBash(c)).toBe(true);
    }
  });

  it('rejects chained / redirected / substituted commands (injection guard)', () => {
    for (const c of ['ls; rm -rf /', 'cat x && rm y', 'echo hi > /etc/passwd', 'echo $(rm -rf /)', 'cat `whoami`', 'a | b']) {
      expect(isKnownSafeBash(c)).toBe(false);
    }
  });

  it('rejects non-allowlisted programs and dangerous git subcommands', () => {
    for (const c of ['rm -rf x', 'git push', 'python script.py', 'npm install']) {
      expect(isKnownSafeBash(c)).toBe(false);
    }
  });
});

describe('writeEscalationNeeded', () => {
  const cwd = path.resolve('/tmp/forsion-ws-test');

  it('flags write_file targets outside the workspace', () => {
    expect(writeEscalationNeeded(call('write_file', { path: '../escape.txt' }), { cwd })).toBe(true);
    expect(writeEscalationNeeded(call('write_file', { path: '/etc/hosts' }), { cwd })).toBe(true);
  });

  it('does not flag in-workspace writes', () => {
    expect(writeEscalationNeeded(call('write_file', { path: 'sub/a.ts' }), { cwd })).toBe(false);
  });

  it('extracts apply_patch targets and flags out-of-workspace ones', () => {
    const out = '*** Begin Patch\n*** Update File: ../outside.ts\n@@\n-a\n+b\n*** End Patch';
    expect(writeEscalationNeeded(call('apply_patch', { patch: out }), { cwd })).toBe(true);
    const inside = '*** Begin Patch\n*** Add File: sub/new.ts\n+x\n*** End Patch';
    expect(writeEscalationNeeded(call('apply_patch', { patch: inside }), { cwd })).toBe(false);
  });

  it('returns false for non-write tools', () => {
    expect(writeEscalationNeeded(call('read_file', { path: '../x' }), { cwd })).toBe(false);
  });
});
