package com.forsion.tangu.localengine;

/** Canonical x.y.z release versions (no prerelease, no +meta, no leading zeros), compared numerically. */
final class Versions {
    private Versions() {}

    private static final java.util.regex.Pattern RELEASE = java.util.regex.Pattern.compile("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})");

    static boolean isRelease(String v) { return v != null && RELEASE.matcher(v).matches(); }

    /** Negative / 0 / positive like Comparable; both must be release versions (IllegalArgumentException otherwise). */
    static int compare(String a, String b) {
        long[] x = parts(a), y = parts(b);
        for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
        return 0;
    }

    private static long[] parts(String v) {
        java.util.regex.Matcher m = RELEASE.matcher(v == null ? "" : v);
        if (!m.matches()) throw new IllegalArgumentException("not a release version: " + v);
        return new long[]{Long.parseLong(m.group(1)), Long.parseLong(m.group(2)), Long.parseLong(m.group(3))};
    }
}
