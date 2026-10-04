/**
 * Provider OAuth 凭证存储:~/.tangu/provider-auth.json = { [providerId]: OAuthTokens }。
 * `tangu-chat login <provider>`(如 xai)写入;chat 启动时读出、按需刷新,接进 provider registry 当 LLM。
 */
import { readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { providerAuthFile } from '../core/tanguHome.js';
import { withConfigLock } from '../core/config.js';

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  baseUrl: string; // OpenAI 兼容推理根(如 https://cli-chat-proxy.grok.com/v1)
  tokenEndpoint: string; // 刷新用
  clientId: string;
  account_id?: string; // Codex 订阅:chatgpt-account-id(从 id_token JWT 解出)
  modelIds?: string[]; // 登录时从 provider /models 端点拉取并缓存(空或 stale 时启动懒刷;失败回退硬编提示)
  modelIdsAt?: number; // modelIds 拉取时刻 epoch ms(TTL 判 stale 用)
  modelIdsClientVersion?: string; // Codex 目录按客户端版本过滤;版本变化立即重拉(旧文件缺字段同样重拉)
}

const file = (): string => providerAuthFile(); // 共享域(home=…/tangu 时为其父目录)

export function loadProviderCreds(): Record<string, OAuthTokens> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, OAuthTokens>;
  } catch {
    return {};
  }
}

/**
 * 锁内读改写一个 provider 的记录:fn 拿到盘上**此刻**的那条(没有 = undefined),返回新记录 = 写入,返回 undefined = 不写。
 * 这份文件引擎、TUI、桌面登录(都经本模块)多进程共写,而且续期会轮换 refresh_token:
 *   - 无锁「读全量 → 改一条 → 写全量」会把别的进程刚轮换过的另一家 token 用旧值盖回去,那家就只能重新登录;
 *   - 直接 writeFileSync 是先截断再写,读者撞上半截文件会当成「空」,下一次保存就把其它登录全抹掉。
 * 所以:跨进程写锁(与 config.json 同一套实现,各锁各的文件)+ 写临时文件再 rename。读不加锁。
 * ponytail: 这把锁是同步等的(Atomics.wait),而续期落盘在取用模型的路径上:别的进程死在临界区时,本进程最多整体停到
 *           陈旧锁被回收(5s)。只在真要落盘时才抢锁(约每个 token 有效期一次,并发调用共用一次续期),先不为它做异步锁。
 */
export function updateProviderCred(id: string, fn: (cur: OAuthTokens | undefined) => OAuthTokens | undefined): void {
  // 文件本身可能是软链(live 台架把隔离 home 里的这份链到开发环境那份):rename 落到链上会把链换成普通文件,
  // 续出来的新 refresh_token 就写不回真身,真身那份留着已作废的旧值。按真身加锁、在真身旁边落位。
  let f = file();
  try { f = realpathSync(f); } catch { /* 还不存在:按字面路径 */ }
  withConfigLock(f, (stillMine) => {
    const all = loadProviderCreds();
    const next = fn(all[id]);
    if (!next) return;
    all[id] = next;
    const tmp = `${f}.${process.pid}-${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (!stillMine()) throw new Error(`provider-auth.json 的写锁在持有期间被回收,放弃本次写入:${f}`);
      renameSync(tmp, f);
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* 清不掉就留着,别盖掉原始错误 */ }
      throw e;
    }
  });
}

export function saveProviderCred(id: string, t: OAuthTokens): void {
  updateProviderCred(id, () => t);
}
