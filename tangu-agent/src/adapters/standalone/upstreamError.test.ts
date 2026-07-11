import { describe, it, expect } from 'vitest';
import { friendlyUpstreamError } from './upstreamError.js';

describe('friendlyUpstreamError', () => {
  it('replaces openresty 504 HTML with a short message (no HTML/openresty leak)', () => {
    const html = '<html> <head><title>504 Gateway Time-out</title></head> <body><center>openresty</center></body> </html>';
    const msg = friendlyUpstreamError(504, html);
    expect(msg).not.toMatch(/<html|openresty/i);
    expect(msg).toContain('504');
  });

  it('maps 502/503 HTML to an unavailable message', () => {
    expect(friendlyUpstreamError(502, '<html>502 Bad Gateway</html>')).toContain('502');
    expect(friendlyUpstreamError(503, '<!DOCTYPE html><html>x</html>')).toContain('503');
  });

  it('passes non-HTML backend detail through verbatim', () => {
    expect(friendlyUpstreamError(400, 'modelId and payload required')).toBe('modelId and payload required');
  });

  it('falls back to the sentinel when body is empty', () => {
    expect(friendlyUpstreamError(500, '')).toBe('brain stream 500');
  });
});
