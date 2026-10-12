/**
 * The last JSON object in a model's text: a fenced ```json block if there is
 * one, else the last `{...}` that parses. `undefined` when there is none.
 */
export function lastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(found => found[1] ?? '')
  for (const block of fenced.reverse()) {
    const value = tryParse(block)
    if (isObject(value)) return value
  }

  // The report sits at the end; scanning only the tail keeps this bounded.
  const tail = text.slice(-20_000)
  for (let end = tail.lastIndexOf('}'); end >= 0; end = tail.lastIndexOf('}', end - 1)) {
    for (let start = tail.lastIndexOf('{', end); start >= 0; start = tail.lastIndexOf('{', start - 1)) {
      const value = tryParse(tail.slice(start, end + 1))
      if (isObject(value)) return value
    }
  }

  return undefined
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
