/**
 * CLI 凭证存储:~/.tangu/auth.json { cloudUrl, token }。
 * `tangu login` 写入,`tangu chat` / standalone 在未显式传 --token 时读取(去掉手动塞 token)。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Creds {
  cloudUrl?: string;
  token?: string;
  model?: string; // TUI 内 /model 选定后记住,下次免 --model
}

const dir = (): string => join(homedir(), '.tangu');
const file = (): string => join(dir(), 'auth.json');

export function loadCreds(): Creds {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Creds;
  } catch {
    return {};
  }
}

export function saveCreds(c: Creds): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(c, null, 2), 'utf8');
  try { chmodSync(file(), 0o600); } catch { /* best-effort 私有权限 */ }
}

/** 合并保存「最近使用的模型」（不动 token/cloudUrl）。TUI 内 /model 调用。 */
export function saveModel(model: string): void {
  const c = loadCreds();
  c.model = model;
  saveCreds(c);
}
