#!/usr/bin/env node
/**
 * Tangu 分离式云 worker 入口（第四部署形态）。
 *
 * 取代「进程内 agent-core」来横向扩展:N 台机器各跑一个 worker,共享同一云端 Postgres
 * (run/会话态跨机共享),Forsion server 按 session 亲和把 /api/agent/* 转发到本进程(见
 * server/microserver/agent-core fleet 模式)。
 *
 * 组装:cloudWorkerHost(共享云库 + JWT 多用户验签) + httpBrain(LLM/记忆/技能经 brain-api,
 * 计费在云端收口) + noopBilling(loop 不计费) + docker profile。
 *
 *   - 多用户:每个请求由 cloudWorkerHost 用 JWT_SECRET 本地验签 forsion_token → 真实 userId。
 *   - brain 调用按**当前 run 的用户**(runContext)铸 per-user JWT(token 函数),云端据此鉴权/计费。
 *   - 不跑 run 自愈 / historian(共享云库下全局任务会跨 worker 互扰),只留本机沙箱 janitor。
 *   - run 接口同契约:POST /agent/runs、SSE GET /agent/runs/:id/events。
 */
import express from 'express';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import jwt from 'jsonwebtoken';
import { createTanguModule } from '../index.js';
import { activeRunCount } from '../services/agentLoop.js';
import { createAiStudioProfile } from '../profiles/index.js';
import { createCloudWorkerHost } from '../adapters/cloudWorkerHost.js';
import { createHttpBrain } from '../adapters/standalone/httpBrain.js';
import { createNoopBilling } from '../adapters/standalone/noopBilling.js';
import { currentRunUserId } from '../seams/runContext.js';

interface WorkerConfig {
  cloudUrl: string; // brain-api 所在 Forsion 云端
  databaseUrl: string; // 共享云端 Postgres
  jwtSecret: string; // 与 Forsion 同一 JWT_SECRET
  appId: string; // 本 worker 服务的 app(按 app 部署;默认 ai-studio)
  defaultModelId: string;
  port: number;
  host: string;
  sandbox: 'docker' | 'none' | 'auto';
  showHelp: boolean;
}

function parseConfig(argv: string[]): WorkerConfig {
  const cfg: WorkerConfig = {
    cloudUrl: process.env.TANGU_CLOUD_URL ?? '',
    databaseUrl: process.env.TANGU_DB_URL ?? process.env.TANGU_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    jwtSecret: process.env.JWT_SECRET ?? '',
    appId: process.env.TANGU_APP_ID ?? 'ai-studio',
    defaultModelId: process.env.TANGU_MODEL ?? '',
    port: Number(process.env.TANGU_WORKER_PORT ?? 8790),
    host: process.env.TANGU_WORKER_HOST ?? '0.0.0.0',
    sandbox: (process.env.TANGU_SANDBOX as WorkerConfig['sandbox']) ?? 'auto',
    showHelp: false,
  };
  const set = (k: string, v: string): void => {
    switch (k) {
      case '--cloud-url': cfg.cloudUrl = v; break;
      case '--db': case '--database-url': cfg.databaseUrl = v; break;
      case '--app-id': cfg.appId = v; break;
      case '--model': cfg.defaultModelId = v; break;
      case '--port': cfg.port = Number(v); break;
      case '--host': cfg.host = v; break;
      case '--sandbox': cfg.sandbox = v as WorkerConfig['sandbox']; break;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { cfg.showHelp = true; continue; }
    if (!a.startsWith('--')) continue;
    if (a.includes('=')) set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
    else set(a, argv[++i] ?? '');
  }
  return cfg;
}

const HELP = `Tangu Agent — 分离式云 worker(多用户,共享云库)

用法: tangu-worker [options]

  --cloud-url <url>   Forsion 云端地址(brain API),env TANGU_CLOUD_URL
  --db <url>          共享云端 Postgres 连接串,env TANGU_DB_URL / DATABASE_URL
  --app-id <id>       本 worker 服务的 app(默认 ai-studio),env TANGU_APP_ID
  --model <id>        默认模型 id,env TANGU_MODEL
  --port <n>          监听端口(默认 8790),env TANGU_WORKER_PORT
  --host <addr>       绑定地址(默认 0.0.0.0,供 Forsion dispatcher 访问),env TANGU_WORKER_HOST
  --sandbox <mode>    docker|none|auto(默认 auto),env TANGU_SANDBOX
  -h, --help          显示帮助

JWT_SECRET(env,必填):与 Forsion 同一密钥,用于本地验签 forsion_token + 铸 per-user token。
`;

function validate(cfg: WorkerConfig): string[] {
  const errs: string[] = [];
  if (!cfg.cloudUrl) errs.push('缺少 --cloud-url / TANGU_CLOUD_URL');
  if (!cfg.databaseUrl) errs.push('缺少 --db / TANGU_DB_URL(共享云端 Postgres)');
  if (!cfg.jwtSecret) errs.push('缺少 JWT_SECRET(env,与 Forsion 同一密钥)');
  return errs;
}

function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = execFile('docker', ['version', '--format', '{{.Server.Version}}'], (err) => resolve(!err));
    p.on('error', () => resolve(false));
  });
}

