# 第 2.12 话 · 人类补完计划

Forsion 2.12 的宣传片，也是 Forsion Video Studio 的示例工程。EVA 风格的致敬，4:3，150 BPM，配乐是原创的「决战 II」。

- 场景按顺序首尾相接地播放；每个场景的 `hits` 是从场景开头算起的拍点。画面的切点从这里读，配乐的重音也按同一份表写（`fvs cues` 导出）。
- 纯文字的卡片用 `data-seq` / `data-in` 声明，不用写代码；复杂的场景写在 `js` 块里，能用的函数见技能说明。
- 素材：`assets/` 里是三个 Agent 的头像，`audio/` 里是配乐。

```fvs
{
  "fvs": 1,
  "title": "第 2.12 话 · 人类补完计划",
  "lang": "zh-CN",
  "width": 1440,
  "height": 1080,
  "fps": 30,
  "tempo": { "bpm": 150, "beatsPerBar": 4 },
  "class": "stage sb fb",
  "background": "#000",
  "fonts": ["https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Noto+Sans+SC:wght@400;500;700&family=Noto+Serif+SC:wght@500;700;900&display=swap"],
  "audio": [{ "src": "audio/episode-2.12-score.mp3", "role": "score" }]
}
```

```css
/* palette and type (from the promo's shared sheet) */
:root {
  --bg: #0e0d0c;
  --panel: #171514;
  --fg: #efebe7;
  --muted: #a1968e;
  --line: #2c2826;
  --accent: #c9957a;

  /* Study A · brand warm */
  --a-paper: #f3ebe1;
  --a-ink: #201915;
  --a-copper: #bd866c;
  --a-copper-soft: #debcaa;
  --a-cream: #fbf2e9;
  --a-muted: #8b7c70;
  /* Study B · EVA homage */
  --b-black: #000000;
  --b-white: #f2f0ea;
  --b-red: #e3161b;
  --b-orange: #ff6a13;
  --b-green: #38ff8b;
  /* Study C · product cinema */
  --c-stage: #0c0c0e;
  --c-ui-bg: #f7f7f6;
  --c-ui-card: #ffffff;
  --c-ui-line: #e2e2e0;
  --c-ui-text: #171717;
  --c-ui-muted: #8a8a8a;
  --c-ui-accent: #262626;
  --c-gold: #a88427;

  --f-display: 'Noto Serif SC', 'Songti SC', serif;
  --f-body: 'Noto Sans SC', 'Inter', 'PingFang SC', system-ui, sans-serif;
  --f-ui: 'Inter', 'Noto Sans SC', system-ui, sans-serif;
  --f-latin-serif: 'Instrument Serif', 'Times New Roman', serif;
  --f-cond: 'Barlow Condensed', 'Arial Narrow', sans-serif;
  --f-mono: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace;
}

/* ───────── stage base ───────── */
.stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; }
.stage * { box-sizing: border-box; }
.stage p, .stage h2, .stage h4, .stage ul { margin: 0; padding: 0; }
.stage li { list-style: none; }
.abs { position: absolute; }
.grain { position: absolute; inset: 0; pointer-events: none; background-size: 200px 200px; }

/* ───────── B · 第 2.12 话 ───────── */
.sb { width: 1440px; height: 1080px; background: var(--b-black); color: var(--b-white); font-family: var(--f-display); }
.sb-card { position: absolute; inset: 0; background: var(--b-black); }
.sb .k { position: absolute; font-weight: 900; line-height: 1; color: var(--b-white); white-space: nowrap; }
.sb .e { position: absolute; font: 600 52px/1 var(--f-display); letter-spacing: .08em; color: var(--b-white); white-space: nowrap; }
.sb-c1 .k { left: 110px; top: 250px; font-size: 340px; transform: scaleX(.8); transform-origin: 0 0; }
.sb-c1 .e { left: 760px; top: 650px; }
.sb-c2 .k { left: 1010px; top: 70px; font-size: 300px; writing-mode: vertical-rl; transform: scaleY(.86); transform-origin: 0 0; }
.sb-c2 .e { left: 110px; top: 900px; }
.sb-c3 .k { left: 0; right: 0; top: 330px; text-align: center; font-size: 380px; transform: scaleX(.78); }
.sb-c3 .e { left: 0; right: 0; top: 190px; text-align: center; font-size: 46px; }
.sb-c4 .k { left: 110px; top: 540px; font-size: 360px; transform: scaleX(.8); transform-origin: 0 0; }
.sb-c4 .e { left: 118px; top: 420px; font-size: 48px; }
.sb-c5 { background: var(--b-white); }
.sb-c5 .k { left: 104px; top: 220px; font-size: 380px; color: var(--b-black); transform: scaleX(.8); transform-origin: 0 0; }
.sb-c5 .q { position: absolute; left: 720px; top: 220px; font: 900 380px/1 var(--f-display); color: var(--b-red); transform: scaleX(.8); transform-origin: 0 0; }
.sb-c5 .e { left: 112px; top: 760px; font: 700 64px/1 var(--f-cond); letter-spacing: .22em; color: var(--b-red); }
.sb-hud { position: absolute; inset: 0; background: var(--b-black); color: var(--b-orange); font-family: var(--f-cond); }
.sb-hex { position: absolute; inset: 0; opacity: .75; }
.sb-top { position: absolute; left: 70px; right: 70px; top: 46px; height: 58px; display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--b-orange); font: 700 30px var(--f-cond); letter-spacing: .16em; }
.sb-top .live { color: var(--b-red); }
.sb-box { position: absolute; border: 2px solid rgba(255, 106, 19, .75); background: rgba(0, 0, 0, .78); }
.sb-box .lbl { position: absolute; left: 16px; top: 10px; font: 700 22px var(--f-cond); letter-spacing: .18em; color: var(--b-orange); }
.sb-term { left: 70px; top: 140px; width: 690px; height: 250px; padding: 50px 22px 0; }
.sb-term p { font: 500 21px/1.62 var(--f-mono); color: var(--b-green); white-space: pre; min-height: 1.62em; }
.sb-sync { left: 790px; top: 140px; width: 580px; height: 250px; }
.sb-sync .num { position: absolute; left: 22px; top: 44px; font: 700 112px/1 var(--f-mono); color: var(--b-white); font-variant-numeric: tabular-nums; }
.sb-sync .num small { font-size: 52px; color: var(--b-orange); margin-left: 6px; }
.sb-sync canvas { position: absolute; left: 0; bottom: 8px; width: 576px; height: 80px; }
.sb-warn { left: 70px; top: 420px; width: 1300px; height: 240px; border: none; background: var(--b-black); }
.sb-warn::before, .sb-warn::after { content: ''; position: absolute; left: 0; right: 0; height: 24px; background: repeating-linear-gradient(-45deg, var(--b-red) 0 18px, var(--b-black) 18px 36px); }
.sb-warn::before { top: 0; } .sb-warn::after { bottom: 0; }
.sb-warn .wait, .sb-warn .go { position: absolute; inset: 24px 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.sb-warn .wait { font: 700 64px var(--f-cond); letter-spacing: .2em; color: var(--b-orange); }
.sb-warn .go .en { font: 700 76px/1 var(--f-cond); letter-spacing: .08em; color: var(--b-red); }
.sb-warn .go .zh { font: 900 64px/1 var(--f-display); color: var(--b-white); letter-spacing: .06em; }
.sb-magi { position: absolute; top: 700px; width: 414px; height: 320px; }
.sb-magi .name { position: absolute; left: 18px; top: 12px; font: 700 42px var(--f-cond); letter-spacing: .12em; color: var(--b-orange); }
.sb-magi .role { position: absolute; left: 20px; top: 62px; font: 500 20px var(--f-body); color: rgba(255, 106, 19, .8); letter-spacing: .1em; }
.sb-magi img { position: absolute; left: 18px; top: 110px; width: 184px; height: 184px; border-radius: 50%; filter: grayscale(1) contrast(1.25); border: 2px solid rgba(255, 106, 19, .6); }
.sb-magi .st { position: absolute; left: 220px; top: 128px; width: 176px; height: 152px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.sb-magi .ok { border: 2px solid var(--b-green); color: var(--b-green); }
.sb-magi .hand { border: 2px solid var(--b-red); background: var(--b-red); color: var(--b-black); }
.sb-magi .st b { font: 900 58px/1 var(--f-display); }
.sb-magi .st i { font: 700 20px var(--f-cond); letter-spacing: .16em; font-style: normal; }
.sb-t0 { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; }
.sb-t0 p { font: 700 44px/1 var(--f-display); letter-spacing: .08em; }
.sb-t0 p + p { font-size: 64px; letter-spacing: .04em; }
.sb-title .no { position: absolute; left: 112px; top: 112px; font: 900 76px/1 var(--f-display); transform: scaleX(.86); transform-origin: 0 0; white-space: nowrap; }
.sb-title .big1 { position: absolute; left: 96px; top: 222px; font: 900 350px/1 var(--f-display); transform: scaleX(.8); transform-origin: 0 0; white-space: nowrap; }
.sb-title .big2 { position: absolute; left: 100px; top: 578px; font: 900 250px/1 var(--f-display); transform: scaleX(.74); transform-origin: 0 0; white-space: nowrap; }
.sb-title .en { position: absolute; right: 110px; top: 876px; text-align: right; font: 700 34px/1.45 var(--f-display); letter-spacing: .06em; }
.sb-title .en span { font-size: 48px; }
.sb-title .brand { position: absolute; left: 114px; top: 982px; font: 600 26px var(--f-cond); letter-spacing: .6em; color: #8c8c8c; }
.sb-scan { position: absolute; inset: 0; pointer-events: none; background: repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0 2px, rgba(0,0,0,.28) 2px 3px); }
.sb-vig { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse 75% 70% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,.6) 100%); }
.sb .grain { opacity: .1; mix-blend-mode: screen; }
.sb-flash { position: absolute; inset: 0; background: var(--b-white); pointer-events: none; opacity: 0; }

/* ───────── film stage (1440 × 1080) ───────── */
.fb { width: 1440px; height: 1080px; background: var(--b-black); }
.fb .fb-hexbg { position: absolute; inset: 0; }
/* Forsion stands where NERV would: the red tree as the watermark behind the HUD, and as the mark on its bars */
.fb .fb-mark { position: absolute; right: -150px; top: 130px; width: 780px; height: 922px; fill: rgba(227, 22, 27, .075); }
.fb .orgmark { width: 30px; height: 36px; fill: var(--b-red); margin-right: 16px; vertical-align: -6px; flex: none; }
.fb .top > span:first-of-type, .fb .sb-top > span:first-of-type { display: inline-flex; align-items: center; }
.fb .scene, .fb .fb-card, .fb .fb-layer { position: absolute; inset: 0; overflow: hidden; }
.fb .solid { background: var(--b-black); }
.fb .inv { background: var(--b-white); }
.fb .fk { position: absolute; font: 900 100px/1 var(--f-display); color: var(--b-white); white-space: nowrap; transform: scaleX(.8); transform-origin: 0 0; }
.fb .fk.mid { left: 0; right: 0; text-align: center; transform-origin: 50% 0; }
.fb .fk.right { text-align: right; transform-origin: 100% 0; }
.fb .fk.vert { writing-mode: vertical-rl; transform: scaleY(.86); }
.fb .fe { position: absolute; font: 700 44px/1.35 var(--f-display); letter-spacing: .05em; color: var(--b-white); white-space: nowrap; }
.fb .fe.mid { left: 0; right: 0; text-align: center; }
.fb .inv .fk, .fb .inv .fe { color: var(--b-black); }
.fb .red { color: var(--b-red) !important; }
.fb .org { color: var(--b-orange) !important; }
.fb .dim { color: #8c8c8c !important; }
.fb .cond { font-family: var(--f-cond); font-weight: 700; letter-spacing: .2em; }
.fb .mono { font-family: var(--f-mono); }
.fb .sub { position: absolute; left: 0; right: 0; text-align: center; font: 900 54px/1.3 var(--f-display); color: var(--b-white); text-shadow: 0 0 8px #000, 3px 3px 0 #000, -2px -2px 0 #000; }
.fb .sub small { display: block; font: 700 34px/1.4 var(--f-display); color: #cfcfcf; letter-spacing: .03em; }
.fb .hud { color: var(--b-orange); font-family: var(--f-cond); }
.fb .panel { position: absolute; border: 2px solid rgba(255, 106, 19, .75); background: rgba(0, 0, 0, .8); }
.fb .panel > .lbl { position: absolute; left: 16px; top: 10px; font: 700 22px var(--f-cond); letter-spacing: .18em; color: var(--b-orange); }
.fb .top { position: absolute; left: 70px; right: 70px; top: 46px; height: 58px; display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--b-orange); font: 700 30px var(--f-cond); letter-spacing: .16em; color: var(--b-orange); }
.fb .top .alt { color: var(--b-red); }

/* photosensitivity warning */
.fb .warn { position: absolute; left: 170px; right: 170px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; gap: 24px; }
.fb .warn hr { border: 0; height: 2px; width: 120px; background: var(--b-red); margin: 0; }
.fb .warn h2 { font: 900 76px/1.1 var(--f-display); color: var(--b-white); }
.fb .warn .en { font: 600 30px var(--f-cond); letter-spacing: .3em; color: #a8a8a8; }
.fb .warn p { font: 500 31px/1.75 var(--f-body); color: #dcdcdc; }
.fb .warn p.small { font: 400 21px/1.6 var(--f-ui); color: #8e8e8e; }

/* boot */
.fb-boot { background: var(--b-black); }
.fb-bootlines { position: absolute; left: 110px; top: 200px; display: grid; gap: 10px; }
.fb-bootlines p { font: 500 34px/1.4 var(--f-mono); color: var(--b-green); white-space: pre; min-height: 1.4em; }
.fb-bootlines p.bad { color: var(--b-red); }
.fb-bootmark { position: absolute; right: 60px; bottom: -40px; font: 700 420px/1 var(--f-cond); color: transparent; -webkit-text-stroke: 2px rgba(56, 255, 139, .18); }

/* half: agent vs human */
.fb .sysbox { top: 140px; width: 610px; height: 600px; padding: 90px 30px 0; display: grid; align-content: start; gap: 22px; }
.fb .sysbox h3 { position: absolute; left: 28px; top: 20px; margin: 0; font: 700 64px/1 var(--f-cond); letter-spacing: .12em; }
.fb .sysrow { display: grid; grid-template-columns: 170px 1fr 70px; align-items: center; gap: 16px; font: 700 30px var(--f-cond); letter-spacing: .12em; color: var(--b-white); }
.fb .sysrow i { display: block; height: 22px; border: 2px solid rgba(56, 255, 139, .5); position: relative; }
.fb .sysrow i::after { content: ''; position: absolute; inset: 2px; right: calc(2px + (1 - var(--f, 0)) * (100% - 4px)); background: var(--b-green); }
.fb .sysrow b { color: var(--b-green); text-align: right; }
.fb .sysbox.human { border-color: var(--b-red); }
.fb .sysbox.human h3 { color: var(--b-red); }
.fb .sysbox.human .sysrow i { border-color: rgba(227, 22, 27, .45); }
.fb .sysbox.human .sysrow b { color: var(--b-red); }
.fb .nodata { position: absolute; left: 0; right: 0; top: 270px; text-align: center; font: 700 110px/1 var(--f-cond); letter-spacing: .1em; color: var(--b-red); }
.fb .link { position: absolute; left: 70px; right: 70px; top: 766px; height: 44px; border: 2px dashed rgba(227, 22, 27, .8); display: flex; align-items: center; justify-content: center; font: 700 28px var(--f-cond); letter-spacing: .3em; color: var(--b-red); }

/* HUMAN.md */
.fb .hm-title { position: absolute; left: 0; right: 0; top: 230px; text-align: center; font: 700 180px/1 var(--f-mono); color: var(--b-white); letter-spacing: -.02em; white-space: pre; min-height: 1em; }
.fb .hm-sub { position: absolute; left: 0; right: 0; top: 452px; text-align: center; font: 700 44px var(--f-cond); letter-spacing: .4em; color: var(--b-orange); }
.fb .hm-q { position: absolute; left: 0; right: 0; top: 540px; text-align: center; font: 900 92px/1 var(--f-display); color: var(--b-white); }
.fb .hm-term { left: 250px; top: 720px; width: 940px; height: 270px; padding: 54px 26px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 30px; }
.fb .hm-term p { font: 500 28px/1.6 var(--f-mono); color: var(--b-green); white-space: pre; min-height: 1.6em; }

/* memory vs HUMAN.md */
.fb .half-l, .fb .half-r { position: absolute; top: 0; bottom: 0; width: 720px; }
.fb .half-l { left: 0; background: #101010; }
.fb .half-r { left: 720px; background: var(--b-black); box-shadow: inset 0 0 0 3px var(--b-orange); }
.fb .half-l .fe, .fb .half-r .fe { font-family: var(--f-cond); font-size: 96px; letter-spacing: .08em; }

/* layers */
.fb .gauge { position: absolute; left: 70px; top: 140px; width: 130px; height: 860px; border: 2px solid rgba(255, 106, 19, .6); }
.fb .gauge span { position: absolute; left: 12px; font: 700 20px/1.2 var(--f-cond); letter-spacing: .12em; color: var(--b-orange); }
.fb .gauge i { position: absolute; left: 0; right: 0; height: 2px; background: rgba(255, 106, 19, .35); }
.fb .gauge .mark { position: absolute; left: -2px; right: -2px; height: 90px; border: 3px solid var(--b-red); background: rgba(227, 22, 27, .2); }
.fb .layer { position: absolute; left: 240px; top: 140px; width: 1130px; height: 860px; }
.fb .layer .head { position: absolute; left: 0; top: 0; font: 700 40px var(--f-cond); letter-spacing: .16em; color: var(--b-orange); }
.fb .layer .file { position: absolute; left: 0; top: 56px; font: 700 34px var(--f-mono); color: var(--b-white); }
.fb .idcard { left: 0; top: 130px; width: 330px; height: 470px; }
.fb .idcard img { position: absolute; left: 40px; top: 60px; width: 250px; height: 250px; border-radius: 50%; filter: grayscale(1) contrast(1.25); border: 2px solid rgba(255, 106, 19, .6); }
.fb .idcard .big { position: absolute; left: 0; right: 0; text-align: center; font: 700 52px/1.1 var(--f-cond); letter-spacing: .1em; color: var(--b-white); }
.fb .idcard .small { position: absolute; left: 0; right: 0; text-align: center; font: 500 24px/1.3 var(--f-body); color: var(--b-orange); letter-spacing: .1em; }
.fb .rules { position: absolute; left: 380px; top: 150px; right: 0; display: grid; gap: 26px; }
.fb .rules p { font: 900 44px/1.25 var(--f-display); color: var(--b-white); white-space: nowrap; }
.fb .rules p::before { content: '▶'; color: var(--b-orange); font-size: 30px; margin-right: 18px; vertical-align: 6px; }
.fb .layer .cap { position: absolute; left: 0; right: 0; top: 700px; font: 900 76px/1 var(--f-display); color: var(--b-white); }
.fb .layer .cap small { display: block; margin-top: 14px; font: 700 28px var(--f-cond); letter-spacing: .3em; color: var(--b-orange); }

/* evolve */
.fb .ev-sync { left: 560px; top: 140px; width: 810px; height: 520px; }
.fb .ev-sync .num { position: absolute; left: 30px; top: 70px; font: 700 220px/1 var(--f-mono); color: var(--b-white); font-variant-numeric: tabular-nums; }
.fb .ev-sync .num small { font-size: 90px; color: var(--b-orange); margin-left: 8px; }
.fb .ev-sync canvas { position: absolute; left: 0; bottom: 10px; width: 806px; height: 170px; }
.fb .ev-log { left: 70px; top: 140px; width: 460px; height: 520px; padding: 60px 20px 0; display: grid; align-content: start; gap: 16px; }
.fb .ev-log p { font: 500 24px/1.4 var(--f-mono); color: var(--b-green); white-space: nowrap; }
.fb .ev-log p b { color: var(--b-orange); font-weight: 700; margin-right: 12px; }
.fb .stamp { position: absolute; left: 70px; top: 690px; padding: 10px 22px; border: 3px solid var(--b-orange); font: 700 40px var(--f-cond); letter-spacing: .2em; color: var(--b-orange); }
.fb .final-ctl { position: absolute; left: 70px; right: 70px; top: 330px; height: 420px; background: var(--b-black); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
.fb .final-ctl::before, .fb .final-ctl::after { content: ''; position: absolute; left: 0; right: 0; height: 22px; background: repeating-linear-gradient(-45deg, var(--b-orange) 0 18px, var(--b-black) 18px 36px); }
.fb .final-ctl::before { top: 0; } .fb .final-ctl::after { bottom: 0; }
.fb .final-ctl .zh { font: 900 120px/1 var(--f-display); color: var(--b-white); }
.fb .final-ctl .en { font: 700 48px/1 var(--f-cond); letter-spacing: .24em; color: var(--b-orange); }
.fb .final-ctl .four { font: 700 34px var(--f-cond); letter-spacing: .3em; color: #8c8c8c; }

/* MAGI: the waiting state */
.fb .sb-magi .wait { border: 2px solid var(--b-orange); color: var(--b-orange); }

/* interface field */
.fb .field { position: absolute; inset: 0; }

/* montage */
.fb .files { position: absolute; left: 70px; right: 70px; top: 140px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
.fb .files .panel { position: relative; height: 560px; }
.fb .files img, .fb .files .noimg { position: absolute; left: 22px; right: 22px; top: 70px; aspect-ratio: 1; width: calc(100% - 44px); border-radius: 50%; filter: grayscale(1) contrast(1.2); border: 2px solid rgba(255, 106, 19, .6); }
.fb .files .noimg { display: flex; align-items: center; justify-content: center; font: 700 110px var(--f-cond); color: rgba(255, 106, 19, .8); filter: none; }
.fb .files .nm { position: absolute; left: 0; right: 0; top: 320px; text-align: center; font: 700 42px var(--f-cond); letter-spacing: .12em; color: var(--b-white); }
.fb .files .rl { position: absolute; left: 0; right: 0; top: 374px; text-align: center; font: 500 22px var(--f-body); color: var(--b-orange); }
.fb .files .tabs { position: absolute; left: 14px; right: 14px; top: 430px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.fb .files .tabs span { font: 500 18px/1 var(--f-body); color: rgba(255, 255, 255, .6); border: 1px solid rgba(255, 106, 19, .45); padding: 7px 0; text-align: center; }
.fb .files .tabs span.on { background: var(--b-orange); color: var(--b-black); font-weight: 700; }
.fb .skills { left: 70px; top: 140px; width: 1300px; height: 880px; padding: 70px 30px 0; }
.fb .skills .ops { display: flex; gap: 10px; margin-bottom: 26px; }
.fb .skills .ops span { font: 700 26px var(--f-body); padding: 8px 18px; border: 2px solid rgba(255, 106, 19, .6); color: var(--b-orange); }
.fb .skills .ops span.on { background: var(--b-orange); color: var(--b-black); }
.fb .skills .row { display: grid; grid-template-columns: 80px 1fr 220px; align-items: center; font: 500 36px/2.05 var(--f-mono); color: var(--b-white); border-bottom: 1px solid rgba(255, 106, 19, .25); }
.fb .skills .row b { font: 700 24px var(--f-cond); letter-spacing: .2em; color: var(--b-green); text-align: right; }
.fb .skills .row b.off { color: #777; }
.fb .skills .row i { font: 700 22px var(--f-cond); color: var(--b-orange); font-style: normal; }
.fb .graph { position: absolute; left: 0; top: 0; width: 1440px; height: 1080px; }
.fb .graph path { fill: none; stroke: var(--b-orange); stroke-width: 3; stroke-dasharray: 1; stroke-dashoffset: var(--d, 1); }
.fb .node-a { position: absolute; left: 150px; width: 170px; height: 170px; border-radius: 50%; filter: grayscale(1) contrast(1.2); border: 3px solid var(--b-orange); }
.fb .node-s { position: absolute; left: 930px; width: 440px; height: 76px; border: 2px solid var(--b-orange); background: var(--b-black); font: 500 30px/72px var(--f-mono); color: var(--b-white); padding-left: 20px; }
.fb .chat { left: 70px; top: 200px; width: 560px; height: 520px; border-style: dashed; padding: 70px 26px 0; }
.fb .chat .bub { font: 500 28px/1.55 var(--f-body); color: var(--b-white); background: rgba(255, 255, 255, .08); padding: 16px 20px; margin-bottom: 18px; }
.fb .chat .bub.me { background: rgba(255, 106, 19, .18); margin-left: 80px; }
.fb .note { left: 760px; top: 170px; width: 610px; height: 620px; background: #0b0b0b; padding: 70px 30px 0; border-color: var(--b-green); }
.fb .note .lbl { color: var(--b-green) !important; }
.fb .note h4 { margin: 0 0 18px; font: 900 44px/1.2 var(--f-display); color: var(--b-white); }
.fb .note .ln { height: 14px; background: rgba(255, 255, 255, .22); margin: 12px 0; }
.fb .note .todo { font: 500 26px/1.6 var(--f-body); color: var(--b-white); }
.fb .note .todo::before { content: '☐ '; color: var(--b-green); }
.fb .note table { width: 100%; border-collapse: collapse; margin-top: 16px; font: 500 22px var(--f-mono); color: var(--b-white); }
.fb .note td { border: 1px solid rgba(56, 255, 139, .45); padding: 6px 10px; }
.fb .arrow { position: absolute; left: 640px; top: 430px; font: 700 90px var(--f-cond); color: var(--b-orange); }
.fb .slots { position: absolute; left: 70px; right: 70px; top: 170px; display: grid; gap: 22px; }
.fb .slot { position: relative; height: 150px; border: 2px solid rgba(255, 106, 19, .7); display: flex; align-items: center; padding: 0 40px; font: 700 88px var(--f-cond); letter-spacing: .1em; color: var(--b-white); background: rgba(0, 0, 0, .8); }
.fb .slot b { margin-left: auto; font-size: 32px; letter-spacing: .25em; color: var(--b-green); }
.fb .slot.ctx { height: 90px; font-size: 44px; color: var(--b-orange); }
.fb .device { position: absolute; border: 3px solid var(--b-orange); background: rgba(0, 0, 0, .85); }
.fb .device.pc { left: 130px; top: 240px; width: 700px; height: 440px; }
.fb .device.pc::after { content: ''; position: absolute; left: -60px; right: -60px; bottom: -40px; height: 24px; border: 3px solid var(--b-orange); border-top: 0; }
.fb .device.ph { left: 1050px; top: 250px; width: 230px; height: 440px; border-radius: 30px; }
.fb .device p { position: absolute; left: 0; right: 0; text-align: center; font: 700 30px/1.3 var(--f-cond); letter-spacing: .15em; color: var(--b-orange); }
.fb .device .scr { position: absolute; inset: 30px; display: grid; align-content: start; gap: 10px; }
.fb .device .scr i { display: block; height: 16px; background: rgba(56, 255, 139, .35); }
.fb .wire { position: absolute; left: 830px; top: 450px; width: 220px; height: 4px; background: repeating-linear-gradient(90deg, var(--b-orange) 0 16px, transparent 16px 28px); background-position-x: calc(var(--p, 0) * 280px); }

/* release: the special edition logo, then the credit */
.fb .emblem { position: absolute; left: 540px; top: 110px; width: 360px; height: 426px; overflow: visible; }
.fb .emblem .fs-line { stroke-dasharray: 1; stroke-dashoffset: var(--d, 1); }
.fb .relt { position: absolute; left: 0; right: 0; top: 640px; display: flex; flex-direction: column; align-items: center; gap: 18px; }
.fb .relt .nm { font: 700 64px/1 var(--f-cond); letter-spacing: .3em; padding-left: .3em; color: var(--b-white); }
.fb .relt .zh { font: 900 66px/1 var(--f-display); color: var(--b-white); }
.fb .relt .url { font: 500 28px var(--f-mono); color: #8c8c8c; }
.fb .credit { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; }
.fb .credit .by { font: 600 30px var(--f-cond); letter-spacing: .6em; padding-left: .6em; color: #8c8c8c; }
.fb .credit .st { font: 700 84px/1 var(--f-cond); letter-spacing: .18em; padding-left: .18em; color: var(--b-white); }
.fb .credit hr { width: 90px; height: 2px; border: 0; background: var(--b-red); margin: 10px 0 0; }
```

