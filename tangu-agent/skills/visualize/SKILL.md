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

## Built-in figures: use these for common charts and processes

`fs-chart` and `fs-flow` provide finished layout, spacing and interaction. Prefer them when the
schema fits the data. Do not restyle their internals: the host owns typography, theme, axes,
connectors and responsive layout. Supply actual labels, a concise title, units and a caption only
when needed. Localize all text to the user's language, including `inspectLabel` and `emptyLabel`.
Examples below use illustrative data; do not present them as measured facts.
The elements render their own title and caption. Place them directly in the fragment; do not add
another heading, eyebrow or source paragraph around them that repeats that information.

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

Give the element a unique ID when inputs need to update it. After registration use
`customElements.whenDefined('fs-chart').then(() => document.getElementById('my-chart').setData(data))`
or the equivalent `fs-flow` call. `setData` replaces the whole configuration. Persist only the
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
`.fs-row` (wraps), `.fs-stat-grid`, `.fs-stat`, `.fs-value`, `.fs-label`, `.fs-number`, `.fs-muted`.
Only use `.fs-panel` for a genuinely bounded interactive field. Do not nest panels.

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

## Buttons that change the answer

`window.forsionSketch.ask(text)` sends `text` as the user's next visible message in this
conversation. Call it only from a click handler (it refuses to run on load or from a timer), with
the follow-up the user would type, e.g. `ask("Explain the hybrid option in detail")`. Use it for
choices that need a new answer from you; keep recomputation that needs no new answer inside the
card. One request per click; do not chain several. The card does not receive a reply itself.

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
