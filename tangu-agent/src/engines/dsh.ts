/**
 * DeepSeek Harness(dsh)外部引擎的落地文件 + 引擎定义。
 *
 * 与 claude-code/codex/openclaw/pi 不同,DSH 的 ACP 服务端(`@deepseek-ai/dsh-acp-demo`)不是一个自洽 CLI,
 * 而是一份 **cordis 插件组合**:它把 LLM/沙箱/bash/文件/审批等能力都交给同目录下的兄弟包提供,
 * 靠 loader 按包名从**自己所在的 node_modules** 解析。实测 `npx -y @deepseek-ai/dsh-acp-demo` 必然失败
 * (npx 缓存目录里只有它自己,`Cannot find package '@deepseek-ai/dsh-bash-sandbox'`),
 * 所以必须有一个装齐了兄弟包的真实目录。
 *
 * 做法:在 ~/.tangu/engines/dsh/ 落 package.json + cordis.yml + README(仅当缺失,不覆盖用户改动),
 * 用户跑一次 `npm install` 即可;启动走 `npm --prefix <dir> exec -- dsh-acp-demo -c <dir>/cordis.yml`
 * ——npm 负责跨平台 bin shim,且 exec 保留调用方 cwd(=Tangu 会话 cwd,cordis.yml 里的沙箱根据此解析)。
 * 未 install 前 detect 落到 not-installed → 新建会话的引擎选择条不列它,设置页显示 setup 命令。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tanguHome } from '../core/tanguHome.js';
import type { EngineDef } from './config.js';

/** DSH 引擎目录(装兄弟包 + 放 cordis.yml)。随 TANGU_HOME 走,故按调用时求值而非模块常量。 */
export function dshDir(): string {
  return path.join(tanguHome(), 'engines', 'dsh');
}

/** 经实测能起 ACP(initialize + session/new 均通)的最小可用组合所需的包。版本随 dsh 的 next 通道。 */
const PACKAGE_JSON = `{
  "name": "tangu-dsh-engine",
  "private": true,
  "type": "module",
  "dependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/cordis-plugin-include": "^1.0.6",
    "@deepseek-ai/cordis-plugin-loader": "^1.0.2",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@deepseek-ai/dsh-acp": "next",
    "@deepseek-ai/dsh-acp-demo": "next",
    "@deepseek-ai/dsh-agent-instructions": "next",
    "@deepseek-ai/dsh-agent-spine-demo": "next",
    "@deepseek-ai/dsh-app-boot": "next",
    "@deepseek-ai/dsh-bash-sandbox": "next",
    "@deepseek-ai/dsh-compaction-basic": "next",
    "@deepseek-ai/dsh-fs-observation-policy": "next",
    "@deepseek-ai/dsh-fs-sandbox": "next",
    "@deepseek-ai/dsh-invariants": "next",
    "@deepseek-ai/dsh-llm-deepseek": "next",
    "@deepseek-ai/dsh-sandbox-local": "next",
    "@deepseek-ai/dsh-sandbox-policy": "next",
    "@deepseek-ai/dsh-session-checkpoint-policy": "next",
    "@deepseek-ai/dsh-session-persistence-jsonl": "next",
    "@deepseek-ai/dsh-session-query": "next",
    "@deepseek-ai/dsh-session-query-sqlite": "next",
    "@deepseek-ai/dsh-subprocess-local": "next",
    "@deepseek-ai/dsh-token-meter": "next",
    "@deepseek-ai/dsh-tool-fs": "next",
    "@deepseek-ai/dsh-tools": "next",
    "@deepseek-ai/dsh-user-approval": "next"
  }
}
`;

