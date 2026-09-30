// Handing work to the bundled Video Studio Director agent, and small in-place AI edits.
// Prompts are English (the model reads them); what the user typed goes in verbatim.
import CLI from '../generated/cli-src.js';
import MUSIC from '../generated/music-src.js';

export const AGENT = 'fvs-director';
export const TOOLS_VERSION = __FVS_VERSION__;

const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * Put the CLI and the music toolkit into the vault (a hidden folder in the plugin's work folder), so the
 * agent can run them wherever the engine runs. Rewritten only when the plugin version changes.
 * Returns vault-relative and (when the engine shares this filesystem) absolute paths.
 */
export async function ensureTools(ctx) {
  const app = ctx.app || {};
  const base = `${app.workFolder ? app.workFolder() : 'Forsion Video Studio'}/.fvs-tools`;
  const stamp = `${base}/VERSION`;
  let have = null;
  try { have = await app.readFile(stamp); } catch { have = null; }
  if ((have || '').trim() !== TOOLS_VERSION) {
    await app.writeFile(`${base}/fvs.mjs`, CLI);
    for (const [name, src] of Object.entries(MUSIC)) await app.writeFile(`${base}/music/${name}`, src);
    await app.writeFile(stamp, TOOLS_VERSION + '\n');
  }
  const abs = p => (app.hostPath ? app.hostPath(p) : null);
  return { cli: `${base}/fvs.mjs`, music: `${base}/music`, cliAbs: abs(`${base}/fvs.mjs`), musicAbs: abs(`${base}/music`) };
}

const q = s => JSON.stringify(s);

/** The context block every hand-off starts with. */
function contextBlock(ctx, s, tools) {
  const app = ctx.app || {};
  const abs = app.hostPath ? app.hostPath(s.path) : null;
  const sel = s.sel ? s.p.scenes.find(x => x.id === s.sel) : null;
  const lines = [
    'You are working on a Forsion Video Studio project (a web-animation video written as a .fvs.md file).',
    `Project file: ${abs ? q(abs) : q(s.path)}${abs ? ` (vault path ${q(s.path)})` : ' (vault-relative path)'}.`,
    'The user has it open in the Video Studio editor, which reloads the file whenever it changes on disk. Edit the file in place; keep everything you do not need to change byte for byte.',
    'Load the skill "forsion-video-studio" first if you have not read it in this conversation: it defines the file format, the scene API and the workflow.',
  ];
  if (tools) {
    const cli = tools.cliAbs || tools.cli;
    lines.push(`Command line: node ${q(cli)} <command> <project> (run "node ${q(cli)} help"). Start with "info" to see the scenes, times and hits; "check --runtime" after editing; "sheet" or "still" to look at frames.`);
    lines.push(`Music toolkit (Python): ${q(tools.musicAbs || tools.music)} (see its README.md).`);
  }
  if (sel) lines.push(`The user has scene "${sel.id}"${sel.title ? ` (${sel.title})` : ''} selected (${sel.t0.toFixed(2)}–${sel.t1.toFixed(2)} s).`);
  lines.push(`Playhead: ${s.time.toFixed(2)} s of ${s.p.length.toFixed(2)} s.`);
  return lines.join('\n');
}

export const TASKS = {
  ask: text => `Task from the user (their words):\n${text}\n\nDo it in the project file. When you are done, run the check, look at a contact sheet of the scenes you changed, and tell the user in their language what changed.`,
  score: () => 'Task: compose an original score for this video and add it to the project.\n1. Export the cue sheet (the "cues" command) and read the scenes, tempo and hits.\n2. Write a score script with the music toolkit that puts accents on the hits (stingers on the big cuts, breaths before hits that fall inside running music), render it to WAV/MP3 next to the project (for example audio/score.mp3) and add it to the project settings "audio" list.\n3. Run the "sync" command and fix hits that miss an accent.\nNever copy an existing melody. Tell the user what you made and how to change it.',
  render: out => `Task: render this project to MP4 at ${q(out)} with the "render" command (use --workers 3). If the browser driver or ffmpeg is missing, install or locate it (see the skill) and say what you did. When it is done, check a few frames of the MP4 and report the file path, length and size.`,
  sync: () => 'Task: check that the picture cuts land on the music. Run the "sync" command. For each hit that misses an accent, decide whether the hit or the music should move: nudge the hit to the accent when it is a picture-only cut, or suggest a score change. Edit the file, re-run the sync check, and report what you changed.',
  review: () => 'Task: review the cut. Make a contact sheet with the "sheet" command, look at it, read the project, and give the user a short list of concrete improvements (pacing, legibility, text, sync). Do not edit anything until the user agrees.',
};

/** Start a visible conversation with the Director. Falls back to the clipboard off Tangu. */
export async function handOff(ctx, s, task, t) {
  let tools = null;
  try { tools = await ensureTools(ctx); } catch { tools = null; }
  const prompt = `${contextBlock(ctx, s, tools)}\n\n${task}`;
  const folder = dirOf(s.path) || undefined;
  if (ctx.tangu && ctx.tangu.startChat) {
    const r = await ctx.tangu.startChat({ agent: AGENT, prompt, send: true, folder });
    if (r && r.ok) { notify(ctx, t('ai-started')); return true; }
    if (r && !r.ok) notify(ctx, String(r.error || 'failed'), 'warn');
  }
  try { await navigator.clipboard.writeText(prompt); } catch { /* the notice still explains */ }
  notify(ctx, t('ai-no-host'));
  return false;
}

/** One-shot rewrite of a text run (no conversation). Returns the suggestion or null when unavailable. */
export async function rewrite(ctx, text, how, signal) {
  if (!(ctx.tangu && ctx.tangu.complete)) return null;
  const r = await ctx.tangu.complete({
    prompt: `Rewrite this on-screen text for a video: ${how}. It is shown large on screen, so keep it short. Reply with the new text only, no quotes, no explanation.`,
    selection: text, signal,
  });
  return r && typeof r.text === 'string' ? r.text.trim().replace(/^["“「]|["”」]$/g, '') : null;
}

export function notify(ctx, msg, level = 'info') {
  if (ctx.notify) ctx.notify(msg, { level });
  else if (ctx.app && ctx.app.notify) ctx.app.notify(msg);
}
