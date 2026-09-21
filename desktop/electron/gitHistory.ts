/**
 * Coding Studio 的 git 版本历史 —— 宿主侧驱动,无 Electron 依赖(纯 node,可直接单测)。
 *
 * 产品口径:版本管理**只对本机装了 git 的用户存在**,没有 git 的界面改为安装建议(available:false)。
 * AI 自己永远不跑 git,提交一律由宿主发起:一轮 agent 改完文件后自动提交(auto),用户命名版本时手动提交(manual)。
 * 恢复绝不丢现场 —— 先把当前工作区提交成备份,再 restore,历史始终线性;
 * 全程不用 reset --hard / clean / checkout -f / stash 这些会把未提交内容蒸发掉的命令。
 *
 * 只读边界:用户自己的仓(foreign)和「项目落在别人仓里」(nested)只列日志,绝不写。
 */
import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, promises as fs, statSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { PRODUCT_SIDECAR } from '../shared/products'
import type { GitHistoryStatus, GitRepoState, GitRestoreSummary, GitVersion } from '../shared/products'

/** env = 调用方补全过 PATH 的环境(主进程的 envWithFullPath);gitPath 是测试/宿主的显式覆盖,null = 假装本机没有 git。 */
export interface GitEnv { env?: NodeJS.ProcessEnv; gitPath?: string | null; owners?: GitOwners }

/**
 * 「这个仓是 Forsion 建的」的**宿主侧**凭据。为什么不能只看 `.git/` 里的标记文件(第一版就是那么干的,Codex 三份评审一致打回):
 * 项目目录不可信 —— 一个解压 / 克隆来的文件夹可以自带标记文件,再配上 `.git/config` 里的 clean filter 与 `.gitattributes`;
 * 标记一认,它就是「我方仓」,下一轮自动 `git add -A` 便执行 filter 里的任意命令(关掉 hooks 管不到 filter)。
 * 现在标记文件里是 init 时发的随机 nonce,**nonce 同时登记在宿主家目录**(由 IPC 层注入的 owners 负责落盘):
 * 两边对得上才算我方仓。外来文件夹猜不出一个登记过的 nonce;项目改名 / 挪位置 nonce 跟着 .git 走,照样认。
 * 没注入 owners = 一律不认(fail closed):只读,也不 init。
 */
export interface GitOwners { has(nonce: string): boolean; add(nonce: string): void }

/**
 * 提交标题里那几个**落盘产物命名**的当前语言文案,由调用方(IPC 层按界面语言)传进来。
 * 为什么不在这里 import i18n:提交标题写下就不可变,渲染期翻译根本不可行;而且本模块要保持
 * 无 Electron / 无前端依赖(纯 node 单测)。英文缺省只是最后一道保险,不是「默认语言」。
 */
export interface GitLabels {
  /** 名字为空时的缺省版本名。 */
  untitled?: string
  /** 恢复前那次「备份现场」提交的标题。 */
  backup?: string
  /** 恢复提交的标题前缀,后面接目标版本的标题(缺省 `Restore:`)。 */
  restorePrefix?: string
}

const MARKER = 'forsion-history'
const READ_TIMEOUT_MS = 5_000
const WRITE_TIMEOUT_MS = 30_000
const MAX_BUFFER = 4 * 1024 * 1024
const MAX_SUBJECT = 120
const SHA = /^[0-9a-f]{7,40}$/
const FULL_SHA = /^[0-9a-f]{40}$/
const RECORD = '\x1e'
const FIELD = '\x1f'
const DEFAULT_UNTITLED = 'Untitled version'
const DEFAULT_BACKUP = 'Backup before restore'
const DEFAULT_RESTORE_PREFIX = 'Restore:'
/** 一次 log 同时拿元数据与改动文件数:%s 放最后,万一 subject 里混进分隔符也只会污染它自己。 */
const LOG_FORMAT = '--format=%x1e%H%x1f%ct%x1f%(trailers:key=Forsion-Version,valueonly)%x1f%s'
/** 固定前缀:不分页、不跑 fsmonitor / 钩子 / 外部 diff、不把 CJK 路径转义成八进制、不给提交签名(全局开了 gpgsign 也不许卡住)。 */
const PREFIX = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false']