```html stage
<canvas class="fb-hexbg" width="1440" height="1080"></canvas>
<svg class="fb-mark" viewBox="190 110 630 745" aria-hidden="true"><path d="M 351.75 194.02 C 350.54 192.44 350.51 190.75 351.62 188.97 A 2.32 2.23 -4.1 0 1 352.18 188.35 Q 352.45 188.14 377.03 170.33 Q 378.81 169.04 380.94 170.66 A 1.56 1.37 2.7 0 1 381.25 170.96 L 457.27 270.65 A 1.10 1.09 36.3 0 0 459.17 270.36 Q 488.11 189.64 508.46 132.09 C 509.66 128.70 511.09 127.48 514.58 128.66 Q 525.38 132.31 537.42 136.64 C 540.07 137.59 540.80 138.98 539.79 141.83 C 521.49 193.83 502.53 245.51 483.80 297.56 Q 482.68 300.66 484.29 302.73 Q 505.89 330.31 532.05 363.38 A 1.19 1.19 0.0 0 0 533.80 363.52 Q 534.34 363.02 535.34 361.84 Q 627.38 253.56 660.04 215.04 Q 678.56 193.20 685.40 185.40 Q 687.33 183.20 690.21 184.21 A 2.71 2.63 72.5 0 1 690.95 184.61 Q 707.19 197.49 711.84 201.05 Q 715.05 203.50 712.51 206.54 Q 662.78 265.87 661.72 266.73 C 660.84 267.46 659.22 269.62 658.86 270.69 A 1.52 1.51 9.2 0 0 660.30 272.68 Q 709.32 272.68 772.51 272.17 Q 776.38 272.13 776.36 275.70 Q 776.30 286.38 776.27 299.94 Q 776.26 302.63 773.50 302.66 Q 747.38 302.92 635.01 302.74 A 2.13 2.13 0.0 0 0 633.33 303.56 Q 586.76 363.64 576.45 376.72 Q 575.70 377.67 575.76 378.36 A 1.82 1.78 -2.1 0 0 577.56 380.00 Q 655.56 380.14 794.54 380.05 Q 798.66 380.05 798.67 383.78 Q 798.78 424.81 798.64 449.48 Q 798.63 451.75 795.88 452.50 A 1.21 1.08 -48.3 0 1 795.62 452.53 Q 675.18 452.52 576.49 452.55 C 573.01 452.55 572.16 453.97 572.16 457.39 Q 572.16 533.97 572.17 536.25 C 572.18 541.20 575.34 540.71 579.58 540.71 Q 704.78 540.66 751.42 540.80 C 754.22 540.80 755.95 541.53 755.99 544.50 Q 756.26 569.28 755.97 601.50 C 755.93 605.42 753.69 605.66 750.20 605.65 Q 674.11 605.47 575.94 605.68 Q 572.11 605.69 572.09 609.50 C 571.84 658.94 574.71 709.90 582.89 760.66 Q 586.77 784.77 593.78 804.72 Q 598.40 817.89 606.39 828.98 C 607.88 831.05 608.78 833.10 606.45 834.40 A 2.48 2.46 -61.0 0 1 605.12 834.79 L 464.88 834.73 A 0.91 0.79 -30.5 0 1 464.56 834.67 C 461.92 833.56 462.41 831.38 463.85 829.19 Q 471.41 817.68 475.57 803.81 C 478.89 792.75 481.68 780.44 483.44 769.18 Q 489.67 729.42 491.88 694.24 Q 495.65 634.21 495.25 574.00 C 495.21 568.29 494.67 563.43 489.98 559.95 Q 446.96 528.05 404.86 497.12 Q 399.01 492.82 392.18 495.15 Q 347.42 510.44 303.99 524.82 C 287.18 530.38 271.49 536.15 255.47 540.97 Q 253.29 541.63 251.75 539.77 A 1.65 1.62 17.8 0 1 251.47 539.24 Q 247.56 526.18 243.84 513.43 Q 242.95 510.37 245.26 508.76 A 1.08 0.98 16.6 0 1 245.57 508.61 Q 274.09 499.79 365.02 471.31 Q 366.75 470.77 367.33 469.60 A 2.40 2.40 0.0 0 0 366.47 466.51 C 315.32 433.70 274.89 409.24 212.01 371.24 Q 210.33 370.22 210.63 367.29 A 1.53 1.41 -29.6 0 1 210.82 366.70 Q 215.00 359.72 224.25 343.59 C 225.71 341.05 227.12 340.14 229.83 341.42 Q 231.65 342.28 238.85 346.65 Q 274.91 368.52 330.50 402.04 A 1.34 1.33 -63.4 0 0 332.42 401.40 Q 332.93 400.18 332.45 397.89 Q 327.93 376.01 314.75 306.22 C 314.11 302.81 315.15 301.13 318.52 300.32 Q 325.88 298.53 340.79 294.43 Q 345.49 293.13 346.43 297.91 Q 360.63 370.27 371.39 423.31 Q 371.72 424.94 373.88 426.38 Q 394.04 439.77 491.39 505.78 C 492.92 506.81 494.58 506.38 495.20 504.47 A 1.60 1.41 57.3 0 0 495.27 504.01 Q 495.38 416.33 495.13 391.20 Q 495.08 386.11 492.58 379.29 A 4.36 4.22 -76.7 0 0 491.77 377.93 Q 488.96 374.71 479.85 362.65 Q 419.13 282.27 351.75 194.02 Z"/></svg>
<div data-fvs-scenes></div>
<div class="sb-scan"></div><div class="sb-vig"></div><div class="grain"></div><div class="sb-flash" data-fvs-flash></div>
```

