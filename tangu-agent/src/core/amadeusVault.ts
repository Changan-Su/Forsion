import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AmadeusBrain, AmadeusNotes } from '../seams/cloudBrain.js';

export interface OnlineVaultRef {
  readonly kind: 'online';
  readonly account: string;
  readonly libraryId: string;
  readonly vaultId: string;
  readonly prefix: string;
  readonly name: string;
}

interface VaultSelectionSource {
  readonly managed: boolean;
  // Used only to deny stand-in access, never as an online or unknown vault's working root.
  readonly protectedRoot: string;
}

export type AmadeusVault = VaultSelectionSource & (
  | { readonly kind: 'none' }
  | { readonly kind: 'local'; readonly root: string }
  | { readonly kind: 'online'; readonly ref: OnlineVaultRef; readonly notes?: AmadeusNotes }
);

export type RunAmadeusVault = AmadeusVault & { readonly generation: string };

const goodId = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const goodSegment = (p: string): boolean => p !== '' && p !== '.' && p !== '..' && !/[\\\u0000-\u001f]/.test(p);

/** Match the desktop host's parseOnlineVaultRef. */
function parseOnlineRef(value: unknown): OnlineVaultRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { kind, account, libraryId, vaultId, prefix, name } = value as Record<string, unknown>;
  if (kind !== 'online' || typeof account !== 'string' || !/^[0-9a-f]{64}$/.test(account)) return null;
  if (!goodId(libraryId, 4096) || !goodId(vaultId, 1024) || !goodId(name, 1024) || !name.trim()) return null;
  if (typeof prefix !== 'string' || prefix.length > 1024 || !prefix.startsWith('Amadeus/') ||
      !prefix.endsWith('/') || !prefix.slice(0, -1).split('/').every(goodSegment)) return null;
  return { kind, account, libraryId, vaultId, prefix, name };
}

export function readAmadeusVault(brain?: AmadeusBrain): AmadeusVault {
  const config = process.env.FORSION_AMADEUS_CONFIG?.trim();
  const explicit = process.env.FORSION_AMADEUS_VAULT?.trim();
  const fallback = path.join(os.homedir(), 'Forsion', 'Amadeus');
  if (!config) {
    const root = explicit || fallback;
    return { kind: 'local', root, protectedRoot: root, managed: false };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(config, 'utf8'));
  } catch {
    return { kind: 'none', protectedRoot: fallback, managed: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'none', protectedRoot: fallback, managed: true };
  const { activeVault, lastVault } = raw as Record<string, unknown>;
  const root = typeof lastVault === 'string' && path.isAbsolute(lastVault.trim()) && !lastVault.includes('\0')
    ? lastVault.trim()
    : null;
  const source = { protectedRoot: root ?? fallback, managed: true };
  if (lastVault !== undefined && !root) return { ...source, kind: 'none' };
  if (activeVault != null) {
    const ref = parseOnlineRef(activeVault);
    if (!ref) return { ...source, kind: 'none' };
    if (ref.account === brain?.accountNamespace?.()) return { ...source, kind: 'online', ref };
    return root ? { ...source, kind: 'local', root } : { ...source, kind: 'none' };
  }
  // An explicit CLI root can override a known local selection, never an unreadable config or an online selection.
  const local = explicit || root;
  return local ? { kind: 'local', root: local, protectedRoot: local, managed: true } : { ...source, kind: 'none' };
}

export async function pinAmadeusVault(generation: string, brain?: AmadeusBrain, signal?: AbortSignal): Promise<RunAmadeusVault> {
  const vault = readAmadeusVault(brain);
  if (vault.kind !== 'online') return { ...vault, generation };
  // Legacy libraries share the default vault's ID. The adapter also checks the server's kind:
  // an actual default vault ID may be a UUID, just like an independent library.
  const { ref } = vault;
  const notes = ref.libraryId === ref.vaultId && ref.prefix === 'Amadeus/'
    ? await brain?.library?.(ref, ref.account, signal)
    : undefined;
  return { ...vault, generation, notes: notes ?? undefined };
}
