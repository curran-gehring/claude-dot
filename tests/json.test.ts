import { describe, expect, test } from 'claude-code/testing'

import { lastJsonObject } from '../hooks/core/json'

describe('lastJsonObject', () => {
  test('the enclosing object, not one nested in it', async () => {
    expect(lastJsonObject('Done.\n{"summary":"x","inbox":[{"kind":"result"}],"notes":[]}')).toEqual({ summary: 'x', inbox: [{ kind: 'result' }], notes: [] })
    expect(lastJsonObject('{"summary":"x","meta":{"a":1}}')).toEqual({ summary: 'x', meta: { a: 1 } })
  })

  test('braces inside strings and in prose after it', async () => {
    expect(lastJsonObject('{"summary":"has } and { in it"}\nThat is all {really}.')).toEqual({ summary: 'has } and { in it' })
    expect(lastJsonObject('{"a":"quote \\" then }"}')).toEqual({ a: 'quote " then }' })
  })

  test('the last of several, and a fenced block first', async () => {
    expect(lastJsonObject('{"a":1} then {"b":2}')).toEqual({ b: 2 })
    expect(lastJsonObject('```json\n{"a":1}\n```\nlater {"b":2}')).toEqual({ a: 1 })
  })

  test('a long report is read whole, not from its middle', async () => {
    const notes = Array.from({ length: 2_000 }, (_, at) => `note number ${at} with some words in it`)
    const report = { summary: 'long', inbox: [{ kind: 'result', title: 't', body: 'b' }], notes }
    expect(lastJsonObject(`Done.
${JSON.stringify(report)}`)).toEqual(report)
  })

  test('nothing that parses is undefined, quickly', async () => {
    expect(lastJsonObject('{ not json } {also not}')).toBeUndefined()
    expect(lastJsonObject('{'.repeat(5_000) + 'x' + '}'.repeat(4_000))).toBeUndefined()
    expect(lastJsonObject('{ a '.repeat(50_000) + '{"b":1}')).toEqual({ b: 1 })
    // 19,000 matched candidates that all open like objects and none parses: capped, not quadratic.
    expect(lastJsonObject('{"a":'.repeat(20_000) + 'x' + '}'.repeat(19_000))).toBeUndefined()
    expect(lastJsonObject('{"a":'.repeat(20_000) + 'x' + '}'.repeat(19_000) + ' and then {"b":2}')).toEqual({ b: 2 })
    expect(lastJsonObject('no braces')).toBeUndefined()
  })
})
