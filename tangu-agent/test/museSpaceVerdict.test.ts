/**
 * scripts/muse-space-verdict.mjs 的判定口径(live 台架 muse 场景与实机排查共用这件仪器)。
 * 起因 09-27:实机 Muse 每一版 main.js 都包成 function setup(ctx){…} 不调用 —— 零注册零报错,Space 空白 16 天。
 * 仪器坏了照样「绿」,所以把最要紧的几种形态钉住:包裹式判红、顶层注册判绿、门禁判红、宽限内的异步注册判绿、
 * 没人接的 async 报错不许打死进程。跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/museSpaceVerdict.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/muse-space-verdict.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'muse-space-verdict-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function verdict(name: string, main: string | null, manifest: object | null = {}): { built: boolean; ok: boolean; text: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (main !== null) writeFileSync(join(dir, 'main.js'), main);
  const out = execFileSync(process.execPath, [SCRIPT, dir, '2.11.4'], { encoding: 'utf8', timeout: 20_000 });
  return JSON.parse(out.trim().split('\n').pop()!);
}

// 判红的形态都要等满 3 秒宽限、每条还起一个子进程:缺省 5s 超时在负载高时会假红
describe('muse-space-verdict', { timeout: 30_000 }, () => {
  it('包成 function setup(ctx){…} 却不调用 → 判红(09-27 实机形态)', () => {
    expect(verdict('wrapped', "function setup(ctx) {\n  ctx.registerView({ id: 'home', mount() {} })\n}\n")).toMatchObject({ built: true, ok: false });
  });
  it('顶层 registerView(home)→ 判绿;顶层碰 DOM 也不算错', () => {
    expect(verdict('bare', "const s = document.createElement('style')\ndocument.head.appendChild(s)\nctx.registerView({ id: 'home', mount() {} })\n").ok).toBe(true);
  });
  it('目录空 → 未建(不是错)', () => {
    expect(verdict('none', null, null)).toMatchObject({ built: false, ok: true });
  });
  it('manifest 门禁与宿主同口径:minAppVersion 四段比较', () => {
    const v = verdict('minapp', "ctx.registerView({ id: 'home', mount() {} })", { minAppVersion: '2.11.4.1' });
    expect(v.ok).toBe(false);
    expect(v.text).toContain('minAppVersion');
  });
  it('3 秒宽限内的异步注册判绿,超出判红', () => {
    expect(verdict('timer', "setTimeout(() => ctx.registerView({ id: 'home', mount() {} }), 100)").ok).toBe(true);
    expect(verdict('late', "setTimeout(() => ctx.registerView({ id: 'home', mount() {} }), 5000)").ok).toBe(false);
  });
  it('没人接的 async 报错不打死判定进程,照实报出来', () => {
    const v = verdict('reject', "(async () => { await 0; throw new Error('late boom') })()");
    expect(v.ok).toBe(false);
    expect(v.text).toContain('late boom');
  });
  it('home 缺 mount → 判红(宿主会渲染「视图加载失败」)', () => {
    expect(verdict('nomount', "ctx.registerView({ id: 'home', title: 'x' })")).toMatchObject({ ok: false });
  });
  it('顶层声明与浏览器全局同名的变量是合法写法(注入不许撞形参)', () => {
    expect(verdict('shadow', "const fetch = 1\nconst self = this\nconst t = 'Muse ' + ctx.getLocale()\nctx.registerView({ id: 'home', title: t, mount() {} })").ok).toBe(true);
  });
  it('this 与宿主同形:strict 是 undefined、sloppy 是全局(=window)', () => {
    expect(verdict('strictthis', '"use strict"; const root = this || window; if (root.document) ctx.registerView({ id: "home", mount() {} })').ok).toBe(true);
    expect(verdict('sloppythis', 'if (this.document && window === self) ctx.registerView({ id: "home", mount() {} })').ok).toBe(true);
  });
  it('特性探测不存在的 ctx 成员不会被编成真的', () => {
    expect(verdict('featdet', "if (ctx.system || ctx.noSuchThing) ctx.registerView({ id: 'home', mount() {} })").ok).toBe(false);
    expect(verdict('featreal', "if (ctx.registerCommand) ctx.registerView({ id: 'home', mount() {} })").ok).toBe(true); // 真有的照常
  });
});
