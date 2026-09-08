/** Hosts may scope content-bearing layouts before loading the workspace modules.
 * Desktop's local workspace leaves this unset. Browser/mobile supply the signed-in account.
 * Each workspace module captures its keys once: an old window can only save to its own scope. */
let scope: string | undefined

export function setContentStorageScope(value: string): void { scope = value }

export function contentStorageKey(base: string): string {
  return scope ? `${base}:account:${encodeURIComponent(scope)}` : base
}
