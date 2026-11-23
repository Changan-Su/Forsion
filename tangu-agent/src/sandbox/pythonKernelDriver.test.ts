import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { pythonKernelDriver } from './pythonKernelDriver.js';

it('captures a script’s native stdout and stderr and preserves the next Python turn', () => {
  const turns = [
    'import subprocess, sys\nvalue = 40\nsubprocess.run([sys.executable, "-c", "import sys; print(42); print(24, file=sys.stderr)"], check=True)',
    'print(value + 3)',
    'print(chr(0) * 3000)',
    'print("finished")',
  ];
  const input = turns.map(code => String(Buffer.byteLength(code)).padStart(10, '0') + code).join('');
  const p = spawnSync('python3', ['-u', '-c', pythonKernelDriver(1024)], { input });
  expect(p.status).toBe(0);
  const frames = [];
  for (let i = 0; i < p.stdout.length;) {
    const n = Number(p.stdout.subarray(i, i + 10).toString());
    expect(n).toBeGreaterThan(0);
    frames.push(JSON.parse(p.stdout.subarray(i + 10, i + 10 + n).toString('utf8')));
    i += n + 10;
  }
  expect(frames[0]).toEqual({ ready: true });
  expect(frames[1]).toEqual({ stdout: '42\n', stderr: '24\n', ok: true });
  expect(frames[2].stdout).toBe('43\n');
  expect(frames[3].ok).toBe(true);
  expect(frames[4].stdout).toBe('finished\n');
});
