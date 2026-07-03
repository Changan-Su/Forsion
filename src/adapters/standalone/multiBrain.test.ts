import { describe, it, expect } from 'vitest';
import { pcmToWav } from './multiBrain.js';

// CosyVoice 走 WS 取 pcm 后自封 WAV;微信只认头部合法的 WAV,这里守住头部字节正确。
describe('pcmToWav', () => {
  it('writes a correct 44-byte mono 16-bit header', () => {
    const pcm = new Uint8Array(1000).fill(7);
    const wav = Buffer.from(pcmToWav(pcm, 24000));
    expect(wav.length).toBe(44 + 1000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(4)).toBe(36 + 1000); // RIFF chunk size = 36 + data
    expect(wav.readUInt16LE(20)).toBe(1);         // PCM
    expect(wav.readUInt16LE(22)).toBe(1);         // mono
    expect(wav.readUInt32LE(24)).toBe(24000);     // sample rate
    expect(wav.readUInt32LE(28)).toBe(24000 * 2); // byte rate = rate * blockAlign
    expect(wav.readUInt16LE(32)).toBe(2);         // block align
    expect(wav.readUInt16LE(34)).toBe(16);        // bits/sample
    expect(wav.readUInt32LE(40)).toBe(1000);      // data size
    expect(wav[44]).toBe(7);                      // payload starts right after header
  });
});
