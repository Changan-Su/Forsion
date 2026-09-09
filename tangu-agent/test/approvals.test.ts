import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isKnownSafeBash, writeEscalationNeeded } from '../src/services/approvals.js';

const call = (name: string, args: any) =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } } as any);

describe('isKnownSafeBash', () => {
  it('does not treat mutating arguments, wrappers or executable search helpers as read-only', () => {
    for (const c of [
      'env touch /tmp/not-executed', 'find /tmp -delete', 'git branch -D unused',
      'git branch new-name', 'git remote add unused https://example.invalid/repo',
      'git diff --output=/tmp/not-executed', 'git log --output=/tmp/not-executed',
      'git diff HEAD', 'rg --pre touch text', 'rg --pre=touch text',
      'file -C', 'tree -o /tmp/not-executed', 'date -s 2000-01-01', 'hostname changed',
      'git status\nrm file', 'echo $HOME', 'ls *',
    ]) expect(isKnownSafeBash(c), c).toBe(false);
    for (const c of ['git branch --list', 'git remote -v', 'git status --short', 'rg -n text src']) {
      expect(isKnownSafeBash(c), c).toBe(true);
    }
  });

  it('allows simple read-only commands', () => {
    for (const c of ['ls -la', 'git status', 'git diff --no-ext-diff --no-textconv HEAD', 'cat package.json', 'rg foo src', 'pwd']) {
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
