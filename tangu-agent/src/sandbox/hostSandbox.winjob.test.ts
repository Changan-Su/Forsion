import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HOST_TOOLS } from '../tools/hostExec.js';
import { hostProcessProvider } from '../tools/builtin/hostProcess.js';
import { BASH_EVAL_ARGS, JOB_READY_VAR, RUN_VAR, hostShell } from '../tools/hostShell.js';
import { getProcess } from '../tools/processRegistry.js';
import { killProcessTree } from '../utils/boundedProcess.js';
import { spawnWindowsJob } from '../utils/windowsProcessJob.js';
import { spawnHostShell } from './hostSandbox.js';

const shell = hostShell();
const sleepExe = shell.bin && path.join(path.dirname(shell.bin), 'sleep.exe');
const exec = promisify(execFile);

async function sleepPid(binary: string, argument: string): Promise<number | undefined> {
  const literalPath = binary.replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name = 'sleep.exe'" | Where-Object { $_.ExecutablePath -eq '${literalPath}' -and $_.CommandLine -and $_.CommandLine.EndsWith(' ${argument}') } | Select-Object -ExpandProperty ProcessId`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  return Number(stdout.trim()) || undefined;
}

describe.runIf(process.platform === 'win32' && shell.kind === 'bash' && !!sleepExe && existsSync(sleepExe))('Windows Git Bash jobs', () => {
  it.each(['', ' | cat'])('stops native descendants of sleep%s on cancellation', async (pipeline) => {
    const marker = Date.now().toString();
    const argument = `300.${marker}`;
    const otherArgument = `301.${marker}`;
    const other = spawnHostShell({ cwd: os.tmpdir() }, `sleep ${otherArgument}`);
    const otherClosed = once(other, 'close');
    const controller = new AbortController();
    const command = HOST_TOOLS.run_bash.execute({ command: `sleep ${argument}${pipeline}`, timeout_ms: 25_000 }, {
      cwd: os.tmpdir(), userId: 'winjob-test', sessionId: 'winjob-test', appId: 'tangu', signal: controller.signal,
    });
    try {
      await expect.poll(() => sleepPid(sleepExe!, argument), { timeout: 8_000 }).toBeTypeOf('number');
      const otherPid = await sleepPid(sleepExe!, otherArgument);
      expect(otherPid).toBeTypeOf('number');
      controller.abort();
      expect(await command).toMatch(/\(aborted\)/);
      expect(await sleepPid(sleepExe!, argument)).toBeUndefined();
      expect(await sleepPid(sleepExe!, otherArgument)).toBe(otherPid);
    } finally {
      controller.abort();
      await killProcessTree(other);
      await command;
      // Clean up only this unique fixture invocation when running against a regression.
      const leaked = await sleepPid(sleepExe!, argument);
      if (leaked) process.kill(leaked);
      const otherLeaked = await sleepPid(sleepExe!, otherArgument);
      if (otherLeaked) process.kill(otherLeaked);
      await otherClosed;
    }
  }, 25_000);

  it('passes stdin, stdout, stderr and the original exit code through Bash', async () => {
    const child = spawnHostShell({ cwd: os.tmpdir() }, 'read -r line; printf "%s\\n" "$line"; echo "${TANGU_RUN_BASH_JOB_READY-unset}" >&2; exit 7');
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += String(data); });
    child.stderr?.on('data', (data) => { stderr += String(data); });
    child.stdin?.end('pipe input with spaces\n');
    expect(await once(child, 'close')).toEqual([7, null]);
    expect(stdout.trim()).toBe('pipe input with spaces');
    expect(stderr.trim()).toBe('unset');
  });

  it('keeps the job after the Bash leader exits and its descendant still owns the pipes', async () => {
    const argument = `302.${Date.now()}`;
    const child = spawnHostShell({ cwd: os.tmpdir() }, `sleep ${argument} & exit 0`);
    const closed = once(child, 'close');
    try {
      expect(await once(child, 'exit')).toEqual([0, null]);
      await expect.poll(() => sleepPid(sleepExe!, argument), { timeout: 8_000 }).toBeTypeOf('number');
      expect(await killProcessTree(child)).toBe(true);
      await closed;
      expect(await sleepPid(sleepExe!, argument)).toBeUndefined();
    } finally {
      await killProcessTree(child);
      const leaked = await sleepPid(sleepExe!, argument);
      if (leaked) process.kill(leaked);
    }
  }, 20_000);

  it('tracks natural background completion and preserves its output', async () => {
    const start = hostProcessProvider.tools().find((tool) => tool.name === 'run_background')!;
    const output = hostProcessProvider.tools().find((tool) => tool.name === 'read_process_output')!;
    const context = { cwd: os.tmpdir(), userId: 'winjob-test', sessionId: 'winjob-background', appId: 'tangu' };
    const started = String(await start.execute({ command: 'printf background-job-marker; exit 7' }, context));
    const id = /started background process (\S+)/.exec(started)?.[1];
    expect(id, started).toBeDefined();
    await expect.poll(() => getProcess(context.sessionId, id!)?.exitCode).toBe(7);
    expect(await output.execute({ process_id: id }, context)).toContain('background-job-marker');
  });

  it('removes the readiness directory when the executable cannot be spawned', async () => {
    let ready = '';
    const child = spawnWindowsJob((file) => {
      ready = file;
      return spawn(path.join(path.dirname(file), 'missing.exe'), [], { windowsHide: true });
    });
    await expect(once(child, 'error')).resolves.toMatchObject([{ code: 'ENOENT' }]);
    expect(existsSync(path.dirname(ready))).toBe(false);
  });

  it('refuses to run the command if the Bash PID differs from the job owner', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tangu-winjob-test-'));
    const ready = path.join(dir, 'ready');
    writeFileSync(ready, `${process.pid}\n`);
    try {
      const { stderr } = await exec(shell.bin!, BASH_EVAL_ARGS, {
        env: { ...process.env, [JOB_READY_VAR]: ready.replaceAll('\\', '/'), [RUN_VAR]: 'printf must-not-run' },
        windowsHide: true,
      }).then(() => { throw new Error('The mismatched Bash process ran'); }, (error) => {
        expect(error.code).toBe(125);
        expect(error.stdout).toBe('');
        return error;
      });
      expect(stderr).toContain('Cannot verify the Windows Git Bash process');
    } finally {
      rmSync(ready, { force: true });
      rmdirSync(dir);
    }
  });
});
