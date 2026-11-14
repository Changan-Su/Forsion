// cuweb / cuwebdead(10-31):网页按钮的后台 AXPress(Computer Use 插件 feat/web-axpress-first)。
// 替身 Melody / Chatter 是自绘窗口,走不到网页这条路,这里用一个一次性的 Electron 窗口。
//   cuweb:普通网页按钮,全程不许抢前台,按一次就够。
//   cuwebdead:只认真实鼠标悬停的按钮,AXPress 按了没反应。模型要看出来,对同一元素再按一次,这次才是真实点击。
//     判据要求它最后成了、没有反复乱按、没有绕去 shell / AppleScript。
//   cuwebcovered:窗口被完全盖住,页面进 hidden。按压照样落地,但页面不再把无障碍变化送出来、也不重绘。helper 读之前先问页面一次
//     (插件 0.7.2 起),不提窗口就读得到新状态:模型按一次就该看到结果,替身全程不到前台。
// 判据只看页面自己收到的事件和采样到的前台,不信模型自述。
// ⚠️cuwebdead 会真的动鼠标、把替身拿到前台。负对照 = --cu-plugin 指向没有这处改动的包,cuweb 须红(前台被抢);
// cuwebcovered 的负对照 = 同一份包带 PI_COMPUTER_USE_WEB_FLUSH=0 跑,须红在「没提窗口」。
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CU_WEB_KEYS = ['cuweb', 'cuwebdead', 'cuwebcovered'];

