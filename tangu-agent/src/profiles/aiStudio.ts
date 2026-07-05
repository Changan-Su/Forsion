/**
 * AI Studio profile(云端多租户:microserver 进程内 / 分离式云 worker)。
 * 第一个 AppProfile 实例,要求与改造前行为零差异:builtins:'all'、全部 features 按原字面量。
 * hostExec:false —— 云端形态绝不允许 host-exec(红线②/④),loop 会把 execMode='host' 强制回 sandbox。
 */
import type { AppProfile } from '../seams/appProfile.js';
import { defaultPromptSections } from './promptSections.js';

export function createAiStudioProfile(opts?: {
  /** worker 按 app 部署时覆盖(env TANGU_APP_ID);缺省 'ai-studio'。 */
  appId?: string;
  sandboxMode?: 'docker' | 'none';
  defaultModelId?: string;
  /** worker 传 false(共享云库下 historian 是全局任务,多 worker 互扰);microserver 缺省 true。 */
  historian?: boolean;
}): AppProfile {
  const sandboxMode = opts?.sandboxMode ?? 'docker';
  return {
    appId: opts?.appId || 'ai-studio',
    displayName: 'AI Studio',
    defaultModelId: opts?.defaultModelId || undefined,
    sandboxMode,
    features: {
      sandbox: sandboxMode === 'docker',
      webSearch: true,
      historian: opts?.historian ?? true,
      customTools: true,
    },
    capabilities: { hostExec: false, groupChat: false, memory: true, log: true },
    toolLoadout: { builtins: 'all' },
    promptSections: defaultPromptSections,
  };
}
