/** 回收站核心:挪进 / 恢复(原名被占落到 -2,目录名带点不拆扩展名)/ 中途失败可重试 / 30 天到期清理(含没写完 meta 的目录)。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moveToTrash, listTrash, restoreTrashItems, purgeExpiredTrash, trashDir, TRASH_DAYS } from './trash.js';

let home: string;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'tangu-trash-')); process.env.TANGU_HOME = home; });
afterEach(() => { delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true }); });
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
});
