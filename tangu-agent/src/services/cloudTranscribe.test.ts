/** 云端转写的切段(services/cloudTranscribe.ts):≤30 秒一段、切在安静处、按偏移读、拼回顺序、没人声的段算空、失败带段号。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transcribeFileViaCloud, wavHeader, CLOUD_WHOLE_MAX_BYTES } from './cloudTranscribe.js';

const SR = 16000;
let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'cloud-asr-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** 「人声」= 大幅噪声,silences 里的 [from,to) 秒是静音。 */
function speechWav(seconds: number, silences: Array<[number, number]> = []): Buffer {
  const n = Math.round(seconds * SR);
  const pcm = Buffer.alloc(n * 2);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const quiet = silences.some(([a, b]) => t >= a && t < b);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pcm.writeInt16LE(quiet ? 0 : ((seed % 16000) - 8000), i * 2);
  }
  return Buffer.concat([wavHeader(pcm.length, SR), pcm]);
}
const file = (name: string, data: Buffer): string => { const p = path.join(dir, name); writeFileSync(p, data); return p; };
/** 发出去的每段:时长(秒)、是不是合法的 16k 单声道 WAV。 */
function recorder(reply?: (i: number, audio: Buffer) => string | Promise<string>) {
  const sent: Array<{ seconds: number; mime: string; wav: boolean }> = [];
  const send = async (audio: Buffer, mime: string) => {
    const i = sent.length;
    const wav = audio.toString('ascii', 0, 4) === 'RIFF' && audio.readUInt32LE(24) === SR && audio.readUInt16LE(22) === 1;
    sent.push({ seconds: (audio.length - 44) / 2 / SR, mime, wav });
    return reply ? reply(i, audio) : `part ${i}`;
  };
  return { sent, send };
}

describe('transcribeFileViaCloud', () => {
  it('a short WAV goes in one request; timestamps cover its real length', async () => {
    const r = recorder(() => 'hello');
    const out = await transcribeFileViaCloud(file('short.wav', speechWav(12)), { timestamps: true }, r.send);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].mime).toBe('audio/wav');
    expect(out).toEqual({ text: 'hello', segments: [{ start: 0, end: 12, text: 'hello' }] });
  });

  it('a long WAV is split into pieces of at most 30 s, cut in the quiet parts, and joined back in order', async () => {
    const r = recorder(async (i, audio) => { await new Promise((ok) => setTimeout(ok, (3 - i) * 15)); return ((audio.length - 44) / 2 / SR).toFixed(2); });
    const out = await transcribeFileViaCloud(file('long.wav', speechWav(95, [[24, 25], [51, 52], [77, 78]])), { timestamps: true }, r.send);
    expect(r.sent.length).toBe(4);
    for (const s of r.sent) { expect(s.wav).toBe(true); expect(s.seconds).toBeLessThanOrEqual(30); }
    expect(r.sent.reduce((a, s) => a + s.seconds, 0)).toBeCloseTo(95, 3);
    // 切点落在静音里
    const cuts = out.segments!.slice(0, -1).map((s) => s.end);
    expect(cuts[0]).toBeGreaterThanOrEqual(24); expect(cuts[0]).toBeLessThan(25);
    expect(cuts[1]).toBeGreaterThanOrEqual(51); expect(cuts[1]).toBeLessThan(52);
    expect(cuts[2]).toBeGreaterThanOrEqual(77); expect(cuts[2]).toBeLessThan(78);
    // 并发送出去、回来的先后不定:每段回自己的时长,拼回去的顺序必须是段的顺序
    expect(out.segments!.map((s) => s.text)).toEqual(out.segments!.map((s) => (s.end - s.start).toFixed(2)));
    expect(out.text).toBe(out.segments!.map((s) => s.text).join('\n'));
    expect(out.segments![0].start).toBe(0);
    expect(out.segments![3].end).toBeCloseTo(95, 3);
  });

  it('without quiet parts it still cuts at most every 30 s; without timestamps there are no segments', async () => {
    const r = recorder();
    const out = await transcribeFileViaCloud(file('dense.wav', speechWav(70)), {}, r.send);
    expect(r.sent.length).toBe(3);
    for (const s of r.sent) expect(s.seconds).toBeLessThanOrEqual(30);
    expect(out.segments).toBeUndefined();
  });

  it('a piece with no speech is empty text, not a failure', async () => {
    const r = recorder((i) => { if (i === 1) throw new Error('cloud transcription 502: upstream(native) 400: ASR_RESPONSE_HAVE_NO_WORDS'); return `p${i}`; });
    const out = await transcribeFileViaCloud(file('music.wav', speechWav(65)), { timestamps: true, concurrency: 1 }, r.send);
    expect(out.text).toBe('p0\np2');
    expect(out.segments!.map((s) => s.text)).toEqual(['p0', 'p2']);
  });

  it('any other failure fails the whole call and names the piece; no half transcript', async () => {
    const r = recorder((i) => { if (i === 1) throw new Error('cloud transcription 402 (quota exceeded): token_quota_exceeded'); return 'x'; });
    await expect(transcribeFileViaCloud(file('quota.wav', speechWav(65)), { concurrency: 1 }, r.send)).rejects.toThrow(/chunk 2\/3 .*402/);
    expect(r.sent.length).toBe(2); // 失败后不再发后面的段
  });

  it('stereo or other formats go whole when small, and are refused when too large to send whole', async () => {
    const stereo = Buffer.concat([speechWav(1)]);
    stereo.writeUInt16LE(2, 22); // 声道数改成 2:不能原样切
    const r = recorder(() => 'whole');
    expect(await transcribeFileViaCloud(file('stereo.wav', stereo), { timestamps: true }, r.send)).toEqual({ text: 'whole' });
    const m4a = file('clip.m4a', Buffer.from('not really m4a'));
    const r2 = recorder(() => 'm4a');
    expect(await transcribeFileViaCloud(m4a, {}, r2.send)).toEqual({ text: 'm4a' });
    expect(r2.sent[0].mime).toBe('audio/mp4');
    const big = path.join(dir, 'big.mp3');
    writeFileSync(big, '');
    truncateSync(big, CLOUD_WHOLE_MAX_BYTES + 1);
    const r3 = recorder();
    await expect(transcribeFileViaCloud(big, {}, r3.send)).rejects.toThrow(/16 kHz mono WAV/);
    expect(r3.sent).toHaveLength(0);
  });

  it('audio longer than the cap is refused before anything is sent', async () => {
    const r = recorder();
    await expect(transcribeFileViaCloud(file('cap.wav', speechWav(70)), { maxAudioSec: 60 }, r.send)).rejects.toThrow(/at most 1 minutes/);
    expect(r.sent).toHaveLength(0);
  });

  it('a stopped turn stops sending', async () => {
    const ac = new AbortController();
    const r = recorder((i) => { if (i === 0) ac.abort(); return 'x'; });
    await expect(transcribeFileViaCloud(file('abort.wav', speechWav(95)), { signal: ac.signal, concurrency: 1 }, r.send)).rejects.toThrow(/stopped/);
    expect(r.sent.length).toBe(1);
  });

  it('a header that claims more data than the file has is clamped to the file', async () => {
    const w = speechWav(40);
    w.writeUInt32LE(0xffffffff, 40); // 流式写的 WAV:data 长度不可信
    const r = recorder();
    const out = await transcribeFileViaCloud(file('stream.wav', w), { timestamps: true }, r.send);
    expect(r.sent.reduce((a, s) => a + s.seconds, 0)).toBeCloseTo(40, 3);
    expect(out.segments![out.segments!.length - 1].end).toBeCloseTo(40, 3);
  });
});
