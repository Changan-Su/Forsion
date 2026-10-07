import { describe, expect, it, vi } from 'vitest';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { KEEP_BYTES, MAX_EDGE, MAX_PIXELS, fitImageForModel, fitImageUrlForModel } from './imageShrink.js';

// 夹具:四个象限各一色(左上红 / 右上绿 / 左下蓝 / 右下灰),右下象限可铺噪点把体积撑过 KEEP_BYTES(纯色块压完只有几 KB)。
const QUAD = { tl: [220, 30, 30], tr: [30, 180, 60], bl: [40, 60, 210], br: [128, 128, 128] } as const;

function quadrants(w: number, h: number, noise = true, alpha = 255): Buffer {
  const px = Buffer.alloc(w * h * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const left = x < w / 2, top = y < h / 2;
      const c = top ? (left ? QUAD.tl : QUAD.tr) : (left ? QUAD.bl : QUAD.br);
      const i = (y * w + x) * 4;
      if (noise && y > h * 0.6 && x > w * 0.6) { px[i] = rnd(); px[i + 1] = rnd(); px[i + 2] = rnd(); } // 噪点只铺右下角那一块
      else { px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; }
      px[i + 3] = alpha;
    }
  }
  return px;
}
const png = (w: number, h: number, px: Buffer): Buffer => { const p = new PNG({ width: w, height: h }); px.copy(p.data); return PNG.sync.write(p); };
const jpg = (w: number, h: number, px: Buffer, q = 95): Buffer => jpeg.encode({ data: px, width: w, height: h }, q).data;

/** 解出来的图上 (fx, fy)(0~1 的相对位置)那一点最像哪个象限的颜色。 */
function quadAt(buf: Buffer, fx: number, fy: number): string {
  const d = jpeg.decode(buf, { useTArray: true });
  const i = (Math.floor(d.height * fy) * d.width + Math.floor(d.width * fx)) * 4;
  let best = '', bestDist = Infinity;
  for (const [name, c] of Object.entries(QUAD)) {
    const dist = Math.abs(d.data[i] - c[0]) + Math.abs(d.data[i + 1] - c[1]) + Math.abs(d.data[i + 2] - c[2]);
    if (dist < bestDist) { best = name; bestDist = dist; }
  }
  return bestDist < 60 ? best : `?(${d.data[i]},${d.data[i + 1]},${d.data[i + 2]})`;
}

/** 在 SOI 后面塞一段只有方向标签的 EXIF(大端 TIFF,IFD0 一条 0x0112)。 */
function withOrientation(buf: Buffer, o: number): Buffer {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([buf.subarray(0, 2), Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body, buf.subarray(2)]);
}

