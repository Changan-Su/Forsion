/**
 * 按远端主机取 git 凭据的接缝(登记式)。推送 / 拉取之前按远端的 origin 问一圈登记过的提供方,有人认领就把凭据**按次**
 * 交给这一个 git 子进程,没人认领就什么都不加 —— 行为与没有这个接缝时逐字一致。
 *
 * 这里不认识任何具体的托管站:Forsion Git 的提供方在 services/forsionGit.ts,别的站(github.com …)各自登记。
 *
 * 凭据怎么给 git(2026-10-10 在真 Gitea 28 上用真 git 验过推送 / 克隆 / fetch):只经环境变量,
 *     GIT_CONFIG_COUNT=<n+1>
 *     GIT_CONFIG_KEY_<n>=http.<origin>/.extraheader
 *     GIT_CONFIG_VALUE_<n>=Authorization: Basic <base64(username:password)>
 * 不进命令行参数(`ps` 看得到)、不写任何 gitconfig、不落盘、不经凭据助手(助手会把它存进钥匙串)。
 * `http.<url>.*` 按 URL 前缀匹配:同一个进程里连到别的主机的请求(子模块、多个 pushurl)拿不到这个头。git ≥ 2.31。
 *
 * 只认 `https://` 远端:明文 http 上发 Basic 头等于把令牌交给路上的每一跳;ssh 远端用的是用户自己的钥匙。
 * 远端 URL 里自带用户名 / 口令(`https://u:p@host/…`)= 用户自己配了凭据 → 不碰。
 *
 * 带凭据的那个子进程还要对这个站点清空凭据助手、关掉 askpass(gitActions.runAction 里做,理由写在那里):
 * 我们的凭据被拒之后,git 会去问助手,助手手里的旧凭据跟着失败、然后被 git 让助手**删掉**;图形界面的助手会弹窗干等。
 *
 * ⚠️ 给了凭据的那个子进程,环境里的 `GIT_TRACE*` / `GIT_CURL_VERBOSE` 必须先摘掉(stripGitTraceEnv):
 * 开着它们时 git 会把请求头打进 stderr,而 stderr 会作为失败原文回到界面。回显前还要再按字面遮一遍(scrubGitSecrets)。
 * 已信任仓库的钩子(pre-push 之类)继承同一份环境,读得到这枚凭据 —— 与用户自己在终端里配了凭据时一样,信任闸管的就是这件事。
 * 子模块是另一个仓库、另一份没过信任闸的配置:带凭据的动作一律不递归进子模块(gitActions 里加 --no-recurse-submodules)。
 *
 * 信任边界 = 认领的那个 origin 自己:它把 git 重定向到哪里,头就跟到哪里(git 只跟初始请求的重定向,之后的请求发往新地址)。
 * 不关重定向 —— 站内改名(用户名 / 仓库名)靠的就是它;能发出这种重定向的只有已经拿到这枚凭据的那台服务器。
 */

export interface GitCredential { username: string; password: string }

/** origin = 远端的 `https://host[:port]`(主机名小写、缺省端口省略、没有尾斜杠)。不是自己管的主机 → null。 */
export type GitCredentialLookup = (origin: string) => Promise<GitCredential | null>;

export interface GitCredentialProvider {
  credentials: GitCredentialLookup;
  /** 远端刚拒了 `rejected` 这一枚(认证失败)。提供方作废自己缓存里的**同一枚**(已经换过新的就别动 —— 两个并发的动作
   *  先后报同一枚失效时,第二个不该把第一个刚取回来的新凭据也作废);接缝随后会再问一次 credentials。没有缓存的提供方不用实现。 */
  invalidate?(origin: string, rejected: GitCredential): void;
}

/** 提供方给不出凭据、并且有话要对用户说时抛它(别的异常一律按「不认领」处理:取凭据这一步不许让动作多出报错)。
 *  - fallback = false:动作到此为止,按 code 报给用户(例:这个人在那个站上还没有账号)。
 *  - fallback = true :这一次暂时取不到(限次、站点够不着)→ 动作照「没有凭据」继续;git 自己因为认证失败时,
 *    才把这个 code 报给用户 —— 用户自己配过凭据的,照常成功,不多出任何报错。 */
export class GitCredentialError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: string, readonly fallback = false) { super(message); }
}

const providers: Array<{ id: string; provider: GitCredentialProvider }> = [];

/** 登记一个提供方。按登记顺序问,第一个给出凭据的算数;同一个 id 再登记 = 原位替换。返回注销函数。 */
export function registerGitCredentialProvider(id: string, provider: GitCredentialLookup | GitCredentialProvider): () => void {
  const entry = { id, provider: typeof provider === 'function' ? { credentials: provider } : provider };
  const at = providers.findIndex((p) => p.id === id);
  if (at >= 0) providers[at] = entry; else providers.push(entry);
  return () => { const i = providers.indexOf(entry); if (i >= 0) providers.splice(i, 1); };
}

