/** Internal desktop coordination; intentionally absent from the plugin Tangu API. */
export type DocumentTaskClaim =
  | { state: 'claimed'; token: string }
  | { state: 'busy' }
  | { state: 'conflict' }
  | { state: 'linked'; sessionId: string }

export interface DocumentTaskClaimsApi {
  claim(key: string, signature: string): Promise<DocumentTaskClaim>
  complete(key: string, token: string, sessionId: string): Promise<void>
  release(key: string, token: string): Promise<void>
}
