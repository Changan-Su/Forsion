/**
 * Model tickets for multi-account mode (TANGU_MULTI_ACCOUNT=1, standalone/multiAccount.ts).
 *
 * Nobody owns a multi-account engine, so it has no process credential for model calls. The host that verified a visitor's
 * sign-in gets a short-lived model ticket for that visitor from the server and sends it with the visitor's requests
 * (X-Forsion-Model-Ticket, read only on requests that already passed the host credential check). The engine keeps the
 * newest ticket per account and uses it as that account's credential for every server model call (llm and models; speech
 * recognition goes through the same credential). The engine does not verify the ticket — the server does — but it drops one
 * whose userId is not the account the host named.
 *
 * The newest ticket (latest exp) wins; one the server refuses (401) is forgotten, so the next one the host sends is taken
 * even if it expires sooner (another sign-in of the same person, or a re-issued ticket after a rotation).
 *
 * Fails closed: no account in context, no ticket, or an expired ticket → LlmError 401 with a plain English message, and
 * nothing is sent. Never another account's ticket, never the process token (TANGU_TOKEN / --token / the engine .env).
 * Tickets live only in the map below: not in plugin script environments, not in log lines, not in run events.
 */
import { LlmError } from '../core/types.js';
import { currentAccountId, isValidAccountId } from '../core/accountScope.js';
import { createHttpBrain } from '../adapters/standalone/httpBrain.js';
import type { CloudBrainServices } from '../seams/cloudBrain.js';

export const MODEL_TICKET_HEADER = 'x-forsion-model-ticket';
/** Shown to the model / user when an account has no usable ticket. */
export const NO_MODEL_TICKET = 'No model ticket for this account; sign in again';
export const NO_ACCOUNT_FOR_MODEL_CALL = 'No account for this model call; sign in again';
export const NO_MODEL_SERVER = 'This engine has no model server configured';

/** A ticket this close to its expiry is not sent: the server would see it expire mid-request. */
const EXPIRY_MARGIN_MS = 5_000;
const TICKET_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const tickets = new Map<string, { raw: string; expMs: number }>();
const warnedAccounts = new Set<string>();
let warnedMalformed = false;

