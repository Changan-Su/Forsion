/**
 * 接缝①:AppProfile —— 每个 app/部署一份的装载声明(G1/G2)。
 * 工厂见 src/profiles/(aiStudio=云端多租户、tangu=本地/standalone);装配进 TanguDeps.profile。
 *   microserver:createAiStudioProfile()
 *   standalone/TUI:createTanguProfile({ sandboxMode, … })
 *   worker:createAiStudioProfile({ appId: cfg.appId, historian: false, … })
 */
import { deps } from './runtime.js';
import type { ToolProvider } from '../tools/toolRegistry.js';

export interface PromptSectionCtx {
  execMode: 'sandbox' | 'host';
  cwd?: string;
}

/**
 * 系统提示静态段(G4),按插入位置分组(保持与原内联文本相同的段落顺序):
 *   guidance    在「用户长期记忆」段之后、技能段之前(记忆与日志使用指引);
 *   environment 在技能段之后(host=本地执行环境;sandbox=文件输出位置 + 执行效率)。
 */
export interface PromptSections {
  guidance: string[];
  environment: string[];
}

export interface AppProfile {
  /** 取代硬编码的 'ai-studio'(会话/沙箱/资产作用域)。 */
  appId: string;
  displayName: string;
  defaultModelId?: string;
  /** 代码执行后端:docker 沙箱 / 无(禁 exec 类工具)。 */
  sandboxMode: 'docker' | 'none';
  features: {
    sandbox: boolean;
    webSearch: boolean;
    historian: boolean;
    customTools: boolean;
  };
  /** 能力门禁(红线④):未声明 hostExec 的 app,agent_config.execMode='host' 一律强制回 sandbox。 */
  capabilities: {
    hostExec: boolean;
    memory: boolean;
    log: boolean;
  };
  /** 'all'=全部内置工具(零行为变化基线);string[]=内置白名单。providers=app 自带工具(随 G3 生效)。 */
  toolLoadout: {
    builtins: 'all' | string[];
    providers?: ToolProvider[];
  };
  /** 系统提示静态段按 profile 装载(G4)。 */
  promptSections(ctx: PromptSectionCtx): PromptSections;
}

/**
 * 单个 app 对基线(ai-studio)的覆盖声明。来源:checked-in 文件(appProfiles.config.ts)
 * 与 DB 表 app_profile_overrides(admin panel 可改),DB 覆盖文件覆盖基线,逐字段。
 *
 * ⚠️ 故意**不含** hostExec / historian / sandboxMode / providers —— 这些是部署级强制字段,
 * 绝不可经覆盖授予(红线:云端永不可拿 host-exec)。合并时一律取基线值。
 */
export interface AppProfileOverride {
  /** false → 该 app 被路由拒绝(等同未知 app,400)。缺省 true。 */
  enabled?: boolean;
  displayName?: string;
  /** null/'' 清空(回落基线默认);string 设为该模型。 */
  defaultModelId?: string | null;
  /** 'all' 或内置工具白名单(未知名在合并时丢弃);缺省=继承基线。 */
  toolBuiltins?: 'all' | string[];
  capabilities?: { memory?: boolean; log?: boolean };
  features?: { webSearch?: boolean; customTools?: boolean; sandbox?: boolean };
  /** 整段替换默认 guidance(`promptSections().guidance`);缺省=继承。 */
  promptGuidance?: string[];
  /** 按 execMode 整段替换默认 environment;云端恒 sandbox,故只 .sandbox 生效。 */
  promptEnvironment?: { sandbox?: string[]; host?: string[] };
}

/**
 * 按 app_id 解析 profile。装配期 configureTangu 已建 ProfileStore(基线⊕文件⊕DB 快照),
 * 故走快照同步解析:缺省 appId → 基线 app;有快照条目 → 返回;无 → null(路由侧 400)。
 * 无 store 的退路(理论上不触发,configureTangu 恒建)保留旧单 profile 语义。
 */
export function resolveProfile(appId?: string | null): AppProfile | null {
  return deps().profileStore.resolve(appId);
}
