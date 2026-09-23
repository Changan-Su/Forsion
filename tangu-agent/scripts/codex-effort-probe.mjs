#!/usr/bin/env node
/**
 * Codex 订阅 × 思考档位实测探针 —— Codex 发新模型时,一条命令读出「目录里有没有它 / 后端认哪些档 / 工具轮通不通」。
 * 走编译产物的真链路:目录发现(client_version)→ codex/<model> 路由 → 能力表夹档 → 流式工具调用 → 工具结果续轮。
 *
 * 用法(在 Forsion-Genesis/tangu-agent 下先 npm run build):
 *   node scripts/codex-effort-probe.mjs gpt-6-sol off minimal max        # 按能力表发:打印每档实际上 wire 的 effort
 *   FORCE_EFFORT=minimal node scripts/codex-effort-probe.mjs gpt-6-sol   # 绕过能力表强发:后端 400 原文会列出该模型的合法值集合
 *
 * 取证口径(09-22):Codex 客户端目录的 supported_reasoning_levels 比后端窄(不列 none),合法值以后端 400 原文为准;
 * 能力表 modelCapabilities.ts 的 GPT-6 各支就是这么定的。
 * 凭证:把 ~/.forsion-dev/provider-auth.json(TANGU_LIVE_AUTH 可改)软链进临时隔离 home,引擎自己读,本脚本不读不打印;
 * 目录重拉 / token 刷新会写回同一文件(与 live 台架、开第二个桌面实例一致)。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const [modelArg, ...levels] = process.argv.slice(2);
if (!modelArg) { console.error('用法: node scripts/codex-effort-probe.mjs <model> [level...]'); process.exit(2); }
const model = modelArg.includes('/') ? modelArg : `codex/${modelArg}`;
const AUTH = path.resolve(process.env.TANGU_LIVE_AUTH || path.join(homedir(), '.forsion-dev', 'provider-auth.json'));
if (!existsSync(AUTH)) { console.error(`凭证不存在:${AUTH}(先在 dev 桌面登录 Codex 订阅)`); process.exit(2); }

// 隔离 home:<tmp>/forsion/{provider-auth.json→软链, tangu/}(basename 必须是 tangu,引擎才去父目录找凭证)
const root = mkdtempSync(path.join(tmpdir(), 'codex-effort-probe-'));
const shared = path.join(root, 'forsion');
mkdirSync(path.join(shared, 'tangu'), { recursive: true });
symlinkSync(AUTH, path.join(shared, 'provider-auth.json'));
process.env.TANGU_HOME = path.join(shared, 'tangu');

const DIST = process.env.TANGU_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const imp = (p) => import(pathToFileURL(path.join(DIST, p)).href);
const { loadOAuthDirectProviders } = await imp('llm/providerOAuth.js');
const { createProviderRegistry } = await imp('llm/providerRegistry.js');
const { createMultiBrain } = await imp('adapters/standalone/multiBrain.js');

let failed = 0;
try {
  const providers = await loadOAuthDirectProviders();
  const codex = providers.find((p) => p.providerId === 'codex');
  console.log('catalog:', JSON.stringify(codex?.modelIds ?? null));
  if (!codex) throw new Error('没有 codex 订阅凭证');
  const brain = createMultiBrain({ llm: {}, models: {}, search: {}, images: {} }, createProviderRegistry(providers));
  const tool = {
    type: 'function',
    function: { name: 'echo_probe', description: 'Returns the given word unchanged.', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } },
  };

  for (const level of levels.length ? levels : ['off', 'max']) {
    const r = await brain.llm.resolveModelAndKey(model);
    const messages = [
      { role: 'system', content: 'You are a test harness. Follow instructions exactly.' },
      { role: 'user', content: 'Call echo_probe with word "ping". After you get the tool result, reply with exactly the tool result and nothing else.' },
    ];
    const build = () => brain.llm.buildProviderPayload({ model: r.model, apiModelId: r.apiModelId, messages, tools: [tool], thinkingLevel: level, cacheKey: 'codex-effort-probe' });
    const call = async (payload) => brain.llm.streamProviderCompletion({ apiKey: r.apiKey, baseUrl: r.baseUrl, payload });
    const p1 = await build();
    if (process.env.FORCE_EFFORT) p1.reasoning_effort = process.env.FORCE_EFFORT;
    const t0 = Date.now();
    const row = { model, requested: level, wireEffort: p1.reasoning_effort ?? null };
    try {
      const s1 = await call(p1);
      const tc = s1.toolCalls?.[0];
      row.tool = tc?.function?.name ?? null;
      if (tc) {
        // 续轮照 agentLoop:原始 output items 挂回 assistant(store:false 靠 encrypted_content 维持思考延续)
        messages.push({ role: 'assistant', content: s1.content || '', tool_calls: s1.toolCalls, ...(s1.outputItems ? { providerItems: s1.outputItems } : {}) });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.parse(tc.function.arguments || '{}').word ?? '' });
        row.final = ((await call(await build())).content || '').trim();
      }
      row.ok = row.tool === 'echo_probe' && row.final === 'ping';
    } catch (e) {
      row.ok = false;
      row.error = String(e?.message || e).slice(0, 400);
    }
    row.ms = Date.now() - t0;
    if (!row.ok) failed++;
    console.log(JSON.stringify(row));
  }
} finally {
  rmSync(root, { recursive: true, force: true }); // 只删软链本身,不跟随到真凭证
}
process.exit(failed ? 1 : 0);