describe('fitImageForModel', () => {
  it('够小的图不动:尺寸再大也不解码、不重编码', () => {
    const small = png(3000, 2000, quadrants(3000, 2000, false));
    expect(small.length).toBeLessThan(KEEP_BYTES);
    expect(fitImageForModel(small)).toBeNull();
  });

  it('大截图(反馈里的 1800×1500 PNG)缩进两条上限、转成 JPEG、画面还在原位', () => {
    const src = png(1800, 1500, quadrants(1800, 1500));
    expect(src.length).toBeGreaterThan(KEEP_BYTES);
    const fit = fitImageForModel(src)!;
    expect(fit).not.toBeNull();
    expect(fit.mime).toBe('image/jpeg');
    expect([fit.buf[0], fit.buf[1]]).toEqual([0xff, 0xd8]);
    expect([fit.fromWidth, fit.fromHeight]).toEqual([1800, 1500]);
    expect(Math.max(fit.width, fit.height)).toBeLessThanOrEqual(MAX_EDGE);
    expect(fit.width * fit.height).toBeLessThanOrEqual(MAX_PIXELS);
    expect(fit.width * fit.height).toBeGreaterThan(MAX_PIXELS * 0.99); // 贴着上限,没多缩
    expect(fit.width / fit.height).toBeCloseTo(1800 / 1500, 2);
    expect(fit.buf.length).toBeLessThan(src.length * 0.8);
    const decoded = jpeg.decode(fit.buf);
    expect([decoded.width, decoded.height]).toEqual([fit.width, fit.height]);
    expect([quadAt(fit.buf, 0.25, 0.25), quadAt(fit.buf, 0.75, 0.25), quadAt(fit.buf, 0.25, 0.75), quadAt(fit.buf, 0.55, 0.55)]).toEqual(['tl', 'tr', 'bl', 'br']);
  });

  it('像素数没超、只有长边超:按长边缩', () => {
    const fit = fitImageForModel(png(4000, 200, quadrants(4000, 200)))!;
    expect([fit.width, fit.height]).toEqual([MAX_EDGE, 78]);
  });

  it('同一份输入恒出同一份字节(前缀缓存靠它)', () => {
    const src = png(1800, 1500, quadrants(1800, 1500));
    expect(fitImageForModel(src)!.buf.equals(fitImageForModel(src)!.buf)).toBe(true);
  });

  it('尺寸在上限内的大 PNG:只换编码、尺寸不变;省不到两成就留原图', () => {
    // 渐变 + 细颗粒(照片那种):PNG 压不动,JPEG 很省
    const w = 1000, h = 1000, soft = Buffer.alloc(w * h * 4, 255);
    let grain = 99;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      grain = (grain * 1103515245 + 12345) & 0x7fffffff;
      const i = (y * w + x) * 4;
      soft[i] = (x * 220) / w + ((grain >> 16) & 15); soft[i + 1] = (y * 220) / h + ((grain >> 20) & 15); soft[i + 2] = 120;
    }
    const softPng = png(w, h, soft);
    expect(softPng.length).toBeGreaterThan(KEEP_BYTES);
    const fit = fitImageForModel(softPng)!;
    expect([fit.width, fit.height, fit.fromWidth, fit.fromHeight]).toEqual([w, h, w, h]);
    expect(fit.buf.length).toBeLessThan(softPng.length * 0.8);
    // 白底上稀疏的彩色噪点:PNG 很省,JPEG 反而更大 → 不换
    const sparse = Buffer.alloc(w * h * 4, 255);
    for (let k = 0; k < 120_000; k++) { const i = ((k * 7919) % (w * h)) * 4; sparse[i] = (k * 37) & 0xff; sparse[i + 1] = (k * 91) & 0xff; sparse[i + 2] = (k * 53) & 0xff; }
    const sparsePng = png(w, h, sparse);
    expect(sparsePng.length).toBeGreaterThan(KEEP_BYTES);
    expect(fitImageForModel(sparsePng)).toBeNull();
  });

  it('尺寸在上限内的 JPEG 不动(有损再压一遍不值);超限的 JPEG 照缩', () => {
    const inLimit = jpg(1000, 1000, quadrants(1000, 1000));
    expect(inLimit.length).toBeGreaterThan(KEEP_BYTES);
    expect(fitImageForModel(inLimit)).toBeNull();
    const fit = fitImageForModel(jpg(2400, 1800, quadrants(2400, 1800)))!;
    expect([fit.fromWidth, fit.fromHeight]).toEqual([2400, 1800]);
    expect(fit.width * fit.height).toBeLessThanOrEqual(MAX_PIXELS);
    expect(quadAt(fit.buf, 0.25, 0.25)).toBe('tl');
  });

  // 源图横着存(1600×800),红色在存储的左上。o = EXIF 方向 → 摆正后红色该在哪个角、宽高换没换。
  it.each([
    [1, false, [0.25, 0.25]], [2, false, [0.75, 0.25]], [3, false, [0.75, 0.75]], [4, false, [0.25, 0.75]],
    [5, true, [0.25, 0.25]], [6, true, [0.75, 0.25]], [7, true, [0.75, 0.75]], [8, true, [0.25, 0.75]],
  ] as Array<[number, boolean, [number, number]]>)('JPEG 的 EXIF 方向 %i:像素摆正、报的原尺寸也是摆正后的', (o, turned, [fx, fy]) => {
    const fit = fitImageForModel(withOrientation(jpg(1600, 800, quadrants(1600, 800)), o))!;
    expect(fit).not.toBeNull();
    expect([fit.fromWidth, fit.fromHeight]).toEqual(turned ? [800, 1600] : [1600, 800]);
    expect(fit.width > fit.height).toBe(!turned);
    expect(quadAt(fit.buf, fx, fy)).toBe('tl');
  });

  it('透明的地方垫白,不是垫黑', () => {
    const px = quadrants(1800, 1500);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) px[(y * 1800 + x) * 4 + 3] = 0; // 左上角挖一块全透明
    const fit = fitImageForModel(png(1800, 1500, px))!;
    const d = jpeg.decode(fit.buf, { useTArray: true });
    const i = (20 * d.width + 20) * 4;
    expect(Math.min(d.data[i], d.data[i + 1], d.data[i + 2])).toBeGreaterThan(240);
  });

  it('不是图 / 损坏 / 解不了的:一律 null,不抛', () => {
    const real = png(1800, 1500, quadrants(1800, 1500));
    const garbage = Buffer.alloc(300_000, 0x5a);
    const pngHeadOnly = Buffer.concat([real.subarray(0, 33), garbage]); // 签名 + IHDR 是真的,后面全是垃圾
    const truncated = real.subarray(0, Math.floor(real.length / 2));
    const jpegTruncated = jpg(2400, 1800, quadrants(2400, 1800)).subarray(0, 150_000);
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), garbage]);
    for (const [name, buf] of Object.entries({ garbage, pngHeadOnly, truncated, gif, text: Buffer.from('not an image '.repeat(20_000)) })) {
      expect(fitImageForModel(buf), name).toBeNull();
    }
    // 截断的 JPEG:jpeg-js 能解出一部分就照缩,解不出就 null —— 两种都行,只要不抛
    expect(() => fitImageForModel(jpegTruncated)).not.toThrow();
  });
});

