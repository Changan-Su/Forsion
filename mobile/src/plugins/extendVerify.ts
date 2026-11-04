/** Runtime check for npm copies of Forsion Extend on Android (coreUpdates.ts): same rules as the build-time
 *  check (desktop/shared/extendSignature.ts), with WebCrypto SHA-256 and pure-JS ed25519. */
import { verifyAsync } from '@noble/ed25519'
import bundles from '../../../desktop/electron/builtinBundles.json'
import type { InstalledPluginManifest } from '../../../desktop/shared/amadeus/pluginSource'
import { assertMobileExtendManifest, verifyExtendFiles, type SignatureCrypto } from '../../../desktop/shared/extendSignature'

export const SIGNING_KEY = bundles.find((b) => b.id === 'forsion-extend')!.desktop!.signingKey
/** SPKI DER of an ed25519 key = this 12-byte prefix + the 32-byte raw key. */
const ED25519_SPKI_PREFIX = '302a300506032b6570032100'

/** Same check on every Android version: WebCrypto Ed25519 needs WebView 137+, so ed25519 is pure JS (noble); SHA-* uses WebCrypto. */
export const webSignatureCrypto: SignatureCrypto = {
  async sha256Hex(data) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
  },
  async verify(message, signature, pem) {
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0))
    const hex = Array.from(der.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
    if (der.length !== 44 || hex !== ED25519_SPKI_PREFIX) throw new Error('not an ed25519 SPKI key')
    return verifyAsync(signature, message, der.subarray(12))
  },
}

/** coreUpdates gate for npm copies: pinned-key signature (unsigned files dropped) + mobile host contract. */
export async function verifyMobileExtend(files: Map<string, Uint8Array>, key = SIGNING_KEY): Promise<void> {
  await verifyExtendFiles(files, key, webSignatureCrypto)
  const raw = files.get('manifest.json')
  assertMobileExtendManifest(raw ? JSON.parse(new TextDecoder().decode(raw)) : null)
}

/** A verified snapshot → the same shape the build-time virtual module gives (manifest, code, docs, Space recipes).
 *  The host renders Extend from these bytes only; the copy on disk is never read again after verification. */
export function extendFromVerifiedFiles(files: ReadonlyMap<string, Uint8Array>) {
  const decoder = new TextDecoder()
  const read = (p: string): string => { const b = files.get(p); return b ? decoder.decode(b) : '' }
  const manifest = JSON.parse(read('manifest.json')) as InstalledPluginManifest & { id: string; main: string }
  const recipes = [...files.keys()].filter((p) => /^spaces\/[^/]+\/space\.json$/.test(p)).map((p) => ({ slug: p.split('/')[1], json: read(p), plugin: manifest.id }))
  return { manifest, code: read(manifest.main), readme: read('README.md'), changelog: read('CHANGELOG.md'), recipes }
}
