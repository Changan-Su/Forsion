/**
 * Provider OAuth 凭证存储:~/.tangu/provider-auth.json = { [providerId]: OAuthTokens }。
 * `tangu-chat login <provider>`(如 xai)写入;chat 启动时读出、按需刷新,接进 provider registry 当 LLM。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  baseUrl: string; // OpenAI 兼容推理根(如 https://api.x.ai/v1)
  tokenEndpoint: string; // 刷新用
  clientId: string;
}

const dir = (): string => join(homedir(), '.tangu');
const file = (): string => join(dir(), 'provider-auth.json');

export function loadProviderCreds(): Record<string, OAuthTokens> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, OAuthTokens>;
  } catch {
    return {};
  }
}

export function saveProviderCred(id: string, t: OAuthTokens): void {
  const all = loadProviderCreds();
  all[id] = t;
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(all, null, 2), 'utf8');
  try { chmodSync(file(), 0o600); } catch { /* best-effort */ }
}
