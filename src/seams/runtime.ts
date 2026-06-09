/**
 * 接缝装配点。一次性 configureTangu(deps),core 各处用 deps() 取注入的依赖
 * (避免给每个函数都加 ctx 参数的大改)。单进程单例;每个部署进程装配一次。
 */
import type { HostServices } from './hostServices.js';
import type { CloudBrainServices } from './cloudBrain.js';
import type { BillingServices } from './billing.js';
import type { AppProfile } from './appProfile.js';

export interface TanguDeps {
  host: HostServices;
  brain: CloudBrainServices;
  billing: BillingServices;
  profile: AppProfile;
}

let _deps: TanguDeps | null = null;

/** 装配依赖(microserver 适配器 / standalone bootstrap 各调一次)。 */
export function configureTangu(d: TanguDeps): void {
  _deps = d;
}

/** 取已装配的依赖;未装配即抛(防止漏调 configureTangu)。 */
export function deps(): TanguDeps {
  if (!_deps) throw new Error('[tangu] runtime not configured — call configureTangu() first');
  return _deps;
}

export function isConfigured(): boolean {
  return _deps !== null;
}
