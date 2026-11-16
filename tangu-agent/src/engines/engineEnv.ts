/**
 * 外部引擎(ACP 子进程:DSH / Claude Code / Codex / OpenClaw / Pi / engines.json 里自配的)起进程时的环境 —— 白名单。
 *
 * 为什么:外部 CLI 跑的是模型驱动的命令,它的环境会一路传给它起的 bash。原来经 toolSubprocessEnv 只剥本引擎自己的
 * 凭据(契约 C2),其余整份继承 —— FORSION_* / TANGU_* 配置、别家服务商的 key、用户环境里任意的密钥都进了子进程。
 * DSH2Forsion 插件起常驻 DSH 时已经走白名单;这里让「每轮起一个进程」(以及探测能力)那条路也一样。
 *
 * 放行三类,其余一律不传:
 *  1. 系统运转要的(ENGINE_BASE_ENV):路径、用户、语言、临时目录、Windows 系统变量、代理与证书、图形会话,
 *     npx 拉适配器要的 npm 源(宿主的国内镜像注入的就是它)与 Node 版本管理器,SSH agent(引擎里 git 走 ssh)。
 *  2. 这个引擎自己的:定义里的 passEnv(各引擎自己的配置目录变量、凭据变量)+ detect.env + agentsHomeEnv,
 *     再加按引擎自己的配置 / 开关才知道的(ENGINE_DYNAMIC_ENV):Codex config.toml 里服务商点名的 key 变量,
 *     Claude Code 开了 Bedrock / Vertex / Foundry 时那家云的凭据变量。
 *     不改引擎读凭据的方式:配置目录(~/.claude、~/.codex、$DSH_HOME…)照旧读,用环境变量给 key 的照旧给到它自己。
 *     detect.env 本来就是「这个引擎拿这个变量当登录」的声明,不放行就成了「检测说可用、起来没 key」。
 *  3. 明写给它的:引擎清单的 def.env、这一轮的 extra(交接的指令目录等)—— 叠在过滤之后,原样给。
 * 从本进程环境继承时,FORSION_* / TANGU_* 一律不给(宿主自己的命名空间;passEnv 的 `*`、Codex 配置点名都放不进来),
 * 要给只能经类 3 明写。合成之后再剥 C2 凭据(toolSubprocessEnv):清单、passEnv 都不许把本引擎的令牌加回来。
 *
 * 名字比对不分大小写:Windows 的环境变量名本就不分(`Path` / `SystemRoot` 按原样大小写出现),
 * POSIX 上放行 `http_proxy` 这类小写惯例也正好需要。规则以 `*` 结尾 = 前缀;单独一个 `*` = 整份继承(engines.json 里的逃生口;
 * FORSION_* / TANGU_* 和令牌照样不给)。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { envWithFullPath, type EngineDef } from './config.js';
import { toolSubprocessEnv } from '../sandbox/credentialEnv.js';

/** 每个外部引擎都放行的系统变量。改这份清单 = 改所有外部引擎看得到什么,加之前想清楚它是不是密钥。 */
export const ENGINE_BASE_ENV: readonly string[] = [
  // 路径、用户、语言、终端
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'TZ',
  'LANG', 'LANGUAGE', 'LC_*', 'TERM', 'COLORTERM', '__CF_USER_TEXT_ENCODING',
  // Linux 目录规范与图形会话(钥匙串走 D-Bus)
  'XDG_*', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  // Windows:spawn 用 shell:true 交 cmd.exe(要 ComSpec / SystemRoot / PATHEXT),npm 全局装在 APPDATA 下,引擎跑 PowerShell 要 PSModulePath
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PSModulePath',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS',
  // 代理与证书(公司网络 / 自签根证书)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  // npx 拉适配器:源与本机 npm 配置(宿主开「中国大陆镜像」时注入 npm_config_registry,不放行就回到直连、握手超时)
  'npm_config_registry', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache', 'npm_config_prefix',
  'npm_config_cafile', 'npm_config_strict_ssl', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy',
  // Node 版本管理器(shim 靠它们找 node)
  'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'FNM_DIR', 'FNM_MULTISHELL_PATH', 'ASDF_DIR', 'ASDF_DATA_DIR', 'MISE_DATA_DIR', 'PNPM_HOME', 'COREPACK_HOME',
  // 引擎里的 git 走 ssh(只是套接字路径;私钥文件引擎本来就读得到)
  'SSH_AUTH_SOCK',
  // 不放:GIT_CONFIG_*(宿主的 git 镜像也用它,但 VALUE 里可以是 http.extraheader 的认证头)、PIP_INDEX_URL(私有源地址常带令牌)、
  // NODE_OPTIONS(--require 能往引擎里注代码)。它们只是方便,引擎起不起得来不靠它们。
];

/** 宿主自己的命名空间:从本进程环境继承时一律不给(哪怕 passEnv 写了 `*`、配置文件点了名)。 */
const RESERVED_PREFIXES = ['FORSION_', 'TANGU_'];
const isReserved = (name: string): boolean => RESERVED_PREFIXES.some((p) => name.toUpperCase().startsWith(p));

