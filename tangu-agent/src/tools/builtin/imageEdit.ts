import { deliverImages } from './imageDelivery.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deps } from '../../seams/runtime.js';
import type { ImageGenRequest } from '../../seams/cloudBrain.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';

/** 档位白名单:模型偶尔会编('ultra'/'best'),照发就是上游 400。不在表里 → 当没传。 */
export const IMAGE_QUALITY_TIERS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
export function imageQuality(value: unknown): string | undefined {
  const tier = String(value ?? '').trim().toLowerCase();
  return (IMAGE_QUALITY_TIERS as readonly string[]).includes(tier) ? tier : undefined;
}

export const imageOutputSchema = {
  output_format: { type: 'string', enum: ['png', 'gif'], description: 'Use gif when the user asks for animation. Requires a GPT Image 2.6 model. Omit for a still image.' },
  frame_count: { type: 'integer', minimum: 2, maximum: 16, description: 'GIF only. Number of frames (default 9).' },
  frame_duration_ms: { type: 'integer', minimum: 20, maximum: 2000, description: 'GIF only. Delay per frame in milliseconds (default 200).' },
  complexity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'GPT Image 2.6 planning effort. Omit unless the user requests it.' },
};

export function imageOutputOptions(args: Record<string, unknown>): Pick<ImageGenRequest, 'outputFormat' | 'frameCount' | 'frameDurationMs' | 'complexity'> {
  const { output_format: format, frame_count: count, frame_duration_ms: delay, complexity } = args;
  if (format !== undefined && format !== 'png' && format !== 'gif') throw new Error('output_format must be png or gif.');
  if (complexity !== undefined && complexity !== 'low' && complexity !== 'medium' && complexity !== 'high') throw new Error('complexity must be low, medium or high.');
  if (format !== 'gif' && (count !== undefined || delay !== undefined)) throw new Error('Frame options require output_format: gif.');
  if (format === 'gif' && args.transparent_background) throw new Error('Transparent background output requires PNG.');
  if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 2 || count > 16)) throw new Error('frame_count must be an integer from 2 to 16.');
  if (delay !== undefined && (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 20 || delay > 2000)) throw new Error('frame_duration_ms must be an integer from 20 to 2000.');
  return {
    ...(format === undefined ? {} : { outputFormat: format }),
    ...(count === undefined ? {} : { frameCount: count }),
    ...(delay === undefined ? {} : { frameDurationMs: delay }),
    ...(complexity === undefined ? {} : { complexity }),
  };
}

export function imageOutputExtension(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
}

export function assertImageOutputFormat(format: ImageGenRequest['outputFormat'], images: Array<{ mime: string }>) {
  if (format === 'gif' && images.some(image => image.mime !== 'image/gif')) {
    throw new Error('The image provider did not return GIF output. Select a GPT Image 2.6 model with GIF access.');
  }
}

/** 改图只收两种图:模型此刻看得见的图(本轮附件,没有就是上下文里最新那条带图消息的原图,压缩盖掉后就没了)
 *  和本会话生图工具自己产出的图(按文件名查展示记录)。Never resolve model-supplied URLs or paths. */
const NO_IMAGES = 'No source images are available: nothing is attached to the current message, and no earlier image is visible in this conversation. File paths written in the message text are not attachments. Ask the user to attach the source images (paste or drag them into the chat) in their next message, then call edit_image again. Do not retry before that.';
const IMAGE_TOOL_SOURCES = new Set(['generate_image', 'edit_image']);

function decodeImage(url: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || url.length > 8_000_000) throw new Error('Use PNG, JPEG or WebP images smaller than 6 MB. Remote URLs are not fetched.');
  const data = Buffer.from(match[2], 'base64');
  const valid = match[1] === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
    : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new Error('The image bytes do not match the declared image format.');
  return { mime: match[1], b64: match[2] };
}

/** 客户端「标注修改」发来的标注副本(桌面 imageMarkupModel.ts 的 markup.copyName:「<原图名>-标注」/「<原图名>-marked」,JPEG)
 *  只给对话模型看改哪里。工具说明叫模型别传它,模型偶尔仍当「位置参考」一起传(live imagemulti ② 12 次里 1 次),
 *  标记就会被画进结果 —— 同一批里有它的原图时,来源一律换成原图、去重。没有原图(只发了副本)就照模型选的。 */
