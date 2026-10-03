import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { readFile, readFileLocal } from '../src/tools/fileWorkspace.js';

const storage = vi.hoisted(() => ({ listDirectory: vi.fn(), getFileContent: vi.fn() }));
vi.mock('../src/seams/runtime.js', async (original) => ({
  ...await original<typeof import('../src/seams/runtime.js')>(),
  deps: () => ({ brain: { storage } }),
}));

let dir: string;
const md = ['# Report', '', '```forsion-instructions', 'Keep every date in ISO format.', '```', '', 'Report body.', 'Last line.'].join('\n');
const structured = readFileSync(new URL('./fixtures/page-instructions/amadeus-structure-mixed.md', import.meta.url), 'utf8');
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tangu-page-instructions-'));
  writeFileSync(join(dir, 'report.md'), md);
  writeFileSync(join(dir, 'other.md'), '# Other page\nUnrelated body.');
  writeFileSync(join(dir, 'example.txt'), md);
  writeFileSync(join(dir, 'structured.md'), structured);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('page Instructions reach actual file tools before pagination', () => {
  it('host read_file includes the instruction even when the requested window excludes its block', async () => {
    const out = await HOST_TOOLS.read_file.execute({ path: 'report.md', offset: 6, limit: 1 }, { cwd: dir } as any);
    expect(out).toContain('Keep every date in ISO format.');
    expect(out).toContain(JSON.stringify(join(dir, 'report.md')));
    expect(out).toMatch(/7\tReport body\./);
    expect(out).not.toMatch(/4\tKeep every date/);
    expect(out.lastIndexOf('Cite for the user:')).toBeGreaterThan(out.indexOf('Report body.'));
  });

  it('host read_file does not carry prior-page instructions into the next read or activate a text file', async () => {
    const ctx = { cwd: dir } as any;
    await HOST_TOOLS.read_file.execute({ path: 'report.md', offset: 6, limit: 1 }, ctx);
    const other = await HOST_TOOLS.read_file.execute({ path: 'other.md' }, ctx);
    expect(other).not.toContain('Page maintenance instructions');
    expect(other).not.toContain('ISO format');
    expect(await HOST_TOOLS.read_file.execute({ path: 'example.txt', offset: 6, limit: 1 }, ctx)).not.toContain('ISO format');
  });

  it('host pagination includes only actual root instructions from a serialized structured document', async () => {
    const offset = structured.split('\n').indexOf('COLUMN HIDDEN');
    const out = await HOST_TOOLS.read_file.execute({ path: 'structured.md', offset, limit: 1 }, { cwd: dir } as any);
    const context = out.split('End of page maintenance instructions.')[0];
    expect(context).toContain('ROOT BEFORE\\n\\nROOT MIDDLE\\n\\nROOT AFTER');
    expect(context).not.toContain('CARD HIDDEN');
    expect(context).not.toContain('COLUMN HIDDEN');
    // Nested text remains readable document data, not promoted maintenance guidance.
    expect(out).toContain(`${offset + 1}\tCOLUMN HIDDEN`);
  });

  it('local sandbox read_file preserves the instruction and original body line number', async () => {
    const out = await readFileLocal(dir, '/report.md', 6, 1);
    expect(out).toContain('Keep every date in ISO format.');
    expect(out).toContain('Page maintenance instructions for "/report.md"');
    expect(out).toMatch(/7\tReport body\./);
    expect(await readFileLocal(dir, '/other.md')).not.toContain('Page maintenance instructions');
  });

  it('cloud workspace read_file extracts from the returned full file before slicing', async () => {
    storage.listDirectory.mockResolvedValueOnce([{ id: 'w', name: 'workspace', fileType: 'directory' }]);
    storage.listDirectory.mockResolvedValueOnce([{ id: 's', name: 'session', fileType: 'directory' }]);
    storage.listDirectory.mockResolvedValueOnce([{ id: 'f', name: 'report.md', fileType: 'file' }]);
    storage.getFileContent.mockResolvedValueOnce({ content: Buffer.from(md) });
    const out = await readFile('u', 'app', { sessionId: 'session' }, '/report.md', 6, 1);
    expect(out).toContain('Keep every date in ISO format.');
    expect(out).toContain('Page maintenance instructions for "/report.md"');
    expect(out).toMatch(/7\tReport body\./);
    expect(storage.getFileContent).toHaveBeenCalledWith('f', 'u');
  });
});