async function resolveSandboxMode(cfg: WorkerConfig): Promise<'docker' | 'none'> {
  if (cfg.sandbox === 'docker') return 'docker';
  if (cfg.sandbox === 'none') return 'none';
  const ok = await dockerAvailable();
  if (!ok) console.warn('[tangu-worker] 未检测到 docker → 沙箱禁用(run_python/pip_install 不可用)。');
  return ok ? 'docker' : 'none';
}

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2));
  if (cfg.showHelp) { process.stdout.write(HELP); return; }
  const errs = validate(cfg);
  if (errs.length) {
    process.stderr.write('配置错误:\n  - ' + errs.join('\n  - ') + '\n\n' + HELP);
    process.exit(1);
  }

  const sandboxMode = await resolveSandboxMode(cfg);
  const { host } = createCloudWorkerHost({ databaseUrl: cfg.databaseUrl, jwtSecret: cfg.jwtSecret });

  // brain token:按当前 run 的用户(runContext)铸短期 per-user JWT;云端 brain-api 据此鉴权/计费。
  // 不在 run 上下文(如启动期)时签个占位 userId,调用方仍会被 brain-api 鉴权挡住,无副作用。
  const mintToken = (): string =>
    jwt.sign(
      { userId: currentRunUserId() ?? '__no_run_ctx__', username: 'tangu-worker', role: 'USER' },
      cfg.jwtSecret,
      { expiresIn: '15m' },
    );

  const mod = createTanguModule({
    host,
    brain: createHttpBrain({ cloudUrl: cfg.cloudUrl, token: mintToken }),
    billing: createNoopBilling(), // 计费收口在云端 brain-api,worker loop 不计费
    // 云端多租户 profile(hostExec 禁);worker 按 app 部署,appId 经 TANGU_APP_ID 覆盖。
    // historian:false——共享云库下 historian 是全局任务,多 worker 会互扰(与 startBackgroundTasks 一致)。
    profile: createAiStudioProfile({
      appId: cfg.appId,
      sandboxMode,
      defaultModelId: cfg.defaultModelId || undefined,
      historian: false,
    }),
  });

  // 云库已由 Forsion migrate-all 建表;此处幂等(CREATE/ALTER IF NOT EXISTS),容错跑一遍。
  await mod.runMigration().catch((e) => console.warn('[tangu-worker] runMigration 警告(忽略):', e?.message || e));
  // 共享云库:关 run 自愈 + historian(全局任务,多 worker 会互扰),只留本机沙箱 janitor。
  mod.startBackgroundTasks({ recoverRuns: false, historian: false });

  // /health 自描述:version/startedAt/activeRuns 供 Forsion 调度端探测回写 + admin 面板展示。
  const pkgVersion: string = (() => {
    try { return createRequire(import.meta.url)('../../package.json').version ?? ''; } catch { return ''; }
  })();
  const startedAt = new Date().toISOString();

  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.get('/health', (_req, res) => res.json({
    ok: true,
    mode: 'worker',
    appId: cfg.appId,
    sandbox: sandboxMode,
    version: pkgVersion,
    startedAt,
    activeRuns: activeRunCount(),
  }));
  app.use('/', mod.userRouter); // /agent/runs、/agent/runs/:id/events、/agent/workspace/*、审批
  app.use('/', mod.dataRouter); // 数据路由(fleet 下通常由调度进程直服;worker 同挂无害,直连 worker 调试可用)

  app.listen(cfg.port, cfg.host, () => {
    console.log(`[tangu-worker] 已启动 http://${cfg.host}:${cfg.port} app=${cfg.appId} sandbox=${sandboxMode}`);
    console.log(`[tangu-worker] cloud=${cfg.cloudUrl}(brain-api) db=共享云库 多用户=JWT 本地验签`);
  });
}

main().catch((e) => {
  console.error('[tangu-worker] 启动失败:', e?.message || e);
  process.exit(1);
});
