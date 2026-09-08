/**
 * Provider OAuth 凭证存储:~/.tangu/provider-auth.json = { [providerId]: OAuthTokens }。
 * `tangu-chat login <provider>`(如 xai)写入;chat 启动时读出、按需刷新,接进 provider registry 当 LLM。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { providerAuthFile } from '../core/tanguHome.js';

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  baseUrl: string; // OpenAI 兼容推理根(如 https://api.x.ai/v1)
  tokenEndpoint: string; // 刷新用
  clientId: string;
  account_id?: string; // Codex 订阅:chatgpt-account-id(从 id_token JWT 解出)
  modelIds?: string[]; // 登录时从 provider /models 端点拉取并缓存(空或 stale 时启动懒刷;失败回退硬编提示)
  modelIdsAt?: number; // modelIds 拉取时刻 epoch ms(TTL 判 stale 用)
  modelIdsClientVersion?: string; // Codex 目录按客户端版本过滤;版本变化立即重拉(旧文件缺字段同样重拉)
}

const dir = (): string => dirname(providerAuthFile()); // 共享域(home=…/tangu 时为其父目录)
const file = (): string => providerAuthFile();

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
