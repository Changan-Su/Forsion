import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceMetas, readWorkspaceFileRaw } from '../src/tools/fileWorkspace.js';

const storage = vi.hoisted(() => ({ listDirectory: vi.fn(), getFileContent: vi.fn() }));
vi.mock('../src/seams/runtime.js', () => ({ deps: () => ({ brain: { storage } }) }));
afterEach(() => vi.resetAllMocks());

function directoryChain(): void {
  storage.listDirectory.mockResolvedValueOnce([{ id: 'workspace', name: 'workspace', fileType: 'directory' }]);
  storage.listDirectory.mockResolvedValueOnce([{ id: 'session', name: 's', fileType: 'directory' }]);
}

describe('cloud search read cancellation', () => {
  it('does not start any RPC for an already cancelled lookup', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(listWorkspaceMetas('u', 'a', { sessionId: 's' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(readWorkspaceFileRaw('u', 'a', { sessionId: 's' }, 'f', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(storage.listDirectory).not.toHaveBeenCalled();
  });

  it('stops directory recursion immediately and ignores late read results', async () => {
    directoryChain();
    let complete!: (value: unknown[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    storage.listDirectory.mockImplementationOnce(() => {
      started();
      return new Promise(resolve => { complete = resolve; });
    });
    const controller = new AbortController();
    const operation = listWorkspaceMetas('u', 'a', { sessionId: 's' }, controller.signal);
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    controller.abort();
    await rejected;
    complete([{ id: 'late', name: 'late', fileType: 'directory' }]);
    await new Promise(resolve => setImmediate(resolve));
    expect(storage.listDirectory).toHaveBeenCalledTimes(3);
  });

  it('returns on cancellation even when a issued read has no transport signal', async () => {
    directoryChain();
    storage.listDirectory.mockResolvedValueOnce([{ id: 'f', name: 'f.txt', fileType: 'file' }]);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    storage.getFileContent.mockImplementation(() => { started(); return new Promise(() => {}); });
    const controller = new AbortController();
    const operation = readWorkspaceFileRaw('u', 'a', { sessionId: 's' }, 'f.txt', controller.signal);
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    controller.abort();
    await rejected;
    expect(storage.getFileContent).toHaveBeenCalledTimes(1);
  });

  it('does not swallow an upstream AbortError into empty search results', async () => {
    const error = new Error('transport cancelled'); error.name = 'AbortError';
    storage.listDirectory.mockRejectedValue(error);
    await expect(listWorkspaceMetas('u', 'a', { sessionId: 's' })).rejects.toBe(error);
    await expect(readWorkspaceFileRaw('u', 'a', { sessionId: 's' }, 'f')).rejects.toBe(error);
  });
});
