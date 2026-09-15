/** list_files 的错误语义:只有「目录不存在」才是空目录;云端连不上 / 本地 ENOTDIR 必须上抛。
 *  2026-09-11 真模型 live 台架实报:未登录 Forsion 时 sandbox 模式的 list_files 把 fetch failed 吞成「(empty directory)」,
 *  模型据此答「无法读取」,与同一轮 read_file 的报错自相矛盾。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles, listFilesLocal } from '../src/tools/fileWorkspace.js';

const storage = vi.hoisted(() => ({ listDirectory: vi.fn(), getFileContent: vi.fn() }));
vi.mock('../src/seams/runtime.js', () => ({ deps: () => ({ brain: { storage } }) }));
afterEach(() => vi.clearAllMocks());

describe('list_files 错误语义', () => {
  it('云端目录链缺段 → 空目录(工作区尚未创建)', async () => {
    storage.listDirectory.mockResolvedValueOnce([]); // ROOT 下还没有 workspace/
    await expect(listFiles('u', 'a', { sessionId: 's' }, '/')).resolves.toBe('(empty directory)');
  });
  it('云端连不上 → 上抛,不伪装成空目录(负对照)', async () => {
    storage.listDirectory.mockRejectedValueOnce(new Error('云端 /api/brain/storage/list 连接失败(fetch failed)'));
    await expect(listFiles('u', 'a', { sessionId: 's' }, '/')).rejects.toThrow(/fetch failed/);
  });
  it('本地:不存在 → 空;路径是文件(ENOTDIR)→ 上抛', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-list-'));
    try {
      await expect(listFilesLocal(dir, 'missing')).resolves.toBe('(empty directory)');
      writeFileSync(join(dir, 'f.txt'), 'x');
      await expect(listFilesLocal(dir, 'f.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