/** 远端 URL → 可以带凭据的 origin;不是 https、解析不了、或 URL 里自带用户名 / 口令 → null。 */
export function credentialOrigin(remoteUrl: string): string | null {
  let url: URL;
  try { url = new URL(remoteUrl.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url.origin;
}

/** 这枚凭据对应的三项环境变量。编号接在 env 里已有的 GIT_CONFIG_COUNT 后面(覆盖掉别人的会让他们那几项配置失效)。 */
export function gitCredentialConfig(origin: string, credential: GitCredential, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
  const index = Number.isInteger(existing) && existing > 0 ? existing : 0;
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${origin}/.extraheader`,
    [`GIT_CONFIG_VALUE_${index}`]: `Authorization: Basic ${basic(credential)}`,
  };
}

const basic = (c: GitCredential): string => Buffer.from(`${c.username}:${c.password}`, 'utf8').toString('base64');

export interface GitCredentialGrant {
  /** 要并进 git 子进程环境的那三项;没有凭据时是空对象。 */
  env: Record<string, string>;
  /** 输出回显之前要按字面遮掉的串(口令、Basic 头的 base64)。 */
  secrets: string[];
  /** 这次给出去的那一枚和它的来历(认证失败时交回 refreshGitCredential)。 */
  origin?: string;
  credential?: GitCredential;
  providerId?: string;
  /** 提供方说这次暂时取不到(fallback = true):git 自己认证失败时,动作改报这个。 */
  unavailable?: GitCredentialError;
}

const NO_GRANT: GitCredentialGrant = { env: {}, secrets: [] };

/** 给 git 动作用:远端 URL → 要并进子进程环境的东西。没有提供方认领 / 不是 https → 空(行为与现在一致)。
 *  提供方抛 fallback = false 的 GitCredentialError 时原样抛出;其余失败都不外抛。 */
export async function gitCredentialEnv(remoteUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<GitCredentialGrant> {
  const origin = credentialOrigin(remoteUrl);
  if (!origin) return NO_GRANT;
  let unavailable: GitCredentialError | undefined;
  for (const { id, provider } of [...providers]) {
    let credential: GitCredential | null = null;
    try {
      credential = await provider.credentials(origin);
    } catch (e) {
      if (!(e instanceof GitCredentialError)) continue;
      if (!e.fallback) throw e;
      unavailable ??= e;
      continue;
    }
    if (!credential || typeof credential.username !== 'string' || typeof credential.password !== 'string' || !credential.password) continue;
    return { env: gitCredentialConfig(origin, credential, env), secrets: [credential.password, basic(credential)], origin, credential, providerId: id };
  }
  return unavailable ? { env: {}, secrets: [], unavailable } : NO_GRANT;
}

/** 远端拒了 `grant` 里那一枚:让给出它的提供方作废缓存,再取一次。**只取一次** —— 拿回来的还是同一枚 / 取不到时
 *  返回的 grant 里没有 credential,调用方就此停手,不许循环(重取会让别的进程手里的那枚失效,服务端也限次)。 */
export async function refreshGitCredential(remoteUrl: string, grant: GitCredentialGrant, env: NodeJS.ProcessEnv = process.env): Promise<GitCredentialGrant> {
  if (!grant.credential || !grant.origin) return NO_GRANT;
  providers.find((p) => p.id === grant.providerId)?.provider.invalidate?.(grant.origin, grant.credential);
  const next = await gitCredentialEnv(remoteUrl, env);
  if (next.credential && next.credential.username === grant.credential.username && next.credential.password === grant.credential.password) return NO_GRANT;
  return next;
}

/** git 因为认证失败时 stderr 里的样子。经 extraheader 带的凭据被拒(401)之后,git 会回到自己的凭据流程,
 *  撞上 GIT_TERMINAL_PROMPT=0 —— 所以常见的反而是后两种。403(凭据有效、没有这个仓库的权限)不算:重取凭据救不了它。 */
export function isGitAuthFailure(stderr: string): boolean {
  return /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|returned error: 401/i.test(stderr);
}

/** 带着凭据跑的子进程不许开跟踪:`GIT_TRACE*` / `GIT_CURL_VERBOSE` 会把请求头(连同 Authorization)打进 stderr。原地删。
 *  Trace2 还得**显式关**:它的去向也能写在全局配置里(trace2.eventTarget 之类),再配上 trace2.envVars / trace2.configParams
 *  就会把注入的那一项原样记进文件 —— 环境变量压得过配置,置 0 = 这个子进程不记。 */
export function stripGitTraceEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) if (/^GIT_TRACE/i.test(key) || /^GIT_CURL_VERBOSE$/i.test(key)) delete env[key];
  for (const key of ['GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF']) env[key] = '0';
}

/** git 的输出回显 / 进错误 detail 之前:按字面遮掉这次用过的密文,再把任何 `Authorization: <方案> <值>` 的值遮掉。 */
export function scrubGitSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('***');
  return out.replace(/(Authorization:\s*[A-Za-z]+\s+)[^\s'"]+/gi, '$1***');
}

/** 测试用:清空登记表。 */
export function resetGitCredentialProvidersForTest(): void { providers.length = 0; }