```js stage
// film grain, then the backdrops: hexes for the system check and MAGI only; elsewhere the Forsion tree
grain('.grain')
const hex = $('.fb-hexbg'), hg = hex.getContext('2d'), hr = rng(12), R = 36
for (let row = 0, y = 0; y < 1120; row++, y += R * 1.5) for (let x = (row % 2) * R * .866; x < 1480; x += R * 1.732) {
  hg.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i + Math.PI / 6; hg.lineTo(x + R * .94 * Math.cos(a), y + R * .94 * Math.sin(a)) } hg.closePath()
  if (hr() > .965) { hg.fillStyle = 'rgba(227,22,27,.3)'; hg.fill() }
  hg.strokeStyle = 'rgba(255,106,19,.14)'; hg.lineWidth = 1.5; hg.stroke()
}
const HEX = during(['half', 'magi'])
const MARK = during(['humanmd', 'layers', 'evolve', [scenes.control.hits[4], scenes.control.t1], 'montage'])
const mark = $('.fb-mark')
H(t => { hex.style.display = inside(t, HEX) ? '' : 'none'; mark.style.display = inside(t, MARK) ? '' : 'none' })
// Forsion stands where NERV would: the red tree also marks every HUD title bar
const TREE = mark.querySelector('path').getAttribute('d')
for (const el of $$('.top > span:first-child, .sb-top > span:first-child')) el.insertAdjacentHTML('afterbegin', `<svg class="orgmark" viewBox="190 110 630 745" aria-hidden="true"><path d="${TREE}"/></svg>`)
// projector weave: cards jitter, HUDs flicker
const cards = $$('.fb-card'), huds = $$('.hud'), wr = rng(3), weave = [...Array(240)].map(() => [wr() * 2.4 - 1.2, wr() * 2.4 - 1.2, wr()])
H(t => { const [jx, jy, f] = weave[Math.floor(t * 24) % 240]; for (const c of cards) c.style.translate = `${jx}px ${jy}px`; for (const h of huds) h.style.filter = `brightness(${.94 + f * .12})` })
```

