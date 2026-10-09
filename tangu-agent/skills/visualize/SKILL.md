---
name: visualize
description: Create clear interactive explanations, charts, simulations and interface previews directly in Forsion chat using sketch. Use when changing inputs, exploring relationships or comparing options helps understanding. Not for standalone apps or files.
---

# Visualize in Forsion

Deliver with `sketch`. The host supplies a transparent, theme-aware document with native controls,
automatic height and local interaction state. Supply a literal HTML fragment with scoped CSS and
JavaScript. Do not emit an OpenAI visualization directive, `window.openai` calls or a file link.
Do not send a conversational visualization to Agent Desk in place of the inline result.

## Choose the right visual

- Charts: put data first. Use a concise title, labelled axes with units, direct labels and a small
  legend only if needed. No decorative cards, summary dashboards or fake data. Explicitly label
  illustrative values. Bars start at zero; line domains include all data and uncertainty.
- Simulations: compact controls followed by one dominant visual. Display changed values near their
  control or mark. Do not fill space with equations or prose that belongs in the answer.
- Diagrams: one reading direction, aligned nodes and quiet connectors. Do not turn each sentence
  into a rounded box. A plain Markdown table stays a Markdown table when the user asks for one.
- Interface previews: reflect Forsion's native density and real content. Make the few useful
  interactions work. A requested project implementation belongs in project files, not `sketch`.

## Built-in parts: compose cards from these

`fs-chart`, `fs-flow`, `fs-compare`, `fs-choice` and `fs-checklist` provide finished layout,
spacing, theme and interaction, so every card looks like one family. Prefer them whenever the
schema fits; combine several in one fragment (a chart above a compare, a checklist under a plan).
Do not restyle their internals and do not add inline `style` attributes anywhere: the host owns
typography, theme, axes, connectors and responsive layout. Supply actual labels, a concise title,
units and a caption only when needed. Localize all text to the user's language, including
`inspectLabel`, `emptyLabel` and `submitLabel`. Examples below use illustrative data; do not present
them as measured facts. The elements render their own title and caption. Place them directly in the
fragment; do not add another heading, eyebrow or source paragraph around them that repeats that
information. Between parts use plain `<p>` text or `.fs-callout` for one short note.

```html
<fs-chart type="bar">
  <script type="application/json">
    {"title":"Build duration by approach","unit":"min","highlight":2,"caption":"Illustrative data","emptyLabel":"No data","data":[{"label":"Sequential","value":48},{"label":"Grouped","value":34},{"label":"Parallel","value":22}]}
  </script>
</fs-chart>
```

Supported chart types: `bar` (horizontal comparison) and `line` (one equally spaced series).
`data` contains 1–100 `{label:string,value:number}` observations; all values must be finite.
Bar lengths start at zero and support negative values. `highlight` optionally emphasizes one
zero-based bar index; omit it for equal emphasis. Line charts automatically fit scales and labels,
and provide a cursor-following interpolated value plus keyboard left/right/Home/End inspection.
For lines supply `inspectLabel`, e.g. "Inspect values with left and right arrow keys".
Do not use a line chart for irregular time intervals, multiple series or uncertainty bands: write
custom SVG with genuine numeric/time scales for those cases. Never silently drop observations.

```html
<fs-flow>
  <script type="application/json">
    {"title":"From request to delivery","emptyLabel":"No steps","steps":[{"label":"Understand","detail":"Agree on the acceptance criteria","status":"done"},{"label":"Implement","detail":"Reuse existing components","status":"done"},{"label":"Verify","status":"active","branches":[{"label":"Automated checks","detail":"Types and behavior"},{"label":"Real interface","detail":"Interaction and appearance"}]},{"label":"Deliver","detail":"Report results and limits"}]}
  </script>
</fs-flow>
```

`steps` contains 1–12 labelled stages. `detail` and `status` (`done`, `active`, `pending`) are
optional. `branches` lists up to eight parallel subchecks within one stage, not alternative
destinations. Use custom SVG for decision branches, loops or arbitrary graph connections.
The host lays stages horizontally when they fit and vertically on narrow surfaces. Order and
branch labels remain readable; no tiny scaled-down boxes or crossing connectors.

```html
<fs-compare>
  <script type="application/json">
    {"title":"Where to run it","options":[{"label":"Local","summary":"Full control, your hardware","points":["No usage fees","You handle updates"],"ask":{"label":"Explain local","text":"Explain the trade-offs of running it locally in detail"}},{"label":"Cloud","summary":"Managed, pay as you go","points":["Scales on demand","Vendor dependency"],"ask":{"text":"Explain the cloud option in detail"}}],"caption":"Illustrative comparison"}
  </script>
</fs-compare>
```

`fs-compare` lays 2–6 `options` side by side. Each has a `label`, optional `summary`, up to eight
short `points`, and an optional `ask` (`{label?, text}`) rendered as a button that sends `text` as
the user's next message. Use it for alternatives the user chooses between.

```html
<fs-choice>
  <script type="application/json">
    {"question":"Which part should I go deeper on?","options":[{"label":"Budget","ask":"Go deeper on the budget"},{"label":"Timeline"},{"label":"Risks"}]}
  </script>
</fs-choice>
```

`fs-choice` asks one `question` with 2–8 `options`; clicking an option sends its `ask` (default:
its `label`) as the user's next message. With `"multiple": true` the options become checkboxes and
a `submitLabel` button sends `ask` with `{choices}` replaced by the ticked labels, e.g.
`"ask":"Plan the trip around {choices}"`. Use it at the end of a card when the next answer depends
on the user's pick, instead of asking in prose.

