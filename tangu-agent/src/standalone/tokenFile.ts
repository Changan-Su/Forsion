/**
 * 云端令牌放文件里(cloud.tokenFile / TANGU_TOKEN_FILE):长跑的引擎每次调云端现读,换发的令牌不用重启就能接上。
 * 文件是 `{"token":"..."}` 或纯文本。
 */
import { readFileSync } from 'node:fs';

/** 读不到 / 解析不了 / 没有令牌 → ''。这表示「不知道」,不是「没有令牌」,由调用方决定怎么办。 */
export function readTokenFile(file: string): string {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const value = raw.startsWith('{') ? (JSON.parse(raw) as { token?: unknown })?.token : raw;
    // 令牌要进请求头:带空白的不是令牌(写到一半的文件、一段报错文本)。
    return typeof value === 'string' && /^\S+$/.test(value.trim()) ? value.trim() : '';
  } catch { return ''; }
}

/** 每次调用现读;读失败保留上一个好令牌:断电后零字节的文件、换发时的半截写入,都不能把长跑实例打成未登录。 */
export function tokenFileSource(file: string, initial = ''): () => string {
  let last = initial;
  return () => {
    const token = readTokenFile(file);
    if (token) last = token;
    return last;
  };
}

/** httpBrain 用的云端凭据:配了 tokenFile 就是现读的函数,否则是启动时那个固定串。 */
export function cloudCredential(cfg: { token: string; tokenFile?: string }): string | (() => string) {
  return cfg.tokenFile ? tokenFileSource(cfg.tokenFile, cfg.token) : cfg.token;
}