const PROMPTS = {
  cuweb: '电脑上开着一个叫 Draft Desk 的窗口。帮我点一下里面的 Publish draft 按钮,然后告诉我页面上的状态变成了什么。',
  cuwebdead: '电脑上开着一个叫 Draft Desk 的窗口。帮我点一下里面的 Approve 按钮,要等页面上的状态变成 approved 才算完,然后告诉我结果。',
  cuwebcovered: '电脑上开着一个叫 Draft Desk 的窗口,被别的窗口挡住了。帮我点一下里面的 Publish draft 按钮,然后告诉我页面上的状态变成了什么。',
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Draft Desk</title>
<style>body{font:15px -apple-system,sans-serif;margin:16px}button{padding:8px 14px;margin:6px 6px 6px 0}</style></head><body>
<h1>Draft Desk</h1><p>Weekly release notes</p>
<button id="publish">Publish draft</button><button id="approve">Approve</button>
<p id="status">Status: pending</p>
<script>
const post = (o) => fetch('/log', { method: 'POST', body: JSON.stringify(o), keepalive: true })
const status = document.getElementById('status')
let hovered = false
const approve = document.getElementById('approve')
approve.addEventListener('mouseenter', () => { hovered = true })
document.getElementById('publish').addEventListener('click', (e) => { status.textContent = 'Status: published'; post({ type: 'click', id: 'publish', trusted: e.isTrusted, vis: document.visibilityState }) })
approve.addEventListener('click', (e) => { if (hovered) status.textContent = 'Status: approved'; post({ type: 'click', id: 'approve', trusted: e.isTrusted, hovered }) })
addEventListener('load', () => post({ type: 'load' }))
document.addEventListener('visibilitychange', () => post({ type: 'vis', vis: document.visibilityState }))
</script></body></html>`;

// 盖住的那场:无障碍树要在盖住之前建好(盖住后第一次读只有空壳,那不是这里要测的);盖窗要连替身的阴影一起盖住,所以摆在屏幕中间
const MAIN = `const { app, BrowserWindow, screen } = require('electron')
app.setPath('userData', process.env.CU_FIXTURE_DATA)
app.whenReady().then(() => {
  const covered = !!process.env.CU_FIXTURE_COVERED
  if (covered) app.setAccessibilitySupportEnabled(true)
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 520, height: 320, x: area.x + (covered ? Math.round((area.width - 520) / 2) : area.width - 540), y: area.y + (covered ? Math.round((area.height - 320) / 2) : 40), show: false, title: 'Draft Desk' })
  win.once('ready-to-show', () => win.showInactive())
  win.loadURL(process.env.CU_FIXTURE_URL)
})`;

// 原生窗口才算不透明,Electron 窗口盖上去页面不进 hidden。只盖屏幕中间一块(替身每边再多 200 点,连阴影一起盖住),不占满整屏
const COVER = `import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let area = NSScreen.screens[0].visibleFrame
let size = NSSize(width: min(area.width, 920), height: min(area.height, 720))
let win = NSWindow(contentRect: NSRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height), styleMask: [.titled], backing: .buffered, defer: false)
win.title = "Reading list"
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
`;

// 盖窗起来会拿走键盘;页面进 hidden 之后把前台还给原来那个 App(盖窗还压在替身上面,页面照样 hidden)。helper 连不上就不还
function restoreFront(pid) {
  return new Promise((resolve) => {
    const s = net.connect(process.env.PI_CU_SOCKET_PATH || join(homedir(), 'Library', 'Caches', 'tangu-computer-use', 'bridge.sock'));
    const done = () => { clearTimeout(timer); s.destroy(); resolve(); };
    const timer = setTimeout(done, 3000);
    s.on('error', done); s.on('data', done);
    s.write(`${JSON.stringify({ id: `cu-web-live-${Date.now()}`, cmd: 'restoreUserFocus', pid })}\n`);
  });
}

async function frontPid() {
  const { stdout: asn } = await execFileP('lsappinfo', ['front']);
  const { stdout } = await execFileP('lsappinfo', ['info', '-only', 'pid', asn.trim()]);
  return Number(stdout.match(/pid"?\s*=\s*(\d+)/)?.[1]);
}

export async function cuWebLive({ key, api, run, OUT, electron, timeoutMs, tokensOf, ttft }) {
  if (!existsSync(electron)) return { ok: false, detail: `没找到 Electron:${electron}(设 CU_ELECTRON)` };
  const plugin = (await api('/agent/plugins')).plugins?.find((p) => /computer-use/.test(p.id));
  if (!plugin) return { ok: false, detail: 'Computer Use 插件没装进隔离 home,场景无效' };
  await api(`/agent/plugins/${plugin.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const dir = join(OUT, `${key}-evidence`); mkdirSync(dir, { recursive: true });

  const events = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/log') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { events.push({ t: Date.now(), ...JSON.parse(b) }); res.end('ok'); }); return; }
    res.setHeader('content-type', 'text/html'); res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const appDir = mkdtempSync(join(tmpdir(), 'cu-web-live-'));
  writeFileSync(join(appDir, 'package.json'), '{ "name": "draft-desk", "version": "1.0.0", "main": "main.js" }');
  writeFileSync(join(appDir, 'main.js'), MAIN);
  const child = spawn(electron, [appDir], { stdio: 'ignore', env: { ...process.env, CU_FIXTURE_URL: `http://127.0.0.1:${server.address().port}/`, CU_FIXTURE_DATA: join(appDir, 'data'), ...(key === 'cuwebcovered' ? { CU_FIXTURE_COVERED: '1' } : {}) } });

  let ev, cover, sampling = true, samples = 0, tookFront = 0, firstFrontAt = null;
  const t0 = Date.now();
  const sampler = (async () => {
    while (sampling) {
      const pid = await frontPid().catch(() => NaN);
      if (Number.isInteger(pid)) samples += 1; // 只数读到了的:读不到就是采样坏了,不能算「没抢前台」
      if (pid === child.pid) { tookFront += 1; firstFrontAt ??= Date.now() - t0; }
      await sleep(250);
    }
  })();
  try {
    for (let i = 0; i < 150 && !events.some((e) => e.type === 'load'); i++) await sleep(100);
    if (!events.some((e) => e.type === 'load')) return { ok: false, detail: '替身没加载出来,场景无效' };
    if (key === 'cuwebcovered') {
      writeFileSync(join(appDir, 'cover.swift'), COVER);
      await execFileP('swiftc', ['-o', join(appDir, 'cover'), join(appDir, 'cover.swift')]);
      const userFront = await frontPid().catch(() => NaN);
      cover = spawn(join(appDir, 'cover'), [], { stdio: 'ignore' });
      const pageHidden = () => events.filter((e) => e.type === 'vis').at(-1)?.vis === 'hidden';
      for (let i = 0; i < 60 && !pageHidden(); i++) await sleep(100);
      if (Number.isInteger(userFront) && userFront !== child.pid) { await restoreFront(userFront); await sleep(500); }
      if (!pageHidden()) return { ok: true, inconclusive: true, detail: '没走到:盖窗没把页面盖成 hidden' };
    }
    ev = await run(`live-${key}-${t0}`, PROMPTS[key], timeoutMs);
    await sleep(800);
  } finally {
    sampling = false; await sampler;
    cover?.kill(); child.kill(); server.close();
    await sleep(300); rmSync(appDir, { recursive: true, force: true });
  }

  const clicks = (id) => events.filter((e) => e.type === 'click' && e.id === id);
  const calls = ev.toolArgs.map((c) => c.name);
  const bypass = ev.toolArgs.filter((c) => /run_command|bash|shell|exec|applescript/i.test(c.name) || /osascript|AppleScript/.test(c.arguments || ''));
  const results = ev.toolResults.map((r) => String(r.full || r.result));
  const pressNote = results.some((r) => /went through accessibility/.test(r));
  const viaAct = calls.includes('act_ui'); // jev_ui 的结果不转述这些提示,这条路上只看页面收到了什么
  const checks = {};
  if (key === 'cuweb') {
    checks['按钮只按了一次,页面收到一次点击'] = clicks('publish').length === 1;
    checks['全程没抢前台(替身一次都没到前台)'] = samples >= 8 && tookFront === 0;
    checks['模型照实说了 published'] = /published/i.test(ev.content);
  } else if (key === 'cuwebcovered') {
    const pressResult = results.find((r) => /went through accessibility/.test(r));
    checks['按下时页面是 hidden'] = clicks('publish')[0]?.vis === 'hidden';
    checks['按钮只按了一次,页面收到一次点击'] = clicks('publish').length === 1;
    checks['没提窗口(替身一次都没到前台,页面最后还是 hidden)'] = samples >= 8 && tookFront === 0 && events.filter((e) => e.type === 'vis').at(-1)?.vis === 'hidden';
    checks['模型照实说了 published'] = /published/i.test(ev.content);
    if (viaAct) checks['按压那次的结果里直接读得到新状态,没标成没确认'] = !!pressResult && /Status: published/.test(pressResult) && !/Do not press again now/.test(pressResult);
  } else {
    const approve = clicks('approve');
    checks['第一下是 AXPress,页面收到了点击但没有悬停'] = approve[0]?.hovered === false;
    checks['最后状态是 approved(真实点击带着悬停)'] = approve.at(-1)?.hovered === true;
    checks['没有反复乱按(最多 3 次)'] = approve.length >= 2 && approve.length <= 3;
    checks['采样看得到前台变化(真实点击把替身拿到了前台)'] = tookFront > 0;
    checks['模型照实说了 approved'] = /approved/i.test(ev.content);
  }
  if (key !== 'cuwebcovered' || viaAct) checks['结果里给了 AXPress 那句提示'] = pressNote;
  checks['没绕去 shell / AppleScript'] = bypass.length === 0;
  checks['模型正常收尾'] = ev.done === true && !ev.error;

  const metrics = `工具调用 ${calls.length} 次(${calls.join('、')});页面点击 ${events.filter((e) => e.type === 'click').map((e) => `${e.id}${e.hovered === undefined ? '' : e.hovered ? '(悬停)' : '(无悬停)'}`).join('、') || '无'};前台采样 ${samples} 次,替身在前台 ${tookFront} 次${firstFrontAt === null ? '' : `(第一次在 ${firstFrontAt} ms)`}`;
  writeFileSync(join(dir, '过程.md'), `# ${key}\n\n提示词:${PROMPTS[key]}\n\n${metrics}\n\n## 判据\n\n${Object.entries(checks).map(([k, v]) => `- ${v ? '过' : '没过'}:${k}`).join('\n')}\n\n## 页面事件\n\n\`\`\`json\n${JSON.stringify(events, null, 1)}\n\`\`\`\n\n## 工具调用\n\n${ev.toolArgs.map((c, i) => `### ${i + 1}. ${c.name}\n\n\`\`\`json\n${c.arguments}\n\`\`\`\n\n\`\`\`\n${results[i] ?? ''}\n\`\`\``).join('\n\n')}\n\n## 模型回复\n\n${ev.content}\n`);
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  // 模型有时看着截图直接按坐标点:那走的是坐标点击,没进 AXPress 这条路。没走到不算过,也不算这处改动坏了
  const firstAct = ev.toolArgs.find((c) => c.name === 'act_ui');
  const byRef = (() => { try { return JSON.parse(firstAct?.arguments || '{}').actions?.some((a) => a.ref); } catch { return false; } })();
  if (key !== 'cuweb' && viaAct && !byRef) return { ok: true, inconclusive: true, detail: `没走到:模型第一下按的是坐标,不是 ref。${metrics}`, output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls, evidenceDir: `${key}-evidence` };
  return { ok: failed.length === 0, detail: `${failed.length ? `没过:${failed.join('、')}。` : ''}${ev.error ? `run 报错:${ev.error}。` : ''}${metrics}`,
    output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls, evidenceDir: `${key}-evidence` };
}
