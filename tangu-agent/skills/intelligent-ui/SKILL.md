---
name: intelligent-ui
description: Native interactive answers in Forsion chat using intelligent_ui. Use for interactive plans, real image galleries, linked web research, option comparisons and quantity-aware checklists. Use sketch for custom simulations and diagrams.
---

# Forsion Intelligent UI

Call `intelligent_ui` with `document`, a JSON-encoded object using the schema below. Never emit HTML,
JavaScript, CSS, arbitrary expressions or OpenAI directives. The host supplies a quiet parallel
layout, local state, light/dark themes, keyboard controls and responsive stacking. Localize content
to the user's language. Keep prose concise; do not repeat the whole document in your final answer.
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
selection. When comparison items contain images, omit a duplicate gallery of the same candidates.
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
- `{id,kind:"choice",label,initial:optionId,options:[{id,label,description?:string}]}` — up to
  8 mutually exclusive options. Changing a choice is local, not a prompt submission.

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
| controls | `inputIds:string[]` | Stepper and local radio choices |
| gallery | `resourceIds:imageId[]` | Candidate gallery, expand/collapse, source caption |
| sources | `resourceIds:sourceId[]` | Linked titles, domains, expandable source summaries |
| comparison | `items:[{id,title,description,imageId?:imageId,facts:string[]}]` | 2–6 options side by side; factual differences, no decoration |
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
