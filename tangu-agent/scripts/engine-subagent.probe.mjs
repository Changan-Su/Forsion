/**
 * 引擎子代理真机探针:让 delegate 的 engine 路径真的拉起一个外部 agent CLI(ACP)跑一次子任务。
 * 单测只覆盖翻译器与接线;这个脚本验的是「真能 spawn 起来、握手成功、终稿回得来」。
 *
 *   node scripts/engine-subagent.probe.mjs [engineId] [cwd]
 *   # 默认 codex;claude-code 需 `env -u CLAUDECODE`(Claude Code 拒绝嵌套自己的会话)
 *
 * 用无需工具的提示词 → 不触发审批(探针里没人应答审批弹窗)。需先 npm run build。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { configureTangu } = await import(path.join(R, 'seams/runtime.js'));
const { createTanguProfile } = await import(path.join(R, 'profiles/index.js'));
const { createEngineManager } = await import(path.join(R, 'engines/manager.js'));
const { runSubAgent } = await import(path.join(R, 'services/subAgent.js'));

const engineId = process.argv[2] || 'codex';
const cwd = process.argv[3] || process.cwd();
const events = [];
const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
configureTangu({
  profile: createTanguProfile({ sandboxMode: 'none' }),
  brain: stub,
  store: stub,
  state: { appendEvent: async (_r, type, payload) => { events.push({ type, payload }); return events.length; }, drain: async () => {} },
  engines: createEngineManager(),
});

const phases = () => events.filter((e) => e.type === 'subagent').map((e) => e.payload.phase).join(',');
const t0 = Date.now();
try {
  const out = await runSubAgent({
    task: 'Do not use any tools. Reply with exactly this token and nothing else: TANGU_ENGINE_PROBE_OK',
    parentCtx: { userId: 'u', sessionId: 's', appId: 'tangu', execMode: 'host', cwd, runId: 'probe-run', modelId: 'm' },
    modelId: 'm',
    engineId,
  });
  console.log('result   :', JSON.stringify(out));
  console.log('phases   :', phases());
  console.log('subchat  :', events.filter((e) => e.type === 'subchat').length);
  console.log('elapsed  :', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log(out.includes('TANGU_ENGINE_PROBE_OK') ? 'PROBE: PASS' : 'PROBE: content mismatch');
} catch (e) {
  console.log('PROBE: FAIL', e?.message || e);
  console.log('phases   :', phases());
  process.exitCode = 1;
}
process.exit();
