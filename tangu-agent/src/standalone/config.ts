/**
 * standalone 配置:CLI 参数 > 环境变量 > 默认。手写 parseArgs(无 commander 依赖),仿
 * apps/Agents-Manager/desktop/cli/web.ts。
 */
import type { DirectProvider } from '../llm/providerRegistry.js';
import { getRawSection } from '../core/config.js';

export interface StandaloneConfig {
  cloudUrl: string; // Forsion 云端地址(brain API 所在),如 https://api.forsion.app
  token: string; // forsion_token(既用于调云端,也作本地端点鉴权)
  databaseUrl: string; // 可选:外部 Postgres 连接串;留空则用嵌入式 SQLite/WAL(零安装,落 state.db)
  dataDir: string; // 嵌入式 SQLite 落盘文件(databaseUrl 为空时用;默认 ~/.tangu/state.db,'memory'=内存)
  defaultModelId: string; // CLI 配的模型(run 未指定时用)
  toolBuiltins?: 'all' | string[]; // 内置工具白名单(省略=全开)。Tangu Manager 经 TANGU_TOOL_BUILTINS 下发裁剪
  port: number;
  host: string;
  userId: string; // 本地单用户 id
  sandbox: 'docker' | 'none' | 'auto';
  // LLM 多 provider:直连用户自有 provider(OpenAI/Ollama/…);为空则全部 LLM 走 Forsion 托管面。
  providers: DirectProvider[];
  providersFile?: string; // 可选:JSON 文件含 DirectProvider[](与 inline provider 合并)
  /** OAuth 登录派生的 provider(main 启动时注入;合并优先级最低——显式配置覆盖订阅登录)。 */
  oauthProviders?: DirectProvider[];
  showHelp: boolean;
  printConfig: boolean; // --print-config:打印当前生效配置后退出
}

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  userId: 'local',
  sandbox: 'auto' as const,
};

/** csv → 工具白名单。空 = undefined(全开)；字面量 'all' = 全开；否则按逗号切成白名单数组。 */
function parseToolBuiltins(raw: string | undefined): 'all' | string[] | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  if (s === 'all') return 'all';
  const list = s.split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

