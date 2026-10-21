import path from 'node:path';
import { readdirSync } from 'node:fs';
import { canonicalFuturePath, credentialPaths, credentialReadTarget, pathWithin } from '../sandbox/hostSandboxProtection.js';

/** A bounded cmd.exe read shortcut, shared by approval and execution. Unknown syntax needs approval.
 * findstr must use the system executable: cmd otherwise searches the writable cwd before PATH. */
export function prepareReadOnlyCmd(command: string, cwd: string): string | null {
  if (path.win32.basename(process.env.comspec || 'cmd.exe').toLowerCase() !== 'cmd.exe') return null;
  if (!command.trim() || /[%!^\r\n]/.test(command)) return null;
  const parts = splitCmd(command);
  if (!parts) return null;
  let current = cwd;
  let changedDirectory = false;
  for (const part of parts) {
    if (!part.text) return null;
    // Require a literal unquoted command name; fi""ndstr is external lookup and would evade pinning.
    if (!/^(?:dir|type|echo|cd|chdir|findstr(?:\.exe)?)(?= |$)/i.test(part.text)) return null;
    // An earlier && may skip cd. A later & would resume in the old cwd; keep the entire tail conditional.
    if (changedDirectory && part.separator === '&') return null;
    // Only stderr disposal is free. Other redirection may write a file or read stdin.
    let bare = '', inQuote = false;
    for (let i = 0; i < part.text.length; i++) {
      const ch = part.text[i];
      if (ch === '"') inQuote = !inQuote;
      const discard = !inQuote && (i === 0 || part.text[i - 1] === ' ') && /^2\s*>\s*nul(?= |$)/i.exec(part.text.slice(i));
      if (discard) { i += discard[0].length - 1; bare += ' '; } else bare += ch;
    }
    // No pipes, substitutions, alternate separators, controls, short names or other shells' syntax.
    if (!/^[\p{L}\p{N}\p{M} _.\-\\/:"*?\[\]]+$/u.test(bare)) return null;
    const tokens = cmdTokens(bare);
    if (!tokens?.length) return null;
    const [rawProgram, ...args] = tokens;
    const program = rawProgram.toLowerCase();
    // Quoted internal names invoke external lookup rather than the cmd builtin.
    if (bare.trimStart().startsWith('"')) return null;
    if (program === 'echo') {
      // Literal output only; metacharacters and expansion were rejected above.
    } else if (program === 'cd' || program === 'chdir') {
      const target = args[0]?.toLowerCase() === '/d' ? args.slice(1) : args;
      if (target.length > 1 || (target.length && !plainPath(target[0], false))) return null;
      if (target.length) {
        // A failed cd followed by & leaves cwd unchanged. && makes the following read conditional.
        if (part.separator && part.separator !== '&&') return null;
        const next = path.resolve(current, target[0]);
        if (args[0]?.toLowerCase() !== '/d' && path.parse(next).root.toLowerCase() !== path.parse(current).root.toLowerCase()) return null;
        current = next;
        changedDirectory = true;
      }
    } else if (program === 'dir' || program === 'type') {
      if (!args.every((a) => a.startsWith('/')
        ? program === 'dir' && /^\/-?[a-z0-9](?::?-?[a-z]*)$/i.test(a)
        : plainPath(a, program === 'dir') && !credentialReadTarget(path.resolve(current, a)))) return null;
    } else if (program === 'findstr' || program === 'findstr.exe') {
      // External programs parse quotes using CRT rules, unlike cmd builtins. Only whole quoted args and /c:"pattern".
      if (!/^findstr(?:\.exe)?(?: +(?:[^ "]+|"(?:[^"\\]|\\(?!"))*"|\/c:"(?:[^"\\]|\\(?!"))*"))* *$/i.test(bare.trim())) return null;
      if (!systemFindstr() || !safeFindstr(args, current)) return null;
    } else return null;
  }
  return pinSystemFindstr(command);
}

/** Execution pins by syntax alone, even if filesystem state changed since approval classification. */
export function pinSystemFindstr(command: string): string {
  if (path.win32.basename(process.env.comspec || 'cmd.exe').toLowerCase() !== 'cmd.exe') return command;
  // Leave scripts, escapes and other shell grammars exactly as approved by the user.
  if (/[\u0000-\u001f%!^|<()]/.test(command)) return command;
  const executable = systemFindstr();
  const parts = splitCmd(command);
  if (!executable || !parts || !parts.some((p) => /^findstr(?:\.exe)?(?= |$)/i.test(p.text))) return command;
  return parts.map(({ text, separator }) => text.replace(/^findstr(?:\.exe)?(?= |$)/i, `"${executable}"`) +
    (separator ? ` ${separator} ` : '')).join('');
}

function systemFindstr(): string | null {
  const root = process.env.SystemRoot || process.env.windir;
  if (!root || !path.win32.isAbsolute(root) || !plainPath(root, false) || /[^\p{L}\p{N}\p{M} _.\-\\/:]/u.test(root)) return null;
  return path.win32.join(root, 'System32', 'findstr.exe');
}

function splitCmd(command: string): { text: string; separator: string }[] | null {
  const parts: { text: string; separator: string }[] = [];
  let quoted = false, start = 0;
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '"') quoted = !quoted;
    if (command[i] !== '&' || quoted) continue;
    const separator = command[i + 1] === '&' ? '&&' : '&';
    parts.push({ text: command.slice(start, i).trim(), separator });
    i += separator.length - 1;
    start = i + 1;
  }
  if (quoted || parts.length > 31) return null;
  parts.push({ text: command.slice(start).trim(), separator: '' });
  return parts;
}

/** cmd's double quotes group spaces; backslashes are literal. */
function cmdTokens(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '', quoted = false, has = false;
  for (const ch of cmd) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (ch === ' ' && !quoted) { if (has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch; has = true;
  }
  if (quoted) return null;
  if (has) out.push(cur);
  return out;
}

function plainPath(value: string, wildcard: boolean): boolean {
  // UNC/device paths may send credentials; drive-relative and ADS paths have different resolution rules.
  if (!value || value.startsWith('\\') || value.startsWith('/') || value.indexOf(':', 2) >= 0 ||
      (value.includes(':') && !/^[a-z]:[\\/]/i.test(value))) return false;
  if (!wildcard && /[*?]/.test(value)) return false;
  // Win32 removes trailing dots/spaces; reject aliases that could hide a credential target.
  return !value.split(/[\\/]/).some((s) => s !== '.' && s !== '..' && /[. ]$/.test(s));
}

function safeFindstr(args: string[], cwd: string): boolean {
  const flags = new Set(['/i', '/n', '/l', '/r', '/v', '/x', '/m', '/p', '/b', '/e', '/o']);
  let pattern = false, operand = false;
  const files: string[] = [];
  for (const arg of args) {
    if (!operand && arg.startsWith('/')) {
      if (/^\/c:.+/i.test(arg)) { pattern = true; continue; }
      if (!flags.has(arg.toLowerCase())) return false; // /g, /f, /d and recursive /s have additional read roots.
    } else {
      operand = true;
      if (!pattern) pattern = true; else files.push(arg);
    }
  }
  if (!pattern || !files.length) return false; // No implicit stdin reader.
  return files.every((file) => {
    if (!plainPath(file, true)) return false;
    const abs = path.resolve(cwd, file);
    if (credentialReadTarget(abs)) return false;
    if (!/[*?]/.test(file)) return true;
    const root = path.dirname(abs);
    if (/[*?]/.test(root)) return false;
    const real = canonicalFuturePath(root);
    if (credentialReadTarget(root) || credentialPaths().some((c) => pathWithin(c, root) || pathWithin(c, real))) return false;
    // Check all entries, avoiding differences between DOS wildcard matching and a JS approximation.
    // In particular, a symlink inside an otherwise safe folder can point at a credential file.
    try { return readdirSync(root).every((name) => !credentialReadTarget(path.join(root, name))); }
    catch (error: any) { return error?.code === 'ENOENT'; }
  });
}
