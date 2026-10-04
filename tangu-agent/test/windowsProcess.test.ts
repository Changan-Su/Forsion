/** Real Windows shell/tool regression tests for issue #3. No model or credentials required. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { hostProcessProvider } from '../src/tools/builtin/hostProcess.js';
import { disposeAllProcesses, getProcess, writeStdin } from '../src/tools/processRegistry.js';
import { spawnEngine } from '../src/engines/acpEngine.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('process probe did not settle within 8s');
    await new Promise(r => setTimeout(r, 40));
  }
};

describe.runIf(process.platform === 'win32')('Windows real process lifecycle', () => {
  let dir: string;
  let ctx: ToolContext;
  const pids = new Set<number>();
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forsion win 中文 '));
    ctx = { cwd: dir, sessionId: 'windows-process-test', userId: 'test', appId: 'test', execMode: 'host' };
  });
  afterEach(async () => {
    disposeAllProcesses();
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    pids.clear();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const run = (command: string, options = {}) => HOST_TOOLS.run_bash.execute({ command, ...options }, ctx);
  const tool = (name: string, args: Record<string, unknown>) =>
    hostProcessProvider.tools().find(t => t.name === name)!.execute(args, ctx);
  const script = async (name: string, body: string): Promise<string> => {
    const file = path.join(dir, name);
    await fs.writeFile(file, body);
    return `"${process.execPath}" "${file}"`;
  };
  const start = async (command: string) => {
    const result = String(await tool('run_background', { command }));
    const id = result.match(/process (bg_\w+)/)?.[1];
    if (!id) throw new Error(result);
    return getProcess(ctx.sessionId, id)!;
  };
  const ready = async (): Promise<{ pid: number; port: number }> => {
    const file = path.join(dir, 'ready.json');
    let report: { pid: number; port: number } | undefined;
    await until(async () => {
      try { report = JSON.parse(await fs.readFile(file, 'utf8')); return true; } catch { return false; }
    });
    pids.add(report!.pid);
    return report!;
  };
  const server = () => script('server.cjs', `
    const server = require('node:http').createServer((q, s) => s.end('ok'));
    server.listen(0, '127.0.0.1', () => {
      require('node:fs').writeFileSync('ready.json', JSON.stringify({ pid: process.pid, port: server.address().port }));
      console.log('server-ready');
    });
    setTimeout(() => process.exit(0), 20000);
  `);

  it.each([
    ['python -c "print(6*7)"', '42'],
    ['node -e "console.log(6*7)"', '42'],
    ['git --version', 'git version'],
  ])('returns external stdout: %s', async (command, expected) => {
    const result = await run(command);
    expect(result).toContain(expected);
    expect(result).toContain('exit_code: 0');
  });

  it('preserves stderr, exit code and Unicode output with spaces/Chinese in cwd and script path', async () => {
    const result = await run(await script('输出 test.cjs', "console.log('中文输出'); console.error('diagnostic'); process.exitCode = 7;"));
    expect(result).toContain('中文输出');
    expect(result).toContain('stderr:\ndiagnostic');
    expect(result).toContain('exit_code: 7');
  });

  // The command timeout must outlast a slow start under runner load: killing the server before it
  // writes ready.json is correct behavior, but ready() would then fail the test. Budget = 5s timeout + 5.5s cleanup + 8s probe.
  it('timeout kills the shell descendant, closes its pipes and releases its port', async () => {
    const result = run(await server(), { timeout_ms: 5000 });
    const report = await ready();
    expect(await result).toContain('timed out');
    await until(() => !alive(report.pid));
    await expect(fetch(`http://127.0.0.1:${report.port}`)).rejects.toThrow();
  }, 25_000);

  it('abort kills descendants rather than only cmd.exe', async () => {
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const result = run(await server());
    const report = await ready();
    controller.abort();
    expect(await result).toContain('aborted');
    await until(() => !alive(report.pid));
  }, 15_000);

  it('background stdout/read/kill works through the tool interface and releases the port', async () => {
    const p = await start(await server());
    const report = await ready();
    await until(() => p.output.includes('server-ready'));
    expect(String(await tool('read_process_output', { process_id: p.id }))).toContain('server-ready');
    expect(await (await fetch(`http://127.0.0.1:${report.port}`)).text()).toBe('ok');
    expect(String(await tool('kill_process', { process_id: p.id }))).toContain('killed');
    await until(() => p.child === null && !alive(report.pid));
    expect(p.status).toBe('killed');
    await expect(fetch(`http://127.0.0.1:${report.port}`)).rejects.toThrow();
  }, 15_000);

  it('background stdin round-trip and Ctrl-C stop the actual program', async () => {
    const p = await start(await script('echo.cjs', "console.log('pid=' + process.pid); process.stdin.pipe(process.stdout); setTimeout(() => process.exit(0), 20000);"));
    await until(() => /pid=\d+/.test(p.output));
    const pid = Number(p.output.match(/pid=(\d+)/)![1]);
    pids.add(pid);
    expect(writeStdin(ctx.sessionId, p.id, 'hello 中文', true)).toContain('wrote');
    await until(() => p.output.includes('hello 中文'));
    writeStdin(ctx.sessionId, p.id, '\x03', false);
    await until(() => p.child === null && !alive(pid));
  }, 15_000);

  it('Python http.server streams output and kill_process frees its listening port', async () => {
    const p = await start('python -u -m http.server 0 --bind 127.0.0.1');
    await until(() => /port (\d+)/.test(p.output));
    const port = Number(p.output.match(/port (\d+)/)![1]);
    const url = `http://127.0.0.1:${port}`;
    expect((await fetch(url)).status).toBe(200);
    await until(() => p.output.includes('GET / HTTP'));
    expect(String(await tool('read_process_output', { process_id: p.id }))).toContain('GET / HTTP');
    await tool('kill_process', { process_id: p.id });
    await until(() => p.child === null);
    expect(p.status).toBe('killed');
    await expect(fetch(url)).rejects.toThrow();
  }, 15_000);

  it('ACP launch retains stdout even when its caller requests detached execution', async () => {
    const file = path.join(dir, 'acp-probe.cjs');
    await fs.writeFile(file, "console.log('acp-stdout'); console.error('acp-stderr');");
    const child = spawnEngine({ id: 'probe', name: 'probe', command: 'node', args: [`"${file}"`] }, { cwd: dir, detached: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code).toBe(0);
    expect(stdout).toContain('acp-stdout');
    expect(stderr).toContain('acp-stderr');
  });

  it.runIf(process.env.FORSION_TEST_GUI === '1')('hiding the console still allows an explicitly opened GUI window', async () => {
    const file = path.join(dir, 'gui.ps1');
    await fs.writeFile(file, [
      'Add-Type -AssemblyName System.Windows.Forms',
      `Add-Type -Namespace Probe -Name Gui -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);'`,
      '$form = New-Object System.Windows.Forms.Form',
      '$form.Text = "Forsion GUI regression probe"',
      'try {',
      '  $form.Show()',
      '  [System.Windows.Forms.Application]::DoEvents()',
      '  "gui-visible=$([Probe.Gui]::IsWindowVisible($form.Handle))"',
      '} finally { $form.Close(); $form.Dispose() }',
    ].join('\r\n'));
    const result = await run(`powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "${file}"`);
    expect(result).toContain('gui-visible=True');
    expect(result).toContain('exit_code: 0');
  }, 15_000);
});
