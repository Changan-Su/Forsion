/** Fixed-operation filesystem helper, run under the same OS policy as shell commands. */
import { promises as fs } from 'node:fs';
import type { ToolContext } from '../tools/toolTypes.js';
import { hostSandboxEnabled, spawnHostCommand } from './hostSandbox.js';

// This program is trusted static code. Paths and content arrive as JSON on stdin, never as code.
const HELPER = String.raw`
import { promises as fs } from 'node:fs';
import path from 'node:path';
let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 100 * 1024 * 1024) throw new Error('File request exceeds 100 MiB'); }
try {
  const { op, args } = JSON.parse(input);
  let result;
  if (op === 'readFile') {
    const data = await fs.readFile(args[0]);
    result = { buffer: data.toString('base64') };
  } else if (op === 'writeFile') {
    await fs.writeFile(args[0], Buffer.from(args[1], 'base64'));
  } else if (op === 'readdir') {
    result = [];
    for (const e of await fs.readdir(args[0], { withFileTypes: true })) {
      let sandboxSize = 0;
      if (!e.isDirectory()) { try { sandboxSize = (await fs.stat(path.join(args[0], e.name))).size; } catch {} }
      result.push({ name: e.name, directory: e.isDirectory(), file: e.isFile(), symlink: e.isSymbolicLink(), sandboxSize });
    }
  } else if (op === 'stat' || op === 'lstat') {
    const s = await fs[op](args[0]);
    result = { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, mode: s.mode, directory: s.isDirectory(), file: s.isFile(), symlink: s.isSymbolicLink() };
  } else if (op === 'mkdir') { result = await fs.mkdir(args[0], args[1]);
  } else if (op === 'unlink') { await fs.unlink(args[0]);
  } else if (op === 'rename') { await fs.rename(args[0], args[1]);
  } else if (op === 'copyFile') { await fs.copyFile(args[0], args[1]);
  } else if (op === 'parseDocument') {
    const { LiteParse } = await import(args[1]);
    const parser = new LiteParse(args[2]);
    result = await parser.parse(args[0]);
  } else { throw new Error('Unsupported filesystem operation'); }
  process.stdout.write(JSON.stringify({ result }));
} catch (e) { process.stdout.write(JSON.stringify({ error: String(e?.message || e) })); process.exitCode = 1; }
`;

export async function runHostFileOperation(ctx: ToolContext, op: string, args: unknown[], timeoutMs = 30_000): Promise<any> {
  if (ctx.signal?.aborted) throw new Error('Host sandbox file operation aborted');
  const child = spawnHostCommand(ctx, [process.execPath, '--input-type=module', '-e', HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    let stderr = '';
    let settled = false;
    let failure: Error | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      ctx.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const stop = (reason: string): void => {
      failure = new Error(reason);
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
      grace ??= setTimeout(() => finish(failure), 1500);
    };
    const abort = (): void => stop('Host sandbox file operation aborted');
    const timer = setTimeout(() => stop('Host sandbox file operation timed out'), timeoutMs);
    ctx.signal?.addEventListener('abort', abort, { once: true });
    if (ctx.signal?.aborted) abort();
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 140 * 1024 * 1024) stop('Host sandbox file response exceeds limit');
    });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString(); });
    child.once('error', (e) => finish(e));
    child.once('close', (code) => {
      if (failure) return finish(failure);
      try {
        const parsed = JSON.parse(output);
        if (parsed.error || code !== 0) finish(new Error(`Host sandbox file operation failed: ${parsed.error || stderr || code}`));
        else finish(undefined, parsed.result);
      } catch { finish(new Error(`Host sandbox file operation failed: ${stderr.trim() || `helper exited ${code}`}`)); }
    });
    child.stdin?.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') finish(e); });
    child.stdin?.end(JSON.stringify({ op, args }));
  });
}

const fsMethods = ['readFile', 'writeFile', 'mkdir', 'readdir', 'stat', 'lstat', 'unlink', 'rename', 'copyFile'] as const;
type HostFs = Pick<typeof fs, typeof fsMethods[number]>;
/** Restricted requests run in a helper process; off preserves existing Node filesystem semantics. */
export function hostSandboxFs(ctx: ToolContext): HostFs {
  if (!hostSandboxEnabled(ctx)) return fs;
  const decorate = (entry: any): any => ({ ...entry, isDirectory: () => entry.directory, isFile: () => entry.file, isSymbolicLink: () => entry.symlink });
  return {
    readFile: async (p: string, encoding?: BufferEncoding | { encoding?: BufferEncoding }): Promise<Buffer | string> => {
      const result = await runHostFileOperation(ctx, 'readFile', [String(p)]);
      const bytes = Buffer.from(result.buffer, 'base64');
      const enc = typeof encoding === 'string' ? encoding : encoding?.encoding;
      return enc ? bytes.toString(enc) : bytes;
    },
    writeFile: async (p: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> => {
      const buffer = typeof data === 'string' ? Buffer.from(data, encoding || 'utf8') : Buffer.from(data);
      await runHostFileOperation(ctx, 'writeFile', [String(p), buffer.toString('base64')]);
    },
    readdir: async (p: string, options?: { withFileTypes?: boolean }): Promise<any[]> => {
      const entries = await runHostFileOperation(ctx, 'readdir', [String(p)]);
      return options?.withFileTypes ? entries.map(decorate) : entries.map((e: any) => e.name);
    },
    stat: async (p: string): Promise<any> => decorate(await runHostFileOperation(ctx, 'stat', [String(p)])),
    lstat: async (p: string): Promise<any> => decorate(await runHostFileOperation(ctx, 'lstat', [String(p)])),
    mkdir: async (p: string, options?: object): Promise<any> => runHostFileOperation(ctx, 'mkdir', [String(p), options]),
    unlink: async (p: string): Promise<void> => { await runHostFileOperation(ctx, 'unlink', [String(p)]); },
    rename: async (from: string, to: string): Promise<void> => { await runHostFileOperation(ctx, 'rename', [String(from), String(to)]); },
    copyFile: async (from: string, to: string): Promise<void> => { await runHostFileOperation(ctx, 'copyFile', [String(from), String(to)]); },
  } as HostFs;
}
export async function parseHostDocument(ctx: ToolContext, file: string, options: Record<string, unknown>): Promise<any> {
  return runHostFileOperation(ctx, 'parseDocument', [file, import.meta.resolve('@llamaindex/liteparse'), options], 120_000);
}
