/** 自定义笔预设 —— 逐字抄自 obsidian-excalidraw-plugin(zsviczian,MIT)的 `src/utils/pens.ts`。
 *
 *  这些数值不是我们调的,是他调了很多版的手感,**别凭感觉改**;要加笔型就往表里加一条。
 *  能吃这些参数的只有 zsviczian fork:上游 excalidraw 把 perfect-freehand 的 options 写死在
 *  渲染器里,fork 把它挪到了 `appState.currentStrokeOptions`(见 forkRuntime.ts 为什么换引擎)。
 *
 *  与插件的差别(都是有意的):
 *  - 不做 `customPens`(把预设存进 appState 再让用户改参数)—— 那需要一整个 PenSettingsModal(909 行)。
 *    这里是**固定 7 支笔**,改参数请直接用引擎自己的属性面板(线宽/颜色/填充都还在)。
 *  - `freedrawOnly` 保留:它决定离开自由画笔时要不要把颜色/填充还回去(见 ExcalidrawCanvas 的还原 effect)。
 */
import { registerMessages, translate } from '../../../i18n'
import type { ObsidianPenStyle } from '@excalidraw/excalidraw/obsidianTypes'

export type PenType = ObsidianPenStyle['type']
export type PenStyle = ObsidianPenStyle

export const PEN_ORDER: PenType[] = ['default', 'finetip', 'fountain', 'marker', 'highlighter', 'thick-thin', 'thin-thick-thin']

registerMessages({
  'excalipen.default': { zh: '默认', en: 'Default' },
  'excalipen.finetip': { zh: '细尖笔', en: 'Fine tip' },
  'excalipen.fountain': { zh: '钢笔', en: 'Fountain pen' },
  'excalipen.marker': { zh: '马克笔', en: 'Marker' },
  'excalipen.highlighter': { zh: '荧光笔', en: 'Highlighter' },
  'excalipen.thickThin': { zh: '粗到细', en: 'Thick to thin' },
  'excalipen.thinThickThin': { zh: '两头细', en: 'Tapered ends' },
})

/** UI 文案。图标在 ExcalidrawCanvas 里挑(lucide),这里只管数据。
 *
 *  ⚠️ 必须是 **getter**,别「简化」成一张普通的字符串表:模块作用域的字面量在
 *  import 那一刻就定死成启动时的语言,用户切中/英之后再也不会变(不报错、不崩,
 *  只是静默显示旧语言)。写成 getter,`PEN_LABELS[type]` 每次读取都现查字典,
 *  消费方(PenRow 的 title/aria-label)一行不用改。 */
export const PEN_LABELS: Record<PenType, string> = {
  get default() { return translate('excalipen.default') },
  get finetip() { return translate('excalipen.finetip') },
  get fountain() { return translate('excalipen.fountain') },
  get marker() { return translate('excalipen.marker') },
  get highlighter() { return translate('excalipen.highlighter') },
  get 'thick-thin'() { return translate('excalipen.thickThin') },
  get 'thin-thick-thin'() { return translate('excalipen.thinThickThin') },
}

