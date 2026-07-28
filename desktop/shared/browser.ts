/** 内置浏览器(builtin:browser)的 <webview> 会话分区 —— 主进程与渲染层同源引用。
 *  独立分区 = 与 App 自身 cookie/storage 隔离,且不继承 defaultSession 的「权限全放行」策略。 */
export const BROWSER_PARTITION = 'persist:forsion-browser'

/** 该分区里**放行**的权限。其余(麦克风/摄像头/定位/通知/MIDI/剪贴板读…)一律拒。
 *  收录判据:必须有用户手势 + Esc 可退 + 不泄露任何隐私数据 + **确有实报需求**。
 *  `pointerLock`:不给它,任何 3D/FPS 类网页都玩不了(实报 `Blocked pointer lock … permission is not set`)。
 *  ⚠️`fullscreen` **故意不在表内**:本分区同时承载内置浏览器里的**任意第三方站点**,而权限 handler
 *  不分来源 —— 全屏是伪造桌面/登录界面的放大器(指针锁自己关在小面板里画不出假桌面),而且它
 *  从来不是实报需求(codex High-2)。真要开:先拆分区(预览 ≠ 任意浏览),并确认 Electron 里
 *  Chromium 的全屏提示条真的会出现。 */
export const GUEST_ALLOWED_PERMISSIONS: readonly string[] = ['pointerLock']
