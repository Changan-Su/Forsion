/** TUI 的「运行中排队」(对齐 Codex / 桌面端):运行中或压缩中发的消息与改动运行的命令排到本轮结束后按先后执行。 */
import { COMMAND_CATALOG, canonicalCommandName } from '../core/commandCatalog.js';

/** 会改动运行 / 会话的命令:不许与在跑的 run 或压缩并发,只能排队。 */
export const RUN_AFFECTING = new Set(['/new', '/resume', '/retry', '/compact', '/branch', '/edit', '/delete', '/refine']);

const BUILTIN = new Set(COMMAND_CATALOG.map((c) => c.name));

/**
 * 这一行要不要进队:忙(run / 压缩)或队里还有东西时,普通消息、改动运行的命令、用户自定义命令(展开即消息)都排队;
 * 其余内置命令(/help、/model、/queue…)照常立即执行。
 */
export function mustQueue(line: string, busy: boolean, queued: number): boolean {
  if (!busy && queued === 0) return false;
  if (!line.startsWith('/')) return true;
  const cmd = canonicalCommandName((line.split(/\s/, 1)[0] || '').toLowerCase());
  return RUN_AFFECTING.has(cmd) || !BUILTIN.has(cmd);
}

/** 空闲时逐条取出执行;某条让它重新忙起来(起了 run / 开始压缩)就停,等下一次收尾再取。
 *  一条失败只报错、接着取下一条(调用方是 `void`,抛出去就是未处理的 rejection,会带崩进程)。 */
export async function drainQueue(
  q: { idle(): boolean; take(): string | undefined },
  run: (line: string) => Promise<void>,
  onError: (line: string, e: unknown) => void,
): Promise<void> {
  while (q.idle()) {
    const next = q.take();
    if (next === undefined) return;
    try { await run(next); } catch (e) { onError(next, e); }
  }
}
