/**
 * 图进模型上下文之前先缩小:最长边 ≤ MAX_EDGE、总像素 ≤ MAX_PIXELS,重新编码成 JPEG。
 *
 * 2026-10-07 桌面端 2.13.1 实证(Windows,反馈 1cc9c620):模型自己用 PowerShell 截了 5 张 1342×1355～1800×1500 的
 * PNG(194～260KB)再 view_image,原样 base64 进对话,单次请求体 183KB → 1.41MB;用户上行 30～45KB/s,每轮光上传
 * 25～32 秒。toolImageWindow.ts 管「留几条」,单张多大归这里。
 *
 * 两条上限是 provider 视觉入口本来就会下的那一刀(Anthropic 标准档:长边 1568、约 1.15MP,超了服务端先缩再看;
 * OpenAI detail:high 更狠,短边 768),所以对这类模型不丢眼力,只是不再把服务端要扔的像素传上去。
 * 只卡长边不够:那次反馈 5 张里 3 张长边不到 1568;同尺寸只转 JPEG 省 6%～70%,看内容,不稳。
 * 10-07 实测 6 张 150～360KB 的真截图:两条上限 + q80 → 70～99KB,解码 + 缩放 + 编码 < 150ms。
 *
 * 谁该调:引擎自己知道「这张图只是拿来看的」那几处 —— view_image、desk_screenshot、用户附件。
 * ⚠️ ctx.collectImage 这条通道本身**不缩**:Computer Use 的 look image、MCP server 的截图都可能是坐标系
 *    (act_ui 的坐标按 look image 的像素算),悄悄缩了就点歪。要缩的调用方自己先过这里,尺寸变了要告诉模型。
 *
 * 不动的(返回 null,调用方照原样走):够小的、尺寸在上限内的 JPEG(有损再压一遍不值)、省不到两成的、
 * 认不出 / 解不开的(GIF / WebP / BMP / 损坏文件)、隔行扫描的 PNG、像素多到解码要吃几百 MB 的。
 * 依赖 pngjs + jpeg-js:纯 JS、零传递依赖。引擎还跑在 Windows / Linux worker / Electron 自带的 Node 上,
 * 原生库(sharp)得按平台带预编译包、Electron ABI 另算;没有纯 JS 的 WebP 编码器,所以只出 JPEG。
 * ponytail: 同步跑在主线程。截图 < 150ms;1200 万像素的照片解码 ~200ms、瞬时多占 ~250MB。成了瓶颈再挪进 worker_threads。
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/** 换模型代际 / provider 时要调的就是这两个数(高清档的模型能吃到 2576px / 3.75MP)。 */
export const MAX_EDGE = 1568;
export const MAX_PIXELS = 1_150_000;
/** 不到这个体积的图不解码、不重编码(Computer Use 自己的 look image 约 88KB,缩完的截图也就 70～100KB)。 */
export const KEEP_BYTES = 100 * 1024;
const MIN_SAVING = 0.8; // 重编码后还有原来的八成以上 → 不值得有损,留原图
const MAX_DECODE_PIXELS = 24_000_000; // RGBA 96MB;再大的原样放行(view_image 另有 5MB 闸)
const JPEG_QUALITY = 80;

export interface FittedImage {
  buf: Buffer;
  mime: 'image/jpeg';
  width: number;
  height: number;
  /** 原图尺寸(JPEG 已按 EXIF 方向摆正后的宽高)。与 width/height 相同 = 只换了编码。 */
  fromWidth: number;
  fromHeight: number;
}

interface Header { kind: 'png' | 'jpeg'; width: number; height: number; orientation: number }

/** 只读文件头:格式按字节认,不信扩展名 / 声明的 MIME。 */
function readHeader(buf: Buffer): Header | null {
  try {
    if (buf.length > 29 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
      // 隔行扫描的 PNG 不碰:pngjs 解它时 inflate 不设输出上限(非隔行的按 IHDR 尺寸封顶),几 MB 的压缩炸弹能撑爆内存。
      // 16 位的也不碰:同样的像素数解出来多一倍,截图没有这种。
      if (buf[28] !== 0 || buf[24] > 8) return null;
      return { kind: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), orientation: 1 };
    }
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let orientation = 1, frame: Header | null = null;
    for (let p = 2; p + 4 <= buf.length;) {
      if (buf[p] !== 0xff) return null;
      const marker = buf[p + 1];
      if (marker === 0xff) { p++; continue; } // 填充字节
      // 走到扫描数据(SOS)才算数:只有帧头、没有画面的文件,jpeg-js 会「解」出一张纯灰图(Codex 10-07 评审)
      if (marker === 0xda) return frame;
      const len = buf.readUInt16BE(p + 2);
      if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') orientation = exifOrientation(buf.subarray(p + 10, p + 2 + len));
      // SOFn(帧头)带宽高;C4 / C8 / CC 是同一段号区间里的别的东西
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        frame = { kind: 'jpeg', height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7), orientation };
      }
      p += 2 + len;
    }
  } catch { /* 截断的头 → 认不出 */ }
  return null;
}

/** EXIF 的方向标签(0x0112,IFD0);读不到按 1(不转)。手机竖拍的照片像素是横着存的,靠它摆正。 */
function exifOrientation(tiff: Buffer): number {
  try {
    const le = tiff.toString('latin1', 0, 2) === 'II';
    const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const ifd = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
    for (let i = 0, n = u16(ifd); i < n; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112) { const v = u16(entry + 8); return v >= 1 && v <= 8 ? v : 1; }
    }
  } catch { /* 坏的 EXIF → 不转 */ }
  return 1;
}

