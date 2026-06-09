/**
 * Markdown → 终端 ANSI 渲染（finalized 的 assistant 文本用；流式中用纯文本以保性能）。
 * marked + marked-terminal（内含 cli-highlight 代码高亮）。渲染失败回退原文。
 */
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  try {
    const width = Math.min(process.stdout.columns || 80, 100);
    marked.use(markedTerminal({ width, reflowText: true, tab: 2 }) as any);
  } catch {
    /* 退回 marked 默认 */
  }
  configured = true;
}

export function renderMarkdown(md: string): string {
  if (!md || !md.trim()) return md || '';
  ensureConfigured();
  try {
    const out = marked.parse(md, { async: false }) as string;
    return out.replace(/\s+$/, ''); // 去尾部多余换行，避免气泡间空隙过大
  } catch {
    return md;
  }
}
