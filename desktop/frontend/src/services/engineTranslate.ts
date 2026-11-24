/**
 * 插件翻译引擎的一次调用(2026-11-24;契约:仓根 docs/ToBeImproved/翻译插件设置与服务方案_2026-11-24/契约.md §2)。
 * tanguProbe.translateInline 选中引擎时走这里;单拎出来好测。
 */
import { registerMessages, translate } from '../i18n'
import { protectTranslation } from './translationContent'
import type { RegisteredTranslationEngine } from '../amadeus/plugins/translationEngines'
import type { TanguCompleteOptions, TanguCompleteRequest, TanguCompleteResult } from '../amadeus/plugins/tanguSeam'

registerMessages({
  'translate.engine.unavailable': { zh: '{name} 现在用不了（还没填密钥，或检测没通过）。去翻译设置里看看，或者换回 Forsion 模型。', en: '{name} isn\'t available right now (no key yet, or its check failed). Open translation settings, or switch back to Forsion models.' },
  'translate.engine.failed': { zh: '{name} 没有翻成', en: '{name} could not translate this' },
  'translate.engine.empty': { zh: '{name} 没有返回译文', en: '{name} returned no translation' },
})

/** 插件引擎翻一段:宿主照 completeInline 的规矩包一层 —— 公式 / 代码 / 链接目标先换成不透明标记,回来逐个校验还原;
 *  标记丢了用同一个引擎再试一次,还不行报 translation_format_lost(结果不能复制写入)。引擎自己的错原样带人话出去。 */
export async function engineTranslate(engine: RegisteredTranslationEngine, req: TanguCompleteRequest, opts: TanguCompleteOptions): Promise<TanguCompleteResult> {
  const source = req.selection || ''
  const language = req.language || ''
  if (!source.trim() || !language) throw new Error('translate: text and language are required')
  const content = protectTranslation(source)
  if (content.text.length > 20_000) throw new Error(translate('inlineai.errTooLong'))
  const signal = opts.signal ?? new AbortController().signal
  const name = engine.name()
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted()
    let out: unknown
    try {
      out = await engine.translate({ text: content.text, to: language, ...(req.before ? { before: req.before } : {}), signal })
    } catch (e) {
      if (signal.aborted) throw e
      const msg = (e as Error)?.message ? String((e as Error).message) : translate('translate.engine.failed', { name })
      throw Object.assign(new Error(msg), { code: 'translation_engine_failed', engine: name })
    }
    signal.throwIfAborted()
    if (typeof out !== 'string' || !out.trim()) throw Object.assign(new Error(translate('translate.engine.empty', { name })), { code: 'translation_engine_failed', engine: name })
    const text = content.restore(out)
    if (text != null) {
      opts.onDelta?.(text)
      return { text, toolCallText: false, model: { id: `engine:${engine.key}`, name, mt: true, engine: true } }
    }
  }
  throw Object.assign(new Error(translate('inlineai.errFormat')), { code: 'translation_format_lost' })
}

