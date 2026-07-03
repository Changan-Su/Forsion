/**
 * Lifecycle Hooks 单测：纯函数（matcher / trust hash / discover / fold / parse）+ 真实 spawn（executeHook）
 * + host-only 闸（runHooks）。不触碰真实 ~/.tangu/config.json（runHooks 的 host-only 分支在读配置前返回）。
 */
import { describe, it, expect } from 'vitest';
import {
  matcherMatches,
  validateMatcherPattern,
  hookContentHash,
  hookKey,
  normalizeHooksConfig,
  discoverHooks,
  foldVerdict,
  parseHookOutput,
  executeHook,
  runHooks,
  type DiscoveredHook,
  type HooksConfig,
  type HookRunResult,
} from '../src/hooks/index.js';

describe('matcher', () => {
  it('empty / * match everything', () => {
    expect(matcherMatches('', 'run_bash')).toBe(true);
    expect(matcherMatches(undefined, 'run_bash')).toBe(true);
    expect(matcherMatches('*', 'anything')).toBe(true);
  });
  it('exact + alternation (pure names, not regex)', () => {
    expect(matcherMatches('run_bash', 'run_bash')).toBe(true);
    expect(matcherMatches('run_bash', 'run_background')).toBe(false);
    expect(matcherMatches('edit_file|write_file', 'write_file')).toBe(true);
    expect(matcherMatches('edit_file|write_file', 'apply_patch')).toBe(false);
    // pure-name matcher must NOT behave as substring/regex:
    expect(matcherMatches('Edit', 'CodeEditor')).toBe(false);
  });
  it('regex for non-pure patterns', () => {
    expect(matcherMatches('mcp__.*', 'mcp__github__search')).toBe(true);
    expect(matcherMatches('mcp__.*', 'run_bash')).toBe(false);
  });
  it('invalid regex → no match, validate flags it', () => {
    expect(matcherMatches('[', 'x')).toBe(false);
    expect(validateMatcherPattern('[')).not.toBeNull();
    expect(validateMatcherPattern('mcp__.*')).toBeNull();
    expect(validateMatcherPattern('*')).toBeNull();
  });
});

describe('trust hash / key', () => {
  const h = { type: 'command' as const, command: 'prettier --write "$file"' };
  it('stable for same content, changes when command edited', () => {
    const a = hookContentHash('PostToolUse', 'edit_file', h);
    const b = hookContentHash('PostToolUse', 'edit_file', h);
    const c = hookContentHash('PostToolUse', 'edit_file', { ...h, command: 'eslint --fix' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it('key format = source:event:hash12', () => {
    const hash = hookContentHash('PostToolUse', 'edit_file', h);
    expect(hookKey('user', 'PostToolUse', hash)).toBe(`user:PostToolUse:${hash.slice(0, 12)}`);
  });
});

describe('config normalize + discover trust', () => {
  const mkCfg = (): HooksConfig =>
    normalizeHooksConfig({
      events: {
        PreToolUse: [{ matcher: 'run_bash', hooks: [{ type: 'command', command: './guard.sh' }] }],
        // garbage dropped:
        PostToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: '' }] }, { hooks: 'nope' }],
        NotAnEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
      state: {},
    });

  it('normalize drops empty/invalid handlers and unknown events', () => {
    const cfg = mkCfg();
    expect(cfg.events.PreToolUse?.length).toBe(1);
    expect(cfg.events.PostToolUse).toBeUndefined(); // both groups invalid → event absent
    expect((cfg.events as any).NotAnEvent).toBeUndefined();
  });

  it('no state → needs-review, inactive (does not run)', () => {
    const d = discoverHooks(mkCfg(), 'PreToolUse');
    expect(d).toHaveLength(1);
    expect(d[0].trust).toBe('needs-review');
    expect(d[0].active).toBe(false);
  });

  it('matching trustedHash → trusted + active; wrong hash → needs-review', () => {
    const cfg = mkCfg();
    const key = discoverHooks(cfg, 'PreToolUse')[0].key;
    const hash = discoverHooks(cfg, 'PreToolUse')[0].contentHash;
    cfg.state[key] = { enabled: true, trustedHash: hash };
    let d = discoverHooks(cfg, 'PreToolUse')[0];
    expect(d.trust).toBe('trusted');
    expect(d.active).toBe(true);
    // edit → hash mismatch → inactive again
    cfg.state[key] = { enabled: true, trustedHash: 'deadbeef' };
    d = discoverHooks(cfg, 'PreToolUse')[0];
    expect(d.trust).toBe('needs-review');
    expect(d.active).toBe(false);
    // disabled → inactive even if trusted
    cfg.state[key] = { enabled: false, trustedHash: hash };
    expect(discoverHooks(cfg, 'PreToolUse')[0].active).toBe(false);
  });
});

describe('parseHookOutput (fail-open)', () => {
  it('exit 2 → block with stderr reason', () => {
    const r = parseHookOutput('PreToolUse', 2, '', 'rm -rf blocked');
    expect(r.status).toBe('blocked');
    expect(r.output?.decision).toBe('block');
    expect(r.output?.reason).toBe('rm -rf blocked');
  });
  it('decision:block json → blocked', () => {
    const r = parseHookOutput('PreToolUse', 0, '{"decision":"block","reason":"no"}', '');
    expect(r.status).toBe('blocked');
    expect(r.output?.reason).toBe('no');
  });
  it('invalid json that looks like json → failed (fail-open, not silent)', () => {
    const r = parseHookOutput('PreToolUse', 0, '{oops', '');
    expect(r.status).toBe('failed');
    expect(r.failReason).toMatch(/invalid JSON/);
  });
  it('plain stdout → additionalContext only for context events', () => {
    expect(parseHookOutput('SessionStart', 0, 'use pnpm', '').output?.hookSpecificOutput?.additionalContext).toBe('use pnpm');
    expect(parseHookOutput('PostToolUse', 0, 'ignored', '').output).toBeUndefined();
  });
  it('nonzero non-2 exit → failed', () => {
    expect(parseHookOutput('PostToolUse', 1, '', 'boom').status).toBe('failed');
  });
});

describe('foldVerdict', () => {
  const run = (o: any): HookRunResult => ({ key: 'k', event: 'PreToolUse', status: 'completed', durationMs: 1, output: o });
  it('PreToolUse block wins', () => {
    const v = foldVerdict('PreToolUse', [run({ decision: 'block', reason: 'x' })]);
    expect(v.block).toBe(true);
    expect(v.blockReason).toBe('x');
  });
  it('PreToolUse updatedInput = last completing wins', () => {
    const v = foldVerdict('PreToolUse', [
      { key: 'a', event: 'PreToolUse', status: 'completed', durationMs: 1, output: { hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'first' } } } },
      { key: 'b', event: 'PreToolUse', status: 'completed', durationMs: 1, output: { hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'last' } } } },
    ]);
    expect(v.updatedInput).toEqual({ command: 'last' });
  });
  it('PreToolUse ignores continue:false; PostToolUse honors it', () => {
    expect(foldVerdict('PreToolUse', [run({ continue: false })]).stop).toBeUndefined();
    const v = foldVerdict('PostToolUse', [{ key: 'k', event: 'PostToolUse', status: 'stopped', durationMs: 1, output: { continue: false, stopReason: 'done' } }]);
    expect(v.stop).toBe(true);
    expect(v.stopReason).toBe('done');
  });
  it('PermissionRequest: deny wins over allow; allow alone → allow', () => {
    const deny = foldVerdict('PermissionRequest', [
      { key: 'a', event: 'PermissionRequest', status: 'completed', durationMs: 1, output: { hookSpecificOutput: { permissionDecision: 'allow' } } },
      { key: 'b', event: 'PermissionRequest', status: 'blocked', durationMs: 1, output: { hookSpecificOutput: { permissionDecision: 'deny' }, reason: 'nope' } },
    ]);
    expect(deny.block).toBe(true);
    expect(deny.allow).toBeUndefined();
    const allow = foldVerdict('PermissionRequest', [
      { key: 'a', event: 'PermissionRequest', status: 'completed', durationMs: 1, output: { hookSpecificOutput: { permissionDecision: 'allow' } } },
    ]);
    expect(allow.allow).toBe(true);
  });
  it('collects additionalContext + systemMessages in order', () => {
    const v = foldVerdict('SessionStart', [
      { key: 'a', event: 'SessionStart', status: 'completed', durationMs: 1, output: { hookSpecificOutput: { additionalContext: 'one' }, systemMessage: 'warn' } },
      { key: 'b', event: 'SessionStart', status: 'completed', durationMs: 1, output: { hookSpecificOutput: { additionalContext: 'two' } } },
    ]);
    expect(v.additionalContext).toEqual(['one', 'two']);
    expect(v.systemMessages).toEqual(['warn']);
  });
});

