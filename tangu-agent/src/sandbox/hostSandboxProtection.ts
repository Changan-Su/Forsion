import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configFile, tanguHome, forsionSharedDir, agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../seams/runContext.js';

/** Resolve the nearest existing ancestor too, so a missing config under a home symlink is protected. */
export function canonicalFuturePath(input: string): string {
  let cursor = path.resolve(input);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(cursor), ...tail.reverse()); }
    catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(input);
      tail.push(path.basename(cursor)); cursor = parent;
    }
  }
}
/** Model-controlled execution must not change the next run's security config or runtime code. */
export function protectedHostPaths(): string[] {
  const original = [
    ...['.ssh', '.aws', '.gnupg', '.config/gcloud'].map((name) => path.join(os.homedir(), name)),
    fileURLToPath(new URL('../..', import.meta.url)), process.execPath, configFile(),
    path.join(forsionSharedDir(), 'auth.json'), path.join(forsionSharedDir(), 'provider-auth.json'),
    ...['.env', 'plugins', 'mcp.json', 'engines.json', 'engine-prefs.json', 'providers.json'].map((name) => path.join(tanguHome(), name)),
  ];
  for (const slug of new Set([currentAgentSlug() || DEFAULT_AGENT_SLUG, currentDisplayAgentSlug()].filter(Boolean))) {
    original.push(...['SOUL.md', 'config.toml', 'HARNESS.md', '.harness-refinements.jsonl', '.harness-raw.md', '.cloudsync-accounts.json', '.memory-state.json', '.memory-tombstones.json', '.memory-dream.json', '.memory-raw.md', '.memory.lock'].map((name) => path.join(agentsDir(), slug!, name)));
  }
  return [...new Set([...original.map((p) => path.resolve(p)), ...original.map(canonicalFuturePath)])];
}
export function protectedAncestors(paths: string[]): string[] {
  const ancestors = new Set<string>();
  for (const original of paths) {
    let parent = path.dirname(original);
    while (parent !== path.dirname(parent)) { ancestors.add(parent); parent = path.dirname(parent); }
  }
  return [...ancestors];
}
