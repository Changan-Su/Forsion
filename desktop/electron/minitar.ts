/**
 * 逐字抄自 tangu-agent/src/plugins/minitar.ts(主进程与引擎是两个包,照 cmpVersion / forsionSharedDir 的先例抄一份,
 * 不跨包 import 引擎源码)。改一边必须改另一边:这是解第三方字节的安全边界,两份的拒收规则必须一致。
 * 桌面用它解 npm tarball(electron/builtinUpdates.ts 的内置捆绑包更新)。
 *
 * 极小 tar 解包(纯函数、零依赖)。**只服务 npm pack 产出的 tarball**:gzip 已在上层剥掉,
 * 此处只解 tar。npm publish 拒绝 symlink、条目统一 `package/` 前缀、类型只有普通文件/目录 →
 * 我们只支持这些,**其余条目类型(symlink/hardlink/设备/fifo)一律抛错**——比通用 tar 库更安全,
 * 攻击面更小(装第三方插件是「以完整系统权限运行」的信任动作,解包环节不给可乘之机)。
 *
 * 落盘防穿越不在此文件——untar 只把 tar 解析成内存条目;安全落盘由 npmInstall 的 safeJoin 兜底。
 */
const BLOCK = 512;

export interface TarEntry {
  path: string;
  data: Buffer;
  /** unix 权限位(& 0o777);落盘时用于恢复可执行位(native helper / bin)。 */
  mode?: number;
}

function readStr(b: Buffer, off: number, len: number): string {
  const slice = b.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

/** 读 ASCII 八进制字段(容忍前导/尾随空格与 NUL);空 → 0。 */
function readOctal(b: Buffer, off: number, len: number): number {
  const s = readStr(b, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/** USTAR header checksum:全 512 字节无符号和,checksum 字段(148..156)按 8 个空格计。 */
function checksum(h: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum;
}

/** pax extended header 数据段("len key=value\n" 记录流),取 path= 覆盖值。 */
function paxPath(data: Buffer): string | undefined {
  const s = data.toString('utf8');
  let i = 0;
  while (i < s.length) {
    const sp = s.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(s.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > s.length) break;
    const record = s.slice(sp + 1, i + len - 1); // 去掉末尾 \n
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    i += len;
  }
  return undefined;
}

/**
 * 解 tar buffer 成条目数组。支持:普通文件('0'/'\0')、目录('5',忽略)、GNU longname('L')、
 * pax header('x'/'g',取 path=)。其余类型抛错。header checksum 不匹配抛错(损坏/非 tar)。
 */
export function untar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | undefined; // GNU 'L' → 下一条目的 name
  let overridePath: string | undefined; // pax 'x' path= → 下一条目的 name
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) if (h[i] !== 0) { allZero = false; break; }
    if (allZero) break; // 全零块 = 归档结束
    if (readOctal(h, 148, 8) !== checksum(h)) {
      throw new Error('tar: header checksum 不匹配(文件损坏或不是 tar)');
    }
    const size = readOctal(h, 124, 12);
    const type = String.fromCharCode(h[156]);
    off += BLOCK;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK; // 数据段按块补齐

    if (type === 'L') { longName = readStr(data, 0, data.length).replace(/\0+$/, ''); continue; }
    if (type === 'x' || type === 'g') { overridePath = paxPath(data) ?? overridePath; continue; }

    let name = readStr(h, 0, 100);
    const prefix = readStr(h, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (longName) { name = longName; longName = undefined; }
    if (overridePath) { name = overridePath; overridePath = undefined; }

    if (type === '5') continue; // 目录:忽略(按文件 path 自建父目录)
    if (type === '0' || type === '\0' || type === '') {
      out.push({ path: name, data: Buffer.from(data), mode: readOctal(h, 100, 8) & 0o777 });
      continue;
    }
    throw new Error(`tar: 拒绝不支持的条目类型 '${type === '\0' ? '\\0' : type}'(${name})`);
  }
  return out;
}

/**
 * 剥掉统一顶层目录(npm 规范是 `package/`)。所有条目都在同一顶层下才剥,否则原样返回。
 * 顶层目录本身若作为条目(极少)一并滤掉。
 */
export function stripTopDir(entries: TarEntry[]): TarEntry[] {
  if (!entries.length) return entries;
  const top = entries[0].path.replace(/\\/g, '/').split('/')[0];
  if (!top) return entries;
  const prefix = `${top}/`;
  if (!entries.every((e) => e.path === top || e.path.replace(/\\/g, '/').startsWith(prefix))) return entries;
  return entries
    .filter((e) => e.path.replace(/\\/g, '/').startsWith(prefix))
    .map((e) => ({ ...e, path: e.path.replace(/\\/g, '/').slice(prefix.length) }));
}
