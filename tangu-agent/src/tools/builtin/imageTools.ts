/**
 * generate_image —— 文生图,把 AI Studio 的生图体验搬到 Tangu(生成→落盘工作区→在对话区内联展示+点击放大)。
 * 模型走 Tangu 现有模型体系(brain.images):Forsion 托管图像模型(/v1/images,含配额计费)或用户自配 provider 的
 * /images/generations(imageModelIds)。未指定 model 时自动取第一个可用生图模型。
 * host 会话把图片写进 cwd/generated/ 并以路径展示(可在工作区找到、无 base64 膨胀);沙箱/无 cwd 时以 dataUrl 内联展示。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';

/** 取第一个可用生图模型 id:云端(modelType=image_gen)优先,其次直连 provider 的 imageModelIds。 */
async function firstImageModelId(appId: string): Promise<string | null> {
  try {
    const m = deps().brain.models;
    let cloud: any[] = [];
    if (m.listModelsForProject) cloud = (await m.listModelsForProject(appId))?.models || [];
    else cloud = (await m.listGlobalModels()) || [];
    const img = cloud.find((x) => x?.id && x.modelType === 'image_gen');
    if (img?.id) return String(img.id);
    for (const p of m.listDirectProviders?.() ?? []) {
      if (p.imageModelIds?.length) return p.imageModelIds[0];
    }
  } catch { /* 列表不可达 → 视作无配置 */ }
  return null;
}

export const imageGenProvider: ToolProvider = {
  id: 'builtin:image-gen',
  tools: () => [
    {
      name: 'generate_image',
      mode: 'both',
      capabilities: { sideEffect: 'network', parallel: false, defaultTimeoutMs: 200_000 },
      definition: {
        type: 'function',
        function: {
          name: 'generate_image',
          description:
            'Generate an image from a text prompt and show it to the user inline in the chat (rendered as a clickable thumbnail they can enlarge). ' +
            'Use when the user asks to draw, paint, illustrate, render, or generate a picture. Write a vivid, concrete English `prompt`. ' +
            'After the image lands, give a one-sentence caption — do NOT re-describe it in detail, and do NOT call display_file afterwards (it is already shown).',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Vivid, concrete description of the image to generate.' },
              size: { type: 'string', description: 'Aspect/size: "1:1" | "2:3" | "3:2" | "16:9" | "9:16". Default "1:1".' },
              n: { type: 'integer', description: 'How many images (1-4). Default 1.' },
              transparent_background: { type: 'boolean', description: 'Transparent background (PNG). Default false.' },
              model: { type: 'string', description: 'Optional image model id override; defaults to the configured/first available image model.' },
            },
            required: ['prompt'],
          },
        },
      },
      execute: async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) return 'Error: prompt is required';
        if (!ctx.displayFile) return 'Error: 当前运行环境不支持在对话区展示生成的图片。';
        const brain = deps().brain;
        if (!brain.images) return 'Error: 当前环境未接入生图后端(请在桌面端使用,或检查 Forsion 云端连接)。';

        const modelId = String(args.model ?? '').trim() || (ctx.imageModelId || '').trim() || (await firstImageModelId(ctx.appId));
        if (!modelId) return 'Error: 未找到可用的生图模型。请在「设置 → 模型」启用 Forsion 的生图模型,或在自定义 provider 里填写生图模型 id。';

        const n = Math.min(Math.max(1, Number(args.n) || 1), 4);
        let images: Array<{ b64: string; mime: string }>;
        try {
          const r = await brain.images.generate({
            model: modelId, prompt, size: String(args.size || '1:1'), n,
            transparentBackground: !!args.transparent_background, signal: ctx.signal,
          });
          images = r.images || [];
        } catch (e: any) {
          return `Error: 生图失败:${e?.message || e}`;
        }
        if (!images.length) return 'Error: 生图未返回图片。';

        const stamp = Date.now();
        const isHost = ctx.execMode === 'host' && !!ctx.cwd;
        const shown: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const buf = Buffer.from(images[i].b64, 'base64');
          const name = `${stamp}${images.length > 1 ? `-${i + 1}` : ''}.png`;
          const rel = `generated/${name}`;
          if (isHost) {
            const abs = path.resolve(ctx.cwd!, rel);
            try {
              await fs.mkdir(path.dirname(abs), { recursive: true });
              await fs.writeFile(abs, buf);
              ctx.displayFile({ name, mime: 'image/png', path: abs });
              shown.push(rel);
              continue;
            } catch { /* 落盘失败 → 退化为 dataUrl 内联 */ }
          }
          // 沙箱 / 无 cwd / 落盘失败:dataUrl 内联展示(单图,占用可控)。
          ctx.displayFile({ name, mime: 'image/png', dataUrl: `data:image/png;base64,${images[i].b64}` });
          shown.push(name);
        }
        return `已生成 ${shown.length} 张图片并展示在对话区(${shown.join(', ')})。给一句简短说明即可,不要重复描述图片内容,也不要再调 display_file。`;
      },
    },
  ],
};