## warning · 警告

```fvs
{ "length": "3 bars", "class": "solid" }
```

```html
<div class="warn">
  <hr><h2>光敏性癫痫警告</h2><span class="en">PHOTOSENSITIVE SEIZURE WARNING</span>
  <p>本片包含快速切换的画面、闪光与强烈的明暗对比。极少数观众在观看此类画面时，可能出现光敏性癫痫发作或其他不适。</p>
  <p>观看时请保持室内明亮，并与屏幕保持适当距离。如出现头晕、视觉异常、抽搐或其他不适，请立即停止观看并咨询医生。</p>
  <p class="small">This film contains flashing lights and rapidly changing images that may trigger seizures in people with photosensitive epilepsy. Watch in a well-lit room at a comfortable distance, and stop immediately if you feel unwell.</p>
</div>
```

```js
K('.warn', [[t0 + .15, { o: 0 }], [t0 + .6, { o: 1 }], [t1 - .6, { o: 1 }], [t1 - .1, { o: 0 }]])
```

## boot · 启动

```fvs
{ "length": "2 bars", "class": "fb-boot" }
```

```html
<div class="fb-bootlines">
  <p>FORSION SYSTEM 2.12</p>
  <p>AGENT HARNESS ........ OK</p>
  <p>SOUL ................. OK</p>
  <p>MEMORY ............... OK</p>
  <p>SKILLS ............... OK</p>
  <p>TOOLS · TEAMS ........ OK</p>
  <p class="bad">HUMAN ................ ??</p>
</div>
<div class="fb-bootmark">2.12</div>
```

```js
type('.fb-bootlines p', t0 + 0.12, 80, 0.36)
const bad = $('.bad')
H(t => { bad.style.opacity = t > t0 + 2.45 && Math.floor(t * 6) % 2 ? .25 : 1 })
```

## cards · 标题卡

```fvs
{ "length": "4 bars", "hits": [0, 2, 4, 6, 8, 10, 12, 14] }
```

```html
<div data-seq="h0">
  <div class="fb-card solid"><span class="fk" style="left:110px;top:250px;font-size:340px">人格</span><span class="fe" style="left:760px;top:650px">SOUL</span></div>
  <div class="fb-card solid"><span class="fk vert" style="left:1010px;top:70px;font-size:300px">记忆</span><span class="fe" style="left:110px;top:900px">MEMORY</span></div>
  <div class="fb-card solid"><span class="fe mid" style="top:190px;font-size:46px">SKILLS</span><span class="fk mid" style="top:330px;font-size:380px">技能</span></div>
  <div class="fb-card solid"><span class="fk right" style="right:110px;top:180px;font-size:320px">工具</span><span class="fe" style="left:118px;top:820px">TOOLS</span></div>
  <div class="fb-card solid"><span class="fe" style="left:118px;top:420px;font-size:48px">HARNESS</span><span class="fk" style="left:110px;top:540px;font-size:360px">进化</span></div>
  <div class="fb-card inv"><span class="fk mid" style="top:260px;font-size:360px">团队</span><span class="fe mid" style="top:760px">TEAMS</span></div>
  <div class="fb-card solid"><span class="fe" style="right:110px;top:120px;font-size:48px;text-align:right">PROJECTS</span><span class="fk" style="left:110px;top:560px;font-size:360px">项目</span></div>
  <div class="fb-card solid ticker">
    <span class="fk" style="left:120px;top:250px;font-size:64px">更强的模型</span>
    <span class="fk" style="left:120px;top:370px;font-size:64px">更长的上下文</span>
    <span class="fk" style="left:120px;top:490px;font-size:64px">更丰富的 Skills</span>
    <span class="fk" style="left:120px;top:610px;font-size:64px">更完善的 Memory</span>
    <span class="fk" style="left:120px;top:730px;font-size:64px">更复杂的 Harness</span>
  </div>
</div>
```

```js
flash(hits[0], .6)
cut('.ticker .fk', hits[7], { stagger: beat / 4 })
```

## years · 多年来

```fvs
{ "length": "2 bars", "hits": [0, 2, 4, 6] }
```

```html
<div class="fb-card solid">
  <span class="fk" style="left:110px;top:200px;font-size:210px" data-in="h0">多年来，</span>
  <span class="fk" style="left:112px;top:470px;font-size:130px" data-in="h1">我们一直在建造</span>
  <span class="fk" style="left:112px;top:640px;font-size:130px" data-in="h2">更好的 Agent。</span>
  <span class="fe" style="right:110px;top:900px;font-size:34px" data-in="h3">FOR YEARS, WE HAVE BEEN BUILDING BETTER AGENTS.</span>
</div>
```

## half · 一半

```fvs
{ "length": "2 bars", "hits": [0, 3], "class": "hud" }
```

