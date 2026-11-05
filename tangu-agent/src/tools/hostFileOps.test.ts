import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST_FILE_OP_TOOLS, openPathKnownSafe, trashRoot } from './hostFileOps.js';
import type { ToolContext } from './toolTypes.js';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tangu-fileops-')));
const shared = path.join(root, 'forsion');
const ws = path.join(root, 'ws');
const prevHome = process.env.TANGU_HOME;
const ctx = { cwd: ws, execMode: 'host' } as ToolContext;
const call = (name: string, args: Record<string, unknown>) => Promise.resolve(HOST_FILE_OP_TOOLS[name].execute(args, ctx)).then(String);
const put = (rel: string, text = rel) => { const p = path.join(ws, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); return p; };

beforeAll(() => {
  mkdirSync(path.join(shared, 'tangu'), { recursive: true });
  mkdirSync(ws, { recursive: true });
  process.env.TANGU_HOME = path.join(shared, 'tangu'); // credentials and trash live under this Forsion home
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
});

describe('move_path', () => {
  it('renames, moves into an existing folder, and refuses to clobber or merge', async () => {
    put('a.txt', 'A');
    expect(await call('move_path', { from: 'a.txt', to: 'b.txt' })).toBe('Moved a.txt → b.txt.');
    mkdirSync(path.join(ws, 'box'));
    expect(await call('move_path', { from: 'b.txt', to: 'box' })).toBe(`Moved b.txt → ${path.join('box', 'b.txt')}.`);
    expect(readFileSync(path.join(ws, 'box', 'b.txt'), 'utf8')).toBe('A');
    put('c.txt', 'C');
    expect(await call('move_path', { from: 'c.txt', to: 'box/b.txt' })).toMatch(/already exists\. Pass overwrite/);
    expect(await call('move_path', { from: 'c.txt', to: 'box/b.txt', overwrite: true })).toMatch(/^Moved/);
    expect(readFileSync(path.join(ws, 'box', 'b.txt'), 'utf8')).toBe('C');
    put('d/box/x.txt');
    expect(await call('move_path', { from: 'd/box', to: '.' })).toMatch(/already exists and is a folder/);
    expect(await call('move_path', { from: 'box', to: 'box/inner' })).toMatch(/into itself/);
  });

  it('never moves the home folder or a folder holding credentials, and stays out of protected paths', async () => {
    expect(await call('move_path', { from: os.homedir(), to: 'h' })).toMatch(/home folder/);
    writeFileSync(path.join(shared, 'auth.json'), '{}');
    expect(await call('move_path', { from: shared, to: 'stolen' })).toMatch(/credential/);
    expect(await call('copy_path', { from: path.join(shared, 'auth.json'), to: 'x.json' })).toMatch(/credential/);
  });
});

describe('copy_path', () => {
  it('copies files and folders, skipping credential files reached through a symlink', async () => {
    put('src/one.md', '1');
    put('src/sub/two.md', '2');
    symlinkSync(path.join(shared, 'auth.json'), path.join(ws, 'src', 'innocent.md'));
    const r = await call('copy_path', { from: 'src', to: 'dst' });
    expect(r).toMatch(/^Copied src → dst \(folder\); skipped 1 protected credential file/);
    expect(readFileSync(path.join(ws, 'dst', 'sub', 'two.md'), 'utf8')).toBe('2');
    expect(existsSync(path.join(ws, 'dst', 'innocent.md'))).toBe(false);
    expect(await call('copy_path', { from: 'src/one.md', to: 'dst/one.md' })).toMatch(/already exists/);
    expect(await call('copy_path', { from: 'src', to: 'src/inside' })).toMatch(/into itself/);
  });
});

describe('delete_path', () => {
  it('moves to Forsion’s trash by default and says where; permanent only when asked', async () => {
    put('old/notes.md', 'keep me');
    const r = await call('delete_path', { path: 'old' });
    const slot = /trash: (.+) \(kept 30 days\)/.exec(r)?.[1] || '';
    expect(slot.startsWith(trashRoot())).toBe(true);
    expect(readFileSync(path.join(slot, 'notes.md'), 'utf8')).toBe('keep me');
    expect(existsSync(path.join(ws, 'old'))).toBe(false);
    put('tmp.log');
    expect(await call('delete_path', { path: 'tmp.log', permanent: true })).toBe('Permanently deleted file tmp.log.');
    expect(existsSync(path.join(ws, 'tmp.log'))).toBe(false);
  });

  it('refuses roots, home, credentials and the trash itself', async () => {
    expect(await call('delete_path', { path: path.parse(ws).root })).toMatch(/filesystem root/);
    expect(await call('delete_path', { path: os.homedir() })).toMatch(/home folder/);
    expect(await call('delete_path', { path: path.join(shared, 'auth.json') })).toMatch(/credential/);
    expect(await call('delete_path', { path: 'missing.txt' })).toMatch(/does not exist/);
  });
});

describe('open_path approval', () => {
  it('plain documents and ordinary folders open without asking; apps, scripts and disguised links ask', () => {
    put('report.pdf');
    put('run.sh');
    mkdirSync(path.join(ws, 'Tool.app'), { recursive: true });
    symlinkSync(path.join(ws, 'run.sh'), path.join(ws, 'looks.pdf'));
    expect(openPathKnownSafe('report.pdf', ws)).toBe(true);
    expect(openPathKnownSafe('box', ws)).toBe(true);
    expect(openPathKnownSafe('run.sh', ws)).toBe(false);
    expect(openPathKnownSafe('Tool.app', ws)).toBe(false);
    expect(openPathKnownSafe('looks.pdf', ws)).toBe(false);
    expect(openPathKnownSafe('nothing.pdf', ws)).toBe(false);
  });
});
