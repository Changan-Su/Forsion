/** 回收站核心:挪进 / 恢复(原名被占落到 -2,目录名带点不拆扩展名)/ 中途失败可重试 / 30 天到期清理(含没写完 meta 的目录)。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, symlinkSync, readdirSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moveToTrash, listTrash, readTrash, restoreTrashItems, purgeExpiredTrash, emptyTrash, trashDir, TRASH_DAYS } from './trash.js';

let home: string;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'tangu-trash-')); process.env.TANGU_HOME = home; });
afterEach(() => { vi.restoreAllMocks(); delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true }); });
const put = (rel: string, body = 'x'): string => { const p = path.join(home, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body); return p; };

describe('trash', () => {
  it('moves what exists, skips what does not, and restores to the original place', async () => {
    put('a/my.agent/config.toml', 'cfg');
    const file = put('a/note.json', '{}');
    const e = (await moveToTrash({ kind: 'agent', ref: 'my', name: 'My', paths: [{ path: path.join(home, 'a/my.agent') }, { path: file }, { path: path.join(home, 'gone') }] }))!;
    expect(e.items).toHaveLength(2);
    expect(existsSync(path.join(home, 'a/my.agent'))).toBe(false);
    expect((await listTrash()).map((x) => x.id)).toEqual([e.id]);
    await restoreTrashItems(e);
    expect(readFileSync(path.join(home, 'a/my.agent/config.toml'), 'utf8')).toBe('cfg');
    expect(existsSync(file)).toBe(true);
    expect(await listTrash()).toEqual([]);
    expect(await moveToTrash({ kind: 'skill', ref: 'x', name: 'x', paths: [{ path: path.join(home, 'nothing') }] })).toBeNull();
  });

  it('a taken name lands at name-2 (files keep their extension, dotted folders are not split)', async () => {
    put('a/my.agent/config.toml'); put('a/note.json');
    const e = (await moveToTrash({ kind: 'agent', ref: 'my', name: 'My', paths: [{ path: path.join(home, 'a/my.agent') }, { path: path.join(home, 'a/note.json') }] }))!;
    put('a/my.agent/config.toml', 'new'); put('a/note.json', 'new');
    const placed = await restoreTrashItems(e);
    expect([...placed.values()].map((p) => path.relative(home, p))).toEqual(['a/my.agent-2', 'a/note-2.json']);
  });

  it('a half-finished restore can be retried', async () => {
    put('a/one/f'); put('a/two/f');
    const e = (await moveToTrash({ kind: 'plugin', ref: 'p', name: 'P', paths: [{ path: path.join(home, 'a/one') }, { path: path.join(home, 'a/two') }] }))!;
    rmSync(path.join(trashDir(), e.id, e.items[0].stored), { recursive: true }); // 第一件已经挪回去过
    await restoreTrashItems(e);
    expect(existsSync(path.join(home, 'a/two/f'))).toBe(true);
  });

  it('purges entries older than 30 days and meta-less leftovers, keeps the rest', async () => {
    put('a/old'); put('a/new');
    const old = (await moveToTrash({ kind: 'skill', ref: 'old', name: 'old', paths: [{ path: path.join(home, 'a/old') }] }))!;
    await new Promise((r) => setTimeout(r, 5)); // 同一毫秒建的两条会一起到期
    const fresh = (await moveToTrash({ kind: 'skill', ref: 'new', name: 'new', paths: [{ path: path.join(home, 'a/new') }] }))!;
    const orphan = path.join(trashDir(), 'agent-x-1-deadbeef');
    mkdirSync(path.join(orphan, 'items'), { recursive: true });
    const past = (Date.now() - (TRASH_DAYS + 1) * 864e5) / 1000;
    utimesSync(orphan, past, past);
    const later = old.deletedAt + TRASH_DAYS * 864e5;
    expect(await purgeExpiredTrash(later)).toBe(2);
    expect((await listTrash()).map((x) => x.id)).toEqual([fresh.id]);
    expect(existsSync(orphan)).toBe(false);
  });

  // 挪到一半失败(10-28 Codex 评审 P1):能挪回去就不留条目;挪不回去的那份必须留在回收站里、列得出来、恢复得了
  const failRename = (when: (from: string) => boolean): void => {
    const real = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => { if (when(String(from))) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return real(from, to); });
  };

  it('a failed move puts the earlier items back and leaves no entry', async () => {
    put('a/one/f'); put('a/two/f');
    failRename((from) => from.endsWith(`${path.sep}two`));
    await expect(moveToTrash({ kind: 'plugin', ref: 'p', name: 'P', paths: [{ path: path.join(home, 'a/one') }, { path: path.join(home, 'a/two') }] })).rejects.toThrow('EIO');
    expect(existsSync(path.join(home, 'a/one/f')) && existsSync(path.join(home, 'a/two/f'))).toBe(true);
    expect(readdirSync(trashDir())).toEqual([]);
  });

  it('when the rollback also fails the entry stays listed and restorable', async () => {
    put('a/one/f'); put('a/two/f');
    failRename((from) => from.endsWith(`${path.sep}two`) || from.endsWith(`items${path.sep}0`));
    await expect(moveToTrash({ kind: 'plugin', ref: 'p', name: 'P', paths: [{ path: path.join(home, 'a/one') }, { path: path.join(home, 'a/two') }] })).rejects.toThrow('EIO');
    vi.restoreAllMocks();
    const [e] = await listTrash();
    expect(e?.items.map((i) => path.relative(home, i.from))).toEqual(['a/one', 'a/two']); // 记录先于挪动写好
    await restoreTrashItems(e!);
    expect(existsSync(path.join(home, 'a/one/f'))).toBe(true);
  });

  it('a failing finish keeps the entry; the retry hands finish the earlier landing spot', async () => {
    put('a/x/f', 'old');
    const e = (await moveToTrash({ kind: 'agent', ref: 'x', name: 'X', paths: [{ path: path.join(home, 'a/x'), role: 'dir' }] }))!;
    put('a/x/f', 'new');
    await expect(restoreTrashItems(e, async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    const again = (await readTrash(e.id))!;
    expect(again.items[0].placed).toBe(path.join(home, 'a/x-2'));
    let seen = '';
    await restoreTrashItems(again, async (placed) => { seen = placed.get(path.join(home, 'a/x'))!; });
    expect(seen).toBe(path.join(home, 'a/x-2'));
    expect(await readTrash(e.id)).toBeNull();
  });

  it('a symlinked trash root is never cleaned, listed or emptied', async () => {
    const elsewhere = path.join(home, 'elsewhere');
    mkdirSync(path.join(elsewhere, 'agent-x-1-deadbeef'), { recursive: true });
    mkdirSync(path.join(elsewhere, 'keep'));
    symlinkSync(elsewhere, trashDir());
    expect(await purgeExpiredTrash(Date.now() + 365 * 864e5)).toBe(0);
    expect(await emptyTrash()).toBe(0);
    expect(await listTrash()).toEqual([]);
    expect(readdirSync(elsewhere).sort()).toEqual(['agent-x-1-deadbeef', 'keep']);
  });

  it('restore refuses a parent folder that became a symlink', async () => {
    put('proj/.tangu/skills/s/SKILL.md');
    const e = (await moveToTrash({ kind: 'skill', ref: 'project:s', name: 's', paths: [{ path: path.join(home, 'proj/.tangu/skills/s') }] }))!;
    rmSync(path.join(home, 'proj/.tangu/skills'), { recursive: true });
    mkdirSync(path.join(home, 'outside'));
    symlinkSync(path.join(home, 'outside'), path.join(home, 'proj/.tangu/skills'));
    await expect(restoreTrashItems(e)).rejects.toThrow(/points somewhere else/);
    expect(readdirSync(path.join(home, 'outside'))).toEqual([]);
    expect(await readTrash(e.id)).not.toBeNull();
  });
});
