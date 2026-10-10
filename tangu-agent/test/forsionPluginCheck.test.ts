/**
 * 随 forsion-plugin 技能分发的「插件体检」脚本(skills/forsion-plugin/tools/check-plugin.mjs):照桌面宿主的方式求值 main.js,
 * 对账随包 Space 要的视图。起因是 2026-10-10 一份用户插件:一个函数没收口,把 registerView 包了进去,求值不报错、零注册,
 * Space 被宿主跳过,真模型六次都没查出来。
 *
 * 这里钉的是结论对不对,和「正常写法不误报」(有条件才注册、等宿主能力的插件在 28 个已装插件上扫出过误报)。
 * 脚本当独立进程跑:它本来就是给 agent 用 `node …` 调的。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../skills/forsion-plugin/tools/check-plugin.mjs', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'forsion-plugin-check-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
/** 造一个插件目录:main.js + 一个要 `view` 视图的 Space(传 space 可改写 Space 内容,null = 不带 Space)。 */
function plugin(main: string, opts: { id?: string; space?: object | string | null; folder?: string } = {}) {
  const id = opts.id ?? 'demo';
  const dir = join(base, `${opts.folder ?? id}-${n++}`);
  mkdirSync(join(dir, 'spaces', 'demo-space'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, name: 'Demo', version: '1.0.0', apiVersion: 1, main: 'main.js' }));
  writeFileSync(join(dir, 'main.js'), main);
  const space = opts.space === undefined
    ? { id: 'demo-space', name: 'Demo', layout: { main: [{ type: `plugin:${id}:desk` }], left: [], right: [] }, requires: { views: [`plugin:${id}:desk`] } }
    : opts.space;
  if (space !== null) writeFileSync(join(dir, 'spaces', 'demo-space', 'space.json'), typeof space === 'string' ? space : JSON.stringify(space));
  return dir;
}
function check(dir: string | null, ...args: string[]) {
  return run(dir ? [dir, ...args] : args);
}
function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000, env });
  return { code: r.status, out: r.stdout + r.stderr };
}

const VIEW = "ctx.registerView({ id: 'desk', title: 'Desk', mount() {} })";

