/**
 * 块级 `\[ … \]`(flow)的严格规则,替换 micromark-extension-llm-math 自带的那份(见 remarkLlmMath 文件头的三处毛病)。
 * 照 micromark-extension-math 的 mathFlow 改写(MIT),产出同样的 mathFlow / mathFlowFence / mathFlowValue 记号,
 * mdast-util-math 照常把它变成 `math` 节点:
 *   - `\[` 独占一行(前面最多 3 个空格,后面只许空白)才开;同一行后面还有字的(`\[x\] 后文`)不开,交给行内那半;
 *   - 只有独占一行的 `\]` 才收;公式里以 `]` 结尾的行、以 `- ` `+ ` `1.` `#` `>` 开头的行、空行都是公式内容,
 *     不会像段落那样被列表 / 标题打断(Codex 11-17 复核时抓到:只靠行内那半时 `x =\n- y` 会被拆成列表);
 *   - 后面找不到收尾的 `\]` 就不开(先往后看一遍):流式写到一半时先按普通文字显示,收尾到了再变公式。
 */
import { factorySpace } from 'micromark-factory-space'
import { markdownLineEnding } from 'micromark-util-character'
import type { Code, Construct, Effects, State, TokenizeContext } from 'micromark-util-types'

const BACKSLASH = 92, OPEN = 91, CLOSE = 93

export const texMathFlow: Construct = { name: 'texMathFlow', tokenize: tokenizeTexMathFlow, concrete: true }

function tokenizeTexMathFlow(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this
  const tail = self.events[self.events.length - 1]
  const initialSize = tail && tail[1].type === 'linePrefix' ? tail[2].sliceSerialize(tail[1], true).length : 0
  const closingFence: Construct = { tokenize: tokenizeClosingFence, partial: true }
  const nonLazy: Construct = { tokenize: tokenizeNonLazyContinuation, partial: true }
  const closedAhead: Construct = { tokenize: tokenizeClosedAhead, partial: true }
  return start

  function start(code: Code): State | undefined {
    if (code !== BACKSLASH) return nok(code)
    effects.enter('mathFlow')
    effects.enter('mathFlowFence')
    effects.enter('mathFlowFenceSequence')
    effects.consume(code)
    return openBracket
  }
  function openBracket(code: Code): State | undefined {
    if (code !== OPEN) return nok(code)
    effects.consume(code)
    effects.exit('mathFlowFenceSequence')
    return factorySpace(effects, openEnd, 'whitespace')
  }
  function openEnd(code: Code): State | undefined {
    if (code === null || !markdownLineEnding(code)) return nok(code) // 同一行还有字 / 文件到头:不是块级
    effects.exit('mathFlowFence')
    if (self.interrupt) return ok(code)
    return effects.check(closedAhead, () => effects.attempt(nonLazy, beforeNonLazyContinuation, after)(code), nok)(code)
  }
  function beforeNonLazyContinuation(code: Code): State | undefined {
    return effects.attempt(closingFence, after, contentStart)(code)
  }
  function contentStart(code: Code): State | undefined {
    return (initialSize ? factorySpace(effects, beforeContentChunk, 'linePrefix', initialSize + 1) : beforeContentChunk)(code)
  }
  function beforeContentChunk(code: Code): State | undefined {
    if (code === null) return after(code)
    if (markdownLineEnding(code)) return effects.attempt(nonLazy, beforeNonLazyContinuation, after)(code)
    effects.enter('mathFlowValue')
    return contentChunk(code)
  }
  function contentChunk(code: Code): State | undefined {
    if (code === null || markdownLineEnding(code)) {
      effects.exit('mathFlowValue')
      return beforeContentChunk(code)
    }
    effects.consume(code)
    return contentChunk
  }
  function after(code: Code): State | undefined {
    effects.exit('mathFlow')
    return ok(code)
  }

  /** 独占一行的 `\]`(前面最多 3 个空格,后面只许空白)。 */
  function tokenizeClosingFence(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    return factorySpace(effects, beforeSequence, 'linePrefix', self.parser.constructs.disable.null?.includes('codeIndented') ? undefined : 4)
    function beforeSequence(code: Code): State | undefined {
      if (code !== BACKSLASH) return nok(code)
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      effects.consume(code)
      return closeBracket
    }
    function closeBracket(code: Code): State | undefined {
      if (code !== CLOSE) return nok(code)
      effects.consume(code)
      effects.exit('mathFlowFenceSequence')
      return factorySpace(effects, afterSequence, 'whitespace')
    }
    function afterSequence(code: Code): State | undefined {
      if (code === null || markdownLineEnding(code)) {
        effects.exit('mathFlowFence')
        return ok(code)
      }
      return nok(code)
    }
  }

  /** 往后看:同一容器里(非惰性续行)有没有收尾的 `\]`。只用来判断,不留记号。 */
  function tokenizeClosedAhead(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const ctx = this
    return lineEnd
    function lineEnd(code: Code): State | undefined {
      if (code === null || !markdownLineEnding(code)) return nok(code)
      effects.enter('lineEnding')
      effects.consume(code)
      effects.exit('lineEnding')
      return lineStart
    }
    function lineStart(code: Code): State | undefined {
      if (ctx.parser.lazy[ctx.now().line]) return nok(code)
      return effects.attempt(closingFence, ok, skipLine)(code)
    }
    function skipLine(code: Code): State | undefined {
      if (code === null) return nok(code)
      if (markdownLineEnding(code)) return lineEnd(code)
      effects.enter('mathFlowValue')
      return inLine(code)
    }
    function inLine(code: Code): State | undefined {
      if (code === null || markdownLineEnding(code)) {
        effects.exit('mathFlowValue')
        return code === null ? nok(code) : lineEnd(code)
      }
      effects.consume(code)
      return inLine
    }
  }
}

function tokenizeNonLazyContinuation(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this
  return start
  function start(code: Code): State | undefined {
    if (code === null) return ok(code)
    effects.enter('lineEnding')
    effects.consume(code)
    effects.exit('lineEnding')
    return lineStart
  }
  function lineStart(code: Code): State | undefined {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code)
  }
}
