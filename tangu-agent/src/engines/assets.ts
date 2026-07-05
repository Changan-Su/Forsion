/**
 * 外部引擎(Claude Code / Codex)已装 skills/MCP 的发现 + 按需导入成 Tangu 自有资产(host-only)。
 *   - skill:复制 <engine>/skills/<name>/ 整个文件夹 → ~/.tangu/skills/<name>/(含 references/scripts 资源),
 *     之后经 skills/localSkills 以 `local:<name>` 自然出现,与自有技能同权。
 *   - mcp:读引擎 mcp 配置(.claude.json=json / config.toml=toml),归一化写入 ~/.tangu/mcp.json;
 *     按 mcp/config.ts 约定**默认 enabled:false**——外来配置可能指向引擎私有 binary,用户在 MCP 设置里显式启用。
 * 故意只识别内置两家(自定义引擎走 engines.json,磁盘布局未知 → 不发现);新增一家只加一条 SPEC。
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseFrontmatter } from '../skills/localSkills.js';
import { skillsDir } from '../core/tanguHome.js';
import { loadMcpConfig, saveMcpConfig, type McpServerConfig } from '../mcp/config.js';

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

interface EngineAssetSpec {
  /** 文件夹式技能根:<dir>/<name>/SKILL.md(同 Tangu 自有布局,导入即整夹复制)。 */
  skillsDir: string;
  /** mcp 配置文件 + 格式;json 取 .mcpServers,toml 取 .mcp_servers。 */
  mcp?: { file: string; format: 'json' | 'toml' };
}

// 只覆盖内置两家(id 同 engines/config.ts)。Codex 技能在 ~/.codex/skills(非旧版 prompts)。
const SPECS: Record<string, EngineAssetSpec> = {
  'claude-code': { skillsDir: '~/.claude/skills', mcp: { file: '~/.claude.json', format: 'json' } },
  codex: { skillsDir: '~/.codex/skills', mcp: { file: '~/.codex/config.toml', format: 'toml' } },
};

export interface EngineSkillItem {
  name: string;
  description: string;
  imported: boolean;
}
export interface EngineMcpItem {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  imported: boolean;
}
export interface EngineAssets {
  skills: EngineSkillItem[];
  mcp: EngineMcpItem[];
}

/** 解析引擎 mcp 原文 → { name: rawServer }(纯函数,json/toml 两路;坏输入 → {})。 */
export function parseEngineMcp(format: 'json' | 'toml', raw: string): Record<string, any> {
  try {
    const parsed: any = format === 'toml' ? parseToml(raw) : JSON.parse(raw);
    const servers = format === 'toml' ? parsed?.mcp_servers : parsed?.mcpServers;
    return servers && typeof servers === 'object' ? servers : {};
  } catch {
    return {};
  }
}

/** 归一化单个外来 mcp server → Tangu McpServerConfig:只搬通用字段,默认 enabled:false。纯函数。 */
export function normalizeMcpServer(server: any): McpServerConfig {
  const out: McpServerConfig = { enabled: false };
  if (typeof server?.command === 'string') out.command = server.command;
  if (Array.isArray(server?.args)) out.args = server.args;
  if (server?.env && typeof server.env === 'object') out.env = server.env;
  if (typeof server?.url === 'string') out.url = server.url;
  if (server?.headers && typeof server.headers === 'object') out.headers = server.headers;
  return out;
}

function readEngineMcpServers(spec: EngineAssetSpec): Record<string, any> {
  if (!spec.mcp) return {};
  const file = expandHome(spec.mcp.file);
  if (!existsSync(file)) return {};
  return parseEngineMcp(spec.mcp.format, readFileSync(file, 'utf8'));
}

/** 列出某引擎已装的 skills + mcp(各项标注是否已导入 Tangu)。未知引擎/未安装 → 空。 */
export function listEngineAssets(engineId: string): EngineAssets {
  const spec = SPECS[engineId];
  if (!spec) return { skills: [], mcp: [] };

  const skills: EngineSkillItem[] = [];
  const sdir = expandHome(spec.skillsDir);
  const tanguSkills = skillsDir();
  if (existsSync(sdir)) {
    for (const name of readdirSync(sdir)) {
      const md = path.join(sdir, name, 'SKILL.md');
      if (!existsSync(md)) continue;
      let description = '';
      try {
        description = parseFrontmatter(readFileSync(md, 'utf8')).meta.description || '';
      } catch {
        /* 描述可空 */
      }
      skills.push({ name, description, imported: existsSync(path.join(tanguSkills, name)) });
    }
  }

  const existing = loadMcpConfig().mcpServers;
  const mcp: EngineMcpItem[] = Object.entries(readEngineMcpServers(spec)).map(([name, s]: [string, any]) => ({
    name,
    command: typeof s?.command === 'string' ? s.command : undefined,
    args: Array.isArray(s?.args) ? s.args : undefined,
    url: typeof s?.url === 'string' ? s.url : undefined,
    imported: !!existing[name],
  }));

  return { skills, mcp };
}

export interface ImportResult {
  ok: boolean;
  error?: string;
}

/** 导入一个引擎技能:整文件夹复制到 ~/.tangu/skills/<name>/。已存在 → 拒绝(用户先改名/删除)。 */
export function importEngineSkill(engineId: string, name: string): ImportResult {
  const spec = SPECS[engineId];
  if (!spec) return { ok: false, error: 'unknown engine' };
  const safe = path.basename(name); // 防 ../ 穿越
  const src = path.join(expandHome(spec.skillsDir), safe);
  if (!existsSync(path.join(src, 'SKILL.md'))) return { ok: false, error: 'skill not found' };
  const dest = path.join(skillsDir(), safe);
  if (existsSync(dest)) return { ok: false, error: 'already exists' };
  mkdirSync(skillsDir(), { recursive: true });
  cpSync(src, dest, { recursive: true });
  return { ok: true };
}

/** 导入一个引擎 MCP:归一化写入 ~/.tangu/mcp.json(enabled:false)。已存在 → 拒绝。 */
export function importEngineMcp(engineId: string, name: string): ImportResult {
  const spec = SPECS[engineId];
  if (!spec?.mcp) return { ok: false, error: 'no mcp config' };
  const server = readEngineMcpServers(spec)[name];
  if (!server) return { ok: false, error: 'server not found' };
  const cfg = loadMcpConfig();
  if (cfg.mcpServers[name]) return { ok: false, error: 'already exists' };
  cfg.mcpServers[name] = normalizeMcpServer(server);
  saveMcpConfig(cfg);
  return { ok: true };
}