/** The claims the engine reads from a ticket (payload decoded, signature not checked). null = not a model ticket. */
export function modelTicketClaims(raw: unknown): { userId: string; expMs: number } | null {
  if (typeof raw !== 'string' || raw.length > 8192 || !TICKET_SHAPE.test(raw)) return null;
  let p: any;
  try { p = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.scope !== 'model-ticket') return null;
  const userId = typeof p.userId === 'string' || typeof p.userId === 'number' ? String(p.userId) : '';
  if (!userId || typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null;
  return { userId, expMs: p.exp * 1000 };
}

export type ModelTicketVerdict = 'stored' | 'older' | 'expired' | 'invalid' | 'other-account';

/** Keep `raw` as `accountId`'s ticket if it is a model ticket for that account and expires later than the one kept. */
export function acceptModelTicket(accountId: string, raw: unknown, now = Date.now()): ModelTicketVerdict {
  if (!isValidAccountId(accountId)) return 'invalid';
  const claims = modelTicketClaims(raw);
  if (!claims) return 'invalid';
  if (claims.userId !== accountId) return 'other-account';
  if (claims.expMs <= now) return 'expired';
  const kept = tickets.get(accountId);
  if (kept && kept.expMs >= claims.expMs) return 'older';
  if (!kept && tickets.size >= 1000) for (const [id, t] of tickets) if (t.expMs <= now) tickets.delete(id);
  tickets.set(accountId, { raw: raw as string, expMs: claims.expMs });
  return 'stored';
}

/** The server refused `raw`: forget it (only if it is still the one kept for the account). */
export function forgetModelTicket(accountId: string, raw: string): boolean {
  if (tickets.get(accountId)?.raw !== raw) return false;
  tickets.delete(accountId);
  return true;
}

/**
 * Request middleware step (after the host credential and X-Forsion-User were checked): take the ticket header off the
 * request — header and raw header list, so no handler, log or event can see it — and keep it for that account.
 */
export function takeModelTicket(req: { headers: Record<string, unknown>; rawHeaders?: string[] }, accountId: string): void {
  const raw = req.headers[MODEL_TICKET_HEADER];
  delete req.headers[MODEL_TICKET_HEADER];
  const rh = req.rawHeaders;
  if (Array.isArray(rh)) for (let i = rh.length - 2; i >= 0; i -= 2) if (String(rh[i]).toLowerCase() === MODEL_TICKET_HEADER) rh.splice(i, 2);
  if (raw === undefined) return;
  const verdict = acceptModelTicket(accountId, raw);
  if (verdict === 'other-account' && !warnedAccounts.has(accountId)) {
    if (warnedAccounts.size > 1000) warnedAccounts.clear();
    warnedAccounts.add(accountId);
    console.warn(`[tangu] multi-account: dropped a model ticket that was not issued for account ${accountId}`);
  } else if (verdict === 'invalid' && !warnedMalformed) {
    warnedMalformed = true;
    console.warn('[tangu] multi-account: dropped a malformed model ticket');
  }
}

/** The current account's ticket, or a 401 LlmError (no account in context / no ticket / expired). */
export function currentModelTicket(now = Date.now()): string {
  const id = currentAccountId();
  if (!id) throw new LlmError(401, NO_ACCOUNT_FOR_MODEL_CALL);
  const kept = tickets.get(id);
  if (!kept || kept.expMs - now <= EXPIRY_MARGIN_MS) throw new LlmError(401, NO_MODEL_TICKET);
  return kept.raw;
}

/**
 * The server brain for multi-account mode: every request carries the current account's ticket, evaluated per request.
 * httpBrain turns errors of the two catalogue reads into an empty list; the ticket is checked before them, so a missing
 * ticket reads as an error ("sign in again") rather than as "no models configured".
 */
export function createModelTicketHttpBrain(cloudUrl: string): CloudBrainServices {
  const configured = !!cloudUrl.trim();
  const credential = (): string => {
    if (!configured) throw new LlmError(400, NO_MODEL_SERVER);
    return currentModelTicket();
  };
  const http = createHttpBrain({ cloudUrl, token: credential });
  const listForProject = http.models.listModelsForProject;
  // A 401 from the server for the ticket this call used: forget it (see the header). Our own "no ticket" errors never get here
  // with a ticket in hand.
  const forgetOnRefusal = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    const id = currentAccountId();
    let used: string | undefined;
    try { used = currentModelTicket(); } catch { /* the call itself reports it */ }
    try { return await fn(...args); } catch (e) {
      // The server's own wording ("Invalid or expired token") means nothing to the visitor: say what to do, as the next call would.
      if (id && used && e instanceof LlmError && e.status === 401) { forgetModelTicket(id, used); throw new LlmError(401, NO_MODEL_TICKET); }
      throw e;
    }
  };
  const fim = http.llm.fimCompletion;
  return {
    ...http,
    llm: {
      ...http.llm,
      resolveModelAndKey: forgetOnRefusal(http.llm.resolveModelAndKey),
      streamProviderCompletion: forgetOnRefusal(http.llm.streamProviderCompletion),
      ...(fim ? { fimCompletion: forgetOnRefusal(fim) } : {}),
    },
    models: {
      ...http.models,
      listGlobalModels: async (...args: any[]) => { credential(); return http.models.listGlobalModels(...args); },
      ...(listForProject ? { listModelsForProject: async (projectId: string) => { credential(); return listForProject(projectId); } } : {}),
    },
  };
}

/** Tests only. */
export function __resetModelTicketsForTests(): void {
  tickets.clear();
  warnedAccounts.clear();
  warnedMalformed = false;
}
