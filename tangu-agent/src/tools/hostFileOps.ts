/**
 * Cross-platform file operations for host sessions: move_path, copy_path, delete_path, open_path.
 * The same call works on macOS, Windows and Linux, so the model does not have to write `mv` for one machine and
 * `move` for another (Agent device isolation round 3, U2).
 *
 * Guards, in the same terms as write_file / read_file:
 *  - every path that changes goes through checkWritePath (protected config, identity files, other agents' config,
 *    the human folder, remote runs); the approval gate sees the same paths through writeTargetsOf.
 *  - anything read (the source of a copy or move) goes through checkReadPath, and a folder that contains a
 *    credential file is never copied, moved or deleted as a whole.
 *  - the filesystem root, the home folder and their ancestors are never moved or deleted.
 *  - not offered under the host OS sandbox (hostSandboxPolicy is default-deny); the sandboxed broker has no
 *    recursive copy or trash, and run_bash inside the sandbox covers these there.
 *
 * delete_path is recoverable by default: the item goes to the engine's Trash (services/trash.ts, kind 'file') — the
 * same place deleted agents, skills and plugins go. The user restores it from Settings › Trash; it is cleared after 30 days.
 */
import { execFile } from 'node:child_process';
import { promises as fs, realpathSync, statSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialPaths, credentialReadTarget, pathWithin } from '../sandbox/hostSandboxProtection.js';
import { isHostSandboxRestricted } from '../sandbox/hostSandboxPolicy.js';
import { toolSubprocessEnv } from '../sandbox/credentialEnv.js';
import { moveToTrash, trashDir, TRASH_DAYS } from '../services/trash.js';
import { checkReadPath, checkWritePath } from './fsPolicy.js';
import { fromShellPath } from './hostShell.js';
import { forgetRead } from './readState.js';
import { withWriteLock } from './writeLock.js';
import type { ToolContext, ToolImpl } from './toolTypes.js';

function abs(ctx: ToolContext, p: unknown): string {
  return path.resolve(ctx.cwd || process.cwd(), fromShellPath(String(p ?? '')));
}

