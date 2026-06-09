/**
 * SSRF 防护(vendored,C 类纯函数;原 server/microserver/ai-studio/services/urlSafety.ts)。
 * 把任意 URL 解析为「确认指向公网」的 URL,杜绝打内网/回环/云元数据。
 * 仅 http/https;拒绝 localhost;DNS 解析所有 A/AAAA 记录,任一落在私有/保留段即拒。
 */
import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) {
    return isPrivateIpv4(value.slice('::ffff:'.length));
  }
  return (
    value === '::1' ||
    value === '::' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:')
  );
}

export function isBlockedAddress(address: string): boolean {
  const ipType = net.isIP(address);
  if (ipType === 4) return isPrivateIpv4(address);
  if (ipType === 6) return isPrivateIpv6(address);
  return true;
}

/** 解析并校验 URL 指向公网;通过则返回 URL 对象,否则抛错。 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Localhost URLs are not allowed');
  }

  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('Private or reserved IP addresses are not allowed');
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error('URL hostname could not be resolved');
  if (records.some((record) => isBlockedAddress(record.address))) {
    throw new Error('Private or reserved IP addresses are not allowed');
  }

  return parsed;
}
