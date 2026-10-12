/** Candidates parsed before giving up: each parse is linear, so the whole read stays linear. */
const MAX_TRIES = 200

/**
 * The last JSON object in a model's text: a fenced ```json block if one
 * parses, else the last complete object written in the text, the enclosing one
 * rather than one nested in it. `undefined` when there is none. One linear
 * pass matches the braces, so a long answer is read whole, and at most
 * MAX_TRIES candidates are parsed.
 */
export function lastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(found => found[1] ?? '')
  for (const block of fenced.reverse()) {
    const value = tryParse(block)
    if (isObject(value)) return value
  }

  // The last object to close is the report, or encloses it; a nested object closes earlier.
  const spans = matchBraces(text)
  for (let at = spans.length - 1, tries = 0; at >= 0 && tries < MAX_TRIES; at -= 1) {
    const [start, end] = spans[at] ?? [0, -1]
    if (!opensObject(text, start)) continue
    tries += 1
    const value = tryParse(text.slice(start, end + 1))
    if (isObject(value)) return value
  }

  return undefined
}

/** Whether the `{` at `start` can open a JSON object: next comes a key's quote or the closing brace. */
function opensObject(text: string, start: number): boolean {
  for (let at = start + 1; at < text.length; at += 1) {
    const char = text[at]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') continue
    return char === '"' || char === '}'
  }
  return false
}

/** Each `{` that closes with its `}`, in the order they close, skipping braces inside strings within braces. */
function matchBraces(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
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
      if (start !== undefined) spans.push([start, at])
    }
  }

  return spans
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Malformed, or nested deeper than the parser's stack: not a report either way.
    return undefined
  }
}
