package com.forsion.tangu

import android.app.ActivityManager
import android.content.ComponentName
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import androidx.lifecycle.Lifecycle
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 桌面图标跟随「设置 → 外观 → 应用图标」(页面侧 mobile/src/launcherIcon.ts)。
 * 桌面上的图标是清单里的一个入口(activity-alias);Android 只允许在安装包声明过的入口之间切换,所以只有内置图标
 * 能上桌面 —— 上传的图片 / 插件图标(以及任何不认识的 id)一律回到默认入口,它们只在 App 内显示。
 * 入口一次只开一个;开关的名单 = 清单里的别名,两边一起改。
 *
 * 两条都是模拟器上实测出来的(仪器 scripts/launcher-icon-upgrade-emu.cjs),别凭直觉改:
 * ⚠️ **在前台不切,离开 App 才切。** 用户是从入口进来的,这个任务的起点就是那个入口;入口一关,系统约一秒后把整个任务
 *    移除 —— 人还在设置页里,App 就被关回桌面。所以 set 在前台只记下要去的入口,等 Activity 停下(且盖在上面的不是
 *    别的应用的页面,例如文件选择器)再动手。下次从新图标进来是一次全新启动。
 * ⚠️ **先把快捷方式搬到新入口,再关旧入口。** 快捷方式挂在入口上(ShortcutInfo.activity):入口一关,系统撤掉它名下的
 *    动态快捷方式(长按图标那张 Space 列表),桌面(Launcher3 系)还会把**已固定到桌面**的那些一并摘掉,事后重发救不回
 *    用户摆好的图标。顺序只能是:开新入口 → 两个都开着时全部改挂过去 → 关旧入口。
 */
@CapacitorPlugin(name = "LauncherIcon")
class LauncherIconPlugin : Plugin() {
    /** 记下还没落到系统里的那个入口;进程没等到那一刻就没了也不要紧,页面每次启动都会再说一遍。 */
    @Volatile
    private var pending: String? = null

    @PluginMethod
    fun set(call: PluginCall) {
        try {
            val want = ENTRIES[call.getString("id")] ?: DEFAULT
            val changed = NAMES.any { isOn(it) != (it == want) }
            pending = if (changed) want else null
            if (changed && !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) apply()
            call.resolve(JSObject().put("changed", changed))
        } catch (e: Exception) {
            call.reject("LauncherIcon.set failed: ${e.message}", e)
        }
    }

    override fun handleOnStop() {
        super.handleOnStop()
        // 盖在本任务上的若是别的应用(系统文件选择器、内嵌浏览器页),用户还会回来:这时切,回来时任务已经没了。
        val top = context.getSystemService(ActivityManager::class.java)?.appTasks?.firstOrNull()?.taskInfo?.topActivity
        if (top == null || top.packageName == context.packageName) apply()
    }

    @Synchronized
    private fun apply() {
        val want = pending ?: return
        pending = null
        try {
            val pm = context.packageManager
            // DONT_KILL_APP:不带的话系统连进程一起杀。
            if (!isOn(want)) pm.setComponentEnabledSetting(entry(want), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            moveShortcuts(entry(want))
            for (name in NAMES) {
                if (name != want && isOn(name)) pm.setComponentEnabledSetting(entry(name), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            }
        } catch (e: Exception) {
            // 受限的工作资料 / 不让改组件状态的 ROM:桌面图标保持原样。
            android.util.Log.w("LauncherIcon", "entry not switched: ${e.message}")
        }
    }

    /** 类名的包固定是 com.forsion.tangu(并装的预览包只换 applicationId)。 */
    private fun entry(name: String) = ComponentName(context.packageName, "com.forsion.tangu.$name")

    private fun isOn(name: String): Boolean = when (context.packageManager.getComponentEnabledSetting(entry(name))) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> name == DEFAULT // 清单里只有默认入口是开着的
        else -> false
    }

    /** 把本应用的动态 / 已固定快捷方式全部改挂到 [to](它此刻必须是开着的入口);只改归属,名字、图标、Intent 不动。 */
    private fun moveShortcuts(to: ComponentName) {
        val manager = context.getSystemService(ShortcutManager::class.java) ?: return
        val moved = (manager.dynamicShortcuts + manager.pinnedShortcuts)
            .filter { !it.isImmutable && it.activity != to }
            .distinctBy { it.id }
            .map { ShortcutInfo.Builder(context, it.id).setActivity(to).build() }
        if (moved.isNotEmpty()) manager.updateShortcuts(moved)
    }

    companion object {
        /** ⚠️ 永不改名:用户桌面上已有的图标认的是这个组件名(见清单)。 */
        const val DEFAULT = "MainActivity"
        /** 应用图标的 id(desktop/frontend/src/appearance/builtins.ts 的 key)→ 清单里的别名。 */
        val ENTRIES = mapOf("builtin:arioso" to "IconArioso")
        private val NAMES = ENTRIES.values + DEFAULT
    }
}
