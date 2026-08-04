export type KeyEvent =
  | { type: 'text', text: string }
  | { type: 'enter' }
  | { type: 'backspace' }
  | { type: 'arrow', direction: 'up' | 'left' | 'right' | 'down' }
  | { type: 'delete' }
  | { type: 'ctrl_c' }
  | { type: 'unknown' }

export function parseKeyEvent(chunk: Buffer): KeyEvent {
  const bytes = [...chunk]

  if (bytes.length === 1) {
    if (bytes[0] === 0x03) {
      return { type: 'ctrl_c' }
    }
    if (bytes[0] === 0x0d || bytes[0] === 0x0a) {
      return { type: 'enter' }
    }
    if (bytes[0] === 0x08 || bytes[0] === 0x7f) {
      return { type: 'backspace' }
    }
  } else {
    if (bytes[0] === 0x1b && bytes[1] === 0x5b) {
      const code = String.fromCharCode(bytes[2] ?? 0)
      if (code === 'A') return { type: 'arrow', direction: 'up' }
      if (code === 'B') return { type: 'arrow', direction: 'down' }
      if (code === 'C') return { type: 'arrow', direction: 'right' }
      if (code === 'D') return { type: 'arrow', direction: 'left' }
      if (code === '3' && bytes.length >= 4 && bytes[3] === 0x7e) {
        return { type: 'delete' }
      }
      return { type: 'unknown' }
    }
  }

  const text = chunk.toString('utf-8')
  if (text.trim()) {
    return { type: 'text', text }
  }
  return { type: 'unknown' }
}