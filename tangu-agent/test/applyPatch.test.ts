import { describe, it, expect } from 'vitest';
import { parsePatch, applyHunksToContent, type PatchOp } from '../src/tools/applyPatch.js';

const upd = (ops: PatchOp[]): Extract<PatchOp, { kind: 'update' }> => {
  const o = ops.find((x) => x.kind === 'update');
  if (!o || o.kind !== 'update') throw new Error('no update op');
  return o;
};

describe('parsePatch', () => {
  it('parses Add File content (strips + prefix)', () => {
    const ops = parsePatch(['*** Begin Patch', '*** Add File: a/new.txt', '+hello', '+world', '*** End Patch'].join('\n'));
    expect(ops).toEqual([{ kind: 'add', path: 'a/new.txt', content: 'hello\nworld' }]);
  });

  it('parses Delete File', () => {
    const ops = parsePatch('*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch');
    expect(ops).toEqual([{ kind: 'delete', path: 'gone.ts' }]);
  });

  it('parses Update with typed hunk lines and Move to', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/x.ts',
      '*** Move to: src/y.ts',
      '@@ foo',
      ' keep',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const u = upd(parsePatch(patch));
    expect(u.path).toBe('src/x.ts');
    expect(u.movePath).toBe('src/y.ts');
    expect(u.hunks).toHaveLength(1);
    expect(u.hunks[0].context).toBe('foo');
    expect(u.hunks[0].lines).toEqual([
      { type: ' ', text: 'keep' },
      { type: '-', text: 'old' },
      { type: '+', text: 'new' },
    ]);
  });

  it('is lenient: parses without Begin/End envelope', () => {
    const ops = parsePatch('*** Add File: z.txt\n+one');
    expect(ops).toEqual([{ kind: 'add', path: 'z.txt', content: 'one' }]);
  });

  it('throws when no file change parsed', () => {
    expect(() => parsePatch('just some text\nno markers')).toThrow();
  });
});

describe('applyHunksToContent', () => {
  const file = 'function foo() {\n  return 1;\n}\n';

  it('applies an exact-match update', () => {
    const u = upd(parsePatch(
      '*** Update File: f\n@@\n function foo() {\n-  return 1;\n+  return 2;\n }\n',
    ));
    expect(applyHunksToContent(file, u.hunks)).toBe('function foo() {\n  return 2;\n}\n');
  });

  it('falls back to whitespace-insensitive match on indentation drift', () => {
    const drifted = 'function foo() {\n        return 1;\n}\n'; // 8-space indent in file
    const u = upd(parsePatch(
      '*** Update File: f\n@@\n function foo() {\n-  return 1;\n+  return 2;\n }\n', // 2-space in patch
    ));
    // exact fails → trim match locates it → replaced with patch's new lines
    expect(applyHunksToContent(drifted, u.hunks)).toBe('function foo() {\n  return 2;\n}\n');
  });

  it('applies multiple hunks left-to-right', () => {
    const src = 'a\nb\nc\nd\ne\n';
    const u = upd(parsePatch(
      '*** Update File: f\n@@\n a\n-b\n+B\n@@\n d\n-e\n+E\n',
    ));
    expect(applyHunksToContent(src, u.hunks)).toBe('a\nB\nc\nd\nE\n');
  });

  it('throws when a hunk context cannot be located (caller rolls back)', () => {
    const u = upd(parsePatch('*** Update File: f\n@@\n nonexistent\n-line\n+x\n'));
    expect(() => applyHunksToContent(file, u.hunks)).toThrow(/无法定位/);
  });

  it('throws on an anchorless hunk (only additions, no context)', () => {
    const u = upd(parsePatch('*** Update File: f\n@@\n+just added')); // no trailing newline → no blank context anchor
    expect(() => applyHunksToContent(file, u.hunks)).toThrow();
  });
});
