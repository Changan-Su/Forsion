import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';

/** 档位白名单:模型偶尔会编('ultra'/'best'),照发就是上游 400。不在表里 → 当没传。 */
export const IMAGE_QUALITY_TIERS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
export function imageQuality(value: unknown): string | undefined {
  const tier = String(value ?? '').trim().toLowerCase();
  return (IMAGE_QUALITY_TIERS as readonly string[]).includes(tier) ? tier : undefined;
}

/** Only explicit current-run attachments can be uploaded. Never resolve arbitrary model URLs or paths. */
export function editInputs(inputs: ReadonlyArray<{ url: string }>, indices?: unknown) {
  const chosen = indices === undefined ? inputs.map((_, i) => i + 1) : indices;
  if (!Array.isArray(chosen) || !chosen.length || chosen.length > 8 || new Set(chosen).size !== chosen.length)
    throw new Error('Attach 1–8 reference images and select distinct image_indices.');
  return chosen.map(index => {
    if (!Number.isInteger(index) || index < 1 || index > inputs.length) throw new Error('image_indices must refer to attached images, starting at 1.');
    const url = inputs[index - 1].url;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || url.length > 8_000_000) throw new Error('Use PNG, JPEG or WebP attachments smaller than 6 MB. Remote URLs are not fetched.');
    const data = Buffer.from(match[2], 'base64');
    const valid = match[1] === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : match[1] === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
      : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new Error('The attachment bytes do not match the declared image format.');
    return { mime: match[1], b64: match[2] };
  });
}

type PickModel = (appId: string) => Promise<{ id: string | null; cloudEmpty?: boolean }>;
export function makeImageEditTool(pickModel: PickModel): ReturnType<ToolProvider['tools']>[number] {
  return {
    name: 'edit_image', mode: 'both', deferred: true,
    deferHint: 'Edit attached images using reference pixels; change details, restyle, extend a scene or remove a background.',
    capabilities: { sideEffect: 'network', parallel: false, defaultTimeoutMs: 200_000 },
    definition: { type: 'function', function: {
      name: 'edit_image',
      description: 'Edit the current user-provided image attachments with an image model. Use this instead of generate_image when the user wants to modify an existing image or preserve a reference. Sources are the latest attachments in this run, indexed from 1. Write a concrete English prompt describing changes and what to preserve. Transparent source margins can guide expansion. For background removal request transparent_background and preserve the subject. This is generative editing: exact pixel preservation, masks and automatic layer decomposition are not supported. Do not invent attachment indices or pass base64/URLs. If no attachments are available, ask the user to attach the source image. Results are already displayed; do not call display_file again.',
      parameters: { type: 'object', properties: {
        prompt: { type: 'string', description: 'Desired edit and details to preserve.' },
        image_indices: { type: 'array', items: { type: 'integer' }, description: '1-based attachment indices; defaults to all attached images (maximum 8).' },
        size: { type: 'string', enum: ['1:1', '2:3', '3:2', '16:9', '9:16'] },
        n: { type: 'integer', minimum: 1, maximum: 4 },
        transparent_background: { type: 'boolean' },
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
          description: 'Rendering effort/quality tier. Higher tiers cost several times more and take longer; "xhigh"/"max" need a gpt-image-2.5-class model. Omit unless the user asked for a draft or for maximum fidelity.',
        },
        model: { type: 'string', description: 'Optional image model override; otherwise uses the session/default image model.' },
      }, required: ['prompt'] },
    } },
    execute: async (args, ctx) => {
      try {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) throw new Error('prompt is required');
        if (!ctx.displayFile) throw new Error('This environment cannot display edited images.');
        const brain = deps().brain;
        if (!brain.images?.edit) throw new Error('Image editing is unavailable in this environment.');
        const images = editInputs(ctx.getImageInputs?.() || [], args.image_indices);
        const model = String(args.model || ctx.imageModelId || '').trim() || (await pickModel(ctx.appId)).id;
        if (!model) throw new Error('No image model is available. Check your account connection and image model settings.');
        const size = String(args.size || '1:1');
        if (!['1:1', '2:3', '3:2', '16:9', '9:16'].includes(size)) throw new Error('Unsupported aspect ratio.');
        const n = args.n === undefined ? 1 : Number(args.n);
        if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('n must be an integer from 1 to 4.');
        ctx.signal?.throwIfAborted();
        const result = await brain.images.edit({ model, prompt, images, size, n, transparentBackground: !!args.transparent_background, quality: imageQuality(args.quality), signal: ctx.signal });
        ctx.signal?.throwIfAborted();
        if (!result.images?.length) throw new Error('The model returned no edited images.');
        for (const image of result.images) {
          const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime === 'image/webp' ? 'webp' : 'png';
          const name = `edit-${randomUUID()}.${extension}`;
          if (ctx.execMode === 'host' && ctx.cwd) {
            const file = path.resolve(ctx.cwd, 'generated', name);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, Buffer.from(image.b64, 'base64'));
            ctx.displayFile({ name, mime: image.mime, path: file });
          } else ctx.displayFile({ name, mime: image.mime, dataUrl: `data:${image.mime};base64,${image.b64}` });
        }
        return `Edited ${result.images.length} image(s) using ${images.length} reference image(s). Results are displayed. Give a brief caption; do not call display_file.`;
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[edit_image]', message);
        return `Error: ${message}`;
      }
    },
  };
}
