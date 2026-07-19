/**
 * 云工作区文件工具:list_files / read_file / write_file(execute 体从 registry.ts 原样搬移)。
 * mode:'sandbox' —— host 模式由 hostExec 的真实 FS 工具覆盖。
 */
import {
  listFiles, readFile, writeFile,
  listFilesLocal, readFileLocal, writeFileLocal, scopeOf } from '../fileWorkspace.js';
import { getSessionDir, markSessionDirty } from '../../sandbox/sessionSandbox.js';
import type { ToolProvider } from '../toolRegistry.js';

export const workspaceFilesProvider: ToolProvider = {
  id: 'builtin:workspace-files',
  tools: () => [
    {
      name: 'list_files',
      mode: 'sandbox',
      definition: {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List the files and subdirectories under a directory in the agent workspace.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: "Directory path, root is '/'" } },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        const p = String(args.path ?? '/');
        const dir = await getSessionDir(ctx).catch(() => null);
        return dir ? listFilesLocal(dir, p) : listFiles(ctx.userId, ctx.appId, scopeOf(ctx), p);
      },
    },
    {
      name: 'read_file',
      mode: 'sandbox',
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read the text content of a file in the agent workspace. For large files, use offset/limit to read by line in pages. ' +
            'Output is cat -n style: every line is prefixed with its line number and a tab. When you feed text back to apply_patch, strip that "<number>\\t" prefix — a patch\'s context/old lines must match the file\'s RAW text.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path, e.g. /notes/a.txt' },
              offset: { type: 'number', description: 'Starting line (0-based), default 0' },
              limit: { type: 'number', description: 'Maximum number of lines to return (default reads to the end, capped at a limit)' },
            },
            required: ['path'],
          },
        },
      },
      execute: async (args, ctx) => {
        const p = String(args.path ?? '');
        const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) >= 0 ? Number(args.offset) : undefined;
        const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : undefined;
        const dir = await getSessionDir(ctx).catch(() => null);
        return dir
          ? readFileLocal(dir, p, offset, limit)
          : readFile(ctx.userId, ctx.appId, scopeOf(ctx), p, offset, limit);
      },
    },
    {
      name: 'write_file',
      mode: 'sandbox',
      definition: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write/overwrite a text file in the agent workspace (intermediate directories are created automatically). ' +
            'Use this ONLY to create a new file or when replacing essentially all of an existing one. To change part of an existing file, use apply_patch and touch only the affected lines — do NOT re-read a file and re-emit the whole thing just to make a small change.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path, e.g. /out/result.py' },
              content: { type: 'string', description: 'Text content of the file' },
            },
            required: ['path', 'content'],
          },
        },
      },
      execute: async (args, ctx) => {
        const p = String(args.path ?? '');
        const content = String(args.content ?? '');
        const dir = await getSessionDir(ctx).catch(() => null);
        if (dir) {
          const r = await writeFileLocal(dir, p, content);
          markSessionDirty(ctx); // 标脏 → run 末 snapshot 选择性回写
          return r;
        }
        return writeFile(ctx.userId, ctx.appId, scopeOf(ctx), p, content);
      },
    },
  ],
};
