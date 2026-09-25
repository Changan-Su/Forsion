/**
 * 引导安装的命令表与下载页(env:check 登记 → env:run 执行)。纯函数,单测钉死(envInstall.test.ts)。
 *
 * ⚠️ Windows 的 winget 必须带非交互参数。2026-09-25 在 windows-2025 runner 上用 2.11.4 安装版实测:
 *   - 原命令 `winget install Git.Git` + stdin 开着(env:run 当时的样子)→ 卡在 msstore 源协议
 *     「[Y] Yes [N] No:」上**永远不结束**,界面一直转圈(新机器第一次用 winget 必中);
 *   - 同命令 stdin 关掉 → 1 秒内 0x8a150042「Error reading input in prompt」;
 *   - 加下面这组参数 → 47 秒装完 Git,装完 envCheck 立刻认出(Git\cmd 在 envPath 的补全清单里)。
 * `--source winget` 顺带绕开 msstore 源,那份协议根本不会出现。不加 `--disable-interactivity`:它要 winget ≥ 1.4,
 * 更老的 winget 会整条报「参数无法识别」;env:run 已关 stdin,残余的提示照样立刻失败、不会卡住。
 */

export type InstallPlatform = 'darwin' | 'win32' | 'linux'
export type Mirror = 'default' | 'china'

export function wingetInstall(id: string): string {
  return `winget install --id ${id} -e --source winget --accept-source-agreements --accept-package-agreements`
}

const COMMANDS: Record<string, Partial<Record<InstallPlatform, (cn: boolean) => string>>> = {
  node: {
    linux: () => 'sudo apt-get install -y nodejs npm',
    darwin: () => 'brew install node',
    win32: () => wingetInstall('OpenJS.NodeJS.LTS'),
  },
  python3: {
    linux: () => 'sudo apt-get install -y python3 python3-pip',
    darwin: () => 'brew install python',
    win32: () => wingetInstall('Python.Python.3.12'),
  },
  git: {
    linux: () => 'sudo apt-get install -y git',
    darwin: () => 'brew install git',
    win32: () => wingetInstall('Git.Git'),
  },
  docker: {
    // 官方安装脚本原生支持 --mirror Aliyun(中国网络直连 get.docker.com/Docker CDN 极慢)。脚本内部要 root:
    // 写成 `| sudo sh`,界面按「含 sudo → 复制到终端」处理(GUI 子进程没有 tty,跑不了 sudo)。
    linux: (cn) => cn ? 'curl -fsSL https://get.docker.com | sudo sh -s -- --mirror Aliyun' : 'curl -fsSL https://get.docker.com | sudo sh',
    darwin: () => 'brew install --cask docker',
    win32: () => wingetInstall('Docker.DockerDesktop'),
  },
}

export function installCommandFor(tool: string, platform: string, mirror: Mirror): string | null {
  return COMMANDS[tool]?.[platform as InstallPlatform]?.(mirror === 'china') ?? null
}

/** 命令要跑起来必须先有的那个程序(winget / brew / apt-get / curl)。它不在就别给「安装」按钮:
 *  没有 winget 的 Windows(windows-2022 runner 实测)点了只会 `'winget' is not recognized`,没装 Homebrew 的 Mac 同理。 */
export function requiredProgram(command: string): string {
  return command.replace(/^sudo\s+/, '').split(/\s+/)[0]
}

/** 一键装不了(或装得慢)时的手动下载页;中国大陆镜像开着时给 npmmirror 的镜像页。 */
export function downloadUrlFor(tool: string, platform: string, mirror: Mirror): string | null {
  const cn = mirror === 'china'
  switch (tool) {
    case 'node': return cn ? 'https://registry.npmmirror.com/binary.html?path=node/' : 'https://nodejs.org/en/download'
    case 'python3': return cn ? 'https://registry.npmmirror.com/binary.html?path=python/' : 'https://www.python.org/downloads/'
    case 'git': return cn && platform === 'win32' ? 'https://registry.npmmirror.com/binary.html?path=git-for-windows/' : 'https://git-scm.com/downloads'
    case 'docker': return 'https://www.docker.com/products/docker-desktop/'
    default: return null
  }
}
