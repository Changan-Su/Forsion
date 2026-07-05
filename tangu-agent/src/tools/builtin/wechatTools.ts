/**
 * 微信远程发送工具:在「微信远程」会话里把工作区的文件/图片发回给连接的微信用户。
 * 仅 hostExec profile 暴露(本地形态);执行时经会话的活跃绑定解析微信联系人,
 * 非微信会话(无绑定)优雅报错。底层走 iLink getuploadurl + CDN 密文上传 + sendmessage。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { wechatRemote } from '../../services/wechatRemote.js';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50MB;超过 iLink 普遍拒收

function resolveInCwd(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.cwd || process.cwd(), String(p || ''));
}

async function sendMedia(ctx: ToolContext, rawPath: string, kind: 'image' | 'file'): Promise<string> {
  const rel = String(rawPath || '').trim();
  if (!rel) return 'Error: path is required';
  const abs = resolveInCwd(ctx, rel);
  let buf: Buffer;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return `Error: 不是文件:${rel}`;
    if (st.size === 0) return `Error: 文件为空:${rel}`;
    if (st.size > MAX_MEDIA_BYTES) return `Error: 文件过大(${(st.size / 1048576).toFixed(1)}MB),上限 ${MAX_MEDIA_BYTES / 1048576}MB`;
    buf = await fs.readFile(abs);
  } catch (e: any) {
    return `Error: 无法读取文件 ${rel}:${e?.message || e}`;
  }
  const fileName = path.basename(abs);
  const r = await wechatRemote.sendMediaForSession(ctx.userId, ctx.sessionId, buf, { kind, fileName }, ctx.signal);
  if (!r.ok) return `Error: 发送到微信失败:${r.error || 'unknown error'}`;
  return `已把${kind === 'image' ? '图片' : '文件'}「${fileName}」(${(buf.length / 1024).toFixed(0)} KB)发送到当前微信会话连接的用户。`;
}

export const wechatToolsProvider: ToolProvider = {
  id: 'builtin:wechat-tools',
  tools: () => [
    {
      name: 'wechat_send_file',
      mode: 'host',
      isEnabledFor: (profile) => profile.capabilities.hostExec,
      capabilities: { sideEffect: 'network', parallel: false, concurrencyKey: 'wechat-send', defaultTimeoutMs: 130_000 },
      definition: {
        type: 'function',
        function: {
          name: 'wechat_send_file',
          description:
            'Send a file from the workspace as a "file" to the WeChat user connected to the current WeChat session. Only works in a "WeChat Remote" session (WeChat connected via QR scan); calling it in a normal session returns "WeChat not connected". path is relative to the working directory or an absolute path; any type (document/archive/audio etc.), up to 50MB. To display an image inline, use wechat_send_image instead.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path of the file to send (relative to the working directory or an absolute path)' },
            },
            required: ['path'],
          },
        },
      },
      execute: (args, ctx) => sendMedia(ctx, String(args.path ?? ''), 'file'),
    },
    {
      name: 'wechat_send_image',
      mode: 'host',
      isEnabledFor: (profile) => profile.capabilities.hostExec,
      capabilities: { sideEffect: 'network', parallel: false, concurrencyKey: 'wechat-send', defaultTimeoutMs: 130_000 },
      definition: {
        type: 'function',
        function: {
          name: 'wechat_send_image',
          description:
            'Send an image from the workspace inline as an "image" bubble to the WeChat user connected to the current WeChat session. Only works in a "WeChat Remote" session. path is relative to the working directory or an absolute path; good for screenshots/charts/generated images (png/jpg/gif etc.), up to 50MB. For non-images or to keep the original filename, use wechat_send_file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path of the image to send (png/jpg/gif etc.)' },
            },
            required: ['path'],
          },
        },
      },
      execute: (args, ctx) => sendMedia(ctx, String(args.path ?? ''), 'image'),
    },
  ],
};