/** 透明像素垫白(JPEG 没有透明;先垫再缩,免得透明处的底色渗进边缘)。就地改。 */
function flattenOnWhite(px: Uint8Array): void {
  for (let i = 3; i < px.length; i += 4) {
    const a = px[i];
    if (a === 255) continue;
    px[i - 3] = (px[i - 3] * a + 255 * (255 - a)) / 255;
    px[i - 2] = (px[i - 2] * a + 255 * (255 - a)) / 255;
    px[i - 1] = (px[i - 1] * a + 255 * (255 - a)) / 255;
    px[i] = 255;
  }
}

/** 一条轴上每个目标像素盖住的源像素:起点 + 各自的覆盖比例(边上那两个只算盖到的那一截)。 */
function spans(from: number, to: number): Array<{ start: number; weights: number[] }> {
  const ratio = from / to;
  return Array.from({ length: to }, (_, d) => {
    const a = d * ratio, b = (d + 1) * ratio;
    const start = Math.floor(a), end = Math.min(from, Math.ceil(b));
    const weights: number[] = [];
    for (let i = start; i < end; i++) weights.push((Math.min(i + 1, b) - Math.max(i, a)) / ratio);
    return { start, weights };
  });
}

/** 面积平均缩小(先横后竖):每个目标像素 = 它盖住的那块源像素的加权平均。只管缩小;截图里的小字靠它不糊成锯齿。 */
function shrinkArea(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Buffer {
  const xs = spans(sw, dw), ys = spans(sh, dh);
  const mid = new Float32Array(dw * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const { start, weights } = xs[x];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const p = (y * sw + start + k) * 4, w = weights[k];
        r += src[p] * w; g += src[p + 1] * w; b += src[p + 2] * w;
      }
      const q = (y * dw + x) * 3;
      mid[q] = r; mid[q + 1] = g; mid[q + 2] = b;
    }
  }
  const dst = Buffer.alloc(dw * dh * 4, 255);
  for (let y = 0; y < dh; y++) {
    const { start, weights } = ys[y];
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const p = ((start + k) * dw + x) * 3, w = weights[k];
        r += mid[p] * w; g += mid[p + 1] * w; b += mid[p + 2] * w;
      }
      const q = (y * dw + x) * 4;
      dst[q] = r + 0.5; dst[q + 1] = g + 0.5; dst[q + 2] = b + 0.5;
    }
  }
  return dst;
}

/** 按 EXIF 方向(2～8)把像素摆正;5～8 宽高互换。在缩完的小图上做。 */
function upright(src: Uint8Array, w: number, h: number, o: number): { data: Uint8Array; width: number; height: number } {
  if (o < 2 || o > 8) return { data: src, width: w, height: h };
  const swap = o >= 5, W = swap ? h : w, H = swap ? w : h;
  const dst = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = swap ? y : x, b = swap ? x : y; // a 沿源图的横轴,b 沿纵轴
      const sx = o === 2 || o === 3 || o === 7 || o === 8 ? w - 1 - a : a;
      const sy = o === 3 || o === 4 || o === 6 || o === 7 ? h - 1 - b : b;
      const s = (sy * w + sx) * 4, d = (y * W + x) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255;
    }
  }
  return { data: dst, width: W, height: H };
}

/** 缩不了 / 不值得缩 → null(调用方原样用原图)。同一份输入恒出同一份字节(前缀缓存靠它)。 */
export function fitImageForModel(buf: Buffer): FittedImage | null {
  if (buf.length <= KEEP_BYTES) return null;
  const head = readHeader(buf);
  if (!head) return null;
  const { width: w, height: h } = head;
  if (!(w > 0 && h > 0) || w * h > MAX_DECODE_PIXELS) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  if (scale === 1 && head.kind === 'jpeg') return null;
  try {
    let px: Uint8Array;
    if (head.kind === 'png') {
      px = PNG.sync.read(buf).data;
      flattenOnWhite(px);
    } else {
      px = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_DECODE_PIXELS / 1e6, maxMemoryUsageInMB: 512 }).data;
    }
    if (px.length !== w * h * 4) return null; // 头里写的尺寸和解出来的对不上
    const dw = Math.max(1, Math.floor(w * scale)), dh = Math.max(1, Math.floor(h * scale));
    const shown = upright(scale < 1 ? shrinkArea(px, w, h, dw, dh) : px, dw, dh, head.orientation);
    const out = jpeg.encode({ data: shown.data, width: shown.width, height: shown.height }, JPEG_QUALITY).data;
    if (out.length > buf.length * MIN_SAVING) return null;
    const turned = head.orientation >= 5;
    return { buf: out, mime: 'image/jpeg', width: shown.width, height: shown.height, fromWidth: turned ? h : w, fromHeight: turned ? w : h };
  } catch {
    return null; // 损坏 / 解码器不认的变体:原样放行,由原来的路径决定怎么办
  }
}

/** data: URL 进、data: URL 出;没缩(或根本不是 base64 的 data: URL)就把同一个字符串还回去。 */
export function fitImageUrlForModel(url: string): string {
  const m = /^data:[^,]*;base64,/i.exec(url);
  if (!m) return url;
  const fit = fitImageForModel(Buffer.from(url.slice(m[0].length), 'base64'));
  return fit ? `data:${fit.mime};base64,${fit.buf.toString('base64')}` : url;
}
