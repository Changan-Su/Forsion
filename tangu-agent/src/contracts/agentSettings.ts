/** Shared, browser-safe opt-in contract. No access to plugin storage is implied. */
export type AgentSettingValue = string | number | boolean | null;
export interface AgentSettingField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'secret';
  description: string;
  scope?: 'device' | 'account' | 'workspace';
}
export interface AgentSettingsReadContext {
  userId?: string;
  workspaceId?: string;
  signal?: AbortSignal;
  keys: readonly string[];
}
export interface AgentSettingsContribution {
  fields: readonly AgentSettingField[];
  /** Return current effective values for declared keys only. A secret MUST return a boolean configured flag. */
  read(context: AgentSettingsReadContext): Record<string, AgentSettingValue> | Promise<Record<string, AgentSettingValue>>;
}
export interface AgentSettingsOwner { id: string; name: string; version: string }
export interface AgentSettingResult extends AgentSettingField { value?: AgentSettingValue; configured?: boolean; unavailable?: boolean }
export interface AgentSettingsReport {
  kind: 'plugin_settings';
  source: 'ui' | 'engine';
  plugin?: AgentSettingsOwner;
  plugins?: AgentSettingsOwner[];
  fields?: AgentSettingResult[];
  error?: 'not_exposed' | 'unavailable' | 'invalid_keys' | 'too_large';
}
export const AGENT_SETTINGS_COMMAND = 'core:read-plugin-settings';
export const AGENT_SETTINGS_RESULT_MAX = 7400;

/** One registry per runtime. Revocation and replacement invalidate in-flight reads too. */
export function createAgentSettingsRegistry(source: 'ui' | 'engine') {
  type Entry = { owner: AgentSettingsOwner; fields: AgentSettingField[]; read: AgentSettingsContribution['read'] };
  const entries = new Map<string, Entry>();
  const error = (code: AgentSettingsReport['error']): AgentSettingsReport => ({ kind: 'plugin_settings', source, error: code });
  return {
    hasAny: () => entries.size > 0,
    register(owner: AgentSettingsOwner, def: AgentSettingsContribution): () => void {
      if (!def || typeof def.read !== 'function' || !Array.isArray(def.fields) || def.fields.length > 64) throw new TypeError('Invalid Agent settings contribution');
      const seen = new Set<string>();
      const fields = def.fields.map((f) => {
        if (!f || !/^[a-zA-Z][\w.-]{0,63}$/.test(f.key) || seen.has(f.key)
          || !['string', 'number', 'boolean', 'secret'].includes(f.type)
          || typeof f.description !== 'string' || f.description.length > 240
          || (f.scope !== undefined && !['device', 'account', 'workspace'].includes(f.scope))) throw new TypeError('Invalid Agent settings field');
        seen.add(f.key);
        return { key: f.key, type: f.type, description: f.description, scope: f.scope ?? 'device' };
      });
      const entry: Entry = { owner: { id: owner.id, name: owner.name.slice(0, 100), version: owner.version.slice(0, 80) }, fields, read: def.read };
      entries.set(owner.id, entry);
      return () => { if (entries.get(owner.id) === entry) entries.delete(owner.id); };
    },
    async read(pluginId?: string, keys?: readonly string[], context: Omit<AgentSettingsReadContext, 'keys'> = {}): Promise<AgentSettingsReport> {
      if (!pluginId) {
        const report: AgentSettingsReport = { kind: 'plugin_settings', source, plugins: [...entries.values()].map((e) => ({ ...e.owner })) };
        return JSON.stringify(report).length <= AGENT_SETTINGS_RESULT_MAX ? report : error('too_large');
      }
      const entry = entries.get(pluginId);
      if (!entry) return error('not_exposed');
      if (keys !== undefined && (!Array.isArray(keys) || keys.length > 64 || keys.some((k) => typeof k !== 'string' || !entry.fields.some((f) => f.key === k)))) return error('invalid_keys');
      const fields = entry.fields.filter((f) => !keys || keys.includes(f.key));
      let values: Record<string, AgentSettingValue>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        if (context.signal?.aborted) return error('unavailable');
        values = await Promise.race([
          Promise.resolve().then(() => entry.read({ ...context, keys: fields.map((f) => f.key) })),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 3000);
            abort = () => reject(new Error('aborted'));
            context.signal?.addEventListener('abort', abort, { once: true });
          }),
        ]);
      } catch { return error('unavailable'); }
      finally { clearTimeout(timer); if (abort) context.signal?.removeEventListener('abort', abort); }
      if (entries.get(pluginId) !== entry || context.signal?.aborted || !values || typeof values !== 'object') return error('unavailable');
      try {
      const result: AgentSettingsReport = { kind: 'plugin_settings', source, plugin: { ...entry.owner }, fields: fields.map((f) => {
        // Only own, declared keys leave the provider. Secret values are never stringified, even on an invalid return.
        const v = Object.getOwnPropertyDescriptor(values, f.key)?.value;
        if (f.type === 'secret') return { ...f, ...(typeof v === 'boolean' ? { configured: v } : { unavailable: true }) };
        const valid = v === null || (typeof v === f.type && (typeof v !== 'number' || Number.isFinite(v)));
        return { ...f, ...(valid ? { value: v } : { unavailable: true }) };
      }) };
      return JSON.stringify(result).length <= AGENT_SETTINGS_RESULT_MAX ? result : error('too_large');
      } catch { return error('unavailable'); }
    },
  };
}