/** 这几个环境变量会把 git 整个指到别的仓去 —— GIT_DIR 泄进来时 `init` 会**重新初始化那个外部仓**,
 *  随后 marker 落盘就 ENOENT,报错面也不再是文档承诺的那几条。本模块的仓永远只由 `-C <root>` 决定,所以一律删掉。 */
const SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE']

/** darwin 上 PATH 之外的固定候选,顺序即优先级(新版在前)。 */
const DARWIN_EXTRA = [
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/Library/Developer/CommandLineTools/usr/bin/git',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
]

/** 两个 .forsion-* 边车存着项目身份 / 发布 slug:必须永不被跟踪,否则恢复到早期版本会连它们一起删掉。 */
const CONNECT_SIDECAR = '.forsion-connect.json'
/** 暂存与恢复一律把两个边车排除在 pathspec 之外:`.gitignore` 护不住**已经被跟踪**的文件(agent / 用户 `add -f` 过一次就算),
 *  而恢复到一个没有它的旧提交会把它从磁盘上删掉 —— 产物 id、快捷方式、稳定源一起断。 */
const SIDECAR_EXCLUDES = [`:(exclude,top)${PRODUCT_SIDECAR}`, `:(exclude,top)${CONNECT_SIDECAR}`]
/** 旧快照(codeStudioProjects)由宿主兜底排除的那几类文件名,git 这条路不能反而放行:提交是永久的,之后一 push 就泄露。
 *  判据与那边逐字同源(按分隔符成词,`secretSanta.tsx` 不算,`secrets.json` / `my-credentials.yml` 算)。 */
const SENSITIVE_NAME = /(^|[._-])(secrets?|credentials?|private[-_]?key|service[-_]?account)([._-]|$)/i
const TOKEN_CREDENTIAL = /^(?:(?:access|refresh|auth|oauth|api)[._-])?tokens?(?:[._-](?:cache|credentials|store))?\.(?:jsonc?|ya?ml|toml|txt|ini|conf)$/i
/** 单文件体积闸:自动版本每轮都跑,一个几 GB 的缓存 / 素材进了 `add -A` = 每轮哈希一遍,30s 超时还会留下一地松散对象。 */
const MAX_TRACKED_BYTES = 10 * 1024 * 1024
const NONCE = /^[0-9a-f]{32}$/
const REQUIRED_IGNORES = ['node_modules/', 'dist/', 'build/', 'out/', '.next/', 'coverage/', '.DS_Store', '.env', '.env.*', '!.env.example', '*.pem', '*.key', PRODUCT_SIDECAR, CONNECT_SIDECAR]

/**
 * git 可执行文件的候选表。**纯函数、不碰磁盘** —— 顺序本身就是契约,单测直接钉它
 * (钉 findGit 的返回值是假绿:开发机上第一条候选恒命中,过滤规则删掉照样绿)。
 *
 * darwin 永不收 /usr/bin/git:那是 Apple 的 shim,机器上没装 Command Line Tools 时一跑就弹
 * 「安装开发者工具」系统对话框(用户什么都没点就被弹窗糊脸)。
 * darwin 的顺序 = **新版优先**:PATH(用户自己装的)→ homebrew → /usr/local → CLT → Xcode。
 * 理由:新 git 读得了旧 git 写的仓,反过来读不了 —— CLT 那份 2.39 撞上 reftable 格式的仓直接
 * `fatal: unknown repository extension`。拿一个比用户自己更旧的 git 去读他的仓,只会把好仓判成读不出来。
 */
export function gitCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  if (platform === 'darwin') return [...dirs.filter((dir) => path.resolve(dir) !== '/usr/bin').map((dir) => path.join(dir, 'git')), ...DARWIN_EXTRA]
  // win32 只认最小的两种:PATHEXT 里报了 .EXE / .CMD 才试对应文件名(其余扩展名与 git 无关)。
  const exts = ['.EXE', '.CMD'].filter((ext) => (env.PATHEXT || '.EXE;.CMD').toUpperCase().includes(ext))
  const names = platform === 'win32' ? exts.map((ext) => `git${ext.toLowerCase()}`) : ['git']
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)))
}

