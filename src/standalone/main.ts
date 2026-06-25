#!/usr/bin/env node
/**
 * Tangu standalone 入口(**server 前端**:headless HTTP/SSE 服务)。
 * /health 带 version/startedAt:桌面端/运维据此识别「dist 已重建但旧进程还在跑」。
 *   parseConfig → setupHost(嵌入式 SQLite/WAL / 外部 PG)+ base schema + runMigration
 *   → 装配 deps(host/brain/noopBilling)→ createTanguModule → mount(/agent/*) → listen。
 * run 接口与 microserver 同契约:POST /agent/runs、SSE GET /agent/runs/:id/events。
 * 终端交互前端见 tui/main.tsx(`tangu`);二者共用 standalone/assemble.ts 的装配。
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { createTanguModule } from '../index.js';
import { createNoopBilling } from '../adapters/standalone/noopBilling.js';
import { createTanguProfile } from '../profiles/index.js';
import { parseConfig, validate, HELP } from './config.js';
import { loadCreds } from './credStore.js';
import { loadOAuthDirectProviders } from '../llm/providerOAuth.js';
import { resolveSandboxMode, setupHost, buildBrain, fixLegacyAppIds } from './assemble.js';
import { createMcpManager } from '../mcp/manager.js';
import { createEngineManager } from '../engines/index.js';
import { loadTanguEnv } from '../core/tanguHome.js';
import { activateAllPlugins } from '../plugins/bootstrap.js';

async function main(): Promise<void> {
  loadTanguEnv(); // ~/.tangu/.env → process.env(不覆盖真实环境);须先于 parseConfig
  const cfg = parseConfig(process.argv.slice(2));
  if (cfg.showHelp) { process.stdout.write(HELP); return; }
  // 未显式给 token / cloud-url → 复用 `tangu-chat login` 存的凭证。
  const creds = loadCreds();
  if (!cfg.token) cfg.token = creds.token || '';
  if (!cfg.cloudUrl) cfg.cloudUrl = creds.cloudUrl || '';
  // `tangu login <provider>`(xAI 等 OAuth 直连)的凭证同样接进 registry——与 TUI 对齐,
  // 桌面端 managed 后端登录 provider 后即可用 <providerId>/<model>。
  // 走 oauthProviders 字段(loadProviders 合并时优先级最低,显式配置覆盖订阅登录)。
  try {
    cfg.oauthProviders = await loadOAuthDirectProviders();
  } catch {
    /* ignore */
  }
  const errs = validate(cfg);
  if (errs.length) {
    process.stderr.write('配置错误:\n  - ' + errs.join('\n  - ') + '\n\n' + HELP);
    process.exit(1);
  }

  const sandboxMode = await resolveSandboxMode(cfg);
  const { host, runBaseSchema, storage } = await setupHost(cfg);
  await runBaseSchema(); // base schema 先于 runMigration(后者对 chat_sessions 做 ALTER)
  const { brain, providers } = buildBrain(cfg);

  // MCP(~/.tangu/mcp.json):启动时连一次,server 集进程级冻结(prompt 缓存纪律,配置变更须重启)。
  const mcp = createMcpManager();
  await mcp.start();

  // 外部 agent 引擎(~/.tangu/engines.json + 内置 claude-code):host-only,云端 microserver 不装配。
  const engines = createEngineManager();

  // 插件:激活全部（tool provider 全局注册 + 收集路由挂载器）。tool provider 注册无需 deps()，先于
  // createTanguModule 安全;路由挂载须**在 createTanguModule 之后**（彼时 configureTangu/deps() 才就绪）。
  const mountPluginRoutes = await activateAllPlugins();

  const mod = createTanguModule({
    host,
    brain,
    billing: createNoopBilling(),
    profile: createTanguProfile({ sandboxMode, defaultModelId: cfg.defaultModelId || undefined }),
    mcp,
    engines,
  });
  mountPluginRoutes({ userRouter: mod.userRouter, dataRouter: mod.dataRouter, adminRouter: mod.adminRouter });

  await mod.runMigration();
  await fixLegacyAppIds(); // 修正 runs.ts 硬编码时期误标 'ai-studio' 的本地会话(仅 standalone 本地库)
  mod.startBackgroundTasks();

  const app = express();
  app.use(express.json({ limit: '25mb' }));
  // CORS:桌面 renderer(dev http://localhost:5173 / 打包 file://)跨源直连本服务。
  // 鉴权靠 Bearer token(无 cookie),放开 origin 无 CSRF 面。
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  let version = '';
  try {
    version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '';
  } catch { /* dist 布局异常时留空 */ }
  const startedAt = new Date().toISOString();
  app.get('/health', (_req, res) =>
    res.json({ ok: true, mode: 'standalone', sandbox: sandboxMode, version, startedAt }));
  app.use('/', mod.userRouter); // /agent/runs、/agent/runs/:id/events、/agent/workspace/*、审批
  app.use('/', mod.dataRouter); // /agent/sessions、/agent/models、/agent/memory、/agent/skills、/agent/tools

  app.listen(cfg.port, cfg.host, () => {
    console.log(`[tangu] standalone 已启动 http://${cfg.host}:${cfg.port}`);
    console.log(`[tangu] cloud=${cfg.cloudUrl} 存储=${storage} sandbox=${sandboxMode} model=${cfg.defaultModelId || '(run 指定)'}`);
    if (providers.length) {
      console.log(`[tangu] 直连 provider: ${providers.map((p) => p.providerId).join(', ')}(其余 LLM 走 Forsion 托管面)`);
    }
    const mcpStatus = mcp.listStatus();
    if (mcpStatus.length) {
      console.log(`[tangu] MCP: ${mcpStatus.map((s) => `${s.name}(${s.status},${s.toolCount}工具)`).join(', ')}`);
    }
    const engineList = engines.list();
    if (engineList.length) {
      console.log(`[tangu] 外部引擎: ${engineList.map((e) => `${e.name}(${e.id})`).join(', ')}`);
    }
  });

  // 优雅退出(桌面 backendManager 发 SIGTERM):停定时器/中止 run/杀 MCP stdio 子进程。
  const shutdown = (): void => {
    try { mod.dispose(); } catch { /* ignore */ }
    void mcp.dispose().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('[tangu] 启动失败:', e?.message || e);
  process.exit(1);
});
