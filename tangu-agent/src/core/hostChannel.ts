/**
 * 桌面主进程 → 托管引擎的私有通道:stdin,一行一条 JSON。只在桌面拉起时启用(backendManager 把 stdin 接成管道、
 * 设 FORSION_HOST_STDIN=1);独立 CLI / TUI / Docker 不碰 stdin。
 *
 * 为什么是 stdin 而不是 env / HTTP:
 *  - 电脑历史的钥匙可能在引擎起来**之后**才有(新装用户在首启引导里点「开始使用」才打开电脑历史),env 只能在 spawn 时给,
 *    要换就得重起引擎(会断掉在跑的会话);
 *  - HTTP 路由用的本机令牌渲染层与设备页反代(unitWeb /engine)也拿得到;stdin 只有拉起它的主进程能写,
 *    不出现在 ps / 工具子进程环境里。
 * 引擎自己起的子进程默认各有各的 stdin 管道(没有 stdio:'inherit' 的服务端路径),拿不到这条。
 *
 * 消息:{"computerHistoryKey":"<64 位 hex>"}(主进程每次拉起引擎、以及钥匙第一次就绪时各发一次)。认不出的行忽略。
 */
import { setComputerHistoryKey } from '../services/computerHistoryCrypto.js';

export const HOST_STDIN_ENV = 'FORSION_HOST_STDIN';
/** 单行上限:正常消息不到 200 字节;超了说明对端不是桌面主进程,整段丢掉。 */
const MAX_LINE = 16 * 1024;

type Input = NodeJS.ReadableStream & { unref?: () => void; setEncoding?: (e: BufferEncoding) => unknown };

export function handleHostMessage(line: string): void {
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;
  if ('computerHistoryKey' in m && !setComputerHistoryKey(m.computerHistoryKey)) {
    console.warn('[tangu] host channel: ignored a malformed computer history key');
  }
}

/** 启用了就开始读并返回 true。env 里的开关读完即删:引擎再起的子进程(外部 ACP 引擎、另一个 tangu)不该去读它们自己的 stdin。 */
export function startHostChannel(input: Input = process.stdin as Input, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[HOST_STDIN_ENV] !== '1') return false;
  delete env[HOST_STDIN_ENV];
  let buf = '';
  input.setEncoding?.('utf8');
  input.on('data', (chunk: string | Buffer) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    if (buf.length > MAX_LINE) buf = '';
    for (const line of lines) if (line.trim()) handleHostMessage(line);
  });
  input.on('error', () => { /* 主进程那头关了:钥匙已在内存里,不影响 */ });
  input.unref?.(); // 不靠 stdin 撑住事件循环(启动诊断看 beforeExit;主进程退出时管道 EOF 也不该拖住关停)
  return true;
}
