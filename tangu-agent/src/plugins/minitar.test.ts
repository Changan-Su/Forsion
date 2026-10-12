/**
 * minitar 解包契约:自写一个极小 tar writer 造 fixture(untar 的逆操作),覆盖普通文件/mode/目录忽略/
 * GNU longname/pax path/checksum 校验/symlink 拒绝。writer 只服务测试,不进生产。
 */
import { describe, it, expect } from 'vitest';
import { untar, stripTopDir } from './minitar.js';

const BLOCK = 512;

/** 造一个 512 字节 tar header(ustar)。checksum 按标准:先填 8 空格算无符号和,再写回。 */
function header(name: string, size: number, type = '0', mode = 0o644): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  h.write('0'.padStart(7, '0') + '\0', 108, 8); // uid
  h.write('0'.padStart(7, '0') + '\0', 116, 8); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  h.write('0'.padStart(11, '0') + '\0', 136, 12); // mtime
  h.write(type, 156, 1);
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  h.write('        ', 148, 8); // checksum 占位=8 空格
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function block(name: string, content: Buffer | string = '', type = '0', mode = 0o644): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const pad = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([header(name, data.length, type, mode), data, pad]);
}

/** pax record: "len key=value\n",len 含自身位数(迭代到稳定)。 */
function paxRecord(key: string, val: string): string {
  const tail = ` ${key}=${val}\n`;
  let len = tail.length;
  let size = len;
  do { len = size; size = String(len).length + tail.length; } while (size !== len);
  return String(len) + tail;
}

function makeTar(blocks: Buffer[]): Buffer {
  return Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]); // 两个全零块结束
}

describe('minitar untar', () => {
  it('解普通文件并保 mode(& 0o777)', () => {
    const tar = makeTar([block('package/index.js', 'hi', '0', 0o755)]);
    const e = untar(tar);
    expect(e).toHaveLength(1);
    expect(e[0].path).toBe('package/index.js');
    expect(e[0].data.toString()).toBe('hi');
    expect(e[0].mode).toBe(0o755);
  });

  it('忽略目录条目(type 5)', () => {
    const tar = makeTar([block('package/', '', '5'), block('package/a.js', 'x')]);
    expect(untar(tar).map((e) => e.path)).toEqual(['package/a.js']);
  });

  it('拒绝 symlink 条目(type 2)', () => {
    const tar = makeTar([block('package/link', '', '2')]);
    expect(() => untar(tar)).toThrow(/条目类型/);
  });

  it('checksum 损坏 → 抛错', () => {
    const tar = makeTar([block('package/a.js', 'x')]);
    tar[10] ^= 0xff; // 破坏 name(进而 checksum 不符)
    expect(() => untar(tar)).toThrow(/checksum/);
  });

  it('size 是负数的 header → 抛错,不原地打转(改过 size 的 header 校验和照样能算对)', () => {
    const h = header('package/a.js', 0);
    h.write('-0000001000\0', 124, 12); // parseInt('-0000001000', 8) = -512
    h.write('        ', 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    expect(() => untar(makeTar([h]))).toThrow(/invalid entry size or truncated data/);
  });

  it('数据段比 header 声明的短(截断的归档)→ 抛错', () => {
    const full = block('package/a.js', 'x'.repeat(2000));
    expect(() => untar(full.subarray(0, BLOCK + 1000))).toThrow(/invalid entry size or truncated data/);
  });

  it('GNU longname(type L)覆盖下一条目的 name', () => {
    const longName = 'package/' + 'nested/'.repeat(20) + 'deep.js';
    const tar = makeTar([
      block('././@LongLink', longName + '\0', 'L'),
      block('package/placeholder', 'body'), // name 被 longName 覆盖
    ]);
    const e = untar(tar);
    expect(e).toHaveLength(1);
    expect(e[0].path).toBe(longName);
    expect(e[0].data.toString()).toBe('body');
  });

  it('pax path= 覆盖长文件名', () => {
    const longName = 'package/' + 'x/'.repeat(60) + 'file.js';
    const tar = makeTar([
      block('PaxHeader/0', paxRecord('path', longName), 'x'),
      block('package/placeholder.js', 'content'),
    ]);
    const e = untar(tar);
    expect(e[0].path).toBe(longName);
    expect(e[0].data.toString()).toBe('content');
  });

  it('多文件顺序保留', () => {
    const tar = makeTar([block('package/a', 'A'), block('package/b/c', 'C')]);
    expect(untar(tar).map((e) => e.path)).toEqual(['package/a', 'package/b/c']);
  });
});

describe('minitar stripTopDir', () => {
  it('剥统一 package/ 前缀', () => {
    const e = untar(makeTar([block('package/tangu-plugin.json', '{}'), block('package/dist/index.js', 'x')]));
    expect(stripTopDir(e).map((x) => x.path)).toEqual(['tangu-plugin.json', 'dist/index.js']);
  });

  it('顶层不统一时原样返回', () => {
    const e = untar(makeTar([block('a/x', '1'), block('b/y', '2')]));
    expect(stripTopDir(e).map((x) => x.path)).toEqual(['a/x', 'b/y']);
  });
});
