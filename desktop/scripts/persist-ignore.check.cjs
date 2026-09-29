// 台架跳过「重新打开窗口」仪器:证 main.ts 的 registerDefaults({ ApplePersistenceIgnoreState }) 被 AppKit 读到了。
// 背景:台架与 dev 共用 com.github.Electron,它崩过后 AppKit 在 _handleAEOpenEvent 里弹 NSAlert,ready 永不来 → 台架挂死。
// 那个框没法按需复现(崩溃历史怎么攒上的 09-28 没摸清),所以不看框,看 AppKit 读这个键的那一下:往 Electron 注入一个小 dylib,
// 把 NSUserDefaults 读 ApplePersistenceIgnoreState 的值和调用方记下来,断言决定弹不弹框的那次读(hasPersistentStateToRestore)是 YES。
// 用法:npm run check:persistignore             —— 只验 Playwright 起的实例读到 YES
//       npm run check:persistignore -- --control —— 另跑负对照 TANGU_HARNESS_QUIET=0,必须读到 NO(窗口会抢一次焦点)
// 仅 macOS,要 xcrun clang;dev Electron 是 ad-hoc 签名、无 hardened runtime,DYLD_INSERT_LIBRARIES 才生效。
const fs = require('fs'), os = require('os'), path = require('path')
const { execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')

if (process.platform !== 'darwin') { console.log('SKIP persist-ignore: macOS only'); process.exit(0) }
const ROOT = path.resolve(__dirname, '..')
const KEY = 'ApplePersistenceIgnoreState'
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const HOOK = String.raw`#import <Foundation/Foundation.h>
#import <objc/runtime.h>
static IMP orig;
static BOOL hook(id self, SEL _cmd, NSString *k) {
  BOOL r = ((BOOL(*)(id,SEL,NSString*))orig)(self, _cmd, k);
  const char *out = getenv("PERSIST_HOOK_LOG");
  if (out && [NSThread isMainThread] && [k isEqual:@"${KEY}"]) {
    NSString *caller = [[NSThread callStackSymbols] count] > 1 ? [NSThread callStackSymbols][1] : @"?";
    FILE *f = fopen(out, "a"); if (f) { fprintf(f, "%s %s\n", r ? "YES" : "NO", caller.UTF8String); fclose(f); }
  }
  return r;
}
__attribute__((constructor)) static void init(void) {
  orig = method_setImplementation(class_getInstanceMethod(NSUserDefaults.class, @selector(boolForKey:)), (IMP)hook);
}
`

/** 起应用,等 AppKit 在 _handleAEOpenEvent 里读完这个键,返回那次读到的值(读不到 = null)。 */
async function run(dylib, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-ignore-'))
  const log = path.join(temp, 'reads.log')
  const app = await electron.launch({ args: [`--user-data-dir=${temp}/ud`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: temp, DYLD_INSERT_LIBRARIES: dylib, PERSIST_HOOK_LOG: log, ...env } })
  let gate = null
  try {
    for (let i = 0; i < 150 && !gate; i++) {
      await pause(200)
      gate = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').find((l) => l.includes('hasPersistentStateToRestore')) || null
    }
  } finally { await Promise.race([app.close().catch(() => {}), pause(15000)]) }
  return gate && gate.split(' ')[0]
}

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-hook-'))
  fs.writeFileSync(path.join(dir, 'hook.m'), HOOK)
  try { execFileSync('xcrun', ['clang', '-dynamiclib', '-framework', 'Foundation', '-o', path.join(dir, 'hook.dylib'), path.join(dir, 'hook.m')], { stdio: 'pipe' }) }
  catch (e) { console.log(`SKIP persist-ignore: 编不了探针 dylib(${String(e.stderr || e.message).trim().split('\n')[0]})`); process.exit(0) }
  const dylib = path.join(dir, 'hook.dylib')

  let fail = 0
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} | ${detail}`); if (!ok) fail++ }
  const quiet = await run(dylib, {})
  check('Playwright 起的实例:AppKit 决定弹不弹框时读到 YES', quiet === 'YES', `读到 ${quiet}`)
  let persisted = true
  try { execFileSync('defaults', ['read', 'com.github.Electron', KEY], { stdio: 'pipe' }) } catch { persisted = false }
  check('注册域不落盘:com.github.Electron 持久域里没有这个键', !persisted, persisted ? '持久域里有(有人 defaults write 过?)' : '没有')
  if (process.argv.includes('--control')) {
    const loud = await run(dylib, { TANGU_HARNESS_QUIET: '0' })
    check('负对照:关掉静默必须读到 NO', loud === 'NO', `读到 ${loud}`)
  }
  console.log(fail ? `${fail} failed` : 'all passed')
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
