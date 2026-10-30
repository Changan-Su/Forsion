/**
 * 随 forsion-plugin 技能分发的「插件体检」脚本(skills/forsion-plugin/tools/check-plugin.mjs):照桌面宿主的方式求值 main.js,
 * 对账随包 Space 要的视图。起因是 2026-10-10 一份用户插件:一个函数没收口,把 registerView 包了进去,求值不报错、零注册,
 * Space 被宿主跳过,真模型六次都没查出来。
 *
 * 这里钉的是结论对不对,和「正常写法不误报」(有条件才注册、等宿主能力的插件在 28 个已装插件上扫出过误报)。
 * 脚本当独立进程跑:它本来就是给 agent 用 `node …` 调的。
 *
 * 它要**执行**别人写的 main.js(agent 在用户机器上跑),所以还钉:插件代码够不着本进程(替身对象全在隔离上下文里造)、
 * 卡死的会被杀掉;以及拿不准的(注册代码在条件后面 —— 体检时没有插件存的数据)报「未定」,不报成插件的错。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 90_000, env });
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
    expect(r.out).toContain('did not run in this dry run: it sits behind a condition');
    expect(r.code).toBe(0);
  });

  it('Space 要的视图只在条件成立时注册(体检时没有插件存的数据)→ 报「未定」(退出码 3),不报成插件的错', () => {
    const gated = check(plugin(`return (async () => { const cfg = await ctx.loadData(); if (cfg && cfg.enabled) { ${VIEW} } })()`));
    expect(gated.out).toContain('Not decided: registration code exists in main.js but did not run in this dry run');
    expect(gated.out).toContain('? Space "demo-space" may be hidden');
    expect(gated.out).toContain('RESULT: undecided.');
    expect(gated.out).not.toContain("a bug in this plugin's own main.js");
    expect(gated.code).toBe(3);
    // 没被调用的函数同理:别处有人引用它(可能有条件地调),就不是铁证
    const called = check(plugin(`function addViews() { ${VIEW} }\nctx.app.onReady(addViews)`));
    expect(called.out).toContain('inside function addViews');
    expect(called.out).toContain('Something else in the file refers to that function');
    expect(called.code).toBe(3);
  });

  it('插件代码够不着本进程:console / this / URL / ctx / 定时器 / 返回的 thenable 各条路拿到的都不是 process', () => {
    const grab = (label: string, expr: string) => `try { t.push('${label}=' + String(${expr})) } catch (e) { t.push('${label}=threw') }`;
    const src = [
      'const t = []',
      grab('console', "console.log.constructor('return typeof process')()"),
      grab('this', "(function () { return this })().constructor.constructor('return typeof process')()"),
      grab('URL', "URL.constructor('return typeof process')()"),
      grab('ctx', "ctx.registerView.constructor('return typeof process')()"),
      grab('promise', "ctx.loadData().constructor.constructor('return typeof process')()"),
      grab('timer', "setTimeout.constructor('return typeof process')()"),
      "ctx.registerCommand({ id: t.join(',') })",
      "return { then(resolve) { let got = 'threw'; try { got = resolve.constructor('return typeof process')() } catch (e) {} ctx.registerCommand({ id: 'thenable=' + got }); resolve() } }",
    ].join('\n');
    const r = check(plugin(src, { space: null }));
    expect(r.out).toContain('console=undefined,this=undefined,URL=,ctx=,promise=undefined,timer=undefined');
    expect(r.out).toContain('thenable=undefined');
    expect(r.out).not.toContain('=object');
  });

  it('加载时卡死(含 promise 回调里的死循环)→ 探针被杀掉,报告卡死而不是跟着挂住', () => {
    const env = { ...process.env, FORSION_PLUGIN_CHECK_TIMEOUT_MS: '9000' };
    const sync = run([plugin('for (;;) {}', { space: null })], env);
    expect(sync.out).toContain('did not finish its synchronous part within 5 s');
    expect(sync.code).toBe(1);
    const micro = run([plugin('Promise.resolve().then(() => { for (;;) {} })', { space: null })], env);
    expect(micro.out).toContain('did not finish loading within 9 s and was stopped');
    expect(micro.code).toBe(1);
  }, 60_000);

  it('插件自带 sourceURL 不影响定位;帮助文案里以 import 开头的一行不算语法错;真的顶层 import 报语法错', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}`).join('\n');
    const named = check(plugin(`function render(el) {\n${filler}\n${VIEW}\n}\n//# sourceURL=probe.js`));
    expect(named.out).toMatch(/sits inside function render, lines 1–\d+, which never ran/);
    const help = check(plugin(`const HELP = \`\nimport a mesh from the menu\nexport it when done\n\`\n${VIEW}`));
    expect(help.out).toContain('registerView × 1: desk');
    expect(help.code).toBe(0);
    const esm = check(plugin(`import x from 'y'\n${VIEW}`));
    expect(esm.out).toContain('a top-level import / export is a syntax error for the host');
    expect(esm.code).toBe(1);
  });

  it('很大的插件(几千个没跑到的函数)照样出结论 —— 探针的结果一次写不完管道,曾经被截断成「没有结果」', () => {
    const many = Array.from({ length: 6000 }, (_, i) => `function unused${i}(a) { if (a) { return a + ${i} } return null }`).join('\n');
    const r = check(plugin(`${many}\n${VIEW}`));
    expect(r.out).toContain('registerView × 1: desk');
    expect(r.code).toBe(0);
  });

  it('只带捆绑内容、没有 main.js 的包(宿主允许)不算缺入口;声明了 main 却没有那个文件才算', () => {
    const dir = plugin('', { space: null });
    rmSync(join(dir, 'main.js'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1 }));
    mkdirSync(join(dir, 'skills', 'helper'), { recursive: true });
    const bundle = check(dir);
    expect(bundle.out).toContain('a bundle-only plugin');
    expect(bundle.code).toBe(0);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, main: 'main.js' }));
    expect(check(dir).out).toContain('"main" points at main.js, which does not exist');
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

  it('Space 用了别的插件的同名视图(可以是有意的组合)→ 只提示;视图 id 写错 / JSON 坏了 / 配方缺 name → 各自说清', () => {
    const other = check(plugin(VIEW, { space: { id: 'demo-space', name: 'D', layout: { main: [{ type: 'plugin:other:desk' }] } } }));
    expect(other.out).toContain('if you meant your own view, the type is plugin:demo:desk');
    expect(other.out).not.toContain('will be HIDDEN');
    expect(other.code).toBe(0);
    const noName = check(plugin(VIEW, { space: { id: 'demo-space', layout: { main: [{ type: 'plugin:demo:desk', params: 42 }] } } }));
    expect(noName.out).toContain('"name" must be a non-empty string or { zh?, en? }');
    expect(noName.out).toContain('"params" of plugin:demo:desk must be an object');
    expect(noName.code).toBe(1);
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

  it('--style:私有类名、写死的色 / 圆角 / 阴影、宿主没有的 token、多余兜底都报出来,但不改退出码', () => {
    const css = [
      '.x .ok { background: rgba(34,197,94,.14); color: #16a34a; }',
      '.x .row:hover { background: var(--overlay-6, rgba(0,0,0,.06)); }',
      '.x .card { border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.12); }',
      '.x .t { font-size: var(--ui-font-title, 16px); transition: color var(--dur-fast); }',
      '* { color: #fff; }',
    ].join('\n');
    const dir = plugin(`${VIEW}\nconst s = document.createElement('style'); s.textContent = \`${css}\`;\nconst m = 'ctx-menu amx-db-pop';`);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, minAppVersion: '2.12.0', main: 'main.js' }));
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling.css'));
    const r = check(dir, '--style');
    expect(r.out).toContain('main.js:2  background: hard-coded color rgba(34,197,94,.14)');
    expect(r.out).toContain('color: hard-coded color #16a34a');
    expect(r.out).toContain('--overlay-6 is not a public host token (meant --overlay-subtle / --overlay-light');
    expect(r.out).toContain('border-radius written by hand');
    expect(r.out).toContain('box-shadow with a hard-coded color');
    expect(r.out).toContain('var(--ui-font-title, …): every app this plugin supports defines --ui-font-title');
    expect(r.out).toContain('--dur-fast is deprecated: use --duration-fast');
    expect(r.out).toContain('.amx-db-pop is a private host class');
    expect(r.out).not.toContain('.ctx-menu is a private');
    expect(r.out).toContain('9 style note(s)');
    expect(r.code).toBe(0);
  });

  it('--style:只用公开 token、自己的类名与变量、老宿主才需要的兜底、另一份文档的 CSS → 无可报', () => {
    const css = [
      '.x { --x-wash: color-mix(in srgb, var(--green) 14%, transparent); }',
      '.x .ok { background: var(--x-wash); color: var(--green); border-radius: var(--radius-md); box-shadow: 0 0 0 1px var(--border); }',
      '.x .t { font-size: var(--ui-font-title, 16px); line-height: var(--reading-line-height, 1.6); }',
      '.fc-btn { border-radius: 2px; background: black; }',
    ].join('\n');
    const page = 'html,body{background:#0b0b0b;color:#e8e6e1} /* forsion-style: off */';
    const dir = plugin(`${VIEW}\nconst s = document.createElement('style'); s.textContent = \`${css}\`;\nconst k = 'fc-btn';\n// .amx-x in a comment\nconst page = '${page}';`);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, minAppVersion: '2.9.0', main: 'main.js' }));
    const r = check(dir, '--style');
    expect(r.out).toContain('Style: host classes and tokens checked');
    expect(r.out).toContain('✓ nothing to report');
    expect(r.code).toBe(0);
    expect(check(dir).out).not.toContain('Style:');
  });

  // 10-29 插件开发体验 1B:插件自己画了宿主已有零件的东西(本机 31 个已装插件里 ForsionCFD 自造标签栏、Jupyter 34 个手写按钮 +
  // 16 处自画菜单)。同一份 tools/ui-reinvent.mjs 也进 plugin_sandbox 的状态。只报不拦,退出码不变。
  it('--style UI parts:自画下拉 / 菜单 / 对话框 / 标签栏 / fixed 浮层 / iframe / 往 head 塞 style / 手写按钮 → 每类一行点名零件,不改退出码', () => {
    // 都写在视图的 mount 里:体检只求值文件体,不挂视图,替身 DOM 不会因为这些调用报错
    const dir = plugin([
      "ctx.registerView({ id: 'desk', title: 'Desk', mount(el) {",
      "const sel = document.createElement('select')",
      "const m = document.createElement('div'); m.className = 'rl-menu'",
      "if (window.confirm('Delete?')) m.remove()",
      "const h = (tag) => document.createElement(tag); const tab = h('button', { 'data-tab': 'a' })",
      "m.style.position = 'fixed'",
      "const f = document.createElement('iframe')",
      "const st = document.createElement('style'); document.head.appendChild(st)",
      "const b = document.createElement('button'); b.textContent = 'Go'",
      "const page = '<select>' // forsion-style: off",
      '} })',
    ].join('\n'));
    const r = check(dir, '--style');
    for (const [what, part] of [
      ['hand-made dropdown ×1 (main.js:2)', "ctx.ui.mountControl(el, { type: 'select'"],
      ['hand-made menu ×1 (main.js:3)', 'ctx.ui.contextMenu('],
      ['hand-made dialog ×1 (main.js:4)', 'ctx.ui.confirm('],
      ['hand-made tab bar ×1 (main.js:5)', "type: 'segmented'"],
      ['position: fixed overlay ×1 (main.js:6)', 'ctx.ui.popover('],
      ['view drawn in an iframe ×1 (main.js:7)', 'draw the view with host parts'],
      ['<style> added to document.head ×1 (main.js:8)', 'ctx.addStyle(css)'],
      ['hand-styled button (no host .btn class anywhere) ×2 (main.js:5, main.js:9)', '.btn.primary'],
    ]) expect(r.out.split('\n').find((l) => l.includes(`- ${what} → `)), what).toContain(part);
    expect(r.out).toContain('8 UI note(s)');
    expect(r.code).toBe(0);
  });

  it('--style UI parts:用了零件和公开 .btn、压缩过的库代码、宿主菜单外壳 → 无可报;官方样例全部 0 条(防模板退回手搓)', () => {
    const lib = `var x=1;${'a.createElement("select");'.repeat(100)}`;
    const dir = plugin([
      VIEW,
      "const b = document.createElement('button'); b.className = 'btn primary sm'",
      "ctx.ui.contextMenu({ anchor: b }, [{ label: 'Rename', run() {} }])",
      "const shell = document.createElement('div'); shell.className = 'ctx-menu'",
      "const del = async () => { if (await ctx.ui.confirm({ title: 'Delete?' })) shell.remove() }",
      lib,
    ].join('\n'));
    const r = check(dir, '--style');
    expect(r.out).toContain('UI parts: what this plugin draws itself');
    expect(r.out).not.toContain('UI note(s)');
    const samples = fileURLToPath(new URL('../skills/forsion-plugin/samples/', import.meta.url));
    for (const s of ['forsion-sample-bundle', 'forsion-sample-appearance']) {
      const out = check(join(samples, s), '--style').out;
      expect(out, s).not.toMatch(/(style|UI) note\(s\)/);
    }
  });
});
