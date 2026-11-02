/**
 * CLI 凭证存储:~/.tangu/auth.json { cloudUrl, token }。
 * `tangu login` 写入,`tangu chat` / standalone 在未显式传 --token 时读取(去掉手动塞 token)。
 *
 * 这份文件和桌面共写(desktop/electron/forsionAuth.ts),「读不出来 = 不知道,拒写,只有明确登录放行」是同一契约,改一边必须改另一边。
 * ⚠️ 不走 readLockedJson 的 .bak 恢复:桌面写它时不留备份,.bak 可能停在别的账号,甚至是用户已登出的 token,
 * 恢复等于悄悄换号。这里也不留 .bak。
 * ponytail: 锁只挡 CLI 之间的读改写,桌面写这份文件不抢锁。要真互斥得桌面也走 withConfigLock。
 */
import { readFileSync } from 'node:fs';
import { authFile } from '../core/tanguHome.js';
import { isCreds, keepBadCopy, withConfigLock, writeAtomic } from '../core/config.js';

export interface Creds {
  cloudUrl?: string;
  token?: string;
  model?: string; // TUI 内 /model 选定后记住,下次免 --model
}

const file = (): string => authFile(); // 共享域(home=…/tangu 时为其父目录)

/** 只有 ENOENT 算空。文件在却读不了 / 解析不了 = 不知道(null)。 */
function readCreds(): Creds | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), 'utf8'));
    return isCreds(parsed) ? parsed : null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
}

const unreadable = (): string => `${file()} is unreadable. Sign in again to replace it, or repair or remove the file.`;

export function loadCreds(): Creds {
  const c = readCreds();
  if (!c) console.error(`[auth] ${unreadable()}`);
  return c ?? {};
}

/** 合并写入(读改写在同一把锁里);auth.json 读不出来时抛,原文件不动。
 *  signIn = 明确登录:新凭据不是从失败的那次读算出来的,坏文件另存 `config-backup/auth.json.bad-*` 后换上,
 *  否则断电留下的零字节文件要人手动去删才登得上。留不下坏文件就整次失败。 */
export function saveCreds(patch: Creds, opts: { signIn?: boolean } = {}): void {
  withConfigLock(file(), (stillMine) => {
    const cur = readCreds();
    if (!cur) {
      if (!opts.signIn) throw new Error(unreadable());
      console.warn(`[auth] unreadable auth.json kept at ${keepBadCopy(file())}`);
    }
    writeAtomic(file(), JSON.stringify({ ...cur, ...patch }, null, 2), stillMine);
  });
}

/** 合并保存「最近使用的模型」（不动 token/cloudUrl）。TUI 内 /model 调用。 */
export function saveModel(model: string): void {
  saveCreds({ model });
}
