/**
 * apply_patch 工具 provider:上下文锚定的多文件/多 hunk 结构化编辑,**云端与 host 模式共用**
 * (mode:'both')——补上云端「只有 write_file 全量覆盖、无精确编辑」的洞,并替代 host 的单串替换。
 *
 * 原子性:先在内存里把所有目标算出新内容(任一 hunk 定位失败立即整体放弃,不落盘),全部成功后才落 IO。
 * 解析/应用纯逻辑在 ../applyPatch.ts(可单测);本文件只做后端 IO 适配(host 真实 FS / 云工作区)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePatch, applyHunksToContent } from '../applyPatch.js';
import { resolvePath } from '../hostExec.js';
import { checkWritePath } from '../fsPolicy.js';
import { getSessionDir, markSessionDirty } from '../../sandbox/sessionSandbox.js';
import { readFileRawLocal, writeFileLocal, writeFile, readWorkspaceFileRaw, scopeOf } from '../fileWorkspace.js';
import type { ToolContext } from '../toolTypes.js';
import type { ToolProvider } from '../toolRegistry.js';

// ── 后端读写适配:host = 真实 FS(相对 cwd);sandbox = 云工作区(本地 per-run 目录优先,否则 Penzor)──

async function backendRead(ctx: ToolContext, p: string): Promise<string | null> {
  if (ctx.execMode === 'host') {
    try { return await fs.readFile(resolvePath(ctx, p), 'utf-8'); } catch { return null; }
  }
  const dir = await getSessionDir(ctx).catch(() => null);
  if (dir) return readFileRawLocal(dir, p);
  const raw = await readWorkspaceFileRaw(ctx.userId, ctx.appId, scopeOf(ctx), p);
  return raw ? raw.content.toString('utf-8') : null;
}

async function backendWrite(ctx: ToolContext, p: string, content: string): Promise<void> {
  if (ctx.execMode === 'host') {
    const abs = resolvePath(ctx, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return;
  }
  const dir = await getSessionDir(ctx).catch(() => null);
  if (dir) { await writeFileLocal(dir, p, content); markSessionDirty(ctx); return; }
  await writeFile(ctx.userId, ctx.appId, scopeOf(ctx), p, content);
}

async function backendDelete(ctx: ToolContext, p: string): Promise<void> {
  // 仅 host(execute 已挡掉云端 Delete/Move);真实 FS 删除。
  await fs.rm(resolvePath(ctx, p), { force: true });
}

const PATCH_DESC =
  'Make structured patch edits to one or more files (context-anchored, better than full overwrite / single-string replace; multiple files and multiple edits in one atomic commit). ' +
  'The patch parameter is a block of patch text, in the format:\n' +
  '*** Begin Patch\n' +
  '*** Update File: relative path\n' +
  '@@ optional locating context (class/function name)\n' +
  ' unchanged context line (leading space)\n' +
  '-line to delete\n' +
  '+line to add\n' +
  '*** Add File: relative path\n' +
  '+every line of the new file (each starts with +)\n' +
  '*** Delete File: relative path\n' +
  '*** End Patch\n' +
  'Key points: always include a few unchanged context lines (starting with a space) around each change to locate it; use Add to create, Delete to remove, ' +
  'and to rename put a line "*** Move to: new path" right under Update File. The cloud workspace currently supports only Add/Update.';

export const applyPatchProvider: ToolProvider = {
  id: 'builtin:apply-patch',
  tools: () => [
    {
      name: 'apply_patch',
      mode: 'both',
      capabilities: { sideEffect: 'write', parallel: false },
      definition: {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: PATCH_DESC,
          parameters: {
            type: 'object',
            properties: { patch: { type: 'string', description: 'Complete patch text (*** Begin Patch … *** End Patch)' } },
            required: ['patch'],
          },
        },
      },
      execute: async (args, ctx): Promise<string> => {
        const patchText = String(args.patch ?? args.input ?? '');
        if (!patchText.trim()) return 'Error: patch is required';

        let ops;
        try {
          ops = parsePatch(patchText);
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }

        const host = ctx.execMode === 'host';
        // 内存阶段:算出所有写/删,任一失败整体放弃(不落 IO)。
        const writes = new Map<string, string>();
        const deletes = new Set<string>();
        const summary: string[] = [];

        for (const op of ops) {
          if (op.kind === 'add') {
            const cur = writes.has(op.path) ? writes.get(op.path)! : await backendRead(ctx, op.path);
            if (cur !== null && cur !== undefined) return `Error: Add File 目标已存在(改用 Update File):${op.path}`;
            writes.set(op.path, op.content);
            deletes.delete(op.path);
            summary.push(`added ${op.path}`);
          } else if (op.kind === 'delete') {
            if (!host) return `Error: 云端工作区暂不支持 Delete File:${op.path}`;
            writes.delete(op.path);
            deletes.add(op.path);
            summary.push(`deleted ${op.path}`);
          } else {
            // update(可含 move)
            if (op.movePath && !host) return `Error: 云端工作区暂不支持 Move(*** Move to):${op.path}`;
            const cur = writes.has(op.path) ? writes.get(op.path)! : await backendRead(ctx, op.path);
            if (cur === null || cur === undefined) return `Error: Update File 目标不存在(新建用 Add File):${op.path}`;
            let next: string;
            try {
              next = applyHunksToContent(cur, op.hunks);
            } catch (e: any) {
              return `Error: ${e?.message || e}(文件 ${op.path})`;
            }
            const target = op.movePath || op.path;
            writes.set(target, next);
            if (op.movePath) {
              writes.delete(op.path);
              deletes.add(op.path);
              summary.push(`moved ${op.path} → ${op.movePath}`);
            } else {
              summary.push(`updated ${op.path}`);
            }
          }
        }

        // 落盘前校验:host 写/删目标若命中受保护路径 → 整体硬拒(此时尚无任何 IO)。
        if (host) {
          for (const p of [...writes.keys(), ...deletes]) {
            const guard = checkWritePath(ctx, resolvePath(ctx, p));
            if (guard.hardDeny) return `Error: ${guard.reason}`;
          }
        }

        // 落 IO。ponytail: 跨文件无事务,极端下多文件中途失败可能半写;与现有多文件写一致,可接受。
        try {
          for (const [p, content] of writes) await backendWrite(ctx, p, content);
          for (const p of deletes) await backendDelete(ctx, p);
        } catch (e: any) {
          return `Error: 写入失败:${e?.message || e}`;
        }
        return `applied patch: ${writes.size + deletes.size} file(s) [${summary.join('; ')}]`;
      },
    },
  ],
};
