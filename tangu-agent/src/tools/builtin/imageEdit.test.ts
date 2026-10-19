import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editInputs, makeImageEditTool } from './imageEdit.js';
import { configureTangu } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIxoAAAAASUVORK5CYII=';
const input = { url: `data:image/png;base64,${png}` };
const edit = vi.fn(), displayFile = vi.fn();
const pick = vi.fn(async () => ({ id: 'default-image' }));
const tool = makeImageEditTool(pick);
const ctx = () => ({ appId: 'tangu', displayFile, getImageInputs: () => [input], execMode: 'sandbox' as const }) as any;
beforeEach(() => {
  vi.clearAllMocks();
  edit.mockResolvedValue({ images: [{ b64: png, mime: 'image/png' }] });
  configureTangu({ host: {} as any, billing: {} as any, brain: { images: { edit } } as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
});
describe('edit_image attachment boundary', () => {
  it('rejects remote URLs, file paths, malformed bytes, missing and duplicate references before any upload', () => {
    for (const url of ['https://example.com/image.png', 'file:///private/a.png', 'data:image/png;base64,aGVsbG8=']) expect(() => editInputs([{ url }])).toThrow();
    for (const indices of [[], [0], [2], [1, 1], [1.5]]) expect(() => editInputs([input], indices)).toThrow();
    expect(() => editInputs([])).toThrow();
  });
  it('preserves the requested source order and format', () => {
    const webp = { url: `data:image/webp;base64,${Buffer.from('RIFF0000WEBP').toString('base64')}` };
    expect(editInputs([input, webp], [2, 1]).map(i => i.mime)).toEqual(['image/webp', 'image/png']);
  });
  it('uploads current attachments and emits the actual output through the native display seam', async () => {
    const result = await tool.execute({ prompt: 'Change the background to blue', transparent_background: true, n: 2 }, ctx());
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ images: [{ mime: 'image/png', b64: png }], model: 'default-image', n: 2, transparentBackground: true }));
    expect(displayFile).toHaveBeenCalledWith(expect.objectContaining({ dataUrl: input.url, mime: 'image/png' }));
    expect(result).toContain('Edited 1 image');
  });
  it('only uses images the loop exposes: never scans working messages, paths or URLs', async () => {
    const context = { ...ctx(), getImageInputs: undefined, getWorkingMessages: () => [{ role: 'user', content: [{ type: 'image_url', image_url: input }] }] };
    expect(await tool.execute({ prompt: 'Edit', image_indices: [1, 2] }, context)).toMatch(/^Error: No source images are available/);
    for (const ref of ['/Users/me/Pictures/private.png', 'generated/edit-1.png', 'https://example.com/a.png', '../a.png'])
      expect(await tool.execute({ prompt: 'Edit', previous_outputs: [ref] }, { ...ctx(), listDisplayFiles: async () => [] })).toMatch(/not paths or URLs/);
    expect(edit).not.toHaveBeenCalled(); expect(displayFile).not.toHaveBeenCalled();
  });
  it('says when the visible images came from an earlier message', async () => {
    const result = await tool.execute({ prompt: 'Merge' }, { ...ctx(), getImageInputsSentAt: () => Date.now() - 3 * 60_000 });
    expect(result).toContain("1 image(s) from the user's message 3 minutes ago");
    expect(result).toContain("mentions you used the images from the user's earlier message");
    expect(await tool.execute({ prompt: 'Merge' }, ctx())).toContain('using 1 attached image(s)');
  });
  it('edits its own earlier outputs by file name, without pulling in the visible attachments', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-image-outputs-'));
    fs.writeFileSync(path.join(dir, 'gen.png'), Buffer.from(png, 'base64'));
    const files = [
      { name: 'edit-a.png', mime: 'image/png', dataUrl: input.url, source: 'edit_image' },
      { name: '1760.png', mime: 'image/png', path: path.join(dir, 'gen.png'), source: 'generate_image' },
    ];
    const result = await tool.execute({ prompt: 'Beach background', previous_outputs: ['1760.png', 'edit-a.png'] }, { ...ctx(), listDisplayFiles: async () => files });
    expect(edit.mock.calls[0][0].images).toEqual([{ mime: 'image/png', b64: png }, { mime: 'image/png', b64: png }]); // 只有两张产出,附件没被默认带上
    expect(result).toContain('using 1760.png and edit-a.png');
    expect(displayFile).toHaveBeenCalledWith(expect.objectContaining({ source: 'edit_image' }));
    expect(result).toMatch(/saved as edit-[0-9a-f-]+\.png; to edit one again, pass its file name in previous_outputs/);
  });
  it('only accepts outputs that image tools produced', async () => {
    const shown = [{ name: 'private.png', mime: 'image/png', dataUrl: input.url }]; // display_file 展示过的本机文件:没有 source
    expect(await tool.execute({ prompt: 'Edit', previous_outputs: ['private.png'] }, { ...ctx(), listDisplayFiles: async () => shown })).toMatch(/not an image generated in this conversation/);
    expect(await tool.execute({ prompt: 'Edit', previous_outputs: ['edit-x.png'] }, { ...ctx(), listDisplayFiles: undefined })).toMatch(/not an image generated in this conversation/);
    expect(edit).not.toHaveBeenCalled();
  });
  it('prefers the session model and propagates cancellation without displaying a late result', async () => {
    const ac = new AbortController();
    edit.mockImplementationOnce(async () => { ac.abort(); return { images: [{ b64: png, mime: 'image/png' }] }; });
    await expect(tool.execute({ prompt: 'Edit' }, { ...ctx(), signal: ac.signal, imageModelId: 'session-image' })).rejects.toThrow();
    expect(edit.mock.calls[0][0].model).toBe('session-image'); expect(pick).not.toHaveBeenCalled(); expect(displayFile).not.toHaveBeenCalled();
  });
  it('reports upstream failure without inventing a result', async () => {
    edit.mockRejectedValueOnce(new Error('provider unavailable'));
    expect(await tool.execute({ prompt: 'Edit' }, ctx())).toContain('Error: provider unavailable');
    expect(displayFile).not.toHaveBeenCalled();
  });
});
