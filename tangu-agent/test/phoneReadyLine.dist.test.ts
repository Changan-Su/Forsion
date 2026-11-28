/**
 * The built engine started the way the Android app's install self-test starts it (LocalEngine.selfTest): phone mode,
 * --port 0, a throwaway data directory, TANGU_READY_LINE=1. The port must come from the machine-readable ready line,
 * printed before any human-readable line; /health answers; an authed call passes only with this start's local token.
 *
 * Runs against dist/ (npm run build first); skipped when there is none, like the other dist checks.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { parseReadyLine } from '../src/standalone/readyLine.js';

const MAIN = fileURLToPath(new URL('../dist/standalone/main.js', import.meta.url));
const TOKEN = 'phone-ready-line-local-token-0123456789abcdef';

function rawStatus(port: number, path: string, bearer: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => {
      s.write(`GET ${path} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n${bearer === null ? '' : `Authorization: Bearer ${bearer}\r\n`}Connection: close\r\n\r\n`);
    });
    let head = '';
    s.setTimeout(10_000, () => { s.destroy(); reject(new Error('raw request timed out')); });
    s.on('data', (b) => {
      head += String(b);
      if (head.length >= 12) { s.destroy(); resolve(head.startsWith('HTTP/1.') ? Number(head.slice(9, 12)) : -1); }
    });
    s.on('error', reject);
  });
}

describe.skipIf(!existsSync(MAIN))('phone-mode engine start (dist)', () => {
  it('reports its port on the ready line first, then serves /health and token-gated routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tangu-ready-line-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    for (const d of [home, workspace]) mkdirSync(d, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, // Windows: node needs it for its own DLLs / crypto
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      TANGU_HOME: home,
      TANGU_LOCAL_TOKEN: TOKEN,
      TANGU_SANDBOX: 'none',
      TANGU_PHONE: '1',
      TANGU_BROWSER_EXTENSION: '0',
      TANGU_TOKEN_FILE: join(root, 'no-cloud-token'),
      NODE_ENV: 'production',
      TANGU_READY_LINE: '1',
    };
    const child = spawn(process.execPath, [MAIN, '--port', '0', '--host', '127.0.0.1'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += String(b); });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ready line in 60 s; stdout=${lines.join(' | ')} stderr=${stderr}`)), 60_000);
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`engine exited ${code}; stdout=${lines.join(' | ')} stderr=${stderr}`)); });
        createInterface({ input: child.stdout }).on('line', (line) => {
          lines.push(line);
          const p = parseReadyLine(line);
          if (p > 0) { clearTimeout(timer); resolve(p); }
        });
      });
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, mode: 'standalone', phone: true, activeRuns: 0 });

      const authed = await fetch(`http://127.0.0.1:${port}/agent/sessions?limit=1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(authed.status).toBe(200);
      const wrong = await fetch(`http://127.0.0.1:${port}/agent/sessions?limit=1`, { headers: { Authorization: 'Bearer not-this-start' } });
      expect(wrong.status).toBe(401);
      // byte for byte what the native probe sends (LocalEngineProcess.status: raw HTTP/1.0, status line only)
      expect(await rawStatus(port, `/agent/sessions?limit=1`, TOKEN)).toBe(200);
      expect(await rawStatus(port, `/agent/sessions?limit=1`, `x${TOKEN}`)).toBe(401);
      expect(await rawStatus(port, '/health', null)).toBe(200);
    } finally {
      child.kill();
      await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r(null) : child.once('exit', r)));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    // after stdout is done: exactly one ready line, and it came before anything printed for people
    const ready = lines.flatMap((l, i) => (parseReadyLine(l) > 0 ? [i] : []));
    const firstHuman = lines.findIndex((l) => l.startsWith('[tangu]'));
    expect(ready).toHaveLength(1);
    expect(firstHuman).toBeGreaterThan(ready[0]);
  }, 90_000);
});