const MARKUP_COPY = /^(.+)-(?:标注|marked)\.(?:jpe?g|png|webp)$/i;
export function dropMarkupCopies(inputs: ReadonlyArray<{ name?: string }>, chosen: number[]): number[] {
  const stem = (name?: string) => (name || '').replace(/\.[a-z0-9]+$/i, '');
  const out: number[] = [];
  for (const index of chosen) {
    const copy = MARKUP_COPY.exec(inputs[index - 1]?.name || '');
    const original = copy ? inputs.findIndex((x, j) => j !== index - 1 && !MARKUP_COPY.test(x.name || '') && stem(x.name) === copy[1]) : -1;
    const use = original >= 0 ? original + 1 : index;
    if (!out.includes(use)) out.push(use);
  }
  return out;
}

/** inputs = 看得见的图(按 image_indices 选);outputs = 已按名字查到的本会话产出图。带了 outputs 而没给 image_indices 时不默认带上附件。 */
export function editInputs(inputs: ReadonlyArray<{ url: string; name?: string }>, indices?: unknown, outputs: ReadonlyArray<{ url: string }> = []) {
  // 没图时说清楚原因:旧报错「image_indices must refer to attached images」像是索引写错,模型会原样重试(2026-10-19 连试 5 次)。
  if (!inputs.length && !outputs.length) throw new Error(NO_IMAGES);
  const chosen = indices === undefined ? (outputs.length ? [] : inputs.map((_, i) => i + 1)) : indices;
  if (!Array.isArray(chosen) || (!chosen.length && !outputs.length) || chosen.length + outputs.length > 8 || new Set(chosen).size !== chosen.length)
    throw new Error('Use 1–8 source images in total and select distinct image_indices.');
  for (const index of chosen) {
    if (!Number.isInteger(index) || index < 1 || index > inputs.length) throw new Error(`image_indices must refer to the ${inputs.length} visible attached image(s), starting at 1.`);
  }
  return [
    ...dropMarkupCopies(inputs, chosen as number[]).map(index => decodeImage(inputs[index - 1].url)),
    ...outputs.map(o => decodeImage(o.url)),
  ];
}

/** previous_outputs → 本会话生图工具产出的图。只当名字去查展示记录,不当路径读;没打 source 标记的(display_file 展示的本机文件)不算。 */
export async function previousOutputs(refs: unknown, ctx: Pick<ToolContext, 'listDisplayFiles' | 'cwd'>): Promise<Array<{ url: string; name: string }>> {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > 8 || new Set(refs).size !== refs.length) throw new Error('previous_outputs must list up to 8 distinct file names.');
  if (!refs.length) return [];
  const files = (await ctx.listDisplayFiles?.()) ?? [];
  return Promise.all(refs.map(async (ref) => {
    if (typeof ref !== 'string' || !/^[\w.-]{1,128}$/.test(ref)) throw new Error(`previous_outputs takes file names of images generated in this conversation (e.g. edit-3f2a.png), not paths or URLs: ${String(ref)}`);
    const item = files.find(f => f?.name === ref && IMAGE_TOOL_SOURCES.has(f.source as string));
    if (!item) throw new Error(`${ref} is not an image generated in this conversation. Ask the user to attach it instead.`);
    if (item.dataUrl) return { url: item.dataUrl, name: ref };
    if (!item.path) throw new Error(`${ref} has no stored bytes. Ask the user to attach it instead.`);
    let buf: Buffer;
    try { buf = await fs.readFile(path.resolve(ctx.cwd || '', item.path)); } catch { throw new Error(`${ref} no longer exists on disk. Ask the user to attach it instead.`); }
    if (!item.sha256 || sha256(buf) !== item.sha256) throw new Error(`${ref} has changed on disk since it was generated. Ask the user to attach it instead.`);
    return { url: `data:${item.mime || 'image/png'};base64,${buf.toString('base64')}`, name: ref };
  }));
}

export const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function minutesAgo(ts: number) {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  return `${m} minute${m === 1 ? '' : 's'} ago`;
}

