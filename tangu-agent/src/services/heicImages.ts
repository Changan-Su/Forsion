import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { encodePhotoForModel } from './imageShrink.js';

const require = createRequire(import.meta.url);
const ERROR = 'image_attachment_conversion_failed';
const MAX_PIXELS = 24_000_000;
const CACHE_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheBytes = 0;
// Phone decoders can use hundreds of MB: only one is alive in this engine at a time.
let pending: Promise<unknown> = Promise.resolve();

// Fixed worker program, matching fileSearchWorker's source/compiled entrypoint contract.
// Only HEIF decoding runs here; no executable content comes from the attachment.
const PROGRAM = String.raw`
(async () => {
  const { parentPort, workerData } = await import('node:worker_threads');
  const { createRequire } = await import('node:module');
  const require = createRequire(workerData.module);
  const heif = require(workerData.module);
  await heif.ready;
  const decoder = new heif.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(new Uint8Array(workerData.bytes));
    const image = images.find((image) => image.is_primary()) || images[0];
    if (!image) throw new Error('No image');
    const width = image.get_width(), height = image.get_height();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width * height > workerData.maxPixels) throw new Error('Image too large');
    const rgba = await new Promise((resolve, reject) => image.display(
      { data: new Uint8ClampedArray(width * height * 4), width, height },
      result => result ? resolve(result.data) : reject(new Error('Decode failed'))));
    parentPort.postMessage({ width, height, data: rgba.buffer }, [rgba.buffer]);
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) heif.heif_context_free(decoder.decoder);
  }
})().catch(async () => { (await import('node:worker_threads')).parentPort.postMessage({ error: true }); });
`;

function decode(bytes: Buffer): Promise<{ data: Uint8Array; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PROGRAM, { eval: true, workerData: {
      module: require.resolve('libheif-js/wasm-bundle'), bytes, maxPixels: MAX_PIXELS,
    }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let finished = false;
    const finish = (error?: Error, result?: { data: Uint8Array; width: number; height: number }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Release decoder/WASM memory before allowing the next queued photo to start.
      void worker.terminate().finally(() => error ? reject(error) : resolve(result!));
    };
    const timer = setTimeout(() => finish(new Error(ERROR)), 30_000);
    worker.once('message', (m) => {
      if (m.error || !(m.data instanceof ArrayBuffer)) finish(new Error(ERROR));
      else finish(undefined, { data: new Uint8Array(m.data), width: m.width, height: m.height });
    });
    worker.once('error', () => finish(new Error(ERROR)));
    worker.once('exit', () => finish(new Error(ERROR)));
  });
}

/** Inspect bytes, not the filename/MIME: AirDrop and file pickers can mislabel photos. */
export function inlineImageMime(bytes: Buffer): string | undefined {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0);
    if (size < 16 || size > bytes.length || size > 1024) return;
    const brands = [bytes.toString('ascii', 8, 12)];
    for (let p = 16; p + 4 <= size; p += 4) brands.push(bytes.toString('ascii', p, p + 4));
    // AVIF also advertises mif1: do not accidentally send it through the HEVC decoder.
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'image/avif';
    if (brands.some((b) => /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(b))) return 'image/heic';
  }
}

/** Convert only the model's copy; stored attachments retain the original bytes. */
export async function prepareInlineImage(url: string): Promise<string> {
  const match = /^data:([^;,]+);base64,/i.exec(url);
  if (!match) return url;
  const bytes = Buffer.from(url.slice(match[0].length), 'base64');
  const mime = inlineImageMime(bytes);
  const heic = mime === 'image/heic' || (!mime && /^image\/hei[cf](?:-sequence)?$/i.test(match[1]));
  if (!heic) return mime ? `data:${mime};base64,${url.slice(match[0].length)}` : url;
  if (bytes.length > 6_000_000) throw new Error(ERROR);
  const key = createHash('sha256').update(bytes).digest('hex');
  const convert = async () => {
    const hit = cache.get(key);
    if (hit) return hit;
    try {
      const decoded = await decode(bytes);
      const result = `data:image/jpeg;base64,${encodePhotoForModel(decoded.data, decoded.width, decoded.height).toString('base64')}`;
      while (cache.size && cacheBytes + result.length > CACHE_BYTES) {
        const [oldKey, old] = cache.entries().next().value!;
        cache.delete(oldKey); cacheBytes -= old.length;
      }
      if (result.length <= CACHE_BYTES) { cache.set(key, result); cacheBytes += result.length; }
      return result;
    } catch { throw new Error(ERROR); }
  };
  const result = pending.then(convert);
  pending = result.catch(() => {});
  return result;
}
