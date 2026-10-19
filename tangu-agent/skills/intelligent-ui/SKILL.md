---
name: intelligent-ui
description: Native interactive answers in Forsion chat using intelligent_ui. Use for interactive plans, real image galleries, linked web research, option comparisons, quantity-aware checklists and, on clients that render version 2, computed cards (calculators, budgets, step guides, flashcards, quizzes). Use sketch for charts, diagrams and animations.
---

# Forsion Intelligent UI

Call `intelligent_ui` with `document`, a JSON-encoded object using the schema below. Never emit HTML,
JavaScript, CSS or OpenAI directives; expressions belong only in the version 2 fields described below. The host supplies a quiet parallel
layout, local state, light/dark themes, keyboard controls and responsive stacking. Localize content
to the user's language. Keep prose concise; do not repeat the whole document in your final answer.
The view IS the answer, not an attachment to it. Open the document with a `text` block (no title)
giving your conclusion and what you assumed, and put reasoning that belongs between components in
`text` blocks. Make the call without announcing it in chat text; afterwards stop, adding one short
line only for a caveat the view does not contain (never a restatement, never "below"). A document of
text blocks only is not a view: write that answer as plain chat text. On a follow-up that changes
one part of an earlier view, send a view of that part only.
When the answer rests on assumptions that would change it (who it is for, how many, budget, level,
taste), give each a choice input (one to three, initial = what you assumed) and end the document
with an `actions` block holding one `model` action that redoes the answer for the picked values,
instead of asking in prose. Inputs that only feed that action go in a `controls` block right before
it; an input already shown higher up is not repeated. With nothing that would change the answer,
add neither.
Make an actual `intelligent_ui` function call; writing its JSON arguments in chat text does not
invoke the tool. When revising a plan, keep completed work as history and apply new constraints
only to remaining work. Do not invent elapsed time. New checklists start unchecked: describe
already completed work in text and reserve new checklists for work still to do.
Source summaries must reflect retrieved content. If `web_fetch` returns only a title or page shell,
use `browser_navigate` to read the rendered page; repeated empty fetches do not verify a claim.

For image comparison, inspect actual pixels before describing visual details. For supplied remote
images, preserve the URL exactly; when browser tools are available, use `browser_navigate`, then
`browser_screenshot`, then `view_image` with the screenshot path. Load these tools if needed.
An image page can have an empty DOM snapshot while displaying a valid picture. `web_fetch` does
not provide image pixels. Do not claim inspection is impossible just because the DOM is empty.
If actual inspection fails, retain neutral labels and clearly explain the limitation.
When a user wants to choose a candidate, add a bound choice input; expanding an image is not a
selection. Picking among pictures is ONE choice input whose options each carry `imageId`, with the
one-line reason to pick it in `description`. Those picture cards already are the side-by-side
view, the expandable originals and the radio selection, so a request worded as "show them side by
side, expandable, with a radio control" is still that single choice. Never write a choice without
`imageId` next to a gallery of the same pictures, and never repeat an option picture in a gallery
or as a comparison `imageId`. Put composition or other differences in the option descriptions, a
text block, or a comparison without `imageId`. Use a gallery only for pictures that are not
options. When comparison items contain images, omit a duplicate gallery.
Keep checklist labels short and actionable. Put explanations, exercises and worked
answers in disclosure blocks instead of crowding the checklist with paragraphs.

## Document v1

Write fields in this order to support incremental rendering:

```
{version:1, id:string, title:string, inputs:Input[], resources:Resource[], blocks:Block[]}
```

All IDs: letters/numbers plus `.`, `_`, `-`, max 80 chars, unique within their collection. Stable
semantic IDs, never array indexes. No `constructor`, `prototype`, `__proto__`. Max 64 KiB total,
8 inputs, 24 resources, 40 blocks. All fields below are required unless marked `?`. Use `[]` for
empty collections. Do not add extra styling fields. Document IDs are scoped to this tool call.

**Input** (defaults initialize once; subsequent edits belong to the user):

- `{id,kind:"number",label,initial:number,min:number,max:number,step:number}` — nonnegative,
  finite, initial in range on the step grid. Use step 1 for people.
- `{id,kind:"choice",label,initial:optionId,options:[{id,label,description?:string,imageId?:imageId}]}`
  — up to 8 mutually exclusive options. Changing a choice is local, not a prompt submission.
  `imageId` goes on all options or none. With it the options are one row of picture cards (click
  selects, a corner control expands; four pictures sit two by two); without it, short options
  without descriptions become one segmented control and the rest are option cards. Options that
  stand for pictures must carry `imageId`.

**Resource** (public HTTPS URLs, no credentials, local addresses, arbitrary ports or data URLs):

- `{id,kind:"source",url,title,description?:string}` — a real retrieved/user-supplied source.
- `{id,kind:"image",url,alt,sourceId?:sourceResourceId}` — a real image URL, meaningful alt text,
  optional provenance. Images are displayed by native components and can expand at original ratio.
  Never invent URLs. Failed images retain their alt text and a retry control.
  Inspect the actual image before describing its composition or subjects. URLs/filenames alone
  do not establish image content. If you cannot inspect it, use neutral labels and say so.

