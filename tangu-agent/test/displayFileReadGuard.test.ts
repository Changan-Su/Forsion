/**
 * P1-DL · display_file 在 host 会话里 = 把文件交给用户(手机经 unitWeb 的 /unit/hostfile/download 能下载原文件),
 * 所以它和 read_file 过同一道凭据读闸(checkReadPath,契约 C4):凭据文件硬拒、一张卡片都不发;普通文件照常发本机绝对路径。
 * 按 realpath 判 —— 工作区里指向凭据的软链换个 .pdf 名字同样拦。
 *
 * 负对照(实跑为红,见提交说明):去掉 displayTools.ts 的 checkReadPath → 两条拒绝用例红。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { displayFileProvider } from '../src/tools/builtin/displayTools.js';
import type { DisplayFileItem, ToolContext } from '../src/tools/toolTypes.js';

let home: string; // TANGU_HOME(凭据文件所在)
let proj: string; // host 会话 cwd
const tool = displayFileProvider.tools()[0];
async function display(p: string): Promise<{ out: string; events: DisplayFileItem[] }> {
  const events: DisplayFileItem[] = [];
  const ctx = { userId: 'u1', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd: proj, displayFile: (i: DisplayFileItem) => { events.push(i); } } as ToolContext;
  return { out: await tool.execute({ path: p }, ctx), events };
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-dl-home-')));
  process.env.TANGU_HOME = home;
  writeFileSync(join(home, 'auth.json'), '{"token":"SECRET-AUTH"}');
  proj = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-dl-proj-')));
  writeFileSync(join(proj, 'report.pdf'), 'REPORT');
  if (process.platform !== 'win32') symlinkSync(join(home, 'auth.json'), join(proj, 'looks-like-a-report.pdf'));
  configureTangu({ host: {} as any, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  for (const d of [home, proj]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('display_file × 凭据读闸(host 会话)', () => {
  it('凭据文件:硬拒,不发卡片', async () => {
    const { out, events } = await display(join(home, 'auth.json'));
    expect(out).toMatch(/^Error: Access denied/);
    expect(events).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('工作区里指向凭据的软链(改名成 .pdf):按 realpath 同样拒', async () => {
    const { out, events } = await display('looks-like-a-report.pdf');
    expect(out).toMatch(/^Error: Access denied/);
    expect(events).toEqual([]);
  });

  it('普通文件照常:卡片带本机绝对路径', async () => {
    const { out, events } = await display('report.pdf');
    expect(out).not.toMatch(/^Error/);
    expect(events).toEqual([{ name: 'report.pdf', mime: undefined, path: join(proj, 'report.pdf') }]);
  });
});
