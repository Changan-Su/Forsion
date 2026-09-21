/**
 * Grok Build CLI proxy 的请求契约。
 *
 * Grok OAuth token 不是 api.x.ai 的 API key。它必须连到 CLI chat proxy，并带上
 * CLI 身份头；缺少 client version 时 proxy 会以 426 拒绝请求。版本与 Grok Build
 * 官方 lockstep version crate 对齐（2026-09-17 上游为 1.0.35）。
 */
export const GROK_BUILD_CLIENT_VERSION = '1.0.35';
export const GROK_BUILD_CLIENT_IDENTIFIER = 'grok-shell';
export const GROK_BUILD_CLIENT_MODE = 'interactive';

/**
 * OAuth access token 是 JWT 时，`sub` 是 xAI CLI 用于 `x-userid` 的账户标识。
 * 这里只做本地 payload 解码以复刻 CLI 的请求头，不把 token 或 claim 写日志/磁盘。
 */
export function extractGrokBuildUserId(accessToken: string | undefined): string | undefined {
  if (!accessToken || typeof accessToken !== 'string') return undefined;
  const payload = accessToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.sub;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 构造 CLI proxy 的公共请求头；模型请求再追加 model override。 */
export function buildGrokBuildHeaders(accessToken: string | undefined, modelId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': GROK_BUILD_CLIENT_VERSION,
    'x-grok-client-identifier': GROK_BUILD_CLIENT_IDENTIFIER,
    'x-grok-client-mode': GROK_BUILD_CLIENT_MODE,
    'User-Agent': `grok-shell/${GROK_BUILD_CLIENT_VERSION}`,
  };
  const userId = extractGrokBuildUserId(accessToken);
  if (userId) headers['x-userid'] = userId;
  if (typeof modelId === 'string' && modelId.trim()) headers['x-grok-model-override'] = modelId.trim();
  return headers;
}
