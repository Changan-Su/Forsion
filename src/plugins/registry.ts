/**
 * 统一插件注册表(Obsidian 模型)。内置「核心插件」(编进 app)与文件夹插件(loader 加载)登记同一处;
 * 「设置 → 插件」据此列出每个插件并渲染其 schema 设置面板。每个插件可贡献:工具 provider、提示词片段、
 * 设置 schema(全局 / 按 agent 作用域)。启用状态与设置值存 settingsStore(本表不持久化)。
 *
 * 注意:本表 = 插件「元数据 + 运行时贡献」;src/plugins/{loader,bootstrap,types}.ts = 文件夹插件的发现/装配。
 */
import { registerToolProvider, type ToolProvider } from '../tools/toolRegistry.js';

export type SettingsScope = 'global' | 'agent';

/** 设置字段(供前端通用面板渲染)。label/labelEn 由插件自带,随 locale 显示。 */
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
  /** 设置作用域;缺省 ['global']。含 'agent' 时面板提供「全局 / 按 agent」切换。 */
  scopes?: SettingsScope[];
  settings?: PluginSettingsSchema;
  /** 缺省关闭;用户在「设置 → 插件」开关。 */
  defaultEnabled?: boolean;
  /** 'builtin'=编进 app;'folder'=从目录加载。注册时填,缺省 builtin。 */
  source?: 'builtin' | 'folder';
  /** 该插件提供的工具(按 isEnabledFor 检查 启用+作用域 门禁)。 */
  toolProvider?: ToolProvider;
  /** 启用时注入系统提示的片段(读自身设置组装);空串=不注入。 */
  promptSection?(ctx: PluginPromptCtx): Promise<string> | string;
}

const REGISTRY = new Map<string, PluginMeta>();

/** 运行期激活但贡献了路由(必须重启才挂上)的插件 id。供「设置→插件」逐条标「需重启」。 */
export const pluginsNeedingRestart = new Set<string>();

/** 登记一个插件。若带 toolProvider,顺带注册到工具表(append,按 isEnabledFor 门禁)。同 id 幂等覆盖。 */
export function registerPlugin(meta: PluginMeta): void {
  const m: PluginMeta = { source: 'builtin', scopes: ['global'], ...meta };
  REGISTRY.set(m.id, m);
  if (m.toolProvider) registerToolProvider(m.toolProvider);
}

export function listPluginMetas(): PluginMeta[] {
  return [...REGISTRY.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function getPluginMeta(id: string): PluginMeta | undefined {
  return REGISTRY.get(id);
}