// !!js 由 dsh 的 loader 求值;process.cwd() = 本次 run 的 Tangu 会话 cwd(spawnEngine 传 cwd),
// 沙箱根与 fs 根据此落在会话工作区上,而不是引擎目录。
// ⚠ persistenceRoot 与上面相反,必须是绝对路径:留相对(上游默认 './.sessions')的话每次 run 都会在
// **用户的项目目录**里拉出 .sessions/ 与 session-query.db,并被顺手 git add。种文件时就写死引擎目录下的
// 绝对路径(JSON 字符串同时是合法 YAML,顺带处理 Windows 反斜杠转义)。
const cordisYml = (dir: string): string => `# Tangu 拉起 DeepSeek Harness(ACP)所用的组合。可自行增删插件(改模型改这里的 model 一行)。
# 完整可选项见 https://github.com/deepseek-ai/deepseek-harness examples/acp-agent/cordis.yml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    models:
      - id: deepseek-v4-flash
      - id: deepseek-v4-pro
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.cwd()
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  config:
    timeoutMs: 60000
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: !!js process.cwd()
- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.08
    maxTokens: 8192
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    persistenceRoot: ${JSON.stringify(path.join(dir, 'sessions'))}
    workspaceContext:
      maxBytes: 65536
    persona: |
      You are a coding assistant powered by the {{model}} model. Your working directory is {{cwd}}. Your bash tool runs under a file sandbox — a \`[sandbox: file access denied …]\` result is policy, not a command bug.

      Verify your work by running the code or tests. Keep answers brief and factual.
`;

const README = `# DeepSeek Harness 引擎(Tangu 外部引擎)

启用两步:

    cd ~/.tangu/engines/dsh && npm install      # 装齐 dsh 的 cordis 插件(约 90 个包)
    echo 'DEEPSEEK_API_KEY=sk-...' >> ~/.tangu/.env

装完重启 Tangu,新建会话的引擎选择条上就会出现「DeepSeek Harness」。

- 换模型:改 \`cordis.yml\` 里 \`acp-agent.config.model\`(v4-flash / v4-pro)。引擎选择条上不提供模型下拉
  ——DSH 的 ACP 是 automation-only,不通过协议广播可选模型。
- 加/减能力(子代理、workflow、hooks、todo…):往 \`cordis.yml\` 里按上游 examples/acp-agent/cordis.yml 加条目,
  并把对应包加进 \`package.json\` 后重跑 \`npm install\`。
- 升级:\`npm update\`(依赖钉在 \`next\` 通道,dsh 尚在 rc)。
- 本目录里的三个文件只在缺失时由 Tangu 生成,不会覆盖你的改动;想恢复默认删掉重启即可。
`;

/** 幂等落盘(仅当文件缺失)。装没装 node_modules 是用户的事——引擎检测据此显隐。 */
export function seedDshFiles(): void {
  const dir = dshDir();
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of [['package.json', PACKAGE_JSON], ['cordis.yml', cordisYml(dir)], ['README.md', README]] as const) {
      const f = path.join(dir, name);
      if (!existsSync(f)) writeFileSync(f, body, 'utf-8');
    }
  } catch (e: any) {
    console.warn('[engines] 生成 dsh 引擎目录失败:', e?.message || e);
  }
}

/**
 * DSH 引擎定义。detect 只认 node_modules——文件是我们自己种的,种了不等于能跑,唯一有意义的信号是装没装。
 * models/commands 静态声明为空:DSH 的 ACP 不广播模型/命令,声明空即跳过每次 spawn 探测(见 manager.capabilities)。
 */
export function dshEngineDef(): EngineDef {
  const dir = dshDir();
  return {
    id: 'dsh',
    name: 'DeepSeek Harness',
    command: 'npm',
    // ponytail: Windows 上 spawnEngine 用 shell:true 且 Node 在 shell 模式下不给 args 加引号 → 家目录含空格
    // (C:\\Users\\John Smith\\…)会把命令行切断。首个带路径参数的引擎,是新天花板不是回归;真修就得在
    // spawnEngine 里按平台做引号包装,等有 Windows 机器实测再动。
    args: ['--prefix', dir, 'exec', '--', 'dsh-acp-demo', '-c', path.join(dir, 'cordis.yml')],
    models: [],
    commands: [],
    detect: { dirs: [path.join(dir, 'node_modules')] },
    setup: `cd ~/.tangu/engines/dsh && npm install`,
  };
}
