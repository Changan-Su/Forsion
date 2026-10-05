// Runs inline before app modules, from one source shared by Desktop, Web and Mobile.
(function () {
  var splash = document.getElementById('tangu-splash');
  if (!splash) return;
  var kind = new URLSearchParams(location.search).get('window');
  if (['mini', 'floating', 'detached'].indexOf(kind) !== -1) { splash.remove(); return; }
  var value = {};
  try {
    var saved = window.tangu && window.tangu.startupAppearance
      ? window.tangu.startupAppearance.initial
      : JSON.parse(localStorage.getItem('forsion_startup_appearance_v1') || 'null');
    if (saved && saved.version === 1) value = saved;
  } catch (_) { /* Default brand remains visible. */ }
  if (value.showSplash === false) { splash.remove(); return; }
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var animation = ['default', 'pulse', 'spin', 'none'].indexOf(value.animation) !== -1 ? value.animation : 'default';
  var style = document.createElement('style');
  style.textContent = '\
    #tangu-splash { animation: none; }\
    #tangu-splash.out { animation: tangu-splash-out 380ms both; }\
    @keyframes tangu-splash-out { from { opacity:1; visibility:visible; } to { opacity:0; visibility:hidden; } }\
    #tangu-splash #panel-stack, #tangu-splash #tree-mark, #tangu-splash #tree-outline { animation-iteration-count:infinite; }\
    #tangu-splash .tangu-splash-logo { animation: forsion-seam 1600ms linear infinite; }\
    @keyframes forsion-seam { 0%,100% {opacity:0} 4%,92% {opacity:1} }\
    #tangu-splash .forsion-startup-image { width:184px; height:184px; object-fit:contain; }\
    #tangu-splash[data-custom-motion] .tangu-splash-logo, #tangu-splash[data-custom-motion] #panel-stack, #tangu-splash[data-custom-motion] #tree-mark, #tangu-splash[data-custom-motion] #tree-outline { animation:none; }\
    #tangu-splash[data-custom-motion] #tree-outline { opacity:0; }\
    #tangu-splash[data-custom-motion="pulse"] > :first-child { animation:forsion-pulse 1600ms ease-in-out infinite; }\
    #tangu-splash[data-custom-motion="spin"] > :first-child { animation:forsion-spin 2200ms linear infinite; }\
    @keyframes forsion-pulse { 0%,100% {transform:scale(.94);opacity:.65} 50% {transform:scale(1);opacity:1} }\
    @keyframes forsion-spin { to {transform:rotate(360deg)} }\
    @media(prefers-reduced-motion:reduce) { #tangu-splash .tangu-splash-logo, #tangu-splash #panel-stack, #tangu-splash #tree-mark, #tangu-splash #tree-outline, #tangu-splash[data-custom-motion] > :first-child { animation:none; } #tangu-splash #tree-outline {opacity:0} }\
    #tangu-splash .fts { position:absolute; inset:0; overflow:hidden; background:inherit; }\
    #tangu-splash .fts-view, #tangu-splash .fts-lit, #tangu-splash .fts-bloom, #tangu-splash .fts-grain, #tangu-splash .fts-cloud { position:absolute; inset:0; }\
    #tangu-splash .fts canvas { position:absolute; }\
    #tangu-splash .fts-lit { background:var(--fts-lit); }\
    #tangu-splash .fts-near, #tangu-splash .fts-far { left:0; top:0; width:100%; height:100%; transform-origin:var(--fts-root); }\
    #tangu-splash .fts-near { opacity:var(--fts-near); animation:fts-sway 5600ms ease-in-out infinite alternate; }\
    #tangu-splash .fts-far { opacity:var(--fts-far); animation:fts-sway-far 7400ms ease-in-out -2000ms infinite alternate; }\
    #tangu-splash .fts-wall { left:-48px; top:-48px; width:calc(100% + 96px); height:calc(100% + 96px); animation:fts-drift 18s ease-in-out infinite alternate; }\
    #tangu-splash .fts-bloom { background:radial-gradient(ellipse 44% 58% at var(--fts-cx) var(--fts-cy), var(--fts-bloom), transparent 72%); }\
    #tangu-splash .fts-grain { opacity:.07; background:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%22240%22%3E%3Cfilter id=%22n%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%22.9%22 numOctaves=%222%22 stitchTiles=%22stitch%22/%3E%3CfeColorMatrix values=%220 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .55 0%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22/%3E%3C/svg%3E"); }\
    #tangu-splash .fts-cloud { background:inherit; opacity:0; animation:fts-clear 1700ms cubic-bezier(.4,0,.2,1) both; }\
    #tangu-splash .fts-brand { position:absolute; left:7%; bottom:calc(9% + env(safe-area-inset-bottom, 0px)); display:flex; align-items:center; gap:.92em; color:var(--fts-word); font:500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing:.42em; animation:fts-in 1100ms 500ms both; }\
    #tangu-splash .fts-brand svg { width:1.54em; height:1.85em; fill:currentColor; }\
    #tangu-splash .fts-brand span { display:flex; flex-direction:column; justify-content:space-between; }\
    #tangu-splash .fts-ver { font-size:max(8px, .72em); letter-spacing:.16em; opacity:.7; }\
    #tangu-splash .fts-verse { position:absolute; left:7%; top:calc(13% + env(safe-area-inset-top, 0px)); -webkit-writing-mode:vertical-rl; writing-mode:vertical-rl; color:var(--fts-verse); font-family:"Songti SC", "STSong", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif; line-height:1; letter-spacing:.42em; }\
    #tangu-splash .fts-verse p { margin:0; animation:fts-in 900ms 300ms both; }\
    #tangu-splash .fts-verse p + p { margin-block-start:1.05em; padding-inline-start:1.5em; animation-delay:600ms; }\
    #tangu-splash .fts-verse .fts-src { font-size:.5em; letter-spacing:.3em; opacity:.72; margin-block-start:2.4em; padding:0; text-align:end; animation-delay:1000ms; }\
    @keyframes fts-sway { from {transform:rotate(-.7deg)} to {transform:rotate(.9deg)} }\
    @keyframes fts-sway-far { from {transform:rotate(.6deg)} to {transform:rotate(-.8deg)} }\
    @keyframes fts-drift { from {transform:translateX(-14px)} to {transform:translateX(16px)} }\
    @keyframes fts-clear { from {opacity:1} }\
    @keyframes fts-in { from {opacity:0} }\
    #tangu-splash.out .fts-view { animation:fts-open 380ms cubic-bezier(.4,0,.2,1) both; }\
    @keyframes fts-open { to {transform:scale(1.08)} }\
    #tangu-splash[data-still] .fts * { animation:none; }\
    @media(prefers-reduced-motion:reduce) { #tangu-splash .fts * { animation:none; } }';
  document.head.appendChild(style);
  // Tree shadow, the built-in default scene: window light on a wall, branch shadows and one Fusang verse.
  // Painted once into three canvases; afterwards only transform and opacity animate.
  var VERSES = [
    ['汤谷上有扶桑', '十日所浴', '《山海经》'],
    ['香风送紫蕊', '直到扶桑津', '李白《拟古十二首》'],
    ['客止我且往', '濯发扶桑根', '王安石《我欲往沧海》'],
    ['万里扶桑客', '何时返故乡', '《通州望海》'],
    ['暾将出兮东方', '照吾槛兮扶桑', '《楚辞·九歌》']
  ];
  var original = splash.firstElementChild;
  function treeShadow(target) {
    try {
      var look = document.documentElement.dataset.mode === 'dark'
        ? { wall: '#121419', ink: '#05070c', near: .66, far: .42, word: '#8a94a8', verse: '#ccd4e2', bloom: 'rgba(140,165,215,.1)', lit: 'radial-gradient(70% 80% at 55% 35%, rgba(235,242,255,.16), transparent 70%), linear-gradient(165deg, #7889a8, #47536c)' }
        : { wall: '#e4d9cb', ink: '#5f4636', near: .4, far: .26, word: '#9a7c68', verse: '#6b4f3e', bloom: 'transparent', lit: 'linear-gradient(160deg, #fff7ea, #fbeede)' };
      var W = Math.max(window.innerWidth || 0, 320), H = Math.max(window.innerHeight || 0, 320), u = Math.min(W, H) / 800;
      var wide = W >= H, cx = W * (wide ? .6 : .58), cy = H * (wide ? .46 : .5), pw = W * (wide ? .2 : .3), ph = H * (wide ? .37 : .21);
      // The tree is sized and rooted relative to the window light, so its branches reach the panes at any aspect ratio.
      var rootX = cx + pw * 2.1, rootY = cy + ph * 1.946;
      // Everything on the canvases is blurred, so a capped bitmap stretched by CSS is enough on large displays.
      var q = Math.min(1, 1600 / Math.max(W, H));
      // A different verse on every launch. Storage is unavailable in the sandboxed settings preview.
      var last = -1, pick;
      try { last = parseInt(localStorage.getItem('forsion_startup_verse'), 10); } catch (_) { /* preview */ }
      if (!(last >= 0 && last < VERSES.length)) last = -1;
      pick = Math.floor(Math.random() * (VERSES.length - (last < 0 ? 0 : 1)));
      if (last >= 0 && pick >= last) pick++;
      try { localStorage.setItem('forsion_startup_verse', String(pick)); } catch (_) { /* preview */ }
      var mark = original.querySelector('#tree-mark');
      // Stamped by whoever inlines this runtime (build plugin / settings preview); it goes into innerHTML, so only a plain version passes.
      var stamp = window.FORSION_APP_VERSION;
      var version = typeof stamp === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(stamp) ? stamp : '';
      var scene = document.createElement('div');
      scene.className = 'fts';
      scene.style.cssText = '--fts-lit:' + look.lit + ';--fts-near:' + look.near + ';--fts-far:' + look.far + ';--fts-bloom:' + look.bloom
        + ';--fts-word:' + look.word + ';--fts-verse:' + look.verse + ';--fts-cx:' + cx / W * 100 + '%;--fts-cy:' + cy / H * 100 + '%'
        + ';--fts-root:' + rootX / W * 100 + '% ' + rootY / H * 100 + '%';
      scene.innerHTML = '<div class="fts-view"><div class="fts-lit"></div><canvas class="fts-far"></canvas><canvas class="fts-near"></canvas><canvas class="fts-wall"></canvas><div class="fts-bloom"></div><div class="fts-grain"></div></div><div class="fts-cloud"></div>'
        + '<div class="fts-verse" style="font-size:' + Math.max(17, Math.min(34, Math.min(W, H) * .031)) + 'px"><p>' + VERSES[pick][0] + '</p><p>' + VERSES[pick][1] + '</p><p class="fts-src">' + VERSES[pick][2] + '</p></div>'
        + '<div class="fts-brand" style="font-size:' + Math.max(9, Math.min(13, Math.min(W, H) * .02)) + 'px"><svg viewBox="210.585 128.215 588.13 706.57"><path d="' + (mark ? mark.getAttribute('d') : '') + '"/></svg><span' + (version ? ' style="height:2.1em"' : '') + '>FORSION' + (version ? '<small class="fts-ver">' + version + '</small>' : '') + '</span></div>';
      var layers = scene.getElementsByTagName('canvas');
      // WebKit has no canvas filter: blur the finished layer with CSS instead.
      var blur = function (canvas, context, px) {
        if (typeof context.filter === 'string') context.filter = 'blur(' + px * u * q + 'px)';
        else canvas.style.filter = 'blur(' + px * u + 'px)';
      };
      // The shadow is cast by the same seeded tree as the website hero, rooted outside the lower right of the panes.
      var seed = 20260707, segs = [];
      var rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      (function branch(x, y, a, l, d) {
        if (d <= 0 || l < 4) return;
        var ex = x + Math.cos(a) * l, ey = y + Math.sin(a) * l;
        segs.push([x, y, ex, ey, d, a, rnd(), rnd()]);
        var spread = .32 + rnd() * .16, next = l * (.75 + rnd() * .05);
        branch(ex, ey, a - spread - rnd() * .08, next, d - 1);
        branch(ex, ey, a + spread + rnd() * .08, next, d - 1);
        if (rnd() > .45) branch(ex, ey, a + (rnd() - .5) * .34, next * .82, d - 1);
      })(rootX, rootY, -Math.PI * .64, ph * 1.081, 8);
      var shadow = function (canvas, px, from, to, leafDepth, leaf) {
        // One blur per layer: draw sharp off-screen, then blit once through the filter.
        var raw = document.createElement('canvas');
        raw.width = canvas.width = Math.round(W * q); raw.height = canvas.height = Math.round(H * q);
        var c = raw.getContext('2d'), out = canvas.getContext('2d');
        c.scale(q, q); c.strokeStyle = c.fillStyle = look.ink; c.lineCap = 'round';
        for (var i = 0; i < segs.length; i++) {
          var s = segs[i];
          if (s[4] >= from && s[4] <= to) { c.lineWidth = Math.max(1, s[4] * .95) * u; c.beginPath(); c.moveTo(s[0], s[1]); c.lineTo(s[2], s[3]); c.stroke(); }
          if (s[4] <= leafDepth && s[6] < .62) { c.beginPath(); c.ellipse(s[2] + (s[7] - .5) * 26 * u, s[3] + (s[6] - .3) * 30 * u, leaf * (.75 + s[7] * .7) * u, leaf * (.3 + s[6] * .25) * u, s[5] + (s[7] - .5) * 2.6, 0, 7); c.fill(); }
        }
        blur(canvas, out, px); out.drawImage(raw, 0, 0);
      };
      shadow(layers[0], 12, 1, 4, 2, 15);
      shadow(layers[1], 4, 3, 8, 3, 19);
      // The dim wall covers everything except four slanted panes of window light with a soft penumbra.
      var wall = layers[2], w = wall.getContext('2d'), gap = 22 * u;
      wall.width = Math.round((W + 96) * q); wall.height = Math.round((H + 96) * q);
      w.scale(q, q); w.fillStyle = look.wall; w.fillRect(0, 0, W + 96, H + 96);
      w.globalCompositeOperation = 'destination-out'; blur(wall, w, 9);
      w.translate(48 + cx, 48 + cy); w.rotate(-.04); w.transform(1, 0, -.34, 1, 0, 0);
      for (var sx = -1; sx <= 1; sx += 2) for (var sy = -1; sy <= 1; sy += 2) w.fillRect(sx > 0 ? gap / 2 : -gap / 2 - pw, sy > 0 ? gap / 2 : -gap / 2 - ph, pw, ph);
      target.replaceWith(scene);
      if (!version) {
        // Centre the actual capital-letter ink, not its line box. Segoe UI and the macOS fonts have different baselines.
        var word = scene.querySelector('.fts-brand span'), font = getComputedStyle(word);
        w.font = font.fontWeight + ' ' + font.fontSize + ' ' + font.fontFamily;
        var metrics = w.measureText('FORSION');
        var shift = -(metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent - metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) / 2;
        if (Number.isFinite(shift)) word.style.transform = 'translateY(' + shift + 'px)';
      }
      splash.dataset.scene = 'tree-shadow';
      if (reduce || animation === 'none') splash.dataset.still = '';
      return true;
    } catch (_) { return false; } // No 2D canvas: the classic mark below stays.
  }
  var IMAGE = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
  var usable = function (item) { return !!item && typeof item.image === 'string' && item.image.length <= 2000000 && IMAGE.test(item.image); };
  var classic = value.scene === 'classic';
  // Classic keeps its original rule: artwork, else the app icon. The tree shadow yields only to chosen
  // startup artwork and never follows the app icon, so reduced motion gets the artwork's still poster,
  // a still format as it is, or the still tree shadow.
  var asset = classic ? (!reduce && value.splash) || value.icon : value.splash;
  if (!classic && reduce && asset && !asset.poster && !/^data:image\/(png|jpeg);/.test(asset.image)) asset = null;
  var usesIcon = asset && asset === value.icon;
  if ((animation === 'none' || (reduce && !classic)) && asset && asset.poster) asset = { image: asset.poster };
  if (!classic && !usable(asset) && treeShadow(original)) { /* default scene mounted */ }
  else if (usable(asset)) {
    var img = document.createElement('img');
    img.className = 'forsion-startup-image';
    if (usesIcon) img.style.borderRadius = '22%';
    img.alt = '';
    img.onerror = function () {
      splash.removeAttribute('data-custom-motion');
      if (classic || !treeShadow(img)) img.replaceWith(original);
    };
    img.src = asset.image;
    original.replaceWith(img);
    splash.dataset.customMotion = reduce ? 'none' : animation === 'default' ? (value.splash ? 'none' : 'pulse') : animation;
  } else if (animation !== 'default' || reduce) splash.dataset.customMotion = reduce ? 'none' : animation;

  // App readiness controls exit, with a hard upper bound even if initialization fails.
  var start = Date.now(), done = false, frame = 0;
  var ceiling = setTimeout(fade, 10000);
  function fade() {
    if (done) return;
    done = true;
    clearTimeout(ceiling);
    cancelAnimationFrame(frame);
    splash.classList.add('out');
    setTimeout(function () { splash.remove(); style.remove(); }, 450);
  }
  splash.addEventListener('animationend', function (event) {
    if (event.animationName === 'tangu-splash-out') splash.remove();
  });
  function waitForPaint() {
    if (done) return;
    var root = document.getElementById('root');
    if (!root || !root.firstChild) { frame = requestAnimationFrame(waitForPaint); return; }
    frame = requestAnimationFrame(function () {
      var elapsed = Date.now() - start;
      // The classic mark leaves at its loop seam; the tree shadow has none and only keeps a short minimum.
      var duration = reduce ? 0 : splash.dataset.scene === 'tree-shadow' ? Math.max(0, 1300 - elapsed)
        : Math.max(0, Math.max(1, Math.ceil((elapsed + 300) / 1600)) * 1600 - 300 - elapsed);
      setTimeout(fade, duration);
    });
  }
  waitForPaint();
})();
