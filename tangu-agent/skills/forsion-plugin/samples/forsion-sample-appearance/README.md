# 开屏与图标示例 / Startup appearance sample

将此目录复制到 `~/.forsion/plugins/forsion-sample-appearance/`（开发实例为 `~/.forsion-dev/plugins/`），重载插件后进入设置 → 外观 → 开屏与图标，在品牌图标和开屏动画素材中选择「青环」。禁用插件会清除该插件的当前选择。旧宿主没有此接口时不会生效。

Copy this folder to `~/.forsion/plugins/forsion-sample-appearance/` (`~/.forsion-dev/plugins/` for development), reload plugins, then choose Quiet orbit for the icon and startup artwork in Settings → Appearance → Startup and icons. Disabling the plugin restores defaults. Older hosts without `registerAppearance` safely skip registration. No build step or network access is needed.