/** 按名字取环境变量,后面的层盖前面的。Windows 上名字不分大小写(`codex_home` 也算 CODEX_HOME),和子进程实际看到的一致。 */
export type EnvLookup = (name: string) => string | undefined;
export function layeredLookup(layers: ReadonlyArray<Record<string, string | undefined> | undefined>, platform: NodeJS.Platform = process.platform): EnvLookup {
  return (name) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!layer) continue;
      if (platform !== 'win32') { if (layer[name] !== undefined) return layer[name]; continue; }
      const u = name.toUpperCase();
      // 同一层里大小写不同的两份(少见),取最后一份,和合成时后写的覆盖先写的一致
      let hit: string | undefined;
      for (const [k, v] of Object.entries(layer)) if (v !== undefined && k.toUpperCase() === u) hit = v;
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
}

/** 按引擎自己的配置 / 开关才知道要哪些变量的。读不到 / 没开就是空(白名单,失败即收紧)。 */
const ENGINE_DYNAMIC_ENV: Record<string, (get: EnvLookup) => string[]> = {
  codex: codexConfigEnvKeys,
  'claude-code': claudeCloudEnvRules,
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Codex 自定义服务商的 key 只能从环境给:config.toml 的 `[model_providers.<id>]` 里 `env_key = "DEEPSEEK_API_KEY"`,
 * 或 `env_http_headers = { "api-key" = "AZURE_OPENAI_API_KEY" }`(值是变量名)。不放行就是 Codex 自己配好的服务商全部没 key。
 * 按 TOML 解析,只认这两个字段(注释、别处的同名字符串不算)。
 */
export function codexConfigEnvKeys(get: EnvLookup): string[] {
  const home = get('CODEX_HOME')?.trim() || path.join(os.homedir(), '.codex');
  let cfg: any;
  try { cfg = parseToml(readFileSync(path.join(home, 'config.toml'), 'utf8')); } catch { return []; }
  const out = new Set<string>();
  const providers = cfg?.model_providers;
  if (providers && typeof providers === 'object') {
    for (const p of Object.values(providers) as any[]) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.env_key === 'string' && ENV_NAME.test(p.env_key)) out.add(p.env_key);
      if (p.env_http_headers && typeof p.env_http_headers === 'object') {
        for (const v of Object.values(p.env_http_headers)) if (typeof v === 'string' && ENV_NAME.test(v)) out.add(v);
      }
    }
  }
  return [...out];
}

/** Claude Code 走云厂商:开关(CLAUDE_CODE_USE_*)本身在 CLAUDE_* 里已放行,开了哪家才放那家的凭据 / 区域变量。 */
export function claudeCloudEnvRules(get: EnvLookup): string[] {
  const on = (k: string): boolean => /^(1|true|yes|on)$/i.test(get(k)?.trim() ?? '');
  return [
    ...(on('CLAUDE_CODE_USE_BEDROCK') ? ['AWS_*'] : []),
    ...(on('CLAUDE_CODE_USE_VERTEX') ? ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GCLOUD_PROJECT', 'CLOUD_ML_REGION', 'VERTEX_REGION_*'] : []),
    ...(on('CLAUDE_CODE_USE_FOUNDRY') ? ['AZURE_*'] : []),
  ];
}

/** 规则表 → 判断函数。`FOO` 精确、`FOO_*` 前缀、`*` 全放;不分大小写。非字符串 / 空串忽略(engines.json 是用户手写的)。 */
export function envNameMatcher(rules: readonly unknown[]): (name: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const r of rules) {
    if (typeof r !== 'string' || !r.trim()) continue;
    const u = r.trim().toUpperCase();
    if (u.endsWith('*')) prefixes.push(u.slice(0, -1)); else exact.add(u);
  }
  return (name) => {
    const u = name.toUpperCase();
    return exact.has(u) || prefixes.some((p) => u.startsWith(p));
  };
}

/** 这个引擎自己的变量名规则(放行类 2)。get:它起进程时会看到的环境(本进程 → def.env → 这一轮,后盖前)。 */
export function engineOwnEnvRules(def: EngineDef, get: EnvLookup = layeredLookup([process.env])): string[] {
  return [
    ...(Array.isArray(def.passEnv) ? def.passEnv : []),
    ...(Array.isArray(def.detect?.env) ? def.detect!.env! : []),
    ...(def.agentsHomeEnv ? [def.agentsHomeEnv] : []),
    ...(ENGINE_DYNAMIC_ENV[def.id]?.(get) ?? []),
  ];
}

/**
 * 起外部引擎子进程用的环境:base(缺省本进程)经白名单过滤 → 叠 def.env → 叠 extra → 剥 C2 凭据。
 * PATH 先补全(envWithFullPath:GUI 启动的 App 只有精简 PATH)。返回新对象,不改入参、不改 process.env。
 */
export function engineSubprocessEnv(
  def: EngineDef,
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const full = envWithFullPath(base);
  // 动态规则(Codex 的 config.toml 在哪、Claude 开没开云厂商)以它真正会看到的环境为准:清单 / 这一轮都可能改
  const allowed = envNameMatcher([...ENGINE_BASE_ENV, ...engineOwnEnvRules(def, layeredLookup([full, def.env, extra]))]);
  const kept: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(full)) if (v !== undefined && allowed(k) && !isReserved(k)) kept[k] = v;
  return toolSubprocessEnv({ ...kept, ...(def.env ?? {}), ...extra });
}
