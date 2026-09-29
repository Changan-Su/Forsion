/* Shared keyframe engine core, inlined by build.mjs into each page's IIFE.
   Every visual is a pure function of t, so pages can play live or be captured frame by frame. */
  const EASE = {
    lin: t => t,
    in: t => t * t * t,
    out: t => 1 - (1 - t) ** 3,
    io: t => t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,
    expo: t => t >= 1 ? 1 : 1 - 2 ** (-10 * t),
    back: t => { const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
    step: t => t < 1 ? 0 : 1,
  };
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const prog = (t, a, b, e = 'io') => EASE[e](clamp((t - a) / (b - a)));
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };
  const TF = ['x', 'y', 'z', 's', 'sx', 'sy', 'r', 'rx', 'ry'];

  function sample(kf, t) {
    if (t <= kf[0].t) return kf[0].v;
    for (let i = 1; i < kf.length; i++) {
      const b = kf[i];
      if (t < b.t) {
        const a = kf[i - 1], k = EASE[b.e]((t - a.t) / (b.t - a.t)), v = {};
        for (const key in b.v) { const va = key in a.v ? a.v[key] : b.v[key]; v[key] = va + (b.v[key] - va) * k; }
        return v;
      }
    }
    return kf[kf.length - 1].v;
  }
  function apply(el, v, hasTf) {
    const s = el.style;
    if (hasTf) {
      let tf = `translate3d(${v.x || 0}px,${v.y || 0}px,${v.z || 0}px)`;
      if (v.rx) tf += ` rotateX(${v.rx}deg)`;
      if (v.ry) tf += ` rotateY(${v.ry}deg)`;
      if (v.r) tf += ` rotate(${v.r}deg)`;
      if ((v.s ?? 1) !== 1) tf += ` scale(${v.s})`;
      if ((v.sx ?? 1) !== 1 || (v.sy ?? 1) !== 1) tf += ` scale(${v.sx ?? 1},${v.sy ?? 1})`;
      s.transform = tf;
    }
    if ('o' in v) { s.opacity = v.o; s.visibility = v.o < .002 ? 'hidden' : ''; }
    if ('b' in v || 'br' in v) s.filter = `blur(${v.b || 0}px) brightness(${v.br ?? 1})`;
    if ('ct' in v || 'cr' in v || 'cb' in v || 'cl' in v) s.clipPath = `inset(${v.ct || 0}% ${v.cr || 0}% ${v.cb || 0}% ${v.cl || 0}%)`;
    for (const k in v) if (k[0] === '-') s.setProperty(k, v[k]);
  }

  function createStage(root, w, h, dur) {
    const tracks = [], hooks = [];
    const q = sel => typeof sel === 'string' ? [...root.querySelectorAll(sel)] : [].concat(sel);
    const st = {
      root, w, h, dur, q,
      /* keyframes: [time, props, ease]; props carry forward to later keyframes */
      K(sel, kfs, opt = {}) {
        let acc = {};
        const kf = kfs.map(([t, props = {}, e = 'io']) => (acc = { ...acc, ...props }, { t, v: acc, e }));
        const hasTf = kf.some(k => Object.keys(k.v).some(p => TF.includes(p)));
        q(sel).forEach((el, i) => tracks.push({ el, kf, hasTf, off: (opt.stagger || 0) * i }));
      },
      /* hard cut: shown only inside [a, b) */
      S(sel, a, b) { const els = q(sel); hooks.push(t => { for (const el of els) el.style.display = t >= a && t < b ? '' : 'none'; }); },
      H(fn) { hooks.push(fn); },
      type(sel, a, cps = 30, gap = 0) {
        q(sel).forEach((el, i) => {
          const chars = [...el.textContent], start = a + gap * i;
          hooks.push(t => { const n = clamp(Math.floor((t - start) * cps), 0, chars.length); const s = chars.slice(0, n).join(''); if (el.textContent !== s) el.textContent = s; });
        });
      },
      render(t) { for (const f of hooks) f(t); for (const tr of tracks) apply(tr.el, sample(tr.kf, t - tr.off), tr.hasTf); },
    };
    return st;
  }

  /* film grain: four deterministic noise tiles, cycled at 24 fps */
  const grainTiles = (() => {
    const r = rng(7), out = [];
    for (let n = 0; n < 4; n++) {
      const c = document.createElement('canvas'); c.width = c.height = 200;
      const g = c.getContext('2d'), img = g.createImageData(200, 200);
      for (let i = 0; i < img.data.length; i += 4) { const v = r() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
      g.putImageData(img, 0, 0); out.push(`url(${c.toDataURL()})`);
    }
    return out;
  })();
  function grain(st) { const els = st.q('.grain'); st.H(t => { const bg = grainTiles[Math.floor(t * 24) % 4]; for (const el of els) el.style.backgroundImage = bg; }); }