```html
<div class="top"><span>HUMAN–AGENT SYSTEM / 系统构成</span><span class="alt">● CHECK</span></div>
<div class="panel sysbox" style="left:70px"><h3 class="org">AGENT</h3>
  <div class="sysrow"><span>SOUL</span><i></i><b>OK</b></div>
  <div class="sysrow"><span>MEMORY</span><i></i><b>OK</b></div>
  <div class="sysrow"><span>SKILLS</span><i></i><b>OK</b></div>
  <div class="sysrow"><span>TOOLS</span><i></i><b>OK</b></div>
  <div class="sysrow"><span>HARNESS</span><i></i><b>OK</b></div>
  <div class="sysrow"><span>TEAMS</span><i></i><b>OK</b></div>
</div>
<div class="panel sysbox human" style="left:760px"><h3>HUMAN</h3>
  <div class="sysrow"><span>——</span><i style="--f:0"></i><b>—</b></div>
  <div class="sysrow"><span>——</span><i style="--f:0"></i><b>—</b></div>
  <div class="sysrow"><span>——</span><i style="--f:0"></i><b>—</b></div>
  <div class="sysrow"><span>——</span><i style="--f:0"></i><b>—</b></div>
  <div class="sysrow"><span>——</span><i style="--f:0"></i><b>—</b></div>
  <div class="sysrow"><span>——</span><i style="--f:0"></i><b>—</b></div>
  <div class="nodata">NO DATA</div>
</div>
<div class="link">INTERFACE ▸ UNDEFINED / 协作方式：未定义</div>
<p class="sub" style="top:850px" data-in="h1">The Agent was only half the system.<small>Agent，只是系统的一半。</small></p>
```

```js
// the Agent's gauges fill a sixteenth apart; the human side blinks NO DATA
K('.sysbox:not(.human) .sysrow i', [[t0 + beat / 4, { '--f': 0 }], [t0 + beat + beat / 4, { '--f': 1 }, 'out']], { stagger: beat / 4 })
const nod = $('.nodata')
H(t => { nod.style.opacity = Math.floor(t * 4) % 2 ? .2 : 1 })
flash(t0, .5)
```

## question · 人类？

```fvs
{ "length": "1 bar", "hits": [0] }
```

```html
<div class="fb-card inv"><span class="fk" style="left:104px;top:220px;font-size:380px;color:#000">人类</span><span class="fk red" style="left:720px;top:220px;font-size:380px">？</span><span class="fe red" style="left:112px;top:760px;font:700 64px/1 var(--f-cond);letter-spacing:.22em">HUMAN — UNDEFINED</span></div>
```

```js
flash(t0, .9)
```

## title · 片名

```fvs
{ "length": "2 bars", "hits": [0, 2] }
```

```html
<div data-seq="h0">
  <div class="fb-card solid"><span class="fe mid" style="top:430px;font-size:44px">EPISODE 2.12</span><span class="fe mid" style="top:500px;font-size:64px">COMPLETE THE OTHER HALF.</span></div>
  <div class="fb-card solid">
    <span class="fk" style="left:112px;top:112px;font-size:76px">第 2.12 话</span>
    <span class="fk" style="left:96px;top:222px;font-size:350px">人类</span>
    <span class="fk" style="left:100px;top:578px;font-size:250px;transform:scaleX(.74)">补完计划</span>
    <span class="fe" style="right:110px;top:876px;font-size:34px;text-align:right">EPISODE 2.12<br><span style="font-size:48px">COMPLETE THE OTHER HALF.</span></span>
    <span class="fe" style="left:114px;top:982px;font:600 26px var(--f-cond);letter-spacing:.6em;color:#8c8c8c">FORSION</span>
  </div>
</div>
```

```js
flash(hits[1], .85)
```

## twosides · 两面

```fvs
{ "length": "1 bar", "hits": [0, 1.5, 2.5] }
```

```html
<div class="fb-card solid">
  <span class="fk" style="left:110px;top:220px;font-size:240px" data-in="h0">但协作，</span>
  <span class="fk" style="left:110px;top:520px;font-size:240px" data-in="h1">有两面。</span>
  <span class="fe" style="right:110px;top:890px" data-in="h2">BUT COLLABORATION HAS TWO SIDES.</span>
</div>
```

## humanmd · HUMAN.md

```fvs
{ "length": "2 bars", "hits": [0, 1.5, 2.5, 3.5], "class": "hud" }
```

```html
<p class="hm-title">HUMAN.md</p>
<p class="hm-sub">THE HUMAN HARNESS</p>
<p class="hm-q">我们应该怎样一起工作？</p>
<div class="panel hm-term"><span class="lbl">HUMAN.md · 结构</span><p>## 我会怎样调整</p><p>## 需要你来决定</p><p>## 需要你补充</p><p>## 可选学习</p></div>
```

```js
type('.hm-title', t0 + .05, 22)
cut('.hm-sub', hits[1])
slide('.hm-q', hits[2], { y: 14 })
cut('.hm-term', hits[3])
type('.hm-term p', hits[3] + beat / 4, 40, beat / 2)
flash(t0, .5)
```

## asks · 问题

```fvs
{ "length": "2 bars", "hits": [0, 1.5, 3, 4.5, 6] }
```

```html
<div data-seq="h0">
  <div class="fb-card solid"><span class="fk" style="left:110px;top:260px;font-size:110px">什么事情，</span><span class="fk" style="left:110px;top:420px;font-size:150px">Agent 应该自己判断？</span></div>
  <div class="fb-card solid"><span class="fk right" style="right:110px;top:140px;font-size:110px">什么事情，</span><span class="fk" style="left:110px;top:420px;font-size:230px">需要</span><span class="fk" style="left:110px;top:680px;font-size:230px">人类确认？</span></div>
  <div class="fb-card inv"><span class="fk vert" style="left:1060px;top:90px;font-size:200px">人类，</span><span class="fk" style="left:110px;top:620px;font-size:130px">应该补充哪些信息？</span></div>
  <div class="fb-card solid"><span class="fk mid" style="top:220px;font-size:130px">怎样沟通，</span><span class="fk mid" style="top:470px;font-size:170px">才能减少反复？</span></div>
  <div class="fb-card solid"><span class="fk" style="left:110px;top:180px;font-size:180px">双方，</span><span class="fk" style="left:110px;top:460px;font-size:300px">如何分工？</span></div>
</div>
```

## memory · MEMORY 与 HUMAN.md

```fvs
{ "length": "2 bars", "hits": [0, 4], "class": "solid" }
```

```html
<div class="half-l"><span class="fe dim" style="left:80px;top:270px">MEMORY</span><span class="fk" style="left:80px;top:420px;font-size:92px;color:#bdbdbd">我知道</span><span class="fk" style="left:80px;top:540px;font-size:92px;color:#bdbdbd">你什么。</span></div>
<div class="half-r"><span class="fe org mono" style="left:70px;top:270px;font-family:var(--f-mono)">HUMAN.md</span><span class="fk" style="left:70px;top:420px;font-size:92px">我们怎样</span><span class="fk" style="left:70px;top:540px;font-size:92px">合作得更好。</span></div>
```

```js
cut('.half-r', hits[1])
K('.half-l', [[hits[1], { o: 1 }], [hits[1] + .3, { o: .35 }]])
flash(hits[1], .7)
```

## magi · MAGI 审议

```fvs
{ "length": "3 bars", "hits": [0, 1, 2, 4, 5, 6], "class": "hud" }
```

```html
<div class="sb-top"><span>MAGI · 协作审议 / DELIBERATION</span><span class="live">● HUMAN.md</span></div>
<div class="sb-box sb-term r1"><span class="lbl">提案 01 · PROPOSAL</span><p>按钮圆角 8px → 10px</p><p>类别：技术实现</p><p>规则：技术实现可以自主选择</p></div>
<div class="sb-box sb-term r2"><span class="lbl">提案 02 · PROPOSAL</span><p>调整定价方案</p><p>类别：产品决策</p><p>规则：产品决策必须让我确认</p></div>
<div class="sb-box sb-sync"><span class="lbl">判断归属 · OWNER</span><div class="num own1" style="color:var(--b-green)">AGENT</div><div class="num own2" style="color:var(--b-red)">HUMAN</div></div>
<div class="sb-box sb-warn"><div class="go g1" style="--c:var(--b-green)"><span class="en" style="color:var(--b-green)">APPROVED · AUTONOMOUS</span><span class="zh">技术实现 · Agent 自主判断</span></div><div class="go g2"><span class="en">HUMAN CONFIRMATION REQUIRED</span><span class="zh">需要人类确认 · 产品决策</span></div></div>
<div class="sb-box sb-magi" style="left:70px"><span class="name">ARIA · 1</span><span class="role">情感 · 表达</span><img src="assets/aria.jpg" alt=""><div class="st wait"><b>审议</b><i>VOTING</i></div><div class="st ok"><b>承认</b><i>APPROVE</i></div><div class="st hand"><b>移交</b><i>TO HUMAN</i></div></div>
<div class="sb-box sb-magi" style="left:513px"><span class="name">RECITA · 2</span><span class="role">证据 · 可行性</span><img src="assets/recita.jpg" alt=""><div class="st wait"><b>审议</b><i>VOTING</i></div><div class="st ok"><b>承认</b><i>APPROVE</i></div><div class="st hand"><b>移交</b><i>TO HUMAN</i></div></div>
<div class="sb-box sb-magi" style="left:956px"><span class="name">ARIOSO · 3</span><span class="role">目标 · 取舍</span><img src="assets/arioso.jpg" alt=""><div class="st wait"><b>审议</b><i>VOTING</i></div><div class="st ok"><b>承认</b><i>APPROVE</i></div><div class="st hand"><b>移交</b><i>TO HUMAN</i></div></div>
```

```js
// two proposals: the first stays with the Agent, the second goes to the human
const R2 = hits[3]
S('.r1, .own1, .g1', 0, R2)
S('.r2, .own2, .g2', R2, 999)
type('.r1 p', t0 + .1, 50, .2)
type('.r2 p', R2 + .1, 50, .2)
K('.sb-sync .num', [[hits[2] - .01, { o: 0 }], [hits[2], { o: 1 }, 'step'], [R2, { o: 0 }, 'step'], [hits[5] - .01, { o: 0 }], [hits[5], { o: 1 }, 'step']])
const g1 = $('.g1'), g2 = $('.g2')
H(t => { g1.style.opacity = t < hits[2] ? 0 : 1; g2.style.opacity = t < hits[5] ? 0 : (Math.floor((t - hits[5]) * 6) % 2 ? .3 : 1) })
$$('.sb-magi').forEach((el, i) => {
  const ok = hits[1] + i * beat / 4, hand = hits[4] + i * beat / 4
  S(el.querySelector('.wait'), 0, ok)
  S(el.querySelector('.ok'), ok, hand)
  S(el.querySelector('.hand'), hand, 999)
})
flash(t0, .5); flash(R2, .5)
```

## layers · 双层协作

