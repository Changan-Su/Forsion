#!/usr/bin/env node
/**
 * 接管「用户自己的 Chrome」冒烟(09-24):真 Chrome × 真 agent-browser × dist 里的 browser_tabs / browser_navigate。
 *   npm run build && node scripts/browser-attach.smoke.mjs
 *
 * 起一个**临时** headless Chrome 冒充用户的浏览器(--remote-debugging-port=0 → 它自己写 DevToolsActivePort,
 * 与 chrome://inspect/#remote-debugging 模式同一条 ws 直连路径;差别只在真 Chrome 每次连接会弹「允许」框),
 * 预开两个「用户标签」,然后断言:
 *   ① findUserBrowser 从 user-data-dir 发现端点;
 *   ② browser_tabs 列得出用户的标签,select 能读到页内文字;
 *   ③ browser_navigate 开在 Tangu 自己的 tangu 标签里,用户原有标签的 URL 一个不变;再导航复用同一标签。
 * 绝不碰本机真实的 Chrome:端点显式经 TANGU_BROWSER_CDP 指给临时实例。退出码非 0 = 有断言失败。
 * CHROME_BIN 可指定浏览器路径;TANGU_AGENT_BROWSER_BIN 可指定 agent-browser(缺省 PATH → npx)。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist', 'tools', 'builtin', 'browserTools.js');
if (!existsSync(dist)) { console.error('dist 缺失,先 npm run build'); process.exit(2); }

const CHROME = process.env.CHROME_BIN || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform] || 'google-chrome';
if (process.platform !== 'linux' && !existsSync(CHROME)) { console.error(`找不到 Chrome:${CHROME}(用 CHROME_BIN 指定)`); process.exit(2); }

const work = mkdtempSync(join(tmpdir(), 'tangu-attach-smoke-'));
const profileDir = join(work, 'chrome');
process.env.TANGU_HOME = join(work, 'tangu'); // 不读本机真实 config.json
// socket 路径上限 ~103 字节(macOS):os.tmpdir() 太长,和生产一样放 /tmp 下的短目录
const sockDir = process.platform === 'win32' ? join(work, 'sock') : mkdtempSync('/tmp/tgsmk-');
process.env.TANGU_BROWSER_SOCKET_DIR = sockDir;
process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1'; // 导航目标是本地 http 服务
const MARKER = `SMOKE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
// 页面一律走本地 http(data: URL 会把正文带进 URL,列表就把答案漏了)
const PAGES = {
  '/inbox': ['Inbox - Example Mail', 'three unread'],
  '/video': ['天禄五环 测评 - 哔哩哔哩', `视频结论:最推荐 3 号,口令 ${MARKER}`],
  '/': ['Tangu nav target', 'nav ok'],
};
const http = createServer((q, r) => { const [t, b] = PAGES[q.url.split('?')[0]] || ['404', '']; r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(`<title>${t}</title><h1>${t}</h1><p>${b}</p>`); });
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${http.address().port}`;
const USER_TABS = [`${origin}/inbox`, `${origin}/video`];
const navUrl = `${origin}/`;

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', USER_TABS[0]], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = ''; chrome.stderr.on('data', (d) => { chromeErr += d; });
const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fails.push(name); };
const timed = async (label, fn) => { const t = Date.now(); const v = await fn(); console.log(`      ${label}: ${Date.now() - t}ms`); return v; };
let sessionName = '';

try {
  const portFile = join(profileDir, 'DevToolsActivePort');
  // 文件先建后写:等到两行都写完再测(真实场景 Chrome 早就起好了,没有这个竞态)
  const portReady = () => { try { return readFileSync(portFile, 'utf8').trim().split('\n').length === 2; } catch { return false; } };
  for (let i = 0; i < 100 && !portReady(); i++) await new Promise((r) => setTimeout(r, 100));
  const { __browserToolInternals: bt, browserTabsProvider, browserToolsProvider } = await import(dist);
  const ws = await bt.findUserBrowser([join(work, 'nope'), profileDir]);
  check('① 从 DevToolsActivePort 发现端点', typeof ws === 'string' && ws.startsWith('ws://127.0.0.1:'), ws || `(null;chrome exit=${chrome.exitCode} 文件=${existsSync(portFile) ? JSON.stringify(readFileSync(portFile, 'utf8')) : '不存在'})`);
  if (!ws) throw new Error('没有端点,后面不用跑了');
  process.env.TANGU_BROWSER_CDP = ws;
  const [, port] = ws.match(/:(\d+)\//);
  const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
  // 真 Chrome 的 chrome://inspect 模式下 /json/* 是 404;这里只拿它当旁证核标签,工具本身只走 ws
  await fetch(`http://127.0.0.1:${port}/json/new?${USER_TABS[1]}`, { method: 'PUT' }); // headless 命令行只收一个 URL,第二个用户标签这样开
  for (let i = 0; i < 50 && (await pages()).length < USER_TABS.length; i++) await new Promise((r) => setTimeout(r, 100));
  const before = (await pages()).map((p) => p.url);

  const ctx = { userId: 'smoke', sessionId: 'smoke', appId: 'tangu', execMode: 'host' };
  const tool = (p, n) => p.tools().find((t) => t.name === n);
  const run = async (p, n, args) => JSON.parse(await tool(p, n).execute(args, ctx));

  const listed = await timed('browser_tabs(list)', () => run(browserTabsProvider, 'browser_tabs', {}));
  const bili = (listed.tabs || []).find((t) => t.title.includes('哔哩哔哩'));
  check('② browser_tabs 列出用户的标签', listed.success && (listed.tabs || []).length >= 2 && !!bili, JSON.stringify((listed.tabs || []).map((t) => t.title)));
  check('② 列表里没有正文(答案只能靠 select 读)', !JSON.stringify(listed).includes(MARKER));
  const read = await timed('browser_tabs(select)', () => run(browserTabsProvider, 'browser_tabs', { select: '哔哩哔哩' }));
  check('② select 读到页内文字', read.success && String(read.text || '').includes(MARKER), String(read.text || read.error).slice(0, 120));
  const ambiguous = await run(browserTabsProvider, 'browser_tabs', { select: '127.0.0.1' });
  check('② 多个命中不乱猜', ambiguous.success === false && (ambiguous.tabs || []).length >= 2);

  const nav1 = await timed('browser_navigate#1', () => run(browserToolsProvider, 'browser_navigate', { url: navUrl }));
  check('③ 导航成功且标注在 Tangu 自己的标签', nav1.success && /Tangu's own tab/.test(nav1.note || ''), nav1.error || nav1.title);
  const afterNav = await pages();
  const urlsAfter = afterNav.map((p) => p.url);
  check('③ 用户原有标签一个不少、URL 不变', before.every((u) => urlsAfter.includes(u)), JSON.stringify(urlsAfter.map((u) => u.slice(0, 48))));
  check('③ 只多出一个导航标签', afterNav.length === before.length + 1 && urlsAfter.includes(navUrl));
  await timed('browser_navigate#2', () => run(browserToolsProvider, 'browser_navigate', { url: `${navUrl}?again=1` }));
  const afterNav2 = await pages();
  check('③ 再次导航复用 tangu 标签(不叠标签)', afterNav2.length === afterNav.length, `${afterNav.length} → ${afterNav2.length}`);

  // ④ 跨会话:所有会话共用一个守护进程、一个「当前标签」游标 —— 各自只能动自己选中 / 打开的标签
  const ctxB = { ...ctx, sessionId: 'smoke-b' };
  const runB = async (p, n, args) => JSON.parse(await tool(p, n).execute(args, ctxB));
  const blind = await runB(browserToolsProvider, 'browser_snapshot', {});
  check('④ 没选过标签的会话不能操作(不会落到别人的页上)', blind.success === false && /browser_tabs/.test(blind.error || ''), blind.error);
  const bSel = await runB(browserTabsProvider, 'browser_tabs', { select: '/inbox' });
  check('④ 会话 B 选中用户的另一个标签', bSel.success && /three unread/.test(bSel.text || ''), bSel.error || bSel.title);
  const aSnap = await run(browserToolsProvider, 'browser_snapshot', { compact: false });
  check('④ 会话 A 的快照仍是它自己的页(先切回再读)', aSnap.success && /nav ok/.test(aSnap.snapshot || '') && !/three unread/.test(aSnap.snapshot || ''), String(aSnap.snapshot || aSnap.error).slice(0, 80));
  sessionName = readFileSync(join(process.env.TANGU_BROWSER_SOCKET_DIR, `${`tangu_chrome_`}${(await import('node:crypto')).createHash('sha1').update(ws).digest('hex').slice(0, 10)}.pid`), 'utf8').trim();
} catch (e) {
  check('冒烟未跑完', false, String(e?.stack || e));
  if (chromeErr) console.log(`      chrome stderr: ${chromeErr.slice(-600)}`);
} finally {
  if (sessionName) { try { process.kill(Number(sessionName)); } catch { /* 已退 */ } } // 只断开 agent-browser 守护进程
  chrome.kill('SIGKILL');
  http.close();
  for (const d of [work, sockDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
console.log(fails.length ? `\n${fails.length} 条失败` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
