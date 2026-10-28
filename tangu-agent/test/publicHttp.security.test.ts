import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import dns from 'node:dns/promises';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fetchPublic, httpDeadline, readBodyCapped } from '../src/core/util/publicHttp.js';
import { resolvePublicHttpUrl } from '../src/core/util/urlSafety.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  // This hostname does not resolve: arrival itself proves the pinned address was used.
  return `http://pin.audit.invalid:${(server.address() as AddressInfo).port}`;
}
const pinned = async (raw: string) => ({ url: new URL(raw), addresses: ['127.0.0.1'] });

describe('shared public HTTP security contract', () => {
  it('pins HTTPS connections while preserving hostname, SNI, certificate verification and downgrade rejection', async () => {
    const cert = readFileSync(new URL('./fixtures/http-test-cert.fixture', import.meta.url));
    const key = readFileSync(new URL('./fixtures/http-test-key.fixture', import.meta.url));
    const names: string[] = [];
    const server = https.createServer({ cert, key }, (req, res) => {
      names.push(String((req.socket as any).servername));
      if (req.url === '/downgrade') res.writeHead(302, { location: 'http://pin.audit.invalid/private' });
      res.end('TLS verified');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
    const origin = `https://pin.audit.invalid:${(server.address() as AddressInfo).port}`;
    // Untrusted certificates must fail by default, before any HTTP reaches the server.
    await expect(fetchPublic(origin, {}, pinned)).rejects.toThrow();
    expect(names).toEqual([]);
    // Node >=22.19: add this test CA without disabling hostname/certificate checks.
    const roots = (tls as any).getCACertificates('default');
    (tls as any).setDefaultCACertificates([...roots, cert.toString()]);
    cleanups.push(async () => { (tls as any).setDefaultCACertificates(roots); });
    const page = await fetchPublic(origin, {}, pinned);
    expect((await readBodyCapped(page, 1024)).buf.toString()).toBe('TLS verified');
    expect(names).toEqual(['pin.audit.invalid']);
    await expect(fetchPublic(origin.replace('pin.audit.invalid', 'wrong.audit.invalid'), {}, pinned)).rejects.toThrow(/altname|hostname/i);
    await expect(fetchPublic(`${origin}/downgrade`, { crossOrigin: 'public-read' }, pinned)).rejects.toThrow(/downgrade/);
  });
  it.each([301, 302, 303, 307, 308])('same-origin POST %i preserves or rewrites actual body and headers', async (status) => {
    const seen: Array<{ path?: string; method?: string; type?: string; body: string; host?: string }> = [];
    const origin = await serve(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      seen.push({ path: req.url, method: req.method, body, type: req.headers['content-type'], host: req.headers.host });
      if (req.url === '/a') res.writeHead(status, { location: '/b' });
      res.end('ok');
    });
    const resolve = vi.fn(pinned);
    const page = await fetchPublic(`${origin}/a`, { method: 'POST', body: 'PAYLOAD', headers: { 'Content-Type': 'application/json' } }, resolve);
    expect((await readBodyCapped(page, 1024)).buf.toString()).toBe('ok');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(seen[0]).toMatchObject({ method: 'POST', body: 'PAYLOAD', host: new URL(origin).host });
    expect(seen[1]).toMatchObject(status < 307 ? { method: 'GET', body: '', type: undefined } : { method: 'POST', body: 'PAYLOAD', type: 'application/json' });
  });
  it('public-read cross-origin redirects remove arbitrary custom secrets', async () => {
    let received: IncomingMessage['headers'] | undefined;
    const destination = await serve((req, res) => { received = req.headers; res.end('public'); });
    const source = await serve((_req, res) => { res.writeHead(302, { location: destination }); res.end(); });
    const page = await fetchPublic(source, { crossOrigin: 'public-read', headers: { Authorization: 'SECRET', Cookie: 'SECRET', 'X-Unknown-Credential': 'SECRET', Accept: 'text/plain' } }, pinned);
    await readBodyCapped(page, 1024);
    expect(received?.accept).toBe('text/plain');
    expect(JSON.stringify(received)).not.toContain('SECRET');
  });
  it('rejects mixed public/private and empty DNS answers before any connection', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }] as any);
    await expect(fetchPublic('https://mixed.audit.invalid', {})).rejects.toThrow(/Private/);
    lookup.mockResolvedValueOnce([] as any);
    await expect(fetchPublic('https://empty.audit.invalid', {})).rejects.toThrow(/resolved/);
  });
  it('rejects redirect to loopback with the real validator before connecting there', async () => {
    let destinationCount = 0;
    const destination = await serve((_req, res) => { destinationCount++; res.end(); });
    const target = destination.replace('pin.audit.invalid', '127.0.0.1');
    const source = await serve((_req, res) => { res.writeHead(302, { location: target }); res.end(); });
    const resolve = async (raw: string) => raw === `${source}/` ? pinned(raw) : resolvePublicHttpUrl(raw);
    await expect(fetchPublic(`${source}/`, { crossOrigin: 'public-read' }, resolve)).rejects.toThrow(/Private/);
    expect(destinationCount).toBe(0);
  });
  it('deadline covers pending DNS and its late answer cannot send a request', async () => {
    let count = 0;
    const origin = await serve((_req, res) => { count++; res.end(); });
    let finish!: (value: Awaited<ReturnType<typeof pinned>>) => void;
    const deadline = httpDeadline(undefined, 30);
    try {
      await expect(fetchPublic(origin, { signal: deadline.signal }, () => new Promise((r) => { finish = r; }))).rejects.toThrow(/timed out/);
      finish(await pinned(origin));
      await new Promise((r) => setImmediate(r));
      expect(count).toBe(0);
    } finally { deadline.dispose(); }
  });
  it('one deadline covers the whole redirect chain, not each hop', async () => {
    let count = 0;
    const origin = await serve((_req, res) => { count++; setTimeout(() => { res.writeHead(302, { location: '/next' }); res.end(); }, 60); });
    const deadline = httpDeadline(undefined, 100);
    try {
      await expect(fetchPublic(origin, { signal: deadline.signal }, pinned)).rejects.toThrow();
      expect(deadline.timedOut()).toBe(true);
      expect(count).toBeLessThanOrEqual(2);
    } finally { deadline.dispose(); }
  });
  it('cancels body reading promptly and destroys the socket', async () => {
    let closed!: () => void;
    const socketClosed = new Promise<void>((r) => { closed = r; });
    const origin = await serve((req, res) => { req.on('close', closed); res.writeHead(200); res.write('partial'); });
    const ac = new AbortController();
    const page = await fetchPublic(origin, { signal: ac.signal }, pinned);
    const reading = readBodyCapped(page, 1024, ac.signal);
    ac.abort();
    await expect(reading).rejects.toThrow(/cancelled/);
    await socketClosed;
  });
  it('pre-abort skips DNS and cancellation between headers and reading is an error', async () => {
    const ac = new AbortController(); ac.abort();
    const resolve = vi.fn(pinned);
    await expect(fetchPublic('https://unused.audit.invalid', { signal: ac.signal }, resolve)).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    const origin = await serve((_req, res) => { res.writeHead(200); res.write('partial'); });
    const next = new AbortController();
    const page = await fetchPublic(origin, { signal: next.signal }, pinned);
    next.abort();
    await expect(readBodyCapped(page, 1024, next.signal)).rejects.toThrow(/cancelled/);
  });
});
