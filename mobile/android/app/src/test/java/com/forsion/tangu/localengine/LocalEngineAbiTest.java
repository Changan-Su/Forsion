package com.forsion.tangu.localengine;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 「这台手机」只在本进程按 64 位 ARM 跑时出现(LocalEnginePaths.arm64Native:Process.is64Bit() + uname 的 machine)。 */
public class LocalEngineAbiTest {
    @Test public void arm64Process() {
        assertTrue(LocalEnginePaths.arm64Native(true, "aarch64"));
    }

    @Test public void x86_64DeviceEvenWhenTheAppRunsTranslated() {
        // x86_64 images with libndk_translation: the kernel is x86_64 whatever the ABI list or os.arch say
        assertFalse(LocalEnginePaths.arm64Native(true, "x86_64"));
    }

    @Test public void thirtyTwoBitProcessOnArm64() {
        assertFalse(LocalEnginePaths.arm64Native(false, "armv8l"));
        assertFalse(LocalEnginePaths.arm64Native(false, "aarch64"));
        assertFalse(LocalEnginePaths.arm64Native(false, "armv7l"));
    }

    @Test public void unknown() {
        assertFalse(LocalEnginePaths.arm64Native(true, null));
        assertFalse(LocalEnginePaths.arm64Native(true, ""));
    }
}