describe('fitImageForModel 的解码闸', () => {
  // 改了头的 PNG 校验和对不上,解码器本来也会抛 → 只看返回 null 分不出闸在不在,所以钉「根本没交给解码器」。
  it('头里写着天量像素的、隔行扫描的 PNG:不交给解码器', () => {
    const read = vi.spyOn(PNG.sync, 'read');
    const real = png(1800, 1500, quadrants(1800, 1500));
    const hugeHeader = Buffer.from(real); hugeHeader.writeUInt32BE(30_000, 16); hugeHeader.writeUInt32BE(30_000, 20); // 9 亿像素
    const interlaced = Buffer.from(real); interlaced[28] = 1; // pngjs 解隔行时 inflate 不封顶
    expect(fitImageForModel(hugeHeader)).toBeNull();
    expect(fitImageForModel(interlaced)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(fitImageForModel(real)).not.toBeNull(); // 对照:正常的图确实走解码器,上面那条不是空转
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
  });

  it('16 位的 PNG 不交给解码器', () => {
    const read = vi.spyOn(PNG.sync, 'read');
    const deep = Buffer.from(png(1800, 1500, quadrants(1800, 1500))); deep[24] = 16;
    expect(fitImageForModel(deep)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('只有帧头、没有画面数据的 JPEG:原样放行,不是「解」成一张灰图', () => {
    const real = jpg(2400, 1800, quadrants(2400, 1800));
    let sos = 2; // 沿着段走到 SOS(FF DA),把它连同后面的扫描数据全切掉
    while (real[sos + 1] !== 0xda) sos += 2 + real.readUInt16BE(sos + 2);
    const pad = Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, 0xff]), Buffer.alloc(65_533, 0x20)]); // 注释段,撑体积
    const noScan = Buffer.concat([real.subarray(0, sos), pad, pad, Buffer.from([0xff, 0xd9])]);
    expect(noScan.length).toBeGreaterThan(KEEP_BYTES);
    expect(() => jpeg.decode(noScan)).not.toThrow(); // 前提:解码器真的不拒它(否则这条测不到新加的闸)
    expect(fitImageForModel(noScan)).toBeNull();
  });
});

describe('fitImageUrlForModel', () => {
  it('不是 base64 data: URL 的、够小的:还回同一个字符串', () => {
    const http = 'https://example.com/a.png';
    expect(fitImageUrlForModel(http)).toBe(http);
    const small = `data:image/png;base64,${png(64, 64, quadrants(64, 64, false)).toString('base64')}`;
    expect(fitImageUrlForModel(small)).toBe(small);
    const broken = `data:image/png;base64,${Buffer.alloc(200_000, 1).toString('base64')}`;
    expect(fitImageUrlForModel(broken)).toBe(broken);
  });

  it('前缀带参数 / 大写 BASE64 的 data: URL 一样缩', () => {
    const b64 = png(1800, 1500, quadrants(1800, 1500)).toString('base64');
    for (const head of ['data:image/png;charset=utf-8;base64,', 'data:image/png;BASE64,', 'data:IMAGE/PNG;base64,']) {
      expect(fitImageUrlForModel(head + b64).startsWith('data:image/jpeg;base64,'), head).toBe(true);
    }
  });

  it('大图:换成缩后的 JPEG data: URL', () => {
    const src = png(1800, 1500, quadrants(1800, 1500));
    const out = fitImageUrlForModel(`data:image/png;base64,${src.toString('base64')}`);
    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(out.length).toBeLessThan(src.length); // base64 后仍比原图的二进制小
  });
});
