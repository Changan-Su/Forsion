/**
 * `tangu-chat login` —— codex 式浏览器登录(OAuth device flow 客户端)。
 *   POST /api/auth/cli/start → 出链接 + user_code → 开浏览器 → 轮询 /api/auth/cli/poll → 拿 token 存本地。
 * 用户只需点链接、在浏览器登录批准;token 自动回到 CLI,不用手动复制。
 */
import { spawn } from 'node:child_process';
import { saveCreds, loadCreds } from '../standalone/credStore.js';

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {}); // 打不开就让用户手动复制链接
    p.unref();
  } catch {
    /* ignore */
  }
}

export async function loginFlow(cloudUrl: string): Promise<void> {
  if (!cloudUrl) {
    console.error(red('  首次登录需指定 --cloud-url(如 --cloud-url https://api.forsion.net)'));
    process.exit(1);
  }
  const base = cloudUrl.replace(/\/+$/, '');
  let start: any;
  try {
    start = await fetch(`${base}/api/auth/cli/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
  } catch (e: any) {
    console.error(red(`  无法连接 ${base}: ${e?.message || e}`));
    process.exit(1);
  }

  const url = start.verification_uri_complete || `${start.verification_uri}?code=${start.user_code}`;
  console.log(`\n  ${cyan('在浏览器打开此链接登录')}(已尝试自动打开):`);
  console.log(`  ${url}`);
  console.log(dim(`  验证码: ${start.user_code}`));
  process.stdout.write(dim('  等待授权'));
  openBrowser(url);

  const deadline = Date.now() + (start.expires_in || 600) * 1000;
  const interval = (start.interval || 2) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let resp: Response | null = null;
    try {
      resp = await fetch(`${base}/api/auth/cli/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: start.device_code }) });
    } catch {
      continue;
    }
    if (resp.status === 410) { console.error(red('\n  登录码已过期,请重试 `tangu login`')); process.exit(1); }
    const j: any = await resp.json().catch(() => ({ status: 'pending' }));
    if (j.status === 'approved' && j.token) {
      saveCreds({ ...loadCreds(), cloudUrl: base, token: j.token }); // 保留已记住的 model
      console.log(green('\n  ✓ 已登录') + dim(',凭证存于 ~/.tangu/auth.json'));
      console.log(dim('  现在直接 `tangu` 进入 TUI(无需 --token / --cloud-url;进去用 /model 选模型)。\n'));
      return;
    }
    process.stdout.write(dim('.'));
  }
  console.error(red('\n  登录超时,请重试 `tangu login`'));
  process.exit(1);
}
