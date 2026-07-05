/**
 * display_file —— 让 agent 把工作区文件「展示」在桌面对话区(图片内联预览、点击放大;其它类型=可点开的文件卡片)。
 * 经 ctx.displayFile 闸:loop 即时 publish 'display_file' 事件给在线桌面端,并在 finalize 时随 assistant 消息落库。
 * 与 view_image 区别:view_image 是给**模型**"看"图(回灌上下文);display_file 是给**用户**看(不进上下文、不计费)。
 * mode 'both':host 会话发绝对路径(桌面经 readHostFile 读字节);sandbox 发工作区相对路径(经 /agent/workspace/read 读)。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolProvider } from '../toolRegistry.js';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};

function mimeForName(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return IMAGE_MIME[ext]; // 只标图片(供前端决定内联缩略图);其它类型由前端按文件名后缀自行判定
}

export const displayFileProvider: ToolProvider = {
  id: 'builtin:display-file',
  tools: () => [
    {
      name: 'display_file',
      mode: 'both',
      definition: {
        type: 'function',
        function: {
          name: 'display_file',
          description:
            'Show a workspace file to the USER inline in the chat (NOT for you to read it). ' +
            'Images render as a clickable thumbnail the user can click to enlarge/zoom; other file types render as a clickable file card that opens a preview. ' +
            'Use this when you want the user to see a file you created or found (an image, a generated chart, a document, etc.). ' +
            'To read/analyze an image yourself, use view_image instead.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace file path to display (relative to cwd, or absolute on local sessions).' },
            },
            required: ['path'],
          },
        },
      },
      execute: async (args, ctx): Promise<string> => {
        const rawPath = String(args.path ?? '').trim();
        if (!rawPath) return 'Error: path is required';
        if (!ctx.displayFile) return 'Error: 当前运行环境不支持在对话区展示文件(缺少展示通道)。';

        if (ctx.execMode === 'host') {
          const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.cwd || process.cwd(), rawPath);
          try {
            const st = await fs.stat(abs);
            if (!st.isFile()) return `Error: 不是文件:${rawPath}`;
          } catch {
            return `Error: file not found: ${rawPath}`;
          }
          const name = path.basename(abs);
          ctx.displayFile({ name, mime: mimeForName(name), path: abs });
          return `已在对话区展示文件「${name}」。`;
        }

        // sandbox:工作区相对路径(去掉前导 ./ 或 /),前端经 /agent/workspace/read 拉字节。
        const rel = rawPath.replace(/^\.?\/+/, '');
        const name = rel.split('/').pop() || rel;
        ctx.displayFile({ name, mime: mimeForName(name), path: rel });
        return `已在对话区展示文件「${name}」。`;
      },
    },
  ],
};