export const PENS: Record<PenType, PenStyle> = {
  default: {
    type: 'default',
    freedrawOnly: false,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 0,
    roughness: 0,
    penOptions: {
      highlighter: false,
      constantPressure: false,
      hasOutline: false,
      outlineWidth: 1,
      options: {
        thinning: 0.6,
        smoothing: 0.5,
        streamline: 0.5,
        easing: 'easeOutSine',
        start: { cap: true, taper: 0, easing: 'linear' },
        end: { cap: true, taper: 0, easing: 'linear' },
      },
    },
  },
  /** ⚠️ 这一支**已按用户要求偏离插件原值**(2026-08-14),别当成「抄错了」改回去:
   *  - `hasOutline: false`(插件是 true + outlineWidth 4)—— 荧光笔不该带一圈描边。
   *  - **`thinning: 0`**(插件是 1)。这条是端头能切换的**前提**,实测:thinning=1 时两种 cap 画出来
   *    逐像素相同(末端的收拢是 thinning 造成的,跟 cap 无关);thinning=0 之后才分得出
   *    `cap:false` = 平切、`cap:true` = 多一段圆顶。恒宽本来也正是荧光笔该有的样子。
   *  - 端头默认**方头**(`cap:false` + `taper:0`)。圆/方由属性面板的「笔触」两颗现切(setPenCap)。
   *  - `strokeWidth` 2 → 4:thinning 归零后笔迹从 ~18px 掉到 ~10px,提一档把原来的粗细补回来。 */
  highlighter: {
    type: 'highlighter',
    freedrawOnly: true,
    strokeColor: '#FFC47C',
    backgroundColor: '#FFC47C',
    fillStyle: 'solid',
    strokeWidth: 4,
    roughness: null as unknown as number,
    penOptions: {
      highlighter: true,
      constantPressure: true,
      hasOutline: false,
      outlineWidth: 1,
      options: {
        thinning: 0,
        smoothing: 0.5,
        streamline: 0.5,
        easing: 'linear',
        start: { taper: 0, cap: false, easing: 'linear' },
        end: { taper: 0, cap: false, easing: 'linear' },
      },
    },
  },
  finetip: {
    type: 'finetip',
    freedrawOnly: false,
    strokeColor: '#3E6F8D',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 0.5,
    roughness: 0,
    penOptions: {
      highlighter: false,
      hasOutline: false,
      outlineWidth: 1,
      constantPressure: true,
      options: {
        smoothing: 0.4,
        thinning: -0.5,
        streamline: 0.4,
        easing: 'linear',
        start: { taper: 5, cap: false, easing: 'linear' },
        end: { taper: 5, cap: false, easing: 'linear' },
      },
    },
  },
  fountain: {
    type: 'fountain',
    freedrawOnly: false,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 2,
    roughness: 0,
    penOptions: {
      highlighter: false,
      constantPressure: false,
      hasOutline: false,
      outlineWidth: 1,
      options: {
        smoothing: 0.2,
        thinning: 0.6,
        streamline: 0.2,
        easing: 'easeInOutSine',
        start: { taper: 150, cap: true, easing: 'linear' },
        end: { taper: 1, cap: true, easing: 'linear' },
      },
    },
  },
  marker: {
    type: 'marker',
    freedrawOnly: true,
    strokeColor: '#B83E3E',
    backgroundColor: '#FF7C7C',
    fillStyle: 'dashed',
    strokeWidth: 2,
    roughness: 3,
    penOptions: {
      highlighter: false,
      constantPressure: true,
      hasOutline: true,
      outlineWidth: 4,
      options: {
        thinning: 1,
        smoothing: 0.5,
        streamline: 0.5,
        easing: 'linear',
        start: { taper: 0, cap: true, easing: 'linear' },
        end: { taper: 0, cap: true, easing: 'linear' },
      },
    },
  },
  'thick-thin': {
    type: 'thick-thin',
    freedrawOnly: true,
    strokeColor: '#CECDCC',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 0,
    roughness: null as unknown as number,
    penOptions: {
      highlighter: true,
      constantPressure: true,
      hasOutline: false,
      outlineWidth: 1,
      options: {
        thinning: 1,
        smoothing: 0.5,
        streamline: 0.5,
        easing: 'linear',
        start: { taper: 0, cap: true, easing: 'linear' },
        end: { cap: true, taper: true, easing: 'linear' },
      },
    },
  },
  'thin-thick-thin': {
    type: 'thin-thick-thin',
    freedrawOnly: true,
    strokeColor: '#CECDCC',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 0,
    roughness: null as unknown as number,
    penOptions: {
      highlighter: true,
      constantPressure: true,
      hasOutline: false,
      outlineWidth: 1,
      options: {
        thinning: 1,
        smoothing: 0.5,
        streamline: 0.5,
        easing: 'linear',
        start: { cap: true, taper: true, easing: 'linear' },
        end: { cap: true, taper: true, easing: 'linear' },
      },
    },
  },
}