describe('executeHook (real spawn)', () => {
  const mk = (command: string): DiscoveredHook => ({
    key: 'user:PreToolUse:test', event: 'PreToolUse', matcher: 'run_bash',
    handler: { type: 'command', command }, source: 'user', contentHash: 'x', trust: 'trusted', enabled: true, active: true,
  });
  it('exit 2 → blocked', async () => {
    const r = await executeHook(mk('echo denied 1>&2; exit 2'), { tool_name: 'run_bash' }, {});
    expect(r.status).toBe('blocked');
    expect(r.output?.reason).toBe('denied');
  });
  it('json stdout → parsed block', async () => {
    const r = await executeHook(mk(`printf '%s' '{"decision":"block","reason":"stop"}'`), { tool_name: 'run_bash' }, {});
    expect(r.status).toBe('blocked');
    expect(r.output?.reason).toBe('stop');
  });
  it('reads JSON payload from stdin (event name delivered)', async () => {
    // grep the stdin payload for the injected event name; plain "ok" → additionalContext for SessionStart
    const hook: DiscoveredHook = { ...mk(`grep -q '"hook_event_name":"SessionStart"' && echo ok`), event: 'SessionStart' };
    const r = await executeHook(hook, { source: 'startup' } as any, {});
    expect(r.status).toBe('completed');
    expect(r.output?.hookSpecificOutput?.additionalContext).toBe('ok');
  });
});

describe('runHooks host-only gate (no config read, no spawn)', () => {
  it('no profile → empty verdict', async () => {
    const v = await runHooks('PreToolUse', { tool_name: 'run_bash' }, {});
    expect(v.runs).toHaveLength(0);
    expect(v.block).toBeUndefined();
  });
  it('hostExec false → empty verdict', async () => {
    const v = await runHooks('PreToolUse', { tool_name: 'run_bash' }, { profile: { capabilities: { hostExec: false } } as any, execMode: 'host' });
    expect(v.runs).toHaveLength(0);
  });
  it('sandbox execMode → empty verdict', async () => {
    const v = await runHooks('PreToolUse', { tool_name: 'run_bash' }, { profile: { capabilities: { hostExec: true } } as any, execMode: 'sandbox' });
    expect(v.runs).toHaveLength(0);
  });
});
