import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinSystemFindstr, prepareReadOnlyCmd } from './cmdReadOnly.js';
import { credentialPaths } from '../sandbox/hostSandboxProtection.js';

describe('Windows read shortcut', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), 'tangu-cmd-read-'));
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('comspec', 'C:\\Windows\\System32\\cmd.exe');
  });
  afterAll(() => { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });

  it('accepts the screenshot directory listings and literal separators', () => {
    for (const command of [
      'dir /b "plugins" 2>nul & echo --- & dir /b "other plugins" 2>nul',
      'dir /b Journal && type "Journal\\today.md"',
      'cd /d "Space" && dir && type manifest.json',
      'DIR /b 2 > NUL',
    ]) expect(prepareReadOnlyCmd(command, cwd), command).not.toBeNull();
  });

  it('pins findstr to System32 and supports the screenshot feedback search', () => {
    expect(prepareReadOnlyCmd('findstr /i /c:"[feedback]" "LOG\\*.md"', cwd))
      .toBe('"C:\\Windows\\System32\\findstr.exe" /i /c:"[feedback]" "LOG\\*.md"');
    expect(prepareReadOnlyCmd('cd /d Space && findstr /n text main.js', cwd))
      .toBe('cd /d Space && "C:\\Windows\\System32\\findstr.exe" /n text main.js');
  });

  it('preserves approved scripts containing escaped operators or a different shell', () => {
    for (const command of ['echo hi^&findstr text notes.md', 'echo literal^&del victim.txt & findstr text notes.md', 'echo ok && (findstr text notes.md)', 'dir | findstr text']) {
      expect(pinSystemFindstr(command)).toBe(command);
    }
    vi.stubEnv('comspec', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(pinSystemFindstr('findstr text notes.md')).toBe('findstr text notes.md');
    vi.stubEnv('comspec', 'C:\\Windows\\System32\\cmd.exe');
  });

  it('requires approval for any unknown or mutating segment and ambiguous cmd syntax', () => {
    for (const command of [
      'dir && node -e "code"', 'dir & del notes.md', 'dir && npm install',
      'dir || echo failed', 'dir | findstr text', 'dir > out.txt', 'dir 2>other',
      'dir 2>nul.txt', 'dir 1>nul', 'dir 2>>nul', 'dir < input', 'dir &',
      'dir\necho text', 'dir %TEMP%', 'dir !x!', 'dir ^& echo x',
      'echo text > out.txt', 'cd Space & type notes.md', 'cd C:Space && type notes.md',
      'findstr /g:patterns text.md', 'findstr /f:files text', 'findstr /d:other text notes.md',
      'findstr text', 'findstr text \\\\server\\share\\file', '"findstr" text notes.md',
      'fi""ndstr text notes.md', 'findstr"" /l text notes.md', 'di""r', '2>nul findstr text notes.md',
      'dir missing && cd Space && echo ok & type notes.md',
      'findstr text "folder\\" notes.md', 'findstr te"xt" notes.md',
      'type notes.md:secret', 'type "auth.json."', 'dir && powershell code',
    ]) expect(prepareReadOnlyCmd(command, cwd), command).toBeNull();
  });

  it('checks every read after cd, including wildcard/recursive credential ancestors', () => {
    const credential = credentialPaths()[0];
    const folder = path.dirname(credential);
    const file = path.basename(credential);
    const tests = [
      `dir & type "${credential}"`,
      `cd /d "${folder}" && type "${file}"`,
      `cd /d "${folder}" && findstr text "${file}"`,
      `cd /d "${folder}" && cd /d nonexistent && echo ok & type "${file}"`,
      `findstr /v __NO_MATCH__\\" ${credential} \\" dummy.txt`,
      `findstr text "${folder}\\*.json"`,
      `findstr /s text "${folder}\\*.md"`,
    ];
    // On POSIX a host credential path isn't a cmd path. Use relative paths to test the same policy.
    if (process.platform !== 'win32') {
      expect(prepareReadOnlyCmd(`type "${file}"`, folder)).toBeNull();
      expect(prepareReadOnlyCmd('findstr text *.json', folder)).toBeNull();
    } else for (const command of tests) expect(prepareReadOnlyCmd(command, cwd), command).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('Windows shell execution', () => {
  it('runs reads without executing a same-name helper in the working directory', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'tangu-cmd-exec-'));
    try {
      mkdirSync(path.join(cwd, 'Space'));
      writeFileSync(path.join(cwd, 'Space', 'notes.md'), '[feedback] approved\n');
      writeFileSync(path.join(cwd, 'Space', 'findstr.cmd'), '@echo HIJACKED> hijacked.txt\r\n');
      const { HOST_TOOLS } = await import('./hostExec.js');
      const result = await HOST_TOOLS.run_bash.execute({
        command: 'dir /b "missing" 2>nul & echo --- & cd /d Space && findstr /l /c:"[feedback]" notes.md',
      }, { cwd } as any);
      expect(result).toContain('[feedback] approved');
      expect(result).toContain('exit_code: 0');
      const { existsSync } = await import('node:fs');
      expect(existsSync(path.join(cwd, 'Space', 'hijacked.txt'))).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
