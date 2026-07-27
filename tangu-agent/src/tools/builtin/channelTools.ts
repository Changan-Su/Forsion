/**
 * 通道媒体发送工具:在通道会话(微信/Telegram/QQ)里把工作区的文件/图片发回给连接的用户。
 * 07-25 由 wechat_send_* 改名 channel_send_*(通道通用化后旧名不再准确)。实现经 channelHub
 * 按会话活跃绑定解析所属通道。仅 hostExec profile **且当前会话连接着通道**(ctx.channelSession,
 * loop 每 run 预查)时暴露——未接通道的会话不背这两个定义(P0-3)。
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
  if (!r.ok) return `Error: 发送到通道失败:${r.error || 'unknown error'}`;
  return `已把${kind === 'image' ? '图片' : '文件'}「${fileName}」(${(buf.length / 1024).toFixed(0)} KB)发送到当前通道会话连接的用户。`;
}

export const channelToolsProvider: ToolProvider = {
  id: 'builtin:channel-tools',
  tools: () => [
    {
      name: 'channel_send_file',
      mode: 'host',
      isEnabledFor: (profile, ctx) => profile.capabilities.hostExec && !!ctx.channelSession,
      capabilities: { sideEffect: 'network', parallel: false, concurrencyKey: 'channel-send', defaultTimeoutMs: 130_000 },
      definition: {
        type: 'function',
        function: {
          name: 'channel_send_file',
          description:
            'Send a file from the workspace as a "file" to the chat-channel user (WeChat/Telegram/QQ) connected to the current channel session. Only works in a channel session (created when a channel is connected); calling it in a normal session returns "channel not connected". path is relative to the working directory or an absolute path; any type (document/archive/audio etc.), up to 50MB. To display an image inline, use channel_send_image instead.',
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
      name: 'channel_send_image',
      mode: 'host',
      isEnabledFor: (profile, ctx) => profile.capabilities.hostExec && !!ctx.channelSession,
      capabilities: { sideEffect: 'network', parallel: false, concurrencyKey: 'channel-send', defaultTimeoutMs: 130_000 },
      definition: {
        type: 'function',
        function: {
          name: 'channel_send_image',
          description:
            'Send an image from the workspace inline as an "image" bubble to the chat-channel user (WeChat/Telegram/QQ) connected to the current channel session. Only works in a channel session. path is relative to the working directory or an absolute path; good for screenshots/charts/generated images (png/jpg/gif etc.), up to 50MB. For non-images or to keep the original filename, use channel_send_file.',
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
