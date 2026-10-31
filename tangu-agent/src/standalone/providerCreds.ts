/**
 * Provider OAuth 凭证存储:~/.tangu/provider-auth.json = { [providerId]: OAuthTokens }。
 * `tangu-chat login <provider>`(如 xai)写入;chat 启动时读出、按需刷新,接进 provider registry 当 LLM。
 */
import { realpathSync } from 'node:fs';
import { providerAuthFile } from '../core/tanguHome.js';
import { withConfigLock, loadJsonRecovering, readLockedJson, commitLockedJson } from '../core/config.js';

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
  fastTiers?: Record<string, string>; // 与 modelIds 同一趟拉的:模型 → Fast 档说明原文(Codex service_tiers 里 id=priority 那条);{}=拉过、都没有
}

const file = (): string => providerAuthFile(); // 共享域(home=…/tangu 时为其父目录)

/** 文件本身可能是软链(live 台架把隔离 home 里的这份链到开发环境那份):rename 落到链上会把链换成普通文件,
 *  续出来的新 refresh_token 就写不回真身,真身那份留着已作废的旧值。按真身加锁、在真身旁边落位(备份也在真身旁边)。 */
function realFile(): string {
  const f = file();
  try { return realpathSync(f); } catch { return f; /* 还不存在:按字面路径 */ }
}

/** 读全部登录。坏文件先从 .bak 恢复(core/config.ts 的同一套);恢复不了才当没登录。 */
export function loadProviderCreds(): Record<string, OAuthTokens> {
  const f = realFile();
  return (loadJsonRecovering(f, (m) => updateJsonLocked(f, m)) ?? {}) as Record<string, OAuthTokens>;
}

/** 锁内读改写整份 provider-auth.json:读侧带恢复;坏了又没有备份就当空(重新登录要能救回来),坏文件提交时另存 `.bad-*` 不删。
 *  提交前留 .bak,0600 同原件。 */
function updateJsonLocked(f: string, mutate: (all: Record<string, OAuthTokens>) => Record<string, OAuthTokens> | undefined): void {
  withConfigLock(f, (stillMine) => {
    const read = readLockedJson(f, stillMine, 'provider-auth.json', 'empty');
    const next = mutate((read.cur ?? {}) as Record<string, OAuthTokens>);
    if (next === undefined) return;
    commitLockedJson(f, next, read, stillMine);
  });
}

/**
 * 锁内读改写一个 provider 的记录:fn 拿到盘上**此刻**的那条(没有 = undefined),返回新记录 = 写入,返回 undefined = 不写。
 * 这份文件引擎、TUI、桌面登录(都经本模块)多进程共写,而且续期会轮换 refresh_token:
 *   - 无锁「读全量 → 改一条 → 写全量」会把别的进程刚轮换过的另一家 token 用旧值盖回去,那家就只能重新登录;
 *   - 直接 writeFileSync 是先截断再写,读者撞上半截文件会当成「空」,下一次保存就把其它登录全抹掉。
 * 所以:跨进程写锁(与 config.json 同一套实现,各锁各的文件)+ 写临时文件再 rename。读不加锁。
 * 文件坏了(零字节 / 半截):有 .bak 先恢复(写盘前都留一份);连备份也没有才当空,坏文件另存 `.bad-*` 留着。
 * ponytail: 这把锁是同步等的(Atomics.wait),而续期落盘在取用模型的路径上:别的进程死在临界区时,本进程最多整体停到
 *           陈旧锁被回收(5s)。只在真要落盘时才抢锁(约每个 token 有效期一次,并发调用共用一次续期),先不为它做异步锁。
 */
export function updateProviderCred(id: string, fn: (cur: OAuthTokens | undefined) => OAuthTokens | undefined): void {
  updateJsonLocked(realFile(), (all) => {
    const next = fn(all[id]);
    if (!next) return undefined;
    return { ...all, [id]: next };
  });
}

export function saveProviderCred(id: string, t: OAuthTokens): void {
  updateProviderCred(id, () => t);
}