/** 找 git 可执行文件。**绝不 spawn** —— 只 existsSync 查文件在不在。 */
export function findGit(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  // 光「路径存在」不够:PATH 里一个叫 git 的目录 / 不可执行文件会让界面报「有 git、可写」,一保存才失败,安装建议也永远不出现。
  return gitCandidates(env, platform).find((file) => {
    try {
      if (!statSync(file).isFile()) return false
      if (platform !== 'win32') accessSync(file, fsConstants.X_OK)
      return true
    } catch { return false }
  }) ?? null
}

interface Run { code: number; stdout: string; stderr: string }
interface Ctx { bin: string; root: string; env?: NodeJS.ProcessEnv; owners?: GitOwners }

/** 非零退出不抛 —— 仓库状态天生靠退出码判(rev-parse / config / cat-file / merge-base)。真失败由调用点用 must() 点名。 */
function run(c: Ctx, timeout: number, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...(c.env ?? process.env), GIT_TERMINAL_PROMPT: '0' }
    for (const key of SCRUBBED_ENV) delete env[key]
    const options = { cwd: c.root, env, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' as const }
    execFile(c.bin, [...PREFIX, '-C', c.root, ...args], options, (error, stdout, stderr) => {
      const code = error ? Number((error as { code?: string | number | null }).code ?? 1) || 1 : 0
      // 起不来(gitPath 过期 / ENOENT)与超时都没有 stderr,只有 error.message —— 别把它丢了,否则报错只剩「exited with 1」。
      resolve({ code, stdout, stderr: stderr || (error?.message ?? '') })
    })
  })
}

const read = (c: Ctx, ...args: string[]): Promise<Run> => run(c, READ_TIMEOUT_MS, args)
const write = (c: Ctx, ...args: string[]): Promise<Run> => run(c, WRITE_TIMEOUT_MS, args)
const out = (r: Run): string => r.stdout.trim()

function must(r: Run, message: string): Run {
  if (r.code !== 0) throw new Error(`${message}: ${r.stderr.trim() || r.stdout.trim() || `git exited with ${r.code}`}`)
  return r
}

/** 信任边界:只接受绝对路径,且 realpath 后必须是真实存在的目录(软链接项目根照样落到真身上)。 */
async function resolveRoot(root: string): Promise<string> {
  if (!root || typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('git history needs an absolute project root')
  const real = await fs.realpath(root).catch(() => { throw new Error(`git history root does not exist: ${root}`) })
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`git history root is not a directory: ${root}`)
  return real
}

async function context(root: string, g?: GitEnv): Promise<Ctx | null> {
  const real = await resolveRoot(root)
  const bin = g?.gitPath !== undefined ? g.gitPath : findGit(g?.env)
  return bin ? { bin, root: real, env: g?.env, owners: g?.owners } : null
}

async function requireGit(root: string, g?: GitEnv): Promise<Ctx> {
  const c = await context(root, g)
  if (!c) throw new Error('git is not installed')
  return c
}

/** 「这两个路径是不是同一个目录」。**不能直接比字符串**:macOS 的 realpath 不规范化大小写,而
 *  `rev-parse --show-toplevel` 给的是磁盘上的真实大小写 —— 只差一个字母的大小写,自家仓就被判成
 *  nested,版本管理从此静默只读。按 dev+ino 认同一个 inode;stat 不到(权限 / 竞态)才退回
 *  大小写不敏感的字符串比(仅 darwin / win32,别的平台大小写是有意义的)。 */
async function sameDir(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false
  if (a === b) return true
  const [sa, sb] = await Promise.all([fs.stat(a).catch(() => null), fs.stat(b).catch(() => null)])
  if (sa && sb) return sa.dev === sb.dev && sa.ino === sb.ino
  return (process.platform === 'darwin' || process.platform === 'win32') && a.toLowerCase() === b.toLowerCase()
}

