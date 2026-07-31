/**
 * 自动化建议围栏:助手在回复里写 ```forsion-suggest,每行一条建议。
 * 这里把它从正文摘出来 —— 正文照常走 Markdown,建议渲染成一排可点的芯片(见 EditorialMessage)。
 *
 * 为什么是围栏不是工具:建议本身**什么也不做**(点了才把那句话当用户消息发出去),
 * 为一个纯展示的东西给每轮请求加一条 tool schema 不划算。写法教在内置技能 automation-suggest 里。
 *
 * ⚠️必须按 CommonMark 的围栏规则走,不能逐行独立匹配:模型讲解这个功能本身时会写
 * ````markdown ```forsion-suggest … ``` ````,逐行匹配会把教学示例变成真芯片、还把示例从正文里删掉。
 * 故:① 只认「不在任何围栏里」时开的 forsion-suggest 栏;② 收口反引号数须 ≥ 开栏数;
 * ③ 缩进 ≤3 空格(4 空格是缩进代码块)。
 */

/** 开/收栏行:≤3 空格缩进 + ≥3 反引号 + info 串。info 里不能有反引号(CommonMark)。 */
const FENCE = /^ {0,3}(`{3,})[ \t]*(.*?)[ \t]*\r?$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/

/** 一条建议的长度窗:太短(「继续」「好的」)不是自成一句的请求,太长就不像「能直接发出去的一句话」。 */
const MIN_LEN = 4
const MAX_LEN = 80
const MAX_ITEMS = 3

/** 跨段续读用的围栏状态(段之间可能插着工具块,一道围栏会被切断)。 */
export interface SuggestState {
  /** 当前打开的围栏反引号数;0 = 不在围栏里。 */
  fence: number
  /** 这道围栏是不是 forsion-suggest。 */
  suggest: boolean
  /** 未收口的建议围栏原文(含开栏行)——收口才认;没收口要么丢弃要么还回正文。 */
  pending: string[]
}

export interface Suggestions {
  /** 摘掉围栏之后的正文 —— 渲染、复制、朗读都用它,别让用户看见/听见围栏原文。 */
  text: string
  items: string[]
  /** 喂给下一段的续读状态。 */
  state: SuggestState
}

const FRESH = (): SuggestState => ({ fence: 0, suggest: false, pending: [] })

/**
 * @param streaming 还在流式打字 → 没收口的建议围栏先藏起来(否则用户会先看见一段裸代码块再看它消失);
 *                  已完成却没收口 = 模型写坏了,把内容**还回正文**,绝不吞用户看得见的字。
 */
export function splitSuggestions(
  raw: string,
  opts?: { streaming?: boolean; state?: SuggestState },
): Suggestions {
  const st: SuggestState = opts?.state ? { ...opts.state } : FRESH()
  if (!st.fence && !raw.includes('forsion-suggest')) return { text: raw, items: [], state: st } // 绝大多数消息走这条快路
  const body: string[] = []
  const items: string[] = []

  const take = (line: string): void => {
    const s = line.replace(BULLET, '').trim()
    if (s.length >= MIN_LEN && s.length <= MAX_LEN && items.length < MAX_ITEMS) items.push(s)
  }

  for (const line of raw.split('\n')) {
    const m = FENCE.exec(line)
    if (!st.fence) {
      if (m && !m[2].includes('`')) {
        st.fence = m[1].length
        st.suggest = m[2] === 'forsion-suggest'
        if (st.suggest) { st.pending = [line]; continue }
      }
      body.push(line)
      continue
    }
    // 围栏里:只有「反引号数 ≥ 开栏数 + info 为空」才收口。嵌套的三反引号只是内容。
    if (m && m[1].length >= st.fence && !m[2]) {
      if (st.suggest) { for (const l of st.pending.slice(1)) take(l); st.pending = [] }
      else body.push(line)
      st.fence = 0
      st.suggest = false
      continue
    }
    if (st.suggest) st.pending.push(line)
    else body.push(line)
  }

  if (st.fence && st.suggest && !opts?.streaming) {
    body.push(...st.pending) // 已完成却没收口 → 还回正文
    st.pending = []
  }
  // 只削掉围栏留下的空行,不动行内缩进(4 空格缩进代码块的语义靠它)。
  return { text: body.join('\n').replace(/^\n+|\s+$/g, ''), items, state: st }
}
