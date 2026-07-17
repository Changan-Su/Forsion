/**
 * 各 app 的 profile 覆盖(checked-in 文件层)—— 基线恒为 ai-studio(createAiStudioProfile),
 * 此处只声明**与基线的差异**(能力/工具/提示)。运行期优先级:DB 覆盖 > 本文件 > 基线。
 *
 * 新增一个 app 的两条路径(任一即可,零代码改动):
 *   1) 文件(随版本走、给默认值):在此 map 加一项 `'<appId>': { ... }`;
 *   2) admin panel(运行期热改):/api/admin/agent-core/profiles 写 app_profile_overrides 表,
 *      远程 worker ≤一个刷新窗口(15s)收敛,无需重启。
 *
 * 可覆盖字段见 AppProfileOverride(seams/appProfile.ts):enabled / displayName / defaultModelId /
 * toolBuiltins('all'|工具名白名单) / capabilities{memory,log} / features{webSearch,customTools,sandbox} /
 * promptGuidance(整段替换) / promptEnvironment{sandbox,host}。
 * ⚠️ hostExec / historian / sandboxMode 不可覆盖(部署级强制,云端永不可拿 host-exec)。
 *
 * 沙箱一致性:一个 worker 进程只 docker 或 none,其承载的所有 app 共享该 sandboxMode;
 * `features.sandbox` 只有在 worker 实际有 docker 时才生效(合并时 AND-gate)。
 */
import type { AppProfileOverride } from '../seams/appProfile.js';

export const APP_PROFILE_OVERRIDES: Record<string, AppProfileOverride> = {
  // 'ai-studio' 即基线,无需条目。
  //
  // Tangu 全端共用 app id(桌面 standalone 基线本就是 'tangu';此条让云端 worker 也认它,
  // web/桌面云会话统一走这一个 id,admin 的应用模型配置也只配一份)。值与 standalone 基线等价,
  // 桌面本地行为零变化。**必须走文件层**:worker 若用本地 SQLite(非共享 PG),gateway 往 PG 的
  // app_profile_overrides seed 到不了它,只有 checked-in 文件层随镜像烘进每个 worker。
  // 2026-07-17 弃用独立的 'tangu-web' id(用户拍板共用;server/microserver/tangu-web 挂载留作兼容)。
  'tangu': {
    displayName: 'Tangu',
    toolBuiltins: 'all',
    capabilities: { memory: true, log: true, groupChat: true },
    features: { webSearch: true, customTools: true, sandbox: true },
  },
  //
  // 示例(按需启用并按实际规格修改):
  // 'desk': {
  //   displayName: 'Desk',
  //   features: { webSearch: false },
  //   toolBuiltins: ['get_datetime', 'calculator', 'read_file', 'write_file', 'list_files', 'use_skill'],
  //   promptGuidance: ['## 使用提示\n本应用面向桌面办公场景……'],
  // },
};