/**
 * rev-parse 读不出来时的兜底判定:从项目根一路向上找 `.git` 条目(目录与 gitfile 都算)。
 * 命中在项目根 → foreign,命中在祖先 → nested,一直到文件系统根都没有 → 真的 none。
 *
 * 读不出来的原因五花八门:safe.directory 的 dubious ownership、指向已删 worktree 的 gitfile、
 * 我们这份 git 比用户的旧(读不了 reftable 之类的新格式)、大仓 rev-parse 撞上 5s 读超时……
 * 但结论只有一个:**这里有仓,而我们读不动** → 一律按只读处理。
 * 否则 status 先回 none → 界面算出 writable → 用户一点保存就在自己的仓里 `git init` + `add -A`,
 * 契约第一条「never init a nested repo」当场破功。
 * **绝不去匹配 git 的 "not a git repository" stderr** —— 那句话是 gettext 本地化的,中文 git 下根本对不上。
 */
function scanForRepo(root: string): GitRepoState {
  let dir = root
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir === root ? 'foreign' : 'nested'
    const parent = path.dirname(dir)
    if (parent === dir) return 'none'
    dir = parent
  }
}

/** toplevel 先判:失败 = 交给 scanForRepo 兜底。toplevel ≠ 项目根 = 项目寄居在别人的仓里(只读,绝不在里面再 init 一个)。 */
async function repoState(c: Ctx): Promise<GitRepoState> {
  const top = await read(c, 'rev-parse', '--show-toplevel')
  if (top.code !== 0) return scanForRepo(c.root)
  const real = await fs.realpath(out(top)).catch(() => '')
  if (!(await sameDir(real, c.root))) return 'nested'
  return (await ownedNonce(c)) ? 'owned' : 'foreign'
}

/** 标记文件里的 nonce 且宿主登记过 → 返回它;否则 null。读不到 / 形状不对 / 没注入 owners 一律 null(= 按用户自己的仓,只读)。 */
async function ownedNonce(c: Ctx): Promise<string | null> {
  if (!c.owners) return null
  const nonce = (await fs.readFile(path.join(c.root, '.git', MARKER), 'utf8').catch(() => '')).trim()
  return NONCE.test(nonce) && c.owners.has(nonce) ? nonce : null
}

/** 提交标题必须是单行:控制字符(含换行)折成空格再压空白,超长截断,空标题给缺省名。
 *  按码点截断,不按 UTF-16 单元 —— 否则正好切在 emoji 中间会留下半个代理对,提交信息里变成 U+FFFD。 */
