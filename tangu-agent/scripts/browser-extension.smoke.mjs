#!/usr/bin/env node
/**
 * Tangu for Chrome 扩展冒烟(09-24):真 Chrome × 真扩展 × 真引擎桥 × dist 里的 browser_* 工具。
 *   npm run build && node scripts/browser-extension.smoke.mjs
 *
 * 起一个临时 headless Chrome(独立 user-data-dir,绝不碰用户的 Chrome),管道 CDP 装载 browser-extension/,
 * 附着到扩展的 service worker 写入连接码完成配对(等价于用户在弹窗里粘贴),然后断言用户提的三件事:
 *   ① 看得见用户开着的标签,并知道用户正在看哪个(focused);
 *   ② Tangu 自己打开的页进「Tangu」标签组、在后台 —— 用户正看着的标签始终保持激活;
 *   ③ 不弹任何授权框(扩展这一路没有「允许远程调试?」),读页 / 点击 / 输入都在后台完成;
 * 另验:握手是双向的 —— 冒充 Tangu 的进程(不知道令牌)抢占端口也指挥不了扩展;跨会话各动各的标签、
 * 审批判定(用户标签要批 / Tangu 自己的页不批)、截图。退出码非 0 = 有断言失败。
 */
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { launchChromePipe, pairExtension } from './lib/chrome-pipe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => join(root, 'dist', p);
if (!existsSync(dist('services/browserExtension.js'))) { console.error('dist 缺失,先 npm run build'); process.exit(2); }

const freePort = () => new Promise((r) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const work = mkdtempSync(join(tmpdir(), 'tangu-ext-smoke-'));
process.env.TANGU_HOME = join(work, 'tangu');
process.env.TANGU_BROWSER_EXTENSION_PORT = String(await freePort());
process.env.TANGU_BROWSER_CDP = 'off'; // 只测扩展这一路
process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1';

const MARKER = `EXT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const BUTTON = `<button onclick="this.dataset.n=(+this.dataset.n||0)+1;document.title='CLICKED-'+this.dataset.n">推荐款</button><input id=q placeholder="搜索">`;
const PAGES = {
  '/user': ['Inbox - Example Mail', 'the user is reading this page'],
  '/video': ['天禄五环 测评 - 哔哩哔哩', `视频结论:最推荐 3 号,口令 ${MARKER}`],
  '/nav': ['Tangu nav target', 'nav ok'],
};
const http = createServer((q, r) => {
  const p = q.url.split('?')[0];
  const [t, b] = PAGES[p] || ['404', ''];
  r.setHeader('content-type', 'text/html; charset=utf-8');
  r.end(`<title>${t}</title><h1>${t}</h1><p>${b}</p>${p === '/video' ? BUTTON : ''}`);
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${http.address().port}`;

const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fails.push(name); };
const timed = async (label, fn) => { const t = Date.now(); const v = await fn(); console.log(`      ${label}: ${Date.now() - t}ms`); return v; };
let chrome = null;
let bridge = null;

