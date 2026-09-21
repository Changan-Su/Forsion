import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('never uses prior conversation images when the current run has no attachments', async () => {
    const context = { ...ctx(), getImageInputs: undefined, getWorkingMessages: () => [{ role: 'user', content: [{ type: 'image_url', image_url: input }] }] };
    expect(await tool.execute({ prompt: 'Edit' }, context)).toMatch(/^Error:/);
    expect(edit).not.toHaveBeenCalled(); expect(displayFile).not.toHaveBeenCalled();
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
