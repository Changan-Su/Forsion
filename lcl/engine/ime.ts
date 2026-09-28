/** 输入法组字守卫(评审 G4-02):拼音 / 注音 / 日文输入法组字时,Enter 是「上屏」、↑↓ 是在候选窗里挑词、
 *  Esc 是「取消组字」—— 都归输入法,不是面板的「打开 / 移动选中 / 关闭」。面板的 onKeyDown 第一行就问它,
 *  命中直接 return(**先于** preventDefault:否则连上屏都被吃掉)。
 *  判据以 `isComposing` 为准 —— CDP 真组合实测组字期 Enter 的 keyCode 仍是 13;229 只是 Safari / 老 Chromium
 *  在 compositionend 前后那一拍的兜底。React 合成事件的 isComposing 在 nativeEvent 上,原生事件在自身上,两种都收。 */
export function isImeKeyEvent(e: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }): boolean {
  return !!(e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229)
}
