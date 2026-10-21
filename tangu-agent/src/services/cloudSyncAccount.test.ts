import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSyncConsentSignal, setContentSyncOwner, agentSyncDefault, agentSyncPermission, agentSyncScope, captureAgentSyncPermission, registerAgentSyncIdentity, setAgentSyncDefault, setAgentSyncPermission } from './cloudSyncAccount.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
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

describe('account-level agent sync switch', () => {
  let home = ''; let prev: string | undefined;
  const scope = 'a'.repeat(64); const other = 'b'.repeat(64);
  beforeEach(() => { prev = process.env.TANGU_HOME; home = mkdtempSync(join(tmpdir(), 'tangu-sync-default-')); process.env.TANGU_HOME = home; });
  afterEach(() => { if (prev === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev; rmSync(home, { recursive: true, force: true }); });

  it('hands legacy writers to folder rules and restores their previous switch on rollback',()=>{
    setAgentSyncDefault(scope,true);setAgentSyncPermission('coder',scope,true);setContentSyncOwner(scope,true)
    expect(agentSyncDefault(scope)).toBe(false);expect(agentSyncPermission('coder',scope).enabled).toBe(false)
    expect(()=>setAgentSyncDefault(scope,true)).toThrow('Folder rules')
    setContentSyncOwner(scope,false);expect(agentSyncDefault(scope)).toBe(true);expect(agentSyncPermission('coder',scope).enabled).toBe(true)
  })

  it('is undecided by default and then lets agents without their own choice follow it', () => {
    expect(agentSyncDefault(scope)).toBeNull();
    expect(agentSyncPermission('coder', scope).enabled).toBe(false);
    setAgentSyncDefault(scope, true);
    expect(agentSyncDefault(scope)).toBe(true);
    expect(agentSyncPermission('coder', scope)).toMatchObject({ enabled: true, shared: false });
    // the default agent's memory is shared so Brain memory sync runs too
    expect(agentSyncPermission(DEFAULT_AGENT_SLUG, scope)).toMatchObject({ enabled: true, shared: true });
    // per account: another account on this computer is not affected
    expect(agentSyncPermission('coder', other).enabled).toBe(false);
  });

  it('off stops every agent; individual opt-outs survive; turning one on afterwards sticks', () => {
    setAgentSyncPermission('quiet', scope, false);
    setAgentSyncPermission('loud', scope, true);
    setAgentSyncDefault(scope, true);
    expect(agentSyncPermission('quiet', scope).enabled).toBe(false);
    setAgentSyncDefault(scope, false);
    expect(agentSyncPermission('loud', scope).enabled).toBe(false);
    expect(agentSyncPermission('coder', scope).enabled).toBe(false);
    // the per-agent switch in agent settings no longer snaps back while the account switch is off
    setAgentSyncPermission('coder', scope, true);
    expect(agentSyncPermission('coder', scope).enabled).toBe(true);
    expect(agentSyncPermission('loud', scope).enabled).toBe(false);
    // back on: loud follows the account switch again, quiet stays opted out
    setAgentSyncDefault(scope, true);
    expect(agentSyncPermission('loud', scope).enabled).toBe(true);
    expect(agentSyncPermission('quiet', scope).enabled).toBe(false);
  });

  it('off then on keeps whether each agent shares memory', () => {
    setAgentSyncPermission(DEFAULT_AGENT_SLUG, scope, true, false);
    setAgentSyncPermission('sharer', scope, true, true);
    setAgentSyncDefault(scope, false);
    setAgentSyncDefault(scope, true);
    expect(agentSyncPermission(DEFAULT_AGENT_SLUG, scope)).toMatchObject({ enabled: true, shared: false });
    expect(agentSyncPermission('sharer', scope)).toMatchObject({ enabled: true, shared: true });
  });

  it('a busy agent folder makes turning off fail instead of reporting off while it keeps uploading', () => {
    setAgentSyncPermission('loud', scope, true);
    setAgentSyncDefault(scope, true);
    writeFileSync(join(home, 'agents', 'loud', '.memory.lock'), '{}');
    expect(() => setAgentSyncDefault(scope, false)).toThrow();
    expect(agentSyncDefault(scope)).toBe(true);
    expect(agentSyncPermission('loud', scope).enabled).toBe(true);
  });

  it('off works before any agent folder exists', () => {
    expect(() => setAgentSyncDefault(scope, false)).not.toThrow();
    expect(agentSyncDefault(scope)).toBe(false);
  });

  it('turning off aborts an in-flight capture of an individually enabled agent', () => {
    setAgentSyncPermission('loud', scope, true);
    const check = captureAgentSyncPermission('loud', scope);
    setAgentSyncDefault(scope, false);
    expect(check).toThrow('agent sync consent');
  });

  it('invalidates captured consent when the account switch changes', () => {
    setAgentSyncDefault(scope, true);
    const check = captureAgentSyncPermission('coder', scope);
    const signal = agentSyncConsentSignal('coder', scope);
    setAgentSyncDefault(scope, true);
    expect(check).toThrow('agent sync consent changed');
    expect(signal.aborted).toBe(true);
  });
});
