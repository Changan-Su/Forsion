/**
 * 手机页构建缓存戳的自测(P1 · K9 评审 P1)—— `node scripts/lib/phone-dist-stamp.selftest.cjs`,几秒,不构建。
 * 钉住:源码不变 → 复用;改一个已跟踪文件(desktop/frontend 里的一行)/ 加一个未跟踪文件 / 同一文件改第二次 → 都判「源码变了」重建;
 * 改回原样 → 戳回到原值;别的 GENESIS(兄弟 worktree)的构建 → 不复用;缺省缓存目录按 GENESIS 分开。
 * 改动只落在本 worktree、finally 里按字节写回(不用 git checkout 复原),结束时核对 git diff 为空。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { phoneDistStamp, phoneDistStatus, defaultPhoneDistDir } = require('./phone-page.cjs')
const { GENESIS } = require('./remote-world.cjs')

let fails = 0
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`) }

const TRACKED = path.join(GENESIS, 'desktop/frontend/src/services/backendService.ts')
const UNTRACKED = path.join(GENESIS, `desktop/frontend/src/.k9-stamp-probe-${process.pid}.ts`)
const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-k9-stamp-'))
const original = fs.readFileSync(TRACKED)
const cleanBefore = spawnSync('git', ['-C', GENESIS, 'diff', '--quiet', '--', TRACKED]).status === 0
try {
  const s0 = phoneDistStamp()
  check('算得出源码戳(git 可用)', typeof s0 === 'string' && s0.length === 64, s0)
  check('同一棵源码两次算出同一个戳', phoneDistStamp() === s0)
  // 假构建:index.html + forsion-native.json + 当前戳
  fs.writeFileSync(path.join(fake, 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(fake, 'forsion-native.json'), JSON.stringify({ apiBase: 'http://phone-hub.test/api' }))
  check('无戳的构建(来历不明)→ 不复用', phoneDistStatus(fake).reuse === false, phoneDistStatus(fake).reason)
  fs.writeFileSync(path.join(fake, '.k9-stamp.json'), JSON.stringify({ stamp: s0, genesis: GENESIS, head: 'x' }))
  check('戳一致 → 复用', phoneDistStatus(fake).reuse === true, phoneDistStatus(fake).reason)

  fs.appendFileSync(TRACKED, '\n// k9 stamp probe 1\n')
  const s1 = phoneDistStamp()
  const st1 = phoneDistStatus(fake)
  check('改 desktop/frontend 里一个已跟踪文件 → 戳变、判重建', s1 !== s0 && st1.reuse === false && /源码变了/.test(st1.reason), st1.reason)
  fs.appendFileSync(TRACKED, '// k9 stamp probe 2\n')
  check('同一文件改第二次(porcelain 状态不变)→ 戳又变', phoneDistStamp() !== s1)
  fs.writeFileSync(TRACKED, original)
  check('按字节写回 → 戳回到原值', phoneDistStamp() === s0)

  fs.writeFileSync(UNTRACKED, 'export const k9 = 1\n')
  const s2 = phoneDistStamp()
  check('加一个未跟踪文件 → 戳变', s2 !== s0)
  fs.writeFileSync(UNTRACKED, 'export const k9 = 2\n')
  check('未跟踪文件改内容 → 戳变', phoneDistStamp() !== s2)
  fs.rmSync(UNTRACKED, { force: true })
  check('删掉未跟踪文件 → 戳回到原值', phoneDistStamp() === s0)

  fs.writeFileSync(path.join(fake, '.k9-stamp.json'), JSON.stringify({ stamp: 'f'.repeat(64), genesis: '/elsewhere/.worktrees/p1-k6', head: 'y' }))
  const st3 = phoneDistStatus(fake)
  check('别的 worktree 建的构建 → 不复用', st3.reuse === false && /p1-k6/.test(st3.reason), st3.reason)
  check('缺省缓存目录按 GENESIS 分开(不再是共享的 forsion-remotechain-dist)', /forsion-remotechain-dist-[0-9a-f]{12}$/.test(defaultPhoneDistDir()), defaultPhoneDistDir())
} finally {
  fs.writeFileSync(TRACKED, original)
  fs.rmSync(UNTRACKED, { force: true })
  fs.rmSync(fake, { recursive: true, force: true })
}
if (cleanBefore) check('收尾后被改过的已跟踪文件与 HEAD 一致', spawnSync('git', ['-C', GENESIS, 'diff', '--quiet', '--', TRACKED]).status === 0)
console.log(fails ? `\n${fails} 条 FAIL` : '\n全部通过')
process.exit(fails ? 1 : 0)
