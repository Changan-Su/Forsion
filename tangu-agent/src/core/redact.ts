/** 机械脱敏兜底(提示词也要求,双保险):常见 token/key 形状一律替换。
 *  hex 阈值取 48:不误伤 40 位 git SHA(记忆里常见且有用),仍盖住 64 位 hex 密钥。
 *  (原住 services/localHistorian.ts;harnessStore 也要用,挪进 core 免拖 db/seams 依赖树。) */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{48,}\b/g, '[REDACTED]');
}
