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
    @media(prefers-reduced-motion:reduce) { #tangu-splash .tangu-splash-logo, #tangu-splash #panel-stack, #tangu-splash #tree-mark, #tangu-splash #tree-outline, #tangu-splash[data-custom-motion] > :first-child { animation:none; } #tangu-splash #tree-outline {opacity:0} }';
  document.head.appendChild(style);
  var asset = (!reduce && value.splash) || value.icon;
  if (animation === 'none' && asset && asset.poster) asset = { image: asset.poster };
  var valid = asset && typeof asset.image === 'string' && asset.image.length <= 2000000 && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.image);
  if (valid) {
    var original = splash.firstElementChild;
    var img = document.createElement('img');
    img.className = 'forsion-startup-image';
    img.alt = '';
    img.onerror = function () { img.replaceWith(original); splash.removeAttribute('data-custom-motion'); };
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
      var duration = reduce ? 0 : Math.max(0, Math.max(1, Math.ceil((elapsed + 300) / 1600)) * 1600 - 300 - elapsed);
      setTimeout(fade, duration);
    });
  }
  waitForPaint();
})();