```html
<fs-checklist id="shopping">
  <script type="application/json">
    {"title":"Shopping list","items":[{"label":"Eggs","detail":"12"},{"label":"Spinach","detail":"300 g"},{"label":"Olive oil"}]}
  </script>
</fs-checklist>
```

`fs-checklist` renders 1–40 tickable `items` (`label`, optional `detail`). Ticks persist on this
device under the element's `id`; give each checklist a unique id and do not manage the ticks
yourself. Pair it with a `.fs-button` that calls `window.forsionSketch.copy(text)` when the user
may want the list elsewhere.

Give the element a unique ID when inputs need to update it. After registration use
`customElements.whenDefined('fs-chart').then(() => document.getElementById('my-chart').setData(data))`
or the equivalent call on any other part (a people slider that rescales an `fs-checklist`'s
`detail` amounts, for example). `setData` replaces the whole configuration. Persist only the
controlling choices using `forsionSketch.setState`; recompute figure data from those choices.
Escape a literal `<` in JSON string data as `\u003c` so labels cannot close the JSON script tag.

## Runtime contract

No network, external scripts/fonts/styles, navigation, eval or host APIs. Use inline SVG, canvas
or semantic HTML; do not request D3, Chart.js, Lucide, React or other globals that are not supplied.
Use a unique root ID and `document.getElementById`. Keep CSS selectors local to that root.

Colors: `--fs-text`, `--fs-muted`, `--fs-faint`, `--fs-accent`, `--fs-accent-soft`, `--fs-surface`,
`--fs-border`, `--fs-rule`, `--fs-green`, `--fs-danger`. The outer `--fs-bg` is transparent.
Series `--fs-s1` is the accent; `--fs-s2` through `--fs-s5` are decreasing neutral emphasis.
Do not use the faint series colors for small essential labels. Never rely on color alone.

Layout: `.fs-header`, `.fs-title`, `.fs-subtitle`, `.fs-plot`, `.fs-caption`, `.fs-source`,
`.fs-row` (wraps), `.fs-grid` (responsive columns of `.fs-option` cards), `.fs-actions` (button row),
`.fs-callout` (one short note), `.fs-stat-grid`, `.fs-stat`, `.fs-value`, `.fs-label`, `.fs-number`,
`.fs-muted`. Only use `.fs-panel` for a genuinely bounded interactive field. Do not nest panels.
No inline `style` attributes: if a layout needs one, use the classes above or scoped CSS under the
root id, and keep it to spacing.

Controls: `.fs-controls` wraps `.fs-field` labels. Use native `.fs-range` inputs, `.fs-input`,
`.fs-select`, `.fs-button` buttons, and `.fs-check` labels around a checkbox. Use `.fs-sr-only`
for accessible descriptions. Shared controls own their geometry, theme and focus appearance.

```html
<label class="fs-field" for="demo-level">
  <span>Level <output id="demo-value" for="demo-level">50%</output></span>
  <input class="fs-range" id="demo-level" type="range" min="0" max="100" value="50">
</label>
```

`.fs-tabs[role="tablist"]` provides click and arrow/Home/End behavior. Give each native button
`role="tab"`, a unique `id`, `aria-controls` and `aria-selected`. Panels have matching IDs,
`role="tabpanel"`, `aria-labelledby`, and `hidden` when inactive. Do not duplicate tab handlers.

## State and interaction

`window.forsionSketch.state` is a JSON snapshot or `null`. Validate it and use defaults before the
first draw. On meaningful user input call `window.forsionSketch.setState({ ...choices })`.
Each call replaces the snapshot, limited to 16 KiB. State restores when revisiting this card on
this device. It is not synced to other devices and is not conversation context. Never imply that
the Agent can see slider changes. Never save on initial render. Old cards may lack a snapshot.
Persist only choices; recompute paths, values and temporary hover state.

Theme changes do not reload the card. CSS/SVG follows variables; canvas should listen for
`forsion:themechange` and repaint with resolved computed colors.

The card renders progressively while the `sketch` call is still being written: the host shows the
markup as it arrives and runs scripts only once the call completes. Put the headline and the
structure first and every `<script>` last, so the first visible frame is already useful.

## Buttons that change the answer, and copy

`window.forsionSketch.ask(text)` sends `text` as the user's next visible message in this
conversation. Call it only from a click handler (it refuses to run on load or from a timer), with
the follow-up the user would type, e.g. `ask("Explain the hybrid option in detail")`. Use it for
choices that need a new answer from you; keep recomputation that needs no new answer inside the
card. One request per click; do not chain several. The card does not receive a reply itself.
`fs-compare` and `fs-choice` already wire this for you; write a manual button only when neither fits.

`window.forsionSketch.copy(text)` (click-only as well) puts `text` on the user's clipboard, e.g. a
shopping list, an itinerary or a command. Label the button with what gets copied.

```html
<button class="fs-button" type="button"
  onclick="window.forsionSketch.ask('Show the pessimistic scenario with the same assumptions')">
  Pessimistic scenario
</button>
```

## Responsive figures

- Design for 320px through 700px, with natural height. Avoid fixed outer widths and viewport units.
- Measure the SVG container and update its `viewBox` with `ResizeObserver`. Reserve axis margins;
  reduce tick count before reducing label size. Keep visible labels at least 11 screen pixels.
- Keep plot marks inside the axes, and anchor labels inward near edges. Prefer native descriptions
  or a locally implemented accessible detail field over unusably small hover targets.
- Use `role="img"` and an accessible summary. All inputs need labels; changing results can use
  `aria-live="polite"`. Essential details must be reachable by click, keyboard or touch.
- If transitions help, honor `prefers-reduced-motion`. Do not loop gratuitous animation.

Check first render, at least two input values, narrow width, theme changes and restored state.
Finish with the one conclusion that the visual cannot communicate itself; do not repeat its data.