export function parseConfig(argv: string[]): StandaloneConfig {
  // config.json 作为 env 之下、默认之上的一层(优先级:CLI args > env > config.json > 默认)。
  // 直连 providers 不在此 seed —— 由 loadProviders(assemble.ts)统一读 config.providers 段并合并。
  const cloud = (getRawSection('cloud') as any) || {};
  const db = (getRawSection('database') as any) || {};
  const server = (getRawSection('server') as any) || {};
  const sandboxCfg = getRawSection('sandbox') as StandaloneConfig['sandbox'] | undefined;
  const cfg: StandaloneConfig = {
    cloudUrl: process.env.TANGU_CLOUD_URL ?? cloud.url ?? '',
    token: process.env.TANGU_TOKEN ?? cloud.token ?? '',
    databaseUrl: process.env.TANGU_DATABASE_URL ?? process.env.DATABASE_URL ?? db.url ?? '',
    dataDir: process.env.TANGU_DATA_DIR ?? db.dataDir ?? '',
    defaultModelId: process.env.TANGU_MODEL ?? cloud.defaultModel ?? '',
    toolBuiltins: parseToolBuiltins(process.env.TANGU_TOOL_BUILTINS),
    port: Number(process.env.TANGU_PORT ?? server.port ?? DEFAULTS.port),
    host: process.env.TANGU_HOST ?? server.host ?? DEFAULTS.host,
    userId: process.env.TANGU_USER_ID ?? server.userId ?? DEFAULTS.userId,
    sandbox: (process.env.TANGU_SANDBOX as StandaloneConfig['sandbox']) ?? sandboxCfg ?? DEFAULTS.sandbox,
    providers: [],
    providersFile: process.env.TANGU_PROVIDERS_FILE || undefined,
    showHelp: false,
    printConfig: false,
  };
  // inline 单 provider(env 为起点,CLI 可覆盖;providerId+baseUrl 齐全才算数)
  const inline = {
    providerId: process.env.TANGU_PROVIDER_ID ?? '',
    baseUrl: process.env.TANGU_PROVIDER_BASE_URL ?? '',
    apiKey: process.env.TANGU_PROVIDER_API_KEY ?? '',
    models: process.env.TANGU_PROVIDER_MODELS ?? '',
    imageModels: process.env.TANGU_PROVIDER_IMAGE_MODELS ?? '',
  };
  const set = (k: string, v: string): void => {
    switch (k) {
      case '--cloud-url': cfg.cloudUrl = v; break;
      case '--token': cfg.token = v; break;
      case '--db': case '--database-url': cfg.databaseUrl = v; break;
      case '--data-dir': cfg.dataDir = v; break;
      case '--model': cfg.defaultModelId = v; break;
      case '--tool-builtins': cfg.toolBuiltins = parseToolBuiltins(v); break;
      case '--port': cfg.port = Number(v); break;
      case '--host': cfg.host = v; break;
      case '--user-id': cfg.userId = v; break;
      case '--sandbox': cfg.sandbox = v as StandaloneConfig['sandbox']; break;
      case '--provider': inline.providerId = v; break;
      case '--provider-base-url': inline.baseUrl = v; break;
      case '--provider-api-key': inline.apiKey = v; break;
      case '--provider-models': inline.models = v; break;
      case '--provider-image-models': inline.imageModels = v; break;
      case '--providers-file': cfg.providersFile = v; break;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { cfg.showHelp = true; continue; }
    if (a === '--print-config') { cfg.printConfig = true; continue; }
    if (!a.startsWith('--')) continue;
    if (a.includes('=')) set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
    else set(a, argv[++i] ?? '');
  }
  if (inline.providerId && inline.baseUrl) {
    cfg.providers.push({
      providerId: inline.providerId,
      baseUrl: inline.baseUrl,
      apiKey: inline.apiKey || undefined,
      modelIds: inline.models ? inline.models.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      imageModelIds: inline.imageModels ? inline.imageModels.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
  }
  return cfg;
}

export const HELP = `Tangu Agent — standalone(云端大脑客户端，HTTP/SSE 服务)

用法: tangu-server [options]   (交互式 TUI 用 \`tangu\`)

  --cloud-url <url>   Forsion 云端地址(brain API),env TANGU_CLOUD_URL
  --token <token>     forsion_token(调云端 + 本地端点鉴权),env TANGU_TOKEN
  --db <url>          可选:外部 Postgres 连接串;留空=嵌入式 SQLite/WAL,env TANGU_DATABASE_URL
  --data-dir <path>   嵌入式 SQLite 落盘文件(默认 ~/.tangu/state.db,'memory'=内存),env TANGU_DATA_DIR
  --model <id>        默认模型 id,env TANGU_MODEL
  --tool-builtins <csv> 内置工具白名单(逗号分隔;'all'/省略=全开),env TANGU_TOOL_BUILTINS
  --port <n>          本地服务端口(默认 8787),env TANGU_PORT
  --host <addr>       绑定地址(默认 127.0.0.1),env TANGU_HOST
  --user-id <id>      本地单用户 id(默认 local),env TANGU_USER_ID
  --sandbox <mode>    docker|none|auto(默认 auto:docker 可用即开),env TANGU_SANDBOX
  --print-config      打印当前生效配置(含 ~/.tangu/config.json + env 叠加)后退出
  -h, --help          显示帮助

LLM 多 provider(直连用户自有 provider;未配则 LLM 全走 Forsion 托管面):
  --provider <id>             provider 标识,也作 modelId 前缀(如 ollama → ollama/llama3),env TANGU_PROVIDER_ID
  --provider-base-url <url>   OpenAI 兼容端点根含 /v1(如 http://localhost:11434/v1),env TANGU_PROVIDER_BASE_URL
  --provider-api-key <key>    直连厂商的用户自有 key(Ollama 可省),env TANGU_PROVIDER_API_KEY
  --provider-models <csv>     该 provider 的模型白名单(逗号分隔,可不带前缀直接用),env TANGU_PROVIDER_MODELS
  --provider-image-models <csv> 该 provider 的生图模型白名单(逗号分隔;generate_image 用),env TANGU_PROVIDER_IMAGE_MODELS
  --providers-file <path>     JSON 文件含 DirectProvider[](多 provider),env TANGU_PROVIDERS_FILE
  说明:modelId 命中本地 provider → 直连(用户付厂商,不计 Forsion);否则走 Forsion 托管模型。

run 通过 HTTP 起(同 microserver 契约): POST /agent/runs,SSE GET /agent/runs/:id/events。
`;

/** 校验必填项,缺失返回错误信息列表。databaseUrl 不再必填(留空走嵌入式 PGlite)。 */
export function validate(cfg: StandaloneConfig): string[] {
  const errs: string[] = [];
  if (!cfg.cloudUrl) errs.push('缺少 --cloud-url / TANGU_CLOUD_URL');
  if (!cfg.token) errs.push('缺少 --token / TANGU_TOKEN');
  return errs;
}
