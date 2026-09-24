/**
 * 台架用:以 --remote-debugging-pipe 起一个**临时**Chrome(独立 user-data-dir,绝不碰用户的 Chrome),
 * 经管道 CDP 装载未打包扩展(Extensions.loadUnpacked;Chrome 137+ 已不认 --load-extension)。
 * 管道协议:fd3 写、fd4 读,每条 JSON 以 \0 结尾。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME_BIN = process.env.CHROME_BIN || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform] || 'google-chrome';

export async function launchChromePipe({ url = 'about:blank', headless = true, userDataDir } = {}) {
  if (process.platform !== 'linux' && !existsSync(CHROME_BIN)) throw new Error(`找不到 Chrome:${CHROME_BIN}(用 CHROME_BIN 指定)`);
  const udd = userDataDir || mkdtempSync(join(tmpdir(), 'tangu-chrome-'));
  const args = ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check'];
  if (headless) args.unshift('--headless=new');
  const child = spawn(CHROME_BIN, [...args, url], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const out = child.stdio[3];
  const inp = child.stdio[4];
  let buf = '';
  let seq = 0;
  const pending = new Map();
  inp.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20_000);
    pending.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result); });
    out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  // 等浏览器就绪(第一条命令能回就行)
  for (let i = 0; i < 50; i++) { try { await cdp('Browser.getVersion'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  return { child, cdp, userDataDir: udd, kill: () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } } };
}

/** 给装好的扩展写配对(等价于用户在弹窗里粘贴连接码):附着到扩展的 service worker,在里面 chrome.storage.local.set。 */
export async function pairExtension(chrome, extensionId, pairing) {
  let sw = null;
  for (let i = 0; i < 50 && !sw; i++) {
    const { targetInfos } = await chrome.cdp('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
    if (!sw) await new Promise((r) => setTimeout(r, 200));
  }
  if (!sw) throw new Error('扩展的 service worker 没起来');
  const { sessionId } = await chrome.cdp('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const r = await chrome.cdp('Runtime.evaluate', { expression: `chrome.storage.local.set(${JSON.stringify({ pairing })}).then(() => 'ok')`, awaitPromise: true, returnByValue: true }, sessionId);
  if (r?.result?.value !== 'ok') throw new Error(`写配对失败:${JSON.stringify(r).slice(0, 200)}`);
  await chrome.cdp('Target.detachFromTarget', { sessionId });
}
