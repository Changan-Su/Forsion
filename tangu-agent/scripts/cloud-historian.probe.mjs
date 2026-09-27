#!/usr/bin/env node
/**
 * 云端按轮 Historian(services/historian.ts 的 onCloudRunDone,网关跑,服务 web/安卓 tangu 会话)的真模型探针。
 * live:harness 起的是 standalone(hostExec)引擎,云端 Historian 在那里根本不启动 —— 改它的提示词 / 记忆写入后跑这个。
 *
 *   npm run build && node scripts/cloud-historian.probe.mjs                 # 缺省 codex/gpt-5.6-luna
 *   TANGU_LIVE_MODEL=codex/gpt-5.6-sol node scripts/cloud-historian.probe.mjs
 *
 * 真引擎 onCloudRunDone(首轮触发)× 真模型(~/.forsion-dev/provider-auth.json 软链进隔离家目录)× 内存 SQLite;
 * memory/log seam 换成记录器(不碰任何真实记忆)。三段对话:有稳定偏好 / 纯一次性任务 / 偏好已在记忆里。
 * 判据:① 偏好会话至少记下一条且不含密钥 ② 一次性会话记 0 条 ③ 已有记忆不重复记。模型原话全打印。
 */
import { mkdtempSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const AUTH = process.env.TANGU_LIVE_AUTH || join(homedir(), '.forsion-dev', 'provider-auth.json');
const MODEL = process.env.TANGU_LIVE_MODEL || 'codex/gpt-5.6-luna';
if (!existsSync(join(dist, 'services', 'historian.js'))) { console.error('dist 缺失,先 npm run build'); process.exit(2); }
if (!existsSync(AUTH)) { console.error(`凭证不存在:${AUTH}`); process.exit(2); }

// 隔离家目录:basename 必须是 tangu,forsionSharedDir() 才会到父目录找 provider-auth.json
const shared = mkdtempSync(join(tmpdir(), 'tangu-cloudhist-'));
const home = join(shared, 'tangu');
mkdirSync(home);
symlinkSync(AUTH, join(shared, 'provider-auth.json'));
process.env.TANGU_HOME = home;

const imp = (p) => import(join(dist, p));
const { configureTangu } = await imp('seams/runtime.js');
const { createAiStudioProfile } = await imp('profiles/index.js');
const { createSqliteHost } = await imp('adapters/standalone/sqliteHost.js');
const { toSqliteDDL } = await imp('core/dialectDDL.js');
const { STANDALONE_SCHEMA } = await imp('db/schemaStandalone.js');
const { runMigration } = await imp('db/migrate.js');
const { query } = await imp('core/db.js');
const { currentAgentSlug } = await imp('seams/runContext.js');
const { loadOAuthDirectProviders } = await imp('llm/providerOAuth.js');
const { createProviderRegistry } = await imp('llm/providerRegistry.js');
const { createMultiBrain } = await imp('adapters/standalone/multiBrain.js');
const { onCloudRunDone } = await imp('services/historian.js');
const { setHistorianConfig } = await imp('services/historianConfig.js');

const EXISTING = { 'dup-s': '- 用户偏好用 pnpm 而不是 npm 管理依赖' };
const writes = []; const logs = []; const raw = [];
const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
local.db.exec(toSqliteDDL(STANDALONE_SCHEMA));
const multi = createMultiBrain({ llm: {} }, createProviderRegistry(await loadOAuthDirectProviders()));
let current = '';
configureTangu({
  host: local.host,
  profile: createAiStudioProfile({ sandboxMode: 'none' }), // 网关形态:非 hostExec
  brain: {
    llm: {
      resolveModelAndKey: (id) => multi.llm.resolveModelAndKey(id),
      buildProviderPayload: (p) => multi.llm.buildProviderPayload(p),
      streamProviderCompletion: async (o) => { const r = await multi.llm.streamProviderCompletion(o); raw.push([current, r.content]); return r; },
    },
    users: { getUserById: async () => null },
    models: { listModelsForProject: async () => ({ models: [], defaultModelId: MODEL, backgroundModelId: MODEL }) },
    memory: {
      getMemory: async () => ({ content: EXISTING[current] || '', updatedAt: null }),
      appendMemoryEntry: async (_u, text) => { writes.push([current, currentAgentSlug(), text]); return { appended: true, length: 0 }; },
      appendLogEntry: async (_u, text) => { logs.push([current, text]); return {}; },
    },
  },
  billing: { calculateCost: async () => 0, canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), logApiUsage: async () => {} },
});
await runMigration();
await setHistorianConfig({ enabled: true, modelId: '', idleMinutes: 10 }); // 模型走 tangu 辅助槽(上面桩成 MODEL)