function shown(ctx: ToolContext, p: string): string {
  const rel = path.relative(ctx.cwd || process.cwd(), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Root of a drive / filesystem, the home folder, or anything above home. */
function tooBroad(p: string): boolean {
  const r = path.resolve(p);
  if (path.parse(r).root === r) return true;
  const home = path.resolve(os.homedir());
  return [r, real(r)].some((x) => pathWithin(home, x));
}

/** A folder (literally or through symlinks) that holds a credential file. */
function holdsCredentials(p: string): boolean {
  const candidates = [path.resolve(p), real(p)];
  return credentialPaths().some((c) => candidates.some((x) => pathWithin(c, x)));
}

async function statOrNull(p: string): Promise<Stats | null> {
  try { return await fs.lstat(p); } catch { return null; }
}

function guardWrite(ctx: ToolContext, p: string): string | null {
  const v = checkWritePath(ctx, p);
  return v.hardDeny ? v.reason : null;
}

/** Move one path, also across volumes (rename fails with EXDEV there: copy, then remove the original). */
async function movePath(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.rm(from, { recursive: true, force: false });
  }
}

/** `to` an existing folder → put `from` inside it, as mv / cp do. Exception: `to` is `from` itself under another
 *  spelling (a case-only rename on macOS / Windows) → a plain rename. */
async function destinationFor(from: string, to: string): Promise<string> {
  const st = await statOrNull(to);
  if (st?.isDirectory() && real(to) !== real(from)) return path.join(to, path.basename(from));
  return to;
}

const pathParam = (what: string) => ({ type: 'string', description: `${what} (relative to the current working directory, or absolute)` });

function refusedUnderSandbox(ctx: ToolContext): string | null {
  return isHostSandboxRestricted(ctx) ? 'Error: not available while the OS sandbox is on; use run_bash inside the sandbox instead.' : null;
}

/** ToolImpl plus the on-demand fields of ToolDef (open_path is rare: one catalog line until load_tools). */
type FileOpTool = ToolImpl & { deferred?: boolean; deferHint?: string };

export const HOST_FILE_OP_TOOLS: Record<string, FileOpTool> = {
  move_path: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'move_path',
        description: 'Move or rename a file or folder on the machine; works the same on macOS, Windows and Linux (use it instead of mv / move). ' +
          'If `to` is an existing folder, the item goes inside it. Refuses to replace an existing file unless overwrite is true, and never merges folders.',
        parameters: {
          type: 'object',
          properties: { from: pathParam('Path to move'), to: pathParam('New path, or an existing folder to move it into'), overwrite: { type: 'boolean', description: 'Replace an existing file at the destination (default false)' } },
          required: ['from', 'to'],
        },
      },
    },
    capabilities: { sideEffect: 'write' },
    execute: (args, ctx): Promise<string> => withWriteLock(async () => {
      const no = refusedUnderSandbox(ctx); if (no) return no;
      const from = abs(ctx, args.from);
      if (!args.from || !args.to) return 'Error: from and to are required';
      const st = await statOrNull(from);
      if (!st) return `Error: ${shown(ctx, from)} does not exist`;
      const to = await destinationFor(from, abs(ctx, args.to));
      if (path.resolve(from) === path.resolve(to)) return `Nothing to do: ${shown(ctx, from)} is already there.`;
      const caseRename = real(to) === real(from); // macOS / Windows: notes.md → Notes.md is the same file
      if (!caseRename && pathWithin(to, from)) return 'Error: cannot move a folder into itself';
      const read = checkReadPath(from);
      if (!read.ok) return `Error: ${read.reason}`;
      if (tooBroad(from)) return `Error: refusing to move ${from} (a filesystem root or your home folder).`;
      if (st.isDirectory() && holdsCredentials(from)) return `Error: ${from} contains protected credential files and cannot be moved.`;
      for (const p of [from, to]) { const why = guardWrite(ctx, p); if (why) return `Error: ${why}`; }
      const existing = caseRename ? null : await statOrNull(to);
      if (existing?.isDirectory()) return `Error: ${shown(ctx, to)} already exists and is a folder; folders are never merged. Pick another name.`;
      if (existing && args.overwrite !== true) return `Error: ${shown(ctx, to)} already exists. Pass overwrite: true to replace it, or pick another name.`;
      try {
        if (existing) await fs.rm(to, { force: true });
        await movePath(from, to);
      } catch (e: any) {
        return `Error: ${e?.message || e}`;
      }
      forgetRead(ctx, from);
      forgetRead(ctx, to);
      return `Moved ${shown(ctx, from)} → ${shown(ctx, to)}${st.isDirectory() ? ' (folder)' : ''}.`;
    }),
  },

  copy_path: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'copy_path',
        description: 'Copy a file or a whole folder on the machine; works the same on macOS, Windows and Linux (use it instead of cp / copy / xcopy). ' +
          'If `to` is an existing folder, the copy goes inside it. Refuses to replace existing files unless overwrite is true.',
        parameters: {
          type: 'object',
          properties: { from: pathParam('File or folder to copy'), to: pathParam('Path of the copy, or an existing folder to copy it into'), overwrite: { type: 'boolean', description: 'Replace existing files at the destination (default false)' } },
          required: ['from', 'to'],
        },
      },
    },
    capabilities: { sideEffect: 'write' },
    execute: (args, ctx): Promise<string> => withWriteLock(async () => {
      const no = refusedUnderSandbox(ctx); if (no) return no;
      if (!args.from || !args.to) return 'Error: from and to are required';
      const from = abs(ctx, args.from);
      const st = await statOrNull(from);
      if (!st) return `Error: ${shown(ctx, from)} does not exist`;
      const to = await destinationFor(from, abs(ctx, args.to));
      if (path.resolve(from) === path.resolve(to)) return 'Error: source and destination are the same path';
      if (pathWithin(to, from)) return 'Error: cannot copy a folder into itself';
      const read = checkReadPath(from);
      if (!read.ok) return `Error: ${read.reason}`;
      if (st.isDirectory() && holdsCredentials(from)) return `Error: ${from} contains protected credential files and cannot be copied.`;
      const why = guardWrite(ctx, to); if (why) return `Error: ${why}`;
      const existing = await statOrNull(to);
      if (existing && args.overwrite !== true) return `Error: ${shown(ctx, to)} already exists. Pass overwrite: true to replace it, or pick another name.`;
      let skipped = 0;
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.cp(from, to, {
          recursive: true,
          force: args.overwrite === true,
          errorOnExist: args.overwrite !== true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
          // A symlink inside the folder can point at a credential file; never copy one, whatever its name here.
          filter: (src) => { const hit = !!credentialReadTarget(src); if (hit) skipped++; return !hit; },
        });
      } catch (e: any) {
        return `Error: ${e?.message || e}`;
      }
      forgetRead(ctx, to);
      return `Copied ${shown(ctx, from)} → ${shown(ctx, to)}${st.isDirectory() ? ' (folder)' : ''}${skipped ? `; skipped ${skipped} protected credential file(s)` : ''}.`;
    }),
  },

  delete_path: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'delete_path',
        description: 'Delete a file or folder on the machine; works the same on macOS, Windows and Linux (use it instead of rm / del / rmdir). ' +
          'Recoverable by default: the item goes to the Forsion Trash, where the user can restore it (Settings › Trash) for 30 days. ' +
          'Pass permanent: true only when the user asked for permanent deletion. Never deletes a filesystem root or the home folder.',
        parameters: {
          type: 'object',
          properties: { path: pathParam('File or folder to delete'), permanent: { type: 'boolean', description: 'Delete for good instead of moving to the trash (default false)' } },
          required: ['path'],
        },
      },
    },
    capabilities: { sideEffect: 'write' },
    execute: (args, ctx): Promise<string> => withWriteLock(async () => {
      const no = refusedUnderSandbox(ctx); if (no) return no;
      if (!args.path) return 'Error: path is required';
      const target = abs(ctx, args.path);
      const st = await statOrNull(target);
      if (!st) return `Error: ${shown(ctx, target)} does not exist`;
      if (tooBroad(target)) return `Error: refusing to delete ${target} (a filesystem root or your home folder).`;
      if (credentialReadTarget(target) || (st.isDirectory() && holdsCredentials(target))) return `Error: ${target} is or contains protected credential files and cannot be deleted.`;
      if (pathWithin(trashDir(), target)) return `Error: refusing to delete ${target}: it contains the Forsion Trash.`;
      const why = guardWrite(ctx, target); if (why) return `Error: ${why}`;
      const kind = st.isDirectory() ? 'folder' : 'file';
      try {
        if (args.permanent === true) {
          await fs.rm(target, { recursive: true, force: false });
          forgetRead(ctx, target);
          return `Permanently deleted ${kind} ${shown(ctx, target)}.`;
        }
        const entry = await moveToTrash({ kind: 'file', ref: path.basename(target), name: path.basename(target), paths: [{ path: target }] });
        if (!entry) return `Error: ${shown(ctx, target)} could not be moved to the Trash`;
        forgetRead(ctx, target);
        return `Moved ${kind} ${shown(ctx, target)} to the Forsion Trash. The user can restore it from Settings › Trash for ${TRASH_DAYS} days.`;
      } catch (e: any) {
        return `Error: ${e?.message || e}`;
      }
    }),
  },

  open_path: {
    mode: 'host',
    deferred: true,
    deferHint: 'Open a file in its default app or a folder in Finder / File Explorer on the user\'s screen (any OS).',
    definition: {
      type: 'function',
      function: {
        name: 'open_path',
        description: 'Open a file in its default app, or a folder in Finder / File Explorer, on the user\'s screen; works the same on macOS, Windows and Linux (use it instead of open / start / xdg-open). ' +
          'Documents, images, media and folders open directly; anything that could launch a program (apps, scripts, installers, shortcuts) asks the user first.',
        parameters: { type: 'object', properties: { path: pathParam('File or folder to open') }, required: ['path'] },
      },
    },
    capabilities: { sideEffect: 'system' },
    execute: async (args, ctx): Promise<string> => {
      const no = refusedUnderSandbox(ctx); if (no) return no;
      if (!args.path) return 'Error: path is required';
      const target = abs(ctx, args.path);
      if (!(await statOrNull(target))) return `Error: ${shown(ctx, target)} does not exist`;
      const read = checkReadPath(target);
      if (!read.ok) return `Error: ${read.reason}`;
      const r = await openWithDefaultApp(target);
      return r.ok ? `Opened ${shown(ctx, target)} on the user's screen.` : `Error: could not open ${shown(ctx, target)}: ${r.error}`;
    },
  },
};

