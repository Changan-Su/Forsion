/**
 * generate_image —— 文生图,把 AI Studio 的生图体验搬到 Tangu(生成→落盘工作区→在对话区内联展示+点击放大)。
 * 模型走 Tangu 现有模型体系(brain.images):Forsion 托管图像模型(/v1/images,含配额计费)或用户自配 provider 的
 * /images/generations(imageModelIds)。未指定 model 时自动取第一个可用生图模型。
 * host 会话把图片写进 cwd/generated/ 并以路径展示(可在工作区找到、无 base64 膨胀);沙箱/无 cwd 时以 dataUrl 内联展示。
 */
import fs from 'node:fs/promises';
import { makeImageEditTool, imageQuality } from './imageEdit.js';
import path from 'node:path';
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';

/** 生图模型缺省解析:admin 的 app 级生图默认槽 > 第一个可用云端生图模型 > 直连 provider 的 imageModelIds。
 *  ⚠️解不出来时必须区分两种成因:云端目录一条都没返回(未登录 / token 过期 / 断网,httpBrain 的 catch 把
 *  401 降级成了空数组)vs 目录在但没开生图模型。两者的用户动作完全不同,混成一句「未配置生图模型」会
 *  把掉线的用户支去设置页空等(2026-09-20 线上反馈「作图用不了」疑似卡在此处 —— 当时全链路零日志,
 *  诊断包里无从证实,下面几处 console.warn 就是为了下次能证实)。 */
export async function firstImageModelId(appId: string): Promise<{ id: string | null; cloudEmpty?: boolean }> {
  const m = deps().brain.models;
  let cloud: any[] = [];
  let reachable: boolean | undefined; // 实现若不表态(旧云端/进程内实现)就留 undefined,下面回落长度启发式
  try {
    if (m.listModelsForProject) {
      const r = await m.listModelsForProject(appId);
      if (r?.imageModelId) return { id: String(r.imageModelId) }; // admin 生图默认(用户/run 未显式指定时跟随)
      cloud = r?.models || [];
      reachable = r?.reachable;
    } else {
      cloud = (await m.listGlobalModels()) || [];
    }
  } catch (e) {
    console.warn('[generate_image] 云端模型目录读取失败:', e instanceof Error ? e.message : e);
    reachable = false;
  }
  const img = cloud.find((x) => x?.id && x.modelType === 'image_gen');
  if (img?.id) return { id: String(img.id) };
  for (const p of m.listDirectProviders?.() ?? []) {
    if (p.imageModelIds?.length) return { id: p.imageModelIds[0] };
  }
  // 有 reachable 就信它(事实);没有就回落「一个模型都没有 ⇒ 多半没读到」——登录正常的客户端目录恒非空。
  return { id: null, cloudEmpty: reachable === undefined ? cloud.length === 0 : !reachable };
}

export const imageGenProvider: ToolProvider = {
  id: 'builtin:image-gen',
  tools: () => [
    {
      name: 'generate_image',
      mode: 'both',
      deferred: true, // P0-2:1KB schema,非常驻需求 → 按需装载
      deferHint: 'Generate an image from a text prompt (text-to-image).',
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
              quality: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
                description: 'Rendering effort/quality tier. Higher tiers cost several times more and take longer; "xhigh"/"max" need a gpt-image-2.5-class model. Omit unless the user asks for a draft (low) or for maximum fidelity.',
              },
              model: { type: 'string', description: 'Optional image model id override; defaults to the configured/first available image model.' },
            },
            required: ['prompt'],
          },
        },
      },
      execute: async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) return 'Error: prompt is required';
        // 下面每条失败分支都要留日志:工具错误只回给模型,不写 console 就不进诊断包 —— 用户报
        // 「作图用不了」时一条线索都没有(2026-09-19 实报)。
        if (!ctx.displayFile) {
          console.warn(`[generate_image] 无展示通道(execMode=${ctx.execMode}, client=${ctx.client ?? '-'})`);
          return 'Error: 当前运行环境不支持在对话区展示生成的图片。';
        }
        const brain = deps().brain;
        if (!brain.images) {
          console.warn('[generate_image] 当前 brain 未注入 images(云端 worker / microserver 不提供生图)');
          return 'Error: 当前环境未接入生图后端(请在桌面端使用,或检查 Forsion 云端连接)。';
        }

        let modelId = String(args.model ?? '').trim() || (ctx.imageModelId || '').trim();
        if (!modelId) {
          const pick = await firstImageModelId(ctx.appId);
          if (!pick.id) {
            console.warn(`[generate_image] 未解析到生图模型(appId=${ctx.appId}, cloudEmpty=${pick.cloudEmpty})`);
            return pick.cloudEmpty
              ? 'Error: 取不到云端模型目录(通常是未登录或登录已过期)。请先在「设置 → 账户」重新登录再试;若用自配 provider,需在其 imageModelIds 里声明生图模型 id。'
              : 'Error: 未找到可用的生图模型。请在「设置 → 模型」启用 Forsion 的生图模型,或在自定义 provider 里填写生图模型 id。';
          }
          modelId = pick.id;
        }

        const n = Math.min(Math.max(1, Number(args.n) || 1), 4);
        let images: Array<{ b64: string; mime: string }>;
        try {
          const r = await brain.images.generate({
            model: modelId, prompt, size: String(args.size || '1:1'), n,
            transparentBackground: !!args.transparent_background, quality: imageQuality(args.quality), signal: ctx.signal,
          });
          images = r.images || [];
        } catch (e: any) {
          // 工具错误只回给模型,不进日志 → 用户反馈「作图不能用」时诊断包里一条线索都没有。这里补上。
          console.warn(`[generate_image] 生图失败(model=${modelId}):`, e?.message || e);
          return `Error: 生图失败:${e?.message || e}`;
        }
        if (!images.length) {
          console.warn(`[generate_image] 后端返回 0 张图(model=${modelId})`);
          return 'Error: 生图未返回图片。';
        }

        const stamp = Date.now();
        const isHost = ctx.execMode === 'host' && !!ctx.cwd;
        const shown: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const buf = Buffer.from(images[i].b64, 'base64');
          const mime = images[i].mime || 'image/png';
          const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
          const name = `${stamp}${images.length > 1 ? `-${i + 1}` : ''}.${ext}`;
          const rel = `generated/${name}`;
          if (isHost) {
            const abs = path.resolve(ctx.cwd!, rel);
            try {
              await fs.mkdir(path.dirname(abs), { recursive: true });
              await fs.writeFile(abs, buf);
              ctx.displayFile({ name, mime, path: abs });
              shown.push(rel);
              continue;
            } catch { /* 落盘失败 → 退化为 dataUrl 内联 */ }
          }
          // 沙箱 / 无 cwd / 落盘失败:dataUrl 内联展示(单图,占用可控)。
          ctx.displayFile({ name, mime, dataUrl: `data:${mime};base64,${images[i].b64}` });
          shown.push(name);
        }
        return `已生成 ${shown.length} 张图片并展示在对话区(${shown.join(', ')})。给一句简短说明即可,不要重复描述图片内容,也不要再调 display_file。`;
      },
    },
    makeImageEditTool(firstImageModelId),
  ],
};
