import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { extractText, extractImageMedias, extractFileMedias, decodeMediaBuffer } from './ilinkClient.js';

// 入站 item type：1=text 2=image 3=voice 4=file
describe('extractImageMedias（微信入站图片解析）', () => {
  it('抽出 type=2 图片项的 media（与出站 sendMedia 对称的 image_item.media）', () => {
    const items = [
      { type: 2, image_item: { media: { encrypt_query_param: 'PARAM', aes_key: 'KEY', encrypt_type: 1 }, mid_size: 1024 } },
    ];
    expect(extractImageMedias(items)).toEqual([
      { encrypt_query_param: 'PARAM', aes_key: 'KEY', encrypt_type: 1 },
    ]);
  });

  it('忽略文本/语音项；纯文本消息 → 空', () => {
    const items = [{ type: 1, text_item: { text: '你好' } }];
    expect(extractImageMedias(items)).toEqual([]);
    expect(extractText(items)).toBe('你好');
  });

  it('图文混合：文字与图片各自抽出（不互相吞）', () => {
    const items = [
      { type: 1, text_item: { text: '看这个' } },
      { type: 2, image_item: { media: { encrypt_query_param: 'P', aes_key: 'K', encrypt_type: 1 } } },
    ];
    expect(extractText(items)).toBe('看这个');
    expect(extractImageMedias(items)).toHaveLength(1);
  });

  it('缺 media / 缺 encrypt_query_param 的图片项跳过（防脏数据）', () => {
    expect(extractImageMedias([{ type: 2, image_item: {} }])).toEqual([]);
    expect(extractImageMedias([{ type: 2, image_item: { media: { aes_key: 'K' } } }])).toEqual([]);
    expect(extractImageMedias(undefined)).toEqual([]);
  });
});

describe('extractFileMedias（微信入站文件解析）', () => {
  it('抽出 type=4 文件项的 media + 文件名 + 原始大小', () => {
    const items = [
      { type: 4, file_item: { media: { encrypt_query_param: 'P', aes_key: 'K', encrypt_type: 1 }, file_name: 'report.pdf', len: '2048' } },
    ];
    expect(extractFileMedias(items)).toEqual([
      { media: { encrypt_query_param: 'P', aes_key: 'K', encrypt_type: 1, download_url: undefined }, fileName: 'report.pdf', size: 2048 },
    ]);
  });

  it('缺 media 的文件项跳过；文件名缺省 wechat-file', () => {
    expect(extractFileMedias([{ type: 4, file_item: {} }])).toEqual([]);
    const got = extractFileMedias([{ type: 4, file_item: { media: { encrypt_query_param: 'P' } } }]);
    expect(got[0]?.fileName).toBe('wechat-file');
    expect(got[0]?.size).toBe(0);
  });
});

describe('decodeMediaBuffer（入站媒体穷举解码）', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
  const key = randomBytes(16);
  const ecb = (buf: Buffer): Buffer => {
    const c = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([c.update(buf), c.final()]);
  };

  it('出站规范格式:aes_key = base64(32 字符 hex 串) + ECB', () => {
    const aesKey = Buffer.from(key.toString('hex'), 'ascii').toString('base64');
    const got = decodeMediaBuffer(ecb(PNG), aesKey);
    expect(got?.mimeType).toBe('image/png');
    expect(got?.buffer.equals(PNG)).toBe(true);
  });

  it('入站可能格式:aes_key = base64(原始 16 字节) + ECB', () => {
    const got = decodeMediaBuffer(ecb(PNG), key.toString('base64'));
    expect(got?.mimeType).toBe('image/png');
  });

  it('入站可能格式:aes_key = 裸 hex 串;CBC(零 IV) 也能解', () => {
    const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
    const cbc = Buffer.concat([c.update(PNG), c.final()]);
    expect(decodeMediaBuffer(cbc, key.toString('hex'))?.mimeType).toBe('image/png');
  });

  it('未加密直通:密文本身就是图片', () => {
    expect(decodeMediaBuffer(PNG, 'garbage-key')?.mimeType).toBe('image/png');
  });

  it('文件(不可嗅探):按 expectedSize 验真;错 key/无 size 拒绝', () => {
    const doc = randomBytes(1000); // 非图片
    const got = decodeMediaBuffer(ecb(doc), key.toString('base64'), 1000);
    expect(got?.buffer.equals(doc)).toBe(true);
    expect(got?.mimeType).toBe('application/octet-stream');
    expect(decodeMediaBuffer(ecb(doc), randomBytes(16).toString('base64'), 1000)).toBeNull();
    expect(decodeMediaBuffer(ecb(doc), key.toString('base64'))).toBeNull(); // 无 size → 无法验真
  });
});
