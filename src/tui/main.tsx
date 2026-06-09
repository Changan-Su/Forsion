#!/usr/bin/env node
/**
 * Tangu TUI 入口（`tangu` 命令）——成熟终端 agent（Ink）。
 *
 * 与 standalone-server / worker 同一套 Core，但**无 HTTP**：进程内跑 loop，
 * 用 Ink 渲染流式输出 + 工具卡片 + 状态栏 + 审批弹窗，从 stdin 读下一句。
 *   parseTuiConfig → (login 子命令) → setupHost(嵌入式 PGlite) → createTanguModule
 *   → printBanner → render(<App/>)（订阅事件总线渲染）。
 * 大脑（记忆/技能/LLM）走云端 brain-api（httpBrain），故需登录或 --cloud-url + --token。
 */
import { render } from 'ink';
import { createTanguModule } from '../index.js';
import { createNoopBilling } from '../adapters/standalone/noopBilling.js';
import { loadCreds } from '../standalone/credStore.js';
import { validate } from '../standalone/config.js';
import { resolveSandboxMode, setupHost, buildBrain } from '../standalone/assemble.js';
import { loginFlow } from '../cli/login.js';
import { OAUTH_PROVIDERS, providerOAuthLogin, loadOAuthDirectProviders } from '../llm/providerOAuth.js';
import { parseTuiConfig, TUI_HELP } from './config.js';
import { printBanner } from './components/Banner.js';
import { App } from './app.js';

async function main(): Promise<void> {
  const cfg = parseTuiConfig(process.argv.slice(2));
  if (cfg.showHelp) {
    process.stdout.write(TUI_HELP);
    return;
  }

  // `tangu login [provider]`：无 provider → Forsion 浏览器登录；有 provider → 该 provider 的 OAuth 登录当 LLM。
  if (process.argv[2] === 'login') {
    const which = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '';
    if (which) {
      const p = OAUTH_PROVIDERS[which];
      if (!p) {
        console.error(`  未知 provider: ${which}（可用: ${Object.keys(OAUTH_PROVIDERS).join(', ')}）`);
        process.exit(1);
      }
      try {
        await providerOAuthLogin(p);
        console.log(`\n  \x1b[32m✓ 已登录 ${which}\x1b[0m\x1b[2m，凭证存于 ~/.tangu/provider-auth.json\x1b[0m`);
        console.log(`\x1b[2m  现在可 \`tangu --model ${which}/<model>\`，用你的 ${which} 账号当 LLM。\x1b[0m\n`);
      } catch (e: any) {
        console.error(`\n  \x1b[31m✗ ${which} 登录失败: ${e?.message || e}\x1b[0m`);
        process.exit(1);
      }
      return;
    }
    const creds = loadCreds();
    await loginFlow(cfg.cloudUrl || creds.cloudUrl || '');
    return;
  }

  // 未显式给 token / cloud-url → 用 `tangu login` 存的凭证。
  const creds = loadCreds();
  if (!cfg.token) cfg.token = creds.token || '';
  if (!cfg.cloudUrl) cfg.cloudUrl = creds.cloudUrl || '';
  if (!cfg.defaultModelId) cfg.defaultModelId = creds.model || ''; // 记住的模型；仍可空，进 TUI 后用 /model 选
  try {
    cfg.providers.push(...(await loadOAuthDirectProviders()));
  } catch {
    /* ignore */
  }

  // 模型不再必填：登录后可空手进 TUI，进去用 /model 选模型（会被记住）。这里只校验云端连接。
  const errs = validate(cfg);
  if (errs.length) {
    process.stderr.write(
      '配置错误:\n  - ' +
        errs.join('\n  - ') +
        '\n\n  提示: 先 `tangu login --cloud-url <forsion 地址>` 登录，之后直接 `tangu` 即可（免 token，进去 /model 选模型）。\n\n' +
        TUI_HELP,
    );
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    console.error('Tangu TUI 需要交互式终端 (TTY)。脚本化 / HTTP 用 `tangu-server`。');
    process.exit(1);
  }

  const sandboxMode = await resolveSandboxMode(cfg);
  const { host, runBaseSchema, storage } = await setupHost(cfg);
  await runBaseSchema();
  const { brain, providers } = buildBrain(cfg);

  const mod = createTanguModule({
    host,
    brain,
    billing: createNoopBilling(),
    profile: {
      appId: 'tangu',
      defaultModelId: cfg.defaultModelId,
      sandboxMode,
      features: { sandbox: sandboxMode === 'docker', webSearch: true, historian: false, customTools: true },
    },
  });
  await mod.runMigration();
  // 终端单会话：关 run 自愈（别把上次残留 run 自动跑起来）+ historian；保留本机沙箱 janitor。
  mod.startBackgroundTasks({ recoverRuns: false, historian: false });

  printBanner({
    model: cfg.defaultModelId,
    cwd: cfg.cwd,
    execMode: cfg.execMode,
    storage,
    providers: providers.map((p) => p.providerId),
  });

  const app = render(<App boot={cfg} storage={storage} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  mod.dispose();
  process.exit(0);
}

main().catch((e) => {
  console.error('[tangu] 启动失败:', e?.message || e);
  process.exit(1);
});
