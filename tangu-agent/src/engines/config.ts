/**
 * 外部 Agent 引擎定义（host-only）。每个引擎 = 一个可被当作 ACP 子进程驱动的外部 agent CLI。
 * 内置默认 claude-code（Anthropic 官方 ACP 适配器，npx 拉起）；~/.tangu/engines.json 可覆盖/新增。
 * ponytail: 启动命令走配置 —— 换 binary/路径只改 json，不改代码。
 */
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enginePrefsFile, enginesFile } from '../core/tanguHome.js';
import { dshEngineDef } from './dsh.js';
import { getRawSection, saveSection } from '../core/config.js';

export interface EngineDef {
  id: string;
  name: string;
  /** 拉起命令（如 'npx' 或本机 'claude-code-acp' 绝对路径）。 */
  command: string;
  args?: string[];
  /** 追加/覆盖子进程 env（默认继承父进程 env，详见 acpEngine）。 */
  env?: Record<string, string>;
  /** 透传给 ACP newSession 的默认模型（可空，空则用适配器默认）。 */
  defaultModel?: string;
  /** 静态声明模型/命令(配了则跳过运行时探测——留旋钮;一般留空走懒探测)。 */
  models?: Array<{ id: string; name: string; description?: string }>;
  commands?: Array<{ name: string; description: string; hint?: string }>;
  /** 检测提示(快速判断该 agent 是否已装/已登录;任一命中即「detected」)。无则默认可用。 */
  detect?: { dirs?: string[]; env?: string[]; bin?: string };
  /** 未检测到时给用户看的一行安装命令(设置页「Agent CLIs」显示)。语言中立,不进 i18n。 */
  setup?: string;
}

// 内置：Claude Code 经官方 ACP 适配器。需用户已装/已登录 Claude Code（适配器读 ANTHROPIC_API_KEY 或 ~/.claude）。
const BUILTIN: EngineDef[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp'],
    detect: { dirs: ['~/.claude'], env: ['ANTHROPIC_API_KEY'], bin: 'claude' },
    setup: 'npm i -g @anthropic-ai/claude-code',
  },
  // Codex 官方 ACP 桥(内含 @openai/codex);走同一 acpEngine,零适配器。鉴权用 Codex OAuth / OPENAI_API_KEY。
  {
    id: 'codex',
    name: 'Codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@latest'],
    detect: { dirs: ['~/.codex'], env: ['OPENAI_API_KEY', 'CODEX_API_KEY'], bin: 'codex' },
    setup: 'npm i -g @openai/codex',
  },
  // OpenClaw 官方 `openclaw acp` 桥:对我们说 ACP over stdio,对内转发给本机 OpenClaw Gateway(WebSocket)。
  // ⚠ 必须先起网关(`openclaw gateway start`),否则握手超时——AionUi 那套自研 Gateway WS 客户端已被此桥取代。
  {
    id: 'openclaw',
    name: 'OpenClaw',
    command: 'openclaw',
    args: ['acp'],
    detect: { dirs: ['~/.openclaw'], env: ['OPENCLAW_GATEWAY_TOKEN'], bin: 'openclaw' },
    setup: 'npm i -g openclaw && openclaw gateway start',
  },
  // Pi(earendil-works)自身不讲 ACP;社区适配器 pi-acp 在 ACP 与 `pi --mode rpc` 之间转译,并自己去 PATH 上找 `pi`。
  // ⚠ 非厂商官方包 → 版本钉死,升级必须是显式改动(claude-code/codex 那两条是官方桥,故可 @latest)。
  {
    id: 'pi',
    name: 'Pi',
    command: 'npx',
    args: ['-y', 'pi-acp@0.0.33'],
    detect: { dirs: ['~/.pi'], bin: 'pi' },
    setup: 'npm i -g @earendil-works/pi-coding-agent',
  },
];

/**
 * 读引擎清单：内置 + 自定义（按 id 覆盖；自定义新 id 追加）。
 * 显式传 configFile → 读该文件；否则 config.json 的 engines 段优先,缺失回落 ~/.tangu/engines.json。
 */