const CONVS = {
  'pref-s': [
    ['user', '帮我把这个 React 组件改成 TypeScript。以后写代码都用 TypeScript,别再给我 JS 了,我们团队只用 TS。'],
    ['model', '好的,已改写为 TypeScript 版本……(代码略)'],
    ['user', '还有,我的 OpenAI key 是 sk-proj-abcdefghijklmnopqrstuvwxyz123456,帮我写进 .env 示例里。另外回答别太啰嗦,直接给代码。'],
    ['model', '已写入 .env.example(用占位符替代了真实 key)。'],
  ],
  'oneoff-s': [
    ['user', '今天杭州天气怎么样?'],
    ['model', '今天杭州多云,22-28°C,午后可能有阵雨。'],
    ['user', '好的谢谢,那帮我把这句话翻译成英文:明天的会议改到下午三点。'],
    ['model', "The meeting tomorrow has been moved to 3 p.m."],
  ],
  'dup-s': [
    ['user', '帮我初始化一个 vite 项目,记得用 pnpm,我一直用 pnpm 不用 npm。'],
    ['model', '好的:pnpm create vite my-app --template react-ts,然后 pnpm install。'],
  ],
};
for (const [id, msgs] of Object.entries(CONVS)) {
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title) VALUES (?, 'u', 'tangu', '')`, [id]);
  await query(`INSERT INTO agent_runs (id, session_id, user_id, app_id, status) VALUES (?, ?, 'u', 'tangu', 'done')`, [`run-${id}`, id]);
  let t = Date.now() - 100_000;
  for (const [role, content] of msgs) await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`, [`${id}-${t}`, id, role, content, t++]);
}

// 每个会话 = 第 1 轮刚跑完(缺省首轮触发);串行跑,current 记「正在处理谁」
const t0 = Date.now();
for (const id of Object.keys(CONVS)) { current = id; await onCloudRunDone(`run-${id}`); }
console.log(`\n模型 ${MODEL} · 墙钟 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
for (const [id, text] of raw) console.log(`── ${id} 模型原话:\n${text}\n`);
const titles = await query(`SELECT id, title FROM chat_sessions ORDER BY id`);
console.log('标题:', titles.map((r) => `${r.id}=${r.title}`).join(' | '));
console.log('LOG:', logs.map(([id, t]) => `${id}: ${t}`).join(' | ') || '(无)');
console.log('记忆写入:', writes.map(([id, , t]) => `${id}: ${t}`).join(' | ') || '(无)');

const of = (id) => writes.filter(([s]) => s === id).map(([, , t]) => t);
const checks = [
  ['偏好会话至少记一条', of('pref-s').length >= 1],
  ['记忆里没有密钥原文', !writes.some(([, , t]) => /sk-proj-abc/.test(t))],
  ['一次性会话记 0 条', of('oneoff-s').length === 0],
  ['已有 pnpm 偏好不重复记', !of('dup-s').some((t) => /pnpm/i.test(t))],
  ['三个会话都判完(JSON 可解析、标题都更新)', raw.length === 3 && titles.every((r) => !!r.title)],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
