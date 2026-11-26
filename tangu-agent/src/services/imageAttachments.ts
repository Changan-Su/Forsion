/**
 * 图片附件归一化与物化(修复 2026-06-10 审计的附件双 bug):
 *
 *  旧链路:桌面端发 {name,mimeType,data},服务端 applyAttachments 只认 {type:'image',url}
 *  → 全部被静默丢弃;即使匹配也只在第 0 轮注入 → 前缀分叉 + 第 1 轮起模型丢图。
 *
 *  新链路:attachments 随 user 消息存进 chat_messages.attachments 列;hydrateHistory 只对
 *  **最新带图的 user 消息**把 content 重建成 [text, image_url...] parts 数组(等价 Hermes 的
 *  _strip_historical_media:旧图不再每轮重发),loop 恒传 attachments:[] → 每轮字节一致,
 *  缓存稳定且模型全程可见图片。
 */

import type { ImageResize } from './imageShrink.js';
import { prepareInlineImage } from './heicImages.js';

export interface NormalizedImage {
  url: string; // data: URL 或 http(s) URL
  /** 附件文件名(桌面端带);edit_image 用它认出客户端「标注修改」的标注副本(见 imageEdit.ts dropMarkupCopies)。 */
  name?: string;
  resize?: ImageResize;
}

const MAX_IMAGES = 8;
const MAX_URL_CHARS = 8_000_000; // ≈6MB 二进制的 base64;超限跳过(provider 普遍 5-10MB 上限)

/**
 * 把任意来源的 attachments(JSON 字符串或数组)归一化成图片列表。
 * 兼容两种形态:
 *   - {type:'image', url}(AI Studio / 服务端旧契约)
 *   - {name, mimeType:'image/*', data: base64}(Tangu 桌面端)
 * 非图片附件忽略(目前没有进 prompt 的语义;桌面端 UI 另有提示)。
 */
export function normalizeImageAttachments(raw: any): NormalizedImage[] {
  let list: any[] = [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  }

  const out: NormalizedImage[] = [];
  for (const a of list) {
    if (!a || out.length >= MAX_IMAGES) break;
    let url = '';
    if (a.type === 'image' && typeof a.url === 'string') {
      url = a.url;
    } else if (typeof a.mimeType === 'string' && a.mimeType.startsWith('image/') && typeof a.data === 'string' && a.data) {
      url = `data:${a.mimeType};base64,${a.data}`;
    }
    if (url && url.length <= MAX_URL_CHARS) out.push(typeof a.name === 'string' && a.name ? { url, name: a.name } : { url });
  }
  return out;
}

/** 用户附件进上下文前先缩(大照片 / 高分屏截图,见 imageShrink.ts);http(s) 的和够小的原样。 */
export async function fitUserImages(images: NormalizedImage[], signal?: AbortSignal): Promise<NormalizedImage[]> {
  const out: NormalizedImage[] = [];
  for (const image of images) {
    const fitted = await prepareInlineImage(image.url, signal);
    signal?.throwIfAborted();
    out.push(fitted);
  }
  return out;
}

// Text-only transcripts may clone image parts. Recognize the generated hint only in its
// reserved position between user text and an attachment, including after JSON replay.
const GEOMETRY_PREFIX = 'This attachment is displayed at ';
export function isImageGeometryPart(part: unknown, index: number, parts: unknown[]): boolean {
  const block = part as { type?: string; text?: unknown } | null;
  return index > 0 && block?.type === 'text' && typeof block.text === 'string'
    && block.text.startsWith(GEOMETRY_PREFIX) && (parts[index + 1] as { type?: string } | undefined)?.type === 'image_url';
}

/** 把纯文本 user content 转成 OpenAI 形态的 parts 数组(text + image_url...)。 */
export function toImageParts(text: string, images: NormalizedImage[]): any[] {
  return [
    { type: 'text', text: text || '' },
    ...images.flatMap((image) => {
      const part = { type: 'image_url', image_url: { url: image.url, detail: 'high' } };
      if (!image.resize) return [part];
      const { width, height, fromWidth, fromHeight } = image.resize;
      const geometry = `${GEOMETRY_PREFIX}${width} × ${height} pixels. Its original is ${fromWidth} × ${fromHeight}. For a click in original pixels, convert the displayed point (u,v) to (floor((u + 0.5) × ${fromWidth} / ${width}), floor((v + 0.5) × ${fromHeight} / ${height})).`;
      const hint = { type: 'text', text: geometry };
      return [hint, part];
    }),
  ];
}