export function loadEngines(configFile?: string): EngineDef[] {
  let custom: EngineDef[] = [];
  const fromFile = (file: string): void => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed?.engines)) custom = parsed.engines;
    } catch { /* 无文件/解析失败 → 仅用内置 */ }
  };
  if (configFile) {
    fromFile(configFile);
  } else {
    const sec = getRawSection('engines');
    if (sec !== undefined) { if (Array.isArray(sec?.engines)) custom = sec.engines; }
    else fromFile(enginesFile());
  }
  const byId = new Map<string, EngineDef>();
  // dsh 的启动命令含绝对路径(随 TANGU_HOME),故按调用时求值,不能进模块级 BUILTIN 常量。
  for (const e of [...BUILTIN, dshEngineDef()]) byId.set(e.id, e);
  for (const e of custom) if (e?.id && e?.command) byId.set(e.id, e); // 校验 id+command 才纳入
  return [...byId.values()];
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * bin 是否在 PATH 上(纯 fs 扫描,不 spawn)。
 * 额外扫常见安装目录:GUI 启动的 Electron 子进程拿到的是 launchd 精简 PATH(不含 ~/.local/bin、homebrew 等),
 * 仅靠 process.env.PATH 会漏检「明明装了」的 CLI(claude 常在 ~/.local/bin)。
 * ponytail: 静态常见目录足够;fnm/nvm 版本目录是动态的,交给 detect.dirs(~/.codex 等)兜底。
 */
export function extraBinDirs(): string[] {
  const home = os.homedir();
  return process.platform === 'win32'
    ? [
        path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
        path.join(home, 'scoop', 'shims'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      ]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.cargo', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/local/sbin',
        '/usr/bin',
      ];
}

/**
 * 把 extraBinDirs() 里「真实存在且不在 PATH 上」的目录追加进 env 的 PATH。
 * 为什么必须:引擎子进程继承的是 GUI Electron 的精简 PATH,`openclaw`(全局 bin)与 pi-acp 自己去找的 `pi`
 * 都靠 PATH 解析 → 终端里好用、装成 App 就 ENOENT。检测(binOnPath)早就扫这些目录了,spawn 也得扫。
 * Windows 上 env 键可能是 `Path`,按原键名回写,避免同时出现 Path/PATH 两份。
 */
export function envWithFullPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const cur = (env[key] || '').split(path.delimiter).filter(Boolean);
  const add = extraBinDirs().filter((d) => !cur.includes(d) && existsSync(d));
  return add.length ? { ...env, [key]: [...cur, ...add].join(path.delimiter) } : env;
}

function binOnPath(bin: string): boolean {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extraBinDirs()].filter(Boolean);
  const names = process.platform === 'win32' ? [bin, `${bin}.exe`, `${bin}.cmd`] : [bin];
  return dirs.some((d) => names.some((n) => existsSync(path.join(d, n))));
}

export type EngineStatus = 'available' | 'needs-signin' | 'not-installed';

/**
 * 三态检测:
 * - `available`     — 有鉴权信号(配置目录存在 或 相关 env 已设),或无 detect 提示(不隐藏用户自配引擎)。
 * - `needs-signin`  — bin 在 PATH(装了)但无鉴权信号(没登录/没配 key)。
 * - `not-installed` — 三者全不命中。
 * 依据:claude-code/codex 运行走 `npx @…-acp`,`bin` 只是「装了」的探测提示;有 ~/.claude / API key 即真正可用,
 * 故「有 auth 无 bin」并入 available、不设独立 unavailable 态(三态够用)。
 */
export function engineStatus(def: EngineDef): EngineStatus {
  const d = def.detect;
  if (!d) return 'available';
  const hasAuth = !!(d.dirs?.some((p) => existsSync(expandHome(p))) || d.env?.some((k) => !!process.env[k]));
  if (hasAuth) return 'available';
  if (d.bin && binOnPath(d.bin)) return 'needs-signin';
  return 'not-installed';
}

/** 兼容旧真值语义:非 not-installed 即「已检测」(needs-signin 也返回 true,由 UI 分辨是否需登录)。 */
export function isEngineAvailable(def: EngineDef): boolean {
  return engineStatus(def) !== 'not-installed';
}

export interface EnginePrefs {
  [id: string]: { defaultModel?: string };
}

/** 读引擎偏好:config.json 的 enginePrefs 段优先,缺失回落 ~/.tangu/engine-prefs.json;损坏 → {}。 */
export function loadEnginePrefs(): EnginePrefs {
  const sec = getRawSection('enginePrefs');
  if (sec !== undefined) return sec && typeof sec === 'object' ? sec : {};
  try {
    return JSON.parse(readFileSync(enginePrefsFile(), 'utf-8')) || {};
  } catch {
    return {};
  }
}

/** 写某引擎的默认模型(空串=清除)→ config.json 的 enginePrefs 段。 */
export function saveEngineDefaultModel(id: string, modelId: string): void {
  const prefs = loadEnginePrefs();
  prefs[id] = { ...(prefs[id] || {}), defaultModel: modelId || undefined };
  try {
    saveSection('enginePrefs', prefs);
  } catch (e: any) {
    console.warn('[engines] 保存 engine-prefs 失败:', e?.message || e);
  }
}
