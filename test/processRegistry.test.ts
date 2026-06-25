import { describe, it, expect, afterEach } from 'vitest';
import {
  startBackgroundProcess, writeStdin, waitForOutput, getProcess, disposeAllProcesses,
  type BackgroundProcess,
} from '../src/tools/processRegistry.js';

const SID = 'test-session';
const CWD = process.cwd();

afterEach(() => disposeAllProcesses());

function startOk(cmd: string): BackgroundProcess {
  const r = startBackgroundProcess(SID, cmd, CWD);
  if (typeof r === 'string') throw new Error(`start failed: ${r}`);
  return r;
}

describe('writeStdin + waitForOutput (interactive shell)', () => {
  it('drives a line-oriented process: write to stdin, see echoed output', async () => {
    const p = startOk('cat'); // echoes stdin → stdout
    const from = p.output.length;
    expect(writeStdin(SID, p.id, 'hello', true)).toMatch(/wrote/);
    const { output, status } = await waitForOutput(p, from, { idleMs: 200, capMs: 4000 });
    expect(output).toContain('hello');
    expect(status).toBe('running'); // cat still alive, waiting for more input
  });

  it('errors when writing to an exited process', async () => {
    const p = startOk('true'); // exits 0 immediately
    await waitForOutput(p, p.output.length, { capMs: 3000 }); // wait until it exits
    expect(getProcess(SID, p.id)?.status).not.toBe('running');
    expect(writeStdin(SID, p.id, 'x', true)).toMatch(/Error.*已结束/);
  });

  it('Ctrl-C (\\x03) sends SIGINT and the process ends', async () => {
    const p = startOk('cat');
    expect(writeStdin(SID, p.id, '\x03', false)).toMatch(/SIGINT/);
    const { status } = await waitForOutput(p, p.output.length, { capMs: 3000 });
    expect(status).not.toBe('running'); // SIGINT terminated cat
  });

  it('errors for an unknown process id', () => {
    expect(writeStdin(SID, 'bg_nope', 'x', true)).toMatch(/不存在/);
  });
});

describe('waitForOutput resolve paths', () => {
  it('resolves on cap timeout when no new output arrives', async () => {
    const p = startOk('cat'); // produces nothing without input
    const t0 = Date.now();
    const { output, status } = await waitForOutput(p, p.output.length, { idleMs: 200, capMs: 300 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(output).toBe('');
    expect(status).toBe('running');
  });

  it('resolves promptly when the abort signal is already aborted', async () => {
    const p = startOk('cat');
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await waitForOutput(p, p.output.length, { idleMs: 5000, capMs: 60_000, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(1000); // didn't wait out cap/idle
  });
});
