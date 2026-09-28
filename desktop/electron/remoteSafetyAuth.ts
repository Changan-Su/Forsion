/**
 * 解锁远程访问前的本机系统认证(设备能力 MCP 方案 P1 · K2 §3.8,D13;INTEGRATION §5.2 K2 U3 缺省)。
 *
 * 决策表(纯函数工厂,依赖注入 → vitest 直测;main.ts 注入 electron / child_process 的真实现):
 *   darwin + Touch ID 可用  → promptTouchID:成功 = ok;用户取消 = cancelled;其它失败(生物识别锁住 / 不匹配)→ 退到密码框
 *   darwin + 当前用户是管理员 → osascript「do shell script "true" with administrator privileges」系统密码框:
 *                              成功 = ok;-128(用户取消)= cancelled;**-60005(密码连错)= failed,绝不退到确认框**(否则连输三次错密码就绕过认证);
 *                              osascript 起不来 = 退到确认框;其它错误 = failed
 *   darwin 非管理员 / win32 / linux → 挂父窗的原生确认框(Electron 无 Windows Hello API;安全性降为「本机有人点了」,K2 R4 已记)
 * 所有路径都只在执行设备本机弹 —— 解锁永远不经隧道 / 通道 / 渲染层自己判定。
 */
export type SystemAuthResult = 'ok' | 'cancelled' | 'unavailable' | 'failed'

export interface SystemAuthDeps {
  platform: string
  touchId?: { can(): boolean; prompt(reason: string): Promise<void> }
  /** `id -Gn` 里有 admin。读不出 = false(走确认框)。 */
  isAdmin(): Promise<boolean>
  /** 跑一段 AppleScript;spawnError = osascript 本身起不来(ENOENT 等)。 */
  osascript(script: string): Promise<{ ok: true } | { ok: false; spawnError?: boolean; stderr: string }>
  /** 挂父窗的原生确认框。true = 解锁;false / null = 取消 / 弹不出来。 */
  confirm(): Promise<boolean | null>
  /** 系统密码框里的那句话(已本地化)。 */
  passwordPrompt(): string
  log(m: string): void
}

/** AppleScript 字符串字面量转义(\ 与 ")。 */
export function appleScriptString(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

export function createSystemAuth(d: SystemAuthDeps): (reason: string) => Promise<SystemAuthResult> {
  const viaDialog = async (): Promise<SystemAuthResult> => {
    try { return (await d.confirm()) === true ? 'ok' : 'cancelled' } catch (e) {
      d.log(`[remote-safety] confirm dialog failed: ${(e as Error)?.message || e}`)
      return 'unavailable'
    }
  }
  return async (reason: string): Promise<SystemAuthResult> => {
    if (d.platform !== 'darwin') return viaDialog()
    let canTouch = false
    try { canTouch = !!d.touchId?.can() } catch { canTouch = false }
    if (canTouch) {
      try {
        await d.touchId!.prompt(reason)
        return 'ok'
      } catch (e) {
        const msg = String((e as Error)?.message || e)
        if (/cancel/i.test(msg)) return 'cancelled'
        d.log(`[remote-safety] Touch ID failed (${msg}); falling back to the password prompt`)
      }
    }
    let admin = false
    try { admin = await d.isAdmin() } catch { admin = false }
    if (!admin) return viaDialog()
    const r = await d.osascript(`do shell script "true" with prompt ${appleScriptString(d.passwordPrompt())} with administrator privileges`)
    if (r.ok) return 'ok'
    if ('spawnError' in r && r.spawnError) return viaDialog()
    if (/\(-128\)/.test(r.stderr)) return 'cancelled'
    if (/\(-60005\)/.test(r.stderr)) return 'failed'
    d.log(`[remote-safety] password prompt failed: ${r.stderr.slice(0, 200)}`)
    return 'failed'
  }
}
