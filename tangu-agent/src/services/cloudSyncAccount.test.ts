import { describe, expect, it } from 'vitest';
import { agentSyncScope, registerAgentSyncIdentity } from './cloudSyncAccount.js';
import type { AgentFilesBrain } from '../seams/cloudBrain.js';

const token = (userId: string, jti: string): string => `header.${Buffer.from(JSON.stringify({ userId, jti })).toString('base64url')}.signature`;
const adapter = (origin: string, bearer: string): AgentFilesBrain => {
  const cloud = {} as AgentFilesBrain;
  registerAgentSyncIdentity(cloud, origin, bearer);
  return cloud;
};

describe('cloud sync account identity', () => {
  it('uses the actual cloud user instead of the common local host user', () => {
    const a = agentSyncScope(adapter('https://cloud.test', token('a', '1')), 'local');
    const b = agentSyncScope(adapter('https://cloud.test', token('b', '1')), 'local');
    expect(a).not.toBe(b);
    expect(a).toBe(agentSyncScope(adapter('https://cloud.test/', token('a', '2')), 'local'));
    expect(a).not.toBe(agentSyncScope(adapter('https://other.test', token('a', '2')), 'local'));
  });

  it('keeps same-host backend prefixes separate and does not adopt legacy origin-only state', () => {
    const root = agentSyncScope(adapter('https://cloud.test', token('a', '1')), 'local');
    const one = agentSyncScope(adapter('https://cloud.test/one', token('a', '1')), 'local');
    const two = agentSyncScope(adapter('https://cloud.test/two', token('a', '1')), 'local');
    expect(one).not.toBe(root);
    expect(one).not.toBe(two);
    expect(one).toBe(agentSyncScope(adapter('https://cloud.test/one/', token('a', 'renewed')), 'local'));
  });

  it('does not authorize cloud uploads with the local fallback bearer or an unknown identity', () => {
    expect(agentSyncScope(adapter('https://cloud.test', 'local-fallback'), 'local')).toBeNull();
  });
});