/** Hand a path to the OS's default handler as an argument (never through a shell string). */
function openWithDefaultApp(target: string): Promise<{ ok: boolean; error?: string }> {
  let file: string;
  let argv: string[];
  const env = toolSubprocessEnv();
  if (process.platform === 'darwin') { file = '/usr/bin/open'; argv = [target]; }
  else if (process.platform === 'win32') {
    // Invoke-Item = the shell's default "open" verb. The path rides in an env var: no quoting, commas or `&` issues.
    file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    argv = ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:TANGU_OPEN_PATH'];
    env.TANGU_OPEN_PATH = target;
  } else { file = 'xdg-open'; argv = [target]; }
  return new Promise((resolve) => {
    execFile(file, argv, { env, timeout: 20_000, windowsHide: true }, (err, _out, stderr) => {
      if (!err) resolve({ ok: true });
      else resolve({ ok: false, error: String(stderr || err.message || err).trim().slice(0, 400) });
    });
  });
}

// ── open_path approval: a plain document or folder opens without asking; anything that can run code asks. ──

const SAFE_OPEN_EXT = new Set([
  '.pdf', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.rtf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp', '.tif', '.tiff', '.svg',
  '.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.pages', '.numbers', '.key', '.epub', '.html', '.htm',
]);
/** macOS folders that the OS runs or installs instead of showing. */
const BUNDLE_EXT = /\.(app|appex|bundle|framework|plugin|prefpane|workflow|action|service|kext|xpc|qlgenerator|saver|mdimporter|wdgt|scptd|pkg|mpkg|component|vst3?|definition|osax|systemextension)$/i;

/** open_path may skip approval: the target exists, and both its literal and its resolved name are a plain
 *  document type, or both are an ordinary folder. Read failures → not safe (ask). */
export function openPathKnownSafe(rawPath: string, cwd: string): boolean {
  try {
    const literal = path.resolve(cwd || process.cwd(), fromShellPath(String(rawPath || '')));
    const resolved = realpathSync(literal);
    const st = statSync(resolved);
    if (credentialReadTarget(literal)) return false;
    if (st.isDirectory()) return ![literal, resolved].some((p) => BUNDLE_EXT.test(p.replace(/[\\/]+$/, '')));
    if (!st.isFile()) return false;
    return [literal, resolved].every((p) => SAFE_OPEN_EXT.has(path.extname(p).toLowerCase()));
  } catch {
    return false;
  }
}
