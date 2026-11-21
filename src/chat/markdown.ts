/**
 * The small Markdown subset her messages use: bold, italics, inline code, links (and bare URLs),
 * bullet and numbered lists, code blocks. Headings render as bold paragraphs. Anything else stays text.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'italic'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; url: string; children: Inline[] }

export type Block =
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'heading'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'code'; text: string; language: string | null }

const BULLET = /^\s{0,3}[-*•]\s+(.*)$/
const ORDERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/
const FENCE = /^\s{0,3}```\s*([\w+-]*)\s*$/

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const fence = FENCE.exec(line)
    if (fence) {
      flushParagraph()
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i] as string)) body.push(lines[i++] as string)
      blocks.push({ kind: 'code', text: body.join('\n'), language: fence[1] || null })
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: 'heading', inlines: parseInline(heading[1] as string) })
      continue
    }
    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet || ordered) {
      flushParagraph()
      const isOrdered = !bullet
      const items: Inline[][] = []
      const start = ordered ? Number(ordered[1]) : 1
      while (i < lines.length) {
        const current = lines[i] as string
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current)
        if (match) {
          items.push(parseInline((isOrdered ? match[2] : match[1]) as string))
          i++
        } else if (current.trim() && /^\s{2,}\S/.test(current) && items.length) {
          // continuation line of the previous item
          const last = items.pop() as Inline[]
          items.push([...last, { kind: 'text', text: ' ' }, ...parseInline(current.trim())])
          i++
        } else break
      }
      i--
      blocks.push({ kind: 'list', ordered: isOrdered, start, items })
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  return blocks
}

const URL_RE = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const pushText = () => {
    if (text) out.push({ kind: 'text', text })
    text = ''
  }

  let i = 0
  while (i < source.length) {
    const rest = source.slice(i)
    const ch = source[i]

    if (ch === '`') {
      const end = source.indexOf('`', i + 1)
      if (end > i + 1) {
        pushText()
        out.push({ kind: 'code', text: source.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    if (rest.startsWith('**') || rest.startsWith('__')) {
      const marker = rest.slice(0, 2)
      const end = source.indexOf(marker, i + 2)
      if (end > i + 2) {
        pushText()
        out.push({ kind: 'bold', children: parseInline(source.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    if ((ch === '*' || ch === '_') && source[i + 1] && source[i + 1] !== ' ') {
      // `_` only opens at a word boundary, so snake_case stays text.
      const opens = ch === '*' || i === 0 || /[\s(]/.test(source[i - 1] as string)
      const end = findClosing(source, ch, i + 1)
      if (opens && end > i + 1) {
        pushText()
        out.push({ kind: 'italic', children: parseInline(source.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    if (ch === '[') {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest)
      if (link) {
        pushText()
        out.push({ kind: 'link', url: link[2] as string, children: parseInline(link[1] as string) })
        i += link[0].length
        continue
      }
    }

    if (ch === 'h' && (i === 0 || /[\s(]/.test(source[i - 1] as string))) {
      const url = URL_RE.exec(rest)
      if (url) {
        pushText()
        out.push({ kind: 'link', url: url[0], children: [{ kind: 'text', text: url[0] }] })
        i += url[0].length
        continue
      }
    }

    text += ch
    i++
  }
  pushText()
  return out
}

function findClosing(source: string, marker: string, from: number): number {
  for (let j = from; j < source.length; j++) {
    if (source[j] === '\n' && source[j + 1] === '\n') return -1
    if (source[j] === marker && source[j - 1] !== ' ' && source[j + 1] !== marker) {
      if (marker === '_' && j + 1 < source.length && /\w/.test(source[j + 1] as string)) continue
      return j
    }
  }
  return -1
}

/** Characters of text these inlines render (what a reader sees, markup excluded). */
export function inlineLength(inlines: Inline[]): number {
  let total = 0
  for (const inline of inlines) {
    if (inline.kind === 'text' || inline.kind === 'code') total += inline.text.length
    else total += inlineLength(inline.children)
  }
  return total
}

/**
 * Characters of text these blocks render, in render order. List markers aren't counted. Used to
 * fade the unheard end of a spoken reply: the heard part's length, measured on its own parse, is
 * where the fade starts in the whole message's.
 */
export function visibleLength(blocks: Block[]): number {
  let total = 0
  for (const block of blocks) {
    if (block.kind === 'code') total += block.text.length
    else if (block.kind === 'list') total += block.items.reduce((sum, item) => sum + inlineLength(item), 0)
    else total += inlineLength(block.inlines)
  }
  return total
}

/** Plain text of a message, for notifications and accessibility. */
export function plainText(source: string): string {
  return source
    .replace(/```[\w+-]*\n?/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .trim()
}
