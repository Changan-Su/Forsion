/** Live, read-only skill sources owned by one engine-plugin activation. */
import path from 'node:path';
import type { SkillRecord } from '../core/types.js';

export interface PluginSkillEntry {
  /** Provider-local kebab-case slug (1–64 characters). */
  id: string;
  name: string;
  description: string;
  /** Instructions, without YAML frontmatter. */
  content: string;
  /** Optional absolute directory for scripts/references; grants no file access. */
  dir?: string;
}

export interface PluginSkillListContext {
  cwd?: string;
  /** Aborted on timeout or when the owning activation is revoked. */
  signal?: AbortSignal;
}

export interface PluginSkillProvider {
  /** Provider-local kebab-case slug (1–64 characters). */
  id: string;
  /** Return only skills currently enabled at their source; called afresh on reads. */
  list(context: PluginSkillListContext): Promise<readonly PluginSkillEntry[]>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PLUGIN_SKILL_PREFIX = 'local:plugin/';
export const PLUGIN_SKILL_TIMEOUT_MS = 5_000;
interface Registration {
  owner: string;
  provider: PluginSkillProvider;
  abort: AbortController;
}
const providers = new Map<string, Registration>();
const skillOwners = new WeakMap<SkillRecord, Registration>();

/** Recheck after combining concurrent source/filesystem reads, including replacements. */
export function isPluginSkillActive(skill: SkillRecord): boolean {
  const owner = skillOwners.get(skill);
  return !!owner && providers.get(`${owner.owner}/${owner.provider.id}`) === owner;
}

/** Host-only registration. Plugins receive the owner-bound ctx registration face. */
export function registerPluginSkillProvider(owner: string, provider: PluginSkillProvider): () => void {
  if (typeof owner !== 'string' || !SLUG.test(owner) || !provider
    || typeof provider.id !== 'string' || !SLUG.test(provider.id) || typeof provider.list !== 'function') {
    throw new Error('Invalid plugin skill provider');
  }
  const key = `${owner}/${provider.id}`;
  if (providers.has(key)) throw new Error(`Plugin skill provider already registered: ${key}`);
  // Snapshot identity and callable; later plugin mutation cannot change ownership.
  const registration: Registration = { owner, provider: { id: provider.id, list: provider.list.bind(provider) }, abort: new AbortController() };
  providers.set(key, registration);
  return () => {
    if (providers.get(key) !== registration) return;
    providers.delete(key);
    registration.abort.abort(new Error('Plugin skill provider revoked'));
  };
}

async function readProvider(key: string, registration: Registration, cwd?: string): Promise<SkillRecord[]> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([registration.abort.signal, deadline.signal]);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const timer = setTimeout(() => deadline.abort(new Error('Plugin skill provider timed out')), PLUGIN_SKILL_TIMEOUT_MS);
  try {
    const entries = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return registration.provider.list({ ...(cwd ? { cwd } : {}), signal });
      }),
      aborted,
    ]);
    if (signal.aborted || providers.get(key) !== registration || !Array.isArray(entries)) return [];
    const seen = new Set<string>();
    const result: SkillRecord[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !SLUG.test(entry.id) || seen.has(entry.id)
        || typeof entry.name !== 'string' || !entry.name.trim()
        || typeof entry.description !== 'string' || typeof entry.content !== 'string' || !entry.content.trim()
        || (entry.dir !== undefined && (typeof entry.dir !== 'string' || !path.isAbsolute(entry.dir)))) continue;
      seen.add(entry.id);
      const skill = {
        id: `${PLUGIN_SKILL_PREFIX}${key}/${entry.id}`, app_id: 'tangu', name: entry.name.trim(),
        description: entry.description, content: entry.content, icon: null, category: 'plugin', version: null,
        author: registration.owner, tools: null, visibility: 'private', is_builtin: false,
        is_user_visible: true, is_market_listed: false, is_default_enabled: true, sort_order: 0,
        is_cross_app: false, required_apps: null, created_at: '', updated_at: '',
        source: 'plugin', origin: null, readOnly: true, sourcePluginId: registration.owner, sourceProviderId: registration.provider.id,
        ...(entry.dir === undefined ? {} : { dir: entry.dir }),
      } as SkillRecord;
      skillOwners.set(skill, registration);
      result.push(skill);
    }
    return result;
  } catch {
    // A missing/broken source is not an empty authoritative store: never write it back.
    return [];
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export async function listPluginSkills(cwd?: string): Promise<SkillRecord[]> {
  return (await Promise.all([...providers].map(([key, registration]) => readProvider(key, registration, cwd)))).flat().filter(isPluginSkillActive);
}

/** Re-read only the owning source, never a cached body or an unrelated provider. */
export async function getPluginSkill(id: string, cwd?: string): Promise<SkillRecord | null> {
  if (!id.startsWith(PLUGIN_SKILL_PREFIX)) return null;
  const parts = id.slice(PLUGIN_SKILL_PREFIX.length).split('/');
  if (parts.length !== 3 || parts.some(part => !SLUG.test(part))) return null;
  const key = `${parts[0]}/${parts[1]}`;
  const registration = providers.get(key);
  if (!registration) return null;
  return (await readProvider(key, registration, cwd)).find(skill => skill.id === id && isPluginSkillActive(skill)) ?? null;
}
