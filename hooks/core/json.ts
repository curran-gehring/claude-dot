/**
 * The last JSON object in a model's text: a fenced ```json block if one
 * parses, else the last complete object written in the text, the enclosing one
 * rather than one nested in it. `undefined` when there is none. One linear
 * pass matches the braces, so a long answer is read whole.
 */
export function lastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(found => found[1] ?? '')
  for (const block of fenced.reverse()) {
    const value = tryParse(block)
    if (isObject(value)) return value
  }

  const closes = matchBraces(text)
  let last: unknown
  for (let start = text.indexOf('{'); start >= 0; ) {
    const end = closes.get(start)
    const value = end === undefined ? undefined : tryParse(text.slice(start, end + 1))
    if (end !== undefined && isObject(value)) {
      last = value
      start = text.indexOf('{', end + 1)
    } else {
      start = text.indexOf('{', start + 1)
    }
  }

  return last
}

/** For each `{` that closes, the index of its `}`, skipping braces inside strings within braces. */
function matchBraces(text: string): Map<number, number> {
  const closes = new Map<number, number>()
  const open: number[] = []
  let isInString = false
  let isEscaped = false
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]
    if (isInString) {
      if (isEscaped) isEscaped = false
      else if (char === '\\') isEscaped = true
      else if (char === '"') isInString = false
      continue
    }
    if (char === '"' && open.length > 0) isInString = true
    else if (char === '{') open.push(at)
    else if (char === '}') {
      const start = open.pop()
      if (start !== undefined) closes.set(start, at)
    }
  }

  return closes
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
