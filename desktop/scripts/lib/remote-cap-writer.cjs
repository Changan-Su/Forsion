/**
 * 经 K4 的**新写入口**设「远程会话最高审批档」(P1 · K9,INTEGRATION §4.2 C3):tangu-agent 的 live 台架 `--remote-cap <档>` 在起引擎前调它。
 *
 * 走的是真模块、真接线,不自己写 JSON:
 *   registerRemoteSessionsIpc(假 ipc,可信发送方)→ 'remoteSessions:setMaxApprovalMode' 处理器 → createRemoteSessions().setMaxApprovalMode
 *   → deps.writeCap —— 这一跳照抄 main.ts 的接线(`writeCap: (m) => configQueue(() => updateHomeConfig((home) => withRemoteCap(home, m)))`,
 *   updateHomeConfig = configWrite.lockedUpdateJson(join(forsionHomeDir(), 'config.json')))。
 * 路径也是真的:forsionHomeDir() 按 TANGU_HOME 解析(basename 为 tangu → 父目录),与引擎 core/tanguHome.forsionSharedDir() 同一条规则;
 * 引擎 remoteApprovalCap() 读的是 forsionSharedDir()/config.json 的 remote.maxApprovalMode。K4 写错格式 / 写错文件 / 写入 custom,
 * 引擎都会回落 auto-edit —— live 的 remoteclamp 两腿(readonly / full-auto)就会红。
 * 负对照:K9_CAP_NEGCTL=home 把文件换成 <TANGU_HOME>/config.json(2026-09-17 Codex 评审抓过的那种分脑:桌面写 home、引擎读共享域)→ 须红。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTs } = require('./load-ts.cjs')

/**
 * @param {{ tanguHome: string, mode: 'readonly'|'auto-edit'|'full-auto' }} o  tanguHome = 引擎的 TANGU_HOME(台架隔离 home)
 * @returns {Promise<{ file: string, view: object, written: unknown, readBack: string }>}
 */
async function setRemoteCapViaK4({ tanguHome, mode }) {
  const M = loadTs(path.join(__dirname, 'remote-cap-writer.entry.ts'))
  const prevHome = process.env.TANGU_HOME
  process.env.TANGU_HOME = tanguHome
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-k9-cap-'))
  try {
    const file = process.env.K9_CAP_NEGCTL === 'home' ? path.join(tanguHome, 'config.json') : path.join(M.forsionHomeDir(), 'config.json') // = main.ts homeConfigPath()
    const readHomeConfig = async () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
    const configQueue = M.createSerialQueue()
    const rs = M.createRemoteSessions({
      file: () => path.join(userData, M.REMOTE_SESSIONS_FILE),
      unitHostEnabled: async () => false,
      readCap: async () => M.normalizeCap((await readHomeConfig()).remote?.maxApprovalMode),
      writeCap: (m) => configQueue(() => M.lockedUpdateJson(file, (home) => M.withRemoteCap(home, m))),
      accountId: () => null,
      lookupUnit: async () => 'unreachable',
      confirm: async () => null,
      permitted: () => true,
      isLocked: () => false,
      onChanged: () => {},
      log: () => {},
    })
    await rs.init()
    const handlers = new Map()
    M.registerRemoteSessionsIpc({ handle: (ch, fn) => handlers.set(ch, fn) }, rs, () => true)
    const set = handlers.get('remoteSessions:setMaxApprovalMode')
    if (!set) throw new Error('K4 没注册 remoteSessions:setMaxApprovalMode')
    const view = await set({ sender: {} }, mode)
    const written = JSON.parse(fs.readFileSync(file, 'utf8')).remote
    return { file, view, written, readBack: M.normalizeCap(written?.maxApprovalMode) }
  } finally {
    if (prevHome === undefined) delete process.env.TANGU_HOME
    else process.env.TANGU_HOME = prevHome
    fs.rmSync(userData, { recursive: true, force: true })
  }
}

module.exports = { setRemoteCapViaK4 }