```fvs
{ "length": "4 bars", "hits": [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 14], "class": "hud" }
```

```html
<div class="top"><span>HUMAN.md · 双层协作 / TWO LAYERS</span><span class="alt">● HUMAN HARNESS</span></div>
<div class="gauge"><span style="top:14px">DEPTH</span><i style="top:300px"></i><span style="top:190px">01<br>AGENT</span><i style="top:560px"></i><span style="top:450px">02<br>PROJECT</span><div class="mark"></div></div>
<div class="l1"><div class="layer"><span class="head">LAYER 01 · AGENT-LEVEL</span><span class="file">HUMAN.md</span>
  <div class="panel idcard"><img src="assets/arioso.jpg" alt=""><span class="big" style="top:330px">ARIOSO</span><span class="small" style="top:392px">长期协作 · LONG-TERM</span></div>
  <div class="rules"><p>不要频繁询问实现细节</p><p>产品决策必须让我确认</p><p>技术实现可以自主选择</p><p>汇报时先给结论</p><p>不确定时说明风险，别停下</p></div>
  <div class="cap">长期的人机关系<small>AGENT LAYER · 随长期协作逐渐积累</small></div></div></div>
<div class="l2"><div class="layer"><span class="head">LAYER 02 · PROJECT-LEVEL</span><span class="file">.tangu/HUMAN.md</span>
  <div class="panel idcard"><span class="small" style="top:70px">PROJECT</span><span class="big" style="top:160px;font-size:64px">FORSION<br>2.12</span><span class="small" style="top:392px">本项目 · THIS PROJECT</span></div>
  <div class="rules"><p>当前版本优先保证 macOS</p><p>发布前需要真人视觉验收</p><p>架构修改需要先讨论</p><p>某些领域由 Human 最终判断</p></div>
  <div class="cap">具体项目中的工作方式<small>PROJECT LAYER · 只属于当前项目</small></div></div></div>
```

```js
const L2 = hits[7]
S('.l1', 0, L2); S('.l2', L2, 999)
slide('.l1 .rules p', hits[1], { x: -20 }, { stagger: beat })
slide('.l2 .rules p', hits[8], { x: -20 }, { stagger: beat })
cut('.l1 .cap', hits[6])
cut('.l2 .cap', hits[12])
K('.gauge .mark', [[L2, { y: 150 }], [L2 + beat, { y: 410 }, 'out']])
flash(t0, .5); flash(L2, .6)
```

## evolve · 协作进化

```fvs
{ "length": "3 bars", "hits": [0, 1, 4, 5, 8, 9], "class": "hud" }
```

```html
<div class="top"><span>HUMAN.md · 协作进化 / EVOLUTION</span><span class="alt">● LEARNING</span></div>
<div class="panel ev-log"><span class="lbl">修改历史 · HISTORY</span><p><b>v09</b>实现细节 → 不再逐项询问</p><p><b>v10</b>汇报 → 先给结论</p><p><b>v11</b>UI 方案 → 先做出来再选</p></div>
<div class="panel ev-sync"><span class="lbl">人机同步率 · SYNC RATIO</span><div class="num"><span class="n">41.3</span><small>%</small></div><canvas width="1612" height="340"></canvas></div>
<div class="stamp">HUMAN.md UPDATED</div>
<p class="sub q" style="top:840px">「这种事情以后不用再问我。」</p>
<p class="sub q" style="top:840px">「以后这种报告先给结论。」</p>
<p class="sub q" style="top:840px">「UI 方案先做出来让我选，不要一直讨论。」</p>
```

```js
// each quote (even hits) is answered by a HUMAN.md update on the next hit
const UPD = [hits[1], hits[3], hits[5]]
const SYNC = [41.3, 67.2, 84.6, 99.8]
$$('.sub.q').forEach((el, i) => S(el, hits[2 * i], hits[2 * i + 2] ?? t1))
$$('.ev-log p').forEach((el, i) => cut(el, UPD[i]))
const stamp = $('.stamp')
H(t => { let o = 0; for (const u of UPD) { const k = t - u; if (k >= 0 && k < .8) o = Math.floor(k * 8) % 2 ? .35 : 1 } stamp.style.opacity = o })
const evn = $('.n')
H(t => {
  let v = SYNC[0]
  for (let i = 0; i < 3; i++) v += (SYNC[i + 1] - SYNC[i]) * prog(t, UPD[i], UPD[i] + 1, 'out')
  evn.textContent = v.toFixed(1)
})
const wave = $('canvas'), wg = wave.getContext('2d')
H(t => {
  if (t < t0 - .1 || t > t1 + .1) return
  const W = wave.width, Hh = wave.height, sync = (parseFloat(evn.textContent) - 41.3) / (99.8 - 41.3), ph = 2.8 * (1 - sync)
  wg.clearRect(0, 0, W, Hh)
  wg.strokeStyle = 'rgba(255,106,19,.25)'; wg.lineWidth = 2
  for (let x = 0; x < W; x += 64) { wg.beginPath(); wg.moveTo(x, 0); wg.lineTo(x, Hh); wg.stroke() }
  const line = (c, off) => { wg.strokeStyle = c; wg.lineWidth = 7; wg.beginPath(); for (let x = 0; x <= W; x += 8) { const y = Hh / 2 + Math.sin(x / 90 + t * 6 + off) * Hh * .34; x ? wg.lineTo(x, y) : wg.moveTo(x, y) } wg.stroke() }
  line('#ff6a13', 0); line('#38ff8b', ph)
})
flash(t0, .5)
```

## control · 控制权

```fvs
{ "length": "2 bars", "hits": [0, 1, 2, 3, 4] }
```

```html
<div data-seq="h0">
  <div class="fb-card solid"><span class="fk" style="left:110px;top:250px;font-size:320px">可查看</span><span class="fe" style="left:118px;top:660px">VIEW</span></div>
  <div class="fb-card solid"><span class="fk vert" style="left:1070px;top:80px;font-size:290px">可编辑</span><span class="fe" style="left:110px;top:880px">EDIT</span></div>
  <div class="fb-card solid"><span class="fe mid" style="top:220px;font-size:46px">HISTORY</span><span class="fk mid" style="top:320px;font-size:340px">可追踪</span></div>
  <div class="fb-card inv"><span class="fk right" style="right:110px;top:260px;font-size:320px">可撤销</span><span class="fe" style="left:118px;top:820px">UNDO</span></div>
  <div class="fb-layer hud">
    <div class="top"><span>HUMAN.md · 控制权 / CONTROL</span><span class="alt">● HUMAN</span></div>
    <div class="final-ctl"><span class="four">可查看 · 可编辑 · 可追踪 · 可撤销</span><span class="zh">最终控制权，属于人类</span><span class="en">HUMAN HAS FINAL CONTROL</span></div>
  </div>
</div>
```

```js
flash(hits[0], .5); flash(hits[4], .6)
```

## interface · Interface

```fvs
{ "length": "3 bars", "hits": [0, 4, 8] }
```

```html
<div data-seq="h0">
  <div class="fb-card solid"><span class="fk" style="left:110px;top:230px;font-size:260px">不是 AI</span><span class="fk" style="left:110px;top:540px;font-size:260px">训练人类。</span></div>
  <div class="fb-card solid"><span class="fk" style="left:110px;top:230px;font-size:220px">也不是人类</span><span class="fk" style="left:110px;top:520px;font-size:260px">训练 AI。</span></div>
  <div class="fb-card solid field-card"><canvas class="field" width="1440" height="1080"></canvas>
    <span class="fe org cond" style="left:0;right:0;text-align:center;top:150px;font-size:40px;letter-spacing:.4em">INTERFACE FIELD</span>
    <span class="fk mid" style="top:340px;font-size:140px">而是，共同优化</span><span class="fk mid" style="top:530px;font-size:132px">彼此之间的 Interface。</span></div>
</div>
```

```js
// octagonal field rings expanding from the centre, like an AT field
const fc = $('canvas.field'), fg = fc.getContext('2d'), f0 = hits[2]
H(t => {
  if (t < f0 || t > t1) return
  fg.clearRect(0, 0, 1440, 1080)
  for (let k = 0; k < 9; k++) {
    const r = ((t - f0) * 420 + k * 130) % 1170 + 20, a = Math.max(0, 1 - r / 1170)
    fg.strokeStyle = `rgba(255,106,19,${a * .85})`; fg.lineWidth = 8
    fg.beginPath()
    for (let i = 0; i <= 8; i++) { const ang = Math.PI / 8 + i * Math.PI / 4; const x = 720 + r * Math.cos(ang), y = 540 + r * Math.sin(ang) * .92; i ? fg.lineTo(x, y) : fg.moveTo(x, y) }
    fg.stroke()
  }
})
flash(hits[2], .8)
```

## montage · 系统

```fvs
{ "length": "8 bars", "hits": [0, 2, 4, 8, 12, 16, 17, 18, 20, 24, 28] }
```