**Block** always has `{id,kind,title?:string,when?:Condition}` plus fields below:

| kind | Fields | Behavior |
|---|---|---|
| text | `markdown:string` | Safe prose, lists, links, code and tables; no HTML or images |
| controls | `inputIds:string[]` | Stepper and local radio choices (picture cards when options carry `imageId`) |
| gallery | `resourceIds:imageId[]` | Pictures that are not options: expand/collapse, source caption |
| sources | `resourceIds:sourceId[]` | Linked titles and domains; each summary shows two lines and opens in place |
| comparison | `items:[{id,title,description,imageId?:imageId,facts:string[]}]` | 2–6 options side by side; factual differences, no decoration; no `imageId` for a picture that is a choice option |
| checklist | `items:[{id,label,itemKey?:string,quantity?:Quantity,when?:Condition}]` | Local progress, copy, reset; up to 100 items |
| disclosure | `title:string,markdown:string` | Independent expand/collapse |
| actions | `items:Action[]` | Explicit copy, open source or new model turn |

`Condition = {input:inputId,equals:string|number}` — equals must be a valid option/range value.
`Quantity = {value:number,unit:string,scaleBy?:numberInputId,base?:number}` — base required if scaling.
The renderer computes `value * currentInput / base`; it never asks the model to recompute.
To combine the same ingredient from several recipes, give its separate entries the same `itemKey`
and unit, with an optional `when` per entry. Quantities sum before display. Label consistently.
Checked quantities remain recorded when servings/menu change; a larger requirement is marked as
partly covered instead of pretending the old purchase is enough. No-quantity items are boolean tasks.

`Action` has `{id,label}` and one of:
- `{kind:"model",prompt:string}` — only after the user clicks; current input values accompany the
  visible follow-up. Reserve for new reasoning (e.g. gluten-free menu), not local selection.
- `{kind:"copy",text:string}` — copy this literal text. Dynamic checklists already have copy buttons.
- `{kind:"open",resourceId:sourceId}` — normal source link through the user's link preferences.

## Document v2 (computed cards)

Only when your instructions include the "Computed Intelligent UI (version 2)" section; other clients
render version 1 only and reject version 2. Calculators, budgets, conversions, step guides,
flashcards, scored quizzes and filterable or sortable lists belong here, not in sketch: the card
recomputes on every input change or button press without another model turn.

```
{version:2, id, title, inputs, state:State[], derived:Derived[], resources, blocks}
```

- `State = {id, initial}` (max 16): hidden values the buttons change. `initial` is a number, text,
  true/false, null, or a list (max 200) / object (max 16 keys) of those. Use it for data the card
  walks through (word lists, steps, catalog rows) and for positions, scores and picks.
- `Derived = {id, expr}` (max 32): evaluated in order; reads inputs, state and earlier derived
  values by name (`$loan` and `loan` are the same). Never stored, never sent to you.
- Names are letters, digits and underscore, unique across inputs, state and derived, and not one of
  `and or not true false null`. A value may share a function's name: `payment(…)` calls, `payment` reads.
- Data the card walks through (word lists, steps, catalog rows) goes in a state value's `initial`,
  never in a long expression; expressions compute from it.

Expressions (max 300 characters each): numbers, `'text'`, `[lists]`, `{key: value}`,
`+ - * / %`, `== != < <= > >=`, `and or not`, `c ? a : b`, `x.field`, `x[i]`. `+` joins text;
numbers compare with a small tolerance. Functions, and nothing else:

| Function | Meaning |
|---|---|
| `round(x, digits?)` `floor` `ceil` `abs` `pow(a, b)` `clamp(x, lo, hi)` | Arithmetic |
| `min(a, b, …)` `max(…)` (or one list) `sum(list)` `avg(list)` `count(list or text)` `percent(part, whole)` | Aggregates |
| `payment(ratePerPeriod, periods, principal)` | Level payment per period (loan / annuity) |
| `format(x, style?, digits?)` | style `number` (default), `percent` (0.25 → 25%), `wan` (万 in Chinese, 1.2M in English), `compact` |
| `join(list, sep?)` `range(from, to, step?)` `includes(list or text, value)` | Lists; `range` is inclusive, max 200 |
| `each(list, 'x', expr)` `filter(list, 'x', cond)` `sortBy(list, 'x', key)` | The quoted name is the item inside the third argument; nest at most 2 deep. Sort descending with a negated key |

No random numbers, dates or clocks: a replayed card must show the same values.

Where results appear:

| Place | Form |
|---|---|
| text / disclosure | `{{expr}}` inside `markdown`; inserted as plain text after the markdown is parsed (never a link or formatting) |
| `stats` block | `items:[{label, value:expr}]`, 1–4 headline figures |
| `table` block | `columns:[string]` (max 6), `rows:expr` giving one list of cells per row (max 50) |
| `when` | `{expr}` on any block except controls, and on checklist items |
| `actions` | `{id, label, kind:"set", steps, disabled?:expr}`; steps run in order, each seeing the previous: `{set:id, to:expr}` `{toggle:id, value?:expr}` (flip a boolean, or add/remove a list item) `{append:id, value:expr}` `{remove:id, value:expr}` `{reset:id}` |

A set button changes only the card: no message, no model turn. Keep `model` actions for new
reasoning; their follow-up carries the inputs and any state the buttons changed. A value that fails
(division by zero, a missing field, an empty average) shows "—"; the tool result lists such values
at the initial values. A follow-up card that continues one keeps the same input and state ids and
starts from the values the user sent back. `quantity.scaleBy` still works and equals
`value * $input / base`.

Example (the gallery mortgage card):

```json
{"version":2,"id":"loan","title":"房贷月供估算","inputs":[{"id":"loan","kind":"number","label":"贷款金额（万元）","initial":120,"min":50,"max":300,"step":5},{"id":"rate","kind":"number","label":"年利率（%）","initial":3.2,"min":2,"max":6,"step":0.05},{"id":"years","kind":"number","label":"贷款年限（年）","initial":30,"min":5,"max":30,"step":5}],"state":[],"derived":[{"id":"p","expr":"$loan * 10000"},{"id":"r","expr":"$rate / 1200"},{"id":"n","expr":"$years * 12"},{"id":"pay","expr":"payment(r, n, p)"},{"id":"interest","expr":"pay * n - p"}],"resources":[],"blocks":[{"id":"intro","kind":"text","markdown":"按**等额本息**：贷款 {{$loan}} 万、年利率 {{$rate}}%、{{$years}} 年，**每月还 {{format(pay, 'number', 0)}} 元**，一共付利息约 {{format(interest, 'wan', 1)}}。"},{"id":"controls","kind":"controls","inputIds":["loan","rate","years"]},{"id":"stats","kind":"stats","items":[{"label":"月供","value":"format(pay, 'number', 0) + ' 元'"},{"label":"总利息","value":"format(interest, 'wan', 1)"},{"label":"总还款","value":"format(pay * n, 'wan', 1)"}]},{"id":"balance","kind":"table","title":"每 5 年剩多少本金","columns":["年末","剩余本金"],"rows":"each(range(5, $years, 5), 'y', ['第 ' + y + ' 年', format(pay * (1 - pow(1 + r, y * 12 - n)) / r, 'wan', 1)])"},{"id":"how","kind":"disclosure","title":"怎么算的","markdown":"月利率 r = 年利率 ÷ 12，期数 n = 年限 × 12；月供 = 本金 × r ÷ (1 − (1 + r)^−n)。提前还款和利率调整不在这张表里。"},{"id":"act","kind":"actions","items":[{"id":"more","kind":"model","label":"按这组取值算提前还款","prompt":"按这组取值，帮我算提前还 20 万能省多少利息"}]}]}
```

## Small example (illustrative menu, not measured nutrition or pricing)

```json
{"version":1,"id":"dinner","title":"周末晚餐","inputs":[{"id":"people","kind":"number","label":"用餐人数","initial":4,"min":2,"max":8,"step":1},{"id":"main","kind":"choice","label":"选择主菜","initial":"chicken","options":[{"id":"chicken","label":"宫保鸡丁","description":"约 25 分钟"},{"id":"tofu","label":"香菇烧豆腐","description":"约 20 分钟"}]}],"resources":[],"blocks":[{"id":"choices","kind":"controls","inputIds":["people","main"]},{"id":"shopping","kind":"checklist","title":"采购清单","items":[{"id":"chicken","label":"鸡腿肉","when":{"input":"main","equals":"chicken"},"quantity":{"value":600,"unit":"g","scaleBy":"people","base":4}},{"id":"tofu","label":"豆腐","when":{"input":"main","equals":"tofu"},"quantity":{"value":500,"unit":"g","scaleBy":"people","base":4}},{"id":"broccoli","label":"西兰花","quantity":{"value":500,"unit":"g","scaleBy":"people","base":4}}]},{"id":"prep","kind":"disclosure","title":"准备顺序","markdown":"先洗切配菜，再做主菜。"},{"id":"change","kind":"actions","items":[{"id":"vegetarian","kind":"model","label":"改成全素菜单","prompt":"根据这份计划和我的当前选择，重新设计全素菜单。"}]}]}
```

The document stream commits complete blocks only. Put inputs and resources before blocks; reference
only existing IDs. Every input must appear exactly once in an unconditional controls block, before
the data it affects. Do not print the document JSON in conversation. Keep block order stable.
If validation fails, correct the exact reported field.
If the requested content cannot be expressed, fall back to readable prose or sketch for a custom
simulation. Never provide a blank visual just to satisfy the tool requirement.