type PickModel = (appId: string) => Promise<{ id: string | null; cloudEmpty?: boolean }>;
export function makeImageEditTool(pickModel: PickModel): ReturnType<ToolProvider['tools']>[number] {
  return {
    name: 'edit_image', mode: 'both', deferred: true,
    deferHint: 'Edit images the user attached or that were generated in this conversation, using reference pixels; change details, restyle, extend a scene or remove a background.',
    capabilities: { sideEffect: 'network', parallel: false, defaultTimeoutMs: 1_000_000 },
    definition: { type: 'function', function: {
      name: 'edit_image',
      description: 'Edit images with an image model. Use this instead of generate_image when the user wants to modify an existing image or preserve a reference. Sources: (1) the images attached to the latest user message that carries images and that you can currently see (the current message if it has any), selected by image_indices from 1; (2) images generated earlier in this conversation by generate_image or edit_image, selected by file name in previous_outputs. Write a concrete English prompt describing changes and what to preserve. Transparent source margins can guide expansion. For background removal request transparent_background and preserve the subject. This is generative editing: exact pixel preservation, masks and automatic layer decomposition are not supported. Annotated copies: when the user attaches a clean image together with a copy of it carrying numbered marks (circles, pins, painted highlights), the marked copy only shows where to change. Pass only the clean original as a source and describe in words, in the prompt, where each marked spot is and what to change there; never pass the marked copy as a source, not even as a location guide with an instruction to ignore its marks: the image model cannot tell a guide from content and draws the marks into the result. Several images to change separately: call edit_image once per image, each call selecting only that image (a different index or file name every time), because multiple sources in one call are combined into a single picture. Do not invent indices or file names, and do not pass paths, base64 or URLs. If neither source has the image you need, ask the user to attach it. Results are already displayed; do not call display_file again.',
      parameters: { type: 'object', properties: {
        prompt: { type: 'string', description: 'Desired edit and details to preserve.' },
        image_indices: { type: 'array', items: { type: 'integer' }, description: '1-based indices into the visible attached images. Defaults to all of them when previous_outputs is omitted or empty, and to none when it lists files. At most 8 source images in total.' },
        previous_outputs: { type: 'array', items: { type: 'string' }, description: 'File names of images generated earlier in this conversation (e.g. "edit-3f2a.png"), as reported by generate_image or edit_image.' },
        size: { type: 'string', enum: ['1:1', '2:3', '3:2', '16:9', '9:16'], description: 'Omit for square still images or automatic GIF sizing.' },
        n: { type: 'integer', minimum: 1, maximum: 4 },
        transparent_background: { type: 'boolean' },
        ...imageOutputSchema,
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
          description: 'Rendering effort/quality tier. Higher tiers cost several times more and take longer; "xhigh"/"max" are only honored by some image models. Omit unless the user asked for a draft or for maximum fidelity.',
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
        const options = imageOutputOptions(args);
        const outputs = await previousOutputs(args.previous_outputs, ctx);
        const visible = ctx.getImageInputs?.() || [];
        const images = editInputs(visible, args.image_indices, outputs);
        const fromAttachments = images.length - outputs.length;
        const sentAt = fromAttachments ? ctx.getImageInputsSentAt?.() : undefined;
        const sources = [
          ...(fromAttachments ? [sentAt ? `${fromAttachments} image(s) from the user's message ${minutesAgo(sentAt)}` : `${fromAttachments} attached image(s)`] : []),
          ...outputs.map(o => o.name),
        ].join(' and ');
        const model = String(args.model || ctx.imageModelId || '').trim() || (await pickModel(ctx.appId)).id;
        if (!model) throw new Error('No image model is available. Check your account connection and image model settings.');
        const size = String(args.size || (options.outputFormat === 'gif' ? 'auto' : '1:1'));
        if (!['1:1', '2:3', '3:2', '16:9', '9:16'].includes(size) && !(size === 'auto' && options.outputFormat === 'gif')) throw new Error('Unsupported aspect ratio.');
        const n = args.n === undefined ? 1 : Number(args.n);
        if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('n must be an integer from 1 to 4.');
        ctx.signal?.throwIfAborted();
        const result = await brain.images.edit({ model, prompt, images, size, n, transparentBackground: !!args.transparent_background, quality: imageQuality(args.quality), signal: ctx.signal, ...options });
        ctx.signal?.throwIfAborted();
        if (!result.images?.length) throw new Error('The model returned no edited images.');
        assertImageOutputFormat(options.outputFormat, result.images);
        const names = await deliverImages(result, ctx, 'edit_image');
        const saved = ctx.execMode === 'host' && ctx.cwd ? 'saved to the generated/ folder as' : 'saved as';
        const reuse = result.images.every(image => image.mime === 'image/gif') ? '' : '; to edit one again, pass its file name in previous_outputs';
        return `Edited ${result.images.length} image(s) using ${sources}. Results are displayed and ${saved} ${names.join(', ')}${reuse}. ` +
          `Give a brief caption${sentAt ? " that mentions you used the images from the user's earlier message" : ''}; do not call display_file.`;
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[edit_image]', message);
        return `Error: ${message}`;
      }
    },
  };
}
