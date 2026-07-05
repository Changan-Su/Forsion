import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgentFilesSync } from './agentFileSync.js';
import type { AgentFileContent, AgentFileMeta, AgentFilesBrain } from '../seams/cloudBrain.js';

const slug = 'cloud-only';
const config = 'name = "Cloud Only"\ncloud_sync = true\nlibrary_order = ["reference.md"]\n';
const contents: Record<string, AgentFileContent> = {
  'config.toml': { content: config, isBinary: false, mtimeMs: 1000, deleted: false },
  'SOUL.md': { content: '云端人格', isBinary: false, mtimeMs: 1001, deleted: false },
  'Library/reference.md': { content: '# 云端资料\n已同步', isBinary: false, mtimeMs: 1002, deleted: false },
};
const metas: AgentFileMeta[] = Object.entries(contents).map(([relPath, f]) => ({
  relPath,
  mtimeMs: f.mtimeMs,
  size: Buffer.byteLength(f.content || ''),
  isBinary: f.isBinary,
  deleted: f.deleted,
}));

let home = '';
let previousHome: string | undefined;

beforeAll(() => {
  previousHome = process.env.TANGU_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'tangu-agent-file-sync-'));
  process.env.TANGU_HOME = home;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('runAgentFilesSync cloud-only bootstrap', () => {
  it('discovers cloud_sync agent from manifest and pulls its Library', async () => {
    const cloud: AgentFilesBrain = {
      getManifest: async () => [{ slug, files: metas }],
      getFile: async (_userId, gotSlug, relPath) => gotSlug === slug ? contents[relPath] || null : null,
      putFile: async (_userId, _slug, _relPath, body) => ({ mtimeMs: body.mtimeMs }),
      deleteFile: async () => {},
    };

    const result = await runAgentFilesSync(cloud, 'user-1', { onlySlug: slug });

    expect(result.ok).toBe(true);
    expect(result.agents).toBe(1);
    expect(result.pulled).toBe(3);
    expect(readFileSync(path.join(home, 'agents', slug, 'config.toml'), 'utf8')).toBe(config);
    expect(readFileSync(path.join(home, 'agents', slug, 'Library', 'reference.md'), 'utf8')).toContain('已同步');
  });
});
