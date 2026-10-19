import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { isKnownSafeBash, writeEscalationNeeded } from '../src/services/approvals.js';
import { credentialPaths } from '../src/sandbox/hostSandboxProtection.js';

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

// 10-19:Windows 上 run_bash 走 cmd.exe。Muse 用 `dir /b "C:\…"` 读自己的目录,每条都排成一张审批卡。
describe('isKnownSafeBash · Windows cmd 的 dir / type', () => {
  const win = (c: string, cwd = process.cwd()) => isKnownSafeBash(c, cwd, 'win32');

  it('只读写法免审批(双引号路径、/x 开关、中文路径、dir 的通配)', () => {
    for (const c of ['dir', 'dir /b', 'DIR /b /s "Library"', 'dir /a:-d /o:-d /-c "Journal\\笔记 1"', 'dir *.md', 'dir C:\\Users\\x', 'type "Journal\\2026-10-19.md"', 'type README.md']) {
      expect(win(c), c).toBe(true);
    }
  });

  it('管道 / 重定向 / 分隔符 / 变量 / UNC / 备用数据流 / 短名 / 末尾点 / PowerShell 语法一概要批', () => {
    for (const c of [
      'dir | more', 'dir > out.txt', 'dir & del x', 'dir && del x', 'dir 2>nul', 'type a,b', 'type a;b', 'type a=b',
      'dir %USERPROFILE%', 'dir !x!', 'dir ^& x', 'dir (x)', 'type "unclosed', '"dir" /b', 'dir/b',
      'type \\\\server\\share\\x', 'dir \\\\?\\C:\\x', 'type \\Users\\x', 'dir /b //server/share',
      'type a.txt:secret', 'type C:x:y', 'type PROGRA~1\\x', 'type *.md', 'type a?.md', 'type "auth.json."', 'type "dir\\auth.json "',
      'type /x', 'dir /b/s', "type 'a'", 'dir $env:x', 'dir `x`', 'dir @x', 'dir [ab]',
      'findstr /i x *.md', 'findstr x a.md', 'where git', 'cd /d C:\\x',
    ]) expect(win(c), c).toBe(false);
  });

  it('碰凭据文件的不算(和 cat 同口径)', () => {
    const cred = credentialPaths()[0];
    expect(win(`type "${path.basename(cred)}"`, path.dirname(cred))).toBe(false);
    expect(win(`dir "${path.basename(cred)}"`, path.dirname(cred))).toBe(false);
    expect(win('type "notes.md"', path.dirname(cred))).toBe(true);
  });

  it('只在 Windows 上这样判,别的平台照旧', () => {
    expect(isKnownSafeBash('dir /b', process.cwd(), 'darwin')).toBe(false);
    expect(isKnownSafeBash('type README.md', process.cwd(), 'linux')).toBe(false);
  });
});

describe('isKnownSafeBash · Windows 上的外部程序', () => {
  it('工作区里放了同名可执行文件(LS.BAT / git.cmd)就不免审批;date 带参数是改系统日期,不收', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'win-planted-'));
    expect(isKnownSafeBash('ls -la', dir, 'win32')).toBe(true);
    writeFileSync(path.join(dir, 'LS.BAT'), '');
    expect(isKnownSafeBash('ls -la', dir, 'win32')).toBe(false);
    expect(isKnownSafeBash('ls -la', dir, 'darwin')).toBe(true); // 别的平台不在当前目录找程序
    writeFileSync(path.join(dir, 'git.cmd'), '');
    expect(isKnownSafeBash('git status', dir, 'win32')).toBe(false);
    expect(isKnownSafeBash('date -u', dir, 'win32')).toBe(false);
    expect(isKnownSafeBash('pwd', path.join(dir, 'missing'), 'win32')).toBe(false); // 读不了目录按「有」算
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
