/** 必须最先 import:amadeus/api.ts 在模块求值时就把 window.amadeus 抓成常量,双链预览要读的 readPage 得在那之前就位。 */
const para = (i: number): string => `Paragraph ${i + 1}: the preview card reads the first part of the note and must stay inside the window.`
Object.assign(window, {
  amadeus: {
    readPage: async () => ({
      manifest: { root: { children: [{ columns: [{ children: [{ ref: 'b1' }] }] }] } },
      blocks: { b1: { content: Array.from({ length: 14 }, (_, i) => para(i)).join('\n\n') } },
    }),
  },
})
export {}
