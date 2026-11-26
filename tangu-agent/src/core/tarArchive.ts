/**
 * A small tar (ustar + PAX path records) writer and reader, enough for account backups (standalone/accountBackup.ts).
 * Regular files and directories only: links, devices, FIFOs and sparse entries are never written and are refused when read.
 * The reader streams entry bodies (archives can be a few hundred MB) and never trusts a name: callers validate every path
 * before touching the disk.
 */
const BLOCK = 512;
const ZERO = Buffer.alloc(BLOCK);
const MAX_PAX = 64 * 1024;
const MAX_NAME = 4096;

export type TarEntryType = 'file' | 'dir';

function octal(value: number, width: number): string {
  const s = Math.max(0, Math.floor(value)).toString(8);
  if (s.length > width - 1) throw new Error('tar field overflow');
  return s.padStart(width - 1, '0') + '\0';
}

function header(name: string, typeflag: string, size: number, mode: number, mtimeSec: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtimeSec, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(typeflag, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

const pad = (size: number): Buffer => (size % BLOCK ? Buffer.alloc(BLOCK - (size % BLOCK)) : Buffer.alloc(0));
const plainName = (name: string): boolean => Buffer.byteLength(name) <= 99 && /^[\x20-\x7e]*$/.test(name);

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body);
  let total = len + String(len).length;
  while (String(total).length + len !== total) total = len + String(total).length;
  return Buffer.from(`${total}${body}`, 'utf8');
}

/** Header block(s) for an entry: a PAX record first when the name does not fit plain ustar. */
export function tarEntryHeader(name: string, type: TarEntryType, size: number, mode: number, mtimeSec = 0): Buffer {
  if (!name || Buffer.byteLength(name) > MAX_NAME || name.includes('\0')) throw new Error('tar entry name is invalid');
  const flag = type === 'dir' ? '5' : '0';
  const entrySize = type === 'dir' ? 0 : size;
  if (plainName(name)) return header(name, flag, entrySize, mode, mtimeSec);
  const pax = paxRecord('path', name);
  return Buffer.concat([header('PaxHeader', 'x', pax.length, 0o644, mtimeSec), pax, pad(pax.length), header('long-name', flag, entrySize, mode, mtimeSec)]);
}

export const tarPadding = pad;
/** Two zero blocks end the archive. */
export const tarEnd = (): Buffer => Buffer.alloc(BLOCK * 2);

// ── reading ───────────────────────────────────────────────────────────────────────────

class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(private readonly it: AsyncIterator<Buffer>) {}
  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) { this.done = true; break; }
      const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value as Uint8Array);
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    }
    return this.buf.length >= n;
  }
  async read(n: number): Promise<Buffer> {
    if (!(await this.fill(n))) throw new Error('tar archive is truncated');
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  /** Hands exactly n bytes to sink in pieces. */
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (!this.buf.length && !(await this.fill(1))) throw new Error('tar archive is truncated');
      const piece = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(piece.length);
      left -= piece.length;
      yield piece;
    }
  }
}

function field(h: Buffer, start: number, len: number): string {
  const raw = h.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul < 0 ? len : nul).toString('utf8');
}
function num(h: Buffer, start: number, len: number): number {
  const s = field(h, start, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error('tar header has a non-octal number');
  return s ? parseInt(s, 8) : 0;
}
function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return num(h, 148, 8) === sum;
}
function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) throw new Error('tar PAX record is malformed');
    const len = Number(body.subarray(i, sp).toString('ascii'));
    if (!Number.isSafeInteger(len) || len <= 0 || i + len > body.length) throw new Error('tar PAX record is malformed');
    const rec = body.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq <= 0) throw new Error('tar PAX record is malformed');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export interface TarEntry { name: string; type: TarEntryType; size: number; mode: number }
export interface TarHandler {
  /** Called for every entry, in order. A file's body must be fully consumed (or the call must throw). */
  entry(e: TarEntry, body: AsyncIterable<Buffer>): Promise<void>;
}

/**
 * Reads an uncompressed tar stream. Throws on anything that is not a regular file, a directory or a PAX path record,
 * on a bad checksum, and on a truncated archive. Bodies are streamed to the handler.
 */
export async function readTar(source: AsyncIterable<Buffer>, handler: TarHandler, limits: { maxEntries: number }): Promise<void> {
  const r = new ByteReader(source[Symbol.asyncIterator]());
  let pending: Record<string, string> | null = null;
  let entries = 0;
  for (;;) {
    const h = await r.read(BLOCK);
    if (h.equals(ZERO)) {
      const next = await r.read(BLOCK).catch(() => ZERO);
      if (next.equals(ZERO)) return;
      throw new Error('tar archive has a stray empty block');
    }
    if (!checksumOk(h)) throw new Error('tar header checksum does not match');
    const magic = field(h, 257, 6);
    if (magic !== 'ustar') throw new Error('tar entry is not ustar');
    const flag = String.fromCharCode(h[156] || 0x30);
    const size = num(h, 124, 12);
    if (flag === 'x') {
      if (size > MAX_PAX || pending) throw new Error('tar PAX record is not allowed here');
      const body = await r.read(size);
      await r.read(pad(size).length);
      pending = parsePax(body);
      continue;
    }
    if (flag !== '0' && flag !== '5') throw new Error(`tar entry type ${JSON.stringify(flag)} is not allowed`);
    if (++entries > limits.maxEntries) throw new Error('tar archive has too many entries');
    const prefix = field(h, 345, 155);
    let name = pending?.path ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    pending = null;
    if (!name || name.length > MAX_NAME || name.includes('\0')) throw new Error('tar entry name is invalid');
    const type: TarEntryType = flag === '5' ? 'dir' : 'file';
    if (type === 'dir') name = name.replace(/\/+$/, '');
    const bodySize = type === 'dir' ? 0 : size;
    let consumed = false;
    const body = (async function* () { consumed = true; yield* r.take(bodySize); })();
    await handler.entry({ name, type, size: bodySize, mode: num(h, 100, 8) }, body);
    if (bodySize > 0 && !consumed) for await (const _ of r.take(bodySize)) { /* skip */ }
    await r.read(pad(bodySize).length);
  }
}
