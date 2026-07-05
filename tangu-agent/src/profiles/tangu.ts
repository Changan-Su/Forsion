/**
 * Tangu profile(本地形态:standalone server / TUI / 桌面端 managed 后端)。
 * hostExec:true —— 本地形态允许 execMode='host'(真实 FS/shell + 审批闸门);
 * historian:false —— 本地单用户无后台复盘需求(与改造前字面量一致)。
 */
import type { AppProfile } from '../seams/appProfile.js';
import { defaultPromptSections } from './promptSections.js';

export function createTanguProfile(opts: {
  sandboxMode: 'docker' | 'none';
  defaultModelId?: string;
  /** 内置工具白名单。省略 = 'all'（全开）。容器编排（Tangu Manager）经 TANGU_TOOL_BUILTINS 下发裁剪。 */
  toolBuiltins?: 'all' | string[];
}): AppProfile {
  return {
    appId: 'tangu',
    displayName: 'Tangu',
    defaultModelId: opts.defaultModelId || undefined,
    sandboxMode: opts.sandboxMode,
    features: {
      sandbox: opts.sandboxMode === 'docker',
      webSearch: true,
      historian: false,
      customTools: true,
    },
    capabilities: { hostExec: true, groupChat: true, memory: true, log: true },
    toolLoadout: { builtins: opts.toolBuiltins ?? 'all' },
    promptSections: defaultPromptSections,
  };
}
