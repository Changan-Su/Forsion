/**
 * profile 合并(基线 ⊕ 覆盖)+ 护栏。纯函数,无副作用,不抛(校验/拒绝在 admin API 层)。
 *
 * 关键语义:
 *  - result.appId = **传入的 appId**(会话/沙箱/资产作用域键)——一个 baseline 可服务多 app。
 *  - sandboxMode / capabilities.hostExec / features.historian / toolLoadout.providers 恒取 base
 *    (部署级强制字段,绝不可经覆盖授予;云端永不可拿 host-exec —— 与 agentLoop.ts:228 双保险)。
 *  - features.sandbox 受 worker 实际沙箱能力 AND-gate(none worker 不可开 run_python/pip_install)。
 *  - toolBuiltins 白名单按已注册工具名校验,未知名丢弃(typo 不致清空工具集)。
 */
import type {
  AppProfile,
  AppProfileOverride,
  PromptSectionCtx,
  PromptSections,
} from '../seams/appProfile.js';
import { listToolProviders } from '../tools/toolRegistry.js';

let _knownTools: Set<string> | null = null;

/** 已注册内置工具名集合。provider 在 registry.ts 副作用注册;首个非空结果后缓存。 */
export function getKnownToolNames(): string[] {
  if (_knownTools && _knownTools.size) return [..._knownTools];
  const names = new Set<string>();
  for (const p of listToolProviders()) for (const t of p.tools()) names.add(t.name);
  if (names.size) _knownTools = names;
  return [...names];
}

function buildPromptSections(base: AppProfile, ov: AppProfileOverride): AppProfile['promptSections'] {
  return (ctx: PromptSectionCtx): PromptSections => {
    const b = base.promptSections(ctx); // 未覆盖部分与默认段字节一致
    const guidance = ov.promptGuidance ?? b.guidance; // 整段替换
    const envOv = ov.promptEnvironment?.[ctx.execMode]; // 按模式整段替换(云端恒 sandbox)
    return { guidance, environment: envOv ?? b.environment };
  };
}

export function mergeProfile(
  appId: string,
  base: AppProfile,
  ov?: AppProfileOverride | null,
): AppProfile {
  if (!ov) {
    // 无覆盖:仍把 appId 落到结果(多 app 共享一个 baseline 时,appId 必须是请求的 app)。
    return appId === base.appId ? base : { ...base, appId };
  }

  const known = getKnownToolNames();
  const knownSet = new Set(known);
  let builtins = base.toolLoadout.builtins;
  if (ov.toolBuiltins === 'all') {
    builtins = 'all';
  } else if (Array.isArray(ov.toolBuiltins)) {
    // known 为空(provider 尚未注册)时不过滤,避免启动顺序导致误清空。
    const ok = ov.toolBuiltins.filter((n) => knownSet.size === 0 || knownSet.has(n));
    if (ok.length) builtins = ok;
  }

  return {
    appId, // 强制 = 请求的 appId(身份/作用域)
    displayName: ov.displayName ?? (appId === base.appId ? base.displayName : appId),
    defaultModelId:
      ov.defaultModelId !== undefined ? ov.defaultModelId || undefined : base.defaultModelId,
    sandboxMode: base.sandboxMode, // 强制(部署能力)
    features: {
      // 受 worker 实际沙箱能力 AND-gate:none worker 即便覆盖 true 也开不了沙箱工具。
      sandbox: (ov.features?.sandbox ?? base.features.sandbox) && base.sandboxMode === 'docker',
      webSearch: ov.features?.webSearch ?? base.features.webSearch,
      historian: base.features.historian, // 强制(进程级全局任务)
      customTools: ov.features?.customTools ?? base.features.customTools,
    },
    capabilities: {
      hostExec: base.capabilities.hostExec, // 强制(红线,永不可经覆盖授予)
      groupChat: ov.capabilities?.groupChat ?? base.capabilities.groupChat, // 可覆盖(云端可授予的安全编排能力)
      memory: ov.capabilities?.memory ?? base.capabilities.memory,
      log: ov.capabilities?.log ?? base.capabilities.log,
    },
    toolLoadout: { builtins, providers: base.toolLoadout.providers }, // providers 强制
    promptSections: buildPromptSections(base, ov),
  };
}
