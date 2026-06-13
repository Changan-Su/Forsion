/**
 * ~/.tangu —— Tangu 本地 home 目录统一布局(单一事实来源,各处不再散落拼路径)。
 *
 *   ~/.tangu/
 *   ├── auth.json            Forsion 凭证 { cloudUrl, token, model }(credStore)
 *   ├── provider-auth.json   provider OAuth 凭证 { [providerId]: OAuthTokens }(providerCreds)
 *   ├── providers.json       直连 provider 配置 DirectProvider[](desktop Providers 页/手编;assemble 自动合并)
 *   ├── mcp.json             MCP server 配置 { mcpServers: {...} }(P6)
 *   ├── skills/              本地技能(<id>/SKILL.md,兼容 .claude 技能格式;P5)
 *   └── pgdata/              嵌入式 PGlite 数据目录
 *
 * 仅 standalone/TUI/desktop 形态使用;microserver/worker 不读本目录。
 * 测试/多实例可用 env TANGU_HOME 整体重定向。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

export function tanguHome(): string {
  return process.env.TANGU_HOME || join(homedir(), '.tangu');
}

export const envFile = (): string => join(tanguHome(), '.env');

/**
 * 加载 ~/.tangu/.env(KEY=VALUE 行;# 注释;引号可选)进 process.env——**已存在的环境变量不覆盖**
 * (真实 shell 环境 > .env 文件)。须在 parseConfig 之前调用;模板见包根 example.env。
 * 注:TANGU_HOME 本身只能来自真实环境(鸡生蛋:定位 .env 要先有 home)。
 */
export function loadTanguEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(envFile(), 'utf8');
  } catch {
    return; // 无 .env 是常态
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

export const authFile = (): string => join(tanguHome(), 'auth.json');
export const providerAuthFile = (): string => join(tanguHome(), 'provider-auth.json');
export const providersFile = (): string => join(tanguHome(), 'providers.json');
export const mcpConfigFile = (): string => join(tanguHome(), 'mcp.json');
export const skillsDir = (): string => join(tanguHome(), 'skills');
export const pgdataDir = (): string => join(tanguHome(), 'pgdata');
/** 嵌入式 SQLite 本地库文件(TUI / standalone / desktop 三端共用,故本地会话跨前端共享)。 */
export const stateDbPath = (): string => join(tanguHome(), 'state.db');

/** 确保 home 及子目录存在(幂等);返回 home 路径。 */
export function ensureHome(): string {
  mkdirSync(skillsDir(), { recursive: true });
  return tanguHome();
}
