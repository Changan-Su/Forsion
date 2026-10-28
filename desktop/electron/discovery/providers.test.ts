/**
 * 导入本机配置:临时家目录里放 CC Switch 数据库、Claude Code settings.json、Codex config.toml,走真 scan / 取。
 * 钉住:key 不出现在给渲染端的那份里;只写了 env_key 的、指回 Forsion 的跳过;同一条只列一次;已有的标 exists;
 * 取的时候不和订阅登录派生的 provider 抢名字。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localProvidersFor, scanLocalProviders } from './providers'

const RELAY_KEY = 'sk-relay-0123456789abcdef3f2a'
const DS_KEY = 'sk-deepseek-abcdef0123458c1d'
const CODEX_KEY = 'sk-codex-inline-99887766aa11'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'imp-home-'))
  const claudeDir = join(home, 'claude-cfg')
  await mkdir(claudeDir, { recursive: true })
  await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example.com/', ANTHROPIC_AUTH_TOKEN: RELAY_KEY, ANTHROPIC_MODEL: 'claude-sonnet-5' } }))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'config.toml'), [
    'model_provider = "mine"', 'model = "gpt-6-luna"',
    '[model_providers.mine]', 'name = "My relay"', 'base_url = "https://codex.example.org/v1"', `experimental_bearer_token = "${CODEX_KEY}"`,
    '[model_providers.envonly]', 'base_url = "https://env.example.org/v1"', 'env_key = "ENV_ONLY_KEY"', 'wire_api = "chat"',
    '[model_providers.back]', 'base_url = "https://api.forsion.net/v1"', 'experimental_bearer_token = "sk-forsion-should-skip"',
  ].join('\n'))
  await mkdir(join(home, '.cc-switch'), { recursive: true })
  const { DatabaseSync } = await import('node:sqlite' as string) as any
  const db = new DatabaseSync(join(home, '.cc-switch', 'cc-switch.db'))
  db.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, sort_index INTEGER, created_at INTEGER)')
  const ins = db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?)')
  ins.run('1', 'claude', 'DeepSeek', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: DS_KEY } }), 0, 1)
  ins.run('2', 'claude', 'Official', JSON.stringify({ env: {} }), 1, 2) // Claude 自己的登录:跳过
  ins.run('3', 'claude', 'Relay (current)', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example.com', ANTHROPIC_AUTH_TOKEN: RELAY_KEY, ANTHROPIC_MODEL: 'claude-sonnet-5' } }), 2, 3)
  ins.run('4', 'codex', 'Codex chat relay', JSON.stringify({ auth: { OPENAI_API_KEY: 'sk-cc-codex-1234567890' }, config: 'model_provider = "x"\nmodel = "m1"\n[model_providers.x]\nbase_url = "https://cx.example.net/v1"\nwire_api = "chat"\n' }), 0, 4)
  db.close()
  return { home, env: { CLAUDE_CONFIG_DIR: claudeDir } as NodeJS.ProcessEnv }
}

describe('导入本机配置', () => {
  it('列出三处能导入的连接,不带 key;跳过 env_key、指回 Forsion、Claude 自己的登录;同一条只列一次', async () => {
    const { home, env } = await fixture()
    const list = await scanLocalProviders([], { home, env })
    expect(JSON.stringify(list)).not.toContain(RELAY_KEY.slice(0, -4))
    expect(list.map((c) => [c.source, c.name, c.host, c.keyTail])).toEqual([
      ['cc-switch', 'DeepSeek', 'api.deepseek.com', '8c1d'],
      ['cc-switch', 'Relay (current)', 'relay.example.com', '3f2a'],
      ['cc-switch', 'Codex chat relay', 'cx.example.net', '7890'],
      ['codex', 'My relay', 'codex.example.org', 'aa11'],
    ].map(([s, n, h, k]) => [s, n, h, k]))
  })

  it('已经在 Forsion 里的(地址和 key 都一样)标 exists,取的时候也不重复加', async () => {
    const { home, env } = await fixture()
    const existing = [{ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic/', apiKey: DS_KEY }]
    const list = await scanLocalProviders(existing, { home, env })
    expect(list.find((c) => c.name === 'DeepSeek')?.exists).toBe(true)
    expect(await localProvidersFor(list.map((c) => c.id), existing, { home, env })).not.toContainEqual(expect.objectContaining({ apiKey: DS_KEY }))
  })

  it('取出来的连接带协议、模型和不撞名的 id', async () => {
    const { home, env } = await fixture()
    const list = await scanLocalProviders([], { home, env })
    const pick = (n: string) => list.find((c) => c.name === n)!.id
    const got = await localProvidersFor([pick('DeepSeek'), pick('Codex chat relay'), pick('My relay')], [{ providerId: 'deepseek', baseUrl: 'https://other', apiKey: 'x' }], { home, env })
    expect(got).toEqual([
      { providerId: 'deepseek-2', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: DS_KEY, protocol: 'anthropic-messages' },
      { providerId: 'codex-chat-relay', baseUrl: 'https://cx.example.net/v1', apiKey: 'sk-cc-codex-1234567890', modelIds: ['m1'] },
      { providerId: 'my-relay', baseUrl: 'https://codex.example.org/v1', apiKey: CODEX_KEY, modelIds: ['gpt-6-luna'], protocol: 'openai-responses' },
    ])
  })

  it('CC Switch 里坏掉的行只跳那一行:null、坏 JSON、坏 TOML 不当成官方 OpenAI', async () => {
    const { home, env } = await fixture()
    const { DatabaseSync } = await import('node:sqlite' as string) as any
    const db = new DatabaseSync(join(home, '.cc-switch', 'cc-switch.db'))
    const ins = db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?)')
    ins.run('5', 'claude', 'Null', 'null', 0, 0)
    ins.run('6', 'claude', 'Broken', '{not json', 0, 0)
    ins.run('7', 'codex', 'Bad toml', JSON.stringify({ auth: { OPENAI_API_KEY: 'sk-bad-toml-1234567890' }, config: 'model_provider = "x\n[[[' }), 0, 0)
    db.close()
    const list = await scanLocalProviders([], { home, env })
    expect(list.map((c) => c.name)).toEqual(['DeepSeek', 'Relay (current)', 'Codex chat relay', 'My relay'])
  })

  it('配置改了(换了 key)就是新的一条:id 跟着变', async () => {
    const { home, env } = await fixture()
    const before = (await scanLocalProviders([], { home, env })).find((c) => c.source === 'cc-switch')!.id
    expect((await scanLocalProviders([], { home, env })).some((c) => c.source === 'claude-code')).toBe(false) // 和 CC Switch 那条是同一个连接
    await writeFile(join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-relay-rotated-000000001111' } }))
    const now = await scanLocalProviders([], { home, env })
    expect(now.find((c) => c.source === 'claude-code')?.keyTail).toBe('1111')
    expect(now.find((c) => c.source === 'cc-switch')!.id).toBe(before)
  })
})
