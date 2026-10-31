// 按键类型
type ParsedKeyName =
  | 'return' | 'tab' | 'backspace' | 'delete'
  | 'up' | 'down' | 'left' | 'right'
  | 'pageup' | 'pagedown' | 'home' | 'end' | 'escape'

type ParsedInputEvent =
  | { kind: 'key'; name: ParsedKeyName; ctrl: boolean; meta: boolean }  // 功能性按键
  | { kind: 'text'; text: string; ctrl: boolean; meta: boolean }  // 文本输入
  | { kind: 'wheel'; direction: 'up' | 'down' }   // 鼠标滚轮
  | { kind: 'mouse'; x: number; y: number; button: 'left' | 'middle' | 'right'; action: 'press' | 'release' | 'drag' }

type ParseResult = {
  events: ParsedInputEvent[]
  rest: string
}

// 判断当前 chunk 是否是多行粘贴文本
function isMultilinePasteChunk(input: string): boolean {
  return /[\r\n]/.test(input) && /[^\r\n]/.test(input)
}


const ESC = '\u001b'
// ctrl + A   =  0x1f & 0x41 = 0x01
const CTRL_CHAR_TO_NAME: Record<string, string> = {
  '\u0001': 'a', // Ctrl+A
  '\u0003': 'c', // Ctrl+C
  '\u0005': 'e', // Ctrl+E
  '\u000e': 'n', // Ctrl+N
  '\u000f': 'o', // Ctrl+O
  '\u0010': 'p', // Ctrl+P
  '\u0015': 'u', // Ctrl+U
}
// 防止截断一个不完整 ANSI 序列，解析出错
// 1. 只有单独 ESC
// 2. `\u001b[`（CSI 开头，还没后续数字）
// 3. `\u001b[` 后面只有数字、`;`、`<`、`?`，序列还没结束
// 4. `\u001bO` 开头，总长度小于 3（SS3 序列，比如 `\u001bOA` 方向键）
function maybeNeedMoreForEscapeSequence(input: string): boolean {
  if (!input.startsWith(ESC)) return false

  if (input === ESC) return true
  // Wait only for known-incomplete CSI prefixes.
  // If an unexpected character appears (for example "\u001b[\r"), do not
  // block the parser forever; let parseEscapeSequence fall back.
  if (input === '\u001b[') return true
  if (/^\u001b\[[<\d;?]*$/.test(input)) {
    return true
  }
  if (input.startsWith('\u001bO') && input.length < 3) {
    return true
  }

  return false
}
// 解析 ANSI ESC 转义序列
function parseEscapeSequence(input: string): {
  event: ParsedInputEvent | null
  length: number
} | null {
  // SGR 鼠标序列 `\u001b[<btn;x;y>M` / `\u001b[<btn;x;y>m`
  //   现代终端鼠标协议（Xterm SGR mouse）

  // - `M`：鼠标按下 / 拖拽；`m`：鼠标释放
  // - button 编码：包含按键 + 拖拽标记 + 滚轮标记
  // - x,y：终端单元格坐标，代码里 `-1` 做偏移
  // - 滚轮：`0x40`(0b1000000上，0b1000001下) 位标记，区分 up/down
  // - 拖拽：`0x20`(0b0100000) 位标记
  // - 按键：0(0b0000000) = 左键，1(0b0000001) = 中键，2(0b0000010) = 右键

  let match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(input)
  if (match) {
    const button = Number(match[1])
    const x = Number(match[2]) - 1
    const y = Number(match[3]) - 1
    const released = match[4] === 'm'
    const length = match[0].length
    if ((button & 0x43) === 0x40) {
      return { event: { kind: 'wheel', direction: 'up' }, length }
    }
    if ((button & 0x43) === 0x41) {
      return { event: { kind: 'wheel', direction: 'down' }, length }
    }
    const btnCode = button & 0x43
    const isDrag = (button & 0x20) !== 0
    const buttonName: 'left' | 'middle' | 'right' =
      btnCode === 0 ? 'left' : btnCode === 1 ? 'middle' : 'right'
    return {
      event: {
        kind: 'mouse',
        x,
        y,
        button: buttonName,
        action: released ? 'release' : isDrag ? 'drag' : 'press',
      },
      length,
    }
  }

  // 旧版终端鼠标编码，只识别滚轮
  if (/^\u001b\[M.../.test(input)) {
    const seq = input.slice(0, 6)
    const button = seq.charCodeAt(3) - 32
    if ((button & 0x43) === 0x40) {
      return { event: { kind: 'wheel', direction: 'up' }, length: 6 }
    }
    if ((button & 0x43) === 0x41) {
      return { event: { kind: 'wheel', direction: 'down' }, length: 6 }
    }
    return { event: null, length: 6 }
  }
  // 带修饰键的 CSI 方向键序列  \x1b[1;N A  `\x1b[1;5A` → Ctrl + ↑   `\x1b[1;3A` → Meta(Alt) + ↑
  match = /^\u001b\[(?:1;(\d+))?([ABCDHF])/.exec(input)
  if (match) {
    const modifier = Number(match[1] ?? '1')
    const meta = modifier === 3
    const ctrl = modifier === 5
    const nameMap: Record<string, ParsedKeyName> = {
      A: 'up',
      B: 'down',
      C: 'right',
      D: 'left',
      H: 'home',
      F: 'end',
    }
    return {
      event: {
        kind: 'key',
        name: nameMap[match[2]],
        ctrl,
        meta,
      },
      length: match[0].length,
    }
  }
  // CSI 数字波浪 `\u001b[num~`
  match = /^\u001b\[(\d+)~/.exec(input)
  if (match) {
    const nameMap: Record<string, ParsedKeyName> = {
      '1': 'home',
      '3': 'delete',
      '4': 'end',
      '5': 'pageup',
      '6': 'pagedown',
      '7': 'home',
      '8': 'end',
    }
    const name = nameMap[match[1]]
    if (!name) return { event: null, length: match[0].length }
    return {
      event: { kind: 'key', name, ctrl: false, meta: false },
      length: match[0].length,
    }
  }
  // SS3 序列 `\u001bOABCDHF`（mac输出）
  match = /^\u001bO([ABCDHF])/.exec(input)
  if (match) {
    const nameMap: Record<string, ParsedKeyName> = {
      A: 'up',
      B: 'down',
      C: 'right',
      D: 'left',
      H: 'home',
      F: 'end',
    }
    return {
      event: {
        kind: 'key',
        name: nameMap[match[1]],
        ctrl: false,
        meta: false,
      },
      length: match[0].length,
    }
  }

  if (input.startsWith('\u001b\t')) {
    return {
      event: { kind: 'key', name: 'tab', ctrl: false, meta: true },
      length: 2,
    }
  }

  if (input.length >= 2) {
    const char = input[1]
    if (char !== '[' && char !== 'O') {
      return {
        event: { kind: 'text', text: char, ctrl: false, meta: true },
        length: 2,
      }
    }
  }

  return {
    event: { kind: 'key', name: 'escape', ctrl: false, meta: false },
    length: 1,
  }
}
export function parseInputChunk(
  previousRest: string,
  chunk: Buffer | string,
): ParseResult {
  const chunkText = String(chunk)
  const input = previousRest + chunkText
  // 判断本次 chunk 是否多行粘贴
  const treatNewlinesAsText = isMultilinePasteChunk(chunkText)
  const events: ParsedInputEvent[] = []
  let index = 0

  while (index < input.length) {
    const remaining = input.slice(index)

    if (remaining[0] === ESC) {
      // 如果序列不完整，直接返回当前已解析事件，剩余字符串放入 `rest`，本轮中断
      if (maybeNeedMoreForEscapeSequence(remaining)) {
        return { events, rest: remaining }
      }
      // 完整 ESC 序列：调用 `parseEscapeSequence`，消费对应长度，事件入队
      const parsed = parseEscapeSequence(remaining)
      if (parsed) {
        if (parsed.event) events.push(parsed.event)
        index += parsed.length
        continue
      }
    }
    // 普通字符分支
    const char = remaining[0]
    if (!char) break

    if (char === '\r' || char === '\n') {
      // 粘贴模式：当做普通文本 `text: "\n"`
      if (treatNewlinesAsText) {
        events.push({ kind: 'text', text: '\n', ctrl: false, meta: false })
      } else {
        // 正常输入：当做 `key: return`
        events.push({ kind: 'key', name: 'return', ctrl: false, meta: false })
      }
      if (
        (char === '\r' && remaining[1] === '\n') ||
        (char === '\n' && remaining[1] === '\r')
      ) {
        index += 2
      } else {
        index += 1
      }
      continue
    }

    if (char === '\t') {
      events.push({ kind: 'key', name: 'tab', ctrl: false, meta: false })
      index += 1
      continue
    }

    if (char === '\u007f' || char === '\b') {
      events.push({ kind: 'key', name: 'backspace', ctrl: false, meta: false })
      index += 1
      continue
    }

    if (char >= '\u0001' && char <= '\u001a') {
      const name = CTRL_CHAR_TO_NAME[char]
      if (name) {
        events.push({ kind: 'text', text: name, ctrl: true, meta: false })
      }
      index += 1
      continue
    }

    if (char < ' ') {
      index += 1
      continue
    }

    events.push({ kind: 'text', text: char, ctrl: false, meta: false })
    index += 1
  }

  return { events, rest: '' }
}

export type { ParsedInputEvent } 