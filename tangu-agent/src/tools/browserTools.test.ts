import { afterEach, describe, expect, it } from 'vitest';
import { createTanguProfile } from '../profiles/index.js';
import { __browserToolInternals } from './builtin/browserTools.js';
import { getToolCapabilities } from './registry.js';
import type { ToolContext } from './toolTypes.js';

describe('browser tool URL safety', () => {
  const originalAllowPrivate = process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS;

  afterEach(() => {
    if (originalAllowPrivate === undefined) delete process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS;
    else process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = originalAllowPrivate;
  });

  it('blocks private and localhost URLs by default', async () => {
    delete process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS;

    await expect(__browserToolInternals.validateUrl('http://127.0.0.1:8787')).rejects.toThrow(/Private|reserved/i);
    await expect(__browserToolInternals.validateUrl('http://localhost:8787')).rejects.toThrow(/Localhost/i);
    await expect(__browserToolInternals.validateUrl('file:///tmp/x')).rejects.toThrow(/Only http and https/i);
  });

  it('allows private http URLs only when explicitly enabled', async () => {
    process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1';

    await expect(__browserToolInternals.validateUrl('http://127.0.0.1:8787/path')).resolves.toBe('http://127.0.0.1:8787/path');
    await expect(__browserToolInternals.validateUrl('file:///tmp/x')).rejects.toThrow(/Only http and https/i);
  });
});

describe('tool capability metadata', () => {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  const ctx: ToolContext = {
    userId: 'u1',
    sessionId: 's1',
    appId: profile.appId,
    profile,
    execMode: 'host',
    approvalMode: 'auto-edit',
  };

  it('marks read-only tools parallel and browser tools serial', () => {
    expect(getToolCapabilities('get_datetime', ctx)).toMatchObject({ sideEffect: 'none', parallel: true });
    expect(getToolCapabilities('read_file', ctx)).toMatchObject({ sideEffect: 'read', parallel: true });
    expect(getToolCapabilities('browser_search', ctx)).toMatchObject({ sideEffect: 'browser', parallel: false, concurrencyKey: 'browser' });
  });

  it('keeps unknown external tools serial by default', () => {
    expect(getToolCapabilities('mcp__server__tool', ctx)).toMatchObject({ sideEffect: 'unknown', parallel: false });
  });
});
