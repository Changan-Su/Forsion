/** macOS 安装窗口(DMG)的布局 —— electron-builder.config.cjs 的 dmg 段。单独成文件是为了让测试读得到
 *  (整份配置在缺 unit-web-dist 时一 require 就抛)。
 *
 *  「打不开怎么办」直接画在背景图上(build/dmg-background.html → node build/gen-dmg-background.cjs),
 *  说明文件只是兜底(终端那行命令要能复制)。
 *
 *  ⚠️窗口大小 = 背景图大小,别在这里写 `window: { width, height }`:只要有背景图(不配时 dmg-builder 也会塞
 *  自带的 540×380 模板),窗口尺寸一律取图的尺寸,window 被静默忽略。2.13.1 及更早就是这样把说明文件排到了
 *  窗口外 —— 配置写 560×440,装出来实测 540×380,文件在 y=372,要滚动才看得到。
 *
 *  坐标是图标中心。可视区比窗口矮:标题栏占 32px,用户开了 Finder 的「显示路径栏 / 状态栏」时底部再少约 56px
 *  (这两条是 Finder 的全局偏好,安装包管不了)。挪图标 / 换背景后跑 electron/installerPackaging.test.ts
 *  (钉「每个图标连文件名在最矮的可视区里也看得全」),再跑 node scripts/dmg-layout-preview.cjs 打一个空壳包在 Finder 里看一眼。 */
module.exports = {
  // 文件名故意不叫 background.png:那个名字会被 dmg-builder 自动拾取,连没配 dmg 段的单品变体也会套上这张图。
  // 直接给 tiff(png + @2x 合成,gen-dmg-background.cjs 产出):下面占位要用同一份字节。
  background: 'dmg-background.tiff',
  iconSize: 80,
  contents: [
    { x: 170, y: 114 },
    { x: 430, y: 114, type: 'link', path: '/Applications' },
    { x: 500, y: 274, type: 'file', path: 'build/打不开？Read me.txt' },
    // 卷里的 .background.tiff / .VolumeIcon.icns 是隐藏文件,但用户在 Finder 里开了「显示隐藏文件」(⌘⇧.)时
    // 会被自动排进窗口、压在说明文字上(2.13.8-beta.3 用户报)。dmg-builder 的校验不认 dmgbuild 的 position 类型,
    // 只好放一份同字节的文件占位、坐标甩到窗口外;dmgbuild 先写背景 / 卷图标、后拷 contents,占位会覆盖它们,所以必须同一份。
    { x: 150, y: 700, type: 'file', path: 'build/dmg-background.tiff', name: '.background.tiff' },
    { x: 450, y: 700, type: 'file', path: 'build/icon.icns', name: '.VolumeIcon.icns' },
  ],
}
