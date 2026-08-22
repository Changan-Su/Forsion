/**
 * 大工具输出落盘：超过 INLINE_LIMIT 的输出写进会话工作区 /.agent/outputs/，上下文只回
 * 「预览（头+尾）+ 路径」，模型用 read_file 按需取全文。避免丢数据 + 上下文膨胀。
 * (从 registry.ts 原样抽出,供 builtin providers 共用。)
 */
import { promises as nfs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileLocal } from './fileWorkspace.js';
import { getSessionDir, markSessionDirty } from '../sandbox/sessionSandbox.js';
import type { ToolContext } from './toolTypes.js';

const INLINE_LIMIT = 8000; // 与 agentLoop.trimStaleToolMessages 的 8000 对齐：落盘后的预览永不再被截
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 1000; // 尾部留住 traceback / exit_code 行
let outputSeq = 0;

/** 超限则把全文落盘到会话工作区，返回预览+路径；否则原样返回。FS 故障降级为纯截断（不硬失败）。 */
export async function persistLargeOutput(
  ctx: ToolContext,
  label: string,
  fullText: string,
): Promise<{ preview: string; path: string | null }> {
  if (fullText.length <= INLINE_LIMIT) return { preview: fullText, path: null };
  // host 模式:sandbox 会话目录 + "/.agent/…" 相对路径这套对 host 的 read_file(hostExec 真实
  // FS,相对路径解析到 cwd)不可达 → 落 OS tmpdir、返回**绝对路径**(host read_file 收绝对路径;
  // 目录归 OS 清理,不自建生命周期)。browser_* 是 host-only,这是它们唯一会走到的分支。
  if (ctx.execMode === 'host') {
    try {
      // 目录名带 uid:多用户 Linux 上共享 /tmp,别人先建同名目录会 EACCES(同 browserSocketDir 的纪律)
      let uid = '';
      try { uid = String(process.getuid?.() ?? ''); } catch { /* ignore */ }
      const dir = path.join(tmpdir(), uid ? `tangu-tool-outputs-${uid}` : 'tangu-tool-outputs');
      await nfs.mkdir(dir, { recursive: true });
      const abs = path.join(dir, `${label}-${ctx.runId || 'run'}-${++outputSeq}.txt`);
      await nfs.writeFile(abs, fullText, 'utf-8');
      return { preview: makePreview(fullText), path: abs };
    } catch {
      return { preview: fullText.slice(0, INLINE_LIMIT * 2), path: null };
    }
  }
  let dir: string;
  try {
    dir = await getSessionDir(ctx);
  } catch {
    return { preview: fullText.slice(0, INLINE_LIMIT * 2), path: null };
  }
  const sub = `/.agent/outputs/${label}-${ctx.runId || 'run'}-${++outputSeq}.txt`;
  try {
    await writeFileLocal(dir, sub, fullText);
    markSessionDirty(ctx); // run 末 snapshot 回流 Penzor
  } catch {
    return { preview: fullText.slice(0, INLINE_LIMIT * 2), path: null };
  }
  return { preview: makePreview(fullText), path: sub };
}

function makePreview(fullText: string): string {
  const omitted = Math.max(0, fullText.length - PREVIEW_HEAD - PREVIEW_TAIL);
  return fullText.slice(0, PREVIEW_HEAD) + `\n…[省略 ${omitted} 字符]…\n` + fullText.slice(-PREVIEW_TAIL);
}

/** 把（可能很大的）工具输出整理成回给模型的字符串：小则原样，大则预览+落盘路径提示。 */
export async function formatToolOutput(ctx: ToolContext, label: string, fullText: string): Promise<string> {
  const { preview, path } = await persistLargeOutput(ctx, label, fullText);
  if (!path) return preview;
  return `${preview}\n\n[完整输出已存到 ${path} — 用 read_file 配 offset/limit 读取更多]`;
}
