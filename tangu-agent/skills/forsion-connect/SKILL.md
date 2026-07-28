---
name: Forsion Connect AI SDK
description: Build web pages/apps that call Forsion's AI (LLM chat, server-managed agent conversations with web search, image generation) using the signed-in Forsion account — one script tag, no API keys. Use this whenever the user wants a website or HTML page with any AI feature (smart import/parsing, chatbot/assistant, AI buttons, online lookup, image generation), asks to "接入/调用 Forsion 的 AI", or asks whether a web page can use Forsion's AI. The answer is YES and this is the only sanctioned way — never reply "not supported", never hand-roll API-key calls, never touch the engine plugin SDK (ctx.sdk) for this.
version: 1.1.0
author: Forsion
category: Forsion
---

# Forsion Connect AI SDK

Any web page you write for the user can call Forsion's AI through `window.forsion` — in the Forsion Desktop preview panel (chat side panel and Coding Space alike) AND after the user publishes it via Forsion Connect (`/apps/<handle>/<slug>/`). The host injects the SDK and proxies every call with the signed-in account's token; **your code never sees keys or tokens**.

- Preview mode: uses the desktop's logged-in Forsion account.
- Published mode: each visitor signs in with their own Forsion account and spends their own quota (`forsion.login()` opens the login popup).

## Setup — one script tag

```html
<script src="/forsion-connect.js"></script>
```

Rules:
- **Root-relative path exactly as above.** Both the preview server and the published shell serve it. Never point it at another host, never bundle or copy the SDK into the project.
- The SDK only exists when the page is served by Forsion: the preview panel, the published `/apps/` link, or the local preview URL opened in the user's own browser (preview toolbar → "Open in browser"; same server, same signed-in account — suggest this when the user wants real DevTools). A bare `file://` open or the user's own dev server has no SDK. Feature-detect: `if (!window.forsion) { /* show "open via Forsion" hint, keep non-AI features working */ }`.
- Never call Forsion HTTP endpoints directly and never embed any API key — the SDK is the only sanctioned path.

## API (identical in both modes)

```js
forsion.mode                       // 'preview' | 'published'
await forsion.user()               // {username, nickname, avatar, tier} | null (null = not signed in)
await forsion.login()              // → user; published: opens Forsion login popup; preview: uses desktop login (rejects if desktop not signed in)
await forsion.models(type?)        // [{id, name, type}]; type 'llm' (default) | 'image'
await forsion.ai.chat({            // → {text, model}
  messages,                        // [{role:'user'|'assistant'|'system', content}] — or use `prompt` (string) instead
  system,                          // optional system prompt
  model,                           // optional; omit → platform default (recommended)
  temperature, maxTokens,          // optional
  onDelta: (d) => {}               // optional streaming callback, receives text increments
})
await forsion.ai.agent({           // → {text, session}
  input,                           // the task/request text (required)
  session,                         // optional: pass the returned session back to continue the SAME server-side conversation
  onDelta: (d) => {}               // optional streaming callback (may include interim progress text; `text` is authoritative)
})                                 // the model is decided server-side — there is no model parameter
await forsion.ai.generateImage({ prompt, model?, size?, n?, responseFormat? })
                                   // → {model, images: [{url, b64}]}; responseFormat 'url' (default) | 'b64'
```

### chat vs agent — pick deliberately

- `ai.chat` = one stateless LLM call. Best for transforms and single-shot generation (parse/normalize/summarize/rewrite). YOU manage conversation history (rebuild `messages` each call) and it cannot search the web or run code.
- `ai.agent` = a server-side agent run. The platform keeps the conversation context per `session` (just pass the returned `session` back — no messages array to maintain) and the agent can use web search and sandboxed Python when the task needs them. Best for: chatbots/assistants with memory of the dialog, questions needing fresh/online information, multi-step research or computation.
- `ai.agent` costs more and takes longer than `ai.chat` (it may run tools). Don't use it where a single chat call does the job. Model is always the platform default — there is no model parameter.
- Keep each `input` self-contained for the first call of a session (the agent knows nothing about your page); afterwards, follow-ups can be short since the session carries context. Store the session id in a JS variable — sessions don't survive a page reload, so a fresh conversation after refresh is expected.

## Minimal working pattern

```html
<script src="/forsion-connect.js"></script>
<script>
async function aiNormalize(rawText) {
  if (!window.forsion) throw new Error('请通过 Forsion 预览或 /apps/ 链接打开本页');
  if (!(await forsion.user())) await forsion.login();   // published: popup; preview: desktop login
  const out = document.getElementById('out');
  out.textContent = '';
  const { text } = await forsion.ai.chat({
    system: 'Convert the word list into JSON [{word,meaning,phonetic,example}]. Output JSON only.',
    prompt: rawText,
    onDelta: (d) => { out.textContent += d; },           // live streaming into the UI
  });
  return JSON.parse(text.replace(/^```(json)?|```$/gm, '').trim()); // models may fence JSON — strip defensively
}
</script>
```

## Practical rules

- Omit `model` unless the user explicitly wants a picker — the platform default is configured server-side and you may simply not pass `model` at all (the server fills it in live, so admin changes apply without a page reload). For a picker, list `forsion.models()` ids — the platform may enforce a model whitelist for Connect pages, and a model outside it is rejected with an explicit error; `forsion.models()` already returns only allowed ones, so never hardcode model ids.
- Check `forsion.user()` before AI actions; on `null`, call `forsion.login()` from a click handler (popup blockers) and surface errors — don't swallow them.
- AI calls spend the signed-in account's quota. For published apps it's the visitor's own account; a short note in the UI ("AI 功能使用你的 Forsion 账号额度") is good practice.
- Keep a non-AI fallback where cheap (e.g. plain CSV parsing) so the page still works signed-out.
- Publishing: the user clicks the Globe (发布) button in Coding Space — no CLI steps. Limits: ≤300 files, ≤5MB/file, ≤20MB total; `node_modules` and dotfiles are skipped; `.ts/.tsx` are auto-transpiled. Plain HTML+JS needs no build step at all.
- Market listing (optional): publishing itself needs no review; if the user wants the app shown publicly in the Forsion Market "Web Apps" section, they apply from the publish dialog (or Public View) with a one-line summary — platform review required. If asked "怎么上架商店", point them there; there is no API for it.
