/**
 * Tangu 插件公开 API 正典(apiVersion 1)。这是「稳定公共子集」,不是核心全量类型——
 * 面越小,兼容承诺越小;插件需要新能力时按需扩这里并升 apiVersion。
 *
 * 单源规则:只编辑本文件,然后 `npm run sync:plugin-api` 同步到 plugins/<dir>/types/(逐字节拷贝);
 * 与核心真类型的兼容由 src/plugins/apiContract.ts 双向断言,随 `npm run typecheck` 跑,漂移即编译错误。
 * 插件侧用法:tsconfig `paths` 把裸标识符 @forsion/tangu-agent 映射到本文件拷贝,一律 `import type`
 * (verbatimModuleSyntax 把值导入变成编译错误);运行时能力全经 activate(ctx) 按引用传入的 ctx.sdk。
 */

/** core/types 的 Tool 最小投影(function 工具)。 */
export interface Tool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 设置/数据作用域:全局 或 按 agent。 */
export type Scope = 'global' | { agentSlug: string };

/** 能力门禁(只投影工具门禁读到的 capabilities)。 */
export interface AppProfile {
  capabilities: { hostExec: boolean; groupChat: boolean; memory: boolean; log: boolean };
}

export interface ToolContext {
  userId: string;
  sessionId: string;
  appId: string;
  signal?: AbortSignal;
  execMode?: 'sandbox' | 'host';
  cwd?: string;
  agentSlug?: string;
  displayFile?: (item: { name: string; mime?: string; path?: string; dataUrl?: string }) => void;
}

export interface ToolCapabilities {
  sideEffect?: 'none' | 'read' | 'network' | 'browser' | 'write' | 'system' | 'unknown';
  parallel?: boolean;
  concurrencyKey?: string;
  defaultTimeoutMs?: number;
}

export interface ToolDef {
  name: string;
  definition: Tool;
  execute: (args: Record<string, any>, ctx: ToolContext) => Promise<string> | string;
  mode?: 'sandbox' | 'host' | 'both';
  capabilities?: ToolCapabilities;
  isEnabledFor?(profile: AppProfile, ctx: ToolContext): boolean;
}

export interface ToolProvider {
  id: string;
  tools(): ToolDef[];
}

export type SettingsScope = 'global' | 'agent';

export type SettingsField =
  | { key: string; type: 'toggle'; label: string; labelEn?: string; help?: string; helpEn?: string; default?: boolean }
  | { key: string; type: 'text' | 'textarea'; label: string; labelEn?: string; help?: string; helpEn?: string; default?: string; placeholder?: string }
  | { key: string; type: 'number'; label: string; labelEn?: string; help?: string; helpEn?: string; default?: number; min?: number; max?: number }
  | { key: string; type: 'select'; label: string; labelEn?: string; help?: string; helpEn?: string; default?: string; options: Array<{ value: string; label: string; labelEn?: string }> }
  | { key: string; type: 'image-list'; label: string; labelEn?: string; help?: string; helpEn?: string; itemFields: SettingsField[] };

export interface PluginSettingsSchema { fields: SettingsField[] }

export interface PluginPromptCtx { slug: string; userId: string; execMode: 'host' | 'sandbox' }

export interface PluginMeta {
  id: string;
  name: string;
  nameEn?: string;
  description: string;
  descriptionEn?: string;
  scopes?: SettingsScope[];
  settings?: PluginSettingsSchema;
  defaultEnabled?: boolean;
  source?: 'builtin' | 'folder';
  toolProvider?: ToolProvider;
  promptSection?(ctx: PluginPromptCtx): Promise<string> | string;
}

/** ctx.sdk.pluginStore —— 只列插件常用成员(读写自身设置 + image-list blob)。 */
export interface PluginStore {
  isPluginEnabledSync(id: string): boolean;
  resolveImageListScope(id: string, field: string, agentSlug?: string): Scope;
  getScopeSettings(id: string, scope: Scope): Record<string, any>;
  setScopeSettings(id: string, scope: Scope, patch: Record<string, any>): Promise<Record<string, any>>;
  readPluginFile(id: string, scope: Scope, name: string): Promise<{ buffer: Buffer; mimeType: string } | null>;
  writePluginFile(id: string, scope: Scope, name: string, buf: Buffer): Promise<string>;
  deletePluginFile(id: string, scope: Scope, name: string): Promise<void>;
}

/** 运行时句柄(按引用传入,核心同一模块实例)。只列稳定公开成员。 */
export interface TanguSdk {
  pluginStore: PluginStore;
  sendWechatMedia(
    userId: string,
    sessionId: string,
    buffer: Buffer,
    opts: { kind: 'image' | 'file'; fileName: string },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface TanguPluginContext {
  registerPlugin(meta: PluginMeta): void;
  registerToolProvider(p: ToolProvider): void;
  sdk: TanguSdk;
  log(msg: string): void;
  paths: { pluginDir: string };
}

export interface TanguPlugin {
  manifest?: { id: string; name: string; version: string; apiVersion: number; entry: string; commands?: string[]; description?: string };
  activate(ctx: TanguPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
