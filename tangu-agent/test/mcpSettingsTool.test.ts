import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { manageMcpProvider } from '../src/tools/builtin/manageMcp.js';
import { readMcpSettings, writeMcpSettings } from '../src/services/mcpSettings.js';
import { controlPlaneCall, approvalPreview } from '../src/services/approvals.js';
import { remoteManagementDenied } from '../src/services/remoteOrigin.js';

let home: string, prior: string | undefined;
const profile = createTanguProfile({ sandboxMode: 'none' });
const context: any = { userId: 'u', sessionId: 's', appId: 'tangu', profile, execMode: 'host' };
const entry = { url: 'https://user:SECRET_PASSWORD@example.test/SECRET_PATH/mcp?token=SECRET_QUERY', headers: { Authorization: 'SECRET_HEADER' }, env: { TOKEN: 'SECRET_ENV' }, enabled: false };
const current = () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
beforeEach(() => {
  prior = process.env.TANGU_HOME; home = mkdtempSync(join(tmpdir(), 'mcp-settings-')); process.env.TANGU_HOME = home;
  configureTangu({ host: {} as any, brain: {} as any, billing: {} as any, profile });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ keep: 42, mcp: { mcpServers: { existing: entry } } }));
});
afterEach(() => { if (prior === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prior; rmSync(home, { recursive: true, force: true }); });
describe('MCP management tool', () => {
  it('redacts credentials in reads and approval previews', () => {
    expect(readMcpSettings()).not.toContain('SECRET');
    const preview = approvalPreview({ id: 'a', type: 'function', function: { name: 'manage_mcp', arguments: JSON.stringify({ action: 'update', name: 'existing', config: entry }) } });
    expect(preview).not.toContain('SECRET');
    expect(preview).toContain('https://example.test');
  });
  it('writes only changed servers, preserves secrets on partial update, and validates before writing', () => {
    writeMcpSettings('add', { config: { added: { command: 'test', args: ['a b'], enabled: false } } }, () => {});
    expect(current().mcp.mcpServers.existing).toEqual(entry);
    writeMcpSettings('update', { name: 'existing', config: { timeoutMs: 2000 } }, () => {});
    expect(current()).toMatchObject({ keep: 42, mcp: { mcpServers: { existing: { ...entry, timeoutMs: 2000 } } } });
    const before = readFileSync(join(home, 'config.json'), 'utf8');
    expect(() => writeMcpSettings('add', { config: { valid: { command: 'x' }, invalid: { command: 'x', args: [1] } } }, () => {})).toThrow();
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(before);
    expect(() => writeMcpSettings('delete', { name: 'existing' }, () => { throw new Error('remote taint'); })).toThrow('remote taint');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(before);
  });
  it('uses control-plane approval only for writes and rejects remote writes', () => {
    for (const action of ['list', 'check']) { expect(controlPlaneCall('manage_mcp', { action })).toBe(false); expect(remoteManagementDenied('manage_mcp', action)).toBeNull(); }
    for (const action of ['add', 'update', 'delete', 'enable', 'disable', 'unknown']) { expect(controlPlaneCall('manage_mcp', { action })).toBe(true); expect(remoteManagementDenied('manage_mcp', action)).toBeTruthy(); }
  });
  it('is hidden from background/subagent contexts and refuses direct channel/remote writes', async () => {
    const tool = manageMcpProvider.tools()[0];
    expect(tool.isEnabledFor?.(profile, context)).toBe(true);
    for (const extra of [{ subAgentDepth: 1 }, { muse: true }, { inDiscussion: true }, { automationOrigin: {} }, { ephemeral: true }, { approvalDeferral: {} }]) expect(tool.isEnabledFor?.(profile, { ...context, ...extra })).toBe(false);
    const args = { action: 'delete', name: 'existing', reason: 'requested' };
    for (const extra of [{ runOrigin: 'channel' }, { remote: { via: 'lan', marked: false } }]) expect(await tool.execute(args, { ...context, ...extra })).toMatch(/^Error:/);
    expect(current().mcp.mcpServers.existing).toEqual(entry);
  });
});