try {
  bridge = await import(dist('services/browserExtension.js'));
  const { browserTabsProvider, browserToolsProvider, userBrowserActionGated } = await import(dist('tools/builtin/browserTools.js'));
  bridge.startBrowserExtensionBridge();
  const [, port, token] = bridge.connectCode().split(':');

  chrome = await launchChromePipe({ url: `${origin}/user` });
  await chrome.cdp('Target.createTarget', { url: `${origin}/video`, background: true }); // 用户的第二个标签,不抢前台
  const loaded = await chrome.cdp('Extensions.loadUnpacked', { path: bridge.extensionDir() });
  check('① 扩展装载,ID 与 manifest.key 钉死的一致', loaded.id === bridge.EXTENSION_ID, loaded.id);
  // ⓪ 冒充 Tangu:不知道令牌的进程先占了端口 → 发假证明、趁机塞命令。扩展必须一条都不执行、主动断开。
  const roguePort = await freePort();
  const rogue = new WebSocketServer({ host: '127.0.0.1', port: roguePort, path: '/tangu-browser' });
  const rogueSaw = { hello: null, results: 0, closeCode: null };
  rogue.on('connection', (sock) => {
    sock.send(JSON.stringify({ id: 1, method: 'tabs.list' })); // 握手前就塞
    sock.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'hello') { rogueSaw.hello = m; sock.send(JSON.stringify({ type: 'challenge', proof: '0'.repeat(64), nonce: 'ab'.repeat(16) })); sock.send(JSON.stringify({ type: 'welcome' })); sock.send(JSON.stringify({ id: 2, method: 'tabs.list' })); }
      if (m.id != null && 'result' in m) rogueSaw.results++;
    });
    sock.on('close', (code) => { rogueSaw.closeCode = code; });
  });
  await pairExtension(chrome, loaded.id, { port: roguePort, token });
  for (let i = 0; i < 25 && rogueSaw.closeCode == null; i++) await new Promise((r) => setTimeout(r, 200));
  check('⓪ 冒充 Tangu 的进程指挥不了扩展(一条命令都没执行、令牌没上线、扩展主动断开)',
    rogueSaw.results === 0 && rogueSaw.hello && !JSON.stringify(rogueSaw.hello).includes(token) && rogueSaw.closeCode === 4002, JSON.stringify(rogueSaw));
  rogue.close();

  await pairExtension(chrome, loaded.id, { port: Number(port), token });
  for (let i = 0; i < 50 && !bridge.extensionConnected(); i++) await new Promise((r) => setTimeout(r, 200));
  check('① 扩展凭连接码连上引擎(没有任何授权弹框)', bridge.extensionConnected());
  if (!bridge.extensionConnected()) throw new Error('扩展没连上,后面不用跑了');

  const ctx = { userId: 'smoke', sessionId: 'smoke-a', appId: 'tangu', execMode: 'host' };
  const ctxB = { ...ctx, sessionId: 'smoke-b' };
  const tool = (n) => [...browserTabsProvider.tools(), ...browserToolsProvider.tools()].find((t) => t.name === n);
  const run = async (n, args, c = ctx) => JSON.parse(await tool(n).execute(args, c));
  const listTabs = async () => (await run('browser_tabs', {})).tabs || [];

  const listed = await timed('browser_tabs(list)', listTabs);
  const userTab = listed.find((t) => t.url.endsWith('/user'));
  check('① 列出用户的标签,并标出用户正在看的那个', listed.length >= 2 && userTab?.focused === true && !listed.some((t) => t.tangu), JSON.stringify(listed.map((t) => [t.title, t.focused ? 'focused' : '', t.tangu ? 'tangu' : ''])));

  const read = await timed('browser_tabs(select)', () => run('browser_tabs', { select: '/video' }));
  check('③ 读到后台标签的正文', read.success && String(read.text || '').includes(MARKER), String(read.text || read.error).slice(0, 80));
  const btn = String(read.refs || '').match(/button "推荐款" \[ref=(e\d+)\]/)?.[1];
  const box = String(read.refs || '').match(/textbox "搜索" \[ref=(e\d+)\]/)?.[1];
  check('③ 后台标签里有可交互元素 refs', !!btn && !!box, String(read.refs || '').slice(0, 160));
  const gatedUser = await userBrowserActionGated('smoke-a');

  const c1 = await timed('browser_click', () => run('browser_click', { ref: btn }));
  const c2 = await run('browser_click', { ref: btn });
  const typed = await run('browser_type', { ref: box, text: '天禄五环' });
  const title = await run('browser_console', { expression: 'document.title + "|" + document.querySelector("#q").value' });
  check('③ 用同一组 refs 连点两次 + 输入,都在后台生效', c1.success && c2.success && typed.success && title.result === 'CLICKED-2|天禄五环', `${c1.error || ''}${c2.error || ''}${typed.error || ''} ${JSON.stringify(title.result ?? title.error)}`);

  const nav = await timed('browser_navigate#1', () => run('browser_navigate', { url: `${origin}/nav` }));
  const afterNav = await listTabs();
  const own = afterNav.find((t) => t.url.startsWith(`${origin}/nav`));
  check('② 导航开在「Tangu」标签组里', nav.success && !!own?.tangu, nav.error || JSON.stringify(own));
  check('② 用户正在看的标签一直没被抢走(仍 focused)', afterNav.find((t) => t.url.endsWith('/user'))?.focused === true);
  const gatedOwn = await userBrowserActionGated('smoke-a');
  check('审批:动用户自己的标签要批,动 Tangu 自己开的页不批', gatedUser === true && gatedOwn === false, `user=${gatedUser} own=${gatedOwn}`);
  await timed('browser_navigate#2', () => run('browser_navigate', { url: `${origin}/nav?again=1` }));
  check('② 再次导航复用本会话自己的那一页(不叠标签)', (await listTabs()).length === afterNav.length);

  const blind = await run('browser_click', { ref: 'e1' }, ctxB);
  check('④ 没选过标签的会话不能操作', blind.success === false && /browser_tabs/.test(blind.error || ''), blind.error);
  await run('browser_tabs', { select: '/user' }, ctxB);
  const aSnap = await run('browser_snapshot', {});
  check('④ 会话 A 的快照仍是它自己的页(按标签 id 寻址,不受 B 影响)', /Tangu nav target/.test(aSnap.snapshot || '') , String(aSnap.snapshot || aSnap.error).slice(0, 80));

  const shot = await timed('browser_screenshot', () => run('browser_screenshot', {}));
  const png = shot.success && existsSync(shot.screenshot_path) ? readFileSync(shot.screenshot_path).subarray(0, 4).toString('hex') : '';
  check('截图(调试接口,后台标签)', png === '89504e47', shot.error || png);
} catch (e) {
  check('冒烟未跑完', false, String(e?.stack || e));
} finally {
  chrome?.kill();
  bridge?.stopBrowserExtensionBridge();
  http.close();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(fails.length ? `\n${fails.length} 条失败` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