function sanitizeSubject(name: string, fallback: string = DEFAULT_UNTITLED): string {
  const line = String(name ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(line).slice(0, MAX_SUBJECT).join('').trim() || fallback
}

/** 调用方传进来的文案照样要过一遍标题清洗(它最终也要落进提交标题);清洗后为空就退回英文缺省。 */
const labelOr = (value: string | undefined, fallback: string): string => sanitizeSubject(value ?? '', fallback)

/** 记录形如 `<sha>\x1f<ct>\x1f<trailer>\x1f<subject>\n\n 3 files changed, …`;subject 单行,其后全是 shortstat。 */
function parseVersions(stdout: string): GitVersion[] {
  return stdout.split(RECORD).slice(1).map((record) => {
    const fields = record.split(FIELD)
    const tail = fields.slice(3).join(FIELD)
    const cut = tail.indexOf('\n')
    return {
      id: (fields[0] ?? '').trim(),
      createdAt: Number(fields[1]) * 1000,
      auto: (fields[2] ?? '').trim() === 'auto',
      name: (cut < 0 ? tail : tail.slice(0, cut)).trim() || DEFAULT_UNTITLED,
      // ponytail: merge 提交 shortstat 为空 → files 记 0(只读的外来仓才会有 merge,不值得为它跑 diff-tree)。
      files: Number(/(\d+)\s+files? changed/.exec(cut < 0 ? '' : tail.slice(cut))?.[1] ?? 0),
    }
  }).filter((v) => FULL_SHA.test(v.id) && Number.isFinite(v.createdAt))
}

/** --root 让首个提交也报得出文件数(git 2.50 已是缺省,留着兜老版本);--no-renames 省掉改名检测,大仓快得多。
 *  空仓(还没有任何提交)的 log 退出 128 → 空列表,不当错误。
 *  ponytail: 读命令统一 5s 超时;超大外来仓的 log 若超时就退化成空列表(界面显示「暂无版本」),不做分页续读。 */
async function versions(c: Ctx, args: string[]): Promise<GitVersion[]> {
  const r = await read(c, 'log', '--root', '--shortstat', '--no-renames', '--no-color', LOG_FORMAT, ...args)
  return r.code === 0 ? parseVersions(r.stdout) : []
}

/**
 * 只发生在我们自己 init 的仓里:没有 .gitignore 就整份写,已有就**只补缺的几行**并挂在 `# Forsion` 标题下,
 * 绝不改写 / 重排用户(或 agent)已经写下的行 —— 那是他们的文件,我们只是搭个便车。
 */
async function seedIgnore(root: string): Promise<void> {
  const file = path.join(root, '.gitignore')
  const current = await fs.readFile(file, 'utf8').catch((e) => { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return ''; throw e })
  const have = new Set(current.split(/\r?\n/).map((line) => line.trim()))
  const missing = REQUIRED_IGNORES.filter((line) => !have.has(line))
  if (!missing.length) return
  const head = current ? `${current}${current.endsWith('\n') ? '' : '\n'}\n` : ''
  await fs.writeFile(file, `${head}# Forsion\n${missing.join('\n')}\n`, 'utf8')
}

/** 标记文件住在 .git 里(永不被跟踪),内容是一个随机 nonce;**同一个 nonce 登记进宿主家目录**才算数(见 GitOwners)。
 *  标记紧跟 init 落盘、随即登记:万一后面哪一步失败(磁盘满 / 怪文件系统),留下的是「我方仓,配置还没补齐」——
 *  配置那几步是幂等的,每次写之前都会再确保一遍(ensureSetup),不会因为上次死在半路就带着缺口提交。 */
async function initRepo(c: Ctx): Promise<void> {
  if (!c.owners) throw new Error('read-only repository') // 没有宿主侧登记处就不建仓:建了也认不回来
  must(await write(c, 'init'), 'git init failed')
  const nonce = randomBytes(16).toString('hex')
  await fs.writeFile(path.join(c.root, '.git', MARKER), `${nonce}\n`, 'utf8')
  c.owners.add(nonce)
  must(await write(c, 'symbolic-ref', 'HEAD', 'refs/heads/main'), 'git could not set the default branch')
}

/** 每次往我方仓里写之前都跑一遍,全部幂等:上一次 init 死在半路(标记已落、`.gitignore` 没写成)时,
 *  下一次不能因为「已经是 owned」就跳过 —— 那样 `add -A` 会把 `.env`、密钥、两个边车一起提交进去。 */
async function ensureSetup(c: Ctx): Promise<void> {
  must(await write(c, 'config', 'core.autocrlf', 'false'), 'git could not write the repository config')
  await seedIgnore(c.root)
  // 边车若已被跟踪(有人 add -f 过):从索引里摘掉、磁盘上留着。之后它们既被忽略又不在 pathspec 里,恢复再也碰不到。
  await write(c, 'rm', '--cached', '--ignore-unmatch', '-q', '--', PRODUCT_SIDECAR, CONNECT_SIDECAR)
  await excludeRisky(c)
}

/** 未跟踪文件里名字像凭据的、单个超过体积闸的,写进 `.git/info/exclude`(精确路径、逐字转义)后 `add -A` 自然跳过。
 *  放 info/exclude 而不是 .gitignore:那是宿主的兜底策略,不该出现在用户的项目文件里,也不该被 agent 顺手改掉。
 *  ponytail: 已经被跟踪的文件不回头追(它们进历史时是干净的名字 / 体积);只看新冒出来的。 */
async function excludeRisky(c: Ctx): Promise<void> {
  const listed = await read(c, 'ls-files', '--others', '--exclude-standard', '-z')
  if (listed.code !== 0) return
  const risky: string[] = []
  for (const rel of listed.stdout.split('\0')) {
    if (!rel) continue
    const name = path.posix.basename(rel).toLowerCase()
    let drop = rel.split('/').some((part) => SENSITIVE_NAME.test(part)) || TOKEN_CREDENTIAL.test(name) || name === 'auth.json' || name === 'auth.toml'
    if (!drop) drop = await fs.stat(path.join(c.root, rel)).then((st) => st.size > MAX_TRACKED_BYTES, () => false)
    if (drop) risky.push(rel)
  }
  if (!risky.length) return
  const file = path.join(c.root, '.git', 'info', 'exclude')
  await fs.mkdir(path.dirname(file), { recursive: true })
  // gitignore 语法里的通配符与前导 `!` / `#` 都要转义;前缀 `/` 钉在仓根,只匹配这一条路径。
  const lines = risky.map((rel) => `/${rel.replace(/[\\*?\[\]!# ]/g, (ch) => `\\${ch}`)}`)
  await fs.appendFile(file, `${lines.join('\n')}\n`, 'utf8')
}

/** 用户自己的身份优先;一条都没配过时(git 会直接拒绝提交)才临时补,且 -c 只作用于这一条命令,不写进仓配置。 */
async function identityArgs(c: Ctx): Promise<string[]> {
  const args: string[] = []
  if (!out(await read(c, 'config', 'user.email'))) args.push('-c', 'user.email=forsion@localhost')
  if (!out(await read(c, 'config', 'user.name'))) args.push('-c', 'user.name=Forsion')
  return args
}

async function doCommit(c: Ctx, input: { name: string; auto: boolean; labels?: GitLabels }): Promise<GitVersion | null> {
  // none 与 owned 之外一律只读。「有仓但读不出来」已经在 repoState 里被折成 foreign / nested,
  // 所以这里不再需要单独一条 'unreadable repository' 守卫(它只守 doCommit,status 早就先放行了)。
  const state = await repoState(c)
  if (state !== 'none' && state !== 'owned') throw new Error('read-only repository')
  if (state === 'none') await initRepo(c)
  await ensureSetup(c)
  // 暂存不用给边车写排除 pathspec:ensureSetup 刚确保过它们「被忽略 + 不在索引里」,`add -A` 本来就碰不到
  // (而且 pathspec 里点名一个被忽略的路径,git 会直接报错拒绝)。排除 pathspec 留给 restore 用。
  must(await write(c, 'add', '-A'), 'git could not stage the project files')
  // add 之后仍然干净 = 真没东西可提(新 init 的仓只要有文件,这里必然非空)。
  if (out(must(await read(c, 'status', '--porcelain'), 'git could not read the working tree')) === '') return null
  const subject = sanitizeSubject(input.name, labelOr(input.labels?.untitled, DEFAULT_UNTITLED))
  const trailer = `Forsion-Version: ${input.auto ? 'auto' : 'manual'}`
  must(await write(c, ...(await identityArgs(c)), 'commit', '-m', subject, '-m', trailer), 'git commit failed')
  // 提交已经落盘 —— 从这里往后**绝不允许再回 null**。null 的契约含义是「工作区没东西可提」,
  // 到了 restore 那边 backupId:null 更被界面读成「现场本来就干净,没做备份」:用户刚被恢复覆盖掉现场,
  // 却被告知没有备份点,唯一的退路就这么被藏起来了。
  // sha 用 rev-parse HEAD 拿(不碰 index,快且稳);详情(时间 / 文件数)读不出来(大仓 log 撞 5s 超时)
  // 就按输入补一条最小回执,而不是把整条回执丢掉。
  const id = out(must(await read(c, 'rev-parse', 'HEAD'), 'git could not read the new commit'))
  const detail = (await versions(c, ['-n', '1']))[0]
  return detail && detail.id === id ? detail : { id, name: subject, createdAt: Date.now(), auto: input.auto, files: 0 }
}

async function doRestore(c: Ctx, id: string, labels?: GitLabels): Promise<GitRestoreSummary> {
  if (await repoState(c) !== 'owned') throw new Error('read-only repository')
  if (!SHA.test(id)) throw new Error('invalid version id')
  if ((await read(c, 'cat-file', '-e', `${id}^{commit}`)).code !== 0) throw new Error('version not found')
  // 只许往自己这条历史的祖先上退:别的分支 / 别人塞进来的提交一律拒绝。
  if ((await read(c, 'merge-base', '--is-ancestor', id, 'HEAD')).code !== 0) throw new Error('version is not part of this history')
  // 目标标题读不出来就**在动手之前**停下 —— 硬走下去只会在历史里永久留下一个光秃秃的「Restore:」。
  const subject = out(must(await read(c, 'log', '-1', '--format=%s', id), 'git could not read the version'))
  // ① 先把现场(含未提交改动)封成一个自动版本 —— 恢复之后用户还能原路退回来。
  const backup = await doCommit(c, { name: labelOr(labels?.backup, DEFAULT_BACKUP), auto: true, labels })
  // ② no-overlay(缺省):目标里没有的**已跟踪**文件会被删掉;被忽略的 .env / 边车是未跟踪的,动不到。
  //    两个边车不在 pathspec 里:即便某个旧提交跟踪过它们,恢复也不许把产物身份换掉 / 删掉。
  must(await write(c, 'restore', `--source=${id}`, '--staged', '--worktree', '--', '.', ...SIDECAR_EXCLUDES), 'git restore failed')
  // ③ 恢复动作本身也是一个提交:历史只增不改,永远线性。
  const restored = await doCommit(c, { name: `${labelOr(labels?.restorePrefix, DEFAULT_RESTORE_PREFIX)} ${subject}`, auto: false, labels })
  return { backupId: backup?.id ?? null, restoreId: restored?.id ?? null }
}

/** 同一项目根上的写操作串行化 —— 并发 add / commit 会在 .git/index.lock 上互撞(一方直接报错退出)。 */
const queues = new Map<string, Promise<unknown>>()
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(task, task)
  const guard: Promise<unknown> = result.catch(() => {}).then(() => { if (queues.get(key) === guard) queues.delete(key) })
  queues.set(key, guard)
  return result
}