```html
<div class="fb-layer hud mo-space">
  <div class="top"><span>AGENT SPACE / 人员档案</span><span>PERSONNEL FILES</span></div>
  <div class="files">
    <div class="panel"><img src="assets/arioso.jpg" alt=""><span class="nm">ARIOSO</span><span class="rl">目标 · 取舍</span><div class="tabs"><span>人格</span><span>技能</span><span>MCP</span><span class="on">协作</span><span>成长</span><span>日程</span></div></div>
    <div class="panel"><img src="assets/aria.jpg" alt=""><span class="nm">ARIA</span><span class="rl">情感 · 表达</span><div class="tabs"><span>人格</span><span>技能</span><span>MCP</span><span class="on">协作</span><span>成长</span><span>日程</span></div></div>
    <div class="panel"><img src="assets/recita.jpg" alt=""><span class="nm">RECITA</span><span class="rl">证据 · 可行性</span><div class="tabs"><span>人格</span><span>技能</span><span>MCP</span><span class="on">协作</span><span>成长</span><span>日程</span></div></div>
    <div class="panel"><div class="noimg">C</div><span class="nm">CODING</span><span class="rl">代码 · 实现</span><div class="tabs"><span>人格</span><span>技能</span><span>MCP</span><span class="on">协作</span><span>成长</span><span>日程</span></div></div>
    <div class="panel"><div class="noimg">M</div><span class="nm">MUSE</span><span class="rl">主动 · 跟进</span><div class="tabs"><span>人格</span><span>技能</span><span>MCP</span><span class="on">协作</span><span>成长</span><span>日程</span></div></div>
  </div>
  <p class="sub s1" style="top:760px">Agent 不再只是一个 Prompt。</p><p class="sub s2" style="top:760px">而是在 Forsion 中长期存在的数字协作者。</p>
</div>
<div class="fb-layer hud mo-skills">
  <div class="top"><span>GLOBAL SKILLS / 能力资产</span><span>15 SKILLS</span></div>
  <div class="panel skills"><span class="lbl">SKILLS · 全局</span><div class="ops"><span>查看</span><span>搜索</span><span>导入</span><span>新建</span><span>编辑</span><span>复制</span><span>停用</span></div>
    <div class="row"><i>01</i><span>amadeus-note-format</span><b>ENABLED</b></div>
    <div class="row"><i>02</i><span>web-research</span><b>ENABLED</b></div>
    <div class="row"><i>03</i><span>document-writing-cn</span><b>ENABLED</b></div>
    <div class="row"><i>04</i><span>data-analysis-python</span><b>ENABLED</b></div>
    <div class="row"><i>05</i><span>code-review</span><b>ENABLED</b></div>
    <div class="row"><i>06</i><span>self-brainstorm</span><b>ENABLED</b></div>
    <div class="row"><i>07</i><span>automation-suggest</span><b class="off">DISABLED</b></div>
    <div class="row"><i>08</i><span>skill-creator</span><b>ENABLED</b></div>
  </div>
</div>
<div class="fb-layer hud mo-shared">
  <div class="top"><span>SHARED SKILLS / AGENT × SKILLS</span><span>共享 · 借用</span></div>
  <svg class="graph" viewBox="0 0 1440 1080" aria-hidden="true"></svg>
  <img class="node-a" src="assets/arioso.jpg" alt="" style="top:220px"><img class="node-a" src="assets/aria.jpg" alt="" style="top:450px"><img class="node-a" src="assets/recita.jpg" alt="" style="top:680px">
  <div class="node-s" style="top:180px">web-research</div><div class="node-s" style="top:320px">document-writing-cn</div><div class="node-s" style="top:460px">code-review</div><div class="node-s" style="top:600px">data-analysis-python</div><div class="node-s" style="top:740px">self-brainstorm</div>
  <p class="sub" style="top:900px">能力，不再绑定某一个 Agent。</p>
</div>
<div class="fb-layer hud mo-am">
  <div class="top"><span>TANGU → AMADEUS / 对话 → 成果</span><span>KNOWLEDGE</span></div>
  <div class="panel chat"><span class="lbl">CONVERSATION · 临时</span><div class="bub me">把今天的发布结论整理一下。</div><div class="bub">结论：HUMAN.md 双层协作说明上线；Skills 可共享；新模型接入。已写入笔记。</div></div>
  <div class="arrow">▶▶</div>
  <div class="panel note"><span class="lbl">AMADEUS · NOTE</span><h4>Forsion 2.12 发布纪要</h4><div class="ln" style="width:92%"></div><div class="ln" style="width:78%"></div>
    <p class="todo">发布前真人视觉验收</p><p class="todo">更新 HUMAN.md 示例</p>
    <table><tr><td>模块</td><td>负责人</td><td>状态</td></tr><tr><td>HUMAN.md</td><td>Arioso</td><td>完成</td></tr><tr><td>Skills</td><td>Recita</td><td>验收</td></tr></table></div>
  <p class="sub" style="top:830px">Conversation is temporary. Work should remain.<small>对话会过去，成果应当留下。</small></p>
</div>
<div class="fb-layer hud mo-models">
  <div class="top"><span>INTELLIGENCE LAYER / 智能层</span><span>MODELS</span></div>
  <div class="slots"><div class="slot">GPT-6 SOL<b>ONLINE</b></div><div class="slot">GPT-6 LUNA<b>ONLINE</b></div><div class="slot">CLAUDE OPUS 5.5<b>ONLINE</b></div><div class="slot ctx">CONTEXT · 更灵活的上下文管理</div></div>
  <p class="sub" style="top:880px">Bring the intelligence you want.</p>
</div>
<div class="fb-layer hud mo-dev">
  <div class="top"><span>REMOTE · MOBILE / 多设备</span><span class="alt">● LINKED</span></div>
  <div class="device pc"><div class="scr"><i style="width:80%"></i><i style="width:60%"></i><i style="width:72%"></i><i style="width:40%"></i></div><p style="top:470px">WORKSTATION · 项目 · 文件 · 工具</p></div>
  <div class="wire"></div>
  <div class="device ph"><div class="scr"><i style="width:90%"></i><i style="width:70%"></i></div><p style="top:470px">MOBILE</p></div>
  <p class="sub" style="top:840px">协作，不被一台设备限制。</p>
</div>
```

```js
// six panels; hits: 0 space · 1 s1 · 2 s2 · 3 skills · 4 shared · 5 amadeus · 6 arrow · 7 note · 8 sub · 9 models · 10 devices
seq('.fb-layer', [hits[0], hits[3], hits[4], hits[5], hits[9], hits[10]])
slide('.mo-space .files .panel', hits[0], { y: 30 }, { stagger: beat / 4 })
S('.mo-space .s1', hits[1], hits[2]); S('.mo-space .s2', hits[2], 999)
cut('.mo-skills .row', hits[3], { stagger: .05 })
const opEls = $$('.mo-skills .ops span')
H(t => { const i = Math.floor((t - hits[3]) / (beat / 2)) - 1; opEls.forEach((el, k) => el.classList.toggle('on', k === i)) })
// shared skills: every Agent reaches the skills it borrows
const sy = [220, 450, 680], ky = [180, 320, 460, 600, 740]
const EDGES = [[0, 0], [0, 1], [0, 3], [1, 1], [1, 2], [1, 4], [2, 0], [2, 2], [2, 3], [2, 4]]
$('.mo-shared .graph').innerHTML = EDGES.map(([a, s]) => `<path pathLength="1" d="M320 ${sy[a] + 85} C 620 ${sy[a] + 85}, 640 ${ky[s] + 38}, 930 ${ky[s] + 38}"/>`).join('')
K('.mo-shared .graph path', [[hits[4] + beat / 4, { '--d': 1 }], [hits[4] + beat * 1.5, { '--d': 0 }, 'out']], { stagger: beat / 8 })
slide('.mo-am .arrow', hits[6], { x: -30 })
K('.mo-am .note', [[hits[6] - .01, { o: 0, x: -60 }], [hits[6], { o: .4 }, 'step'], [hits[7], { o: 1, x: 0 }, 'out']])
cut('.mo-am .note > *:not(.lbl)', hits[7], { stagger: beat / 4 })
K('.mo-am .chat', [[hits[7], { o: 1 }], [hits[8], { o: .3 }]])
cut('.mo-am .sub', hits[8])
slide('.mo-models .slot', hits[9], { x: -40 }, { stagger: beat / 2 })
K('.mo-dev .wire', [[hits[10], { '--p': 0 }], [t1, { '--p': 4 }, 'lin']])
for (const k of [0, 3, 4, 5, 9, 10]) flash(hits[k], .45)
```

## finale · 补完

```fvs
{ "length": "9 bars", "hits": [0, 4, 8, 12, 16, 20] }
```

```html
<div data-seq="h0">
  <div class="fb-card solid"><span class="fe mid" style="top:430px;font-size:48px;font-family:var(--f-display)">For years, we have been building better Agents.</span><span class="fe mid" style="top:520px;font-size:42px;color:#9a9a9a">多年来，我们一直在建造更好的 Agent。</span></div>
  <div class="fb-card solid"><span class="fe mid" style="top:430px;font-size:48px">Forsion 2.12 begins working on the other half.</span><span class="fe mid" style="top:520px;font-size:42px;color:#9a9a9a">Forsion 2.12，开始补完另一半。</span></div>
  <div class="fb-card solid"><span class="fk" style="left:112px;top:120px;font-size:90px">人类</span><span class="fe mid red" style="top:360px;font:900 250px/1 var(--f-display);letter-spacing:.02em">HUMAN.</span></div>
  <div class="fb-card solid"><span class="fk" style="left:110px;top:230px;font-size:220px">不是让人类</span><span class="fk" style="left:110px;top:520px;font-size:260px">适应 AI。</span></div>
  <div class="fb-card solid"><span class="fk" style="left:110px;top:230px;font-size:190px">而是让人与 AI，</span><span class="fk" style="left:110px;top:500px;font-size:240px">学会彼此适应。</span></div>
  <div class="fb-card solid">
    <span class="fk" style="left:112px;top:112px;font-size:76px">第 2.12 话</span>
    <span class="fk" style="left:96px;top:222px;font-size:350px">人类</span>
    <span class="fk" style="left:100px;top:578px;font-size:250px;transform:scaleX(.74)">补完计划</span>
    <span class="fe" style="right:110px;top:876px;font-size:34px;text-align:right">EPISODE 2.12<br><span style="font-size:48px">COMPLETE THE OTHER HALF.</span></span>
    <span class="fe" style="left:114px;top:982px;font:600 26px var(--f-cond);letter-spacing:.6em;color:#8c8c8c">FORSION</span>
  </div>
</div>
```

```js
flash(hits[2], .9); flash(hits[5], .9)
```

## release · 发布

```fvs
{ "length": "2 bars", "hits": [0, 4, 5], "class": "solid" }
```

