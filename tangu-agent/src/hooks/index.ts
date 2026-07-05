/** Lifecycle Hooks 子系统 barrel。派发点 import { runHooks } from '../hooks/index.js'。 */
export * from './types.js';
export { matcherMatches, validateMatcherPattern } from './matcher.js';
export { hookContentHash, hookKey } from './trust.js';
export {
  type HooksConfig,
  type HookTrustState,
  HOOKS_DEFAULTS,
  normalizeHooksConfig,
  loadHooksConfig,
  saveHooksConfig,
  discoverHooks,
  discoverAll,
  trustHook,
  setHookEnabled,
  syncUserTrust,
} from './config.js';
export { foldVerdict } from './events.js';
export { runHooks, executeHook, parseHookOutput } from './runner.js';
