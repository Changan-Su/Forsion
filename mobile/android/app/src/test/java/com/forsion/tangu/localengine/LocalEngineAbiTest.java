package com.forsion.tangu.localengine;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 「这台手机」只在真 arm64 设备、且本进程按 arm64 跑时出现(LocalEnginePaths.arm64Native)。 */
public class LocalEngineAbiTest {
    @Test public void arm64Phone() {
        assertTrue(LocalEnginePaths.arm64Native(new String[] {"arm64-v8a", "armeabi-v7a", "armeabi"}, "aarch64"));
        assertTrue(LocalEnginePaths.arm64Native(new String[] {"arm64-v8a"}, "aarch64"));
    }

    @Test public void x86_64WithArmTranslationListsArm64Second() {
        // what an x86_64 API 35 emulator image with libndk_translation reports
        assertFalse(LocalEnginePaths.arm64Native(new String[] {"x86_64", "arm64-v8a"}, "x86_64"));
        assertFalse(LocalEnginePaths.arm64Native(new String[] {"x86_64", "x86", "arm64-v8a", "armeabi-v7a"}, "x86_64"));
    }

    @Test public void translatedProcessEvenIfArm64ComesFirst() {
        // the process runs translated (the app was installed as arm64 on an x86_64 device): os.arch gives it away
        assertFalse(LocalEnginePaths.arm64Native(new String[] {"arm64-v8a", "x86_64"}, "x86_64"));
    }

    @Test public void thirtyTwoBitProcessOnArm64() {
        assertFalse(LocalEnginePaths.arm64Native(new String[] {"arm64-v8a", "armeabi-v7a"}, "armv8l"));
        assertFalse(LocalEnginePaths.arm64Native(new String[] {"armeabi-v7a", "armeabi"}, "armv7l"));
    }

    @Test public void unknown() {
        assertFalse(LocalEnginePaths.arm64Native(null, "aarch64"));
        assertFalse(LocalEnginePaths.arm64Native(new String[0], "aarch64"));
        assertFalse(LocalEnginePaths.arm64Native(new String[] {"arm64-v8a"}, null));
    }
}
