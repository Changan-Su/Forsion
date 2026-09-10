import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineRunCtx } from '../src/engines/manager.js';

const state = vi.hoisted(() => ({ mode: 'off', probe: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/config.js', () => ({
  configExists: () => true, loadRawConfig: () => ({ hostSandbox: { mode: state.mode, network: 'deny' } }), getRawSection: () => undefined,
}));
vi.mock('../src/engines/config.js', () => ({
  loadEngines: () => [{ id: 'test', name: 'Test', command: '/must-not-spawn' }],
  loadEnginePrefs: () => ({}), saveEngineDefaultModel: vi.fn(), engineStatus: () => 'available',
}));
vi.mock('../src/engines/acpEngine.js', () => ({ probeAcpEngine: state.probe, runAcpEngine: state.run }));
vi.mock('../src/engines/dsh.js', () => ({ seedDshFiles: vi.fn() }));
import { createEngineManager } from '../src/engines/manager.js';

beforeEach(() => { state.mode = 'off'; vi.clearAllMocks(); state.probe.mockResolvedValue({ models: [], commands: [] }); state.run.mockResolvedValue({ content: 'done' }); });
const context = (): EngineRunCtx => ({ engineId: 'test', runId: 'r', sessionId: 's', userId: 'u', message: 'hi', signal: new AbortController().signal, publish: () => {}, requestApproval: vi.fn() });

describe('external engine execution boundary', () => {
  it('refuses capability probes without requiring a caller context', async () => {
    state.mode = 'workspace-write';
    await expect(createEngineManager().capabilities('test')).rejects.toThrow('probing is unavailable');
    expect(state.probe).not.toHaveBeenCalled();
  });
  it('rejects direct/internal run calls and ignores a forged off policy in their arguments', async () => {
    state.mode = 'read-only';
    await expect(createEngineManager().run({ ...context(), hostSandbox: { mode: 'off' } } as EngineRunCtx))
      .rejects.toThrow('External engines are unavailable');
    expect(state.run).not.toHaveBeenCalled();
  });
  it('does not start an already-cancelled run even when isolation is off', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createEngineManager().run({ ...context(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.run).not.toHaveBeenCalled();
  });
  it('preserves off-mode execution and checks policy again before returning cached capabilities', async () => {
    const manager = createEngineManager();
    await expect(manager.capabilities('test')).resolves.toEqual({ models: [], commands: [] });
    await expect(manager.run(context())).resolves.toEqual({ content: 'done' });
    state.mode = 'read-only';
    await expect(manager.capabilities('test')).rejects.toThrow('probing is unavailable');
    expect(state.probe).toHaveBeenCalledOnce();
    expect(state.run).toHaveBeenCalledOnce();
  });
});
