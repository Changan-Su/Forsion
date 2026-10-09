import type { ToolProvider } from '../toolRegistry.js'
import type { ToolContext } from '../toolTypes.js'
import { sketchEnabledFor } from './sketch.js'
import { uiDocumentTooLarge, validateUIDocument } from '../../shared/intelligentUi.js'

export const INTELLIGENT_UI_CAPABILITY = 'intelligent-ui.v1'
export function intelligentUiEnabledFor(ctx: Parameters<typeof sketchEnabledFor>[0] & Pick<ToolContext, 'clientCapabilities'>): boolean {
  return sketchEnabledFor(ctx) && !!ctx.clientCapabilities?.includes(INTELLIGENT_UI_CAPABILITY)
}
export const INTELLIGENT_UI_SECTION = `## Intelligent UI
Deliver a native view by making an actual intelligent_ui function call. A JSON object written in
the assistant's text does not invoke the tool and is not a usable answer.
For interactive plans, image selections, web research and qualitative comparisons, prefer
\`intelligent_ui\` over HTML sketches. Native components own layout, theme, accessibility and
state. Put metadata, resources and inputs before blocks so complete blocks appear progressively.
Choose the few controls that actually help; short explanations remain prose. Local choices,
quantities, checklists, image expansion and disclosures NEVER need another model request.
Use model actions only for genuinely new reasoning. Images and sources must use supplied or
retrieved real URLs: do not invent pictures, prices or citations. A source is a linked summary,
not a live embedded website. If web_fetch returns only a title or page shell, use browser_navigate
to read the rendered page before summarizing it; repeating the same text fetch is not verification.
Describe visual details only after viewing the image with an image
tool or from explicit user-provided descriptions. A filename or URL is not evidence of what an
image depicts; if inspection is unavailable, use neutral labels and say it has not been inspected.
For remote images, when browser tools are available, preserve the exact supplied URL and use
browser_navigate, then browser_screenshot, then view_image on the returned screenshot path.
Load those tools if needed. An empty DOM snapshot of an image page is not a failed image load:
inspect its pixels before giving up. web_fetch is for text; it does not show image pixels.
When the user wants to pick a candidate, include a bound choice input; expanding an image does
not select it. If comparison items include images, omit a duplicate gallery of those same images.
Keep checklist labels brief and actionable; put worked answers or long explanations
in disclosures so the task list remains easy to scan.
When revising a plan, retain completed work as history; new time constraints apply to remaining
work, not time already spent. Do not invent elapsed time. New checklists start unchecked, so
describe already completed work in a text block and put only remaining work in new checklists.
Use sketch only for custom charts, diagrams and simulations that
this schema cannot express. A native document satisfies the visual-delivery requirement.
When visuals are set to less, use either visual tool only on an explicit request.

Pass document as a JSON string with these fields IN ORDER (all required):
{version:1,id:string,title:string,inputs:Input[],resources:Resource[],blocks:Block[]}.
Use [] for empty arrays. IDs are unique semantic strings (letters, digits, dots, dashes,
underscores; max 80). Max 8 inputs,24 resources,40 blocks,64 KiB total. Optional fields use ? below.
Input:
- {id,kind:"number",label,initial:number,min:number,max:number,step:number}: nonnegative, initial on step grid.
- {id,kind:"choice",label,initial:optionId,options:[{id,label,description?:string}]}: local radio selection.
Resource:
- {id,kind:"source",url,title,description?:string}
- {id,kind:"image",url,alt,sourceId?:sourceId}
Use public HTTPS URLs only, no credentials/private addresses/ports. Images use actual image URLs.
Every Block has id,kind,title?:string,when?:{input:inputId,equals:validOptionIdOrNumber}, plus:
- text: markdown:string (no HTML/images)
- controls: inputIds:string[]
- gallery: resourceIds:imageId[]
- sources: resourceIds:sourceId[]
- comparison: items:[{id,title,description,imageId?:imageId,facts:string[]}] (2-6 options)
- checklist: items:[{id,label,itemKey?:string,when?:Condition,quantity?:Quantity}]
- disclosure: title:string,markdown:string
- actions: items:[{id,label,kind:"model",prompt:string}|{id,label,kind:"copy",text:string}|{id,label,kind:"open",resourceId:sourceId}]
Condition is {input:inputId,equals:validOptionIdOrNumber}.
Quantity is {value:number,unit:string,scaleBy?:numberInputId,base?:number}. With scaleBy,
base is required and positive: displayed amount=value*currentInput/base. Separate recipe entries
for the same ingredient use the same itemKey and unit; visible entries sum automatically.
Checklists include native copy/reset/progress controls. Checked quantities retain purchased amounts,
so a later increase shows a shortfall. All references must resolve. Put metadata/inputs/resources
before blocks; only complete validated blocks become interactive. Every declared input MUST be
included exactly once in a controls block, without a when condition; put controls before the data
they affect. Do not add CSS or code. NEVER print the document JSON as chat text, before or after
the tool call. The user sees the native view; only add a short takeaway afterwards.
The intelligent-ui skill has worked examples when skills are available; this schema is sufficient
in Chat mode where skills are unavailable.`

export const intelligentUiProvider: ToolProvider = {
  id: 'builtin:intelligent-ui',
  tools: () => [{
    name: 'intelligent_ui', mode: 'both',
    isEnabledFor: (_profile, ctx) => intelligentUiEnabledFor(ctx),
    capabilities: { sideEffect: 'none', parallel: false, defaultTimeoutMs: 5000 },
    definition: { type: 'function', function: {
      name: 'intelligent_ui',
      description: 'Render a native interactive answer: plans, images, sources, comparisons, checklists. Follow the v1 schema in the Intelligent UI instructions. Each call creates one document; local interactions do not call the model. No HTML/JS/CSS. Use sketch for custom simulations, prose for simple answers.',
      parameters: { type: 'object', properties: { document: { type: 'string', description: 'JSON-encoded v1 document. Order: version, id, title, inputs, resources, blocks. Max 64 KiB.' } }, required: ['document'] },
    } },
    execute: (args): string => {
      try {
        if (typeof args.document !== 'string' || uiDocumentTooLarge(args.document)) return 'Error: document must be a JSON string up to 64 KiB.'
        const doc = validateUIDocument(JSON.parse(args.document))
        return `Intelligent UI rendered: ${doc.title} (${doc.blocks.length} blocks).`
      } catch (e) { return `Error: invalid Intelligent UI document. ${e instanceof Error ? e.message : String(e)}. Correct the document or answer in readable prose.` }
    },
  }],
}
