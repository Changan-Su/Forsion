# Context replay, read-only programs and tool-output spill

Runtime context that is safe to retain (requested skills, mentioned projects/agents,
todo state and git state) is kept as a separate user-role snapshot. The first saved
model step carries a versioned `llm_response.turnContext`, keyed by the originating user
row. Step lookup also searches that source id when steering discarded the initial
assistant row. Hydration restores it immediately after that user row; compaction uses
the originating row boundary. Old or malformed records fall back to existing
history replay. Snapshots over 64 KiB are omitted with a diagnostic marker. Runs
without a persisted originating user row, or interrupted before any model step was
saved, may not retain a snapshot; no missing context is fabricated.

Revocable recalled memories, collaboration handbook corrections, file-change
diffs, ephemeral hints and computer-history digests remain transient. This change
does not promise a byte-identical replay for those inputs, steering, recovery
messages, image transformations or tool hook additions. It does not rewrite the
user's original message, restore old permissions, or change compaction thresholds.

`read_only_code` is a deferred tool in work/coding sessions (also usable in plan
mode). A fresh QuickJS/WASM context runs synchronous JavaScript with two bridges:
`tool(name, args)` returns text and `print(value)` selects evidence for the model.
There are no Node, filesystem, import, network or process capabilities in that VM.
The curated built-in read allowlist is enforced again by the parent run, followed
by the normal visibility, approval, hook and execution checks. Custom/MCP/plugin,
write, shell, privacy-limited and recursive program calls are excluded. Nested
calls produce audit events linked with `parentCallId`; full intermediate outputs
are not inserted into chat history. Limits: 32 reads, 2 million input characters,
24,000 output characters, 32 MiB VM memory, 1 second compute between reads, and a
60 second overall deadline. Failures are returned as errors, not partial success.

New tool results use a CJK-aware estimate and a budget of 1% of the context window,
clamped to 512–2,000 tokens. Oversized results retain head/tail evidence and a
content-addressed `out-<sha256>` handle. Full text (maximum 16 MiB per artifact) is
stored under the user/app/session scope. `read_tool_output` supports bounded
character pages and literal matching lines; each read verifies integrity.
Sandbox artifacts use a dedicated per-session artifact workspace, including for
project sessions; the shared project workspace never receives them. Only handles,
not filesystem paths, are shown to the model. Existing snapshot persistence is used; local artifacts
live under Tangu home. Missing/failed artifacts explicitly instruct the model to
read the source again. Existing history is not repeatedly re-truncated. Data with
`persistPlaceholder` never enters this spill store. There is no new periodic GC;
artifacts follow their home/workspace lifecycle, so long-lived local stores can
grow. Forked sessions do not inherit another session's handles.

Successful `use_skill` results are instruction text, not optional data previews.
The tool declares the internal `outputKind: instructions` delivery category, so
the loop preserves the complete result within the skill loader's existing
120,000-character source limit, even when `read_tool_output` is unavailable.
Before admitting the result, the loop estimates the current context plus the
complete instructions using provider-calibrated usage and the existing model
window/reserve budget. If they do not fit, the tool returns a recoverable error
stating that the instructions were not loaded; no partial skill or spill handle
is presented as a successful load. The model can retry with a larger context
window or a smaller complete skill instead of terminating on the next iteration.
The category is read from the registered tool, never from model arguments or
returned text; it grants no additional tool access, approval or filesystem rights.
Ordinary results and errors still use the data budget and spill reader. Privacy
placeholders and read-only program boundaries run before this formatting choice
and are unchanged. General context budgets, compaction and history size limits
still apply; skills remain loaded on demand instead of entering the system prefix.
Regression checks: `npx vitest run test/agentLoopSkillOutput.test.ts
src/tools/builtin/skills.test.ts src/tools/outputPersist.test.ts` from `tangu-agent`.
The loop check uses SQLite and captures the actual provider messages and stored
tool results, including a long instruction's middle and the ordinary error path.
It also checks a 24k model window and a larger window whose remaining budget is
too small for the complete skill.

Measure actual provider usage, including cached inputs, output/reasoning and task
correctness. Fewer tokens and lower charged cost are distinct metrics. Subscription
usage does not establish a per-request monetary bill. The matched production
benchmark is `harness-runs/tangu-token-efficiency.mjs` in Forsion-Root; its model
allowlist is Terra/DeepSeek and its paid HTTP attempts are guarded explicitly.
