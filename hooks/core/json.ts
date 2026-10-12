/** How much of an answer's end is searched: the report is written last. */
const TAIL = 20_000

/**
 * The last JSON object in a model's text: a fenced ```json block if one
 * parses, else the last complete object written in the text, the enclosing one
 * rather than one nested in it. `undefined` when there is none.
 */
export function lastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(found => found[1] ?? '')
  for (const block of fenced.reverse()) {
    const value = tryParse(block)
    if (isObject(value)) return value
  }

  const tail = text.slice(-TAIL)
  let last: unknown
  for (let start = tail.indexOf('{'); start >= 0; ) {
    const end = matchingBrace(tail, start)
    const value = end < 0 ? undefined : tryParse(tail.slice(start, end + 1))
    if (isObject(value)) {
      last = value
      start = tail.indexOf('{', end + 1)
    } else {
      start = tail.indexOf('{', start + 1)
    }
  }

  return last
}

/** The index of the `}` closing the `{` at `start`, skipping braces inside strings; -1 when it never closes. */
function matchingBrace(text: string, start: number): number {
  let depth = 0
  let isInString = false
  let isEscaped = false
  for (let at = start; at < text.length; at += 1) {
    const char = text[at]
    if (isInString) {
      if (isEscaped) isEscaped = false
      else if (char === '\\') isEscaped = true
      else if (char === '"') isInString = false
      continue
    }
    if (char === '"') isInString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return at
    }
  }

  return -1
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
