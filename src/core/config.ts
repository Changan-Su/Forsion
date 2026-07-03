/**
 * ~/.tangu/config.json —— Tangu 本地实例配置的**单一事实来源(唯一真源)**。
 *
 * 一处编辑、CLI 友好:cloud / database / server / sandbox / workspace / providers / mcp /
 * engines / enginePrefs / specialAgents / plugins / browser / wechat / notes / tts 全段集中于此文件。
 *
 * 设计(刻意保持 generic,避免与各 section 模块循环依赖):
 *   - 本模块只做「config.json 的通用 JSON 读写 + 段取用」,**不** import 任何 section 模块,
 *     **不**做 per-section 归一化(归一化留在各 section 模块自己,如 mcp/config、specialAgentsConfig)。
 *   - 读取语义:config.json **存在即权威**——`getRawSection(name)` 返回该段原始值;返回 undefined
 *     表示该段缺失,调用方据此回落自己的 legacy 文件读取(过渡期 / 单测)。
 *   - 写入语义:`saveSection(name, value)` 一律落 config.json(深合并保留其他段)→ 唯一真源。
 *   - 迁移:`migrateLegacyConfig()` 首启把散落的 auth/providers/mcp/engines/engine-prefs/
 *     special-agents JSON 收进 config.json,旧文件 rename 为 `*.bak`(可回滚,不删)。
 *     `.env` **不动**(仍由 loadTanguEnv 载入 process.env;env 始终可覆盖 config.json,运维逃生口)。
 *
 * 仅 standalone/TUI/desktop 形态使用;microserver/worker 不读本目录。chmod 600(含 token/apiKey)。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import {
  configFile, tanguHome, authFile, providersFile, mcpConfigFile,
  enginesFile, enginePrefsFile, specialAgentsConfigFile,
} from './tanguHome.js';

/** config.json 是否存在(存在即权威)。 */
export function configExists(): boolean {
  return existsSync(configFile());
}

/** 读整个 config.json;不存在 / 坏 JSON → null(坏 JSON 由桌面编辑器另行提示)。 */
export function loadRawConfig(): Record<string, any> | null {
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 取某段原始值。config.json 不存在或该段缺失 → undefined(调用方回落 legacy 文件)。
 * 注意:段「存在但为空」(如 `{ "mcp": {} }`)返回 `{}`(权威空),**不**回落。
 */
export function getRawSection(name: string): any {
  const c = loadRawConfig();
  if (!c) return undefined;
  return c[name];
}

function writeConfig(c: Record<string, any>): void {
  mkdirSync(tanguHome(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(c, null, 2), 'utf8');
  try { chmodSync(configFile(), 0o600); } catch { /* best-effort 私有权限(含 token/apiKey) */ }
}

/** 深合并某段并落盘(其他段原样保留),返回写后的整份配置。唯一写入口。 */
export function saveSection(name: string, value: any): Record<string, any> {
  const c = loadRawConfig() || {};
  c[name] = value;
  writeConfig(c);
  return c;
}

/** 读一个 JSON 文件,失败返回 undefined。 */
function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/**
 * 首启一次性迁移:config.json 不存在时,把散落的 legacy JSON 收进来,旧文件 → `*.bak`。
 * 幂等(config.json 已存在 → 直接返回)。无任何 legacy 文件(全新安装)→ 不创建空 config.json
 * (留待首次 saveSection 创建)。`.env` 不迁移、不改动。
 */
export function migrateLegacyConfig(): void {
  if (configExists()) return;

  const c: Record<string, any> = {};

  const auth = readJson(authFile()); // { cloudUrl, token, model }
  if (auth && typeof auth === 'object') {
    c.cloud = { url: auth.cloudUrl || '', token: auth.token || '', defaultModel: auth.model || '' };
  }

  const prov = readJson(providersFile()); // 裸数组 或 { providers: [...] }
  const provArr = Array.isArray(prov) ? prov : Array.isArray(prov?.providers) ? prov.providers : undefined;
  if (provArr) c.providers = provArr;

  const mcp = readJson(mcpConfigFile()); // { mcpServers: {...} }
  if (mcp?.mcpServers && typeof mcp.mcpServers === 'object') c.mcp = { mcpServers: mcp.mcpServers };

  const eng = readJson(enginesFile()); // { engines: [...] }
  if (Array.isArray(eng?.engines)) c.engines = { engines: eng.engines };

  const prefs = readJson(enginePrefsFile()); // { [id]: { defaultModel } }
  if (prefs && typeof prefs === 'object') c.enginePrefs = prefs;

  const special = readJson(specialAgentsConfigFile()); // { historian, muse }
  if (special && typeof special === 'object') c.specialAgents = special;

  if (Object.keys(c).length === 0) return; // 全新安装:无可迁移内容,不落空文件

  writeConfig(c);

  // 旧文件 → .bak(停止被读、可恢复,不删)。
  for (const f of [authFile(), providersFile(), mcpConfigFile(), enginesFile(), enginePrefsFile(), specialAgentsConfigFile()]) {
    try { if (existsSync(f)) renameSync(f, `${f}.bak`); } catch { /* best-effort */ }
  }
}
