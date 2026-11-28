package com.forsion.tangu.localengine;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

/**
 * Ed25519 signature verification (RFC 8032 §5.1.7), verify only, in plain Java.
 *
 * Why not JCA: the platform provider has Ed25519 only from API 33 and minSdk is 26; a JVM unit test on JDK 21 would pass
 * with JCA and the phone would fail. This class uses BigInteger and SHA-512 (available on every API level) and nothing
 * else. Speed is not a concern: one verification per engine download (two scalar multiplications).
 *
 * Strict in the same places as OpenSSL / Node: S must be < L, A and R must decode to points (y < p, valid x), and the
 * recomputed R must encode to exactly the 32 bytes in the signature (so a non-canonical R is refused). Cofactorless check.
 */
final class Ed25519 {
    private Ed25519() {}

    private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
    private static final BigInteger D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
    private static final BigInteger D2 = D.shiftLeft(1).mod(P);
    private static final BigInteger SQRT_M1 = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
    private static final BigInteger TWO = BigInteger.valueOf(2);

    /** Extended coordinates (X:Y:Z:T), x = X/Z, y = Y/Z, xy = T/Z. */
    private static final class Pt {
        final BigInteger x, y, z, t;
        Pt(BigInteger x, BigInteger y, BigInteger z, BigInteger t) { this.x = x; this.y = y; this.z = z; this.t = t; }
    }

    private static final Pt ZERO = new Pt(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO);
    private static final Pt BASE;

    static {
        BigInteger by = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
        BigInteger bx = recoverX(by, 0);
        BASE = new Pt(bx, by, BigInteger.ONE, bx.multiply(by).mod(P));
    }

    /** RFC 8032 §5.1.4 addition (a = -1); also correct for doubling. */
    private static Pt add(Pt p, Pt q) {
        BigInteger a = p.y.subtract(p.x).multiply(q.y.subtract(q.x)).mod(P);
        BigInteger b = p.y.add(p.x).multiply(q.y.add(q.x)).mod(P);
        BigInteger c = p.t.multiply(D2).multiply(q.t).mod(P);
        BigInteger d = p.z.multiply(TWO).multiply(q.z).mod(P);
        BigInteger e = b.subtract(a), f = d.subtract(c), g = d.add(c), h = b.add(a);
        return new Pt(e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P));
    }

    private static Pt negate(Pt p) { return new Pt(P.subtract(p.x).mod(P), p.y, p.z, P.subtract(p.t).mod(P)); }

    private static Pt mul(BigInteger s, Pt p) {
        Pt q = ZERO;
        for (int i = s.bitLength() - 1; i >= 0; i--) {
            q = add(q, q);
            if (s.testBit(i)) q = add(q, p);
        }
        return q;
    }

    /** x for y with the given sign bit, or null when there is none. */
    private static BigInteger recoverX(BigInteger y, int sign) {
        if (y.compareTo(P) >= 0) return null;
        BigInteger y2 = y.multiply(y).mod(P);
        BigInteger u = y2.subtract(BigInteger.ONE).mod(P);
        BigInteger v = D.multiply(y2).add(BigInteger.ONE).mod(P);
        // x = u v^3 (u v^7)^((p-5)/8)
        BigInteger v3 = v.modPow(BigInteger.valueOf(3), P);
        BigInteger v7 = v3.multiply(v3).multiply(v).mod(P);
        BigInteger x = u.multiply(v3).multiply(u.multiply(v7).mod(P).modPow(P.subtract(BigInteger.valueOf(5)).shiftRight(3), P)).mod(P);
        BigInteger vx2 = v.multiply(x).multiply(x).mod(P);
        if (!vx2.equals(u)) {
            if (vx2.equals(P.subtract(u).mod(P))) x = x.multiply(SQRT_M1).mod(P);
            else return null;
        }
        if (x.signum() == 0 && sign == 1) return null;
        if (x.testBit(0) != (sign == 1)) x = P.subtract(x);
        return x;
    }

    private static Pt decode(byte[] b) {
        if (b.length != 32) return null;
        byte[] le = b.clone();
        int sign = (le[31] >> 7) & 1;
        le[31] &= 0x7f;
        BigInteger y = littleEndian(le);
        BigInteger x = recoverX(y, sign);
        if (x == null) return null;
        return new Pt(x, y, BigInteger.ONE, x.multiply(y).mod(P));
    }

    private static byte[] encode(Pt p) {
        BigInteger zi = p.z.modInverse(P);
        BigInteger x = p.x.multiply(zi).mod(P), y = p.y.multiply(zi).mod(P);
        byte[] out = toLittleEndian32(y);
        if (x.testBit(0)) out[31] |= (byte) 0x80;
        return out;
    }

    private static BigInteger littleEndian(byte[] le) {
        byte[] be = new byte[le.length + 1]; // leading 0: unsigned
        for (int i = 0; i < le.length; i++) be[be.length - 1 - i] = le[i];
        return new BigInteger(be);
    }

    private static byte[] toLittleEndian32(BigInteger n) {
        byte[] be = n.toByteArray();
        byte[] out = new byte[32];
        for (int i = 0; i < 32 && i < be.length; i++) out[i] = be[be.length - 1 - i];
        return out;
    }

    /** true iff sig (64 bytes) is a valid Ed25519 signature of msg under the 32-byte public key pub. */
    static boolean verify(byte[] pub, byte[] msg, byte[] sig) {
        if (pub == null || pub.length != 32 || sig == null || sig.length != 64 || msg == null) return false;
        byte[] rBytes = Arrays.copyOfRange(sig, 0, 32);
        BigInteger s = littleEndian(Arrays.copyOfRange(sig, 32, 64));
        if (s.compareTo(L) >= 0) return false;
        Pt a = decode(pub);
        if (a == null || decode(rBytes) == null) return false;
        BigInteger k;
        try {
            MessageDigest h = MessageDigest.getInstance("SHA-512");
            h.update(rBytes);
            h.update(pub);
            h.update(msg);
            k = littleEndian(h.digest()).mod(L);
        } catch (NoSuchAlgorithmException e) {
            return false;
        }
        // R' = [S]B - [k]A must encode to R exactly
        Pt r = add(mul(s, BASE), negate(mul(k, a)));
        return Arrays.equals(encode(r), rBytes);
    }

    /** The 32 raw key bytes from an Ed25519 SubjectPublicKeyInfo (DER, 44 bytes: the fixed 12-byte prefix + key), or null. */
    static byte[] rawFromSpki(byte[] der) {
        byte[] prefix = {0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};
        if (der == null || der.length != 44) return null;
        for (int i = 0; i < prefix.length; i++) if (der[i] != prefix[i]) return null;
        return Arrays.copyOfRange(der, 12, 44);
    }
}
