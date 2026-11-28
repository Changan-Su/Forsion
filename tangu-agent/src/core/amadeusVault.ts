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
  readonly protectedRoots: readonly string[];
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

export function readAmadeusVault(accountNamespace?: () => string | null): AmadeusVault {
  const config = process.env.FORSION_AMADEUS_CONFIG?.trim();
  const explicit = process.env.FORSION_AMADEUS_VAULT?.trim();
  const fallback = path.join(os.homedir(), 'Forsion', 'Amadeus');
  if (!config) {
    const root = explicit || fallback;
    return { kind: 'local', root, protectedRoots: [root], managed: false };
  }

  const unavailable: AmadeusVault = { kind: 'none', protectedRoots: explicit ? [fallback, explicit] : [fallback], managed: true };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(config, 'utf8'));
  } catch {
    return unavailable;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable;
  const { activeVault, lastVault } = raw as Record<string, unknown>;
  const root = typeof lastVault === 'string' && path.isAbsolute(lastVault.trim()) && !lastVault.includes('\0')
    ? lastVault.trim()
    : null;
  const source = { protectedRoots: [...new Set([root ?? fallback, ...(explicit ? [explicit] : [])])], managed: true };
  if (lastVault !== undefined && !root) return { ...source, kind: 'none' };
  if (activeVault != null) {
    const ref = parseOnlineRef(activeVault);
    if (!ref) return { ...source, kind: 'none' };
    if (ref.account === accountNamespace?.()) return { ...source, kind: 'online', ref };
  }
  // An explicit CLI root can override a known local selection, never an unreadable config or an online selection.
  const local = explicit || root;
  return local ? { ...source, kind: 'local', root: local } : { ...source, kind: 'none' };
}

/** Capture the selection before the network check or any other run setup. */
export function pinAmadeusVault(generation: string, brain?: AmadeusBrain): RunAmadeusVault {
  return { ...readAmadeusVault(() => brain?.accountNamespace?.() ?? null), generation };
}

export async function verifyAmadeusNotes(vault: RunAmadeusVault, brain?: AmadeusBrain, signal?: AbortSignal): Promise<RunAmadeusVault> {
  if (vault.kind !== 'online') return vault;
  // A real default vault can have a UUID too, so the adapter also checks the server's kind.
  const { ref } = vault;
  if (ref.libraryId !== ref.vaultId || ref.prefix !== 'Amadeus/') return vault;
  try {
    const notes = await brain?.library?.(ref, ref.account, signal);
    return notes ? { ...vault, notes } : vault;
  } catch {
    return vault;
  }
}
