import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./assemble.js', () => ({ loadProviders: (c: any) => c.providers }));
vi.mock('../mcp/config.js', () => ({ loadMcpConfig: () => ({ mcpServers: {} }) }));
vi.mock('../engines/config.js', () => ({ loadEngines: () => [], loadEnginePrefs: () => ({}) }));
vi.mock('../services/specialAgentsConfig.js', () => ({ loadSpecialAgentsConfig: () => ({ historian: {}, muse: {} }) }));
vi.mock('../core/tanguHome.js', () => ({ configFile: () => '/synthetic/config.json' }));
import { printEffectiveConfig } from './diagnostics.js';
import { redactDiagnosticUrl } from '../core/util/diagnosticUrl.js';
afterEach(() => vi.restoreAllMocks());

describe('final --print-config stdout', () => {
  it.each([
    'postgresql://SYNTHETIC_USER:SYNTHETIC_PASSWORD@[::1]:5432/audit?sslmode=require',
    'postgresql://user:%53%59%4e%54%48%45%54%49%43@host/audit',
    'postgresql://host/audit?password=SYNTHETIC_PASSWORD&%61pi_key=SYNTHETIC_KEY&access_token=SYNTHETIC_TOKEN',
    'not a URL password=SYNTHETIC_PASSWORD',
  ])('never prints embedded credentials: %s', (databaseUrl) => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => { stdout += String(chunk); return true; }) as any);
    printEffectiveConfig({ databaseUrl, cloudUrl: 'https://SYNTHETIC_USER:SYNTHETIC_PASSWORD@cloud.invalid/?token=SYNTHETIC_TOKEN', token: 'SYNTHETIC_ACCOUNT_TOKEN', providers: [{ providerId: 'test', baseUrl: 'https://models.invalid/v1?api_key=SYNTHETIC_KEY#SYNTHETIC_FRAGMENT', apiKey: 'SYNTHETIC_API_KEY' }] } as any);
    expect(stdout).not.toMatch(/SYNTHETIC|%53%59%4e/);
    const parsed = JSON.parse(stdout);
    expect(parsed.cloud.url).toContain('cloud.invalid');
    expect(parsed.providers[0].baseUrl).toContain('/v1');
    if (databaseUrl.includes('[::1]')) expect(parsed.database.url).toContain('[::1]:5432/audit?sslmode=require');
  });
  it('preserves SQLite filenames and redacts encoded query keys and malformed URIs', () => {
    for (const raw of ['/data/state.db', 'C:\\Data\\state.db', 'state.sqlite', ':memory:']) expect(redactDiagnosticUrl(raw)).toBe(raw);
    expect(redactDiagnosticUrl('https://host/?%2561pi_key=SECRET')).not.toContain('SECRET');
    expect(redactDiagnosticUrl('https://user:SECRET@[')).toBe('[redacted invalid URL]');
  });
});