```html
<svg class="emblem" viewBox="190 110 630 745" aria-hidden="true"><path class="fs-line" d="M 351.75 194.02 C 350.54 192.44 350.51 190.75 351.62 188.97 A 2.32 2.23 -4.1 0 1 352.18 188.35 Q 352.45 188.14 377.03 170.33 Q 378.81 169.04 380.94 170.66 A 1.56 1.37 2.7 0 1 381.25 170.96 L 457.27 270.65 A 1.10 1.09 36.3 0 0 459.17 270.36 Q 488.11 189.64 508.46 132.09 C 509.66 128.70 511.09 127.48 514.58 128.66 Q 525.38 132.31 537.42 136.64 C 540.07 137.59 540.80 138.98 539.79 141.83 C 521.49 193.83 502.53 245.51 483.80 297.56 Q 482.68 300.66 484.29 302.73 Q 505.89 330.31 532.05 363.38 A 1.19 1.19 0.0 0 0 533.80 363.52 Q 534.34 363.02 535.34 361.84 Q 627.38 253.56 660.04 215.04 Q 678.56 193.20 685.40 185.40 Q 687.33 183.20 690.21 184.21 A 2.71 2.63 72.5 0 1 690.95 184.61 Q 707.19 197.49 711.84 201.05 Q 715.05 203.50 712.51 206.54 Q 662.78 265.87 661.72 266.73 C 660.84 267.46 659.22 269.62 658.86 270.69 A 1.52 1.51 9.2 0 0 660.30 272.68 Q 709.32 272.68 772.51 272.17 Q 776.38 272.13 776.36 275.70 Q 776.30 286.38 776.27 299.94 Q 776.26 302.63 773.50 302.66 Q 747.38 302.92 635.01 302.74 A 2.13 2.13 0.0 0 0 633.33 303.56 Q 586.76 363.64 576.45 376.72 Q 575.70 377.67 575.76 378.36 A 1.82 1.78 -2.1 0 0 577.56 380.00 Q 655.56 380.14 794.54 380.05 Q 798.66 380.05 798.67 383.78 Q 798.78 424.81 798.64 449.48 Q 798.63 451.75 795.88 452.50 A 1.21 1.08 -48.3 0 1 795.62 452.53 Q 675.18 452.52 576.49 452.55 C 573.01 452.55 572.16 453.97 572.16 457.39 Q 572.16 533.97 572.17 536.25 C 572.18 541.20 575.34 540.71 579.58 540.71 Q 704.78 540.66 751.42 540.80 C 754.22 540.80 755.95 541.53 755.99 544.50 Q 756.26 569.28 755.97 601.50 C 755.93 605.42 753.69 605.66 750.20 605.65 Q 674.11 605.47 575.94 605.68 Q 572.11 605.69 572.09 609.50 C 571.84 658.94 574.71 709.90 582.89 760.66 Q 586.77 784.77 593.78 804.72 Q 598.40 817.89 606.39 828.98 C 607.88 831.05 608.78 833.10 606.45 834.40 A 2.48 2.46 -61.0 0 1 605.12 834.79 L 464.88 834.73 A 0.91 0.79 -30.5 0 1 464.56 834.67 C 461.92 833.56 462.41 831.38 463.85 829.19 Q 471.41 817.68 475.57 803.81 C 478.89 792.75 481.68 780.44 483.44 769.18 Q 489.67 729.42 491.88 694.24 Q 495.65 634.21 495.25 574.00 C 495.21 568.29 494.67 563.43 489.98 559.95 Q 446.96 528.05 404.86 497.12 Q 399.01 492.82 392.18 495.15 Q 347.42 510.44 303.99 524.82 C 287.18 530.38 271.49 536.15 255.47 540.97 Q 253.29 541.63 251.75 539.77 A 1.65 1.62 17.8 0 1 251.47 539.24 Q 247.56 526.18 243.84 513.43 Q 242.95 510.37 245.26 508.76 A 1.08 0.98 16.6 0 1 245.57 508.61 Q 274.09 499.79 365.02 471.31 Q 366.75 470.77 367.33 469.60 A 2.40 2.40 0.0 0 0 366.47 466.51 C 315.32 433.70 274.89 409.24 212.01 371.24 Q 210.33 370.22 210.63 367.29 A 1.53 1.41 -29.6 0 1 210.82 366.70 Q 215.00 359.72 224.25 343.59 C 225.71 341.05 227.12 340.14 229.83 341.42 Q 231.65 342.28 238.85 346.65 Q 274.91 368.52 330.50 402.04 A 1.34 1.33 -63.4 0 0 332.42 401.40 Q 332.93 400.18 332.45 397.89 Q 327.93 376.01 314.75 306.22 C 314.11 302.81 315.15 301.13 318.52 300.32 Q 325.88 298.53 340.79 294.43 Q 345.49 293.13 346.43 297.91 Q 360.63 370.27 371.39 423.31 Q 371.72 424.94 373.88 426.38 Q 394.04 439.77 491.39 505.78 C 492.92 506.81 494.58 506.38 495.20 504.47 A 1.60 1.41 57.3 0 0 495.27 504.01 Q 495.38 416.33 495.13 391.20 Q 495.08 386.11 492.58 379.29 A 4.36 4.22 -76.7 0 0 491.77 377.93 Q 488.96 374.71 479.85 362.65 Q 419.13 282.27 351.75 194.02 Z" fill="none" stroke="#e3161b" stroke-width="3" pathLength="1"/>
  <path class="fs-fill" d="M 351.75 194.02 C 350.54 192.44 350.51 190.75 351.62 188.97 A 2.32 2.23 -4.1 0 1 352.18 188.35 Q 352.45 188.14 377.03 170.33 Q 378.81 169.04 380.94 170.66 A 1.56 1.37 2.7 0 1 381.25 170.96 L 457.27 270.65 A 1.10 1.09 36.3 0 0 459.17 270.36 Q 488.11 189.64 508.46 132.09 C 509.66 128.70 511.09 127.48 514.58 128.66 Q 525.38 132.31 537.42 136.64 C 540.07 137.59 540.80 138.98 539.79 141.83 C 521.49 193.83 502.53 245.51 483.80 297.56 Q 482.68 300.66 484.29 302.73 Q 505.89 330.31 532.05 363.38 A 1.19 1.19 0.0 0 0 533.80 363.52 Q 534.34 363.02 535.34 361.84 Q 627.38 253.56 660.04 215.04 Q 678.56 193.20 685.40 185.40 Q 687.33 183.20 690.21 184.21 A 2.71 2.63 72.5 0 1 690.95 184.61 Q 707.19 197.49 711.84 201.05 Q 715.05 203.50 712.51 206.54 Q 662.78 265.87 661.72 266.73 C 660.84 267.46 659.22 269.62 658.86 270.69 A 1.52 1.51 9.2 0 0 660.30 272.68 Q 709.32 272.68 772.51 272.17 Q 776.38 272.13 776.36 275.70 Q 776.30 286.38 776.27 299.94 Q 776.26 302.63 773.50 302.66 Q 747.38 302.92 635.01 302.74 A 2.13 2.13 0.0 0 0 633.33 303.56 Q 586.76 363.64 576.45 376.72 Q 575.70 377.67 575.76 378.36 A 1.82 1.78 -2.1 0 0 577.56 380.00 Q 655.56 380.14 794.54 380.05 Q 798.66 380.05 798.67 383.78 Q 798.78 424.81 798.64 449.48 Q 798.63 451.75 795.88 452.50 A 1.21 1.08 -48.3 0 1 795.62 452.53 Q 675.18 452.52 576.49 452.55 C 573.01 452.55 572.16 453.97 572.16 457.39 Q 572.16 533.97 572.17 536.25 C 572.18 541.20 575.34 540.71 579.58 540.71 Q 704.78 540.66 751.42 540.80 C 754.22 540.80 755.95 541.53 755.99 544.50 Q 756.26 569.28 755.97 601.50 C 755.93 605.42 753.69 605.66 750.20 605.65 Q 674.11 605.47 575.94 605.68 Q 572.11 605.69 572.09 609.50 C 571.84 658.94 574.71 709.90 582.89 760.66 Q 586.77 784.77 593.78 804.72 Q 598.40 817.89 606.39 828.98 C 607.88 831.05 608.78 833.10 606.45 834.40 A 2.48 2.46 -61.0 0 1 605.12 834.79 L 464.88 834.73 A 0.91 0.79 -30.5 0 1 464.56 834.67 C 461.92 833.56 462.41 831.38 463.85 829.19 Q 471.41 817.68 475.57 803.81 C 478.89 792.75 481.68 780.44 483.44 769.18 Q 489.67 729.42 491.88 694.24 Q 495.65 634.21 495.25 574.00 C 495.21 568.29 494.67 563.43 489.98 559.95 Q 446.96 528.05 404.86 497.12 Q 399.01 492.82 392.18 495.15 Q 347.42 510.44 303.99 524.82 C 287.18 530.38 271.49 536.15 255.47 540.97 Q 253.29 541.63 251.75 539.77 A 1.65 1.62 17.8 0 1 251.47 539.24 Q 247.56 526.18 243.84 513.43 Q 242.95 510.37 245.26 508.76 A 1.08 0.98 16.6 0 1 245.57 508.61 Q 274.09 499.79 365.02 471.31 Q 366.75 470.77 367.33 469.60 A 2.40 2.40 0.0 0 0 366.47 466.51 C 315.32 433.70 274.89 409.24 212.01 371.24 Q 210.33 370.22 210.63 367.29 A 1.53 1.41 -29.6 0 1 210.82 366.70 Q 215.00 359.72 224.25 343.59 C 225.71 341.05 227.12 340.14 229.83 341.42 Q 231.65 342.28 238.85 346.65 Q 274.91 368.52 330.50 402.04 A 1.34 1.33 -63.4 0 0 332.42 401.40 Q 332.93 400.18 332.45 397.89 Q 327.93 376.01 314.75 306.22 C 314.11 302.81 315.15 301.13 318.52 300.32 Q 325.88 298.53 340.79 294.43 Q 345.49 293.13 346.43 297.91 Q 360.63 370.27 371.39 423.31 Q 371.72 424.94 373.88 426.38 Q 394.04 439.77 491.39 505.78 C 492.92 506.81 494.58 506.38 495.20 504.47 A 1.60 1.41 57.3 0 0 495.27 504.01 Q 495.38 416.33 495.13 391.20 Q 495.08 386.11 492.58 379.29 A 4.36 4.22 -76.7 0 0 491.77 377.93 Q 488.96 374.71 479.85 362.65 Q 419.13 282.27 351.75 194.02 Z" fill="#e3161b"/></svg>
<div class="relt"><span class="nm">FORSION 2.12</span><span class="zh">现已发布</span><span class="url">forsion.net</span></div>
```

```js
// the special edition logo: the tree in the film's red, drawn, then filled on the hit
K('.fs-line', [[t0 + .1, { '--d': 1 }], [hits[1] - .3, { '--d': 0 }, 'out']])
cut('.fs-fill', hits[1])
slide('.relt', hits[2], { y: 12 })
flash(hits[1], .45)
```

## credit · 出品

```fvs
{ "length": "2 bars", "hits": [0], "class": "solid" }
```

```html
<div class="credit"><span class="by">MADE BY</span><span class="st">FORSION VIDEO STUDIO</span><hr></div>
```

```js
K('.credit', [[t0, { o: 0 }], [t0 + .4, { o: 1 }], [t1 - 1.2, { o: 1 }], [t1 - .2, { o: 0 }]])
```
