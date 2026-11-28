package com.forsion.tangu.localengine;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * What this APK pins for the local engine (mobile/android/local-engine/lock.json, read by build.gradle into BuildConfig):
 * the base layer it carries as an asset, the engine package and its line, the oldest engine it accepts, and the keys
 * an engine must be signed with. Empty base fields = a build without the base (normal channel): "This phone" stays hidden.
 */
final class LocalEngineConfig {
    static final String NPM_MIRROR = "https://registry.npmmirror.com";
    static final String NPM_OFFICIAL = "https://registry.npmjs.org";
    static final String BASE_ASSET = "local-engine/base.tar.xz";

    final String pkg;
    final int line;
    final String minEngineVersion;
    final String baseVersion, baseSha256;
    final long baseSize, baseUnpackedSize;
    final List<byte[]> keys;

    LocalEngineConfig(String pkg, int line, String minEngineVersion, String baseVersion, String baseSha256, long baseSize, long baseUnpackedSize, List<byte[]> keys) {
        this.pkg = pkg; this.line = line; this.minEngineVersion = minEngineVersion;
        this.baseVersion = baseVersion; this.baseSha256 = baseSha256; this.baseSize = baseSize; this.baseUnpackedSize = baseUnpackedSize;
        this.keys = keys;
    }

    static LocalEngineConfig fromBuild() {
        List<byte[]> keys = new ArrayList<>();
        keys.add(EngineSignature.unhex(EngineSignature.PRODUCTION_KEY_HEX));
        // a throwaway key for the emulator bench (tampered / stale fixtures): only in debug builds that were given one
        String test = com.forsion.tangu.BuildConfig.LOCAL_ENGINE_TEST_KEY;
        if (com.forsion.tangu.BuildConfig.DEBUG && test != null && test.matches("[0-9a-f]{64}")) keys.add(EngineSignature.unhex(test));
        return new LocalEngineConfig(com.forsion.tangu.BuildConfig.LOCAL_ENGINE_PACKAGE, com.forsion.tangu.BuildConfig.LOCAL_ENGINE_LINE,
                com.forsion.tangu.BuildConfig.LOCAL_ENGINE_MIN_VERSION, com.forsion.tangu.BuildConfig.LOCAL_ENGINE_BASE_VERSION,
                com.forsion.tangu.BuildConfig.LOCAL_ENGINE_BASE_SHA256, com.forsion.tangu.BuildConfig.LOCAL_ENGINE_BASE_SIZE,
                com.forsion.tangu.BuildConfig.LOCAL_ENGINE_BASE_UNPACKED, keys);
    }

    boolean configured() {
        return pkg != null && pkg.matches("@[a-z0-9-]+/[a-z0-9-]+") && line > 0 && baseVersion != null && !baseVersion.isEmpty()
                && baseSha256 != null && baseSha256.matches("[0-9a-f]{64}") && baseSize > 0 && baseUnpackedSize > 0;
    }

    /** The dist-tag this APK reads: one line per base generation / native contract (never latest). */
    String distTag() { return "android-" + line; }

    /** npmmirror first, then the official registry; a debuggable build's override (comma-separated, in order) replaces both. */
    static List<String> registries(String override) {
        if (override == null || override.trim().isEmpty()) return Arrays.asList(NPM_MIRROR, NPM_OFFICIAL);
        List<String> out = new ArrayList<>();
        for (String r : override.split(",")) if (!r.trim().isEmpty()) out.add(r.trim().replaceAll("/+$", ""));
        return out;
    }

    /** Abbreviated packument (same path on npmjs and npmmirror; the scope slash encoded). */
    static String packumentUrl(String registry, String pkg) { return registry + "/" + pkg.replace("/", "%2f"); }

    /** The registry's canonical tarball path (desktop/shared/npmRegistry.ts tarballUrl); the packument's dist.tarball is not followed. */
    static String tarballUrl(String registry, String pkg, String version) {
        return registry + "/" + pkg + "/-/" + pkg.replaceFirst("^@[^/]+/", "") + "-" + version + ".tgz";
    }
}
