/**
 * Tangu 本地 home 目录统一布局(单一事实来源,各处不再散落拼路径)。
 *
 * 两层布局(2026-07-12 起):引擎私有数据全在 home 内;desktop 与引擎**共用**的文件在
 * 「共享域」= home 的父目录(见 forsionSharedDir)。桌面托管形态:
 *
 *   ~/.forsion/                     ← 共享域(auth.json / provider-auth.json / config.json / activity/)
 *   └── tangu/                      ← 引擎 home(desktop spawn 传 TANGU_HOME 指此;~/.tangu 软链亦指此)
 *       ├── agents/  memory/  skills/  plugins/  state.db  wechat/ ...
 *       ├── providers.json  mcp.json  engines.json  engine-prefs.json
 *       └── pgdata/
 *
 * 纯 standalone(无 desktop,~/.tangu 为真目录)/云 worker/测试重定向:共享域=home 自身,旧行为零变化。
 * 仅 standalone/TUI/desktop 形态使用;microserver/worker 不读本目录。
 * 测试/多实例可用 env TANGU_HOME 整体重定向。
 */
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';

export function tanguHome(): string {
  return process.env.TANGU_HOME || join(homedir(), '.tangu');
}

/**
 * Forsion 共享域:desktop 与引擎共用文件(auth.json/provider-auth.json/config.json/activity/)的所在地。
 * home 目录名为 `tangu`(桌面托管 ~/.forsion/tangu;CLI 经 ~/.tangu 软链指入)→ 父目录(如 ~/.forsion);
 * 否则(纯 standalone ~/.tangu 真目录、云 worker、测试)→ home 自身=旧行为。经 realpath 判断:
 * ~/.tangu 是软链时按真身归位,CLI 与桌面不分脑。
 */
export function forsionSharedDir(): string {
  const h = tanguHome();
  let real = h;
  try { real = realpathSync(h); } catch { /* home 尚不存在:按字面路径判断 */ }
  return basename(real) === 'tangu' ? dirname(real) : h;
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

// 共享域文件(desktop 也直接读写,见 forsionSharedDir 注释)
export const authFile = (): string => join(forsionSharedDir(), 'auth.json');
export const providerAuthFile = (): string => join(forsionSharedDir(), 'provider-auth.json');
export const providersFile = (): string => join(tanguHome(), 'providers.json');
export const mcpConfigFile = (): string => join(tanguHome(), 'mcp.json');
/** 外部 agent 引擎清单(覆盖/新增内置引擎):{ engines: EngineDef[] }。 */
export const enginesFile = (): string => join(tanguHome(), 'engines.json');
/** 外部 agent 引擎偏好(每引擎默认模型等):{ [engineId]: { defaultModel } }。 */
export const enginePrefsFile = (): string => join(tanguHome(), 'engine-prefs.json');
/**
 * 统一实例配置(唯一真源):cloud/database/server/sandbox/workspace/providers/mcp/engines/
 * enginePrefs/specialAgents/plugins/browser/wechat 全段。存在即权威(见 core/config.ts);
 * 不存在则各 loader 回落各自 legacy 文件(过渡/测试)。CLI/桌面/standalone 三端共读写 → 共享域。
 */
export const configFile = (): string => join(forsionSharedDir(), 'config.json');
export const skillsDir = (): string => join(tanguHome(), 'skills');
/** 用户安装的全局插件目录(~/.tangu/plugins;可写、跨升级保留)。首方插件随包发在 <pkg>/plugins。 */
export const pluginsDir = (): string => join(tanguHome(), 'plugins');
/** 本地 Normal Agent 目录:每个 agent 一个子文件夹 <slug>/(config.toml + SOUL.md + MEMORY.md + LOG/ + Library/)。 */
export const agentsDir = (): string => join(tanguHome(), 'agents');
/** 默认 Agent 的 slug(承载迁移自旧全局记忆/日志;无 agentSlug 时记忆落此)。 */
export const DEFAULT_AGENT_SLUG = 'xyra';
/** 全局用户画像文件(所有 agent 可见,用户主改、agent 可改)。 */
export const userMdFile = (): string => join(tanguHome(), 'USER.md');
/** 读全局 USER.md(不存在/读失败返回空串)。 */
export function readUserMd(): string {
  try { return readFileSync(userMdFile(), 'utf8'); } catch { return ''; }
}
/** 写全局 USER.md。 */
export function writeUserMd(content: string): void {
  mkdirSync(tanguHome(), { recursive: true });
  writeFileSync(userMdFile(), content, 'utf8');
}
/** Special Agent(Historian/Muse)配置文件(默认关;桌面/TUI 经端点读写)。 */
export const specialAgentsConfigFile = (): string => join(tanguHome(), 'special-agents.json');
export const pgdataDir = (): string => join(tanguHome(), 'pgdata');
/** 嵌入式 SQLite 本地库文件(TUI / standalone / desktop 三端共用,故本地会话跨前端共享)。 */
export const stateDbPath = (): string => join(tanguHome(), 'state.db');
/** 本地记忆/日志目录(MEMORY.md / log/<date>.md / .sync.json);Hermes 风格、可人工查看。 */
export const memoryDir = (): string => join(tanguHome(), 'memory');
/** per-install 设备标识文件(日志条目按 deviceId 打标,供多端合并去重)。 */
export const deviceIdFile = (): string => join(tanguHome(), 'device.json');

/** 确保 home 及子目录存在(幂等);返回 home 路径。 */
export function ensureHome(): string {
  mkdirSync(skillsDir(), { recursive: true });
  mkdirSync(agentsDir(), { recursive: true });
  return tanguHome();
}