/** 没有 git 时静默降级:available:false,且一个进程都不 spawn(界面据此改成安装建议)。 */
export async function gitHistoryStatus(root: string, g?: GitEnv): Promise<GitHistoryStatus> {
  const c = await context(root, g)
  if (!c) return { available: false, state: 'none', dirty: false }
  const state = await repoState(c)
  if (state === 'none') return { available: true, state, dirty: false }
  // ⚠️不是我方的仓就**不跑 status**:status 要拿工作区文件跟索引比内容,比之前会先过 clean filter ——
  // 外来仓的 `.git/config` + `.gitattributes` 能借这一步执行任意命令。只读档本来也用不上 dirty(界面不给保存)。
  if (state !== 'owned') return { available: true, state, dirty: false }
  const status = await read(c, 'status', '--porcelain')
  return { available: true, state, dirty: status.code === 0 && out(status) !== '' }
}

/** 新的在前。外来 / 寄居的只读仓照样列日志,只有「没有仓」和「没有 git」才是空列表。
 *  ponytail: nested 时列的是宿主仓的整条日志,不按项目子目录收窄 —— 加 `-- .` 会顺带触发 history simplification,
 *  把「没碰这个子目录」的提交整条吞掉,对只读展示来说更糊涂;要收窄等产品真提需求再说。 */
export async function listGitVersions(root: string, g?: GitEnv, limit = 200): Promise<GitVersion[]> {
  // 要 0 条就给 0 条:以前的 Math.max(1, …) 会把 limit:0 悄悄变成 1 条,分页调用方拿到多余的一行。
  const take = Math.floor(limit)
  if (!Number.isFinite(take) || take < 1) return []
  const c = await context(root, g)
  if (!c || await repoState(c) === 'none') return []
  return versions(c, ['-n', String(take)])
}

/** 返回 null = 工作区没有任何改动,这一轮不产生版本(提交一旦落盘就绝不会是 null)。只读仓抛 'read-only repository'。 */
export async function commitGitVersion(root: string, input: { name: string; auto: boolean; labels?: GitLabels }, g?: GitEnv): Promise<GitVersion | null> {
  const c = await requireGit(root, g)
  return enqueue(c.root, () => doCommit(c, input))
}

export async function restoreGitVersion(root: string, id: string, g?: GitEnv, labels?: GitLabels): Promise<GitRestoreSummary> {
  const c = await requireGit(root, g)
  return enqueue(c.root, () => doRestore(c, id, labels))
}