describe('forsion-plugin 技能的 check-plugin.mjs', () => {
  it('顶层注册、Space 对得上 → 0', () => {
    const r = check(plugin(`${VIEW}\nctx.registerCommand({ id: 'demo-open', title: 'Open', run() {} })`));
    expect(r.out).toContain('registerView × 1: desk');
    expect(r.out).toContain('Space "demo-space": every view it needs from this plugin is registered');
    expect(r.code).toBe(0);
  });

  it('一个函数没收口、把注册包了进去(文件末尾补了个 } 凑平)→ 点名那个函数,并说明不是应用的问题', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}`).join('\n');
    const src = `const h = () => 1\nfunction render(el) {\n  el.textContent = ''\n  const draw = () => {\n    h()\n  }\n${filler}\n${VIEW}\nreturn () => {}\n}`;
    const r = check(plugin(src));
    expect(r.out).toContain('loaded without throwing; returned undefined');
    expect(r.out).toMatch(/registerView \(line \d+\) sits inside function render, lines 2–\d+, which never ran/);
    expect(r.out).toContain('missing\n    closing brace where render should end');
    expect(r.out).toContain('will be HIDDEN: needs plugin:demo:desk');
    expect(r.out).toContain("a bug in this plugin's own main.js, not because the app");
    expect(r.code).toBe(1);
  });

  it('整个文件包成 function setup(ctx) → 说明宿主只求值文件体、没人调用它', () => {
    const r = check(plugin(`function setup(ctx) {\n  ${VIEW}\n}\nreturn setup`));
    expect(r.out).toMatch(/sits inside function setup, lines 1–3, which never ran/);
    expect(r.out).toContain('nothing calls that function during load');
    expect(r.code).toBe(1);
  });

  it('有条件才注册的可选项不算问题(负对照:Space 要的视图已注册)', () => {
    const r = check(plugin(`${VIEW}\nif (ctx.getLocale() === 'never') ctx.registerCommand({ id: 'demo-x', title: 'X', run() {} })\nfunction later() { ctx.registerStatusItem({ id: 's' }) }`));
    expect(r.out).not.toContain('did NOT run');
    expect(r.code).toBe(0);
  });

  it('什么都没注册、注册代码在假条件后面(等宿主能力的插件)→ 只提示,不判错', () => {
    const r = check(plugin(`if (ctx.getLocale() === 'never') { ${VIEW} }`, { space: null }));
    expect(r.out).toContain('sits behind a condition that was false here');
    expect(r.code).toBe(0);
  });

  it('求值抛错 → 报行号', () => {
    const r = check(plugin(`${VIEW}\nconst a = undefinedThing.x`));
    expect(r.out).toMatch(/loading threw: ReferenceError: undefinedThing is not defined \(line 2\)/);
    expect(r.code).toBe(1);
  });

  it('异步 setup 里的注册算数;拿不到 process / require', () => {
    const r = check(plugin(`return (async () => { await ctx.loadData(); ctx.registerView({ id: 'desk' }); ctx.registerCommand({ id: 'p-' + typeof process + '-' + typeof require }) })()`));
    expect(r.out).toContain('registerView × 1: desk');
    expect(r.out).toContain('p-undefined-undefined');
    expect(r.code).toBe(0);
  });

  it('Space 写错了插件 id / 视图 id / JSON 坏了 → 各自说清', () => {
    const wrongOwner = check(plugin(VIEW, { space: { id: 'demo-space', name: 'D', layout: { main: [{ type: 'plugin:other:desk' }] } } }));
    expect(wrongOwner.out).toContain('the view type must be plugin:demo:desk');
    expect(wrongOwner.code).toBe(1);
    const wrongView = check(plugin(VIEW, { space: { id: 'demo-space', name: 'D', layout: { main: [{ type: 'plugin:demo:desc' }] } } }));
    expect(wrongView.out).toContain('No ctx.registerView call in main.js uses the id desc (registered: desk)');
    expect(wrongView.code).toBe(1);
    const badJson = check(plugin(VIEW, { space: '{ "id": ' }));
    expect(badJson.out).toContain('not valid JSON');
    expect(badJson.code).toBe(1);
  });

  it('版本门槛只在给了 --app-version 时判;目录名与 id 不同只是说明', () => {
    const space = { id: 'demo-space', name: 'D', minAppVersion: '2.14.0', layout: { main: [{ type: 'plugin:demo:desk' }] } };
    expect(check(plugin(VIEW, { space, folder: 'other-name' })).code).toBe(0);
    const old = check(plugin(VIEW, { space }), '--app-version', '2.13.1');
    expect(old.out).toContain('needs app ≥ 2.14.0, the app is 2.13.1');
    expect(old.code).toBe(1);
  });

  it('给的是装插件的那层目录(或什么都不给 = ~/.forsion/plugins)→ 逐个查,坏的那个给全文', () => {
    const home = join(base, 'home');
    const plugins = join(home, '.forsion', 'plugins');
    mkdirSync(plugins, { recursive: true });
    const move = (from: string, name: string) => { const to = join(plugins, name); mkdirSync(to, { recursive: true }); for (const f of ['manifest.json', 'main.js']) writeFileSync(join(to, f), readFileSync(join(from, f))); return to; };
    move(plugin(VIEW, { space: null }), 'good-one');
    const bad = move(plugin(`function setup(ctx) {\n  ${VIEW}\n}`, { id: 'bad' }), 'bad-one');
    mkdirSync(join(bad, 'spaces', 's'), { recursive: true });
    writeFileSync(join(bad, 'spaces', 's', 'space.json'), JSON.stringify({ id: 'bad-space', name: 'B', layout: { main: [{ type: 'plugin:bad:desk' }] } }));
    mkdirSync(join(plugins, 'not-a-plugin'));
    for (const r of [check(plugins), run([], { ...process.env, HOME: home, USERPROFILE: home })]) {
      expect(r.out).toContain('2 plugin(s) in');
      expect(r.out).toContain('✓ good-one');
      expect(r.out).toContain('✗ bad-one');
      expect(r.out).toContain('Space "bad-space" will be HIDDEN');
      expect(r.out).toContain('1 of 2 plugin(s) have problems: bad-one');
      expect(r.code).toBe(1);
    }
  });

  it('不是插件目录 → 2 / 1,不崩', () => {
    expect(check(join(base, 'nope')).code).toBe(2);
    const empty = join(base, 'empty'); mkdirSync(empty);
    expect(check(empty).code).toBe(1);
  });
});
