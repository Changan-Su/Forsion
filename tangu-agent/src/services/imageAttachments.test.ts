import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { fitUserImages, normalizeImageAttachments } from './imageAttachments.js';
import { inlineImageMime } from './heicImages.js';
import { encodePhotoForModel, MAX_EDGE, MAX_PIXELS } from './imageShrink.js';

const phone = readFileSync(new URL('../../test/fixtures/phone-digits.heic', import.meta.url));
const url = (mime: string, data = phone) => `data:${mime};base64,${data.toString('base64')}`;

describe('phone photo model input', () => {
  it('turns real HEIC bytes into a readable JPEG without mutating stored attachments', async () => {
    const attachment = { name: 'photo.HEIC', mimeType: 'image/heic', data: phone.toString('base64') };
    const raw = normalizeImageAttachments([attachment]);
    const images = await fitUserImages(raw);
    expect(images[0].url).toMatch(/^data:image\/jpeg;base64,/);
    const decoded = jpeg.decode(Buffer.from(images[0].url.split(',')[1], 'base64'));
    expect([decoded.width, decoded.height]).toEqual([620, 220]);
    // Our fixture has white margins and blue digits: the converted pixels must survive.
    expect([...decoded.data.subarray(0, 3)]).toEqual([255, 255, 255]);
    const pixel = (70 * decoded.width + 110) * 4;
    expect(decoded.data[pixel + 2]).toBeGreaterThan(decoded.data[pixel] + 60);
    expect(raw[0].url).toBe(url('image/heic'));
    expect(attachment.data).toBe(phone.toString('base64'));
    expect(await fitUserImages(raw)).toEqual(images); // history replay stays byte-stable
  });

  it('recognizes HEIF and mislabeled HEIC by bytes; fixes JPEG MIME labels', async () => {
    const [heif, wrong] = await fitUserImages([{ url: url('image/heif') }, { url: url('image/jpeg') }]);
    expect(heif).toEqual(wrong);
    const actual = Buffer.from(heif.url.split(',')[1], 'base64');
    expect((await fitUserImages([{ url: url('image/heic', actual) }]))[0].url).toBe(heif.url);
  });

  it('rejects corrupt HEIC locally and can still process the next image', async () => {
    await expect(fitUserImages([{ url: url('image/heic', Buffer.from('broken')) }]))
      .rejects.toThrow('image_attachment_conversion_failed');
    const truncated = phone.subarray(0, 100);
    await expect(fitUserImages([{ url: url('image/jpeg', truncated) }]))
      .rejects.toThrow('image_attachment_conversion_failed');
    const fresh = Buffer.from(phone);
    fresh.writeUInt32BE(42, 12); // Different ftyp minor version: a valid image absent from the cache.
    expect((await fitUserImages([{ url: url('image/heic', fresh) }]))[0].url).toMatch(/^data:image\/jpeg/);
  });

  it('leaves remote images and existing PNG/GIF/WebP input intact', async () => {
    const images = [{ url: 'https://example.com/photo.png' }, { url: 'data:image/png;base64,iVBORw0KGgo=' },
      { url: 'data:image/gif;base64,R0lGODlh' }, { url: 'data:image/webp;base64,UklGRgAAAABXRUJQ' }];
    expect(await fitUserImages(images)).toEqual(images);
  });

  it('does not mistake AVIF with a compatible mif1 brand for HEIC', () => {
    const header = Buffer.alloc(24); header.writeUInt32BE(24); header.write('ftyp', 4);
    header.write('avif', 8); header.write('mif1', 16);
    expect(inlineImageMime(header)).toBe('image/avif');
  });

  it('bounds converted photos to the viewing budget and refuses unsafe dimensions', () => {
    const photo = encodePhotoForModel(Buffer.alloc(2000 * 1000 * 4, 255), 2000, 1000);
    const decoded = jpeg.decode(photo);
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(MAX_EDGE);
    expect(decoded.width * decoded.height).toBeLessThanOrEqual(MAX_PIXELS);
    expect(() => encodePhotoForModel(new Uint8Array(), 100000, 100000)).toThrow('dimensions');
  });
});
